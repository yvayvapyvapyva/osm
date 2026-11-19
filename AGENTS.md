# AGENTS.md — проект osm

## Структура проекта
- `navigator3/` — основная версия с Яндекс ID, API Gateway, YDB.
- `pad/` — разбор дорожных ситуаций.
- `tts/` — озвучка.
- `navigatortg/` — рабочая версия (Telegram Mini App, Cloudflare Pages/Worker). Правки рабочей версии ведутся здесь.
- `navigatortg2/` — навигатор и редактор на MapLibre (`navigator.html`, `editor.html`), вынесены из `navigatortg/`. В `navigatortg/` — рабочие `navigator.html` и `editor.html` на Яндекс.Картах.
- Деплой: `navigatortg/deploy-pages.sh` публикует рабочий проект `avtoinstruktor` (`avtoinstruktor.pages.dev`); `navigatortg2/deploy-v2.sh` — тестовый `avtoinstruktor-v2` (`avtoinstruktor-v2.pages.dev`).
- `navigatortg2` использует общую D1 `nav-db` (та же, что у `navigatortg`), поэтому покупки, маршруты и папки общие для обеих версий. Воркер `nav-api-v2` (`https://nav-api-v2.ivan43103.workers.dev`, исходники в `navigatortg2/cloudflare_worker/`) и старый `nav-api` смотрят в одну базу. Старый редактор патчен: новые маршруты и папки получают `DEFAULT_OWNER_TG_ID` и попадают в корневую папку владельца. Тестовая `nav-db-v2` (`437996f6-770b-486d-a534-ae68abe7616a`) осталась от прежнего этапа и не используется.
- `nav-api-v2` авторизует по токену `A152Bot` (секрет `TELEGRAM_TOKEN`, значение хранится в `navigatortg2/.env` как `TELEGRAM_TOKEN_A152BOT`). Вебхук `A152Bot` остаётся на старом `nav-api`, тестовый `@a152testbot` отключён (вебхук удалён). Тестовая версия открывается как Mini App `nav2`: `https://t.me/A152Bot/nav2`.
- Платные папки в навигаторе `navigatortg2` выделяются золотой рамкой; под названием — «★ Премиум N», длинные названия переносятся; в хлебных крошках — звёздочка; после покупки — зелёная строка и «✓ Куплено», маршруты без премиум-бейджей.
- Админы `navigatortg2` (`ADMIN_IDS`) в навигаторе открывают любые маршруты, включая платные папки, без покупки; премиум-маршруты помечаются «★ Премиум» и «Админ». В редакторе админ (`ADMIN_IDS`) переключает владельца во вкладке «Профиль» («Работать от имени»), после чего все действия выполняются от имени выбранного `owner_tg_id`.
- Маршруты и папки в `navigatortg2` привязаны к Telegram ID (`owner_tg_id`): редактор показывает только свои, а владелец открывает свои маршруты без покупки даже в платных папках. Вход — только подпись Telegram (ключей и списков нет). Миграция — `cloudflare_worker/migrations/2026-11-19-route-ownership.sql`.
- Корневая папка владельца в `navigatortg2` — таблица `owner_roots` (одна на `owner_tg_id`); название меняется в редакторе (вкладка «Профиль» → «Корневая папка»), новые папки/маршруты «в корне» попадают в неё. Имя владельца (`owner_roots.owner_name`, подставляется из Telegram, не редактируется; числовой ID вместо имени не показывается) показывается кликабельным бейджем второй строкой под названием корневой папки на «Главной»; по клику открывается окно владельца с аватаром, username, информацией (`owner_info`, по умолчанию @username), кнопкой «Связаться с автором» (ссылка t.me/username) и корневой папкой; Telegram ID не показывается. Аватар и username — `owner_avatar`/`owner_username` из Telegram. Миграции — `2026-11-19-owner-roots.sql`, `2026-11-19-owner-name.sql`, `2026-11-19-owner-profile.sql`, `2026-11-19-owner-info.sql`.
- Редактор `navigatortg2` — порт интерфейса `navigator3` (вкладки, дерево папок, знаки, настройки), но авторизация только Telegram, а API-вызовы идут в `nav-api-v2` (мост `callAdminApi` в `navigatortg2/editor.html`).
- Ссылка «Скопировать ссылку» в редакторе `navigatortg2` ведёт на Mini App `nav2` бота A152Bot (`https://t.me/A152Bot/nav2?startapp=m=<m>`); навигатор читает `Telegram.WebApp.initDataUnsafe.start_param`.
- Отчёты об открытии маршрута из навигатора и редактора `navigatortg2` отправляются так же, как в старой версии: `POST /report` в `nav-api-v2`, чат `REPORT_CHAT_ID = -1003906981409`, ссылка в сообщении ведёт на `nav2`.
- Просмотры маршрутов в `navigatortg2` хранятся в `route_views` (`user_id`, `m`, даты, `view_count`); отметка — `route_view`, флаг `viewed` приходит в `owner_bundle`. Миграция — `2026-11-19-route-views.sql`.
- Знаки в `navigatortg2`: сцена одна на владельца (`owner_signs`, экшены `signs_get`/`signs_save`), редактор — кнопка «Знаки», навигатор получает знаки в `owner_bundle` и показывает слоем MapLibre. Ассеты — `signs/` (из `pad/znaki/`). Миграция — `2026-11-19-owner-signs.sql`.

## Деплой (справка)
- `navigator3/deploy.sh` — функция `osmn3` (ID `d4e8ds1489g0q91dt7do`), API Gateway `osmn3` (ID `d5dsd5u1tsc8fm9dbsg5`, служебный домен `https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net`), статика в бакет `osmn-nav`.
- Публичные домены `https://ainstruktor.ru` и `https://www.ainstruktor.ru` обслуживает **Yandex CDN**:
  - ресурс `bc8rtmycecb7amyrix2h`;
  - origin — служебный домен API Gateway;
  - сертификат Certificate Manager `fpqp0bmtjpsj89butg6j` (apex + www, managed, автопродление);
  - HTTP→HTTPS редирект на CDN.
- **CDN обязателен и удалять его нельзя**: он проходит в белых списках мобильного интернета РФ. Обходить CDN или включать проксирование Cloudflare для apex не нужно — это возвращает проблему с DPI/ECH.
- У CDN разрешены только `GET`, `HEAD`, `OPTIONS`. **POST включить нельзя** (CLI отвечает `method POST management is unavailable`). Следствие:
  - навигатор работает через `https://ainstruktor.ru`;
  - редактор на apex/CDN **не сохраняет**: `POST /api/admin` возвращает `405`;
  - редактор открывается на `https://editor.ainstruktor.ru/editor.html` — домен привязан напрямую к API Gateway (CNAME на служебный домен), без CDN;
  - `editor.html` на apex сам перенаправляет на `editor.ainstruktor.ru`.
- API отвечает с `Cache-Control: no-store`, поэтому CDN не кэширует ответы API. Статические JS/CSS в бакете отдаются с `Cache-Control: immutable`; у HTML cache-control отдельно не задан, поэтому после деплоя статики учитывайте возможный кэш CDN.
- DNS в Cloudflare используется только как DNS:
  - `ainstruktor.ru` — A-запись на edge Yandex CDN (`188.72.112.1`);
  - `www.ainstruktor.ru` — CNAME на `9708731cbf7d9658.topology.gslb.yccdn.ru`;
  - `www` обслуживается тем же CDN как secondary hostname, а не редиректом на apex.
- На API Gateway привязан домен `editor.ainstruktor.ru` с сертификатом `fpqrn7r551s28cds8mir` (`editor-ainstruktor`, managed, автопродление). Квота API Gateway — **один домен на облако**, поэтому `ainstruktor.ru` к шлюзу больше не привязан: apex/www обслуживает CDN, отдельная привязка им не нужна. Смена домена — `yc serverless api-gateway remove-domain` и `add-domain`.
- DNS редактора: `editor.ainstruktor.ru` — CNAME на `d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net`, DNS only (не проксируется Cloudflare).
- OAuth: `PUBLIC_BASE_URL=https://ainstruktor.ru`, `PUBLIC_ALTERNATE_URLS=https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net`, `PUBLIC_EDITOR_URL=https://editor.ainstruktor.ru`. Redirect URI приложения Яндекса: apex, editor и служебный домен шлюза.
- Статика: `node navigator3/scripts/build-static-deploy.js`, затем `yc storage s3 cp --recursive navigator3/deploy-2files/ s3://osmn-nav/`. Внешние `maplibre-gl.js`, `maplibre-gl.css`, `pmtiles.js`, `sortable.min.js` лежат в бакете отдельно и в `deploy-2files/` не попадают — при их обновлении загружать вручную.
- `pad/deploy.sh` — функция `pad-osm` (ID `d4esfoiand5dinv3mfth`).
- Статика PAD: бакет `pad2`, сайт `https://pad2.website.yandexcloud.net/`.
- `tts/navigator/deploy.sh` — функция TTS (ID `d4e3cj3q3ff36qlrhbg8`).

## Оплата (Робокасса)
- Разовый платёж на `PREMIUM_DAYS` дней (по умолчанию 30), цена `PREMIUM_PRICE_RUB` (по умолчанию 299 ₽).
- Переменные функции: `ROBOKASSA_LOGIN`, `ROBOKASSA_PASSWORD1`, `ROBOKASSA_PASSWORD2`, `ROBOKASSA_TEST`, а также `ROBOKASSA_PASSWORD_TEST1`/`ROBOKASSA_PASSWORD_TEST2`.
- `ROBOKASSA_TEST=1` переключает на тестовую пару паролей (если задана) и добавляет в ссылку `IsTest=1`; боевые пароли при этом остаются в `.env` рядом.
- `GET /api/premium/checkout` создаёт числовой `InvId`, пишет платёж в `payments` с `provider=robokassa` и отдаёт ссылку на `https://auth.robokassa.ru/Merchant/Index.aspx`. GET, потому что CDN на apex не пропускает POST.
- Подпись ссылки: MD5 `MerchantLogin:OutSum:InvId:Пароль#1`.
- URL в кабинете Робокассы должны быть без параметров, иначе GET не примет.
- Схема у нас GET, поэтому все три адреса — на основном домене через CDN: `https://ainstruktor.ru/api/premium/robokassa/{result,success,fail}`. Домен шлюза нужен только для POST.
- ResultURL: подпись MD5 `OutSum:InvId:Пароль#2`, ответ `OK<InvId>`. Обработчик принимает и GET, и POST.
- SuccessURL → редирект на `https://ainstruktor.ru/navigator.html?payment=success`.
- FailURL → помечает платёж отменённым и редиректит на `...?payment=fail`.
- `GET /api/premium/status` — цена, срок, активность подписки, `payments_available` и список `providers`.
- Миграция: `migrations/add_premium_subscriptions.py` (добавляет `users.premium_until` и таблицу `payments`).
- Страница `/legal.html` генерируется при сборке из `legal.template.html` и переменных `LEGAL_NAME`, `LEGAL_INN`, `LEGAL_EMAIL`, `LEGAL_PHONE`, `LEGAL_TELEGRAM`. Без них будут заглушки «Не указано».

## Админка
- Страница: `/admin` на служебном домене шлюза (`https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net/admin`). Через apex/CDN не работает: CDN пропускает только GET, а действиям нужен POST.
- Доступ: обычная сессия Яндекс ID, чей `yandex_id` перечислен в `ADMIN_YANDEX_IDS` (через пробел). Отзыв доступа — убрать ID и передеплоить функцию.
- API: `GET /api/superadmin/users`, `GET /api/superadmin/user`, `POST /api/superadmin/premium`, `POST /api/superadmin/block`, `POST /api/superadmin/sessions/revoke`, `GET /api/superadmin/audit`.
- Действия: выдать/продлить/снять премиум, блокировка (с завершением сессий), завершение всех сессий.
- Аудит: таблица `admin_audit`, миграция `migrations/add_admin_audit.py`. Пишутся админ, действие, пользователь и параметры.
- `admin.html` собирается копированием из `navigator3/admin.html` в `deploy-2files` (без бандла).

## История загрузок маршрутов
- Таблица `route_views` (`user_id`, `m`, `first_viewed_at`, `last_viewed_at`, `view_count`), миграция `migrations/add_route_views.py`.
- `GET /api/route/view?m=<маршрут>` отмечает загрузку; GET, потому что CDN на apex не пропускает POST.
- `/api/catalog` возвращает `viewed` для каждого маршрута; в меню показывается бейдж «Просмотрен».
- В карточке пользователя админки отдаётся список `views` с датами и количеством загрузок.

## Имя аккаунта и папка маршрутов
- `users.display_name` — имя из Яндекс-профиля, в редакторе не меняется.
- `users.routes_folder_name` — отдельное название корневой папки владельца в каталоге; пустое значение означает fallback на `display_name`/`login`.
- `POST /api/profile` с `{folder_name}` меняет только название папки; без поля `folder_name` запрос отклоняется.
- Миграция: `migrations/add_routes_folder_name.py`.

## Команда YC
- `yc` установлен: `/Users/mb/yandex-cloud/bin/yc`
- cloud-id: `b1gtnlal9r2s3rvqadjn`, folder-id: `b1gepvq09nl4oobiemtr`
