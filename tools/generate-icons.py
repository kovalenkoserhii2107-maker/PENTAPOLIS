"""Renders the PENTAPOLIS app icon (GDD §1.1): a pentagon split into 5 coloured sectors by
roads, converging on the golden Central Core. Pure Python (zlib PNG), 4x supersampled.

Usage: python3 -I tools/generate-icons.py apps/client/public/icons
"""
import math
import struct
import sys
import zlib

BG = (11, 18, 32)
SECTORS = [(88, 132, 92), (56, 132, 196), (196, 164, 64), (150, 140, 130), (64, 168, 140)]
ROAD = (226, 232, 240)
CORE = (245, 190, 45)


def pentagon(cx, cy, r):
    return [(cx + r * math.cos(-math.pi / 2 + i * 2 * math.pi / 5), cy + r * math.sin(-math.pi / 2 + i * 2 * math.pi / 5)) for i in range(5)]


def inside(poly, x, y):
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


def seg_dist(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)))
    return math.hypot(px - (ax + vx * t), py - (ay + vy * t))


def render(size, pad):
    ss = 4
    cx = cy = size / 2
    r = size / 2 * (1 - pad)
    poly = pentagon(cx, cy, r)
    road_w = size * 0.022
    core_r = r * 0.2
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    px = x + (sx + 0.5) / ss
                    py = y + (sy + 0.5) / ss
                    col = BG
                    if inside(poly, px, py):
                        ang = (math.atan2(py - cy, px - cx) + math.pi / 2) % (2 * math.pi)
                        col = SECTORS[int(ang / (2 * math.pi / 5)) % 5]
                        # Roads from the core to the pentagon's corners separate the sectors
                        if any(seg_dist(px, py, cx, cy, vx, vy) < road_w for vx, vy in poly):
                            col = ROAD
                        if math.hypot(px - cx, py - cy) < core_r:
                            col = CORE
                    for i in range(3):
                        acc[i] += col[i]
            row.extend(int(a / (ss * ss)) for a in acc)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def svg():
    poly = pentagon(256, 256, 236)
    corners = " ".join(f"{x:.1f},{y:.1f}" for x, y in poly)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="rgb{BG}"/>']
    for i in range(5):
        a = poly[i]
        b = poly[(i + 1) % 5]
        parts.append(f'<polygon points="256,256 {a[0]:.1f},{a[1]:.1f} {b[0]:.1f},{b[1]:.1f}" fill="rgb{SECTORS[i]}"/>')
    for x, y in poly:
        parts.append(f'<line x1="256" y1="256" x2="{x:.1f}" y2="{y:.1f}" stroke="rgb{ROAD}" stroke-width="11"/>')
    parts.append(f'<polygon points="{corners}" fill="none"/><circle cx="256" cy="256" r="47" fill="rgb{CORE}"/></svg>')
    return "".join(parts)


if __name__ == "__main__":
    out = sys.argv[1]
    for name, size, pad in [("icon-192.png", 192, 0.06), ("icon-512.png", 512, 0.06), ("icon-maskable-512.png", 512, 0.24), ("apple-touch-icon.png", 180, 0.1)]:
        with open(f"{out}/{name}", "wb") as f:
            f.write(render(size, pad))
    with open(f"{out}/icon.svg", "w") as f:
        f.write(svg())
