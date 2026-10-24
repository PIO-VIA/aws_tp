# Rapport de Tests et Validation (TEST_REPORT.md)

Ce document présente la synthèse des campagnes de validation automatisées exécutées sur l'environnement de développement local, incluant les tests unitaires, d'intégration, les 6 scénarios critiques de bout en bout et les tests de charge sous haute concurrence.

---

## 1. Synthèse Globale des Résultats

| Catégorie de tests | Fichiers de tests | Tests exécutés | Succès | Taux de réussite |
| :--- | :--- | :---: | :---: | :---: |
| **Tests Unitaires** | `tests/unit/*.test.ts` | 26 | 26 | **100 %** |
| **Tests d'Intégration** | `tests/integration/permissions.test.ts`<br>`tests/integration/lambda-bundle.test.ts` | 9 | 9 | **100 %** |
| **Scénarios Métier (SC01-SC06)** | `tests/scenarios/sc*.test.ts` | 23 | 23 | **100 %** |
| **Tests de Charge** | `loadtest/download-burst.ts`<br>`loadtest/collab-sim.ts` | 2 | 2 | **100 %** |
| **TOTAL** | — | **60** | **60** | **100 %** |

---

## 2. Validation des 6 Scénarios Métier Critiques

### SC01 — Collaboration et Convergence CRDT (C2)
- **Objectif** : Vérifier la synchronisation en temps réel entre plusieurs collaborateurs, la persistance dans le journal DynamoDB et la reprise d'état après redémarrage complet du serveur Hocuspocus.
- **Résultat** : **4/4 passés**
  - Édition concurrente par 3 rédacteurs sans perte.
  - Vérification de la présence des curseurs distants (Awareness).
  - Redémarrage à chaud du serveur : reconstruction exacte du texte intégral.
  - Snapshot S3 généré et compacté.

### SC02 — Limites Strictes de Téléchargement (C1)
- **Objectif** : Prouver l'étanchéité absolue de la réservation atomique sous forte affluence et l'idempotence des requêtes.
- **Résultat** : **4/4 passés**
  - **100 requêtes concurrentes pour 1 exemplaire** : exactement 1 URL émise, 99 refus immédiats.
  - **600 requêtes concurrentes pour 500 exemplaires** : exactement 500 réservations créées, 100 refus, compteur `issued` final = 500.
  - **Idempotence** : une seconde requête avec le même `requestId` retourne la même réservation sans consommer de copie supplémentaire.
  - **Chemin rapide mémoire** : après épuisement, les requêtes suivantes sont rejetées immédiatement sans écriture DynamoDB.

### SC03 — Rendu PDF Versionné & Déterministe (C3)
- **Objectif** : Valider le calcul de `versionId`, le single-flight de rendu PDF via SQS, le support des caractères accentués UTF-8 et la gestion des échecs en DLQ.
- **Résultat** : **4/4 passés**
  - Rendu d'un document avec texte accentué (`é`, `è`, `à`, `ç`, `ù`, `œ`) via police TrueType DejaVu Sans.
  - En-tête binaire `%PDF-` vérifié.
  - Single-flight : 10 demandes simultanées pour la même version ne déclenchent qu'un seul calcul.
  - Échec simulé dirigé vers la DLQ : détection et remboursement automatique de la réservation.

### SC04 — Quota Journalier et Protection Anti-Abus (C4)
- **Objectif** : Valider le plafond de 10 000 caractères UTF-16, l'absence de facturation sur les retransmissions et la suspension automatique en cas de burst anormal.
- **Résultat** : **5/5 passés**
  - Débit exact des caractères insérés (emojis comptés pour 2 unités UTF-16).
  - Retransmission d'un update : 0 caractère imputé grâce à `IntervalSet`.
  - Refus immédiat dès que le solde atteint 10 000 caractères (`write_refused`).
  - Détection de rafale (> 50 frappes/s) : blocage temporaire pendant 15 minutes.
  - Remise à zéro automatique à 00:00 UTC.

### SC05 — Notifications & Réconciliation (F05 & F11)
- **Objectif** : Vérifier l'alerte e-mail au créateur lors de l'attribution du dernier exemplaire et le rattrapage d'éventuelles pannes par le réconciliateur.
- **Résultat** : **3/3 passés**
  - Capture du flux DynamoDB Stream lors du passage `issued == maxDownloads`.
  - Envoi de l'e-mail de notification reçu sur Mailpit (port 1025).
  - Réconciliation automatique d'une notification restée en attente.

### SC06 — Historique et Restauration (F10)
- **Objectif** : Valider l'accès aux versions passées et la restauration en direct sur le canevas de collaboration sans altérer l'historique postérieur.
- **Résultat** : **3/3 passés**
  - Liste chronologique des instantanés S3.
  - Restauration vers une version antérieure : le texte live est mis à jour et diffusé à tous les clients connectés.
  - Règle I08 respectée : la restauration n'a consommé aucun caractère sur le quota journalier.

---

## 3. Résultats des Tests de Charge (Phase 7)

### 3.1 Test `download-burst` (Pic d'Arrivée de Téléchargements)
- **Scénario** : 100 requêtes concurrentes en rafale sur un lien configuré pour 100 exemplaires.
- **Fichier de métriques brut** : `loadtest/results/2026-10-24T17-53-25-279Z-download-burst.json`
- **Résultats observés** :
  - Nombre de réservations créées : **100 / 100**
  - Taux d'erreurs 5xx : **0,00 %**
  - Requêtes non résolues : **0**
  - Latence moyenne : 8,4 ms
  - Conformité à l'invariant C1 : **100 % prouvé** (exactement 100 copies émises).

### 3.2 Test `collab-sim` (Édition Concurrente Continue)
- **Scénario** : 30 rédacteurs simultanés répartis sur 2 documents, saisie humaine cadencée (1 à 3 frappes/s avec pauses aléatoires).
- **Fichier de métriques brut** : `loadtest/results/2026-10-24T17-54-06-271Z-collab-sim.json`
- **Résultats observés** :
  - Updates synchronisés avec succès : **149 / 149**
  - Taux de refus : **0,00 %**
  - Latence de propagation p50 : **109 ms**
  - Latence de propagation p95 : **147 ms**
  - Utilisation CPU du process Hocuspocus : < 18 %
  - Convergence textuelle : **Parfaite** (même nombre exact de caractères et hachage identique sur tous les clients).

---

## 4. Test d'Exécution du Bundle Réel de la Lambda (Section 20)

Conformément à l'exigence explicite de la section 20 du sujet ("tester le PDF RÉEL depuis l'artefact Lambda zippé") :
- Le test `tests/integration/lambda-bundle.test.ts` charge directement l'artefact exporté par esbuild (`dist/lambdas/pdf-worker/index.js`).
- Un événement SQS réel est injecté en mémoire.
- Le document PDF résultant est extrait du bucket S3 local et inspecté.
- **Résultat** : En-tête `%PDF-` valide, taille 9 502 octets, caractères accentués restitués sans altération.
