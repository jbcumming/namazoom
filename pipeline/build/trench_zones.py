"""Outlines of the official source areas of the great trench quakes, for the Forecast tab.

    uv run python -m pipeline.build.trench_zones

Input: data/raw/jshis/{code}.json, from the J-SHIS seismic activity model API
(NIED, https://www.j-shis.bosai.go.jp/api-pshm-fltinfo), 2024 version, average case:
  https://www.j-shis.bosai.go.jp/map/api/pshm/Y2024/AVR/{code}/fltinfo.geojson?epsg=4326
Each file holds the subfault points (lon, lat, depth) of every rupture pattern HERP's
long-term evaluation allows for that quake. Downloaded once (--fetch) and cached.

J-SHIS terms (https://www.j-shis.bosai.go.jp/agreement, art. 4-5): processed data may be
shared with the source named; the data itself may not be redistributed as-is, even in
another file format. So only this site's own simplified outlines are published: the
points of all patterns gridded at CELL_DEG, and the boundary of the occupied cells.

Output: site/public/data/overlays/trench_zones.json - one MultiPolygon per quake, with
the site's own zone id (matching OUTLOOK in site/src/trench-history.ts) and J-SHIS's name.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

API = "https://www.j-shis.bosai.go.jp/map/api/pshm/Y2024/AVR/{code}/fltinfo.geojson?epsg=4326"
USER_AGENT = "QuakeTracker data pipeline (python-urllib)"
CELL_DEG = 0.1

# J-SHIS quake code -> this site's row id (OUTLOOK in trench-history.ts).
ZONES = {
    "ACHSM": "kuril17",   # Mega earthquakes along the Kuril Trench (17th-century type)
    "ATKCH": "tokachi",   # Huge interplate earthquakes in Tokachi-oki
    "ANMRO": "nemuro",    # Huge interplate earthquakes in Nemuro-oki
    "AJTHK": "jt9",       # Mega earthquakes along the Japan Trench (2011 type)
    "ASGMI": "sagami",    # Sagami Trough earthquakes (M8 class)
    "ANNKI": "nankai",    # Large earthquakes along the Nankai Trough
}


def fetch(raw: Path) -> None:
    raw.mkdir(parents=True, exist_ok=True)
    for code in ZONES:
        path = raw / f"{code}.json"
        if path.exists():
            continue
        req = urllib.request.Request(API.format(code=code), headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=120) as r:
            path.write_bytes(r.read())
        time.sleep(1)  # be gentle with the API


def cells_of(data: dict) -> set[tuple[int, int]]:
    """Grid cells (lon index, lat index) holding any subfault point of any pattern."""
    out: set[tuple[int, int]] = set()
    for f in data["features"]:
        for lon, lat, *_ in f["geometry"]["coordinates"]:
            out.add((int(lon // CELL_DEG), int(lat // CELL_DEG)))
    return out


def fill_gaps(cells: set[tuple[int, int]]) -> set[tuple[int, int]]:
    """Add empty cells boxed in on both sides (east-west or north-south): the points are
    a few km apart, so a cell can fall between them inside the area."""
    out = set(cells)
    for x, y in cells:
        for dx, dy in ((2, 0), (0, 2)):
            if (x + dx, y + dy) in cells:
                out.add((x + dx // 2, y + dy // 2))
    return out


def rings(cells: set[tuple[int, int]]) -> list[list[tuple[int, int]]]:
    """Boundary of a set of unit cells as closed rings of grid corners: each cell
    contributes its four edges counter-clockwise; edges shared by two cells cancel."""
    edges: dict[tuple[int, int], list[tuple[int, int]]] = defaultdict(list)
    for x, y in cells:
        corners = [(x, y), (x + 1, y), (x + 1, y + 1), (x, y + 1)]
        for a, b in zip(corners, corners[1:] + corners[:1]):
            edges[a].append(b)
    # Cancel interior edges (a->b in one cell, b->a in its neighbour).
    for a in list(edges):
        for b in list(edges[a]):
            if a in edges.get(b, []):
                edges[a].remove(b)
                edges[b].remove(a)
    out = []
    while any(edges.values()):
        start = next(a for a, bs in edges.items() if bs)
        ring, a = [start], start
        while True:
            b = edges[a].pop()
            if b == start:
                break
            ring.append(b)
            a = b
        out.append(ring)
    return out


def simplify(ring: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Drop corners on straight runs."""
    n = len(ring)
    keep = []
    for i in range(n):
        (x0, y0), (x1, y1), (x2, y2) = ring[i - 1], ring[i], ring[(i + 1) % n]
        if (x1 - x0) * (y2 - y1) != (y1 - y0) * (x2 - x1):
            keep.append(ring[i])
    return keep


def smooth(ring: list[tuple[float, float]], rounds: int = 3) -> list[tuple[float, float]]:
    """Round off the grid's stair steps: corner cutting (Chaikin), which keeps the outline
    within half a cell of the occupied cells."""
    pts = [(float(x), float(y)) for x, y in ring]
    for _ in range(rounds):
        out = []
        for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
            out += [(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1), (0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1)]
        pts = out
    return pts


def area2(ring: list[tuple[int, int]]) -> int:
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]))


def inside(pt: tuple[float, float], ring: list[tuple[int, int]]) -> bool:
    x, y = pt
    hit = False
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            hit = not hit
    return hit


def multipolygon(cells: set[tuple[int, int]]) -> list:
    """Outer rings (counter-clockwise) with the holes inside them, in degrees."""
    rs = [simplify(r) for r in rings(cells)]
    outers = [r for r in rs if area2(r) > 0]
    holes = [r for r in rs if area2(r) < 0]
    def deg(r: list[tuple[int, int]]) -> list[list[float]]:
        out: list[list[float]] = []
        for x, y in smooth(r):
            q = [round(x * CELL_DEG, 2), round(y * CELL_DEG, 2)]
            if not out or q != out[-1]:
                out.append(q)
        return out + out[:1]
    polys = []
    for o in outers:
        mine = [h for h in holes if inside((h[0][0] + 0.5, h[0][1] + 0.5), o) or inside(h[0], o)]
        polys.append([deg(o)] + [deg(h) for h in mine])
    return polys


def build(raw: Path) -> dict:
    features = []
    for code, zone in ZONES.items():
        data = json.loads((raw / f"{code}.json").read_text())
        m = data["seisact_model"]
        cells = fill_gaps(cells_of(data))
        features.append({
            "type": "Feature",
            "properties": {"zone": zone, "code": code, "name": m.get("ltename", ""), "patterns": len(data["features"])},
            "geometry": {"type": "MultiPolygon", "coordinates": multipolygon(cells)},
        })
    return {"type": "FeatureCollection", "source": "J-SHIS (NIED), seismic activity model 2024, processed: outlines of all "
            f"rupture patterns gridded at {CELL_DEG} degrees", "features": features}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", type=Path, default=Path("data/raw/jshis"))
    ap.add_argument("--out", type=Path, default=Path("site/public/data/overlays"))
    ap.add_argument("--fetch", action="store_true", help="download any missing J-SHIS files first")
    args = ap.parse_args(argv)
    if args.fetch:
        fetch(args.raw)
    fc = build(args.raw)
    args.out.mkdir(parents=True, exist_ok=True)
    path = args.out / "trench_zones.json"
    path.write_text(json.dumps(fc, separators=(",", ":"), ensure_ascii=False))
    for f in fc["features"]:
        polys = f["geometry"]["coordinates"]
        print(f"  {f['properties']['zone']:8} {len(polys)} polygon(s), {sum(len(p) - 1 for p in polys)} hole(s), "
              f"{sum(len(r) for p in polys for r in p)} corners")
    print(f"{path}: {path.stat().st_size / 1e3:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
