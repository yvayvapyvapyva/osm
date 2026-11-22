#!/usr/bin/env bash
# Деплой PAD-бэкенда в отдельную Яндекс.Облако функцию.
# Использует базу данных OSM-проекта (dbosm), таблица сцен — scene.
# Для операций изменения нужен пароль администратора из SCENE_ADMIN_PASSWORD.
set -euo pipefail

FUNCTION_ID="${FUNCTION_ID:-d4esfoiand5dinv3mfth}"
FUNCTION_NAME="${FUNCTION_NAME:-pad-osm}"
DATABASE="${YDB_DATABASE:-/ru-central1/b1gtnlal9r2s3rvqadjn/etnjvaftd6eakeq08kqr}"
ENDPOINT="${YDB_ENDPOINT:-grpcs://ydb.serverless.yandexcloud.net:2135}"
SERVICE_ACCOUNT_ID="${SERVICE_ACCOUNT_ID:-aje0hrd823msk3hqaikt}"
SCENE_ADMIN_PASSWORD="${SCENE_ADMIN_PASSWORD:-}"
SIGNS_OWNER_LOGIN="${SIGNS_OWNER_LOGIN:-eliseev88888}"
SIGNS_OWNER_USER_ID="${SIGNS_OWNER_USER_ID:-}"

cd "$(dirname "$0")"

if [[ -z "${SCENE_ADMIN_PASSWORD}" ]]; then
  echo "Задайте SCENE_ADMIN_PASSWORD перед деплоем; пароль не сохраняется в репозитории." >&2
  exit 1
fi

rm -rf yandex_cloud_function/__pycache__

PAD_ENVIRONMENT="YDB_ENDPOINT=${ENDPOINT},YDB_DATABASE=${DATABASE},SCENE_ADMIN_PASSWORD=${SCENE_ADMIN_PASSWORD}"
if [[ -n "${SIGNS_OWNER_LOGIN}" ]]; then
  PAD_ENVIRONMENT="${PAD_ENVIRONMENT},SIGNS_OWNER_LOGIN=${SIGNS_OWNER_LOGIN}"
fi
if [[ -n "${SIGNS_OWNER_USER_ID}" ]]; then
  PAD_ENVIRONMENT="${PAD_ENVIRONMENT},SIGNS_OWNER_USER_ID=${SIGNS_OWNER_USER_ID}"
fi

echo "Деплой PAD-функции ${FUNCTION_NAME} (${FUNCTION_ID})"
echo "База OSM: ${DATABASE}"
echo "Слой знаков: ${SIGNS_OWNER_LOGIN:-${SIGNS_OWNER_USER_ID}}"

yc serverless function version create \
  --function-id "${FUNCTION_ID}" \
  --runtime python314 \
  --entrypoint index.handler \
  --memory 256MB \
  --execution-timeout 30s \
  --service-account-id "${SERVICE_ACCOUNT_ID}" \
  --environment "${PAD_ENVIRONMENT}" \
  --source-path yandex_cloud_function \
  --description "PAD на БД dbosm без аккаунтов, $(date '+%Y-%m-%d %H:%M:%S')"

echo "Готово: https://functions.yandexcloud.net/${FUNCTION_ID}"
