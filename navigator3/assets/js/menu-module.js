
const MenuModule = {
    callback: null,
    isLoaded: false,
    currentRoute: null,
    routesDescriptions: {}, // { "m": { name, description, m, data } }
    _routesLoaded: false,
    _isFetchingRoutes: false,
    _catalog: [],
    _folders: [],
    _folderMap: new Map(),
    _folderCounts: new Map(),
    _folderPath: [],
    _searchQuery: '',
    _searchScope: 'all',
    _MENU_STATE_KEY: 'osm_routes_menu_state_v2',
    _pendingPurchaseFolderId: null,
    _previewObserver: null,
    _previewImages: new Map(),
    _previewJobs: new Map(),
    _previewQueue: [],
    _previewQueuedKeys: new Set(),
    _previewFetching: new Set(),
    _previewActive: false,
    _folderCache: new Map(),
    API_CATALOG_URL: '/api/catalog',
    API_FOLDER_URL: '/api/folder',
    API_ROUTE_URL: '/api/route',

    // Кэш полных маршрутов: нужен для повторного открытия и превью.
    _routeDataCache: new Map(),
    _routeRequests: new Map(),

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
        this._loadMenuState();
        this.createModal();
        this.hide();
        this._handlePaymentReturn();

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
        this._showListLoading();
        const showLoadError = () => {
            if (container) {
                container.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;gap:12px;">
                        <div class="spinner-ring" style="width:28px;height:28px;border-width:3px;"></div>
                        <div style="color:rgba(18,28,46,0.5);font-size:14px;">Не удалось загрузить. Повторяем...</div>
                    </div>
                `;
            }
        };
        const attempt = async () => {
            try {
                const folderId = this._folderPath[this._folderPath.length - 1] || '';
                const payload = await this._fetchFolder(folderId);
                this._applyFolderData(payload);
                this._folders = Array.isArray(payload.folders) ? payload.folders : [];
                this._folderMap.clear();
                for (const folder of this._folders) {
                    if (folder && folder.folder_id) this._folderMap.set(folder.folder_id, folder);
                }
                this._routesLoaded = true;
                this._buildRoutesList();
                return true;
            } catch (e) {
                console.warn('Не удалось загрузить содержимое папки:', e);
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
     * Запрос к API за каталогом без геометрии.
     *
     * Сервер отдаёт дерево папок отдельно от маршрутов. Доступ считается
     * только на сервере: route.access = public|paid, route.owned — можно ли
     * открывать сейчас, route.purchase_folder_id — какую папку покупать.
     */
    async _fetchFromAPI() {
        const response = await fetch(this.API_CATALOG_URL, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
            cache: 'no-store'
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const payload = await response.json();
        const data = Array.isArray(payload) ? payload : payload && payload.routes;
        if (!Array.isArray(data)) {
            throw new Error('Некорректный ответ каталога');
        }

        this._folders = Array.isArray(payload.folders) ? payload.folders : [];
        this._folderMap = new Map(
            this._folders.map(folder => [folder.folder_id, folder])
        );

        const routesFlat = {};

        for (const route of data) {
            const key = route.m;
            if (!key) continue;
            routesFlat[key] = {
                m: route.m,
                name: route.name || route.title || route.m,
                title: route.title || route.name || route.m,
                folder_id: route.folder_id || '',
                description: typeof route.description === 'string' ? route.description.trim() : '',
                access: route.access || 'public',
                owned: route.owned !== false,
                purchase_folder_id: route.purchase_folder_id || '',
                price_kopecks: Number.isFinite(route.price_kopecks) ? route.price_kopecks : 0,
                sku: route.sku || '',
                point_count: Number.isFinite(route.point_count) ? route.point_count : null,
                distance_meters: Number.isFinite(route.distance_meters) ? route.distance_meters : null
            };
        }

        this.routesDescriptions = routesFlat;
        this._buildCatalog();
    },

    async _fetchFolder(folderId) {
        const key = folderId || '';
        if (this._folderCache.has(key)) {
            return this._folderCache.get(key);
        }
        const url = this.API_FOLDER_URL + (key ? '?folder_id=' + encodeURIComponent(key) : '');
        const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const payload = await response.json();
        this._folderCache.set(key, payload);
        return payload;
    },

    _applyFolderData(payload) {
        if (!payload || typeof payload !== 'object') return;
        const routes = Array.isArray(payload.routes) ? payload.routes : [];
        for (const route of routes) {
            if (!route || !route.m) continue;
            if (Array.isArray(route.data)) {
                this._routeDataCache.set(route.m, route);
                if (!this.routesDescriptions[route.m]) {
                    this.routesDescriptions[route.m] = route;
                } else {
                    if (route.name) this.routesDescriptions[route.m].name = route.name;
                    if (route.title) this.routesDescriptions[route.m].title = route.title;
                    this.routesDescriptions[route.m].data = route.data;
                }
            }
        }
    },
    async _fetchRoute(routeM) {
        const key = String(routeM);
        if (this._routeDataCache.has(key)) return this._routeDataCache.get(key);
        if (this._routeRequests.has(key)) return this._routeRequests.get(key);

        const request = (async () => {
            const response = await fetch(
                this.API_ROUTE_URL + '?m=' + encodeURIComponent(key),
                {
                    credentials: 'same-origin',
                    headers: { Accept: 'application/json' },
                    cache: 'no-store'
                }
            );

            let payload = null;
            try {
                payload = await response.json();
            } catch (e) {}

            if (!response.ok) {
                const error = new Error(
                    (payload && payload.error) || `HTTP ${response.status}`
                );
                error.status = response.status;
                error.purchaseFolderId = (payload && payload.purchase_folder_id) || '';
                const folder = this._folderMap.get(error.purchaseFolderId);
                error.folderName = folder ? folder.name : '';
                throw error;
            }
            if (!payload || !Array.isArray(payload.data)) {
                throw new Error('Некорректный ответ маршрута');
            }

            this._routeDataCache.set(key, payload);
            return payload;
        })();

        this._routeRequests.set(key, request);
        try {
            return await request;
        } finally {
            this._routeRequests.delete(key);
        }
    },

    /**
     * Плоский каталог маршрутов с деревом папок.
     *
     * folderPath хранит folder_id, а не названия: папку можно переименовать,
     * не ломая сохранённое состояние меню.
     */
    _buildCatalog() {
        const catalog = [];
        this._folderCounts = new Map();

        for (const [key, route] of Object.entries(this.routesDescriptions)) {
            const chain = this._folderChain(route.folder_id);
            const folders = chain.map(folder => folder.folder_id);
            const folderNames = chain.map(folder => folder.name);
            const title = (route.title || route.name || key).trim() || key;
            const fullPath = [...folderNames, title].join(' / ');
            const top = folderNames[0] || 'Без категории';
            const sub = folderNames.length > 1 ? folderNames.slice(1).join(' / ') : null;

            catalog.push({
                key,
                m: route.m || key,
                name: title,
                title,
                fullPath,
                top,
                sub,
                folders,
                folderNames,
                description: typeof route.description === 'string' ? route.description.trim() : '',
                access: route.access || 'public',
                owned: route.owned !== false,
                purchaseFolderId: route.purchase_folder_id || '',
                priceKopecks: Number.isFinite(route.price_kopecks) ? route.price_kopecks : 0,
                sku: route.sku || '',
                ...this._routeStats(route),
                search: this._normalizeSearch(
                    `${fullPath} ${typeof route.description === 'string' ? route.description : ''}`
                )
            });

            for (const folderId of folders) {
                this._folderCounts.set(
                    folderId,
                    (this._folderCounts.get(folderId) || 0) + 1
                );
            }
        }

        catalog.sort((a, b) => a.fullPath.localeCompare(b.fullPath, 'ru'));
        this._catalog = catalog;

        let validPath = [];
        let parentId = '';
        for (const folderId of this._folderPath) {
            const folder = this._folderMap.get(folderId);
            if (!folder || (folder.parent_id || '') !== parentId) break;
            validPath.push(folderId);
            parentId = folderId;
        }
        this._folderPath = validPath;
        this._saveMenuState();
    },

    _folderChain(folderId) {
        const chain = [];
        const seen = new Set();
        let current = folderId || '';
        while (current && this._folderMap.has(current) && !seen.has(current)) {
            seen.add(current);
            const folder = this._folderMap.get(current);
            chain.push(folder);
            current = folder.parent_id || '';
        }
        return chain.reverse();
    },

    _formatPrice(kopecks) {
        const value = Number(kopecks) || 0;
        if (value <= 0) return 'Платный доступ';
        const rubles = value / 100;
        const formatted = rubles.toLocaleString('ru-RU', {
            maximumFractionDigits: Number.isInteger(rubles) ? 0 : 2
        });
        return `${formatted} ₽`;
    },

    _routeStats(route) {
        // Новый API присылает готовые метрики. Старый формат с data
        // поддерживаем на случай локальной отладки.
        const measured = Array.isArray(route.data)
            ? this._measureRoute(route.data)
            : { pointCount: 0, distanceMeters: 0 };
        return {
            pointCount: Number.isFinite(route.point_count)
                ? route.point_count
                : measured.pointCount,
            distanceMeters: Number.isFinite(route.distance_meters)
                ? route.distance_meters
                : measured.distanceMeters
        };
    },

    _measureRoute(data) {
        if (!Array.isArray(data)) return { pointCount: 0, distanceMeters: 0 };

        let pointCount = 0;
        let distanceMeters = 0;
        for (const segment of data) {
            if (!segment || !Array.isArray(segment.pts)) continue;
            let previous = null;
            let hasPoint = false;
            for (const point of segment.pts) {
                if (!Array.isArray(point) ||
                    !Number.isFinite(point[0]) ||
                    !Number.isFinite(point[1]) ||
                    Math.abs(point[0]) > 90 ||
                    Math.abs(point[1]) > 180) continue;
                hasPoint = true;
                if (previous) {
                    const radians = Math.PI / 180;
                    const dLat = (point[0] - previous[0]) * radians;
                    const dLon = (point[1] - previous[1]) * radians;
                    const a = Math.sin(dLat / 2) ** 2 +
                        Math.cos(previous[0] * radians) *
                        Math.cos(point[0] * radians) *
                        Math.sin(dLon / 2) ** 2;
                    const arc = Math.min(1, Math.max(0, a));
                    distanceMeters += 6371000 * 2 *
                        Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
                }
                previous = point;
            }
            if (hasPoint) pointCount++;
        }
        return { pointCount, distanceMeters };
    },

    _loadMenuState() {
        try {
            const saved = JSON.parse(localStorage.getItem(this._MENU_STATE_KEY) || '{}');
            if (!saved || typeof saved !== 'object') return;
            if (Array.isArray(saved.folderPath) &&
                saved.folderPath.every(folder => typeof folder === 'string')) {
                this._folderPath = saved.folderPath;
            }
            if (typeof saved.query === 'string') this._searchQuery = saved.query;
            if (saved.searchScope === 'all' || saved.searchScope === 'category') {
                this._searchScope = saved.searchScope;
            }
        } catch (e) {
            this._folderPath = [];
            this._searchQuery = '';
            this._searchScope = 'all';
        }
    },

    _saveMenuState() {
        try {
            localStorage.setItem(this._MENU_STATE_KEY, JSON.stringify({
                folderPath: this._folderPath,
                query: this._searchQuery,
                searchScope: this._searchScope
            }));
        } catch (e) {}
    },

    _getChildFolders(parentId) {
        const parent = parentId || '';
        return this._folders
            .filter(folder => (folder.parent_id || '') === parent)
            .map(folder => ({
                ...folder,
                count: this._folderCounts.get(folder.folder_id) || 0
            }))
            .sort((a, b) => {
                const ao = Number.isFinite(a.sort_order) ? a.sort_order : 0;
                const bo = Number.isFinite(b.sort_order) ? b.sort_order : 0;
                if (ao !== bo) return ao - bo;
                return a.name.localeCompare(b.name, 'ru');
            });
    },

    _isWithinFolder(item, path) {
        return item.folders.length >= path.length &&
            path.every((folderId, index) => item.folders[index] === folderId);
    },

    _normalizeSearch(value) {
        return String(value || '')
            .toLocaleLowerCase('ru')
            .replace(/ё/g, 'е')
            .replace(/\s+/g, ' ')
            .trim();
    },

    _getFilteredRoutes() {
        let routes;

        if (this._searchQuery) {
            const tokens = this._normalizeSearch(this._searchQuery).split(' ').filter(Boolean);
            routes = !tokens.length
                ? this._catalog
                : this._catalog.filter(item =>
                    tokens.every(token => item.search.includes(token)) &&
                    (this._searchScope !== 'category' || !this._folderPath.length ||
                        this._isWithinFolder(item, this._folderPath))
                );
        } else {
            routes = this._catalog.filter(item =>
                item.folders.length === this._folderPath.length &&
                this._isWithinFolder(item, this._folderPath)
            );
        }

        return routes;
    },

    // Индикация загрузки списка маршрутов
    _showListLoading() {
        const container = document.getElementById('routesListContainer');
        if (!container) return;
        this._destroyRoutePreviews();
        container.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;gap:12px;">
                <div class="spinner-ring" style="width:28px;height:28px;border-width:3px;"></div>
                <div style="color:rgba(18,28,46,0.5);font-size:14px;">Загрузка маршрутов...</div>
            </div>
        `;
    },

    _buildRoutesList() {
        const container = document.getElementById('routesListContainer');
        if (!container) return;
        this._destroyRoutePreviews();
        this._updateSearchScopeButton();

        // Список ещё не получен — показываем спиннер, а не «Нет маршрутов».
        if (!this._routesLoaded) {
            this._renderBreadcrumbs();
            if (this._isFetchingRoutes) {
                this._showListLoading();
            } else {
                this._loadRoutesList();
            }
            return;
        }

        const routes = this._getFilteredRoutes();
        this._renderBreadcrumbs();

        container.innerHTML = '';

        if (!this._catalog.length && !this._folders.length) {
            container.innerHTML = '<div class="routes-empty"><div class="routes-empty-title">Нет маршрутов</div></div>';
            return;
        }

        const childFolders = !this._searchQuery
            ? this._getChildFolders(this._folderPath[this._folderPath.length - 1] || '')
            : [];
        if (!routes.length && !childFolders.length) {
            const empty = document.createElement('div');
            empty.className = 'routes-empty';
            empty.innerHTML = this._searchQuery
                ? '<div class="routes-empty-title">Ничего не найдено</div><div class="routes-empty-hint">Попробуйте изменить запрос</div>'
                : '<div class="routes-empty-title">В этом разделе нет маршрутов</div>';
            container.appendChild(empty);
            return;
        }

        const summary = document.createElement('div');
        summary.className = 'routes-results-meta';
        const countLabel = this._searchQuery
            ? `${routes.length} ${this._pluralize(routes.length, 'маршрут найден', 'маршрута найдено', 'маршрутов найдено')}`
            : `${routes.length} ${this._pluralize(routes.length, 'маршрут', 'маршрута', 'маршрутов')}`;
        const searchContext = this._searchQuery
            ? this._searchScope === 'category' && this._folderPath.length
                ? `в папке «${this._folderPath.map(id => this._folderMap.get(id)?.name).filter(Boolean).join(' / ')}»`
                : 'во всех маршрутах'
            : '';
        summary.textContent = this._searchQuery
            ? `${countLabel} ${searchContext}`
            : childFolders.length
                ? `${childFolders.length} ${this._pluralize(childFolders.length, 'папка', 'папки', 'папок')} · ${countLabel}`
                : countLabel;
        container.appendChild(summary);
        if (childFolders.length) {
            const folderList = document.createElement('div');
            folderList.className = 'routes-folder-list';
            for (const folder of childFolders) {
                const locked = folder.access === 'paid' && !folder.owned;
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'routes-folder-row' + (locked ? ' is-locked' : '');
                button.dataset.folderId = folder.folder_id;
                button.dataset.folderName = folder.name;
                button.dataset.folderAccess = folder.access || 'public';
                button.dataset.folderOwned = folder.owned ? '1' : '0';
                button.dataset.purchaseFolderId = folder.purchase_folder_id || '';
                const icon = locked
                    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`
                    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>`;
                button.innerHTML = `
                    <span class="routes-folder-icon${locked ? ' is-locked' : ''}" aria-hidden="true">${icon}</span>
                    <span class="routes-folder-name">${this._escape(folder.name)}</span>
                    <span class="routes-folder-count" aria-label="${folder.count} ${this._pluralize(folder.count, 'маршрут', 'маршрута', 'маршрутов')}">
                        ${folder.count} ${this._pluralize(folder.count, 'маршрут', 'маршрута', 'маршрутов')}
                    </span>
                    ${locked ? `<span class="routes-folder-price">${this._escape(this._formatPrice(folder.price_kopecks))}</span>` : ''}
                    <span class="routes-folder-chevron" aria-hidden="true">${locked ? '🔒' : '›'}</span>
                `;
                folderList.appendChild(button);
            }
            container.appendChild(folderList);
        }
        const frag = document.createDocumentFragment();
        for (const route of routes) frag.appendChild(this._createRouteRow(route));
        container.appendChild(frag);
        this._observeRoutePreviews(container);
        this._scrollToCurrentRoute(container);
    },

    // Прокручивает список к загруженному маршруту, чтобы при открытии меню
    // было видно, где остановились. Срабатывает, только если строка есть
    // в текущей папке и не видна целиком.
    _scrollToCurrentRoute(container) {
        if (!this.currentRoute) return;
        const row = container.querySelector('.route-row.is-active');
        if (!row) return;
        const box = container.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        if (!box.height || (rect.top >= box.top && rect.bottom <= box.bottom)) return;
        container.scrollTop += rect.top - box.top - (box.height - rect.height) / 2;
    },

    _renderBreadcrumbs() {
        const el = document.getElementById('routesBreadcrumb');
        if (!el) return;
        el.innerHTML = '';
        const labels = [
            { id: '', name: 'Все маршруты' },
            ...this._folderPath.map(id => ({
                id,
                name: this._folderMap.get(id)?.name || id
            }))
        ];
        el.hidden = false;

        labels.forEach((label, index) => {
            if (index > 0) {
                const separator = document.createElement('span');
                separator.className = 'routes-breadcrumb-separator';
                separator.textContent = '›';
                separator.setAttribute('aria-hidden', 'true');
                el.appendChild(separator);
            }
            const item = document.createElement('button');
            item.type = 'button';
            const isCurrent = index === labels.length - 1;
            item.className = 'routes-breadcrumb-item' + (isCurrent ? ' current' : '');
            item.textContent = label.name;
            item.dataset.breadcrumbIndex = String(index);
            if (isCurrent) item.setAttribute('aria-current', 'location');
            el.appendChild(item);
        });
    },

    _pluralize(count, one, few, many) {
        const mod100 = count % 100;
        if (mod100 >= 11 && mod100 <= 14) return many;
        switch (count % 10) {
            case 1: return one;
            case 2:
            case 3:
            case 4: return few;
            default: return many;
        }
    },

    _updateSearchScopeButton() {
        const button = document.getElementById('routesSearchScope');
        if (!button) return;
        button.hidden = !this._folderPath.length || !this._searchQuery;
        button.textContent = this._searchScope === 'category' ? 'В этой папке' : 'Везде';
        button.setAttribute('aria-pressed', String(this._searchScope === 'category'));
        button.setAttribute(
            'aria-label',
            this._searchScope === 'category'
                ? `Искать в этой папке и её подпапках: ${this._folderPath.map(id => this._folderMap.get(id)?.name).filter(Boolean).join(' / ')}`
                : 'Искать во всех маршрутах'
        );
    },

    _createRouteRow(route) {
        const isActive = route.key === this.currentRoute;
        const locked = route.access === 'paid' && !route.owned;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'route-row' + (isActive ? ' is-active' : '') + (locked ? ' is-locked' : '');
        btn.dataset.routeKey = route.key;
        if (isActive) btn.setAttribute('aria-current', 'true');

        const preview = document.createElement('span');
        preview.className = 'route-preview';
        preview.dataset.routeKey = route.key;
        preview.setAttribute('aria-hidden', 'true');

        const main = document.createElement('span');
        main.className = 'route-row-main';

        const title = document.createElement('span');
        title.className = 'route-row-title';

        const name = document.createElement('span');
        name.className = 'route-row-name';
        name.textContent = route.name || route.m;
        title.appendChild(name);

        if (isActive) {
            const badge = document.createElement('span');
            badge.className = 'route-row-badge';
            badge.textContent = 'Загружен';
            title.appendChild(badge);
        }

        const meta = document.createElement('span');
        meta.className = 'route-row-meta';
        meta.textContent = route.folderNames.length ? route.folderNames.join(' · ') : 'Без папки';

        main.appendChild(title);
        const details = document.createElement('span');
        details.className = 'route-row-details';
        details.appendChild(meta);
        const stats = [];
        if (locked) {
            stats.push(this._formatPrice(route.priceKopecks));
        } else {
            if (route.pointCount) {
                stats.push(`${route.pointCount} ${this._pluralize(route.pointCount, 'точка', 'точки', 'точек')}`);
            }
            if (route.distanceMeters >= 10) {
                const distanceLabel = route.distanceMeters >= 1000
                    ? `${(route.distanceMeters / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`
                    : `${Math.round(route.distanceMeters)} м`;
                stats.push(`≈ ${distanceLabel}`);
            }
        }
        if (stats.length) {
            const statsEl = document.createElement('span');
            statsEl.className = 'route-row-stats' + (locked ? ' is-price' : '');
            statsEl.textContent = stats.join(' · ');
            details.appendChild(statsEl);
        }
        main.append(title, details);

        const tail = document.createElement('span');
        tail.className = 'route-row-tail';
        tail.setAttribute('aria-hidden', 'true');
        tail.innerHTML = locked
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'
            : isActive
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

        btn.append(preview, main, tail);
        btn.addEventListener('click', event => {
            event.stopPropagation();
            if (locked) {
                this._openPurchase(route.purchaseFolderId, route.title);
                return;
            }
            if (route.m) this.loadRouteByName(route.m);
        });
        return btn;
    },

    _destroyRoutePreviews() {
        if (this._previewObserver) {
            this._previewObserver.disconnect();
            this._previewObserver = null;
        }
    },

    _previewTheme() {
        return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    },

    _previewPalette() {
        const styles = getComputedStyle(document.documentElement);
        const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
        return {
            from: read('--preview-bg-from', '#F8FAFC'),
            to: read('--preview-bg-to', '#E8EEF6'),
            shadow: read('--preview-shadow', 'rgba(18, 28, 46, 0.20)')
        };
    },

    refreshRoutePreviews() {
        const container = document.getElementById('routesListContainer');
        if (!container) return;
        this._destroyRoutePreviews();
        this._previewQueue = [];
        this._previewQueuedKeys.clear();
        this._previewFetching.clear();
        this._previewJobs.clear();
        this._previewActive = false;
        this._previewImages.clear();
        container.querySelectorAll('.route-preview').forEach(element => {
            delete element.dataset.previewKey;
            element.replaceChildren();
            element.classList.remove('is-loading', 'is-empty');
        });
        this._observeRoutePreviews(container);
    },

    _observeRoutePreviews(container) {
        const previews = container.querySelectorAll('.route-preview');
        if (!previews.length) return;

        const showPreviewImage = (element, key, imageUrl) => {
            if (!element.isConnected || element.dataset.previewKey !== key) return;
            const image = document.createElement('img');
            image.className = 'route-preview-image';
            image.alt = '';
            image.src = imageUrl;
            element.replaceChildren(image);
            element.classList.remove('is-loading', 'is-empty');
        };

        previews.forEach(element => {
            const key = `route-preview-v12\0${this._previewTheme()}\0${element.dataset.routeKey}`;
            element.dataset.previewKey = key;
            const image = this._previewImages.get(key);
            if (image) showPreviewImage(element, key, image);
        });

        const renderPreview = async (element, key, routeData) => {
            const palette = this._previewPalette();
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
                    element.classList.remove('is-loading');
                    element.classList.add('is-empty');
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
                background.addColorStop(0, palette.from);
                background.addColorStop(1, palette.to);
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
                    context.strokeStyle = palette.shadow;
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
                document.querySelectorAll('.route-preview').forEach(candidate => {
                    showPreviewImage(candidate, key, imageUrl);
                });
            } catch (error) {
                console.warn('Не удалось создать превью маршрута:', error);
                element.classList.remove('is-loading');
                element.classList.add('is-empty');
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
                if (job.element.dataset.previewKey !== job.key) continue;
                const cachedImage = this._previewImages.get(job.key);
                if (cachedImage) {
                    job.showCached(cachedImage);
                    continue;
                }
                if (this._previewJobs.has(job.key)) continue;
                this._previewActive = true;
                this._previewJobs.set(job.key, true);
                job.element.replaceChildren();
                job.element.classList.add('is-loading');
                void renderPreview(job.element, job.key, job.routeData);
                return;
            }
        };

        const queuePreview = (element, key, routeData) => {
            if (this._previewJobs.has(key) || this._previewQueuedKeys.has(key)) return;
            this._previewQueuedKeys.add(key);
            this._previewQueue.push({
                key,
                element,
                routeData,
                showCached: image => showPreviewImage(element, key, image),
            });
            startNextPreview();
        };

        const createPreview = element => {
            if (!element.isConnected) return;
            const key = element.dataset.previewKey;
            const cachedImage = this._previewImages.get(key);
            if (cachedImage) {
                showPreviewImage(element, key, cachedImage);
                return;
            }
            if (
                this._previewJobs.has(key) ||
                this._previewQueuedKeys.has(key) ||
                this._previewFetching.has(key)
            ) return;

            const routeKey = element.dataset.routeKey;
            const cachedRoute = this._routeDataCache.get(routeKey);
            if (cachedRoute && Array.isArray(cachedRoute.data)) {
                queuePreview(element, key, cachedRoute.data);
                return;
            }

            // Старый локальный формат с data внутри каталога.
            const inlineData = this.routesDescriptions[routeKey]?.data;
            if (Array.isArray(inlineData)) {
                queuePreview(element, key, inlineData);
                return;
            }

            // Каталог без геометрии: догружаем её только для видимой строки.
            this._previewFetching.add(key);
            element.replaceChildren();
            element.classList.add('is-loading');
            this._fetchRoute(routeKey)
                .then(payload => {
                    this._previewFetching.delete(key);
                    if (!element.isConnected || element.dataset.previewKey !== key) return;
                    if (!Array.isArray(payload.data)) {
                        element.classList.remove('is-loading');
                        element.classList.add('is-empty');
                        return;
                    }
                    queuePreview(element, key, payload.data);
                })
                .catch(error => {
                    this._previewFetching.delete(key);
                    if (!element.isConnected || element.dataset.previewKey !== key) return;
                    element.classList.remove('is-loading');
                    element.classList.add('is-empty');
                    console.warn('Не удалось загрузить превью маршрута:', error);
                });
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
                <div class="screen-panel" id="jsonModalScreen">
                    <header class="screen-head">
                        <h1 class="screen-title">Маршруты</h1>
                        <button type="button" class="screen-close" id="jsonModalClose" aria-label="Закрыть">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
                        </button>
                    </header>
                    <div id="routesToolbar" class="routes-toolbar">
                        <div class="routes-search">
                            <svg class="routes-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                                <circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>
                            </svg>
                            <input id="routesSearchInput" class="routes-search-input" type="search" placeholder="Поиск маршрута" aria-label="Поиск маршрута" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
                            <button type="button" class="routes-search-clear" id="routesSearchClear" aria-label="Очистить поиск" hidden>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
                            </button>
                            <button type="button" class="routes-search-scope" id="routesSearchScope" hidden>Везде</button>
                        </div>
                        <nav id="routesBreadcrumb" class="routes-breadcrumb" aria-label="Путь к папке" hidden></nav>
                    </div>
                    <div id="routesListContainer" class="routes-list">
                        <div style="text-align:center; padding:20px; color:rgba(18,28,46,0.5); font-size:14px;">
                            Загрузка списка маршрутов...
                        </div>
                    </div>
                </div>
            </div>
            <div id="purchaseModal" class="screen-modal hidden">
                <div class="screen-panel purchase-panel">
                    <header class="screen-head">
                        <h1 class="screen-title" id="purchaseTitle">Доступ к папке</h1>
                        <button type="button" class="screen-close" id="purchaseClose" aria-label="Закрыть">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
                        </button>
                    </header>
                    <div class="purchase-body">
                        <div class="purchase-icon" aria-hidden="true">🔒</div>
                        <div class="purchase-name" id="purchaseName"></div>
                        <div class="purchase-price" id="purchasePrice"></div>
                        <p class="purchase-hint" id="purchaseHint">После оплаты откроются эта папка и все вложенные маршруты.</p>
                        <button type="button" class="purchase-buy" id="purchaseBuy">Купить доступ</button>
                        <button type="button" class="purchase-login" id="purchaseLogin" hidden>Войти с Яндексом</button>
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

        const purchaseClose = document.getElementById('purchaseClose');
        if (purchaseClose) purchaseClose.addEventListener('click', () => this._closePurchase());

        const purchaseBuy = document.getElementById('purchaseBuy');
        if (purchaseBuy) purchaseBuy.addEventListener('click', () => this._buyFolder());

        const purchaseLogin = document.getElementById('purchaseLogin');
        if (purchaseLogin) purchaseLogin.addEventListener('click', () => this._loginForPurchase());

        const searchInput = document.getElementById('routesSearchInput');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                this._searchQuery = searchInput.value.trim();
                this._saveMenuState();
                this._updateSearchClear();
                this._buildRoutesList();
            });
            searchInput.addEventListener('keydown', event => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    this._clearSearch();
                }
            });
        }

        const searchClear = document.getElementById('routesSearchClear');
        if (searchClear) {
            searchClear.addEventListener('click', () => {
                this._clearSearch();
                if (searchInput) searchInput.focus();
            });
        }

        const searchScope = document.getElementById('routesSearchScope');
        if (searchScope) {
            searchScope.addEventListener('click', () => {
                this._searchScope = this._searchScope === 'category' ? 'all' : 'category';
                this._saveMenuState();
                this._buildRoutesList();
            });
        }

        const breadcrumb = document.getElementById('routesBreadcrumb');
        if (breadcrumb) {
            breadcrumb.addEventListener('click', event => {
                const item = event.target.closest('[data-breadcrumb-index]');
                if (!item) return;
                const index = Number(item.dataset.breadcrumbIndex);
                if (!Number.isInteger(index)) return;
                this._folderPath = index === 0 ? [] : this._folderPath.slice(0, index);
                this._searchScope = 'all';
                this._saveMenuState();
                this._buildRoutesList();
            });
        }

        const routesList = document.getElementById('routesListContainer');
        if (routesList) {
            routesList.addEventListener('click', event => {
                const folder = event.target.closest('[data-folder-id]');
                if (!folder || !routesList.contains(folder)) return;
                if (folder.dataset.folderAccess === 'paid' && folder.dataset.folderOwned !== '1') {
                    this._openPurchase(
                        folder.dataset.purchaseFolderId || folder.dataset.folderId,
                        folder.dataset.folderName || ''
                    );
                    return;
                }
                this._folderPath = [...this._folderPath, folder.dataset.folderId];
                this._searchScope = 'all';
                this._saveMenuState();
                this._routesLoaded = false;
                this._catalog = [];
                this._buildRoutesList();
            });
        }
    },

    _openPurchase(folderId, folderName) {
        if (!folderId) return;
        this._pendingPurchaseFolderId = folderId;
        const folder = this._folderMap.get(folderId) || {};
        const loggedIn = !!(window.AuthModule && AuthModule.user);
        const title = $('purchaseTitle');
        const name = $('purchaseName');
        const price = $('purchasePrice');
        const hint = $('purchaseHint');
        const buy = $('purchaseBuy');
        const login = $('purchaseLogin');
        if (title) title.textContent = 'Доступ к папке';
        if (name) name.textContent = folderName || folder.name || 'Платная папка';
        if (price) price.textContent = this._formatPrice(folder.price_kopecks);
        if (hint) {
            hint.textContent = loggedIn
                ? 'После оплаты откроются эта папка и все вложенные маршруты.'
                : 'Войдите с Яндексом, чтобы оплатить доступ. После оплаты папка откроется на этом аккаунте.';
        }
        if (buy) buy.hidden = !loggedIn;
        if (login) login.hidden = loggedIn;
        const modal = $('purchaseModal');
        if (modal) modal.classList.remove('hidden');
    },

    _closePurchase() {
        const modal = $('purchaseModal');
        if (modal) modal.classList.add('hidden');
        this._pendingPurchaseFolderId = null;
    },

    _loginForPurchase() {
        if (window.AuthModule && typeof AuthModule.login === 'function') {
            AuthModule.login();
            return;
        }
        const returnTo =
            window.location.pathname +
            window.location.search +
            window.location.hash;
        window.location.href =
            '/auth/yandex/start?return=' + encodeURIComponent(returnTo);
    },

    async _buyFolder() {
        const folderId = this._pendingPurchaseFolderId;
        if (!folderId) return;
        const button = $('purchaseBuy');
        if (button) {
            button.disabled = true;
            button.textContent = 'Создаём заказ…';
        }
        try {
            const returnTo =
                window.location.pathname +
                window.location.search +
                window.location.hash;
            const response = await fetch('/api/orders', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({ folder_id: folderId, return: returnTo })
            });
            const payload = await response.json().catch(() => ({}));
            if (response.status === 401) {
                this._loginForPurchase();
                return;
            }
            if (!response.ok || !payload.confirmation_url) {
                const messages = {
                    payments_not_configured: 'Оплата временно недоступна',
                    already_available: 'Доступ уже открыт',
                    folder_is_free: 'Эта папка бесплатна',
                    price_not_set: 'Для папки не указана цена'
                };
                throw new Error(
                    messages[payload.error] || payload.error || `HTTP ${response.status}`
                );
            }
            window.location.href = payload.confirmation_url;
        } catch (e) {
            if (typeof showToast === 'function') {
                showToast(e.message, 'error', 5000);
            }
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = 'Купить доступ';
            }
        }
    },

    _handlePaymentReturn() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('payment') !== 'success') return;
        if (typeof showToast === 'function') {
            showToast('Оплата получена. Обновляем доступ…', 'success', 4000);
        }
        // Webhook ЮKassa может прийти на секунду позже возврата в браузер.
        setTimeout(() => this._loadRoutesList(), 1800);
        params.delete('payment');
        const query = params.toString();
        window.history.replaceState(
            null,
            '',
            window.location.pathname +
                (query ? '?' + query : '') +
                window.location.hash
        );
    },

    _clearSearch() {
        this._searchQuery = '';
        const input = document.getElementById('routesSearchInput');
        if (input) input.value = '';
        this._saveMenuState();
        this._updateSearchClear();
        this._buildRoutesList();
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

            // Каталог больше не содержит геометрию: грузим только выбранный
            // маршрут и кэшируем его до перезагрузки страницы.
            const data = await this._fetchRoute(routeM);

            await this.loadRoute(data);
            this.hideSpinner();
        } catch (e) {
            this.hideSpinner();
            if (e && (e.status === 401 || e.status === 402)) {
                this._openPurchase(e.purchaseFolderId, e.folderName);
                return;
            }
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

        const input = document.getElementById('routesSearchInput');
        if (input) input.value = this._searchQuery;
        this._updateSearchClear();
        this._buildRoutesList();
    },

    _updateSearchClear() {
        const clear = document.getElementById('routesSearchClear');
        if (clear) clear.hidden = !this._searchQuery;
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
