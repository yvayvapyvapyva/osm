"""Создание таблиц пользователей и сессий в YDB (dbosm).

Запуск из корня репозитория (нужен настроенный yc CLI):

    python3 navigator3/scripts/init_auth_db.py
    python3 navigator3/scripts/init_auth_db.py --print-ddl

Скрипт идемпотентен: существующие таблицы не пересоздаются и не очищаются.
Параметры подключения можно переопределить через переменные окружения:
    YDB_DATABASE, YDB_ENDPOINT
"""

import argparse
import os
import subprocess
import sys

import ydb

ENDPOINT = os.getenv("YDB_ENDPOINT", "grpcs://ydb.serverless.yandexcloud.net:2135")
DATABASE = os.getenv(
    "YDB_DATABASE", "/ru-central1/b1gtnlal9r2s3rvqadjn/etnjvaftd6eakeq08kqr"
)

USERS_DDL = """
CREATE TABLE users (
    yandex_id     Utf8,
    user_id       Utf8,
    login         Utf8,
    email         Utf8,
    display_name  Utf8,
    created_at    Timestamp,
    last_login_at Timestamp,
    blocked       Bool,
    PRIMARY KEY (yandex_id)
);
"""

SESSIONS_DDL = """
CREATE TABLE sessions (
    sid_hash     Utf8,
    yandex_id    Utf8,
    user_id      Utf8,
    created_at   Timestamp,
    expires_at   Timestamp,
    last_seen_at Timestamp,
    user_agent   Utf8,
    ip           Utf8,
    PRIMARY KEY (sid_hash)
);
"""


def make_pool():
    token = subprocess.check_output(["yc", "iam", "create-token"]).decode().strip()
    config = ydb.DriverConfig(
        ENDPOINT, DATABASE, credentials=ydb.AuthTokenCredentials(token)
    )
    driver = ydb.Driver(config)
    driver.wait(timeout=10)
    return driver, ydb.SessionPool(driver)


def table_exists(pool, name):
    try:
        pool.retry_operation_sync(
            lambda session: session.describe_table(f"{DATABASE}/{name}")
        )
        return True
    except ydb.SchemeError:
        return False


def create_table(pool, name, ddl):
    if table_exists(pool, name):
        print(f"Таблица {name} уже существует — пропускаю CREATE")
        return
    pool.retry_operation_sync(lambda session: session.execute_scheme(ddl))
    print(f"Таблица {name} создана")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--print-ddl",
        action="store_true",
        help="только напечатать DDL и не подключаться к базе",
    )
    args = parser.parse_args()

    if args.print_ddl:
        print(USERS_DDL.strip())
        print()
        print(SESSIONS_DDL.strip())
        return

    print(f"База: {DATABASE}")
    driver, pool = make_pool()
    try:
        create_table(pool, "users", USERS_DDL)
        create_table(pool, "sessions", SESSIONS_DDL)
    finally:
        driver.stop()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
