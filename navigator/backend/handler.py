"""Бэкенд OSM-версии навигатора и редактора.

Маршруты не привязаны к аккаунтам. Единственный идентификатор маршрута — `m`.

Публичное API:
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
  POST ?action=delete&m=<m>       — заголовок X-Route-Admin-Password

База — отдельная serverless-YDB (dbosm).
"""

import hmac
import json
import os

import ydb
import ydb.iam

YDB_ENDPOINT = os.getenv("YDB_ENDPOINT")
YDB_DATABASE = os.getenv("YDB_DATABASE")

_pool = None


def get_pool():
    global _pool
    if _pool is None:
        driver_config = ydb.DriverConfig(
            YDB_ENDPOINT,
            YDB_DATABASE,
            credentials=ydb.iam.MetadataUrlCredentials(),
        )
        driver = ydb.Driver(driver_config)
        driver.wait(timeout=10)
        _pool = ydb.SessionPool(driver)
    return _pool


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


def handler(event, context):
    params = event.get("queryStringParameters") or {}
    method = (event.get("httpMethod") or "GET").upper()
    body = event.get("body") or ""

    if method == "OPTIONS":
        return create_response(200, {"status": "ok"}, is_public=True)

    action = params.get("action") or "get"
    m_val = params.get("m")

    if action in {"auth", "save", "save_meta", "delete"}:
        admin_password = os.environ.get("ROUTE_ADMIN_PASSWORD")
        headers = event.get("headers") or {}
        provided_password = next(
            (value for key, value in headers.items()
             if str(key).lower() == "x-route-admin-password"),
            "",
        )
        if not admin_password:
            return create_response(503, {"error": "admin_auth_not_configured"})
        if not isinstance(provided_password, str) or not hmac.compare_digest(
            provided_password, admin_password
        ):
            return create_response(403, {"error": "invalid_admin_password"})
        if action == "auth":
            return create_response(200, {"status": "authenticated"}, is_public=True)

    try:
        if action == "list_routes":
            # full=1 — отдать геометрию всех видимых маршрутов одним запросом,
            # чтобы клиент не ходил в action=get по каждому маршруту.
            include_json = params.get("full") == "1"
            result = get_pool().retry_operation_sync(
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
            result = get_pool().retry_operation_sync(
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
            result = get_pool().retry_operation_sync(execute_list_editor_routes)
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
            result = get_pool().retry_operation_sync(
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
            get_pool().retry_operation_sync(
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
                get_pool().retry_operation_sync(
                    execute_rename_route,
                    old_m_param=m_val,
                    new_m_param=new_m,
                    name=name,
                    description=description,
                    visible=visible,
                )
                return create_response(200, {"status": "meta_saved", "new_m": new_m})

            get_pool().retry_operation_sync(
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
            get_pool().retry_operation_sync(execute_delete_route, m_param=m_val)
            return create_response(200, {"status": "deleted"})

        return create_response(400, {"error": "unknown_action"})

    except ValueError as exc:
        return create_response(
            400, {"error": "invalid_parameter_format", "details": str(exc)}
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[osmn] {action} failed: {exc}")
        return create_response(500, {"error": "internal_server_error"})
