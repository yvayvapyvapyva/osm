// Веб-версия навигатора: вход по email в профиле, без Telegram-заглушки.
(function () {
    'use strict';

    const params = new URLSearchParams(window.location.search);
    const authResult = params.get('auth');
    if (authResult) {
        params.delete('auth');
        const query = params.toString();
        window.history.replaceState(null, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
    }

    // В веб-версии оплата пока не подключена: не показываем кнопки Stars.
    if (!document.getElementById('webHideShop')) {
        const style = document.createElement('style');
        style.id = 'webHideShop';
        style.textContent = [
            '.premium-buy-btn{display:none!important;}',
            '.web-auth{display:flex;flex-direction:column;gap:12px;font-size:14px;}',
            '.web-auth-lead{color:var(--text-muted,#5B6B80);line-height:1.45;}',
            '.web-auth-input{width:100%;height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line,#D7DEE8);background:var(--surface-muted,#fff);color:var(--text,#101828);font:inherit;font-size:16px;outline:none;box-sizing:border-box;}',
            '.web-auth-input:focus{border-color:#2FA8E0;}',
            '.web-auth-btn{height:44px;padding:0 16px;border-radius:10px;border:1px solid #2FA8E0;background:#2FA8E0;color:#fff;font:700 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;cursor:pointer;}',
            '.web-auth-btn:disabled{opacity:.6;cursor:default;}',
            '.web-auth-btn-secondary{background:transparent;border-color:var(--line,#D7DEE8);color:var(--text,#344054);}',
            '.web-auth-note{color:var(--text-muted,#667085);font-size:12px;line-height:1.45;}',
            '.web-auth-note a{color:#2FA8E0;}',
            '.web-auth-status{min-height:18px;font-size:13px;line-height:1.4;color:var(--text-muted,#667085);}',
            '.web-auth-status.err{color:#D92D20;}',
            '.web-auth-status.ok{color:#067647;}',
            '.web-auth-codebox{display:none;flex-direction:column;gap:10px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line,#E4E7EC);}',
            '.web-auth-codebox.visible{display:flex;}',
            '.web-auth-code{width:100%;height:52px;padding:0 12px;border-radius:12px;border:1px solid var(--line,#D7DEE8);background:var(--surface-muted,#fff);color:var(--text,#101828);font:700 24px/1 monospace;letter-spacing:8px;text-align:center;outline:none;box-sizing:border-box;}',
            '.web-auth-code:focus{border-color:#2FA8E0;}',
            '.web-auth-codelabel{font-size:13px;color:var(--text-muted,#667085);}',
            '.web-auth-email{font-size:16px;font-weight:700;color:var(--text,#101828);overflow-wrap:anywhere;}',
            '.web-auth-actions{display:flex;gap:10px;flex-wrap:wrap;}',
            '.web-auth-actions .web-auth-btn{flex:1 1 auto;}',
            '.web-auth-section-title{margin-top:8px;font:700 13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--text,#101828);}',
            '.web-auth-access{display:flex;flex-direction:column;gap:8px;}',
            '.web-auth-access-item{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:10px;background:var(--surface-muted,#F7F9FC);border:1px solid var(--line,#E4E7EC);}',
            '.web-auth-access-name{font-size:13px;font-weight:600;color:var(--text,#101828);overflow-wrap:anywhere;}',
            '.web-auth-access-until{font-size:12px;color:var(--text-muted,#667085);white-space:nowrap;}',
            '@media (max-width:420px){.web-auth-access-item{flex-direction:column;gap:2px;}}',
        ].join('');
        document.head.appendChild(style);
    }

    let account = null;
    let authMessage = authResult === 'invalid' ? 'Ссылка недействительна или уже использована. Запросите новую.' : '';
    let authMessageKind = authResult === 'invalid' ? 'err' : '';

    function fetchMe() {
        return fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) { return data && data.ok ? data.account : null; })
            .catch(function () { return null; });
    }

    function renderProfile() {
        const box = document.getElementById('tgProfileCard');
        if (!box) return;
        // В веб-версии у профиля нет Telegram — убираем служебный заголовок.
        const group = box.closest('.settings-group');
        const groupLabel = group ? group.querySelector('.settings-label') : null;
        if (groupLabel) groupLabel.style.display = 'none';
        box.innerHTML = '';
        box.style.cssText = 'display:flex;flex-direction:column;gap:0;';

        if (account) {
            renderLoggedIn(box, account);
        } else {
            renderLogin(box);
        }
    }

    function renderLoggedIn(box, acc) {
        const wrap = document.createElement('div');
        wrap.className = 'web-auth';

        const label = document.createElement('div');
        label.className = 'web-auth-lead';
        label.textContent = 'Вы вошли по email';
        wrap.appendChild(label);

        const email = document.createElement('div');
        email.className = 'web-auth-email';
        email.textContent = acc.email || '';
        wrap.appendChild(email);

        const accessTitle = document.createElement('div');
        accessTitle.className = 'web-auth-section-title';
        accessTitle.textContent = 'Купленные папки';
        wrap.appendChild(accessTitle);

        const accessList = document.createElement('div');
        accessList.className = 'web-auth-access';
        const accessStatus = document.createElement('div');
        accessStatus.className = 'web-auth-status';
        accessStatus.textContent = 'Загрузка…';
        wrap.appendChild(accessStatus);
        wrap.appendChild(accessList);

        loadAccess(accessList, accessStatus);

        const actions = document.createElement('div');
        actions.className = 'web-auth-actions';

        const logout = document.createElement('button');
        logout.type = 'button';
        logout.className = 'web-auth-btn web-auth-btn-secondary';
        logout.textContent = 'Выйти';
        logout.addEventListener('click', function () {
            logout.disabled = true;
            fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
                .catch(function () {})
                .then(function () {
                    account = null;
                    authMessage = 'Вы вышли из аккаунта.';
                    authMessageKind = 'ok';
                    renderProfile();
                });
        });
        actions.appendChild(logout);

        wrap.appendChild(actions);
        box.appendChild(wrap);
    }

    function loadAccess(list, status) {
        Promise.all([
            fetch('/api/?action=my_access', { credentials: 'same-origin', cache: 'no-store' }),
            fetch('/api/?action=catalog', { credentials: 'same-origin', cache: 'no-store' }),
        ])
            .then(function (responses) {
                if (responses[0].status === 401) {
                    account = null;
                    authMessage = 'Сессия истекла. Войдите снова.';
                    authMessageKind = 'err';
                    renderProfile();
                    return null;
                }
                return Promise.all([
                    responses[0].json().catch(function () { return {}; }),
                    responses[1].json().catch(function () { return {}; }),
                ]);
            })
            .then(function (data) {
                if (!data) return;
                const access = data[0] || {};
                const catalog = data[1] || {};
                const expires = access.expires || {};
                const ids = Object.keys(expires);
                const folders = new Map();
                for (const folder of (catalog.folders || [])) folders.set(String(folder.id), folder);
                if (!ids.length) {
                    status.className = 'web-auth-status';
                    status.textContent = 'Пока нет купленных папок. Публичные маршруты доступны на карте.';
                    return;
                }
                status.textContent = '';
                for (const id of ids) {
                    const folder = folders.get(String(id)) || {};
                    const item = document.createElement('div');
                    item.className = 'web-auth-access-item';
                    const name = document.createElement('div');
                    name.className = 'web-auth-access-name';
                    name.textContent = folder.folder || folder.name || ('Папка #' + id);
                    const until = document.createElement('div');
                    until.className = 'web-auth-access-until';
                    const ts = Number(expires[id]);
                    until.textContent = ts ? 'до ' + new Date(ts * 1000).toLocaleDateString('ru-RU') : '';
                    item.appendChild(name);
                    item.appendChild(until);
                    list.appendChild(item);
                }
            })
            .catch(function () {
                status.className = 'web-auth-status err';
                status.textContent = 'Не удалось загрузить покупки.';
            });
    }

    function renderLogin(box) {
        const wrap = document.createElement('div');
        wrap.className = 'web-auth';

        const lead = document.createElement('div');
        lead.className = 'web-auth-lead';
        lead.textContent = 'Войдите по email, чтобы открыть купленные материалы. Пароль не нужен.';
        wrap.appendChild(lead);

        const form = document.createElement('form');
        form.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

        const input = document.createElement('input');
        input.type = 'email';
        input.className = 'web-auth-input';
        input.placeholder = 'you@example.com';
        input.autocomplete = 'email';
        input.inputMode = 'email';
        input.required = true;
        form.appendChild(input);

        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.className = 'web-auth-btn';
        submit.textContent = 'Получить ссылку для входа';
        form.appendChild(submit);

        const status = document.createElement('div');
        status.className = 'web-auth-status' + (authMessageKind ? ' ' + authMessageKind : '');
        status.textContent = authMessage || '';
        form.appendChild(status);

        const note = document.createElement('div');
        note.className = 'web-auth-note';
        note.innerHTML = 'Нажимая кнопку, вы принимаете <a href="/legal/offer.html" target="_blank" rel="noopener">оферту</a> и <a href="/legal/privacy.html" target="_blank" rel="noopener">политику конфиденциальности</a>.';
        form.appendChild(note);

        let cooldownTimer = null;
        let cooldownLeft = 0;

        function setStatus(text, kind) {
            status.textContent = text || '';
            status.className = 'web-auth-status' + (kind ? ' ' + kind : '');
        }

        function updateCooldown() {
            if (cooldownLeft <= 0) {
                submit.disabled = false;
                submit.textContent = 'Получить ссылку для входа';
                return;
            }
            submit.disabled = true;
            submit.textContent = 'Отправить ещё раз через ' + cooldownLeft + ' с';
        }

        submit.addEventListener('click', function () {
            if (cooldownLeft > 0) return;
        });

        form.addEventListener('submit', function (event) {
            event.preventDefault();
            const email = String(input.value || '').trim();
            if (!email) {
                setStatus('Введите email', 'err');
                return;
            }
            submit.disabled = true;
            setStatus('Отправляем ссылку…');
            fetch('/api/auth/email/request', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email, consent: true }),
            })
                .then(function (res) {
                    return res.json().catch(function () { return {}; }).then(function (data) {
                        return { res: res, data: data };
                    });
                })
                .then(function (result) {
                    if (result.res.status === 429) {
                        setStatus('Слишком много попыток. Попробуйте через 15 минут.', 'err');
                        return;
                    }
                    if (!result.res.ok) {
                        setStatus(result.data && result.data.error === 'email_not_configured'
                            ? 'Отправка писем временно недоступна. Попробуйте позже.'
                            : 'Не удалось отправить ссылку. Проверьте email.', 'err');
                        return;
                    }
                    setStatus('Код и ссылка отправлены на ' + email + '. Проверьте почту и папку «Спам».', 'ok');
                    showCodeForm(email);
                    authMessage = '';
                    cooldownLeft = 60;
                    updateCooldown();
                    cooldownTimer = setInterval(function () {
                        cooldownLeft -= 1;
                        updateCooldown();
                        if (cooldownLeft <= 0) {
                            clearInterval(cooldownTimer);
                            cooldownTimer = null;
                        }
                    }, 1000);
                })
                .catch(function () {
                    setStatus('Ошибка сети. Попробуйте ещё раз.', 'err');
                })
                .then(function () {
                    if (cooldownLeft <= 0) submit.disabled = false;
                });
        });

        const codeBox = document.createElement('form');
        codeBox.className = 'web-auth-codebox';
        codeBox.style.cssText = 'display:none;';

        const codeLabel = document.createElement('div');
        codeLabel.className = 'web-auth-codelabel';
        codeLabel.textContent = 'Или введите код из письма';
        codeBox.appendChild(codeLabel);

        const codeInput = document.createElement('input');
        codeInput.type = 'text';
        codeInput.className = 'web-auth-code';
        codeInput.inputMode = 'numeric';
        codeInput.autocomplete = 'one-time-code';
        codeInput.maxLength = 6;
        codeInput.placeholder = '000000';
        codeInput.pattern = '[0-9]{6}';
        codeInput.required = true;
        codeBox.appendChild(codeInput);

        const codeButton = document.createElement('button');
        codeButton.type = 'submit';
        codeButton.className = 'web-auth-btn';
        codeButton.textContent = 'Войти по коду';
        codeBox.appendChild(codeButton);

        const codeStatus = document.createElement('div');
        codeStatus.className = 'web-auth-status';
        codeBox.appendChild(codeStatus);

        let codeEmail = '';

        function showCodeForm(email) {
            codeEmail = email;
            codeBox.style.display = 'flex';
            codeInput.value = '';
            codeStatus.textContent = '';
            codeStatus.className = 'web-auth-status';
            try { codeInput.focus(); } catch (e) {}
        }

        codeBox.addEventListener('submit', function (event) {
            event.preventDefault();
            const value = String(codeInput.value || '').replace(/\D/g, '').slice(0, 6);
            codeInput.value = value;
            if (!/^\d{6}$/.test(value)) {
                codeStatus.className = 'web-auth-status err';
                codeStatus.textContent = 'Введите 6 цифр из письма';
                return;
            }
            codeButton.disabled = true;
            codeStatus.className = 'web-auth-status';
            codeStatus.textContent = 'Проверяем код…';
            fetch('/api/auth/email/verify-code', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: codeEmail, code: value }),
            })
                .then(function (res) {
                    return res.json().catch(function () { return {}; }).then(function (data) {
                        return { res: res, data: data };
                    });
                })
                .then(function (result) {
                    if (result.res.ok && result.data && result.data.ok) {
                        account = result.data.account;
                        authMessage = 'Вы вошли в аккаунт.';
                        authMessageKind = 'ok';
                        renderProfile();
                        return;
                    }
                    const error = result.data && result.data.error;
                    if (error === 'code_expired') {
                        codeStatus.textContent = 'Код истёк. Запросите новый.';
                    } else if (error === 'too_many_attempts') {
                        codeStatus.textContent = 'Слишком много попыток. Запросите новый код.';
                    } else {
                        codeStatus.textContent = 'Неверный код. Попробуйте ещё раз.';
                    }
                    codeStatus.className = 'web-auth-status err';
                })
                .catch(function () {
                    codeStatus.className = 'web-auth-status err';
                    codeStatus.textContent = 'Ошибка сети. Попробуйте ещё раз.';
                })
                .then(function () {
                    codeButton.disabled = false;
                });
        });

        wrap.appendChild(form);
        wrap.appendChild(codeBox);
        box.appendChild(wrap);

        if (authResult === 'invalid') {
            authMessage = '';
            authMessageKind = '';
        }
    }

    function openProfileIfNeeded() {
        if (authResult !== 'ok' && authResult !== 'invalid') return;
        const tab = document.querySelector('.top-nav-btn[data-tab="profile"]');
        if (!tab) return;
        setTimeout(function () { tab.click(); }, 300);
    }

    // Переопределяем профиль навигатора: в веб-версии он не должен
    // ссылаться на Telegram.
    window.renderTgProfile = renderProfile;

    fetchMe().then(function (me) {
        account = me;
        renderProfile();
        openProfileIfNeeded();
    });

    if (authResult === 'ok') {
        authMessage = 'Вы вошли в аккаунт.';
        authMessageKind = 'ok';
    }
})();
