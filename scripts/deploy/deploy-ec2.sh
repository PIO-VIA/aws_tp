#!/bin/bash
set -euo pipefail

# ------------------------------------------------------------------------------
# Script de déploiement à distance sur EC2 via AWS Systems Manager (SSM)
# Usage: ./scripts/deploy/deploy-ec2.sh <TAG> [INSTANCE_ID] [AWS_REGION]
# ------------------------------------------------------------------------------

TAG="${1:-}"
INSTANCE_ID="${2:-${INSTANCE_ID:-}}"
REGION="${3:-${AWS_REGION:-eu-west-3}}"

if [ -z "${TAG}" ]; then
    echo "Usage: $0 <TAG> [INSTANCE_ID] [AWS_REGION]" >&2
    echo "Erreur : Le tag de version est obligatoire." >&2
    exit 1
fi

if [ -z "${INSTANCE_ID}" ]; then
    echo "INSTANCE_ID non fourni. Tentative de lecture depuis terraform output..."
    if command -v terraform >/dev/null 2>&1 && [ -d "infra/terraform" ]; then
        INSTANCE_ID=$(terraform -chdir=infra/terraform output -raw instance_id 2>/dev/null || true)
    fi
fi

if [ -z "${INSTANCE_ID}" ]; then
    echo "Erreur : Impossible de déterminer INSTANCE_ID." >&2
    exit 1
fi

echo "=== [DEPLOY EC2] Déploiement de la version ${TAG} sur ${INSTANCE_ID} (${REGION}) ==="

# 1. Envoi de la commande SSM
COMMAND_ID=$(aws ssm send-command \
    --region "${REGION}" \
    --instance-ids "${INSTANCE_ID}" \
    --document-name "AWS-RunShellScript" \
    --parameters "commands=[\"/opt/app/update.sh ${TAG}\"]" \
    --comment "Déploiement version ${TAG}" \
    --query "Command.CommandId" \
    --output text)

echo "--> Commande SSM envoyée. CommandId: ${COMMAND_ID}"
echo "--> En attente de l'exécution..."

# 2. Polling du statut de la commande
MAX_WAIT=30
STATUS="InProgress"

for i in $(seq 1 $MAX_WAIT); do
    sleep 5
    INVOCATION=$(aws ssm get-command-invocation \
        --region "${REGION}" \
        --command-id "${COMMAND_ID}" \
        --instance-id "${INSTANCE_ID}" \
        --output json 2>/dev/null || true)

    if [ -n "${INVOCATION}" ]; then
        STATUS=$(echo "${INVOCATION}" | jq -r '.Status // "Unknown"')
        if [ "${STATUS}" = "Success" ]; then
            echo "=== [DEPLOY EC2] Commande exécutée avec succès ! ==="
            echo "--- Sortie standard ---"
            echo "${INVOCATION}" | jq -r '.StandardOutputContent // ""'
            exit 0
        elif [ "${STATUS}" = "Failed" ] || [ "${STATUS}" = "Cancelled" ] || [ "${STATUS}" = "TimedOut" ]; then
            echo "ERREUR : La commande SSM s'est terminée avec le statut : ${STATUS}" >&2
            echo "--- Sortie d'erreur ---" >&2
            echo "${INVOCATION}" | jq -r '.StandardErrorContent // ""' >&2
            echo "--- Sortie standard ---" >&2
            echo "${INVOCATION}" | jq -r '.StandardOutputContent // ""' >&2
            exit 1
        fi
    fi
    echo "Attente (tentative ${i}/${MAX_WAIT}, statut actuel: ${STATUS})..."
done

echo "ERREUR : Délai d'attente dépassé pour la commande SSM ${COMMAND_ID}." >&2
exit 1
