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
| Cloud Function TTS | `navigator-tts-cache` | `d4e3cj3q3ff36qlrhbg8` |
| HTTP TTS endpoint | — | https://functions.yandexcloud.net/d4e3cj3q3ff36qlrhbg8 |
| TTS bucket | `eia-tts` | `e3e25m6j2oqle9jrpjge`; публичное чтение MP3, запись только от service account функции |

База и функция не пересекаются с `dbnav`/`vknav`: изменения в OSM-версии не влияют
на остальные приложения, и наоборот.

## Карты

В навигаторе и редакторе доступны Яндекс.Спутник, растровые тайлы OpenStreetMap
и векторные тайлы Shortbread от OpenStreetMap Foundation. Ключи карт не нужны.
Векторный стиль использует MapLibre GL, тайлы Shortbread и глифы
`fonts.openmaptiles.org`; максимальный zoom набора Shortbread — 14, поэтому
при большем приближении детализация не растёт.

Для OSM-подложек отображается атрибуция OpenStreetMap. Публичные тайловые
серверы работают без SLA и требуют соблюдения политик использования:
[растровые тайлы](https://operations.osmfoundation.org/policies/tiles/) и
[векторные тайлы](https://operations.osmfoundation.org/policies/vector/).
Не использовать их для массовой предварительной загрузки или офлайн-карт.

## Редактор

Редактор намеренно не linked из навигатора: в `navigator.html` и меню нет кнопок
или ссылок на него. Открывается только по прямой ссылке:

```
https://<домен-навигатора>/navigator/editor.html
```

В `editor.html` стоит `<meta name="robots" content="noindex, nofollow">`, поэтому
поисковые системы страницу не индексируют.

При открытии `editor.html` интерфейс запрашивает пароль администратора.
Backend дополнительно проверяет пароль для всех операций изменения маршрутов:
сохранения данных, изменения метаданных/названия и удаления.

Для деплоя функции задайте `ROUTE_ADMIN_PASSWORD` в окружении. Пароль не
хранится в репозитории; без него `deploy.sh` остановится. Пароль остаётся
только в памяти открытой страницы и передаётся backend в заголовке
`X-Route-Admin-Password`. Публичные API чтения маршрутов по-прежнему доступны
без пароля; входной экран редактора ограничивает интерфейс, а серверная
проверка защищает именно операции изменения.

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
│   │   ├── js/config.js    # константы редактора (цвета)
│   │   ├── js/map-styles.js # стили OSM и Яндекс.Спутника
│   │   └── js/tts-client.js # общая загрузка TTS из бакета и синтез при промахе
│   ├── backend/
│   │   ├── handler.py      # код функции osmn
│   │   └── requirements.txt
│   ├── scripts/init_db.py  # создание схемы и перенос маршрутов
│   └── deploy.sh           # деплой новой версии функции
├── tts/navigator/
│   ├── handler.py          # отдельная bucket-backed TTS-функция
│   ├── sync_routes.py      # проверка/пополнение аудио по фразам из dbosm
│   ├── requirements.txt
│   └── deploy.sh
└── pad/                    # отдельное приложение PAD
```

## Статическая сборка из двух файлов

Установите Node.js и Terser, затем из корня репозитория выполните:

```sh
node navigator/scripts/build-static-deploy.js
```

Готовая папка `navigator/deploy-2files/` содержит только `navigator.html` и
`editor.html`. В них встроены локальные стили, минифицированные скрипты,
иконка и соответствующая инструкция. Сборка сохраняет внешние ссылки на CDN
MapLibre и Sortable.js, а также на картографические и API-сервисы.
Backend в сборку не входит: он деплоится отдельно через `navigator/deploy.sh`.
После изменения исходников пересоберите папку перед публикацией.

Навигатор и редактор сначала проверяют адрес MP3 напрямую в бакете `eia-tts`.
Функция `navigator-tts-cache` вызывается только при отсутствии файла; она
генерирует речь и сохраняет MP3 в бакет. Эта функция и бакет не используют
старый TTS endpoint или YDB-кэш.

Новая функция публично вызываема для клиентского приложения; один запрос
ограничен 100 фразами длиной до 1000 символов. Для деплоя её исходников выполните
из корня репозитория `sh tts/navigator/deploy.sh`.

Чтобы проверить и пополнить кэш всеми уникальными командами и комментариями из
маршрутов `dbosm`, установите зависимость YDB (`pip install -r
navigator/backend/requirements.txt`) и выполните из корня репозитория:

```sh
python3 tts/navigator/sync_routes.py --dry-run
python3 tts/navigator/sync_routes.py
```

Скрипт использует текущую авторизацию `yc`, читает все строки `roads` и
повторно заполняет только отсутствующие объекты; его можно запускать после
изменений маршрутов или по расписанию для контроля актуальности бакета.

## API функции

### Публичное API навигатора

Без авторизации.

**Список маршрутов**

```
GET ?action=list_routes
GET ?action=list_routes&full=1
```

Возвращает массив `{m, name, description}` только для
`visible = true AND name IS NOT NULL`.

С `full=1` в каждый элемент добавляется `data` — геометрия маршрута.
Навигатор запрашивает список именно так: один запрос при запуске вместо
отдельного `action=get` на каждый выбор маршрута (без кэша, данные живут
в памяти до перезагрузки страницы).

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
