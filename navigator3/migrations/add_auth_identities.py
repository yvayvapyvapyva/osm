#!/usr/bin/env python3
"""Идентичности пользователей: Яндекс и Telegram на один аккаунт.

- user_identities (provider, external_id) -> users.user_id
- users.avatar_url — аватар из Telegram
- payments.stars / charge_id — оплата звёздами Telegram
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


def _add_column(pool, database, table, column, sql_type):
    description = _describe(pool, database, table)
    columns = {c.name for c in description.columns}
    if column in columns:
        print(f"{table}.{column} already exists")
        return
    _execute_scheme(pool, f"ALTER TABLE {table} ADD COLUMN {column} {sql_type};")
    print(f"Added {table}.{column}")


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

        if not _table_exists(pool, database, "user_identities"):
            _execute_scheme(
                pool,
                """
                CREATE TABLE user_identities (
                    provider    Utf8,
                    external_id Utf8,
                    user_id     Utf8,
                    created_at  Timestamp,
                    PRIMARY KEY (provider, external_id)
                );
                """,
            )
            print("Created user_identities")
        else:
            print("user_identities already exists")

        _add_column(pool, database, "users", "avatar_url", "Utf8")
        _add_column(pool, database, "payments", "stars", "Uint64")
        _add_column(pool, database, "payments", "charge_id", "Utf8")

        description = _describe(pool, database, "payments")
        indexes = {
            getattr(index, "name", "") for index in getattr(description, "indexes", [])
        }
        if "payments_charge_idx" not in indexes:
            _execute_scheme(
                pool,
                "ALTER TABLE payments ADD INDEX payments_charge_idx GLOBAL ON (charge_id);",
            )
            print("Added payments_charge_idx")
        else:
            print("payments_charge_idx already exists")

        # Существующие аккаунты считаем яндекс-идентичностями.
        def select_users(session):
            prepared = session.prepare(
                """
                SELECT yandex_id, user_id, created_at
                FROM users;
                """
            )
            return session.transaction().execute(prepared, {}, commit_tx=True)

        rows = pool.retry_operation_sync(select_users)[0].rows
        for row in rows:
            yandex_id = str(getattr(row, "yandex_id", "") or "")
            user_id = str(getattr(row, "user_id", "") or "")
            if not yandex_id or not user_id:
                continue

            def insert(session, yandex_id=yandex_id, user_id=user_id, created_at=getattr(row, "created_at", None)):
                prepared = session.prepare(
                    """
                    DECLARE $provider AS Utf8;
                    DECLARE $external_id AS Utf8;
                    DECLARE $user_id AS Utf8;
                    DECLARE $created_at AS Timestamp;
                    UPSERT INTO user_identities
                        (provider, external_id, user_id, created_at)
                    VALUES
                        ($provider, $external_id, $user_id, $created_at);
                    """
                )
                return session.transaction().execute(
                    prepared,
                    {
                        "$provider": "yandex",
                        "$external_id": yandex_id,
                        "$user_id": user_id,
                        "$created_at": created_at,
                    },
                    commit_tx=True,
                )

            pool.retry_operation_sync(insert)

        print(f"Backfilled {len(rows)} yandex identities")
    finally:
        driver.stop()


if __name__ == "__main__":
    main()
