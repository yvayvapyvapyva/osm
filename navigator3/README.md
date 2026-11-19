# navigator3 — навигатор с Яндекс ID, маршрутами и знаками

`navigator3/` — единственная версия навигатора в репозитории. Старые
`navigator/`, `navigator2/`, `routes.json` и функция `osmn` удалены: новый
клиент работает только через API Gateway и функцию `osmn3`.

Что уже есть:

- вход через Яндекс ID (OAuth + PKCE, сессия в YDB);
- каталог по владельцам: `/api/owners` отдаёт корневые папки и счётчики,
  `/api/catalog?owner=...` — маршруты владельца с геометрией и знаками;
- дерево папок как отдельная сущность в БД;
- все видимые маршруты открыты без входа;
- в публичном меню видимые маршруты сгруппированы по корневой папке владельца;
- редактор маршрутов, папок и личной сцены знаков на `/editor.html`, доступный через Яндекс ID;
- маршруты и папки в редакторе изолированы по владельцу.

Редактор живёт на отдельном домене `https://editor.ainstruktor.ru`, привязанном
к API Gateway: там разрешён `POST`, а cookie и OAuth остаются first-party.
Страница `editor.html` на apex сразу перенаправляет туда: CDN перед публичным
доменом пропускает только `GET`, поэтому сохранять маршруты с apex нельзя.

## Текущий контур

| Что | Значение |
|---|---|
| Бакет | `osmn-nav` (приватный) |
| Домен | `https://ainstruktor.ru` — DNS only в Cloudflare, трафик напрямую в API Gateway (сертификат Yandex Certificate Manager). `www` — через Cloudflare, 301 на apex |
| Домен редактора | `https://editor.ainstruktor.ru` — CNAME на служебный домен API Gateway, сертификат `editor-ainstruktor` |
| Домен шлюза | `https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net` |
| API Gateway | `osmn3` / `d5dsd5u1tsc8fm9dbsg5` |
| Функция | `osmn3` / `d4e8ds1489g0q91dt7do` |
| Сервисный аккаунт шлюза | `osmn3-gateway` / `ajec0sf19r17r3tv6vrg` |
| YDB | `dbosm`, таблицы `users`, `sessions`, `roads`, `folders` |

Redirect URI приложения Яндекс OAuth (должны быть зарегистрированы все):

```
https://ainstruktor.ru/auth/yandex/callback
https://editor.ainstruktor.ru/auth/yandex/callback
https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net/auth/yandex/callback
```

`PUBLIC_BASE_URL` задаёт основной origin (`https://ainstruktor.ru`),
`PUBLIC_ALTERNATE_URLS` — дополнительные через запятую, `PUBLIC_EDITOR_URL` —
домен редактора. Redirect URI и return-адреса строятся от того хоста, с
которого пользователь начал запрос, поэтому вход работает на всех трёх.

У облака квота API Gateway — один домен. Сейчас она занята доменом редактора:
apex и `www` обслуживает CDN и отдельная привязка к шлюзу им не нужна.

## Схема

```
https://<домен-шлюза>/
  /                       → бакет osmn-nav: navigator.html
  /editor.html            → бакет osmn-nav: editor.html
  /admin                  → бакет osmn-nav: admin.html
  /api/health             → функция osmn3
  /api/me                 → функция osmn3
  /api/owners             → функция osmn3 (корневые папки владельцев и счётчики)
  /api/catalog?owner=...  → функция osmn3 (маршруты и знаки владельца)
  /api/catalog?m=...      → функция osmn3 (пакет владельца по маршруту)
  /api/signs?owner=...    → функция osmn3 (только знаки владельца)
  /api/route?m=...        → функция osmn3
  /api/admin?action=...   → функция osmn3
  /auth/yandex/start      → функция osmn3
  /auth/yandex/callback   → функция osmn3
  /auth/logout            → функция osmn3
```

Один origin обязателен: при прямом вызове `functions.yandexcloud.net`
платформа вырезает `Cookie` и `Authorization`. Через API Gateway cookie
доходят до функции, а `osm_sid` становится first-party cookie.

Статика лежит в приватном бакете и отдаётся только через шлюз. Оба файла —
самодостаточные бандлы: CSS, JS и инструкция уже внутри HTML.

## Состав

```
navigator3/
├── navigator.html              # клиент (исходник)
├── editor.html                 # редактор маршрутов и папок (исходник)
├── instr.html                  # инструкция навигатора
├── instr_editor.html           # инструкция редактора
├── assets/
│   ├── css/
│   │   ├── navigator.css
│   │   └── editor.css
│   └── js/
│       ├── menu-module.js      # дерево папок, /api/catalog, /api/route
│       ├── auth-module.js      # вход, /api/me, выход
│       ├── config.js           # палитра и названия категорий
│       ├── map-styles.js
│       └── tts-client.js
├── backend/
│   ├── handler.py              # точка входа: /api, /auth, /api/admin
│   ├── auth.py                 # OAuth, PKCE, cookie, ответы
│   ├── store.py                # users/sessions в YDB
│   └── requirements.txt
├── migrations/
│   ├── add_route_ownership.py  # владельцы routes/folders и индексы
│   ├── add_owner_signs.py      # личная сцена знаков владельца
│   ├── add_activity_log.py     # журнал значимых действий
│   └── drop_road_name.py       # удаление roads.name
├── scripts/
│   └── build-static-deploy.js
├── gateway/osmn.yaml           # спецификация API Gateway
├── deploy.sh                   # деплой функции osmn3
└── deploy-2files/
    ├── navigator.html          # собранный бандл
    ├── editor.html             # собранный бандл
    └── admin.html              # админка (копируется как есть)
```

## Модель данных

### `folders`

```sql
CREATE TABLE folders (
    folder_id     Utf8,
    parent_id     Utf8,        -- "" у корневой папки
    name          Utf8,
    sort_order    Uint32,
    owner_user_id Utf8,
    PRIMARY KEY (folder_id)
);
```

Папка — стабильная сущность: у неё есть `folder_id`, который не меняется при
переименовании. `parent_id` задаёт дерево. `owner_user_id` — `users.user_id`
владельца папки.

### `roads`

К существующим полям добавлены:

```sql
folder_id     Utf8,
title         Utf8,        -- короткое имя внутри папки
owner_user_id Utf8         -- users.user_id владельца маршрута
```

`roads.name` не хранится: короткое название задаёт `title`, папка — `folder_id`.
Полный путь собирается сервером при формировании API-ответа.
Видимость (`visible`) независима от владельца: видимые маршруты по-прежнему
доступны в публичном навигаторе, а редактировать их может только владелец.
Индекс `owner_user_id` используется для выборки своих маршрутов и папок.
В публичном каталоге над папками владельца отображается виртуальная корневая
папка с его `display_name` (если он не задан — с Яндекс login). Она не хранится
в `folders`, поэтому не появляется как редактируемая папка в редакторе.

Маршруты доступны всем без входа. Каталог содержит видимые маршруты вместе
с геометрией открытых маршрутов; закрытые премиум-маршруты приходят без `data`.

`/api/route`:

- 200 + `data` для видимого маршрута;
- 404 для скрытого или несуществующего маршрута.

## API

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/health` | `{"status":"ok"}` |
| GET | `/api/me` | `{"user":{...},"logout_token":"..."}` или 401 |
| GET | `/api/owners` | `{"owners":[{"root_folder_id","name","routes_count","premium_count"}]}` |
| GET | `/api/catalog?owner=<root_folder_id>` | пакет владельца: `folders`, `routes`, `signs`; у открытых маршрутов есть `data` |
| GET | `/api/catalog?m=<m>` | пакет владельца маршрута (для прямых ссылок) |
| GET | `/api/signs?owner=<root_folder_id>` | `{"signs":[...]}` только знаки владельца |
| GET | `/api/route?m=<m>` | маршрут с `data` |
| GET | `/api/route/view?m=...` | отметка загрузки маршрута |
| POST | `/api/admin?action=...` | операции редактора маршрутов и знаков |
| POST | `/api/admin?action=signs_get` | личная сцена знаков текущего владельца |
| POST | `/api/admin?action=signs_save` | сохранить личную сцену знаков |
| GET | `/api/superadmin/activity` | лента значимых действий (только `ADMIN_YANDEX_IDS`) |
| GET | `/auth/telegram?d=<initData>` | вход в Mini App по подписи Telegram |
| GET | `/api/premium/stars/checkout` | счёт Telegram Stars на премиум |
| POST | `/api/telegram/webhook` | вебхук бота: подтверждение и зачисление звёзд |
| GET | `/auth/yandex/start?return=/...&base=https://...` | 302 на Яндекс + state-cookie |
| GET | `/auth/yandex/callback` | 302 обратно + sid-cookie |
| GET | `/auth/logout?t=<token>&return=/...` | 302 обратно + удаление cookie |
| POST | `/auth/logout` | 200 + удаление cookie |

Выход сделан через GET, потому что CDN перед публичным доменом
`ainstruktor.ru` разрешает только `GET`, `HEAD` и `OPTIONS`: запрос `POST`
до функции не доходит. Ссылка на выход подписана HMAC-токеном из `/api/me`
(`logout_token`), чтобы разлогинить пользователя нельзя было переходом с
чужого сайта.

Параметр `base` задаёт origin, на котором закончится вход, и принимается
только из списка `PUBLIC_BASE_URL` + `PUBLIC_ALTERNATE_URLS`. Он нужен
редактору: он открывается на `editor.ainstruktor.ru` (там разрешён
`POST /api/admin`), и `redirect_uri` должен указывать на тот же хост, иначе
state-cookie не совпадёт с callback.

### Редактор

Редактор автоматически проверяет сессию Яндекс ID и перенаправляет гостя на
OAuth-вход. Все действия `/api/admin` требуют активную сессию; сервер выбирает
и изменяет маршруты и папки только с `owner_user_id` текущего пользователя.
Чужие или не принадлежащие никому объекты отвечают `404`. Общего пароля
редактора нет.

| `action` | Назначение |
|---|---|
| `list` | маршруты и папки текущего пользователя |
| `get`, `get_meta` | геометрия и метаданные своего маршрута |
| `save`, `save_meta`, `delete` | создание/изменение и удаление своего маршрута |
| `folder_save`, `folder_delete` | создание/изменение и удаление своей папки |

`save_meta` принимает `{title, folder_id, description, visible}`.
Полный путь `name` в API собирается на сервере из папок и `title`.
`folder_delete` не удаляет папку, если в ней есть вложенные папки или
маршруты (409).

Однократная миграция схемы и назначение текущих данных владельцу:

```bash
set -a
source navigator3/.env
set +a
python3 navigator3/migrations/add_route_ownership.py --owner-login <логин-Яндекса>
```

Скрипт находит существующую учётную запись в `users`, добавляет владельца к
маршрутам и папкам, проверяет назначение и создаёт индексы. Повторный запуск
безопасен, пока данные принадлежат тому же аккаунту.

Чтобы удалить больше не используемый полный путь из схемы `roads`:

```bash
python3 navigator3/migrations/drop_road_name.py
```

## Переменные окружения функции

| Переменная | Обязательна | Назначение |
|---|---|---|
| `YDB_ENDPOINT` | да | `grpcs://ydb.serverless.yandexcloud.net:2135` |
| `YDB_DATABASE` | да | `/ru-central1/.../etnjvaftd6eakeq08kqr` |
| `PUBLIC_BASE_URL` | да | `https://<домен-шлюза>` |
| `PUBLIC_ALTERNATE_URLS` | нет | дополнительные origin'ы через запятую |
| `PUBLIC_EDITOR_URL` | нет | домен редактора, например `https://editor.ainstruktor.ru` |
| `TELEGRAM_BOT_TOKEN` | нет | токен отдельного бота навигатора для Mini App и Stars |
| `TELEGRAM_WEBHOOK_SECRET` | нет | секрет заголовка `X-Telegram-Bot-Api-Secret-Token` |
| `PREMIUM_STARS_PRICE` | нет | цена премиума в звёздах, по умолчанию 300 |
| `YANDEX_CLIENT_ID` | да | ClientID приложения OAuth |
| `SESSION_TTL_DAYS` | нет | срок сессии, по умолчанию 30 |
| `OAUTH_SCOPE` | нет | по умолчанию `login:info login:email` |
| `YANDEX_CLIENT_SECRET` | да | секрет приложения Яндекс OAuth |

Секреты — обычные переменные окружения функции, Lockbox не используется.
`deploy.sh` берёт значения из `navigator3/.env` (он в `.gitignore`) и передаёт
их в `--environment`. Значения видны в `yc serverless function version list`,
поэтому доступ к каталогу Yandex Cloud должен быть ограничен кругом доверенных
людей.

## Порядок запуска

### 1. Секреты

Все секреты — в `navigator3/.env`, который не попадает в git:

```
YANDEX_CLIENT_SECRET=<секрет приложения OAuth>
```

`deploy.sh` передаёт их в переменные окружения функции. Lockbox не
используется: значение видно в `yc serverless function version list`, так что
доступ к каталогу Yandex Cloud должен быть ограничен.

### 2. Функция

```bash
cp navigator3/.env.example navigator3/.env
# заполнить PUBLIC_BASE_URL, YANDEX_CLIENT_ID, YANDEX_CLIENT_SECRET
./navigator3/deploy.sh
```

### 3. Статика

```bash
node navigator3/scripts/build-static-deploy.js
yc storage s3 cp navigator3/deploy-2files/navigator.html \
  s3://osmn-nav/navigator.html --content-type text/html --cache-control no-cache
yc storage s3 cp navigator3/deploy-2files/editor.html \
  s3://osmn-nav/editor.html --content-type text/html --cache-control no-cache
yc storage s3 cp --recursive navigator3/deploy-2files/signs/webp/ \
  s3://osmn-nav/signs/webp/ --content-type image/webp \
  --cache-control "public, max-age=31536000, immutable"
yc storage s3 cp navigator3/deploy-2files/signs/catalog.json \
  s3://osmn-nav/signs/catalog.json --content-type application/json \
  --cache-control "public, max-age=600"
```

## Дорожные знаки

Личные сцены знаков хранятся в таблице `owner_signs` (YDB `dbosm`), по одной
на владельца:

```sql
CREATE TABLE owner_signs (
    owner_user_id Utf8,
    data          Utf8,      -- JSON сцены: camera + markers (kind: znak)
    updated_at    Timestamp,
    PRIMARY KEY (owner_user_id)
);
```

Владелец редактирует знаки в разделе **«Знаки»** редактора `/editor.html`:
каталог, установка на карту, поворот, таблички, ножка. Сохранение — кнопкой
«Сохранить знаки». Доступ к сцене ограничен текущим `owner_user_id`.

При старте навигатор загружает только `/api/owners` — корневые папки и
количество маршрутов. При открытии папки владельца загружается один пакет
`/api/catalog?owner=...`, в котором есть папки, маршруты, геометрия открытых
маршрутов и знаки владельца. Пакет кэшируется в памяти до перезагрузки:
переключение между маршрутами одного владельца не делает новых запросов.

Знаки показываются только после открытия маршрута. При переходе на маршрут
другого владельца старые знаки убираются, загружаются знаки нового владельца.
Прямая ссылка `?m=<маршрут>` работает через `/api/catalog?m=...`.

Картинки знаков берутся из `pad/znaki/webp/`; при сборке они копируются в
`deploy-2files/signs/webp/`, каталог — в `deploy-2files/signs/catalog.json`.
Показ слоя в навигаторе можно отключить в настройках («Знаки»).

## Журнал действий

`activity_log` — отдельный поток значимых событий: вход и выход, открытие
маршрута в навигаторе и редакторе, создание/изменение/удаление маршрутов и
папок, сохранение знаков, оплата и действия админов. Просмотры маршрутов
по-прежнему агрегируются в `route_views`, старые действия админов — в
`admin_audit`; в админке они показываются вместе.

```sql
CREATE TABLE activity_log (
    id           Utf8,
    created_at   Timestamp,
    user_id      Utf8,
    yandex_id    Utf8,
    login        Utf8,
    display_name Utf8,
    action       Utf8,
    source       Utf8,      -- navigator / editor / admin / auth / premium / profile
    entity_type  Utf8,      -- route / folder / signs / payment / user
    entity_id    Utf8,
    route_m      Utf8,
    folder_id    Utf8,
    title        Utf8,
    metadata     Utf8,      -- JSON: количество точек, добавленные знаки, сумма и т.п.
    PRIMARY KEY (id)
);
```

TTL — 180 дней, индекс `activity_created_idx` по `created_at`.
Миграция: `migrations/add_activity_log.py`.

Запись — best-effort: ошибка журнала не ломает сохранение маршрута, знаков
или оплату. Для знаков сравнивается предыдущая и новая сцена, поэтому в
`metadata` попадают `total`, `added`, `removed` и коды добавленных знаков.
Миниатюры маршрутов в списке редактора запрашиваются с `preview=1` и
открытием маршрута не считаются.

`GET /api/superadmin/activity?limit=100&before=<iso>&action=<...>&source=<...>&user_id=<...>`
доступен только аккаунтам из `ADMIN_YANDEX_IDS`. В админке кнопка
«Последние действия» открывает ленту с фильтрами по источнику и типу действия
и кнопкой «Показать ещё».

## Telegram Mini App

Вход в мини-апп идёт по `Telegram.WebApp.initData`:

- `GET /auth/telegram?d=<initData>` проверяет HMAC-подпись токеном бота,
  создаёт/находит аккаунт и ставит обычную сессию `osm_sid`;
- Яндекс и Telegram — две личности одного аккаунта в таблице
  `user_identities`; аккаунты не связываются автоматически;
- в Telegram профиль показывает имя, `@username` и аватар из Telegram;
- премиум в Telegram покупается за звёзды: счёт создаётся через Bot API,
  оплата подтверждается вебхуком `POST /api/telegram/webhook`;
- на сайте остаются Яндекс-вход и Робокасса.

Миграция: `migrations/add_auth_identities.py` создаёт `user_identities`,
добавляет `users.avatar_url`, `payments.stars` и `payments.charge_id`.

Вебхук бота настраивается на служебный домен шлюза (не на apex/CDN, где
разрешён только GET):

```
https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net/api/telegram/webhook
```

## Проверка

На шлюзе:

```bash
curl -i https://<домен>/api/health
curl -i https://<домен>/api/me
curl -i https://<домен>/api/owners
curl -i 'https://<домен>/api/catalog?owner=<root_folder_id>'
curl -i 'https://<домен>/api/catalog?m=<m>'
curl -i 'https://<домен>/api/route?m=<m>'
curl -i -X POST 'https://<домен>/api/admin?action=list' \
  -H 'Cookie: osm_sid=<сессионная-cookie>'
```

Ожидается:

- `/api/owners` — 200, в ответе есть корневые папки и счётчики;
- `/api/catalog?owner=...` — 200, в ответе есть `folders`, `routes`, `signs`;
- `/api/admin?action=signs_get` с сессией — 200 с личной сценой знаков;
- `/api/route?m=<m>` — 200 с `data` для видимого маршрута;
- `/api/admin` без сессии — 401, с сессией Яндекс — список собственных маршрутов;

В браузере:

1. Открыть `https://<домен>/`.
2. Войти через Яндекс в «Настройках».
3. Открыть любую папку и маршрут — доступ не требует входа.
4. Открыть `/editor.html` и войти через Яндекс, если сессии ещё нет.
5. Создать папку и перетащить в неё маршрут.

## Ограничения

- Нет rate limit и ограничения числа активных сессий.
