"""Бэкенд PAD на Яндекс.Облако Function.

Сцены не привязаны к аккаунтам. Имя — уникальный ключ записи, ID — постоянный
восьмисимвольный код сцены, используемый в ссылках и сохраняемый при переименовании.
База — общая serverless-YDB OSM-проекта (`dbosm`), таблица `scene`.
Таблица маршрутов `roads` не затрагивается.

Публичное API:
  GET             — список сцен
  GET ?id=...     — одна сцена по постоянному ID
  GET ?name=...   — одна сцена по имени (совместимость)
  POST ?action=auth — проверка пароля администратора
  POST            — сохранить сцену, тело {name, data} (требует пароль)
  PUT             — переименовать, тело {name, from} (требует пароль)
  DELETE ?name=...— удалить сцену (требует пароль)

Деплой: см. pad/deploy.sh.
"""

import datetime as _dt
import hmac
import json
import os
import secrets
import string
import urllib.request

import ydb
import ydb.credentials


SIGNS_OWNER_LOGIN = os.environ.get("SIGNS_OWNER_LOGIN", "").strip()
SIGNS_OWNER_USER_ID = os.environ.get("SIGNS_OWNER_USER_ID", "").strip()
MAX_SIGNS = 5000
MAX_SIGNS_BYTES = 2_000_000


def _scene_path() -> str:
    return os.environ["YDB_DATABASE"].rstrip("/") + "/scene"


def _owner_signs_path() -> str:
    return os.environ["YDB_DATABASE"].rstrip("/") + "/owner_signs"


def _get_sa_token() -> dict:
    """Получаем IAM-токен сервисного аккаунта функции из сервиса метаданных."""
    url = ("http://169.254.169.254/computeMetadata/v1/instance/"
           "service-accounts/default/token")
    req = urllib.request.Request(url, headers={"Metadata-Flavor": "Google"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


class _IAMCredentials(ydb.credentials.AbstractExpiringTokenCredentials):
    """Динамические IAM-креды сервисного аккаунта (токен кэшируется)."""

    def _make_token_request(self):
        return _get_sa_token()


def _driver() -> ydb.DriverConfig:
    endpoint = os.environ["YDB_ENDPOINT"]
    database = os.environ["YDB_DATABASE"]
    return ydb.DriverConfig(endpoint, database, credentials=_IAMCredentials())


def _ensure_table(session: ydb.Session) -> None:
    """Создаёт таблицу scene(name PK, data, id), добавляя id старым таблицам.

    Таблицу с другой схемой не пересоздаём автоматически: это защищает данные
    от случайной потери.
    """
    path = _scene_path()
    try:
        desc = session.describe_table(path)
    except ydb.issues.SchemeError:
        session.create_table(
            path,
            ydb.TableDescription()
            .with_primary_keys("name")
            .with_columns(
                ydb.Column("name", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                ydb.Column("data", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                ydb.Column("id", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
            ),
        )
        return

    cols = {c.name for c in getattr(desc, "columns", [])}
    pk = set(getattr(desc, "primary_key", []) or [])
    if cols not in ({"name", "data"}, {"name", "data", "id"}) or pk != {"name"}:
        raise RuntimeError(
            "Таблица scene имеет старую схему с привязкой к аккаунту. "
            "Нужна миграция на ключ name."
        )
    if "id" not in cols:
        session.execute_scheme(f"ALTER TABLE `{path}` ADD COLUMN `id` Utf8;")


def _ensure_owner_signs_table(session: ydb.Session) -> None:
    """Таблица личной сцены знаков navigator3; PAD пишет в ту же строку."""
    path = _owner_signs_path()
    try:
        session.describe_table(path)
        return
    except ydb.issues.SchemeError:
        session.create_table(
            path,
            ydb.TableDescription()
            .with_primary_keys("owner_user_id")
            .with_columns(
                ydb.Column("owner_user_id", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                ydb.Column("data", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                ydb.Column("updated_at", ydb.OptionalType(ydb.PrimitiveType.Timestamp)),
            ),
        )


def _signs_owner(session: ydb.Session):
    """Возвращает (user_id, login) владельца слоя знаков."""
    if SIGNS_OWNER_USER_ID:
        return SIGNS_OWNER_USER_ID, SIGNS_OWNER_LOGIN or SIGNS_OWNER_USER_ID
    login = SIGNS_OWNER_LOGIN
    if not login:
        raise ValueError("Слой знаков не настроен: задайте SIGNS_OWNER_LOGIN или SIGNS_OWNER_USER_ID")
    query = session.prepare(
        "DECLARE $login AS Utf8; "
        "SELECT user_id FROM users WHERE login = $login LIMIT 1;"
    )
    rows = session.transaction().execute(
        query, parameters={"$login": login}, commit_tx=True
    )[0].rows
    if not rows:
        raise ValueError(f"Пользователь {login} не найден")
    return _ascii(rows[0].user_id), login


def _owner_signs_doc(session: ydb.Session):
    user_id, login = _signs_owner(session)
    query = session.prepare(
        "DECLARE $owner_user_id AS Utf8; "
        "SELECT data FROM owner_signs WHERE owner_user_id = $owner_user_id;"
    )
    rows = session.transaction().execute(
        query, parameters={"$owner_user_id": user_id}, commit_tx=True
    )[0].rows
    data = {}
    if rows:
        try:
            parsed = json.loads(_ascii(rows[0].data))
            if isinstance(parsed, dict):
                data = parsed
        except Exception:
            data = {}
    data.setdefault("version", 1)
    data.setdefault("markers", [])
    return user_id, login, data


def _normalize_sign(marker):
    if not isinstance(marker, dict) or marker.get("kind") != "znak":
        return None
    code = _ascii(marker.get("code") or "").strip()
    file_name = _ascii(marker.get("file") or "").strip()
    if not code or not file_name:
        return None
    try:
        lat = float(marker.get("lat"))
        lon = float(marker.get("lon"))
    except (TypeError, ValueError):
        return None
    try:
        heading = float(marker.get("heading") or 0)
    except (TypeError, ValueError):
        heading = 0.0
    plates = [
        _ascii(plate).strip()
        for plate in (marker.get("plates") or [])
        if _ascii(plate).strip()
    ]
    sign = {
        "kind": "znak",
        "code": code,
        "file": file_name,
        "lat": lat,
        "lon": lon,
        "heading": heading,
        "leg": bool(marker.get("leg")),
        "plates": plates,
    }
    if "value" in marker:
        sign["value"] = marker.get("value")
    return sign


def _save_owner_signs(session: ydb.Session, markers) -> int:
    if not isinstance(markers, list):
        raise ValueError("Поле 'markers' должно быть массивом")
    normalized = [sign for sign in (_normalize_sign(m) for m in markers) if sign]
    if len(normalized) > MAX_SIGNS:
        raise ValueError(f"Слишком много знаков: максимум {MAX_SIGNS}")
    user_id, _login = _signs_owner(session)
    query = session.prepare(
        "DECLARE $owner_user_id AS Utf8; "
        "SELECT data FROM owner_signs WHERE owner_user_id = $owner_user_id;"
    )
    rows = session.transaction().execute(
        query, parameters={"$owner_user_id": user_id}, commit_tx=True
    )[0].rows
    data = {}
    if rows:
        try:
            parsed = json.loads(_ascii(rows[0].data))
            if isinstance(parsed, dict):
                data = parsed
        except Exception:
            data = {}
    data.setdefault("version", 1)
    data["markers"] = normalized
    data["savedAt"] = _dt.datetime.now(_dt.timezone.utc).isoformat()
    payload = json.dumps(data, ensure_ascii=False)
    if len(payload.encode("utf-8")) > MAX_SIGNS_BYTES:
        raise ValueError("Слой знаков слишком большой")
    write_query = session.prepare(
        "DECLARE $owner_user_id AS Utf8; "
        "DECLARE $data AS Utf8; "
        "DECLARE $updated_at AS Timestamp; "
        "UPSERT INTO owner_signs (owner_user_id, data, updated_at) "
        "VALUES ($owner_user_id, $data, $updated_at);"
    )
    session.transaction().execute(
        write_query,
        parameters={
            "$owner_user_id": user_id,
            "$data": payload,
            "$updated_at": _dt.datetime.now(_dt.timezone.utc),
        },
        commit_tx=True,
    )
    return len(normalized)


def _delete_owner_signs(session: ydb.Session) -> None:
    user_id, _login = _signs_owner(session)
    query = session.prepare(
        "DECLARE $owner_user_id AS Utf8; "
        "DELETE FROM owner_signs WHERE owner_user_id = $owner_user_id;"
    )
    session.transaction().execute(
        query, parameters={"$owner_user_id": user_id}, commit_tx=True
    )


def _new_scene_id() -> str:
    """Создаёт восьмисимвольный ID в том же алфавите, что и навигатор."""
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(8))


def _write_scene(session: ydb.Session, name: str, payload: str, scene_id: str) -> None:
    data_query = session.prepare(
        "DECLARE $name AS Utf8; "
        "DECLARE $id AS Utf8; "
        "DECLARE $data AS Utf8; "
        "UPSERT INTO `scene` (`name`, `data`, `id`) VALUES ($name, $data, $id);"
    )
    session.transaction().execute(
        data_query,
        parameters={"$name": name, "$id": scene_id, "$data": payload},
        commit_tx=True,
    )


def _ascii(v) -> str:
    """YDB может вернуть Utf8 как str или bytes — приводим к str."""
    if isinstance(v, bytes):
        return v.decode("utf-8")
    return str(v)


def _upsert_scene(session: ydb.Session, name: str, data) -> str:
    payload = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    existing = _get_scene(session, name)
    scene_id = existing["id"] if existing else _new_scene_id()
    _write_scene(session, name, payload, scene_id)
    return scene_id


def _get_scene(session: ydb.Session, name: str):
    data_query = session.prepare(
        "DECLARE $name AS Utf8; "
        "SELECT `name`, `data`, `id` FROM `scene` WHERE `name` = $name;"
    )
    result_sets = session.transaction().execute(
        data_query,
        parameters={"$name": name},
        commit_tx=True,
    )
    rows = result_sets[0].rows
    if not rows:
        return None
    scene_id = _ascii(rows[0]["id"]) if rows[0]["id"] is not None else ""
    scene = {
        "name": _ascii(rows[0]["name"]),
        "data": _ascii(rows[0]["data"]),
        "id": scene_id,
    }
    if len(scene_id) != 8 or any(char not in string.ascii_lowercase + string.digits for char in scene_id):
        scene["id"] = _new_scene_id()
        _write_scene(session, scene["name"], scene["data"], scene["id"])
    return scene


def _get_scene_by_id(session: ydb.Session, scene_id: str):
    if len(scene_id) != 8 or any(char not in string.ascii_lowercase + string.digits for char in scene_id):
        return None
    data_query = session.prepare(
        "DECLARE $id AS Utf8; "
        "SELECT `name`, `data`, `id` FROM `scene` WHERE `id` = $id;"
    )
    result_sets = session.transaction().execute(
        data_query,
        parameters={"$id": scene_id},
        commit_tx=True,
    )
    rows = result_sets[0].rows
    if not rows:
        return None
    return {
        "name": _ascii(rows[0]["name"]),
        "data": _ascii(rows[0]["data"]),
        "id": _ascii(rows[0]["id"]),
    }


def _list_scenes(session: ydb.Session):
    data_query = session.prepare("SELECT `name`, `data`, `id` FROM `scene`;")
    result_sets = session.transaction().execute(data_query, commit_tx=True)
    out = []
    for row in result_sets[0].rows:
        name = _ascii(row["name"])
        data = _ascii(row["data"])
        scene_id = _ascii(row["id"]) if row["id"] is not None else ""
        if len(scene_id) != 8 or any(char not in string.ascii_lowercase + string.digits for char in scene_id):
            scene_id = _new_scene_id()
            _write_scene(session, name, data, scene_id)
        try:
            saved_at = json.loads(data).get("savedAt")
        except Exception:
            saved_at = None
        out.append({
            "name": name,
            "id": scene_id,
            "savedAt": saved_at,
            "sizeBytes": len(data.encode("utf-8")),
        })
    out.sort(key=lambda s: s["name"])
    return out


def _delete_scene(session: ydb.Session, name: str) -> bool:
    data_query = session.prepare(
        "DECLARE $name AS Utf8; "
        "DELETE FROM `scene` WHERE `name` = $name;"
    )
    session.transaction().execute(
        data_query,
        parameters={"$name": name},
        commit_tx=True,
    )
    return True


def _rename_scene(session: ydb.Session, old_name: str, new_name: str) -> dict:
    """Переименовывает сцену, сохраняя её постоянный ID."""
    scene = _get_scene(session, old_name)
    if scene is None:
        raise KeyError("Сцена не найдена")
    if new_name == old_name:
        return {"name": new_name, "id": scene["id"]}
    if _get_scene(session, new_name) is not None:
        raise ValueError("Сцена с таким именем уже существует")
    _delete_scene(session, old_name)
    _write_scene(session, new_name, scene["data"], scene["id"])
    return {"name": new_name, "id": scene["id"]}


# ---------- HTTP-обработчик ----------

def handler(event, context):
    method = (event.get("httpMethod") or event.get("method") or "GET").upper()

    if method == "OPTIONS":
        return {
            "statusCode": 200,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, X-Scene-Admin-Password",
                "Access-Control-Max-Age": "3600",
            },
            "body": "",
            "isBase64Encoded": False,
        }

    body = event.get("body") or ""
    if body and isinstance(body, dict):
        body = json.dumps(body)
    if body and isinstance(body, str):
        try:
            body = json.loads(body)
        except Exception:
            body = {}

    query = event.get("queryStringParameters") or {}
    action = query.get("action")
    name = body.get("name") if isinstance(body, dict) else None
    if not name:
        name = query.get("name")
    scene_id = query.get("id")

    if action == "auth":
        if method != "POST":
            return _error("Метод не поддерживается для проверки пароля", 405)
        auth_error = _authorize_mutation(event)
        if auth_error:
            return auth_error
        return _ok({"ok": True, "authenticated": True})

    if method in {"POST", "PUT", "DELETE"}:
        auth_error = _authorize_mutation(event)
        if auth_error:
            return auth_error

    driver = None
    try:
        driver = ydb.Driver(_driver())
        driver.wait(timeout=10)
        with ydb.SessionPool(driver, size=1) as pool:
            if action == "owner_signs":
                def run_signs(session):
                    _ensure_owner_signs_table(session)
                    if method == "GET":
                        user_id, login, data = _owner_signs_doc(session)
                        return {
                            "ok": True,
                            "owner": {"user_id": user_id, "login": login},
                            "data": data,
                        }
                    if method in ("POST", "PUT"):
                        markers = body.get("markers") if isinstance(body, dict) else None
                        count = _save_owner_signs(session, markers)
                        return {"ok": True, "saved": True, "count": count}
                    if method == "DELETE":
                        _delete_owner_signs(session)
                        return {"ok": True, "deleted": True}
                    raise ValueError("Метод не поддерживается для слоя знаков")
                result = pool.retry_operation_sync(run_signs)
            else:
                def run(session):
                    _ensure_table(session)
                    return _dispatch(session, method, name, scene_id, body)
                result = pool.retry_operation_sync(run)
        return _ok(result)
    except Exception as e:
        return _error(str(e))
    finally:
        if driver is not None:
            try:
                driver.stop()
            except Exception:
                pass


def _authorize_mutation(event):
    admin_password = os.environ.get("SCENE_ADMIN_PASSWORD")
    headers = event.get("headers") or {}
    provided_password = next(
        (value for key, value in headers.items()
         if str(key).lower() == "x-scene-admin-password"),
        "",
    )
    if not admin_password:
        return _error("Операции изменения не настроены: задайте пароль администратора", 503)
    if not isinstance(provided_password, str) or not hmac.compare_digest(
        provided_password, admin_password
    ):
        return _error("Неверный пароль администратора", 403)
    return None


def _dispatch(session, method, name, scene_id, body):
    if method == "POST":
        if not name:
            raise ValueError("Параметр 'name' обязателен")
        data = body.get("data") if isinstance(body, dict) else body
        if data is None:
            raise ValueError("Поле 'data' обязательно")
        saved_id = _upsert_scene(session, name, data)
        return {"ok": True, "name": name, "id": saved_id}

    if method == "GET":
        if scene_id:
            scene = _get_scene_by_id(session, scene_id)
            if scene is None:
                raise KeyError("Сцена не найдена")
            return {"ok": True, **scene}
        if name:
            scene = _get_scene(session, name)
            if scene is None:
                raise KeyError("Сцена не найдена")
            return {"ok": True, **scene}
        return {"ok": True, "scenes": _list_scenes(session)}

    if method == "PUT":
        if not name:
            raise ValueError("Параметр 'name' обязателен")
        old_name = body.get("from") if isinstance(body, dict) else None
        if not old_name:
            raise ValueError("Параметр 'from' обязателен")
        renamed = _rename_scene(session, old_name, name)
        return {"ok": True, **renamed}

    if method == "DELETE":
        if not name:
            raise ValueError("Параметр 'name' обязателен")
        _delete_scene(session, name)
        return {"ok": True, "name": name}

    raise ValueError("Метод не поддерживается: " + method)


def _ok(data):
    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Scene-Admin-Password",
        },
        "body": json.dumps(data, ensure_ascii=False),
        "isBase64Encoded": False,
    }


def _error(msg, status_code=400):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type, X-Scene-Admin-Password",
        },
        "body": json.dumps({"ok": False, "error": str(msg)}, ensure_ascii=False),
        "isBase64Encoded": False,
    }
