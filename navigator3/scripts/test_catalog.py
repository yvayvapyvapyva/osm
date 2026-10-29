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
    def __init__(self, m, name, description, data):
        self.m = m
        self.name = name
        self.description = description
        self.json = json.dumps(data, ensure_ascii=False)


ROW = Row("route-1", "Категория/Маршрут", "Описание", ROUTE_JSON)


class FakeResult:
    def __init__(self, rows):
        self.rows = rows


class FakePool:
    def retry_operation_sync(self, operation, **kwargs):
        m_param = kwargs.get("m_param")
        if m_param is None:
            return [FakeResult([ROW])]
        return [FakeResult([ROW] if m_param == "route-1" else [])]


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


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.patch = unittest.mock.patch.object(
            handler.store, "get_pool", return_value=FakePool()
        )
        self.patch.start()

    def tearDown(self):
        self.patch.stop()

    def test_catalog_has_no_geometry(self):
        response = handler.handler(event("/api/catalog"), None)
        self.assertEqual(response["statusCode"], 200)
        payload = json.loads(response["body"])
        self.assertEqual(len(payload["routes"]), 1)

        route = payload["routes"][0]
        self.assertEqual(route["m"], "route-1")
        self.assertEqual(route["name"], "Категория/Маршрут")
        self.assertEqual(route["access"], "public")
        self.assertEqual(route["point_count"], 2)
        self.assertGreater(route["distance_meters"], 0)
        self.assertNotIn("data", route)
        self.assertNotIn("json", route)
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")

    def test_catalog_trailing_slash(self):
        response = handler.handler(event("/api/catalog/"), None)
        self.assertEqual(response["statusCode"], 200)

    def test_route_returns_geometry(self):
        response = handler.handler(
            event("/api/route", query={"m": "route-1"}), None
        )
        self.assertEqual(response["statusCode"], 200)
        payload = json.loads(response["body"])
        self.assertEqual(payload["m"], "route-1")
        self.assertEqual(payload["name"], "Категория/Маршрут")
        self.assertEqual(payload["access"], "public")
        self.assertEqual(payload["point_count"], 2)
        self.assertIsInstance(payload["data"], list)
        self.assertEqual(payload["data"][0]["pts"][0], [55.0, 37.0])

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
