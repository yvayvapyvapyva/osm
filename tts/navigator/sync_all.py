#!/usr/bin/env python3
"""Полная синхронизация озвучки маршрутов с хранилищем eia-tts.

Что делает:
  1. Читает все cmd/comm из маршрутов:
     - navigatortg / nav-db (D1, Cloudflare) — через wrangler;
     - navigator3 — из YDB (таблица roads).
  2. Добавляет служебные фразы, которые навигатор прогревает и произносит
     отдельно от маршрутов (порог удара и превышения скорости), и fallback
     «Т<номер>» для точек без cmd/comm.
  3. Проверяет наличие mp3 в бакете eia-tts и при необходимости синтезирует
     недостающие через TTS-функцию.
  4. Приводит манифест v1/manifest.json к точному набору фраз: правит
     повреждённые записи, удаляет лишние.
  5. Удаляет из бакета mp3, которых нет среди нужных фраз.

Перед удалением сохраняет манифест и лишние файлы в backup-каталог.

Запуск:
  python3 sync_all.py            # только отчёт, ничего не меняет
  python3 sync_all.py --apply    # применить изменения
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    import ydb
except ImportError:  # pragma: no cover
    ydb = None

BUCKET = "eia-tts"
BUCKET_URL = f"https://storage.yandexcloud.net/{BUCKET}"
MANIFEST_KEY = "v1/manifest.json"
TTS_ENDPOINT = "https://functions.yandexcloud.net/d4e3cj3q3ff36qlrhbg8"
VOICE_SETTINGS = {
    "command": ("ru-RU-DmitryNeural", "-10Hz"),
    "comment": ("ru-RU-SvetlanaNeural", "+0Hz"),
}
VOLUME = "+30%"
MAX_TEXT_LENGTH = 1000
MAX_BATCH_SIZE = 100
YDB_ENDPOINT = "grpcs://ydb.serverless.yandexcloud.net:2135"
YDB_DATABASE = "/ru-central1/b1gtnlal9r2s3rvqadjn/etnjvaftd6eakeq08kqr"
WRANGLER_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "navigatortg2", "cloudflare_worker")
)
WRANGLER_CONFIG = "wrangler-api.toml"
SERVICE_PHRASES = (
    "Сильный удар",
    "Превышение скорости",
    "Превышена максимальная скорость",
)


def object_key(text, voice_type):
    voice, pitch = VOICE_SETTINGS[voice_type]
    raw = f"{text}\0{voice}\0{pitch}\0{VOLUME}".encode("utf-8")
    return "v1/" + hashlib.sha256(raw).hexdigest() + ".mp3"


def object_url(key):
    return f"{BUCKET_URL}/{key}"


def manifest_url(cache_bust=False):
    url = f"{BUCKET_URL}/{MANIFEST_KEY}"
    return url + (f"?t={int(time.time())}" if cache_bust else "")


def yc_token():
    return subprocess.check_output(["yc", "iam", "create-token"], text=True).strip()


def http_request(url, method="GET", data=None, token=None, headers=None, timeout=60):
    request_headers = dict(headers or {})
    if token:
        request_headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, data=data, method=method, headers=request_headers)
    return urllib.request.urlopen(request, timeout=timeout)


def load_manifest(token=None):
    try:
        with http_request(manifest_url(cache_bust=True), token=token, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return {}
        raise


def save_manifest(manifest, token):
    data = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
    with http_request(
        manifest_url(),
        method="PUT",
        data=data,
        token=token,
        headers={
            "Content-Type": "application/json",
            "Cache-Control": "no-cache, no-store, must-revalidate",
        },
    ) as response:
        if response.status not in (200, 201):
            raise RuntimeError(f"manifest upload failed: HTTP {response.status}")


def list_objects(token):
    objects = {}
    continuation = None
    while True:
        query = {"list-type": "2", "prefix": "v1/", "max-keys": "1000"}
        if continuation:
            query["continuation-token"] = continuation
        with http_request(BUCKET_URL + "?" + urllib.parse.urlencode(query), token=token) as response:
            xml = response.read().decode("utf-8")
        for match in re.finditer(
            r"<Contents><Key>(.*?)</Key>.*?<Size>(\d+)</Size>", xml, re.S
        ):
            objects[match.group(1)] = int(match.group(2))
        token_match = re.search(r"<NextContinuationToken>(.*?)</NextContinuationToken>", xml)
        continuation = token_match.group(1) if token_match else None
        if not continuation:
            break
    return objects


def delete_object(key, token):
    try:
        with http_request(object_url(key), method="DELETE", token=token, timeout=20) as response:
            return response.status in (200, 202, 204)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        raise


def download_object(key, destination):
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    with http_request(object_url(key), timeout=60) as response, open(destination, "wb") as handle:
        shutil.copyfileobj(response, handle)


def d1_route_json():
    command = [
        "npx",
        "--no-install",
        "wrangler",
        "d1",
        "execute",
        "nav-db",
        "--remote",
        "--json",
        "--command",
        "SELECT m, json FROM roads",
        "--config",
        WRANGLER_CONFIG,
    ]
    result = subprocess.run(
        command,
        cwd=WRANGLER_DIR,
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(result.stdout)
    return [row.get("json") for row in payload[0].get("results", [])]


def ydb_route_json():
    if ydb is None:
        raise RuntimeError("python-ydb не установлен, нужен пакет ydb")
    token = yc_token()
    driver = ydb.Driver(
        ydb.DriverConfig(YDB_ENDPOINT, YDB_DATABASE, credentials=ydb.AuthTokenCredentials(token))
    )
    try:
        driver.wait(timeout=15)
        pool = ydb.SessionPool(driver)

        def query(session):
            return session.transaction().execute("SELECT json FROM roads;", commit_tx=True)

        rows = pool.retry_operation_sync(query)[0].rows
        values = []
        for row in rows:
            raw = row.json
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8")
            values.append(raw)
        pool.stop()
        return values
    finally:
        driver.stop()


def collect_phrases(route_jsons):
    phrases = {"command": set(), "comment": set()}
    fallbacks = set()
    bad = 0
    for raw in route_jsons:
        if raw is None:
            continue
        route = raw
        if isinstance(raw, str):
            try:
                route = json.loads(raw)
            except json.JSONDecodeError:
                bad += 1
                continue
        if not isinstance(route, list):
            bad += 1
            continue
        for index, point in enumerate(route):
            if not isinstance(point, dict):
                continue
            cmd = point.get("cmd")
            comm = point.get("comm")
            cmd = cmd.strip() if isinstance(cmd, str) else ""
            comm = comm.strip() if isinstance(comm, str) else ""
            if cmd:
                phrases["command"].add(cmd)
            if comm:
                phrases["comment"].add(comm)
            if not cmd and not comm:
                fallbacks.add(f"Т{index + 1}")
    return phrases, fallbacks, bad


def request_tts(items):
    if not items:
        return
    batches = []
    for voice_type in ("command", "comment"):
        texts = [text for item_type, text in items if item_type == voice_type]
        if texts:
            batches.append({"voice_type": voice_type, "texts": texts})
    payload = json.dumps({"batches": batches}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        TTS_ENDPOINT,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=330) as response:
                result = json.loads(response.read().decode("utf-8"))
            audios = result.get("audios")
            if not isinstance(audios, list):
                raise RuntimeError(f"TTS function returned invalid response: {result}")
            return audios
        except urllib.error.HTTPError as error:
            if error.code < 500 and error.code != 429:
                details = error.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"TTS function HTTP {error.code}: {details}") from error
            if attempt == 2:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError("TTS function request failed after retries")


def chunks(values, size):
    for index in range(0, len(values), size):
        yield values[index:index + size]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="внести изменения")
    parser.add_argument("--skip-service-phrases", action="store_true", help="не добавлять служебные фразы навигатора")
    parser.add_argument("--backup-dir", help="куда сохранить резервную копию (по умолчанию /tmp/tts-sync-...)")
    parser.add_argument("--batch-size", type=int, default=40)
    args = parser.parse_args()
    if not 1 <= args.batch_size <= MAX_BATCH_SIZE:
        parser.error(f"--batch-size должен быть от 1 до {MAX_BATCH_SIZE}")

    backup_dir = args.backup_dir or f"/tmp/tts-sync-{time.strftime('%Y%m%d-%H%M%S')}"
    token = yc_token()

    print("Читаю маршруты navigatortg (D1 nav-db)…")
    tg_routes = d1_route_json()
    print("Читаю маршруты navigator3 (YDB)…")
    n3_routes = ydb_route_json()

    tg_phrases, tg_fallbacks, tg_bad = collect_phrases(tg_routes)
    n3_phrases, n3_fallbacks, n3_bad = collect_phrases(n3_routes)
    union = {voice: tg_phrases[voice] | n3_phrases[voice] for voice in ("command", "comment")}
    fallbacks = tg_fallbacks | n3_fallbacks
    service = set() if args.skip_service_phrases else set(SERVICE_PHRASES)

    required = {
        "command": union["command"] | service | fallbacks,
        "comment": union["comment"],
    }
    expected = {
        object_key(text, voice): (voice, text)
        for voice in ("command", "comment")
        for text in required[voice]
    }

    print(
        f"navigatortg: маршрутов {len(tg_routes)} (ошибок {tg_bad}), "
        f"команд {len(tg_phrases['command'])}, комментариев {len(tg_phrases['comment'])}"
    )
    print(
        f"navigator3: маршрутов {len(n3_routes)} (ошибок {n3_bad}), "
        f"команд {len(n3_phrases['command'])}, комментариев {len(n3_phrases['comment'])}"
    )
    print(
        f"Итого уникальных фраз: команд {len(required['command'])}, "
        f"комментариев {len(required['comment'])}, файлов {len(expected)}"
    )
    if service:
        print(f"Служебные фразы навигатора: {len(service)}")
    if fallbacks:
        print(f"Fallback-фразы точек без cmd/comm: {sorted(fallbacks, key=lambda x: int(x[1:]))}")

    oversized = [text for text in required["command"] | required["comment"] if len(text) > MAX_TEXT_LENGTH]
    if oversized:
        raise RuntimeError(f"{len(oversized)} фраз длиннее {MAX_TEXT_LENGTH} символов")

    manifest = load_manifest(token)
    objects = list_objects(token)
    mp3_objects = {key: size for key, size in objects.items() if key.endswith(".mp3")}

    broken_manifest = []
    for key, (voice, text) in expected.items():
        meta = manifest.get(key)
        if not meta or meta.get("voice_type") != voice or (meta.get("text") or "").strip() != text:
            broken_manifest.append(key)
    extra_manifest = [key for key in manifest if key not in expected]
    missing_audio = [
        key for key in expected if key not in mp3_objects or mp3_objects[key] == 0
    ]

    print(f"Манифест: {len(manifest)} записей, требуемых {len(expected)}")
    print(f"  повреждённых записей: {len(broken_manifest)}")
    print(f"  лишних записей: {len(extra_manifest)}")
    print(f"В бакете mp3: {len(mp3_objects)}, не хватает или пустых: {len(missing_audio)}")

    if not args.apply:
        print("\nРежим проверки. Для изменений запустите с --apply.")
        return

    os.makedirs(backup_dir, exist_ok=True)
    with open(os.path.join(backup_dir, "manifest.before.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    # Резервная копия всех лишних mp3.
    extra_objects = [key for key in mp3_objects if key not in expected]
    for key in extra_objects:
        download_object(key, os.path.join(backup_dir, "extra", key))
    with open(os.path.join(backup_dir, "extra-keys.txt"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(extra_objects) + ("\n" if extra_objects else ""))
    print(f"Резервная копия: {backup_dir} (лишних файлов: {len(extra_objects)})")

    if missing_audio:
        print(f"Синтезирую {len(missing_audio)} файлов…")
        items = sorted((expected[key][0], expected[key][1]) for key in missing_audio)
        for part in chunks(items, args.batch_size):
            request_tts(part)
        objects = list_objects(token)
        mp3_objects = {key: size for key, size in objects.items() if key.endswith(".mp3")}
        still_missing = [key for key in expected if key not in mp3_objects or mp3_objects[key] == 0]
        if still_missing:
            raise RuntimeError(f"после синтеза не хватает {len(still_missing)} файлов")

    # Манифест ровно по нужным фразам.
    cleaned_manifest = {
        key: {"text": text, "voice_type": voice, "key": key, "url": object_url(key)}
        for key, (voice, text) in expected.items()
    }
    save_manifest(cleaned_manifest, token)
    print(f"Манифест обновлён: {len(cleaned_manifest)} записей")

    deleted = 0
    for key in extra_objects:
        if delete_object(key, token):
            deleted += 1
    print(f"Удалено лишних mp3: {deleted}")

    # Финальная сверка.
    objects = list_objects(token)
    final_mp3 = {key for key in objects if key.endswith(".mp3")}
    final_manifest = load_manifest(token)
    problems = []
    if final_mp3 != set(expected):
        problems.append(
            f"бакет: лишних {len(final_mp3 - set(expected))}, не хватает {len(set(expected) - final_mp3)}"
        )
    if set(final_manifest) != set(expected):
        problems.append(
            f"манифест: лишних {len(set(final_manifest) - set(expected))}, не хватает {len(set(expected) - set(final_manifest))}"
        )
    if problems:
        raise RuntimeError("Финальная сверка не прошла: " + "; ".join(problems))
    print(
        f"Готово: {len(expected)} файлов и записей манифеста, "
        f"лишних нет. Резервная копия: {backup_dir}"
    )


if __name__ == "__main__":
    main()
