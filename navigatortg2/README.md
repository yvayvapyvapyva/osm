# navigatortg2 — тестовые версии навигатора и редактора

Отдельный проект тестовой версии Telegram Mini App, вынесенный из
`navigatortg/`. В `navigatortg/` остались только рабочие `navigator.html` и
`editor.html`.

## Страницы

- `navigator-v3.html` — тестовый навигатор onepage2 на MapLibre + PMTiles
  (в рабочей версии — Яндекс.Карты).
- `navigator-test.html` — тестовый навигатор той же логики, что и рабочий, но
  на MapLibre, с автообновлением по `version.json`.
- `editor-test.html` — тестовый редактор на MapLibre.
- `index.html` — редирект на `navigator-v3.html`.
- `instr.html`, `instr_editor.html` — инструкции, подгружаются через `fetch`.
- `assets/` — стили и скрипты. Уникальные для тестовой версии
  (`navigator-test.css`, `navigator-v3.css`, `menu-n3.js`, `tts-n3.js`,
  `onepage-*.js`, `map-shim.js`, `maplibre-gl.*`, `pmtiles.js`,
  `map-styles.js`, `tg-fullscreen.js`) перенесены; общие с рабочей версией
  (`config.js`, `tts-client.js`, `report.js`, `menu-module.js`, `editor.css`)
  скопированы. Копии независимые: правки здесь не влияют на `navigatortg/`.

API общий — воркер `nav-api` (`https://nav-api.ivan43103.workers.dev`, см.
`assets/js/onepage-adapter.js` и `onepage-shop.js`), данные в D1 `nav-db`.

## Деплой

```bash
./navigatortg2/deploy-v2.sh
```

Скрипт публикует проект Cloudflare Pages `avtoinstruktor-v2` (новый домен
`https://avtoinstruktor-v2.pages.dev`), собирает staging по белому списку,
подставляет `?v=<build>` в ссылки на статику и пишет `version.json` (его
использует автообновление мини-аппа). Имя проекта можно переопределить:

```bash
PROJECT_NAME=my-test ./navigatortg2/deploy-v2.sh
```

## Проверка

Страницы рассчитаны на Telegram WebView, но открываются и в браузере. Если
нужен локальный сервер:

```bash
python3 -m http.server 8080 --directory navigatortg2
```
