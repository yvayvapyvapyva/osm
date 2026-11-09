#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

ENV_ARGS="--environment TTS_BUCKET=eia-tts"
if [ -n "${TTS_ADMIN_SECRET:-}" ]; then
  ENV_ARGS="$ENV_ARGS --environment TTS_ADMIN_SECRET=$TTS_ADMIN_SECRET"
fi

# shellcheck disable=SC2086
yc serverless function version create \
  --function-id d4e3cj3q3ff36qlrhbg8 \
  --runtime python314 \
  --entrypoint handler.handler \
  --memory 512MB \
  --execution-timeout 300s \
  --service-account-id ajes1766qghjbk20pcjp \
  --source-path "$SCRIPT_DIR" \
  $ENV_ARGS \
  --description "Cache-first navigator TTS in eia-tts"
