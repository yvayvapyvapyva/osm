# OSM-версия навигатора

Статический клиент (`navigator.html`), скрытый редактор маршрутов (`editor.html`)
и отдельный бэкенд в Яндекс Облаке для этой версии.

## Ресурсы

| Что | Имя | ID / адрес |
|---|---|---|
| Serverless YDB | `dbosm` | `etnjvaftd6eakeq08kqr` |
| Cloud Function | `osmn` | `d4e02ghbv31h6kpf8ddh` |
| HTTP-эндпоинт | — | https://functions.yandexcloud.net/d4e02ghbv31h6kpf8ddh |
| Редактор (прямая ссылка) | — | `editor.html` на том же домене, где лежит навигатор |
| База-источник (не используется клиентом) | `dbnav` | `etn3ppn9gdj01le0ep1v` |
| TTS (общая для версий) | `tts` | `d4erngid6s4rf5oinnp1` |

База и функция не пересекаются с `dbnav`/`vknav`: изменения в OSM-версии не влияют
на остальные приложения, и наоборот.

## Редактор

Редактор намеренно не linked из навигатора: в `navigator.html` и меню нет кнопок
или ссылок на него. Открывается только по прямой ссылке:

```
https://<домен-навигатора>/editor.html
```

В `editor.html` стоит `<meta name="robots" content="noindex, nofollow">`, поэтому
поисковые системы страницу не индексируют. Авторизация остаётся как в исходной
версии:

- логин/пароль из таблицы `users`;
- Telegram Mini App `initData` (если в функции задан `TELEGRAM_TOKEN`);
- VK `id` при запуске внутри VK Mini App;
- админ-ключ `ADMIN_ACCESS_KEY`: позволяет войти под любым `id` создателя и
  редактировать его маршруты.

Новые пользователи могут зарегистрироваться на вкладке «Регистрация»; запись
создаётся в `users` новой базы. Если регистрация не нужна, её можно отключить в
бэкенде.

## Структура

```
osm/
├── navigator.html          # клиент навигатора
├── editor.html             # скрытый редактор маршрутов
├── instr.html              # инструкция навигатора
├── instr_editor.html       # инструкция редактора
├── assets/                 # стили и клиентские модули
│   ├── css/editor.css
│   └── js/config.js        # константы редактора (цвета, ключ карт)
├── backend/
│   ├── handler.py          # код функции osmn
│   └── requirements.txt
├── scripts/init_db.py      # создание схемы и перенос roads + users
└── deploy.sh               # деплой новой версии функции
```

## API функции

### Публичное API навигатора

Без авторизации и без отчётов в Telegram (отчёты клиент отправляет
самостоятельно через Cloudflare Worker).

**Список маршрутов**

```
GET ?action=list_routes
GET ?action=list_routes&creator=<id>
```

Возвращает массив `{id, m, name, description, creator_name}` только для
`visible = true AND name IS NOT NULL`.

**Маршрут**

```
GET ?id=<id>&m=<m>
```

Возвращает `{name, m, data}`, где `data` — исходный JSON маршрута (массив точек).
Коды: `400` — не хватает параметров, `404` — маршрут не найден, `500` — ошибка БД.

### API редактора

Авторизация передаётся в параметрах запроса:

- `p=user&login=<login>&password=<password>` — вход по логину/паролю;
- `p=tg&tg_init_data=<initData>` — Telegram Mini App;
- `p=vk&id=<vk_id>` — VK Mini App.

Действия:

```
GET  ?action=register&login=<login>&password=<password>&creator_name=<name>
GET  ?action=login&login=<login>&password=<password>
GET  ?action=list&p=user&login=<login>&password=<password>
GET  ?action=get_protected&p=...&m=<m>
GET  ?action=get_meta&p=...&m=<m>
POST ?action=save&p=...&m=<m>       # тело: {"data": [...]}
POST ?action=save_meta&p=...&m=<m>  # тело: {"name","description","visible","creator_name","new_m"}
GET  ?action=delete&p=...&m=<m>
```

`new_m` в `save_meta` необязателен: если задан и отличается от `m`, маршрут
переименовывается. `get_protected`, `save`, `save_meta` и `delete` работают
только с маршрутами текущего пользователя (`id` = логин/VK id/Telegram id) либо
с чужими маршрутами при входе по `ADMIN_ACCESS_KEY`.

## Схема БД

Таблица `roads` (ключ `id`, `m`):

| Колонка | Тип |
|---|---|
| `id` | `Utf8` |
| `m` | `Utf8` |
| `json` | `Json` |
| `name` | `Utf8` |
| `description` | `Utf8` |
| `visible` | `Bool` |
| `creator_name` | `Utf8` |

Таблица `users` (ключ `login`):

| Колонка | Тип |
|---|---|
| `login` | `Utf8` |
| `password` | `Utf8` |
| `creator_name` | `Utf8` |
| `created_at` | `Timestamp` |

Пароли в `users` хранятся в том же legacy-виде, что и в исходной базе, чтобы
существующие логины продолжали работать после переноса.

## Развёртывание

```bash
# 1. Первичная инициализация БД и перенос roads + users из dbnav
python3 scripts/init_db.py

# только схема, без данных
python3 scripts/init_db.py --no-copy

# только видимые маршруты
python3 scripts/init_db.py --visible-only

# 2. Обновление кода функции
./deploy.sh
```

`init_db.py` берёт IAM-токен из `yc iam create-token`, поэтому нужен
авторизованный `yc` CLI. Адреса БД можно переопределить переменными
`SRC_DATABASE` и `DST_DATABASE`.

`deploy.sh` при обновлении переиспользует `TELEGRAM_TOKEN` и `ADMIN_ACCESS_KEY`
из текущей версии функции. Их можно переопределить переменными окружения:

```bash
TELEGRAM_TOKEN=... ADMIN_ACCESS_KEY=... ./deploy.sh
```

## Переключение клиента

Адрес функции задан в `assets/js/menu-module.js` и `editor.html`:

```js
API_URL_V2: 'https://functions.yandexcloud.net/d4e02ghbv31h6kpf8ddh',
```

В `editor.html` — константа `YC_FUNCTION_URL`. После изменения констант обновите
`?v=` у подключаемых скриптов, чтобы браузер не взял старую версию из кэша.

## Права

- Функция `osmn`: `functions.functionInvoker` для `allUsers` (публичный вызов).
- Сервисный аккаунт `servaccsunt` (`aje0hrd823msk3hqaikt`): роль `editor` на `dbosm`.
