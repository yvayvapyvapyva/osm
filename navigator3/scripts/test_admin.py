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

    def retry_operation_sync(self, operation, **kwargs):
        self.calls.append((operation.__name__, kwargs))
        name = operation.__name__
        if name == "execute_list_editor_routes":
            return [
                FakeResult(
                    [
                        Row(m="route-1", name="Категория/Маршрут", visible=True),
                        Row(m="route-2", name="Скрытый", visible=False),
                    ]
                )
            ]
        if name == "execute_get_route_meta":
            return [
                FakeResult(
                    [
                        Row(
                            name="Категория/Маршрут",
                            description="Описание",
                            visible=True,
                        )
                    ]
                )
            ]
        if name in {
            "execute_upsert_route",
            "execute_update_route_meta",
            "execute_delete_route",
        }:
            return [FakeResult([])]
        raise AssertionError(f"unexpected operation: {name}")


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

    def test_list_routes(self):
        response = handler.handler(
            event(
                "/api/admin",
                query={"action": "list"},
                headers={"X-Route-Admin-Password": "test-password"},
            ),
            None,
        )
        self.assertEqual(response["statusCode"], 200)
        routes = json.loads(response["body"])["routes"]
        self.assertEqual(len(routes), 2)
        self.assertEqual(routes[0], {"m": "route-1", "name": "Категория/Маршрут", "visible": True})
        self.assertFalse(routes[1]["visible"])

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
        response = handler.handler(
            event(
                "/api/admin",
                query={"action": "save", "m": "route-1"},
                headers={"X-Route-Admin-Password": "test-password"},
                body=json.dumps({"data": data}),
            ),
            None,
        )
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"])["status"], "saved")
        name, kwargs = self.pool.calls[0]
        self.assertEqual(name, "execute_upsert_route")
        self.assertEqual(kwargs["m_param"], "route-1")
        self.assertEqual(kwargs["json_data"], data)

    def test_get_meta(self):
        response = handler.handler(
            event(
                "/api/admin",
                query={"action": "get_meta", "m": "route-1"},
                headers={"X-Route-Admin-Password": "test-password"},
            ),
            None,
        )
        self.assertEqual(response["statusCode"], 200)
        payload = json.loads(response["body"])
        self.assertEqual(payload["name"], "Категория/Маршрут")
        self.assertEqual(payload["description"], "Описание")
        self.assertTrue(payload["visible"])

    def test_unknown_action(self):
        response = handler.handler(
            event(
                "/api/admin",
                query={"action": "drop_table"},
                headers={"X-Route-Admin-Password": "test-password"},
            ),
            None,
        )
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(json.loads(response["body"])["error"], "unknown_action")


if __name__ == "__main__":
    unittest.main(verbosity=2)
