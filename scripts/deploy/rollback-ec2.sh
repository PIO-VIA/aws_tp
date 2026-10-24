#!/bin/bash
set -euo pipefail

# ------------------------------------------------------------------------------
# Script de retour arrière sur EC2 (redéploie un tag précédent)
# Usage: ./scripts/deploy/rollback-ec2.sh <PREVIOUS_TAG> [INSTANCE_ID] [AWS_REGION]
# ------------------------------------------------------------------------------

PREVIOUS_TAG="${1:-}"

if [ -z "${PREVIOUS_TAG}" ]; then
    echo "Usage: $0 <PREVIOUS_TAG> [INSTANCE_ID] [AWS_REGION]" >&2
    echo "Erreur : Le tag de la version vers laquelle revenir en arrière est requis." >&2
    exit 1
fi

DIR=$(cd "$(dirname "$0")" && pwd)

echo "=== [ROLLBACK EC2] Déclenchement du retour arrière vers la version : ${PREVIOUS_TAG} ==="
"${DIR}/deploy-ec2.sh" "$@"
