#!/usr/bin/env bash
# Деплой PAD-бэкенда в отдельную Яндекс.Облако функцию.
# Использует базу данных OSM-проекта (dbosm), таблица сцен — scene.
# Аккаунты и пароли не используются.
set -euo pipefail

FUNCTION_ID="${FUNCTION_ID:-d4esfoiand5dinv3mfth}"
FUNCTION_NAME="${FUNCTION_NAME:-pad-osm}"
DATABASE="${YDB_DATABASE:-/ru-central1/b1gtnlal9r2s3rvqadjn/etnjvaftd6eakeq08kqr}"
ENDPOINT="${YDB_ENDPOINT:-grpcs://ydb.serverless.yandexcloud.net:2135}"
SERVICE_ACCOUNT_ID="${SERVICE_ACCOUNT_ID:-aje0hrd823msk3hqaikt}"

cd "$(dirname "$0")"

rm -rf yandex_cloud_function/__pycache__

echo "Деплой PAD-функции ${FUNCTION_NAME} (${FUNCTION_ID})"
echo "База OSM: ${DATABASE}"

yc serverless function version create \
  --function-id "${FUNCTION_ID}" \
  --runtime python314 \
  --entrypoint index.handler \
  --memory 256MB \
  --execution-timeout 30s \
  --service-account-id "${SERVICE_ACCOUNT_ID}" \
  --environment "YDB_ENDPOINT=${ENDPOINT},YDB_DATABASE=${DATABASE}" \
  --source-path yandex_cloud_function \
  --description "PAD на БД dbosm без аккаунтов, $(date '+%Y-%m-%d %H:%M:%S')"

echo "Готово: https://functions.yandexcloud.net/${FUNCTION_ID}"
