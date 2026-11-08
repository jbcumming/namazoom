"""Export the static JSON the site loads, from data/interim/.

    uv run python -m pipeline.build.site_data

Writes site/public/data/gr.json - everything the Gutenberg-Richter page
needs, pre-aggregated so the browser never sees individual events:
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

from ..selection import JAPAN_BOX
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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interim", type=Path, default=Path("data/interim"))
    ap.add_argument("--out", type=Path, default=Path("site/public/data"))
    args = ap.parse_args(argv)
    info = build(args.interim, args.out)
    print(f"{info['path']}: {info['bytes'] / 1e6:.2f} MB, {info['rows']:,} count rows, {info['cells']} cells")
    return 0


if __name__ == "__main__":
    sys.exit(main())
