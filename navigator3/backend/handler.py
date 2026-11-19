"""Бэкенд навигатора и редактора navigator3.

Публичное API (через API Gateway, тот же origin):
  GET  /api/health            — проверка функции
  GET  /api/me                — текущий пользователь
  GET  /api/owners            — корневые папки владельцев и счётчики маршрутов
  GET  /api/catalog?owner=... — маршруты и знаки одного владельца
  GET  /api/catalog?m=<m>     — пакет владельца маршрута (для прямых ссылок)
  GET  /api/route?m=<m>       — геометрия одного маршрута

Вход:
  GET  /auth/yandex/start
  GET  /auth/yandex/callback
  GET  /auth/logout?t=<подпись>&return=<путь>  — выход (CDN запрещает POST)
  POST /auth/logout                            — выход для прямых вызовов

Редактор (нужна сессия Яндекс ID; данные ограничены владельцем):
  POST /api/admin?action=list|get|get_meta|save|save_meta|delete
  POST /api/admin?action=folder_save|folder_delete
База — serverless-YDB (dbosm).
"""

import base64
import datetime as dt
import hashlib
import hmac
import json
import math
import os
import secrets
import urllib.parse

import auth
import store

# ---------------------------------------------------------------------------
# YDB-запросы
# ---------------------------------------------------------------------------


def execute_list_folders(session):
    query = """
        SELECT folder_id, parent_id, name, sort_order, owner_user_id
        FROM folders
        ORDER BY sort_order, name;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_list_editor_folders(session, owner_user_id):
    query = """
        DECLARE $owner_user_id AS Utf8;
        SELECT folder_id, parent_id, name, sort_order
        FROM folders
        WHERE owner_user_id = $owner_user_id
        ORDER BY sort_order, name;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$owner_user_id": str(owner_user_id)}, commit_tx=True
    )


def execute_list_editor_routes(session, owner_user_id):
    query = """
        DECLARE $owner_user_id AS Utf8;
        SELECT m, description, visible, premium, folder_id, title
        FROM roads
        WHERE owner_user_id = $owner_user_id
        ORDER BY title, m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$owner_user_id": str(owner_user_id)}, commit_tx=True
    )


def execute_get_route_owner(session, m_param):
    query = """
        DECLARE $m AS Utf8;
        SELECT owner_user_id FROM roads WHERE m = $m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$m": str(m_param)}, commit_tx=True
    )


def execute_get_folder_owner(session, folder_id):
    query = """
        DECLARE $folder_id AS Utf8;
        SELECT owner_user_id FROM folders WHERE folder_id = $folder_id;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$folder_id": str(folder_id)}, commit_tx=True
    )


def execute_list_public_routes(session):
    query = """
        SELECT m, description, folder_id, title, owner_user_id, premium
        FROM roads
        WHERE visible = true
        ORDER BY title, m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_list_public_routes_geometry(session):
    query = """
        SELECT m, description, json, folder_id, title, owner_user_id, premium
        FROM roads
        WHERE visible = true
        ORDER BY title, m;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_list_owner_names(session):
    query = """
        SELECT user_id, login, display_name, routes_folder_name
        FROM users;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(prepared, commit_tx=True)


def execute_get_owned_route(session, m_param, owner_user_id):
    query = """
        DECLARE $m AS Utf8;
        DECLARE $owner_user_id AS Utf8;
        SELECT json, m, description, visible, premium, folder_id, title
        FROM roads
        WHERE m = $m AND owner_user_id = $owner_user_id;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {"$m": str(m_param), "$owner_user_id": str(owner_user_id)},
        commit_tx=True,
    )


def execute_get_public_route(session, m_param):
    """Только видимый маршрут: скрытые и удалённые наружу не отдаём."""
    query = """
        DECLARE $m AS Utf8;
        SELECT json, m, description, folder_id, title, owner_user_id, premium
        FROM roads
        WHERE m = $m AND visible = true;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared, {"$m": str(m_param)}, commit_tx=True
    )


def execute_delete_route(session, m_param, owner_user_id):
    query = """
        DECLARE $m AS Utf8;
        DECLARE $owner_user_id AS Utf8;
        DELETE FROM roads WHERE m = $m AND owner_user_id = $owner_user_id;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {"$m": str(m_param), "$owner_user_id": str(owner_user_id)},
        commit_tx=True,
    )


def execute_create_route(session, m_param, json_data, owner_user_id):
    query = """
        DECLARE $m AS Utf8;
        DECLARE $json AS Json;
        DECLARE $owner_user_id AS Utf8;
        INSERT INTO roads (m, json, owner_user_id)
        VALUES ($m, $json, $owner_user_id);
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$m": str(m_param),
            "$json": json.dumps(json_data, ensure_ascii=False)
            if not isinstance(json_data, str)
            else json_data,
            "$owner_user_id": str(owner_user_id),
        },
        commit_tx=True,
    )


def execute_update_route_data(session, m_param, json_data, owner_user_id):
    query = """
        DECLARE $m AS Utf8;
        DECLARE $json AS Json;
        DECLARE $owner_user_id AS Utf8;
        UPDATE roads SET json = $json
        WHERE m = $m AND owner_user_id = $owner_user_id;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$m": str(m_param),
            "$json": json.dumps(json_data, ensure_ascii=False)
            if not isinstance(json_data, str)
            else json_data,
            "$owner_user_id": str(owner_user_id),
        },
        commit_tx=True,
    )


def execute_update_route_meta(
    session, m_param, folder_id, title, description, visible, owner_user_id, premium
):
    query = """
        DECLARE $m AS Utf8;
        DECLARE $folder_id AS Utf8;
        DECLARE $title AS Utf8;
        DECLARE $description AS Utf8;
        DECLARE $visible AS Bool;
        DECLARE $premium AS Bool;
        DECLARE $owner_user_id AS Utf8;
        UPDATE roads
        SET folder_id = $folder_id,
            title = $title,
            description = $description,
            visible = $visible,
            premium = $premium
        WHERE m = $m AND owner_user_id = $owner_user_id;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$m": str(m_param),
            "$folder_id": str(folder_id),
            "$title": str(title),
            "$description": str(description),
            "$visible": bool(visible),
            "$premium": bool(premium),
            "$owner_user_id": str(owner_user_id),
        },
        commit_tx=True,
    )


def execute_rename_route(
    session,
    old_m_param,
    new_m_param,
    folder_id,
    title,
    description,
    visible,
    owner_user_id,
    premium,
):
    query = """
        DECLARE $old_m AS Utf8;
        DECLARE $new_m AS Utf8;
        DECLARE $folder_id AS Utf8;
        DECLARE $title AS Utf8;
        DECLARE $description AS Utf8;
        DECLARE $visible AS Bool;
        DECLARE $premium AS Bool;
        DECLARE $owner_user_id AS Utf8;

        $json = (
            SELECT json FROM roads
            WHERE m = $old_m AND owner_user_id = $owner_user_id
        );

        INSERT INTO roads
            (m, json, folder_id, title, description, visible, owner_user_id,
             premium)
        VALUES
            ($new_m, $json, $folder_id, $title, $description, $visible,
             $owner_user_id, $premium);
        DELETE FROM roads
        WHERE m = $old_m AND owner_user_id = $owner_user_id;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$old_m": str(old_m_param),
            "$new_m": str(new_m_param),
            "$folder_id": str(folder_id),
            "$title": str(title),
            "$description": str(description),
            "$visible": bool(visible),
            "$premium": bool(premium),
            "$owner_user_id": str(owner_user_id),
        },
        commit_tx=True,
    )


def execute_create_folder(session, folder_id, parent_id, name, sort_order, owner_user_id):
    query = """
        DECLARE $folder_id AS Utf8;
        DECLARE $parent_id AS Utf8;
        DECLARE $name AS Utf8;
        DECLARE $sort_order AS Uint32;
        DECLARE $owner_user_id AS Utf8;
        INSERT INTO folders
            (folder_id, parent_id, name, sort_order, owner_user_id)
        VALUES
            ($folder_id, $parent_id, $name, $sort_order, $owner_user_id);
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$folder_id": str(folder_id),
            "$parent_id": str(parent_id),
            "$name": str(name),
            "$sort_order": int(sort_order),
            "$owner_user_id": str(owner_user_id),
        },
        commit_tx=True,
    )


def execute_update_folder(session, folder_id, parent_id, name, sort_order, owner_user_id):
    query = """
        DECLARE $folder_id AS Utf8;
        DECLARE $parent_id AS Utf8;
        DECLARE $name AS Utf8;
        DECLARE $sort_order AS Uint32;
        DECLARE $owner_user_id AS Utf8;
        UPDATE folders
        SET parent_id = $parent_id, name = $name, sort_order = $sort_order
        WHERE folder_id = $folder_id AND owner_user_id = $owner_user_id;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$folder_id": str(folder_id),
            "$parent_id": str(parent_id),
            "$name": str(name),
            "$sort_order": int(sort_order),
            "$owner_user_id": str(owner_user_id),
        },
        commit_tx=True,
    )


def execute_delete_folder(session, folder_id, owner_user_id):
    query = """
        DECLARE $folder_id AS Utf8;
        DECLARE $owner_user_id AS Utf8;
        DELETE FROM folders
        WHERE folder_id = $folder_id AND owner_user_id = $owner_user_id;
    """
    prepared = session.prepare(query)
    return session.transaction().execute(
        prepared,
        {
            "$folder_id": str(folder_id),
            "$owner_user_id": str(owner_user_id),
        },
        commit_tx=True,
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
    return title or _text(_row_value(row, "m"))


def _full_route_name(by_id, folder_id, title):
    parts = [folder["name"] for folder in _folder_chain(by_id, folder_id)]
    parts.append(title)
    return "/".join(part for part in parts if part)


def _is_premium(row):
    return bool(_row_value(row, "premium"))


def _premium_until(user):
    value = (user or {}).get("premium_until")
    if isinstance(value, dt.datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=dt.timezone.utc)
        return value.astimezone(dt.timezone.utc)
    return None


def _premium_active(user):
    until = _premium_until(user)
    return bool(until and until > store.now())


def _premium_days():
    try:
        value = int(os.getenv("PREMIUM_DAYS", "30"))
    except (TypeError, ValueError):
        value = 30
    return max(1, min(value, 3650))


def _premium_stars_price():
    try:
        value = int(os.getenv("PREMIUM_STARS_PRICE", "300"))
    except (TypeError, ValueError):
        value = 300
    return max(1, min(value, 100000))


def _premium_price_rub():
    raw = _text(os.getenv("PREMIUM_PRICE_RUB", "299")).replace(",", ".")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = 299.0
    return max(1.0, round(value, 2))


def _premium_amount_kopecks():
    return int(round(_premium_price_rub() * 100))


def _premium_price_text():
    value = _premium_price_rub()
    if abs(value - round(value)) < 1e-9:
        return str(int(round(value)))
    return f"{value:.2f}"


# --- Робокасса -------------------------------------------------------------


ROBOKASSA_PAYMENT_URL = "https://auth.robokassa.ru/Merchant/Index.aspx"


def _robokassa_config():
    login = _text(os.getenv("ROBOKASSA_LOGIN")).strip()
    test = _text(os.getenv("ROBOKASSA_TEST", "")).strip().lower() in (
        "1", "true", "yes", "on"
    )
    # В тестовом режиме Робокасса требует отдельную пару паролей из
    # технических настроек. Если тестовые не заданы — берём боевые.
    if test:
        password1 = (
            _text(os.getenv("ROBOKASSA_PASSWORD_TEST1")).strip()
            or _text(os.getenv("ROBOKASSA_PASSWORD1")).strip()
        )
        password2 = (
            _text(os.getenv("ROBOKASSA_PASSWORD_TEST2")).strip()
            or _text(os.getenv("ROBOKASSA_PASSWORD2")).strip()
        )
    else:
        password1 = _text(os.getenv("ROBOKASSA_PASSWORD1")).strip()
        password2 = _text(os.getenv("ROBOKASSA_PASSWORD2")).strip()
    return login, password1, password2, test


def _robokassa_ready():
    login, password1, password2, _ = _robokassa_config()
    return bool(login and password1 and password2)


def _robokassa_signature(*parts):
    return hashlib.md5(":".join(str(part) for part in parts).encode("utf-8")).hexdigest()


def _premium_providers():
    return ["robokassa"] if _robokassa_ready() else []


def _robokassa_new_inv_id():
    """Числовой InvId: Робокасса не принимает строковые идентификаторы."""
    for _ in range(10):
        value = secrets.randbelow(2_000_000_000) + 1
        if not store.get_payment(str(value)):
            return value
    raise RuntimeError("could not allocate Robokassa InvId")


def _robokassa_payment_url(inv_id, amount, description, user):
    login, password1, _, test = _robokassa_config()
    out_sum = f"{float(amount):.2f}"
    params = {
        "MerchantLogin": login,
        "OutSum": out_sum,
        "InvId": str(inv_id),
        "Description": description,
        "SignatureValue": _robokassa_signature(login, out_sum, str(inv_id), password1),
        "Encoding": "utf-8",
        "Culture": "ru",
    }
    email = _text((user or {}).get("email")).strip()
    if email:
        params["Email"] = email
    if test:
        params["IsTest"] = "1"
    return ROBOKASSA_PAYMENT_URL + "?" + urllib.parse.urlencode(params)


def _form_body(event):
    """Тело application/x-www-form-urlencoded (Робокасса шлёт Result URL так)."""
    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        try:
            body = base64.b64decode(body).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return {}
    if not body:
        return {}
    parsed = urllib.parse.parse_qs(body, keep_blank_values=True)
    return {key: values[0] if values else "" for key, values in parsed.items()}


def _text_response(status_code, text):
    return {
        "statusCode": int(status_code),
        "headers": {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
        },
        "body": text,
        "isBase64Encoded": False,
    }


def _route_locked(row, user):
    """Премиум-маршрут закрыт для всех, кроме владельца и активной подписки."""
    if not _is_premium(row):
        return False
    owner_user_id = _text(_row_value(row, "owner_user_id"))
    user_id = _text((user or {}).get("user_id"))
    if owner_user_id and owner_user_id == user_id:
        return False
    return not _premium_active(user)


def _route_public_dict(
    row,
    by_id,
    folder_id_override=None,
    user=None,
    with_metrics=True,
    data=None,
):
    raw_folder_id = _text(_row_value(row, "folder_id"))
    folder_id = (
        raw_folder_id if folder_id_override is None else folder_id_override
    )
    title = _route_title(row)
    route = {
        "m": _text(_row_value(row, "m")),
        "folder_id": folder_id,
        "title": title,
        "name": _full_route_name(by_id, folder_id, title)
        if folder_id in by_id
        else title,
        "description": _text(_row_value(row, "description")),
        "premium": _is_premium(row),
        "locked": _route_locked(row, user),
    }
    if with_metrics:
        metrics_source = (
            data if data is not None else _json_value(_row_value(row, "json"))
        )
        route.update(_route_metrics(metrics_source))
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
        else title,
        "description": _text(_row_value(row, "description")),
        "visible": bool(_row_value(row, "visible"))
        if _row_value(row, "visible") is not None
        else False,
        "premium": _is_premium(row),
    }


def _public_user(user):
    until = _premium_until(user)
    return {
        "user_id": _text(user.get("user_id")),
        "login": _text(user.get("login")),
        "display_name": _text(user.get("display_name")),
        "routes_folder_name": _text(user.get("routes_folder_name")),
        "email": _text(user.get("email")),
        "avatar_url": _text(user.get("avatar_url")),
        "auth_provider": _text(user.get("auth_provider")) or "yandex",
        "premium_until": until.isoformat() if until else None,
        "premium_active": _premium_active(user),
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
    user = store.get_user_by_user_id(session.get("user_id"))
    if not user:
        user = store.get_user_by_yandex_id(session.get("yandex_id"))
    if not user or user.get("blocked"):
        return None
    store.touch_session(session.get("sid_hash"), session.get("last_seen_at"))
    return user


def _log_activity(user, action, source="", entity_type="", entity_id="",
                  route_m="", folder_id="", title="", metadata=None):
    """Best-effort запись в журнал действий.

    Ошибка журнала не должна ломать основную операцию: маршрут, оплату или
    сохранение знаков.
    """
    try:
        store.add_activity(
            user,
            action,
            source=source,
            entity_type=entity_type,
            entity_id=entity_id,
            route_m=route_m,
            folder_id=folder_id,
            title=title,
            metadata=metadata,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[activity] {action} failed: {exc}")


def _catalog_data(include_geometry=False, owner_user_id=None):
    pool = store.get_pool()
    folder_rows = _rows(pool.retry_operation_sync(execute_list_folders))
    route_query = (
        execute_list_public_routes_geometry
        if include_geometry
        else execute_list_public_routes
    )
    route_rows = _rows(pool.retry_operation_sync(route_query))
    if owner_user_id is not None:
        owner_user_id = _text(owner_user_id)
        route_rows = [
            row for row in route_rows
            if _text(_row_value(row, "owner_user_id")) == owner_user_id
        ]
        folder_rows = [
            row for row in folder_rows
            if _text(_row_value(row, "owner_user_id")) == owner_user_id
        ]
    owner_rows = _rows(pool.retry_operation_sync(execute_list_owner_names))
    owner_names = {
        _text(_row_value(row, "user_id")): (
            _text(_row_value(row, "routes_folder_name")).strip()
            or _text(_row_value(row, "display_name")).strip()
            or _text(_row_value(row, "login")).strip()
            or "Владелец"
        )
        for row in owner_rows
        if _text(_row_value(row, "user_id"))
    }
    all_folders = [_folder_dict(row) for row in folder_rows]
    all_by_id = {folder["folder_id"]: folder for folder in all_folders}
    folder_owners = {
        _text(_row_value(row, "folder_id")): _text(
            _row_value(row, "owner_user_id")
        )
        for row in folder_rows
    }
    public_owners = {
        _text(_row_value(row, "owner_user_id")) for row in route_rows
    }
    public_folder_ids = set()
    for row in route_rows:
        owner_user_id = _text(_row_value(row, "owner_user_id"))
        folder_id = _text(_row_value(row, "folder_id"))
        public_folder_ids.update(
            folder["folder_id"]
            for folder in _folder_chain(all_by_id, folder_id)
            if folder_owners.get(folder["folder_id"], "") == owner_user_id
        )

    folders = []
    for owner_user_id in sorted(public_owners):
        folders.append(
            {
                "folder_id": _owner_folder_id(owner_user_id),
                "parent_id": "",
                "name": owner_names.get(
                    owner_user_id, "Без владельца" if not owner_user_id else "Владелец"
                ),
                "sort_order": 0,
                "owner_user_id": owner_user_id,
                "is_owner_root": True,
            }
        )

    for folder in all_folders:
        folder_id = folder["folder_id"]
        if folder_id not in public_folder_ids:
            continue
        owner_user_id = folder_owners.get(folder_id, "")
        parent_id = folder["parent_id"]
        if (
            not parent_id
            or parent_id not in public_folder_ids
            or folder_owners.get(parent_id, "") != owner_user_id
        ):
            parent_id = _owner_folder_id(owner_user_id)
        folders.append(
            {
                **folder,
                "parent_id": parent_id,
                "owner_user_id": owner_user_id,
            }
        )
    by_id = {folder["folder_id"]: folder for folder in folders}
    return folders, route_rows, by_id


def _owner_folder_id(owner_user_id):
    if not owner_user_id:
        return "owner_unassigned"
    digest = hashlib.sha256(owner_user_id.encode("utf-8")).hexdigest()[:24]
    return f"owner_{digest}"


def _editor_data(owner_user_id):
    pool = store.get_pool()
    folder_rows = _rows(
        pool.retry_operation_sync(
            execute_list_editor_folders, owner_user_id=owner_user_id
        )
    )
    route_rows = _rows(
        pool.retry_operation_sync(
            execute_list_editor_routes, owner_user_id=owner_user_id
        )
    )
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
        force_confirm = str(
            _query(event).get("force_confirm") or ""
        ).lower() in ("1", "yes", "true")
        location = auth.build_authorize_url(
            state, challenge, event, force_confirm=force_confirm
        )
    except auth.AuthConfigError as exc:
        print(f"[auth] config error: {exc}")
        return auth.json_response(503, {"error": "auth_not_configured"})

    return auth.redirect_response(
        location,
        auth.oauth_cookies(state, verifier, return_to),
    )


def _strip_auth_params(path):
    """Убирает служебные параметры входа из адреса возврата."""
    if not isinstance(path, str):
        return "/"
    parsed = urllib.parse.urlsplit(path)
    query = [
        (key, value)
        for key, value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        if key not in ("auth_error", "logged_out")
    ]
    return urllib.parse.urlunsplit(
        ("", "", parsed.path or "/", urllib.parse.urlencode(query), parsed.fragment)
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
        # Повторный callback после успешного входа: сессия уже есть, cookie
        # состояния погашена. Не пугаем пользователя ошибкой.
        if _current_user(event):
            print("[auth] state mismatch with active session, ignoring")
            return_to = _strip_auth_params(
                auth.return_from_cookie(cookies.get(auth.RETURN_COOKIE))
            )
            return auth.redirect_response(return_to, auth.clear_oauth_cookies())
        print("[auth] state mismatch without session")
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

    try:
        store.upsert_identity("yandex", user.get("yandex_id"), user.get("user_id"))
    except Exception as exc:  # noqa: BLE001
        print(f"[auth] identity upsert failed: {exc}")

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

    _log_activity(
        user,
        "login",
        source="auth",
        entity_type="user",
        entity_id=_text(user.get("user_id")),
    )

    return_to = _strip_auth_params(
        auth.return_from_cookie(cookies.get(auth.RETURN_COOKIE))
    )
    return auth.redirect_response(
        return_to,
        [auth.session_cookie(sid)] + auth.clear_oauth_cookies(),
    )


def _auth_telegram(event):
    """Вход в Mini App по подписи Telegram.WebApp.initData."""
    params = _query(event)
    raw = _text(params.get("d") or params.get("init_data")).strip()
    if not raw and _request_meta(event)[1] == "POST":
        body = _body_json(event)
        if isinstance(body, dict):
            raw = _text(body.get("init_data") or body.get("d")).strip()
    if not raw:
        return auth.json_response(400, {"error": "missing_init_data"})

    bot_token = auth.telegram_bot_token()
    if not bot_token:
        return auth.json_response(503, {"error": "telegram_not_configured"})

    profile, error = auth.verify_telegram_init_data(raw, bot_token)
    if error:
        print(f"[auth] telegram rejected: {error}")
        return auth.json_response(401, {"error": error})

    try:
        user = store.upsert_telegram_user(
            profile["id"],
            profile["login"],
            profile["display_name"],
            profile["avatar_url"],
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[auth] telegram user upsert failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})

    if user.get("blocked"):
        return auth.json_response(403, {"error": "blocked"})

    ip, user_agent = _client_meta(event)
    try:
        sid = store.create_session(
            user["yandex_id"], user["user_id"], user_agent, ip
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[auth] telegram session failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})

    _log_activity(
        user,
        "login",
        source="auth",
        entity_type="user",
        entity_id=_text(user.get("user_id")),
        metadata={"provider": "telegram"},
    )
    return auth.json_response(
        200,
        {"status": "ok", "user": _public_user(user)},
        cookies=[auth.session_cookie(sid)],
    )


def _auth_logout(event):
    if not auth.origin_allowed(event):
        return auth.json_response(403, {"error": "forbidden_origin"})

    sid = auth.parse_cookies(event).get(auth.SESSION_COOKIE)
    method = _request_meta(event)[1]
    if method == "GET":
        return _auth_logout_get(event, sid)

    user = _current_user(event)
    if sid:
        try:
            store.delete_session(sid)
        except Exception as exc:  # noqa: BLE001
            print(f"[auth] session delete failed: {exc}")
    if user:
        _log_activity(
            user,
            "logout",
            source="auth",
            entity_type="user",
            entity_id=_text(user.get("user_id")),
        )
    return auth.json_response(
        200,
        {"status": "logged_out"},
        cookies=[auth.clear_session_cookie()],
    )


def _with_query(path, key, value):
    """Добавляет query-параметр к локальному пути, не ломая существующие."""
    if "?" not in path:
        separator = "?"
    elif path.endswith(("?", "&")):
        separator = ""
    else:
        separator = "&"
    return f"{path}{separator}{key}={value}"


def _auth_logout_get(event, sid):
    """Выход без POST: CDN перед публичным доменом разрешает только GET.

    Ссылка подписана токеном из /api/me, поэтому посторонний сайт не может
    разлогинить пользователя простым переходом.
    """
    params = _query(event)
    return_to = auth.safe_return(params.get("return"), "/")
    if not auth.logout_token_valid(sid, params.get("t")):
        return auth.redirect_response(
            _with_query(return_to, "auth_error", "logout_failed")
        )
    user = _current_user(event)
    try:
        store.delete_session(sid)
    except Exception as exc:  # noqa: BLE001
        print(f"[auth] session delete failed: {exc}")
    if user:
        _log_activity(
            user,
            "logout",
            source="auth",
            entity_type="user",
            entity_id=_text(user.get("user_id")),
        )
    return auth.redirect_response(
        _with_query(return_to, "logged_out", "1"),
        [auth.clear_session_cookie()],
    )


# ---------------------------------------------------------------------------
# Публичное API
# ---------------------------------------------------------------------------


def _signs_from_scene_data(data):
    """Достаёт знаки из JSON сцены PAD в компактном формате навигатора."""
    signs = []
    for marker in data.get("markers") or []:
        if not isinstance(marker, dict) or marker.get("kind") != "znak":
            continue
        code = _text(marker.get("code")).strip()
        file_name = _text(marker.get("file")).strip()
        if not code or not file_name:
            continue
        try:
            lat = float(marker.get("lat"))
            lon = float(marker.get("lon"))
        except (TypeError, ValueError):
            continue
        plates = [
            _text(plate).strip()
            for plate in (marker.get("plates") or [])
            if _text(plate).strip()
        ]
        try:
            heading = float(marker.get("heading") or 0)
        except (TypeError, ValueError):
            heading = 0.0
        signs.append(
            {
                "code": code,
                "file": file_name,
                "lat": lat,
                "lon": lon,
                "heading": heading,
                "leg": bool(marker.get("leg")),
                "plates": plates,
            }
        )
    return signs


def _owner_signs(owner_user_id):
    """Знаки личной сцены владельца. Пустая сцена — пустой список."""
    raw = store.get_owner_signs(owner_user_id)
    if not raw:
        return []
    try:
        data = json.loads(raw)
        if isinstance(data, str):
            data = json.loads(data)
    except Exception as exc:  # noqa: BLE001
        print(f"[signs] owner scene json failed: {exc}")
        return []
    if not isinstance(data, dict):
        return []
    return _signs_from_scene_data(data)


def _api_owners(event):
    """Корневые папки владельцев и количество маршрутов в них."""
    try:
        folders, route_rows, _ = _catalog_data(include_geometry=False)
    except Exception as exc:  # noqa: BLE001
        print(f"[owners] read failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})

    total = {}
    premium = {}
    for row in route_rows:
        owner = _text(_row_value(row, "owner_user_id"))
        total[owner] = total.get(owner, 0) + 1
        if _is_premium(row):
            premium[owner] = premium.get(owner, 0) + 1

    owners = []
    for folder in folders:
        if not folder.get("is_owner_root"):
            continue
        owner = _text(folder.get("owner_user_id"))
        if not owner:
            continue
        owners.append(
            {
                "root_folder_id": folder["folder_id"],
                "name": folder["name"],
                "routes_count": total.get(owner, 0),
                "premium_count": premium.get(owner, 0),
            }
        )
    owners.sort(key=lambda item: item["name"].lower())
    return auth.json_response(200, {"owners": owners})


def _owner_user_id_for_root(root_folder_id):
    root_folder_id = _text(root_folder_id).strip()
    if not root_folder_id:
        return None
    folders, _, _ = _catalog_data(include_geometry=False)
    for folder in folders:
        if folder.get("is_owner_root") and folder["folder_id"] == root_folder_id:
            return _text(folder.get("owner_user_id"))
    return None


def _owner_bundle(owner_user_id, user, views):
    folders, route_rows, by_id = _catalog_data(
        include_geometry=True, owner_user_id=owner_user_id
    )
    routes = []
    for row in route_rows:
        folder_id = _text(_row_value(row, "folder_id"))
        if not folder_id or folder_id not in by_id:
            folder_id = _owner_folder_id(owner_user_id)
        data = _json_value(_row_value(row, "json"))
        route = _route_public_dict(
            row,
            by_id,
            folder_id_override=folder_id,
            user=user,
            data=data,
        )
        if not route["locked"]:
            route["data"] = data if isinstance(data, list) else []
        route["viewed"] = route["m"] in views
        routes.append(route)

    root_id = _owner_folder_id(owner_user_id)
    root = next(
        (folder for folder in folders if folder.get("is_owner_root")),
        None,
    )
    return {
        "owner": {
            "root_folder_id": root_id,
            "name": root["name"] if root else "Владелец",
        },
        "folders": [
            {
                "folder_id": folder["folder_id"],
                "parent_id": folder["parent_id"],
                "name": folder["name"],
                "sort_order": folder["sort_order"],
            }
            for folder in folders
        ],
        "routes": routes,
        "signs": _owner_signs(owner_user_id),
        "user": _public_user(user) if user else None,
    }


def _api_catalog(event):
    """Каталог одного владельца: папки, маршруты, геометрия и знаки.

    Без параметров возвращает список корневых папок владельцев.
    ``owner=<root_folder_id>`` — пакет владельца.
    ``m=<route_m>`` — пакет владельца маршрута (для глубоких ссылок).
    """
    user = _current_user(event)
    owner_param = _text(_query(event).get("owner")).strip()
    route_param = _text(_query(event).get("m")).strip()
    try:
        if not owner_param and not route_param:
            return _api_owners(event)

        owner_user_id = None
        if owner_param:
            owner_user_id = _owner_user_id_for_root(owner_param)
            if not owner_user_id:
                return auth.json_response(404, {"error": "owner_not_found"})
        else:
            rows = _rows(
                store.get_pool().retry_operation_sync(
                    execute_get_public_route, m_param=route_param
                )
            )
            if not rows:
                return auth.json_response(404, {"error": "route_not_found"})
            owner_user_id = _text(_row_value(rows[0], "owner_user_id"))
            if not owner_user_id:
                return auth.json_response(404, {"error": "owner_not_found"})

        views = store.route_views_for_user(user["user_id"]) if user else {}
        return auth.json_response(200, _owner_bundle(owner_user_id, user, views))
    except Exception as exc:  # noqa: BLE001
        print(f"[api] catalog failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})


def _api_signs(event):
    """Совместимый endpoint: знаки владельца по owner или m.

    Основной клиент получает знаки внутри /api/catalog?owner=... .
    """
    owner_param = _text(_query(event).get("owner")).strip()
    route_param = _text(_query(event).get("m")).strip()
    try:
        if owner_param:
            owner_user_id = _owner_user_id_for_root(owner_param)
        elif route_param:
            rows = _rows(
                store.get_pool().retry_operation_sync(
                    execute_get_public_route, m_param=route_param
                )
            )
            owner_user_id = _text(_row_value(rows[0], "owner_user_id")) if rows else None
        else:
            owner_user_id = None
        if not owner_user_id:
            return auth.json_response(404, {"error": "owner_not_found"})
        return auth.json_response(200, {"signs": _owner_signs(owner_user_id)})
    except Exception as exc:  # noqa: BLE001
        print(f"[signs] read failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})


def _api_me(event):
    """Текущий пользователь либо 401 для гостя."""
    user = _current_user(event)
    if not user:
        return auth.json_response(401, {"error": "unauthorized"})
    payload = {"user": _public_user(user)}
    sid = auth.parse_cookies(event).get(auth.SESSION_COOKIE)
    token = auth.logout_token(sid)
    if token:
        payload["logout_token"] = token
    return auth.json_response(200, payload)


def _api_profile_update(event):
    """Смена отображаемого имени текущего пользователя."""
    if not auth.origin_allowed(event):
        return auth.json_response(403, {"error": "forbidden_origin"})
    user = _current_user(event)
    if not user:
        return auth.json_response(401, {"error": "unauthorized"})
    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})

    if "folder_name" not in body:
        return auth.json_response(400, {"error": "missing_folder_name"})
    folder_name = _text(body.get("folder_name")).strip()
    if len(folder_name) > 60:
        return auth.json_response(400, {"error": "folder_name_too_long"})

    try:
        updated = store.update_routes_folder_name(
            user.get("yandex_id"), folder_name
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[profile] routes_folder_name update failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})

    _log_activity(
        user,
        "profile_update",
        source="profile",
        entity_type="user",
        entity_id=_text(user.get("user_id")),
        metadata={"folder_name": folder_name},
    )
    return auth.json_response(200, {"user": _public_user(updated or user)})


# ---------------------------------------------------------------------------
# Премиум-подписка
# ---------------------------------------------------------------------------


def _premium_status_payload(user):
    until = _premium_until(user)
    providers = _premium_providers()
    return {
        "active": _premium_active(user),
        "until": until.isoformat() if until else None,
        "price": _premium_price_text(),
        "price_value": _premium_price_rub(),
        "currency": "RUB",
        "days": _premium_days(),
        "payments_available": bool(providers),
        "providers": providers,
        "logged_in": bool(user),
        "stars_price": _premium_stars_price(),
        "auth_provider": _text(user.get("auth_provider")) if user else "",
        "telegram": bool(user and _text(user.get("auth_provider")) == "telegram"),
    }


def _api_premium_status(event):
    user = _current_user(event)
    return auth.json_response(200, _premium_status_payload(user))


def _api_premium_checkout(event):
    """Создаёт платёж в Робокассе и возвращает ссылку на оплату.

    GET вместо POST: CDN на публичном домене пропускает только GET/HEAD/OPTIONS.
    """
    user = _current_user(event)
    if not user:
        return auth.json_response(401, {"error": "unauthorized"})
    if not _robokassa_ready():
        return auth.json_response(503, {"error": "payments_not_configured"})

    amount_kopecks = _premium_amount_kopecks()
    amount = f"{amount_kopecks / 100:.2f}"
    days = _premium_days()
    description = f"Премиум-подписка на {days} дней"

    try:
        inv_id = _robokassa_new_inv_id()
        payment_url = _robokassa_payment_url(inv_id, amount, description, user)
    except Exception as exc:  # noqa: BLE001
        print(f"[premium] Robokassa create failed: {exc}")
        return auth.json_response(502, {"error": "payment_provider_failed"})

    try:
        store.create_payment(
            inv_id=str(inv_id),
            user_id=_text(user.get("user_id")),
            yandex_id=_text(user.get("yandex_id")),
            amount_kopecks=amount_kopecks,
            currency="RUB",
            payment_url=payment_url,
            provider="robokassa",
            status="pending",
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[premium] failed to store Robokassa payment {inv_id}: {exc}")
        return auth.json_response(500, {"error": "payment_create_failed"})

    _log_activity(
        user,
        "premium_checkout",
        source="premium",
        entity_type="payment",
        entity_id=str(inv_id),
        metadata={
            "amount_kopecks": amount_kopecks,
            "days": days,
            "provider": "robokassa",
        },
    )
    return auth.json_response(
        200,
        {
            "payment_url": payment_url,
            "payment_id": str(inv_id),
            "provider": "robokassa",
            "amount": _premium_price_text(),
            "currency": "RUB",
            "days": days,
        },
    )


def _api_premium_stars_checkout(event):
    """Счёт Telegram Stars для покупки премиума в мини-аппе."""
    user = _current_user(event)
    if not user:
        return auth.json_response(401, {"error": "unauthorized"})
    if _text(user.get("auth_provider")) != "telegram":
        return auth.json_response(403, {"error": "telegram_only"})
    if not auth.telegram_bot_token():
        return auth.json_response(503, {"error": "telegram_not_configured"})

    stars = _premium_stars_price()
    days = _premium_days()
    inv_id = "stars_" + secrets.token_hex(12)
    payload = f"stars:{_text(user.get('user_id'))}:{inv_id}"
    title = f"Премиум на {days} дней"
    description = "Доступ к премиум-маршрутам в навигаторе"

    try:
        response = auth.telegram_create_invoice_link(
            title, description, payload, stars
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[premium] stars invoice failed: {exc}")
        return auth.json_response(502, {"error": "payment_provider_failed"})

    link = ""
    if isinstance(response, dict) and response.get("ok"):
        link = _text((response.get("result") or "")).strip()
    if not link:
        print(f"[premium] stars invoice bad response: {response}")
        return auth.json_response(502, {"error": "payment_provider_failed"})

    try:
        store.create_payment(
            inv_id=inv_id,
            user_id=_text(user.get("user_id")),
            yandex_id=_text(user.get("yandex_id")),
            amount_kopecks=0,
            currency="XTR",
            payment_url=link,
            provider="telegram_stars",
            status="pending",
            stars=stars,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[premium] stars payment store failed: {exc}")
        return auth.json_response(500, {"error": "payment_create_failed"})

    _log_activity(
        user,
        "premium_checkout",
        source="premium",
        entity_type="payment",
        entity_id=inv_id,
        metadata={"stars": stars, "days": days, "provider": "telegram_stars"},
    )
    return auth.json_response(
        200,
        {
            "invoice_url": link,
            "payment_id": inv_id,
            "provider": "telegram_stars",
            "stars": stars,
            "days": days,
        },
    )


def _api_telegram_webhook(event):
    """Вебхук бота: подтверждение оплаты и зачисление звёзд."""
    secret = _text(os.getenv("TELEGRAM_WEBHOOK_SECRET", "")).strip()
    if secret:
        got = _header(event, "X-Telegram-Bot-Api-Secret-Token").strip()
        if not hmac.compare_digest(got, secret):
            return auth.json_response(401, {"error": "unauthorized"})

    body = _body_json(event)
    if not isinstance(body, dict):
        return auth.json_response(400, {"error": "invalid_json_body"})

    pre_checkout = body.get("pre_checkout_query")
    if isinstance(pre_checkout, dict):
        query_id = _text(pre_checkout.get("id"))
        try:
            auth.telegram_answer_pre_checkout(query_id, True)
        except Exception as exc:  # noqa: BLE001
            print(f"[premium] pre_checkout answer failed: {exc}")
        return auth.json_response(200, {"ok": True})

    message = body.get("message") or {}
    payment = message.get("successful_payment") if isinstance(message, dict) else None
    if not isinstance(payment, dict):
        return auth.json_response(200, {"ok": True})

    charge_id = _text(payment.get("telegram_payment_charge_id")).strip()
    payload = _text(payment.get("invoice_payload")).strip()
    amount = _int(payment.get("total_amount"))

    parts = payload.split(":")
    if len(parts) != 3 or parts[0] != "stars":
        print(f"[premium] unknown stars payload: {payload}")
        return auth.json_response(200, {"ok": True})
    user_id = parts[1]
    inv_id = parts[2]

    record = store.get_payment(inv_id)
    if not record or record.get("provider") != "telegram_stars":
        print(f"[premium] stars payment not found: {inv_id}")
        return auth.json_response(200, {"ok": True})
    if record.get("status") == "succeeded":
        return auth.json_response(200, {"ok": True})
    if amount and record.get("stars") and amount < record["stars"]:
        print(f"[premium] stars amount mismatch {inv_id}: {amount}")
        return auth.json_response(200, {"ok": True})

    try:
        if charge_id:
            store.set_payment_charge(inv_id, charge_id)
        store.mark_payment_succeeded(inv_id)
        until = store.extend_premium_user(user_id, _premium_days())
        print(f"[premium] stars payment {inv_id} paid, premium until {until}")
    except Exception as exc:  # noqa: BLE001
        print(f"[premium] stars apply failed {inv_id}: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})

    user = store.get_user_by_user_id(user_id)
    if user:
        _log_activity(
            user,
            "premium_paid",
            source="premium",
            entity_type="payment",
            entity_id=inv_id,
            metadata={
                "stars": record.get("stars"),
                "charge_id": charge_id,
            },
        )
    return auth.json_response(200, {"ok": True})


def _api_premium_robokassa_result(event):
    """Result URL Робокассы: подтверждение оплаты.

    Робокасса присылает form-urlencoded POST. Подпись проверяем по
    Паролю #2, сумму сверяем с сохранённым платежом, отвечаем «OK<InvId>»,
    иначе Робокасса будет повторять уведомление.
    """
    params = dict(_query(event))
    params.update(_form_body(event))

    out_sum = _text(params.get("OutSum")).strip()
    inv_id = _text(params.get("InvId")).strip()
    signature = _text(params.get("SignatureValue")).strip()
    if not out_sum or not inv_id or not signature:
        return _text_response(400, "ERROR: missing parameters")

    _, _, password2, _ = _robokassa_config()
    if not password2:
        return _text_response(503, "ERROR: not configured")

    expected = _robokassa_signature(out_sum, inv_id, password2)
    if not hmac.compare_digest(expected.lower(), signature.lower()):
        print(f"[premium] Robokassa bad signature for {inv_id}")
        return _text_response(400, "ERROR: bad signature")

    payment = store.get_payment(inv_id)
    if not payment:
        print(f"[premium] Robokassa result for unknown payment {inv_id}")
        return _text_response(404, "ERROR: payment not found")
    if payment.get("provider") not in ("robokassa", ""):
        return _text_response(400, "ERROR: unknown provider")

    try:
        paid_kopecks = int(round(float(out_sum.replace(",", ".")) * 100))
    except (TypeError, ValueError):
        return _text_response(400, "ERROR: bad amount")
    if paid_kopecks < payment["amount_kopecks"]:
        print(
            f"[premium] Robokassa amount mismatch {inv_id}: "
            f"{paid_kopecks} < {payment['amount_kopecks']}"
        )
        return _text_response(400, "ERROR: amount mismatch")

    if payment["status"] != "succeeded":
        try:
            store.mark_payment_succeeded(inv_id)
            until = store.extend_premium(payment["yandex_id"], _premium_days())
            print(f"[premium] Robokassa payment {inv_id} paid, premium until {until}")
            _log_activity(
                {
                    "user_id": payment.get("user_id"),
                    "yandex_id": payment.get("yandex_id"),
                },
                "premium_paid",
                source="premium",
                entity_type="payment",
                entity_id=inv_id,
                metadata={
                    "amount_kopecks": payment.get("amount_kopecks"),
                    "until": until.isoformat()
                    if hasattr(until, "isoformat")
                    else str(until),
                },
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[premium] failed to apply Robokassa payment {inv_id}: {exc}")
            return _text_response(500, "ERROR: storage failed")

    return _text_response(200, f"OK{inv_id}")


def _api_premium_robokassa_success(event):
    """Success URL: возвращаем пользователя в навигатор.

    Робокасса требует, чтобы настроенный URL был без параметров, поэтому
    результат оформляем редиректом на страницу с ?payment=success.
    """
    base = _text(os.getenv("PUBLIC_BASE_URL", "")).rstrip("/") or "https://ainstruktor.ru"
    return auth.redirect_response(f"{base}/navigator.html?payment=success")


def _api_premium_robokassa_fail(event):
    """Fail URL: пользователь отказался или оплата не прошла."""
    params = dict(_query(event))
    params.update(_form_body(event))
    inv_id = _text(params.get("InvId")).strip()
    if inv_id:
        payment = store.get_payment(inv_id)
        if (
            payment
            and payment.get("provider") == "robokassa"
            and payment.get("status") != "succeeded"
        ):
            try:
                store.mark_payment_canceled(inv_id)
            except Exception as exc:  # noqa: BLE001
                print(f"[premium] failed to mark Robokassa {inv_id} canceled: {exc}")

    base = _text(os.getenv("PUBLIC_BASE_URL", "")).rstrip("/") or "https://ainstruktor.ru"
    return auth.redirect_response(f"{base}/navigator.html?payment=fail")


def _api_route_view(event):
    """Отмечает маршрут как загруженный текущим пользователем.

    GET, потому что CDN на публичном домене пропускает только GET.
    """
    user = _current_user(event)
    if not user:
        return auth.json_response(401, {"error": "unauthorized"})

    m_param = _text(_query(event).get("m")).strip()
    if not m_param:
        return auth.json_response(400, {"error": "missing_route_name"})

    meta = store.get_road_meta(m_param)
    if not meta or not meta["visible"]:
        return auth.json_response(404, {"error": "route_not_found"})

    store.record_route_view(_text(user.get("user_id")), m_param)
    _log_activity(
        user,
        "route_open",
        source="navigator",
        entity_type="route",
        route_m=m_param,
        title=_text(meta.get("title")),
    )
    return auth.json_response(200, {"status": "ok", "viewed": True})


def _api_route(event):
    """Геометрия одного видимого маршрута."""
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

        _, _, by_id = _catalog_data()
        row = rows[0]
        data = _json_value(_row_value(row, "json"))
        owner_user_id = _text(_row_value(row, "owner_user_id"))
        folder_id = _text(_row_value(row, "folder_id"))
        if not folder_id or folder_id not in by_id:
            folder_id = _owner_folder_id(owner_user_id)
        payload = _route_public_dict(
            row, by_id, folder_id_override=folder_id, user=user
        )
        if payload["locked"]:
            return auth.json_response(
                403,
                {
                    "error": "premium_locked",
                    "m": payload["m"],
                    "title": payload["title"],
                },
            )
        payload["data"] = data
        return auth.json_response(200, payload)
    except Exception as exc:  # noqa: BLE001
        print(f"[api] route failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})


# ---------------------------------------------------------------------------
# Редактор
# ---------------------------------------------------------------------------


def _admin_list(user):
    owner_user_id = _text(user.get("user_id"))
    folders, route_rows, by_id = _editor_data(owner_user_id)
    return auth.json_response(
        200,
        {
            "routes": [_route_editor_dict(row, by_id) for row in route_rows],
            "folders": folders,
        },
    )


def _admin_get(event, user):
    m_val = _query(event).get("m")
    if not m_val:
        return auth.json_response(400, {"error": "missing_route_name"})
    rows = _rows(
        store.get_pool().retry_operation_sync(
            execute_get_owned_route,
            m_param=m_val,
            owner_user_id=_text(user.get("user_id")),
        )
    )
    if not rows:
        return auth.json_response(404, {"error": "not_found"})
    row = rows[0]
    owner_user_id = _text(user.get("user_id"))
    _, _, by_id = _editor_data(owner_user_id)
    route = _route_editor_dict(row, by_id)
    # Миниатюра в списке тоже запрашивает get — не считаем её открытием.
    if _text(_query(event).get("preview")).strip() not in ("1", "true", "yes"):
        _log_activity(
            user,
            "route_open",
            source="editor",
            entity_type="route",
            route_m=_text(route.get("m")) or m_val,
            title=_text(route.get("title")),
        )
    return auth.json_response(
        200,
        {
            "name": route["name"],
            "title": route["title"],
            "m": _text(_row_value(row, "m")) or m_val,
            "data": _json_value(_row_value(row, "json")),
        },
    )


def _admin_get_meta(event, user):
    m_val = _query(event).get("m")
    if not m_val:
        return auth.json_response(400, {"error": "missing_route_name"})
    owner_user_id = _text(user.get("user_id"))
    folders, route_rows, by_id = _editor_data(owner_user_id)
    for row in route_rows:
        if _text(_row_value(row, "m")) == m_val:
            return auth.json_response(200, _route_editor_dict(row, by_id))
    return auth.json_response(404, {"error": "route_not_found"})


def _admin_save(event, user):
    m_val = _query(event).get("m")
    if not m_val:
        return auth.json_response(400, {"error": "missing_route_name"})
    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})
    owner_user_id = _text(user.get("user_id"))
    owner_rows = _rows(
        store.get_pool().retry_operation_sync(
            execute_get_route_owner, m_param=m_val
        )
    )
    created = not owner_rows
    if owner_rows:
        if _text(_row_value(owner_rows[0], "owner_user_id")) != owner_user_id:
            return auth.json_response(404, {"error": "route_not_found"})
        store.get_pool().retry_operation_sync(
            execute_update_route_data,
            m_param=m_val,
            json_data=body.get("data", []),
            owner_user_id=owner_user_id,
        )
    else:
        store.get_pool().retry_operation_sync(
            execute_create_route,
            m_param=m_val,
            json_data=body.get("data", []),
            owner_user_id=owner_user_id,
        )

    data = body.get("data")
    _log_activity(
        user,
        "route_create" if created else "route_save",
        source="editor",
        entity_type="route",
        route_m=m_val,
        metadata={"points": len(data) if isinstance(data, list) else None},
    )
    return auth.json_response(200, {"status": "saved"})


def _admin_save_meta(event, user):
    m_val = _query(event).get("m")
    if not m_val:
        return auth.json_response(400, {"error": "missing_route_name"})
    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})

    owner_user_id = _text(user.get("user_id"))
    folders, route_rows, by_id = _editor_data(owner_user_id)
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
    premium = bool(body.get("premium", current.get("premium", False)))

    new_m = _text(body.get("new_m")).strip()

    if new_m and new_m != m_val:
        new_m_owner = _rows(
            store.get_pool().retry_operation_sync(
                execute_get_route_owner, m_param=new_m
            )
        )
        if new_m_owner:
            return auth.json_response(409, {"error": "route_id_exists"})
        store.get_pool().retry_operation_sync(
            execute_rename_route,
            old_m_param=m_val,
            new_m_param=new_m,
            folder_id=folder_id,
            title=title,
            description=description,
            visible=bool(visible),
            owner_user_id=owner_user_id,
            premium=premium,
        )
        _log_activity(
            user,
            "route_update",
            source="editor",
            entity_type="route",
            route_m=new_m,
            title=title,
            metadata={
                "old_m": m_val,
                "renamed": True,
                "folder_id": folder_id,
                "visible": bool(visible),
                "premium": premium,
            },
        )
        return auth.json_response(200, {"status": "meta_saved", "new_m": new_m})

    store.get_pool().retry_operation_sync(
        execute_update_route_meta,
        m_param=m_val,
        folder_id=folder_id,
        title=title,
        description=description,
        visible=bool(visible),
        owner_user_id=owner_user_id,
        premium=premium,
    )
    _log_activity(
        user,
        "route_update",
        source="editor",
        entity_type="route",
        route_m=m_val,
        title=title,
        metadata={
            "folder_id": folder_id,
            "folder_changed": folder_id != current["folder_id"],
            "visible": bool(visible),
            "premium": premium,
        },
    )
    return auth.json_response(200, {"status": "meta_saved"})


def _admin_delete(event, user):
    m_val = _query(event).get("m")
    if not m_val:
        return auth.json_response(400, {"error": "missing_route_name"})
    owner_user_id = _text(user.get("user_id"))
    rows = _rows(
        store.get_pool().retry_operation_sync(
            execute_get_owned_route,
            m_param=m_val,
            owner_user_id=owner_user_id,
        )
    )
    if not rows:
        return auth.json_response(404, {"error": "route_not_found"})
    store.get_pool().retry_operation_sync(
        execute_delete_route,
        m_param=m_val,
        owner_user_id=owner_user_id,
    )
    _log_activity(
        user,
        "route_delete",
        source="editor",
        entity_type="route",
        route_m=m_val,
        folder_id=_text(_row_value(rows[0], "folder_id")),
        title=_text(_row_value(rows[0], "title")),
    )
    return auth.json_response(200, {"status": "deleted"})


def _admin_folder_save(event, user):
    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})

    owner_user_id = _text(user.get("user_id"))
    folders, route_rows, by_id = _editor_data(owner_user_id)
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

    created = folder_id not in by_id
    if folder_id in by_id:
        store.get_pool().retry_operation_sync(
            execute_update_folder,
            folder_id=folder_id,
            parent_id=parent_id,
            name=name,
            sort_order=sort_order,
            owner_user_id=owner_user_id,
        )
    else:
        existing_owner = _rows(
            store.get_pool().retry_operation_sync(
                execute_get_folder_owner, folder_id=folder_id
            )
        )
        if existing_owner:
            return auth.json_response(404, {"error": "folder_not_found"})
        store.get_pool().retry_operation_sync(
            execute_create_folder,
            folder_id=folder_id,
            parent_id=parent_id,
            name=name,
            sort_order=sort_order,
            owner_user_id=owner_user_id,
        )

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
    _log_activity(
        user,
        "folder_create" if created else "folder_update",
        source="editor",
        entity_type="folder",
        folder_id=folder_id,
        title=name,
        metadata={"parent_id": parent_id, "sort_order": sort_order},
    )
    return auth.json_response(
        200,
        {
            "status": "folder_saved",
            "folder": new_by_id[folder_id],
        },
    )


def _admin_folder_delete(event, user):
    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})
    folder_id = _text(body.get("folder_id")).strip()
    if not folder_id:
        return auth.json_response(400, {"error": "missing_folder_id"})

    owner_user_id = _text(user.get("user_id"))
    folders, route_rows, _ = _editor_data(owner_user_id)
    if not any(folder["folder_id"] == folder_id for folder in folders):
        return auth.json_response(404, {"error": "folder_not_found"})
    if any(folder["parent_id"] == folder_id for folder in folders):
        return auth.json_response(409, {"error": "folder_has_children"})
    if any(_text(_row_value(row, "folder_id")) == folder_id for row in route_rows):
        return auth.json_response(409, {"error": "folder_has_routes"})

    store.get_pool().retry_operation_sync(
        execute_delete_folder,
        folder_id=folder_id,
        owner_user_id=owner_user_id,
    )
    folder_name = next(
        (folder["name"] for folder in folders if folder["folder_id"] == folder_id),
        "",
    )
    _log_activity(
        user,
        "folder_delete",
        source="editor",
        entity_type="folder",
        folder_id=folder_id,
        title=_text(folder_name),
    )
    return auth.json_response(200, {"status": "folder_deleted"})


def _admin_signs_get(user):
    owner_user_id = _text(user.get("user_id"))
    raw = store.get_owner_signs(owner_user_id)
    data = None
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, str):
                data = json.loads(data)
        except Exception as exc:  # noqa: BLE001
            print(f"[admin] signs get json failed: {exc}")
    if not isinstance(data, dict):
        data = {"version": 1, "camera": None, "markers": []}
    return auth.json_response(200, {"data": data})


def _admin_signs_save(event, user):
    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})
    data = body.get("data") if isinstance(body, dict) and "data" in body else body
    if not isinstance(data, dict):
        return auth.json_response(400, {"error": "invalid_signs_data"})

    markers = data.get("markers")
    if markers is None:
        markers = []
    if not isinstance(markers, list):
        return auth.json_response(400, {"error": "invalid_markers"})
    if len(markers) > 5000:
        return auth.json_response(400, {"error": "too_many_markers"})

    clean_markers = []
    for marker in markers:
        if not isinstance(marker, dict) or marker.get("kind") != "znak":
            continue
        code = _text(marker.get("code")).strip()
        file_name = _text(marker.get("file")).strip()
        if not code or not file_name:
            continue
        try:
            lat = float(marker.get("lat"))
            lon = float(marker.get("lon"))
        except (TypeError, ValueError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        try:
            heading = float(marker.get("heading") or 0)
        except (TypeError, ValueError):
            heading = 0.0
        plates = []
        for plate in marker.get("plates") or []:
            plate_code = _text(plate).strip()
            if plate_code:
                plates.append(plate_code)
        clean_markers.append(
            {
                "kind": "znak",
                "code": code,
                "file": file_name,
                "lat": lat,
                "lon": lon,
                "heading": heading,
                "leg": bool(marker.get("leg")),
                "plates": plates,
            }
        )

    def marker_key(item):
        return (
            _text(item.get("code")),
            round(float(item.get("lat") or 0), 6),
            round(float(item.get("lon") or 0), 6),
        )

    old_keys = set()
    try:
        old_raw = store.get_owner_signs(_text(user.get("user_id")))
        if old_raw:
            old_data = json.loads(old_raw)
            if isinstance(old_data, str):
                old_data = json.loads(old_data)
            if isinstance(old_data, dict):
                for item in old_data.get("markers") or []:
                    if isinstance(item, dict) and item.get("kind") == "znak":
                        old_keys.add(marker_key(item))
    except Exception as exc:  # noqa: BLE001
        print(f"[admin] signs diff failed: {exc}")

    camera = data.get("camera")
    payload_data = {
        "version": 1,
        "savedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "camera": camera if isinstance(camera, dict) else None,
        "markers": clean_markers,
    }
    payload = json.dumps(payload_data, ensure_ascii=False)
    if len(payload.encode("utf-8")) > 2_000_000:
        return auth.json_response(400, {"error": "signs_too_large"})

    try:
        store.save_owner_signs(_text(user.get("user_id")), payload)
    except Exception as exc:  # noqa: BLE001
        print(f"[admin] signs save failed: {exc}")
        return auth.json_response(500, {"error": "storage_failed"})

    new_keys = {marker_key(marker) for marker in clean_markers}
    added_keys = new_keys - old_keys
    removed_keys = old_keys - new_keys
    _log_activity(
        user,
        "signs_save",
        source="editor",
        entity_type="signs",
        metadata={
            "total": len(clean_markers),
            "added": len(added_keys),
            "removed": len(removed_keys),
            "added_codes": sorted({key[0] for key in added_keys})[:20],
            "removed_codes": sorted({key[0] for key in removed_keys})[:20],
        },
    )
    return auth.json_response(
        200, {"ok": True, "savedAt": payload_data["savedAt"], "count": len(clean_markers)}
    )


def _handle_admin(event, user):
    action = _query(event).get("action") or "list"

    try:
        if action == "list":
            return _admin_list(user)
        if action == "get":
            return _admin_get(event, user)
        if action == "get_meta":
            return _admin_get_meta(event, user)
        if action == "save":
            return _admin_save(event, user)
        if action == "save_meta":
            return _admin_save_meta(event, user)
        if action == "delete":
            return _admin_delete(event, user)
        if action == "folder_save":
            return _admin_folder_save(event, user)
        if action == "folder_delete":
            return _admin_folder_delete(event, user)
        if action == "signs_get":
            return _admin_signs_get(user)
        if action == "signs_save":
            return _admin_signs_save(event, user)
        return auth.json_response(400, {"error": "unknown_action"})
    except ValueError as exc:
        return auth.json_response(
            400, {"error": "invalid_parameter_format", "details": str(exc)}
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[admin] {action} failed: {exc}")
        return auth.json_response(500, {"error": "internal_server_error"})


# ---------------------------------------------------------------------------
# Админка
# ---------------------------------------------------------------------------


def _superadmin_ids():
    raw = _text(os.getenv("ADMIN_YANDEX_IDS", ""))
    normalized = raw.replace(",", " ").replace(";", " ")
    return {item.strip() for item in normalized.split() if item.strip()}


def _current_superadmin(event):
    user = _current_user(event)
    if not user:
        return None
    if _text(user.get("yandex_id")) not in _superadmin_ids():
        return None
    return user


def _superadmin_guard(event):
    user = _current_superadmin(event)
    if user:
        return user, None
    if not _current_user(event):
        return None, auth.json_response(401, {"error": "unauthorized"})
    return None, auth.json_response(403, {"error": "forbidden"})


def _date_iso(value):
    if not value:
        return None
    if isinstance(value, (int, float)):
        value = dt.datetime.fromtimestamp(value / 1_000_000, tz=dt.timezone.utc)
    if isinstance(value, dt.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=dt.timezone.utc)
        return value.astimezone(dt.timezone.utc).isoformat()
    return None


def _superadmin_user_dict(user):
    return {
        "yandex_id": _text(user.get("yandex_id")),
        "user_id": _text(user.get("user_id")),
        "login": _text(user.get("login")),
        "email": _text(user.get("email")),
        "display_name": _text(user.get("display_name")),
        "routes_folder_name": _text(user.get("routes_folder_name")),
        "created_at": _date_iso(user.get("created_at")),
        "last_login_at": _date_iso(user.get("last_login_at")),
        "blocked": bool(user.get("blocked")),
        "premium_until": _date_iso(_premium_until(user)),
        "premium_active": _premium_active(user),
    }


def _api_superadmin_users(event):
    admin, error = _superadmin_guard(event)
    if error:
        return error

    query = _text(_query(event).get("q")).strip().lower()
    try:
        limit = max(1, min(int(_query(event).get("limit") or 100), 200))
        offset = max(0, int(_query(event).get("offset") or 0))
    except (TypeError, ValueError):
        return auth.json_response(400, {"error": "invalid_pagination"})

    users = store.list_users()
    if query:
        def matches(user):
            fields = (
                user.get("yandex_id"), user.get("user_id"), user.get("login"),
                user.get("email"), user.get("display_name"),
            )
            return any(query in _text(field).lower() for field in fields)

        users = [user for user in users if matches(user)]

    total = len(users)
    page = users[offset:offset + limit]
    return auth.json_response(
        200,
        {
            "users": [_superadmin_user_dict(user) for user in page],
            "total": total,
            "limit": limit,
            "offset": offset,
        },
    )


def _api_superadmin_user(event):
    admin, error = _superadmin_guard(event)
    if error:
        return error

    user_id = _text(_query(event).get("user_id")).strip()
    if not user_id:
        return auth.json_response(400, {"error": "missing_user_id"})
    user = store.get_user_by_user_id(user_id)
    if not user:
        return auth.json_response(404, {"error": "user_not_found"})

    payments = []
    for payment in store.payments_for_user(user_id):
        payments.append(
            {
                "inv_id": payment.get("inv_id"),
                "amount_kopecks": payment.get("amount_kopecks"),
                "currency": payment.get("currency"),
                "status": payment.get("status"),
                "provider": payment.get("provider"),
                "created_at": _date_iso(payment.get("created_at")),
                "paid_at": _date_iso(payment.get("paid_at")),
            }
        )

    sessions = []
    for session in store.sessions_for_user(_text(user.get("yandex_id"))):
        sessions.append(
            {
                "created_at": _date_iso(session.get("created_at")),
                "expires_at": _date_iso(session.get("expires_at")),
                "last_seen_at": _date_iso(session.get("last_seen_at")),
                "user_agent": session.get("user_agent"),
                "ip": session.get("ip"),
            }
        )

    roads, folders = store.owned_counts(user_id)
    views = []
    roads_meta = store.list_roads_meta()
    for m_param, view in store.route_views_for_user(user_id).items():
        meta = roads_meta.get(m_param) or {}
        views.append(
            {
                "m": m_param,
                "title": meta.get("title") or "",
                "premium": bool(meta.get("premium")),
                "visible": bool(meta.get("visible")),
                "deleted": not meta,
                "first_viewed_at": _date_iso(view.get("first_viewed_at")),
                "last_viewed_at": _date_iso(view.get("last_viewed_at")),
                "view_count": view.get("view_count") or 0,
            }
        )
    views.sort(key=lambda item: item.get("last_viewed_at") or "", reverse=True)

    return auth.json_response(
        200,
        {
            "user": _superadmin_user_dict(user),
            "payments": payments,
            "sessions": sessions,
            "routes": roads,
            "folders": folders,
            "views": views,
        },
    )


def _api_superadmin_premium(event):
    admin, error = _superadmin_guard(event)
    if error:
        return error
    if not auth.origin_allowed(event):
        return auth.json_response(403, {"error": "forbidden_origin"})

    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})

    yandex_id = _text(body.get("yandex_id")).strip()
    if not yandex_id:
        return auth.json_response(400, {"error": "missing_yandex_id"})
    user = store.get_user_by_yandex_id(yandex_id)
    if not user:
        return auth.json_response(404, {"error": "user_not_found"})

    revoke = bool(body.get("revoke"))
    until_raw = _text(body.get("until")).strip()
    try:
        days = int(body.get("days") or 0)
    except (TypeError, ValueError):
        return auth.json_response(400, {"error": "invalid_days"})

    if revoke or days <= 0 and not until_raw:
        until = None
    elif until_raw:
        try:
            until = dt.datetime.fromisoformat(until_raw.replace("Z", "+00:00"))
        except ValueError:
            return auth.json_response(400, {"error": "invalid_until"})
        if until.tzinfo is None:
            until = until.replace(tzinfo=dt.timezone.utc)
    else:
        if days > 3650:
            return auth.json_response(400, {"error": "days_too_large"})
        base = max(store.now(), _premium_until(user) or store.now())
        until = base + dt.timedelta(days=days)

    updated = store.set_premium_until(yandex_id, until)
    store.add_admin_audit(
        _text(admin.get("yandex_id")),
        "premium",
        _text(user.get("user_id")),
        yandex_id,
        json.dumps(
            {
                "until": until.isoformat() if until else None,
                "days": days,
            },
            ensure_ascii=False,
        ),
    )
    _log_activity(
        admin,
        "admin_premium",
        source="admin",
        entity_type="user",
        entity_id=_text(user.get("user_id")),
        title=_text(user.get("login")) or yandex_id,
        metadata={
            "target_yandex_id": yandex_id,
            "until": until.isoformat() if until else None,
            "days": days,
        },
    )
    return auth.json_response(
        200, {"user": _superadmin_user_dict(updated or user)}
    )


def _api_superadmin_block(event):
    admin, error = _superadmin_guard(event)
    if error:
        return error
    if not auth.origin_allowed(event):
        return auth.json_response(403, {"error": "forbidden_origin"})

    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})
    yandex_id = _text(body.get("yandex_id")).strip()
    if not yandex_id:
        return auth.json_response(400, {"error": "missing_yandex_id"})
    user = store.get_user_by_yandex_id(yandex_id)
    if not user:
        return auth.json_response(404, {"error": "user_not_found"})

    blocked = bool(body.get("blocked"))
    updated = store.set_blocked(yandex_id, blocked)
    if blocked:
        store.delete_user_sessions(yandex_id)

    store.add_admin_audit(
        _text(admin.get("yandex_id")),
        "block",
        _text(user.get("user_id")),
        yandex_id,
        json.dumps({"blocked": blocked}, ensure_ascii=False),
    )
    _log_activity(
        admin,
        "admin_block",
        source="admin",
        entity_type="user",
        entity_id=_text(user.get("user_id")),
        title=_text(user.get("login")) or yandex_id,
        metadata={"target_yandex_id": yandex_id, "blocked": blocked},
    )
    return auth.json_response(
        200, {"user": _superadmin_user_dict(updated or user)}
    )


def _api_superadmin_sessions_revoke(event):
    admin, error = _superadmin_guard(event)
    if error:
        return error
    if not auth.origin_allowed(event):
        return auth.json_response(403, {"error": "forbidden_origin"})

    body = _body_json(event)
    if body is None:
        return auth.json_response(400, {"error": "invalid_json_body"})
    yandex_id = _text(body.get("yandex_id")).strip()
    if not yandex_id:
        return auth.json_response(400, {"error": "missing_yandex_id"})
    user = store.get_user_by_yandex_id(yandex_id)
    if not user:
        return auth.json_response(404, {"error": "user_not_found"})

    store.delete_user_sessions(yandex_id)
    store.add_admin_audit(
        _text(admin.get("yandex_id")),
        "sessions_revoke",
        _text(user.get("user_id")),
        yandex_id,
        "",
    )
    _log_activity(
        admin,
        "admin_sessions_revoke",
        source="admin",
        entity_type="user",
        entity_id=_text(user.get("user_id")),
        title=_text(user.get("login")) or yandex_id,
        metadata={"target_yandex_id": yandex_id},
    )
    return auth.json_response(200, {"status": "ok"})


def _api_superadmin_audit(event):
    admin, error = _superadmin_guard(event)
    if error:
        return error
    try:
        limit = max(1, min(int(_query(event).get("limit") or 100), 500))
    except (TypeError, ValueError):
        return auth.json_response(400, {"error": "invalid_limit"})
    items = store.list_admin_audit(limit)
    for item in items:
        item["created_at"] = _date_iso(item.get("created_at"))
    return auth.json_response(200, {"items": items})


def _parse_timestamp(raw):
    value = _text(raw).strip()
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed


def _activity_folder_paths(items):
    """Дополняет события названием маршрута и путём папок до объекта.

    Название берётся из текущих данных маршрута, если в событии его нет
    (например, при сохранении геометрии приходит только `m`). Путь собирается
    из текущих папок; у удалённого маршрута остаётся `folder_id` из события.
    """
    route_ms = [
        _text(item.get("route_m")).strip()
        for item in items
        if _text(item.get("route_m")).strip()
    ]
    roads = store.roads_meta_for(route_ms) if route_ms else {}
    folder_rows = _rows(
        store.get_pool().retry_operation_sync(execute_list_folders)
    )
    by_id = {
        _text(_row_value(row, "folder_id")): _folder_dict(row)
        for row in folder_rows
    }

    for item in items:
        route_meta = roads.get(_text(item.get("route_m")).strip()) or {}
        if not _text(item.get("title")).strip():
            item["title"] = _text(route_meta.get("title"))
        metadata = item.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        folder_id = (
            _text(route_meta.get("folder_id"))
            or _text(item.get("folder_id"))
            or _text(metadata.get("folder_id"))
        )
        chain = _folder_chain(by_id, folder_id)
        if item.get("entity_type") == "folder" and chain:
            chain = chain[:-1]
        item["folder_path"] = " / ".join(
            folder["name"] for folder in chain if folder.get("name")
        )


def _api_superadmin_activity(event):
    """Лента значимых действий. Только для админов из ADMIN_YANDEX_IDS."""
    admin, error = _superadmin_guard(event)
    if error:
        return error

    params = _query(event)
    try:
        limit = max(1, min(int(params.get("limit") or 100), 500))
    except (TypeError, ValueError):
        return auth.json_response(400, {"error": "invalid_limit"})

    before_raw = _text(params.get("before")).strip()
    before = _parse_timestamp(before_raw)
    if before_raw and before is None:
        return auth.json_response(400, {"error": "invalid_before"})

    items = store.list_activity(
        limit=limit,
        before=before,
        action=_text(params.get("action")).strip(),
        source=_text(params.get("source")).strip(),
        user_id=_text(params.get("user_id")).strip(),
    )
    try:
        _activity_folder_paths(items)
    except Exception as exc:  # noqa: BLE001
        print(f"[activity] folder paths failed: {exc}")
    for item in items:
        item["created_at"] = _date_iso(item.get("created_at"))
    return auth.json_response(200, {"items": items, "limit": limit})


# ---------------------------------------------------------------------------
# Маршрутизация
# ---------------------------------------------------------------------------


def _handle_api(event, path, method):
    normalized = path.rstrip("/") or "/"

    if normalized == "/api/health" and method == "GET":
        return auth.json_response(200, {"status": "ok"})

    if normalized == "/api/me" and method == "GET":
        return _api_me(event)

    if normalized == "/api/profile":
        if method != "POST":
            return auth.json_response(405, {"error": "method_not_allowed"})
        return _api_profile_update(event)

    if normalized == "/api/owners" and method == "GET":
        return _api_owners(event)

    if normalized == "/api/catalog" and method == "GET":
        return _api_catalog(event)

    if normalized == "/api/signs" and method == "GET":
        return _api_signs(event)

    if normalized == "/api/route/view" and method == "GET":
        return _api_route_view(event)

    if normalized == "/api/route" and method == "GET":
        return _api_route(event)

    if normalized == "/api/superadmin/users" and method == "GET":
        return _api_superadmin_users(event)

    if normalized == "/api/superadmin/user" and method == "GET":
        return _api_superadmin_user(event)

    if normalized == "/api/superadmin/premium" and method == "POST":
        return _api_superadmin_premium(event)

    if normalized == "/api/superadmin/block" and method == "POST":
        return _api_superadmin_block(event)

    if normalized == "/api/superadmin/sessions/revoke" and method == "POST":
        return _api_superadmin_sessions_revoke(event)

    if normalized == "/api/superadmin/audit" and method == "GET":
        return _api_superadmin_audit(event)

    if normalized == "/api/superadmin/activity" and method == "GET":
        return _api_superadmin_activity(event)

    if normalized == "/api/premium/status" and method == "GET":
        return _api_premium_status(event)

    if normalized == "/api/premium/stars/checkout" and method in ("GET", "POST"):
        return _api_premium_stars_checkout(event)

    if normalized == "/api/telegram/webhook" and method == "POST":
        return _api_telegram_webhook(event)

    if normalized == "/api/premium/checkout" and method in ("GET", "POST"):
        return _api_premium_checkout(event)

    if normalized == "/api/premium/robokassa/result" and method in ("GET", "POST"):
        return _api_premium_robokassa_result(event)

    if normalized == "/api/premium/robokassa/success" and method in ("GET", "POST"):
        return _api_premium_robokassa_success(event)

    if normalized == "/api/premium/robokassa/fail" and method in ("GET", "POST"):
        return _api_premium_robokassa_fail(event)

    if normalized == "/api/admin":
        if method != "POST":
            return auth.json_response(405, {"error": "method_not_allowed"})
        if not auth.origin_allowed(event):
            return auth.json_response(403, {"error": "forbidden_origin"})
        user = _current_user(event)
        if not user:
            return auth.json_response(401, {"error": "unauthorized"})
        return _handle_admin(event, user)

    if normalized == "/auth/yandex/start" and method == "GET":
        return _auth_start(event)

    if normalized == "/auth/telegram" and method in ("GET", "POST"):
        return _auth_telegram(event)

    if normalized == "/auth/yandex/callback" and method == "GET":
        return _auth_callback(event)

    if normalized == "/auth/logout" and method in ("GET", "POST"):
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
