"""Export the static JSON the site loads, from data/interim/.

    uv run python -m pipeline.build.site_data

Writes to site/public/data/:

quakes/index.json, quakes/m5.json, quakes/m3/{year}.json - events for the
map, columnar, tiered so the browser only loads what it shows:
  m5.json         every shown event with M >= 5 (all years; loaded at start)
  m3/{year}.json  shown events with 3 <= M < 5, plus felt events without a
                  magnitude, one file per year (loaded on demand)
  Smaller events are never sent individually; they appear only in gr.json.

stations.json, shindo/{YYYY-MM}.json - station readings for felt quakes
(see build_shindo). felt/{lat}_{lon}.json - every reading by place, for the
"My location" tab (see build_felt).

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
    "dmg": "coalesce(damage_class, '')",  # pipeline/jma/codes.DAMAGE_CLASS
    "tsu": "coalesce(tsunami_class, '')",  # pipeline/jma/codes.TSUNAMI_CLASS
    "id": "id",
}
# Only in m5.json (keeps the yearly files small).
M5_EXTRA = {"region": "region_name"}


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

    def write(where: str, path: Path, extra: dict[str, str] | None = None) -> int:
        columns = {**QUAKE_COLUMNS, **(extra or {})}
        sel = ", ".join(f"{expr} AS {name}" for name, expr in columns.items())
        rows = con.execute(f"SELECT {sel} FROM q WHERE {where} ORDER BY origin_utc").fetchall()
        data = {name: [r[i] for r in rows] for i, name in enumerate(columns)}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, separators=(",", ":")))
        return len(rows)

    qdir = out / "quakes"
    n5 = write("mag1 >= 5", qdir / "m5.json", M5_EXTRA)
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


def build_shindo(interim: Path, out: Path) -> dict:
    """Station readings for each felt quake, for the footprint view.

    stations.json      columnar: id, name, lat, lon, start, end (index = position)
    shindo/{YYYY-MM}.json, one file per month of origin (JST):
      ids    catalogue event IDs
      start  offset of each event's first reading; readings of event k are
             start[k] .. start[k+1]-1
      st     station index into stations.json
      sh     one character per reading: the station intensity code
             (1-7, A=5-, B=5+, C=6-, D=6+, 9=felt but unknown)
      iv     instrumental intensity x10, or -1 if not measured
      ot     observation time at the station, in tenths of a second after the
             origin time; null if not recorded
    Only readings that belong to a single quake are exported: in type B/D
    groups the readings are shared by several quakes and are left out.
    """
    con = duckdb.connect()
    stations = con.execute(f"""
        SELECT id, name, round(lat, 4), round(lon, 4), start, "end"
        FROM read_parquet('{interim / 'stations.parquet'}') ORDER BY id
    """).fetchall()
    index = {r[0]: i for i, r in enumerate(stations)}
    names = ("id", "name", "lat", "lon", "start", "end")
    (out / "stations.json").write_text(json.dumps(
        {n: [r[i] for r in stations] for i, n in enumerate(names)}, separators=(",", ":"), ensure_ascii=False))

    rows = con.execute(f"""
        WITH ev AS (
            SELECT group_id, event_id, strftime(origin_jst, '%Y-%m') AS ym, origin_jst
            FROM read_parquet('{interim / 'shindo_headers' / '*.parquet'}')
            WHERE event_id IS NOT NULL AND is_event AND NOT shares_readings
        )
        SELECT ev.ym, ev.event_id, o.station_id, o.shindo,
               CAST(round(coalesce(o.instrumental, -0.1) * 10) AS INTEGER) AS iv,
               CAST(round((epoch(o.obs_time_jst) - epoch(ev.origin_jst)) * 10) AS INTEGER) AS ot
        FROM read_parquet('{interim / 'shindo_obs' / '*.parquet'}') o JOIN ev USING (group_id)
        ORDER BY ev.ym, ev.origin_jst, ev.event_id, iv DESC
    """).fetchall()
    sdir = out / "shindo"
    sdir.mkdir(parents=True, exist_ok=True)
    months: dict[str, dict] = {}
    for ym, eid, sid, sh, iv, ot in rows:
        m = months.setdefault(ym, {"ids": [], "start": [], "st": [], "sh": [], "iv": [], "ot": []})
        if not m["ids"] or m["ids"][-1] != eid:
            m["ids"].append(eid)
            m["start"].append(len(m["st"]))
        m["st"].append(index[sid])
        m["sh"].append(sh)
        m["iv"].append(iv)
        m["ot"].append(ot)
    for ym, m in months.items():
        m["sh"] = "".join(m["sh"])
        (sdir / f"{ym}.json").write_text(json.dumps(m, separators=(",", ":")))
    size = sum(f.stat().st_size for f in sdir.glob("*.json"))
    return {"stations": len(stations), "months": len(months), "events": sum(len(m["ids"]) for m in months.values()),
            "readings": len(rows), "bytes": size}


FELT_CELL_DEG = 1


def build_felt(interim: Path, out: Path) -> dict:
    """Felt history per place, for the "My location" tab.

    felt/{lat}_{lon}.json, one file per 1° cell (south-west corner), holding
    every reading at stations in the cell:
      events  columnar: t (s, UTC), lat, lon, depth, mag, id - the quake each
              reading belongs to. Readings are grouped as in the JMA file: for
              groups of several close quakes (type B/D) this is the first; for
              felt reports without a located hypocentre lat/lon/depth/mag are
              null and id is "".
      st      station index into stations.json
      ev      event index into `events`
      sh      one character per reading (station intensity code)
      iv      instrumental intensity x10, or -1
    """
    con = duckdb.connect()
    station_index = {sid: i for i, (sid,) in enumerate(
        con.execute(f"SELECT id FROM read_parquet('{interim / 'stations.parquet'}') ORDER BY id").fetchall())}
    rows = con.execute(f"""
        WITH g AS (  -- one row per group: its first header, with the catalogue values when linked
            SELECT h.group_id, h.origin_jst, h.located, h.event_id,
                   coalesce(e.lat, h.lat) AS lat, coalesce(e.lon, h.lon) AS lon,
                   coalesce(e.depth_km, h.depth_km) AS depth, coalesce(e.mag1, h.mag1) AS mag
            FROM read_parquet('{interim / 'shindo_headers' / '*.parquet'}') h
            LEFT JOIN read_parquet('{interim / 'events' / '*.parquet'}') e ON e.id = h.event_id
            WHERE h.header_index = 0
        )
        SELECT floor(s.lat)::INTEGER AS clat, floor(s.lon)::INTEGER AS clon,
               g.group_id, CAST(epoch(g.origin_jst) - 9 * 3600 AS BIGINT) AS t,
               CASE WHEN g.located THEN round(g.lat, 3) END AS lat,
               CASE WHEN g.located THEN round(g.lon, 3) END AS lon,
               CASE WHEN g.located THEN round(g.depth, 1) END AS depth,
               CASE WHEN g.located THEN g.mag END AS mag,
               coalesce(g.event_id, '') AS id,
               o.station_id, o.shindo,
               CAST(round(coalesce(o.instrumental, -0.1) * 10) AS INTEGER) AS iv
        FROM read_parquet('{interim / 'shindo_obs' / '*.parquet'}') o
        JOIN g USING (group_id)
        JOIN read_parquet('{interim / 'stations.parquet'}') s ON s.id = o.station_id
        WHERE s.lat IS NOT NULL
        ORDER BY clat, clon, t, g.group_id
    """).fetchall()
    fdir = out / "felt"
    fdir.mkdir(parents=True, exist_ok=True)
    cells: dict[tuple[int, int], dict] = {}
    event_pos: dict[tuple[int, int], dict[str, int]] = {}
    for clat, clon, gid, t, lat, lon, depth, mag, eid, sid, sh, iv in rows:
        key = (clat, clon)
        c = cells.setdefault(key, {"events": {"t": [], "lat": [], "lon": [], "depth": [], "mag": [], "id": []},
                                   "st": [], "ev": [], "sh": [], "iv": []})
        pos = event_pos.setdefault(key, {})
        if gid not in pos:
            pos[gid] = len(c["events"]["t"])
            for k, v in (("t", t), ("lat", lat), ("lon", lon), ("depth", depth), ("mag", mag), ("id", eid)):
                c["events"][k].append(v)
        c["st"].append(station_index[sid])
        c["ev"].append(pos[gid])
        c["sh"].append(sh)
        c["iv"].append(iv)
    for (clat, clon), c in cells.items():
        c["sh"] = "".join(c["sh"])
        (fdir / f"{clat}_{clon}.json").write_text(json.dumps(c, separators=(",", ":")))
    (fdir / "index.json").write_text(json.dumps(
        {"cellDeg": FELT_CELL_DEG, "cells": sorted(f"{a}_{b}" for a, b in cells)}, separators=(",", ":")))
    size = sum(f.stat().st_size for f in fdir.glob("*.json"))
    return {"cells": len(cells), "readings": len(rows), "bytes": size}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interim", type=Path, default=Path("data/interim"))
    ap.add_argument("--out", type=Path, default=Path("site/public/data"))
    args = ap.parse_args(argv)
    info = build(args.interim, args.out)
    print(f"{info['path']}: {info['bytes'] / 1e6:.2f} MB, {info['rows']:,} count rows, {info['cells']} cells")
    q = build_quakes(args.interim, args.out)
    print(f"quakes: {q['m5']:,} M5+ events, {q['m3']:,} in yearly M3-5 files, {q['bytes'] / 1e6:.1f} MB total")
    sh = build_shindo(args.interim, args.out)
    print(f"shindo: {sh['events']:,} quakes, {sh['readings']:,} readings in {sh['months']} monthly files "
          f"({sh['bytes'] / 1e6:.1f} MB); {sh['stations']:,} stations")
    fe = build_felt(args.interim, args.out)
    print(f"felt: {fe['readings']:,} readings in {fe['cells']} cell files ({fe['bytes'] / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
