
# DECISIONS.md — Journal des décisions

Projet : éditeur de documents collaboratif sur AWS.
Version initiale : 24 octobre 2026. Ce fichier est **vivant** : l'agent et toi y ajoutez chaque nouvelle décision ou tout écart par rapport à la spécification (`SPEC_AGENT_editeur_collaboratif.txt`).

Format d'une ligne : **décision**, raison, alternative écartée, impact sur les invariants.
Statut : `figée` (ne pas remettre en cause sans raison forte), `proposée` (à valider), `ouverte`.

---

## 1. Décisions figées avec l'utilisateur

| ID   | Décision                                                                                                                                 | Raison                                                                                                                                                                                                     | Alternative écartée                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| D-01 | Texte brut uniquement (`Y.Text`)                                                                                                        | Le sujet demande « un simple texte » ; comptage de caractères, restauration et rendu PDF beaucoup plus simples                                                                                          | Tiptap / texte riche : formats, nœuds et marques compliquent le comptage et le PDF                   |
| D-02 | **Une seule instance** Hocuspocus                                                                                                   | 300 rédacteurs tiennent sur une instance ; évite Redis, le routage par document et la double facturation entre instances                                                                                 | Plusieurs instances (choix initial abandonné) : coût et complexité non justifiés pour le week-end |
| D-03 | CodeMirror 6 + `y-codemirror.next`                                                                                                      | Éditeur texte brut léger avec curseurs distants prêts à l'emploi                                                                                                                                       | Éditeur maison : temps et risques                                                                    |
| D-04 | Téléchargement par URL pré-signée S3 à TTL court (60 s), **une seule URL émise par réservation**                             | Les fichiers sont dans S3 (exigence du sujet) ; TTL court limite le partage                                                                                                                                | Proxy avec jeton à usage unique : plus strict mais plus coûteux et plus lourd à tenir sous pic     |
| D-05 | Une copie est consommée à l'acceptation de la réservation atomique. Remboursement **uniquement** si aucune URL n'a été émise  | Un transfert S3 commencé continue après l'expiration de l'URL et ne peut pas être détecté de façon fiable : réattribuer une copie dont l'URL est sortie risquerait un exemplaire de trop (viole C1) | Liste d'attente avec remplacement des téléchargements non terminés : écartée (voir D-06)         |
| D-06 | Pas de file d'attente ordonnée pour les visiteurs ; états `preparing` / `retry` avec `Retry-After`, premier arrivé premier servi | Une attente longue contredit C6 (informer vite que le lien est épuisé) et garde un polling massif                                                                                                        | File ordonnée de 14 500 visiteurs : charge et retard de l'information « épuisé »                 |

## 2. Définitions normatives (règles de calcul)

| ID   | Décision                                                                                                                                                                   | Raison / remarque                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-07 | Crédit compté en unités **UTF-16** (`String.length`) ; un emoji = 2. Seules les **insertions** comptent ; suppressions et remplacements ne restituent rien | Cohérent avec les index Yjs, déterministe, simple à tester. Alternative : points de code Unicode (plus intuitif mais plus de cas limites aux frontières de structures Yjs) |
| D-08 | Remise à zéro du crédit à 00:00 **UTC** (clé `writerId#AAAA-MM-JJ`)                                                                                            | Pas de logique de fuseau ; à 01:00 heure de Yaoundé. L'UI affiche l'heure locale et UTC                                                                                      |
| D-09 | Restauration = nouvelle évolution ; elle ne consomme pas de crédit ; rôle owner/editor ; limitée à 10/heure/rédacteur                                                 | Le contenu restauré a déjà été écrit avec du crédit ; la limite de fréquence évite l'abus                                                                             |
| D-10 | Identité : session JWT (cookie HttpOnly) créée depuis nom + e-mail, **sans vérification d'e-mail**. `writerId = sha256(email en minuscules)`                    | Le sujet n'exige pas de vrais comptes ; SES en sandbox rend la vérification irréaliste. Limite : plusieurs e-mails pour une même personne                                   |
| D-11 | Version d'un PDF = `sha256(texte UTF-8)`                                                                                                                                  | Il n'existe pas de « V42 » naturelle avec un CRDT continu ; même texte, même PDF réutilisé                                                                               |
| D-12 | « Téléchargement » = émission d'une URL pré-signée valide                                                                                                            | Seul événement observable et atomique côté serveur                                                                                                                         |

## 3. Collaboration et persistance

| ID   | Décision                                                                                                                                                   | Raison                                                                                                                             | Alternative écartée                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| D-13 | Journal d'updates Yjs dans DynamoDB **avant** application et diffusion (write-ahead) + snapshots compactés dans S3                                   | Aucun update n'est acquitté sans être durable (C2) ; l'état reconstruit n'est jamais en retard sur les modifications acceptées | Persistance débouncée dans S3 seul : un crash perd plusieurs secondes de modifications acceptées |
| D-14 | Facturation du **delta réellement nouveau** par intervalles `(clientID, clock)` (structure `IntervalSet`), imputée au `writerId` authentifié | Une retransmission est gratuite par construction (I06) ; le `clientID` est choisi par le client donc non fiable                  | Facturer le message reçu : double facturation sur retransmission                                   |
| D-15 | Asymétrie sûre : **surfacturation possible** (crash entre débit et journal, puis renvoi), **sous-facturation interdite**                     | Préserve I02 (jamais plus de 10 000 caractères/jour)                                                                             | Rembourser en cas d'échec de persistance : risque de double remboursement                          |
| D-16 | Validation stricte des updates : seul le contenu texte (+ suppressions) rattaché à la racine `content`, taille ≤ 64 Ko                                 | Empêche d'injecter des types non facturables ; protège la taille des items DynamoDB                                              | Accepter tout update Yjs valide                                                                     |
| D-17 | Protocole de refus explicite (`write_refused`) puis client recréé en lecture seule, sans persistance locale                                             | Le client a déjà appliqué sa modification localement ; sans protocole il diverge et renvoie à l'infini                         | Ignorer silencieusement l'update refusé                                                            |
| D-18 | Optimisation par micro-lots (20–50 ms) **seulement si la mesure la justifie**                                                                        | Évite une complexité prématurée ; un `PutItem` par update au départ                                                         | Group commit dès le départ                                                                        |

## 4. Téléchargements et PDF

| ID   | Décision                                                                                                                                      | Raison                                                                                                                                     | Alternative écartée                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| D-19 | Réservation par `TransactWriteItems` [compteur `issued` conditionnel + item réservation]                                                 | Atomicité de la limite (C1) et idempotence par `(linkId, requestId)`                                                                    | Compteur seul sans item réservation : pas d'idempotence                                     |
| D-20 | **Chemin rapide « épuisé »** sans écriture DynamoDB (lecture + cache mémoire 1 s)                                                  | Les écritures conditionnelles refusées consomment de la capacité ; l'essentiel des ~12 000 requêtes du pic arrivera après épuisement | Laisser chaque requête tenter la transaction                                                |
| D-21 | `TransactionConflict` : retries avec backoff + jitter, puis état explicite `retry` (jamais 429/503 sec)                                   | C5 interdit de « jeter » un visiteur                                                                                                     | Renvoyer une erreur HTTP de saturation                                                       |
| D-22 | Sélection de version **après** la réservation, seulement pour les gagnants (≤ N par lien)                                            | Le chemin lourd (reconstruction du texte) n'est pas exécuté 12 000 fois                                                                  | Sélectionner la version pour chaque requête                                                |
| D-23 | Version courante reconstruite depuis le journal + snapshot ; coalescence `HEAD_COALESCE_MS` (1 s par défaut, 0 = désactivée)              | Le journal étant écrit avant acquittement, rien n'est en retard ; la coalescence protège sous pic                                       | Appeler le serveur collab depuis la Lambda (dépendance et exposition d'un endpoint interne) |
| D-24 | Limite connue : modification dans la fenêtre de coalescence → version suivante. Elle apparaît dans DESIGN et dans le rapport                | Honnêteté sur la tolérance de C3                                                                                                        | —                                                                                           |
| D-25 | Génération PDF : `pdfkit` + police TrueType embarquée, PDF complet en mémoire puis `PutObject` unique avec `If-None-Match: *`        | Jamais de fichier partiel publié ; objet immuable par version ; 412 = succès                                                             | Écrire en flux dans S3                                                                      |
| D-26 | Single-flight : `PutItem` conditionnel sur `pdf_jobs` ; seul le créateur du job publie le message SQS ; reconciler pour les envois perdus | Une génération par version ; pas de double génération ni de perte de message                                                           | Mécanisme de réconciliation maison sans table de jobs                                      |
| D-27 | Après échec définitif (DLQ), `pdf-dlq-handler` rembourse les réservations `reserved` de la version dans une transaction                | Aucune URL n'était sortie : la limite stricte est préservée (D-05)                                                                      | Laisser la copie consommée sans livraison                                                   |
| D-28 | Notification du dernier exemplaire par **DynamoDB Streams → Lambda** + table `notifications` à clé `linkId` (put conditionnel)    | Événement logique unique, durable, réessayable (D07) ; pas de dual-write maison                                                         | Envoyer l'e-mail dans le chemin de réservation                                              |
| D-29 | Si un remboursement ramène `issued` sous le maximum après la notification, aucune seconde notification n'est envoyée                      | Clé = `linkId`                                                                                                                          | —                                                                                           |

## 5. Plateforme AWS et infrastructure

| ID   | Décision                                                                                                          | Raison                                                                                                                                         | Alternative écartée                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| D-30 | EC2 unique (Next.js + Hocuspocus en conteneurs) derrière Caddy, CloudFront devant                                 | Hocuspocus est un serveur WebSocket long-lived, incompatible avec Lambda ; CloudFront apporte TLS, WSS et un domaine sans certificat à gérer | ALB (coût), Fargate (coût et plus de pièces)                               |
| D-31 | API de téléchargement en Lambda (Function URL) avec interrupteur Terraform `download_origin = "ec2"`           | Absorbe le pic sans dimensionner l'EC2 ; plan B si la concurrence Lambda du compte est trop basse (comptes neufs)                              | Tout sur l'EC2 par défaut                                                    |
| D-32 | Pas de VPC dédié, pas de NAT Gateway, pas de SSH (accès par SSM Session Manager)                                | Coût et surface d'attaque ; aucun composant n'exige un VPC privé                                                                             | VPC privé + NAT : coûteux et inutile ici                                    |
| D-33 | Groupe de sécurité : entrée port 80 uniquement depuis le prefix list géré CloudFront ; un seul port via Caddy | Évite plusieurs règles à fort poids dans le groupe de sécurité                                                                            | Ports 3000 et 1234 exposés séparément                                      |
| D-34 | Région : `eu-north-1` (Paris), une seule                                                                         | Contrainte du sujet ; latence raisonnable depuis Yaoundé ; SES disponible                                                                     | `us-east-1` (moins cher mais plus loin), `af-south-1` (moins de services) |
| D-35 | Terraform ≥ 1.10, backend S3 avec `use_lockfile = true` (pas de table DynamoDB de verrou)                       | Le verrou DynamoDB est déprécié                                                                                                             | Backend DynamoDB                                                              |
| D-36 | Secrets dans SSM Parameter Store, **créés à la main**                                                     | Ne figurent pas dans l'état Terraform ni dans le dépôt                                                                                      | `random_password` Terraform : secret dans le tfstate                        |
| D-37 | `terraform apply` et `destroy` jamais lancés par la CI                                                        | Opérations destructrices protégées et documentées                                                                                          | Apply automatique                                                             |
| D-38 | CI : OIDC GitHub → AWS, aucune clé permanente ; environnement protégé pour le déploiement                     | Exigence de sécurité du sujet                                                                                                                | Clés AWS dans les secrets GitHub                                             |
| D-39 | Pas de versioning S3 sur le bucket de données (réservé au bucket d'état)                                       | Les PDF sont immuables par clé de version                                                                                                     | Versioning général                                                          |
| D-40 | Kubernetes hors périmètre                                                                                        | Complexité et coût sans bénéfice pour les objectifs du sujet                                                                               | —                                                                            |

## 6. Développement local

| ID   | Décision                                                                                          | Raison                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| D-41 | DynamoDB Local + MinIO + ElasticMQ + Mailpit dans Docker ; mêmes interfaces que sur AWS           | Tests proches de la production (SQS avec DLQ/redrive, URL pré-signées, e-mails visibles) sans compte AWS |
| D-42 | Flux de stream local en mode inline (`STREAM_MODE=inline`)                                       | Évite un poller de streams ; la fonction `handleLinkChange` est la même qu'en production               |
| D-43 | Un seul `package.json` à la racine, alias `@shared/*`, bundles esbuild pour Lambdas et collab | Moins de configuration qu'un monorepo ; adapté à un week-end                                             |
| D-44 | Tous les horodatages stockés en UTC                                                               | Évite les ambiguïtés de fuseau                                                                          |

## 7. Limites connues (à reprendre dans DESIGN.md)

- L'URL pré-signée est un jeton porteur : partageable pendant son TTL (60 s). Atténuation : TTL court, une URL par réservation, pas de réémission.
- Visiteurs anonymes : un script peut générer autant de `requestId` qu'il veut ; chaque URL émise compte comme une copie. Pas de WAF ni de limitation par IP dans la version principale.
- Plusieurs adresses e-mail pour une même personne contournent le crédit par personne (limite de D-10).
- Coalescence de version (D-24).
- Surfacturation possible du crédit après crash (D-15).
- Un seul serveur collab : point de défaillance unique ; reprise par redémarrage sans perte grâce au write-ahead.
- Scans DynamoDB du reconciler : acceptables seulement sur de petites tables.

## 8. Points encore ouverts

| #   | Point                                                            | Proposition actuelle                                               |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| O-1 | Objectif de latence du pic (p95 du chemin de téléchargement)   | À fixer avant la mesure ; renseigner dans TEST_REPORT             |
| O-2 | Seuils d'abus (`ABUSE_THRESHOLD`, fenêtre, durée de blocage) | 10 événements / 60 s → blocage 15 min ; ajustables              |
| O-3 | Volume exact réellement testé pour 15 000 visiteurs            | Dépend du budget et des quotas ; à indiquer honnêtement         |
| O-4 | Type d'instance EC2 (`t3.small` ou `t3.micro`)               | `t3.small` ; vérifier l'éligibilité et la mémoire disponible |
| O-5 | Alias Lambda `live` pour le retour arrière                    | Si le temps le permet                                              |

## 9. Constats et décisions de l'agent (à remplir)

### 9.1 Constats sur le projet Next.js existant

- Version de Next.js :
- Router (App Router ou Pages Router) :
- Gestionnaire de paquets :
- Tailwind / UI existante :
- Éléments conservés tels quels :
- Version de Next.js : 16.4.3 (avec React 19.3.0)
- Router (App Router ou Pages Router) : App Router (`app/`)
- Gestionnaire de paquets : npm (avec package-lock.json)
- Tailwind / UI existante : Tailwind CSS v4 (`@tailwindcss/turbopack`, `@import "tailwindcss";`), polices Google Geist via `next/font/google`
- Éléments conservés tels quels : structure de base `app/layout.tsx`, `app/globals.css`, configuration Turbopack et ESLint
- Éléments modifiés (et pourquoi) :
  - `tsconfig.json` : ajout du path `@shared/*` -> `./src/shared/*` pour les imports partagés ; cible ES2022 ; exclusion de `dist/` et `loadtest/`.
  - `.gitignore` : autorisation de commit pour `.env.example`, exclusion de `dist/`, `.terraform/`, `*.tfstate*`, `backend.hcl`, `*.tfvars`.
  - `package.json` : ajout des scripts `local:*`, `dev:all`, `typecheck`, `test:*`, `loadtest:*`, `smoke`, `build:*`.

### 9.2 Décisions et écarts pris pendant l'implémentation

| Date | Phase | Décision ou écart | Raison | Alternative écartée | Impact invariants |
| ---- | ----- | ------------------- | ------ | --------------------- | ----------------- |
| 2026-10-24 | Phase 0 | Image Docker `pgsty/minio:latest` au lieu de `minio/minio:latest` | L'image officielle Docker Hub `minio/minio:latest` renvoie une erreur d'accès refusé (dépôt retiré / privé) | Image officielle inaccessible | Aucun : même API S3, ports 9000/9001 identiques |
| 2026-10-24 | Phase 0 | Node.js `@types/node` fixé à `^24.19.2` | Compatibilité avec l'environnement d'exécution Node v24 local et peerDependency de Vitest 5 | `@types/node@20` incompatible avec Vitest 5 | Aucun |
| 2026-10-24 | Phase 1 | Cache mémoire 1s `exhausted` + TransactWriteItems conditionnel | Évite les écritures DynamoDB refusées sous pic tout en garantissant strictement C1 (issued <= maxDownloads) | Écriture systématique (sature DynamoDB) ou Redis (interdit D-02) | Respect strict de C1, C5 et I01 |
| 2026-10-24 | Phase 2 | Authentification par JWT HttpOnly sans mot de passe avec GSI `by_writer` pour les permissions | Conforme à D-10 ; simplifie le parcours rédacteur tout en garantissant l'isolation des droits | Stockage des sessions dans DynamoDB avec lookup à chaque requête | Respect de l'isolation des données et du contrôle d'accès |
| 2026-10-24 | Phase 3 | Interception `beforeSync` et write-ahead log séquentiel dans `doc_updates` | Garantit qu'aucun update n'est diffusé aux autres rédacteurs avant d'être persisté en base (C2, D-12) | Persistance asynchrone non bloquante (risque de divergence/perte en cas de crash) | Respect strict de C2, I03, I04, I06 |
| 2026-10-24 | Phase 3 | Décompte exact des nouveaux caractères UTF-16 via `IntervalSet` par `(clientId, clock)` | Empêche la double facturation lors des retransmissions ou duplications réseau (I06) | Facturation aveugle de la taille du message reçu | Respect strict de C4 et I06 |
| 2026-10-24 | Phase 4 | Débit de crédit atomique conditionnel dans DynamoDB (`attribute_not_exists(used) OR used <= DAILY_CREDIT - n`) et blocage d'abus 15min | Garantit la limite stricte de 10 000 caractères UTF-16 par jour sans condition de course et protège contre les requêtes abusives répétées | Décompte en mémoire dans le serveur WebSocket (perdu en cas de redémarrage) | Respect strict de C4 |
| 2026-10-24 | Phase 5 | Single-flight de génération PDF par docId/versionId dans DynamoDB `pdf_jobs` + écriture conditionnelle S3 `If-None-Match: *` | Empêche les générations concurrentes redondantes de la même version et garantit l'immuabilité sans écrasement (C3, I01, I05) | Régénération systématique à chaque demande de téléchargement | Respect strict de C3, I01 et I05 |
| 2026-10-24 | Phase 5 | Restitution automatique des exemplaires réservés via le handler DLQ en cas d'échec de rendu PDF | Assure qu'aucun quota de lien n'est perdu si la génération PDF échoue définitivement | Abandon silencieux des réservations expirées sans remboursement | Respect strict de C1 et F12 |
| 2026-10-24 | Phase 6 | Idempotence absolue des notifications par `attribute_not_exists(linkId)` sur `notifications` | Garantit qu'un seul e-mail est expédié au créateur même en cas de rejeu du stream DynamoDB ou de relance du reconciler | Envoi direct sans table d'état intermédiaire (risque de doublon lors des rejeux) | Respect strict de F11 et D07 |
| 2026-10-24 | Phase 6 | Restauration d'historique comme nouvelle évolution (`billedChars = 0`) et limite de 10 restaurations/h | Préserve l'arbre des modifications antérieures sans perte (I08) et évite le contournement du quota quotidien | Remplacement destructif de l'historique ou facturation de la restauration | Respect strict de I08 et C4 |
| 2026-10-24 | Phase 6 | Comparaison à temps constant `timingSafeEqual` pour `ADMIN_TOKEN` et `INTERNAL_TOKEN` | Empêche les attaques par canal auxiliaire temporel sur les routes de supervision et d'administration | Comparaison classique `===` vulnérable aux attaques temporelles | Sécurité et conformité Section 6.5 & 16 |
| 2026-10-24 | Phase 8 | Résolution du piège Section 20 pour `pdfkit` (standard-fonts & import.meta.url shim) | Permet l'exécution sans erreur de PDFKit bundlé par esbuild en CJS sous AWS Lambda et Node local | Conserver node_modules complet dans le zip ou abandonner DejaVu Sans | Respect strict de C3 et Section 20 |
| 2026-10-24 | Phase 8 | Conteneurs Docker de production utilisant les bundles autonomes (`.next/standalone` et `dist/collab/server.js`) | Temps de build de quelques secondes, images légères (< 150 Mo), zéro devDependencies en production | Build de Next.js et npm ci intégrés dans le conteneur sans cache | Robustesse et conformité Section 17 |
| 2026-10-24 | C-02 | Pas de réémission d'URL pré-signée après expiration (D-04/D-05) | UNE seule URL par réservation ; après expiration retourne 200 {state: 'expired'} sans réémission ni écriture DynamoDB | Régénération d'URL à la volée (viole C1 : permet des téléchargements infinis) | Respect strict de C1 ("jamais un téléchargement de plus") et D-04/D-05 |
| 2026-10-24 | C-01 | Maintien de `inFlight: Set<number>` et fonction pure `safeUpToSeq(state)` | Évite qu'un snapshot ne déclare couvrir un seq pas encore appliqué ou journalisé en cas de course concurrente | Utiliser `state.latestSeq` directement (cause de perte de données) | Respect strict de C2 et I03 ("aucune modification acceptée n'est perdue") |
| 2026-10-24 | C-01 | Libération de `inFlight` dans `setImmediate` après `beforeSync` et bloc `finally` sur erreur | Enquête Hocuspocus v4 : l'application Yjs dans `MessageReceiver.apply` est synchrone immédiatement après `beforeSync`. `setImmediate` garantit l'application avant libération. | Hook `afterHandleMessage` (qui ne reçoit pas le `seq`) | Robustesse et cohérence mémoire/disque |
| 2026-10-24 | C-01 | Capture synchrone de `upToSeq` et `snapshotBytes` au même tick dans `persistDocumentSnapshot` | Évite qu'un `await` intermédiaire ne permette à des updates concurrents d'entrer dans `state.latestSeq` sans figurer dans le snapshot | Calculer `upToSeq` après les écritures S3 (bogue original) | Élimination de la course snapshot / journal |
| 2026-10-24 | C-01 | Marge de sécurité `REPLAY_MARGIN` (défaut 200) pour le rejeu et la purge du journal | Défense en profondeur : rejouer un update Yjs est idempotent, en sauter un est fatal. Purge uniquement `seq <= upToSeq - REPLAY_MARGIN`. | Purge immédiate de `seq <= upToSeq` sans marge | Invariant C2 garanti même en cas d'anomalie transitoire |
| 2026-10-24 | C-01 | Fallback de `getHead` sur `doc_snapshots` quand le journal est vide et aucun head n'existe | Empêche de renvoyer un document vierge si un document existant a eu son journal purgé après snapshot | Renvoyer un texte vide par défaut sans consulter `doc_snapshots` | Respect strict de C3 ("la dernière version acceptée") |

### 9.4 Extraits des sorties ROUGE avant correctifs (C-01, C-02)

#### C-01 : Course entre snapshot et journal (perte d'updates concurrents)
```text
FAIL  tests/scenarios/sc01b-snapshot-concurrent-writes.test.ts > SC01b — Course entre snapshot et journal (C-01 / C2 / I03) > T2. Course entre snapshots et 1000 updates concurrents (20 graines déterministes)
AssertionError: expected 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD…' to be 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD…' // Object.is equality

- Expected: 1000 caractères
- Received: 945 caractères (mises à jour concurrentes perdues lors de la compaction et purge du journal)

 ❯ runConcurrentWritesTest tests/scenarios/sc01b-snapshot-concurrent-writes.test.ts:214:24
    212|     const head = await getHead(docId);
    213|
    214|     expect(loadedText).toBe(expectedText);
       |                        ^
    215|     expect(head.versionId).toBe(computeVersionId(expectedText));
```

#### C-02 : Réémission d'URL pré-signée après expiration
```text
FAIL  tests/scenarios/sc02b-no-url-reissue.test.ts > SC02b — Pas de réémission d'URL pré-signée après expiration (C-02 / C1) > T1. PRESIGN_TTL_SEC=1 : Réserver, obtenir granted (u1), attendre 2s -> 10 appels GET retournent expired et u1 reste l'unique URL
AssertionError: expected 'granted' to be 'expired' // Object.is equality
Expected: "expired"
Received: "granted"

FAIL  tests/scenarios/sc02b-no-url-reissue.test.ts > SC02b — Pas de réémission d'URL pré-signée après expiration (C-02 / C1) > T3. Invariant global : 50 exemplaires, 200 visiteurs, polling répété sur 3xTTL -> nombre d'URL distinctes <= 50
AssertionError: expected 4 to be 1 // Object.is equality
- Expected
+ Received
- 1
+ 4

FAIL  tests/scenarios/sc02b-no-url-reissue.test.ts > SC02b — Pas de réémission d'URL pré-signée après expiration (C-02 / C1) > T4. Table reservations : au plus UNE transition vers url_issued par réservation
AssertionError: expected 'http://localhost:9000/...Date=20261024T214921Z...' to be 'http://localhost:9000/...Date=20261024T214922Z...'
```



### 9.3 Dépendances ajoutées (une ligne par ajout)

| Paquet | Usage | Pourquoi nécessaire |
| ------ | ----- | -------------------- |
| `@hocuspocus/server` (4.7.1) | Serveur de synchronisation collaborative | Serveur WebSocket Hocuspocus temps réel (D-02) |
| `@hocuspocus/provider` (4.7.1) | Provider client Yjs | Connexion WebSocket entre CodeMirror et Hocuspocus (D-03) |
| `yjs` (13.6.33) | CRDT de texte brut | Structure Y.Text pour convergence sans conflit (D-01, C2) |
| `y-protocols` (1.0.7) | Décodage messages Yjs | Décodage et interception des messages sync dans beforeHandleMessage (7.3) |
| `lib0` (0.2.119) | Encodage/décodage binaire | Primitives binaires pour les flux Yjs et messages personnalisés |
| `y-codemirror.next` (0.3.6) | Binding CodeMirror 6 | Intégration de Y.Text et affichage des curseurs distants (D-03) |
| `codemirror` (6.0.2) + `@codemirror/state` + `@codemirror/view` | Éditeur de code et texte | Éditeur web léger, performant et modulaire |
| `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` (3.1156.0) | Client DynamoDB | Gestion des tables, transactions atomiques, journal d'updates et quotas |
| `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (3.1156.0) | Client S3 | Stockage des snapshots, textes immuables, PDF et URLs pré-signées (D-04) |
| `@aws-sdk/client-sqs` (3.1156.0) | Client SQS | File de messages asynchrone pour la génération PDF et DLQ (10.4, 10.5) |
| `@aws-sdk/client-sesv2` (3.1156.0) | Client SES | Envoi de l'e-mail au créateur lors du dernier exemplaire sur AWS (F11) |
| `@aws-sdk/client-ssm` (3.1156.0) | Client SSM Parameter Store | Lecture sécurisée des secrets applicatifs sur AWS sans clés codées (D-36) |
| `pdfkit` (0.20.2) | Générateur PDF | Génération déterministe et autonome des PDF avec police TrueType DejaVu (10.4) |
| `zod` (4.6.7) | Validation de schémas | Validation stricte des variables d'env et des corps de requête API (6.0) |
| `jose` (6.2.13) | Chiffrement et JWT | Sessions cookies HttpOnly (HS256) et tokens de collaboration (D-10) |
| `nodemailer` (10.2.1) | Client SMTP | Envoi d'e-mails vers Mailpit en local (14.1) |
| `vitest` (5.0.5) | Framework de tests | Tests unitaires, d'intégration et scénarios critiques (15.1, 15.3) |
| `tsx` (4.23.15) | Runner TypeScript | Exécution directe des scripts et serveurs TypeScript sans étape de compilation |
| `esbuild` (0.28.2) | Bundler | Compilation rapide du serveur collab et des zips Lambda |
| `concurrently` (10.0.6) | Orchestrateur de tâches dev | Exécution conjointe de Next, collab, poller et reconciler dans `npm run dev` |
| `pdfjs-dist` (6.4.299) | Analyse de PDF | Vérification du contenu textuel des PDF dans les tests SC03 |

