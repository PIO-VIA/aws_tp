# Éditeur Collaboratif de Documents & Diffusion Versionnée sur AWS

[![Next.js](https://img.shields.io/badge/Next.js-16.4.3-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-blue?logo=react)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-38bdf8?logo=tailwindcss)](https://tailwindcss.com/)
[![AWS](https://img.shields.io/badge/AWS-Free%20Tier-ff9900?logo=amazon-aws)](https://aws.amazon.com/)
[![Terraform](https://img.shields.io/badge/Terraform-1.10+-7b42bc?logo=terraform)](https://www.terraform.io/)
[![Tests](https://img.shields.io/badge/Tests-64%2F64%20Pass-emerald)](./docs/TEST_REPORT.md)

Plateforme web de rédaction collaborative en temps réel et de diffusion de documents PDF à tirage limité pour association étudiante. L'infrastructure est conçue pour absorber d'intenses pics d'affluence sous des contraintes strictes de capacité et de quotas, avec une maîtrise rigoureuse des coûts sur AWS.

---

## Sommaire

1. [Architecture Globale](#1-architecture-globale)
2. [Garanties Métier et Invariants Formels](#2-garanties-métier-et-invariants-formels)
3. [Index de la Documentation Technique](#3-index-de-la-documentation-technique)
4. [Démarrage Rapide en Local](#4-démarrage-rapide-en-local)
5. [Validation et Tests Automatisés](#5-validation-et-tests-automatisés)
6. [Déploiement AWS et Exploitation](#6-déploiement-aws-et-exploitation)
7. [Structure du Dépôt](#7-structure-du-dépôt)

---

## 1. Architecture Globale

Le schéma ci-dessous illustre l'architecture complète du système, depuis le pipeline CI/CD jusqu'à la distribution aux utilisateurs via Amazon CloudFront, EC2, DynamoDB, S3 et les fonctions Serverless.

<p align="center">
  <img src="./docs/images/global%20architecture.png" alt="Architecture Globale AWS — Éditeur Collaboratif" width="100%" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" />
</p>

### Synthèse des Blocs Fonctionnels

- **Distribution & Accès Edge** : Amazon CloudFront achemine le trafic HTTPS et WebSockets vers l'instance Amazon EC2. Un reverse-proxy Caddy sécurise les connexions et dispatche les flux vers l'application web Next.js (port 3000) et le serveur collaboratif Hocuspocus (port 1234).
- **Édition Collaborative en Temps Réel** : Moteur CRDT décentralisé basé sur Yjs (`Y.Text`) et CodeMirror 6, géré par un serveur Hocuspocus sur instance unique EC2 (`t3.small`). Synchronisation synchrone par journalisation Write-Ahead Logging (WAL) dans DynamoDB garantissant zéro perte de caractère.
- **Traitement Asynchrone & Serverless** : Gestion des tirages PDF par file Amazon SQS et fonctions AWS Lambda (génération PDF déterministe par hachage SHA-256, API de réservation et notifications SES).
- **Stockage & Persistance** : Amazon DynamoDB (transactions atomiques ACID pour les quotas et réservations) et Amazon S3 (instantanés de texte et PDFs horodatés immuables).
- **CI/CD & Exploitation** : Déploiement d'infrastructure via Terraform, conteneurs légers hébergés sur Amazon ECR, exploitation sécurisée sans port SSH ouvert via AWS Systems Manager (SSM), et métriques centralisées sur Amazon CloudWatch.

---

## 2. Garanties Métier et Invariants Formels

Le système garantit par construction quatre invariants fondamentaux et des mécanismes de protection robustes :

| Invariant / Mécanisme | Description | Garantie Formelle & Validation |
| :--- | :--- | :--- |
| **C1 — Capacité de Tirage** | Limitation stricte du nombre d'exemplaires émis ($0 \le \text{URL émis} \le N$). | Transaction atomique DynamoDB `TransactWriteItems`, fast-path mémoire vive anti-pic. Éprouvé sous 15 000 requêtes concurrentes (`SC02`, `SC02b`). |
| **C2 — Convergence CRDT** | Édition simultanée sans conflit entre plusieurs centaines de rédacteurs. | Document `Y.Text` brut, Write-Ahead Logging DynamoDB avant diffusion aux pairs. Validé sous 89 100 propagations concurrentes (`SC01`, `SC01b`). |
| **C3 — Rendu PDF Single-Flight** | Identifiant de version déterministe par hachage SHA-256 UTF-8. | Traitement SQS asynchrone avec verrou single-flight anti-recalcul et remboursement automatique en cas d'échec (`c04-pdf-isolation`, `SC03`). |
| **C4 — Quotas & Anti-Abus** | Quota journalier de 10 000 caractères UTF-16 par rédacteur (remis à zéro à 00:00 UTC). | Déduplication par `IntervalSet` (0 caractère refacturé). Limiteur de rafale à 50 updates/s et suspension temporaire d'abus (`SC04`, `SC04b`). |
| **F05 — Historique & Restauration** | Visualisation et restauration de versions antérieures sans altérer l'arbre historique. | Instantanés S3 immuables, restauration sans impact sur le quota journalier (`billedChars = 0`, limite 10/heure, `SC06-history`). |
| **F10 — Administration** | Supervision des sessions ouvertes, des liens de tirage et levée manuelle de suspension. | Tableau de bord `/admin` temps réel (rafraîchissement 5s) protégé par token secret. |
| **F11 — Alerte Dernier Exemplaire** | Notification par e-mail au créateur dès l'émission du dernier exemplaire disponible. | Détection idempotente sur événement DynamoDB, acheminée via Amazon SES en production et Mailpit en local (`SC05`). |

---

## 3. Index de la Documentation Technique

Afin de préserver la clarté et la concision de ce README, la documentation technique détaillée est organisée par domaine d'expertise :

| Document | Objet & Périmètre |
| :--- | :--- |
| [**Architecture & Choix Technologiques (`docs/CHOIX_TECHNIQUES.md`)**](./docs/CHOIX_TECHNIQUES.md) | Synthèse exhaustive des choix d'ingénierie (Next.js 16, React 19, Tailwind v4, CodeMirror 6, Hocuspocus, DynamoDB, S3, SQS, SES) et justification des options exclues. |
| [**Scénarios Critiques & Preuves (`docs/SCENARIOS.md`)**](./docs/SCENARIOS.md) | Formalisation complète des scénarios SC01 à SC06 : déroulement étape par étape, concurrence, cas de panne et résultats des tests. |
| [**Guide de Déploiement AWS (`docs/DEPLOIEMENT_AWS.md`)**](./docs/DEPLOIEMENT_AWS.md) | Guide pas à pas de mise en production : politique IAM boundary, création du backend S3, prise en main Terraform, ECR, SSM et destruction. |
| [**Conception & Design System (`docs/DESIGN.md`)**](./docs/DESIGN.md) | Modèle de données DynamoDB, arbre CRDT, tokens de style Papier/Nuit, composant `Logo` vectoriel et preuves formelles des invariants. |
| [**Registre des Décisions d'Architecture (`docs/DECISIONS.md`)**](./docs/DECISIONS.md) | Historique exhaustif et justification des 45 décisions d'architecture (ADR D-01 à D-45). |
| [**Spécification d'API (`docs/API.md`)**](./docs/API.md) | Spécification complète des contrats HTTP, en-têtes, codes d'erreur et modèle OpenAPI ([`docs/openapi.yaml`](./docs/openapi.yaml)). |
| [**Rapport de Validation & Charge (`docs/TEST_REPORT.md`)**](./docs/TEST_REPORT.md) | Rapport dynamique des tests unitaires, d'intégration, de charge en boucle ouverte (Artillery/custom) et smoke tests. |
| [**Modélisation Budgétaire AWS (`docs/COST.md`)**](./docs/COST.md) | Analyse détaillée des coûts, dimensionnement sous l'AWS Free Tier et plafonnement budgétaire strict (< 10 $). |

---

## 4. Démarrage Rapide en Local

### Prérequis
- **Node.js** >= 22.0.0
- **Docker** et **Docker Compose**
- **Terraform** >= 1.10.0 *(uniquement pour la validation d'infrastructure)*

### Lancement de l'Environnement Complet
Une seule commande orchestre l'ensemble de la pile locale (conteneurs, initialisation des schémas et serveurs dev) :

```bash
# 1. Installation des dépendances
npm ci

# 2. Démarrage complet de l'infrastructure et de l'application
npm run dev:all
```

Cette commande démarre :
1. **Les conteneurs de services locaux** : DynamoDB Local (`:8000`), MinIO S3 (`:9000/:9001`), ElasticMQ SQS (`:9324/:9325`), et Mailpit (`:1025/:8025`).
2. **L'initialisation automatique** : Création des 12 tables DynamoDB, des index secondaires, du bucket S3 local `editeur-local-data`, et des files SQS.
3. **Les processus applicatifs** : Application Next.js (`:3000`), serveur WebSocket Hocuspocus (`:1234`), worker SQS et réconciliateur local.

### Points d'Accès Locaux

| Service | URL locale | Identifiants / Remarques |
| :--- | :--- | :--- |
| **Application Web & Éditeur** | [http://localhost:3000](http://localhost:3000) | Choix de session prédéfinie (Alice, Bob, Charlie) ou personnalisée |
| **Tableau de Bord Admin** | [http://localhost:3000/admin](http://localhost:3000/admin) | Token par défaut : `dev-admin-token-change-in-prod` |
| **Vitrine UI & Thèmes** | [http://localhost:3000/ui-kit](http://localhost:3000/ui-kit) | Showcase du logo, des tokens Papier/Nuit et des variantes de marque |
| **Console MinIO (S3)** | [http://localhost:9001](http://localhost:9001) | Utilisateur : `minioadmin` / Mot de passe : `minioadminpassword` |
| **Interface Mailpit (E-mails)** | [http://localhost:8025](http://localhost:8025) | Consultation des notifications et alertes de tirage |
| **File SQS ElasticMQ** | [http://localhost:9325](http://localhost:9325) | File de tâches de rendu PDF asynchrone |

---

## 5. Validation et Tests Automatisés

Le projet intègre une suite d'assurance qualité validant les contrats, la sécurité et la robustesse :

```bash
# Vérification du style de code et des règles React 19 / ESLint
npm run lint

# Contrôle strict du typage TypeScript
npm run typecheck

# Tests unitaires (contrats Terraform, contrats API, IntervalSet, calcul UTF-16, marque)
npm test

# Tests de conformité UI (vérification de l'absence totale d'emojis / icônes Lucide)
npm run check:ui

# Scénarios métier de bout en bout (SC01 à SC06)
npm run test:scenarios

# Génération dynamique du rapport de validation exhaustif
npm run report

# Tests de charge en boucle ouverte (C-08)
npm run loadtest:download
npm run loadtest:collab
npm run loadtest:combined
```

---

## 6. Déploiement AWS et Exploitation

Consultez le guide complet de mise en production dans [**`docs/DEPLOIEMENT_AWS.md`**](./docs/DEPLOIEMENT_AWS.md).

### Résumé de la Procédure

1. **Prérequis IAM & Backend S3** :
   - Définition de la *Permissions Boundary* : `permissions_boundary_arn`.
   - Création du bucket S3 d'état Terraform avec chiffrement et verrouillage natif S3.
2. **Prise en main par Terraform** :
   ```bash
   cd infra/terraform
   terraform init -backend-config=backend.hcl
   terraform validate
   terraform plan -out=tfplan
   terraform apply tfplan
   ```
3. **Construction et Publication des Conteneurs vers ECR** :
   ```bash
   ./scripts/deploy/build-and-push.sh [AWS_REGION] [ECR_APP_URL] [ECR_COLLAB_URL]
   ```
4. **Mise à Jour Sécurisée de l'Instance EC2 via SSM (Sans port SSH)** :
   ```bash
   ./scripts/deploy/deploy-ec2.sh <TAG> [INSTANCE_ID] [AWS_REGION]
   ```
5. **Nettoyage Intégral des Ressources (Post-Évaluation)** :
   ```bash
   terraform destroy -auto-approve
   ```

---

## 7. Structure du Dépôt

```text
├── app/                  # Application Next.js 16 (App Router, thèmes clair/sombre, UI responsive)
│   ├── (public)/d/       # Page de téléchargement publique /d/[linkId]
│   ├── admin/            # Console d'administration et déblocage /admin
│   ├── editor/           # Éditeur collaboratif temps réel avec aperçu Overleaf /editor/[docId]
│   ├── ui-kit/           # Vitrine de test des pistes de marque et tokens
│   └── api/              # Route Handlers Next.js (session, documents, téléchargement, admin)
├── collab/               # Serveur WebSocket Hocuspocus & protocoles CRDT Yjs
├── deploy/               # Fichiers de conteneurisation Docker, Caddyfile et scripts EC2
├── dist/                 # Artefacts compilés (lambdas zip, bundle collab)
├── docs/                 # Documentation technique d'ingénierie et d'architecture
│   ├── images/           # Diagrammes d'architecture (global architecture.png)
│   ├── CHOIX_TECHNIQUES.md # Justification des choix technologiques et des exclusions
│   ├── SCENARIOS.md      # Formalisation et validation des scénarios critiques SC01 à SC06
│   ├── DEPLOIEMENT_AWS.md  # Guide complet de déploiement et d'exploitation AWS
│   ├── DESIGN.md         # Architecture détaillée, design system, tokens et preuves
│   ├── DECISIONS.md      # Registre des 45 décisions d'architecture (ADR)
│   ├── API.md            # Spécification détaillée des endpoints
│   ├── openapi.yaml      # Spécification OpenAPI 3.0 importable
│   ├── TEST_REPORT.md    # Rapport de validation et résultats de charge
│   └── COST.md           # Modélisation des coûts AWS Free Tier (< 10 $)
├── infra/terraform/      # Infrastructure as Code AWS complète (17 fichiers .tf modulaires)
├── lambdas/              # Handlers des 5 fonctions AWS Lambda (PDF, API, Notifier, Reconciler, DLQ)
├── loadtest/             # Scripts d'injection de charge en boucle ouverte (Artillery / custom)
├── public/brand/         # Assets d'identité visuelle (logos SVG vectoriels, icônes PWA, images)
├── scripts/              # Scripts utilitaires d'init locale, déploiement, checks et tests de fumée
├── src/components/       # Composants React partagés (Logo, ThemeToggle, modales)
└── tests/                # Suites de tests automatisés (unitaires, intégration, contrats)
```
