# navigatortg2 — навигатор и редактор

Отдельный проект, вынесенный из `navigatortg/`. Здесь тестовые версии
навигатора и редактора на MapLibre; в `navigatortg/` — рабочая версия на
Яндекс.Картах.

## Страницы

- `navigator.html` — навигатор onepage2 на MapLibre + PMTiles.
- `editor.html` — редактор маршрутов на MapLibre.
- `index.html` — редирект на `navigator.html`.
- `instr.html`, `instr_editor.html` — инструкции, подгружаются через `fetch`.
- `assets/` — стили и скрипты проекта. `config.js`, `tts-client.js`,
  `report.js`, `editor.css` скопированы из `navigatortg/`; остальные файлы
  относятся к версии на MapLibre. Правки здесь не влияют на `navigatortg/`.

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
