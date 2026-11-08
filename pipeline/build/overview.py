"""Overview of everything ingested into data/interim/ - the "is the data
loaded correctly?" report. Also written to data/interim/overview.txt.

    uv run python -m pipeline.build.overview
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import duckdb

from ..known_quakes import HISTORIC


def report(interim: Path) -> tuple[str, bool]:
    con = duckdb.connect()
    ev = f"read_parquet('{interim / 'events' / '*.parquet'}')"
    hd = f"read_parquet('{interim / 'shindo_headers' / '*.parquet'}')"
    ob = f"read_parquet('{interim / 'shindo_obs' / '*.parquet'}')"
    out: list[str] = []
    p = out.append
    ok = True
    q = lambda sql, *a: con.execute(sql, list(a)).fetchall()  # noqa: E731

    (n, n_ids, first, last), = q(f"SELECT count(*), count(DISTINCT id), min(origin_jst), max(origin_jst) FROM {ev}")
    p("CATALOGUE")
    p(f"  {n:,} records, {first:%Y-%m-%d} .. {last:%Y-%m-%d} (JST); IDs unique: {n == n_ids}")
    ok &= n == n_ids
    for agency, cls, cnt in q(f"SELECT agency, event_class, count(*) FROM {ev} GROUP BY ALL ORDER BY 3 DESC"):
        p(f"    agency {agency}  class {cls or '-'}  {cnt:>10,}")
    (nomag,), = q(f"SELECT count(*) FROM {ev} WHERE agency = 'J' AND mag1 IS NULL")
    corr = q(f"SELECT id, corrections FROM {ev} WHERE corrections IS NOT NULL")
    p(f"  JMA events without magnitude: {nomag:,}   errata applied: {len(corr)} {[c[0] for c in corr]}")

    p("\nFELT EVENTS (intensity files)")
    rows = q(f"""SELECT count(*) FILTER (WHERE is_event),
                        count(*) FILTER (WHERE is_event AND link_method = 'exact'),
                        count(*) FILTER (WHERE is_event AND link_method = 'nearest'),
                        count(*) FILTER (WHERE is_event AND located AND link_method IS NULL),
                        count(*) FILTER (WHERE is_event AND link_method = 'duplicate'),
                        count(*) FILTER (WHERE is_event AND NOT located AND time_known),
                        count(*) FILTER (WHERE is_event AND NOT time_known),
                        count(*) FILTER (WHERE shares_readings)
                 FROM {hd}""")[0]
    labels = ["events", "linked exactly", "linked by nearest match (<=2 s, <=0.1 deg)",
              "located, not in catalogue", "duplicate headers", "felt reports without hypocentre (詳細不明)",
              "felt reports with unknown time", "secondary events sharing readings (type B/D)"]
    for label, v in zip(labels, rows):
        p(f"  {label:<46} {v:>9,}")
    (nobs, nst, nmiss), = q(f"""SELECT count(*), count(DISTINCT station_id),
                                count(DISTINCT station_id) FILTER (WHERE station_id NOT IN
                                    (SELECT id FROM read_parquet('{interim / 'stations.parquet'}')))
                               FROM {ob}""")
    p(f"  station readings {nobs:,} from {nst:,} stations ({nmiss} not in station list)")
    (orphans,), = q(f"SELECT count(DISTINCT group_id) FROM {ob} WHERE group_id NOT IN (SELECT group_id FROM {hd})")
    ok &= orphans == 0
    (mismatch,), = q(f"""SELECT count(*) FROM {ob} WHERE instrumental IS NOT NULL AND shindo <> CASE
        WHEN instrumental >= 6.5 THEN '7' WHEN instrumental >= 6.0 THEN 'D' WHEN instrumental >= 5.5 THEN 'C'
        WHEN instrumental >= 5.0 THEN 'B' WHEN instrumental >= 4.5 THEN 'A' WHEN instrumental >= 3.5 THEN '4'
        WHEN instrumental >= 2.5 THEN '3' WHEN instrumental >= 1.5 THEN '2' WHEN instrumental >= 0.5 THEN '1'
        ELSE '0' END""")
    (with_instr,), = q(f"SELECT count(*) FROM {ob} WHERE instrumental IS NOT NULL")
    p(f"  readings with instrumental intensity {with_instr:,}; class disagrees with value: {mismatch:,}")

    p("\nPER YEAR  (catalogue: JMA natural events; felt: intensity-file events)")
    p(f"  {'year':>4} {'events':>8} {'M>=3':>6} {'M>=5':>5} {'M>=7':>4} {'LFE':>6} {'largest':>7}  "
      f"{'felt':>6} {'no-hyp':>6} {'readings':>8}  region of largest")
    per_year = q(f"""
        WITH c AS (
            SELECT year,
                   count(*) FILTER (WHERE event_class IN ('1','2')) AS n,
                   count(*) FILTER (WHERE event_class IN ('1','2') AND mag1 >= 3) AS m3,
                   count(*) FILTER (WHERE event_class IN ('1','2') AND mag1 >= 5) AS m5,
                   count(*) FILTER (WHERE event_class IN ('1','2') AND mag1 >= 7) AS m7,
                   count(*) FILTER (WHERE event_class = '5') AS lfe,
                   max(mag1) AS mmax, arg_max(region_name, mag1) AS region
            FROM {ev} WHERE agency = 'J' GROUP BY year),
        f AS (SELECT year, count(*) FILTER (WHERE is_event) AS felt,
                     count(*) FILTER (WHERE is_event AND NOT located) AS nohyp FROM {hd} GROUP BY year),
        o AS (SELECT CAST(substr(split_part(group_id, ':', 1), 2, 4) AS INTEGER) AS year, count(*) AS readings
              FROM {ob} GROUP BY 1)
        SELECT c.*, f.felt, f.nohyp, o.readings FROM c LEFT JOIN f USING (year) LEFT JOIN o USING (year) ORDER BY year""")
    for y, n_, m3, m5, m7, lfe, mmax, region, felt, nohyp, readings in per_year:
        p(f"  {y:>4} {n_:>8,} {m3:>6,} {m5:>5} {m7:>4} {lfe:>6,} {mmax!s:>7}  "
          f"{felt or 0:>6,} {nohyp or 0:>6,} {readings or 0:>8,}  {region}")

    p("\nCOMPLETENESS  (Mc per 2°x2° cell per 5-year window; see pipeline/build/completeness.py)")
    p("  window      cells  Mc p10  median   p90  b median | pooled Mc (all cells)")
    for r in q(f"SELECT * FROM read_parquet('{interim / 'completeness_national.parquet'}') ORDER BY window_start"):
        w0, w1, cm, ce, p10, med, p90, bmed, _, pmc, pb, pmeth = r
        f = lambda v: "   -" if v is None else f"{v:5.1f}"  # noqa: E731
        p(f"  {w0}-{w1}  {cm:>3}/{ce:<3} {f(p10)}  {f(med)}  {f(p90)}  {f(bmed)}     | {f(pmc)} ({pmeth})")

    p("\nKNOWN QUAKES")
    for k in HISTORIC:
        row = q(f"""SELECT id, mag1, max_shindo, depth_km, region_name FROM {ev}
                    WHERE agency = 'J' AND origin_jst BETWEEN ?::TIMESTAMP - INTERVAL 90 SECOND
                                                         AND ?::TIMESTAMP + INTERVAL 90 SECOND
                      AND abs(lat - ?) <= 0.3 AND abs(lon - ?) <= 0.3
                    ORDER BY mag1 DESC NULLS LAST LIMIT 1""", k.origin_jst, k.origin_jst, k.lat, k.lon)
        problems = k.check_values(*row[0][1:4]) if row else ["not found"]
        ok &= not problems
        got = f"M{row[0][1]} shindo {row[0][2]} {row[0][3]:.0f} km {row[0][4]}" if row else ""
        p(f"  {'OK  ' if not problems else 'FAIL'} {k.name:<30} {got}  {'; '.join(problems)}")

    manifest = json.loads((interim / "manifest.json").read_text())
    p(f"\nbuilt {manifest['built']} in {manifest['seconds']} s from {len(manifest['hypocentre'])} hypocentre "
      f"and {len(manifest['shindo'])} intensity files")
    return "\n".join(out), ok


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interim", type=Path, default=Path("data/interim"))
    args = ap.parse_args(argv)
    text, ok = report(args.interim)
    text += "\n\nALL CHECKS PASSED" if ok else "\n\nSOME CHECKS FAILED"
    (args.interim / "overview.txt").write_text(text + "\n")
    print(text)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
