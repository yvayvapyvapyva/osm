"""Проверки заказов и webhook ЮKassa без сети и YDB.

Запуск:
    python3 navigator3/scripts/test_payments.py
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
os.environ["YOOKASSA_SHOP_ID"] = "test-shop"
os.environ["YOOKASSA_SECRET_KEY"] = "test-secret"

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import handler  # noqa: E402

USER = {"user_id": "u1", "login": "user", "display_name": "User", "email": ""}


class Row:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class FakeResult:
    def __init__(self, rows):
        self.rows = rows


FOLDERS = [
    Row(
        folder_id="f_paid",
        parent_id="",
        name="Платно",
        access="paid",
        price_kopecks=50000,
        sku="paid-sku",
        sort_order=0,
    )
]


class FakePool:
    def __init__(self):
        self.calls = []
        self.orders = {}

    def retry_operation_sync(self, operation, **kwargs):
        self.calls.append((operation.__name__, kwargs))
        name = operation.__name__
        if name == "execute_list_folders":
            return [FakeResult(FOLDERS)]
        if name == "execute_list_editor_routes":
            return [FakeResult([])]
        if name == "execute_list_entitlements":
            return [FakeResult([])]
        if name == "execute_insert_order":
            self.orders[kwargs["order_id"]] = Row(
                order_id=kwargs["order_id"],
                user_id=kwargs["user_id"],
                folder_id=kwargs["folder_id"],
                amount_kopecks=kwargs["amount_kopecks"],
                status=kwargs["status"],
                payment_id=kwargs["payment_id"],
                return_path=kwargs["return_path"],
                created_at=None,
                updated_at=None,
            )
            return [FakeResult([])]
        if name == "execute_update_order":
            order = self.orders.get(kwargs["order_id"])
            if order is not None:
                order.status = kwargs["status"]
                if kwargs.get("payment_id"):
                    order.payment_id = kwargs["payment_id"]
            return [FakeResult([])]
        if name == "execute_get_order":
            order = self.orders.get(kwargs["order_id"])
            return [FakeResult([order] if order else [])]
        if name == "execute_grant_entitlement":
            return [FakeResult([])]
        raise AssertionError(f"unexpected operation: {name}")

    def called(self, name):
        return [kwargs for call_name, kwargs in self.calls if call_name == name]


def event(path, method="POST", body=None, headers=None):
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
        "queryStringParameters": {},
        "cookies": [],
        "headers": headers or {"origin": "https://d5dtest.apigw.yandexcloud.net"},
        "body": json.dumps(body) if body is not None else "",
    }


class PaymentTests(unittest.TestCase):
    def setUp(self):
        self.pool = FakePool()
        self.patch_pool = unittest.mock.patch.object(
            handler.store, "get_pool", return_value=self.pool
        )
        self.patch_user = unittest.mock.patch.object(
            handler, "_current_user", return_value=USER
        )
        self.patch_create = unittest.mock.patch.object(
            handler.payments,
            "create_payment",
            return_value={
                "payment_id": "pay-1",
                "status": "pending",
                "confirmation_url": "https://yookassa.test/pay-1",
            },
        )
        self.patch_fetch = unittest.mock.patch.object(
            handler.payments, "fetch_payment"
        )
        self.patch_pool.start()
        self.patch_user.start()
        self.patch_create.start()
        self.fetch = self.patch_fetch.start()

    def tearDown(self):
        self.patch_fetch.stop()
        self.patch_create.stop()
        self.patch_user.stop()
        self.patch_pool.stop()

    def create_order(self, folder_id="f_paid"):
        response = handler.handler(
            event("/api/orders", body={"folder_id": folder_id, "return": "/"}),
            None,
        )
        return response

    def webhook(self, event_type, payment):
        self.fetch.return_value = payment
        return handler.handler(
            event(
                "/api/yookassa/notify",
                body={"event": event_type, "object": {"id": payment["id"]}},
            ),
            None,
        )

    def test_order_requires_login(self):
        self.patch_user.stop()
        with unittest.mock.patch.object(handler, "_current_user", return_value=None):
            response = self.create_order()
        self.assertEqual(response["statusCode"], 401)
        self.patch_user.start()

    def test_order_requires_payments_configured(self):
        with unittest.mock.patch.object(
            handler.payments, "configured", return_value=False
        ):
            response = self.create_order()
        self.assertEqual(response["statusCode"], 503)
        self.assertEqual(
            json.loads(response["body"])["error"], "payments_not_configured"
        )

    def test_order_rejects_free_folder(self):
        with unittest.mock.patch.object(
            handler, "_folder_access_info", return_value={"access": "public"}
        ):
            response = self.create_order()
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(json.loads(response["body"])["error"], "folder_is_free")

    def test_order_creates_payment(self):
        response = self.create_order()
        self.assertEqual(response["statusCode"], 200)
        payload = json.loads(response["body"])
        self.assertEqual(payload["confirmation_url"], "https://yookassa.test/pay-1")
        insert = self.pool.called("execute_insert_order")[0]
        self.assertEqual(insert["amount_kopecks"], 50000)
        self.assertEqual(insert["folder_id"], "f_paid")
        self.assertEqual(insert["status"], "pending")
        update = self.pool.called("execute_update_order")[0]
        self.assertEqual(update["payment_id"], "pay-1")

    def test_webhook_grants_entitlement(self):
        self.create_order()
        order_id = next(iter(self.pool.orders))
        response = self.webhook(
            "payment.succeeded",
            {
                "id": "pay-1",
                "status": "succeeded",
                "paid": True,
                "amount": {"value": "500.00", "currency": "RUB"},
                "metadata": {"order_id": order_id},
            },
        )
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"])["status"], "paid")
        self.assertEqual(self.pool.orders[order_id].status, "paid")
        grant = self.pool.called("execute_grant_entitlement")[0]
        self.assertEqual(grant["user_id"], "u1")
        self.assertEqual(grant["entitlement"], "folder:f_paid")
        self.assertEqual(grant["source"], "yookassa")

    def test_webhook_rejects_amount_mismatch(self):
        self.create_order()
        order_id = next(iter(self.pool.orders))
        response = self.webhook(
            "payment.succeeded",
            {
                "id": "pay-1",
                "status": "succeeded",
                "paid": True,
                "amount": {"value": "1.00", "currency": "RUB"},
                "metadata": {"order_id": order_id},
            },
        )
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(json.loads(response["body"])["error"], "amount_mismatch")
        self.assertEqual(self.pool.called("execute_grant_entitlement"), [])

    def test_webhook_cancels_order(self):
        self.create_order()
        order_id = next(iter(self.pool.orders))
        response = self.webhook(
            "payment.canceled",
            {
                "id": "pay-1",
                "status": "canceled",
                "paid": False,
                "amount": {"value": "500.00", "currency": "RUB"},
                "metadata": {"order_id": order_id},
            },
        )
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"])["status"], "canceled")
        self.assertEqual(self.pool.orders[order_id].status, "canceled")

    def test_webhook_ignores_unknown_event(self):
        response = self.webhook(
            "payment.waiting_for_capture",
            {"id": "pay-1", "metadata": {}},
        )
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"])["status"], "ignored")


if __name__ == "__main__":
    unittest.main(verbosity=2)
