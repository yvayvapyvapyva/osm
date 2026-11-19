#!/usr/bin/env bash
# Деплой версии navigator3 с идентификацией через Яндекс OAuth.
#
# Создаёт или обновляет функцию osmn3, которую использует шлюз osmn3.
# Другие функции в проекте не меняются.
#
# Обязательные переменные:
#   PUBLIC_BASE_URL       — https://<домен-шлюза>
#   YANDEX_CLIENT_ID      — ClientID приложения Яндекс OAuth
#   YANDEX_CLIENT_SECRET  — секрет приложения Яндекс OAuth
#
# Необязательные:
#   FUNCTION_NAME         — по умолчанию osmn3
#   FUNCTION_ID           — если функция уже создана
#   SERVICE_ACCOUNT_ID    — по умолчанию servaccsunt
#
# Секреты передаются обычными переменными окружения функции, без Lockbox.
# Значения видны в `yc serverless function version list`, поэтому доступ к
# каталогу Yandex Cloud должен быть ограничен кругом доверенных людей.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Удобно для локального запуска: .env не попадает в git.
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${SCRIPT_DIR}/.env"
  set +a
fi

FUNCTION_NAME="${FUNCTION_NAME:-osmn3}"
FUNCTION_ID="${FUNCTION_ID:-}"
DATABASE="${YDB_DATABASE:-/ru-central1/b1gtnlal9r2s3rvqadjn/etnjvaftd6eakeq08kqr}"
ENDPOINT="${YDB_ENDPOINT:-grpcs://ydb.serverless.yandexcloud.net:2135}"
SERVICE_ACCOUNT_ID="${SERVICE_ACCOUNT_ID:-aje0hrd823msk3hqaikt}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
PUBLIC_ALTERNATE_URLS="${PUBLIC_ALTERNATE_URLS:-}"
PUBLIC_EDITOR_URL="${PUBLIC_EDITOR_URL:-}"
YANDEX_CLIENT_ID="${YANDEX_CLIENT_ID:-}"
YANDEX_CLIENT_SECRET="${YANDEX_CLIENT_SECRET:-9418164755114b98b225e0e545629e79}"
SESSION_TTL_DAYS="${SESSION_TTL_DAYS:-30}"
ROBOKASSA_LOGIN="${ROBOKASSA_LOGIN:-}"
ROBOKASSA_PASSWORD1="${ROBOKASSA_PASSWORD1:-}"
ROBOKASSA_PASSWORD2="${ROBOKASSA_PASSWORD2:-}"
ROBOKASSA_PASSWORD_TEST1="${ROBOKASSA_PASSWORD_TEST1:-}"
ROBOKASSA_PASSWORD_TEST2="${ROBOKASSA_PASSWORD_TEST2:-}"
ROBOKASSA_TEST="${ROBOKASSA_TEST:-0}"
PREMIUM_PRICE_RUB="${PREMIUM_PRICE_RUB:-299}"
PREMIUM_DAYS="${PREMIUM_DAYS:-30}"
PREMIUM_STARS_PRICE="${PREMIUM_STARS_PRICE:-300}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_WEBHOOK_SECRET="${TELEGRAM_WEBHOOK_SECRET:-}"
ADMIN_YANDEX_IDS="${ADMIN_YANDEX_IDS:-}"

cd "${SCRIPT_DIR}"

if [[ -z "${PUBLIC_BASE_URL}" ]]; then
  echo "Задайте PUBLIC_BASE_URL, например https://d5d....apigw.yandexcloud.net" >&2
  exit 1
fi

if [[ -z "${YANDEX_CLIENT_ID}" ]]; then
  echo "Задайте YANDEX_CLIENT_ID из приложения Яндекс OAuth." >&2
  exit 1
fi

if [[ -z "${YANDEX_CLIENT_SECRET}" ]]; then
  echo "Задайте YANDEX_CLIENT_SECRET." >&2
  exit 1
fi

if [[ -z "${FUNCTION_ID}" ]]; then
  if ! yc serverless function get --name "${FUNCTION_NAME}" >/dev/null 2>&1; then
    echo "Создаю функцию ${FUNCTION_NAME}"
    yc serverless function create \
      --name "${FUNCTION_NAME}" \
      --description "OSM navigator with Yandex OAuth (navigator3)"
  fi
  FUNCTION_ID="$(yc serverless function get --name "${FUNCTION_NAME}" --format json \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])')"
fi

echo "Деплой функции ${FUNCTION_NAME} (${FUNCTION_ID})"
echo "База: ${DATABASE}"
echo "Публичный адрес: ${PUBLIC_BASE_URL}"

ENVIRONMENT="YDB_ENDPOINT=${ENDPOINT},YDB_DATABASE=${DATABASE},PUBLIC_BASE_URL=${PUBLIC_BASE_URL},YANDEX_CLIENT_ID=${YANDEX_CLIENT_ID},YANDEX_CLIENT_SECRET=${YANDEX_CLIENT_SECRET},SESSION_TTL_DAYS=${SESSION_TTL_DAYS},PREMIUM_STARS_PRICE=${PREMIUM_STARS_PRICE}"

if [[ -n "${TELEGRAM_BOT_TOKEN}" ]]; then
  ENVIRONMENT="${ENVIRONMENT},TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}"
fi

if [[ -n "${TELEGRAM_WEBHOOK_SECRET}" ]]; then
  ENVIRONMENT="${ENVIRONMENT},TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET}"
fi

PREMIUM_ENV="PREMIUM_PRICE_RUB=${PREMIUM_PRICE_RUB},PREMIUM_DAYS=${PREMIUM_DAYS},ADMIN_YANDEX_IDS=${ADMIN_YANDEX_IDS}"
if [[ -n "${ROBOKASSA_LOGIN}" ]]; then
  PREMIUM_ENV="ROBOKASSA_LOGIN=${ROBOKASSA_LOGIN},ROBOKASSA_PASSWORD1=${ROBOKASSA_PASSWORD1},ROBOKASSA_PASSWORD2=${ROBOKASSA_PASSWORD2},ROBOKASSA_PASSWORD_TEST1=${ROBOKASSA_PASSWORD_TEST1},ROBOKASSA_PASSWORD_TEST2=${ROBOKASSA_PASSWORD_TEST2},ROBOKASSA_TEST=${ROBOKASSA_TEST},${PREMIUM_ENV}"
fi
ENVIRONMENT="${ENVIRONMENT},${PREMIUM_ENV}"

if [[ -n "${PUBLIC_ALTERNATE_URLS}" ]]; then
  ENVIRONMENT="${ENVIRONMENT},PUBLIC_ALTERNATE_URLS=${PUBLIC_ALTERNATE_URLS}"
fi

if [[ -n "${PUBLIC_EDITOR_URL}" ]]; then
  ENVIRONMENT="${ENVIRONMENT},PUBLIC_EDITOR_URL=${PUBLIC_EDITOR_URL}"
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
  --description "navigator3 auth $(date '+%Y-%m-%d %H:%M:%S')" \
  >/dev/null

echo "Готово. Проверьте: https://functions.yandexcloud.net/${FUNCTION_ID}"
