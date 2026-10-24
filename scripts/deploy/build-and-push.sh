#!/bin/bash
set -euo pipefail

# ------------------------------------------------------------------------------
# Script de build et push des images Docker vers Amazon ECR
# Usage: ./scripts/deploy/build-and-push.sh [AWS_REGION] [ECR_APP_URL] [ECR_COLLAB_URL]
# ------------------------------------------------------------------------------

REGION="${1:-${AWS_REGION:-eu-west-3}}"
APP_REPO="${2:-${ECR_APP_URL:-}}"
COLLAB_REPO="${3:-${ECR_COLLAB_URL:-}}"

if [ -z "${APP_REPO}" ] || [ -z "${COLLAB_REPO}" ]; then
    echo "Usage: $0 [AWS_REGION] [ECR_APP_URL] [ECR_COLLAB_URL]" >&2
    echo "Erreur : Les URLs des dépôts ECR (app et collab) sont obligatoires." >&2
    exit 1
fi

GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "manual")
REGISTRY=$(echo "${APP_REPO}" | cut -d/ -f1)

echo "=== [BUILD & PUSH] Tag: ${GIT_SHA} | Registry: ${REGISTRY} | Région: ${REGION} ==="

# 1. Compilation des applications Next.js et Collab
echo "--> Compilation de l'application Next.js et du serveur Collab..."
npm run build
npm run build:collab

# 2. Connexion au registre ECR
echo "--> Connexion à AWS ECR..."
aws ecr get-login-password --region "${REGION}" | docker login --username AWS --password-stdin "${REGISTRY}"

# 2. Build image Next.js (app)
echo "--> Build de l'image Next.js (${APP_REPO}:${GIT_SHA})..."
docker build \
    -f deploy/Dockerfile.next \
    -t "${APP_REPO}:${GIT_SHA}" \
    -t "${APP_REPO}:latest" \
    .

# 3. Build image Hocuspocus (collab)
echo "--> Build de l'image Collab (${COLLAB_REPO}:${GIT_SHA})..."
docker build \
    -f deploy/Dockerfile.collab \
    -t "${COLLAB_REPO}:${GIT_SHA}" \
    -t "${COLLAB_REPO}:latest" \
    .

# 4. Push vers ECR
echo "--> Push de l'image Next.js..."
docker push "${APP_REPO}:${GIT_SHA}"
docker push "${APP_REPO}:latest"

echo "--> Push de l'image Collab..."
docker push "${COLLAB_REPO}:${GIT_SHA}"
docker push "${COLLAB_REPO}:latest"

echo "=== [BUILD & PUSH] Images poussées avec succès sur ECR (Tags: ${GIT_SHA}, latest) ==="
