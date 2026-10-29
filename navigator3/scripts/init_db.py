"""Инициализация отдельной БД dbosm и перенос маршрутов из dbnav.

Запуск из корня репозитория (нужен настроенный yc CLI):

    python3 navigator/scripts/init_db.py                 # создать таблицу + скопировать всё
    python3 navigator/scripts/init_db.py --no-copy       # только создать таблицу
    python3 navigator/scripts/init_db.py --visible-only  # только visible = true

Маршруты не привязаны к аккаунтам: ключ маршрута — только `m`.
Legacy-поле info из точек маршрутов при переносе удаляется.
Параметры подключения можно переопределить через переменные окружения:
    SRC_DATABASE, DST_DATABASE, YDB_ENDPOINT
"""

import argparse
import json
import os
import subprocess
import sys

import ydb

ENDPOINT = os.getenv("YDB_ENDPOINT", "grpcs://ydb.serverless.yandexcloud.net:2135")
SRC_DATABASE = os.getenv(
    "SRC_DATABASE", "/ru-central1/b1gtnlal9r2s3rvqadjn/etn3ppn9gdj01le0ep1v"
)
DST_DATABASE = os.getenv(
    "DST_DATABASE", "/ru-central1/b1gtnlal9r2s3rvqadjn/etnjvaftd6eakeq08kqr"
)


def strip_legacy_info(raw):
    """Убирает legacy-поле info из точек маршрута при переносе."""
    try:
        data = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return raw or "[]"
    if not isinstance(data, list):
        return raw or "[]"
    for point in data:
        if isinstance(point, dict):
            point.pop("info", None)
    return json.dumps(data, ensure_ascii=False)


ROADS = {
    "ddl": """
        CREATE TABLE roads (
            m Utf8,
            json Json,
            name Utf8,
            description Utf8,
            visible Bool,
            PRIMARY KEY (m)
        );
    """,
    "columns": ("m", "json", "name", "description", "visible"),
    "upsert": """
        DECLARE $m AS Utf8;
        DECLARE $json AS Json;
        DECLARE $name AS Utf8;
        DECLARE $description AS Utf8;
        DECLARE $visible AS Bool;
        UPSERT INTO roads (m, json, name, description, visible)
        VALUES ($m, $json, $name, $description, $visible);
    """,
    "params": lambda row: {
        "$m": row["m"] or "",
        "$json": strip_legacy_info(row["json"]),
        "$name": row["name"] or "",
        "$description": row["description"] or "",
        "$visible": bool(row["visible"]),
    },
}


def make_pool(database):
    token = subprocess.check_output(["yc", "iam", "create-token"]).decode().strip()
    config = ydb.DriverConfig(
        ENDPOINT, database, credentials=ydb.AuthTokenCredentials(token)
    )
    driver = ydb.Driver(config)
    driver.wait(timeout=10)
    return driver, ydb.SessionPool(driver)


def table_exists(pool, database, name):
    try:
        pool.retry_operation_sync(
            lambda session: session.describe_table(f"{database}/{name}")
        )
        return True
    except ydb.SchemeError:
        return False


def create_table(pool, name, ddl):
    if table_exists(pool, DST_DATABASE, name):
        print(f"Таблица {name} уже существует — пропускаю CREATE")
        return
    pool.retry_operation_sync(lambda session: session.execute_scheme(ddl))
    print(f"Таблица {name} создана")


def copy_roads(src_pool, dst_pool, where=""):
    query = f"SELECT {', '.join(ROADS['columns'])} FROM roads {where};"

    def read(session):
        return session.transaction().execute(session.prepare(query), commit_tx=True)

    rows = src_pool.retry_operation_sync(read)[0].rows
    print(f"roads: прочитано строк {len(rows)}")
    if not rows:
        return

    def write(session):
        prepared = session.prepare(ROADS["upsert"])
        for row in rows:
            session.transaction().execute(
                prepared, ROADS["params"](row), commit_tx=True
            )

    dst_pool.retry_operation_sync(write)

    def count(session):
        return session.transaction().execute(
            session.prepare("SELECT COUNT(*) AS c FROM roads;"), commit_tx=True
        )

    total = dst_pool.retry_operation_sync(count)[0].rows[0]["c"]
    print(f"roads: в новой базе {total}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-copy", action="store_true", help="не переносить данные")
    parser.add_argument(
        "--visible-only", action="store_true", help="маршруты: только visible = true"
    )
    args = parser.parse_args()

    print(f"Источник: {SRC_DATABASE}")
    print(f"Цель:     {DST_DATABASE}")

    src_driver, src_pool = make_pool(SRC_DATABASE)
    dst_driver, dst_pool = make_pool(DST_DATABASE)

    create_table(dst_pool, "roads", ROADS["ddl"])

    if not args.no_copy:
        copy_roads(
            src_pool,
            dst_pool,
            "WHERE visible = true AND name IS NOT NULL" if args.visible_only else "",
        )

    src_driver.stop()
    dst_driver.stop()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
