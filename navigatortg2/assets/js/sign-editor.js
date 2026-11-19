/* Редактор дорожных знаков для navigatortg2.
 *
 * Знаки — личная сцена владельца (одна на Telegram-аккаунт). Редактор ставит
 * знаки в центр видимой части карты, позволяет поворачивать их, добавлять
 * таблички и ножку, затем сохраняет сцену через callApi('signs_save').
 */
(function () {
    'use strict';

    const SIGN_GROUPS = [
        { id: 'warning', title: 'Предупреждающие', short: 'Предупр.' },
        { id: 'priority', title: 'Приоритет', short: 'Приоритет' },
        { id: 'prohibitory', title: 'Запрещающие', short: 'Запрещ.' },
        { id: 'mandatory', title: 'Предписывающие', short: 'Предпис.' },
        { id: 'special', title: 'Особые предписания', short: 'Особые' },
        { id: 'information', title: 'Информационные', short: 'Информ.' },
        { id: 'service', title: 'Сервис', short: 'Сервис' },
        { id: 'additional', title: 'Таблички', short: 'Табл.' }
    ];

    let signsMode = false;
    let signsLoaded = false;
    let signsLoading = false;
    let signsSaving = false;
    let signsDirty = false;

    let signScene = { version: 1, camera: null, markers: [] };
    let signMarkers = [];
    let selectedSign = null;
    let signGroup = 'all';
    let signSearch = '';
    let signPanelMode = 'place';

    let signCatalog = [];
    let signCatalogByCode = new Map();
    let signCatalogPromise = null;
    let signIdSeq = 0;

    const el = id => document.getElementById(id);

    function rawMap() {
        if (typeof map !== 'undefined' && map && map.map) return map.map;
        return window.__osmMap || null;
    }

    function metersPerPixel(lat) {
        const m = rawMap();
        const zoom = Math.min(m ? m.getZoom() : 17, 21);
        return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom + 1);
    }

    function catalogItem(code) {
        return signCatalogByCode.get(String(code || '')) || null;
    }

    function loadSignCatalog() {
        if (signCatalogPromise) return signCatalogPromise;
        signCatalogPromise = fetch('signs/catalog.json', { cache: 'force-cache' })
            .then(response => (response.ok ? response.json() : []))
            .then(list => {
                signCatalog = Array.isArray(list) ? list : [];
                signCatalogByCode = new Map(
                    signCatalog.filter(item => item && item.code).map(item => [String(item.code), item])
                );
                return signCatalog;
            })
            .catch(e => {
                console.warn('Не удалось загрузить каталог знаков:', e);
                signCatalog = [];
                signCatalogByCode = new Map();
                return signCatalog;
            });
        return signCatalogPromise;
    }

    /* ---------- Маркер знака на карте ---------- */
    class EditorSignMarker {
        constructor(data) {
            this.data = {
                id: data.id || ('s' + (++signIdSeq)),
                code: data.code,
                file: data.file,
                lat: Number(data.lat),
                lon: Number(data.lon),
                heading: Number(data.heading) || 0,
                leg: !!data.leg,
                plates: Array.isArray(data.plates) ? data.plates.slice() : []
            };
            this.el = document.createElement('div');
            this.el.className = 'ed-sign-marker';
            this.rot = document.createElement('div');
            this.rot.className = 'ed-sign-rot';
            this.el.appendChild(this.rot);
            this.leg = document.createElement('div');
            this.leg.className = 'ed-sign-leg';
            this.rot.appendChild(this.leg);
            this.main = document.createElement('img');
            this.main.className = 'ed-sign-main';
            this.main.draggable = false;
            this.main.alt = '';
            this.rot.appendChild(this.main);
            this.platesEl = document.createElement('div');
            this.platesEl.className = 'ed-sign-plates';
            this.rot.appendChild(this.platesEl);

            this.main.addEventListener('click', event => {
                event.stopPropagation();
                selectSign(this);
            });
            this.platesEl.addEventListener('click', event => {
                event.stopPropagation();
                selectSign(this);
            });

            this.marker = new maplibregl.Marker({
                element: this.el,
                anchor: 'center',
                draggable: false
            }).setLngLat([this.data.lon, this.data.lat]);

            this.marker.on('dragstart', () => {
                selectSign(this);
                this.el.classList.add('dragging');
            });
            this.marker.on('dragend', () => {
                this.el.classList.remove('dragging');
                const ll = this.marker.getLngLat();
                this.data.lat = ll.lat;
                this.data.lon = ll.lng;
                markDirty();
            });
            this.marker.on('drag', () => {
                const ll = this.marker.getLngLat();
                this.data.lat = ll.lat;
                this.data.lon = ll.lng;
            });

            this.update(true);
        }

        addToMap() {
            const m = rawMap();
            if (!m) return;
            this.marker.addTo(m);
            this.setVisible(signsMode);
        }

        removeFromMap() {
            this.marker.remove();
        }

        setVisible(visible) {
            this.el.style.display = visible ? '' : 'none';
        }

        setSelected(selected) {
            this.el.classList.toggle('selected', !!selected);
        }

        setDraggable(enabled) {
            if (this.marker.setDraggable) this.marker.setDraggable(!!enabled);
            else this.marker._draggable = !!enabled;
        }

        setRotation() {
            const m = rawMap();
            const bearing = m ? m.getBearing() : 0;
            this.rot.style.transform = `rotate(${this.data.heading - bearing}deg)`;
        }

        renderPlates() {
            this.platesEl.replaceChildren();
            for (const code of this.data.plates) {
                const item = catalogItem(code);
                if (!item) continue;
                const img = document.createElement('img');
                img.className = 'ed-sign-plate';
                img.draggable = false;
                img.alt = item.title || code;
                img.dataset.code = code;
                img.src = 'signs/' + item.file;
                img.addEventListener('pointerdown', event => {
                    event.stopPropagation();
                    selectSign(this);
                });
                this.platesEl.appendChild(img);
            }
            this.update(false);
        }

        update(rebuildPlates) {
            const item = catalogItem(this.data.code);
            const mainFile = item ? item.file : this.data.file;
            if (this.main.dataset.file !== mainFile) {
                this.main.dataset.file = mainFile;
                this.main.src = 'signs/' + mainFile;
            }
            if (rebuildPlates) this.renderPlates();

            const mpp = metersPerPixel(this.data.lat);
            const realPx = Math.max(1, 3 / mpp);
            const maxPx = Math.max(15, realPx);
            const aspect = item ? (Number(item.w) || 1) / (Number(item.h) || 1) : 1;
            let mainW, mainH;
            if (aspect >= 1) { mainW = maxPx; mainH = maxPx / aspect; }
            else { mainH = maxPx; mainW = maxPx * aspect; }
            this.main.style.width = mainW + 'px';
            this.main.style.height = mainH + 'px';

            const gap = 2;
            let plateTop = mainH / 2 + gap;
            let maxPlateW = 0;
            let stackBottom = mainH / 2;
            Array.from(this.platesEl.children).forEach(img => {
                const plateItem = catalogItem(img.dataset.code);
                if (!plateItem) return;
                const a = (Number(plateItem.w) || 1) / (Number(plateItem.h) || 1);
                let w, h;
                if (a >= 1) { w = maxPx; h = maxPx / a; }
                else { h = maxPx; w = maxPx * a; }
                img.style.width = w + 'px';
                img.style.height = h + 'px';
                maxPlateW = Math.max(maxPlateW, w);
                stackBottom = plateTop + h;
                plateTop += h + gap;
            });
            this.platesEl.style.top = (mainH / 2 + gap) + 'px';
            this.platesEl.style.width = Math.max(1, maxPlateW) + 'px';

            if (this.data.leg) {
                const legW = Math.max(1.2, realPx * 0.09);
                const poleHeight = Math.max(1, stackBottom + realPx * 0.6);
                this.leg.style.display = '';
                this.leg.style.width = legW + 'px';
                this.leg.style.height = poleHeight + 'px';
                this.leg.style.boxShadow = '0 0 0 ' + (legW * 0.28) + 'px #fff';
            } else {
                this.leg.style.display = 'none';
            }
            this.setRotation();
        }

        serialize() {
            return {
                kind: 'znak',
                code: this.data.code,
                file: this.data.file,
                lat: this.data.lat,
                lon: this.data.lon,
                heading: this.data.heading,
                leg: this.data.leg,
                plates: this.data.plates.slice()
            };
        }
    }

    /* ---------- Состояние и отрисовка панели ---------- */
    function markDirty() {
        signsDirty = true;
        const btn = el('signSaveBtn');
        if (btn) btn.textContent = 'Сохранить знаки •';
    }

    function resetDirty() {
        signsDirty = false;
        const btn = el('signSaveBtn');
        if (btn) btn.textContent = 'Сохранить знаки';
    }

    function selectSign(marker) {
        if (selectedSign === marker) {
            updateSelectionUi();
            return;
        }
        if (selectedSign) {
            selectedSign.setSelected(false);
            selectedSign.setDraggable(false);
        }
        selectedSign = marker || null;
        if (selectedSign) {
            selectedSign.setSelected(true);
            selectedSign.setDraggable(true);
        }
        updateSelectionUi();
    }

    function updateSelectionUi() {
        const bar = el('signSelectedBar');
        const name = el('signSelectedName');
        if (!bar) return;
        bar.hidden = !signsMode || !selectedSign;
        if (!selectedSign) return;
        const item = catalogItem(selectedSign.data.code);
        if (name) name.textContent = item ? (item.code + ' · ' + (item.title || '')) : selectedSign.data.code;
        const legBtn = bar.querySelector('[data-sign-action="leg"]');
        if (legBtn) legBtn.classList.toggle('active', !!selectedSign.data.leg);
        const plateBtn = bar.querySelector('[data-sign-action="plate"]');
        if (plateBtn) plateBtn.classList.toggle('active', signPanelMode === 'plate');
    }

    function renderGroupTabs() {
        const container = el('signGroupTabs');
        if (!container) return;
        container.replaceChildren();
        SIGN_GROUPS.forEach(group => {
            const first = signCatalog.find(item => item.group === group.id);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sign-group-tab' + (signGroup === group.id ? ' active' : '');
            btn.title = group.title;
            if (first) {
                const img = document.createElement('img');
                img.src = 'signs/' + first.file;
                img.alt = '';
                btn.appendChild(img);
            }
            const label = document.createElement('span');
            label.textContent = group.short;
            btn.appendChild(label);
            btn.addEventListener('click', () => {
                signGroup = group.id;
                signSearch = '';
                const input = el('signSearchInput');
                if (input) input.value = '';
                renderCatalog();
            });
            container.appendChild(btn);
        });
    }

    function filteredSigns() {
        const query = signSearch.toLocaleLowerCase('ru-RU');
        if (query) {
            return signCatalog.filter(item => {
                const hay = (item.code + ' ' + (item.title || '')).toLocaleLowerCase('ru-RU');
                return hay.includes(query);
            });
        }
        if (signGroup === 'all') return signCatalog;
        return signCatalog.filter(item => item.group === signGroup);
    }

    function renderCatalogGrid() {
        const grid = el('signCatalogGrid');
        if (!grid) return;
        grid.replaceChildren();
        const items = filteredSigns();
        if (!items.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'width:100%;padding:20px;text-align:center;color:var(--text-tertiary);font-size:13px;';
            empty.textContent = 'Ничего не найдено';
            grid.appendChild(empty);
            return;
        }
        const activePlates = selectedSign ? new Set(selectedSign.data.plates) : new Set();
        items.forEach(item => {
            const cell = document.createElement('div');
            cell.className = 'sign-cell';
            if (signPanelMode === 'plate' && activePlates.has(item.code)) cell.classList.add('active');
            cell.title = item.code + ' — ' + (item.title || '');
            const img = document.createElement('img');
            img.src = 'signs/' + item.file;
            img.alt = '';
            img.loading = 'lazy';
            cell.appendChild(img);
            cell.addEventListener('click', () => {
                if (signPanelMode === 'plate') togglePlate(item);
                else placeSign(item);
            });
            grid.appendChild(cell);
        });
    }

    function renderCatalog() {
        renderGroupTabs();
        renderCatalogGrid();
    }

    function placementCenter() {
        const m = rawMap();
        if (!m) return null;
        const container = m.getContainer();
        const panel = el('signEditorPanel');
        const panelH = panel && !panel.hidden ? panel.getBoundingClientRect().height : 0;
        const x = container.clientWidth / 2;
        const y = Math.max(48, (container.clientHeight - panelH) / 2);
        return m.unproject([x, y]);
    }

    function placeSign(item) {
        const m = rawMap();
        if (!item || !m) return;
        const center = placementCenter();
        if (!center) return;
        const marker = new EditorSignMarker({
            id: 's' + (++signIdSeq),
            code: item.code,
            file: item.file,
            lat: center.lat,
            lon: center.lng,
            heading: m.getBearing(),
            leg: false,
            plates: []
        });
        marker.addToMap();
        signMarkers.push(marker);
        selectSign(marker);
        markDirty();
    }

    function togglePlate(item) {
        if (!selectedSign || !item) return;
        const plates = selectedSign.data.plates;
        const index = plates.findIndex(code => code === item.code);
        if (index >= 0) plates.splice(index, 1);
        else plates.push(item.code);
        selectedSign.renderPlates();
        markDirty();
        renderCatalogGrid();
    }

    function setSignPanelMode(mode) {
        signPanelMode = mode === 'plate' ? 'plate' : 'place';
        const bar = el('signModeBar');
        if (bar) bar.hidden = signPanelMode !== 'plate';
        const plateBtn = document.querySelector('#signSelectedBar [data-sign-action="plate"]');
        if (plateBtn) plateBtn.classList.toggle('active', signPanelMode === 'plate');
        renderCatalogGrid();
    }

    function renderAllSigns() {
        signMarkers.forEach(marker => marker.removeFromMap());
        signMarkers = [];
        selectedSign = null;
        for (const data of signScene.markers || []) {
            const marker = new EditorSignMarker(data);
            marker.addToMap();
            signMarkers.push(marker);
        }
        updateSelectionUi();
    }

    function bindMapEvents() {
        const m = rawMap();
        if (!m || m._signEditorBound) return;
        m._signEditorBound = true;
        m.on('zoom', () => signMarkers.forEach(marker => marker.update(false)));
        m.on('rotate', () => signMarkers.forEach(marker => marker.setRotation()));
    }

    async function ensureSignsLoaded() {
        if (signsLoaded || signsLoading) return;
        signsLoading = true;
        const grid = el('signCatalogGrid');
        if (grid) grid.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-tertiary);font-size:13px;">Загрузка знаков…</div>';
        try {
            const [, response] = await Promise.all([
                loadSignCatalog(),
                callApi('signs_get')
            ]);
            const data = response && response.data;
            signScene = (data && typeof data === 'object')
                ? { version: 1, camera: data.camera || null, markers: Array.isArray(data.markers) ? data.markers : [] }
                : { version: 1, camera: null, markers: [] };
            signsLoaded = true;
            bindMapEvents();
            renderAllSigns();
            renderCatalog();
            resetDirty();
            const camera = signScene.camera;
            const m = rawMap();
            if (m && camera && Array.isArray(camera.center) && camera.center.length >= 2 && Number.isFinite(camera.zoom)) {
                m.jumpTo({ center: camera.center, zoom: camera.zoom });
            }
        } catch (e) {
            console.warn('Не удалось загрузить знаки:', e);
            if (typeof showToast === 'function') showToast('Не удалось загрузить знаки: ' + e.message, 'error', 5000);
            exitSignsMode(true);
        } finally {
            signsLoading = false;
        }
    }

    async function enterSignsMode() {
        if (signsMode) return;
        if (typeof isAdd !== 'undefined' && isAdd && typeof stopAdd === 'function') stopAdd();
        if (typeof isDrawing !== 'undefined' && isDrawing && typeof stopDrawingMode === 'function') {
            try { await stopDrawingMode(); } catch (e) {}
        }
        ['settingsModal', 'folderSettingsModal', 'settingsRouteModal', 'createRouteModal', 'createFolderModal']
            .forEach(id => {
                const node = el(id);
                if (node && node.style.display === 'flex') {
                    try { if (typeof toggleM === 'function') toggleM(id); } catch (e) {}
                }
            });
        signsMode = true;
        document.body.classList.add('signs-mode');
        const panel = el('signEditorPanel');
        if (panel) panel.hidden = false;
        const bar = el('signSelectedBar');
        if (bar) bar.hidden = true;
        signMarkers.forEach(marker => marker.setVisible(true));
        await ensureSignsLoaded();
        if (signMarkers.length) {
            bindMapEvents();
            signMarkers.forEach(marker => marker.update(false));
        }
    }

    function exitSignsMode(force) {
        if (!signsMode) return true;
        if (!force && signsDirty) {
            if (!window.confirm('Несохранённые изменения знаков будут потеряны. Выйти?')) return false;
        }
        signsMode = false;
        document.body.classList.remove('signs-mode');
        const panel = el('signEditorPanel');
        if (panel) panel.hidden = true;
        const bar = el('signSelectedBar');
        if (bar) bar.hidden = true;
        const modeBar = el('signModeBar');
        if (modeBar) modeBar.hidden = true;
        signPanelMode = 'place';
        signMarkers.forEach(marker => marker.setVisible(false));
        selectSign(null);
        return true;
    }

    async function saveSigns() {
        if (!signsLoaded || signsSaving) return;
        const m = rawMap();
        if (!m) return;
        const btn = el('signSaveBtn');
        signsSaving = true;
        if (btn) { btn.disabled = true; btn.textContent = 'Сохранение…'; }
        try {
            const center = m.getCenter();
            const payload = {
                version: 1,
                camera: {
                    center: [center.lng, center.lat],
                    zoom: m.getZoom(),
                    azimuth: -m.getBearing() * Math.PI / 180
                },
                markers: signMarkers.map(marker => marker.serialize())
            };
            const result = await callApi('signs_save', {}, { data: payload });
            signScene = payload;
            resetDirty();
            if (typeof showToast === 'function') {
                showToast('Знаки сохранены' + (result && result.count != null ? ' · ' + result.count : ''), 'success', 2500);
            }
        } catch (e) {
            console.warn('Не удалось сохранить знаки:', e);
            if (typeof showToast === 'function') showToast('Не удалось сохранить знаки: ' + e.message, 'error', 5000);
        } finally {
            signsSaving = false;
            if (btn) { btn.disabled = false; btn.textContent = signsDirty ? 'Сохранить знаки •' : 'Сохранить знаки'; }
        }
    }

    function bindUi() {
        const saveBtn = el('signSaveBtn');
        if (saveBtn) saveBtn.addEventListener('click', saveSigns);

        const searchToggle = el('signSearchToggle');
        if (searchToggle) searchToggle.addEventListener('click', () => {
            const row = el('signSearchRow');
            const input = el('signSearchInput');
            if (!row) return;
            const show = row.hidden;
            row.hidden = !show;
            searchToggle.classList.toggle('active', show);
            if (show && input) input.focus();
            else {
                if (input) input.value = '';
                signSearch = '';
                renderCatalogGrid();
            }
        });

        const searchInput = el('signSearchInput');
        if (searchInput) searchInput.addEventListener('input', () => {
            signSearch = searchInput.value.trim();
            renderCatalogGrid();
        });

        const doneBtn = el('signModeDone');
        if (doneBtn) doneBtn.addEventListener('click', () => setSignPanelMode('place'));

        const selectedBar = el('signSelectedBar');
        if (selectedBar) selectedBar.addEventListener('click', event => {
            const btn = event.target.closest('[data-sign-action]');
            if (!btn || !selectedSign) return;
            const action = btn.dataset.signAction;
            if (action === 'rotate-left' || action === 'rotate-right') {
                selectedSign.data.heading += action === 'rotate-left' ? -15 : 15;
                selectedSign.setRotation();
                markDirty();
            } else if (action === 'plate') {
                setSignPanelMode(signPanelMode === 'plate' ? 'place' : 'plate');
                updateSelectionUi();
            } else if (action === 'leg') {
                selectedSign.data.leg = !selectedSign.data.leg;
                selectedSign.update(false);
                updateSelectionUi();
                markDirty();
            } else if (action === 'delete') {
                selectedSign.removeFromMap();
                signMarkers = signMarkers.filter(marker => marker !== selectedSign);
                selectSign(null);
                markDirty();
            }
        });
    }

    window.toggleSignsMode = function () {
        if (signsMode) exitSignsMode();
        else enterSignsMode();
    };

    // Перед открытием списка маршрутов выходим из режима знаков (там другой
    // набор кнопок и сохранение). Перехватываем раньше inline-обработчика.
    document.addEventListener('click', event => {
        if (!signsMode) return;
        const btn = event.target.closest('#settingsBtn');
        if (!btn) return;
        if (!exitSignsMode()) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);

    bindUi();
})();
