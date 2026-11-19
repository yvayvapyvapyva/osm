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

API общий — воркер `nav-api-v2` (`https://nav-api-v2.ivan43103.workers.dev`),
данные в D1 `nav-db-v2`. Воркер и база свои, независимые от `navigatortg/`:
исходники воркера лежат в `navigatortg2/cloudflare_worker/` (`api.js`, `lib/`,
`schema.sql`, `wrangler-api.toml`), данные перенесены из `nav-db` копией таблиц
`folders`, `roads`, `purchases`. Таблицы инструкторов удалены — функционал
больше не используется.

### Воркер и база

```bash
cd navigatortg2/cloudflare_worker
npx wrangler d1 execute nav-db-v2 --remote --file=schema.sql --config=wrangler-api.toml
npx wrangler deploy --config=wrangler-api.toml
```

Секреты воркера:

- `EDITOR_ACCESS_KEY` — уже задан, значение хранится локально в
  `navigatortg2/cloudflare_worker/.dev.vars` (файл в `.gitignore`); вход в
  редактор — `/editor?key=<ключ>` или поле «Ключ доступа» вне Telegram;
- `TELEGRAM_TOKEN` — нужен для входа в редактор по подписи Telegram, отчётов и
  оплаты звёздами. Задаётся вручную: `npx wrangler secret put TELEGRAM_TOKEN
  --config=wrangler-api.toml`;
- `TG_SECRET` — секрет вебхука Telegram. У одного бота может быть только один
  вебхук, поэтому тестовый воркер не должен его перехватывать; для независимой
  проверки оплат нужен отдельный тестовый бот.

## Владение маршрутами

Маршруты и папки привязаны к Telegram-аккаунту: в таблицах `roads` и `folders`
есть колонка `owner_tg_id`. В редакторе пользователь видит и меняет только свои
маршруты и папки; публичный каталог по-прежнему показывает все видимые
маршруты.

- Вход в редактор — `Telegram.WebApp.initData` (подпись проверяется токеном
  бота). Подходит любой пользователь Telegram, никаких списков доступа нет.
- Вход по `EDITOR_ACCESS_KEY` из браузера работает от имени `EDITOR_KEY_UID`
  и видит маршруты этого аккаунта. Без `EDITOR_KEY_UID` ключ доступа не даёт.
- Новые маршруты и папки получают `owner_tg_id` текущего пользователя.
- Миграция: `cloudflare_worker/migrations/2026-11-19-route-ownership.sql`
  добавляет колонки и закрепляет существующие данные за `7292595756`.

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
