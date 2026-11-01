/**
 * Вход через Яндекс ID для navigator3.
 *
 * Модуль работает только на том origin, где есть /api/me (то есть на API
 * Gateway). На старом домене бакета запрос вернёт HTML, и вход просто не
 * показывается — навигатор продолжает работать как раньше.
 */
const AuthModule = {
    user: null,
    enabled: false,
    _initialized: false,

    async init() {
        if (this._initialized) return;
        this._initialized = true;
        this._bind();
        this._showUrlError();
        await this._load();
    },

    _bind() {
        const login = document.getElementById('accountLogin');
        if (login) login.addEventListener('click', () => this.login());

        const logout = document.getElementById('accountLogout');
        if (logout) logout.addEventListener('click', () => this.logout());
    },

    async _load() {
        // Оффлайн-версия не использует авторизацию
        return;
    },

    render() {
        const loginGroup = document.getElementById('accountLoginGroup');
        const userGroup = document.getElementById('accountUserGroup');
        if (loginGroup) loginGroup.hidden = !this.enabled || !!this.user;
        if (userGroup) userGroup.hidden = !this.enabled || !this.user;

        if (!this.user) return;

        const name = document.getElementById('accountName');
        if (name) {
            name.textContent =
                this.user.display_name || this.user.login || 'Пользователь';
        }

        const email = document.getElementById('accountEmail');
        if (email) {
            email.textContent = this.user.email || '';
            email.hidden = !this.user.email;
        }
    },

    login() {
        const returnTo =
            window.location.pathname +
            window.location.search +
            window.location.hash;
        window.location.href =
            '/auth/yandex/start?return=' + encodeURIComponent(returnTo);
    },

    async logout() {
        const button = document.getElementById('accountLogout');
        if (button) {
            button.disabled = true;
            button.textContent = 'Выходим…';
        }
        try {
            await fetch('/auth/logout', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
            });
        } catch (e) {
            // Даже при сетевой ошибке перезагружаем страницу: cookie могла
            // уже удалиться, а /api/me покажет актуальное состояние.
        }
        window.location.reload();
    },

    _showUrlError() {
        const params = new URLSearchParams(window.location.search);
        const code = params.get('auth_error');
        if (!code) return;

        const messages = {
            access_denied: 'Вход отменён на стороне Яндекса',
            state_mismatch: 'Сессия входа истекла, попробуйте снова',
            token_exchange_failed: 'Яндекс не подтвердил вход, попробуйте снова',
            profile_failed: 'Не удалось получить профиль Яндекса',
            storage_failed: 'Ошибка сохранения пользователя, попробуйте позже',
            blocked: 'Доступ для этого аккаунта заблокирован',
            auth_not_configured: 'Вход временно недоступен',
        };
        if (typeof window.showToast === 'function') {
            window.showToast(messages[code] || 'Не удалось войти', 'error', 5000);
        }

        params.delete('auth_error');
        const query = params.toString();
        const clean =
            window.location.pathname +
            (query ? '?' + query : '') +
            window.location.hash;
        window.history.replaceState(null, '', clean);
    },
};

window.AuthModule = AuthModule;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AuthModule.init());
} else {
    AuthModule.init();
}
