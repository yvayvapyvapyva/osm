
const MenuModule = {
    callback: null,
    isLoaded: false,
    currentRoute: null,
    routesDescriptions: {}, // { "m": { name, description, m, data } }
    _routesLoaded: false,   // список с геометрией уже получен
    _isFetchingRoutes: false,
    _catalog: [],           // плоский список маршрутов с путём и категориями
    _activeCategory: 'all',
    _folderPath: [],
    _searchQuery: '',
    _searchScope: 'all',
    _recentRouteKeys: [],
    _recentLimit: 6,
    _RECENT_KEY: 'osm_recent_routes_v1',
    _MENU_STATE_KEY: 'osm_routes_menu_state_v1',
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
        this._loadRecentRoutes();
        this._loadMenuState();
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
                this._buildCatalog();
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
                description: typeof route.description === 'string' ? route.description.trim() : '',
                data: route.data
            };
        }

        this.routesDescriptions = routesFlat;
        this._buildCatalog();
    },

    /**
     * Плоский каталог вместо дерева. Путь по-прежнему строится по "/",
     * но хранится как категория + подкатегория для чипов и поиска.
     */
    _buildCatalog() {
        const catalog = [];

        for (const [key, route] of Object.entries(this.routesDescriptions)) {
            const fullPath = (route.name || key).trim() || key;
            const parts = fullPath.split('/').map(s => s.trim()).filter(Boolean);
            const leafName = parts.length ? parts.pop() : fullPath;
            const folders = parts;
            const top = folders[0] || 'Без категории';
            const sub = folders.length > 1 ? folders.slice(1).join(' / ') : null;

            catalog.push({
                key,
                m: route.m || key,
                name: leafName,
                fullPath,
                top,
                sub,
                folders,
                description: typeof route.description === 'string' ? route.description.trim() : '',
                ...this._measureRoute(route.data),
                search: this._normalizeSearch(
                    `${fullPath} ${typeof route.description === 'string' ? route.description : ''}`
                )
            });
        }

        catalog.sort((a, b) => a.fullPath.localeCompare(b.fullPath, 'ru'));
        this._catalog = catalog;

        if (this._activeCategory !== 'all' && this._activeCategory !== 'recent') {
            this._activeCategory = 'all';
        }
        if (this._activeCategory === 'recent' && !this._getRecentRoutes().length) {
            this._activeCategory = 'all';
        }
        if (this._activeCategory === 'recent') {
            this._folderPath = [];
            this._searchScope = 'all';
        }
        let validPath = [];
        for (const folder of this._folderPath) {
            const children = this._getChildFolders(validPath);
            if (!children.some(child => child.name === folder)) break;
            validPath.push(folder);
        }
        this._folderPath = validPath;
        this._saveMenuState();
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
                this._activeCategory = 'all';
            } else {
                if (saved.category === 'recent') this._activeCategory = 'recent';
                if (typeof saved.category === 'string' && saved.category.startsWith('cat:')) {
                    this._folderPath = [
                        saved.category.slice(4),
                        ...(typeof saved.subcategory === 'string' && saved.subcategory !== 'all'
                            ? saved.subcategory.split(' / ')
                            : [])
                    ];
                    this._activeCategory = 'all';
                }
            }
            if (typeof saved.query === 'string') this._searchQuery = saved.query;
            if (saved.searchScope === 'all' || saved.searchScope === 'category') {
                this._searchScope = saved.searchScope;
            }
        } catch (e) {
            this._activeCategory = 'all';
            this._folderPath = [];
            this._searchQuery = '';
            this._searchScope = 'all';
        }
    },

    _saveMenuState() {
        try {
            localStorage.setItem(this._MENU_STATE_KEY, JSON.stringify({
                category: this._activeCategory,
                folderPath: this._folderPath,
                query: this._searchQuery,
                searchScope: this._searchScope
            }));
        } catch (e) {}
    },

    _getChildFolders(parentPath) {
        const folders = new Map();
        for (const item of this._catalog) {
            if (item.folders.length <= parentPath.length ||
                !parentPath.every((folder, index) => item.folders[index] === folder)) continue;
            const name = item.folders[parentPath.length];
            folders.set(name, (folders.get(name) || 0) + 1);
        }
        return Array.from(folders, ([name, count]) => ({ name, count }))
            .sort((a, b) => {
                if (a.name === 'Без категории') return 1;
                if (b.name === 'Без категории') return -1;
                return a.name.localeCompare(b.name, 'ru');
            });
    },

    _isWithinFolder(item, path) {
        return item.folders.length >= path.length &&
            path.every((folder, index) => item.folders[index] === folder);
    },

    _loadRecentRoutes() {
        try {
            const saved = JSON.parse(localStorage.getItem(this._RECENT_KEY) || '[]');
            if (Array.isArray(saved)) {
                this._recentRouteKeys = saved
                    .filter(key => typeof key === 'string' && key)
                    .slice(0, this._recentLimit);
            }
        } catch (e) {
            this._recentRouteKeys = [];
        }
    },

    _rememberRecent(routeM) {
        if (!routeM) return;
        this._recentRouteKeys = [routeM, ...this._recentRouteKeys.filter(key => key !== routeM)]
            .slice(0, this._recentLimit);
        try {
            localStorage.setItem(this._RECENT_KEY, JSON.stringify(this._recentRouteKeys));
        } catch (e) {}
    },

    _getRecentRoutes() {
        const byKey = new Map(this._catalog.map(item => [item.key, item]));
        return this._recentRouteKeys.map(key => byKey.get(key)).filter(Boolean);
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
        } else if (this._activeCategory === 'recent') {
            routes = this._getRecentRoutes();
        } else {
            routes = this._catalog.filter(item =>
                item.folders.length === this._folderPath.length &&
                this._isWithinFolder(item, this._folderPath)
            );
        }

        return this._pinCurrentRoute(routes);
    },

    _pinCurrentRoute(routes) {
        if (!this.currentRoute || routes.length < 2) return routes;
        const index = routes.findIndex(route => route.key === this.currentRoute);
        if (index <= 0) return routes;
        return [routes[index], ...routes.slice(0, index), ...routes.slice(index + 1)];
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
        this._updateSearchScopeButton();

        // Список ещё не получен — показываем спиннер, а не «Нет маршрутов».
        if (!this._routesLoaded) {
            this._renderCategoryChips();
            this._renderSubcategoryChips();
            this._renderBreadcrumbs();
            if (this._isFetchingRoutes) {
                this._showListLoading();
            } else {
                this._loadRoutesList();
            }
            return;
        }

        const routes = this._getFilteredRoutes();
        this._renderCategoryChips();
        this._renderSubcategoryChips();
        this._renderBreadcrumbs();

        container.innerHTML = '';

        if (!this._catalog.length) {
            container.innerHTML = '<div class="routes-empty"><div class="routes-empty-title">Нет маршрутов</div></div>';
            return;
        }

        const childFolders = !this._searchQuery && this._activeCategory !== 'recent'
            ? this._getChildFolders(this._folderPath)
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
                ? `в папке «${this._folderPath.join(' / ')}»`
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
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'routes-folder-row';
                button.dataset.folder = folder.name;
                button.innerHTML = `
                    <span class="routes-folder-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>
                        </svg>
                    </span>
                    <span class="routes-folder-name">${this._escape(folder.name)}</span>
                    <span class="routes-folder-count" aria-label="${folder.count} ${this._pluralize(folder.count, 'маршрут', 'маршрута', 'маршрутов')}">
                        ${folder.count} ${this._pluralize(folder.count, 'маршрут', 'маршрута', 'маршрутов')}
                    </span>
                    <span class="routes-folder-chevron" aria-hidden="true">›</span>
                `;
                folderList.appendChild(button);
            }
            container.appendChild(folderList);
        }
        const frag = document.createDocumentFragment();
        for (const route of routes) frag.appendChild(this._createRouteRow(route));
        container.appendChild(frag);
        this._observeRoutePreviews(container);
    },

    _renderCategoryChips() {
        const el = document.getElementById('routesCategoryChips');
        if (!el) return;

        if (!this._catalog.length || this._folderPath.length || this._activeCategory === 'recent') {
            el.innerHTML = '';
            el.hidden = true;
            return;
        }

        const scrollLeft = el.scrollLeft;
        el.innerHTML = '';

        const recent = this._getRecentRoutes();
        const chips = recent.length
            ? [{ key: 'recent', label: 'Недавние', count: recent.length }]
            : [];

        for (const chip of chips) {
            const button = document.createElement('button');
            button.type = 'button';
            const isActive = this._activeCategory === chip.key;
            button.className = 'routes-chip' + (isActive ? ' active' : '');
            button.dataset.category = chip.key;
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', String(isActive));
            button.innerHTML = `
                <span class="routes-chip-label">${this._escape(chip.label)}</span>
                <span class="routes-chip-count">${chip.count}</span>
            `;
            el.appendChild(button);
        }

        el.hidden = !!this._searchQuery || !chips.length;
        el.scrollLeft = scrollLeft;
        this._ensureActiveChipVisible(el);
        this._updateChipFades(el);
    },

    _ensureActiveChipVisible(el) {
        if (!el || el.hidden) return;
        const active = el.querySelector('.routes-chip.active');
        if (!active) return;
        const elRect = el.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        if (activeRect.left < elRect.left) {
            el.scrollLeft -= elRect.left - activeRect.left + 12;
        } else if (activeRect.right > elRect.right) {
            el.scrollLeft += activeRect.right - elRect.right + 12;
        }
    },

    _renderSubcategoryChips() {
        const el = document.getElementById('routesSubcategoryChips');
        if (!el) return;
        el.innerHTML = '';
        el.hidden = true;
    },

    _renderBreadcrumbs() {
        const el = document.getElementById('routesBreadcrumb');
        if (!el) return;
        el.innerHTML = '';
        const labels = this._activeCategory === 'recent'
            ? ['Все маршруты', 'Недавние']
            : ['Все маршруты', ...this._folderPath];
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
            item.className = 'routes-breadcrumb-item' + (index === labels.length - 1 ? ' current' : '');
            item.textContent = label;
            item.dataset.breadcrumbIndex = String(index);
            if (index === labels.length - 1) item.setAttribute('aria-current', 'location');
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
                ? `Искать в этой папке и её подпапках: ${this._folderPath.join(' / ')}`
                : 'Искать во всех маршрутах'
        );
    },

    _updateChipFades(el) {
        if (!el || el.hidden) return;
        const maxScroll = el.scrollWidth - el.clientWidth;
        el.classList.toggle('can-scroll-left', el.scrollLeft > 1);
        el.classList.toggle('can-scroll-right', el.scrollLeft < maxScroll - 1);
    },

    _createRouteRow(route) {
        const isActive = route.key === this.currentRoute;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'route-row' + (isActive ? ' is-active' : '');
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
        meta.textContent = route.folders.length ? route.folders.join(' · ') : 'Без категории';

        main.appendChild(title);
        const details = document.createElement('span');
        details.className = 'route-row-details';
        details.appendChild(meta);
        const stats = [];
        if (route.pointCount) {
            stats.push(`${route.pointCount} ${this._pluralize(route.pointCount, 'точка', 'точки', 'точек')}`);
        }
        if (route.distanceMeters >= 10) {
            const distanceLabel = route.distanceMeters >= 1000
                ? `${(route.distanceMeters / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км`
                : `${Math.round(route.distanceMeters)} м`;
            stats.push(`≈ ${distanceLabel}`);
        }
        if (stats.length) {
            const statsEl = document.createElement('span');
            statsEl.className = 'route-row-stats';
            statsEl.textContent = stats.join(' · ');
            details.appendChild(statsEl);
        }
        main.append(title, details);

        const tail = document.createElement('span');
        tail.className = 'route-row-tail';
        tail.setAttribute('aria-hidden', 'true');
        tail.innerHTML = isActive
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

        btn.append(preview, main, tail);
        btn.addEventListener('click', event => {
            event.stopPropagation();
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
            const key = `route-preview-v11\0${element.dataset.routeKey}`;
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
                        <div id="routesCategoryChips" class="routes-chips" role="tablist" aria-label="Быстрые фильтры" hidden></div>
                        <div id="routesSubcategoryChips" class="routes-chips routes-chips-sub" role="tablist" aria-label="Подкатегории" hidden></div>
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

        const closeBtn = document.getElementById('jsonModalClose');
        if (closeBtn) closeBtn.addEventListener('click', () => this.hide());

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

        const categoryChips = document.getElementById('routesCategoryChips');
        if (categoryChips) {
            categoryChips.addEventListener('click', event => {
                const chip = event.target.closest('.routes-chip');
                if (!chip) return;
                const key = chip.dataset.category;
                if (!key || key === this._activeCategory) return;
                this._activeCategory = key;
                this._folderPath = [];
                this._searchScope = 'all';
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
                if (this._activeCategory === 'recent') {
                    if (index !== 0) return;
                    this._activeCategory = 'all';
                    this._folderPath = [];
                } else {
                    this._activeCategory = 'all';
                    this._folderPath = index === 0 ? [] : this._folderPath.slice(0, index);
                }
                this._searchScope = 'all';
                this._saveMenuState();
                this._buildRoutesList();
            });
        }

        const routesList = document.getElementById('routesListContainer');
        if (routesList) {
            routesList.addEventListener('click', event => {
                const folder = event.target.closest('[data-folder]');
                if (!folder || !routesList.contains(folder)) return;
                this._activeCategory = 'all';
                this._folderPath = [...this._folderPath, folder.dataset.folder];
                this._searchScope = 'all';
                this._saveMenuState();
                this._buildRoutesList();
            });
        }

        [categoryChips].forEach(chips => {
            if (!chips) return;
            chips.addEventListener('scroll', () => this._updateChipFades(chips), { passive: true });
        });
    },

    _clearSearch() {
        this._searchQuery = '';
        const input = document.getElementById('routesSearchInput');
        if (input) input.value = '';
        this._saveMenuState();
        this._updateSearchClear();
        this._buildRoutesList();
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
            this._rememberRecent(routeM);
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
