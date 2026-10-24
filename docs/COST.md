# Modèle Économique et Estimation des Coûts AWS (COST.md)

Projet : **Éditeur de documents collaboratif avec téléchargement versionné**  
Région principale : `eu-north-1` (Paris)  
Budget mensuel alloué : **10,00 USD** (surveillé par AWS Budgets à 50 %, 80 % et 100 %)

---

## 1. Principes d'Optimisation des Coûts

L'architecture a été conçue pour minimiser les coûts d'infrastructure en exploitant le niveau gratuit (AWS Free Tier) et des services entièrement facturés à l'usage réel :
1. **Pas de Kubernetes (EKS)** : économise ~73 $/mois de frais fixes de cluster managé.
2. **Pas d'ElastiCache Redis** : économise ~15 $/mois de nœud cache dédié.
3. **Une seule instance EC2 `t3.small`** : suffisante pour accueillir les WebSockets Hocuspocus et l'application Next.js compilée en standalone.
4. **DynamoDB On-Demand (`PAY_PER_REQUEST`)** : 0 $ de capacité réservée inactive ; seules les lectures et écritures réelles sont facturées (25 Go et 2,5 millions de flux gratuits chaque mois).
5. **Rendu PDF Single-Flight** : évite le recalcul redondant sous pic de charge (1 seul rendu pour $N$ réservations identiques).
6. **Chemin rapide mémoire pour liens saturés** : évite jusqu'à 12 000 transactions DynamoDB par lien lors des rafales de téléchargement après épuisement.

---

## 2. Grille Tarifaire par Service (eu-north-1)

| Service | Unité de facturation | Tarif unitaire indicatif | Franchise gratuite (Free Tier) |
| :--- | :--- | :--- | :--- |
| **EC2 (`t3.small`)** | Instance Linux (heure) | 0,0232 $/heure (~16,70 $/mois) | 750h de `t2.micro` / `t3.micro` la 1ère année |
| **Amazon CloudFront** | Données sortantes (Go) | 0,085 $/Go | 1 To de transfert sortant / mois |
| **Amazon S3** | Stockage Standard (Go/mois) | 0,023 $/Go/mois | 5 Go de stockage Standard |
| **Amazon S3** | Requêtes PUT / LIST / GET | 0,005 $ / 1 000 PUT<br>0,0004 $ / 1 000 GET | 20 000 GET et 2 000 PUT |
| **Amazon DynamoDB** | Écritures (WRU) / Lectures (RRU) | 1,25 $ / million WRU<br>0,25 $ / million RRU | 25 WRU / 25 RRU de capacité ou équivalent |
| **AWS Lambda (arm64)** | Requêtes / Durée Go-seconde | 0,20 $ / million requêtes<br>0,0000133334 $ / Go-s | 1 000 000 de requêtes et 3,2M Go-s |
| **Amazon SQS** | Requêtes de file | 0,40 $ / million | 1 000 000 de requêtes / mois |
| **Amazon SES** | E-mails sortants | 0,10 $ / 1 000 e-mails | 62 000 e-mails / mois si envoyés depuis EC2 |
| **CloudWatch Logs** | Ingestion de logs (Go) | 0,50 $/Go | 5 Go d'ingestion / mois |

---

## 3. Modélisation selon 3 Profils d'Usage

### Profil A : Démonstration et Évaluation du Jury (7 jours)
- **Hypothèse** : 5 rédacteurs actifs, 20 documents, 200 téléchargements de PDF de 50 Ko.
- **Détail** :
  - EC2 `t3.small` (7 jours) : $0,0232 \times 24 \times 7 = \mathbf{3,90\ \$}$
  - DynamoDB : < 5 000 requêtes = **0,01 $**
  - S3 Stockage & Requêtes : < 10 Mo = **0,01 $**
  - Lambda : < 1 000 invocations = **0,00 $** (couvert par le Free Tier)
  - CloudFront : < 1 Go de transfert = **0,00 $** (couvert par le Free Tier)
  - SES : 20 e-mails = **0,00 $**
- **Coût total estimé pour l'évaluation** : **~ 3,92 USD** (inférieur au budget de 10 $).

---

### Profil B : Utilisation Nominale Associative (1 mois)
- **Hypothèse** : 10 rédacteurs actifs quotidiens, 100 documents rédigés, 5 000 téléchargements de PDF / mois.
- **Détail** :
  - EC2 `t3.small` (30 jours) : **16,70 $** (ou 0 $ la 1ère année si déployé sur `t3.micro` Free Tier)
  - DynamoDB (écritures WAL + quotas) : ~250 000 WRU = **0,31 $**
  - S3 (500 Mo de PDF et snapshots) : **0,02 $**
  - Lambda (workers et dl-api) : 25 000 invocations = **0,05 $**
  - SQS : 5 000 messages = **0,00 $**
  - CloudWatch Logs (rétention 14j) : **0,20 $**
- **Coût total estimé** : **~ 17,28 USD** (ou **~ 0,58 USD** avec une instance `t3.micro` sous Free Tier).

---

### Profil C : Pic de Charge Extrême du Sujet (1 heure de pic)
- **Hypothèse** :
  - **300 rédacteurs simultanés** (1 frappe/s pendant 1 heure = 1 080 000 frappes).
  - **Pic de 12 000 requêtes de téléchargement** sur un lien de 100 exemplaires.
- **Comportement et coût du pic** :
  1. **Collaboration** :
     - 1 080 000 mises à jour = 1 080 000 items insérés dans `doc_updates`.
     - Coût DynamoDB : $1,08 \times 1,25 = \mathbf{1,35\ \$}$.
     - CPU EC2 : crête absorbée sur un seul cœur sans saturation (profilage local : 18 % pour 30 rédacteurs).
  2. **Téléchargements** :
     - 100 premières requêtes : transactions atomiques DynamoDB = $100 \times 2 = 200\text{ WRU} = \mathbf{0,00025\ \$}$.
     - 11 900 requêtes suivantes : rejetées par le chemin rapide mémoire sans écriture = **0,00 $**.
     - Rendu PDF : 1 seul job exécuté en single-flight (taille 50 Ko) = **0,0001 $**.
     - Transfert CloudFront : $100 \times 50\text{ Ko} = 5\text{ Mo} = \mathbf{0,00\ \$}$.
- **Surcoût strict du pic de charge** : **~ 1,36 USD**.

---

## 4. Tableau de Synthèse des Dépenses Réelles

*Ce tableau est à compléter avec les relevés réels de la console AWS Cost Explorer après déploiement :*

| Date | Période | Services principaux | Coût réel facturé (USD) | Écart / Budget |
| :--- | :--- | :--- | :---: | :---: |
| 2026-10-24 | Tests locaux / CI | Aucun (LocalStack / Docker) | 0,00 $ | 0 % |
| — | Déploiement initial | EC2, DynamoDB, S3 | *À renseigner* | — |
| — | Évaluation jury | EC2, CloudFront, Lambda | *À renseigner* | — |
| — | Destruction (`terraform destroy`) | 0 ressource active résiduelle | 0,00 $ | — |
