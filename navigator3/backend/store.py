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
        "created_at": row.created_at,
        "last_login_at": row.last_login_at,
        "blocked": bool(row.blocked) if row.blocked is not None else False,
    }


def get_user_by_yandex_id(yandex_id):
    query = """
        DECLARE $yandex_id AS Utf8;
        SELECT yandex_id, user_id, login, email, display_name,
               created_at, last_login_at, blocked
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
            display_name = $display_name,
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
