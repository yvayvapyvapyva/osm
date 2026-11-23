// Ссылка на веб-кабинет внутри навигатора (только веб-версия).
(function () {
    if (document.getElementById('webAccountLink')) return;
    const link = document.createElement('a');
    link.id = 'webAccountLink';
    link.href = '/account.html';
    link.textContent = 'Аккаунт';
    link.style.cssText = [
        'position:fixed',
        'left:12px',
        'bottom:calc(12px + env(safe-area-inset-bottom))',
        'z-index:9000',
        'height:38px',
        'padding:0 14px',
        'border-radius:19px',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'background:rgba(15,15,15,0.82)',
        'border:0.5px solid rgba(255,255,255,0.18)',
        'color:#fff',
        'font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif',
        'text-decoration:none',
        'box-shadow:0 8px 28px rgba(0,0,0,0.35)',
    ].join(';');
    document.body.appendChild(link);

    // В веб-версии оплата пока не подключена: не показываем кнопки Stars.
    if (!document.getElementById('webHideShop')) {
        const style = document.createElement('style');
        style.id = 'webHideShop';
        style.textContent = '.premium-buy-btn{display:none!important;}';
        document.head.appendChild(style);
    }

    // В веб-версии профиль не должен отправлять в Telegram.
    function renderWebProfile(box, email) {
        if (!box || box.dataset.webProfile === '1') return;
        box.dataset.webProfile = '1';
        box.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
        box.innerHTML = '';

        const title = document.createElement('div');
        title.textContent = email ? 'Вход по email' : 'Вы не вошли';
        title.style.cssText = 'font-size:15px;font-weight:700;color:inherit;';
        box.appendChild(title);

        if (email) {
            const value = document.createElement('div');
            value.textContent = email;
            value.style.cssText = 'font-size:14px;color:#5B6B80;overflow-wrap:anywhere;';
            box.appendChild(value);
        }

        const action = document.createElement('a');
        action.href = '/account.html';
        action.textContent = email ? 'Открыть личный кабинет' : 'Войти по email';
        action.style.cssText = 'align-self:flex-start;display:inline-flex;align-items:center;height:38px;padding:0 14px;border-radius:10px;background:#2FA8E0;color:#fff;font:700 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;text-decoration:none;';
        box.appendChild(action);
    }

    let webEmail = '';
    function renderCurrentProfile() {
        const box = document.getElementById('tgProfileCard');
        if (!box) return;
        delete box.dataset.webProfile;
        renderWebProfile(box, webEmail);
    }

    // Переопределяем профиль навигатора: в веб-версии он не должен
    // ссылаться на Telegram.
    window.renderTgProfile = renderCurrentProfile;

    fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
            if (!data || !data.ok || !data.account) return;
            webEmail = data.account.email || '';
            const box = document.getElementById('tgProfileCard');
            if (box && (box.textContent || '').indexOf('Профиль доступен') !== -1) renderCurrentProfile();
        })
        .catch(() => {});
})();
