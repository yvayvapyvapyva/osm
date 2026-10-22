# PAD

Приложение для разбора дорожных ситуаций. Бэкенд сцен вынесен в отдельную
Яндекс.Облако функцию и использует базу данных OSM-проекта.

## Бэкенд

- Функция: `pad-osm`
- ID: `d4esfoiand5dinv3mfth`
- URL: https://functions.yandexcloud.net/d4esfoiand5dinv3mfth
- База: `dbosm` (`/ru-central1/b1gtnlal9r2s3rvqadjn/etnjvaftd6eakeq08kqr`)
- Таблица сцен: `scene` (ключ `user_id`, `name`)
- Сервисный аккаунт: `aje0hrd823msk3hqaikt`

Сцены из прежней базы PAD (`dbnav`) перенесены в `dbosm.scene`.

Функция публичная и не пересекается с функцией `osmn`, которая обслуживает
маршруты навигатора/редактора в таблице `roads`.

## Деплой

```bash
TELEGRAM_BOT_TOKEN=... DEFAULT_PASSWORD=... ./pad/deploy.sh
```

Необязательно: `REPORT_CHAT_ID=...`.

## Frontend

URL функции задан в `pad/saveState.js` (`API_URL`). При изменении URL или
кода `saveState.js` обновите версию в `pad/pad.html`, чтобы сбросить кэш.
