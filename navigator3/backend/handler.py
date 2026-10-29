"""Бэкенд OSM-версии навигатора и редактора.

Маршруты не привязаны к аккаунтам. Единственный идентификатор маршрута — `m`.

Публичное API (старый способ, прямой вызов функции):
  GET ?action=list_routes        — список видимых маршрутов
  GET ?action=list_routes&full=1 — то же + геометрия (data) каждого маршрута
  GET ?action=get&m=<m>          — маршрут {name, m, data}

API редактора (операции изменения требуют ROUTE_ADMIN_PASSWORD):
  GET  ?action=list                  — все маршруты
  GET  ?action=get&m=<m>             — данные маршрута
  GET  ?action=get_meta&m=<m>        — название, описание, видимость
  POST ?action=auth                  — проверка X-Route-Admin-Password
  POST ?action=save&m=<m>            — тело {data: [...]}
  POST ?action=save_meta&m=<m>       — тело {name, description, visible[, new_m]}
  POST ?action=delete&m=<m>          — заголовок X-Route-Admin-Password

Идентификация через API Gateway:
  GET  /auth/yandex/start     — редирект на Яндекс OAuth
  GET  /auth/yandex/callback  — обмен кода, создание сессии
  POST /auth/logout           — удаление сессии
  GET  /api/me                — текущий пользователь или 401
  GET  /api/health            — проверка, что функция на шлюзе доступна

Публичный API навигатора:
  GET  /api/catalog           — видимые маршруты без геометрии
  GET  /api/route?m=<m>       — геометрия одного видимого маршрута

Редактор через шлюз:
  /api/admin?action=...       — те же legacy-операции (list, get, save, ...),
                                что и прямой вызов функции; нужен пароль
                                X-Route-Admin-Password для любого действия

База — отдельная serverless-YDB (dbosm).
"""

import hmac
import json
import math
import os
import secrets

import auth
import store


def execute_list_routes(session, visible_only, include_json=False):
    where = "WHERE visible = true AND name IS NOT NULL" if visible_only else ""
    columns = "m, name, description, json" if include_json else "m, name, description"
    query = f"""
        SELECT {columns}
        FROM roads
        {where}
        ORDER BY name;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_list_editor_routes(session):
    query = """
        SELECT m, name, visible
        FROM roads
        ORDER BY name;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_get_route(session, m_param):
    query = """
        DECLARE $m AS Utf8;
        SELECT json, name, m FROM roads WHERE m = $m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$m": str(m_param)}, commit_tx=True
    )


def execute_get_public_route(session, m_param):
    """Только видимый маршрут: скрытые и удалённые наружу не отдаём."""
    query = """
        DECLARE $m AS Utf8;
        SELECT json, name, m, description
        FROM roads
        WHERE m = $m AND visible = true AND name IS NOT NULL;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$m": str(m_param)}, commit_tx=True
    )


def execute_get_route_meta(session, m_param):
    query = """
        DECLARE $m AS Utf8;
        SELECT name, description, visible FROM roads WHERE m = $m;
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


def execute_update_route_meta(session, m_param, name, description, visible):
    query = """
        DECLARE $m AS Utf8;
        DECLARE $name AS Utf8;
        DECLARE $description AS Utf8;
        DECLARE $visible AS Bool;
        UPDATE roads
        SET name = $name,
            description = $description,
            visible = $visible
        WHERE m = $m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$m": str(m_param),
            "$name": str(name),
            "$description": str(description),
            "$visible": bool(visible),
        },
        commit_tx=True,
    )


def execute_rename_route(session, old_m_param, new_m_param, name, description, visible):
    query = """
        DECLARE $old_m AS Utf8;
        DECLARE $new_m AS Utf8;
        DECLARE $name AS Utf8;
        DECLARE $description AS Utf8;
        DECLARE $visible AS Bool;

        $json = (
            SELECT json FROM roads WHERE m = $old_m
        );

        UPSERT INTO roads (m, json, name, description, visible)
        VALUES ($new_m, $json, $name, $description, $visible);
        DELETE FROM roads WHERE m = $old_m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$old_m": str(old_m_param),
            "$new_m": str(new_m_param),
            "$name": str(name),
            "$description": str(description),
            "$visible": bool(visible),
        },
        commit_tx=True,
    )


def create_response(status_code, body, is_public=False):
    """Ответ старого API: с CORS, чтобы прямой вызов функции не сломался."""
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Origin, Accept, X-Route-Admin-Password",
    }
    if is_public:
        headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": json.dumps(body, ensure_ascii=False),
    }


def _text(value):
    return value if isinstance(value, str) else ("" if value is None else str(value))


def _json_value(raw):
    try:
        return json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return []


def _route_metrics(data):
    """Считает число сегментов и длину так же, как фронтенд.

    Геометрия остаётся на сервере: в /api/catalog уходят только эти числа.
    """
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


def _header(event, name):
    headers = event.get("headers") or {}
    for key, value in headers.items():
        if str(key).lower() == name.lower() and isinstance(value, str):
            return value
    return ""


def _request_meta(event):
    """Совместимость с API Gateway 2.0 и со старым прямым вызовом функции."""
    context = event.get("requestContext") or {}
    http = context.get("http") or {}
    path = event.get("rawPath") or event.get("path") or http.get("path") or "/"
    method = event.get("httpMethod") or http.get("method") or "GET"
    return str(path or "/"), str(method).upper()


def _query(event):
    return event.get("queryStringParameters") or {}


def _client_meta(event):
    context = event.get("requestContext") or {}
    http = context.get("http") or {}
    identity = context.get("identity") or {}
    ip = http.get("sourceIp") or identity.get("sourceIp") or ""
    user_agent = http.get("userAgent")
    if not isinstance(user_agent, str):
        user_agent = _header(event, "user-agent")
    return str(ip or ""), str(user_agent or "")


def _public_user(user):
    return {
        "user_id": _text(user.get("user_id")),
        "login": _text(user.get("login")),
        "display_name": _text(user.get("display_name")),
        "email": _text(user.get("email")),
    }


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


def _api_me(event):
    user = _current_user(event)
    if not user:
        return auth.json_response(401, {"error": "unauthorized"})
    return auth.json_response(
        200,
        {"user": _public_user(user), "entitlements": []},
    )


def _api_catalog(event):
    """Список видимых маршрутов без геометрии.

    Метрики считаются на сервере, чтобы клиент не получал и не парсил все
    точки ради количества и длины. Сама геометрия отдаётся только
    /api/route для выбранного маршрута.
    """
    try:
        result = store.get_pool().retry_operation_sync(
            execute_list_routes, visible_only=True, include_json=True
        )
        routes = []
        for row in result[0].rows:
            data = _json_value(row.json)
            route = {
                "m": _text(row.m),
                "name": _text(row.name),
                "description": _text(row.description),
                "access": "public",
            }
            route.update(_route_metrics(data))
            routes.append(route)
        return auth.json_response(200, {"routes": routes})
    except Exception as exc:  # noqa: BLE001
        print(f"[api] catalog failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})


def _api_route(event):
    """Геометрия одного маршрута. Скрытые маршруты не отдаются."""
    m_val = _query(event).get("m") or ""
    if not isinstance(m_val, str) or not m_val.strip():
        return auth.json_response(400, {"error": "missing_route_name"})

    try:
        result = store.get_pool().retry_operation_sync(
            execute_get_public_route, m_param=m_val.strip()
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[api] route failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})

    if not result[0].rows:
        return auth.json_response(404, {"error": "route_not_found"})

    row = result[0].rows[0]
    data = _json_value(row.json)
    payload = {
        "m": _text(row.m) or m_val,
        "name": _text(row.name),
        "description": _text(row.description),
        "access": "public",
        "data": data,
    }
    payload.update(_route_metrics(data))
    return auth.json_response(200, payload)


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


def _handle_api(event, path, method):
    normalized = path.rstrip("/") or "/"

    if normalized == "/api/health" and method == "GET":
        return auth.json_response(200, {"status": "ok"})

    if normalized == "/api/me" and method == "GET":
        return _api_me(event)

    if normalized == "/api/catalog" and method == "GET":
        return _api_catalog(event)

    if normalized == "/api/route" and method == "GET":
        return _api_route(event)

    if normalized == "/api/admin":
        # Редактор работает на том же origin, что и шлюз. Прямой вызов
        # функции платформа закрывает (403), поэтому проксируем сюда.
        # Читать через этот путь тоже можно только с паролем: иначе
        # action=get отдавал бы скрытые маршруты в обход visible=true.
        error = _admin_auth_error(event)
        if error:
            return error
        return _handle_legacy(event, method)

    if normalized == "/auth/yandex/start" and method == "GET":
        return _auth_start(event)

    if normalized == "/auth/yandex/callback" and method == "GET":
        return _auth_callback(event)

    if normalized == "/auth/logout" and method == "POST":
        return _auth_logout(event)

    return auth.json_response(404, {"error": "not_found"})


def _admin_auth_error(event):
    """Возвращает 503/403, если пароль редактора не настроен или неверен."""
    admin_password = os.environ.get("ROUTE_ADMIN_PASSWORD")
    if not admin_password:
        return create_response(503, {"error": "admin_auth_not_configured"})

    headers = event.get("headers") or {}
    provided_password = next(
        (
            value
            for key, value in headers.items()
            if str(key).lower() == "x-route-admin-password"
        ),
        "",
    )
    if not isinstance(provided_password, str) or not hmac.compare_digest(
        provided_password, admin_password
    ):
        return create_response(403, {"error": "invalid_admin_password"})
    return None


def _handle_legacy(event, method):
    params = _query(event)
    body = event.get("body") or ""
    action = params.get("action") or "get"
    m_val = params.get("m")

    if action in {"auth", "save", "save_meta", "delete"}:
        error = _admin_auth_error(event)
        if error:
            return error
        if action == "auth":
            return create_response(200, {"status": "authenticated"}, is_public=True)

    try:
        if action == "list_routes":
            # full=1 — отдать геометрию всех видимых маршрутов одним запросом,
            # чтобы клиент не ходил в action=get по каждому маршруту.
            include_json = params.get("full") == "1"
            result = store.get_pool().retry_operation_sync(
                execute_list_routes, visible_only=True, include_json=include_json
            )
            routes = []
            for row in result[0].rows:
                route = {
                    "m": _text(row.m),
                    "name": _text(row.name),
                    "description": _text(row.description),
                }
                if include_json:
                    route["data"] = _json_value(row.json)
                routes.append(route)
            return create_response(200, routes, is_public=True)

        if action == "get":
            if not m_val:
                return create_response(400, {"error": "missing_route_name"})
            result = store.get_pool().retry_operation_sync(
                execute_get_route, m_param=m_val
            )
            if not result[0].rows:
                return create_response(404, {"error": "not_found"}, is_public=True)
            row = result[0].rows[0]
            return create_response(
                200,
                {
                    "name": _text(row.name),
                    "m": _text(row.m) or m_val,
                    "data": _json_value(row.json),
                },
                is_public=True,
            )

        if action == "list":
            result = store.get_pool().retry_operation_sync(execute_list_editor_routes)
            routes = [
                {
                    "m": _text(row.m),
                    "name": _text(row.name),
                    "visible": bool(row.visible) if row.visible is not None else False,
                }
                for row in result[0].rows
            ]
            return create_response(200, {"routes": routes})

        if action == "get_meta":
            if not m_val:
                return create_response(400, {"error": "missing_route_name"})
            result = store.get_pool().retry_operation_sync(
                execute_get_route_meta, m_param=m_val
            )
            if not result[0].rows:
                return create_response(404, {"error": "route_not_found"})
            row = result[0].rows[0]
            return create_response(
                200,
                {
                    "name": _text(row.name),
                    "description": _text(row.description),
                    "visible": bool(row.visible) if row.visible is not None else False,
                },
            )

        if action == "save":
            if not m_val:
                return create_response(400, {"error": "missing_route_name"})
            try:
                body_data = json.loads(body) if body else {}
            except ValueError:
                return create_response(400, {"error": "invalid_json_body"})
            store.get_pool().retry_operation_sync(
                execute_upsert_route,
                m_param=m_val,
                json_data=body_data.get("data", []),
            )
            return create_response(200, {"status": "saved"})

        if action == "save_meta":
            if not m_val:
                return create_response(400, {"error": "missing_route_name"})
            try:
                body_data = json.loads(body) if body else {}
            except ValueError:
                return create_response(400, {"error": "invalid_json_body"})

            name = body_data.get("name", "")
            description = body_data.get("description", "")
            visible = body_data.get("visible", False)
            new_m = body_data.get("new_m", "")

            if new_m and new_m != m_val:
                store.get_pool().retry_operation_sync(
                    execute_rename_route,
                    old_m_param=m_val,
                    new_m_param=new_m,
                    name=name,
                    description=description,
                    visible=visible,
                )
                return create_response(200, {"status": "meta_saved", "new_m": new_m})

            store.get_pool().retry_operation_sync(
                execute_update_route_meta,
                m_param=m_val,
                name=name,
                description=description,
                visible=visible,
            )
            return create_response(200, {"status": "meta_saved"})

        if action == "delete":
            if not m_val:
                return create_response(400, {"error": "missing_route_name"})
            store.get_pool().retry_operation_sync(execute_delete_route, m_param=m_val)
            return create_response(200, {"status": "deleted"})

        return create_response(400, {"error": "unknown_action"})

    except ValueError as exc:
        return create_response(
            400, {"error": "invalid_parameter_format", "details": str(exc)}
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[osmn] {action} failed: {exc}")
        return create_response(500, {"error": "internal_server_error"})


def handler(event, context):
    path, method = _request_meta(event)

    if method == "OPTIONS":
        if path.startswith("/api/") or path.startswith("/auth/"):
            return {
                "statusCode": 204,
                "headers": {"Cache-Control": "no-store"},
                "body": "",
                "isBase64Encoded": False,
            }
        return create_response(200, {"status": "ok"}, is_public=True)

    if path.startswith("/api/") or path.startswith("/auth/"):
        return _handle_api(event, path, method)

    return _handle_legacy(event, method)
