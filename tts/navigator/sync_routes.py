#!/usr/bin/env python3
"""Generate missing TTS audio for unique commands and comments in dbosm."""

import argparse
import json
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import ydb


YDB_ENDPOINT = "grpcs://ydb.serverless.yandexcloud.net:2135"
YDB_DATABASE = (
    "/ru-central1/b1gtnlal9r2s3rvqadjn/etnjvaftd6eakeq08kqr"
)
TTS_ENDPOINT = "https://functions.yandexcloud.net/d4e3cj3q3ff36qlrhbg8"
MAX_TEXT_LENGTH = 1000
MAX_BATCH_SIZE = 100


def read_route_phrases():
    token = subprocess.check_output(
        ["yc", "iam", "create-token"],
        text=True,
    ).strip()
    driver = ydb.Driver(
        ydb.DriverConfig(
            YDB_ENDPOINT,
            YDB_DATABASE,
            credentials=ydb.AuthTokenCredentials(token),
        )
    )
    try:
        driver.wait(timeout=15)
        pool = ydb.SessionPool(driver)

        def query(session):
            return session.transaction().execute(
                "SELECT json FROM roads;",
                commit_tx=True,
            )

        rows = pool.retry_operation_sync(query)[0].rows
        phrases = {"command": set(), "comment": set()}
        for row in rows:
            route = row.json
            if isinstance(route, bytes):
                route = route.decode("utf-8")
            if isinstance(route, str):
                route = json.loads(route)
            if not isinstance(route, list):
                continue
            for point in route:
                if not isinstance(point, dict):
                    continue
                for field, voice_type in (("cmd", "command"), ("comm", "comment")):
                    text = point.get(field)
                    if isinstance(text, str) and text.strip():
                        phrases[voice_type].add(text.strip())
        pool.stop()
        return phrases, len(rows)
    finally:
        driver.stop()


def chunks(items, size):
    for offset in range(0, len(items), size):
        yield items[offset:offset + size]


def request_tts(batch):
    payload = json.dumps({"batches": batch}, ensure_ascii=False).encode("utf-8")
    request = Request(
        TTS_ENDPOINT,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    for attempt in range(3):
        try:
            with urlopen(request, timeout=330) as response:
                result = json.loads(response.read().decode("utf-8"))
            if not isinstance(result.get("audios"), list):
                raise RuntimeError(f"TTS function returned an invalid response: {result}")
            return result["audios"]
        except HTTPError as error:
            if error.code < 500 and error.code != 429:
                details = error.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"TTS function returned HTTP {error.code}: {details}") from error
            if attempt == 2:
                raise
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError("TTS function request failed after retries")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--batch-size",
        type=int,
        default=40,
        help=f"Maximum phrases per function request (1-{MAX_BATCH_SIZE}; default: 40)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Count route phrases without generating or uploading audio",
    )
    args = parser.parse_args()
    if not 1 <= args.batch_size <= MAX_BATCH_SIZE:
        parser.error(f"--batch-size must be between 1 and {MAX_BATCH_SIZE}")

    phrases, route_count = read_route_phrases()
    oversized = [
        text
        for voice_phrases in phrases.values()
        for text in voice_phrases
        if len(text) > MAX_TEXT_LENGTH
    ]
    if oversized:
        raise RuntimeError(
            f"{len(oversized)} unique phrases exceed the {MAX_TEXT_LENGTH}-character limit"
        )

    items = sorted(
        (voice_type, text)
        for voice_type, values in phrases.items()
        for text in values
    )
    print(
        f"Read {route_count} routes: {len(phrases['command'])} unique commands, "
        f"{len(phrases['comment'])} unique comments, {len(items)} audio files total."
    )
    if args.dry_run:
        return

    generated = 0
    for index, part in enumerate(chunks(items, args.batch_size), start=1):
        batches = []
        for voice_type in ("command", "comment"):
            texts = [text for item_voice, text in part if item_voice == voice_type]
            if texts:
                batches.append({"voice_type": voice_type, "texts": texts})
        audios = request_tts(batches)
        expected = set(part)
        returned = {
            (audio.get("voice_type"), audio.get("text"))
            for audio in audios
            if audio.get("url")
        }
        missing = expected - returned
        if missing:
            raise RuntimeError(
                f"TTS request {index} did not return {len(missing)} expected audio files"
            )
        generated += len(returned)
        print(f"Processed batch {index}: {len(returned)}/{len(part)} files verified.")

    print(f"Synchronization complete: {generated}/{len(items)} route audio files available.")


if __name__ == "__main__":
    main()
