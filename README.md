# Éditeur Collaboratif de Documents & Téléchargement Versionné sur AWS

Application web de rédaction collaborative en temps réel et de diffusion de documents PDF versionnés, conçue pour résister à des pics d'affluence extrêmes tout en garantissant des règles de capacité strictes, le respect d'invariants formels et une maîtrise totale des coûts sur AWS.

---

## 1. Caractéristiques Principales et Invariants

- **Invariant C1 (Capacité de Téléchargement)** : Pour tout lien configuré avec $N$ exemplaires, il est mathématiquement garanti que $0 \le \text{URL émises} \le N$. La réservation est atomique sous concurrence via DynamoDB `TransactWriteItems`, avec un chemin rapide en mémoire vive pour absorber les pics sans coût.
- **Invariant C2 (Convergence CRDT)** : Édition collaborative concurrente de texte brut (`Y.Text` via CodeMirror 6 et Hocuspocus). Journalisation préalable en écriture (Write-Ahead Logging) dans DynamoDB avant diffusion : aucune perte d'update acquitté en cas de redémarrage.
- **Invariant C3 (Immuabilité & Single-Flight PDF)** : Chaque version est identifiée par le hachage SHA-256 de son texte UTF-8 (`pdfs/<docId>/<versionId>.pdf`). Rendu asynchrone déterministe via file SQS, avec verrou single-flight évitant tout recalcul redondant et remboursement automatique via DLQ en cas d'échec.
- **Invariant C4 (Quota UTF-16 & Anti-Abus)** : Quota journalier strict de 10 000 caractères UTF-16 par rédacteur (remise à zéro à 00:00 UTC). Déduplication des retransmissions par `IntervalSet` (0 caractère refacturé). Suspension automatique en cas de rafale anormale (> 50 frappes/s).
- **Historique & Restauration (F10)** : Visualisation des instantanés S3 et restauration sans altération de l'historique postérieur ni consommation de quota journalier (`billedChars = 0`, limite 10/heure).
- **Supervision & Administration (F11)** : Tableau de bord `/admin` actualisé toutes les 5 secondes (documents ouverts, liens actifs, rédacteurs suspendus avec bouton de déblocage immédiat).

---

## 2. Architecture Technique et Choix

| Composant | Technologie | Justification |
| :--- | :--- | :--- |
| **Frontend & UI** | Next.js 16 (App Router), React 19, Tailwind CSS v4 | Rendu serveur hybride, performance et ergonomie réactive |
| **Éditeur de texte** | CodeMirror 6 + `y-codemirror.next` + Yjs | Éditeur modulaire léger avec présence et curseurs distants |
| **Serveur de collaboration** | Hocuspocus 4.7.1 (Node.js 22, instance unique) | Évite la complexité de Redis et du routage multi-instances (D-02) |
| **Base de données** | Amazon DynamoDB (12 tables `PAY_PER_REQUEST`) | Latence milliseconde, transactions atomiques, TTL et Streams |
| **Stockage Objets** | Amazon S3 (Privé, SSE-S3, TLS forcé) | Stockage immuable des textes, instantanés et PDF pré-signés |
| **Files asynchrones** | Amazon SQS (`pdf-jobs` + `pdf-jobs-dlq`) | Traitement robuste du rendu PDF avec politique de réessai et DLQ |
| **E-mails / Alertes** | Amazon SES (sur AWS) / Mailpit (en local) | Envoi d'alertes lors de l'épuisement du dernier exemplaire (F05) |
| **Infrastructure as Code** | Terraform >= 1.10 (Backend S3 avec verrou natif) | Déploiement reproductible, least-privilege strict, budget 10 $ |

---

## 3. Guide de Démarrage Rapide en Local

### 3.1 Prérequis
- **Node.js** >= 22.0.0
- **Docker** et **Docker Compose**
- **Terraform** >= 1.10.0 (pour validation locale)

### 3.2 Lancement en une seule commande
Le projet fournit un orchestrateur automatisé configurant l'ensemble de la pile locale :
```bash
# 1. Installation des dépendances npm
npm ci

# 2. Démarrage des conteneurs locaux, initialisation des tables/buckets et serveurs dev
npm run dev:all
```

Cette commande exécute séquentiellement :
1. `docker compose up -d` : Démarre DynamoDB Local (8000), MinIO (9000/9001), ElasticMQ (9324/9325) et Mailpit (1025/8025).
2. `npm run local:init` : Crée les 12 tables DynamoDB avec index et TTL, initialise le bucket S3 local `editeur-local-data`, et configure les files SQS.
3. `npm run dev` : Lance concurremment :
   - Next.js (port 3000)
   - Serveur WebSocket Hocuspocus (port 1234 public, 1235 interne)
   - Worker / Poller SQS local (`scripts/local-sqs-poller.ts`)
   - Réconciliateur local (`scripts/local-reconciler.ts`)

### 3.3 Points d'Accès Locaux
- **Application Web & Éditeur** : [http://localhost:3000](http://localhost:3000)
- **Tableau de Bord Admin** : [http://localhost:3000/admin](http://localhost:3000/admin) *(Token : `dev-admin-token-change-in-prod`)*
- **Console MinIO (S3)** : [http://localhost:9001](http://localhost:9001) *(Identifiants : `minioadmin` / `minioadminpassword`)*
- **Interface Mailpit (E-mails)** : [http://localhost:8025](http://localhost:8025)
- **File SQS ElasticMQ** : [http://localhost:9325](http://localhost:9325)

---

## 4. Exécution des Suites de Tests et Validation

Toutes les commandes de test s'exécutent en local contre les services conteneurisés :

```bash
# Tests unitaires (comptage UTF-16, IntervalSet, validation Zod, JWT)
npm run test

# Tests d'intégration des permissions et du bundle réel de la Lambda PDF (Section 20)
npm run test:integration

# Scénarios métier de bout en bout (SC01 à SC06 - 23 tests critiques)
npm run test:scenarios

# Test de charge de téléchargement en rafale (Vérification stricte de C1)
npm run loadtest:download

# Test de charge de collaboration concurrente (30 rédacteurs, p50/p95, Invariant C2)
npm run loadtest:collab

# Test de fumée (Smoke Test) de bout en bout
npm run smoke
```

---

## 5. Déploiement sur AWS (Infrastructure & Conteneurs)

> [!IMPORTANT]
> Conformément à la règle 0.8 du sujet, **aucune commande de déploiement réel n'a été exécutée automatiquement**. La configuration Terraform a été rédigée, formatée (`terraform fmt`) et validée avec succès (`terraform validate`).

### 5.1 Préparation de Terraform
1. Rendez-vous dans le répertoire `infra/terraform/` :
   ```bash
   cd infra/terraform
   ```
2. Créez votre fichier de backend S3 :
   ```bash
   cp backend.hcl.example backend.hcl
   # Éditez bucket, key et region selon votre compte AWS
   ```
3. Créez vos variables de déploiement :
   ```bash
   cp terraform.tfvars.example terraform.tfvars
   # Configurez alert_email, ses_sender, github_repo, etc.
   ```
4. Initialisez et validez :
   ```bash
   terraform init -backend-config=backend.hcl
   terraform plan -out=tfplan
   ```

### 5.2 Déploiement des Images de Production
Le script de build prépare les conteneurs légers et les pousse vers Amazon ECR :
```bash
./scripts/deploy/build-and-push.sh <AWS_REGION> <ECR_APP_URL> <ECR_COLLAB_URL>
```

### 5.3 Déploiement sur l'Instance EC2
L'instance EC2 (Amazon Linux 2023) est gérée sans port SSH ouvert, exclusivement via AWS Systems Manager (SSM) :
```bash
./scripts/deploy/deploy-ec2.sh <GIT_SHA> <INSTANCE_ID> <AWS_REGION>
```
Le script contacte l'agent SSM, tire les nouvelles images ECR, exécute `docker compose up -d`, et effectue un contrôle de santé HTTP (`http://127.0.0.1:80/`) avant d'acquitter le déploiement.

### 5.4 Test de Fumée de Production
Pour valider l'ensemble des flux (session, création de doc, liens, téléchargement et intégrité PDF) :
```bash
npm run smoke -- --base-url https://<distributionId>.cloudfront.net
```

### 5.5 Retour Arrière (Rollback)
- **Serveur EC2** : Redéployez instantanément un tag d'image antérieur :
  ```bash
  ./scripts/deploy/rollback-ec2.sh <TAG_PRECEDENT> <INSTANCE_ID> <AWS_REGION>
  ```
- **Fonctions Lambda** : Mettez à jour le code vers le package précédent via `aws lambda update-function-code`.

---

## 6. Destruction Complète des Ressources (Clean-up)

Pour garantir qu'aucun frais ne subsiste après l'évaluation :

```bash
cd infra/terraform

# 1. Destruction de l'ensemble des ressources AWS
terraform destroy -auto-approve

# 2. Vérifications de propreté dans la console AWS :
# - Aucun Elastic IP (EIP) non attaché
# - Aucune instance EC2 en cours d'exécution
# - Aucun volume EBS résiduel
# - Tables DynamoDB et Bucket S3 supprimés (data_bucket_force_destroy = true)
# - Dépôts ECR supprimés
```

---

## 7. Structure du Référentiel

```text
├── app/                  # Application Next.js 16 (App Router)
│   ├── (public)/d/       # Page de téléchargement publique /d/[linkId]
│   ├── admin/            # Page de supervision /admin
│   ├── editor/           # Éditeur collaboratif temps réel /editor/[docId]
│   └── api/              # Route Handlers Next.js (session, documents, dl, admin)
├── collab/               # Serveur WebSocket Hocuspocus & protocoles CRDT
├── deploy/               # Fichiers de conteneurisation et déploiement
│   ├── Dockerfile.next   # Image production Next.js (standalone)
│   ├── Dockerfile.collab # Image production Hocuspocus
│   ├── Caddyfile         # Configuration reverse proxy port 80 (WebSockets)
│   ├── docker-compose.prod.yml
│   ├── bootstrap.sh      # User data EC2 (Amazon Linux 2023)
│   └── update.sh         # Script de mise à jour à chaud via SSM
├── dist/                 # Artefacts compilés (dist/lambdas/*.zip, dist/collab/server.js)
├── docs/                 # Documentation d'architecture, API, rapports et coûts
│   ├── API.md            # Spécification détaillée des endpoints
│   ├── openapi.yaml      # Spécification OpenAPI 3.1.0 importable
│   ├── DESIGN.md         # Architecture, modèles de données et preuves des invariants
│   ├── TEST_REPORT.md    # Rapport des tests unitaires, scénarios et charge
│   ├── COST.md           # Modélisation des coûts AWS et profils d'usage
│   └── DECISIONS.md      # Journal de bord de toutes les décisions d'architecture
├── infra/terraform/      # Infrastructure as Code AWS complète (17 fichiers)
├── lambdas/              # Handlers des 5 fonctions Lambda du projet
├── loadtest/             # Scripts de test de charge (download-burst, collab-sim)
├── scripts/              # Scripts utilitaires, init locale, smoke test et déploiement
└── tests/                # Suites de tests automatisés (unit, integration, scenarios)
```
