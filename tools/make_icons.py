#!/usr/bin/env python3
"""
Genereert de extensie-iconen met alleen de standaardbibliotheek (geen Pillow).

    python tools/make_icons.py

Schrijft extension/icons/icon16.png, icon32.png, icon48.png en icon128.png
(een donker vierkant met een ondertitelbalk en een cyaan "]"-haakje).
"""

from __future__ import annotations

import os
import struct
import zlib

SS = 4  # supersampling factor

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "extension", "icons")

BG = (0x17, 0x1B, 0x26, 255)
BORDER = (0x33, 0x3C, 0x4D, 255)
PANEL = (0xF2, 0xF5, 0xFA, 240)
BAR = (0x2A, 0x31, 0x40, 255)
ACCENT = (0x35, 0xC8, 0xE6, 255)


class Canvas:
    """Kleine premultiplied RGBA canvas."""

    def __init__(self, size: int) -> None:
        self.size = size
        self.data = [(0.0, 0.0, 0.0, 0.0)] * (size * size)

    def _blend(self, idx: int, color) -> None:
        sr, sg, sb, sa = color
        sa_f = sa / 255.0
        r, g, b, a = self.data[idx]
        out_a = sa_f + a * (1 - sa_f)
        if out_a <= 0:
            self.data[idx] = (0.0, 0.0, 0.0, 0.0)
            return
        self.data[idx] = (
            (sr / 255.0) * sa_f + r * (1 - sa_f),
            (sg / 255.0) * sa_f + g * (1 - sa_f),
            (sb / 255.0) * sa_f + b * (1 - sa_f),
            out_a,
        )

    def rect(self, x0: float, y0: float, x1: float, y1: float, color) -> None:
        for y in range(max(0, int(y0 * self.size)), min(self.size, int(y1 * self.size) + 1)):
            for x in range(max(0, int(x0 * self.size)), min(self.size, int(x1 * self.size) + 1)):
                px = (x + 0.5) / self.size
                py = (y + 0.5) / self.size
                if x0 <= px < x1 and y0 <= py < y1:
                    self._blend(y * self.size + x, color)

    def round_rect(self, x0: float, y0: float, x1: float, y1: float, r: float, color) -> None:
        for y in range(max(0, int(y0 * self.size)), min(self.size, int(y1 * self.size) + 1)):
            for x in range(max(0, int(x0 * self.size)), min(self.size, int(x1 * self.size) + 1)):
                px = (x + 0.5) / self.size
                py = (y + 0.5) / self.size
                if not (x0 <= px < x1 and y0 <= py < y1):
                    continue
                # afstand tot de dichtstbijzijnde binnenhoek
                cx = min(max(px, x0 + r), x1 - r)
                cy = min(max(py, y0 + r), y1 - r)
                dx = px - cx
                dy = py - cy
                if dx * dx + dy * dy <= r * r:
                    self._blend(y * self.size + x, color)

    def downsample(self, factor: int) -> "Canvas":
        out = Canvas(self.size // factor)
        for y in range(out.size):
            for x in range(out.size):
                r = g = b = a = 0.0
                for dy in range(factor):
                    for dx in range(factor):
                        pr, pg, pb, pa = self.data[(y * factor + dy) * self.size + (x * factor + dx)]
                        r += pr
                        g += pg
                        b += pb
                        a += pa
                n = float(factor * factor)
                out.data[y * out.size + x] = (r / n, g / n, b / n, a / n)
        return out

    def to_png(self) -> bytes:
        raw = bytearray()
        for y in range(self.size):
            raw.append(0)  # filter type 0
            for x in range(self.size):
                r, g, b, a = self.data[y * self.size + x]
                if a <= 0:
                    raw.extend((0, 0, 0, 0))
                    continue
                # un-premultiply
                raw.append(max(0, min(255, int(round(r / a * 255)))))
                raw.append(max(0, min(255, int(round(g / a * 255)))))
                raw.append(max(0, min(255, int(round(b / a * 255)))))
                raw.append(max(0, min(255, int(round(a * 255)))))

        def chunk(tag: bytes, data: bytes) -> bytes:
            return (
                struct.pack(">I", len(data))
                + tag
                + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
            )

        ihdr = struct.pack(">IIBBBBB", self.size, self.size, 8, 6, 0, 0, 0)
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b"")
        )


def draw(size: int) -> Canvas:
    c = Canvas(size * SS)
    # buitenste rand + donkere vulling (zo blijft er een dun randje zichtbaar)
    c.round_rect(0.02, 0.02, 0.98, 0.98, 0.20, BORDER)
    c.round_rect(0.06, 0.06, 0.94, 0.94, 0.17, BG)
    # ondertitelbalk
    c.round_rect(0.14, 0.40, 0.70, 0.76, 0.06, PANEL)
    c.rect(0.20, 0.47, 0.46, 0.53, BAR)
    c.rect(0.20, 0.59, 0.62, 0.65, BAR)
    # "]"-haakje
    c.round_rect(0.74, 0.26, 0.84, 0.70, 0.03, ACCENT)
    c.round_rect(0.64, 0.26, 0.84, 0.36, 0.03, ACCENT)
    c.round_rect(0.64, 0.60, 0.84, 0.70, 0.03, ACCENT)
    return c.downsample(SS)


def main() -> int:
    out = os.path.abspath(OUT_DIR)
    os.makedirs(out, exist_ok=True)
    for size in (16, 32, 48, 128):
        png = draw(size).to_png()
        path = os.path.join(out, f"icon{size}.png")
        with open(path, "wb") as fh:
            fh.write(png)
        print(f"geschreven: {path} ({len(png)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
