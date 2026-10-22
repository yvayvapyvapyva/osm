// Менеджер сцен через Яндекс.Облако функцию PAD (YDB, таблица "scene" в базе OSM).
// Сцены общие: привязки к аккаунтам и паролей нет.
//
// Модуль переиспользует serializeScene()/restoreScene() из pad.html, чтобы не
// дублировать логику сериализации линий, объектов и записанных движений машинок.
//
// Кнопка сразу открывает менеджер со списком всех сцен. Из него:
//   - Сохранить   — открывает окно с именем: если ввести существующее имя,
//                   сцена перезаписывается, новое имя — создаётся новая сцена;
//   - Клик по строке сцены — применяет сцену на карту и делает её активной;
//   - Переименовать (иконка) — меняет имя сцены;
//   - Удалить (иконка)       — удаляет сцену.

(function () {
    if (window.sceneIoInit) return;
    window.sceneIoInit = true;

    const API_URL = 'https://functions.yandexcloud.net/d4esfoiand5dinv3mfth';
    const BOT_LINK = 'https://t.me/E_ia_bot/pad';
    const viewOnly = document.documentElement.classList.contains('scene-viewer');
    // Длительность анимации перелёта к камере сохранённой сцены.
    // Мгновенный прыжок camera при холодном кеше спутниковых тайлов даёт
    // рассинхрон растра и слоя элементов на iOS — перелёт это устраняет.
    const SCENE_FLY_MS = 500;

    // Имя активной (загруженной на карту) сцены. null — активной сцены нет.
    let activeSceneName = null;

    // Таймер защитного «poke» камеры после перелёта к камере сцены
    // (см. pokeCamera ниже). Сбрасывается при повторных загрузках.
    let scenePokeTimer = null;

    // Кэш списка сцен. Загружается при запуске приложения и обновляется
    // после сохранения, переименования или удаления сцен.
    let scenesCache = [];
    // Флаги состояния загрузки списка: идёт ли сейчас загрузка и была ли она завершена
    // (успешно или с ошибкой). Нужны, чтобы шторка показывала индикатор загрузки
    // и автоматически обновлялась, когда список наконец загрузится.
    let scenesLoading = false;
    let scenesLoaded = false;

    // ---- Base64URL кодирование для startapp параметра ----
    function b64urlEncode(str) {
        return btoa(unescape(encodeURIComponent(str)))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    async function api(method, { body, query } = {}) {
        let url = API_URL;
        if (query && Object.keys(query).length) {
            const qs = Object.keys(query)
                .filter(k => query[k] != null && query[k] !== '')
                .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
                .join('&');
            if (qs) url += '?' + qs;
        }
        const opts = { method: method, headers: { 'Content-Type': 'application/json' } };
        if (body !== undefined) opts.body = JSON.stringify(body);
        const resp = await fetch(url, opts);
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok || json.ok === false) {
            throw new Error(json.error || ('Ошибка ' + resp.status));
        }
        return json;
    }

    function collectState() {
        const snap = window.serializeScene ? window.serializeScene() : { lines: [], markers: [] };

        const center = map && map.center ? [map.center[0], map.center[1]] : null;

        return {
            app: 'scene-save',
            version: 1,
            savedAt: new Date().toISOString(),
            camera: {
                center: center,
                zoom: map ? map.zoom : null,
                azimuth: (map && map.azimuth != null) ? map.azimuth : (typeof mapRot === 'number' ? mapRot : null)
            },
            lines: snap.lines || [],
            texts: snap.texts || [],
            markers: snap.markers || []
        };
    }

    function defaultName() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return 'scene-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    function sanitizeName(name) {
        return String(name).replace(/[\\/:*?"<>|]/g, '_').trim();
    }

    // ---- Размер в килобайтах ----
    function formatSize(bytes) {
        if (!bytes || bytes <= 0) return '';
        return (bytes / 1024).toFixed(1) + ' КБ';
    }

    // ---- Открыть/закрыть менеджер ----
    let managerEl = null;
    let loadingScene = false;

    function closeManager() {
        if (managerEl) {
            const el = managerEl;
            managerEl = null;
            el.classList.remove('visible');
            el.classList.add('scene-io-closing');
            const btn = document.getElementById('saveBtn');
            if (btn) btn.classList.remove('active');
            setTimeout(() => el.remove(), 650);
        }
    }

    // Доступ из pad.html: закрытие менеджера при нажатии любой кнопки интерфейса
    window.closeSceneManager = closeManager;

    function closeM(el) {
        el.classList.remove('visible');
        setTimeout(() => el.remove(), 200);
    }

    // ---- Растягивание шторки за заголовок (как у ПДД) ----
    function attachSheetDrag(modal) {
        const box = modal.querySelector('.scene-io-box');
        const header = modal.querySelector('.scene-io-header');
        if (!box || !header) return;
        let drag = null;
        header.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.scene-io-close') || e.target.closest('button')) return;
            modal.classList.add('scene-io-dragging');
            drag = { startY: e.clientY, startH: box.offsetHeight };
            header.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        header.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const h = drag.startH + (drag.startY - e.clientY);
            const vh = window.innerHeight;
            box.style.height = Math.min(vh, Math.max(vh * 0.12, h)) + 'px';
        });
        const endDrag = () => { drag = null; modal.classList.remove('scene-io-dragging'); };
        header.addEventListener('pointerup', endDrag);
        header.addEventListener('pointercancel', endDrag);
    }

    // ---- Применение сцены на карту ----
    // Точная установка камеры после анимации: если перелёт был прерван
    // (например, касанием карты), возвращаем финальные центр/зум/азимут.
    function pokeCamera(az) {
        try {
            if (!map || !map.zoom || !map.center) return;
            if (az == null) az = (map.azimuth != null) ? map.azimuth : 0;
            const exact = { center: [map.center[0], map.center[1]], zoom: map.zoom, duration: 0 };
            map.update({ location: exact });
            map.update({ camera: { azimuth: az, duration: 0 } });
        } catch (e) {}
    }

    function applyScene(data, name) {
        const lines = Array.isArray(data.lines) ? data.lines : [];
        const markers = Array.isArray(data.markers) ? data.markers : [];

        const snap = {
            lines: lines.map(l => ({
                coords: Array.isArray(l.coords) ? l.coords.map(c => (Array.isArray(c) ? c.slice() : c)) : [],
                color: l.color || '#000000',
                width: l.width || 5,
                widthM: l.widthM || null
            })),
            texts: (Array.isArray(data.texts) ? data.texts : []).map(t => ({
                lat: t.lat,
                lon: t.lon,
                text: t.text || '',
                collapsed: !!t.collapsed
            })),
            markers: markers.map(m => ({
                kind: m.kind || 'pic',
                file: m.file,
                lat: m.lat,
                lon: m.lon,
                heading: m.heading || 0,
                leg: !!m.leg,
                rec: m.rec || null
            }))
        };

        if (window.restoreScene) {
            window.restoreScene(snap);
            if (window.commit) window.commit();
        }

        if (map && data.camera) {
            try {
                const hasCenter = Array.isArray(data.camera.center) && data.camera.center.length >= 2 && data.camera.zoom != null;
                const hasAz = data.camera.azimuth != null;
                const az = hasAz ? data.camera.azimuth : 0;
                if (hasCenter || hasAz) {
                    // Перелёт к камере сцены. Центр, зум и азимут применяются одним
                    // движением: mapEngine объединяет location и camera в один easeTo.
                    if (hasCenter) map.update({ location: { center: [data.camera.center[0], data.camera.center[1]], zoom: data.camera.zoom, duration: SCENE_FLY_MS } });
                    if (hasAz) map.update({ camera: { azimuth: az, duration: SCENE_FLY_MS } });
                    clearTimeout(scenePokeTimer);
                    // Точная доводка камеры после анимации.
                    scenePokeTimer = setTimeout(() => pokeCamera(hasAz ? az : null), SCENE_FLY_MS + 150);
                }
            } catch (e) {}
        }

        activeSceneName = name || null;
    }

    // ---- Toast-уведомление ----
    function showToast(text, duration) {
        duration = duration || 2000;
        const t = document.createElement('div');
        t.textContent = text;
        t.style.cssText = 'position:fixed;bottom:calc(100px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);'
            + 'z-index:9999;padding:10px 20px;border-radius:10px;font-size:14px;font-weight:600;'
            + 'background:rgba(48,209,88,0.95);color:#fff;pointer-events:none;'
            + 'box-shadow:0 4px 16px rgba(0,0,0,0.4);transition:opacity .3s;white-space:nowrap;';
        document.body.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; }, duration);
        setTimeout(() => t.remove(), duration + 300);
    }

    // ---- Загрузка сцены по ссылке ----
    window.loadSharedScene = async function (sceneName) {
        try {
            const got = await api('GET', { query: { name: sceneName } });
            let data = got.data;
            if (typeof data === 'string') data = JSON.parse(data);
            if (!data) { showToast('Сцена не найдена'); return; }
            applyScene(data, null);
            activeSceneName = null;
        } catch (e) {
            showToast('Ошибка загрузки: ' + e.message);
        }
    };

    // ---- Кодирование deep-link ссылки ----
    window.makeShareLink = function (sceneName) {
        const payload = b64urlEncode(sceneName);
        return BOT_LINK + '?startapp=' + encodeURIComponent(payload);
    };

    // ---- Копирование в буфер + тост ----
    function copyShareLink(sceneName) {
        const link = window.makeShareLink(sceneName);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(link).then(
                () => showToast('Ссылка скопирована в буфер обмена'),
                () => fallbackCopy(link)
            );
        } else {
            fallbackCopy(link);
        }
    }
    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); showToast('Ссылка скопирована в буфер обмена'); }
        catch (e) { showToast('Не удалось скопировать'); }
        ta.remove();
    }

    // ---- Нативное меню «Поделиться» в Telegram ----
    function shareSceneLink(sceneName) {
        const link = window.makeShareLink(sceneName);
        const text = '«' + sceneName + '» на доске дорожных ситуаций';
        const shareUrl = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(text);
        const wa = window.Telegram && window.Telegram.WebApp;
        if (wa && typeof wa.openTelegramLink === 'function') {
            try { wa.openTelegramLink(shareUrl); return; }
            catch (e) { /* fallback ниже */ }
        }
        window.open(shareUrl, '_blank');
    }

    // ---- Окно «Поделиться»: отправить или скопировать ----
    function openSharePopup(sceneName) {
        const overlay = document.createElement('div');
        overlay.className = 'scene-io-modal scene-io-modal-save scene-io-center';
        const box = document.createElement('div');
        box.className = 'scene-io-box';

        const header = document.createElement('div');
        header.className = 'scene-io-header';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'scene-io-close';
        closeBtn.innerHTML = '&#10005;';
        closeBtn.addEventListener('click', () => { closeSharePopup(overlay); });
        const headerTitle = document.createElement('div');
        headerTitle.className = 'scene-io-header-title';
        headerTitle.textContent = 'Поделиться';
        header.appendChild(closeBtn);
        header.appendChild(headerTitle);

        const nameEl = document.createElement('div');
        nameEl.className = 'scene-io-share-title';
        nameEl.textContent = sceneName;

        const send = document.createElement('button');
        send.className = 'scene-io-opt scene-io-share-send';
        send.innerHTML = '<span class="scene-io-share-ic"><svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></span><span>Отправить через Telegram</span>';
        send.addEventListener('click', () => {
            closeSharePopup(overlay);
            shareSceneLink(sceneName);
        });

        const copy = document.createElement('button');
        copy.className = 'scene-io-opt scene-io-share-copy';
        copy.innerHTML = '<span class="scene-io-share-ic"><svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg></span><span>Копировать ссылку</span>';
        copy.addEventListener('click', () => {
            closeSharePopup(overlay);
            copyShareLink(sceneName);
        });

        box.appendChild(header);
        box.appendChild(nameEl);
        box.appendChild(send);
        box.appendChild(copy);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('visible'));
        overlay.addEventListener('click', e => { if (e.target === overlay) closeSharePopup(overlay); });
    }

    function closeSharePopup(overlay) {
        if (!overlay) return;
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 200);
    }

    // ---- Сохранение (интерактив: ввод имени) ----
    function saveWithName({ prefill, callback }) {
        promptBox({
            title: 'Сохранить сцену',
            value: prefill,
            placeholder: 'Имя сцены',
            okText: 'Сохранить',
            onSubmit: async (name, wrap) => {
                await api('POST', { body: { name: name, data: collectState() } });
                closeM(wrap);
                showToast('Сохранено: ' + name);
                if (callback) callback(name);
            }
        });
    }

    // Сохранить в активную сцену (перезапись) или создать новую
    function saveActive() {
        const prefill = activeSceneName || defaultName();
        saveWithName({
            prefill: prefill,
            callback: (name) => {
                activeSceneName = name;
                reloadScenes();
            }
        });
    }

    // ---- Простой prompt-модалка (для переименования) ----
    function promptBox({ title, label, value, placeholder, okText, onSubmit }) {
        const wrap = document.createElement('div');
        wrap.className = 'scene-io-modal scene-io-modal-save scene-io-center';
        const box = document.createElement('div');
        box.className = 'scene-io-box';

        const header = document.createElement('div');
        header.className = 'scene-io-header';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'scene-io-close';
        closeBtn.innerHTML = '&#10005;';
        closeBtn.addEventListener('click', () => closeM(wrap));
        const headerTitle = document.createElement('div');
        headerTitle.className = 'scene-io-header-title';
        headerTitle.textContent = title;
        header.appendChild(closeBtn);
        header.appendChild(headerTitle);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'scene-io-input';
        input.value = value || '';
        input.placeholder = placeholder || label || '';
        input.spellcheck = false;
        input.autocomplete = 'off';

        const ok = document.createElement('button');
        ok.className = 'scene-io-opt';
        ok.textContent = okText || 'ОК';

        const status = document.createElement('div');
        status.className = 'scene-io-status';

        box.appendChild(header);
        box.appendChild(input);
        box.appendChild(ok);
        box.appendChild(status);
        wrap.appendChild(box);
        wrap.addEventListener('click', e => { if (e.target === wrap) closeM(wrap); });
        document.body.appendChild(wrap);
        requestAnimationFrame(() => {
            wrap.classList.add('visible');
            input.focus();
            input.select();
        });

        const submit = () => {
            const val = sanitizeName(input.value);
            if (!val) { status.textContent = 'Введите имя'; return; }
            ok.disabled = true;
            onSubmit(val, wrap).catch(e => {
                status.textContent = 'Ошибка: ' + e.message;
                ok.disabled = false;
            });
        };

        ok.addEventListener('click', submit);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
    }

    // ---- Конфирм (для удаления) ----
    function confirmBox({ title, message, okText, onOk }) {
        const wrap = document.createElement('div');
        wrap.className = 'scene-io-modal scene-io-modal-save scene-io-center';
        const box = document.createElement('div');
        box.className = 'scene-io-box';

        const header = document.createElement('div');
        header.className = 'scene-io-header';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'scene-io-close';
        closeBtn.innerHTML = '&#10005;';
        closeBtn.addEventListener('click', () => closeM(wrap));
        const headerTitle = document.createElement('div');
        headerTitle.className = 'scene-io-header-title';
        headerTitle.textContent = title;
        header.appendChild(closeBtn);
        header.appendChild(headerTitle);

        const msg = document.createElement('div');
        msg.className = 'scene-io-confirm-msg';
        msg.textContent = message;

        const ok = document.createElement('button');
        ok.className = 'scene-io-opt scene-io-danger';
        ok.textContent = okText || 'Удалить';

        box.appendChild(header);
        box.appendChild(msg);
        box.appendChild(ok);
        wrap.appendChild(box);
        wrap.addEventListener('click', e => { if (e.target === wrap) closeM(wrap); });
        document.body.appendChild(wrap);
        requestAnimationFrame(() => wrap.classList.add('visible'));

        ok.addEventListener('click', async () => {
            ok.disabled = true;
            try {
                await onOk();
                closeM(wrap);
            } catch (e) {
                ok.disabled = false;
                msg.textContent = 'Ошибка: ' + e.message;
            }
        });
    }

    // ---- Менеджер сцен ----

    // Загрузка списка сцен в кэш. Возвращает отсортированный список.
    // Управляет состоянием загрузки и, если шторка открыта, автоматически
    // перерисовывает её по завершении (даже если это первая загрузка при старте).
    async function loadScenes() {
        if (scenesLoading) return scenesCache;
        scenesLoading = true;
        setLoadingUI();
        try {
            const json = await api('GET', {});
            scenesCache = (json.scenes || [])
                .slice()
                .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        } catch (e) {
            scenesCache = [];
        } finally {
            scenesLoading = false;
            scenesLoaded = true;
            refreshManager();
        }
        return scenesCache;
    }

    // Общий конструктор строки списка
    function makeRow(scene, statusEl) {
        const row = document.createElement('div');
        row.className = 'scene-io-item' + (activeSceneName === scene.name ? ' active' : '');
        row.addEventListener('click', () => loadScene(scene, statusEl));
        const main = document.createElement('div');
        main.className = 'scene-io-item-main';
        const left = document.createElement('div');
        left.className = 'scene-io-item-left';
        const nm = document.createElement('div');
        nm.className = 'scene-io-item-name';
        nm.textContent = scene.name;
        left.appendChild(nm);
        const meta = document.createElement('div');
        meta.className = 'scene-io-item-meta';
        const parts = [];
        if (scene.sizeBytes) parts.push(formatSize(scene.sizeBytes));
        if (scene.savedAt) parts.push(new Date(scene.savedAt).toLocaleString());
        meta.textContent = parts.join(' · ');
        left.appendChild(meta);
        main.appendChild(left);
        const btns = document.createElement('div');
        btns.className = 'scene-io-item-btns';
        const mkBtn = (title, svg, onClick) => {
            const b = document.createElement('button');
            b.className = 'scene-io-item-btn';
            b.title = title;
            b.setAttribute('aria-label', title);
            b.innerHTML = svg;
            b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            return b;
        };
        if (!viewOnly) {
            btns.appendChild(mkBtn('Переименовать',
                '<svg viewBox="0 0 24 24" width="18" height="18" fill="#FFD60A"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
                () => renameScene(scene, statusEl)));
            btns.appendChild(mkBtn('Поделиться',
                '<svg viewBox="0 0 24 24" width="18" height="18" fill="#0A84FF"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>',
                () => openSharePopup(scene.name)));
            btns.appendChild(mkBtn('Удалить',
                '<svg viewBox="0 0 24 24" width="18" height="18" fill="#FF453A"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM8 9h8v10H8V9zm.5-5l1-1h5l1 1H20v2H4V4h4.5z"/></svg>',
                () => deleteScene(scene, statusEl)));
            main.appendChild(btns);
        }
        row.appendChild(main);
        const loading = document.createElement('div');
        loading.className = 'scene-io-item-loading';
        loading.innerHTML = '<span class="scene-io-spinner"></span><span>Загрузка сцены…</span>';
        row.appendChild(loading);
        return row;
    }

    function openManager() {
        if (managerEl) { managerEl.classList.add('visible'); return; }

        const modal = document.createElement('div');
        modal.className = 'scene-io-modal scene-io-sheet';
        const box = document.createElement('div');
        box.className = 'scene-io-box';

        const header = document.createElement('div');
        header.className = 'scene-io-header';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'scene-io-close';
        closeBtn.innerHTML = '&#10005;';
        closeBtn.addEventListener('click', closeManager);
        const headerTitle = document.createElement('div');
        headerTitle.className = 'scene-io-header-title';
        headerTitle.textContent = 'Сцены';
        header.appendChild(closeBtn);
        header.appendChild(headerTitle);

        // Кнопка сохранения
        let saveBtn = null;
        if (!viewOnly) {
            saveBtn = document.createElement('button');
            saveBtn.className = 'scene-io-opt scene-io-primary';
            saveBtn.innerHTML = '<span class="scene-io-opt-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M12 16l-5-5h3V4h4v7h3l-5 5zm-7 3h14v2H5v-2z"/></svg></span><span>Сохранить текущую сцену</span>';
            saveBtn.addEventListener('click', saveActive);
        }

        const listBody = document.createElement('div');
        listBody.className = 'scene-io-list';

        const status = document.createElement('div');
        status.className = 'scene-io-status busy';
        status.textContent = 'Загрузка списка…';

        box.appendChild(header);
        box.appendChild(listBody);
        box.appendChild(status);
        if (saveBtn) box.appendChild(saveBtn);
        modal.appendChild(box);
        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) closeManager(); });
        requestAnimationFrame(() => modal.classList.add('visible'));
        managerEl = modal;
        attachSheetDrag(modal);
        const btn = document.getElementById('saveBtn');
        if (btn) btn.classList.add('active');

        refreshManager();
        if (!scenesLoaded) {
            // Список ещё ни разу не загружался (например, SDK Telegram не
            // инициализировался в обычном браузере) — грузим сейчас, иначе
            // шторка покажет ложное «Нет ни одной сцены». Если загрузка уже
            // идёт, loadScenes не запустит вторую и сам перерисует список
            // по завершении через refreshManager.
            loadScenes();
        }
    }

    async function loadScene(scene, statusEl) {
        if (loadingScene) return;
        loadingScene = true;
        const rows = managerEl ? managerEl.querySelectorAll('.scene-io-item') : [];
        rows.forEach(r => { r.classList.add('disabled'); if (r.querySelector('.scene-io-item-name').textContent === scene.name) r.classList.add('loading'); });
        statusEl.classList.add('busy');
        statusEl.textContent = 'Загрузка: ' + scene.name + '…';
        try {
            const got = await api('GET', { query: { name: scene.name } });
            let data = got.data;
            if (typeof data === 'string') data = JSON.parse(data);
            applyScene(data || got, scene.name);
            rows.forEach(r => {
                const nm = r.querySelector('.scene-io-item-name').textContent;
                r.classList.toggle('active', nm === scene.name);
                r.classList.remove('loading');
            });
            statusEl.classList.remove('busy');
            statusEl.textContent = 'Загружено: ' + scene.name;
            if (typeof window.sendSceneReport === 'function') {
                window.sendSceneReport(scene.name);
            }
            closeManager();
            if (viewOnly) {
                window.setTimeout(() => {
                    const playBtn = document.getElementById('playAllBtn');
                    if (playBtn) playBtn.click();
                }, SCENE_FLY_MS + 100);
            }
        } catch (e) {
            rows.forEach(r => r.classList.remove('loading'));
            statusEl.classList.remove('busy');
            statusEl.textContent = 'Ошибка: ' + e.message;
        } finally {
            loadingScene = false;
            rows.forEach(r => r.classList.remove('disabled'));
        }
    }

    async function renameScene(scene, statusEl) {
        promptBox({
            title: 'Переименовать сцену',
            label: 'Новое имя',
            value: scene.name,
            placeholder: 'Новое имя сцены',
            okText: 'Переименовать',
            onSubmit: async (newName, wrap) => {
                await api('PUT', { body: { name: newName, from: scene.name } });
                if (activeSceneName === scene.name) activeSceneName = newName;
                closeM(wrap);
                reloadScenes();
            }
        });
    }

    async function deleteScene(scene, statusEl) {
        confirmBox({
            title: 'Удалить сцену',
            message: 'Удалить сцену «' + scene.name + '» без возможности восстановления?',
            okText: 'Удалить',
            onOk: async () => {
                await api('DELETE', { query: { name: scene.name } });
                if (activeSceneName === scene.name) activeSceneName = null;
                reloadScenes();
            }
        });
    }

    // Показать состояние загрузки в открытой шторке (если она есть)
    function setLoadingUI() {
        if (!managerEl) return;
        const listBody = managerEl.querySelector('.scene-io-list');
        const status = managerEl.querySelector('.scene-io-status');
        if (!listBody || !status) return;
        listBody.innerHTML = '';
        status.classList.add('busy');
        status.textContent = 'Загрузка списка…';
        const row = document.createElement('div');
        row.className = 'scene-io-loading';
        row.innerHTML = '<span class="scene-io-spinner"></span><span>Загрузка сцен…</span>';
        listBody.appendChild(row);
    }

    // Обновить список в менеджере из кэша без пересоздания окна.
    // Пока идёт загрузка — показывает индикатор и надпись, затем — сам список.
    function refreshManager() {
        if (!managerEl) return;
        const listBody = managerEl.querySelector('.scene-io-list');
        const status = managerEl.querySelector('.scene-io-status');
        listBody.innerHTML = '';
        if (scenesLoading) {
            setLoadingUI();
            return;
        }
        status.classList.remove('busy');
        status.textContent = scenesCache.length ? '' : 'Нет ни одной сцены';
        scenesCache.forEach(s => listBody.appendChild(makeRow(s, status)));
    }

    // Обновить кэш сцен и, если шторка открыта, перерисовать список.
    // Вызывается после сохранения, переименования или удаления.
    async function reloadScenes() {
        await loadScenes();
        refreshManager();
    }

    // ---- Кнопка ----
    function init() {
        const group = document.createElement('div');
        group.id = 'savePddGroup';
        const pddBtn = document.getElementById('pddBtn');
        if (pddBtn) group.appendChild(pddBtn);
        document.body.appendChild(group);

        const btn = document.createElement('button');
        btn.id = 'saveBtn';
        btn.className = 'fab';
        btn.title = 'Сцены';
        btn.setAttribute('aria-label', 'Сцены');
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M5,3A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5.5L18.5,3H17V9A1,1 0 0,1 16,10H8A1,1 0 0,1 7,9V3H5M12,4V9H15V4H12M7,12H17A1,1 0 0,1 18,13V19H6V13A1,1 0 0,1 7,12Z"/></svg>';
        btn.addEventListener('click', () => {
            if (managerEl && managerEl.classList.contains('visible')) closeManager();
            else openManager();
        });
        group.appendChild(btn);

        const css = document.createElement('style');
        css.textContent = '#savePddGroup{position:fixed;top:calc(12px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;z-index:9006;pointer-events:none;touch-action:manipulation;}'
            + '#savePddGroup > *{pointer-events:auto;}'
            + '#savePddGroup #pddBtn{position:static;left:auto;transform:none;height:52px;}'
            + '#savePddGroup #pddBtn:active{transform:scale(0.92);}'
            + '#saveBtn { top:auto; right:auto; position:static; height:52px; width:52px; border-radius:26px; }'
            + '#saveBtn.active { background:rgba(48,209,88,0.5); border-color:#30D158; }'
            + '@keyframes sceneIoSlideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}'
            + '.scene-io-modal{position:fixed;inset:0;z-index:9500;background:transparent;pointer-events:none;display:flex;align-items:flex-end;justify-content:center;padding:0;opacity:0;visibility:hidden;transition:opacity .3s ease,visibility .3s;-webkit-tap-highlight-color:transparent;}'
            + '.scene-io-modal.visible{opacity:1;visibility:visible;}'
            + '.scene-io-modal.scene-io-sheet{pointer-events:none;}'
            + '.scene-io-box{pointer-events:auto;width:100%;max-width:100%;background:linear-gradient(180deg,rgba(30,30,30,0.98) 0%,rgba(18,18,18,1) 100%);border-radius:20px 20px 0 0;border-top:0.5px solid rgba(255,255,255,0.1);padding:0 0 env(safe-area-inset-bottom) 0;display:flex;flex-direction:column;gap:0;transform:translateY(100%);transition:transform .35s cubic-bezier(.32,.72,0,1);max-height:88vh;overflow:hidden;box-shadow:0 -8px 40px rgba(0,0,0,0.5);}'
            + '.scene-io-modal.visible .scene-io-box{transform:translateY(0);}'
            + '.scene-io-modal.scene-io-closing{transition:opacity .6s ease,visibility .6s;}'
            + '.scene-io-modal.scene-io-closing .scene-io-box{transition:transform .6s cubic-bezier(.32,.72,0,1);}'
            + '.scene-io-modal.scene-io-center{background:rgba(0,0,0,0.6);pointer-events:auto;display:flex;align-items:center;justify-content:center;padding:24px;}'
            + '.scene-io-modal.scene-io-center .scene-io-box{width:100%;max-width:320px;border-radius:16px;border:0.5px solid rgba(255,255,255,0.12);padding:12px 16px 16px;gap:12px;transform:translateY(0) scale(0.95);transition:transform .2s ease;max-height:85vh;box-shadow:0 20px 60px rgba(0,0,0,0.5);}'
            + '.scene-io-modal.scene-io-center.visible .scene-io-box{transform:translateY(0) scale(1);}'
            + '.scene-io-modal.scene-io-center .scene-io-input{margin:0;}'
            + '.scene-io-modal.scene-io-center .scene-io-header{padding:0 0 6px;}'
            + '.scene-io-modal.scene-io-center .scene-io-opt{width:100%;margin:0;}'
            + '.scene-io-modal.scene-io-center .scene-io-cancel{width:100%;margin:0;border-radius:12px;}'
            + '.scene-io-modal.scene-io-center .scene-io-confirm-msg{padding:0 4px 4px;}'
            + '.scene-io-status:empty{display:none;}'
            + '.scene-io-header{display:flex;align-items:center;gap:8px;padding:10px 10px 8px;border-bottom:0.5px solid rgba(255,255,255,0.1);flex-shrink:0;touch-action:none;user-select:none;-webkit-user-select:none;}'
            + '.scene-io-header-title{font-size:16px;font-weight:700;flex:1;text-align:center;color:#fff;letter-spacing:-0.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
            + '.scene-io-close{width:30px;height:30px;border-radius:50%;border:0.5px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:#fff;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;touch-action:manipulation;flex-shrink:0;margin-left:auto;order:2;}'
            + '.scene-io-header-title{order:1;}'
            + '.scene-io-close:active{background:rgba(255,255,255,0.15);}'
            + '.scene-io-title{font-size:17px;font-weight:700;color:#fff;text-align:center;padding:14px 16px 10px;letter-spacing:-0.3px;flex-shrink:0;}'
            + '.scene-io-header{padding:10px 10px 8px;}'
            + '.scene-io-opt{display:flex;align-items:center;justify-content:center;gap:8px;width:calc(100% - 32px);margin:0 16px;padding:15px;border:none;border-radius:14px;background:rgba(255,255,255,0.07);color:#fff;font-size:15px;font-weight:500;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:all .2s ease;letter-spacing:-0.2px;flex-shrink:0;}'
            + '.scene-io-opt:active{background:rgba(255,255,255,0.14);transform:scale(0.98);}'
            + '.scene-io-opt:disabled{opacity:0.5;}'
            + '.scene-io-opt-icon{width:22px;height:22px;flex-shrink:0;}'
            + '.scene-io-cancel{padding:14px;border:none;border-radius:12px;background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.6);font-size:15px;font-weight:500;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;width:calc(100% - 32px);margin:0 16px;transition:all .2s ease;letter-spacing:-0.2px;flex-shrink:0;}'
            + '.scene-io-cancel:active{background:rgba(255,255,255,0.12);transform:scale(0.98);}'
            + '.scene-io-input{width:100%;padding:14px 16px;border-radius:14px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.06);color:#fff;font-size:16px;outline:none;margin:10px 0;user-select:text;-webkit-user-select:text;-webkit-tap-highlight-color:transparent;transition:border-color .2s ease;flex-shrink:0;}'
            + '.scene-io-input:focus{border-color:rgba(48,209,88,0.6);background:rgba(255,255,255,0.08);}'
            + '.scene-io-status{min-height:20px;font-size:13px;color:rgba(255,255,255,0.4);text-align:center;padding:4px 16px;flex-shrink:0;}'
            + '.scene-io-status.busy{color:#FFD60A;}'
            + '.scene-io-status.ok{color:#30D158;}'
            + '.scene-io-loading{display:flex;align-items:center;justify-content:center;gap:10px;padding:24px 16px;color:rgba(255,255,255,0.55);font-size:14px;min-height:80px;}'
            + '.scene-io-spinner{width:18px;height:18px;border-radius:50%;border:2px solid rgba(255,255,255,0.2);border-top-color:#FFD60A;animation:sceneIoSpin .8s linear infinite;flex-shrink:0;}'
            + '@keyframes sceneIoSpin{to{transform:rotate(360deg);}}'
            + '.scene-io-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;flex:1 1 auto;min-height:0;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:8px 16px;}'
            + '.scene-io-list::-webkit-scrollbar{display:none;}'
            + '.scene-io-item{display:flex;flex-direction:column;gap:2px;padding:14px 16px;border:none;border-radius:14px;background:rgba(255,255,255,0.05);color:#fff;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;min-height:56px;transition:background .15s ease,transform .12s ease,border-color .2s ease;border:1px solid transparent;}'
            + '.scene-io-item:active{background:rgba(255,255,255,0.18);}'
            + '.scene-io-item.active{background:rgba(48,209,88,0.12);border-color:rgba(48,209,88,0.5);}'
            + '.scene-io-item.active:active{background:rgba(48,209,88,0.22);}'
            + '.scene-io-item-main{display:flex;align-items:center;justify-content:space-between;gap:10px;}'
            + '.scene-io-item-left{flex:1;min-width:0;}'
            + '.scene-io-item-name{font-size:15px;font-weight:600;word-break:break-all;letter-spacing:-0.2px;}'
            + '.scene-io-item-meta{font-size:12px;color:rgba(255,255,255,0.35);margin-top:3px;}'
            + '.scene-io-item.active .scene-io-item-meta{color:rgba(48,209,88,0.7);}'
            + '.scene-io-item-btns{display:flex;gap:6px;flex-shrink:0;}'
            + '.scene-io-item-loading{display:none;align-items:center;gap:8px;font-size:13px;color:rgba(255,255,255,0.7);padding:4px 0 2px;}'
            + '.scene-io-item.loading .scene-io-item-loading{display:flex;}'
            + '.scene-io-item.disabled{opacity:0.55;pointer-events:none;}'
            + '.scene-io-item.loading{border-color:rgba(255,214,10,0.5);}'
            + '.scene-io-item-btn{width:40px;height:40px;border:none;border-radius:10px;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;padding:0;user-select:none;-webkit-user-select:none;transition:all .15s ease;}'
            + '.scene-io-item-btn:active{background:rgba(255,255,255,0.15);transform:scale(0.9);}'
            + '.scene-io-modal-save{z-index:9600;}'
            + '.scene-io-modal.scene-io-dragging .scene-io-box{transition:none;}'
            + '.scene-io-confirm-msg{font-size:15px;color:rgba(255,255,255,0.75);text-align:center;padding:14px 24px 16px;line-height:1.5;user-select:none;-webkit-user-select:none;}'
            + '.scene-io-opt.scene-io-danger{background:rgba(255,69,58,0.15);color:#FF453A;}'
            + '.scene-io-opt.scene-io-danger:active{background:rgba(255,69,58,0.25);}'
            + '.scene-io-opt.scene-io-primary{background:rgba(48,209,88,0.9);color:#000;margin:12px 16px calc(12px + env(safe-area-inset-bottom));}'
            + '.scene-io-opt.scene-io-primary:active{background:rgba(48,209,88,1);}'
            + '.scene-io-opt.scene-io-primary:disabled{background:rgba(48,209,88,0.5);}'
            + '.scene-io-opt.scene-io-primary .scene-io-opt-icon svg{fill:#000;}'
            + '.scene-io-share-title{font-size:15px;color:rgba(255,255,255,0.75);text-align:center;padding:2px 4px 8px;line-height:1.4;word-break:break-word;}'
            + '.scene-io-share-ic{width:22px;height:22px;flex-shrink:0;display:flex;align-items:center;justify-content:center;}'
            + '.scene-io-opt.scene-io-share-send{background:rgba(48,209,88,0.9);color:#000;}'
            + '.scene-io-opt.scene-io-share-send:active{background:rgba(48,209,88,1);}'
            + '.scene-io-opt.scene-io-share-send .scene-io-share-ic svg{fill:#000;}'
            + '.scene-io-opt.scene-io-share-copy{background:rgba(255,255,255,0.08);}'
            + '.scene-io-opt.scene-io-share-copy:active{background:rgba(255,255,255,0.15);}';
        document.head.appendChild(css);

        function startLoadScenes() {
            if (scenesLoading || scenesLoaded) return;
            loadScenes();
        }
        if (window._tgInitDone) {
            startLoadScenes();
        } else if (typeof window.onTgReady === 'function') {
            window.onTgReady(startLoadScenes);
            // Резерв: если SDK Telegram так и не загрузился (открыто в обычном
            // браузере, telegram.org недоступен/заблокирован), всё равно загружаем
            // общий список сцен. Иначе загрузка на старте остаётся невыполненной.
            setTimeout(startLoadScenes, 6000);
        } else {
            startLoadScenes();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
