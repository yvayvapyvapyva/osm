// Доступ редактора маршрутов: ключ из браузера либо подписанный initData Telegram.

import { verifyTgInitData } from './telegram.js';

// Экшены, доступные владельцу маршрутов и папок (см. requireUser).
// Публичные остаются открытыми: catalog, get, list_routes, locks, my_access,
// shop_invoice, shop_claim, editor_check.
export const EDITOR_ACTIONS = new Set([
  'list', 'get_protected', 'get_meta',
  'delete', 'save', 'save_meta',
  'save_lock', 'del_lock',
  'folder_list', 'folder_create', 'folder_rename', 'folder_delete',
  'folder_move', 'folder_settings', 'route_move',
  'signs_get', 'signs_save',
]);

// Сравнение строк за постоянное время (для ключа доступа).
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// uid, от имени которого работает вход по ключу из браузера. Маршруты и
// папки этого аккаунта он и видит. Без EDITOR_KEY_UID ключ не даёт доступа.
export function editorKeyUid(env) {
  return String(env.EDITOR_KEY_UID || '');
}

// Удостоверение пользователя редактора. Два способа:
//   1) подписанный Telegram.WebApp.initData — uid берётся из подписи Telegram,
//      подделать нельзя; подходит любой пользователь Telegram;
//   2) ключ EDITOR_ACCESS_KEY — вход из браузера вне Telegram от имени
//      editorKeyUid(env).
// Возвращает { ok, uid, via } либо { ok:false, err }.
export async function requireUser(request, bodyData, env) {
  const url = new URL(request.url);
  const givenKey = bodyData.editor_key || request.headers.get('X-Editor-Key') ||
    url.searchParams.get('editor_key') || '';
  const accessKey = String(env.EDITOR_ACCESS_KEY || '');
  if (accessKey && givenKey && safeEqual(givenKey, accessKey)) {
    return { ok: true, uid: editorKeyUid(env), via: 'key' };
  }

  const initData = bodyData.tg_init_data || url.searchParams.get('tg_init_data') || '';
  const { uid, err } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN, 24 * 3600);
  if (uid) return { ok: true, uid, via: 'tg' };
  return { ok: false, err: err || 'forbidden' };
}
