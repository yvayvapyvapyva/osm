// Прокси /api/* из веб-версии в nav-api-v2.
// Нужен, чтобы cookie веб-сессии ставились на домене сайта (pages.dev),
// а не на домене воркера. Секретов здесь нет.

const API_BASE = 'https://nav-api-v2.ivan43103.workers.dev';

export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '') || '/';
    const target = new URL(path + url.search, API_BASE);

    const headers = new Headers(request.headers);
    headers.delete('host');

    const init = {
        method: request.method,
        headers,
        redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
    }

    const response = await fetch(target, init);
    const out = new Headers(response.headers);
    out.delete('access-control-allow-origin');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: out,
    });
}
