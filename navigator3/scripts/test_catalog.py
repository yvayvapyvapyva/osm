"""Локальные проверки /api/catalog и /api/route без YDB и сети.

Запуск:
    python3 navigator3/scripts/test_catalog.py
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

ROUTE_JSON = [
    {
        "pts": [[55.0, 37.0], [55.001, 37.002]],
        "color": "Gold",
        "id": 1,
    },
    {
        "pts": [[55.01, 37.01]],
        "color": "Blue",
        "id": 2,
    },
]


class Row:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def folder(folder_id, parent_id, name, access="public", price=0, sku=""):
    return Row(
        folder_id=folder_id,
        parent_id=parent_id,
        name=name,
        access=access,
        price_kopecks=price,
        sku=sku,
        sort_order=0,
    )


def route(m, folder_id, title, access="folder"):
    return Row(
        m=m,
        folder_id=folder_id,
        title=title,
        name=title,
        description="",
        visible=True,
        access=access,
        price_kopecks=0,
        sku="",
        json=json.dumps(ROUTE_JSON, ensure_ascii=False),
    )


FOLDERS = [
    folder("f_root", "", "Категория"),
    folder("f_paid", "f_root", "Платно", access="paid", price=50000, sku="paid-sku"),
    folder("f_child", "f_paid", "Экзамен"),
]

ROUTES = [
    route("route-1", "f_root", "Маршрут"),
    route("route-2", "f_child", "Платный"),
    route("route-3", "f_child", "Открытый", access="public"),
]

USER = {"user_id": "u1", "login": "user", "display_name": "User", "email": ""}


class FakeResult:
    def __init__(self, rows):
        self.rows = rows


class FakePool:
    def __init__(self, entitlements=()):
        self.entitlements = list(entitlements)

    def retry_operation_sync(self, operation, **kwargs):
        name = operation.__name__
        if name == "execute_list_folders":
            return [FakeResult(FOLDERS)]
        if name in {"execute_list_public_routes", "execute_list_editor_routes"}:
            return [FakeResult(ROUTES)]
        if name in {"execute_get_public_route", "execute_get_route"}:
            m_param = kwargs.get("m_param")
            return [FakeResult([row for row in ROUTES if row.m == m_param])]
        if name == "execute_list_entitlements":
            return [
                FakeResult(
                    [
                        Row(
                            entitlement=value,
                            created_at=None,
                            source="test",
                            order_id="",
                        )
                        for value in self.entitlements
                    ]
                )
            ]
        raise AssertionError(f"unexpected operation: {name}")


def event(path, method="GET", query=None):
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
        "headers": {},
        "body": "",
    }


class CatalogTestBase(unittest.TestCase):
    entitlements = ()

    def setUp(self):
        self.pool = FakePool(self.entitlements)
        self.patch_pool = unittest.mock.patch.object(
            handler.store, "get_pool", return_value=self.pool
        )
        self.patch_pool.start()
        self.patch_user = unittest.mock.patch.object(
            handler, "_current_user", return_value=USER if self.entitlements else None
        )
        self.patch_user.start()

    def tearDown(self):
        self.patch_user.stop()
        self.patch_pool.stop()

    def catalog(self):
        response = handler.handler(event("/api/catalog"), None)
        self.assertEqual(response["statusCode"], 200)
        return json.loads(response["body"])


class AnonymousCatalogTests(CatalogTestBase):
    def test_catalog_has_folders_and_no_geometry(self):
        payload = self.catalog()
        self.assertEqual(len(payload["routes"]), 3)
        self.assertEqual(
            [folder["folder_id"] for folder in payload["folders"]],
            ["f_root", "f_paid", "f_child"],
        )

        routes = {route["m"]: route for route in payload["routes"]}
        self.assertEqual(routes["route-1"]["name"], "Категория/Маршрут")
        self.assertEqual(routes["route-2"]["name"], "Категория/Платно/Экзамен/Платный")
        self.assertEqual(routes["route-2"]["title"], "Платный")
        self.assertEqual(routes["route-2"]["access"], "paid")
        self.assertFalse(routes["route-2"]["owned"])
        self.assertEqual(routes["route-2"]["purchase_folder_id"], "f_paid")
        self.assertEqual(routes["route-2"]["price_kopecks"], 50000)
        self.assertEqual(routes["route-3"]["access"], "public")
        self.assertTrue(routes["route-3"]["owned"])
        self.assertEqual(routes["route-1"]["point_count"], 2)
        self.assertGreater(routes["route-1"]["distance_meters"], 0)
        for item in payload["routes"]:
            self.assertNotIn("data", item)
            self.assertNotIn("json", item)

        paid = next(f for f in payload["folders"] if f["folder_id"] == "f_paid")
        self.assertEqual(paid["access"], "paid")
        self.assertFalse(paid["owned"])
        self.assertEqual(paid["purchase_folder_id"], "f_paid")
        self.assertEqual(paid["price_kopecks"], 50000)

    def test_catalog_trailing_slash(self):
        response = handler.handler(event("/api/catalog/"), None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")

    def test_route_returns_geometry_for_free_route(self):
        response = handler.handler(
            event("/api/route", query={"m": "route-1"}), None
        )
        self.assertEqual(response["statusCode"], 200)
        payload = json.loads(response["body"])
        self.assertEqual(payload["m"], "route-1")
        self.assertEqual(payload["name"], "Категория/Маршрут")
        self.assertEqual(payload["access"], "public")
        self.assertTrue(payload["owned"])
        self.assertEqual(payload["point_count"], 2)
        self.assertIsInstance(payload["data"], list)
        self.assertEqual(payload["data"][0]["pts"][0], [55.0, 37.0])

    def test_public_route_inside_paid_folder_is_open(self):
        response = handler.handler(
            event("/api/route", query={"m": "route-3"}), None
        )
        self.assertEqual(response["statusCode"], 200)

    def test_paid_route_requires_payment(self):
        response = handler.handler(
            event("/api/route", query={"m": "route-2"}), None
        )
        self.assertEqual(response["statusCode"], 401)
        payload = json.loads(response["body"])
        self.assertEqual(payload["error"], "unauthorized")
        self.assertEqual(payload["purchase_folder_id"], "f_paid")
        self.assertEqual(payload["price_kopecks"], 50000)

    def test_route_without_m(self):
        response = handler.handler(event("/api/route"), None)
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(json.loads(response["body"])["error"], "missing_route_name")

    def test_route_not_found(self):
        response = handler.handler(
            event("/api/route", query={"m": "missing"}), None
        )
        self.assertEqual(response["statusCode"], 404)
        self.assertEqual(json.loads(response["body"])["error"], "route_not_found")

    def test_metrics_ignore_bad_points(self):
        metrics = handler._route_metrics(
            [
                {"pts": [[91, 37], [55, 181]]},
                {"pts": [[55, 37], [55, 37]]},
                "not a segment",
            ]
        )
        self.assertEqual(metrics["point_count"], 1)
        self.assertEqual(metrics["distance_meters"], 0)


class PaidCatalogTests(CatalogTestBase):
    entitlements = ("folder:f_paid",)

    def test_paid_folder_is_owned_after_purchase(self):
        payload = self.catalog()
        routes = {route["m"]: route for route in payload["routes"]}
        self.assertTrue(routes["route-2"]["owned"])
        self.assertEqual(routes["route-2"]["purchase_folder_id"], "")

        paid = next(f for f in payload["folders"] if f["folder_id"] == "f_paid")
        self.assertTrue(paid["owned"])
        child = next(f for f in payload["folders"] if f["folder_id"] == "f_child")
        self.assertTrue(child["owned"])

    def test_paid_route_returns_geometry(self):
        response = handler.handler(
            event("/api/route", query={"m": "route-2"}), None
        )
        self.assertEqual(response["statusCode"], 200)
        payload = json.loads(response["body"])
        self.assertTrue(payload["owned"])
        self.assertIsInstance(payload["data"], list)

    def test_all_entitlement_opens_paid_folder(self):
        self.pool.entitlements = ["all"]
        response = handler.handler(
            event("/api/route", query={"m": "route-2"}), None
        )
        self.assertEqual(response["statusCode"], 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
