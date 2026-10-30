#!/usr/bin/env python3
"""Схема папок, прав и заказов + миграция текущих roads.

Запуск из корня репозитория (нужен настроенный yc CLI):

    python3 navigator3/scripts/init_folders.py

Скрипт идемпотентен:
  * создаёт таблицы folders, entitlements, orders, если их нет;
  * добавляет в roads колонки folder_id, title, access, price_kopecks, sku;
  * один раз раскладывает текущие roads.name вида "МЕЩЕРА/Экзамен/Маршрут"
    в дерево папок. Уже заполненные folder_id/title не перезаписываются.
"""

import hashlib
import os
import subprocess
import sys

import ydb

ENDPOINT = os.getenv("YDB_ENDPOINT", "grpcs://ydb.serverless.yandexcloud.net:2135")
DATABASE = os.getenv(
    "YDB_DATABASE", "/ru-central1/b1gtnlal9r2s3rvqadjn/etnjvaftd6eakeq08kqr"
)

TABLES = {
    "folders": """
        CREATE TABLE folders (
            folder_id Utf8,
            parent_id Utf8,
            name Utf8,
            access Utf8,
            price_kopecks Uint64,
            sku Utf8,
            sort_order Uint32,
            PRIMARY KEY (folder_id)
        );
    """,
    "entitlements": """
        CREATE TABLE entitlements (
            user_id Utf8,
            entitlement Utf8,
            created_at Timestamp,
            source Utf8,
            order_id Utf8,
            PRIMARY KEY (user_id, entitlement)
        );
    """,
    "orders": """
        CREATE TABLE orders (
            order_id Utf8,
            user_id Utf8,
            folder_id Utf8,
            amount_kopecks Uint64,
            status Utf8,
            created_at Timestamp,
            updated_at Timestamp,
            payment_id Utf8,
            return_path Utf8,
            PRIMARY KEY (order_id)
        );
    """,
}

ROAD_COLUMNS = {
    "folder_id": "Utf8",
    "title": "Utf8",
    "access": "Utf8",
    "price_kopecks": "Uint64",
    "sku": "Utf8",
}


def make_pool():
    token = subprocess.check_output(["yc", "iam", "create-token"]).decode().strip()
    driver = ydb.Driver(
        ydb.DriverConfig(ENDPOINT, DATABASE, credentials=ydb.AuthTokenCredentials(token))
    )
    driver.wait(timeout=10)
    return driver, ydb.SessionPool(driver)


def table_columns(pool, name):
    try:
        description = pool.retry_operation_sync(
            lambda session: session.describe_table(f"{DATABASE}/{name}")
        )
    except ydb.SchemeError:
        return None
    return {column.name for column in description.columns}


def ensure_tables(pool):
    for name, ddl in TABLES.items():
        columns = table_columns(pool, name)
        if columns is None:
            pool.retry_operation_sync(lambda session, q=ddl: session.execute_scheme(q))
            print(f"{name}: создана")
        else:
            print(f"{name}: уже есть")


def ensure_road_columns(pool):
    columns = table_columns(pool, "roads")
    if columns is None:
        raise RuntimeError("Таблица roads не найдена")
    for name, sql_type in ROAD_COLUMNS.items():
        if name in columns:
            continue
        ddl = f"ALTER TABLE roads ADD COLUMN {name} {sql_type};"
        pool.retry_operation_sync(lambda session, q=ddl: session.execute_scheme(q))
        print(f"roads.{name}: добавлена")


def folder_id_for(path):
    digest = hashlib.sha1(path.encode("utf-8")).hexdigest()[:16]
    return "f_" + digest


def read_folders(pool):
    def query(session):
        return session.transaction().execute(
            session.prepare(
                "SELECT folder_id, parent_id, name FROM folders;"
            ),
            commit_tx=True,
        )

    rows = pool.retry_operation_sync(query)[0].rows
    by_id = {}
    by_key = {}
    for row in rows:
        folder = {
            "folder_id": row.folder_id or "",
            "parent_id": row.parent_id or "",
            "name": row.name or "",
        }
        by_id[folder["folder_id"]] = folder
        by_key[(folder["parent_id"], folder["name"])] = folder["folder_id"]
    return by_id, by_key


def create_folder(pool, by_id, by_key, parent_id, name):
    key = (parent_id, name)
    if key in by_key:
        return by_key[key]

    path = name if not parent_id else f"{by_id[parent_id]['name']}/{name}"
    # Путь для id должен быть стабильным и не зависеть от отображаемых имён,
    # поэтому используем цепочку id, а не только текст.
    seed = parent_id + "/" + name
    folder_id = folder_id_for(seed)
    while folder_id in by_id:
        folder_id = "f_" + hashlib.sha1(
            (seed + folder_id).encode("utf-8")
        ).hexdigest()[:16]

    def insert(session):
        query = """
            DECLARE $folder_id AS Utf8;
            DECLARE $parent_id AS Utf8;
            DECLARE $name AS Utf8;
            DECLARE $access AS Utf8;
            DECLARE $price AS Uint64;
            DECLARE $sku AS Utf8;
            DECLARE $sort_order AS Uint32;
            UPSERT INTO folders
                (folder_id, parent_id, name, access, price_kopecks, sku, sort_order)
            VALUES
                ($folder_id, $parent_id, $name, $access, $price, $sku, $sort_order);
        """
        return session.transaction().execute(
            session.prepare(query),
            {
                "$folder_id": folder_id,
                "$parent_id": parent_id,
                "$name": name,
                "$access": "public",
                "$price": 0,
                "$sku": "",
                "$sort_order": 0,
            },
            commit_tx=True,
        )

    pool.retry_operation_sync(insert)
    by_id[folder_id] = {
        "folder_id": folder_id,
        "parent_id": parent_id,
        "name": name,
    }
    by_key[key] = folder_id
    print(f"folders: + {path} ({folder_id})")
    return folder_id


def ensure_path(pool, by_id, by_key, parts):
    parent_id = ""
    for part in parts:
        parent_id = create_folder(pool, by_id, by_key, parent_id, part)
    return parent_id


def migrate_roads(pool, by_id, by_key):
    def query(session):
        return session.transaction().execute(
            session.prepare(
                """
                SELECT m, name, folder_id, title, access, price_kopecks, sku
                FROM roads;
                """
            ),
            commit_tx=True,
        )

    rows = pool.retry_operation_sync(query)[0].rows
    changed = 0
    for row in rows:
        name = row.name or ""
        parts = [part.strip() for part in name.split("/") if part.strip()]

        folder_id = row.folder_id or ""
        if folder_id and folder_id not in by_id:
            folder_id = ""
        if not folder_id and parts:
            folder_id = ensure_path(pool, by_id, by_key, parts[:-1])

        title = (row.title or "").strip()
        if not title:
            title = parts[-1] if parts else (name.strip() or row.m or "")

        access = (row.access or "").strip() or "folder"
        price = int(row.price_kopecks or 0)
        sku = row.sku or ""

        def update(session):
            query = """
                DECLARE $m AS Utf8;
                DECLARE $folder_id AS Utf8;
                DECLARE $title AS Utf8;
                DECLARE $access AS Utf8;
                DECLARE $price AS Uint64;
                DECLARE $sku AS Utf8;
                UPDATE roads
                SET folder_id = $folder_id,
                    title = $title,
                    access = $access,
                    price_kopecks = $price,
                    sku = $sku
                WHERE m = $m;
            """
            return session.transaction().execute(
                session.prepare(query),
                {
                    "$m": row.m,
                    "$folder_id": folder_id,
                    "$title": title,
                    "$access": access,
                    "$price": price,
                    "$sku": sku,
                },
                commit_tx=True,
            )

        pool.retry_operation_sync(update)
        changed += 1

    print(f"roads: обработано {changed}")


def main():
    print(f"База: {DATABASE}")
    driver, pool = make_pool()
    try:
        ensure_tables(pool)
        ensure_road_columns(pool)
        by_id, by_key = read_folders(pool)
        migrate_roads(pool, by_id, by_key)
        print(f"folders: всего {len(by_id)}")
    finally:
        driver.stop()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
