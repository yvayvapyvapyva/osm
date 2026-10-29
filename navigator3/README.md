# navigator3 — навигатор с идентификацией через Яндекс ID

Рабочая копия `navigator2` для постепенного внедрения аккаунтов. Основная
версия в `navigator/` и работающая функция `osmn` не меняются: здесь своя
функция `osmn3`, свой шлюз и свои таблицы в той же YDB `dbosm`.

Сейчас сделаны идентификация и новый каталог. Фронтенд получает список
маршрутов без геометрии из `/api/catalog`, а точки — из `/api/route` только
для выбранного маршрута. Маршруты пока публичные, оплаты нет. Старый API
`osmn` оставлен для редактора и обратной совместимости.

## Текущий тестовый контур

| Что | Значение |
|---|---|
| Бакет | `osmn-nav` |
| Домен | `https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net` |
| API Gateway | `osmn3` / `d5dsd5u1tsc8fm9dbsg5` |
| Функция | `osmn3` / `d4e8ds1489g0q91dt7do` |
| Сервисный аккаунт шлюза | `osmn3-gateway` / `ajec0sf19r17r3tv6vrg` |
| Таблицы YDB | `users`, `sessions` созданы в `dbosm` |

Redirect URI для приложения Яндекс OAuth:

```
https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net/auth/yandex/callback
```

Статус: бакет, шлюз и функция работают, статика отдаётся, таблицы `users` и
`sessions` созданы. Вход через Яндекс проверен в браузере. Каталог переведён
на `/api/catalog` без геометрии; `/api/route` отдаёт точки одного маршрута.

## Схема

```
https://<домен-шлюза>/
  /                     → бакет osmn-nav: navigator.html
  /assets/*             → бакет osmn-nav
  /instr.html           → бакет osmn-nav
  /api/me               → функция osmn3
  /api/health           → функция osmn3
  /api/catalog          → функция osmn3
  /api/route?m=...      → функция osmn3
  /auth/yandex/start    → функция osmn3
  /auth/yandex/callback → функция osmn3
  /auth/logout          → функция osmn3
```

Один origin нужен, потому что при прямом вызове
`functions.yandexcloud.net` Яндекс вырезает из запроса `Cookie` и
`Authorization`. Через API Gateway cookie доходят до функции, а `sid`
становится first-party cookie.

## Состав

```
navigator3/
├── navigator.html              # клиент (исходник)
├── instr.html                  # инструкция
├── assets/
│   ├── css/navigator.css
│   └── js/
│       ├── menu-module.js      # /api/catalog и /api/route
│       ├── auth-module.js      # вход, /api/me, выход
│       ├── map-styles.js
│       └── tts-client.js
├── backend/
│   ├── handler.py              # точка входа, старые action + /api, /auth
│   ├── auth.py                 # OAuth, PKCE, cookie, ответы
│   ├── store.py                # users/sessions в YDB
│   └── requirements.txt
├── scripts/
│   ├── init_auth_db.py         # создание users и sessions
│   ├── init_db.py              # старый скрипт маршрутов (не обязателен)
│   ├── test_auth.py            # локальные проверки входа
│   ├── test_catalog.py         # локальные проверки каталога
│   └── build-static-deploy.js
├── gateway/osmn.yaml           # спецификация API Gateway
├── deploy.sh                   # деплой функции osmn3
└── deploy-2files/navigator.html # собранный одностраничный бандл
```

## Как работает вход

```
Браузер                  osmn3                     Яндекс
  |                        |                         |
  |-- /auth/yandex/start ->|                         |
  |<-- 302 + state cookie -|                         |
  |----------------------->|------------------------>|
  |                        |    пользователь входит  |
  |<-----------------------|<------------------------|
  |-- /auth/yandex/callback?code=...&state=... ---->|
  |                        |-- POST /token --------->|
  |                        |<-- access_token --------|
  |                        |-- GET login/info ------>|
  |                        |<-- id, login, email ----|
  |                        | users + sessions в YDB  |
  |<-- 302 + sid cookie ---|                         |
  |-- /api/me ------------>|                         |
  |<-- user / 401 ---------|                         |
```

Детали:

- `state` и PKCE `code_verifier` лежат в HttpOnly-cookie с путём `/auth` и
  живут 10 минут.
- Код Яндекса одноразовый и живёт 10 минут.
- В `sessions` хранится только SHA-256 от `sid`, не сам `sid`.
- Cookie сессии: `osm_sid`, `HttpOnly`, `Secure`, `SameSite=Lax`, 30 дней.
- Токен Яндекса не сохраняется: он нужен один раз для профиля.
- `return` принимается только как локальный путь (`/...`), иначе `/`.

## Таблицы

Создаются `scripts/init_auth_db.py`:

```sql
CREATE TABLE users (
    yandex_id     Utf8,
    user_id       Utf8,
    login         Utf8,
    email         Utf8,
    display_name  Utf8,
    created_at    Timestamp,
    last_login_at Timestamp,
    blocked       Bool,
    PRIMARY KEY (yandex_id)
);

CREATE TABLE sessions (
    sid_hash     Utf8,
    yandex_id    Utf8,
    user_id      Utf8,
    created_at   Timestamp,
    expires_at   Timestamp,
    last_seen_at Timestamp,
    user_agent   Utf8,
    ip           Utf8,
    PRIMARY KEY (sid_hash)
);
```

`yandex_id` — стабильный идентификатор из `login.yandex.ru/info`. Email может
отсутствовать, поэтому он не ключ.

## API

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/health` | `{"status":"ok"}` |
| GET | `/api/me` | `{"user":{...},"entitlements":[]}` или 401 |
| GET | `/api/catalog` | `{"routes":[{"m","name","description","point_count","distance_meters","access"}]}` — без геометрии |
| GET | `/api/route?m=<m>` | `{"m","name","description","access","point_count","distance_meters","data":[...]}` |
| GET | `/auth/yandex/start?return=/...` | 302 на Яндекс + state-cookie |
| GET | `/auth/yandex/callback` | 302 обратно + sid-cookie |
| POST | `/auth/logout` | 200 + удаление cookie |

`/api/catalog` отдаёт только видимые маршруты и метрики, посчитанные на
сервере. `/api/route` тоже проверяет `visible = true`: скрытые и удалённые
маршруты наружу не попадают.

Старые вызовы `?action=list_routes`, `?action=get`, `?action=save` и т. д.
работают как раньше, с CORS `*` и `X-Route-Admin-Password` для редактора.
Именно поэтому старый `full=1` пока не отключён — его использует рабочая
версия `navigator/`.

## Переменные окружения функции

| Переменная | Обязательна | Назначение |
|---|---|---|
| `YDB_ENDPOINT` | да | `grpcs://ydb.serverless.yandexcloud.net:2135` |
| `YDB_DATABASE` | да | `/ru-central1/.../etnjvaftd6eakeq08kqr` |
| `PUBLIC_BASE_URL` | да | `https://<домен-шлюза>` |
| `YANDEX_CLIENT_ID` | да | ClientID приложения OAuth |
| `SESSION_TTL_DAYS` | нет | срок сессии, по умолчанию 30 |
| `OAUTH_SCOPE` | нет | по умолчанию `login:info login:email` |

Секреты в переменные окружения не записываются. Они лежат в Lockbox и
подключаются к функции как `--secret`:

| Ключ Lockbox | Переменная функции |
|---|---|
| `YANDEX_CLIENT_SECRET` | `YANDEX_CLIENT_SECRET` |
| `ROUTE_ADMIN_PASSWORD` | `ROUTE_ADMIN_PASSWORD` |

`deploy.sh` требует `LOCKBOX_SECRET_ID` и передаёт оба ключа. Значения не
попадают в вывод `yc`, в историю команд и в репозиторий:

```bash
LOCKBOX_SECRET_ID=<id> \
PUBLIC_BASE_URL=https://<домен> \
YANDEX_CLIENT_ID=<client-id> \
./deploy.sh
```

## Порядок запуска

### 1. Бакет и шлюз

```bash
yc storage bucket create --name osmn-nav
```

Создайте сервисный аккаунт шлюза и выдайте роли:

```bash
yc iam service-account create --name osmn3-gateway
```

Нужны:

- `storage.viewer` на папку (или на бакет, если доступно);
- `functions.functionInvoker` на функцию `osmn3`.

Заполните `gateway/osmn.yaml`: `<SERVICE_ACCOUNT_ID>`, `<FUNCTION_ID>`.
Создайте шлюз:

```bash
yc serverless api-gateway create --name osmn3 --spec gateway/osmn.yaml
yc serverless api-gateway get --name osmn3
```

В поле `domain` будет служебный адрес вида
`https://d5d....apigw.yandexcloud.net`. Он бесплатный. Если удалить шлюз и
создать заново, домен изменится.

### 2. Приложение Яндекс OAuth

На `https://oauth.yandex.ru/` создайте приложение:

- тип «Для авторизации пользователей»;
- платформа «Веб-сервисы»;
- Redirect URI: `https://<домен-шлюза>/auth/yandex/callback`;
- права: `login:info`, `login:email`.

Получите `ClientID` и `Client secret`. Секрет положите в Lockbox вместе с
паролем редактора:

```bash
printf '%s' '[{"key":"YANDEX_CLIENT_SECRET","text_value":"<secret>"},{"key":"ROUTE_ADMIN_PASSWORD","text_value":"<пароль>"}]' \
  | yc lockbox secret create --name osmn3-oauth --payload -
```

Сервисному аккаунту функции нужна роль `lockbox.payloadViewer` на секрет.

### 3. Таблицы

```bash
python3 navigator3/scripts/init_auth_db.py
```

Скрипт идемпотентен, существующие таблицы не трогает.

### 4. Функция

Можно заполнить `navigator3/.env` (он в `.gitignore`) и запустить:

```bash
cp navigator3/.env.example navigator3/.env
# отредактировать navigator3/.env
./navigator3/deploy.sh
```

Или передать переменные вручную:

```bash
PUBLIC_BASE_URL=https://<домен-шлюза> \
YANDEX_CLIENT_ID=<client-id> \
LOCKBOX_SECRET_ID=<id> \
./navigator3/deploy.sh
```

По умолчанию создаётся функция `osmn3`. Старая `osmn` не меняется.

### 5. Статика

```bash
node navigator3/scripts/build-static-deploy.js
yc storage s3api put-object \
  --bucket osmn-nav \
  --key navigator.html \
  --body navigator3/deploy-2files/navigator.html
```

`routes.json` в бакет не загружайте: в нём лежит геометрия всех маршрутов.

## Проверка

Локально, без YDB и сети:

```bash
python3 navigator3/scripts/test_auth.py
```

На шлюзе:

```bash
curl -i https://<домен>/api/health
curl -i https://<домен>/api/me
curl -i https://<домен>/api/catalog
curl -i 'https://<домен>/api/route?m=<m>'
curl -i https://<домен>/auth/yandex/start
```

Ожидается:

- `/api/health` — 200;
- `/api/me` без cookie — 401;
- `/api/catalog` — 200, в ответе нет поля `data`;
- `/api/route?m=<m>` — 200, есть `data`; для скрытого `m` — 404;
- `/auth/yandex/start` — 302 на `oauth.yandex.ru` и три `Set-Cookie`.

В браузере:

1. Открыть `https://<домен>/`.
2. «Настройки» → «Войти с Яндексом».
3. Разрешить доступ.
4. Вернуться в навигатор, снова открыть настройки — видны имя и email.
5. Перезагрузить страницу — вход сохраняется.
6. «Выйти» — `/api/me` снова 401.
7. В DevTools проверить, что `osm_sid` имеет `HttpOnly`, `Secure`,
   `SameSite=Lax`, а в `localStorage` токенов нет.

## Что пока не сделано

- Старый API `osmn` всё ещё умеет `full=1`: его использует рабочая версия
  `navigator/`. Отключать надо после перевода всех клиентов.
- Нет платных маршрутов, `entitlements`, ЮKassa.
- Нет ограничения числа активных сессий и rate limit.
- Вход доступен в «Настройках»; отдельную кнопку в верхней панели добавим
  после проверки на мобильных.
- `navigator/` и функция `osmn` не изменялись.

## Следующий шаг

1. Добавить в `roads` поля `access`, `price_kopecks`, `sku`.
2. Отдавать в `/api/catalog` признак доступа, а в `/api/route` — 402/403 для
   маршрута без entitlement.
3. Добавить `entitlements` и оплату через ЮKassa.
4. После перевода старого навигатора отключить `full=1` и убрать
   `routes.json` из публичного доступа.
