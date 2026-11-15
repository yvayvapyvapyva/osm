#!/usr/bin/env python3
"""Таблица аудита действий админки.

Каждая запись — одно изменение: кто из админов, что сделал, с кем и когда.
"""

import os
import subprocess

import ydb


def _describe(pool, database, table):
    return pool.retry_operation_sync(
        lambda session: session.describe_table(f"{database}/{table}")
    )


def _table_exists(pool, database, table):
    try:
        _describe(pool, database, table)
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

        if not _table_exists(pool, database, "admin_audit"):
            _execute_scheme(
                pool,
                """
                CREATE TABLE admin_audit (
                    id Utf8,
                    admin_yandex_id Utf8,
                    action Utf8,
                    target_user_id Utf8,
                    target_yandex_id Utf8,
                    payload Utf8,
                    created_at Timestamp,
                    PRIMARY KEY (id)
                );
                """,
            )
            print("Created admin_audit table")
        else:
            print("admin_audit table already exists")

        audit = _describe(pool, database, "admin_audit")
        indexes = {getattr(index, "name", "") for index in getattr(audit, "indexes", [])}
        if "admin_audit_created_idx" not in indexes:
            _execute_scheme(
                pool,
                "ALTER TABLE admin_audit ADD INDEX admin_audit_created_idx GLOBAL ON (created_at);",
            )
            print("Added admin_audit_created_idx")
        else:
            print("admin_audit_created_idx already exists")
    finally:
        driver.stop()


if __name__ == "__main__":
    main()
