#!/usr/bin/env python3
"""Assign existing routes and folders to a Yandex user and add owner indexes."""

import argparse
import os
import subprocess

import ydb


TABLES = {
    "roads": ("m", "roads_owner_idx"),
    "folders": ("folder_id", "folders_owner_idx"),
}


def _describe(pool, database, table):
    return pool.retry_operation_sync(
        lambda session: session.describe_table(f"{database}/{table}")
    )


def _table_rows(pool, table, key_column):
    query = f"SELECT {key_column}, owner_user_id FROM {table};"
    return pool.retry_operation_sync(
        lambda session: session.transaction().execute(query, commit_tx=True)[0].rows
    )


def _backfill_owner(pool, table, key_column, keys, owner_user_id):
    query = f"""
        DECLARE $key AS Utf8;
        DECLARE $owner_user_id AS Utf8;
        UPDATE {table}
        SET owner_user_id = $owner_user_id
        WHERE {key_column} = $key AND owner_user_id IS NULL;
    """
    for key in keys:
        def update(session, value):
            prepared = session.prepare(query)
            return session.transaction().execute(
                prepared,
                {"$key": str(value), "$owner_user_id": owner_user_id},
                commit_tx=True,
            )

        pool.retry_operation_sync(
            lambda session, value=key: update(session, value)
        )


def _index_names(description):
    return {getattr(index, "name", "") for index in getattr(description, "indexes", [])}


def _add_owner_index(pool, table, index_name):
    session = pool.acquire()
    try:
        session.execute_scheme(
            f"ALTER TABLE {table} ADD INDEX {index_name} GLOBAL ON (owner_user_id);"
        )
    finally:
        pool.release(session)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-login", required=True)
    args = parser.parse_args()

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
        query = """
            DECLARE $login AS Utf8;
            SELECT user_id, blocked FROM users WHERE login = $login;
        """

        def find_owner(session):
            prepared = session.prepare(query)
            return session.transaction().execute(
                prepared, {"$login": args.owner_login}, commit_tx=True
            )[0].rows

        users = pool.retry_operation_sync(find_owner)
        if len(users) != 1 or users[0].blocked:
            raise RuntimeError("The owner login must match one unblocked Yandex user")
        owner_user_id = str(users[0].user_id)

        for table, (key_column, index_name) in TABLES.items():
            description = _describe(pool, database, table)
            columns = {column.name for column in description.columns}
            if "owner_user_id" not in columns:
                session = pool.acquire()
                try:
                    session.execute_scheme(
                        f"ALTER TABLE {table} ADD COLUMN owner_user_id Utf8;"
                    )
                finally:
                    pool.release(session)

            rows = _table_rows(pool, table, key_column)
            conflicting = [
                row for row in rows
                if row.owner_user_id not in (None, "", owner_user_id)
            ]
            if conflicting:
                raise RuntimeError(
                    f"{table} already contains rows owned by another user"
                )
            unassigned_keys = [
                getattr(row, key_column)
                for row in rows
                if not row.owner_user_id
            ]
            _backfill_owner(
                pool, table, key_column, unassigned_keys, owner_user_id
            )

            if index_name not in _index_names(_describe(pool, database, table)):
                _add_owner_index(pool, table, index_name)

            verified = _table_rows(pool, table, key_column)
            if any(row.owner_user_id != owner_user_id for row in verified):
                raise RuntimeError(f"Ownership verification failed for {table}")
            print(f"{table}: assigned {len(verified)} rows to the selected owner")
    finally:
        driver.stop()


if __name__ == "__main__":
    main()
