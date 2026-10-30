"""Минимальный клиент ЮKassa для оплаты доступа к папкам.

Секреты не хранятся в коде: YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY приходят
из переменных окружения функции (secret key — из Lockbox).

Документация: https://yookassa.ru/developers/api
"""

import base64
import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

API_BASE = "https://api.yookassa.ru/v3"


class PaymentConfigError(RuntimeError):
    """Не заданы shop id или secret key."""


class PaymentError(RuntimeError):
    """ЮKassa вернула ошибку или недоступна."""


def _env(name):
    value = os.getenv(name, "")
    return value if isinstance(value, str) else ""


def shop_id():
    value = _env("YOOKASSA_SHOP_ID")
    if not value:
        raise PaymentConfigError("YOOKASSA_SHOP_ID is not configured")
    return value


def secret_key():
    value = _env("YOOKASSA_SECRET_KEY")
    if not value:
        raise PaymentConfigError("YOOKASSA_SECRET_KEY is not configured")
    return value


def configured():
    return bool(_env("YOOKASSA_SHOP_ID") and _env("YOOKASSA_SECRET_KEY"))


def _amount(kopecks):
    kopecks = int(kopecks)
    return f"{kopecks // 100}.{kopecks % 100:02d}"


def _request(method, path, payload=None, idempotence_key=None):
    credentials = base64.b64encode(
        f"{shop_id()}:{secret_key()}".encode("utf-8")
    ).decode("ascii")
    headers = {
        "Authorization": f"Basic {credentials}",
        "Accept": "application/json",
    }
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if idempotence_key:
        headers["Idempotence-Key"] = str(idempotence_key)

    request = Request(
        API_BASE + path,
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urlopen(request, timeout=20) as response:
            body = response.read().decode("utf-8")
            result = json.loads(body)
    except HTTPError as exc:
        # Тело ошибки может содержать описание, но не секреты.
        details = ""
        try:
            details = exc.read().decode("utf-8")[:500]
        except Exception:  # noqa: BLE001
            pass
        print(f"[payments] HTTP {exc.code}: {details}")
        raise PaymentError(f"yookassa_http_{exc.code}") from exc
    except (URLError, TimeoutError, ValueError) as exc:
        print(f"[payments] request failed: {type(exc).__name__}")
        raise PaymentError("yookassa_unavailable") from exc

    if not isinstance(result, dict):
        raise PaymentError("yookassa_invalid_response")
    return result


def create_payment(
    amount_kopecks, description, return_url, metadata, idempotence_key
):
    payload = {
        "amount": {"value": _amount(amount_kopecks), "currency": "RUB"},
        "capture": True,
        "confirmation": {"type": "redirect", "return_url": return_url},
        "description": str(description)[:128],
        "metadata": {str(key): str(value) for key, value in metadata.items()},
    }
    result = _request(
        "POST", "/payments", payload=payload, idempotence_key=idempotence_key
    )

    payment_id = result.get("id")
    confirmation = result.get("confirmation") or {}
    confirmation_url = confirmation.get("confirmation_url")
    if not payment_id or not confirmation_url:
        raise PaymentError("yookassa_invalid_response")
    return {
        "payment_id": str(payment_id),
        "status": str(result.get("status") or ""),
        "confirmation_url": str(confirmation_url),
    }


def fetch_payment(payment_id):
    return _request("GET", f"/payments/{payment_id}")
