// Доступ редактора маршрутов: только подписанный initData Telegram.

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

// Удостоверение пользователя: только подпись Telegram.WebApp.initData.
// uid берётся из подписи, подделать нельзя; подходит любой пользователь
// Telegram. Возвращает { ok, uid, via } либо { ok:false, err }.
export async function requireUser(request, bodyData, env) {
  const url = new URL(request.url);
  const initData = bodyData.tg_init_data || url.searchParams.get('tg_init_data') || '';
  const { uid, err } = await verifyTgInitData(initData, env.TELEGRAM_TOKEN, 24 * 3600);
  if (uid) return { ok: true, uid, via: 'tg' };
  return { ok: false, err: err || 'forbidden' };
}
