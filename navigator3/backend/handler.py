"""Бэкенд навигатора и редактора navigator3.

Публичное API (через API Gateway, тот же origin):
  GET  /api/health            — проверка функции
  GET  /api/me                — текущий пользователь
  GET  /api/catalog           — папки и видимые маршруты без геометрии
  GET  /api/route?m=<m>       — геометрия одного маршрута

Вход:
  GET  /auth/yandex/start
  GET  /auth/yandex/callback
  POST /auth/logout

Редактор (нужен X-Route-Admin-Password для любого действия):
  POST /api/admin?action=list|get|get_meta|save|save_meta|delete
  POST /api/admin?action=folder_save|folder_delete
База — serverless-YDB (dbosm).
"""

import base64
import hmac
import json
import math
import os
import secrets

import auth
import store

# ---------------------------------------------------------------------------
# YDB-запросы
# ---------------------------------------------------------------------------


def execute_list_folders(session):
    query = """
        SELECT folder_id, parent_id, name, sort_order
        FROM folders
        ORDER BY sort_order, name;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_list_editor_routes(session):
    query = """
        SELECT m, name, description, visible, folder_id, title
        FROM roads
        ORDER BY name;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_list_public_routes(session):
    query = """
        SELECT m, name, description, json, folder_id, title
        FROM roads
        WHERE visible = true AND name IS NOT NULL
        ORDER BY name;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_get_route(session, m_param):
    query = """
        DECLARE $m AS Utf8;
        SELECT json, name, m, description, visible, folder_id, title
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
        SELECT json, name, m, description, folder_id, title
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
    session, m_param, folder_id, title, name, description, visible
):
    query = """
        DECLARE $m AS Utf8;
        DECLARE $folder_id AS Utf8;
        DECLARE $title AS Utf8;
        DECLARE $name AS Utf8;
        DECLARE $description AS Utf8;
        DECLARE $visible AS Bool;
        UPDATE roads
        SET folder_id = $folder_id,
            title = $title,
            name = $name,
            description = $description,
            visible = $visible
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
    session, old_m_param, new_m_param, folder_id, title, name, description, visible
):
    query = """
        DECLARE $old_m AS Utf8;
        DECLARE $new_m AS Utf8;
        DECLARE $folder_id AS Utf8;
        DECLARE $title AS Utf8;
        DECLARE $name AS Utf8;
        DECLARE $description AS Utf8;
        DECLARE $visible AS Bool;

        $json = (SELECT json FROM roads WHERE m = $old_m);

        UPSERT INTO roads
            (m, json, folder_id, title, name, description, visible)
        VALUES
            ($new_m, $json, $folder_id, $title, $name, $description, $visible);
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
        },
        commit_tx=True,
    )


def execute_upsert_folder(session, folder_id, parent_id, name, sort_order):
    query = """
        DECLARE $folder_id AS Utf8;
        DECLARE $parent_id AS Utf8;
        DECLARE $name AS Utf8;
        DECLARE $sort_order AS Uint32;
        UPSERT INTO folders
            (folder_id, parent_id, name, sort_order)
        VALUES
            ($folder_id, $parent_id, $name, $sort_order);
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$folder_id": str(folder_id),
            "$parent_id": str(parent_id),
            "$name": str(name),
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


def _route_public_dict(row, by_id):
    data = _json_value(_row_value(row, "json"))
    folder_id = _text(_row_value(row, "folder_id"))
    title = _route_title(row)
    route = {
        "m": _text(_row_value(row, "m")),
        "folder_id": folder_id,
        "title": title,
        "name": _full_route_name(by_id, folder_id, title)
        if folder_id in by_id
        else _text(_row_value(row, "name")) or title,
        "description": _text(_row_value(row, "description")),
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


# ---------------------------------------------------------------------------
# Вход
# ---------------------------------------------------------------------------


def _auth_start(event):
    try:
        return_to = auth.safe_return(_query(event).get("return"))
        state = secrets.token_urlsafe(24)
        verifier, challenge = auth.make_pkce()
        location = auth.build_authorize_url(state, challenge, event)
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


def _api_catalog(event):
    """Папки и видимые маршруты без геометрии."""
    user = _current_user(event)
    try:
        folders, route_rows, by_id = _catalog_data()
        routes = [_route_public_dict(row, by_id) for row in route_rows]
        return auth.json_response(
            200,
            {
                "folders": folders,
                "routes": routes,
                "user": _public_user(user) if user else None,
            },
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[api] catalog failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})


def _api_me(event):
    """Текущий пользователь либо 401 для гостя."""
    user = _current_user(event)
    if not user:
        return auth.json_response(401, {"error": "unauthorized"})
    return auth.json_response(200, {"user": _public_user(user)})


def _api_folder(event):
    """Содержимое папки со всей геометрией её маршрутов."""
    folder_id = (_query(event).get("folder_id") or "").strip()
    user = _current_user(event)
    try:
        folders, route_rows, by_id = _catalog_data()
        if folder_id and folder_id not in by_id:
            return auth.json_response(404, {"error": "folder_not_found"})

        child_folders = []
        for folder in folders:
            if _text(folder["parent_id"]) != folder_id:
                continue
            child_folders.append(
                {
                    "folder_id": folder["folder_id"],
                    "parent_id": folder["parent_id"],
                    "name": folder["name"],
                    "sort_order": folder["sort_order"],
                }
            )
        child_folders.sort(key=lambda f: (f["sort_order"], f["name"]))

        routes = []
        for row in route_rows:
            row_folder_id = _text(_row_value(row, "folder_id"))
            if row_folder_id != folder_id:
                continue
            route = _route_public_dict(row, by_id)
            route["data"] = _json_value(_row_value(row, "json"))
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
    """Геометрия одного видимого маршрута."""
    m_val = _query(event).get("m") or ""
    if not isinstance(m_val, str) or not m_val.strip():
        return auth.json_response(400, {"error": "missing_route_name"})

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
        row = rows[0]
        data = _json_value(_row_value(row, "json"))
        payload = _route_public_dict(row, by_id)
        payload["data"] = data
        return auth.json_response(200, payload)
    except Exception as exc:  # noqa: BLE001
        print(f"[api] route failed: {exc}")
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
    sort_order = _int(body.get("sort_order"))

    if not name:
        return auth.json_response(400, {"error": "missing_folder_name"})
    if parent_id and parent_id not in by_id:
        return auth.json_response(400, {"error": "unknown_parent"})
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
        sort_order=sort_order,
    )

    # Держим legacy-поле roads.name в согласии с деревом папок.
    new_by_id = dict(by_id)
    new_by_id[folder_id] = {
        "folder_id": folder_id,
        "parent_id": parent_id,
        "name": name,
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

    if normalized == "/api/route" and method == "GET":
        return _api_route(event)

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
