// Cloudflare Worker — API маршрутов на D1.
//
// Точка входа: роутинг по action и ответы. Вся логика вынесена в lib/:
//   lib/http.js      — CORS, json(), escapeHtml()
//   lib/telegram.js  — verifyTgInitData(), tgApi()
//   lib/db.js        — маршруты, папки, замки платных папок, доступы покупателей
//   lib/editor.js    — EDITOR_ACTIONS, requireUser()
//   lib/shop.js      — покупки, баланс звёзд, возвраты, уведомления в канал
//   lib/bot.js       — вебхук Telegram и админ-команды бота
//   lib/report.js    — прокси отчётов в Telegram Bot API
//
// Упрощённая модель: общий неймспейс, без аккаунтов.
// Читать маршруты может любой посетитель, редактировать — только редакторы
// (см. requireUser: подпись Telegram или EDITOR_ACCESS_KEY).
// Ключ маршрута — только `m` (колонка id всегда 'shared', оставлена для совместимости).
//
// Роуты:
//   GET /?action=list_routes                      — публичный список (visible=1)
//   GET /?action=catalog                          — маршруты + папки + замки одним ответом (меню)
// Оба публичных списка не показывают скрытые папки (visible=0 в редакторе) и то,
// что внутри них. В редакторе такие папки видны и доступны как обычно.
//   GET /?action=get&m=NAME                       — маршрут {name, m, data}
//   GET/POST /?action=list                        — все маршруты (для редактора)
//   GET/POST /?action=get_protected&m=NAME        — то же, что get (для редактора)
//   POST /?action=save&m=NAME {data}              — сохранить точки
//   POST /?action=delete&m=NAME                   — удалить
//   GET/POST /?action=get_meta&m=NAME             — метаданные
//   POST /?action=save_meta&m=NAME {name, description, visible, creator_name, new_m?}
//   POST /report { text, lat?, lon? }             — прокси отчётов в Telegram Bot API
//   Платные папки (Telegram Stars):
//   GET  /?action=locks                            — {locks:[{id, folder, price}]} (публично)
//   POST /?action=save_lock {folder, price}        — пометить папку платной (price 0 — снять)
//   POST /?action=del_lock {folder}               — снять замок
//   POST /?action=my_access {initData}            — {user_id, ids:[...], expires:{id:ts}} (Telegram)
//   POST /?action=shop_invoice {initData, folder_id} — {invoiceLink, price, folder, folder_id}
//   POST /?action=shop_claim {initData}           — сверить оплаты, {ids:[...], expires}
//   Замки и доступ считаются по id папки, а не по пути из имён: у двух папок
//   может быть одинаковое имя. Маршрут в платной папке через action=get требует
//   tg_init_data покупателя, иначе 403 {error:'locked', id, folder, price}.
//   Экшены редактора доступны владельцу: маршруты и папки привязаны к Telegram ID.
//
// Env:
//   DB               — D1 database binding (см. schema.sql)
//   TELEGRAM_TOKEN   — токен бота (wrangler secret put, для /report и вебхука)
//   TG_SECRET        — секрет вебхука Telegram (заголовок X-Telegram-Bot-Api-Secret-Token)
//   REPORT_CHAT_ID   — чат для отчётов (переменная [vars])
//   PURCHASE_CHANNEL_ID — канал для уведомлений о покупках и возвратах
//                         (@username публичного или -100… приватного). Не задан — уведомления не шлются.
//   EDITOR_ACCESS_KEY — ключ для входа в редактор из браузера (вне Telegram). Не задан — только через Telegram.
//   EDITOR_KEY_UID   — Telegram user id, от чьего имени работает вход по ключу.
//   ADMIN_IDS        — Telegram user id админов бота (команды /balance, /stats, /refund), через запятую.

import { CORS, json } from './lib/http.js';
import { verifyTgInitData, tgApi } from './lib/telegram.js';
import {
  SHARED_ID, resolveM, findRoute, parseData, normFolder,
  lockForFolder, loadFolderIndex, folderPathIn, findFolderIdByPath,
  hasAccess, accessExpires, hiddenFolderIds,
} from './lib/db.js';
import { EDITOR_ACTIONS, requireUser, editorPasswordAllowed } from './lib/editor.js';
import { handleReport } from './lib/report.js';
import { recordPurchase, isAdmin } from './lib/shop.js';
import { handleTelegramWebhook } from './lib/bot.js';

// Список платных папок для клиента: id — для сопоставления, folder — для показа.
// Путь в ответе справочный: у двух папок может быть одинаковое имя, различает их id.
function locksFromIndex(index) {
  const out = [];
  for (const f of index.values()) {
    if ((f.price || 0) > 0) {
      out.push({ id: f.id, folder: folderPathIn(index, f.id), price: f.price });
    }
  }
  return out;
}

// Попадает ли маршрут в публичные списки (catalog, list_routes). Маршрут в
// скрытой папке — не попадает; папка задаётся по id. Маршрут с несуществующей
// папкой считается корневым и показывается как раньше.
function isPublicRoute(route, hidden) {
  const fid = route.folder_id;
  return fid === null || fid === undefined || !hidden.has(fid);
}

/* ---------- Веб-аккаунты и вход по email ---------- */

const WEB_COOKIE = 'nav_web_session';
const WEB_SESSION_DAYS = 30;
const WEB_TOKEN_MINUTES = 15;

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const piece = part.trim();
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    if (piece.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(piece.slice(eq + 1));
    } catch {
      return piece.slice(eq + 1);
    }
  }
  return '';
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function webCookie(token, maxAge) {
  return `${WEB_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function readWebSession(request, env) {
  const token = readCookie(request, WEB_COOKIE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT s.token_hash, s.expires_at, a.id AS account_id, a.email,
            a.email_verified_at, a.created_at
       FROM web_sessions s
       JOIN web_accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
      LIMIT 1`
  ).bind(hash, now).first();
  if (!row) return null;
  return { token, hash, account: row };
}

async function webHasAccess(env, accountId, folderId) {
  if (!accountId) return false;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT 1 FROM purchases
      WHERE account_id = ? AND product_type = 'folder_access' AND product_id = ?
        AND status = 'active' AND expires_at > ?
      LIMIT 1`
  ).bind(String(accountId), String(folderId), now).first();
  return !!row;
}

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams();
    body.set('secret', env.TURNSTILE_SECRET);
    body.set('response', String(token));
    if (ip) body.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = await res.json().catch(() => ({}));
    return !!data.success;
  } catch {
    return false;
  }
}

async function sendWebEmail(env, to, link) {
  const from = String(env.WEB_EMAIL_FROM || 'navigator@ainstruktor.ru');
  const subject = 'Вход в веб-версию навигатора';
  const text = `Здравствуйте!\n\nСсылка для входа в веб-версию навигатора:\n${link}\n\nСсылка действует 15 минут. Если вы не запрашивали вход, просто проигнорируйте письмо.`;
  const html = `<p>Здравствуйте!</p><p>Ссылка для входа в веб-версию навигатора:</p><p><a href="${link}">Войти в навигатор</a></p><p>Ссылка действует 15 минут. Если вы не запрашивали вход, просто проигнорируйте письмо.</p>`;

  if (env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({ from, to, subject, text, html }),
    });
    if (!res.ok) throw new Error('resend_failed');
    return;
  }
  if (env.EMAIL && typeof env.EMAIL.send === 'function') {
    await env.EMAIL.send({ from, to, subject, text, html });
    return;
  }
  throw new Error('email_not_configured');
}

function webRedirect(location, cookie) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

async function handleEmailRequest(request, env, body) {
  const email = normalizeEmail(body.email);
  if (!email) return json({ ok: false, error: 'bad_email' }, 400);
  if (body.consent !== true && body.consent !== 'true') {
    return json({ ok: false, error: 'consent_required' }, 400);
  }
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await verifyTurnstile(env, body.turnstile_token, ip))) {
    return json({ ok: false, error: 'captcha_failed' }, 403);
  }

  const now = Math.floor(Date.now() / 1000);
  const since = now - 15 * 60;
  const byEmail = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM web_email_tokens WHERE email = ? AND created_at > ?'
  ).bind(email, since).first();
  if (byEmail && Number(byEmail.n) >= 5) {
    return json({ ok: false, error: 'too_many_requests' }, 429);
  }
  if (ip) {
    const byIp = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM web_email_tokens WHERE ip = ? AND created_at > ?'
    ).bind(ip, since).first();
    if (byIp && Number(byIp.n) >= 20) {
      return json({ ok: false, error: 'too_many_requests' }, 429);
    }
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = now + WEB_TOKEN_MINUTES * 60;
  await env.DB.prepare(
    `INSERT INTO web_email_tokens (token_hash, email, purpose, created_at, expires_at, ip)
     VALUES (?, ?, 'login', ?, ?, ?)`
  ).bind(tokenHash, email, now, expiresAt, ip).run();

  const base = String(env.WEB_APP_URL || 'https://avtoinstruktor-web.pages.dev').replace(/\/+$/, '');
  const link = `${base}/api/auth/email/verify?token=${encodeURIComponent(token)}`;
  try {
    await sendWebEmail(env, email, link);
  } catch (e) {
    await env.DB.prepare('DELETE FROM web_email_tokens WHERE token_hash = ?').bind(tokenHash).run();
    console.error('web email send failed:', (e && e.message) || e);
    return json({ ok: false, error: 'email_not_configured' }, 503);
  }
  return json({ ok: true });
}

async function handleEmailVerify(request, env, url) {
  const token = url.searchParams.get('token') || '';
  const base = String(env.WEB_APP_URL || 'https://avtoinstruktor-web.pages.dev').replace(/\/+$/, '');
  if (!token) return webRedirect(`${base}/index.html?auth=invalid`);
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT token_hash, email, expires_at, used_at FROM web_email_tokens
      WHERE token_hash = ? LIMIT 1`
  ).bind(tokenHash).first();
  if (!row || row.used_at || Number(row.expires_at) <= now) {
    return webRedirect(`${base}/index.html?auth=invalid`);
  }
  const email = normalizeEmail(row.email);
  if (!email) return webRedirect(`${base}/index.html?auth=invalid`);

  let account = await env.DB.prepare(
    'SELECT id, email, created_at FROM web_accounts WHERE email = ? LIMIT 1'
  ).bind(email).first();
  if (!account) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO web_accounts (id, email, email_verified_at, consent_at, consent_version, created_at, status)
       VALUES (?, ?, ?, ?, '2026-11-23', ?, 'active')`
    ).bind(id, email, now, now, now).run();
    account = { id, email, created_at: now };
  } else {
    await env.DB.prepare(
      'UPDATE web_accounts SET email_verified_at = ? WHERE id = ?'
    ).bind(now, account.id).run();
  }
  await env.DB.prepare('UPDATE web_email_tokens SET used_at = ? WHERE token_hash = ?')
    .bind(now, tokenHash).run();

  const sessionToken = randomToken();
  const sessionHash = await sha256Hex(sessionToken);
  const sessionExpires = now + WEB_SESSION_DAYS * 24 * 3600;
  await env.DB.prepare(
    `INSERT INTO web_sessions (id, account_id, token_hash, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    crypto.randomUUID(),
    account.id,
    sessionHash,
    now,
    sessionExpires,
    request.headers.get('CF-Connecting-IP') || '',
    String(request.headers.get('User-Agent') || '').slice(0, 500)
  ).run();

  return webRedirect(`${base}/account.html?auth=ok`, webCookie(sessionToken, WEB_SESSION_DAYS * 24 * 3600));
}

async function handleAuthMe(request, env) {
  const session = await readWebSession(request, env);
  if (!session) return json({ ok: false, error: 'unauthorized' }, 401);
  return json({
    ok: true,
    account: {
      id: session.account.account_id,
      email: session.account.email,
      email_verified_at: session.account.email_verified_at,
      created_at: session.account.created_at,
    },
  });
}

async function handleLogout(request, env) {
  const session = await readWebSession(request, env);
  if (session) {
    await env.DB.prepare('UPDATE web_sessions SET revoked_at = ? WHERE token_hash = ?')
      .bind(Math.floor(Date.now() / 1000), session.hash).run();
  }
  return json({ ok: true }, 200, { 'Set-Cookie': webCookie('', 0) });
}

// Корневая папка владельца — контейнер, в котором лежат все его папки и
// маршруты. Одна на Telegram-аккаунт. Создаётся при первом обращении.
async function ensureOwnerRoot(env, uid, defaultName, profile) {
  const info = profile || {};
  const avatar = String(info.avatar || '').trim();
  const username = String(info.username || '').trim();
  // Числовой ID вместо имени не сохраняем — это запасной вариант клиента.
  const rawName = String(info.name || '').trim();
  const displayName = /^\d+$/.test(rawName) ? '' : rawName;

  const readRoot = () => env.DB.prepare(
    'SELECT r.folder_id, r.owner_name, r.owner_avatar, r.owner_username, r.owner_info, f.name, f.parent_id FROM owner_roots r JOIN folders f ON f.id = r.folder_id WHERE r.owner_tg_id = ?')
    .bind(uid).first();

  const existing = await readRoot();
  if (existing) {
    // Корень не должен быть вложенным: чиним данные после старых гонок.
    if (existing.parent_id !== null && existing.parent_id !== '') {
      await env.DB.prepare('UPDATE folders SET parent_id = NULL WHERE id = ?')
        .bind(existing.folder_id).run();
    }
    // Имя владельца не редактируется вручную: подставляем его из Telegram,
    // если оно ещё не заполнено. Аватар и username обновляем всегда.
    const nextName = String(existing.owner_name || '').trim() || displayName;
    const nextAvatar = avatar || String(existing.owner_avatar || '');
    const nextUsername = username || String(existing.owner_username || '');
    if (nextName !== String(existing.owner_name || '') ||
        nextAvatar !== String(existing.owner_avatar || '') ||
        nextUsername !== String(existing.owner_username || '')) {
      await env.DB.prepare(
        'UPDATE owner_roots SET owner_name = ?, owner_avatar = ?, owner_username = ? WHERE owner_tg_id = ?')
        .bind(nextName, nextAvatar, nextUsername, uid).run();
      existing.owner_name = nextName;
      existing.owner_avatar = nextAvatar;
      existing.owner_username = nextUsername;
    }
    await env.DB.prepare(
      "UPDATE roads SET folder_id = ? WHERE owner_tg_id = ? AND (folder_id IS NULL OR folder_id = '')")
      .bind(existing.folder_id, uid).run();
    return existing;
  }

  // Для старых данных: первая папка верхнего уровня становится корневой.
  let candidate = await env.DB.prepare(
    "SELECT id, name FROM folders WHERE owner_tg_id = ? AND (parent_id IS NULL OR parent_id = '') ORDER BY id LIMIT 1")
    .bind(uid).first();
  let createdId = null;
  if (!candidate) {
    const name = String(defaultName || '').trim() || 'Мои маршруты';
    const res = await env.DB.prepare(
      'INSERT INTO folders (name, parent_id, visible, price, owner_tg_id) VALUES (?, NULL, 1, 0, ?)')
      .bind(name, uid).run();
    createdId = res.meta && res.meta.last_row_id ? res.meta.last_row_id : null;
    candidate = { id: createdId, name };
  }

  // Корень один на владельца. Если два запроса одновременно создают папку,
  // owner_roots достанется первому, а лишнюю пустую папку удаляем.
  // Результат INSERT OR IGNORE в D1 не даёт надёжно понять, кто победил,
  // поэтому после вставки всегда перечитываем owner_roots.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO owner_roots (owner_tg_id, folder_id, owner_name, owner_avatar, owner_username, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(uid, candidate.id, displayName, avatar, username, Date.now()).run();
  let root = candidate;
  let rootOwnerName = displayName;
  const winner = await readRoot();
  if (winner) {
    root = { id: winner.folder_id, name: winner.name };
    rootOwnerName = String(winner.owner_name || '').trim() || displayName;
    if (!winner.owner_name && displayName) {
      await env.DB.prepare('UPDATE owner_roots SET owner_name = ? WHERE owner_tg_id = ?')
        .bind(displayName, uid).run();
    }
    if (createdId && Number(winner.folder_id) !== Number(createdId)) {
      await env.DB.prepare(
        'DELETE FROM folders WHERE id = ? AND (SELECT COUNT(*) FROM roads WHERE folder_id = ?) = 0 AND (SELECT COUNT(*) FROM folders WHERE parent_id = ?) = 0')
        .bind(createdId, createdId, createdId).run();
    }
  }

  await env.DB.prepare(
    "UPDATE folders SET parent_id = ? WHERE owner_tg_id = ? AND (parent_id IS NULL OR parent_id = '') AND id <> ?")
    .bind(root.id, uid, root.id).run();
  await env.DB.prepare(
    "UPDATE roads SET folder_id = ? WHERE owner_tg_id = ? AND (folder_id IS NULL OR folder_id = '')")
    .bind(root.id, uid).run();
  return {
    folder_id: root.id,
    name: root.name,
    owner_name: rootOwnerName || '',
    owner_avatar: avatar,
    owner_username: username,
    owner_info: '',
    owner_tg_id: uid,
  };
}

// Дорожные знаки из сцены { markers: [...] } в компактном формате навигатора.
function signsFromScene(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.markers)) return [];
  const signs = [];
  for (const marker of data.markers) {
    if (!marker || typeof marker !== 'object' || marker.kind !== 'znak') continue;
    const code = String(marker.code || '').trim();
    const file = String(marker.file || '').trim();
    if (!code || !file) continue;
    const lat = Number(marker.lat);
    const lon = Number(marker.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    signs.push({
      code,
      file,
      lat,
      lon,
      heading: Number(marker.heading) || 0,
      leg: !!marker.leg,
      plates: Array.isArray(marker.plates)
        ? marker.plates.map((plate) => String(plate || '').trim()).filter(Boolean)
        : [],
    });
  }
  return signs;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === '/webhook') return handleTelegramWebhook(request, env, ctx);
    if (url.pathname === '/report') return handleReport(request, env);

    if (!env.DB) return json({ error: 'DB not bound' }, 500);

    // ---- Веб-вход по email (страницы на Pages, запросы через прокси) ----
    if (url.pathname.startsWith('/auth/')) {
      try {
        if (url.pathname === '/auth/email/request' && request.method === 'POST') {
          let body = {};
          try { body = await request.json(); } catch { body = {}; }
          return await handleEmailRequest(request, env, body);
        }
        if (url.pathname === '/auth/email/verify' && request.method === 'GET') {
          return await handleEmailVerify(request, env, url);
        }
        if (url.pathname === '/auth/me' && request.method === 'GET') {
          return await handleAuthMe(request, env);
        }
        if (url.pathname === '/auth/logout' && request.method === 'POST') {
          return await handleLogout(request, env);
        }
        return json({ error: 'not_found' }, 404);
      } catch (e) {
        console.error('web auth error:', (e && e.message) || e);
        return json({ ok: false, error: 'auth_failed' }, 500);
      }
    }

    const action = url.searchParams.get('action') || 'get';
    const mVal = url.searchParams.get('m');

    let bodyData = {};
    if (request.method === 'POST') {
      try {
        bodyData = await request.json();
      } catch {
        bodyData = {};
      }
    }

    try {
      // ---- Публичный список маршрутов ----
      if (action === 'list_routes') {
        const rows = (await env.DB.prepare(
          'SELECT m, name, description, creator_name, folder_id FROM roads WHERE visible = 1 AND name IS NOT NULL ORDER BY name')
          .all()).results || [];
        const folders = (await env.DB.prepare(
          'SELECT id, parent_id, visible FROM folders').all()).results || [];
        const hidden = hiddenFolderIds(folders);
        return json(rows
          .filter((r) => isPublicRoute(r, hidden))
          .map((r) => ({
            m: r.m, name: r.name,
            description: r.description || '', creator_name: r.creator_name || '',
            folder_id: r.folder_id || null,
          })), 200, { 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      }

      // ---- Каталог одним запросом: маршруты + папки + замки ----
      // Нужен меню навигатора, чтобы дерево папок строилось сразу из одного
      // ответа. Иначе список успевает отрисоваться «плоским» до прихода
      // отдельного запроса folder_list.
      if (action === 'catalog') {
        const routes = (await env.DB.prepare(
          'SELECT m, name, description, creator_name, folder_id FROM roads WHERE visible = 1 AND name IS NOT NULL ORDER BY name')
          .all()).results || [];
        const folders = (await env.DB.prepare(
          `SELECT f.id, f.name, f.parent_id, f.price, f.visible,
                  COALESCE(r.owner_name, '') AS owner_name,
                  COALESCE(r.owner_avatar, '') AS owner_avatar,
                  COALESCE(r.owner_username, '') AS owner_username,
                  COALESCE(r.owner_info, '') AS owner_info,
                  COALESCE(r.owner_tg_id, '') AS owner_tg_id
             FROM folders f
             LEFT JOIN owner_roots r ON r.folder_id = f.id
            ORDER BY f.name`).all()).results || [];
        // Скрытые в редакторе папки в приложение не попадают — ни сама папка,
        // ни маршруты внутри неё (скрытие наследуется вниз, см. hiddenFolderIds).
        const hidden = hiddenFolderIds(folders);
        // Пустые корневые папки (без видимых маршрутов во всём поддереве) в
        // меню не показываем: они создаются при первом входе в редактор и
        // только засоряют каталог.
        const parentById = new Map();
        for (const f of folders) {
          parentById.set(Number(f.id), f.parent_id === null || f.parent_id === '' ? null : Number(f.parent_id));
        }
        const rootOf = new Map();
        const findRoot = (id) => {
          if (rootOf.has(id)) return rootOf.get(id);
          const chain = [];
          let cur = id;
          let guard = 0;
          while (cur !== null && guard++ < 200) {
            if (rootOf.has(cur)) { cur = rootOf.get(cur); break; }
            chain.push(cur);
            const parent = parentById.get(cur);
            if (parent === undefined || parent === null) break;
            cur = parent;
          }
          for (const item of chain) rootOf.set(item, cur);
          return cur;
        };
        const routesByRoot = new Map();
        for (const r of routes) {
          if (r.folder_id === null || r.folder_id === undefined) continue;
          const rootId = findRoot(Number(r.folder_id));
          routesByRoot.set(rootId, (routesByRoot.get(rootId) || 0) + 1);
        }
        const emptyRoots = new Set();
        for (const f of folders) {
          const id = Number(f.id);
          if (f.parent_id !== null && f.parent_id !== '') continue;
          if (!routesByRoot.get(id)) emptyRoots.add(id);
        }
        const inEmptyRoot = (id) => emptyRoots.has(findRoot(Number(id)));
        const locks = locksFromIndex(await loadFolderIndex(env));
        return json({
          routes: routes
            .filter((r) => isPublicRoute(r, hidden))
            .map((r) => ({
              m: r.m, name: r.name,
              description: r.description || '', creator_name: r.creator_name || '',
              folder_id: r.folder_id || null,
            })),
          folders: folders
            .filter((f) => !hidden.has(f.id) && !inEmptyRoot(f.id))
            .map((f) => ({
              id: f.id, name: f.name, parent_id: f.parent_id, price: f.price || 0,
              owner_name: f.owner_name || f.owner_username || '',
              owner_avatar: f.owner_avatar || '',
              owner_username: f.owner_username || '',
              owner_info: f.owner_info || '',
              owner_tg_id: f.owner_tg_id || '',
            })),
          locks,
        }, 200, { 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      }

      // ---- Отметка просмотра маршрута (хранится по пользователю) ----
      if (action === 'route_view') {
        const routeM = resolveM(bodyData.m || url.searchParams.get('m') || '');
        if (!routeM) return json({ error: 'missing_route_name' }, 400);
        const initData = bodyData.tg_init_data || url.searchParams.get('tg_init_data') || '';
        const { uid } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN);
        let viewerId = uid ? String(uid) : '';
        if (!viewerId) {
          const session = await readWebSession(request, env);
          if (session) viewerId = `web:${session.account.account_id}`;
        }
        if (viewerId) {
          const now = Math.floor(Date.now() / 1000);
          await env.DB.prepare(
            `INSERT INTO route_views (user_id, m, first_viewed_at, last_viewed_at, view_count)
             VALUES (?, ?, ?, ?, 1)
             ON CONFLICT(user_id, m) DO UPDATE SET
               last_viewed_at = excluded.last_viewed_at,
               view_count = view_count + 1`)
            .bind(viewerId, routeM, now, now).run();
        }
        return json({ status: 'ok', viewed: true });
      }

      // ---- Пакет корневой папки владельца: маршруты с геометрией ----
      // Открытие корневой папки — один запрос. Отдаём все видимые маршруты
      // поддерева; геометрию платных папок — только владельцу или покупателю.
      if (action === 'owner_bundle') {
        const rawOwner = bodyData.owner || url.searchParams.get('owner');
        const rootId = Number(rawOwner);
        if (!Number.isFinite(rootId)) return json({ error: 'missing_owner' }, 400);
        const root = await env.DB.prepare(
          'SELECT id, name, owner_tg_id FROM folders WHERE id = ?').bind(rootId).first();
        if (!root) return json({ error: 'owner_not_found' }, 404);

        const guard = await requireUser(request, bodyData, env);
        const uid = guard.ok ? String(guard.uid || '') : '';
        const webSession = !uid ? await readWebSession(request, env) : null;
        const webAccountId = webSession ? String(webSession.account.account_id) : '';
        const viewOwnerId = uid || (webAccountId ? `web:${webAccountId}` : '');
        const viewedRoutes = new Set();
        if (viewOwnerId) {
          const viewRows = (await env.DB.prepare(
            'SELECT m FROM route_views WHERE user_id = ?').bind(viewOwnerId).all()).results || [];
          for (const row of viewRows) viewedRoutes.add(String(row.m));
        }
        const rootMeta = await env.DB.prepare(
          'SELECT owner_name, owner_avatar, owner_username, owner_info FROM owner_roots WHERE owner_tg_id = ?')
          .bind(String(root.owner_tg_id || '')).first();
        const ownerTgId = String(root.owner_tg_id || '');
        const ownerName = (rootMeta && rootMeta.owner_name) || (rootMeta && rootMeta.owner_username) || '';
        const isAdminUser = !!uid && isAdmin(uid, env);
        const isOwner = !!uid && (ownerTgId === uid || isAdminUser);
        const isAdminAccess = isAdminUser && ownerTgId !== uid;

        const allFolders = (await env.DB.prepare(
          'SELECT id, parent_id, visible FROM folders').all()).results || [];
        const hidden = hiddenFolderIds(allFolders);
        const subRows = (await env.DB.prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM folders WHERE id = ?
             UNION ALL
             SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
           )
           SELECT id FROM sub`).bind(rootId).all()).results || [];
        const ids = subRows
          .map((row) => Number(row.id))
          .filter((id) => !hidden.has(id));

        if (!ids.length) {
          return json({ owner: { root_folder_id: rootId, name: root.name || '', owner_name: ownerName, owner_avatar: (rootMeta && rootMeta.owner_avatar) || '', owner_username: (rootMeta && rootMeta.owner_username) || '', owner_info: (rootMeta && rootMeta.owner_info) || '', owner_tg_id: ownerTgId, is_owner: isOwner, is_admin: isAdminAccess }, routes: [] },
            200, { 'Cache-Control': 'no-store, must-revalidate' });
        }

        const placeholders = ids.map(() => '?').join(',');
        const rows = (await env.DB.prepare(
          `SELECT m, name, description, creator_name, folder_id, json
             FROM roads
            WHERE visible = 1 AND name IS NOT NULL AND folder_id IN (${placeholders})
            ORDER BY name`).bind(...ids).all()).results || [];

        const index = await loadFolderIndex(env);
        const access = uid ? await accessExpires(env, uid) : {};
        if (webAccountId) {
          const now = Math.floor(Date.now() / 1000);
          const webRows = (await env.DB.prepare(
            `SELECT product_id, expires_at FROM purchases
              WHERE account_id = ? AND product_type = 'folder_access'
                AND status = 'active' AND expires_at > ?`
          ).bind(webAccountId, now).all()).results || [];
          for (const row of webRows) access[String(row.product_id)] = Number(row.expires_at);
        }

        const routes = rows.map((row) => {
          const folderId = row.folder_id;
          const lock = folderId !== null && folderId !== undefined
            ? lockForFolder(index, folderId)
            : null;
          const allowed = !lock || isOwner ||
            Object.prototype.hasOwnProperty.call(access, String(lock.id));
          const item = {
            m: row.m,
            name: row.name || '',
            description: row.description || '',
            creator_name: row.creator_name || '',
            folder_id: row.folder_id || null,
            locked: !allowed,
            viewed: viewedRoutes.has(String(row.m)),
          };
          if (allowed) {
            item.data = parseData(row.json);
          } else if (lock) {
            item.lock = { id: lock.id, folder: lock.folder, price: lock.price };
          }
          return item;
        });

        let signs = [];
        const rootOwnerId = String(root.owner_tg_id || '');
        if (rootOwnerId) {
          const scene = await env.DB.prepare(
            'SELECT data FROM owner_signs WHERE owner_tg_id = ?').bind(rootOwnerId).first();
          if (scene && scene.data) {
            try {
              signs = signsFromScene(JSON.parse(scene.data));
            } catch (e) {
              signs = [];
            }
          }
        }

        return json({
          owner: {
            root_folder_id: rootId,
            name: root.name || '',
            owner_name: ownerName,
            owner_avatar: (rootMeta && rootMeta.owner_avatar) || '',
            owner_username: (rootMeta && rootMeta.owner_username) || '',
            owner_info: (rootMeta && rootMeta.owner_info) || '',
            owner_tg_id: ownerTgId,
            is_owner: isOwner,
            is_admin: isAdminAccess,
          },
          routes,
          signs,
        }, 200, { 'Cache-Control': 'no-store, must-revalidate' });
      }

      // ---- Проверка прав пользователя (без изменений данных) ----
      if (action === 'editor_password_check') {
        return json({
          ok: editorPasswordAllowed(bodyData.password, env),
          configured: !!String(env.EDITOR_PASSWORD || ''),
        }, 200, { 'Cache-Control': 'no-store' });
      }

      if (action === 'editor_check') {
        const guard = await requireUser(request, bodyData, env);
        const uid = guard.ok ? String(guard.uid || '') : '';
        const passwordOk = editorPasswordAllowed(bodyData.editor_password, env);
        const allowed = guard.ok && passwordOk;
        return json({
          allowed,
          via: guard.via || null,
          uid: uid || null,
          is_admin: allowed && !!uid && isAdmin(uid, env),
          password_ok: passwordOk,
        });
      }

      // ---- Защита экшенов редактора ----
      // Любой пользователь Telegram, но каждый видит и меняет только свои
      // маршруты и папки (owner_tg_id).
      let userUid = '';
      if (EDITOR_ACTIONS.has(action)) {
        const guard = await requireUser(request, bodyData, env);
        if (!guard.ok) return json({ error: 'forbidden' }, 403);
        userUid = String(guard.uid || '');
        if (!userUid) return json({ error: 'forbidden' }, 403);
        if (!editorPasswordAllowed(bodyData.editor_password, env)) {
          return json({ error: 'editor_password_required' }, 403);
        }
      }

      // Админ может работать от имени другого владельца: все owner-scoped
      // действия ниже используют actingUid. Для остальных owner игнорируется.
      const isAdminUser = !!userUid && isAdmin(userUid, env);
      let actingUid = userUid;
      if (isAdminUser) {
        const requestedOwner = String(bodyData.owner || url.searchParams.get('owner') || '').trim();
        if (requestedOwner && requestedOwner !== userUid) {
          const ownerRow = await env.DB.prepare(
            'SELECT owner_tg_id FROM owner_roots WHERE owner_tg_id = ?').bind(requestedOwner).first();
          if (!ownerRow) return json({ error: 'owner_not_found' }, 404);
          actingUid = requestedOwner;
        }
      }

      // ---- Список владельцев для админского переключения ----
      if (action === 'admin_owners') {
        if (!isAdminUser) return json({ error: 'forbidden' }, 403);
        const rows = (await env.DB.prepare(
          `SELECT r.owner_tg_id, r.owner_name, r.owner_username, r.owner_info,
                  f.id AS root_folder_id, f.name AS root_name,
                  (SELECT COUNT(*) FROM roads WHERE owner_tg_id = r.owner_tg_id) AS routes_count,
                  (SELECT COUNT(*) FROM folders WHERE owner_tg_id = r.owner_tg_id) AS folders_count
             FROM owner_roots r
             JOIN folders f ON f.id = r.folder_id
            WHERE r.owner_tg_id <> ?
            ORDER BY r.owner_name, r.owner_tg_id`).bind(userUid).all()).results || [];
        return json({
          self: userUid,
          owners: rows.map((row) => ({
            owner_tg_id: String(row.owner_tg_id),
            owner_name: row.owner_name || row.owner_username || '',
            owner_username: row.owner_username || '',
            owner_info: row.owner_info || '',
            root_folder_id: row.root_folder_id,
            root_name: row.root_name || '',
            routes_count: Number(row.routes_count) || 0,
            folders_count: Number(row.folders_count) || 0,
          })),
        });
      }

      // ---- Получение маршрута ----
      // get — навигатор, с проверкой платных папок (нужен tg_init_data покупателя).
      // get_protected — редактор, без ограничений.
      if (action === 'get' || action === 'get_protected') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const { row, m } = await findRoute(env, mVal);
        if (!row) return json({ error: 'not_found' }, 404);
        if (action === 'get_protected' && String(row.owner_tg_id || '') !== actingUid) {
          return json({ error: 'not_found' }, 404);
        }
        if (action === 'get') {
          // Папка маршрута — только folder_id (реальная иерархия). Замок ищем
          // по id, а не по пути из имён: у двух папок-соседей имя может совпадать.
          const index = await loadFolderIndex(env);
          const folderId = row.folder_id;
          const lock = folderId !== null && folderId !== undefined
            ? lockForFolder(index, folderId)
            : null;
          if (lock) {
            const initData = url.searchParams.get('tg_init_data') || bodyData.tg_init_data || '';
            const { uid } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN);
            // Владелец и админ открывают платную папку без покупки.
            const owner = String(row.owner_tg_id || '');
            const adminAccess = !!uid && isAdmin(uid, env);
            const webSession = !uid ? await readWebSession(request, env) : null;
            const webAccess = webSession
              ? await webHasAccess(env, webSession.account.account_id, lock.id)
              : false;
            if (!(uid && owner && String(uid) === owner) && !adminAccess &&
                !(uid && await hasAccess(env, uid, lock.id)) && !webAccess) {
              return json({ error: 'locked', id: lock.id, folder: lock.folder, price: lock.price }, 403);
            }
          }
        }
        return json({ name: row.name || '', m, data: parseData(row.json) });
      }

      // ---- Полный список (для редактора) ----
      if (action === 'list') {
        const root = await ensureOwnerRoot(env, actingUid, '', actingUid === userUid ? {
          avatar: bodyData.tg_avatar,
          username: bodyData.tg_username,
          name: bodyData.tg_name,
        } : {});
        const rows = (await env.DB.prepare(
          'SELECT m, name, visible, folder_id FROM roads WHERE owner_tg_id = ? ORDER BY name')
          .bind(actingUid).all()).results || [];
        return json({
          root: {
            folder_id: root.folder_id,
            name: root.name || '',
            owner_name: root.owner_name || root.owner_username || '',
            owner_avatar: root.owner_avatar || '',
            owner_username: root.owner_username || '',
            owner_info: root.owner_info || '',
            owner_tg_id: actingUid,
          },
          routes: rows.map((r) => ({
            m: r.m, name: r.name || '', visible: r.visible === 1, folder_id: r.folder_id || null,
          })),
        });
      }

      if (action === 'delete') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const m = resolveM(mVal);
        const own = await env.DB.prepare(
          'SELECT owner_tg_id FROM roads WHERE m = ?').bind(m).first();
        if (!own || String(own.owner_tg_id || '') !== actingUid) {
          return json({ error: 'route_not_found' }, 404);
        }
        await env.DB.prepare('DELETE FROM roads WHERE m = ? AND owner_tg_id = ?')
          .bind(m, actingUid).run();
        return json({ status: 'deleted' });
      }

      if (action === 'save') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const m = resolveM(mVal);
        const own = await env.DB.prepare(
          'SELECT owner_tg_id FROM roads WHERE m = ?').bind(m).first();
        if (own && String(own.owner_tg_id || '') !== actingUid) {
          return json({ error: 'route_not_found' }, 404);
        }
        const root = await ensureOwnerRoot(env, actingUid);
        const newJson = bodyData.data || [];
        await env.DB.prepare(
          'INSERT INTO roads (id, m, json, owner_tg_id, folder_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id, m) DO UPDATE SET json=excluded.json, owner_tg_id=excluded.owner_tg_id')
          .bind(SHARED_ID, m, typeof newJson === 'string' ? newJson : JSON.stringify(newJson), actingUid, root.folder_id).run();
        return json({ status: 'saved' });
      }

      if (action === 'get_meta') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const row = await env.DB.prepare(
          'SELECT name, description, visible, creator_name, folder_id, owner_tg_id FROM roads WHERE m = ?')
          .bind(resolveM(mVal)).first();
        if (!row || String(row.owner_tg_id || '') !== actingUid) {
          return json({ error: 'route_not_found' }, 404);
        }
        return json({
          name: row.name || '', description: row.description || '',
          visible: row.visible === 1, creator_name: row.creator_name || '',
          folder_id: row.folder_id || null,
        });
      }

      if (action === 'save_meta') {
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const m = resolveM(mVal);
        const name = bodyData.name || '';
        const description = bodyData.description || '';
        const visible = bodyData.visible ? 1 : 0;
        const newM = bodyData.new_m || '';
        const creatorName = bodyData.creator_name || '';
        const rawFolderId = bodyData.folder_id !== undefined ? bodyData.folder_id : null;
        let folderId = rawFolderId === '' ? null : rawFolderId;
        if (folderId === null || folderId === undefined) {
          const root = await ensureOwnerRoot(env, actingUid);
          folderId = root.folder_id;
        }
        if (folderId !== null && folderId !== undefined) {
          const folder = await env.DB.prepare(
            'SELECT owner_tg_id FROM folders WHERE id = ?').bind(folderId).first();
          if (!folder || String(folder.owner_tg_id || '') !== actingUid) {
            return json({ error: 'folder_not_found' }, 404);
          }
        }
        const src = await env.DB.prepare(
          'SELECT json, creator_name, owner_tg_id FROM roads WHERE m = ?').bind(m).first();
        if (!src || String(src.owner_tg_id || '') !== actingUid) {
          return json({ error: 'route_not_found' }, 404);
        }
        if (newM && newM !== m) {
          // Переименование: копируем json + мета под новым m, старый удаляем.
          const busy = await env.DB.prepare(
            'SELECT m FROM roads WHERE m = ?').bind(newM).first();
          if (busy) return json({ error: 'route_exists' }, 409);
          await env.DB.batch([
            env.DB.prepare(
              'INSERT INTO roads (id, m, json, name, description, visible, creator_name, folder_id, owner_tg_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .bind(SHARED_ID, newM, src.json, name, description, visible,
                creatorName || src.creator_name || '', folderId, actingUid),
            env.DB.prepare('DELETE FROM roads WHERE m = ? AND owner_tg_id = ?').bind(m, actingUid),
          ]);
          return json({ status: 'meta_saved', new_m: newM });
        }
        if (creatorName) {
          await env.DB.prepare(
            'UPDATE roads SET name = ?, description = ?, visible = ?, creator_name = ?, folder_id = ? WHERE m = ? AND owner_tg_id = ?')
            .bind(name, description, visible, creatorName, folderId, m, actingUid).run();
        } else {
          await env.DB.prepare(
            'UPDATE roads SET name = ?, description = ?, visible = ?, folder_id = ? WHERE m = ? AND owner_tg_id = ?')
            .bind(name, description, visible, folderId, m, actingUid).run();
        }
        return json({ status: 'meta_saved' });
      }

      // ---- Платные папки ----
      if (action === 'locks') {
        return json({ locks: locksFromIndex(await loadFolderIndex(env)) });
      }

      if (action === 'save_lock') {
        const folder = normFolder(bodyData.folder || url.searchParams.get('folder'));
        const price = Math.floor(Number(bodyData.price ?? url.searchParams.get('price')));
        if (!folder) return json({ error: 'missing_folder' }, 400);
        if (!Number.isFinite(price) || price < 0 || price > 10000) {
          return json({ error: 'bad_price' }, 400);
        }
        const folderId = await findFolderIdByPath(env, folder);
        if (!folderId) return json({ error: 'folder_not_found' }, 400);
        const owner = await env.DB.prepare(
          'SELECT owner_tg_id FROM folders WHERE id = ?').bind(folderId).first();
        if (!owner || String(owner.owner_tg_id || '') !== actingUid) {
          return json({ error: 'folder_not_found' }, 404);
        }
        await env.DB.prepare('UPDATE folders SET price = ? WHERE id = ?').bind(price, folderId).run();
        return json({ status: 'ok', folder, price });
      }

      if (action === 'del_lock') {
        const folder = normFolder(bodyData.folder || url.searchParams.get('folder'));
        if (!folder) return json({ error: 'missing_folder' }, 400);
        const folderId = await findFolderIdByPath(env, folder);
        if (!folderId) return json({ error: 'folder_not_found' }, 400);
        const owner = await env.DB.prepare(
          'SELECT owner_tg_id FROM folders WHERE id = ?').bind(folderId).first();
        if (!owner || String(owner.owner_tg_id || '') !== actingUid) {
          return json({ error: 'folder_not_found' }, 404);
        }
        await env.DB.prepare('UPDATE folders SET price = 0 WHERE id = ?').bind(folderId).run();
        return json({ status: 'ok' });
      }

      // Купленные папки пользователя (Telegram). Только действующие (30 дней).
      if (action === 'my_access') {
        const initData = bodyData.initData || url.searchParams.get('tg_init_data') || '';
        const { uid, err } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN);
        if (uid) {
          const expires = await accessExpires(env, uid);
          return json({ user_id: uid, ids: Object.keys(expires), expires });
        }
        const session = await readWebSession(request, env);
        if (!session) return json({ error: 'bad_init_data', message: err }, 401);
        const now = Math.floor(Date.now() / 1000);
        const rows = (await env.DB.prepare(
          `SELECT product_id, expires_at FROM purchases
            WHERE account_id = ? AND product_type = 'folder_access'
              AND status = 'active' AND expires_at > ?`
        ).bind(String(session.account.account_id), now).all()).results || [];
        const expires = {};
        for (const row of rows) expires[String(row.product_id)] = Number(row.expires_at);
        return json({
          user_id: `web:${session.account.account_id}`,
          email: session.account.email,
          ids: Object.keys(expires),
          expires,
        });
      }

      // Создать счёт на папку (Telegram Stars).
      if (action === 'shop_invoice') {
        const initData = bodyData.initData || '';
        const { uid, err } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN);
        if (!uid) return json({ error: 'bad_init_data', message: err }, 401);
        // Папка задаётся по id: клиент присылает folder_id.
        const index = await loadFolderIndex(env);
        const rawId = bodyData.folder_id;
        const folderId = rawId === null || rawId === undefined || rawId === '' ? NaN : Number(rawId);
        if (!Number.isFinite(folderId)) {
          return json({ error: 'missing_folder' }, 400);
        }
        const lock = lockForFolder(index, folderId);
        if (!lock) return json({ error: 'not_locked' }, 400);
        // Владельцу папки счёт не нужен: доступ у него уже есть.
        const folderOwner = await env.DB.prepare(
          'SELECT owner_tg_id FROM folders WHERE id = ?').bind(lock.id).first();
        if ((folderOwner && String(folderOwner.owner_tg_id || '') === String(uid)) ||
            await hasAccess(env, uid, lock.id)) {
          return json({ ok: true, owned: true, folder: lock.folder, folder_id: lock.id });
        }
        const title = (`Доступ: ${lock.folder}`).substring(0, 32);
        // В payload — id папки: путь не годится, у двух папок может совпасть имя.
        const payload = `folder:${uid}:id=${lock.id}:${Date.now()}`;
        const res = await tgApi(env, 'createInvoiceLink', {
          title,
          description: `Доступ к папке «${lock.folder}» на 30 дней`.substring(0, 255),
          payload,
          currency: 'XTR',
          prices: [{ label: title, amount: lock.price }],
        });
        if (!res || !res.ok) {
          return json({ ok: false, error: 'invoice_failed', details: res && res.description }, 500);
        }
        return json({ ok: true, invoiceLink: res.result, price: lock.price, folder: lock.folder, folder_id: lock.id });
      }

      // Подтвердить оплаты: сверяем getStarTransactions по payload и, если вебхук
      // ещё не записал покупку, записываем её сами (подстраховка от задержки).
      if (action === 'shop_claim') {
        const initData = bodyData.initData || '';
        const { uid, err } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN);
        if (!uid) return json({ error: 'bad_init_data', message: err }, 401);
        let claimed = 0;
        let offset = 0;
        for (let page = 0; page < 5; page++) {
          const res = await tgApi(env, 'getStarTransactions', { offset, limit: 100 });
          if (!res || !res.ok) break;
          const txns = (res.result && res.result.transactions) || [];
          for (const t of txns) {
            const stars = Math.trunc(Number(t.amount || 0));
            if (!(stars > 0)) continue; // возвраты и списания пропускаем
            for (const p of [t.source, t.receiver]) {
              const payload = p && p.invoice_payload;
              if (typeof payload === 'string' && payload.startsWith(`folder:${uid}:`)) {
                if (!t.id) continue;
                // payload передаём как есть: разбор формата (id/старый путь) — в recordPurchase.
                const rec = await recordPurchase(env, {
                  chargeId: t.id,
                  userId: uid,
                  payload,
                  stars,
                  ts: t.date,
                });
                if (!rec.duplicate) claimed++;
              }
            }
          }
          if (txns.length < 100) break;
          offset += 100;
        }
        const expires = await accessExpires(env, uid);
        return json({ ok: true, claimed, ids: Object.keys(expires), expires });
      }

      // ---- Папки (реальная иерархия) ----

      // Список всех папок (плоский)
      if (action === 'folder_list') {
        const root = await ensureOwnerRoot(env, actingUid);
        const rows = (await env.DB.prepare(
          'SELECT id, name, parent_id, visible, price FROM folders WHERE owner_tg_id = ? ORDER BY name')
          .bind(actingUid).all()).results || [];
        return json({
          root: {
            folder_id: root.folder_id,
            name: root.name || '',
            owner_name: root.owner_name || root.owner_username || '',
            owner_avatar: root.owner_avatar || '',
            owner_username: root.owner_username || '',
            owner_info: root.owner_info || '',
            owner_tg_id: actingUid,
          },
          folders: rows.map((r) => ({
            id: r.id, name: r.name, parent_id: r.parent_id,
            visible: r.visible === 1, price: r.price,
          })),
        });
      }

      // Создать папку
      if (action === 'folder_create') {
        const name = String(bodyData.name || '').trim();
        const rawParent = bodyData.parent_id;
        let parentId = rawParent === undefined || rawParent === null || rawParent === ''
          ? null
          : Number(rawParent);
        if (parentId !== null && !Number.isFinite(parentId)) {
          return json({ error: 'bad_params' }, 400);
        }
        if (parentId === null) {
          const root = await ensureOwnerRoot(env, actingUid);
          parentId = root.folder_id;
        }
        const visible = bodyData.visible !== false ? 1 : 0;
        const price = Math.floor(Number(bodyData.price ?? 0));
        if (!name) return json({ error: 'missing_name' }, 400);
        if (!Number.isFinite(price) || price < 0 || price > 10000) {
          return json({ error: 'bad_price' }, 400);
        }
        if (parentId !== null && parentId !== undefined) {
          const parent = await env.DB.prepare(
            'SELECT owner_tg_id FROM folders WHERE id = ?').bind(parentId).first();
          if (!parent || String(parent.owner_tg_id || '') !== actingUid) {
            return json({ error: 'folder_not_found' }, 404);
          }
        }
        const res = await env.DB.prepare(
          'INSERT INTO folders (name, parent_id, visible, price, owner_tg_id) VALUES (?, ?, ?, ?, ?)')
          .bind(name, parentId, visible, price, actingUid).run();
        const id = res.meta && res.meta.last_row_id ? res.meta.last_row_id : null;
        return json({ status: 'ok', id, name, parent_id: parentId, visible: visible === 1, price });
      }

      // Переименовать папку
      if (action === 'folder_rename') {
        const id = Number(bodyData.id);
        const name = String(bodyData.name || '').trim();
        if (!Number.isFinite(id) || !name) return json({ error: 'bad_params' }, 400);
        const own = await env.DB.prepare(
          'SELECT owner_tg_id FROM folders WHERE id = ?').bind(id).first();
        if (!own || String(own.owner_tg_id || '') !== actingUid) {
          return json({ error: 'folder_not_found' }, 404);
        }
        await env.DB.prepare('UPDATE folders SET name = ? WHERE id = ? AND owner_tg_id = ?')
          .bind(name, id, actingUid).run();
        return json({ status: 'ok' });
      }

      // Удалить папку (только если пустая: нет подпапок и нет маршрутов)
      if (action === 'folder_delete') {
        const id = Number(bodyData.id);
        if (!Number.isFinite(id)) return json({ error: 'bad_params' }, 400);
        const root = await ensureOwnerRoot(env, actingUid);
        if (id === Number(root.folder_id)) return json({ error: 'root_folder' }, 400);
        const own = await env.DB.prepare(
          'SELECT owner_tg_id FROM folders WHERE id = ?').bind(id).first();
        if (!own || String(own.owner_tg_id || '') !== actingUid) {
          return json({ error: 'folder_not_found' }, 404);
        }
        const children = (await env.DB.prepare('SELECT id FROM folders WHERE parent_id = ?').bind(id).all()).results || [];
        const routes = (await env.DB.prepare('SELECT m FROM roads WHERE folder_id = ?').bind(id).all()).results || [];
        if (children.length > 0) return json({ error: 'folder_not_empty' }, 400);
        if (routes.length > 0) return json({ error: 'folder_has_routes' }, 400);
        await env.DB.prepare('DELETE FROM folders WHERE id = ? AND owner_tg_id = ?')
          .bind(id, actingUid).run();
        return json({ status: 'ok' });
      }

      // Переместить папку (изменить parent_id). Защита от циклов.
      if (action === 'folder_move') {
        const id = Number(bodyData.id);
        const rawParent = bodyData.parent_id;
        let parentId = rawParent === undefined || rawParent === null || rawParent === ''
          ? null
          : Number(rawParent);
        if (parentId !== null && !Number.isFinite(parentId)) {
          return json({ error: 'bad_params' }, 400);
        }
        if (!Number.isFinite(id)) return json({ error: 'bad_params' }, 400);
        const root = await ensureOwnerRoot(env, actingUid);
        if (id === Number(root.folder_id)) return json({ error: 'root_folder' }, 400);
        if (parentId === null) parentId = Number(root.folder_id);
        const own = await env.DB.prepare(
          'SELECT owner_tg_id FROM folders WHERE id = ?').bind(id).first();
        if (!own || String(own.owner_tg_id || '') !== actingUid) {
          return json({ error: 'folder_not_found' }, 404);
        }
        if (parentId !== null) {
          const parent = await env.DB.prepare(
            'SELECT owner_tg_id FROM folders WHERE id = ?').bind(parentId).first();
          if (!parent || String(parent.owner_tg_id || '') !== actingUid) {
            return json({ error: 'folder_not_found' }, 404);
          }
        }
        if (parentId !== null && parentId === id) return json({ error: 'cyclic_move' }, 400);
        if (parentId !== null) {
          let cur = parentId;
          let cyclic = false;
          while (cur !== null) {
            if (cur === id) { cyclic = true; break; }
            const p = (await env.DB.prepare('SELECT parent_id FROM folders WHERE id = ?').bind(cur).first());
            cur = p ? p.parent_id : null;
          }
          if (cyclic) return json({ error: 'cyclic_move' }, 400);
        }
        await env.DB.prepare('UPDATE folders SET parent_id = ? WHERE id = ? AND owner_tg_id = ?')
          .bind(parentId, id, actingUid).run();
        return json({ status: 'ok' });
      }

      // Настройки папки: имя, видимость, цена
      if (action === 'folder_settings') {
        const id = Number(bodyData.id);
        const name = bodyData.name !== undefined ? String(bodyData.name).trim() : null;
        const visible = bodyData.visible !== undefined ? (bodyData.visible ? 1 : 0) : null;
        const price = bodyData.price !== undefined ? Math.floor(Number(bodyData.price)) : null;
        if (!Number.isFinite(id)) return json({ error: 'bad_params' }, 400);
        if (price !== null && (!Number.isFinite(price) || price < 0 || price > 10000)) {
          return json({ error: 'bad_price' }, 400);
        }
        const own = await env.DB.prepare(
          'SELECT owner_tg_id FROM folders WHERE id = ?').bind(id).first();
        if (!own || String(own.owner_tg_id || '') !== actingUid) {
          return json({ error: 'folder_not_found' }, 404);
        }
        const sets = [];
        const vals = [];
        if (name !== null) { sets.push('name = ?'); vals.push(name); }
        if (visible !== null) { sets.push('visible = ?'); vals.push(visible); }
        if (price !== null) { sets.push('price = ?'); vals.push(price); }
        if (sets.length === 0) return json({ error: 'nothing_to_update' }, 400);
        vals.push(id, actingUid);
        await env.DB.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ? AND owner_tg_id = ?`).bind(...vals).run();
        return json({ status: 'ok' });
      }

      // Переместить маршрут в папку (folder_id = null — в корень)
      if (action === 'route_move') {
        const mVal = bodyData.m || url.searchParams.get('m');
        const rawFolderId = bodyData.folder_id !== undefined ? bodyData.folder_id : null;
        let folderId = rawFolderId === '' || rawFolderId === null || rawFolderId === undefined
          ? null
          : Number(rawFolderId);
        if (folderId === null) {
          const root = await ensureOwnerRoot(env, actingUid);
          folderId = root.folder_id;
        }
        if (!mVal) return json({ error: 'missing_route_name' }, 400);
        const m = resolveM(mVal);
        const row = await env.DB.prepare(
          'SELECT id, owner_tg_id FROM roads WHERE m = ?').bind(m).first();
        if (!row || String(row.owner_tg_id || '') !== actingUid) {
          return json({ error: 'route_not_found' }, 404);
        }
        if (folderId !== null && folderId !== undefined) {
          const folder = await env.DB.prepare(
            'SELECT owner_tg_id FROM folders WHERE id = ?').bind(folderId).first();
          if (!folder || String(folder.owner_tg_id || '') !== actingUid) {
            return json({ error: 'folder_not_found' }, 404);
          }
        }
        await env.DB.prepare('UPDATE roads SET folder_id = ? WHERE m = ? AND owner_tg_id = ?')
          .bind(folderId, m, actingUid).run();
        return json({ status: 'ok' });
      }

      // ---- Корневая папка владельца ----
      if (action === 'root_save') {
        const name = String(bodyData.name || '').trim();
        if (!name) return json({ error: 'missing_name' }, 400);
        const root = await ensureOwnerRoot(env, actingUid);
        await env.DB.prepare('UPDATE folders SET name = ? WHERE id = ? AND owner_tg_id = ?')
          .bind(name, root.folder_id, actingUid).run();
        return json({ status: 'ok', root: {
          folder_id: root.folder_id,
          name,
          owner_name: root.owner_name || root.owner_username || '',
          owner_avatar: root.owner_avatar || '',
          owner_username: root.owner_username || '',
          owner_info: root.owner_info || '',
          owner_tg_id: actingUid,
        } });
      }

      // ---- Профиль владельца ----
      if (action === 'owner_save') {
        const root = await ensureOwnerRoot(env, actingUid);
        const info = bodyData.info !== undefined ? String(bodyData.info).trim() : null;
        if (info === null) return json({ error: 'nothing_to_update' }, 400);
        await env.DB.prepare('UPDATE owner_roots SET owner_info = ? WHERE owner_tg_id = ?')
          .bind(info, actingUid).run();
        return json({
          status: 'ok',
          root: {
            folder_id: root.folder_id,
            name: root.name || '',
            owner_name: root.owner_name || root.owner_username || '',
            owner_avatar: root.owner_avatar || '',
            owner_username: root.owner_username || '',
            owner_info: info,
            owner_tg_id: actingUid,
          },
        });
      }

      // ---- Личная сцена знаков владельца ----
      if (action === 'signs_get') {
        const row = await env.DB.prepare(
          'SELECT data FROM owner_signs WHERE owner_tg_id = ?').bind(actingUid).first();
        let data = null;
        if (row && row.data) {
          try {
            data = JSON.parse(row.data);
          } catch (e) {
            data = null;
          }
        }
        return json({ data });
      }

      if (action === 'signs_save') {
        const data = bodyData.data;
        if (!data || typeof data !== 'object' || !Array.isArray(data.markers)) {
          return json({ error: 'invalid_signs_data' }, 400);
        }
        const payload = JSON.stringify(data);
        if (payload.length > 200000) {
          return json({ error: 'signs_too_large' }, 400);
        }
        await env.DB.prepare(
          `INSERT INTO owner_signs (owner_tg_id, data, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(owner_tg_id) DO UPDATE SET
             data = excluded.data, updated_at = excluded.updated_at`)
          .bind(actingUid, payload, Date.now()).run();
        return json({ status: 'ok', count: data.markers.length });
      }

      return json({ error: 'unknown_action' }, 400);
    } catch (e) {
      return json({ error: 'internal_server_error', details: String(e && e.message || e) }, 500);
    }
  },
};
