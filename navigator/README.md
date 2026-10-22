# OSM-версия навигатора

Все файлы навигатора находятся в этой папке (`navigator/`).

Статический клиент (`navigator.html`), скрытый редактор маршрутов (`editor.html`)
и отдельный бэкенд в Яндекс Облаке для этой версии.

Маршруты не привязаны к аккаунтам: нет таблицы пользователей, авторизации и
поля создателя. Единственный идентификатор маршрута — `m`.

## Ресурсы

| Что | Имя | ID / адрес |
|---|---|---|
| Serverless YDB | `dbosm` | `etnjvaftd6eakeq08kqr` |
| Cloud Function | `osmn` | `d4e02ghbv31h6kpf8ddh` |
| HTTP-эндпоинт | — | https://functions.yandexcloud.net/d4e02ghbv31h6kpf8ddh |
| Редактор (прямая ссылка) | — | `navigator/editor.html` на том же домене, где лежит навигатор |
| База-источник (не используется клиентом) | `dbnav` | `etn3ppn9gdj01le0ep1v` |
| TTS (общая для версий) | `tts` | `d4erngid6s4rf5oinnp1` |

База и функция не пересекаются с `dbnav`/`vknav`: изменения в OSM-версии не влияют
на остальные приложения, и наоборот.

## Редактор

Редактор намеренно не linked из навигатора: в `navigator.html` и меню нет кнопок
или ссылок на него. Открывается только по прямой ссылке:

```
https://<домен-навигатора>/navigator/editor.html
```

В `editor.html` стоит `<meta name="robots" content="noindex, nofollow">`, поэтому
поисковые системы страницу не индексируют.

Авторизации нет: редактор открывается сразу. Это значит, что любой, у кого есть
прямая ссылка на `editor.html`, может просматривать и редактировать все маршруты.

Ссылка на конкретный маршрут в навигаторе имеет вид
`https://<домен-навигатора>/navigator/navigator.html#m=<m>`.
Идентификатор `m` — единственный ключ маршрута.

## Структура

```
osm/
├── navigator/
│   ├── navigator.html      # клиент навигатора
│   ├── editor.html         # скрытый редактор маршрутов
│   ├── instr.html          # инструкция навигатора
│   ├── instr_editor.html   # инструкция редактора
│   ├── assets/             # стили и клиентские модули
│   │   ├── css/editor.css
│   │   └── js/config.js    # константы редактора (цвета, ключ карт)
│   ├── backend/
│   │   ├── handler.py      # код функции osmn
│   │   └── requirements.txt
│   ├── scripts/init_db.py  # создание схемы и перенос маршрутов
│   └── deploy.sh           # деплой новой версии функции
└── pad/                    # отдельное приложение PAD
```

## API функции

### Публичное API навигатора

Без авторизации.

**Список маршрутов**

```
GET ?action=list_routes
```

Возвращает массив `{m, name, description}` только для
`visible = true AND name IS NOT NULL`.

**Маршрут**

```
GET ?action=get&m=<m>
```

Возвращает `{name, m, data}`, где `data` — исходный JSON маршрута (массив точек).
Коды: `400` — не хватает параметров, `404` — маршрут не найден, `500` — ошибка БД.

### API редактора

Авторизация не требуется. Действия:

```
GET  ?action=list
GET  ?action=get&m=<m>
GET  ?action=get_meta&m=<m>
POST ?action=save&m=<m>       # тело: {"data": [...]}
POST ?action=save_meta&m=<m>  # тело: {"name","description","visible","new_m"}
GET  ?action=delete&m=<m>
```

`new_m` в `save_meta` необязателен: если задан и отличается от `m`, маршрут
переименовывается. Все действия работают с маршрутом по его `m`.

## Схема БД

Таблица `roads` (ключ `m`):

| Колонка | Тип |
|---|---|
| `m` | `Utf8` |
| `json` | `Json` |
| `name` | `Utf8` |
| `description` | `Utf8` |
| `visible` | `Bool` |

Таблицы `users` и полей `id`/`creator_name` нет.

## Развёртывание

Из корня репозитория:

```bash
# 1. Первичная инициализация БД и перенос маршрутов из dbnav
python3 navigator/scripts/init_db.py

# только схема, без данных
python3 navigator/scripts/init_db.py --no-copy

# только видимые маршруты
python3 navigator/scripts/init_db.py --visible-only

# 2. Обновление кода функции
./navigator/deploy.sh
```

`init_db.py` берёт IAM-токен из `yc iam create-token`, поэтому нужен
авторизованный `yc` CLI. Адреса БД можно переопределить переменными
`SRC_DATABASE` и `DST_DATABASE`. При переносе из точек удаляется legacy-поле
`info`.

`navigator/deploy.sh` передаёт функции только `YDB_ENDPOINT` и `YDB_DATABASE`.

## Переключение клиента

Адрес функции задан в `navigator/assets/js/menu-module.js` и `navigator/editor.html`:

```js
API_URL_V2: 'https://functions.yandexcloud.net/d4e02ghbv31h6kpf8ddh',
```

В `navigator/editor.html` — константа `YC_FUNCTION_URL`. После изменения констант обновите
`?v=` у подключаемых скриптов, чтобы браузер не взял старую версию из кэша.

## Права

- Функция `osmn`: `functions.functionInvoker` для `allUsers` (публичный вызов).
- Сервисный аккаунт `servaccsunt` (`aje0hrd823msk3hqaikt`): роль `editor` на `dbosm`.
