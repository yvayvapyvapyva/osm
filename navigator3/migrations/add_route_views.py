#!/usr/bin/env python3
"""История загрузок маршрутов пользователями.

Одна строка на пару (пользователь, маршрут). Нужна, чтобы в меню отмечать
уже загруженные маршруты, а в админке показывать список по пользователю.
"""

import os
import subprocess

import ydb


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


def main():
    endpoint = os.environ.get("YDB_ENDPOINT")
    database = os.environ.get("YDB_DATABASE")
    if not endpoint or not database:
        raise RuntimeError("Set YDB_ENDPOINT and YDB_DATABASE before running")

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

        if not _table_exists(pool, database, "route_views"):
            _execute_scheme(
                pool,
                """
                CREATE TABLE route_views (
                    user_id Utf8,
                    m Utf8,
                    first_viewed_at Timestamp,
                    last_viewed_at Timestamp,
                    view_count Uint32,
                    PRIMARY KEY (user_id, m)
                );
                """,
            )
            print("Created route_views table")
        else:
            print("route_views table already exists")
    finally:
        driver.stop()


if __name__ == "__main__":
    main()
