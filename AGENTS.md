# AGENTS.md — проект osm

## Структура проекта
- `navigator3/` — основная версия с Яндекс ID, API Gateway, YDB.
- `pad/` — разбор дорожных ситуаций.
- `tts/` — озвучка.

## Деплой (справка)
- `navigator3/deploy.sh` — функция `osmn3` (ID `d4e8ds1489g0q91dt7do`), API Gateway `osmn3` (ID `d5dsd5u1tsc8fm9dbsg5`, служебный домен `https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net`), статика в бакет `osmn-nav`.
- Публичные домены `https://ainstruktor.ru` и `https://www.ainstruktor.ru` обслуживает **Yandex CDN**:
  - ресурс `bc8rtmycecb7amyrix2h`;
  - origin — служебный домен API Gateway;
  - сертификат Certificate Manager `fpqp0bmtjpsj89butg6j` (apex + www, managed, автопродление);
  - HTTP→HTTPS редирект на CDN.
- **CDN обязателен и удалять его нельзя**: он проходит в белых списках мобильного интернета РФ. Обходить CDN или включать проксирование Cloudflare для apex не нужно — это возвращает проблему с DPI/ECH.
- У CDN разрешены только `GET`, `HEAD`, `OPTIONS`. **POST включить нельзя.** Следствие:
  - навигатор работает через `https://ainstruktor.ru`;
  - редактор на apex/CDN **не сохраняет**: `POST /api/admin` возвращает `405`. Редактор открывается по служебному домену шлюза: `https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net/editor.html`;
  - `editor.ainstruktor.ru` не настроен; через CDN он всё равно не заработает из-за отсутствия POST.
- API отвечает с `Cache-Control: no-store`, поэтому CDN не кэширует ответы API. Статические JS/CSS в бакете отдаются с `Cache-Control: immutable`; у HTML cache-control отдельно не задан, поэтому после деплоя статики учитывайте возможный кэш CDN.
- DNS в Cloudflare используется только как DNS:
  - `ainstruktor.ru` — A-запись на edge Yandex CDN (`188.72.112.1`);
  - `www.ainstruktor.ru` — CNAME на `9708731cbf7d9658.topology.gslb.yccdn.ru`;
  - `www` обслуживается тем же CDN как secondary hostname, а не редиректом на apex.
- На API Gateway также привязан домен `ainstruktor.ru` с сертификатом `fpqp0bmtjpsj89butg6j`, но публичный трафик apex/www идёт через CDN.
- OAuth: `PUBLIC_BASE_URL=https://ainstruktor.ru`, `PUBLIC_ALTERNATE_URLS=https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net`. Редактор логинится с origin служебного домена шлюза.
- Статика: `node navigator3/scripts/build-static-deploy.js`, затем `yc storage s3 cp --recursive navigator3/deploy-2files/ s3://osmn-nav/`. Внешние `maplibre-gl.js`, `maplibre-gl.css`, `pmtiles.js`, `sortable.min.js` лежат в бакете отдельно и в `deploy-2files/` не попадают — при их обновлении загружать вручную.
- `pad/deploy.sh` — функция `pad-osm` (ID `d4esfoiand5dinv3mfth`).
- `tts/navigator/deploy.sh` — функция TTS (ID `d4e3cj3q3ff36qlrhbg8`).

## Оплата (ЮKassa)
- Разовый платёж на `PREMIUM_DAYS` дней (по умолчанию 30), цена `PREMIUM_PRICE_RUB` (по умолчанию 299 ₽).
- Переменные функции: `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`, `PREMIUM_PRICE_RUB`, `PREMIUM_DAYS`.
- `GET /api/premium/checkout` создаёт платёж через API ЮKassa (`POST /v3/payments`) и возвращает `confirmation_url`. GET, потому что CDN на apex не пропускает POST.
- В кабинете ЮKassa указать HTTP-уведомления (POST, только домен шлюза): `https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net/api/premium/yookassa/webhook`. События: `payment.succeeded`, `payment.canceled`.
- `POST /api/premium/yookassa/webhook` не доверяет телу уведомления: перепроверяет платёж через `GET /v3/payments/{id}`, сверяет сумму и идемпотентно продлевает `users.premium_until`.
- После оплаты ЮKassa возвращает браузер на `https://ainstruktor.ru/navigator.html?payment=success`.
- `GET /api/premium/status` — цена, срок, активность подписки и `payments_available`.
- Тестовый режим: тестовые `YOOKASSA_SHOP_ID` и `YOOKASSA_SECRET_KEY`.
- Миграция: `migrations/add_premium_subscriptions.py` (добавляет `users.premium_until` и таблицу `payments`).
- Страница `/legal.html` генерируется при сборке из `legal.template.html` и переменных `LEGAL_NAME`, `LEGAL_INN`, `LEGAL_EMAIL`, `LEGAL_PHONE`, `LEGAL_TELEGRAM`, `LEGAL_REFUND_TERMS`. Без них будут заглушки «Не указано».

## Команда YC
- `yc` установлен: `/Users/mb/yandex-cloud/bin/yc`
- cloud-id: `b1gtnlal9r2s3rvqadjn`, folder-id: `b1gepvq09nl4oobiemtr`
