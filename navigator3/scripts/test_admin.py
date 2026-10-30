"""Проверки /api/admin — редактора через шлюз, без YDB и сети.

Запуск:
    python3 navigator3/scripts/test_admin.py
"""

import json
import os
import sys
import unittest
import unittest.mock
from pathlib import Path

os.environ.setdefault("PUBLIC_BASE_URL", "https://d5dtest.apigw.yandexcloud.net")
os.environ.setdefault("YANDEX_CLIENT_ID", "test-client-id")
os.environ.setdefault("YANDEX_CLIENT_SECRET", "test-client-secret")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import handler  # noqa: E402


class Row:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class FakeResult:
    def __init__(self, rows):
        self.rows = rows


class FakePool:
    def __init__(self):
        self.calls = []
        self.folders = [
            Row(
                folder_id="f_root",
                parent_id="",
                name="Категория",
                access="public",
                price_kopecks=0,
                sku="",
                sort_order=0,
            ),
            Row(
                folder_id="f_paid",
                parent_id="f_root",
                name="Платно",
                access="paid",
                price_kopecks=50000,
                sku="paid-sku",
                sort_order=0,
            ),
        ]
        self.routes = [
            Row(
                m="route-1",
                folder_id="f_root",
                title="Маршрут",
                name="Категория/Маршрут",
                description="Описание",
                visible=True,
                access="folder",
                price_kopecks=0,
                sku="",
                json="[]",
            ),
            Row(
                m="route-2",
                folder_id="",
                title="Скрытый",
                name="Скрытый",
                description="",
                visible=False,
                access="folder",
                price_kopecks=0,
                sku="",
                json="[]",
            ),
        ]
        self.entitlements = []
        self.users = [
            Row(
                yandex_id="y1",
                user_id="u1",
                login="user",
                email="user@example.com",
                display_name="User",
                blocked=False,
            )
        ]
        self.orders = []

    def retry_operation_sync(self, operation, **kwargs):
        self.calls.append((operation.__name__, kwargs))
        name = operation.__name__
        if name == "execute_list_folders":
            return [FakeResult(self.folders)]
        if name == "execute_list_editor_routes":
            return [FakeResult(self.routes)]
        if name == "execute_list_public_routes":
            return [FakeResult([row for row in self.routes if row.visible])]
        if name in {"execute_get_route", "execute_get_public_route"}:
            m_param = kwargs.get("m_param")
            return [FakeResult([row for row in self.routes if row.m == m_param])]
        if name in {
            "execute_upsert_route",
            "execute_update_route_meta",
            "execute_rename_route",
            "execute_update_route_name",
            "execute_delete_route",
            "execute_upsert_folder",
            "execute_delete_folder",
            "execute_grant_entitlement",
            "execute_revoke_entitlement",
            "execute_insert_order",
            "execute_update_order",
        }:
            return [FakeResult([])]
        if name == "execute_list_entitlements":
            return [
                FakeResult(
                    [
                        Row(
                            entitlement=item,
                            created_at=None,
                            source="manual",
                            order_id="",
                        )
                        for item in self.entitlements
                    ]
                )
            ]
        if name == "execute_find_user":
            value = kwargs.get("value")
            found = [
                user
                for user in self.users
                if value in {user.user_id, user.yandex_id, user.login, user.email}
            ]
            return [FakeResult(found[:1])]
        if name == "execute_list_users":
            return [FakeResult(self.users)]
        if name == "execute_list_orders":
            return [FakeResult(self.orders)]
        if name == "execute_get_order":
            order_id = kwargs.get("order_id")
            return [FakeResult([o for o in self.orders if o.order_id == order_id])]
        raise AssertionError(f"unexpected operation: {name}")

    def called(self, name):
        return [kwargs for call_name, kwargs in self.calls if call_name == name]


def event(path, method="POST", query=None, headers=None, body=""):
    return {
        "rawPath": path,
        "requestContext": {
            "http": {
                "method": method,
                "path": path,
                "sourceIp": "203.0.113.10",
                "userAgent": "unit-test",
            }
        },
        "queryStringParameters": query or {},
        "cookies": [],
        "headers": headers or {},
        "body": body,
    }


class AdminApiTests(unittest.TestCase):
    def setUp(self):
        os.environ["ROUTE_ADMIN_PASSWORD"] = "test-password"
        self.pool = FakePool()
        self.patch = unittest.mock.patch.object(
            handler.store, "get_pool", return_value=self.pool
        )
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        os.environ.pop("ROUTE_ADMIN_PASSWORD", None)

    def admin(self, action, query=None, body=None):
        return handler.handler(
            event(
                "/api/admin",
                query={"action": action, **(query or {})},
                headers={"X-Route-Admin-Password": "test-password"},
                body=json.dumps(body) if body is not None else "",
            ),
            None,
        )

    def test_list_routes_and_folders(self):
        response = self.admin("list")
        self.assertEqual(response["statusCode"], 200)
        payload = json.loads(response["body"])
        routes = payload["routes"]
        self.assertEqual(len(routes), 2)
        self.assertEqual(routes[0]["m"], "route-1")
        self.assertEqual(routes[0]["title"], "Маршрут")
        self.assertEqual(routes[0]["folder_id"], "f_root")
        self.assertEqual(routes[0]["name"], "Категория/Маршрут")
        self.assertFalse(routes[1]["visible"])
        self.assertEqual(
            [folder["folder_id"] for folder in payload["folders"]],
            ["f_root", "f_paid"],
        )
        paid = payload["folders"][1]
        self.assertEqual(paid["access"], "paid")
        self.assertEqual(paid["price_kopecks"], 50000)

    def test_list_requires_password(self):
        response = handler.handler(event("/api/admin", query={"action": "list"}), None)
        self.assertEqual(response["statusCode"], 403)
        self.assertEqual(self.pool.calls, [])

    def test_auth_rejects_wrong_password(self):
        response = handler.handler(
            event(
                "/api/admin",
                query={"action": "auth"},
                headers={"X-Route-Admin-Password": "wrong"},
            ),
            None,
        )
        self.assertEqual(response["statusCode"], 403)
        self.assertEqual(json.loads(response["body"])["error"], "invalid_admin_password")

    def test_auth_accepts_correct_password(self):
        response = handler.handler(
            event(
                "/api/admin",
                query={"action": "auth"},
                headers={"x-route-admin-password": "test-password"},
            ),
            None,
        )
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"])["status"], "authenticated")

    def test_save_requires_password(self):
        response = handler.handler(
            event(
                "/api/admin",
                query={"action": "save", "m": "route-1"},
                body=json.dumps({"data": []}),
            ),
            None,
        )
        self.assertEqual(response["statusCode"], 403)
        self.assertEqual(self.pool.calls, [])

    def test_save_with_password(self):
        data = [{"pts": [[55.0, 37.0]], "color": "Gold"}]
        response = self.admin("save", {"m": "route-1"}, {"data": data})
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"])["status"], "saved")
        kwargs = self.pool.called("execute_upsert_route")[0]
        self.assertEqual(kwargs["m_param"], "route-1")
        self.assertEqual(kwargs["json_data"], data)

    def test_get_meta(self):
        response = self.admin("get_meta", {"m": "route-1"})
        self.assertEqual(response["statusCode"], 200)
        payload = json.loads(response["body"])
        self.assertEqual(payload["title"], "Маршрут")
        self.assertEqual(payload["name"], "Категория/Маршрут")
        self.assertEqual(payload["description"], "Описание")
        self.assertTrue(payload["visible"])
        self.assertEqual(payload["folder_id"], "f_root")

    def test_save_meta_builds_full_name(self):
        response = self.admin(
            "save_meta",
            {"m": "route-1"},
            {
                "title": "Новый",
                "folder_id": "f_paid",
                "description": "Текст",
                "visible": True,
                "access": "folder",
            },
        )
        self.assertEqual(response["statusCode"], 200)
        kwargs = self.pool.called("execute_update_route_meta")[0]
        self.assertEqual(kwargs["title"], "Новый")
        self.assertEqual(kwargs["folder_id"], "f_paid")
        self.assertEqual(kwargs["name"], "Категория/Платно/Новый")

    def test_save_meta_rejects_unknown_folder(self):
        response = self.admin(
            "save_meta",
            {"m": "route-1"},
            {"title": "Новый", "folder_id": "missing"},
        )
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(json.loads(response["body"])["error"], "unknown_folder")

    def test_save_meta_rejects_unknown_route(self):
        response = self.admin("save_meta", {"m": "missing"}, {"title": "X"})
        self.assertEqual(response["statusCode"], 404)

    def test_folder_save_creates_folder(self):
        response = self.admin(
            "folder_save",
            body={
                "parent_id": "f_root",
                "name": "Новая",
                "access": "paid",
                "price_kopecks": 99000,
                "sku": "sku-1",
            },
        )
        self.assertEqual(response["statusCode"], 200)
        payload = json.loads(response["body"])
        self.assertEqual(payload["status"], "folder_saved")
        self.assertEqual(payload["folder"]["parent_id"], "f_root")
        self.assertEqual(payload["folder"]["name"], "Новая")
        kwargs = self.pool.called("execute_upsert_folder")[0]
        self.assertEqual(kwargs["access"], "paid")
        self.assertEqual(kwargs["price_kopecks"], 99000)

    def test_folder_save_rejects_cycle(self):
        response = self.admin(
            "folder_save",
            body={"folder_id": "f_root", "parent_id": "f_paid", "name": "Категория"},
        )
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(json.loads(response["body"])["error"], "folder_cycle")

    def test_folder_save_rejects_unknown_parent(self):
        response = self.admin(
            "folder_save",
            body={"parent_id": "missing", "name": "Новая"},
        )
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(json.loads(response["body"])["error"], "unknown_parent")

    def test_folder_delete_rejects_non_empty(self):
        response = self.admin("folder_delete", body={"folder_id": "f_root"})
        self.assertEqual(response["statusCode"], 409)
        self.assertEqual(json.loads(response["body"])["error"], "folder_has_children")

    def test_folder_delete_empty_folder(self):
        response = self.admin("folder_delete", body={"folder_id": "f_paid"})
        self.assertEqual(response["statusCode"], 200)
        kwargs = self.pool.called("execute_delete_folder")[0]
        self.assertEqual(kwargs["folder_id"], "f_paid")

    def test_grant_entitlement(self):
        response = self.admin(
            "grant", body={"user": "user", "folder_id": "f_paid"}
        )
        self.assertEqual(response["statusCode"], 200)
        payload = json.loads(response["body"])
        self.assertEqual(payload["entitlement"], "folder:f_paid")
        self.assertEqual(payload["status"], "granted")
        kwargs = self.pool.called("execute_grant_entitlement")[0]
        self.assertEqual(kwargs["user_id"], "u1")
        self.assertEqual(kwargs["source"], "manual")

    def test_revoke_entitlement(self):
        response = self.admin(
            "revoke", body={"user": "user", "entitlement": "folder:f_paid"}
        )
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"])["status"], "revoked")
        kwargs = self.pool.called("execute_revoke_entitlement")[0]
        self.assertEqual(kwargs["entitlement"], "folder:f_paid")

    def test_grant_rejects_unknown_user(self):
        response = self.admin("grant", body={"user": "ghost", "folder_id": "f_paid"})
        self.assertEqual(response["statusCode"], 404)
        self.assertEqual(json.loads(response["body"])["error"], "user_not_found")

    def test_entitlements_for_user(self):
        self.pool.entitlements = ["folder:f_paid"]
        response = self.admin("entitlements", body={"user": "user"})
        self.assertEqual(response["statusCode"], 200)
        payload = json.loads(response["body"])
        self.assertEqual(
            [item["entitlement"] for item in payload["entitlements"]],
            ["folder:f_paid"],
        )

    def test_users(self):
        response = self.admin("users")
        self.assertEqual(response["statusCode"], 200)
        users = json.loads(response["body"])["users"]
        self.assertEqual(users[0]["user_id"], "u1")
        self.assertEqual(users[0]["login"], "user")

    def test_unknown_action(self):
        response = self.admin("drop_table")
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(json.loads(response["body"])["error"], "unknown_action")


if __name__ == "__main__":
    unittest.main(verbosity=2)
