
const MenuModule = {
    callback: null,
    isLoaded: false,
    currentRoute: null,
    routesDescriptions: {}, // { "m": { name, description, m, data } }
    _routesLoaded: false,   // список с геометрией уже получен
    _isFetchingRoutes: false,
    _categoryTree: null,
    _expandedFolders: new Set(),
    _previewObserver: null,
    _previewImages: new Map(),
    _previewJobs: new Map(),
    _previewQueue: [],
    _previewQueuedKeys: new Set(),
    _previewActive: false,

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

        // Проверяем параметр #m=<маршрут> в адресе
        this.checkUrlParam();

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
        this._destroyRoutePreviews();
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
        this._destroyRoutePreviews();

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
        this._observeRoutePreviews(container);
    },

    _destroyRoutePreviews() {
        if (this._previewObserver) {
            this._previewObserver.disconnect();
            this._previewObserver = null;
        }
    },

    _observeRoutePreviews(container) {
        const previews = container.querySelectorAll('.route-preview-map');
        if (!previews.length) return;

        const showPreviewImage = (element, key, imageUrl) => {
            if (!element.isConnected || element.dataset.previewKey !== key) return;
            const image = document.createElement('img');
            image.className = 'route-preview-image';
            image.alt = '';
            image.src = imageUrl;
            element.replaceChildren(image);
        };

        previews.forEach(element => {
            const key = `route-preview-v10\0${element.dataset.routeKey}`;
            element.dataset.previewKey = key;
            const image = this._previewImages.get(key);
            if (image) showPreviewImage(element, key, image);
        });

        const renderPreview = async (element, key, routeData) => {
            try {
                const points = [];
                const project = point => {
                    const latitude = Math.max(-85.0511, Math.min(85.0511, point[0]));
                    const longitude = point[1];
                    const sinLatitude = Math.sin(latitude * Math.PI / 180);
                    return {
                        x: (longitude + 180) / 360,
                        y: 0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)
                    };
                };

                let pointNumber = 0;
                for (const segment of routeData) {
                    if (!segment || !Array.isArray(segment.pts)) continue;
                    const coordinates = segment.pts.filter(point =>
                        Array.isArray(point) &&
                        Number.isFinite(point[0]) &&
                        Number.isFinite(point[1]) &&
                        Math.abs(point[0]) <= 90 &&
                        Math.abs(point[1]) <= 180
                    );
                    if (!coordinates.length) continue;
                    pointNumber++;
                    points.push({
                        coordinates,
                        color: this._ROUTE_COLORS[segment.color] || '#FFD700',
                        number: String(segment.id || pointNumber),
                        current: pointNumber === 1,
                        hasComment: typeof segment.comm === 'string' && segment.comm.trim() !== ''
                    });
                }

                if (!points.length) {
                    element.textContent = 'Нет геометрии маршрута';
                    return;
                }

                const icons = await Promise.all(points.map(point => new Promise((resolve, reject) => {
                    const icon = new Image();
                    icon.onload = () => resolve(icon);
                    icon.onerror = () => reject(new Error('Could not load route point icon'));
                    icon.src = window.getNavigatorPointIcon(
                        point.color,
                        point.number,
                        point.current,
                        point.hasComment
                    );
                })));

                const width = Math.max(1, element.clientWidth);
                const height = Math.max(1, element.clientHeight);
                const pixelRatio = 2;
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(width * pixelRatio);
                canvas.height = Math.round(height * pixelRatio);
                const context = canvas.getContext('2d');
                if (!context) throw new Error('Could not create preview canvas');
                context.scale(pixelRatio, pixelRatio);

                const background = context.createLinearGradient(0, 0, width, height);
                background.addColorStop(0, '#303840');
                background.addColorStop(1, '#20262d');
                context.fillStyle = background;
                context.fillRect(0, 0, width, height);

                const projected = points.map(point => ({
                    ...point,
                    path: point.coordinates.map(project)
                }));
                let minX = Infinity;
                let maxX = -Infinity;
                let minY = Infinity;
                let maxY = -Infinity;
                for (const point of projected) {
                    for (const coordinate of point.path) {
                        minX = Math.min(minX, coordinate.x);
                        maxX = Math.max(maxX, coordinate.x);
                        minY = Math.min(minY, coordinate.y);
                        maxY = Math.max(maxY, coordinate.y);
                    }
                }
                const markerSize = Math.min(40, Math.max(20, Math.min(width, height) * 0.2));
                const padding = markerSize / 2 + 2;
                const scale = Math.min(
                    (width - padding * 2) / Math.max(maxX - minX, 1e-9),
                    (height - padding * 2) / Math.max(maxY - minY, 1e-9)
                );
                const offsetX = (width - (maxX - minX) * scale) / 2;
                const offsetY = (height - (maxY - minY) * scale) / 2;
                const toCanvas = point => ({
                    x: offsetX + (point.x - minX) * scale,
                    y: offsetY + (point.y - minY) * scale
                });

                for (const point of projected) {
                    if (point.path.length < 2) continue;
                    context.beginPath();
                    point.path.forEach((coordinate, index) => {
                        const position = toCanvas(coordinate);
                        if (index === 0) context.moveTo(position.x, position.y);
                        else context.lineTo(position.x, position.y);
                    });
                    context.lineCap = 'round';
                    context.lineJoin = 'round';
                    context.strokeStyle = 'rgba(0, 0, 0, 0.75)';
                    context.lineWidth = markerSize * 0.2;
                    context.stroke();
                    context.strokeStyle = point.color;
                    context.lineWidth = markerSize * 0.1;
                    context.stroke();
                }

                for (let index = projected.length - 1; index >= 0; index--) {
                    const position = toCanvas(projected[index].path[0]);
                    context.drawImage(
                        icons[index],
                        position.x - markerSize / 2,
                        position.y - markerSize / 2,
                        markerSize,
                        markerSize
                    );
                }

                const imageUrl = canvas.toDataURL('image/jpeg', 0.92);
                this._previewImages.set(key, imageUrl);
                document.querySelectorAll('.route-preview-map').forEach(candidate => {
                    showPreviewImage(candidate, key, imageUrl);
                });
            } catch (error) {
                console.warn('Не удалось создать превью маршрута:', error);
            } finally {
                this._previewJobs.delete(key);
                this._previewActive = false;
                startNextPreview();
            }
        };

        const startNextPreview = () => {
            if (this._previewActive) return;
            while (this._previewQueue.length) {
                const job = this._previewQueue.shift();
                this._previewQueuedKeys.delete(job.key);
                if (!job.element.isConnected) continue;
                const cachedImage = this._previewImages.get(job.key);
                if (cachedImage) {
                    job.showCached(cachedImage);
                    continue;
                }
                if (this._previewJobs.has(job.key)) continue;
                this._previewActive = true;
                this._previewJobs.set(job.key, true);
                job.element.textContent = 'Подготавливаем превью…';
                void renderPreview(job.element, job.key, job.routeData);
                return;
            }
        };

        const createPreview = element => {
            if (!element.isConnected) return;
            const key = element.dataset.previewKey;
            const cachedImage = this._previewImages.get(key);
            if (cachedImage) {
                showPreviewImage(element, key, cachedImage);
                return;
            }
            if (this._previewJobs.has(key) || this._previewQueuedKeys.has(key)) return;

            const routeData = this.routesDescriptions[element.dataset.routeKey]?.data;
            if (!Array.isArray(routeData)) return;
            this._previewQueuedKeys.add(key);
            this._previewQueue.push({
                key,
                element,
                routeData,
                showCached: image => showPreviewImage(element, key, image),
            });
            startNextPreview();
        };

        if (typeof IntersectionObserver === 'undefined') {
            Array.from(previews).slice(0, 2).forEach(createPreview);
            return;
        }

        this._previewObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                const element = entry.target;
                if (entry.isIntersecting) {
                    this._previewObserver.unobserve(element);
                    createPreview(element);
                }
            }
        }, {
            root: container,
            rootMargin: '240px 0px'
        });
        previews.forEach(element => this._previewObserver.observe(element));
    },

    // Цвета сегментов маршрута (те же, что в навигаторе и редакторе)
    _ROUTE_COLORS: {
        Gold: '#FFD700', Blue: '#007AFF', Red: '#FF3B30', Fuchsia: '#AF52DE',
        Orange: '#FF9500', Purple: '#5856D6', Cyan: '#5AC8FA', Brown: '#A2845E',
        Lime: '#34C759'
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
            header.setAttribute('role', 'button');
            header.setAttribute('tabindex', '0');
            header.setAttribute('aria-expanded', String(isExpanded));
            header.innerHTML = `
                <span class="category-chevron" aria-hidden="true"></span>
                <svg class="category-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>
                <span class="category-name">${this._escape(name)}</span>
                <span class="category-count">${total}</span>
            `;
            const toggleFolder = e => {
                e.stopPropagation();
                if (this._expandedFolders.has(folderPath)) this._expandedFolders.delete(folderPath);
                else this._expandedFolders.add(folderPath);
                this._buildRoutesList();
            };
            header.addEventListener('click', toggleFolder);
            header.addEventListener('keydown', e => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                toggleFolder(e);
            });
            el.appendChild(header);
            container.appendChild(el);

            if (isExpanded) {
                const childWrap = document.createElement('div');
                childWrap.className = 'route-tree-children';
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
            fcHdr.setAttribute('role', 'button');
            fcHdr.setAttribute('tabindex', '0');
            fcHdr.setAttribute('aria-expanded', String(fcExpanded));
            fcHdr.innerHTML = `
                <span class="category-chevron" aria-hidden="true"></span>
                <svg class="category-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>
                <span class="category-name">Без категории</span>
                <span class="category-count">${fcTotal}</span>
            `;
            const toggleUncategorized = e => {
                e.stopPropagation();
                if (this._expandedFolders.has(fcPath)) this._expandedFolders.delete(fcPath);
                else this._expandedFolders.add(fcPath);
                this._buildRoutesList();
            };
            fcHdr.addEventListener('click', toggleUncategorized);
            fcHdr.addEventListener('keydown', e => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                toggleUncategorized(e);
            });
            fcEl.appendChild(fcHdr);
            container.appendChild(fcEl);

            if (fcExpanded) {
                const childWrap = document.createElement('div');
                childWrap.className = 'route-tree-children';
                this._renderTreeNode(uncat, childWrap, fcPath, false);
                container.appendChild(childWrap);
            }
        }

        for (const route of node.routes) {
            const routeKey = route.key;
            const isActive = routeKey === this.currentRoute;
            const btn = document.createElement('button');
            btn.className = 'route-item' + (isActive ? ' active' : '');
            if (isActive) btn.setAttribute('aria-current', 'true');

            const preview = document.createElement('div');
            preview.className = 'route-preview-map';
            preview.dataset.routeKey = routeKey;
            preview.setAttribute('aria-hidden', 'true');
            btn.appendChild(preview);

            const details = document.createElement('span');
            details.className = 'route-item-details';
            const nameSpan = document.createElement('span');
            nameSpan.className = 'route-name';
            nameSpan.textContent = route.name || route.m;
            details.appendChild(nameSpan);
            if (isActive) {
                const loadedLabel = document.createElement('span');
                loadedLabel.className = 'route-loaded-label';
                loadedLabel.textContent = 'Загружен';
                details.appendChild(loadedLabel);
            }
            btn.appendChild(details);

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

    // Создание модального окна
    createModal() {
        const html = `
            <div id="jsonModal" class="screen-modal">
                <div class="screen-panel compact-route-menu" id="jsonModalScreen">
                    <header class="screen-head">
                        <h1 class="screen-title">Маршруты</h1>
                        <button type="button" class="screen-close" id="jsonModalClose" aria-label="Закрыть">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
                        </button>
                    </header>
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

        const closeBtn = document.getElementById('jsonModalClose');
        if (closeBtn) closeBtn.addEventListener('click', () => this.hide());
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

            await this.loadRoute(data);
            this.hideSpinner();
        } catch (e) {
            this.hideSpinner();
            console.error('[MenuModule] Ошибка загрузки маршрута:', e);
            if (typeof showToast === 'function') {
                showToast('Ошибка загрузки: ' + e.message, 'error', 5000);
            }
        }
    },

    // Загрузка маршрута (публичный метод, передаёт JSON в навигатор)
    async loadRoute(jsonData) {
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
            await this.callback(routeData);
        }
        this.isLoaded = true;
        this.hide();
    },

    // Скрыть модальное окно
    hide() {
        this._destroyRoutePreviews();
        const modal = document.getElementById('jsonModal');
        if (modal) modal.classList.add('hidden');
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
