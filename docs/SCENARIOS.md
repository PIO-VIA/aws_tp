# Formalisation et Validation des Scénarios Critiques

Ce document détaille les scénarios d'exécution critiques de l'application **Éditeur Collaboratif**. Il formalise pour chaque flux les préconditions, les mécanismes de concurrence, les garanties d'invariants, les cas de panne traités et les preuves de validation issues des suites de tests automatisés.

---

## Sommaire

1. [Synthèse des Invariants Formels](#1-synthèse-des-invariants-formels)
2. [SC01 — Édition Concurrente et Convergence CRDT](#2-sc01--édition-concurrente-et-convergence-crdt)
3. [SC01b — Durabilité et Compaction Concurrente](#3-sc01b--durabilité-et-compaction-concurrente)
4. [SC02 — Réservation Atomique sous Pic d'Affluence](#4-sc02--réservation-atomique-sous-pic-daffluence)
5. [SC02b — Règle de Non-Réémission d'URL Pré-signée](#5-sc02b--règle-de-non-réémission-durl-pré-signée)
6. [SC03 — Rendu PDF Asynchrone Déterministe et Single-Flight](#6-sc03--rendu-pdf-asynchrone-déterministe-et-single-flight)
7. [SC04 — Quotas Quotidiens et Déduplication par IntervalSet](#7-sc04--quotas-quotidiens-et-déduplication-par-intervalset)
8. [SC04b — Détection de Rafales et Suspension Temporaire d'Abus](#8-sc04b--détection-de-rafales-et-suspension-temporaire-dabus)
9. [SC05 — Notification Idempotente du Dernier Exemplaire](#9-sc05--notification-idempotente-du-dernier-exemplaire)
10. [SC06 — Historique Immuable et Restauration sans Perte](#10-sc06--historique-immuable-et-restauration-sans-perte)

---

## 1. Synthèse des Invariants Formels

Le système garantit par conception l'étanchéité des règles suivantes :

| Identifiant | Règle Formelle | Mécanisme d'Enforcement |
| :--- | :--- | :--- |
| **C1 / I01** | $0 \le \text{exemplaires distribués} \le \text{limite autorisée}$ | Transaction atomique DynamoDB `TransactWriteItems` + cache mémoire court anti-pic. |
| **C2 / I03-I04** | Convergence stricte et zéro perte d'édition acquittée | CRDT Yjs (`Y.Text`), journalisation préalable Write-Ahead Logging (WAL) dans DynamoDB `doc_updates` avant diffusion. |
| **C3 / I05** | PDF immuable, déterministe et complet par version | Hachage SHA-256 du texte brut UTF-8, isolation stricte du rendu dans `pdf-worker`, écriture S3 conditionnelle `If-None-Match: *`. |
| **C4 / I02** | Quota de 10 000 caractères UTF-16 par rédacteur et par jour | Décompte exact via `IntervalSet` par `(clientId, clock)`, débit conditionnel atomique DynamoDB, remise à zéro à 00:00 UTC. |
| **C5** | Aucun visiteur rejeté sans état explicite | Zéro retour 429 ou 503 brut ; réponses structurées 200 (`granted`, `expired`) ou 202 (`preparing`, `retry`) avec en-tête `Retry-After`. |
| **C6** | Information immédiate lors de l'épuisement d'un tirage | Cache mémoire 1s sur le serveur de téléchargement basculant immédiatement à l'état `exhausted`. |

---

## 2. SC01 — Édition Concurrente et Convergence CRDT

### Objectif
Garantir la convergence déterministe et sans conflit de l'ensemble des rédacteurs connectés, sans perte d'opération acquittée, même lors de frappes simultanées au même emplacement dans le document.

### Contexte et Préconditions
- Le document `D1` contient initialement la chaîne : `Le cloud stocke les donnees`.
- Deux rédacteurs (Alice et Bob) sont connectés via WebSocket à l'instance Hocuspocus.
- Alice insère le mot `distribue ` après `cloud `, tandis que Bob insère `durablement ` au même index sans avoir reçu l'opération d'Alice.

### Déroulement Implémenté
1. **Interception synchrone (`beforeSync`)** : Chaque mise à jour générée par le client Yjs est interceptée par le crochet serveur Hocuspocus avant toute diffusion aux pairs.
2. **Attribution séquentielle** : Le serveur alloue un numéro de séquence monotone croissant `seq` pour le document.
3. **Journalisation préalable (WAL)** : L'opération binaire est persistée de manière synchrone dans la table DynamoDB `doc_updates` (`PK = D1, SK = seq`).
4. **Diffusion aux pairs** : L'update n'est répercuté aux autres clients connectés qu'après confirmation de l'écriture en base.
5. **Résolution mathématique CRDT** : Le moteur Yjs fusionne les deux insertions concurrentes selon l'ordre strict des `ClientID` et horloges logiques Lamport. Alice et Bob visualisent exactement le même texte final : `Le cloud distribue durablement les donnees`.

### Validation Automatisée
- Test unitaire et de scénario : `tests/scenarios/sc01-collaboration.test.ts`.
- Test de charge : `loadtest/collab-sim.ts` simulant 300 rédacteurs simultanés répartis sur plusieurs documents. Résultat : **89 100 propagations observées avec 100 % de convergence stricte**.

---

## 3. SC01b — Durabilité et Compaction Concurrente

### Objectif
Empêcher toute perte d'édition lorsqu'une compaction (snapshot périodique vers S3) se déroule pendant que des flux continus d'écritures arrivent au serveur.

### Mécanisme Implémenté (Correctif C-01)
- **Suivi des écritures en vol** : Le serveur maintient un ensemble en mémoire `inFlight: Set<number>` répertoriant les séquences en cours d'écriture DynamoDB.
- **Calcul de séquence sûre (`safeUpToSeq`)** : Le point de capture du snapshot ne prend jamais `latestSeq` à l'aveugle, mais la plus haute séquence continue telle que toutes les séquences inférieures sont acquittées (`seq < min(inFlight)`).
- **Marge de sécurité (`REPLAY_MARGIN = 200`)** : Lors de la purge du journal `doc_updates` après téléversement du snapshot compressé vers S3, les 200 derniers updates sont systématiquement conservés. Comme rejouer un update Yjs est idempotent mais en manquer un est fatal, cette marge garantit une étanchéité absolue en cas de panne transitoire.

### Validation Automatisée
- `tests/scenarios/sc01b-snapshot-concurrent-writes.test.ts` : Simulation de crash serveur en plein cycle de snapshot sous rafale concurrente ; zéro mise à jour perdue après redémarrage.

---

## 4. SC02 — Réservation Atomique sous Pic d'Affluence

### Objectif
Assurer qu'un lien configuré pour $N$ exemplaires ne délivre jamais plus de $N$ réservations, même sous une charge extrême de requêtes concurrentes.

### Contexte et Préconditions
- Le lien de téléchargement `L1` dispose d'un quota de 50 exemplaires, dont 49 ont déjà été attribués.
- 100 visiteurs anonymes requêtent le téléchargement à la même milliseconde.

### Déroulement Implémenté
1. **Requête client** : Chaque visiteur émet un `POST /api/dl/L1/request` avec un identifiant de session unique `requestId` conservé en `sessionStorage`.
2. **Chemin rapide mémoire (Fast-Path)** : Si le cache local du serveur indique que le lien est épuisé (`exhausted`), la requête est rejetée en 0 ms sans solliciter DynamoDB.
3. **Transaction atomique DynamoDB** : Le serveur exécute un `TransactWriteItems` combinant :
   - L'incrémentation de `issued` sur la table `links` sous condition `issued < maxDownloads AND #st = 'active'`.
   - L'insertion de l'item de réservation dans la table `reservations` (`PK = L1, SK = requestId`).
4. **Attribution exclusive** :
   - Une seule requête réussit la transaction atomique (le 50e exemplaire). La réservation passe à l'état `granted` ou `preparing`.
   - Les 99 autres requêtes essuient un échec de condition (`TransactionCanceledException: ConditionalCheckFailed`). Le serveur met à jour son cache mémoire `exhausted` et renvoie une réponse explicite `410 Gone / 200 { state: 'exhausted' }`.

### Validation Automatisée
- `tests/scenarios/sc02-download-limits.test.ts` : Validation formelle sur 100 requêtes concurrentes pour 1 copie restante (exactement 1 succès, 99 refus).
- `loadtest/download-burst.ts` : Injection de 15 000 requêtes en boucle ouverte. Résultat : **exactement 500 copies accordées en base, 0 dépassement**.

---

## 5. SC02b — Règle de Non-Réémission d'URL Pré-signée

### Objectif
Interdire le contournement des quotas par réémission multiple d'URLs de téléchargement pour une même réservation.

### Règle Métier et Implémentation (Décisions D-04 / D-05)
- Une réservation réussie n'émet **qu'une seule et unique URL pré-signée S3** à durée de vie courte (TTL de 60 secondes).
- Si le visiteur laisse expirer l'URL ou tente de réinterroger `/api/dl/L1/reservations/{requestId}` après expiration, le serveur renvoie `200 { state: 'expired' }` et refuse de régénérer une nouvelle URL.
- Aucun remboursement de copie n'est accordé si l'URL a été délivrée, car un transfert S3 initié ne peut pas être invalidé côté client.

### Validation Automatisée
- `tests/scenarios/sc02b-no-url-reissue.test.ts` : Vérification qu'une réservation expirée ne permet aucune réémission d'URL S3 ni incrément caché.

---

## 6. SC03 — Rendu PDF Asynchrone Déterministe et Single-Flight

### Objectif
Délivrer un document PDF intègre et complet, correspondant exactement à la version du document au moment de la demande, sans bloquer les requêtes HTTP ni saturer le serveur lors des pics.

### Déroulement Implémenté
1. **Verrouillage de la version (`versionId`)** : Le document courant est converti en texte brut UTF-8 immuable. Le `versionId` est calculé de manière pure et déterministe via le hachage SHA-256 de ce contenu.
2. **Single-Flight via DynamoDB (`pdf_jobs`)** : Lors d'une demande de génération, le serveur vérifie si un job existe déjà pour ce `(docId, versionId)`. Si c'est le cas, la tâche n'est pas réémise ; le demandeur se met en attente de la complétion du job existant.
3. **Publication asynchrone SQS** : Si le job est nouveau, un message est publié dans la file `pdf-jobs`. Le client reçoit `202 { state: 'preparing', retryAfterMs: 1500 }`.
4. **Exécution isolée dans `pdf-worker`** : La fonction Lambda `pdf-worker` consomme le message SQS, compile le document PDF avec police vectorielle intégrée, et téléverse le fichier dans S3 sous la clé immuable `pdfs/{docId}/{versionId}.pdf` avec l'en-tête conditionnel `If-None-Match: *`.
5. **Remboursement automatique via DLQ** : Si le worker rencontre un échec terminal (après 3 tentatives SQS), le message bascule dans `pdf-jobs-dlq`. La Lambda `pdf-dlq-handler` est déclenchée, passe la réservation en `failed` et décrémente `issued` dans DynamoDB pour restituer le quota au lien.

### Validation Automatisée
- `tests/scenarios/sc03-versioned-pdf.test.ts` : Vérification du déterminisme SHA-256 et du comportement en cas de modification concurrente pendant la génération.
- `tests/integration/c04-pdf-isolation.test.ts` : Validation de l'absence totale de code de rendu PDF dans les routes HTTP et confirmation du transit exclusif par SQS.

---

## 7. SC04 — Quotas Quotidiens et Déduplication par IntervalSet

### Objectif
Appliquer un plafond quotidien strict de 10 000 caractères par rédacteur sans pénaliser les retransmissions réseau ni les réparations de connexion.

### Algorithme de Calcul Exact (Classe `IntervalSet`)
- Chaque caractère inséré dans Yjs porte l'identifiant du client (`clientId`) et un compteur monotone (`clock`).
- Le serveur maintient pour chaque couple `(writerId, clientId)` une structure `IntervalSet` regroupant les plages d'horloges déjà facturées : $[c_1, c_2], [c_3, c_4]$.
- Lorsqu'un update arrive, l'algorithme calcule l'intersection de la plage reçue avec les intervalles existants :
  $$\text{caractères facturables} = \text{longueur totale} - \text{longueur déjà comprise dans } IntervalSet$$
- Une retransmission réseau (même opération reçue plusieurs fois) produit un débit de **0 caractère**.
- Les suppressions de texte ne restituent pas de crédit (règle anti-abus).

### Débit Atomique DynamoDB
- Le débit est opéré via une écriture conditionnelle sur la table `quota` :
  ```text
  attribute_not_exists(used) OR used + :delta <= 10000
  ```
- La date de référence est fixée sur la date UTC (`YYYY-MM-DD`). La remise à zéro s'opère automatiquement à 00:00:00 UTC par changement de clé partition.

### Validation Automatisée
- `tests/unit/interval-set.test.ts` : 7 tests unitaires validant les fusions, chevauchements et déduplications.
- `tests/scenarios/sc04-credit-abuse.test.ts` : Tentative d'épuisement du quota depuis deux sessions concurrentes du même utilisateur.

---

## 8. SC04b — Détection de Rafales et Suspension Temporaire d'Abus

### Objectif
Détecter et neutraliser les comportements malveillants ou scripts tentant de saturer le serveur WebSocket par des rafales massives d'écritures.

### Mécanisme de Protection en Temps Réel
1. **Fenêtre glissante par connexion** : Dans le crochet `beforeSync`, le serveur compte le nombre d'updates reçus sur une fenêtre glissante de 5 secondes.
2. **Seuil de rafale (Rate Limit)** : Si le débit dépasse 50 updates/s, la mise à jour est immédiatement rejetée avec le message `write_refused` adressé au client sans fermeture sauvage de connexion.
3. **Suspension temporaire (15 minutes)** : Si un utilisateur accumule 5 infractions consécutives (`ABUSE_THRESHOLD = 5`), le serveur écrit dans DynamoDB l'enregistrement de blocage (`blockedUntil = now + 900`) et ferme la connexion WebSocket avec le code standard **4403**.
4. **Cache de blocage en session** : Le serveur collab vérifie l'état de suspension en cours de session toutes les 5 secondes, empêchant un utilisateur banni de continuer à taper dans une session déjà ouverte.

### Validation Automatisée
- `tests/scenarios/sc04b-burst-and-session-block.test.ts` : Simulation de rafale d'écritures, vérification de l'émission des notifications de refus et confirmation de la déconnexion 4403 au 5e abus.

---

## 9. SC05 — Notification Idempotente du Dernier Exemplaire

### Objectif
Avertir le créateur d'un lien par e-mail dès que le dernier exemplaire autorisé a été attribué, avec la garantie absolue d'exactement un seul envoi (`exactly-once` logique), même sous charge concurrente.

### Déroulement Implémenté
1. **Émission de l'événement** : Lorsqu'une transaction atomique porte `issued == maxDownloads`, un item de notification est créé dans la table DynamoDB `notifications`.
2. **Verrou conditionnel d'envoi** :
   ```text
   SET #st = :sending, claimedAt = :now
   CONDITION #st = :pending AND (attribute_not_exists(claimedAt) OR claimedAt < :staleCutoff)
   ```
   Ce verrou garantit qu'en cas d'exécutions simultanées du Stream DynamoDB et du réconciliateur périodique, un seul processus acquiert le droit d'émettre l'e-mail.
3. **Envoi effectif** : Acheminement du message via Amazon SES en production et Mailpit en environnement de développement local.
4. **Acquittement** : Passage de l'item à l'état `#st = :sent`.

### Validation Automatisée
- `tests/scenarios/sc05-notifications.test.ts` : Validation de l'envoi de notification et confirmation de non-duplication.
- `tests/scenarios/sc06-notifications-and-scans.test.ts` : Validation de la reprise après panne avec `scanAll<T>` et pagination `LastEvaluatedKey`.

---

## 10. SC06 — Historique Immuable et Restauration sans Perte

### Objectif
Permettre la consultation des versions antérieures d'un document et la restauration d'un état passé sans détruire l'arborescence des modifications ultérieures ni contourner le quota d'écriture.

### Règles Métier et Implémentation
- **Immuabilité de l'arbre historique** : La restauration d'une version passée ne tronque jamais l'historique postérieur. Elle crée une nouvelle évolution du document dont le contenu est identique à la version ciblée.
- **Facturation nulle de la restauration** : L'opération de restauration n'impute aucun caractère sur le quota journalier (`billedChars = 0`), afin d'éviter qu'un rédacteur ne soit bloqué en voulant corriger une erreur.
- **Plafond anti-abus** : Pour empêcher les boucles infinies de restauration automatisée, le système limite les restaurations à **10 par heure** et par document.

### Validation Automatisée
- `tests/scenarios/sc06-history.test.ts` : Création de versions successives, restauration d'une version antérieure, vérification de la conservation des états intermédiaires et contrôle du compteur de quota (0 caractère débité).
