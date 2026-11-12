#!/usr/bin/env python3
"""Add the roads.premium flag used for premium (locked) routes."""

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
        description = pool.retry_operation_sync(
            lambda session: session.describe_table(f"{database}/roads")
        )
        columns = {column.name for column in description.columns}
        if "premium" in columns:
            print("roads.premium already exists")
            return
        session = pool.acquire()
        try:
            session.execute_scheme("ALTER TABLE roads ADD COLUMN premium Bool;")
        finally:
            pool.release(session)
        print("Added roads.premium")
    finally:
        driver.stop()


if __name__ == "__main__":
    main()
