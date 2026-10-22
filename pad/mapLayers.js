// pad/mapLayers.js — спутниковая подложка карты PAD.
//
// PAD работает на Yandex Maps JS API 3. Базовая подложка — Яндекс.Спутник.
// Тайлы Яндекса отдаются в эллипсоидном Меркаторе (EPSG:3395), а карта PAD
// переведена в Web Mercator (EPSG:3857), поэтому строки тайлов
// пересчитываются со сдвигом по широте — та же поправка, что и в навигаторе.

(function () {
    'use strict';

    const YANDEX_MERC_E = 0.0818191908426;
    const YANDEX_ZOOM_MAX = 21;

    let state = null;

    // Пересчёт строки Web Mercator в строку Яндекс-Меркатора (EPSG:3395).
    function webRowToLat(row, worldPx) {
        return Math.atan(Math.sinh(Math.PI * (1 - 2 * row / worldPx))) * 180 / Math.PI;
    }

    function latToYandexRow(lat, worldPx) {
        const b = lat * Math.PI / 180;
        const phi = (1 - YANDEX_MERC_E * Math.sin(b)) / (1 + YANDEX_MERC_E * Math.sin(b));
        const theta = Math.tan(Math.PI / 4 + b / 2) * Math.pow(phi, YANDEX_MERC_E / 2);
        return worldPx * (1 - Math.log(theta) / Math.PI) / 2;
    }

    async function loadBitmap(url, signal) {
        const res = await fetch(url, { signal: signal, mode: 'cors' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        if (typeof createImageBitmap === 'function') return await createImageBitmap(blob);
        return await new Promise(function (resolve, reject) {
            const img = new Image();
            const objUrl = URL.createObjectURL(blob);
            img.onload = function () { URL.revokeObjectURL(objUrl); resolve(img); };
            img.onerror = function () { URL.revokeObjectURL(objUrl); reject(new Error('Не удалось загрузить тайл')); };
            img.src = objUrl;
        });
    }

    async function fetchYandexTile(x, y, z, scale, signal) {
        x = Number(x); y = Number(y); z = Number(z);
        const n = Math.pow(2, z);
        const worldPx = 256 * n;
        const lat = webRowToLat(256 * y, worldPx);
        const yRow = latToYandexRow(lat, worldPx);
        let srcY = Math.floor(yRow / 256);
        srcY = Math.max(0, Math.min(n - 1, srcY));
        const shiftUp = Math.max(0, Math.min(255.999, yRow - 256 * srcY));
        const snap = Math.max(0, Math.min(255, Math.round(shiftUp)));

        const base = 'https://core-sat.maps.yandex.net/tiles?l=sat&x=' + x + '&y=';
        const secondY = Math.min(n - 1, srcY + 1);
        const imgA = await loadBitmap(base + srcY + '&z=' + z, signal);
        const imgB = snap > 0
            ? await loadBitmap(base + secondY + '&z=' + z, signal).catch(function () { return null; })
            : null;

        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imgA, 0, -snap);
        if (imgB) ctx.drawImage(imgB, 0, 256 - snap);
        if (imgA.close) imgA.close();
        if (imgB && imgB.close) imgB.close();
        return { image: canvas };
    }

    function init(options) {
        if (state) return;
        state = {
            map: options.map,
            YMapTileDataSource: options.YMapTileDataSource,
            YMapLayer: options.YMapLayer
        };

        const sourceId = 'pad-base-yandex-sat';
        const source = new state.YMapTileDataSource({
            id: sourceId,
            raster: {
                type: 'ground',
                size: 256,
                fetchTile: fetchYandexTile
            },
            zoomRange: { min: 0, max: YANDEX_ZOOM_MAX },
            clampMapZoom: false,
            copyrights: ['© Яндекс']
        });

        const layer = new state.YMapLayer({
            id: 'pad-base-yandex-sat-layer',
            source: sourceId,
            type: 'ground',
            zIndex: 1,
            options: {
                raster: {
                    opacity: 1,
                    tileRevealDuration: 0
                }
            }
        });

        state.map.addChild(source);
        state.map.addChild(layer);
    }

    window.PadMapLayers = {
        init: init
    };
})();
