"""Пользователи и сессии в YDB.

Отдельный модуль, чтобы handler.py не смешивал маршруты, OAuth и SQL.
Все запросы точечные: users — по yandex_id (первичный ключ), sessions — по
sid_hash (первичный ключ). В базе хранится только SHA-256 от sid.
"""

import datetime as dt
import hashlib
import os
import secrets
import uuid

import ydb
import ydb.iam

_pool = None


def get_pool():
    global _pool
    if _pool is None:
        endpoint = os.getenv("YDB_ENDPOINT")
        database = os.getenv("YDB_DATABASE")
        if not endpoint or not database:
            raise RuntimeError("YDB_ENDPOINT and YDB_DATABASE are not configured")
        token = os.getenv("YDB_TOKEN")
        credentials = (
            ydb.AuthTokenCredentials(token)
            if token
            else ydb.iam.MetadataUrlCredentials()
        )
        driver_config = ydb.DriverConfig(
            endpoint,
            database,
            credentials=credentials,
        )
        driver = ydb.Driver(driver_config)
        driver.wait(timeout=10)
        _pool = ydb.SessionPool(driver)
    return _pool


def _now():
    return dt.datetime.now(dt.timezone.utc)


def now():
    """Текущее время UTC для записей в YDB."""
    return _now()


def _as_utc(value):
    if value is None:
        return None
    # YDB возвращает Timestamp как int — микросекунды с Unix epoch.
    if isinstance(value, (int, float)):
        return dt.datetime.fromtimestamp(value / 1_000_000, tz=dt.timezone.utc)
    if isinstance(value, dt.datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=dt.timezone.utc)
        return value.astimezone(dt.timezone.utc)
    return None


def _text(value):
    return value if isinstance(value, str) else ("" if value is None else str(value))


def _ttl_days():
    try:
        value = int(os.getenv("SESSION_TTL_DAYS", "30"))
    except (TypeError, ValueError):
        value = 30
    return max(1, min(value, 365))


def _user_dict(row):
    return {
        "yandex_id": _text(row.yandex_id),
        "user_id": _text(row.user_id),
        "login": _text(row.login),
        "email": _text(row.email),
        "display_name": _text(row.display_name),
        "routes_folder_name": _text(getattr(row, "routes_folder_name", "")),
        "created_at": row.created_at,
        "last_login_at": row.last_login_at,
        "blocked": bool(row.blocked) if row.blocked is not None else False,
        "premium_until": _as_utc(getattr(row, "premium_until", None)),
    }


def get_user_by_yandex_id(yandex_id):
    query = """
        DECLARE $yandex_id AS Utf8;
        SELECT yandex_id, user_id, login, email, display_name,
               routes_folder_name, created_at, last_login_at, blocked,
               premium_until
        FROM users
        WHERE yandex_id = $yandex_id;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$yandex_id": str(yandex_id)}, commit_tx=True
        )

    result = get_pool().retry_operation_sync(operation)
    rows = result[0].rows
    if not rows:
        return None
    return _user_dict(rows[0])


def upsert_user(yandex_id, login, email, display_name):
    """Создаёт пользователя или обновляет его профиль и last_login_at."""
    yandex_id = str(yandex_id)
    existing = get_user_by_yandex_id(yandex_id)
    now = _now()

    if existing is None:
        user_id = uuid.uuid4().hex
        query = """
            DECLARE $yandex_id AS Utf8;
            DECLARE $user_id AS Utf8;
            DECLARE $login AS Utf8;
            DECLARE $email AS Utf8;
            DECLARE $display_name AS Utf8;
            DECLARE $now AS Timestamp;

            INSERT INTO users
                (yandex_id, user_id, login, email, display_name,
                 created_at, last_login_at, blocked)
            VALUES
                ($yandex_id, $user_id, $login, $email, $display_name,
                 $now, $now, false);
        """

        def insert(session):
            prepared = session.prepare(query)
            return session.transaction().execute(
                prepared,
                {
                    "$yandex_id": yandex_id,
                    "$user_id": user_id,
                    "$login": str(login or ""),
                    "$email": str(email or ""),
                    "$display_name": str(display_name or ""),
                    "$now": now,
                },
                commit_tx=True,
            )

        get_pool().retry_operation_sync(insert)
        return {
            "yandex_id": yandex_id,
            "user_id": user_id,
            "login": str(login or ""),
            "email": str(email or ""),
            "display_name": str(display_name or ""),
            "created_at": now,
            "last_login_at": now,
            "blocked": False,
            "premium_until": None,
        }

    query = """
        DECLARE $yandex_id AS Utf8;
        DECLARE $login AS Utf8;
        DECLARE $email AS Utf8;
        DECLARE $display_name AS Utf8;
        DECLARE $now AS Timestamp;

        UPDATE users
        SET login = $login,
            email = $email,
            display_name = CASE WHEN display_name IS NULL OR display_name = '' THEN $display_name ELSE display_name END,
            last_login_at = $now
        WHERE yandex_id = $yandex_id;
    """

    def update(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared,
            {
                "$yandex_id": yandex_id,
                "$login": str(login or ""),
                "$email": str(email or ""),
                "$display_name": str(display_name or ""),
                "$now": now,
            },
            commit_tx=True,
        )

    get_pool().retry_operation_sync(update)
    existing.update(
        {
            "login": str(login or ""),
            "email": str(email or ""),
            "display_name": str(display_name or ""),
            "last_login_at": now,
        }
    )
    return existing


def update_routes_folder_name(yandex_id, folder_name):
    """Меняет название корневой папки с маршрутами, не трогая имя аккаунта."""
    query = """
        DECLARE $yandex_id AS Utf8;
        DECLARE $folder_name AS Utf8;
        UPDATE users
        SET routes_folder_name = $folder_name
        WHERE yandex_id = $yandex_id;
    """

    def update(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared,
            {
                "$yandex_id": str(yandex_id),
                "$folder_name": str(folder_name or ""),
            },
            commit_tx=True,
        )

    get_pool().retry_operation_sync(update)
    return get_user_by_yandex_id(yandex_id)


def create_session(yandex_id, user_id, user_agent="", ip=""):
    """Создаёт непрозрачную сессию и возвращает sid для cookie."""
    sid = secrets.token_urlsafe(32)
    sid_hash = hashlib.sha256(sid.encode("ascii")).hexdigest()
    now = _now()
    expires_at = now + dt.timedelta(days=_ttl_days())

    query = """
        DECLARE $sid_hash AS Utf8;
        DECLARE $yandex_id AS Utf8;
        DECLARE $user_id AS Utf8;
        DECLARE $now AS Timestamp;
        DECLARE $expires_at AS Timestamp;
        DECLARE $user_agent AS Utf8;
        DECLARE $ip AS Utf8;

        INSERT INTO sessions
            (sid_hash, yandex_id, user_id, created_at, expires_at,
             last_seen_at, user_agent, ip)
        VALUES
            ($sid_hash, $yandex_id, $user_id, $now, $expires_at,
             $now, $user_agent, $ip);
    """

    def insert(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared,
            {
                "$sid_hash": sid_hash,
                "$yandex_id": str(yandex_id),
                "$user_id": str(user_id),
                "$now": now,
                "$expires_at": expires_at,
                "$user_agent": str(user_agent or "")[:500],
                "$ip": str(ip or "")[:100],
            },
            commit_tx=True,
        )

    get_pool().retry_operation_sync(insert)
    return sid


def get_session(sid):
    """Возвращает данные сессии или None, если её нет или она истекла."""
    if not sid:
        return None
    sid_hash = hashlib.sha256(sid.encode("ascii", "ignore")).hexdigest()
    query = """
        DECLARE $sid_hash AS Utf8;
        SELECT sid_hash, yandex_id, user_id, expires_at, last_seen_at
        FROM sessions
        WHERE sid_hash = $sid_hash;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$sid_hash": sid_hash}, commit_tx=True
        )

    result = get_pool().retry_operation_sync(operation)
    rows = result[0].rows
    if not rows:
        return None

    row = rows[0]
    expires_at = _as_utc(row.expires_at)
    if expires_at is None or expires_at <= _now():
        delete_session(sid)
        return None

    return {
        "sid_hash": sid_hash,
        "yandex_id": _text(row.yandex_id),
        "user_id": _text(row.user_id),
        "expires_at": expires_at,
        "last_seen_at": _as_utc(row.last_seen_at),
    }


def touch_session(sid_hash, last_seen_at=None):
    """Обновляет last_seen_at не чаще раза в час, чтобы не писать на каждый запрос."""
    if not sid_hash:
        return
    now = _now()
    seen = _as_utc(last_seen_at)
    if seen is not None and (now - seen).total_seconds() < 3600:
        return

    query = """
        DECLARE $sid_hash AS Utf8;
        DECLARE $now AS Timestamp;
        UPDATE sessions SET last_seen_at = $now WHERE sid_hash = $sid_hash;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$sid_hash": sid_hash, "$now": now}, commit_tx=True
        )

    try:
        get_pool().retry_operation_sync(operation)
    except Exception as exc:  # noqa: BLE001
        # Обновление last_seen_at не должно ломать /api/me.
        print(f"[store] touch_session failed: {exc}")


def delete_session(sid):
    if not sid:
        return
    sid_hash = hashlib.sha256(sid.encode("ascii", "ignore")).hexdigest()
    query = """
        DECLARE $sid_hash AS Utf8;
        DELETE FROM sessions WHERE sid_hash = $sid_hash;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$sid_hash": sid_hash}, commit_tx=True
        )

    get_pool().retry_operation_sync(operation)


def delete_user_sessions(yandex_id):
    """Выход на всех устройствах. Пока не используется в UI."""
    query = """
        DECLARE $yandex_id AS Utf8;
        DELETE FROM sessions WHERE yandex_id = $yandex_id;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$yandex_id": str(yandex_id)}, commit_tx=True
        )

    get_pool().retry_operation_sync(operation)


# ---------------------------------------------------------------------------
# Премиум-подписка и платежи
# ---------------------------------------------------------------------------


def extend_premium(yandex_id, days):
    """Продлевает премиум на days дней от максимума(сейчас, текущий срок)."""
    user = get_user_by_yandex_id(yandex_id)
    if not user:
        return None
    now = _now()
    current = _as_utc(user.get("premium_until"))
    base = current if current and current > now else now
    premium_until = base + dt.timedelta(days=max(1, int(days)))

    query = """
        DECLARE $yandex_id AS Utf8;
        DECLARE $premium_until AS Timestamp;

        UPDATE users
        SET premium_until = $premium_until
        WHERE yandex_id = $yandex_id;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared,
            {
                "$yandex_id": str(yandex_id),
                "$premium_until": premium_until,
            },
            commit_tx=True,
        )

    get_pool().retry_operation_sync(operation)
    return premium_until


def _payment_dict(row):
    return {
        "inv_id": _text(getattr(row, "inv_id", "")),
        "user_id": _text(getattr(row, "user_id", "")),
        "yandex_id": _text(getattr(row, "yandex_id", "")),
        "amount_kopecks": int(getattr(row, "amount_kopecks", 0) or 0),
        "currency": _text(getattr(row, "currency", "RUB")),
        "status": _text(getattr(row, "status", "")),
        "provider": _text(getattr(row, "provider", "robokassa")),
        "payment_url": _text(getattr(row, "payment_url", "")),
        "created_at": _as_utc(getattr(row, "created_at", None)),
        "paid_at": _as_utc(getattr(row, "paid_at", None)),
    }


def create_payment(inv_id, user_id, yandex_id, amount_kopecks, currency,
                   payment_url, provider="robokassa", status="pending"):
    now = _now()
    query = """
        DECLARE $inv_id AS Utf8;
        DECLARE $user_id AS Utf8;
        DECLARE $yandex_id AS Utf8;
        DECLARE $amount_kopecks AS Uint64;
        DECLARE $currency AS Utf8;
        DECLARE $status AS Utf8;
        DECLARE $provider AS Utf8;
        DECLARE $payment_url AS Utf8;
        DECLARE $created_at AS Timestamp;

        INSERT INTO payments
            (inv_id, user_id, yandex_id, amount_kopecks, currency,
             status, provider, payment_url, created_at)
        VALUES
            ($inv_id, $user_id, $yandex_id, $amount_kopecks, $currency,
             $status, $provider, $payment_url, $created_at);
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared,
            {
                "$inv_id": str(inv_id),
                "$user_id": str(user_id),
                "$yandex_id": str(yandex_id),
                "$amount_kopecks": int(amount_kopecks),
                "$currency": str(currency),
                "$status": str(status),
                "$provider": str(provider),
                "$payment_url": str(payment_url),
                "$created_at": now,
            },
            commit_tx=True,
        )

    get_pool().retry_operation_sync(operation)
    return {
        "inv_id": str(inv_id),
        "user_id": str(user_id),
        "yandex_id": str(yandex_id),
        "amount_kopecks": int(amount_kopecks),
        "currency": str(currency),
        "status": str(status),
        "provider": str(provider),
        "payment_url": str(payment_url),
        "created_at": now,
        "paid_at": None,
    }


def get_payment(inv_id):
    query = """
        DECLARE $inv_id AS Utf8;
        SELECT inv_id, user_id, yandex_id, amount_kopecks, currency,
               status, provider, payment_url, created_at, paid_at
        FROM payments
        WHERE inv_id = $inv_id;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$inv_id": str(inv_id)}, commit_tx=True
        )

    result = get_pool().retry_operation_sync(operation)
    rows = result[0].rows
    if not rows:
        return None
    return _payment_dict(rows[0])


def mark_payment_succeeded(inv_id, paid_at=None):
    paid_at = paid_at or _now()
    query = """
        DECLARE $inv_id AS Utf8;
        DECLARE $status AS Utf8;
        DECLARE $paid_at AS Timestamp;

        UPDATE payments
        SET status = $status, paid_at = $paid_at
        WHERE inv_id = $inv_id;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared,
            {
                "$inv_id": str(inv_id),
                "$status": "succeeded",
                "$paid_at": paid_at,
            },
            commit_tx=True,
        )

    get_pool().retry_operation_sync(operation)
    return paid_at


def mark_payment_canceled(inv_id):
    query = """
        DECLARE $inv_id AS Utf8;
        DECLARE $status AS Utf8;
        UPDATE payments SET status = $status WHERE inv_id = $inv_id;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared,
            {"$inv_id": str(inv_id), "$status": "canceled"},
            commit_tx=True,
        )

    get_pool().retry_operation_sync(operation)


def latest_payment_for_user(user_id):
    query = """
        DECLARE $user_id AS Utf8;
        SELECT inv_id, user_id, yandex_id, amount_kopecks, currency,
               status, provider, payment_url, created_at, paid_at
        FROM payments
        WHERE user_id = $user_id
        ORDER BY created_at DESC
        LIMIT 1;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$user_id": str(user_id)}, commit_tx=True
        )

    result = get_pool().retry_operation_sync(operation)
    rows = result[0].rows
    if not rows:
        return None
    return _payment_dict(rows[0])


# ---------------------------------------------------------------------------
# Админка: чтение пользователей, платежи, сессии, аудит
# ---------------------------------------------------------------------------


def list_users():
    query = """
        SELECT yandex_id, user_id, login, email, display_name,
               routes_folder_name, created_at, last_login_at, blocked,
               premium_until
        FROM users;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(prepared, {}, commit_tx=True)

    rows = get_pool().retry_operation_sync(operation)[0].rows
    users = [_user_dict(row) for row in rows]
    users.sort(key=lambda item: item.get("created_at") or _now(), reverse=True)
    return users


def get_user_by_user_id(user_id):
    query = """
        DECLARE $user_id AS Utf8;
        SELECT yandex_id, user_id, login, email, display_name,
               routes_folder_name, created_at, last_login_at, blocked,
               premium_until
        FROM users
        WHERE user_id = $user_id;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$user_id": str(user_id)}, commit_tx=True
        )

    rows = get_pool().retry_operation_sync(operation)[0].rows
    return _user_dict(rows[0]) if rows else None


def payments_for_user(user_id, limit=100):
    query = """
        DECLARE $user_id AS Utf8;
        DECLARE $limit AS Uint64;
        SELECT inv_id, user_id, yandex_id, amount_kopecks, currency,
               status, provider, payment_url, created_at, paid_at
        FROM payments
        WHERE user_id = $user_id
        ORDER BY created_at DESC
        LIMIT $limit;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared,
            {"$user_id": str(user_id), "$limit": int(limit)},
            commit_tx=True,
        )

    rows = get_pool().retry_operation_sync(operation)[0].rows
    return [_payment_dict(row) for row in rows]


def sessions_for_user(yandex_id):
    query = """
        DECLARE $yandex_id AS Utf8;
        SELECT sid_hash, yandex_id, user_id, created_at, expires_at,
               last_seen_at, user_agent, ip
        FROM sessions
        WHERE yandex_id = $yandex_id;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$yandex_id": str(yandex_id)}, commit_tx=True
        )

    result = get_pool().retry_operation_sync(operation)[0].rows
    items = []
    for row in result:
        items.append(
            {
                "sid_hash": _text(getattr(row, "sid_hash", "")),
                "yandex_id": _text(getattr(row, "yandex_id", "")),
                "user_id": _text(getattr(row, "user_id", "")),
                "created_at": _as_utc(getattr(row, "created_at", None)),
                "expires_at": _as_utc(getattr(row, "expires_at", None)),
                "last_seen_at": _as_utc(getattr(row, "last_seen_at", None)),
                "user_agent": _text(getattr(row, "user_agent", "")),
                "ip": _text(getattr(row, "ip", "")),
            }
        )
    items.sort(key=lambda item: item.get("last_seen_at") or _now(), reverse=True)
    return items


def set_premium_until(yandex_id, until):
    """until — datetime или None, чтобы снять премиум."""
    query = """
        DECLARE $yandex_id AS Utf8;
        DECLARE $premium_until AS Timestamp?;
        UPDATE users
        SET premium_until = $premium_until
        WHERE yandex_id = $yandex_id;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared,
            {"$yandex_id": str(yandex_id), "$premium_until": until},
            commit_tx=True,
        )

    get_pool().retry_operation_sync(operation)
    return get_user_by_yandex_id(yandex_id)


def set_blocked(yandex_id, blocked):
    query = """
        DECLARE $yandex_id AS Utf8;
        DECLARE $blocked AS Bool;
        UPDATE users SET blocked = $blocked WHERE yandex_id = $yandex_id;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared,
            {"$yandex_id": str(yandex_id), "$blocked": bool(blocked)},
            commit_tx=True,
        )

    get_pool().retry_operation_sync(operation)
    return get_user_by_yandex_id(yandex_id)


def add_admin_audit(admin_yandex_id, action, target_user_id, target_yandex_id,
                    payload=""):
    query = """
        DECLARE $id AS Utf8;
        DECLARE $admin_yandex_id AS Utf8;
        DECLARE $action AS Utf8;
        DECLARE $target_user_id AS Utf8;
        DECLARE $target_yandex_id AS Utf8;
        DECLARE $payload AS Utf8;
        DECLARE $created_at AS Timestamp;

        INSERT INTO admin_audit
            (id, admin_yandex_id, action, target_user_id, target_yandex_id,
             payload, created_at)
        VALUES
            ($id, $admin_yandex_id, $action, $target_user_id, $target_yandex_id,
             $payload, $created_at);
    """
    now = _now()
    audit_id = uuid.uuid4().hex

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared,
            {
                "$id": audit_id,
                "$admin_yandex_id": str(admin_yandex_id),
                "$action": str(action),
                "$target_user_id": str(target_user_id),
                "$target_yandex_id": str(target_yandex_id),
                "$payload": str(payload or ""),
                "$created_at": now,
            },
            commit_tx=True,
        )

    get_pool().retry_operation_sync(operation)
    return audit_id


def list_admin_audit(limit=200):
    query = """
        SELECT id, admin_yandex_id, action, target_user_id, target_yandex_id,
               payload, created_at
        FROM admin_audit;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(prepared, {}, commit_tx=True)

    rows = get_pool().retry_operation_sync(operation)[0].rows
    items = []
    for row in rows:
        items.append(
            {
                "id": _text(getattr(row, "id", "")),
                "admin_yandex_id": _text(getattr(row, "admin_yandex_id", "")),
                "action": _text(getattr(row, "action", "")),
                "target_user_id": _text(getattr(row, "target_user_id", "")),
                "target_yandex_id": _text(getattr(row, "target_yandex_id", "")),
                "payload": _text(getattr(row, "payload", "")),
                "created_at": _as_utc(getattr(row, "created_at", None)),
            }
        )
    items.sort(key=lambda item: item.get("created_at") or _now(), reverse=True)
    return items[: int(limit)]


def owned_counts(user_id):
    """Количество маршрутов и папок, принадлежащих пользователю."""
    roads_query = """
        DECLARE $user_id AS Utf8;
        SELECT m FROM roads WHERE owner_user_id = $user_id;
    """
    folders_query = """
        DECLARE $user_id AS Utf8;
        SELECT folder_id FROM folders WHERE owner_user_id = $user_id;
    """

    def count(query):
        def operation(session):
            prepared = session.prepare(query)
            return session.transaction().execute(
                prepared, {"$user_id": str(user_id)}, commit_tx=True
            )

        return len(get_pool().retry_operation_sync(operation)[0].rows)

    return count(roads_query), count(folders_query)


# ---------------------------------------------------------------------------
# История загрузок маршрутов
# ---------------------------------------------------------------------------


def record_route_view(user_id, m_param):
    """Отмечает загрузку маршрута. Повтор увеличивает счётчик."""
    now = _now()
    select_query = """
        DECLARE $user_id AS Utf8;
        DECLARE $m AS Utf8;
        SELECT view_count FROM route_views
        WHERE user_id = $user_id AND m = $m;
    """

    def select(session):
        prepared = session.prepare(select_query)
        return session.transaction().execute(
            prepared, {"$user_id": str(user_id), "$m": str(m_param)}, commit_tx=True
        )

    rows = get_pool().retry_operation_sync(select)[0].rows
    if rows:
        count = int(getattr(rows[0], "view_count", 1) or 1) + 1
        update_query = """
            DECLARE $user_id AS Utf8;
            DECLARE $m AS Utf8;
            DECLARE $last_viewed_at AS Timestamp;
            DECLARE $view_count AS Uint32;
            UPDATE route_views
            SET last_viewed_at = $last_viewed_at, view_count = $view_count
            WHERE user_id = $user_id AND m = $m;
        """

        def update(session):
            prepared = session.prepare(update_query)
            return session.transaction().execute(
                prepared,
                {
                    "$user_id": str(user_id),
                    "$m": str(m_param),
                    "$last_viewed_at": now,
                    "$view_count": count,
                },
                commit_tx=True,
            )

        get_pool().retry_operation_sync(update)
        return

    insert_query = """
        DECLARE $user_id AS Utf8;
        DECLARE $m AS Utf8;
        DECLARE $now AS Timestamp;
        INSERT INTO route_views
            (user_id, m, first_viewed_at, last_viewed_at, view_count)
        VALUES
            ($user_id, $m, $now, $now, 1);
    """

    def insert(session):
        prepared = session.prepare(insert_query)
        return session.transaction().execute(
            prepared,
            {"$user_id": str(user_id), "$m": str(m_param), "$now": now},
            commit_tx=True,
        )

    get_pool().retry_operation_sync(insert)


def route_views_for_user(user_id):
    query = """
        DECLARE $user_id AS Utf8;
        SELECT m, first_viewed_at, last_viewed_at, view_count
        FROM route_views
        WHERE user_id = $user_id;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$user_id": str(user_id)}, commit_tx=True
        )

    rows = get_pool().retry_operation_sync(operation)[0].rows
    result = {}
    for row in rows:
        key = _text(getattr(row, "m", ""))
        if not key:
            continue
        result[key] = {
            "first_viewed_at": _as_utc(getattr(row, "first_viewed_at", None)),
            "last_viewed_at": _as_utc(getattr(row, "last_viewed_at", None)),
            "view_count": int(getattr(row, "view_count", 0) or 0),
        }
    return result


def list_roads_meta():
    query = """
        SELECT m, title, premium, visible, owner_user_id FROM roads;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(prepared, {}, commit_tx=True)

    rows = get_pool().retry_operation_sync(operation)[0].rows
    meta = {}
    for row in rows:
        key = _text(getattr(row, "m", ""))
        if not key:
            continue
        meta[key] = {
            "m": key,
            "title": _text(getattr(row, "title", "")),
            "premium": bool(getattr(row, "premium", False)),
            "visible": bool(getattr(row, "visible", False)),
            "owner_user_id": _text(getattr(row, "owner_user_id", "")),
        }
    return meta


def get_road_meta(m_param):
    query = """
        DECLARE $m AS Utf8;
        SELECT m, title, premium, visible, owner_user_id
        FROM roads
        WHERE m = $m;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$m": str(m_param)}, commit_tx=True
        )

    rows = get_pool().retry_operation_sync(operation)[0].rows
    if not rows:
        return None
    row = rows[0]
    return {
        "m": _text(getattr(row, "m", "")),
        "title": _text(getattr(row, "title", "")),
        "premium": bool(getattr(row, "premium", False)),
        "visible": bool(getattr(row, "visible", False)),
        "owner_user_id": _text(getattr(row, "owner_user_id", "")),
    }
