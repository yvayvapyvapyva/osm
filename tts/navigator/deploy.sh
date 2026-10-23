#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

yc serverless function version create \
  --function-id d4e3cj3q3ff36qlrhbg8 \
  --runtime python314 \
  --entrypoint handler.handler \
  --memory 512MB \
  --execution-timeout 300s \
  --service-account-id ajes1766qghjbk20pcjp \
  --source-path "$SCRIPT_DIR" \
  --environment TTS_BUCKET=eia-tts \
  --description "Cache-first navigator TTS in eia-tts"
