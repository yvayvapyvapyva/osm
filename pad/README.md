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

Базовые тайлы PAD берутся у MapTiler — те же стили, что в навигаторе:
`hybrid-v4` (спутник), `streets-v4`, `base-v4`, `topo-v4`,
`streets-v4-dark` и `openstreetmap`. Дополнительно доступен слой
«Яндекс.Спутник»: тайлы Яндекса пересчитываются из EPSG:3395 в Web Mercator
в `pad/mapLayers.js`, поэтому слой совпадает с подложкой MapTiler.

Переключатель слоёв — кнопка с иконкой слоёв в правом верхнем углу.
Выбранный слой сохраняется в `localStorage` (`pad_map_style_v1`).
При изменении `pad/mapLayers.js` обновите версию в `pad/pad.html`.
