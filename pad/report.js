// report.js — модуль отчётов о запуске мини-аппа.
//
// Вынесен из pad.html. Вся логика, связанная с отправкой отчёта боту,
// хранится здесь. Модуль самодостаточен и не зависит от DOM — работает,
// даже если подключён до готовности документа.
//
// Отчёт уходит на Cloudflare Worker (report_proxy), который пересылает
// его в Telegram Bot API со своей стороны — клиент не ходит в telegram.org.
// URL Worker'а задаётся в REPORT_URL. Параметр отключения: window.disableLaunchReport === true.

(function () {
    if (window.sendLaunchReport) return;

    const REPORT_URL = 'https://pad-report.ivan43103.workers.dev/';
    const REPORT_KEY = ''; // если задан — добавляется в заголовок X-Report-Key
    const isViewer = location.pathname.endsWith('/viewer.html')
        || new URLSearchParams(location.search).get('viewer') === '1';

    function appLabel() {
        return isViewer ? 'PAD Viewer' : 'PAD';
    }

    // Распознаёт короткий startapp-токен постоянного ID сцены.
    function decodeStartParam(param) {
        const match = /^s([a-z0-9]{8})$/.exec(String(param));
        return match ? { sceneId: match[1] } : null;
    }

    function sendReportMessage(lines) {
        try {
            lines = lines.concat(['— via Cloudflare ☁️']);
            const text = lines.filter(l => l !== null).join('\n');
            if (!text) return;
            const headers = { 'Content-Type': 'application/json' };
            if (REPORT_KEY) headers['X-Report-Key'] = REPORT_KEY;
            fetch(REPORT_URL, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ text: text })
            }).catch(() => {});
        } catch (e) {}
    }

    // Компактная сводка о пользователе: ключевые данные + признаки в одну строку.
    // Имя оборачивается в ссылку на фото (если есть) — клик по нему открывает фото.
    function userSummary() {
        const wa = window.Telegram && window.Telegram.WebApp;
        const u = wa && wa.initDataUnsafe && wa.initDataUnsafe.user;
        if (!u) return 'default';
        let name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'аноним';
        if (u.photo_url) name = '<a href="' + u.photo_url + '">' + name + '</a>';
        const idPart = 'ID ' + u.id;
        const userPart = u.username ? (name + ', @' + u.username + ', ' + idPart) : (name + ', ' + idPart);
        const tags = [];
        if (u.is_premium) tags.push('Premium');
        if (u.is_bot) tags.push('Бот');
        if (u.added_to_attachment_menu) tags.push('Меню вложений');
        return userPart + (tags.length ? ' | ' + tags.join(' · ') : '');
    }

    function sceneLinkLine(sceneName, source, sceneId) {
        if (!/^[a-z0-9]{8}$/.test(sceneId || '')) return null;
        const payload = 's' + sceneId;
        const link = 'https://t.me/E_ia_bot/pad?startapp=' + encodeURIComponent(payload);
        const label = source ? ('Загружена сцена ' + source + ': ') : 'Загружена сцена: ';
        return label + '<a href="' + link + '">' + sceneName + '</a>';
    }

    function sendLaunchReport() {
        try {
            const wa = window.Telegram && window.Telegram.WebApp;
            const lines = ['🚀 ' + appLabel() + ': ' + userSummary()];
            const startParam = (wa && wa.initDataUnsafe && wa.initDataUnsafe.start_param)
                || new URLSearchParams(location.search).get('startapp');
            if (startParam) {
                const decoded = decodeStartParam(startParam);
                if (decoded && decoded.sceneId) {
                    lines.push(sceneLinkLine('ID ' + decoded.sceneId, 'из ссылки', decoded.sceneId));
                }
            }
            const chat = [];
            if (wa && wa.initDataUnsafe && wa.initDataUnsafe.chat_type) chat.push(wa.initDataUnsafe.chat_type);
            if (wa && wa.initDataUnsafe) {
                const ci = wa.initDataUnsafe.chat_instance;
                if (ci) chat.push(String(ci));
            }
            if (wa) chat.push(wa.platform, 'WebApp ' + wa.version);
            else chat.push('unknown', 'WebApp 6.0');
            lines.push('chat: ' + chat.join(' · '));
            lines.push(new Date().toLocaleString('ru-RU'));
            sendReportMessage(lines);
        } catch (e) {}
    }

    // Отправляет отчёт о загрузке сцены из менеджера сцен (такой же формат, что и запуск).
    function sendSceneReport(sceneName, sceneId) {
        try {
            const wa = window.Telegram && window.Telegram.WebApp;
            const lines = ['🚀 ' + appLabel() + ': ' + userSummary()];
            lines.push(sceneLinkLine(sceneName, 'из меню', sceneId));
            const chat = [];
            if (wa && wa.initDataUnsafe && wa.initDataUnsafe.chat_type) chat.push(wa.initDataUnsafe.chat_type);
            if (wa && wa.initDataUnsafe) {
                const ci = wa.initDataUnsafe.chat_instance;
                if (ci) chat.push(String(ci));
            }
            if (wa) chat.push(wa.platform, 'WebApp ' + wa.version);
            lines.push('chat: ' + chat.join(' · '));
            lines.push(new Date().toLocaleString('ru-RU'));
            sendReportMessage(lines);
        } catch (e) {}
    }

    var launchReportSent = false;
    function sendLaunchReportOnce() {
        if (launchReportSent) return;
        launchReportSent = true;
        sendLaunchReport();
    }

    window.sendLaunchReport = sendLaunchReport;
    window.sendSceneReport = sendSceneReport;

    if (window.disableLaunchReport !== true) {
        // Отчёт о запуске отправляем только после того, как Telegram
        // проинициализирован — иначе userSummary() вернёт 'default'.
        if (window._tgInitDone) {
            sendLaunchReportOnce();
        } else if (typeof window.onTgReady === 'function') {
            window.onTgReady(sendLaunchReportOnce);
            // Резерв: если SDK Telegram так и не загрузился (недоступен/заблокирован),
            // через 6 секунд всё равно отправляем анонимный отчёт, чтобы запуск
            // не потерялся совсем.
            setTimeout(sendLaunchReportOnce, 6000);
        } else {
            sendLaunchReportOnce();
        }
    }
})();
