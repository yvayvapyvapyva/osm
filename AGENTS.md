# AGENTS.md — проект osm

## Структура проекта
- `navigator_offline/` — офлайн-версия навигатора (без авторизации, без API Gateway и YDB). Маршруты в `routes_all.json`, открывается `navigator.html`.
- `navigator3/` — основная версия с Яндекс ID, API Gateway, YDB.
- `pad/` — разбор дорожных ситуаций.
- `tts/` — озвучка.
- `export_offline.py` — экспорт данных для офлайн-версии.

## Деплой navigator_offline (текущая задача)
- Бакет Yandex Object Storage: **`navigator-offline`** (folder `b1gepvq09nl4oobiemtr`, создан 2026-11-01 09:45).
- Деплоится вручную: `yc storage s3 cp --recursive navigator_offline/ s3://navigator-offline/`
- `routes_all.json` должен лежать в корне бакета.
- Статику открывать через веб-хостинг бакета, например `https://storage.yandexcloud.net/navigator-offline/navigator.html` (точный URL веб-хостинга — в консоли Яндекс.Облака, настройки бакета).
- Авторизация в офлайн-версии отключена. Карты — локальные `maplibre-gl.js`/`pmtiles.js`, тайлы из бакета `nn-map-tiles`. Озвучка — из `eia-tts` (нужен интернет).

## Деплой остальных частей (справка)
- `navigator3/deploy.sh` — функция `osmn3` (ID `d4e8ds1489g0q91dt7do`), API Gateway `https://d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net`, публичный домен `https://ainstruktor.ru`, статика в бакет `osmn-nav`.
- **Cloudflare больше не проксирует apex.** Запись `ainstruktor.ru` в DNS-зоне Cloudflare переведена в **DNS only** (CNAME на `d5dsd5u1tsc8fm9dbsg5.s183zexc.apigw.yandexcloud.net`, TTL 300): браузер подключается напрямую к API Gateway, сертификат отдаёт Yandex Certificate Manager (`fpqp0bmtjpsj89butg6j`, Let's Encrypt `YR2`, apex+www, автопродление). Проверено: `GET /` 200, `/api/health` 200, HTTP→HTTPS 301 уже от шлюза, HSTS отдаёт шлюз, OAuth крутится на `https://ainstruktor.ru/auth/yandex/callback`. У шлюза нет IPv6, ALPN только `h2`, сжатие только gzip.
- `www.ainstruktor.ru` **остаётся за Cloudflare** (оранжевое облако, CNAME на тот же шлюз) и работает только как редирект 301 на apex. Привязать www напрямую к шлюзу нельзя — исчерпана квота `serverless.apiGatewaysDomains.count`. Если www тоже уводить напрямую, нужно поднимать квоту в поддержке и добавлять обработку `Host` в функцию.
- Историческая заметка: раньше apex шёл через Cloudflare с включённым ECH и не открывался с мобильных сетей РФ (SNI прятался за `cloudflare-ech.com`, DPI рвал соединение). Сейчас ECH неактуален: в DNS для apex нет HTTPS-записи, проксирования нет. Включать прокси обратно без причины не стоит — это вернёт старую проблему.
- Откат при необходимости: вернуть `proxied: true` для записи apex в Cloudflare (5 минут с TTL 300).
- `pad/deploy.sh` — функция `pad-osm` (ID `d4esfoiand5dinv3mfth`).
- `tts/navigator/deploy.sh` — функция TTS (ID `d4e3cj3q3ff36qlrhbg8`).

## Последние изменения (коммит acf527a, ветка main)
- Убран поиск из меню маршрутов (`navigator_offline/assets/js/menu-module.js`).
- В строке маршрута добавлены количество точек и длина (`navigator_offline/assets/js/menu-module.js`, `assets/css/navigator.css`).
- Запушено в `origin/main`.

## Команда YC
- `yc` установлен: `/Users/mb/yandex-cloud/bin/yc`
- cloud-id: `b1gtnlal9r2s3rvqadjn`, folder-id: `b1gepvq09nl4oobiemtr`
