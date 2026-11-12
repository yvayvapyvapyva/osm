#!/usr/bin/env python3
"""Add premium subscription fields and payment records.

- users.premium_until — timestamp when the paid premium period ends.
- payments — audit/idempotency table for YooKassa payments.
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
    except Exception:  # noqa: BLE001 - YDB raises different not-found errors
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

        users = _describe(pool, database, "users")
        user_columns = {column.name for column in users.columns}
        if "premium_until" not in user_columns:
            _execute_scheme(pool, "ALTER TABLE users ADD COLUMN premium_until Timestamp;")
            print("Added users.premium_until")
        else:
            print("users.premium_until already exists")

        if not _table_exists(pool, database, "payments"):
            _execute_scheme(
                pool,
                """
                CREATE TABLE payments (
                    inv_id Utf8,
                    user_id Utf8,
                    yandex_id Utf8,
                    amount_kopecks Uint64,
                    currency Utf8,
                    status Utf8,
                    provider Utf8,
                    payment_url Utf8,
                    created_at Timestamp,
                    paid_at Timestamp,
                    PRIMARY KEY (inv_id)
                );
                """,
            )
            print("Created payments table")
        else:
            print("payments table already exists")

        payments = _describe(pool, database, "payments")
        indexes = {getattr(index, "name", "") for index in getattr(payments, "indexes", [])}
        if "payments_user_idx" not in indexes:
            _execute_scheme(
                pool,
                "ALTER TABLE payments ADD INDEX payments_user_idx GLOBAL ON (user_id);",
            )
            print("Added payments_user_idx")
        else:
            print("payments_user_idx already exists")
    finally:
        driver.stop()


if __name__ == "__main__":
    main()
