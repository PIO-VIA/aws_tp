
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
| 2026-10-24 | C-04 | Isolation stricte du rendu PDF au seul `pdf-worker` (jamais de rendu dans `handleGetReservation` ni `persistDocumentSnapshot`) | Évite la saturation CPU sous pic sur l'API de téléchargement et le serveur collab ; garantit l'utilisation exclusive de la file SQS et de la concurrence contrôlée | Rendu synchrone de secours lors du polling (contournait SQS, DLQ et timeout) | Performance sous pic et respect strict de C3, I05 |
| 2026-10-24 | C-04 | Découplage de `computeVersionId` dans `src/shared/pdf/version.ts` et exclusion de `pdfkit` du bundle `download-api` | `download-api` n'a pas besoin de `pdfkit` ni de DejaVu Sans ; bundle réduit de 3.27 Mo à 2.17 Mo (< 3 Mo) | Conserver `computeVersionId` dans `render.ts` (importait `pdfkit` par effet de bord) | Réduction taille de bundle Lambda et rapidité de cold-start |
| 2026-10-24 | C-05 | Fonction unique idempotente `advanceReservation(res)` et capture des pannes transitoires | Permet la reprise immédiate des réservations orphelines (sans versionId) lors des retries ou du polling, sans double débit de copie (`issued` reste incrémenté de 1) et sans jamais renvoyer 500 au visiteur (réponse 202 `preparing`) | Laisser la réservation bloquée en `preparing` jusqu'au scan du reconciler (10 minutes d'attente pour le visiteur) | Résilience aux pannes transitoires, zéro réservation orpheline bloquée, respect strict de C1 |
| 2026-10-25 | C-03 | Limiteur de débit par connexion dans `beforeSync` (fenêtre glissante 5s, seuil `RATE_MAX_UPDATES_PER_SEC * 5`) et cache mémoire 5s pour blocage en cours de session | Protection active contre les rafales d'updates et fermeture immédiate (4403) dès qu'un rédacteur est bloqué en cours de session | Vérification uniquement lors du handshake d'authentification (permettait à un rédacteur bloqué de continuer à écrire indéfiniment) | Respect strict de F09, C4 et protection anti-abus en temps réel |
| 2026-10-25 | C-03 | Refus d'update par `connection.readOnly = true` et `write_refused` sans fermeture sauvage tant que le seuil d'abus n'est pas atteint | Permet de notifier le client en temps réel sans détruire la connexion sur un pic transitoire ; fermeture 4403 uniquement après `ABUSE_THRESHOLD` (5) abus | `throw Error` systématique qui fermait brutalement la connexion avec code 4400 au lieu de délivrer les notifications `write_refused` | Conformité au protocole de refus Section 7.4 et UX client |
| 2026-10-25 | C-06 | Verrou conditionnel d'envoi (`SET #st = :sending, claimedAt = :now` sous condition `#st = :pending AND (attribute_not_exists(claimedAt) OR claimedAt < :staleCutoff)`) | Élimine les doublons d'e-mail lors des courses concurrentes entre `handleLinkChange` et le réconciliateur | Envoi direct SES sans réservation d'état intermédiaire (provoquait l'envoi de multiples e-mails pour le même lien) | Exactly-once logique, idempotence et zéro doublon d'e-mail |
| 2026-10-25 | C-06 | Helper générique de scan paginé `scanAll<T>` bouclant sur `LastEvaluatedKey` pour tous les scans de tables DynamoDB | Empêche la troncature silencieuse au-delà de 1 Mo / 1000 items qui laissait des notifications bloquées, des jobs non relancés et des réservations orphelines non remboursées | Scans bruts sans pagination | Exhaustivité des réconciliations et remboursements DLQ |
| 2026-10-25 | C-10 | Moindre privilège IAM, variable obligatoire `permissions_boundary_arn` sur les 8 rôles et durcissement IMDSv2 / logs | Conforme aux exigences de sécurité du sujet ("chaque composant n'a que les droits dont il a besoin"). Supprime les jokers superflus, resserre SES à l'identité, ECR aux 2 dépôts, journalisation conteneurs sous `awslogs` et impose IMDSv2 avec hop limit 2. | Maintenir `Resource = "*"` partout ou omettre les permissions boundaries | Respect strict du principe de moindre privilège et sécurité Cloud |
| 2026-10-25 | C-11 | Analyse Checkov sur `infra/terraform`, conditionnement de `deploy.yml` sur succès de CI, concurrence et variables `vars.*` | Garantit que le déploiement ne peut être déclenché si la CI échoue, évite les collisions de déploiement, migre les identifiants publics vers `vars.*` et sécurise le rollback immédiat | Déploiement direct sans vérification de CI ou utilisation de secrets pour des identifiants non sensibles | Intégrité et reproductibilité du pipeline CI/CD |
| 2026-10-25 | C-12 | Alignement strict de la documentation : correction des numéros de fonctionnalités (F05, F10, F11), remplacement des affirmations invérifiables, 7 limites documentées dans DESIGN.md et test de contrat API | Rétablit l'honnêteté technique et la rigueur d'ingénierie : aucune affirmation sans preuve ou fichier de résultat, alignement avec `DEPLOIEMENT_AWS.md`, validation des 6 états de téléchargement | Conserver des affirmations non prouvées ou des numéros de fonctionnalités erronés | Intégrité documentaire et conformité Section 12 |

### 9.4 Extraits des sorties ROUGE avant correctifs (C-01 à C-12)

#### C-11 : CI et Déploiement (Checkov, Gating CI, Variables Actions, Rollback)
```text
FAIL  tests/unit/ci-deploy-contract.test.ts > C-11 : Vérification du contrat CI et Déploiement > V1. ci.yml intègre Checkov sur infra/terraform et toutes les suites de tests
AssertionError: expected '...' to contain 'bridgecrewio/checkov-action'

FAIL  tests/unit/ci-deploy-contract.test.ts > C-11 : Vérification du contrat CI et Déploiement > V2. deploy.yml est conditionné au succès de la CI et définit la concurrence
AssertionError: expected '...' to contain 'concurrency:'

FAIL  tests/unit/ci-deploy-contract.test.ts > C-11 : Vérification du contrat CI et Déploiement > V3. deploy.yml utilise vars.* pour les identifiants non-secrets et ne contient aucune clé AWS
AssertionError: expected '...' to contain 'vars.AWS_DEPLOY_ROLE_ARN'

FAIL  tests/unit/ci-deploy-contract.test.ts > C-11 : Vérification du contrat CI et Déploiement > V4. Le smoke test et deploy.yml affichent la commande de retour arrière en cas d'échec
AssertionError: expected '...' to contain 'rollback-ec2.sh'
```

#### Règles Checkov ignorées (Skip List) et Justifications d'Ingénierie (C-11)

| Règle Checkov | Description | Justification d'architecture / Non-pertinence |
| :--- | :--- | :--- |
| `CKV_AWS_18` | S3 bucket access logging | Aucun bucket de logging d'accès dédié configuré afin de limiter les coûts fixes et la prolifération de buckets sur le compte AWS. |
| `CKV_AWS_144` | S3 bucket cross-region replication | L'architecture retenue est strictement mono-région (`eu-north-1`) ; aucune réplication géographique n'est requise par le cahier des charges. |
| `CKV_AWS_145` | S3 bucket KMS CMK | Le chiffrement standard côté serveur AES-256 (`SSE-S3`) avec clés gérées par AWS est actif par défaut sans surcoût par requête KMS. |
| `CKV_AWS_21` | S3 bucket versioning | L'immuabilité des artefacts PDF et textes est assurée au niveau applicatif par nommage déterministe SHA-256 (`<docId>/<versionId>.pdf`). Le versioning S3 générerait des surcoûts d'espace inutiles. |
| `CKV_AWS_116` | Lambda DLQ | Les Lambdas synchrones (`download-api`) et asynchrones gérées par DynamoDB Streams / EventBridge n'ont pas de DLQ directe ; seul `pdf-worker` traite une file SQS qui intègre déjà sa propre DLQ dédiée (`pdf-jobs-dlq`). |
| `CKV_AWS_117` / `CKV_AWS_272` | Lambda code-signing | La signature cryptographique des packages Lambda n'est pas mise en œuvre pour ce projet d'évaluation académique. |
| `CKV_AWS_173` | Lambda env vars KMS encryption | Les variables d'environnement des Lambdas ne contiennent aucun secret sensible ; les secrets d'administration sont centralisés dans AWS SSM Parameter Store. |
| `CKV_AWS_135` | EC2 EBS-optimized | Les instances `t3.micro` / `t3.small` intègrent l'optimisation EBS par défaut. |
| `CKV_AWS_68` | CloudFront WAF | Arbitrage budgétaire assumé (limite D-XX dans DESIGN.md) : AWS WAF facture 5 $/mois + 1 $/règle, incompatible avec le budget de 10 $/mois. Protection assurée par le rate-limiter applicatif. |
| `CKV_AWS_86` | CloudFront access logging | Les journaux d'accès CloudFront vers S3 sont désactivés pour respecter l'enveloppe budgétaire. |
| `CKV_AWS_66` | SQS KMS encryption | Les files SQS utilisent le chiffrement géré `SSE-SQS` activé par défaut. |
| `CKV_AWS_27` | SQS DLQ for DLQ | La file `pdf-jobs-dlq` est la file de rebut terminale ; elle ne nécessite pas de DLQ de second niveau. |
| `CKV_AWS_28` | DynamoDB PITR | La sauvegarde continue à un instant donné (PITR) génère des coûts horaires permanents ; désactivée sur l'environnement de développement. |
| `CKV_AWS_119` | DynamoDB KMS CMK | Chiffrement par défaut au repos avec clés gérées AWS (sans surcoût KMS). |
| `CKV_AWS_158` | CloudWatch Log Group KMS | Chiffrement standard CloudWatch actif sans clé KMS dédiée. |

#### Tableau Avant / Après des permissions et configurations durcies (C-10)

| Composant / Règle | Avant durcissement | Après durcissement | Justification / Conformité |
| ----------------- | ------------------ | ------------------ | -------------------------- |
| **Permissions Boundary** | Absente de tous les rôles IAM | `permissions_boundary = var.permissions_boundary_arn` sur les 8 rôles (`download_api`, `pdf_worker`, `pdf_dlq_handler`, `notifier`, `reconciler`, `ec2`, `github_deploy`, `github_plan`) | Empêche toute élévation de privilège non autorisée au-delà de la borne définie par l'organisation. |
| **SES (`notifier`, `reconciler`)** | `Resource = "*"` sur `ses:SendEmail`, `ses:SendRawEmail` | `Resource = "arn:aws:ses:${local.region}:${local.account_id}:identity/${var.ses_sender}"` avec condition `StringEquals "ses:FromAddress" = var.ses_sender` | Interdit l'envoi d'e-mails sous d'autres identités ou adresses arbitraires. |
| **ECR CI (`github_deploy`)** | `Resource = "*"` sur toutes les actions ECR | `ecr:GetAuthorizationToken` en `Resource = "*"` (obligatoire AWS IAM) ; `ecr:PutImage`, `InitiateLayerUpload`, etc. restreints à `[aws_ecr_repository.app.arn, aws_ecr_repository.collab.arn]` | Empêche la CI de pousser ou modifier des images dans d'autres dépôts du compte AWS. |
| **ECR EC2 (`ec2_app`)** | `Resource = "*"` sur toutes les actions ECR | `ecr:GetAuthorizationToken` en `Resource = "*"` (obligatoire AWS IAM) ; `BatchGetImage`, `GetDownloadUrlForLayer`, etc. restreints aux deux dépôts applicatifs | Empêche l'instance EC2 de lire ou puller des images tierces du compte. |
| **DynamoDB Streams (`notifier`)** | `dynamodb:ListStreams` ciblant `stream_arn` (incompatible AWS IAM) | Isolé avec `Resource = "*"` et commentaire explicatif justifiant la limitation de l'API AWS IAM | Conforme à la syntaxe stricte d'IAM pour les actions globales non adressables par ARN. |
| **CloudWatch Logs EC2** | `/opt/app/*` avec `logs:CreateLogGroup`, `CreateLogStream`, `PutLogEvents` | Restreint à `/${var.project}/${var.environment}/app:*` et `/collab:*` ; droits limités à `logs:CreateLogStream` et `logs:PutLogEvents` | Conforme au contrat 10.1 et 10.5 ; la création des log groups (14j rétention) est déléguée à Terraform. |
| **SSM Document (`github_deploy`)** | `arn:aws:ssm:${local.region}:*:document/AWS-RunShellScript` (avec joker de compte) | `arn:aws:ssm:${local.region}::document/AWS-RunShellScript` (sans joker de compte) | Supprime le joker de compte pour les documents système AWS gérés. |
| **GitHub OIDC Trust** | Acceptait `ref:refs/heads/main` et joker `environment:*` | Restreint à `sub = "repo:${var.github_repo}:environment:${var.github_environment}"` et `aud = "sts.amazonaws.com"` | Seul un runner authentifié sur l'environnement cible exact de ce dépôt peut assumer le rôle. |
| **EC2 IMDSv2** | Non spécifié (IMDSv1 autorisé par défaut, hop limit 1) | `http_tokens = "required"`, `http_put_response_hop_limit = 2`, `http_endpoint = "enabled"` | Bloque les attaques SSRF (IMDSv2) et permet aux conteneurs Docker en mode bridge de joindre le service (hop limit 2). |
| **Conteneurs logs (`docker-compose.prod.yml`)** | Pilote par défaut `json-file` local (aucun log dans CloudWatch) | Pilote `awslogs` configuré vers `/${project}/${environment}/app` et `/collab` | Centralisation de la supervision dans CloudWatch logs avec rétention 14 jours. |
| **CloudFront Price Class** | `PriceClass_100` codé en dur | Variable configurable `cloudfront_price_class` (défaut `"PriceClass_All"`) | Optimisation de la latence africaine (Yaoundé) avec switch économique disponible. |
| **Sorties Terraform** | 7 sorties sans SSM ni logs | Ajout de `ssm_parameter_names` et `log_group_names` | Déploiement et orchestration automatisés reproductibles. |

#### C-06 : Scans non paginés et notifications sans réservation (doublon d'e-mail)
```text
FAIL tests/unit/scan-all.test.ts
TypeError: scanAll is not a function

FAIL tests/scenarios/sc06-notifications-and-scans.test.ts > SC06 — Scans paginés et réservation conditionnelle de notification (C-06) > T2. 10 appels simultanés du notifier + 10 du reconciler sur la même notification : exactement 1 e-mail dans Mailpit
AssertionError: expected 7 to be 1 // Object.is equality
- Expected
+ Received
- 1
+ 7
 ❯ tests/scenarios/sc06-notifications-and-scans.test.ts:101:23
    100|
    101|     expect(data.total).toBe(1);
       |                        ^

FAIL tests/scenarios/sc06-notifications-and-scans.test.ts > SC06 — Scans paginés et réservation conditionnelle de notification (C-06) > T3. Réservation périmée (claimedAt ancien) reprise
TypeError: sendLastCopyNotification is not a function
```

#### C-03 : Détection de rafale absente et blocage en cours de session
```text
FAIL  tests/scenarios/sc04b-burst-and-session-block.test.ts > SC04b — Détection de rafale et blocage en cours de session (C-03 / F09) > T1. Rafale : un client envoie 400 updates en 2s -> refus rate_limited, blocage pour abus, document = updates acceptés
AssertionError: expected 0 to be greater than 0
 ❯ tests/scenarios/sc04b-burst-and-session-block.test.ts:135:35
    133|
    134|     // Des refus rate_limited doivent avoir été émis
    135|     expect(refusedReasons.length).toBeGreaterThan(0);
       |                                   ^
    136|     expect(refusedReasons).toContain("rate_limited");
    137|

FAIL  tests/scenarios/sc04b-burst-and-session-block.test.ts > SC04b — Détection de rafale et blocage en cours de session (C-03 / F09) > T2. Blocage en cours de session : rédacteur connecté et en écriture -> update valide suivant sur la MÊME connexion refusé ('blocked')
AssertionError: expected false to be true // Object.is equality
- Expected
+ Received
- true
+ false
 ❯ tests/scenarios/sc04b-burst-and-session-block.test.ts:202:65
    200|
    201|     // L'update doit être refusé avec reason "blocked" et la connexion fermée avec 4403
    202|     expect(refusedMessages.some((m) => m.reason === "blocked")).toBe(true);
```

#### C-05 : Réservation orpheline et reprise (advanceReservation)
```text
FAIL  tests/integration/c05-advance-reservation.test.ts > C-05 — Réservation orpheline et reprise (advanceReservation) > T1. getHead échoue au premier appel : réponse 202 avec reservationId ; 2ème appel (même requestId) aboutit ; links.issued n'augmente que de 1
Error: Injection panne transitoire getHead
 ❯ tests/integration/c05-advance-reservation.test.ts:96:7

FAIL  tests/integration/c05-advance-reservation.test.ts > C-05 — Réservation orpheline et reprise (advanceReservation) > T3. Deux advanceReservation concurrents sur la même réservation : un seul versionId écrit, une seule URL émise
TypeError: advanceReservation is not a function
 ❯ tests/integration/c05-advance-reservation.test.ts:299:7
```

#### C-04 : Rendu PDF hors du PDF-Worker (polling download-api et collab)
```text
FAIL  tests/integration/c04-pdf-isolation.test.ts > C-04 — Rendu PDF hors du PDF-Worker > T1. Poller SQS arrêté, réservation sans PDF : GET reservation renvoie 202 'preparing', renderPdfBuffer : 0 appel, job 'pending' existe
AssertionError: expected "renderPdfBuffer" to be called +0 times, but got 1 times

FAIL  tests/integration/c04-pdf-isolation.test.ts > C-04 — Rendu PDF hors du PDF-Worker > T2. Test de bundle : metafile sans pdfkit pour download-api et taille zip < 3 Mo
AssertionError: expected true to be false // hasPdfKit was true in download-api bundle

FAIL  tests/integration/c04-pdf-isolation.test.ts > C-04 — Rendu PDF hors du PDF-Worker > T3. Snapshot : espion sur renderPdfBuffer : 0 appel lors de persistDocumentSnapshot
AssertionError: expected "renderPdfBuffer" to be called +0 times, but got 1 times
```

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

#### C-08 : Tests de charge en boucle ouverte et mesures de production
```text
FAIL  tests/unit/loadtest-open-loop.test.ts > Planification en boucle ouverte (Open Loop - C-08) > T1. Répartition 80% première minute / 20% 4 minutes suivantes
Error: Cannot find module '../../loadtest/scheduler'
 ❯ tests/unit/loadtest-open-loop.test.ts:4:33
```
- **Run 1 (600 visiteurs / 500 copies)** : `2026-10-25T01-13-09-504Z-download-burst.json`. Invariant C1 : 500/500 distinctes, 500 en DB, C6 -69 ms, 0 erreur 5xx, p95 6839 ms.
- **Run 2 (15 000 visiteurs / 500 copies)** : `2026-10-25T01-14-35-006Z-download-burst.json`. 15 029 requêtes, C1 en base : 500/500, refus épuisement : 6 437, 0 5xx. Limite locale : saturation loopback réseau (8 070 erreurs réseau client).
- **Run 3 (collab-sim 300 rédacteurs)** : `2026-10-25T01-16-19-012Z-collab-sim.json`. Invariant C2 strictement identique entre les 300 pairs, 89 100 propagations observées, CPU serveur mesuré via `/internal/health` : 7 795 ms (~64.6% d'un cœur), RSS 386 Mo, p95 2650 ms.
- **Run 4 (Test combiné)** : `2026-10-25T01-17-03-793Z-combined.json`. 600 visiteurs + 50 rédacteurs simultanés. C1 validé (500 copies et 500 URLs distinctes), C2 validé (convergence stricte), zéro 5xx. p95 téléchargement 4152 ms, propagation collab 220 ms.

#### C-09 : Rapport de test généré à partir des résultats bruts
```text
FAIL  tests/unit/gen-test-report.test.ts > C-09 : Génération automatique du rapport de tests (TEST_REPORT.md)
Error: Cannot find module '../../scripts/gen-test-report'
 ❯ tests/unit/gen-test-report.test.ts:4:1
```
- Script `scripts/gen-test-report.ts` et commande `npm run report`.
- Génération automatisée de `docs/TEST_REPORT.md` à partir des sorties JSON de Vitest (`test-results/*.json`) et des exécutions de charge (`loadtest/results/*.json`).
- Aucun chiffre saisi manuellement : 89 tests automatisés (37 unitaires, 15 intégration, 37 scénarios), 100% de succès.
- Tableau "Mesuré / Non mesuré" obligatoire, preuves C1/C2, rapport d'erreurs réelles et limites locales conservées fidèlement.





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

