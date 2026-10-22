#!/usr/bin/env bash
# Деплой PAD-бэкенда в отдельную Яндекс.Облако функцию.
# Использует базу данных OSM-проекта (dbosm), таблица сцен — scene.
#
# Требуется настроенный yc CLI и переменные окружения с секретами:
#   TELEGRAM_BOT_TOKEN — токен Telegram-бота
#   DEFAULT_PASSWORD   — пароль пользователя default
# Необязательно:
#   REPORT_CHAT_ID     — чат для отчётов (сохраняется в окружении функции)
set -euo pipefail

FUNCTION_ID="${FUNCTION_ID:-d4esfoiand5dinv3mfth}"
FUNCTION_NAME="${FUNCTION_NAME:-pad-osm}"
DATABASE="${YDB_DATABASE:-/ru-central1/b1gtnlal9r2s3rvqadjn/etnjvaftd6eakeq08kqr}"
ENDPOINT="${YDB_ENDPOINT:-grpcs://ydb.serverless.yandexcloud.net:2135}"
SERVICE_ACCOUNT_ID="${SERVICE_ACCOUNT_ID:-aje0hrd823msk3hqaikt}"

: "${TELEGRAM_BOT_TOKEN:?Укажите TELEGRAM_BOT_TOKEN в переменных окружения}"
: "${DEFAULT_PASSWORD:?Укажите DEFAULT_PASSWORD в переменных окружения}"

cd "$(dirname "$0")"

ENVIRONMENT="YDB_ENDPOINT=${ENDPOINT},YDB_DATABASE=${DATABASE},TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN},DEFAULT_PASSWORD=${DEFAULT_PASSWORD}"
if [[ -n "${REPORT_CHAT_ID:-}" ]]; then
  ENVIRONMENT="${ENVIRONMENT},REPORT_CHAT_ID=${REPORT_CHAT_ID}"
fi

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
  --environment "${ENVIRONMENT}" \
  --source-path yandex_cloud_function \
  --description "PAD на БД dbosm, $(date '+%Y-%m-%d %H:%M:%S')"

echo "Готово: https://functions.yandexcloud.net/${FUNCTION_ID}"
