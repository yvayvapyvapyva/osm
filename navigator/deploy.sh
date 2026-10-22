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

ENVIRONMENT="YDB_ENDPOINT=${ENDPOINT},YDB_DATABASE=${DATABASE}"

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
