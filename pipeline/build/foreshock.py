"""Base rates for "could this quake have been a foreshock?" (the Quake tab).

    uv run python -m pipeline.build.foreshock

For every shallow (<= 100 km) natural quake of M5.5+ in the Japan box since
1923 (plus preliminary data), records what followed within RADIUS_KM of its
epicentre:
  - gap24: its magnitude minus the largest quake in the next 24 hours
    (null when no M4+ quake followed in that time);
  - the first larger quake (strictly larger magnitude) within 7 days, if any:
    hours later, magnitude, distance;
  - or, if it came within 7 days of an equal or larger quake, within 50 km or
    that quake's rupture length if longer (Utsu: log10 L = 0.5 M - 1.85, the
    formula JMA uses for its advisory areas), that it was part of that
    earlier quake's sequence.

The site turns these into base rates from quakes *before* the selected one only,
so the comparison could have been made at the time. 50 km is the radius JMA used
for the Nankai Trough advisory statistics (Mw7+ followed by Mw7.8+ within 50 km).

Writes site/public/data/foreshock.json.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import duckdb
import numpy as np

from ..forecast.etas import dist2_km
from ..selection import IN_BOX, NATURAL

RADIUS_KM = 50.0
DAYS = 7
MIN_MAG = 5.5        # quakes recorded
FOLLOWER_MAG = 4.0   # smallest follower that counts for the 24-hour gap
START_YEAR = 1923
MAX_DEPTH_KM = 100


def rupture_km(m: np.ndarray) -> np.ndarray:
    """Rupture length (Utsu): log10 L = 0.5 M - 1.85."""
    return 10 ** (0.5 * m - 1.85)


def load(interim: Path) -> dict[str, np.ndarray]:
    con = duckdb.connect()
    sel = (f"(({NATURAL}) OR (source LIKE 'prelim:%' AND mag1 IS NOT NULL)) AND {IN_BOX} "
           f"AND depth_km <= {MAX_DEPTH_KM} AND mag1 >= {FOLLOWER_MAG} AND year >= {START_YEAR}")
    r = con.execute(f"""
        SELECT epoch(origin_utc) AS t, lat, lon, depth_km, mag1
        FROM read_parquet('{interim / 'events' / '*.parquet'}') WHERE {sel} ORDER BY t
    """).fetchnumpy()
    return {k: np.asarray(r[k], float) for k in ("t", "lat", "lon", "depth_km", "mag1")}


def build(interim: Path, out: Path) -> dict:
    q = load(interim)
    t, lat, lon, dep, m = q["t"], q["lat"], q["lon"], q["depth_km"], q["mag1"]
    week, day = DAYS * 86400.0, 86400.0
    data_end = float(t.max())
    rows = []
    for i in np.flatnonzero(m >= MIN_MAG):
        lo, hi = np.searchsorted(t, t[i] - week), np.searchsorted(t, t[i] + week, side="right")
        win = np.arange(lo, hi)
        win = win[win != i]
        d2 = dist2_km(lat[i], lon[i], lat[win], lon[win])
        near = win[d2 <= RADIUS_KM ** 2]
        reach = np.maximum(RADIUS_KM, rupture_km(m[win]))
        before = win[(t[win] <= t[i]) & (m[win] >= m[i]) & (d2 <= reach ** 2)]
        row: dict = {"t": round(t[i]), "lat": round(lat[i], 2), "lon": round(lon[i], 2), "m": round(m[i], 1)}
        if len(before):
            j = before[np.argmax(m[before])]
            row["after"] = {"m": round(m[j], 1), "h": round((t[i] - t[j]) / 3600, 1)}
            rows.append(row)
            continue
        after = near[t[near] > t[i]]
        first24 = after[t[after] <= t[i] + day]
        row["gap24"] = round(m[i] - m[first24].max(), 1) if len(first24) else None
        bigger = after[m[after] > m[i]]
        if len(bigger):
            j = bigger[0]
            d = float(np.sqrt(dist2_km(lat[i], lon[i], lat[j], lon[j])))
            row["big"] = {"m": round(m[j], 1), "h": round((t[j] - t[i]) / 3600, 1), "km": round(d)}
        row["complete"] = bool(t[i] + week <= data_end)  # the 7 days are over
        rows.append(row)

    data = {"radiusKm": RADIUS_KM, "days": DAYS, "minMag": MIN_MAG, "followerMag": FOLLOWER_MAG,
            "maxDepth": MAX_DEPTH_KM, "from": START_YEAR, "dataEnd": round(data_end), "quakes": rows}
    out.mkdir(parents=True, exist_ok=True)
    path = out / "foreshock.json"
    path.write_text(json.dumps(data, separators=(",", ":")))
    main = [r for r in rows if "after" not in r and r["complete"]]
    return {"path": str(path), "bytes": path.stat().st_size, "quakes": len(rows), "largest_so_far": len(main),
            "followed_by_larger": sum("big" in r for r in main)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interim", type=Path, default=Path("data/interim"))
    ap.add_argument("--out", type=Path, default=Path("site/public/data"))
    args = ap.parse_args(argv)
    print(json.dumps(build(args.interim, args.out), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
