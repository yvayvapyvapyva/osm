# navigator3 — навигатор с Яндекс ID и платными папками маршрутов

`navigator3/` — единственная версия навигатора в репозитории. Старые
`navigator/`, `navigator2/`, `routes.json` и функция `osmn` удалены: новый
клиент работает только через API Gateway и функцию `osmn3`.

Что уже есть:

- вход через Яндекс ID (OAuth + PKCE, сессия в YDB);
- каталог без геометрии: `/api/catalog`, точки — только по запросу
  `/api/route?m=...`;
- дерево папок как отдельная сущность в БД;
- платный доступ к папке: покупка открывает саму папку, все вложенные папки и
  маршруты;
- оплата через ЮKassa (`/api/orders`, webhook `/api/yookassa/notify`);
- редактор маршрутов и папок на `/editor.html`.

## Текущий контур

| Что | Значение |
|---|---|
| Бакет | `osmn-nav` (приватный) |
| Домен | `https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net` |
| API Gateway | `osmn3` / `d5dsd5u1tsc8fm9dbsg5` |
| Функция | `osmn3` / `d4e8ds1489g0q91dt7do` |
| Сервисный аккаунт шлюза | `osmn3-gateway` / `ajec0sf19r17r3tv6vrg` |
| YDB | `dbosm`, таблицы `users`, `sessions`, `roads`, `folders`, `entitlements`, `orders` |
| Lockbox | `osmn3-oauth` / `e6q97rh5hpfelika4qjl` |

Redirect URI приложения Яндекс OAuth:

```
https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net/auth/yandex/callback
```

## Схема

```
https://<домен-шлюза>/
  /                       → бакет osmn-nav: navigator.html
  /editor.html            → бакет osmn-nav: editor.html
  /api/health             → функция osmn3
  /api/me                 → функция osmn3
  /api/catalog            → функция osmn3
  /api/route?m=...        → функция osmn3
  /api/orders             → функция osmn3
  /api/yookassa/notify    → функция osmn3
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
│       ├── menu-module.js      # дерево папок, /api/catalog, /api/route, покупка
│       ├── auth-module.js      # вход, /api/me, выход
│       ├── config.js           # палитра и названия категорий
│       ├── report.js           # отчёт о маршруте в Telegram
│       ├── map-styles.js
│       └── tts-client.js
├── backend/
│   ├── handler.py              # точка входа: /api, /auth, /api/admin
│   ├── auth.py                 # OAuth, PKCE, cookie, ответы
│   ├── store.py                # users/sessions в YDB
│   ├── payments.py             # клиент ЮKassa
│   └── requirements.txt
├── scripts/
│   ├── init_auth_db.py         # создание users и sessions
│   ├── init_folders.py         # folders, entitlements, orders + миграция roads
│   ├── init_db.py              # первичный перенос маршрутов (архив)
│   ├── test_auth.py            # локальные проверки входа
│   ├── test_catalog.py         # локальные проверки каталога и доступа
│   ├── test_admin.py           # локальные проверки редактора
│   ├── test_payments.py        # локальные проверки заказов и webhook
│   └── build-static-deploy.js
├── gateway/osmn.yaml           # спецификация API Gateway
├── deploy.sh                   # деплой функции osmn3
└── deploy-2files/
    ├── navigator.html          # собранный бандл
    └── editor.html             # собранный бандл
```

## Модель данных

### `folders`

```sql
CREATE TABLE folders (
    folder_id     Utf8,
    parent_id     Utf8,        -- "" у корневой папки
    name          Utf8,
    access        Utf8,        -- public | paid
    price_kopecks Uint64,
    sku           Utf8,
    sort_order    Uint32,
    PRIMARY KEY (folder_id)
);
```

Папка — стабильная сущность: у неё есть `folder_id`, который не меняется при
переименовании. `parent_id` задаёт дерево. Цена хранится в копейках.

### `roads`

К существующим полям добавлены:

```sql
folder_id     Utf8,
title         Utf8,        -- короткое имя внутри папки
access        Utf8,        -- public | folder
price_kopecks Uint64,      -- резерв, сейчас цена берётся у папки
sku           Utf8
```

`roads.name` остаётся полным путём (`МЕЩЕРА/Экзамен/Экз. Мещера-1`) и
пересчитывается сервером при сохранении метаданных. Новый код использует
`folder_id` + `title`; полный путь нужен для совместимости с TTS и отчётами.

`access = public` у маршрута означает «открыт всегда», даже внутри платной
папки. `access = folder` (по умолчанию) наследует доступ папки.

### `entitlements`

```sql
CREATE TABLE entitlements (
    user_id     Utf8,
    entitlement Utf8,        -- "folder:<folder_id>" или "all"
    created_at  Timestamp,
    source      Utf8,        -- yookassa | manual
    order_id    Utf8,
    PRIMARY KEY (user_id, entitlement)
);
```

Право на родительскую папку открывает все вложенные папки и маршруты.
`all` открывает весь каталог.

### `orders`

```sql
CREATE TABLE orders (
    order_id       Utf8,
    user_id        Utf8,
    folder_id      Utf8,
    amount_kopecks Uint64,
    status         Utf8,      -- pending | paid | canceled | failed
    created_at     Timestamp,
    updated_at     Timestamp,
    payment_id     Utf8,
    return_path    Utf8,
    PRIMARY KEY (order_id)
);
```

## Как считается доступ

Только на сервере. Клиент не решает, можно ли открыть маршрут.

1. Для папки строится цепочка от корня до неё.
2. Если в цепочке нет платных папок — доступ публичный.
3. Если платная папка есть, берётся первая (ближайшая к корню) платная папка:
   её и нужно купить.
4. `owned = true`, если у пользователя есть `all` или
   `folder:<любая папка из цепочки>`.

`/api/catalog` отдаёт для каждой папки и маршрута `access`, `owned`,
`purchase_folder_id`, `price_kopecks`, `sku`. Геометрия в каталог не входит.

`/api/route`:

- 200 + `data`, если доступ есть;
- 401 `unauthorized` + `purchase_folder_id`, если пользователь не вошёл;
- 402 `payment_required` + `purchase_folder_id`, если вошёл, но не купил;
- 404 для скрытого или несуществующего маршрута.

## API

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/health` | `{"status":"ok"}` |
| GET | `/api/me` | `{"user":{...},"entitlements":[...]}` или 401 |
| GET | `/api/catalog` | `{"folders":[...],"routes":[...],"user":...}` без геометрии |
| GET | `/api/route?m=<m>` | маршрут с `data`; 401/402 без доступа |
| POST | `/api/orders` | `{"order_id","payment_id","confirmation_url"}` |
| POST | `/api/yookassa/notify` | webhook ЮKassa |
| POST | `/api/admin?action=...` | операции редактора |
| GET | `/auth/yandex/start?return=/...` | 302 на Яндекс + state-cookie |
| GET | `/auth/yandex/callback` | 302 обратно + sid-cookie |
| POST | `/auth/logout` | 200 + удаление cookie |

### Редактор

Все действия `/api/admin` требуют заголовок `X-Route-Admin-Password`, включая
чтение: иначе `action=list` отдавал бы скрытые маршруты в обход
`visible = true`. Пароль хранится только в Lockbox.

| `action` | Назначение |
|---|---|
| `auth` | проверка пароля |
| `list` | все маршруты и папки |
| `get`, `get_meta` | геометрия и метаданные маршрута |
| `save`, `save_meta`, `delete` | изменение маршрута |
| `folder_save`, `folder_delete` | создание/изменение и удаление папки |
| `grant`, `revoke` | выдать/забрать право вручную |
| `entitlements` | права пользователя |
| `users` | список пользователей |
| `orders` | последние 200 заказов |

`save_meta` принимает `{title, folder_id, description, visible, access}`.
Полный `name` собирается на сервере. `folder_delete` не удаляет папку, если в
ней есть вложенные папки или маршруты (409).

## Оплата

Поток:

```
браузер → POST /api/orders {folder_id, return}
        → заказ pending в orders
        → POST https://api.yookassa.ru/v3/payments
        → 200 {confirmation_url}
браузер → confirmation_url → оплата
ЮKassa  → POST /api/yookassa/notify
        → GET /v3/payments/<id> (проверка суммы и статуса)
        → orders.status = paid
        → entitlements UPSERT folder:<folder_id>
браузер → return_path?payment=success → каталог перезагружается
```

Вебхук не доверяет телу запроса: сумма и статус перепроверяются запросом в
ЮKassa. Повторный webhook идемпотентен: право выдаётся только при переходе
заказа в `paid`.

Если `YOOKASSA_SHOP_ID` и `YOOKASSA_SECRET_KEY` не заданы, `/api/orders`
возвращает 503 `payments_not_configured`, а каталог продолжает работать.

## Переменные окружения функции

| Переменная | Обязательна | Назначение |
|---|---|---|
| `YDB_ENDPOINT` | да | `grpcs://ydb.serverless.yandexcloud.net:2135` |
| `YDB_DATABASE` | да | `/ru-central1/.../etnjvaftd6eakeq08kqr` |
| `PUBLIC_BASE_URL` | да | `https://<домен-шлюза>` |
| `YANDEX_CLIENT_ID` | да | ClientID приложения OAuth |
| `SESSION_TTL_DAYS` | нет | срок сессии, по умолчанию 30 |
| `OAUTH_SCOPE` | нет | по умолчанию `login:info login:email` |
| `YOOKASSA_SHOP_ID` | для оплаты | shopId ЮKassa |

Секреты лежат в Lockbox и подключаются к функции как `--secret`:

| Ключ Lockbox | Переменная функции |
|---|---|
| `YANDEX_CLIENT_SECRET` | `YANDEX_CLIENT_SECRET` |
| `ROUTE_ADMIN_PASSWORD` | `ROUTE_ADMIN_PASSWORD` |
| `YOOKASSA_SECRET_KEY` | `YOOKASSA_SECRET_KEY` (только если задан `YOOKASSA_SHOP_ID`) |

`deploy.sh` не передаёт секреты через environment и не печатает их. Пустые
переменные окружения платформа не принимает, поэтому `YOOKASSA_SHOP_ID`
добавляется только когда оплата настроена.

## Порядок запуска

### 1. Таблицы

```bash
python3 navigator3/scripts/init_auth_db.py   # users, sessions
python3 navigator3/scripts/init_folders.py   # folders, entitlements, orders, поля roads
```

Оба скрипта идемпотентны. `init_folders.py` один раз раскладывает старые
`roads.name` вида `МЕЩЕРА/Экзамен/Маршрут` в дерево папок и заполняет
`folder_id`, `title`, `access`. Уже заполненные значения не перезаписываются.

### 2. Lockbox

```bash
printf '%s' '[
  {"key":"YANDEX_CLIENT_SECRET","text_value":"<secret>"},
  {"key":"ROUTE_ADMIN_PASSWORD","text_value":"<пароль>"},
  {"key":"YOOKASSA_SECRET_KEY","text_value":"<secret-key>"}
]' | yc lockbox secret create --name osmn3-oauth --payload -
```

Сервисному аккаунту функции нужна роль `lockbox.payloadViewer` на секрет.

### 3. Функция

```bash
cp navigator3/.env.example navigator3/.env
# заполнить PUBLIC_BASE_URL, YANDEX_CLIENT_ID, LOCKBOX_SECRET_ID
# при необходимости YOOKASSA_SHOP_ID
./navigator3/deploy.sh
```

### 4. Статика

```bash
node navigator3/scripts/build-static-deploy.js
yc storage s3 cp navigator3/deploy-2files/navigator.html \
  s3://osmn-nav/navigator.html --content-type text/html --cache-control no-cache
yc storage s3 cp navigator3/deploy-2files/editor.html \
  s3://osmn-nav/editor.html --content-type text/html --cache-control no-cache
```

## Проверка

Локально, без YDB и сети:

```bash
python3 navigator3/scripts/test_auth.py
python3 navigator3/scripts/test_catalog.py
python3 navigator3/scripts/test_admin.py
python3 navigator3/scripts/test_payments.py
```

На шлюзе:

```bash
curl -i https://<домен>/api/health
curl -i https://<домен>/api/me
curl -i https://<домен>/api/catalog
curl -i 'https://<домен>/api/route?m=<m>'
curl -i -X POST 'https://<домен>/api/admin?action=list' \
  -H 'X-Route-Admin-Password: <пароль>'
```

Ожидается:

- `/api/catalog` — 200, в ответе есть `folders`, у маршрутов нет `data`;
- `/api/route?m=<m>` — 200 с `data` для бесплатной папки;
- для платной папки без входа — 401, после входа без покупки — 402;
- `/api/admin` без пароля — 403, с верным — 200;
- `/api/orders` без входа — 401, без настроенной ЮKassa — 503.

В браузере:

1. Открыть `https://<домен>/`.
2. Войти через Яндекс в «Настройках».
3. Открыть платную папку — появится замок и цена.
4. Нажать покупку, оплатить, вернуться — папка должна открыться.
5. Открыть `/editor.html`, ввести пароль редактора.
6. Создать папку, задать цену, перетащить в неё маршрут.

## Ограничения

- Нет rate limit и ограничения числа активных сессий.
- Нет возвратов и повторной выдачи прав после отмены платежа.
- `roads.price_kopecks` и `roads.sku` оставлены как резерв; цена сейчас
  задаётся у папки.
- `init_db.py` — архивный скрипт первичного переноса; для текущей схемы
  используйте `init_folders.py`.
