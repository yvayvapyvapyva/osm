#!/bin/bash
# Деплой веб-версии navigatortg2: только навигатор, вход по email и документы.
# Редактор, Telegram-специфика и Stars сюда не входят.
#
# Использование:
#   ./deploy-web.sh
#   PROJECT_NAME=my-web ./deploy-web.sh
set -euo pipefail
cd "$(dirname "$0")"

PROJECT_NAME="${PROJECT_NAME:-avtoinstruktor-web}"
SOURCE_DIR="${SOURCE_DIR:-../navigatortg2}"

STAGE="$(mktemp -d)"
trap "rm -rf $STAGE" EXIT

# Свои страницы веб-версии.
cp -R index.html account.html legal assets functions _headers _redirects "$STAGE"/

# Навигатор и общие ассеты берём из navigatortg2, чтобы не поддерживать копию.
cp "$SOURCE_DIR/navigator.html" "$STAGE/navigator.html"
cp -R "$SOURCE_DIR/assets" "$STAGE/assets-src"
cp -R "$SOURCE_DIR/signs" "$STAGE/signs"

# Совмещаем ассеты: свои web.css и функции не должны потеряться.
cp -R "$STAGE/assets-src/." "$STAGE/assets/"
rm -rf "$STAGE/assets-src"

# В веб-версии API идёт через тот же origin (/api), поэтому cookie сессии
# остаются на домене pages.dev. Ссылки на воркер встречаются в config.js,
# onepage-adapter.js, onepage-shop.js и внутри navigator.html.
python3 - "$STAGE" <<'PY'
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
for path in list(root.glob('*.html')) + list((root / 'assets' / 'js').glob('*.js')):
    text = path.read_text(encoding='utf-8')
    updated = text.replace('https://nav-api-v2.ivan43103.workers.dev', '/api')
    updated = updated.replace("APP_URL: 'https://avtoinstruktor-v2.pages.dev'", "APP_URL: 'https://avtoinstruktor-web.pages.dev'")
    if updated != text:
        path.write_text(updated, encoding='utf-8')
        print('web api:', path.name)
PY

# Ссылка на кабинет внутри навигатора.
python3 - "$STAGE/navigator.html" <<'PY'
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding='utf-8')
if '/assets/web-nav.js' not in text:
    text = text.replace('</body>', '<script src="/assets/web-nav.js"></script>\n</body>', 1)
path.write_text(text, encoding='utf-8')
PY

find "$STAGE" -name '.DS_Store' -delete

echo "Web deploy: $PROJECT_NAME"
wrangler pages deploy "$STAGE" --project-name="$PROJECT_NAME" --branch="${BRANCH:-main}"
