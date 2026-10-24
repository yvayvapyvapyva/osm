
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
    _previewMaps: new Set(),
    _previewImages: new Map(),
    _previewJobs: new Map(),

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
        if (!previews.length || typeof maplibregl === 'undefined') return;

        const styleKey = window.getNavigatorMapStyleKey();
        const showPreviewImage = (element, key, imageUrl) => {
            if (!element.isConnected || element.dataset.previewKey !== key) return;
            const image = document.createElement('img');
            image.className = 'route-preview-image';
            image.alt = '';
            image.src = imageUrl;
            element.replaceChildren(image);
        };

        previews.forEach(element => {
            const key = `${styleKey}\0${element.dataset.routeKey}`;
            element.dataset.previewKey = key;
            const image = this._previewImages.get(key);
            if (image) showPreviewImage(element, key, image);
        });

        const createPreview = element => {
            if (!element.isConnected) return;
            const key = element.dataset.previewKey;
            const cachedImage = this._previewImages.get(key);
            if (cachedImage) {
                showPreviewImage(element, key, cachedImage);
                return;
            }
            if (this._previewJobs.has(key)) return;

            const routeData = this.routesDescriptions[element.dataset.routeKey]?.data;
            if (!Array.isArray(routeData)) return;
            const host = document.createElement('div');
            const previewWidth = Math.max(1, element.clientWidth);
            const previewHeight = Math.max(1, element.clientHeight);
            host.style.cssText = `position:fixed;left:-10000px;top:0;width:${previewWidth}px;height:${previewHeight}px;visibility:hidden;pointer-events:none;`;
            document.body.appendChild(host);
            element.textContent = 'Подготавливаем кадр карты…';
            const map = new maplibregl.Map({
                container: host,
                style: window.getNavigatorMapStyle(),
                center: [0, 0],
                zoom: 2,
                attributionControl: false,
                interactive: false,
                fadeDuration: 0,
                preserveDrawingBuffer: true
            });
            element._routePreviewMap = map;
            this._previewMaps.add(map);

            let pointFeatures = [];
            let captureTimer = null;
            let captured = false;
            const finishPreview = async () => {
                if (captured) return;
                captured = true;
                if (captureTimer) clearTimeout(captureTimer);
                try {
                    const pointIcons = await Promise.all(pointFeatures.map(feature => new Promise((resolve, reject) => {
                        const icon = new Image();
                        icon.onload = () => resolve(icon);
                        icon.onerror = () => reject(new Error('Could not load route point icon'));
                        icon.src = window.getNavigatorPointIcon(
                            feature.properties.color,
                            feature.properties.number,
                            feature.properties.current,
                            feature.properties.hasComment
                        );
                    })));
                    const mapCanvas = map.getCanvas();
                    const composite = document.createElement('canvas');
                    composite.width = mapCanvas.width;
                    composite.height = mapCanvas.height;
                    const context = composite.getContext('2d');
                    if (!context) throw new Error('Could not create preview snapshot canvas');
                    context.drawImage(mapCanvas, 0, 0);

                    const pixelRatio = mapCanvas.width / map.getContainer().clientWidth || 1;
                    context.scale(pixelRatio, pixelRatio);
                    for (let index = pointFeatures.length - 1; index >= 0; index--) {
                        const feature = pointFeatures[index];
                        const point = map.project(feature.geometry.coordinates);
                        context.drawImage(pointIcons[index], point.x - 20, point.y - 20, 40, 40);
                    }

                    const imageUrl = composite.toDataURL('image/jpeg', 0.88);
                    this._previewImages.set(key, imageUrl);
                    container.querySelectorAll('.route-preview-map').forEach(candidate => {
                        showPreviewImage(candidate, key, imageUrl);
                    });
                } catch (error) {
                    console.warn('Не удалось сохранить кадр маршрута:', error);
                } finally {
                    this._previewJobs.delete(key);
                    this._previewMaps.delete(map);
                    map.remove();
                    host.remove();
                }
            };
            this._previewJobs.set(key, map);
            captureTimer = setTimeout(finishPreview, 15000);

            map.once('load', () => {
                const lineFeatures = [];
                pointFeatures = [];
                const bounds = new maplibregl.LngLatBounds();
                let pointNumber = 0;
                for (const segment of routeData) {
                    if (!segment || !Array.isArray(segment.pts)) continue;
                    const coordinates = segment.pts
                        .filter(point =>
                            Array.isArray(point) &&
                            Number.isFinite(point[0]) &&
                            Number.isFinite(point[1]) &&
                            Math.abs(point[0]) <= 90 &&
                            Math.abs(point[1]) <= 180
                        )
                        .map(point => [point[1], point[0]]);
                    if (!coordinates.length) continue;

                    coordinates.forEach(coordinate => bounds.extend(coordinate));
                    const color = this._ROUTE_COLORS[segment.color] || '#FFD700';
                    if (coordinates.length > 1) {
                        lineFeatures.push({
                            type: 'Feature',
                            properties: { color: color },
                            geometry: { type: 'LineString', coordinates: coordinates }
                        });
                    }

                    pointNumber++;
                    pointFeatures.push({
                        type: 'Feature',
                        properties: {
                            number: String(segment.id || pointNumber),
                            color: color,
                            current: pointNumber === 1,
                            hasComment: typeof segment.comm === 'string' && segment.comm.trim() !== ''
                        },
                        geometry: { type: 'Point', coordinates: coordinates[0] }
                    });
                }

                if (lineFeatures.length) {
                    map.addSource('route-preview-lines', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: lineFeatures }
                    });
                    map.addLayer({
                        id: 'route-preview-casing',
                        type: 'line',
                        source: 'route-preview-lines',
                        layout: { 'line-join': 'round', 'line-cap': 'round' },
                        paint: {
                            'line-color': '#101820',
                            'line-width': 7,
                            'line-opacity': 0.85
                        }
                    });
                    map.addLayer({
                        id: 'route-preview-route',
                        type: 'line',
                        source: 'route-preview-lines',
                        layout: { 'line-join': 'round', 'line-cap': 'round' },
                        paint: {
                            'line-color': ['get', 'color'],
                            'line-width': 4
                        }
                    });
                }

                if (!bounds.isEmpty()) {
                    map.fitBounds(bounds, {
                        padding: { top: 28, right: 28, bottom: 28, left: 28 },
                        maxZoom: 15,
                        duration: 0
                    });
                }
                map.once('idle', finishPreview);
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

            const preview = document.createElement('div');
            preview.className = 'route-preview-map';
            preview.dataset.routeKey = routeKey;
            preview.setAttribute('aria-hidden', 'true');
            btn.appendChild(preview);

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
        this._destroyRoutePreviews();
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
