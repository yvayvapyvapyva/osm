#!/bin/bash
# Загружает RESEND_API_KEY из navigatortg2-web/.env в секреты воркера nav-api-v2.
# Использование:
#   1. Впишите ключ в navigatortg2-web/.env
#   2. ./navigatortg2-web/set-resend-secret.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
    echo "Нет файла navigatortg2-web/.env" >&2
    exit 1
fi

# shellcheck disable=SC1091
set -a
source .env
set +a

if [ -z "${RESEND_API_KEY:-}" ]; then
    echo "RESEND_API_KEY пустой. Впишите ключ в navigatortg2-web/.env" >&2
    exit 1
fi

printf '%s' "$RESEND_API_KEY" | npx --yes wrangler@latest secret put RESEND_API_KEY \
    --config ../navigatortg2/cloudflare_worker/wrangler-api.toml

echo "RESEND_API_KEY загружен в nav-api-v2"
