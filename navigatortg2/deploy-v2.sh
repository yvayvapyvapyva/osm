#!/bin/bash
# Деплой тестовых версий навигатора и редактора (MapLibre) на Cloudflare Pages.
# Публикуется ТОЛЬКО перечисленное ниже (белый список) — новые файлы в
# репозитории (секреты, бэкапы, исходники воркеров) наружу по умолчанию не
# попадают.
# Использование: ./deploy-v2.sh
# Проект можно переопределить: PROJECT_NAME=my-test ./deploy-v2.sh
set -e
cd "$(dirname "$0")"

PROJECT_NAME="${PROJECT_NAME:-avtoinstruktor-v2}"

# Белый список: что уходит на сайт.
SITE_FILES=(
  index.html
  navigator-v3.html
  navigator-test.html
  editor-test.html
  instr.html
  instr_editor.html
  ico.png
  assets
)

STAGE="$(mktemp -d)"
trap "rm -rf $STAGE" EXIT

for f in "${SITE_FILES[@]}"; do
  cp -R "$f" "$STAGE/"
done

# Никакого мусора ОС на публикацию.
find "$STAGE" -name '.DS_Store' -delete

# Версия сборки: подставляется в ссылки на статику, чтобы Telegram WebView
# и браузер не держали старые JS/CSS после деплоя.
BUILD_ID="$(date -u +%Y%m%d%H%M%S)"
python3 - "$STAGE" "$BUILD_ID" <<'PY_VERSION'
import pathlib
import re
import sys

stage = pathlib.Path(sys.argv[1])
build = sys.argv[2]

# Локальные ссылки на статику. Существующий ?v=... заменяем на актуальный.
pattern = re.compile(r'(?P<url>(?:assets/[A-Za-z0-9_./-]+|instr_editor\.html|instr\.html|ico\.png))(?:\?v=[A-Za-z0-9._-]+)?')

for page in sorted(stage.glob('*.html')):
    text = page.read_text(encoding='utf-8')
    updated = pattern.sub(lambda m: m.group('url') + '?v=' + build, text)
    if updated != text:
        page.write_text(updated, encoding='utf-8')

(stage / 'version.json').write_text(
    '{"build":"%s"}\n' % build, encoding='utf-8'
)
PY_VERSION

# Заголовки кэширования для Cloudflare Pages.
cat > "$STAGE/_headers" <<'HEADERS'
/
/index.html
/navigator
/navigator-v3
/navigator-v3.html
/navigator-test
/navigator-test.html
/editor
/editor-test
/editor-test.html
/instr
/instr.html
/instr_editor
/instr_editor.html
/version.json
  Cache-Control: no-store, must-revalidate

/assets/*
  Cache-Control: public, max-age=31536000, immutable
HEADERS

echo "Build: $BUILD_ID"
echo "Project: $PROJECT_NAME"

wrangler pages deploy "$STAGE" --project-name="$PROJECT_NAME" --branch=main
