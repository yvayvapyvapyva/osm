#!/usr/bin/env python3
"""Название папки с маршрутами владельца.

Отдельно от display_name: имя аккаунта остаётся из Яндекс-профиля,
а папку в каталоге можно переименовать.
"""

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
        users = pool.retry_operation_sync(
            lambda session: session.describe_table(f"{database}/users")
        )
        columns = {column.name for column in users.columns}
        if "routes_folder_name" not in columns:
            session = pool.acquire()
            try:
                session.execute_scheme(
                    "ALTER TABLE users ADD COLUMN routes_folder_name Utf8;"
                )
            finally:
                pool.release(session)
            print("Added users.routes_folder_name")
        else:
            print("users.routes_folder_name already exists")
    finally:
        driver.stop()


if __name__ == "__main__":
    main()
