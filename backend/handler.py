"""Бэкенд OSM-версии навигатора и редактора.

Публичное API:
  GET ?action=list_routes[&creator=<id>]  — список видимых маршрутов
  GET ?id=<id>&m=<m>                      — маршрут {name, m, data}

API редактора (после авторизации):
  GET ?action=register|login
  GET ?action=list                        — маршруты текущего пользователя
  GET ?action=get_protected&m=<m>         — маршрут пользователя
  GET ?action=get_meta&m=<m>
  POST ?action=save&m=<m>                 — тело {data: [...]}
  POST ?action=save_meta&m=<m>            — тело {name, description, visible, creator_name[, new_m]}
  GET ?action=delete&m=<m>

Авторизация — как в исходном редакторе: Telegram initData, VK id либо
логин/пароль из таблицы users. База — отдельная serverless-YDB (dbosm).
"""

import hashlib
import hmac
import json
import os
import time
import urllib.parse

import ydb
import ydb.iam

YDB_ENDPOINT = os.getenv("YDB_ENDPOINT")
YDB_DATABASE = os.getenv("YDB_DATABASE")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_TOKEN")
ADMIN_ACCESS_KEY = os.getenv("ADMIN_ACCESS_KEY")

_pool = None
_users_ready = False


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


def ensure_users_table():
    global _users_ready
    if _users_ready:
        return

    def create(session):
        session.execute_scheme(
            """
            CREATE TABLE IF NOT EXISTS users (
                login Utf8,
                password Utf8,
                creator_name Utf8,
                created_at Timestamp,
                PRIMARY KEY (login)
            );
            """
        )

    get_pool().retry_operation_sync(create)
    _users_ready = True


def verify_tg_init_data(init_data):
    """Проверка подписи Telegram Mini App initData."""
    if not TELEGRAM_BOT_TOKEN:
        return None, "TELEGRAM_TOKEN not configured"
    if not init_data:
        return None, "tg_init_data missing"

    parsed = urllib.parse.parse_qs(init_data)
    params = {k: v[0] for k, v in parsed.items()}

    hash_value = params.pop("hash", None)
    if not hash_value:
        return None, "hash missing from tg_init_data"

    sorted_params = sorted(params.items(), key=lambda x: x[0])
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted_params)

    secret_key = hmac.new(
        b"WebAppData", TELEGRAM_BOT_TOKEN.encode("utf-8"), hashlib.sha256
    ).digest()
    calculated_hash = hmac.new(
        secret_key, data_check_string.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(calculated_hash, hash_value):
        return None, "invalid tg signature"

    user_str = params.get("user")
    if not user_str:
        return None, "user missing from tg_init_data"

    try:
        user_data = json.loads(urllib.parse.unquote(user_str))
        uid = str(user_data.get("id"))
        if not uid:
            return None, "user id missing"
        return uid, None
    except (json.JSONDecodeError, ValueError) as exc:
        return None, f"invalid user data: {exc}"


# ---- Маршруты ----


def execute_list_routes_public(session, creator=None):
    if creator:
        query = """
            DECLARE $creator AS Utf8;
            SELECT DISTINCT id, m, name, description, creator_name
            FROM roads
            WHERE id = $creator AND visible = true AND name IS NOT NULL
            ORDER BY name;
        """
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$creator": str(creator)}, commit_tx=True
        )

    query = """
        SELECT DISTINCT id, m, name, description, creator_name
        FROM roads
        WHERE visible = true AND name IS NOT NULL
        ORDER BY name;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_list_user_routes(session, id_param):
    query = """
        DECLARE $id AS Utf8;
        SELECT m, name, visible FROM roads WHERE id = $id;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$id": str(id_param)}, commit_tx=True
    )


def execute_get_route(session, id_param, m_param):
    query = """
        DECLARE $id AS Utf8;
        DECLARE $m AS Utf8;
        SELECT json, name, m FROM roads WHERE id = $id AND m = $m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$id": str(id_param), "$m": str(m_param)}, commit_tx=True
    )


def execute_delete_route(session, id_param, m_param):
    query = """
        DECLARE $id AS Utf8;
        DECLARE $m AS Utf8;
        DELETE FROM roads WHERE id = $id AND m = $m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$id": str(id_param), "$m": str(m_param)}, commit_tx=True
    )


def execute_upsert_route(session, id_param, m_param, json_data):
    query = """
        DECLARE $id AS Utf8;
        DECLARE $m AS Utf8;
        DECLARE $json AS Json;
        UPSERT INTO roads (id, m, json) VALUES ($id, $m, $json);
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$id": str(id_param),
            "$m": str(m_param),
            "$json": json.dumps(json_data, ensure_ascii=False)
            if not isinstance(json_data, str)
            else json_data,
        },
        commit_tx=True,
    )


def execute_update_route_meta(
    session, id_param, m_param, name, description, visible, creator_name=""
):
    query = """
        DECLARE $id AS Utf8;
        DECLARE $m AS Utf8;
        DECLARE $name AS Utf8;
        DECLARE $description AS Utf8;
        DECLARE $visible AS Bool;
        DECLARE $creator_name AS Utf8;
        UPDATE roads
        SET name = $name,
            description = $description,
            visible = $visible,
            creator_name = CASE WHEN $creator_name = '' THEN creator_name ELSE $creator_name END
        WHERE id = $id AND m = $m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$id": str(id_param),
            "$m": str(m_param),
            "$name": str(name),
            "$description": str(description),
            "$visible": bool(visible),
            "$creator_name": str(creator_name),
        },
        commit_tx=True,
    )


def execute_rename_route(
    session,
    id_param,
    old_m_param,
    new_m_param,
    name,
    description,
    visible,
    creator_name="",
):
    query = """
        DECLARE $id AS Utf8;
        DECLARE $old_m AS Utf8;
        DECLARE $new_m AS Utf8;
        DECLARE $name AS Utf8;
        DECLARE $description AS Utf8;
        DECLARE $visible AS Bool;
        DECLARE $creator_name AS Utf8;

        $json = (
            SELECT json FROM roads WHERE id = $id AND m = $old_m
        );
        $old_creator_name = (
            SELECT creator_name FROM roads WHERE id = $id AND m = $old_m
        );

        UPSERT INTO roads (id, m, json, name, description, visible, creator_name)
        VALUES (
            $id, $new_m, $json, $name, $description, $visible,
            CASE WHEN $creator_name = '' THEN $old_creator_name ELSE $creator_name END
        );
        DELETE FROM roads WHERE id = $id AND m = $old_m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$id": str(id_param),
            "$old_m": str(old_m_param),
            "$new_m": str(new_m_param),
            "$name": str(name),
            "$description": str(description),
            "$visible": bool(visible),
            "$creator_name": str(creator_name),
        },
        commit_tx=True,
    )


def execute_get_route_meta(session, id_param, m_param):
    query = """
        DECLARE $id AS Utf8;
        DECLARE $m AS Utf8;
        SELECT name, description, visible, creator_name
        FROM roads WHERE id = $id AND m = $m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$id": str(id_param), "$m": str(m_param)}, commit_tx=True
    )


# ---- Пользователи (логин/пароль) ----


def execute_get_user(session, login_param):
    query = """
        DECLARE $login AS Utf8;
        SELECT login, password, creator_name FROM users WHERE login = $login;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$login": str(login_param)}, commit_tx=True
    )


def execute_create_user(session, login_param, password_param, creator_name_param):
    query = """
        DECLARE $login AS Utf8;
        DECLARE $password AS Utf8;
        DECLARE $creator_name AS Utf8;
        DECLARE $created_at AS Timestamp;
        UPSERT INTO users (login, password, creator_name, created_at)
        VALUES ($login, $password, $creator_name, $created_at);
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$login": str(login_param),
            "$password": str(password_param),
            "$creator_name": str(creator_name_param),
            "$created_at": int(time.time() * 1_000_000),
        },
        commit_tx=True,
    )


# ---- HTTP ----


def create_response(status_code, body, is_public=False):
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Origin, Accept",
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
    id_val = params.get("id")
    creator_filter = params.get("creator", "")

    # Публичный список маршрутов (навигатор)
    if action == "list_routes":
        try:
            result_sets = get_pool().retry_operation_sync(
                execute_list_routes_public, creator=creator_filter or None
            )
            routes = [
                {
                    "id": _text(row.id),
                    "m": _text(row.m),
                    "name": _text(row.name),
                    "description": _text(row.description),
                    "creator_name": _text(row.creator_name),
                }
                for row in result_sets[0].rows
            ]
            return create_response(200, routes, is_public=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[osmn] list_routes failed: {exc}")
            return create_response(500, {"error": "internal_error"}, is_public=True)

    # Регистрация / вход (редактор)
    if action in ("register", "login"):
        try:
            ensure_users_table()
        except Exception as exc:  # noqa: BLE001
            print(f"[osmn] ensure users failed: {exc}")
            return create_response(500, {"error": "users_table_error"})

    if action == "register":
        try:
            login = params.get("login", "").strip()
            password = params.get("password", "")
            creator_name = params.get("creator_name", login)

            if not login or not password:
                return create_response(400, {"error": "missing_fields"})
            if len(login) < 2 or len(password) < 3:
                return create_response(400, {"error": "login_min_2_password_min_3"})
            if not any(c.isalpha() for c in login):
                return create_response(400, {"error": "login_must_contain_letter"})
            if "-" in login:
                return create_response(400, {"error": "login_no_hyphen"})

            existing = get_pool().retry_operation_sync(
                execute_get_user, login_param=login
            )
            if existing[0].rows:
                return create_response(409, {"error": "login_taken"})

            get_pool().retry_operation_sync(
                execute_create_user,
                login_param=login,
                password_param=password,
                creator_name_param=creator_name,
            )
            return create_response(200, {"status": "registered"})
        except Exception as exc:  # noqa: BLE001
            print(f"[osmn] register failed: {exc}")
            return create_response(500, {"error": "register_failed"})

    if action == "login":
        try:
            login = params.get("login", "").strip()
            password = params.get("password", "")

            if not login or not password:
                return create_response(400, {"error": "missing_fields"})

            if ADMIN_ACCESS_KEY and password == ADMIN_ACCESS_KEY:
                creator_name = login
                try:
                    result = get_pool().retry_operation_sync(
                        execute_get_user, login_param=login
                    )
                    if result[0].rows:
                        creator_name = getattr(result[0].rows[0], "creator_name", "") or login
                except Exception:  # noqa: BLE001
                    pass
                return create_response(
                    200,
                    {"status": "ok", "login": login, "name": creator_name, "admin": True},
                )

            result = get_pool().retry_operation_sync(
                execute_get_user, login_param=login
            )
            if not result[0].rows:
                return create_response(401, {"error": "invalid_credentials"})

            row = result[0].rows[0]
            if row.password != password:
                return create_response(401, {"error": "invalid_credentials"})

            creator_name = getattr(row, "creator_name", "") or login
            return create_response(
                200, {"status": "ok", "login": login, "name": creator_name}
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[osmn] login failed: {exc}")
            return create_response(500, {"error": "login_failed"})

    # Публичное получение маршрута (навигатор)
    if action == "get":
        if not m_val:
            return create_response(400, {"error": "missing_route_name"})
        if not id_val:
            return create_response(400, {"error": "missing_id"})

        try:
            result_sets = get_pool().retry_operation_sync(
                execute_get_route, id_param=id_val, m_param=m_val
            )
            if not result_sets[0].rows:
                return create_response(404, {"error": "not_found"})

            row = result_sets[0].rows[0]
            return create_response(
                200,
                {
                    "name": _text(row.name),
                    "m": _text(row.m) or m_val,
                    "data": _json_value(row.json),
                },
                is_public=True,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[osmn] get failed: {exc}")
            return create_response(500, {"error": "internal_error"})

    # Авторизация редактора
    platform = params.get("p", "vk")
    verified_user_id = None

    if platform == "tg":
        verified_user_id, err = verify_tg_init_data(params.get("tg_init_data", ""))
        if not verified_user_id:
            return create_response(401, {"error": "invalid_tg_signature", "message": err})
    elif platform == "user":
        login = params.get("login", "").strip()
        password = params.get("password", "")
        if not login or not password:
            return create_response(401, {"error": "missing_credentials"})
        try:
            ensure_users_table()
            if ADMIN_ACCESS_KEY and password == ADMIN_ACCESS_KEY:
                verified_user_id = login
            else:
                result = get_pool().retry_operation_sync(
                    execute_get_user, login_param=login
                )
                if not result[0].rows or result[0].rows[0].password != password:
                    return create_response(401, {"error": "invalid_credentials"})
                verified_user_id = login
        except Exception as exc:  # noqa: BLE001
            print(f"[osmn] user auth failed: {exc}")
            return create_response(500, {"error": "auth_error"})
    else:
        verified_user_id = id_val

    user_id = verified_user_id
    if not user_id:
        return create_response(401, {"error": "unauthorized"})

    try:
        if action == "list":
            result = get_pool().retry_operation_sync(
                execute_list_user_routes, id_param=user_id
            )
            routes = [
                {
                    "m": _text(row.m),
                    "name": _text(row.name),
                    "visible": bool(row.visible) if row.visible is not None else False,
                }
                for row in result[0].rows
            ]
            return create_response(200, {"routes": routes})

        if action == "get_protected":
            if not m_val:
                return create_response(400, {"error": "missing_route_name"})
            result = get_pool().retry_operation_sync(
                execute_get_route, id_param=user_id, m_param=m_val
            )
            if not result[0].rows:
                return create_response(404, {"error": "route_not_found"})
            row = result[0].rows[0]
            return create_response(
                200,
                {"id": user_id, "m": m_val, "data": _json_value(row.json)},
            )

        if action == "delete":
            if not m_val:
                return create_response(400, {"error": "missing_route_name"})
            get_pool().retry_operation_sync(
                execute_delete_route, id_param=user_id, m_param=m_val
            )
            return create_response(200, {"status": "deleted"})

        if action == "save":
            if not m_val:
                return create_response(400, {"error": "missing_route_name"})
            try:
                body_data = json.loads(body) if body else {}
            except ValueError:
                body_data = {}
            try:
                get_pool().retry_operation_sync(
                    execute_upsert_route,
                    id_param=user_id,
                    m_param=m_val,
                    json_data=body_data.get("data", []),
                )
            except Exception as exc:  # noqa: BLE001
                print(f"[osmn] save failed: {exc}")
                return create_response(500, {"error": "save_failed"})
            return create_response(200, {"status": "saved"})

        if action == "get_meta":
            if not m_val:
                return create_response(400, {"error": "missing_route_name"})
            result = get_pool().retry_operation_sync(
                execute_get_route_meta, id_param=user_id, m_param=m_val
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
                    "creator_name": _text(row.creator_name),
                },
            )

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
            creator_name = body_data.get("creator_name", "")

            if new_m and new_m != m_val:
                get_pool().retry_operation_sync(
                    execute_rename_route,
                    id_param=user_id,
                    old_m_param=m_val,
                    new_m_param=new_m,
                    name=name,
                    description=description,
                    visible=visible,
                    creator_name=creator_name,
                )
                return create_response(200, {"status": "meta_saved", "new_m": new_m})

            get_pool().retry_operation_sync(
                execute_update_route_meta,
                id_param=user_id,
                m_param=m_val,
                name=name,
                description=description,
                visible=visible,
                creator_name=creator_name,
            )
            return create_response(200, {"status": "meta_saved"})

        return create_response(400, {"error": "unknown_action"})

    except ValueError as exc:
        return create_response(400, {"error": "invalid_parameter_format", "details": str(exc)})
    except Exception as exc:  # noqa: BLE001
        print(f"[osmn] {action} failed: {exc}")
        return create_response(500, {"error": "internal_server_error"})
