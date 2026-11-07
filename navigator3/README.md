# navigator3 — навигатор с Яндекс ID и папками маршрутов

`navigator3/` — единственная версия навигатора в репозитории. Старые
`navigator/`, `navigator2/`, `routes.json` и функция `osmn` удалены: новый
клиент работает только через API Gateway и функцию `osmn3`.

Что уже есть:

- вход через Яндекс ID (OAuth + PKCE, сессия в YDB);
- каталог без геометрии: `/api/catalog`, точки — только по запросу
  `/api/route?m=...`;
- дерево папок как отдельная сущность в БД;
- все видимые маршруты открыты без входа;
- редактор маршрутов и папок на `/editor.html`.

## Текущий контур

| Что | Значение |
|---|---|
| Бакет | `osmn-nav` (приватный) |
| Домен | `https://ainstruktor.ru` — DNS only в Cloudflare, трафик напрямую в API Gateway (сертификат Yandex Certificate Manager). `www` — через Cloudflare, 301 на apex |
| Домен шлюза | `https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net` |
| API Gateway | `osmn3` / `d5dsd5u1tsc8fm9dbsg5` |
| Функция | `osmn3` / `d4e8ds1489g0q91dt7do` |
| Сервисный аккаунт шлюза | `osmn3-gateway` / `ajec0sf19r17r3tv6vrg` |
| YDB | `dbosm`, таблицы `users`, `sessions`, `roads`, `folders` |

Redirect URI приложения Яндекс OAuth (должны быть зарегистрированы оба):

```
https://ainstruktor.ru/auth/yandex/callback
https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net/auth/yandex/callback
```

`PUBLIC_BASE_URL` задаёт основной origin (`https://ainstruktor.ru`),
`PUBLIC_ALTERNATE_URLS` — дополнительные через запятую. Redirect URI и
return-адреса строятся от того хоста, с которого пользователь начал запрос,
поэтому вход работает и на старом домене шлюза.

## Схема

```
https://<домен-шлюза>/
  /                       → бакет osmn-nav: navigator.html
  /editor.html            → бакет osmn-nav: editor.html
  /api/health             → функция osmn3
  /api/me                 → функция osmn3
  /api/catalog            → функция osmn3
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
│       ├── report.js           # отчёт о маршруте в Telegram
│       ├── map-styles.js
│       └── tts-client.js
├── backend/
│   ├── handler.py              # точка входа: /api, /auth, /api/admin
│   ├── auth.py                 # OAuth, PKCE, cookie, ответы
│   ├── store.py                # users/sessions в YDB
│   └── requirements.txt
├── scripts/
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
    sort_order    Uint32,
    PRIMARY KEY (folder_id)
);
```

Папка — стабильная сущность: у неё есть `folder_id`, который не меняется при
переименовании. `parent_id` задаёт дерево.

### `roads`

К существующим полям добавлены:

```sql
folder_id     Utf8,
title         Utf8         -- короткое имя внутри папки
```

`roads.name` остаётся полным путём (`МЕЩЕРА/Экзамен/Экз. Мещера-1`) и
пересчитывается сервером при сохранении метаданных. Новый код использует
`folder_id` + `title`; полный путь нужен для совместимости с TTS и отчётами.

Маршруты доступны всем без входа. Каталог содержит только видимые маршруты
без геометрии; геометрия загружается отдельно.

`/api/route`:

- 200 + `data` для видимого маршрута;
- 404 для скрытого или несуществующего маршрута.

## API

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/health` | `{"status":"ok"}` |
| GET | `/api/me` | `{"user":{...}}` или 401 |
| GET | `/api/catalog` | `{"folders":[...],"routes":[...],"user":...}` без геометрии |
| GET | `/api/folder?folder_id=<id>` | содержимое папки с геометрией её маршрутов |
| GET | `/api/route?m=<m>` | маршрут с `data` |
| POST | `/api/admin?action=...` | операции редактора |
| GET | `/auth/yandex/start?return=/...` | 302 на Яндекс + state-cookie |
| GET | `/auth/yandex/callback` | 302 обратно + sid-cookie |
| POST | `/auth/logout` | 200 + удаление cookie |

### Редактор

Все действия `/api/admin` требуют заголовок `X-Route-Admin-Password`, включая
чтение: иначе `action=list` отдавал бы скрытые маршруты в обход
`visible = true`. Пароль хранится в переменной окружения функции
`ROUTE_ADMIN_PASSWORD`.

| `action` | Назначение |
|---|---|
| `auth` | проверка пароля |
| `list` | все маршруты и папки |
| `get`, `get_meta` | геометрия и метаданные маршрута |
| `save`, `save_meta`, `delete` | изменение маршрута |
| `folder_save`, `folder_delete` | создание/изменение и удаление папки |

`save_meta` принимает `{title, folder_id, description, visible}`.
Полный `name` собирается на сервере. `folder_delete` не удаляет папку, если в
ней есть вложенные папки или маршруты (409).

## Переменные окружения функции

| Переменная | Обязательна | Назначение |
|---|---|---|
| `YDB_ENDPOINT` | да | `grpcs://ydb.serverless.yandexcloud.net:2135` |
| `YDB_DATABASE` | да | `/ru-central1/.../etnjvaftd6eakeq08kqr` |
| `PUBLIC_BASE_URL` | да | `https://<домен-шлюза>` |
| `PUBLIC_ALTERNATE_URLS` | нет | дополнительные origin'ы через запятую |
| `YANDEX_CLIENT_ID` | да | ClientID приложения OAuth |
| `SESSION_TTL_DAYS` | нет | срок сессии, по умолчанию 30 |
| `OAUTH_SCOPE` | нет | по умолчанию `login:info login:email` |
| `YANDEX_CLIENT_SECRET` | да | секрет приложения Яндекс OAuth |
| `ROUTE_ADMIN_PASSWORD` | да | пароль редактора маршрутов |

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
ROUTE_ADMIN_PASSWORD=<пароль редактора>
```

`deploy.sh` передаёт их в переменные окружения функции. Lockbox не
используется: значение видно в `yc serverless function version list`, так что
доступ к каталогу Yandex Cloud должен быть ограничен.

### 2. Функция

```bash
cp navigator3/.env.example navigator3/.env
# заполнить PUBLIC_BASE_URL, YANDEX_CLIENT_ID, YANDEX_CLIENT_SECRET,
# ROUTE_ADMIN_PASSWORD
./navigator3/deploy.sh
```

### 3. Статика

```bash
node navigator3/scripts/build-static-deploy.js
yc storage s3 cp navigator3/deploy-2files/navigator.html \
  s3://osmn-nav/navigator.html --content-type text/html --cache-control no-cache
yc storage s3 cp navigator3/deploy-2files/editor.html \
  s3://osmn-nav/editor.html --content-type text/html --cache-control no-cache
```

## Проверка

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
- `/api/route?m=<m>` — 200 с `data` для видимого маршрута;
- `/api/admin` без пароля — 403, с верным — 200;

В браузере:

1. Открыть `https://<домен>/`.
2. Войти через Яндекс в «Настройках».
3. Открыть любую папку и маршрут — доступ не требует входа.
4. Открыть `/editor.html`, ввести пароль редактора.
5. Создать папку и перетащить в неё маршрут.

## Ограничения

- Нет rate limit и ограничения числа активных сессий.
