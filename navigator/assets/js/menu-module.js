
const MenuModule = {
    callback: null,
    isLoaded: false,
    currentRoute: null,
    routesDescriptions: {}, // { "m": { name, description, m, data } }
    _routesLoaded: false,   // список с геометрией уже получен
    _isFetchingRoutes: false,
    _categoryTree: null,
    _expandedFolders: new Set(),

    // URL Яндекс-функции OSM-версии (отдельная БД dbosm)
    API_URL_V2: 'https://functions.yandexcloud.net/d4e02ghbv31h6kpf8ddh',

    /**
     * Универсальное получение параметров URL.
     * Поддерживается формат: #m=<m>, ?m=<m> и #/path?m=<m>.
     */
    getUrlParam(name) {
        if (name !== 'm') return null;

        // Проверка query-строки URL
        let value = new URLSearchParams(window.location.search).get(name);
        if (value) return value;

        // Проверка hash
        const hash = window.location.hash.slice(1);
        if (hash) {
            const hashParams = new URLSearchParams(hash);
            value = hashParams.get(name);
            if (value) return value;

            // Формат: #/path?m=<m>
            const hashQueryIndex = hash.indexOf('?');
            if (hashQueryIndex > -1) {
                const hashQuery = hash.substring(hashQueryIndex + 1);
                const hashQueryParams = new URLSearchParams(hashQuery);
                value = hashQueryParams.get(name);
                if (value) return value;
            }
        }

        return null;
    },

    // Инициализация
    async init(onRouteLoaded) {
        this.callback = onRouteLoaded;
        this.createModal();
        this.createButton();
        this.hide();

        // Загружаем список маршрутов динамически
        await this._loadRoutesList();

        // Проверяем параметры сразу и при получении данных от VK Bridge
        this.checkUrlParam();

        // Подписка на события VK Bridge для параметров запуска
        if (typeof vkBridge !== 'undefined') {
            vkBridge.subscribe((event) => {
                if (!this.isLoaded && (event && event.type === 'VKWebAppUpdateConfig' || event.detail)) {
                    this.checkUrlParam();
                }
            });

            // Пробуем получить параметры из launchParams
            try {
                vkBridge.send('VKWebAppGetLaunchParams')
                    .then(params => {
                        if (!this.isLoaded && params && params.m) {
                            this.isLoaded = true;
                            this.hide();
                            this.loadRouteByName(params.m);
                        }
                    })
                    .catch(e => {});
            } catch (e) {
            }
        }

        // Проверка start_param от Telegram Mini App (на конкретный маршрут)
        if (typeof Telegram !== 'undefined' && Telegram.WebApp) {
            try {
                const startParam = Telegram.WebApp.initDataUnsafe?.start_param;
                if (startParam && !this.isLoaded && startParam.startsWith('m=')) {
                    const mValue = startParam.substring(2);
                    if (mValue) {
                        this.isLoaded = true;
                        this.hide();
                        this.loadRouteByName(mValue);
                    }
                }
            } catch (e) {}
        }
    },

    /**
     * Загрузка списка маршрутов из Яндекс-функции
     */
    async _loadRoutesList() {
        if (this._isFetchingRoutes) return;
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
        this._isFetchingRoutes = true;

        const container = document.getElementById('routesListContainer');

        // Показываем индикацию сразу: полный список с геометрией — ~80 КБ,
        // на медленной сети это заметно.
        this._showListLoading();

        const showLoadError = () => {
            if (container) {
                container.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;gap:12px;">
                        <div class="spinner-ring" style="width:28px;height:28px;border-width:3px;"></div>
                        <div style="color:rgba(255,255,255,0.5);font-size:14px;">Не удалось загрузить. Повторяем...</div>
                    </div>
                `;
            }
        };

        const attempt = async () => {
            try {
                await this._fetchFromAPI();
                this._routesLoaded = true;
                this._expandCurrentRoutePath();
                this._buildRoutesList();
                return true;
            } catch (e) {
                console.warn('Не удалось загрузить список маршрутов:', e);
                showLoadError();
                return false;
            }
        };

        const ok = await attempt();
        if (!ok) {
            this._isFetchingRoutes = false;
            this._retryTimer = setTimeout(() => this._loadRoutesList(), 5000);
        } else {
            this._isFetchingRoutes = false;
        }
    },

    /**
     * Запрос к Яндекс-функции за списком маршрутов
     */
    async _fetchFromAPI() {
        // full=1: геометрия всех видимых маршрутов одним запросом — при выборе
        // маршрута из каталога сетевые запросы уже не нужны.
        const response = await fetch(`${this.API_URL_V2}?action=list_routes&full=1`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        const routesFlat = {};

        for (const route of data) {
            const key = route.m;
            if (!key) continue;
            routesFlat[key] = {
                m: route.m,
                name: route.name || route.m,
                description: route.description || '',
                data: route.data
            };
        }

        this.routesDescriptions = routesFlat;
        this._categoryTree = this._buildCategoryTree();
    },

    _countTreeRoutes(node) {
        let count = node.routes.length;
        for (const folder of Object.values(node.folders)) {
            count += this._countTreeRoutes(folder);
        }
        return count;
    },

    _buildCategoryTree() {
        const root = { folders: {}, routes: [] };

        for (const [key, route] of Object.entries(this.routesDescriptions)) {
            // Звёздочка больше не выделяет маршрут в отдельный блок,
            // но остаётся частью названия. Папки строятся по символу "/".
            const fullPath = (route.name || key).trim() || key;
            const parts = fullPath.split('/').map(s => s.trim()).filter(Boolean);
            const leafName = parts.pop() || fullPath;

            let node = root;
            for (const part of parts) {
                if (!node.folders[part]) node.folders[part] = { folders: {}, routes: [] };
                node = node.folders[part];
            }
            node.routes.push({ ...route, name: leafName, fullPath, key });
        }

        if (root.routes.length > 0) {
            root.folders['Без категории'] = root.folders['Без категории'] || { folders: {}, routes: [] };
            root.folders['Без категории'].routes.push(...root.routes);
            root.routes = [];
        }
        return root;
    },

    _expandCurrentRoutePath() {
        if (!this.currentRoute) return;
        const route = this.routesDescriptions[this.currentRoute];
        if (!route || !route.name) return;
        const rawName = route.name.trim();
        const parts = rawName.split('/').filter(Boolean);
        parts.pop();
        let path = '';
        for (const part of parts) {
            path = path ? path + '/' + part : part;
            this._expandedFolders.add(path);
        }
    },

    // Индикация загрузки списка маршрутов
    _showListLoading() {
        const container = document.getElementById('routesListContainer');
        if (!container) return;
        container.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;gap:12px;">
                <div class="spinner-ring" style="width:28px;height:28px;border-width:3px;"></div>
                <div style="color:rgba(255,255,255,0.5);font-size:14px;">Загрузка маршрутов...</div>
            </div>
        `;
    },

    _buildRoutesList() {
        const container = document.getElementById('routesListContainer');
        if (!container) return;

        // Список ещё не получен — показываем спиннер, а не «Нет маршрутов».
        if (!this._routesLoaded) {
            if (this._isFetchingRoutes) {
                this._showListLoading();
            } else {
                this._loadRoutesList();
            }
            return;
        }

        const tree = this._categoryTree;
        const hasRoutes = tree && (Object.keys(tree.folders).length > 0 || tree.routes.length > 0);
        if (!hasRoutes) {
            container.innerHTML = '<div style="text-align:center;padding:20px;color:rgba(255,255,255,0.5);font-size:14px;">Нет маршрутов</div>';
            return;
        }

        const frag = document.createDocumentFragment();
        this._renderTreeNode(tree, frag, '', true);

        container.innerHTML = '';
        container.appendChild(frag);
    },

    // Цвета сегментов маршрута (те же, что в навигаторе и редакторе)
    _ROUTE_COLORS: {
        Gold: '#FFD700', Blue: '#007AFF', Red: '#FF3B30', Fuchsia: '#AF52DE',
        Orange: '#FF9500', Purple: '#5856D6', Cyan: '#5AC8FA', Brown: '#A2845E',
        Lime: '#34C759'
    },

    /**
     * SVG-превью маршрута: полилиния по сегментам с сохранением их цветов,
     * обводка для контраста, точки старта/финиша.
     * Геометрия берётся из уже загруженного списка — без сетевых запросов.
     * Возвращает строку '' если данных нет.
     */
    _routePreviewSVG(routeData, size) {
        const S = size || 54;
        if (!Array.isArray(routeData) || routeData.length === 0) return '';

        const segs = [];
        for (const seg of routeData) {
            if (!seg || !Array.isArray(seg.pts)) continue;
            const pts = seg.pts.filter(p =>
                Array.isArray(p) && p.length >= 2 &&
                isFinite(p[0]) && isFinite(p[1])
            );
            if (pts.length) {
                segs.push({ color: this._ROUTE_COLORS[seg.color] || '#FFD700', pts: pts });
            }
        }
        if (!segs.length) return '';

        // На миниатюре 54px сотни точек не нужны — режем шагом, сохраняя концы.
        const total = segs.reduce((n, s) => n + s.pts.length, 0);
        const MAX_PTS = 300;
        if (total > MAX_PTS) {
            const keep = Math.max(2, Math.ceil(MAX_PTS / segs.length));
            for (const s of segs) {
                if (s.pts.length <= keep) continue;
                const stride = Math.ceil((s.pts.length - 1) / (keep - 1));
                const out = [];
                for (let i = 0; i < s.pts.length - 1; i += stride) out.push(s.pts[i]);
                out.push(s.pts[s.pts.length - 1]);
                s.pts = out;
            }
        }

        // bbox по всем точкам
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const s of segs) {
            for (const p of s.pts) {
                if (p[1] < minX) minX = p[1];
                if (p[1] > maxX) maxX = p[1];
                if (p[0] < minY) minY = p[0];
                if (p[0] > maxY) maxY = p[0];
            }
        }

        // Эквидистантная проекция с поправкой на широту, чтобы форма
        // маршрута не растягивалась по вертикали.
        const pad = S * 0.12;
        const kx = Math.cos(((minY + maxY) / 2) * Math.PI / 180) || 1e-6;
        const gx = (maxX - minX) * kx;
        const gy = (maxY - minY);
        const span = Math.max(gx, gy) || 1e-6;
        const scale = (S - 2 * pad) / span;
        const offX = (S - gx * scale) / 2;
        const offY = (S - gy * scale) / 2;
        const px = (p) => [
            offX + (p[1] - minX) * kx * scale,
            S - offY - (p[0] - minY) * scale
        ];

        const dOf = (s) => 'M' + s.pts.map(p => {
            const xy = px(p);
            return xy[0].toFixed(1) + ',' + xy[1].toFixed(1);
        }).join('L');

        const all = segs.map(dOf).join(' ');
        const sw = Math.max(2, S * 0.05);

        let inner = `<rect width="${S}" height="${S}" fill="#fff"/>`;
        // Тёмная подложка под цветными линиями — контраст на любом фоне.
        inner += `<path d="${all}" stroke="#1b2430" stroke-width="${(sw + 2.5).toFixed(1)}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
        for (const s of segs) {
            inner += `<path d="${dOf(s)}" stroke="${s.color}" stroke-width="${sw.toFixed(1)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
        }

        // Старт / финиш
        const start = px(segs[0].pts[0]);
        const lastSeg = segs[segs.length - 1];
        const end = px(lastSeg.pts[lastSeg.pts.length - 1]);
        const r = Math.max(3, S * 0.065);
        const dot = (xy, fill) =>
            `<circle cx="${xy[0].toFixed(1)}" cy="${xy[1].toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}" stroke="#fff" stroke-width="${(r * 0.45).toFixed(1)}"/>`;
        inner += dot(start, '#34C759') + dot(end, '#FF3B30');

        return `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
    },

    _renderTreeNode(node, container, path, isRoot = !path) {
        const folderNames = Object.keys(node.folders).sort((a, b) => a.localeCompare(b));

        for (const name of folderNames) {
            if (name === 'Без категории') continue;
            const folderPath = path ? path + '/' + name : name;
            const sub = node.folders[name];
            const total = this._countTreeRoutes(sub);
            const isExpanded = this._expandedFolders.has(folderPath);

            const el = document.createElement('div');
            el.className = 'category-folder';

            const header = document.createElement('div');
            header.className = 'category-header' + (isExpanded ? ' expanded' : '') + (isRoot ? ' root' : '');
            header.innerHTML = `
                <span class="category-icon">${isExpanded ? '📂' : '📁'}</span>
                <span class="category-name">${this._escape(name)}</span>
                <span class="category-count">${total}</span>
            `;
            header.addEventListener('click', e => {
                e.stopPropagation();
                if (this._expandedFolders.has(folderPath)) this._expandedFolders.delete(folderPath);
                else this._expandedFolders.add(folderPath);
                this._buildRoutesList();
            });
            el.appendChild(header);
            container.appendChild(el);

            if (isExpanded) {
                const childWrap = document.createElement('div');
                childWrap.style.cssText = 'padding-left:16px;display:flex;flex-direction:column;gap:6px;';
                this._renderTreeNode(sub, childWrap, folderPath, false);
                container.appendChild(childWrap);
            }
        }

        const uncat = node.folders['Без категории'];
        if (uncat) {
            const fcPath = path ? path + '/Без категории' : 'Без категории';
            const fcExpanded = this._expandedFolders.has(fcPath);
            const fcTotal = this._countTreeRoutes(uncat);
            const fcEl = document.createElement('div');
            fcEl.className = 'category-folder';

            const fcHdr = document.createElement('div');
            fcHdr.className = 'category-header' + (fcExpanded ? ' expanded' : '') + (isRoot ? ' root' : '');
            fcHdr.innerHTML = `
                <span class="category-icon">${fcExpanded ? '📂' : '📁'}</span>
                <span class="category-name">Без категории</span>
                <span class="category-count">${fcTotal}</span>
            `;
            fcHdr.addEventListener('click', e => {
                e.stopPropagation();
                if (this._expandedFolders.has(fcPath)) this._expandedFolders.delete(fcPath);
                else this._expandedFolders.add(fcPath);
                this._buildRoutesList();
            });
            fcEl.appendChild(fcHdr);
            container.appendChild(fcEl);

            if (fcExpanded) {
                const childWrap = document.createElement('div');
                childWrap.style.cssText = 'padding-left:16px;display:flex;flex-direction:column;gap:6px;';
                this._renderTreeNode(uncat, childWrap, fcPath, false);
                container.appendChild(childWrap);
            }
        }

        for (const route of node.routes) {
            const routeKey = route.key;
            const hasDesc = route.description && route.description.trim() !== '';
            const isActive = routeKey === this.currentRoute;
            const btn = document.createElement('button');
            btn.className = 'route-item' + (isActive ? ' active' : '');
            if (isActive) btn.style.cssText = 'background:rgba(48,209,88,0.2);border-color:rgba(48,209,88,0.4);';

            const svg = this._routePreviewSVG(route.data, 54);
            if (svg) {
                const thumb = document.createElement('span');
                thumb.className = 'route-thumb';
                thumb.innerHTML = svg;
                btn.appendChild(thumb);
            }

            const nameSpan = document.createElement('span');
            nameSpan.className = 'route-name';
            nameSpan.textContent = route.name || route.m;
            btn.appendChild(nameSpan);

            if (hasDesc) {
                const infoBtn = document.createElement('span');
                infoBtn.className = 'route-info-btn';
                infoBtn.textContent = '?';
                infoBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    this._showRouteDescription(routeKey);
                });
                btn.appendChild(infoBtn);
            }

            btn.addEventListener('click', e => {
                e.stopPropagation();
                if (route.m) this.loadRouteByName(route.m);
            });
            container.appendChild(btn);
        }
    },

    // HTML-экранирование для вставки в innerHTML.
    _escape(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    /**
     * Показать описание маршрута
     */
    _showRouteDescription(routeKey) {
        const routeData = this.routesDescriptions[routeKey];
        if (!routeData || !routeData.description) return;

        // Создаём модальное окно если его нет
        let descModal = document.getElementById('routeDescModal');
        if (!descModal) {
            descModal = document.createElement('div');
            descModal.id = 'routeDescModal';
            descModal.innerHTML = `
                <div class="desc-modal-overlay" id="routeDescOverlay">
                    <div class="desc-modal-content">
                        <div class="desc-modal-header">
                            <span id="routeDescTitle"></span>
                            <button id="routeDescCloseBtn" class="desc-close-btn">×</button>
                        </div>
                        <div class="desc-modal-body" id="routeDescText"></div>
                    </div>
                </div>
            `;
            document.body.appendChild(descModal);

            // Закрытие по клику на overlay
            document.getElementById('routeDescOverlay').addEventListener('click', (e) => {
                if (e.target === e.currentTarget) {
                    this._hideRouteDescription();
                }
            });

            // Закрытие по кнопке
            document.getElementById('routeDescCloseBtn').addEventListener('click', () => {
                this._hideRouteDescription();
            });
        }

        const routeData2 = this.routesDescriptions[routeKey];
        document.getElementById('routeDescTitle').textContent = (routeData2.name || routeKey).trim();
        document.getElementById('routeDescText').textContent = routeData2.description;
        descModal.style.display = 'block';
        requestAnimationFrame(() => descModal.classList.add('visible'));
    },

    /**
     * Скрыть описание маршрута
     */
    _hideRouteDescription() {
        const descModal = document.getElementById('routeDescModal');
        if (descModal) {
            descModal.classList.remove('visible');
            setTimeout(() => descModal.style.display = 'none', 300);
        }
    },

    // Создание модального окна
    createModal() {
        const html = `
            <div id="jsonModal" class="sheet-modal">
                <div class="modal-sheet" id="jsonModalSheet">
                    <div class="sheet-drag-area" id="jsonModalDragArea">
                        <div class="sheet-handle"><svg viewBox="0 0 24 24"><path d="M3 9L12 14.2L21 9" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
                    </div>
                    <div id="routesListContainer" class="routes-list">
                        <div style="text-align:center; padding:20px; color:rgba(255,255,255,0.5); font-size:14px;">
                            Загрузка списка маршрутов...
                        </div>
                    </div>
                </div>
            </div>
            <div id="loadingSpinner">
                <div class="spinner-box">
                    <div class="spinner-ring"></div>
                    <div class="spinner-text">Загрузка маршрута...</div>
                </div>
            </div>
        `;

        const loading = document.getElementById('loading');
        if (loading) {
            loading.insertAdjacentHTML('afterend', html);
        } else {
            document.body.insertAdjacentHTML('afterbegin', html);
        }

        // Drag-to-dismiss на ручку
        const self = this;
        (() => {
            const sheet = document.getElementById('jsonModalSheet');
            const handle = document.getElementById('jsonModalDragArea');
            let startY = 0, currentY = 0, dragging = false;
            if (!sheet || !handle) return;
            const onStart = (e) => { e.preventDefault(); startY = e.clientY; currentY = startY; dragging = false; };
            const onMove = (e) => {
                if (startY === 0) return;
                const dy = e.clientY - startY;
                if (Math.abs(dy) > 5) dragging = true;
                if (!dragging) return;
                currentY = e.clientY;
                sheet.style.transition = 'none';
                if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
            };
            const onEnd = () => {
                if (startY === 0) return;
                if (dragging) {
                    sheet.style.transition = '';
                    const dy = currentY - startY;
                    if (dy > 100) { self.hide(); startY = 0; return; }
                    sheet.style.transform = '';
                } else {
                    self.hide();
                }
                startY = 0;
            };
            handle.addEventListener('pointerdown', onStart);
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onEnd);
            window.addEventListener('pointercancel', onEnd);
        })();

        // Закрытие при клике на любую кнопку приложения (кроме кнопки меню и модалки описания)
        document.addEventListener('click', (e) => {
            const descModal = document.getElementById('routeDescModal');
            if (descModal && descModal.style.display === 'block') {
                const descOverlay = document.getElementById('routeDescOverlay');
                if (descOverlay && descOverlay.contains(e.target)) {
                    this._hideRouteDescription();
                    return;
                }
            }

            const modal = document.getElementById('jsonModal');
            if (modal && !modal.classList.contains('hidden')) {
                const sheet = modal.querySelector('.modal-sheet');
                const menuBtn = document.getElementById('menuBtn');
                const descModalEl = document.getElementById('routeDescModal');
                if (descModalEl && descModalEl.contains(e.target)) {
                    return; // Не закрываем меню если клик внутри модалки описания
                }
                if (sheet && !sheet.contains(e.target) && e.target !== menuBtn && !menuBtn.contains(e.target)) {
                    this.hide();
                }
            }
        });
    },

    // Создание кнопки меню
    createButton() {
        const html = `
            <button id="menuBtn" class="circle-btn">
                <span>Маршруты</span>
            </button>
        `;

        const container = document.getElementById('topCenterControls');
        if (container) {
            container.insertAdjacentHTML('afterbegin', html);
        } else {
            const loading = document.getElementById('loading');
            if (loading) {
                loading.insertAdjacentHTML('afterend', html);
            } else {
                document.body.insertAdjacentHTML('afterbegin', html);
            }
        }

        // Обработчик клика
        document.getElementById('menuBtn').addEventListener('click', () => {
            if (typeof closeInstruction === 'function') closeInstruction();
            const modal = document.getElementById('jsonModal');
            if (modal && modal.classList.contains('hidden')) {
                this.show();
            } else {
                this.hide();
            }
        });
    },

    // Проверка URL параметра
    checkUrlParam() {
        const routeParam = this.getUrlParam('m');
        if (!routeParam) return;

        this.currentRoute = routeParam;
        this.isLoaded = true;
        this.hide();
        this.loadRouteByName(routeParam);
    },

    // Загрузка маршрута по m
    async loadRouteByName(routeM) {
        this.showSpinner();
        try {
            if (!routeM) throw new Error('Не указан маршрут');
            this.currentRoute = routeM;

            this.hide();

            let data;
            const cached = this.routesDescriptions && this.routesDescriptions[routeM];

            if (cached && cached.data) {
                // Данные уже загружены списком (list_routes&full=1) — без запроса.
                data = { name: cached.name, m: routeM, data: cached.data };
            } else {
                // Fallback: маршрута нет в списке (скрыт/удалён) или бэкенд ещё
                // не умеет full=1 — грузим по одному.
                const url = this.API_URL_V2 + '?action=get&m=' + encodeURIComponent(routeM);
                const res = await fetch(url);

                if (!res.ok) throw new Error('HTTP ' + res.status);
                data = await res.json();
            }

            // Отчёт об открытии маршрута — после получения данных маршрута.
            try {
                if (typeof REPORT !== 'undefined') {
                    REPORT.send({
                        m_val: routeM,
                        report_type: 'navigator',
                        route_name: data && data.name ? data.name : ''
                    });
                }
            } catch (re) {
                console.warn('[report] ошибка отправки отчёта навигатора:', re);
            }

            this.hideSpinner();
            this.loadRoute(data);
        } catch (e) {
            this.hideSpinner();
            console.error('[MenuModule] Ошибка загрузки маршрута:', e);
            if (typeof showToast === 'function') {
                showToast('Ошибка загрузки: ' + e.message, 'error', 5000);
            }
        }
    },

    // Загрузка маршрута (публичный метод, передаёт JSON в навигатор)
    loadRoute(jsonData) {
        // Очищаем предыдущий маршрут
        if (typeof clearRoute === 'function') {
            clearRoute();
        }

        // Если ответ содержит метаданные (имя, m), извлекаем их
        let routeData = jsonData;
        if (jsonData && typeof jsonData === 'object' && 'data' in jsonData) {
            routeData = jsonData.data;
            const cr = this.currentRoute;
            if (cr && jsonData.name) {
                if (!this.routesDescriptions) this.routesDescriptions = {};
                if (this.routesDescriptions[cr]) {
                    this.routesDescriptions[cr].name = jsonData.name;
                } else {
                    this.routesDescriptions[cr] = { name: jsonData.name, m: jsonData.m || cr };
                }
            }
        }

        // Передаём JSON данные в навигатор
        if (typeof this.callback === 'function') {
            this.callback(routeData);
        }
        this.isLoaded = true;
        this.hide();
    },

    // Скрыть модальное окно
    hide() {
        const modal = document.getElementById('jsonModal');
        if (modal) {
            const sheet = document.getElementById('jsonModalSheet');
            if (sheet) { sheet.style.transform = ''; sheet.style.transition = ''; }
            modal.classList.add('hidden');
        }
        this._hideRouteDescription();
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }
    },

    // Показать модальное окно
    show() {
        if (typeof closeAllSheets === 'function') closeAllSheets();
        const modal = document.getElementById('jsonModal');
        if (modal) modal.classList.remove('hidden');
        this._hideRouteDescription();
        this._expandedFolders = new Set();
        this._expandCurrentRoutePath();
        this._buildRoutesList();
    },

    showSpinner() {
        const spinner = document.getElementById('loadingSpinner');
        if (spinner) spinner.classList.add('active');
    },

    hideSpinner() {
        const spinner = document.getElementById('loadingSpinner');
        if (spinner) spinner.classList.remove('active');
    }
};
