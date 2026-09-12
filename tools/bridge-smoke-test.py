#!/usr/bin/env python3
"""
Subtitle Corrector - smoke test voor de bridge.

Controleert:
  1. GET /health          -> draait de bridge en is het model klaar?
  2. POST /detect (WAV)   -> taalherkenning op tools/fixtures/speech_en.wav / speech_nl.wav
  3. POST /detect (stilte)-> de stilte-gate moet netjes 'silence' teruggeven

Gebruik:
    python tools/bridge-smoke-test.py
    python tools/bridge-smoke-test.py --url http://127.0.0.1:8791 --wav eigen_bestand.wav

Fixtures maken (eenmalig):  powershell -ExecutionPolicy Bypass -File tools\\make_tts_fixtures.ps1
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")


def http_json(url: str, data: bytes | None = None, content_type: str | None = None) -> dict:
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
    if content_type:
        req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def check_health(url: str) -> bool:
    print(f"1) GET {url}/health")
    try:
        health = http_json(url + "/health")
    except urllib.error.URLError as exc:
        print(f"   FAIL: geen verbinding ({exc}). Draai eerst bridge\\run_bridge.bat")
        return False

    print(f"   ok={health.get('ok')} ready={health.get('ready')} loading={health.get('loading')} "
          f"backend={health.get('backend')} model={health.get('model')} talen={health.get('languages')}")
    if health.get("error"):
        print(f"   model-fout: {health['error']}")
        return False
    if not health.get("ready"):
        print("   LET OP: model is nog aan het laden. Probeer het over een minuut opnieuw.")
        return False
    return True


def check_wav(url: str, path: str, expected: str | None) -> bool:
    name = os.path.basename(path)
    print(f"2) POST {url}/detect  <- {name}")
    if not os.path.exists(path):
        print("   overgeslagen (bestand bestaat niet)")
        return True

    with open(path, "rb") as fh:
        body = fh.read()
    try:
        res = http_json(url + "/detect", body, "audio/wav")
    except urllib.error.HTTPError as exc:
        print(f"   FAIL: HTTP {exc.code}: {exc.read()[:200]!r}")
        return False
    except urllib.error.URLError as exc:
        print(f"   FAIL: {exc}")
        return False

    if not res.get("ok"):
        print(f"   FAIL: {res}")
        return False

    lang = str(res.get("language"))
    ok = (expected is None) or (lang == expected)
    print(f"   taal={lang} ({res.get('confidence')}) in_scope={res.get('in_scope')} "
          f"duur={res.get('duration')}s verwerkt_in={res.get('elapsed')}s")
    if res.get("transcript"):
        print(f"   tekst: {res['transcript'][:110]}")
    if not ok:
        print(f"   LET OP: verwachtte '{expected}', kreeg '{lang}' (met een klein model kan dit misgaan)")
    return ok


def check_silence(url: str) -> bool:
    print(f"3) POST {url}/detect  <- 3 seconde stilte (float32)")
    body = struct.pack("<%df" % (16000 * 3), *([0.0] * (16000 * 3)))
    try:
        res = http_json(url + "/detect?rate=16000&format=f32", body, "application/octet-stream")
    except Exception as exc:  # noqa: BLE001
        print(f"   FAIL: {exc}")
        return False
    ok = (res.get("ok") is False) and res.get("reason") == "silence"
    print(f"   antwoord: {res}  -> {'OK' if ok else 'onverwacht'}")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="Subtitle Corrector bridge smoke test")
    parser.add_argument("--url", default="http://127.0.0.1:8791")
    parser.add_argument("--wav", action="append", default=[], help="extra WAV-bestand om te testen")
    args = parser.parse_args()

    url = args.url.rstrip("/")
    print("=" * 68)
    print(" Subtitle Corrector - bridge smoke test")
    print("=" * 68)

    if not check_health(url):
        return 1

    wavs = list(args.wav)
    if not wavs:
        for fname, expected in (("speech_en.wav", "en"), ("speech_nl.wav", "nl")):
            path = os.path.join(FIXTURES, fname)
            if os.path.exists(path):
                wavs.append(path)
    for path in wavs:
        expected = "nl" if "nl" in os.path.basename(path).lower() else ("en" if "en" in os.path.basename(path).lower() else None)
        if not check_wav(url, path, expected):
            return 1

    if not wavs:
        print("2) geen fixtures gevonden - draai tools\\make_tts_fixtures.ps1 voor een echte taaltest")

    if not check_silence(url):
        return 1

    print("=" * 68)
    print("Klaar. Alles wat hierboven geen FAIL geeft, werkt.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
