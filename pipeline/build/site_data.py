"""Export the static JSON the site loads, from data/interim/.

    uv run python -m pipeline.build.site_data

Writes to site/public/data/:

quakes/index.json, quakes/m5.json, quakes/m3/{year}.json - events for the
map, columnar, tiered so the browser only loads what it shows:
  m5.json         every shown event with M >= 5 (all years; loaded at start)
  m3/{year}.json  shown events with 3 <= M < 5, plus felt events without a
                  magnitude, one file per year (loaded on demand)
  Smaller events are never sent individually; they appear only in gr.json.

gr.json - everything the magnitude-frequency tab needs, pre-aggregated:
  counts        columnar: year, cell index, magnitude x10, event count
                (natural earthquakes in the Japan box, see pipeline.selection)
  cells         [south-west lat, lon] of each CELL_DEG x CELL_DEG cell
  completeness  the pipeline's own Mc / b per cell per 5-year window, so the
                page can show them for reference
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

import duckdb

from ..selection import JAPAN_BOX, shown
from .completeness import CELL_DEG, WINDOW_YEARS


def build(interim: Path, out: Path) -> dict:
    con = duckdb.connect()
    counts = con.execute(f"""
        SELECT year, (cell_lat // {CELL_DEG}) * {CELL_DEG} AS clat, (cell_lon // {CELL_DEG}) * {CELL_DEG} AS clon,
               CAST(round(mag * 10) AS INTEGER) AS m10, sum(n)::INTEGER AS n
        FROM read_parquet('{interim / 'mag_counts.parquet'}')
        GROUP BY ALL ORDER BY ALL
    """).fetchall()
    cells = sorted({(r[1], r[2]) for r in counts})
    cell_index = {c: i for i, c in enumerate(cells)}

    comp = con.execute(f"""
        SELECT window_start, cell_lat, cell_lon, mc, b_value, method, n_events
        FROM read_parquet('{interim / 'completeness.parquet'}') WHERE mc IS NOT NULL ORDER BY ALL
    """).fetchall()
    comp = [r for r in comp if (r[1], r[2]) in cell_index]

    data = {
        "generated": date.today().isoformat(),
        "source": "JMA Seismological Bulletin of Japan (hypocentre catalogue)",
        "selection": "JMA-located natural earthquakes with a magnitude, epicentre in the Japan box",
        "box": JAPAN_BOX,
        "cellDeg": CELL_DEG,
        "windowYears": WINDOW_YEARS,
        "years": [min(r[0] for r in counts), max(r[0] for r in counts)],
        "cells": [list(c) for c in cells],
        "counts": {
            "year": [r[0] for r in counts],
            "cell": [cell_index[(r[1], r[2])] for r in counts],
            "m10": [r[3] for r in counts],
            "n": [r[4] for r in counts],
        },
        "completeness": {
            "windowStart": [r[0] for r in comp],
            "cell": [cell_index[(r[1], r[2])] for r in comp],
            "mc": [r[3] for r in comp],
            "b": [r[4] for r in comp],
            "method": [r[5] for r in comp],
            "n": [r[6] for r in comp],
        },
    }
    out.mkdir(parents=True, exist_ok=True)
    path = out / "gr.json"
    path.write_text(json.dumps(data, separators=(",", ":")))
    return {"path": str(path), "bytes": path.stat().st_size, "rows": len(counts), "cells": len(cells)}


# Columns written for each map event. Time is seconds since the Unix epoch (UTC);
# position to 4 decimals (~10 m, finer than the catalogue's precision).
QUAKE_COLUMNS = {
    "t": "CAST(epoch(origin_utc) AS BIGINT)",
    "lat": "round(lat, 4)",
    "lon": "round(lon, 4)",
    "depth": "round(depth_km, 1)",
    "mag": "mag1",
    "shindo": "coalesce(max_shindo, '')",  # code, see pipeline/jma/codes.MAX_SHINDO
    "cls": "coalesce(event_class, '')",  # 1 natural, 2 few JMA stations, 4 volcanic/other, 5 low-frequency
    "felt": "felt",  # has intensity readings in Japan
    "id": "id",
}


def build_quakes(interim: Path, out: Path) -> dict:
    con = duckdb.connect()
    con.execute(f"""
        CREATE TABLE q AS
        WITH felt_ids AS (
            SELECT DISTINCT event_id FROM read_parquet('{interim / 'shindo_headers' / '*.parquet'}')
            WHERE event_id IS NOT NULL
        )
        SELECT e.*, f.event_id IS NOT NULL AS felt
        FROM read_parquet('{interim / 'events' / '*.parquet'}') e LEFT JOIN felt_ids f ON f.event_id = e.id
    """)
    con.execute(f"DELETE FROM q WHERE NOT ({shown('felt')})")
    cols = ", ".join(f"{expr} AS {name}" for name, expr in QUAKE_COLUMNS.items())

    def write(where: str, path: Path) -> int:
        rows = con.execute(f"SELECT {cols} FROM q WHERE {where} ORDER BY origin_utc").fetchall()
        data = {name: [r[i] for r in rows] for i, name in enumerate(QUAKE_COLUMNS)}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, separators=(",", ":")))
        return len(rows)

    qdir = out / "quakes"
    n5 = write("mag1 >= 5", qdir / "m5.json")
    years = [y for (y,) in con.execute("SELECT DISTINCT year FROM q ORDER BY 1").fetchall()]
    per_year = {}
    for y in years:
        per_year[y] = write(f"year = {y} AND ((mag1 >= 3 AND mag1 < 5) OR (mag1 IS NULL AND felt))",
                            qdir / "m3" / f"{y}.json")
    index = {
        "generated": date.today().isoformat(),
        "columns": list(QUAKE_COLUMNS),
        "years": [years[0], years[-1]],
        "m5": n5,
        "m3": per_year,
    }
    (qdir / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    size = sum(f.stat().st_size for f in qdir.rglob("*.json"))
    return {"m5": n5, "m3": sum(per_year.values()), "bytes": size}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interim", type=Path, default=Path("data/interim"))
    ap.add_argument("--out", type=Path, default=Path("site/public/data"))
    args = ap.parse_args(argv)
    info = build(args.interim, args.out)
    print(f"{info['path']}: {info['bytes'] / 1e6:.2f} MB, {info['rows']:,} count rows, {info['cells']} cells")
    q = build_quakes(args.interim, args.out)
    print(f"quakes: {q['m5']:,} M5+ events, {q['m3']:,} in yearly M3-5 files, {q['bytes'] / 1e6:.1f} MB total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
