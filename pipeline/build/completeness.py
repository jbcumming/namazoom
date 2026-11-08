"""Magnitude-frequency counts and magnitude of completeness (Mc).

    uv run python -m pipeline.build.completeness

Writes to data/interim/:
  mag_counts.parquet    year x 1° cell x 0.1-magnitude bin -> count.
                        The base aggregate: any region/period G-R curve can be
                        summed from it.
  completeness.parquet  Mc and b-value per CELL_DEG cell per WINDOW_YEARS window.
  completeness_national.parquet
                        per window: how Mc varies across cells (median, 90th
                        percentile) - the honest one-line summary.

Why per region: the network is far denser on land than offshore, so a single
national Mc is the Mc of the best-covered areas. Above it the offshore
catalogue is still incomplete and the national b-value comes out ~0.5-0.7,
where well-covered regions give the expected ~0.9-1.0.

Selection: pipeline.selection.GR_SELECTION - JMA-located natural earthquakes
(event class 1 or 2) with a magnitude, epicentre inside the Japan box.
Low-frequency, artificial and eruption-related events are excluded because
they don't follow the same magnitude-frequency law.

Mc method: goodness-of-fit (Wiemer & Wyss 2000) - the lowest Mc at which a
Gutenberg-Richter law explains >= 95% (else >= 90%) of the observed counts;
if neither level is reached, maximum curvature + 0.2 (Woessner & Wiemer 2005).
b is the Aki-Utsu maximum-likelihood estimate above Mc. Cells with fewer than
MIN_EVENTS events get no estimate.
"""

from __future__ import annotations

import argparse
import math
import sys
from collections import defaultdict
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from ..selection import GR_SELECTION

BIN = 0.1
CELL_DEG = 2
WINDOW_YEARS = 5
FIRST_YEAR = 1919
MIN_EVENTS = 200
MIN_ABOVE_MC = 50
MAXC_CORRECTION = 0.2


def aki_b(counts: dict[float, int], mc: float) -> tuple[float | None, int]:
    above = [(m, n) for m, n in counts.items() if m >= mc - 1e-9]
    total = sum(n for _, n in above)
    if total < MIN_ABOVE_MC:
        return None, total
    mean = sum(m * n for m, n in above) / total
    if mean - (mc - BIN / 2) <= 0:
        return None, total
    return math.log10(math.e) / (mean - (mc - BIN / 2)), total


def gft_residual(counts: dict[float, int], mc: float) -> tuple[float, float, int] | None:
    """Percentage of observed counts explained by the fitted G-R law above mc."""
    b, total = aki_b(counts, mc)
    if b is None:
        return None
    a = math.log10(total) + b * (mc - BIN / 2)  # N(M >= mc - bin/2) = total
    resid = 0.0
    for m, n in counts.items():
        if m >= mc - 1e-9:
            expected = 10 ** (a - b * (m - BIN / 2)) - 10 ** (a - b * (m + BIN / 2))
            resid += abs(n - expected)
    return 100 - 100 * resid / total, b, total


def estimate_mc(counts: dict[float, int]) -> dict:
    """Mc, b and how they were obtained for one magnitude histogram."""
    total = sum(counts.values())
    out = {"n_events": total, "mc": None, "b_value": None, "n_above_mc": None, "method": None, "fit_pct": None}
    if total < MIN_EVENTS:
        return out
    fits = {}
    for mc10 in range(round(min(counts) * 10), round(max(counts) * 10) + 1):
        mc = mc10 / 10
        r = gft_residual(counts, mc)
        if r is None:
            break
        fits[mc] = r
    for level in (95, 90):
        for mc, (pct, b, n) in fits.items():
            if pct >= level:
                return out | {"mc": mc, "b_value": round(b, 2), "n_above_mc": n,
                              "method": f"gft{level}", "fit_pct": round(pct, 1)}
    maxc = max(counts, key=lambda m: (counts[m], m))
    mc = round(maxc + MAXC_CORRECTION, 1)
    b, n = aki_b(counts, mc)
    return out | {"mc": mc, "b_value": None if b is None else round(b, 2), "n_above_mc": n, "method": "maxc+0.2"}


def _window(year: int) -> int:
    return FIRST_YEAR + (year - FIRST_YEAR) // WINDOW_YEARS * WINDOW_YEARS


def build(interim: Path) -> dict[str, pa.Table]:
    con = duckdb.connect()
    events = interim / "events" / "*.parquet"
    mag_counts = con.sql(f"""
        SELECT year::SMALLINT AS year,
               floor(lat)::SMALLINT AS cell_lat, floor(lon)::SMALLINT AS cell_lon,
               round(mag1, 1) AS mag, count(*)::INTEGER AS n
        FROM read_parquet('{events}') WHERE {GR_SELECTION}
        GROUP BY ALL ORDER BY ALL
    """).to_arrow_table()
    pq.write_table(mag_counts, interim / "mag_counts.parquet", compression="zstd")

    last_year = max(mag_counts.column("year").to_pylist())
    hist: dict[tuple[int, int, int], dict[float, int]] = defaultdict(lambda: defaultdict(int))
    pooled: dict[int, dict[float, int]] = defaultdict(lambda: defaultdict(int))
    for year, clat, clon, mag, n in zip(*(mag_counts.column(c).to_pylist()
                                          for c in ("year", "cell_lat", "cell_lon", "mag", "n"))):
        key = (_window(year), clat // CELL_DEG * CELL_DEG, clon // CELL_DEG * CELL_DEG)
        hist[key][mag] += n
        pooled[_window(year)][mag] += n

    def window(w: int) -> dict:
        return {"window_start": w, "window_end": min(w + WINDOW_YEARS - 1, last_year)}

    rows = [{**window(w), "cell_lat": clat, "cell_lon": clon, "cell_deg": CELL_DEG, **estimate_mc(counts)}
            for (w, clat, clon), counts in sorted(hist.items())]
    completeness = pa.Table.from_pylist(rows)
    pq.write_table(completeness, interim / "completeness.parquet", compression="zstd")

    # Pooled estimate over all cells: the only one possible for sparse early
    # decades; for later ones it reflects the best-covered regions (see docstring).
    pooled_rows = pa.Table.from_pylist([
        {"window_start": w, **{f"pooled_{k}": v for k, v in estimate_mc(c).items() if k != "n_events"}}
        for w, c in sorted(pooled.items())
    ])
    con.register("completeness_t", completeness)
    con.register("pooled_t", pooled_rows)
    national = con.sql("""
        SELECT window_start, any_value(window_end) AS window_end,
               count(*) FILTER (WHERE mc IS NOT NULL) AS cells_with_mc,
               count(*) AS cells_with_events,
               round(quantile_cont(mc, 0.1), 2) AS mc_p10,
               round(median(mc), 2) AS mc_median,
               round(quantile_cont(mc, 0.9), 2) AS mc_p90,
               round(median(b_value), 2) AS b_median,
               sum(n_events) AS n_events,
               any_value(p.pooled_mc) AS pooled_mc, any_value(p.pooled_b_value) AS pooled_b_value,
               any_value(p.pooled_method) AS pooled_method
        FROM completeness_t c JOIN pooled_t p USING (window_start)
        GROUP BY window_start ORDER BY window_start
    """).to_arrow_table()
    pq.write_table(national, interim / "completeness_national.parquet", compression="zstd")
    return {"mag_counts": mag_counts, "completeness": completeness, "national": national}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interim", type=Path, default=Path("data/interim"))
    args = ap.parse_args(argv)
    t = build(args.interim)
    print(f"mag_counts: {t['mag_counts'].num_rows:,} rows; completeness: {t['completeness'].num_rows:,} cell-windows")
    for r in t["national"].to_pylist():
        print(f"{r['window_start']}-{r['window_end']}  cells {r['cells_with_mc']:>3}/{r['cells_with_events']:<3} "
              f"Mc p10 {r['mc_p10']}  median {r['mc_median']}  p90 {r['mc_p90']}  b median {r['b_median']}  "
              f"| pooled Mc {r['pooled_mc']} b {r['pooled_b_value']} ({r['pooled_method']})  events {r['n_events']:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
