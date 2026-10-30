"""Бэкенд навигатора и редактора navigator3.

Публичное API (через API Gateway, тот же origin):
  GET  /api/health            — проверка функции
  GET  /api/me                — пользователь и его entitlements
  GET  /api/catalog           — папки и видимые маршруты без геометрии
  GET  /api/route?m=<m>       — геометрия одного маршрута
  POST /api/orders            — создать заказ на доступ к папке (ЮKassa)
  POST /api/yookassa/notify   — webhook ЮKassa

Вход:
  GET  /auth/yandex/start
  GET  /auth/yandex/callback
  POST /auth/logout

Редактор (нужен X-Route-Admin-Password для любого действия):
  POST /api/admin?action=list|get|get_meta|save|save_meta|delete
  POST /api/admin?action=folder_save|folder_delete
  POST /api/admin?action=grant|revoke|entitlements|users|orders

База — serverless-YDB (dbosm). Доступ к папке хранится как entitlement
`folder:<folder_id>`; `all` открывает всё.
"""

import base64
import hmac
import json
import math
import os
import secrets
import uuid

import auth
import payments
import store

ACCESS_PUBLIC = "public"
ACCESS_PAID = "paid"
ROUTE_ACCESS_PUBLIC = "public"
ROUTE_ACCESS_FOLDER = "folder"


# ---------------------------------------------------------------------------
# YDB-запросы
# ---------------------------------------------------------------------------


def execute_list_folders(session):
    query = """
        SELECT folder_id, parent_id, name, access, price_kopecks, sku, sort_order
        FROM folders
        ORDER BY sort_order, name;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_list_editor_routes(session):
    query = """
        SELECT m, name, description, visible, folder_id, title, access,
               price_kopecks, sku
        FROM roads
        ORDER BY name;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_list_public_routes(session):
    query = """
        SELECT m, name, description, json, folder_id, title, access,
               price_kopecks, sku
        FROM roads
        WHERE visible = true AND name IS NOT NULL
        ORDER BY name;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_get_route(session, m_param):
    query = """
        DECLARE $m AS Utf8;
        SELECT json, name, m, description, visible, folder_id, title, access,
               price_kopecks, sku
        FROM roads
        WHERE m = $m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$m": str(m_param)}, commit_tx=True
    )


def execute_get_public_route(session, m_param):
    """Только видимый маршрут: скрытые и удалённые наружу не отдаём."""
    query = """
        DECLARE $m AS Utf8;
        SELECT json, name, m, description, folder_id, title, access,
               price_kopecks, sku
        FROM roads
        WHERE m = $m AND visible = true AND name IS NOT NULL;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$m": str(m_param)}, commit_tx=True
    )


def execute_delete_route(session, m_param):
    query = """
        DECLARE $m AS Utf8;
        DELETE FROM roads WHERE m = $m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$m": str(m_param)}, commit_tx=True
    )


def execute_upsert_route(session, m_param, json_data):
    query = """
        DECLARE $m AS Utf8;
        DECLARE $json AS Json;
        UPSERT INTO roads (m, json) VALUES ($m, $json);
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$m": str(m_param),
            "$json": json.dumps(json_data, ensure_ascii=False)
            if not isinstance(json_data, str)
            else json_data,
        },
        commit_tx=True,
    )


def execute_update_route_meta(
    session, m_param, folder_id, title, name, description, visible, access
):
    query = """
        DECLARE $m AS Utf8;
        DECLARE $folder_id AS Utf8;
        DECLARE $title AS Utf8;
        DECLARE $name AS Utf8;
        DECLARE $description AS Utf8;
        DECLARE $visible AS Bool;
        DECLARE $access AS Utf8;
        UPDATE roads
        SET folder_id = $folder_id,
            title = $title,
            name = $name,
            description = $description,
            visible = $visible,
            access = $access
        WHERE m = $m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$m": str(m_param),
            "$folder_id": str(folder_id),
            "$title": str(title),
            "$name": str(name),
            "$description": str(description),
            "$visible": bool(visible),
            "$access": str(access),
        },
        commit_tx=True,
    )


def execute_update_route_name(session, m_param, name):
    query = """
        DECLARE $m AS Utf8;
        DECLARE $name AS Utf8;
        UPDATE roads SET name = $name WHERE m = $m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$m": str(m_param), "$name": str(name)}, commit_tx=True
    )


def execute_rename_route(
    session, old_m_param, new_m_param, folder_id, title, name, description, visible,
    access,
):
    query = """
        DECLARE $old_m AS Utf8;
        DECLARE $new_m AS Utf8;
        DECLARE $folder_id AS Utf8;
        DECLARE $title AS Utf8;
        DECLARE $name AS Utf8;
        DECLARE $description AS Utf8;
        DECLARE $visible AS Bool;
        DECLARE $access AS Utf8;

        $json = (SELECT json FROM roads WHERE m = $old_m);
        $price = (SELECT price_kopecks FROM roads WHERE m = $old_m);
        $sku = (SELECT sku FROM roads WHERE m = $old_m);

        UPSERT INTO roads
            (m, json, folder_id, title, name, description, visible, access,
             price_kopecks, sku)
        VALUES
            ($new_m, $json, $folder_id, $title, $name, $description, $visible,
             $access, $price, $sku);
        DELETE FROM roads WHERE m = $old_m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$old_m": str(old_m_param),
            "$new_m": str(new_m_param),
            "$folder_id": str(folder_id),
            "$title": str(title),
            "$name": str(name),
            "$description": str(description),
            "$visible": bool(visible),
            "$access": str(access),
        },
        commit_tx=True,
    )


def execute_upsert_folder(
    session, folder_id, parent_id, name, access, price_kopecks, sku, sort_order
):
    query = """
        DECLARE $folder_id AS Utf8;
        DECLARE $parent_id AS Utf8;
        DECLARE $name AS Utf8;
        DECLARE $access AS Utf8;
        DECLARE $price_kopecks AS Uint64;
        DECLARE $sku AS Utf8;
        DECLARE $sort_order AS Uint32;
        UPSERT INTO folders
            (folder_id, parent_id, name, access, price_kopecks, sku, sort_order)
        VALUES
            ($folder_id, $parent_id, $name, $access, $price_kopecks, $sku,
             $sort_order);
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$folder_id": str(folder_id),
            "$parent_id": str(parent_id),
            "$name": str(name),
            "$access": str(access),
            "$price_kopecks": int(price_kopecks),
            "$sku": str(sku),
            "$sort_order": int(sort_order),
        },
        commit_tx=True,
    )


def execute_delete_folder(session, folder_id):
    query = """
        DECLARE $folder_id AS Utf8;
        DELETE FROM folders WHERE folder_id = $folder_id;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$folder_id": str(folder_id)}, commit_tx=True
    )


def execute_list_entitlements(session, user_id):
    query = """
        DECLARE $user_id AS Utf8;
        SELECT entitlement, created_at, source, order_id
        FROM entitlements
        WHERE user_id = $user_id
        ORDER BY entitlement;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$user_id": str(user_id)}, commit_tx=True
    )


def execute_grant_entitlement(session, user_id, entitlement, source, order_id):
    query = """
        DECLARE $user_id AS Utf8;
        DECLARE $entitlement AS Utf8;
        DECLARE $created_at AS Timestamp;
        DECLARE $source AS Utf8;
        DECLARE $order_id AS Utf8;
        UPSERT INTO entitlements
            (user_id, entitlement, created_at, source, order_id)
        VALUES
            ($user_id, $entitlement, $created_at, $source, $order_id);
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$user_id": str(user_id),
            "$entitlement": str(entitlement),
            "$created_at": store.now(),
            "$source": str(source),
            "$order_id": str(order_id or ""),
        },
        commit_tx=True,
    )


def execute_revoke_entitlement(session, user_id, entitlement):
    query = """
        DECLARE $user_id AS Utf8;
        DECLARE $entitlement AS Utf8;
        DELETE FROM entitlements
        WHERE user_id = $user_id AND entitlement = $entitlement;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {"$user_id": str(user_id), "$entitlement": str(entitlement)},
        commit_tx=True,
    )


def execute_find_user(session, value):
    query = """
        DECLARE $value AS Utf8;
        SELECT yandex_id, user_id, login, email, display_name, blocked
        FROM users
        WHERE user_id = $value OR yandex_id = $value OR login = $value
           OR email = $value
        LIMIT 1;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$value": str(value)}, commit_tx=True
    )


def execute_list_users(session):
    query = """
        SELECT yandex_id, user_id, login, email, display_name, blocked
        FROM users
        ORDER BY login;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_insert_order(
    session, order_id, user_id, folder_id, amount_kopecks, status, payment_id,
    return_path,
):
    query = """
        DECLARE $order_id AS Utf8;
        DECLARE $user_id AS Utf8;
        DECLARE $folder_id AS Utf8;
        DECLARE $amount_kopecks AS Uint64;
        DECLARE $status AS Utf8;
        DECLARE $created_at AS Timestamp;
        DECLARE $updated_at AS Timestamp;
        DECLARE $payment_id AS Utf8;
        DECLARE $return_path AS Utf8;
        INSERT INTO orders
            (order_id, user_id, folder_id, amount_kopecks, status, created_at,
             updated_at, payment_id, return_path)
        VALUES
            ($order_id, $user_id, $folder_id, $amount_kopecks, $status,
             $created_at, $updated_at, $payment_id, $return_path);
    """
    now = store.now()
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$order_id": str(order_id),
            "$user_id": str(user_id),
            "$folder_id": str(folder_id),
            "$amount_kopecks": int(amount_kopecks),
            "$status": str(status),
            "$created_at": now,
            "$updated_at": now,
            "$payment_id": str(payment_id or ""),
            "$return_path": str(return_path or "/"),
        },
        commit_tx=True,
    )


def execute_update_order(session, order_id, status, payment_id=None):
    query = """
        DECLARE $order_id AS Utf8;
        DECLARE $status AS Utf8;
        DECLARE $updated_at AS Timestamp;
        DECLARE $payment_id AS Utf8;
        UPDATE orders
        SET status = $status,
            updated_at = $updated_at,
            payment_id = IF($payment_id = "", payment_id, $payment_id)
        WHERE order_id = $order_id;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$order_id": str(order_id),
            "$status": str(status),
            "$updated_at": store.now(),
            "$payment_id": str(payment_id or ""),
        },
        commit_tx=True,
    )


def execute_get_order(session, order_id):
    query = """
        DECLARE $order_id AS Utf8;
        SELECT order_id, user_id, folder_id, amount_kopecks, status, created_at,
               updated_at, payment_id, return_path
        FROM orders
        WHERE order_id = $order_id;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$order_id": str(order_id)}, commit_tx=True
    )


def execute_list_orders(session):
    query = """
        SELECT order_id, user_id, folder_id, amount_kopecks, status, created_at,
               updated_at, payment_id, return_path
        FROM orders
        ORDER BY created_at DESC
        LIMIT 200;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------


def _text(value):
    return value if isinstance(value, str) else ("" if value is None else str(value))


def _int(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _json_value(raw):
    try:
        return json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return []


def _row_value(row, name, default=None):
    return getattr(row, name, default)


def _rows(result):
    return result[0].rows if result else []


def _route_metrics(data):
    """Считает число сегментов и длину так же, как фронтенд."""
    if not isinstance(data, list):
        return {"point_count": 0, "distance_meters": 0}

    point_count = 0
    distance_meters = 0.0

    for segment in data:
        if not isinstance(segment, dict):
            continue
        points = segment.get("pts")
        if not isinstance(points, list):
            continue

        previous = None
        has_point = False
        for point in points:
            if (
                not isinstance(point, (list, tuple))
                or len(point) < 2
                or not isinstance(point[0], (int, float))
                or not isinstance(point[1], (int, float))
                or abs(point[0]) > 90
                or abs(point[1]) > 180
            ):
                continue
            has_point = True
            if previous is not None:
                lat1 = math.radians(previous[0])
                lat2 = math.radians(point[0])
                delta_lat = lat2 - lat1
                delta_lon = math.radians(point[1] - previous[1])
                a = (
                    math.sin(delta_lat / 2) ** 2
                    + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
                )
                a = min(1.0, max(0.0, a))
                distance_meters += 6371000 * 2 * math.atan2(
                    math.sqrt(a), math.sqrt(1 - a)
                )
            previous = point
        if has_point:
            point_count += 1

    return {
        "point_count": point_count,
        "distance_meters": int(round(distance_meters)),
    }


def _folder_dict(row):
    return {
        "folder_id": _text(_row_value(row, "folder_id")),
        "parent_id": _text(_row_value(row, "parent_id")),
        "name": _text(_row_value(row, "name")),
        "access": _text(_row_value(row, "access")) or ACCESS_PUBLIC,
        "price_kopecks": _int(_row_value(row, "price_kopecks")),
        "sku": _text(_row_value(row, "sku")),
        "sort_order": _int(_row_value(row, "sort_order")),
    }


def _folder_chain(by_id, folder_id):
    chain = []
    seen = set()
    current = _text(folder_id)
    while current and current in by_id and current not in seen:
        seen.add(current)
        folder = by_id[current]
        chain.append(folder)
        current = folder["parent_id"]
    chain.reverse()
    return chain


def _folder_access_info(by_id, folder_id, entitlements):
    """Возвращает эффективный доступ к папке с учётом всех родителей."""
    chain = _folder_chain(by_id, folder_id)
    owned = "all" in entitlements or any(
        f"folder:{folder['folder_id']}" in entitlements for folder in chain
    )
    paid = [folder for folder in chain if folder["access"] == ACCESS_PAID]
    if not paid:
        return {
            "access": ACCESS_PUBLIC,
            "owned": True,
            "purchase_folder_id": "",
            "price_kopecks": 0,
            "sku": "",
        }

    purchase = paid[0]
    return {
        "access": ACCESS_PAID,
        "owned": owned,
        "purchase_folder_id": "" if owned else purchase["folder_id"],
        "price_kopecks": purchase["price_kopecks"],
        "sku": purchase["sku"],
    }


def _route_access_info(row, by_id, entitlements):
    route_access = _text(_row_value(row, "access")) or ROUTE_ACCESS_FOLDER
    if route_access == ROUTE_ACCESS_PUBLIC:
        return {
            "access": ACCESS_PUBLIC,
            "owned": True,
            "purchase_folder_id": "",
            "price_kopecks": 0,
            "sku": "",
        }
    return _folder_access_info(
        by_id, _text(_row_value(row, "folder_id")), entitlements
    )


def _route_title(row):
    title = _text(_row_value(row, "title")).strip()
    if title:
        return title
    name = _text(_row_value(row, "name")).strip()
    if "/" in name:
        name = name.rsplit("/", 1)[-1]
    return name or _text(_row_value(row, "m"))


def _full_route_name(by_id, folder_id, title):
    parts = [folder["name"] for folder in _folder_chain(by_id, folder_id)]
    parts.append(title)
    return "/".join(part for part in parts if part)


def _route_public_dict(row, by_id, entitlements):
    data = _json_value(_row_value(row, "json"))
    folder_id = _text(_row_value(row, "folder_id"))
    title = _route_title(row)
    info = _route_access_info(row, by_id, entitlements)
    route = {
        "m": _text(_row_value(row, "m")),
        "folder_id": folder_id,
        "title": title,
        "name": _full_route_name(by_id, folder_id, title)
        if folder_id in by_id
        else _text(_row_value(row, "name")) or title,
        "description": _text(_row_value(row, "description")),
        "access": info["access"],
        "owned": info["owned"],
        "purchase_folder_id": info["purchase_folder_id"],
        "price_kopecks": info["price_kopecks"],
        "sku": info["sku"],
    }
    route.update(_route_metrics(data))
    return route


def _route_editor_dict(row, by_id):
    folder_id = _text(_row_value(row, "folder_id"))
    title = _route_title(row)
    return {
        "m": _text(_row_value(row, "m")),
        "folder_id": folder_id,
        "title": title,
        "name": _full_route_name(by_id, folder_id, title)
        if folder_id in by_id
        else _text(_row_value(row, "name")) or title,
        "description": _text(_row_value(row, "description")),
        "visible": bool(_row_value(row, "visible"))
        if _row_value(row, "visible") is not None
        else False,
        "access": _text(_row_value(row, "access")) or ROUTE_ACCESS_FOLDER,
        "price_kopecks": _int(_row_value(row, "price_kopecks")),
        "sku": _text(_row_value(row, "sku")),
    }


def _public_user(user):
    return {
        "user_id": _text(user.get("user_id")),
        "login": _text(user.get("login")),
        "display_name": _text(user.get("display_name")),
        "email": _text(user.get("email")),
    }


def _header(event, name):
    headers = event.get("headers") or {}
    for key, value in headers.items():
        if str(key).lower() == name.lower() and isinstance(value, str):
            return value
    return ""


def _request_meta(event):
    """Совместимость с API Gateway 2.0 и старым прямым вызовом функции."""
    context = event.get("requestContext") or {}
    http = context.get("http") or {}
    path = event.get("rawPath") or event.get("path") or http.get("path") or "/"
    method = event.get("httpMethod") or http.get("method") or "GET"
    return str(path or "/"), str(method).upper()


def _query(event):
    return event.get("queryStringParameters") or {}


def _body_json(event):
    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        try:
            body = base64.b64decode(body).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return None
    if not body:
        return {}
    try:
        data = json.loads(body)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _client_meta(event):
    context = event.get("requestContext") or {}
    http = context.get("http") or {}
    identity = context.get("identity") or {}
    ip = http.get("sourceIp") or identity.get("sourceIp") or ""
    user_agent = http.get("userAgent")
    if not isinstance(user_agent, str):
        user_agent = _header(event, "user-agent")
    return str(ip or ""), str(user_agent or "")


def _current_user(event):
    sid = auth.parse_cookies(event).get(auth.SESSION_COOKIE)
    if not sid:
        return None
    session = store.get_session(sid)
    if not session:
        return None
    user = store.get_user_by_yandex_id(session.get("yandex_id"))
    if not user or user.get("blocked"):
        return None
    store.touch_session(session.get("sid_hash"), session.get("last_seen_at"))
    return user


def _catalog_data():
    pool = store.get_pool()
    folder_rows = _rows(pool.retry_operation_sync(execute_list_folders))
    route_rows = _rows(pool.retry_operation_sync(execute_list_public_routes))
    folders = [_folder_dict(row) for row in folder_rows]
    by_id = {folder["folder_id"]: folder for folder in folders}
    return folders, route_rows, by_id


def _editor_data():
    pool = store.get_pool()
    folder_rows = _rows(pool.retry_operation_sync(execute_list_folders))
    route_rows = _rows(pool.retry_operation_sync(execute_list_editor_routes))
    folders = [_folder_dict(row) for row in folder_rows]
    by_id = {folder["folder_id"]: folder for folder in folders}
    return folders, route_rows, by_id


def _user_entitlements(user):
    if not user:
        return set()
    rows = _rows(
        store.get_pool().retry_operation_sync(
            execute_list_entitlements, user_id=user.get("user_id")
        )
    )
    return {_text(_row_value(row, "entitlement")) for row in rows}


def _find_user(identifier):
    rows = _rows(
        store.get_pool().retry_operation_sync(
            execute_find_user, value=identifier
        )
    )
    if not rows:
        return None
    row = rows[0]
    return {
        "yandex_id": _text(_row_value(row, "yandex_id")),
        "user_id": _text(_row_value(row, "user_id")),
        "login": _text(_row_value(row, "login")),
        "email": _text(_row_value(row, "email")),
        "display_name": _text(_row_value(row, "display_name")),
        "blocked": bool(_row_value(row, "blocked")),
    }


def _order_dict(row):
    return {
        "order_id": _text(_row_value(row, "order_id")),
        "user_id": _text(_row_value(row, "user_id")),
        "folder_id": _text(_row_value(row, "folder_id")),
        "amount_kopecks": _int(_row_value(row, "amount_kopecks")),
        "status": _text(_row_value(row, "status")),
        "payment_id": _text(_row_value(row, "payment_id")),
        "return_path": _text(_row_value(row, "return_path")),
        "created_at": _row_value(row, "created_at"),
        "updated_at": _row_value(row, "updated_at"),
    }


# ---------------------------------------------------------------------------
# Вход
# ---------------------------------------------------------------------------


def _auth_start(event):
    try:
        return_to = auth.safe_return(_query(event).get("return"))
        state = secrets.token_urlsafe(24)
        verifier, challenge = auth.make_pkce()
        location = auth.build_authorize_url(state, challenge)
    except auth.AuthConfigError as exc:
        print(f"[auth] config error: {exc}")
        return auth.json_response(503, {"error": "auth_not_configured"})

    return auth.redirect_response(
        location,
        auth.oauth_cookies(state, verifier, return_to),
    )


def _auth_callback(event):
    params = _query(event)
    cookies = auth.parse_cookies(event)

    if params.get("error"):
        print(f"[auth] user denied access: {params.get('error')}")
        return auth.redirect_response(
            "/?auth_error=access_denied", auth.clear_oauth_cookies()
        )

    code = params.get("code") or ""
    state = params.get("state") or ""
    expected_state = cookies.get(auth.STATE_COOKIE) or ""
    if (
        not code
        or not expected_state
        or not hmac.compare_digest(str(state), str(expected_state))
    ):
        return auth.redirect_response(
            "/?auth_error=state_mismatch", auth.clear_oauth_cookies()
        )

    try:
        access_token = auth.exchange_code(code, cookies.get(auth.VERIFIER_COOKIE) or "")
        profile = auth.fetch_profile(access_token)
    except auth.AuthConfigError as exc:
        print(f"[auth] config error: {exc}")
        return auth.redirect_response(
            "/?auth_error=auth_not_configured", auth.clear_oauth_cookies()
        )
    except auth.OAuthError as exc:
        print(f"[auth] {exc.code}")
        return auth.redirect_response(
            f"/?auth_error={exc.code}", auth.clear_oauth_cookies()
        )

    fields = auth.profile_fields(profile)
    if not fields["yandex_id"]:
        return auth.redirect_response(
            "/?auth_error=profile_failed", auth.clear_oauth_cookies()
        )

    try:
        user = store.upsert_user(
            fields["yandex_id"],
            fields["login"],
            fields["email"],
            fields["display_name"],
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[auth] user upsert failed: {exc}")
        return auth.redirect_response(
            "/?auth_error=storage_failed", auth.clear_oauth_cookies()
        )

    if user.get("blocked"):
        return auth.redirect_response("/?auth_error=blocked", auth.clear_oauth_cookies())

    ip, user_agent = _client_meta(event)
    try:
        sid = store.create_session(
            user["yandex_id"], user["user_id"], user_agent, ip
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[auth] session create failed: {exc}")
        return auth.redirect_response(
            "/?auth_error=storage_failed", auth.clear_oauth_cookies()
        )

    return_to = auth.return_from_cookie(cookies.get(auth.RETURN_COOKIE))
    return auth.redirect_response(
        return_to,
        [auth.session_cookie(sid)] + auth.clear_oauth_cookies(),
    )


def _auth_logout(event):
    if not auth.origin_allowed(event):
        return auth.json_response(403, {"error": "forbidden_origin"})

    sid = auth.parse_cookies(event).get(auth.SESSION_COOKIE)
    if sid:
        try:
            store.delete_session(sid)
        except Exception as exc:  # noqa: BLE001
            print(f"[auth] session delete failed: {exc}")
    return auth.json_response(
        200,
        {"status": "logged_out"},
        cookies=[auth.clear_session_cookie()],
    )


# ---------------------------------------------------------------------------
# Публичное API
# ---------------------------------------------------------------------------


def _api_me(event):
    user = _current_user(event)
    if not user:
        return auth.json_response(401, {"error": "unauthorized"})
    entitlements = sorted(_user_entitlements(user))
    return auth.json_response(
        200,
        {"user": _public_user(user), "entitlements": entitlements},
    )


def _api_folder(event):
    """Содержимое папки со всей геометрией доступных маршрутов."""
    folder_id = (_query(event).get("folder_id") or "").strip()
    user = _current_user(event)
    try:
        folders, route_rows, by_id = _catalog_data()
        entitlements = _user_entitlements(user)
        if folder_id and folder_id not in by_id:
            return auth.json_response(404, {"error": "folder_not_found"})

        child_folders = []
        for folder in folders:
            if _text(folder["parent_id"]) != folder_id:
                continue
            info = _folder_access_info(by_id, folder["folder_id"], entitlements)
            child_folders.append(
                {
                    "folder_id": folder["folder_id"],
                    "parent_id": folder["parent_id"],
                    "name": folder["name"],
                    "sort_order": folder["sort_order"],
                    "access": info["access"],
                    "owned": info["owned"],
                    "purchase_folder_id": info["purchase_folder_id"],
                    "price_kopecks": info["price_kopecks"],
                    "sku": info["sku"],
                }
            )
        child_folders.sort(key=lambda f: (f["sort_order"], f["name"]))

        routes = []
        for row in route_rows:
            row_folder_id = _text(_row_value(row, "folder_id"))
            if row_folder_id != folder_id:
                continue
            info = _route_access_info(row, by_id, entitlements)
            route = _route_public_dict(row, by_id, entitlements)
            if info["owned"]:
                data = _json_value(_row_value(row, "json"))
                route["data"] = data
            routes.append(route)
        routes.sort(key=lambda r: r.get("name", ""))

        return auth.json_response(
            200,
            {
                "folder_id": folder_id,
                "folders": child_folders,
                "routes": routes,
                "user": _public_user(user) if user else None,
            },
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[api] folder failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})


def _api_route(event):
    """Геометрия одного маршрута с проверкой доступа на сервере."""
    m_val = _query(event).get("m") or ""
    if not isinstance(m_val, str) or not m_val.strip():
        return auth.json_response(400, {"error": "missing_route_name"})

    user = _current_user(event)
    try:
        rows = _rows(
            store.get_pool().retry_operation_sync(
                execute_get_public_route, m_param=m_val.strip()
            )
        )
        if not rows:
            return auth.json_response(404, {"error": "route_not_found"})

        folder_rows = _rows(
            store.get_pool().retry_operation_sync(execute_list_folders)
        )
        by_id = {
            folder["folder_id"]: folder
            for folder in (_folder_dict(row) for row in folder_rows)
        }
        entitlements = _user_entitlements(user)
        row = rows[0]
        info = _route_access_info(row, by_id, entitlements)
        if not info["owned"]:
            payload = {
                "error": "payment_required",
                "purchase_folder_id": info["purchase_folder_id"],
                "price_kopecks": info["price_kopecks"],
                "sku": info["sku"],
            }
            if not user:
                payload["error"] = "unauthorized"
                return auth.json_response(401, payload)
            return auth.json_response(402, payload)

        data = _json_value(_row_value(row, "json"))
        payload = _route_public_dict(row, by_id, entitlements)
        payload["data"] = data
        return auth.json_response(200, payload)
    except Exception as exc:  # noqa: BLE001
        print(f"[api] route failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})


def _return_url(return_path):
    path = auth.safe_return(return_path)
    if "#" in path:
        before, fragment = path.split("#", 1)
        fragment = "#" + fragment
    else:
        before, fragment = path, ""
    separator = "&" if "?" in before else "?"
    return auth.public_base_url() + before + separator + "payment=success" + fragment


def _api_orders(event):
    if not auth.origin_allowed(event):
        return auth.json_response(403, {"error": "forbidden_origin"})

    user = _current_user(event)
    if not user:
        return auth.json_response(401, {"error": "unauthorized"})

    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})

    folder_id = _text(body.get("folder_id")).strip()
    if not folder_id:
        return auth.json_response(400, {"error": "missing_folder_id"})

    if not payments.configured():
        return auth.json_response(503, {"error": "payments_not_configured"})

    try:
        folders, _, by_id = _editor_data()
        if folder_id not in by_id:
            return auth.json_response(404, {"error": "folder_not_found"})
        entitlements = _user_entitlements(user)
        info = _folder_access_info(by_id, folder_id, entitlements)
        if info["access"] != ACCESS_PAID:
            return auth.json_response(400, {"error": "folder_is_free"})
        if info["owned"]:
            return auth.json_response(400, {"error": "already_available"})
        if info["price_kopecks"] <= 0:
            return auth.json_response(400, {"error": "price_not_set"})

        order_id = uuid.uuid4().hex
        return_path = auth.safe_return(body.get("return"), "/")
        store.get_pool().retry_operation_sync(
            execute_insert_order,
            order_id=order_id,
            user_id=user["user_id"],
            folder_id=folder_id,
            amount_kopecks=info["price_kopecks"],
            status="pending",
            payment_id="",
            return_path=return_path,
        )

        try:
            payment = payments.create_payment(
                amount_kopecks=info["price_kopecks"],
                description=f"Доступ к папке «{by_id[folder_id]['name']}»",
                return_url=_return_url(return_path),
                metadata={
                    "order_id": order_id,
                    "user_id": user["user_id"],
                    "folder_id": folder_id,
                },
                idempotence_key=order_id,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[payments] create failed: {exc}")
            store.get_pool().retry_operation_sync(
                execute_update_order,
                order_id=order_id,
                status="failed",
            )
            return auth.json_response(502, {"error": "payment_failed"})

        store.get_pool().retry_operation_sync(
            execute_update_order,
            order_id=order_id,
            status="pending",
            payment_id=payment["payment_id"],
        )
        return auth.json_response(
            200,
            {
                "order_id": order_id,
                "payment_id": payment["payment_id"],
                "confirmation_url": payment["confirmation_url"],
            },
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[api] order failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})


def _api_yookassa_notify(event):
    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})

    payment_id = _text((body.get("object") or {}).get("id")).strip()
    event_type = _text(body.get("event")).strip()
    if not payment_id or not event_type:
        return auth.json_response(200, {"status": "ignored"})
    if event_type not in {"payment.succeeded", "payment.canceled"}:
        return auth.json_response(200, {"status": "ignored"})

    try:
        payment = payments.fetch_payment(payment_id)
    except Exception as exc:  # noqa: BLE001
        print(f"[payments] verify failed: {exc}")
        return auth.json_response(502, {"error": "payment_verification_failed"})

    metadata = payment.get("metadata") or {}
    order_id = _text(metadata.get("order_id")).strip()
    if not order_id:
        return auth.json_response(200, {"status": "ignored"})

    try:
        orders = _rows(
            store.get_pool().retry_operation_sync(
                execute_get_order, order_id=order_id
            )
        )
        if not orders:
            return auth.json_response(200, {"status": "ignored"})
        order = _order_dict(orders[0])

        if event_type == "payment.canceled":
            store.get_pool().retry_operation_sync(
                execute_update_order,
                order_id=order_id,
                status="canceled",
                payment_id=payment_id,
            )
            return auth.json_response(200, {"status": "canceled"})

        if not payment.get("paid") or payment.get("status") != "succeeded":
            return auth.json_response(200, {"status": "not_paid"})

        amount = payment.get("amount") or {}
        amount_value = _text(amount.get("value"))
        amount_kopecks = _int(round(float(amount_value) * 100)) if amount_value else 0
        if amount.get("currency") != "RUB" or amount_kopecks != order["amount_kopecks"]:
            print(f"[payments] amount mismatch for order {order_id}")
            return auth.json_response(400, {"error": "amount_mismatch"})

        if order["status"] != "paid":
            store.get_pool().retry_operation_sync(
                execute_update_order,
                order_id=order_id,
                status="paid",
                payment_id=payment_id,
            )
            store.get_pool().retry_operation_sync(
                execute_grant_entitlement,
                user_id=order["user_id"],
                entitlement=f"folder:{order['folder_id']}",
                source="yookassa",
                order_id=order_id,
            )
        return auth.json_response(200, {"status": "paid"})
    except Exception as exc:  # noqa: BLE001
        print(f"[api] yookassa notify failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})


# ---------------------------------------------------------------------------
# Редактор
# ---------------------------------------------------------------------------


def _admin_auth_error(event):
    """Возвращает 503/403, если пароль редактора не настроен или неверен."""
    admin_password = os.environ.get("ROUTE_ADMIN_PASSWORD")
    if not admin_password:
        return auth.json_response(503, {"error": "admin_auth_not_configured"})

    provided_password = _header(event, "x-route-admin-password")
    if not isinstance(provided_password, str) or not hmac.compare_digest(
        provided_password, admin_password
    ):
        return auth.json_response(403, {"error": "invalid_admin_password"})
    return None


def _admin_list(event):
    folders, route_rows, by_id = _editor_data()
    return auth.json_response(
        200,
        {
            "routes": [_route_editor_dict(row, by_id) for row in route_rows],
            "folders": folders,
        },
    )


def _admin_get(event):
    m_val = _query(event).get("m")
    if not m_val:
        return auth.json_response(400, {"error": "missing_route_name"})
    rows = _rows(
        store.get_pool().retry_operation_sync(execute_get_route, m_param=m_val)
    )
    if not rows:
        return auth.json_response(404, {"error": "not_found"})
    row = rows[0]
    return auth.json_response(
        200,
        {
            "name": _text(_row_value(row, "name")),
            "m": _text(_row_value(row, "m")) or m_val,
            "data": _json_value(_row_value(row, "json")),
        },
    )


def _admin_get_meta(event):
    m_val = _query(event).get("m")
    if not m_val:
        return auth.json_response(400, {"error": "missing_route_name"})
    folders, route_rows, by_id = _editor_data()
    for row in route_rows:
        if _text(_row_value(row, "m")) == m_val:
            return auth.json_response(200, _route_editor_dict(row, by_id))
    return auth.json_response(404, {"error": "route_not_found"})


def _admin_save(event):
    m_val = _query(event).get("m")
    if not m_val:
        return auth.json_response(400, {"error": "missing_route_name"})
    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})
    store.get_pool().retry_operation_sync(
        execute_upsert_route,
        m_param=m_val,
        json_data=body.get("data", []),
    )
    return auth.json_response(200, {"status": "saved"})


def _admin_save_meta(event):
    m_val = _query(event).get("m")
    if not m_val:
        return auth.json_response(400, {"error": "missing_route_name"})
    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})

    folders, route_rows, by_id = _editor_data()
    current = None
    for row in route_rows:
        if _text(_row_value(row, "m")) == m_val:
            current = _route_editor_dict(row, by_id)
            break
    if current is None:
        return auth.json_response(404, {"error": "route_not_found"})

    folder_id = _text(body.get("folder_id", current["folder_id"])).strip()
    if folder_id and folder_id not in by_id:
        return auth.json_response(400, {"error": "unknown_folder"})

    title = body.get("title")
    if title is None:
        title = body.get("name")
    if title is None:
        title = current["title"]
    title = _text(title).strip()
    if not title:
        return auth.json_response(400, {"error": "missing_title"})

    description = _text(body.get("description", current["description"]))
    visible = body.get("visible", current["visible"])
    access = _text(body.get("access", current["access"])) or ROUTE_ACCESS_FOLDER
    if access not in {ROUTE_ACCESS_PUBLIC, ROUTE_ACCESS_FOLDER}:
        return auth.json_response(400, {"error": "invalid_access"})

    name = _full_route_name(by_id, folder_id, title)
    new_m = _text(body.get("new_m")).strip()

    if new_m and new_m != m_val:
        store.get_pool().retry_operation_sync(
            execute_rename_route,
            old_m_param=m_val,
            new_m_param=new_m,
            folder_id=folder_id,
            title=title,
            name=name,
            description=description,
            visible=bool(visible),
            access=access,
        )
        return auth.json_response(200, {"status": "meta_saved", "new_m": new_m})

    store.get_pool().retry_operation_sync(
        execute_update_route_meta,
        m_param=m_val,
        folder_id=folder_id,
        title=title,
        name=name,
        description=description,
        visible=bool(visible),
        access=access,
    )
    return auth.json_response(200, {"status": "meta_saved"})


def _admin_delete(event):
    m_val = _query(event).get("m")
    if not m_val:
        return auth.json_response(400, {"error": "missing_route_name"})
    store.get_pool().retry_operation_sync(execute_delete_route, m_param=m_val)
    return auth.json_response(200, {"status": "deleted"})


def _admin_folder_save(event):
    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})

    folders, route_rows, by_id = _editor_data()
    folder_id = _text(body.get("folder_id")).strip() or "f_" + secrets.token_hex(8)
    parent_id = _text(body.get("parent_id")).strip()
    name = _text(body.get("name")).strip()
    access = _text(body.get("access")).strip() or ACCESS_PUBLIC
    price_kopecks = _int(body.get("price_kopecks"))
    sku = _text(body.get("sku")).strip()
    sort_order = _int(body.get("sort_order"))

    if not name:
        return auth.json_response(400, {"error": "missing_folder_name"})
    if parent_id and parent_id not in by_id:
        return auth.json_response(400, {"error": "unknown_parent"})
    if access not in {ACCESS_PUBLIC, ACCESS_PAID}:
        return auth.json_response(400, {"error": "invalid_access"})
    if price_kopecks < 0:
        return auth.json_response(400, {"error": "invalid_price"})

    current = parent_id
    seen = set()
    while current:
        if current == folder_id:
            return auth.json_response(400, {"error": "folder_cycle"})
        if current in seen:
            break
        seen.add(current)
        current = by_id.get(current, {}).get("parent_id", "")

    store.get_pool().retry_operation_sync(
        execute_upsert_folder,
        folder_id=folder_id,
        parent_id=parent_id,
        name=name,
        access=access,
        price_kopecks=price_kopecks,
        sku=sku,
        sort_order=sort_order,
    )

    # Держим legacy-поле roads.name в согласии с деревом папок.
    new_by_id = dict(by_id)
    new_by_id[folder_id] = {
        "folder_id": folder_id,
        "parent_id": parent_id,
        "name": name,
        "access": access,
        "price_kopecks": price_kopecks,
        "sku": sku,
        "sort_order": sort_order,
    }
    for row in route_rows:
        route_folder_id = _text(_row_value(row, "folder_id"))
        if folder_id not in {
            folder["folder_id"]
            for folder in _folder_chain(new_by_id, route_folder_id)
        }:
            continue
        title = _route_title(row)
        full_name = _full_route_name(new_by_id, route_folder_id, title)
        if full_name != _text(_row_value(row, "name")):
            store.get_pool().retry_operation_sync(
                execute_update_route_name,
                m_param=_text(_row_value(row, "m")),
                name=full_name,
            )

    return auth.json_response(
        200,
        {
            "status": "folder_saved",
            "folder": new_by_id[folder_id],
        },
    )


def _admin_folder_delete(event):
    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})
    folder_id = _text(body.get("folder_id")).strip()
    if not folder_id:
        return auth.json_response(400, {"error": "missing_folder_id"})

    folders, route_rows, _ = _editor_data()
    if not any(folder["folder_id"] == folder_id for folder in folders):
        return auth.json_response(404, {"error": "folder_not_found"})
    if any(folder["parent_id"] == folder_id for folder in folders):
        return auth.json_response(409, {"error": "folder_has_children"})
    if any(_text(_row_value(row, "folder_id")) == folder_id for row in route_rows):
        return auth.json_response(409, {"error": "folder_has_routes"})

    store.get_pool().retry_operation_sync(
        execute_delete_folder, folder_id=folder_id
    )
    return auth.json_response(200, {"status": "folder_deleted"})


def _resolve_entitlement(body, by_id):
    entitlement = _text(body.get("entitlement")).strip()
    if entitlement:
        if entitlement == "all" or entitlement.startswith("folder:"):
            return entitlement
        return None
    folder_id = _text(body.get("folder_id")).strip()
    if not folder_id or folder_id not in by_id:
        return None
    return f"folder:{folder_id}"


def _admin_grant(event, revoke=False):
    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})

    identifier = (
        _text(body.get("user")).strip()
        or _text(body.get("user_id")).strip()
        or _text(body.get("login")).strip()
        or _text(body.get("email")).strip()
    )
    if not identifier:
        return auth.json_response(400, {"error": "missing_user"})

    _, _, by_id = _editor_data()
    entitlement = _resolve_entitlement(body, by_id)
    if not entitlement:
        return auth.json_response(400, {"error": "invalid_entitlement"})

    user = _find_user(identifier)
    if not user:
        return auth.json_response(404, {"error": "user_not_found"})

    if revoke:
        store.get_pool().retry_operation_sync(
            execute_revoke_entitlement,
            user_id=user["user_id"],
            entitlement=entitlement,
        )
        status = "revoked"
    else:
        store.get_pool().retry_operation_sync(
            execute_grant_entitlement,
            user_id=user["user_id"],
            entitlement=entitlement,
            source="manual",
            order_id="",
        )
        status = "granted"

    return auth.json_response(
        200,
        {"status": status, "entitlement": entitlement, "user": _public_user(user)},
    )


def _admin_entitlements(event):
    body = _body_json(event) or {}
    identifier = (
        _text(body.get("user")).strip()
        or _text(body.get("user_id")).strip()
        or _query(event).get("user")
        or _query(event).get("user_id")
        or ""
    )
    if not identifier:
        return auth.json_response(400, {"error": "missing_user"})
    user = _find_user(identifier)
    if not user:
        return auth.json_response(404, {"error": "user_not_found"})
    rows = _rows(
        store.get_pool().retry_operation_sync(
            execute_list_entitlements, user_id=user["user_id"]
        )
    )
    return auth.json_response(
        200,
        {
            "user": _public_user(user),
            "entitlements": [
                {
                    "entitlement": _text(_row_value(row, "entitlement")),
                    "source": _text(_row_value(row, "source")),
                    "order_id": _text(_row_value(row, "order_id")),
                }
                for row in rows
            ],
        },
    )


def _admin_users(event):
    rows = _rows(store.get_pool().retry_operation_sync(execute_list_users))
    return auth.json_response(
        200,
        {
            "users": [
                {
                    "yandex_id": _text(_row_value(row, "yandex_id")),
                    "user_id": _text(_row_value(row, "user_id")),
                    "login": _text(_row_value(row, "login")),
                    "email": _text(_row_value(row, "email")),
                    "display_name": _text(_row_value(row, "display_name")),
                    "blocked": bool(_row_value(row, "blocked")),
                }
                for row in rows
            ]
        },
    )


def _admin_orders(event):
    rows = _rows(store.get_pool().retry_operation_sync(execute_list_orders))
    return auth.json_response(200, {"orders": [_order_dict(row) for row in rows]})


def _handle_admin(event):
    action = _query(event).get("action") or "list"

    try:
        if action == "auth":
            return auth.json_response(200, {"status": "authenticated"})
        if action == "list":
            return _admin_list(event)
        if action == "get":
            return _admin_get(event)
        if action == "get_meta":
            return _admin_get_meta(event)
        if action == "save":
            return _admin_save(event)
        if action == "save_meta":
            return _admin_save_meta(event)
        if action == "delete":
            return _admin_delete(event)
        if action == "folder_save":
            return _admin_folder_save(event)
        if action == "folder_delete":
            return _admin_folder_delete(event)
        if action == "grant":
            return _admin_grant(event)
        if action == "revoke":
            return _admin_grant(event, revoke=True)
        if action == "entitlements":
            return _admin_entitlements(event)
        if action == "users":
            return _admin_users(event)
        if action == "orders":
            return _admin_orders(event)
        return auth.json_response(400, {"error": "unknown_action"})
    except ValueError as exc:
        return auth.json_response(
            400, {"error": "invalid_parameter_format", "details": str(exc)}
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[admin] {action} failed: {exc}")
        return auth.json_response(500, {"error": "internal_server_error"})


# ---------------------------------------------------------------------------
# Маршрутизация
# ---------------------------------------------------------------------------


def _handle_api(event, path, method):
    normalized = path.rstrip("/") or "/"

    if normalized == "/api/health" and method == "GET":
        return auth.json_response(200, {"status": "ok"})

    if normalized == "/api/me" and method == "GET":
        return _api_me(event)

    if normalized == "/api/catalog" and method == "GET":
        return _api_catalog(event)

    if normalized == "/api/folder" and method == "GET":
        return _api_folder(event)

    if normalized == "/api/orders" and method == "POST":
        return _api_orders(event)

    if normalized == "/api/yookassa/notify" and method == "POST":
        return _api_yookassa_notify(event)

    if normalized == "/api/admin":
        # Редактор работает на том же origin, что и шлюз. Прямой вызов
        # функции платформа закрывает (403), поэтому проксируем сюда.
        # Читать тоже можно только с паролем: иначе action=get отдавал бы
        # скрытые маршруты в обход visible=true.
        error = _admin_auth_error(event)
        if error:
            return error
        return _handle_admin(event)

    if normalized == "/auth/yandex/start" and method == "GET":
        return _auth_start(event)

    if normalized == "/auth/yandex/callback" and method == "GET":
        return _auth_callback(event)

    if normalized == "/auth/logout" and method == "POST":
        return _auth_logout(event)

    return auth.json_response(404, {"error": "not_found"})


def handler(event, context):
    path, method = _request_meta(event)

    if method == "OPTIONS" and (
        path.startswith("/api/") or path.startswith("/auth/")
    ):
        return {
            "statusCode": 204,
            "headers": {"Cache-Control": "no-store"},
            "body": "",
            "isBase64Encoded": False,
        }

    if path.startswith("/api/") or path.startswith("/auth/"):
        return _handle_api(event, path, method)

    return auth.json_response(404, {"error": "not_found"})
