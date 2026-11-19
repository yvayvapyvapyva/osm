/* Адаптер навигатора3 к API onepage2.
 *
 * Интерфейс навигатора3 ходит в /api/owners, /api/catalog, /api/route.
 * Здесь эти запросы переводятся в действия воркера навигатора
 * (?action=catalog/get) и возвращаются в формате, который ждёт menu-n3.
 */
(function (global) {
    'use strict';

    const API = 'https://nav-api-v2.ivan43103.workers.dev';
    const OWNER_ID = 'shared';
    const OWNER_NAME = 'Автоинструктор';

    const originalFetch = global.fetch ? global.fetch.bind(global) : null;
    if (!originalFetch) return;

    let catalogPromise = null;

    function jsonResponse(payload, status) {
        return new Response(JSON.stringify(payload), {
            status: status || 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store'
            }
        });
    }

    function workerGet(action, params) {
        const url = new URL(API);
        url.searchParams.set('action', action);
        Object.keys(params || {}).forEach((key) => {
            url.searchParams.set(key, params[key]);
        });
        return originalFetch(url.toString(), {
            method: 'GET',
            cache: 'no-store',
            headers: { Accept: 'application/json' }
        });
    }

    function workerPost(action, params, body) {
        const url = new URL(API);
        url.searchParams.set('action', action);
        Object.keys(params || {}).forEach((key) => {
            url.searchParams.set(key, params[key]);
        });
        return originalFetch(url.toString(), {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body || {})
        });
    }

    // Геометрия всех маршрутов корневой папки. Загружается один раз при входе
    // в корневую папку владельца: превью и переходы дальше идут из кэша.
    const ownerGeometries = new Map();

    function loadOwnerGeometry(rootId) {
        const key = String(rootId);
        if (!ownerGeometries.has(key)) {
            const request = workerPost('owner_bundle', { owner: key }, {
                tg_init_data: tgInitData(),
                editor_key: editorKey()
            })
                .then((response) => {
                    if (!response.ok) throw new Error('owner_bundle HTTP ' + response.status);
                    return response.json();
                })
                .then((payload) => {
                    const routes = new Map();
                    for (const route of (payload && payload.routes) || []) {
                        if (route && route.m) routes.set(String(route.m), route);
                    }
                    return {
                        routes,
                        signs: Array.isArray(payload && payload.signs) ? payload.signs : [],
                        owner: (payload && payload.owner) || null
                    };
                })
                .catch((error) => {
                    ownerGeometries.delete(key);
                    throw error;
                });
            ownerGeometries.set(key, request);
        }
        return ownerGeometries.get(key);
    }

    function loadCatalog() {
        if (!catalogPromise) {
            catalogPromise = workerGet('catalog')
                .then((response) => {
                    if (!response.ok) throw new Error('catalog HTTP ' + response.status);
                    return response.json();
                })
                .catch((error) => {
                    catalogPromise = null;
                    throw error;
                });
        }
        return catalogPromise;
    }

    function rememberFolders(catalog) {
        const parents = {};
        const names = {};
        (catalog.folders || []).forEach((folder) => {
            parents[String(folder.id)] = folder.parent_id == null ? '' : String(folder.parent_id);
            names[String(folder.id)] = folder.name || '';
        });
        global.OnepageFolders = { parents: parents, names: names };
    }

    // Корневые папки всех владельцев: на «Главной» показываем именно их,
    // без отдельного синтетического уровня «владелец».
    function topFolders(catalog) {
        return (catalog.folders || [])
            .filter((folder) => folder.parent_id == null || folder.parent_id === '')
            .map((folder) => String(folder.id));
    }

    function folderById(catalog, id) {
        return (catalog.folders || []).find((folder) => String(folder.id) === String(id)) || null;
    }

    function childrenMap(catalog) {
        const map = new Map();
        (catalog.folders || []).forEach((folder) => {
            const parent = folder.parent_id == null ? '' : String(folder.parent_id);
            if (!map.has(parent)) map.set(parent, []);
            map.get(parent).push(String(folder.id));
        });
        return map;
    }

    // Все папки поддерева, включая саму корневую.
    function subtreeIds(catalog, rootId) {
        const children = childrenMap(catalog);
        const out = [];
        const seen = new Set();
        const stack = [String(rootId)];
        while (stack.length) {
            const id = stack.pop();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
            for (const child of children.get(id) || []) stack.push(child);
        }
        return out;
    }

    // Верхнеуровневая папка, к которой относится папка маршрута.
    function topRootForFolder(catalog, folderId) {
        const byId = new Map((catalog.folders || []).map((folder) => [String(folder.id), folder]));
        let current = folderId == null ? '' : String(folderId);
        let top = '';
        const seen = new Set();
        while (current && byId.has(current) && !seen.has(current)) {
            seen.add(current);
            top = current;
            const folder = byId.get(current);
            current = folder.parent_id == null ? '' : String(folder.parent_id);
        }
        return top;
    }

    function paramValue(params, key) {
        if (!params) return '';
        if (typeof params.get === 'function') return String(params.get(key) || '');
        return String(params[key] || '');
    }

    function requestedRootId(catalog, params) {
        const owner = paramValue(params, 'owner');
        if (owner && folderById(catalog, owner)) return owner;
        const routeM = paramValue(params, 'm');
        if (routeM) {
            const route = (catalog.routes || []).find((item) => String(item.m) === routeM);
            const top = route ? topRootForFolder(catalog, route.folder_id) : '';
            if (top) return top;
        }
        const tops = topFolders(catalog);
        return tops.length ? tops[0] : OWNER_ID;
    }

    function ownerBundle(catalog, params, geometry) {
        rememberFolders(catalog);
        const rootId = requestedRootId(catalog, params);
        const rootFolder = folderById(catalog, rootId);
        const ids = rootFolder ? new Set(subtreeIds(catalog, rootId)) : null;

        const folders = (catalog.folders || [])
            .filter((folder) => !ids || ids.has(String(folder.id)))
            .map((folder) => {
                const folderId = String(folder.id);
                const parentId = folder.parent_id == null ? '' : String(folder.parent_id);
                const price = Number(folder.price) || 0;
                const shopClient = global.OnepageShop;
                const purchased = price > 0 && !!shopClient &&
                    typeof shopClient.hasAccess === 'function' && shopClient.hasAccess(folderId);
                return {
                    folder_id: folderId,
                    parent_id: ids && folderId === rootId ? '' : parentId,
                    name: folder.name || 'Папка',
                    sort_order: Number(folder.sort_order) || 0,
                    price,
                    purchased
                };
            });

        const shop = global.OnepageShop;
        const routes = (catalog.routes || [])
            .filter((route) => {
                if (!route || !route.m) return false;
                if (!ids) return true;
                const folderId = route.folder_id == null ? '' : String(route.folder_id);
                return ids.has(folderId);
            })
            .map((route) => {
                const m = String(route.m);
                const folderId = route.folder_id == null ? '' : String(route.folder_id);
                const mine = !!(geometry && geometry.owner && geometry.owner.is_owner);
                const adminAccess = !!(geometry && geometry.owner && geometry.owner.is_admin);
                const lockedByShop = shop && folderId ? shop.isLocked(folderId) : false;
                const full = geometry && geometry.routes ? geometry.routes.get(m) : null;
                const serverLocked = full ? !!full.locked : false;
                const premium = !!(lockedByShop || serverLocked);
                const locked = mine ? false : premium;
                const item = {
                    m,
                    title: route.name || route.m,
                    name: route.name || route.m,
                    folder_id: folderId,
                    description: route.description || '',
                    premium: premium,
                    locked: locked,
                    owned: mine,
                    admin: adminAccess,
                    viewed: !!(full && full.viewed) || !!route.viewed
                };
                // Пакет владельца уже содержит геометрию — меню сложит её в
                // _routeDataCache, и превью/переходы не делают запросов.
                if (full && Array.isArray(full.data) && (mine || !serverLocked)) {
                    item.data = full.data;
                }
                return item;
            });

        return {
            owner: {
                root_folder_id: rootId,
                name: rootFolder ? (rootFolder.name || OWNER_NAME) : OWNER_NAME,
                owner_name: rootFolder ? (rootFolder.owner_name || '') : '',
                owner_avatar: rootFolder ? (rootFolder.owner_avatar || '') : '',
                owner_username: rootFolder ? (rootFolder.owner_username || '') : '',
                owner_info: rootFolder ? (rootFolder.owner_info || '') : '',
                owner_tg_id: rootFolder ? (rootFolder.owner_tg_id || '') : ''
            },
            folders: folders,
            routes: routes,
            signs: (geometry && Array.isArray(geometry.signs)) ? geometry.signs : []
        };
    }

    // Премиум-маршрут — тот, что лежит в платной папке (или в её подпапке),
    // доступ к которой ещё не куплен. Считаем по locks каталога и доступам
    // OnepageShop, чтобы счётчик совпадал с бейджами внутри папок.
    function isPremiumRoute(catalog, route) {
        const byId = new Map((catalog.folders || []).map((folder) => [String(folder.id), folder]));
        const locks = new Set((catalog.locks || []).map((lock) => String(lock.id)));
        const shop = global.OnepageShop;
        const state = shop && shop.state;
        const access = state && state.loaded ? state.access : null;
        const unlimited = !!(state && state.unlimited);
        let current = route.folder_id == null ? '' : String(route.folder_id);
        const seen = new Set();
        while (current && byId.has(current) && !seen.has(current)) {
            if (locks.has(current) && !(unlimited || (access && access.has(current)))) {
                return true;
            }
            seen.add(current);
            const folder = byId.get(current);
            current = folder.parent_id == null ? '' : String(folder.parent_id);
        }
        return false;
    }

    function currentTgUserId() {
        try {
            const user = global.Telegram && global.Telegram.WebApp &&
                global.Telegram.WebApp.initDataUnsafe && global.Telegram.WebApp.initDataUnsafe.user;
            return user && user.id ? String(user.id) : '';
        } catch (e) { return ''; }
    }

    function handleOwners() {
        const shopReady = global.OnepageShop && global.OnepageShop.ready
            ? global.OnepageShop.ready
            : Promise.resolve();
        return Promise.all([loadCatalog(), shopReady]).then(([catalog]) => {
            const routeFolders = (catalog.routes || [])
                .map((route) => (route.folder_id == null ? '' : String(route.folder_id)));
            const countFor = (rootId) => {
                const ids = new Set(subtreeIds(catalog, rootId));
                return routeFolders.filter((folderId) => ids.has(folderId)).length;
            };
            const premiumFor = (rootId) => {
                const ids = new Set(subtreeIds(catalog, rootId));
                return (catalog.routes || []).filter((route) => {
                    const folderId = route.folder_id == null ? '' : String(route.folder_id);
                    return ids.has(folderId) && isPremiumRoute(catalog, route);
                }).length;
            };
            const roots = topFolders(catalog)
                .map((id) => folderById(catalog, id))
                .filter(Boolean)
                .sort((a, b) => {
                    const ao = Number.isFinite(a.sort_order) ? a.sort_order : 0;
                    const bo = Number.isFinite(b.sort_order) ? b.sort_order : 0;
                    if (ao !== bo) return ao - bo;
                    return String(a.name || '').localeCompare(String(b.name || ''), 'ru');
                });
            const tgUserId = currentTgUserId();
            const owners = roots.map((folder) => {
                const mine = !!tgUserId && String(folder.owner_tg_id || '') === tgUserId;
                const price = Number(folder.price) || 0;
                const shopClient = global.OnepageShop;
                const purchased = price > 0 && !!shopClient &&
                    typeof shopClient.hasAccess === 'function' && shopClient.hasAccess(String(folder.id));
                return {
                    root_folder_id: String(folder.id),
                    name: folder.name || OWNER_NAME,
                    owner_name: folder.owner_name || '',
                    owner_avatar: folder.owner_avatar || '',
                    owner_username: folder.owner_username || '',
                    owner_info: folder.owner_info || '',
                    owner_tg_id: folder.owner_tg_id || '',
                    is_owner: mine,
                    price,
                    purchased,
                    routes_count: countFor(folder.id),
                    premium_count: premiumFor(folder.id)
                };
            });
            if (!owners.length) {
                owners.push({
                    root_folder_id: OWNER_ID,
                    name: OWNER_NAME,
                    owner_name: '',
                    routes_count: routeFolders.length,
                    premium_count: (catalog.routes || []).filter((route) => isPremiumRoute(catalog, route)).length
                });
            }
            return jsonResponse({ owners });
        });
    }

    function handleCatalog(params) {
        const shopReady = global.OnepageShop && global.OnepageShop.ready
            ? global.OnepageShop.ready
            : Promise.resolve();
        return loadCatalog().then((catalog) => {
            const rootId = requestedRootId(catalog, params);
            // Один запрос на корневую папку. Если пакет недоступен, меню
            // продолжит работать на метаданных и догрузит превью по одному.
            const geometry = loadOwnerGeometry(rootId).catch(() => null);
            return Promise.all([shopReady, geometry])
                .then(([, data]) => jsonResponse(ownerBundle(catalog, params, data)));
        });
    }
    function tgInitData() {
        try {
            return (global.Telegram && global.Telegram.WebApp && global.Telegram.WebApp.initData) || '';
        } catch (e) {
            return '';
        }
    }

    function editorKey() {
        try { return global.localStorage.getItem('editor_key') || ''; } catch (e) { return ''; }
    }

    function handleRoute(m) {
        if (!m) return Promise.resolve(jsonResponse({ error: 'missing_route_name' }, 400));
        // POST, чтобы передать подпись Telegram или ключ редактора:
        // без них воркер считает посетителя гостем и закрывает платные папки.
        const routeUrl = new URL(API);
        routeUrl.searchParams.set('action', 'get');
        routeUrl.searchParams.set('m', m);
        return originalFetch(routeUrl.toString(), {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                tg_init_data: tgInitData(),
                editor_key: editorKey()
            })
        }).then(async (response) => {
            let payload = null;
            try { payload = await response.json(); } catch (e) {}
            if (!response.ok) {
                return jsonResponse(
                    { error: (payload && payload.error) || 'route_not_found' },
                    response.status
                );
            }
            if (!payload || !Array.isArray(payload.data)) {
                return jsonResponse({ error: 'invalid_route' }, 502);
            }
            return jsonResponse({
                m: payload.m || m,
                name: payload.name || m,
                data: payload.data
            });
        });
    }

    global.fetch = function (input, init) {
        const rawUrl = typeof input === 'string' ? input : (input && input.url) || '';
        let url;
        try {
            url = new URL(rawUrl, global.location.href);
        } catch (e) {
            return originalFetch(input, init);
        }

        // Внешние запросы (тайлы, TTS, Telegram) не трогаем.
        if (url.origin !== global.location.origin) {
            return originalFetch(input, init);
        }

        switch (url.pathname) {
            case '/api/owners':
                return handleOwners();
            case '/api/catalog':
                return handleCatalog(url.searchParams);
            case '/api/route':
                return handleRoute(url.searchParams.get('m'));
            case '/api/signs':
                return Promise.resolve(jsonResponse({ signs: [] }));
            case '/api/route/view':
                return workerPost('route_view', { m: url.searchParams.get('m') || '' }, {
                    tg_init_data: tgInitData()
                }).then(async (response) => {
                    let payload = null;
                    try { payload = await response.json(); } catch (e) {}
                    if (!response.ok) return jsonResponse(payload || { error: 'route_view_failed' }, response.status);
                    return jsonResponse(payload || { status: 'ok', viewed: true });
                }).catch(() => jsonResponse({ status: 'ok', viewed: true }));
            case '/api/premium/status':
                return Promise.resolve(jsonResponse({
                    active: false,
                    price: '',
                    price_value: 0,
                    currency: 'RUB',
                    days: 0,
                    payments_available: false,
                    providers: [],
                    logged_in: false
                }));
            case '/api/me':
                return Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401));
            default:
                return originalFetch(input, init);
        }
    };

    // После покупки старый пакет владельца содержит закрытые папки без
    // геометрии — сбрасываем кэш, чтобы загрузить свежий одним запросом.
    global.OnepageOwnerBundles = {
        clear: function () { ownerGeometries.clear(); }
    };
})(window);
