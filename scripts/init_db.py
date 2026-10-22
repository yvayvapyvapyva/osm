"""Инициализация отдельной БД dbosm и перенос данных из dbnav.

Запуск (нужен настроенный yc CLI):

    python3 scripts/init_db.py                 # создать таблицы + скопировать всё
    python3 scripts/init_db.py --no-copy       # только создать таблицы
    python3 scripts/init_db.py --visible-only  # маршруты: только visible = true

Копируются таблицы roads (маршруты) и users (логины редактора).
Параметры подключения можно переопределить через переменные окружения:
    SRC_DATABASE, DST_DATABASE, YDB_ENDPOINT
"""

import argparse
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

TABLES = {
    "roads": {
        "ddl": """
            CREATE TABLE roads (
                id Utf8,
                m Utf8,
                json Json,
                name Utf8,
                description Utf8,
                visible Bool,
                creator_name Utf8,
                PRIMARY KEY (id, m)
            );
        """,
        "columns": (
            "id",
            "m",
            "json",
            "name",
            "description",
            "visible",
            "creator_name",
        ),
        "upsert": """
            DECLARE $id AS Utf8;
            DECLARE $m AS Utf8;
            DECLARE $json AS Json;
            DECLARE $name AS Utf8;
            DECLARE $description AS Utf8;
            DECLARE $visible AS Bool;
            DECLARE $creator_name AS Utf8;
            UPSERT INTO roads (id, m, json, name, description, visible, creator_name)
            VALUES ($id, $m, $json, $name, $description, $visible, $creator_name);
        """,
        "params": lambda row: {
            "$id": row["id"] or "",
            "$m": row["m"] or "",
            "$json": row["json"] or "[]",
            "$name": row["name"] or "",
            "$description": row["description"] or "",
            "$visible": bool(row["visible"]),
            "$creator_name": row["creator_name"] or "",
        },
    },
    "users": {
        "ddl": """
            CREATE TABLE users (
                login Utf8,
                password Utf8,
                creator_name Utf8,
                created_at Timestamp,
                PRIMARY KEY (login)
            );
        """,
        "columns": ("login", "password", "creator_name", "created_at"),
        "upsert": """
            DECLARE $login AS Utf8;
            DECLARE $password AS Utf8;
            DECLARE $creator_name AS Utf8;
            DECLARE $created_at AS Timestamp;
            UPSERT INTO users (login, password, creator_name, created_at)
            VALUES ($login, $password, $creator_name, $created_at);
        """,
        "params": lambda row: {
            "$login": row["login"] or "",
            "$password": row["password"] or "",
            "$creator_name": row["creator_name"] or "",
            "$created_at": row["created_at"] or 0,
        },
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
        pool.retry_operation_sync(lambda session: session.describe_table(f"{database}/{name}"))
        return True
    except ydb.SchemeError:
        return False


def create_table(pool, name, ddl):
    if table_exists(pool, DST_DATABASE, name):
        print(f"Таблица {name} уже существует — пропускаю CREATE")
        return
    pool.retry_operation_sync(lambda session: session.execute_scheme(ddl))
    print(f"Таблица {name} создана")


def copy_table(src_pool, dst_pool, name, spec, where=""):
    query = f"SELECT {', '.join(spec['columns'])} FROM {name} {where};"

    def read(session):
        return session.transaction().execute(session.prepare(query), commit_tx=True)

    rows = src_pool.retry_operation_sync(read)[0].rows
    print(f"{name}: прочитано строк {len(rows)}")
    if not rows:
        return

    def write(session):
        prepared = session.prepare(spec["upsert"])
        for row in rows:
            session.transaction().execute(
                prepared, spec["params"](row), commit_tx=True
            )

    dst_pool.retry_operation_sync(write)

    def count(session):
        return session.transaction().execute(
            session.prepare(f"SELECT COUNT(*) AS c FROM {name};"), commit_tx=True
        )

    total = dst_pool.retry_operation_sync(count)[0].rows[0]["c"]
    print(f"{name}: в новой базе {total}")


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

    for name, spec in TABLES.items():
        create_table(dst_pool, name, spec["ddl"])

    if args.no_copy:
        src_driver.stop()
        dst_driver.stop()
        return

    copy_table(
        src_pool,
        dst_pool,
        "roads",
        TABLES["roads"],
        "WHERE visible = true AND name IS NOT NULL" if args.visible_only else "",
    )
    copy_table(src_pool, dst_pool, "users", TABLES["users"])

    src_driver.stop()
    dst_driver.stop()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
