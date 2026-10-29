"""Яндекс OAuth, PKCE, cookie и ответы для API Gateway.

Модуль не работает с YDB: он только собирает URL авторизации, обменивает код
на токен, читает профиль и формирует безопасные ответы. Пользователя и сессию
сохраняет handler через store.py.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlencode
from urllib.request import Request, urlopen

AUTHORIZE_URL = "https://oauth.yandex.ru/authorize"
TOKEN_URL = "https://oauth.yandex.ru/token"
PROFILE_URL = "https://login.yandex.ru/info?format=json"

SESSION_COOKIE = "osm_sid"
STATE_COOKIE = "osm_oauth_state"
VERIFIER_COOKIE = "osm_oauth_verifier"
RETURN_COOKIE = "osm_oauth_return"

STATE_TTL_SECONDS = 10 * 60
DEFAULT_SESSION_TTL_DAYS = 30
DEFAULT_SCOPE = "login:info login:email"


class AuthConfigError(RuntimeError):
    """Не заданы обязательные переменные окружения."""


class OAuthError(RuntimeError):
    """Ошибка обмена кода или чтения профиля."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _env(name, default=""):
    value = os.getenv(name, default)
    return value if isinstance(value, str) else default


def public_base_url():
    base = _env("PUBLIC_BASE_URL").rstrip("/")
    if not base:
        raise AuthConfigError("PUBLIC_BASE_URL is not configured")
    return base


def client_id():
    value = _env("YANDEX_CLIENT_ID")
    if not value:
        raise AuthConfigError("YANDEX_CLIENT_ID is not configured")
    return value


def client_secret():
    value = _env("YANDEX_CLIENT_SECRET")
    if not value:
        raise AuthConfigError("YANDEX_CLIENT_SECRET is not configured")
    return value


def session_ttl_days():
    raw = _env("SESSION_TTL_DAYS", str(DEFAULT_SESSION_TTL_DAYS))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_SESSION_TTL_DAYS
    return max(1, min(value, 365))


def oauth_scope():
    return _env("OAUTH_SCOPE", DEFAULT_SCOPE)


def redirect_uri():
    return public_base_url() + "/auth/yandex/callback"


def safe_return(value, default="/"):
    """Разрешает только локальный путь, чтобы не стать open redirect."""
    if not isinstance(value, str) or not value:
        return default
    if not value.startswith("/") or value.startswith("//"):
        return default
    if "\\" in value:
        return default
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        return default
    return value


def make_pkce():
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def build_authorize_url(state, challenge):
    params = {
        "response_type": "code",
        "client_id": client_id(),
        "redirect_uri": redirect_uri(),
        "scope": oauth_scope(),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return AUTHORIZE_URL + "?" + urlencode(params, quote_via=quote)


def exchange_code(code, verifier):
    payload = urlencode(
        {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": client_id(),
            "client_secret": client_secret(),
            "code_verifier": verifier,
        }
    ).encode("utf-8")
    request = Request(
        TOKEN_URL,
        data=payload,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=15) as response:
            body = response.read().decode("utf-8")
            data = json.loads(body)
    except HTTPError as exc:
        # Не печатаем тело ответа: в нём может быть токен или код.
        print(f"[auth] token exchange HTTP {exc.code}")
        raise OAuthError("token_exchange_failed") from exc
    except (URLError, TimeoutError, ValueError) as exc:
        print(f"[auth] token exchange failed: {type(exc).__name__}")
        raise OAuthError("token_exchange_failed") from exc

    token = data.get("access_token") if isinstance(data, dict) else None
    if not token or not isinstance(token, str):
        raise OAuthError("token_exchange_failed")
    return token


def fetch_profile(access_token):
    request = Request(
        PROFILE_URL,
        headers={
            "Authorization": f"OAuth {access_token}",
            "Accept": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        print(f"[auth] profile HTTP {exc.code}")
        raise OAuthError("profile_failed") from exc
    except (URLError, TimeoutError, ValueError) as exc:
        print(f"[auth] profile failed: {type(exc).__name__}")
        raise OAuthError("profile_failed") from exc

    if not isinstance(data, dict) or not data.get("id"):
        raise OAuthError("profile_failed")
    return data


def profile_fields(profile):
    yandex_id = str(profile.get("id") or "").strip()
    login = str(profile.get("login") or "").strip()
    email = profile.get("default_email")
    if not email:
        emails = profile.get("emails")
        if isinstance(emails, list) and emails:
            email = emails[0]
    email = str(email or "").strip()
    display_name = (
        profile.get("display_name")
        or profile.get("real_name")
        or " ".join(
            part
            for part in (profile.get("first_name"), profile.get("last_name"))
            if part
        ).strip()
        or login
    )
    return {
        "yandex_id": yandex_id,
        "login": login,
        "email": email,
        "display_name": str(display_name or "").strip(),
    }


def parse_cookies(event):
    """Читает cookie из формата API Gateway 2.0 и обычного заголовка Cookie."""
    result = {}
    raw = event.get("cookies")
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str) and "=" in item:
                name, value = item.split("=", 1)
                result[name.strip()] = value.strip()

    headers = event.get("headers") or {}
    for key, value in headers.items():
        if str(key).lower() != "cookie" or not isinstance(value, str):
            continue
        for item in value.split(";"):
            if "=" not in item:
                continue
            name, cookie_value = item.split("=", 1)
            result.setdefault(name.strip(), cookie_value.strip())
    return result


def _secure():
    return public_base_url().startswith("https://") if _env("PUBLIC_BASE_URL") else True


def cookie(name, value, max_age, path="/", http_only=True):
    parts = [
        f"{name}={value}",
        f"Path={path}",
        f"Max-Age={max(0, int(max_age))}",
        "SameSite=Lax",
    ]
    if http_only:
        parts.append("HttpOnly")
    if _secure():
        parts.append("Secure")
    return "; ".join(parts)


def clear_cookie(name, path="/"):
    parts = [
        f"{name}=",
        f"Path={path}",
        "Max-Age=0",
        "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        "SameSite=Lax",
        "HttpOnly",
    ]
    if _secure():
        parts.append("Secure")
    return "; ".join(parts)


def return_from_cookie(value):
    """Декодирует return_to из cookie и заново проверяет, что путь локальный."""
    if not isinstance(value, str):
        return "/"
    return safe_return(unquote(value))


def oauth_cookies(state, verifier, return_to):
    return [
        cookie(STATE_COOKIE, state, STATE_TTL_SECONDS, path="/auth"),
        cookie(VERIFIER_COOKIE, verifier, STATE_TTL_SECONDS, path="/auth"),
        cookie(
            RETURN_COOKIE,
            quote(return_to, safe=""),
            STATE_TTL_SECONDS,
            path="/auth",
        ),
    ]


def clear_oauth_cookies():
    return [
        clear_cookie(STATE_COOKIE, path="/auth"),
        clear_cookie(VERIFIER_COOKIE, path="/auth"),
        clear_cookie(RETURN_COOKIE, path="/auth"),
    ]


def session_cookie(sid):
    return cookie(
        SESSION_COOKIE,
        sid,
        session_ttl_days() * 24 * 60 * 60,
        path="/",
    )


def clear_session_cookie():
    return clear_cookie(SESSION_COOKIE, path="/")


def _response_headers(extra=None):
    headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
    }
    if extra:
        headers.update(extra)
    return headers


def json_response(status_code, payload, cookies=None, extra_headers=None):
    headers = _response_headers({"Content-Type": "application/json; charset=utf-8"})
    if extra_headers:
        headers.update(extra_headers)
    response = {
        "statusCode": int(status_code),
        "headers": headers,
        "body": json.dumps(payload, ensure_ascii=False),
        "isBase64Encoded": False,
    }
    if cookies:
        response["multiValueHeaders"] = {"Set-Cookie": list(cookies)}
    return response


def redirect_response(location, cookies=None):
    response = {
        "statusCode": 302,
        "headers": _response_headers({"Location": location}),
        "body": "",
        "isBase64Encoded": False,
    }
    if cookies:
        response["multiValueHeaders"] = {"Set-Cookie": list(cookies)}
    return response


def origin_allowed(event):
    """Для POST проверяет Origin, если браузер его прислал."""
    base = _env("PUBLIC_BASE_URL").rstrip("/")
    if not base:
        return True
    headers = event.get("headers") or {}
    origin = ""
    for key, value in headers.items():
        if str(key).lower() == "origin" and isinstance(value, str):
            origin = value.rstrip("/")
            break
    if not origin:
        return True
    return hmac.compare_digest(origin, base)


def now_utc():
    return datetime.now(timezone.utc)
