# navigatortg2-web

Веб-версия навигатора: только просмотр маршрутов, вход по email и личный кабинет.
Редактор, Telegram Mini App и Stars сюда не входят.

## Архитектура

- Статика и страницы — Cloudflare Pages, проект `avtoinstruktor-web`.
- API — тот же воркер `nav-api-v2`, база — общая D1 `nav-db`.
- `/api/*` проксируется через Pages Function, поэтому cookie сессии остаются
  на домене сайта (`*.pages.dev`).
- Веб-покупатели — отдельные аккаунты (`web_accounts`), не связанные с Telegram.
- Оплата на сайте пока не подключена. Заложены поля `purchases.account_id` и
  `purchases.provider`, чтобы позже подключить выбранный платёжный сервис.

## Страницы

- `/` — лендинг и вход по email.
- `/account.html` — email, купленные папки, выход.
- `/navigator.html` — навигатор (копия из `../navigatortg2`).
- `/legal/offer.html` — оферта.
- `/legal/privacy.html` — политика конфиденциальности.
- `/legal/refund.html` — условия возврата.

Перед публикацией заполните в документах поля `[ФИО]`, `[ИНН]`, `[EMAIL]`.

## Вход по email

1. Пользователь вводит email и подтверждает согласие.
2. `POST /api/auth/email/request` создаёт одноразовый токен (15 минут) и шлёт письмо.
3. Ссылка ведёт на `/api/auth/email/verify?token=...`.
4. Воркер создаёт/находит аккаунт, ставит cookie `nav_web_session` на 30 дней.
5. Редирект в `/account.html`.

Токен хранится только в виде SHA-256. Сессии можно отзывать.

## Отправка писем

Поддерживаются два варианта, выбор по наличию настроек:

### Resend

Впишите ключ в `navigatortg2-web/.env`:

```dotenv
RESEND_API_KEY=re_...
WEB_EMAIL_FROM=navigator@mail.ainstruktor.ru
```

Файл `.env` в `.gitignore`. Затем загрузите ключ в секреты воркера:

```bash
./navigatortg2-web/set-resend-secret.sh
```

Или вручную:

```bash
npx wrangler secret put RESEND_API_KEY --config=navigatortg2/cloudflare_worker/wrangler-api.toml
```

В `wrangler-api.toml` отправитель уже указан:
`WEB_EMAIL_FROM = "navigator@mail.ainstruktor.ru"`.

### Cloudflare Email Service

Включите Email Sending для домена в панели Cloudflare, добавьте binding:

```toml
[[send_email]]
name = "EMAIL"
```

и задайте `WEB_EMAIL_FROM` на этом домене. После деплоя воркер будет
использовать `env.EMAIL.send()`.

Пока ни один вариант не настроен, `POST /auth/email/request` отвечает
`503 email_not_configured`.

## Деплой

```bash
./navigatortg2-web/deploy-web.sh
```

Скрипт:

- копирует страницы веб-версии и юридические документы;
- берёт `navigator.html`, `assets` и `signs` из `../navigatortg2`;
- подменяет `API_BASE` на `/api`;
- добавляет ссылку «Аккаунт» в навигатор;
- публикует проект `avtoinstruktor-web`.

Переопределить проект:

```bash
PROJECT_NAME=my-web ./navigatortg2-web/deploy-web.sh
```

## Turnstile

Воркер поддерживает проверку Turnstile, если задан секрет `TURNSTILE_SECRET`.
Сейчас на странице входа виджета нет: перед включением секрета добавьте виджет
и передавайте `turnstile_token` в запросе.

## Что дальше

- Подключить платёжный сервис на веб-домене (только вне Telegram).
- Добавить `folders.price_rub` и веб-чекаут.
- Связать email и Telegram, если понадобится перенос покупок.
