#!/usr/bin/env python3
"""Drop the denormalized roads.name column from YDB."""

import os
import subprocess

import ydb


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
        table_path = f"{database}/roads"
        description = pool.retry_operation_sync(
            lambda session: session.describe_table(table_path)
        )
        if "name" in {column.name for column in description.columns}:
            session = pool.acquire()
            try:
                session.execute_scheme("ALTER TABLE roads DROP COLUMN name;")
            finally:
                pool.release(session)

        updated = pool.retry_operation_sync(
            lambda session: session.describe_table(table_path)
        )
        if "name" in {column.name for column in updated.columns}:
            raise RuntimeError("roads.name is still present after migration")
        print("Verified: roads.name is absent")
    finally:
        driver.stop()


if __name__ == "__main__":
    main()
