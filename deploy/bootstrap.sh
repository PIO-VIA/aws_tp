#!/bin/bash
set -euo pipefail

# ------------------------------------------------------------------------------
# Script de démarrage EC2 (Amazon Linux 2023)
# Installe Docker, configure l'application, récupère les secrets SSM et lance Caddy/Next/Collab
# ------------------------------------------------------------------------------

echo "=== [BOOTSTRAP] Début de l'initialisation de l'instance EC2 ==="

# 1. Mise à jour et installation de Docker et Docker Compose
dnf update -y
dnf install -y docker jq awscli
systemctl enable --now docker
usermod -aG docker ec2-user

# Installation du plugin docker-compose si non présent
DOCKER_CONFIG="$${DOCKER_CONFIG:-/usr/local/lib/docker}"
mkdir -p "$$DOCKER_CONFIG/cli-plugins"
if ! docker compose version >/dev/null 2>&1; then
    dnf install -y docker-compose-plugin || {
        echo "Installation manuelle du plugin docker-compose..."
        curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$$(uname -m)" -o "$$DOCKER_CONFIG/cli-plugins/docker-compose"
        chmod +x "$$DOCKER_CONFIG/cli-plugins/docker-compose"
    }
fi

# 2. Préparation du répertoire applicatif
mkdir -p /opt/app
cd /opt/app

# Variables d'environnement injectées par Terraform via template
AWS_REGION="${AWS_REGION}"
SSM_PREFIX="${SSM_PREFIX}"
ECR_APP_URL="${ECR_APP_URL}"
ECR_COLLAB_URL="${ECR_COLLAB_URL}"
DATA_BUCKET="${DATA_BUCKET}"
PDF_QUEUE_URL="${PDF_QUEUE_URL}"

# 3. Récupération des paramètres SSM pour constituer /opt/app/.env
echo "=== [BOOTSTRAP] Récupération des paramètres SSM depuis $${SSM_PREFIX} ==="
cat <<EOF > /opt/app/.env
# Généré automatiquement par bootstrap.sh
APP_ENV=aws
AWS_REGION=$${AWS_REGION}
S3_BUCKET=$${DATA_BUCKET}
PDF_QUEUE_URL=$${PDF_QUEUE_URL}
SSM_PREFIX=$${SSM_PREFIX}
ECR_APP_URL=$${ECR_APP_URL}
ECR_COLLAB_URL=$${ECR_COLLAB_URL}
EOF

# Injection sécurisée de tous les paramètres sous SSM_PREFIX dans .env
if [ -n "$${SSM_PREFIX}" ]; then
    aws ssm get-parameters-by-path \
        --region "$${AWS_REGION}" \
        --path "$${SSM_PREFIX}" \
        --with-decryption \
        --query "Parameters[*].[Name,Value]" \
        --output text 2>/dev/null | while read -r name value; do
            key=$$(echo "$$name" | sed "s|^$${SSM_PREFIX}||")
            echo "$${key}=$${value}" >> /opt/app/.env
    done || true
fi

# 4. Authentification ECR et tentative de pull des images (sans bloquer si 1er boot)
if [ -n "$${ECR_APP_URL}" ]; then
    REGISTRY=$$(echo "$${ECR_APP_URL}" | cut -d/ -f1)
    echo "=== [BOOTSTRAP] Authentification ECR sur $${REGISTRY} ==="
    aws ecr get-login-password --region "$${AWS_REGION}" | docker login --username AWS --password-stdin "$${REGISTRY}" || true
    docker compose -f /opt/app/docker-compose.prod.yml pull || true
fi

# 5. Démarrage des conteneurs
echo "=== [BOOTSTRAP] Démarrage des services Docker Compose ==="
if [ -f /opt/app/docker-compose.prod.yml ]; then
    docker compose -f /opt/app/docker-compose.prod.yml up -d || true
fi

echo "=== [BOOTSTRAP] Initialisation terminée avec succès ==="
