#!/bin/bash
set -euo pipefail

# ------------------------------------------------------------------------------
# Script de déploiement à distance sur EC2 via SSH / EC2 Instance Connect
# Usage: ./scripts/deploy/deploy-ec2.sh <TAG> [INSTANCE_ID] [AWS_REGION] [PUBLIC_IP]
# ------------------------------------------------------------------------------

TAG="${1:-}"
INSTANCE_ID="${2:-${INSTANCE_ID:-}}"
REGION="${3:-${AWS_REGION:-eu-north-1}}"
PUBLIC_IP="${4:-${PUBLIC_IP:-}}"
PROJECT_PREFIX="${PROJECT_PREFIX:-editeur-collab-dev}"

if [ -z "${TAG}" ]; then
    echo "Usage: $0 <TAG> [INSTANCE_ID] [AWS_REGION] [PUBLIC_IP]" >&2
    echo "Erreur : Le tag de version est obligatoire." >&2
    exit 1
fi

# 1. Détection de l'INSTANCE_ID si absent
if [ -z "${INSTANCE_ID}" ]; then
    echo "INSTANCE_ID non fourni. Tentative de lecture depuis terraform output..."
    if command -v terraform >/dev/null 2>&1 && [ -d "infra/terraform" ]; then
        INSTANCE_ID=$(terraform -chdir=infra/terraform output -raw instance_id 2>/dev/null || true)
    fi
fi

if [ -z "${INSTANCE_ID}" ]; then
    echo "--> Tentative de détection automatique de l'instance EC2 via tags..."
    INSTANCE_ID=$(aws ec2 describe-instances \
        --region "${REGION}" \
        --filters "Name=tag:Name,Values=${PROJECT_PREFIX}-server" "Name=instance-state-name,Values=running" \
        --query "Reservations[0].Instances[0].InstanceId" \
        --output text 2>/dev/null || true)
    if [ "${INSTANCE_ID}" = "None" ]; then INSTANCE_ID=""; fi
    if [ -n "${INSTANCE_ID}" ]; then
        echo "--> Instance EC2 détectée : ${INSTANCE_ID}"
    fi
fi

if [ -z "${INSTANCE_ID}" ]; then
    echo "Usage: $0 <TAG> [INSTANCE_ID] [AWS_REGION] [PUBLIC_IP]" >&2
    echo "Erreur : Impossible de déterminer INSTANCE_ID." >&2
    exit 1
fi

# 2. Détection de la PUBLIC_IP si absente
if [ -z "${PUBLIC_IP}" ]; then
    echo "--> Recherche de l'adresse IP publique de l'instance ${INSTANCE_ID}..."
    PUBLIC_IP=$(aws ec2 describe-instances \
        --region "${REGION}" \
        --instance-ids "${INSTANCE_ID}" \
        --query "Reservations[0].Instances[0].PublicIpAddress" \
        --output text 2>/dev/null || true)
    if [ "${PUBLIC_IP}" = "None" ]; then PUBLIC_IP=""; fi
fi

if [ -z "${PUBLIC_IP}" ]; then
    echo "Usage: $0 <TAG> [INSTANCE_ID] [AWS_REGION] [PUBLIC_IP]" >&2
    echo "Erreur : Impossible de déterminer l'adresse IP publique de l'instance." >&2
    exit 1
fi

echo "=== [DEPLOY EC2] Déploiement de la version ${TAG} sur ${INSTANCE_ID} (${PUBLIC_IP}) via SSH ==="

# 3. Préparation de la clé SSH et nettoyage
SSH_KEY_FILE=$(mktemp -u /tmp/deploy_key_XXXXXX)
RUNNER_IP=""
SG_ID=""
AUTHORIZED_TEMPORARY_INGRESS=false

cleanup() {
    rm -f "${SSH_KEY_FILE}" "${SSH_KEY_FILE}.pub"
    if [ "${AUTHORIZED_TEMPORARY_INGRESS}" = "true" ] && [ -n "${RUNNER_IP}" ] && [ -n "${SG_ID}" ] && [ "${SG_ID}" != "None" ]; then
        echo "--> Nettoyage de la règle temporaire sur le port 22..."
        aws ec2 revoke-security-group-ingress \
            --region "${REGION}" \
            --group-id "${SG_ID}" \
            --protocol tcp \
            --port 22 \
            --cidr "${RUNNER_IP}/32" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# 4. Autorisation temporaire de l'IP du runner sur le port 22 si besoin
RUNNER_IP=$(curl -s --max-time 5 https://checkip.amazonaws.com 2>/dev/null || true)
SG_ID=$(aws ec2 describe-instances \
    --region "${REGION}" \
    --instance-ids "${INSTANCE_ID}" \
    --query "Reservations[0].Instances[0].SecurityGroups[0].GroupId" \
    --output text 2>/dev/null || true)

if [ -n "${RUNNER_IP}" ] && [ -n "${SG_ID}" ] && [ "${SG_ID}" != "None" ]; then
    echo "--> Vérification / autorisation de l'IP (${RUNNER_IP}/32) sur le port 22..."
    if aws ec2 authorize-security-group-ingress \
        --region "${REGION}" \
        --group-id "${SG_ID}" \
        --protocol tcp \
        --port 22 \
        --cidr "${RUNNER_IP}/32" 2>/dev/null; then
        AUTHORIZED_TEMPORARY_INGRESS=true
        echo "--> Règle temporaire ajoutée."
    else
        echo "--> Port 22 déjà accessible ou règle déjà présente."
    fi
fi

# 5. Configuration de la clé SSH (EC2_SSH_KEY ou EC2 Instance Connect)
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15"

if [ -n "${EC2_SSH_KEY:-}" ]; then
    echo "--> Utilisation de la clé SSH fournie via secret (EC2_SSH_KEY)..."
    echo "${EC2_SSH_KEY}" > "${SSH_KEY_FILE}"
    chmod 600 "${SSH_KEY_FILE}"
else
    echo "--> Génération d'une clé SSH éphémère et transmission via AWS EC2 Instance Connect..."
    rm -f "${SSH_KEY_FILE}" "${SSH_KEY_FILE}.pub"
    ssh-keygen -t rsa -b 2048 -f "${SSH_KEY_FILE}" -N "" -q
    aws ec2-instance-connect send-ssh-public-key \
        --region "${REGION}" \
        --instance-id "${INSTANCE_ID}" \
        --instance-os-user "ec2-user" \
        --ssh-public-key "file://${SSH_KEY_FILE}.pub"
    echo "--> Clé temporaire autorisée avec succès."
fi

# Attente brève de propagation réseau
sleep 2

# 6. Transfert des fichiers de configuration
echo "--> Transfert des fichiers de déploiement vers l'instance EC2..."
ssh ${SSH_OPTS} -i "${SSH_KEY_FILE}" ec2-user@"${PUBLIC_IP}" "mkdir -p /tmp/deploy-${TAG}"
scp ${SSH_OPTS} -i "${SSH_KEY_FILE}" \
    deploy/docker-compose.prod.yml \
    deploy/Caddyfile \
    deploy/update.sh \
    ec2-user@"${PUBLIC_IP}":/tmp/deploy-${TAG}/

# 7. Exécution en direct de la mise à jour
echo "--> Exécution de /opt/app/update.sh sur l'instance..."
ssh ${SSH_OPTS} -i "${SSH_KEY_FILE}" ec2-user@"${PUBLIC_IP}" "
    set -euo pipefail
    sudo mkdir -p /opt/app
    sudo cp /tmp/deploy-${TAG}/docker-compose.prod.yml /tmp/deploy-${TAG}/Caddyfile /tmp/deploy-${TAG}/update.sh /opt/app/
    sudo chmod +x /opt/app/update.sh
    rm -rf /tmp/deploy-${TAG}
    sudo /opt/app/update.sh '${TAG}'
"

echo "=== [DEPLOY EC2] Déploiement de la version ${TAG} sur ${PUBLIC_IP} terminé avec succès ! ==="
