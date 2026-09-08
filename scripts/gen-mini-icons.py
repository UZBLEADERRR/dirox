#!/usr/bin/env python3
"""Generates mini/assets/*.png.

There is no image library in this repo and no build step in the app, so the
icons are drawn here with a 40-line PNG writer and checked in. Re-run after
changing the mark or the accent colour.
"""
import math, struct, zlib, pathlib

ACCENT = (0x7C, 0x8C, 0xFF)
OUT = pathlib.Path(__file__).resolve().parent.parent / "mini" / "assets"


def png(path, w, h, px):
    raw = b"".join(b"\x00" + bytes(px[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b""))


def dist_seg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def draw(size, inset=0.0, radius_ratio=0.225, bg=ACCENT):
    """Rounded square in `bg` with a white M. `inset` pads for maskable icons."""
    S, SS = size, 3                       # SS = supersampling factor
    pad = size * inset
    box = size - 2 * pad
    r = box * radius_ratio
    t = box * 0.115                       # stroke half-width comes from this
    # M control points, inside the box
    x0, x1 = pad + box * 0.27, pad + box * 0.73
    y0, y1 = pad + box * 0.30, pad + box * 0.70
    xm, ym = pad + box * 0.50, pad + box * 0.545
    segs = [(x0, y1, x0, y0), (x0, y0, xm, ym), (xm, ym, x1, y0), (x1, y0, x1, y1)]

    px = bytearray(S * S * 4)
    for y in range(S):
        for x in range(S):
            cov_bg = cov_fg = 0
            for sy in range(SS):
                for sx in range(SS):
                    fx = x + (sx + 0.5) / SS
                    fy = y + (sy + 0.5) / SS
                    # rounded rect coverage
                    qx = max(pad + r - fx, fx - (pad + box - r), 0.0)
                    qy = max(pad + r - fy, fy - (pad + box - r), 0.0)
                    if math.hypot(qx, qy) <= r:
                        cov_bg += 1
                        if min(dist_seg(fx, fy, *s) for s in segs) <= t / 2:
                            cov_fg += 1
            n = SS * SS
            a = cov_bg / n
            f = cov_fg / n
            if a == 0:
                continue
            mix = f / a if a else 0
            col = tuple(round(bg[i] * (1 - mix) + 255 * mix) for i in range(3))
            o = (y * S + x) * 4
            px[o:o + 4] = bytes((col[0], col[1], col[2], round(a * 255)))
    return px


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, inset, radius in [
        ("icon-180.png", 180, 0.0, 0.225),
        ("icon-192.png", 192, 0.0, 0.225),
        ("icon-512.png", 512, 0.0, 0.225),
        ("icon-maskable-512.png", 512, 0.0, 0.5),   # full circle-safe: square bg
    ]:
        if name.startswith("icon-maskable"):
            # maskable: full-bleed background, mark shrunk into the safe zone
            px = draw(size, inset=0.18, radius_ratio=0.0)
            # repaint the whole square as opaque background
            for i in range(0, len(px), 4):
                if px[i + 3] == 0:
                    px[i:i + 4] = bytes((*ACCENT, 255))
        else:
            px = draw(size, inset, radius)
        png(OUT / name, size, size, px)
        print("wrote", name)

    (OUT / "icon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        '<rect width="64" height="64" rx="14.4" fill="#7c8cff"/>'
        '<path d="M17.3 44.8V19.2L32 34.9 46.7 19.2v25.6" fill="none" stroke="#fff" '
        'stroke-width="7.4" stroke-linecap="round" stroke-linejoin="round"/></svg>')
    print("wrote icon.svg")


if __name__ == "__main__":
    main()
