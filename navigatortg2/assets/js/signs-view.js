/* Отображение дорожных знаков владельца в навигаторе navigatortg2.
 *
 * Знаки приходят вместе с пакетом корневой папки (owner_bundle) и рисуются
 * слоем MapLibre как композитные иконки: основной знак + таблички + ножка.
 * Логика перенесена из navigator3.
 */
(function (global) {
    'use strict';

    const SIGNS_SOURCE_ID = 'nav-signs';
    const SIGNS_LAYER_ID = 'nav-signs-icons';
    const SIGNS_ENABLED_KEY = 'osm_signs_enabled_v1';
    const SIGNS_REF_PX = 128;
    const SIGNS_DSF = 2;
    const SIGNS_MIN_ZOOM = 13;

    const state = {
        enabled: true,
        catalog: new Map(),
        catalogPromise: null,
        catalogLoaded: false,
        imageCache: new Map(),
        iconCacheBySigns: new WeakMap(),
        buildPromises: new WeakMap(),
        iconGen: 0,
        iconDefs: [],
        features: null,
        sourceData: null,
        seq: 0
    };

    try {
        state.enabled = global.localStorage.getItem(SIGNS_ENABLED_KEY) !== '0';
    } catch (e) {}
    APP._signsEnabled = state.enabled;

    function signItemFor(code, file) {
        const item = state.catalog.get(String(code || ''));
        if (item) return item;
        if (file) return { code: String(code || ''), file: String(file), w: 0, h: 0 };
        return null;
    }

    function comboKey(sign) {
        return [sign.code, (sign.plates || []).join('+'), sign.leg ? '1' : '0'].join('|');
    }

    function loadSignImage(file) {
        const key = String(file || '');
        if (state.imageCache.has(key)) return state.imageCache.get(key);
        const promise = new Promise((resolve, reject) => {
            const img = new Image();
            img.decoding = 'async';
            img.onload = () => resolve(img);
            img.onerror = () => {
                state.imageCache.delete(key);
                reject(new Error('Не загрузился знак: ' + key));
            };
            img.src = 'signs/' + key;
        });
        state.imageCache.set(key, promise);
        return promise;
    }

    function buildComposite(combo, images) {
        const mainImage = images.get(combo.main.file);
        if (!mainImage) return null;

        const ref = SIGNS_REF_PX;
        const dsf = SIGNS_DSF;

        const mainW0 = combo.main.w || mainImage.naturalWidth || 1;
        const mainH0 = combo.main.h || mainImage.naturalHeight || 1;
        const mainAspect = mainW0 / mainH0;
        let mainW, mainH;
        if (mainAspect >= 1) { mainW = ref; mainH = ref / mainAspect; }
        else { mainH = ref; mainW = ref * mainAspect; }

        const plates = [];
        for (const item of combo.plates) {
            const image = images.get(item.file);
            if (!image) continue;
            const w0 = item.w || image.naturalWidth || 1;
            const h0 = item.h || image.naturalHeight || 1;
            const aspect = w0 / h0;
            let w, h;
            if (aspect >= 1) { w = ref; h = ref / aspect; }
            else { h = ref; w = ref * aspect; }
            plates.push({ image, w, h });
        }

        const gap = 2;
        const stackH = mainH + plates.reduce((sum, plate) => sum + plate.h + gap, 0);
        const legW = ref * 0.09;
        const poleBottom = combo.leg ? stackH + ref * 0.6 : stackH;
        const contentTop = mainH / 2;
        const contentBottom = Math.max(mainH / 2, poleBottom - mainH / 2);
        const maxPlateW = plates.reduce((max, plate) => Math.max(max, plate.w), 0);
        const contentHalfW = Math.max(mainW, maxPlateW, legW * 1.56) / 2;
        const pad = 2;
        const halfW = contentHalfW + pad;
        const halfH = Math.max(contentTop, contentBottom) + pad;

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(halfW * 2 * dsf));
        canvas.height = Math.max(1, Math.ceil(halfH * 2 * dsf));
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        const cx = canvas.width / 2;
        const cy = canvas.height / 2;

        if (combo.leg) {
            const topY = cy;
            const bottomY = cy + (poleBottom - mainH / 2) * dsf;
            const poleH = Math.max(1, bottomY - topY);
            const totalW = legW * 1.56 * dsf;
            const poleW = legW * dsf;

            ctx.fillStyle = '#ffffff';
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(cx - totalW / 2, topY, totalW, poleH, totalW / 2);
                ctx.fill();
            } else {
                ctx.fillRect(cx - totalW / 2, topY, totalW, poleH);
            }

            const gradient = ctx.createLinearGradient(cx - poleW / 2, 0, cx + poleW / 2, 0);
            gradient.addColorStop(0, '#6F7378');
            gradient.addColorStop(0.35, '#B8BCC2');
            gradient.addColorStop(0.6, '#8E9298');
            gradient.addColorStop(1, '#6F7378');
            ctx.fillStyle = gradient;
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(cx - poleW / 2, topY, poleW, poleH, poleW / 2);
                ctx.fill();
            } else {
                ctx.fillRect(cx - poleW / 2, topY, poleW, poleH);
            }
        }

        const mainTop = cy - mainH * dsf / 2;
        ctx.drawImage(mainImage, cx - mainW * dsf / 2, mainTop, mainW * dsf, mainH * dsf);

        let y = mainTop + mainH * dsf;
        for (const plate of plates) {
            y += gap * dsf;
            ctx.drawImage(plate.image, cx - plate.w * dsf / 2, y, plate.w * dsf, plate.h * dsf);
            y += plate.h * dsf;
        }

        return canvas;
    }

    async function buildIcons(signs) {
        signs = Array.isArray(signs) ? signs : [];
        if (!signs.length) return { defs: [], features: [] };

        const combos = new Map();
        for (const sign of signs) {
            if (!sign || !sign.code) continue;
            const main = signItemFor(sign.code, sign.file);
            if (!main) continue;
            const plateItems = (sign.plates || [])
                .map(code => signItemFor(code, ''))
                .filter(Boolean);
            const key = comboKey(sign);
            if (!combos.has(key)) {
                combos.set(key, { key, main, plates: plateItems, leg: !!sign.leg });
            }
        }

        const files = new Set();
        for (const combo of combos.values()) {
            files.add(combo.main.file);
            combo.plates.forEach(plate => files.add(plate.file));
        }
        const images = new Map();
        await Promise.all(Array.from(files).map(async file => {
            try {
                images.set(file, await loadSignImage(file));
            } catch (e) {
                console.warn(e);
            }
        }));

        const defs = [];
        const iconByCombo = new Map();
        const generation = ++state.iconGen;
        let index = 0;
        for (const combo of combos.values()) {
            const canvas = buildComposite(combo, images);
            if (!canvas) continue;
            const iconId = 'pad-sign-' + generation + '-' + index++;
            defs.push({ iconId, canvas });
            iconByCombo.set(combo.key, iconId);
        }

        const features = [];
        for (const sign of signs) {
            if (!sign || !sign.code) continue;
            const icon = iconByCombo.get(comboKey(sign));
            if (!icon) continue;
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [Number(sign.lon), Number(sign.lat)] },
                properties: {
                    icon,
                    heading: Number(sign.heading) || 0
                }
            });
        }

        return { defs, features };
    }

    function updateVisibility() {
        const map = APP.map;
        if (!map) return;
        try {
            if (map.getLayer(SIGNS_LAYER_ID)) {
                map.setLayoutProperty(SIGNS_LAYER_ID, 'visibility', state.enabled ? 'visible' : 'none');
            }
        } catch (e) {}
    }

    function applySignsConfig() {
        const toggle = global.document.getElementById('signsToggle');
        state.enabled = !!(toggle && toggle.checked);
        APP._signsEnabled = state.enabled;
        try {
            global.localStorage.setItem(SIGNS_ENABLED_KEY, state.enabled ? '1' : '0');
        } catch (e) {}
        updateVisibility();
    }

    function ensureSignLayers() {
        const map = APP.map;
        if (!map || !state.features) return;
        try {
            const collection = { type: 'FeatureCollection', features: state.features };
            const source = map.getSource(SIGNS_SOURCE_ID);
            if (!source) {
                map.addSource(SIGNS_SOURCE_ID, { type: 'geojson', data: collection });
                state.sourceData = state.features;
            } else if (state.sourceData !== state.features) {
                source.setData(collection);
                state.sourceData = state.features;
            }

            for (const def of state.iconDefs) {
                if (map.hasImage(def.iconId)) continue;
                const ctx = def.canvas.getContext('2d');
                if (!ctx) continue;
                const imageData = ctx.getImageData(0, 0, def.canvas.width, def.canvas.height);
                map.addImage(def.iconId, imageData, { pixelRatio: SIGNS_DSF });
            }

            if (!map.getLayer(SIGNS_LAYER_ID)) {
                map.addLayer({
                    id: SIGNS_LAYER_ID,
                    type: 'symbol',
                    source: SIGNS_SOURCE_ID,
                    minzoom: SIGNS_MIN_ZOOM,
                    layout: {
                        'icon-image': ['get', 'icon'],
                        'icon-rotate': ['get', 'heading'],
                        'icon-rotation-alignment': 'map',
                        'icon-pitch-alignment': 'map',
                        'icon-keep-upright': false,
                        'icon-anchor': 'center',
                        'icon-allow-overlap': true,
                        'icon-ignore-placement': true,
                        'icon-size': ['interpolate', ['exponential', 2], ['zoom'],
                            0, 15 / SIGNS_REF_PX,
                            17, 15 / SIGNS_REF_PX,
                            18, 18.1 / SIGNS_REF_PX,
                            19, 36.2 / SIGNS_REF_PX,
                            20, 72.4 / SIGNS_REF_PX,
                            21, 144.8 / SIGNS_REF_PX
                        ],
                        'visibility': state.enabled ? 'visible' : 'none'
                    }
                });
            } else {
                map.moveLayer(SIGNS_LAYER_ID);
                updateVisibility();
            }
        } catch (e) {
            console.warn('Не удалось добавить слой знаков:', e);
        }
    }

    function ensureCatalog() {
        if (state.catalogLoaded) return Promise.resolve(state.catalog);
        if (!state.catalogPromise) {
            state.catalogPromise = fetch('signs/catalog.json', { cache: 'force-cache' })
                .then(response => (response.ok ? response.json() : []))
                .then(catalog => {
                    state.catalog = new Map(
                        (Array.isArray(catalog) ? catalog : [])
                            .filter(item => item && item.code)
                            .map(item => [String(item.code), item])
                    );
                    state.catalogLoaded = true;
                    return state.catalog;
                })
                .catch(e => {
                    console.warn('Не удалось загрузить каталог знаков:', e);
                    state.catalog = new Map();
                    return state.catalog;
                });
        }
        return state.catalogPromise;
    }

    function clearSigns() {
        state.seq += 1;
        state.features = [];
        state.iconDefs = [];
        const map = APP.map;
        if (map && map.getSource(SIGNS_SOURCE_ID)) {
            try {
                map.getSource(SIGNS_SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
                state.sourceData = state.features;
            } catch (e) {}
        }
    }

    function buildCached(signs) {
        if (state.iconCacheBySigns.has(signs)) {
            return Promise.resolve(state.iconCacheBySigns.get(signs));
        }
        if (state.buildPromises.has(signs)) return state.buildPromises.get(signs);
        const promise = (async () => {
            await ensureCatalog();
            const built = await buildIcons(signs);
            state.iconCacheBySigns.set(signs, built);
            return built;
        })().finally(() => {
            state.buildPromises.delete(signs);
        });
        state.buildPromises.set(signs, promise);
        return promise;
    }

    function preloadOwnerSigns(signs) {
        if (!Array.isArray(signs) || !signs.length) return;
        buildCached(signs).catch(e => console.warn('Не удалось подготовить знаки:', e));
    }

    async function loadSignsForCurrentRoute() {
        const menu = MenuModule;
        const routeM = menu && menu.currentRoute ? menu.currentRoute : '';
        if (!routeM) {
            clearSigns();
            return;
        }
        const signs = menu && typeof menu.getSignsForRoute === 'function'
            ? menu.getSignsForRoute(routeM)
            : [];
        if (!Array.isArray(signs) || !signs.length) {
            clearSigns();
            return;
        }

        const seq = ++state.seq;
        let built;
        try {
            built = await buildCached(signs);
        } catch (e) {
            console.warn('Не удалось подготовить знаки:', e);
            return;
        }
        if (seq !== state.seq) return;
        state.iconDefs = built.defs;
        state.features = built.features;
        ensureSignLayers();
    }

    global.applySignsConfig = applySignsConfig;
    global.ensureSignLayers = ensureSignLayers;
    global.clearSigns = clearSigns;
    global.preloadOwnerSigns = preloadOwnerSigns;
    global.loadSignsForCurrentRoute = loadSignsForCurrentRoute;

    global.document.addEventListener('DOMContentLoaded', () => {
        const toggle = global.document.getElementById('signsToggle');
        if (toggle) toggle.checked = state.enabled;
    });
})(window);
