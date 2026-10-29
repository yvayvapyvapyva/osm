"""Быстрые локальные проверки auth-эндпоинтов без YDB и без сети.

Запуск:
    python3 navigator3/scripts/test_auth.py
"""

import json
import os
import sys
import unittest
import urllib.parse
from pathlib import Path

BASE = "https://d5dtest.apigw.yandexcloud.net"
os.environ.setdefault("PUBLIC_BASE_URL", BASE)
os.environ.setdefault("YANDEX_CLIENT_ID", "test-client-id")
os.environ.setdefault("YANDEX_CLIENT_SECRET", "test-client-secret")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import handler  # noqa: E402


def event(path, method="GET", query=None, cookies=None, headers=None):
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
        "cookies": cookies or [],
        "headers": headers or {},
        "body": "",
    }


def cookies_from(response):
    return response.get("multiValueHeaders", {}).get("Set-Cookie", [])


class AuthEndpointTests(unittest.TestCase):
    def test_me_without_cookie(self):
        response = handler.handler(event("/api/me"), None)
        self.assertEqual(response["statusCode"], 401)
        self.assertEqual(json.loads(response["body"])["error"], "unauthorized")
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")
        self.assertNotIn("Access-Control-Allow-Origin", response["headers"])

    def test_health(self):
        response = handler.handler(event("/api/health"), None)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(json.loads(response["body"])["status"], "ok")

    def test_start_builds_authorize_url_and_cookies(self):
        response = handler.handler(
            event("/auth/yandex/start", query={"return": "/#m=route-1"}), None
        )
        self.assertEqual(response["statusCode"], 302)
        location = response["headers"]["Location"]
        self.assertTrue(location.startswith("https://oauth.yandex.ru/authorize?"))
        query = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)
        self.assertEqual(query["response_type"], ["code"])
        self.assertEqual(query["client_id"], ["test-client-id"])
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertEqual(query["redirect_uri"], [BASE + "/auth/yandex/callback"])

        set_cookies = cookies_from(response)
        self.assertEqual(len(set_cookies), 3)
        joined = "\n".join(set_cookies)
        self.assertIn("osm_oauth_state=", joined)
        self.assertIn("osm_oauth_verifier=", joined)
        self.assertIn("osm_oauth_return=%2F%23m%3Droute-1", joined)
        self.assertIn("HttpOnly", joined)
        self.assertIn("SameSite=Lax", joined)

    def test_start_rejects_open_redirect(self):
        for target in ("https://evil.example", "//evil.example", "/\\evil.example"):
            with self.subTest(target=target):
                response = handler.handler(
                    event("/auth/yandex/start", query={"return": target}), None
                )
                joined = "\n".join(cookies_from(response))
                self.assertIn("osm_oauth_return=%2F;", joined)
                self.assertNotIn("evil.example", joined)

    def test_callback_state_mismatch(self):
        response = handler.handler(
            event(
                "/auth/yandex/callback",
                query={"code": "code", "state": "wrong"},
                cookies=["osm_oauth_state=expected"],
            ),
            None,
        )
        self.assertEqual(response["statusCode"], 302)
        self.assertEqual(response["headers"]["Location"], "/?auth_error=state_mismatch")
        joined = "\n".join(cookies_from(response))
        self.assertIn("osm_oauth_state=;", joined)

    def test_callback_user_denied(self):
        response = handler.handler(
            event("/auth/yandex/callback", query={"error": "access_denied"}), None
        )
        self.assertEqual(response["statusCode"], 302)
        self.assertEqual(response["headers"]["Location"], "/?auth_error=access_denied")

    def test_logout_rejects_foreign_origin(self):
        response = handler.handler(
            event(
                "/auth/logout",
                method="POST",
                headers={"origin": "https://evil.example"},
            ),
            None,
        )
        self.assertEqual(response["statusCode"], 403)
        self.assertEqual(json.loads(response["body"])["error"], "forbidden_origin")

    def test_unknown_api_path(self):
        response = handler.handler(event("/api/unknown"), None)
        self.assertEqual(response["statusCode"], 404)
        self.assertEqual(json.loads(response["body"])["error"], "not_found")

    def test_legacy_options_keeps_cors(self):
        response = handler.handler(
            event("/", method="OPTIONS"),
            None,
        )
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response["headers"]["Access-Control-Allow-Origin"], "*")


if __name__ == "__main__":
    unittest.main(verbosity=2)
