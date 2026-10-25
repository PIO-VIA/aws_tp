#!/bin/bash
set -euo pipefail

# ------------------------------------------------------------------------------
# Script de mise à jour à chaud sur EC2 (/opt/app/update.sh <tag>)
# Exécuté via AWS SSM Run Command lors des déploiements CI/CD
# ------------------------------------------------------------------------------

TAG="${1:-latest}"
cd /opt/app

echo "=== [UPDATE] Déploiement de la version ${TAG} ==="

# 1. Chargement des variables
if [ -f /opt/app/.env ]; then
    # shellcheck disable=SC1091
    source /opt/app/.env
fi

AWS_REGION="${AWS_REGION:-eu-north-1}"
ECR_APP_URL="${ECR_APP_URL:-}"

# Auto-détection de ECR_APP_URL si absent de .env
if [ -z "${ECR_APP_URL}" ]; then
    ACCOUNT_ID=$(aws sts get-caller-identity --region "${AWS_REGION}" --query Account --output text 2>/dev/null || true)
    if [ -n "${ACCOUNT_ID}" ] && [ "${ACCOUNT_ID}" != "None" ]; then
        ECR_APP_URL="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/editeur-collab-dev-app"
    fi
fi

# 2. Authentification ECR
if [ -n "${ECR_APP_URL}" ]; then
    REGISTRY=$(echo "${ECR_APP_URL}" | cut -d/ -f1)
    echo "=== [UPDATE] Connexion au registre ECR ${REGISTRY} ==="
    aws ecr get-login-password --region "${AWS_REGION}" | docker login --username AWS --password-stdin "${REGISTRY}"
fi

# 3. Pull des nouvelles images
export IMAGE_TAG="${TAG}"
echo "=== [UPDATE] Téléchargement des images taguées ${TAG} ==="
docker compose -f /opt/app/docker-compose.prod.yml pull

# 4. Redémarrage des services
echo "=== [UPDATE] Application des conteneurs ==="
docker compose -f /opt/app/docker-compose.prod.yml up -d --remove-orphans

# 5. Vérification de santé (Healthcheck)
echo "=== [UPDATE] Vérification de la santé des conteneurs ==="
MAX_ATTEMPTS=15
HEALTH_OK=false

for i in $(seq 1 $MAX_ATTEMPTS); do
    if curl -s -f http://127.0.0.1:80/ >/dev/null 2>&1 || curl -s -f http://127.0.0.1:80/api/session >/dev/null 2>&1; then
        HEALTH_OK=true
        echo "=== [UPDATE] Health check réussi à la tentative ${i} ==="
        break
    fi
    echo "Attente du démarrage (tentative ${i}/${MAX_ATTEMPTS})..."
    sleep 2
done

if [ "$HEALTH_OK" = false ]; then
    echo "ERREUR : Le health check a échoué après ${MAX_ATTEMPTS} tentatives !" >&2
    docker compose -f /opt/app/docker-compose.prod.yml logs --tail=50 >&2
    exit 1
fi

echo "=== [UPDATE] Déploiement de la version ${TAG} terminé avec succès ==="
