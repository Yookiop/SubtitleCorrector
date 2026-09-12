#!/usr/bin/env python3
"""
Subtitle Corrector - lokale bridge.

Draait een klein HTTP-servertje op 127.0.0.1 dat van de browser-extensie korte
audiofragmenten (16 kHz mono float32) krijgt en teruggeeft in welke taal er
gesproken wordt (EN/NL).

    python bridge_server.py                  # start op http://127.0.0.1:8791
    python bridge_server.py --model tiny     # kleiner/sneller model
    python bridge_server.py --warmup         # model vast downloaden en stoppen
    python bridge_server.py --backend whisper

Endpoints:
    GET  /health   -> {"ok":true,"ready":true,"backend":"faster-whisper",...}
    POST /detect   -> body = raw float32le (of WAV), ?rate=16000
                      -> {"ok":true,"language":"nl","confidence":0.93,...}
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse, parse_qs

try:
    import numpy as np
except ImportError:  # pragma: no cover
    print("[bridge] numpy ontbreekt. Draai bridge/setup.ps1 of: pip install numpy")
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from language_detector import LanguageDetector, TARGET_RATE  # noqa: E402

VERSION = "1.0.0"
MAX_BODY_BYTES = 8 * 1024 * 1024
DEFAULT_MODEL_DIR = os.path.join(HERE, "models")

STATE: Dict[str, Any] = {
    "detector": None,
    "started": time.time(),
    "requests": 0,
    "verbose": False,
}


def log(msg: str, always: bool = True) -> None:
    if always or STATE.get("verbose"):
        print(f"[bridge {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------------- #
# Audio inlezen
# ---------------------------------------------------------------------- #
def resample_linear(data: "np.ndarray", src_rate: int, dst_rate: int) -> "np.ndarray":
    if src_rate == dst_rate or data.size == 0:
        return data
    duration = data.size / float(src_rate)
    count = max(1, int(round(duration * dst_rate)))
    src_idx = np.linspace(0.0, data.size - 1, num=count)
    return np.interp(src_idx, np.arange(data.size), data).astype(np.float32)


def parse_audio(body: bytes, content_type: str, query: Dict[str, list]) -> "np.ndarray":
    ct = (content_type or "").split(";")[0].strip().lower()

    if ct in ("audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave") or body[:4] == b"RIFF":
        with wave.open(io.BytesIO(body), "rb") as w:
            frames = w.getnframes()
            channels = w.getnchannels()
            width = w.getsampwidth()
            rate = w.getframerate()
            raw = w.readframes(frames)
        dtype = {1: np.uint8, 2: np.int16, 4: np.int32}.get(width)
        if dtype is None:
            raise ValueError(f"Onbekende samplebreedte: {width} bytes")
        data = np.frombuffer(raw, dtype=dtype).astype(np.float32)
        if width == 2:
            data = data / 32768.0
        elif width == 4:
            data = data / 2147483648.0
        elif width == 1:
            data = (data - 128.0) / 128.0
        if channels > 1:
            data = data.reshape(-1, channels).mean(axis=1)
        return resample_linear(np.ascontiguousarray(data, dtype=np.float32), rate, TARGET_RATE)

    # raw samples (float32 little endian), zoals de extensie stuurt
    if len(body) % 4 != 0:
        raise ValueError("Body-lengte is geen veelvoud van 4 (float32 verwacht)")
    data = np.frombuffer(body, dtype="<f4").astype(np.float32)
    rate = int((query.get("rate") or ["16000"])[0])
    return resample_linear(np.ascontiguousarray(data), rate, TARGET_RATE)


# ---------------------------------------------------------------------- #
# HTTP
# ---------------------------------------------------------------------- #
class BridgeHandler(BaseHTTPRequestHandler):
    server_version = f"SubtitleCorrectorBridge/{VERSION}"
    protocol_version = "HTTP/1.1"

    # ---------------- helpers ----------------
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-SC-Min-Confidence, X-SC-Max-Seconds")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        if STATE.get("verbose"):
            log("%s - %s" % (self.address_string(), fmt % args), always=False)

    # ---------------- routes ----------------
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        det: LanguageDetector = STATE["detector"]

        if path in ("/health", "/healthz"):
            self._send(200, {
                "ok": True,
                "ready": bool(det.ready),
                "loading": bool(det.loading),
                "backend": det.backend or det.requested_backend,
                "model": det.model_size,
                "languages": list(det.languages),
                "error": det.error,
                "version": VERSION,
                "uptime": round(time.time() - STARTED, 1),
                "requests": STATE["requests"],
            })
            return

        if path == "/":
            self._send(200, {
                "ok": True,
                "name": "Subtitle Corrector bridge",
                "version": VERSION,
                "hint": "Draait. De extensie gebruikt /health en /detect.",
                "languages": list(det.languages),
            })
            return

        self._send(404, {"ok": False, "reason": "not-found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != "/detect":
            self._send(404, {"ok": False, "reason": "not-found"})
            return

        det: LanguageDetector = STATE["detector"]
        if not det.ready:
            if det.error:
                self._send(503, {"ok": False, "reason": "model-error", "error": det.error})
            else:
                self._send(503, {"ok": False, "reason": "model-loading"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._send(400, {"ok": False, "reason": "empty-body"})
            return
        if length > MAX_BODY_BYTES:
            self._send(413, {"ok": False, "reason": "body-too-large"})
            return

        body = self.rfile.read(length)
        query = parse_qs(urlparse(self.path).query)
        content_type = self.headers.get("Content-Type", "")

        try:
            audio = parse_audio(body, content_type, query)
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"ok": False, "reason": "bad-audio", "error": str(exc)})
            return

        STATE["requests"] += 1
        started = time.time()
        try:
            result = det.detect(audio)
        except Exception as exc:  # noqa: BLE001
            log(f"detectie mislukt: {exc}")
            self._send(500, {"ok": False, "reason": "detect-failed", "error": str(exc)})
            return

        if not result.get("ok"):
            self._send(200, {
                "ok": False,
                "reason": result.get("reason", "no-result"),
                "rms": result.get("rms"),
            })
            return

        try:
            min_conf = float(self.headers.get("X-SC-Min-Confidence") or 0.5)
        except ValueError:
            min_conf = 0.5
        result["low_confidence"] = bool(result.get("in_scope") and (result.get("confidence") or 0) < min_conf)

        log(
            f"detect: {result['language']} ({result['confidence']:.2f}) "
            f"in_scope={result['in_scope']} {result['duration']}s in {result['elapsed']}s"
            + (f" tekst='{result['transcript'][:60]}...'" if STATE.get("verbose") and result.get("transcript") else "")
        )
        void_ms = int((time.time() - started) * 1000)
        result["server_ms"] = void_ms
        self._send(200, result)


STARTED = time.time()


# ---------------------------------------------------------------------- #
# Start
# ---------------------------------------------------------------------- #
def main(argv: Optional[list] = None) -> int:
    global STARTED
    parser = argparse.ArgumentParser(description="Subtitle Corrector bridge (lokale taalherkenning)")
    parser.add_argument("--host", default="127.0.0.1", help="bind-adres (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8791, help="poort (default: 8791)")
    parser.add_argument("--backend", default=os.environ.get("SC_BRIDGE_BACKEND", "auto"),
                        choices=["auto", "faster-whisper", "whisper"], help="Whisper-backend")
    parser.add_argument("--model", default=os.environ.get("SC_BRIDGE_MODEL", "base"),
                        help="modelgrootte: tiny | base | small (default: base)")
    parser.add_argument("--languages", default="en,nl", help="toegestane talen, kommagescheiden")
    parser.add_argument("--min-confidence", type=float, default=0.5, help="default minimale zekerheid")
    parser.add_argument("--model-dir", default=DEFAULT_MODEL_DIR, help="map voor gedownloade modellen")
    parser.add_argument("--warmup", action="store_true", help="model laden/downloaden en daarna stoppen")
    parser.add_argument("--verbose", action="store_true", help="extra logging")
    args = parser.parse_args(argv)

    STATE["verbose"] = args.verbose
    STARTED = time.time()

    detector = LanguageDetector(
        backend=args.backend,
        model_size=args.model,
        languages=[l.strip() for l in args.languages.split(",") if l.strip()],
        model_dir=args.model_dir,
        verbose=args.verbose,
    )
    STATE["detector"] = detector
    STATE["min_confidence"] = args.min_confidence

    print("=" * 68)
    print(" Subtitle Corrector bridge")
    print(f" backend : {args.backend}   model: {args.model}   talen: {', '.join(detector.languages)}")
    print(f" adres   : http://{args.host}:{args.port}")
    print("=" * 68)

    if args.warmup:
        print("Model laden (eerste keer duurt dit even - het model wordt gedownload)...")
        try:
            detector.load()
        except Exception as exc:  # noqa: BLE001
            print(f"[bridge] model laden mislukt: {exc}")
            return 1
        print(f"Klaar. Backend={detector.backend}, model={detector.model_size}.")
        return 0

    # Model op de achtergrond laden zodat /health direct antwoordt.
    def _warmup() -> None:
        try:
            detector.load()
            log(f"model geladen ({detector.backend}, {detector.model_size}) - klaar voor gebruik")
        except Exception as exc:  # noqa: BLE001
            log(f"model laden mislukt: {exc}")

    threading.Thread(target=_warmup, daemon=True).start()

    try:
        httpd = ThreadingHTTPServer((args.host, args.port), BridgeHandler)
    except OSError as exc:
        print(f"[bridge] kon niet starten op {args.host}:{args.port} - {exc}")
        print("        Draait er al een bridge? Of gebruik --port <ander poortnummer>.")
        return 1

    httpd.daemon_threads = True
    print("Bridge draait. Stop met Ctrl+C.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[bridge] gestopt")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
