#!/usr/bin/env python3
"""Журнал значимых действий пользователей и администраторов.

Одна строка на событие. Просмотры маршрутов по-прежнему агрегируются в
route_views; этот журнал нужен для аудита изменений и админской ленты.
"""

import os
import subprocess

import ydb

TTL_SECONDS = 180 * 24 * 60 * 60


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
        table_path = f"{database}/activity_log"

        if not _table_exists(pool, database, "activity_log"):
            description = (
                ydb.TableDescription()
                .with_primary_keys("id")
                .with_columns(
                    ydb.Column("id", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                    ydb.Column("created_at", ydb.OptionalType(ydb.PrimitiveType.Timestamp)),
                    ydb.Column("user_id", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                    ydb.Column("yandex_id", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                    ydb.Column("login", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                    ydb.Column("display_name", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                    ydb.Column("action", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                    ydb.Column("source", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                    ydb.Column("entity_type", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                    ydb.Column("entity_id", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                    ydb.Column("route_m", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                    ydb.Column("folder_id", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                    ydb.Column("title", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                    ydb.Column("metadata", ydb.OptionalType(ydb.PrimitiveType.Utf8)),
                )
                .with_ttl(
                    ydb.TtlSettings().with_date_type_column(
                        "created_at", TTL_SECONDS
                    )
                )
            )
            session = pool.acquire()
            try:
                session.create_table(table_path, description)
            finally:
                pool.release(session)
            print("Created activity_log table")
        else:
            print("activity_log table already exists")

        description = pool.retry_operation_sync(
            lambda session: session.describe_table(table_path)
        )
        indexes = {getattr(index, "name", "") for index in getattr(description, "indexes", [])}
        if "activity_created_idx" not in indexes:
            _execute_scheme(
                pool,
                "ALTER TABLE activity_log ADD INDEX activity_created_idx GLOBAL ON (created_at);",
            )
            print("Added activity_created_idx")
        else:
            print("activity_created_idx already exists")
    finally:
        driver.stop()


if __name__ == "__main__":
    main()
