#!/usr/bin/env bash
# Деплой OSM-версии бэкенда в Яндекс Облако.
# Требуется настроенный yc CLI (yc config list).
set -euo pipefail

FUNCTION_ID="${FUNCTION_ID:-d4e02ghbv31h6kpf8ddh}"
FUNCTION_NAME="${FUNCTION_NAME:-osmn}"
DATABASE="${YDB_DATABASE:-/ru-central1/b1gtnlal9r2s3rvqadjn/etnjvaftd6eakeq08kqr}"
ENDPOINT="${YDB_ENDPOINT:-grpcs://ydb.serverless.yandexcloud.net:2135}"
SERVICE_ACCOUNT_ID="${SERVICE_ACCOUNT_ID:-aje0hrd823msk3hqaikt}"

cd "$(dirname "$0")"

echo "Деплой функции ${FUNCTION_NAME} (${FUNCTION_ID})"
echo "База: ${DATABASE}"

# Секреты авторизации редактора не хранятся в репозитории. Если они не заданы
# в окружении, переиспользуем значения из текущей версии функции, чтобы
# обычный деплой не отключал вход через Telegram и админ-ключ.
CURRENT_ENV="$(yc serverless function version get-by-tag \
  --function-id "${FUNCTION_ID}" --tag '$latest' --format json 2>/dev/null || true)"

current_secret() {
  printf '%s' "${CURRENT_ENV}" | python3 -c \
    'import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print((data.get("environment") or {}).get(sys.argv[1], ""))' "$1"
}

TELEGRAM_TOKEN="${TELEGRAM_TOKEN:-$(current_secret TELEGRAM_TOKEN)}"
ADMIN_ACCESS_KEY="${ADMIN_ACCESS_KEY:-$(current_secret ADMIN_ACCESS_KEY)}"

ENVIRONMENT="YDB_ENDPOINT=${ENDPOINT},YDB_DATABASE=${DATABASE}"
if [ -n "${TELEGRAM_TOKEN}" ]; then
  ENVIRONMENT="${ENVIRONMENT},TELEGRAM_TOKEN=${TELEGRAM_TOKEN}"
fi
if [ -n "${ADMIN_ACCESS_KEY}" ]; then
  ENVIRONMENT="${ENVIRONMENT},ADMIN_ACCESS_KEY=${ADMIN_ACCESS_KEY}"
fi

yc serverless function version create \
  --function-id "${FUNCTION_ID}" \
  --runtime python314 \
  --entrypoint handler.handler \
  --memory 256MB \
  --execution-timeout 20s \
  --service-account-id "${SERVICE_ACCOUNT_ID}" \
  --environment "${ENVIRONMENT}" \
  --source-path backend \
  --description "Обновление $(date '+%Y-%m-%d %H:%M:%S')"

echo "Готово: https://functions.yandexcloud.net/${FUNCTION_ID}"
