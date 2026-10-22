"""Бэкенд PAD на Яндекс.Облако Function.

Сцены не привязаны к аккаунтам. Единственный идентификатор сцены — `name`.
База — общая serverless-YDB OSM-проекта (`dbosm`), таблица `scene`.
Таблица маршрутов `roads` не затрагивается.

Публичное API:
  GET             — список сцен
  GET ?name=...   — одна сцена
  POST            — сохранить сцену, тело {name, data}
  PUT             — переименовать, тело {name, from}
  DELETE ?name=...— удалить сцену

Деплой: см. pad/deploy.sh.
"""

import json
import os
import urllib.request

import ydb
import ydb.credentials


def _scene_path() -> str:
    return os.environ["YDB_DATABASE"].rstrip("/") + "/scene"


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
    """Создаёт таблицу scene(name PK, data), если её ещё нет.

    Старую схему с user_id не пересоздаём автоматически: это защищает данные
    от случайной потери. Миграция выполняется отдельно при переходе на
    безаккаунтную версию.
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
            ),
        )
        return

    cols = {c.name for c in getattr(desc, "columns", [])}
    pk = set(getattr(desc, "primary_key", []) or [])
    if cols != {"name", "data"} or pk != {"name"}:
        raise RuntimeError(
            "Таблица scene имеет старую схему с привязкой к аккаунту. "
            "Нужна миграция на ключ name."
        )


def _ascii(v) -> str:
    """YDB может вернуть Utf8 как str или bytes — приводим к str."""
    if isinstance(v, bytes):
        return v.decode("utf-8")
    return str(v)


def _upsert_scene(session: ydb.Session, name: str, data) -> str:
    payload = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    data_query = session.prepare(
        "DECLARE $name AS Utf8; "
        "DECLARE $data AS Utf8; "
        "UPSERT INTO `scene` (`name`, `data`) VALUES ($name, $data);"
    )
    session.transaction().execute(
        data_query,
        parameters={"$name": name, "$data": payload},
        commit_tx=True,
    )
    return name


def _get_scene(session: ydb.Session, name: str):
    data_query = session.prepare(
        "DECLARE $name AS Utf8; "
        "SELECT `name`, `data` FROM `scene` WHERE `name` = $name;"
    )
    result_sets = session.transaction().execute(
        data_query,
        parameters={"$name": name},
        commit_tx=True,
    )
    rows = result_sets[0].rows
    if not rows:
        return None
    return {"name": _ascii(rows[0]["name"]), "data": _ascii(rows[0]["data"])}


def _list_scenes(session: ydb.Session):
    data_query = session.prepare("SELECT `name`, `data` FROM `scene`;")
    result_sets = session.transaction().execute(data_query, commit_tx=True)
    out = []
    for row in result_sets[0].rows:
        name = _ascii(row["name"])
        data = _ascii(row["data"])
        try:
            saved_at = json.loads(data).get("savedAt")
        except Exception:
            saved_at = None
        out.append({
            "name": name,
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


def _rename_scene(session: ydb.Session, old_name: str, new_name: str) -> str:
    """Переименовывает сцену: копирует данные под новым ключом и удаляет старый."""
    if new_name == old_name:
        return new_name
    scene = _get_scene(session, old_name)
    if scene is None:
        raise KeyError("Сцена не найдена")
    _upsert_scene(session, new_name, scene["data"])
    _delete_scene(session, old_name)
    return new_name


# ---------- HTTP-обработчик ----------

def handler(event, context):
    method = (event.get("httpMethod") or event.get("method") or "GET").upper()

    if method == "OPTIONS":
        return {
            "statusCode": 200,
            "headers": {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
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
    name = body.get("name") if isinstance(body, dict) else None
    if not name:
        name = query.get("name")

    driver = None
    try:
        driver = ydb.Driver(_driver())
        driver.wait(timeout=10)
        with ydb.SessionPool(driver, size=1) as pool:
            def run(session):
                _ensure_table(session)
                return _dispatch(session, method, name, body)
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


def _dispatch(session, method, name, body):
    if method == "POST":
        if not name:
            raise ValueError("Параметр 'name' обязателен")
        data = body.get("data") if isinstance(body, dict) else body
        if data is None:
            raise ValueError("Поле 'data' обязательно")
        saved = _upsert_scene(session, name, data)
        return {"ok": True, "name": saved}

    if method == "GET":
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
        return {"ok": True, "name": renamed}

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
            "Access-Control-Allow-Headers": "Content-Type",
        },
        "body": json.dumps(data, ensure_ascii=False),
        "isBase64Encoded": False,
    }


def _error(msg):
    return {
        "statusCode": 400,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps({"ok": False, "error": str(msg)}, ensure_ascii=False),
        "isBase64Encoded": False,
    }
