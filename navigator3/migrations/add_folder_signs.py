#!/usr/bin/env python3
"""Знаки, привязанные к корневой папке владельца.

Таблица хранит, какая сцена PAD относится к корневой папке владельца.
Навигатор читает знаки только при открытии маршрута этого владельца.
"""

import datetime as dt
import os
import subprocess

import ydb

# Текущая общая сцена со знаками Кузнечихи и Мещеры.
DEFAULT_SCENE_ID = "c5bk482x"
# Корневая папка владельца текущих маршрутов (owner_<sha256(user_id)[:24]>).
DEFAULT_ROOT_FOLDER_ID = "owner_8cdc9094d3d39eff615b753f"


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


def _upsert(pool, root_folder_id, scene_id):
    query = """
        DECLARE $root_folder_id AS Utf8;
        DECLARE $scene_id AS Utf8;
        DECLARE $updated_at AS Timestamp;
        UPSERT INTO folder_signs (root_folder_id, scene_id, updated_at)
        VALUES ($root_folder_id, $scene_id, $updated_at);
    """

    def operation(session):
        prepared = session.prepare(query)
        return session.transaction().execute(
            prepared,
            {
                "$root_folder_id": root_folder_id,
                "$scene_id": scene_id,
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

    scene_id = os.environ.get("FULL_SIGNS_SCENE_ID", DEFAULT_SCENE_ID).strip()
    root_folder_id = os.environ.get(
        "FULL_SIGNS_ROOT_FOLDER_ID", DEFAULT_ROOT_FOLDER_ID
    ).strip()
    if not scene_id or not root_folder_id:
        raise RuntimeError("FULL_SIGNS_SCENE_ID and FULL_SIGNS_ROOT_FOLDER_ID are required")

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
        if not _table_exists(pool, database, "folder_signs"):
            _execute_scheme(
                pool,
                """
                CREATE TABLE folder_signs (
                    root_folder_id Utf8,
                    scene_id Utf8,
                    updated_at Timestamp,
                    PRIMARY KEY (root_folder_id)
                );
                """,
            )
            print("Created folder_signs table")
        else:
            print("folder_signs table already exists")
        _upsert(pool, root_folder_id, scene_id)
        print(f"Linked {root_folder_id} -> {scene_id}")
    finally:
        driver.stop()


if __name__ == "__main__":
    main()
