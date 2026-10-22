// pad/mapEngine.js — карта PAD на MapLibre GL JS.
//
// Движок и подложка устроены как в навигаторе: MapLibre + растровый слой
// «Яндекс.Спутник». Тайлы Яндекса отдаются без ключа и в эллипсоидном
// Меркаторе (EPSG:3395), а MapLibre рисует Web Mercator (EPSG:3857),
// поэтому строки тайлов пересчитываются со сдвигом по широте.
//
// Ниже — небольшой адаптер под вызовы Yandex Maps JS API, которые уже
// используются в pad.html, padtext.js, trafficlights.js, recplay.js и
// saveState.js (map.update, map.center, YMapMarker, YMapFeature и т.д.).
// Так редактор PAD продолжает работать без переписывания всей логики.

(function () {
    'use strict';

    const YANDEX_MERC_E = 0.0818191908426;
    const MAX_ZOOM = 21;

    let protocolRegistered = false;

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

    function makeCanvas(w, h) {
        if (typeof OffscreenCanvas !== 'undefined') {
            const c = new OffscreenCanvas(w, h);
            return { canvas: c, ctx: c.getContext('2d'), offscreen: true };
        }
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return { canvas: c, ctx: c.getContext('2d'), offscreen: false };
    }

    async function fetchTileBitmap(url, signal) {
        const res = await fetch(url, { signal: signal, mode: 'cors' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await createImageBitmap(await res.blob());
    }

    async function buildYandexTile(params, abortController) {
        const m = /yandexsat:\/\/sat\/(\d+)\/(\d+)\/(\d+)/.exec((params && params.url) || '');
        if (!m) throw new Error('Некорректный URL тайла Яндекса');
        const z = +m[1], x = +m[2], y = +m[3];
        const n = Math.pow(2, z);
        const worldPx = 256 * n;

        const lat = webRowToLat(256 * y, worldPx);
        const yRow = latToYandexRow(lat, worldPx);
        let srcY = Math.floor(yRow / 256);
        srcY = Math.max(0, Math.min(n - 1, srcY));
        const shiftUp = Math.max(0, Math.min(255.999, yRow - 256 * srcY));

        // Целочисленный сдвиг убирает видимую линию на стыке тайлов.
        const snap = Math.max(0, Math.min(255, Math.round(shiftUp)));

        const base = 'https://core-sat.maps.yandex.net/tiles?l=sat&x=' + x + '&y=';
        const signal = abortController && abortController.signal;
        const secondY = Math.min(n - 1, srcY + 1);
        const images = await Promise.all([
            fetchTileBitmap(base + srcY + '&z=' + z, signal),
            snap > 0
                ? fetchTileBitmap(base + secondY + '&z=' + z, signal).catch(function () { return null; })
                : Promise.resolve(null)
        ]);
        const imgA = images[0], imgB = images[1];

        const c = makeCanvas(256, 256);
        c.ctx.drawImage(imgA, 0, -snap);
        if (imgB) c.ctx.drawImage(imgB, 0, 256 - snap);
        if (imgA.close) imgA.close();
        if (imgB && imgB.close) imgB.close();

        const data = (c.offscreen && typeof c.canvas.transferToImageBitmap === 'function')
            ? c.canvas.transferToImageBitmap()
            : await createImageBitmap(c.canvas);
        return { data: data };
    }

    function registerProtocol() {
        if (protocolRegistered) return;
        if (typeof maplibregl === 'undefined' || !maplibregl.addProtocol) return;
        maplibregl.addProtocol('yandexsat', buildYandexTile);
        protocolRegistered = true;
    }

    function yandexStyle() {
        return {
            version: 8,
            sources: {
                'pad-yandex-sat': {
                    type: 'raster',
                    tiles: ['yandexsat://sat/{z}/{x}/{y}'],
                    tileSize: 256,
                    minzoom: 0,
                    maxzoom: MAX_ZOOM,
                    attribution: '© Яндекс'
                }
            },
            layers: [
                { id: 'pad-yandex-sat', type: 'raster', source: 'pad-yandex-sat' }
            ]
        };
    }

    /* ---------- Маркер ---------- */

    class PadMapMarker {
        constructor(options, element) {
            options = options || {};
            this._options = options;
            this._element = element;
            this._coords = options.coordinates ? [options.coordinates[0], options.coordinates[1]] : [0, 0];
            this._draggable = !!options.draggable;
            this._marker = null;
        }

        update(options) {
            if (!options) return;
            if (options.coordinates) {
                this._coords = [options.coordinates[0], options.coordinates[1]];
                if (this._marker) this._marker.setLngLat(this._coords);
            }
            if (typeof options.draggable === 'boolean') {
                this._draggable = options.draggable;
                if (this._marker) this._marker.setDraggable(this._draggable);
            }
        }

        _add(engine) {
            if (this._marker) return;
            const opts = this._options;
            const marker = new maplibregl.Marker({
                element: this._element,
                anchor: 'center',
                rotationAlignment: 'viewport',
                pitchAlignment: 'viewport',
                draggable: this._draggable,
                // Без этого MapLibre округляет позицию маркера до целых пикселей
                // при каждом setLngLat(). На большом отдалении машинка за кадр
                // смещается меньше пикселя, и округление даёт заметные рывки.
                subpixelPositioning: true
            }).setLngLat(this._coords).addTo(engine._map);
            this._marker = marker;
            if (opts.onDragStart) marker.on('dragstart', function () { try { opts.onDragStart(); } catch (e) {} });
            if (opts.onDragMove) marker.on('drag', function () {
                const ll = marker.getLngLat();
                try { opts.onDragMove([ll.lng, ll.lat]); } catch (e) {}
            });
            if (opts.onDragEnd) marker.on('dragend', function () { try { opts.onDragEnd(); } catch (e) {} });
        }

        _remove() {
            if (this._marker) {
                this._marker.remove();
                this._marker = null;
            }
        }
    }

    /* ---------- Линия ---------- */

    let featureSeq = 0;

    function firstStroke(style) {
        const strokes = style && style.stroke;
        const s = Array.isArray(strokes) ? strokes[0] : null;
        return {
            width: (s && s.width) || 5,
            color: (s && s.color) || '#000000'
        };
    }

    function lineGeoJson(coords) {
        // У LineString должно быть минимум две точки. Пока линия только начата,
        // отдаём пустую коллекцию, иначе MapLibre отвергнет геометрию.
        if (!coords || coords.length < 2) {
            return { type: 'FeatureCollection', features: [] };
        }
        return {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: coords }
        };
    }

    class PadMapFeature {
        constructor(options) {
            options = options || {};
            this._options = options;
            this._id = 'pad-line-' + (++featureSeq);
            const geometry = options.geometry || {};
            this._coords = (geometry.coordinates || []).map(function (c) { return [c[0], c[1]]; });
            this._stroke = firstStroke(options.style);
            this._map = null;
        }

        update(options) {
            if (!options) return;
            if (options.geometry && options.geometry.coordinates) {
                this._coords = options.geometry.coordinates.map(function (c) { return [c[0], c[1]]; });
            }
            if (options.style) this._stroke = firstStroke(options.style);
            if (!this._map) return;
            const source = this._map.getSource(this._id);
            if (source) source.setData(lineGeoJson(this._coords));
            if (this._map.getLayer(this._id)) {
                this._map.setPaintProperty(this._id, 'line-color', this._stroke.color);
                this._map.setPaintProperty(this._id, 'line-width', this._stroke.width);
            }
        }

        _add(engine) {
            if (this._map) return;
            const map = engine._map;
            this._map = map;
            map.addSource(this._id, { type: 'geojson', data: lineGeoJson(this._coords) });
            map.addLayer({
                id: this._id,
                type: 'line',
                source: this._id,
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': this._stroke.color,
                    'line-width': this._stroke.width
                }
            });
        }

        _remove() {
            if (!this._map) return;
            const map = this._map;
            this._map = null;
            try { if (map.getLayer(this._id)) map.removeLayer(this._id); } catch (e) {}
            try { if (map.getSource(this._id)) map.removeSource(this._id); } catch (e) {}
        }
    }

    /* ---------- Слушатель карты ---------- */

    class PadMapListener {
        constructor(options) {
            this._options = options || {};
            this._map = null;
            this._dom = null;
        }

        _add(engine) {
            const map = engine._map;
            const container = map.getContainer();
            const opts = this._options;
            this._map = map;

            if (opts.onUpdate) {
                const onUpdate = function () {
                    const ev = engine._cameraEvent();
                    try { opts.onUpdate(ev, ev); } catch (e) {}
                };
                map.on('move', onUpdate);
                onUpdate();
                (this._cleanup || (this._cleanup = [])).push(function () { map.off('move', onUpdate); });
            }

            const toEvent = function (e) {
                const rect = container.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                let coordinates = null;
                try {
                    const ll = map.unproject([x, y]);
                    coordinates = [ll.lng, ll.lat];
                } catch (err) {}
                return {
                    pointerId: e.pointerId,
                    coordinates: coordinates,
                    screenCoordinates: [e.clientX, e.clientY],
                    originalEvent: e
                };
            };

            const bind = function (type, cb) {
                if (!cb) return;
                const handler = function (e) { const ev = toEvent(e); cb(ev, ev); };
                container.addEventListener(type, handler);
                (this._cleanup || (this._cleanup = [])).push(function () {
                    container.removeEventListener(type, handler);
                });
            }.bind(this);

            bind('pointerdown', opts.onPointerDown);
            bind('pointermove', opts.onPointerMove);
            bind('pointerup', opts.onPointerUp);
            bind('pointercancel', opts.onPointerCancel);
        }

        _remove() {
            (this._cleanup || []).forEach(function (fn) { try { fn(); } catch (e) {} });
            this._cleanup = [];
            this._map = null;
        }
    }

    /* ---------- Карта ---------- */

    class PadMap {
        constructor(container, options) {
            options = options || {};
            registerProtocol();

            const loc = options.location || {};
            const zoomRange = options.zoomRange || {};
            const center = loc.center ? [loc.center[0], loc.center[1]] : [43.9968, 56.3269];

            this._map = new maplibregl.Map({
                container: container,
                style: yandexStyle(),
                center: center,
                zoom: loc.zoom != null ? loc.zoom : 19,
                minZoom: zoomRange.min != null ? zoomRange.min : 0,
                maxZoom: zoomRange.max != null ? zoomRange.max : MAX_ZOOM,
                attributionControl: false,
                dragRotate: false,
                pitchWithRotate: false,
                touchPitch: false,
                fadeDuration: 0
            });

            this._children = [];
            this._pending = [];
            this._ready = false;
            this._queuedMove = null;
            this._queuedDuration = 0;
            this._flushScheduled = false;

            // MapLibre вешает на элемент маркера mousedown с preventDefault —
            // из-за этого в contenteditable-поле не встаёт каретка по клику.
            // Пока поле редактируется, не пускаем mousedown до элемента маркера.
            this._map.getContainer().addEventListener('mousedown', function (e) {
                const target = e.target;
                if (target && target.closest && target.closest('[contenteditable="true"]')) {
                    e.stopPropagation();
                }
            }, true);

            // Стиль готов раньше полной загрузки тайлов: уже можно добавлять
            // источники и слои. Ждём именно style.load, чтобы редактор стал
            // интерактивным, не дожидаясь спутниковых тайлов.
            const onReady = () => {
                if (this._ready) return;
                this._ready = true;
                const q = this._pending;
                this._pending = [];
                q.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
                // После загрузки стиля пересчитываем размеры/повороты маркеров:
                // сцена могла быть восстановлена до готовности карты.
                if (typeof window.updateAllPicMarkers === 'function') {
                    try { window.updateAllPicMarkers(); } catch (e) {}
                }
            };
            this._map.on('style.load', onReady);
            this._map.on('load', onReady);

            this._applyBehaviors(options.behaviors || []);
        }

        get center() {
            const c = this._map.getCenter();
            return [c.lng, c.lat];
        }

        get zoom() {
            return this._map.getZoom();
        }

        // Как в Yandex Maps API 3 — радианы, положительное значение = поворот
        // содержимого карты по часовой стрелке. В MapLibre bearing отсчитывается
        // в градусах в обратную сторону.
        get azimuth() {
            return -this._map.getBearing() * Math.PI / 180;
        }

        get tilt() {
            return this._map.getPitch() * Math.PI / 180;
        }

        _cameraEvent() {
            const c = this._map.getCenter();
            return {
                camera: {
                    center: [c.lng, c.lat],
                    zoom: this._map.getZoom(),
                    azimuth: -this._map.getBearing() * Math.PI / 180,
                    tilt: this._map.getPitch() * Math.PI / 180
                }
            };
        }

        _applyBehaviors(behaviors) {
            const list = Array.isArray(behaviors) ? behaviors : [];
            const on = list.length > 0;
            const m = this._map;
            const h = {
                dragPan: m.dragPan,
                scrollZoom: m.scrollZoom,
                doubleClickZoom: m.doubleClickZoom,
                boxZoom: m.boxZoom,
                dragRotate: m.dragRotate,
                keyboard: m.keyboard,
                touchZoomRotate: m.touchZoomRotate,
                touchPitch: m.touchPitch
            };
            const has = function (name) { return list.indexOf(name) !== -1; };

            if (!on) {
                Object.keys(h).forEach(function (k) { if (h[k]) h[k].disable(); });
                return;
            }

            if (h.dragPan) h.dragPan.enable();
            if (h.scrollZoom) { if (has('scrollZoom')) h.scrollZoom.enable(); else h.scrollZoom.disable(); }
            if (h.doubleClickZoom) { if (has('dblClick')) h.doubleClickZoom.enable(); else h.doubleClickZoom.disable(); }
            if (h.touchZoomRotate) {
                h.touchZoomRotate.enable();
                h.touchZoomRotate.disableRotation();
            }
            if (h.dragRotate) { if (has('mouseRotate')) h.dragRotate.enable(); else h.dragRotate.disable(); }
            if (h.boxZoom) h.boxZoom.disable();
            if (h.keyboard) h.keyboard.disable();
            if (h.touchPitch) h.touchPitch.disable();
        }

        _queueMove(values, duration) {
            if (!this._queuedMove) this._queuedMove = {};
            Object.keys(values).forEach((k) => { this._queuedMove[k] = values[k]; });
            if (duration && duration > this._queuedDuration) this._queuedDuration = duration;
            if (this._flushScheduled) return;
            this._flushScheduled = true;
            Promise.resolve().then(() => this._flushMove());
        }

        _flushMove() {
            this._flushScheduled = false;
            const values = this._queuedMove;
            const duration = this._queuedDuration;
            this._queuedMove = null;
            this._queuedDuration = 0;
            if (!values || !Object.keys(values).length) return;
            if (duration > 0) {
                this._map.easeTo(Object.assign({}, values, { duration: duration }));
            } else {
                this._map.jumpTo(values);
            }
        }

        update(params) {
            if (!params) return;
            if (params.behaviors) this._applyBehaviors(params.behaviors);

            if (params.location) {
                const loc = params.location;
                const values = {};
                if (loc.center) values.center = [loc.center[0], loc.center[1]];
                if (loc.zoom != null) values.zoom = loc.zoom;
                this._queueMove(values, loc.duration);
            }

            if (params.camera) {
                const cam = params.camera;
                const values = {};
                if (cam.center) values.center = [cam.center[0], cam.center[1]];
                if (cam.zoom != null) values.zoom = cam.zoom;
                if (cam.azimuth != null) values.bearing = -cam.azimuth * 180 / Math.PI;
                if (cam.tilt != null) values.pitch = cam.tilt * 180 / Math.PI;
                this._queueMove(values, cam.duration);
            }
        }

        setLocation(location) {
            if (!location) return;
            this.update({ location: location });
        }

        addChild(child) {
            if (!child) return;
            this._children.push(child);
            const add = () => {
                if (this._children.indexOf(child) === -1) return;
                if (child._add) child._add(this);
            };
            if (this._ready) add();
            else this._pending.push(add);
        }

        removeChild(child) {
            if (!child) return;
            const i = this._children.indexOf(child);
            if (i !== -1) this._children.splice(i, 1);
            if (child._remove) child._remove();
        }
    }

    class PadNoopChild {
        _add() {}
        _remove() {}
    }

    const readyValue = {
        YMap: PadMap,
        YMapMarker: PadMapMarker,
        YMapFeature: PadMapFeature,
        YMapListener: PadMapListener,
        YMapDefaultFeaturesLayer: PadNoopChild,
        projections: { sphericalMercator: {} }
    };

    // Стартуем карту после разбора документа: модули padtext/recplay/
    // trafficlights/saveState подключаются ниже по документу, и часть кода
    // инициализации PAD уже рассчитывает на их глобальные переменные.
    // (С Yandex Maps ready приходил асинхронно, поэтому порядок совпадал.)
    const ready = new Promise(function (resolve) {
        const done = function () { resolve(readyValue); };
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            done();
        } else {
            document.addEventListener('DOMContentLoaded', done, { once: true });
        }
    });

    window.ymaps3 = {
        ready: ready,
        YMapMarker: PadMapMarker,
        YMapFeature: PadMapFeature,
        YMapListener: PadMapListener,
        projections: { sphericalMercator: {} }
    };
})();
