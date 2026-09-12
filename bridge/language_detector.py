"""
Taalherkenning (EN/NL) voor de Subtitle Corrector bridge.

Twee backends:
  * faster-whisper  (aanbevolen: snel op CPU, int8)
  * openai-whisper  (alternatief, zwaarder)

Beide doen hetzelfde: gegeven 16 kHz mono float32 audio -> taal + zekerheid.
De taalherkenning van Whisper is betrouwbaar met een paar seconden spraak.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, Optional, Sequence

import numpy as np

TARGET_RATE = 16000

BACKENDS = ("faster-whisper", "whisper")


class LanguageDetector:
    """Lazy-loading taaldetector met een lock (Whisper-modellen zijn niet thread-safe)."""

    def __init__(
        self,
        backend: str = "auto",
        model_size: str = "base",
        languages: Sequence[str] = ("en", "nl"),
        model_dir: Optional[str] = None,
        verbose: bool = False,
    ) -> None:
        self.requested_backend = backend if backend in BACKENDS else "auto"
        self.backend: Optional[str] = None
        self.model_size = model_size
        self.languages = tuple(l.lower() for l in languages)
        self.model_dir = model_dir
        self.verbose = verbose

        self.loading = False
        self.ready = False
        self.error: Optional[str] = None

        self._model: Any = None
        self._lock = threading.Lock()
        self._load_lock = threading.Lock()

    # ------------------------------------------------------------------ #
    # Laden
    # ------------------------------------------------------------------ #
    def load(self) -> None:
        """Laadt het model (idempotent). Gooit RuntimeError als het niet lukt."""
        if self.ready:
            return
        with self._load_lock:
            if self.ready:
                return
            self.loading = True
            try:
                if self.requested_backend in ("auto", "faster-whisper"):
                    try:
                        self._load_faster_whisper()
                        self.backend = "faster-whisper"
                        self.ready = True
                        return
                    except ImportError as exc:
                        if self.requested_backend == "faster-whisper":
                            raise RuntimeError(
                                "faster-whisper is niet geinstalleerd. Draai bridge/setup.ps1 "
                                "of: pip install faster-whisper"
                            ) from exc
                        if self.verbose:
                            print(f"[bridge] faster-whisper niet beschikbaar ({exc}); probeer openai-whisper...")

                if self.requested_backend in ("auto", "whisper"):
                    try:
                        self._load_openai_whisper()
                        self.backend = "whisper"
                        self.ready = True
                        return
                    except ImportError as exc:
                        raise RuntimeError(
                            "Geen enkele Whisper-backend gevonden. Installeer er een:\n"
                            "  pip install faster-whisper     (aanbevolen)\n"
                            "  pip install openai-whisper     (alternatief)"
                        ) from exc

                raise RuntimeError(f"Onbekende backend: {self.requested_backend}")
            except Exception as exc:  # noqa: BLE001 - fout moet naar /health
                self.error = str(exc)
                raise
            finally:
                self.loading = False

    def _load_faster_whisper(self) -> None:
        from faster_whisper import WhisperModel  # type: ignore

        kwargs: Dict[str, Any] = {"device": "cpu", "compute_type": "int8"}
        if self.model_dir:
            kwargs["download_root"] = self.model_dir
        self._model = WhisperModel(self.model_size, **kwargs)

    def _load_openai_whisper(self) -> None:
        import whisper  # type: ignore

        self._model = whisper.load_model(self.model_size, download_root=self.model_dir)

    # ------------------------------------------------------------------ #
    # Detectie
    # ------------------------------------------------------------------ #
    def detect(self, audio: np.ndarray) -> Dict[str, Any]:
        """@param audio: mono float32 op 16 kHz."""
        if not self.ready:
            self.load()

        audio = np.ascontiguousarray(audio, dtype=np.float32).reshape(-1)
        if audio.size == 0:
            return {"ok": False, "reason": "empty-audio"}

        rms = float(np.sqrt(np.mean(np.square(audio.astype(np.float64)))) if audio.size else 0.0)
        if rms < 1e-5:
            return {"ok": False, "reason": "silence", "rms": rms}

        with self._lock:
            started = time.time()
            if self.backend == "faster-whisper":
                out = self._detect_faster_whisper(audio)
            else:
                out = self._detect_openai_whisper(audio)

        out["ok"] = True
        out["in_scope"] = out.get("language") in self.languages
        out["backend"] = self.backend
        out["model"] = self.model_size
        out["duration"] = round(audio.size / TARGET_RATE, 2)
        out["rms"] = round(rms, 5)
        out["elapsed"] = round(time.time() - started, 2)
        return out

    def _detect_faster_whisper(self, audio: np.ndarray) -> Dict[str, Any]:
        segments, info = self._model.transcribe(
            audio,
            language=None,
            task="transcribe",
            beam_size=1,
            best_of=1,
            temperature=0.0,
            condition_on_previous_text=False,
            without_timestamps=True,
            vad_filter=False,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()

        top = None
        all_probs = getattr(info, "all_language_probs", None)
        if all_probs:
            top = [[lang, round(float(p), 4)] for lang, p in all_probs[:5]]

        return {
            "language": (info.language or "").lower() or None,
            "confidence": round(float(info.language_probability or 0.0), 4),
            "transcript": text[:400],
            "top": top,
        }

    def _detect_openai_whisper(self, audio: np.ndarray) -> Dict[str, Any]:
        import whisper  # type: ignore

        model = self._model
        padded = whisper.pad_or_trim(audio)
        try:
            mel = whisper.log_mel_spectrogram(padded, n_mels=model.dims.n_mels).to(model.device)
        except TypeError:  # oudere versie zonder n_mels parameter
            mel = whisper.log_mel_spectrogram(padded).to(model.device)

        _, probs = whisper.detect_language(model, mel)
        prob_map = {str(k).lower(): float(v) for k, v in probs.items()}
        language = max(prob_map, key=prob_map.get) if prob_map else None
        top = sorted(prob_map.items(), key=lambda kv: kv[1], reverse=True)[:5]

        result = model.transcribe(padded, language=language, fp16=False, verbose=None,
                                  condition_on_previous_text=False)
        return {
            "language": language,
            "confidence": round(prob_map.get(language, 0.0), 4),
            "transcript": str(result.get("text", ""))[:400],
            "top": [[lang, round(p, 4)] for lang, p in top],
        }
