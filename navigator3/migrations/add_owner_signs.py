#!/usr/bin/env python3
"""Личная сцена знаков владельца маршрутов.

Одна JSON-сцена на owner_user_id. Редактор навигатора сохраняет сюда знаки,
а навигатор читает их вместе с пакетом маршрутов владельца.

Скрипт создаёт таблицу и один раз переносит текущую сцену PAD `full`
в личную сцену владельца.
"""

import datetime as dt
import json
import os
import subprocess

import ydb

DEFAULT_OWNER_USER_ID = "9dd835554c3045439e40f1264dc0dac9"
DEFAULT_SCENE_ID = "c5bk482x"


def _table_exists(pool, database, table):
    try:
        pool.retry_operation_sync(
            lambda session: session.describe_table(f"{database}/{table}")
        )
        return True
    except Exception:  # noqa: BLE001
        return False


def _execute_scheme(pool, query):
    session = pool.acquire()
    try:
        session.execute_scheme(query)
    finally:
        pool.release(session)


def _get_scene_data(pool, scene_id):
    query = """
        DECLARE $id AS Utf8;
        SELECT data FROM scene WHERE id = $id LIMIT 1;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$id": str(scene_id)}, commit_tx=True
        )

    rows = pool.retry_operation_sync(operation)[0].rows
    if not rows:
        return None
    raw = getattr(rows[0], "data", "")
    if isinstance(raw, bytes):
        return raw.decode("utf-8")
    return str(raw or "")


def _has_owner_signs(pool, owner_user_id):
    query = """
        DECLARE $owner_user_id AS Utf8;
        SELECT owner_user_id FROM owner_signs WHERE owner_user_id = $owner_user_id;
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared, {"$owner_user_id": str(owner_user_id)}, commit_tx=True
        )

    return bool(pool.retry_operation_sync(operation)[0].rows)


def _save(pool, owner_user_id, payload):
    query = """
        DECLARE $owner_user_id AS Utf8;
        DECLARE $data AS Utf8;
        DECLARE $updated_at AS Timestamp;
        UPSERT INTO owner_signs (owner_user_id, data, updated_at)
        VALUES ($owner_user_id, $data, $updated_at);
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared,
            {
                "$owner_user_id": str(owner_user_id),
                "$data": payload,
                "$updated_at": dt.datetime.now(dt.timezone.utc),
            },
            commit_tx=True,
        )

    pool.retry_operation_sync(operation)


def main():
    endpoint = os.environ.get("YDB_ENDPOINT")
    database = os.environ.get("YDB_DATABASE")
    if not endpoint or not database:
        raise RuntimeError("Set YDB_ENDPOINT and YDB_DATABASE before running")

    owner_user_id = os.environ.get("SIGNS_OWNER_USER_ID", DEFAULT_OWNER_USER_ID).strip()
    scene_id = os.environ.get("SIGNS_SOURCE_SCENE_ID", DEFAULT_SCENE_ID).strip()
    force = os.environ.get("SIGNS_FORCE_COPY", "0") == "1"

    token = subprocess.check_output(["yc", "iam", "create-token"], text=True).strip()
    driver = ydb.Driver(
        ydb.DriverConfig(
            endpoint,
            database,
            credentials=ydb.AuthTokenCredentials(token),
        )
    )
    try:
        driver.wait(timeout=10)
        pool = ydb.SessionPool(driver)
        if not _table_exists(pool, database, "owner_signs"):
            _execute_scheme(
                pool,
                """
                CREATE TABLE owner_signs (
                    owner_user_id Utf8,
                    data Utf8,
                    updated_at Timestamp,
                    PRIMARY KEY (owner_user_id)
                );
                """,
            )
            print("Created owner_signs table")
        else:
            print("owner_signs table already exists")

        if not force and _has_owner_signs(pool, owner_user_id):
            print(f"owner_signs already has data for {owner_user_id}, skip copy")
            return

        raw = _get_scene_data(pool, scene_id)
        if not raw:
            raise RuntimeError(f"Source scene {scene_id} not found")
        data = json.loads(raw)
        if isinstance(data, str):
            data = json.loads(data)
        if not isinstance(data, dict):
            raise RuntimeError("Source scene has invalid JSON")
        # Оставляем только знаки и камеру: редактору знаков линии/тексты не нужны.
        data = {
            "version": 1,
            "savedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "camera": data.get("camera"),
            "markers": [
                marker for marker in (data.get("markers") or [])
                if isinstance(marker, dict) and marker.get("kind") == "znak"
            ],
        }
        _save(pool, owner_user_id, json.dumps(data, ensure_ascii=False))
        print(f"Copied {len(data['markers'])} signs from {scene_id} to {owner_user_id}")
    finally:
        driver.stop()


if __name__ == "__main__":
    main()
