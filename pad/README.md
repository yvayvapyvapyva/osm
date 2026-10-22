# PAD

Приложение для разбора дорожных ситуаций. Бэкенд сцен вынесен в отдельную
Яндекс.Облако функцию и использует базу данных OSM-проекта.

## Бэкенд

- Функция: `pad-osm`
- ID: `d4esfoiand5dinv3mfth`
- URL: https://functions.yandexcloud.net/d4esfoiand5dinv3mfth
- База: `dbosm` (`/ru-central1/b1gtnlal9r2s3rvqadjn/etnjvaftd6eakeq08kqr`)
- Таблица сцен: `scene` (ключ `name`)
- Сервисный аккаунт: `aje0hrd823msk3hqaikt`

Сцены общие: привязки к Telegram-аккаунту, `user_id` и пароля нет.
Сцены из прежней базы PAD (`dbnav`) перенесены в `dbosm.scene`.

Share-ссылки содержат только имя сцены. Старый формат
`ownerUserId:sceneName` не поддерживается: PAD — независимое приложение.

Функция публичная и не пересекается с функцией `osmn`, которая обслуживает
маршруты навигатора/редактора в таблице `roads`.

## Деплой

```bash
./pad/deploy.sh
```

Пароли и токены бэкенду больше не нужны.

## Frontend

URL функции задан в `pad/saveState.js` (`API_URL`). При изменении URL или
кода `saveState.js` обновите версию в `pad/pad.html`, чтобы сбросить кэш.

## Карта

PAD использует MapLibre GL JS — тот же движок, что и навигатор. Базовая
подложка — «Яндекс.Спутник». Тайлы Яндекса отдаются без ключа и
пересчитываются из EPSG:3395 в Web Mercator в `pad/mapEngine.js`.
Максимальный зум — 21. Ключи карт (Яндекс/MapTiler) не нужны.
При изменении `pad/mapEngine.js` обновите версию в `pad/pad.html`.
