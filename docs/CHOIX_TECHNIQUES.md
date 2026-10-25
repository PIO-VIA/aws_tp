# Architecture et Choix Technologiques Validés

Ce document consigne l'ensemble des choix d'architecture, technologies, protocoles et compromis techniques retenus pour l'implémentation de l'**Éditeur Collaboratif**. Il justifie chaque décision par rapport aux contraintes du système, aux performances sous pic et aux exigences de durabilité sur AWS.

---

## Sommaire

1. [Principes Directeurs et Contraintes Globales](#1-principes-directeurs-et-contraintes-globales)
2. [Frontend et Interface Utilisateur](#2-frontend-et-interface-utilisateur)
3. [Moteur d'Édition et Protocoles CRDT](#3-moteur-dédition-et-protocoles-crdt)
4. [Serveur de Collaboration et Reverse Proxy](#4-serveur-de-collaboration-et-reverse-proxy)
5. [Stockage, Persistance et Modèle de Données](#5-stockage-persistance-et-modèle-de-données)
6. [Traitements Asynchrones et Rendu PDF](#6-traitements-asynchrones-et-rendu-pdf)
7. [Gestion des Quotas et Protection Anti-Abus](#7-gestion-des-quotas-et-protection-anti-abus)
8. [Infrastructure as Code et Sécurité IAM](#8-infrastructure-as-code-et-sécurité-iam)
9. [Pipeline CI/CD et Exploitation](#9-pipeline-cicd-et-exploitation)
10. [Technologies et Approches Exclues](#10-technologies-et-approches-exclues)

---

## 1. Principes Directeurs et Contraintes Globales

L'architecture du système répond à quatre impératifs stricts :
- **Intégrité et Durabilité** : Aucune modification textuelle acquittée par le serveur ne doit être perdue en cas d'interruption ou de crash.
- **Étanchéité des Capacités** : Pour tout lien configuré avec $N$ exemplaires, il est mathématiquement impossible de distribuer $N+1$ copies, y compris lors de rafales de requêtes concurrentes.
- **Économie de Ressources (AWS Free Tier)** : Déploiement dans une seule région AWS (`eu-north-1`), sans service surdimensionné, sous un budget plafond de 10 USD.
- **Simplicité et Robustesse** : Préférer des composants déterministes, simples à opérer et testables de bout en bout, plutôt qu'une sur-ingénierie non maîtrisée.

---

## 2. Frontend et Interface Utilisateur

| Composant | Technologie Retenue | Justification Technique |
| :--- | :--- | :--- |
| **Framework Web** | Next.js 16.4.3 (App Router) | Rendu hybride (SSR / Client), performances de compilation avec Turbopack, simplification des Route Handlers pour l'API. |
| **Bibliothèque UI** | React 19.3.0 | Gestion fine des transitions asynchrones (`useTransition`, `useSyncExternalStore`), réactivité sans surcharge de re-rendus. |
| **Système de Styles** | Tailwind CSS v4 | Architecture CSS moderne basée sur les tokens de design (`--color-surface`, `--color-accent`), compilation ultra-rapide. |
| **Typographie & Thèmes** | Thèmes « Papier » (clair) et « Nuit » (sombre) | Polices Geist Sans et Geist Mono intégrées sans requête externe, bascule instantanée sans scintillement (Anti-Flash). |
| **Iconographie** | Lucide React | Icônes vectorielles légères et cohérentes. **Règle absolue : zéro emoji ni glyphe brut dans le code et les interfaces**. |
| **Aperçu Journal** | Feuille réactive Overleaf | Rendu en temps réel (split-view) simulant la feuille d'impression du journal étudiant avec mise en page typographique directe. |

---

## 3. Moteur d'Édition et Protocoles CRDT

### Choix de CodeMirror 6 et Y.Text (Décision D-01 & D-03)
Contrairement aux éditeurs de texte enrichi (comme Tiptap ou ProseMirror), le choix s'est porté sur **CodeMirror 6 associé au type CRDT `Y.Text`** de la bibliothèque Yjs :
- **Invariant du texte brut** : Le journal étudiant produit des articles au format texte brut diffusés en PDF. L'utilisation d'arbres de nœuds WYSIWYG complexes introduit des surcoûts d'encodage, des risques de désynchronisation de balises et complique inutilement le décompte exact des caractères UTF-16.
- **Performance et légèreté** : CodeMirror 6 est hautement modulaire, supporte nativement les curseurs distants nommés (Awareness) et maintient un temps de rendu négligeable même sur des documents de plusieurs dizaines de milliers de caractères.

---

## 4. Serveur de Collaboration et Reverse Proxy

### Architecture à Instance Unique Hocuspocus (Décision D-02)
- **Hocuspocus 4.7.1** : Serveur WebSocket dédié Node.js/TypeScript gérant la synchronisation Yjs et l'awareness des utilisateurs.
- **Instance Unique EC2 (`t3.small`)** : Les mesures de charge démontrent que 300 rédacteurs simultanés consomment moins de 30 % d'un seul cœur de processeur et moins de 150 Mo de mémoire vive.
- **Élimination de Redis** : L'utilisation d'une instance unique évite la complexité d'un cluster multi-serveurs, le routage distribué des WebSockets, les verrous répartis et le coût financier d'un cluster Redis/ElastiCache sur AWS.
- **Reverse Proxy Caddy** : Hébergé sur la même instance, Caddy assure la terminaison HTTP/WSS sur le port 80/443 et dispatche de façon transparente :
  - Le trafic web Next.js vers `http://127.0.0.1:3000`.
  - Le protocole WebSocket vers `ws://127.0.0.1:1234` sur le chemin `/collab`.

---

## 5. Stockage, Persistance et Modèle de Données

### Amazon DynamoDB (Mode `PAY_PER_REQUEST`)
DynamoDB constitue la colonne vertébrale transactionnelle de l'application grâce à ses temps de réponse millisecondes et son support des opérations atomiques :
1. **`doc_updates` (Write-Ahead Logging)** : Journalisation séquentielle synchrone (`seq`) de chaque fragment CRDT avant diffusion aux pairs.
2. **`doc_snapshots`** : Métadonnées des instantanés S3 périodiques.
3. **`links` et `reservations`** : Gestion des tirages limités avec réservation conditionnelle par `TransactWriteItems`.
4. **`quota`** : Suivi atomique du crédit d'écriture par rédacteur et par jour UTC.
5. **`abuse_events`** : Enregistrement des dépassements de rafale et des suspensions temporaires.
6. **`notifications`** : Suivi idempotent des e-mails émis pour le dernier exemplaire.

### Amazon S3 (Stockage Objets Immuable)
- **Bucket privé avec chiffrement SSE-S3 et TLS forcé**.
- **Instantanés de collaboration** : Sauvegardes binaires complètes compressées de l'état Yjs sous `snapshots/{docId}/{snapshotId}.bin`.
- **Fichiers PDF immuables** : Stockage des documents compilés sous `pdfs/{docId}/{versionId}.pdf`, où `versionId` est le hachage SHA-256 du contenu textuel. L'écriture utilise l'en-tête `If-None-Match: *` pour interdire tout écrasement accidentel.

---

## 6. Traitements Asynchrones et Rendu PDF

### Découplage SQS et Fonctions Lambda
Pour protéger le serveur web et l'API de téléchargement contre les pics CPU causés par la compilation graphique des PDF :
- **File de messages Amazon SQS (`pdf-jobs`)** : Chaque demande de nouveau PDF dépose une tâche asynchrone dans la file.
- **Isolation stricte (`pdf-worker`)** : La fonction Lambda `pdf-worker` assure de manière exclusive la compilation PDF (via PDFKit et les polices vectorielles DejaVu Sans). Aucun code de rendu PDF n'est exécuté dans l'API HTTP ni sur l'instance EC2.
- **Single-Flight Déterministe** : Avant publication dans SQS, DynamoDB vérifie si un job est déjà en cours pour ce `versionId`. Si oui, la tâche n'est pas dupliquée.
- **Gestion des pannes et DLQ (`pdf-jobs-dlq`)** : En cas d'échec répété (3 tentatives), la tâche bascule dans la file DLQ. La fonction `pdf-dlq-handler` est déclenchée pour rembourser automatiquement la réservation (`links.issued = issued - 1`), préservant ainsi l'invariant de capacité C1.

---

## 7. Gestion des Quotas et Protection Anti-Abus

### Algorithme de Comptage Exact (`IntervalSet`)
- Pour respecter le quota journalier de 10 000 caractères UTF-16 sans pénaliser les retransmissions réseau, le serveur implémente la déduplication par plages d'horloges logiques (`clientId, clock`).
- Toute modification retransmise ou déjà couverte dans l'intervalle est débitée à 0 caractère.
- Le débit en base s'effectue sous condition atomique DynamoDB : `used + :delta <= 10000`.

### Limiteur de Débit et Bannissement Temporaire (4403)
- Surveillance du flux d'écriture dans `beforeSync` : limitation à 50 mises à jour par seconde sur une fenêtre glissante de 5s.
- En cas de rafale anormale, le serveur refuse l'écriture (`write_refused`) sans rompre la connexion.
- Après 5 récidives (`ABUSE_THRESHOLD = 5`), l'utilisateur est temporairement suspendu pour 15 minutes (`blockedUntil = now + 900`) et sa connexion WebSocket est immédiatement fermée avec le code standard **4403**.

---

## 8. Infrastructure as Code et Sécurité IAM

### Terraform >= 1.10
- Description modulaire et reproductible de 100 % des composants AWS (`infra/terraform/`).
- **Backend S3 avec verrouillage natif** : Exploitation du verrouillage natif d'état S3 introduit dans Terraform 1.10, évitant le besoin d'une table DynamoDB dédiée pour le lock.
- **Délimitation des autorisations (`permissions_boundary`)** : Variable obligatoire `permissions_boundary_arn` injectée sur chacun des 8 rôles IAM créés, garantissant le respect strict des politiques de sécurité cloud.
- **Durcissement IMDSv2** : Configuration de l'instance EC2 avec `http_tokens = "required"` et `http_put_response_hop_limit = 2` pour neutraliser les attaques SSRF.

---

## 9. Pipeline CI/CD et Exploitation

### GitHub Actions avec Authentification OIDC AWS
- **Zéro clé AWS permanente** stockée dans les secrets GitHub.
- L'authentification utilise un rôle IAM assumé dynamiquement via jeton JWT OpenID Connect (OIDC).
- Les workflows exécutent séquentiellement :
  1. Audit de style et qualité : `npm run lint` et `npm run check:ui`.
  2. Contrôle de typage : `npm run typecheck`.
  3. Tests unitaires et d'intégration : `npm test`.
  4. Validation Terraform : `terraform fmt` et `terraform validate`.
  5. Audit de sécurité des configurations Terraform via Checkov.
  6. Déploiement conditionné sur succès total de la suite de tests.

### Administration Sécurisée sans SSH via AWS SSM
- Aucun port SSH (port 22) n'est ouvert sur Internet.
- L'exploitation de l'instance EC2 (mises à jour d'images Docker, redémarrages, consultations de santé) s'effectue exclusivement par le canal sécurisé **AWS Systems Manager (SSM)**.

---

## 10. Technologies et Approches Exclues

Plusieurs options ont été délibérément écartées lors de la conception :

| Option Écartée | Décision Associée | Motif du Rejet |
| :--- | :--- | :--- |
| **Kubernetes (EKS)** | Décision D-40 | Complexité opérationnelle disproportionnée, coût de base élevé (> 70 $/mois) incompatible avec le budget de 10 $. |
| **Redis / ElastiCache** | Décision D-02 | Inutile avec une instance unique Hocuspocus bien dimensionnée ; ajoute un point de panne et des coûts fixes superflus. |
| **Éditeurs WYSIWYG (Tiptap)** | Décision D-01 | Arborescence de nœuds JSON rendant le comptage exact des caractères UTF-16 et la compilation PDF complexes et fragiles. |
| **Rendu PDF synchrone dans l'API** | Décision C-04 | Risque de saturation CPU lors d'un pic de téléchargements entraînant le blocage des requêtes HTTP. |
| **Génération continue d'URLs pré-signées** | Décisions D-04/D-05 | Permettrait à un visiteur de contourner le quota en demandant indéfiniment de nouvelles URLs après expiration. |
