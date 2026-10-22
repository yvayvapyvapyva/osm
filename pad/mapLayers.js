// pad/mapLayers.js — подложки карты PAD.
//
// PAD работает на Yandex Maps JS API 3, но базовые тайлы берутся у MapTiler
// (как в навигаторе): схема, спутник, топо, тёмная и OSM. Отдельным пунктом
// доступен слой Яндекс.Спутника. Тайлы Яндекса отдаются в эллипсоидном
// Меркаторе (EPSG:3395), а карта PAD переведена в Web Mercator (EPSG:3857),
// поэтому слой Яндекса собирается вручную со сдвигом по широте — та же
// поправка, что и в навигаторе.

(function () {
    'use strict';

    const MAPTILER_KEY = 'mveDsz0PeGC3zhA47AdM';

    const MAP_STYLES = {
        sat:         { label: 'Спутник MapTiler', id: 'hybrid-v4',      ext: 'jpg' },
        scheme:      { label: 'Схема',            id: 'streets-v4',     ext: 'png' },
        base:        { label: 'Базовая',          id: 'base-v4',        ext: 'png' },
        topo:        { label: 'Топо',             id: 'topo-v4',        ext: 'png' },
        dark:        { label: 'Тёмная',           id: 'streets-v4-dark', ext: 'png' },
        osm:         { label: 'OSM',              id: 'openstreetmap',  ext: 'png' },
        yandex_sat:  { label: 'Яндекс.Спутник',   yandex: true }
    };

    const STYLE_ORDER = ['sat', 'scheme', 'base', 'topo', 'dark', 'osm', 'yandex_sat'];
    const DEFAULT_STYLE = 'sat';
    const STORAGE_KEY = 'pad_map_style_v1';

    const YANDEX_MERC_E = 0.0818191908426;
    const MAPTILER_ZOOM_MAX = 21;
    const YANDEX_ZOOM_MAX = 21;

    let state = null;
    let currentStyle = readStyle();
    let ui = null;
    let layerSeq = 0;

    function readStyle() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved && MAP_STYLES[saved]) return saved;
        } catch (e) {}
        return DEFAULT_STYLE;
    }

    function saveStyle(styleKey) {
        try { localStorage.setItem(STORAGE_KEY, styleKey); } catch (e) {}
    }

    function maptilerTileUrl(style, x, y, z, scale) {
        const dpr = Math.min(2, Math.max(1, Number(scale) || 1));
        return 'https://api.maptiler.com/maps/' + style.id + '/256/' + z + '/' + x + '/' + y
            + '@' + dpr + 'x.' + style.ext + '?key=' + encodeURIComponent(MAPTILER_KEY);
    }

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
        return await new Promise((resolve, reject) => {
            const img = new Image();
            const objUrl = URL.createObjectURL(blob);
            img.onload = function () { URL.revokeObjectURL(objUrl); resolve(img); };
            img.onerror = function () { URL.revokeObjectURL(objUrl); reject(new Error('Не удалось загрузить тайл')); };
            img.src = objUrl;
        });
    }

    async function fetchMaptilerTile(style, x, y, z, scale, signal) {
        const image = await loadBitmap(maptilerTileUrl(style, x, y, z, scale), signal);
        return { image: image };
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

    function makeSourceAndLayer(styleKey) {
        const style = MAP_STYLES[styleKey];
        const id = 'pad-base-' + styleKey + '-' + (++layerSeq);
        const isYandex = !!style.yandex;
        const source = new state.YMapTileDataSource({
            id: id,
            raster: {
                type: 'ground',
                size: 256,
                fetchTile: isYandex
                    ? fetchYandexTile
                    : function (x, y, z, scale, signal) {
                        return fetchMaptilerTile(style, x, y, z, scale, signal);
                    }
            },
            zoomRange: { min: 0, max: isYandex ? YANDEX_ZOOM_MAX : MAPTILER_ZOOM_MAX },
            clampMapZoom: false,
            copyrights: isYandex
                ? ['© Яндекс']
                : ['© MapTiler', '© OpenStreetMap contributors']
        });
        const layer = new state.YMapLayer({
            id: 'pad-base-layer-' + styleKey + '-' + layerSeq,
            source: id,
            type: 'ground',
            zIndex: 1,
            options: {
                raster: {
                    opacity: 1,
                    tileRevealDuration: 0
                }
            }
        });
        return { source: source, layer: layer };
    }

    function removeCurrentLayer() {
        if (!state || !state.map) return;
        if (state.layer) {
            try { state.map.removeChild(state.layer); } catch (e) {}
            state.layer = null;
        }
        if (state.source) {
            try { state.map.removeChild(state.source); } catch (e) {}
            state.source = null;
        }
    }

    function syncUi() {
        if (!ui) return;
        ui.panel.querySelectorAll('.map-style-item').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.style === state.styleKey);
        });
    }

    function applyStyle(styleKey) {
        if (!state || !state.map || !MAP_STYLES[styleKey]) return;
        if (state.styleKey === styleKey && state.source && state.layer) {
            syncUi();
            return;
        }

        removeCurrentLayer();
        const pair = makeSourceAndLayer(styleKey);
        state.map.addChild(pair.source);
        state.map.addChild(pair.layer);
        state.source = pair.source;
        state.layer = pair.layer;
        state.styleKey = styleKey;
        currentStyle = styleKey;
        saveStyle(styleKey);
        syncUi();
    }

    function injectCss() {
        if (document.getElementById('padMapStyleCss')) return;
        const css = document.createElement('style');
        css.id = 'padMapStyleCss';
        css.textContent = `
            #mapStyleBtn {
                top: calc(204px + env(safe-area-inset-top) + var(--tg-top));
                right: 12px;
            }
            #mapStyleBtn.active { background: rgba(48,209,88,0.5); border-color: #30D158; }
            #mapStylePanel {
                position: fixed;
                top: calc(264px + env(safe-area-inset-top) + var(--tg-top));
                right: 12px;
                z-index: 9005;
                display: none;
                flex-direction: column;
                gap: 3px;
                padding: 6px;
                background: rgba(15,15,15,0.92);
                border: 0.5px solid rgba(255,255,255,0.12);
                border-radius: 14px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.45);
                max-height: calc(100vh - 280px - env(safe-area-inset-bottom));
                overflow-y: auto;
            }
            #mapStylePanel.visible { display: flex; }
            .map-style-item {
                min-width: 158px;
                padding: 10px 14px;
                border: none;
                border-radius: 9px;
                background: transparent;
                color: #fff;
                font: 500 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                text-align: left;
                white-space: nowrap;
                cursor: pointer;
                touch-action: manipulation;
            }
            .map-style-item:active { background: rgba(255,255,255,0.12); }
            .map-style-item.active { background: rgba(48,209,88,0.28); }
            .map-style-item.active::after {
                content: '✓';
                float: right;
                margin-left: 12px;
                color: #30D158;
            }
            body.controls-hidden #mapStylePanel { display: none !important; }
        `;
        document.head.appendChild(css);
    }

    function closePanel() {
        if (!ui) return;
        ui.panel.classList.remove('visible');
        ui.button.classList.remove('active');
    }

    function openPanel() {
        if (!ui) return;
        syncUi();
        ui.panel.classList.add('visible');
        ui.button.classList.add('active');
    }

    function createUi() {
        injectCss();

        const button = document.createElement('button');
        button.id = 'mapStyleBtn';
        button.className = 'fab';
        button.title = 'Слой карты';
        button.setAttribute('aria-label', 'Слой карты');
        button.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/></svg>';
        document.body.appendChild(button);

        const panel = document.createElement('div');
        panel.id = 'mapStylePanel';
        STYLE_ORDER.forEach(function (key) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'map-style-item';
            btn.dataset.style = key;
            btn.textContent = MAP_STYLES[key].label;
            btn.addEventListener('click', function () {
                applyStyle(key);
                closePanel();
            });
            panel.appendChild(btn);
        });
        document.body.appendChild(panel);

        button.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (panel.classList.contains('visible')) closePanel();
            else openPanel();
        });

        document.addEventListener('pointerdown', function (e) {
            if (!panel.classList.contains('visible')) return;
            if (e.target && e.target.closest && e.target.closest('#mapStylePanel, #mapStyleBtn')) return;
            closePanel();
        }, true);

        ui = { button: button, panel: panel };
        syncUi();
    }

    function init(options) {
        if (state) return;
        state = {
            map: options.map,
            YMapTileDataSource: options.YMapTileDataSource,
            YMapLayer: options.YMapLayer,
            source: null,
            layer: null,
            styleKey: null
        };
        createUi();
        applyStyle(currentStyle);
    }

    window.PadMapLayers = {
        init: init,
        applyStyle: applyStyle,
        get style() { return currentStyle; },
        styles: MAP_STYLES
    };
})();
