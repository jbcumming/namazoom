"""Reference overlays for the map: plate boundaries and slab depth contours.

    uv run python -m pipeline.build.overlays

Inputs:
  data/raw/plates/PB2002_steps.json
      Bird (2003), "An updated digital model of plate boundaries", G-cubed 4(3),
      doi:10.1029/2001GC000252; GeoJSON from github.com/fraxen/tectonicplates,
      Open Data Commons Attribution License 1.0.
  data/raw/slab2/{kur,izu,ryu}_slab2_dep_*_contours.in
      Hayes (2018), Slab2 - A Comprehensive Subduction Zone Geometry Model,
      USGS data release, doi:10.5066/F7PV6JNV (no use constraints). Depth to the
      top of the subducting plate; GMT multi-segment text, 20 km contour interval.
Outputs: site/public/data/overlays/plates.json, slabs.json

PB2002 boundary names: "A/B" means plate B subducts beneath A; "A\\B" means
A subducts beneath B; "A-B" is any other boundary.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

# Area kept around the data box (24-46N, 122-148E).
BOUNDS = {"lon_min": 115.0, "lon_max": 155.0, "lat_min": 18.0, "lat_max": 50.0}

PLATES = {
    "AM": "Amur", "EU": "Eurasian", "MA": "Mariana", "NA": "North American", "OK": "Okhotsk",
    "ON": "Okinawa", "PA": "Pacific", "PS": "Philippine Sea", "SU": "Sunda", "YA": "Yangtze",
}

# PB2002 step classes, grouped into what the map distinguishes.
KIND = {
    "SUB": "subduction",
    "OCB": "convergent", "CCB": "convergent",
    "OTF": "transform", "CTF": "transform",
    "OSR": "spreading", "CRB": "rift",
}

ATTRIBUTION = "Plate boundaries: Bird (2003) PB2002, ODC-By"
SLAB_ATTRIBUTION = "Slab depths: USGS Slab2 (Hayes 2018)"

# Contours drawn on the map. They match the depth classes used to colour
# quakes (site/src/app.ts), so a contour is a colour boundary.
SLAB_DEPTHS = (40, 100, 200, 300, 400, 500, 600)
SLABS = {
    "kur": "Pacific plate (Kuril–Japan Trench)",
    "izu": "Pacific plate (Izu–Bonin Trench)",
    "ryu": "Philippine Sea plate (Nankai–Ryukyu)",
}



def describe(bound: str, kind: str) -> str:
    name = lambda code: PLATES.get(code, code)  # noqa: E731
    if "/" in bound:
        over, under = bound.split("/")
        return f"{name(under)} plate sinks beneath the {name(over)} plate"
    if "\\" in bound:
        under, over = bound.split("\\")
        return f"{name(under)} plate sinks beneath the {name(over)} plate"
    a, b = bound.split("-")
    verb = {"convergent": "converge", "transform": "slide past each other",
            "spreading": "spread apart", "rift": "pull apart"}.get(kind, "meet")
    return f"{name(a)} and {name(b)} plates {verb}"


def near(lon: float, lat: float) -> bool:
    return BOUNDS["lon_min"] <= lon <= BOUNDS["lon_max"] and BOUNDS["lat_min"] <= lat <= BOUNDS["lat_max"]


def build_plates(steps_path: Path) -> dict:
    steps = json.loads(steps_path.read_text())["features"]
    # Chain consecutive steps of the same boundary and kind into lines.
    lines: dict[tuple[str, str], list[list[list[float]]]] = defaultdict(list)
    for f in sorted(steps, key=lambda f: f["properties"]["SEQNUM"]):
        p = f["properties"]
        a, b = (p["STARTLONG"], p["STARTLAT"]), (p["FINALLONG"], p["FINALLAT"])
        if not (near(*a) or near(*b)):
            continue
        key = (p["PLATEBOUND"], KIND.get(p["STEPCLASS"], "other"))
        chains = lines[key]
        if chains and chains[-1][-1] == [round(a[0], 3), round(a[1], 3)]:
            chains[-1].append([round(b[0], 3), round(b[1], 3)])
        else:
            chains.append([[round(a[0], 3), round(a[1], 3)], [round(b[0], 3), round(b[1], 3)]])
    features = [
        {
            "type": "Feature",
            "properties": {"kind": kind, "boundary": bound, "label": describe(bound, kind)},
            "geometry": {"type": "MultiLineString", "coordinates": chains},
        }
        for (bound, kind), chains in sorted(lines.items())
    ]
    return {"type": "FeatureCollection", "attribution": ATTRIBUTION, "features": features}


def read_gmt_contours(path: Path) -> list[tuple[int, list[tuple[float, float]]]]:
    """GMT multi-segment file: '> -100 contour -Z-100' then 'lon lat depth' rows."""
    segments: list[tuple[int, list[tuple[float, float]]]] = []
    for line in path.read_text().splitlines():
        if line.startswith(">"):
            depth = -round(float(line.split()[1]))
            segments.append((depth, []))
        elif line.strip():
            lon, lat, _ = (float(x) for x in line.split())
            segments[-1][1].append((lon - 360 if lon > 180 else lon, lat))
    return segments


def clip_runs(points: list[tuple[float, float]]) -> list[list[list[float]]]:
    """Split a line into the runs inside BOUNDS, rounded to 0.01° (~1 km)."""
    runs: list[list[list[float]]] = []
    current: list[list[float]] = []
    for lon, lat in points:
        if near(lon, lat):
            pt = [round(lon, 2), round(lat, 2)]
            if not current or current[-1] != pt:
                current.append(pt)
        elif current:
            if len(current) > 1:
                runs.append(current)
            current = []
    if len(current) > 1:
        runs.append(current)
    return runs


def build_slabs(slab_dir: Path) -> dict:
    features = []
    for code, plate in SLABS.items():
        (path,) = sorted(slab_dir.glob(f"{code}_slab2_dep_*_contours.in"))
        by_depth: dict[int, list] = defaultdict(list)
        for depth, pts in read_gmt_contours(path):
            if depth in SLAB_DEPTHS:
                by_depth[depth].extend(clip_runs(pts))
        for depth, runs in sorted(by_depth.items()):
            if runs:
                features.append({
                    "type": "Feature",
                    "properties": {"depth": depth, "slab": code, "plate": plate},
                    "geometry": {"type": "MultiLineString", "coordinates": runs},
                })
    return {"type": "FeatureCollection", "attribution": SLAB_ATTRIBUTION, "features": features}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", type=Path, default=Path("data/raw"))
    ap.add_argument("--out", type=Path, default=Path("site/public/data/overlays"))
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    plates = build_plates(args.raw / "plates" / "PB2002_steps.json")
    path = args.out / "plates.json"
    path.write_text(json.dumps(plates, separators=(",", ":"), ensure_ascii=False))
    kinds = defaultdict(int)
    for f in plates["features"]:
        kinds[f["properties"]["kind"]] += sum(len(c) - 1 for c in f["geometry"]["coordinates"])
    print(f"{path}: {len(plates['features'])} boundaries, segments by kind {dict(kinds)}, {path.stat().st_size // 1024} KB")
    slabs = build_slabs(args.raw / "slab2")
    path = args.out / "slabs.json"
    path.write_text(json.dumps(slabs, separators=(",", ":"), ensure_ascii=False))
    depths = sorted({f["properties"]["depth"] for f in slabs["features"]})
    print(f"{path}: {len(slabs['features'])} contours at {depths} km, {path.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
