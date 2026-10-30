#!/usr/bin/env bash
# Деплой версии navigator3 с идентификацией через Яндекс OAuth.
#
# Создаёт или обновляет функцию osmn3, которую использует шлюз osmn3.
# Другие функции в проекте не меняются.
#
# Обязательные переменные:
#   PUBLIC_BASE_URL       — https://<домен-шлюза>
#   YANDEX_CLIENT_ID      — ClientID приложения Яндекс OAuth
#   LOCKBOX_SECRET_ID     — id секрета Lockbox с ключами:
#                           YANDEX_CLIENT_SECRET и ROUTE_ADMIN_PASSWORD
#
# Необязательные:
#   FUNCTION_NAME         — по умолчанию osmn3
#   FUNCTION_ID           — если функция уже создана
#   SERVICE_ACCOUNT_ID    — по умолчанию servaccsunt
#   YOOKASSA_SHOP_ID      — shopId ЮKassa; если задан, подключится секрет
#                           YOOKASSA_SECRET_KEY из Lockbox
#
# Пароль редактора, client secret и секрет ЮKassa не передаются через
# environment: только через Lockbox, чтобы значения не попадали в вывод `yc`
# и в историю команд.
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
YANDEX_CLIENT_ID="${YANDEX_CLIENT_ID:-}"
LOCKBOX_SECRET_ID="${LOCKBOX_SECRET_ID:-}"
SESSION_TTL_DAYS="${SESSION_TTL_DAYS:-30}"
YOOKASSA_SHOP_ID="${YOOKASSA_SHOP_ID:-}"

cd "${SCRIPT_DIR}"

if [[ -z "${PUBLIC_BASE_URL}" ]]; then
  echo "Задайте PUBLIC_BASE_URL, например https://d5d....apigw.yandexcloud.net" >&2
  exit 1
fi

if [[ -z "${YANDEX_CLIENT_ID}" ]]; then
  echo "Задайте YANDEX_CLIENT_ID из приложения Яндекс OAuth." >&2
  exit 1
fi

if [[ -z "${LOCKBOX_SECRET_ID}" ]]; then
  echo "Задайте LOCKBOX_SECRET_ID: в секрете должны быть ключи YANDEX_CLIENT_SECRET и ROUTE_ADMIN_PASSWORD." >&2
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

ENVIRONMENT="YDB_ENDPOINT=${ENDPOINT},YDB_DATABASE=${DATABASE},PUBLIC_BASE_URL=${PUBLIC_BASE_URL},YANDEX_CLIENT_ID=${YANDEX_CLIENT_ID},SESSION_TTL_DAYS=${SESSION_TTL_DAYS}"

# Пустое значение переменной окружения платформа не принимает: добавляем
# YOOKASSA_SHOP_ID только когда оплата действительно настроена.
if [[ -n "${YOOKASSA_SHOP_ID}" ]]; then
  ENVIRONMENT="${ENVIRONMENT},YOOKASSA_SHOP_ID=${YOOKASSA_SHOP_ID}"
fi

SECRET_ARGS=(
  --secret "id=${LOCKBOX_SECRET_ID},key=YANDEX_CLIENT_SECRET,environment-variable=YANDEX_CLIENT_SECRET"
  --secret "id=${LOCKBOX_SECRET_ID},key=ROUTE_ADMIN_PASSWORD,environment-variable=ROUTE_ADMIN_PASSWORD"
)

if [[ -n "${YOOKASSA_SHOP_ID}" ]]; then
  SECRET_ARGS+=(
    --secret "id=${LOCKBOX_SECRET_ID},key=YOOKASSA_SECRET_KEY,environment-variable=YOOKASSA_SECRET_KEY"
  )
fi

yc serverless function version create \
  --function-id "${FUNCTION_ID}" \
  --runtime python314 \
  --entrypoint handler.handler \
  --memory 256MB \
  --execution-timeout 20s \
  --service-account-id "${SERVICE_ACCOUNT_ID}" \
  --environment "${ENVIRONMENT}" \
  "${SECRET_ARGS[@]}" \
  --source-path backend \
  --description "navigator3 auth $(date '+%Y-%m-%d %H:%M:%S')"

echo "Готово. Проверьте: https://functions.yandexcloud.net/${FUNCTION_ID}"
