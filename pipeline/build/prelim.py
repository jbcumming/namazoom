"""Ingest the preliminary data (pipeline.fetch_prelim) into data/interim/.

    uv run python -m pipeline.build.prelim

Writes, alongside the finalised catalogue's files and in the same schemas:
  events/prelim.parquet          daily-list hypocentres, plus felt quakes the
                                 lists don't (yet) have, plus felt quakes from
                                 the live list after the intensity database ends
  shindo_headers/prelim.parquet  one header per felt quake, linked to its event
  shindo_obs/prelim.parquet      station intensities (no instrumental value,
                                 observation time or acceleration)
and adds stations missing from code_p.dat to stations.parquet.

Every row's `source` starts with "prelim:", which is how later steps tell
preliminary values apart. Only days after the last finalised year are used,
so when JMA publishes the next year's catalogue its preliminary rows drop out.
Preliminary events have no event class (natural / low-frequency / artificial
is not published), so the magnitude statistics, which use classified natural
earthquakes only, leave them out.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from ..jma.prelim import (JST_OFFSET, EqdbQuake, PrelimHypocentre, match_eqdb, parse_daily_page, parse_eqdb_event,
                          parse_live_list)
from .ingest import EVENT_SCHEMA, HEADER_SCHEMA, OBS_SCHEMA, STATION_SCHEMA, _write

PREFIX = "prelim:"

# Region names in the daily lists that never occur in the finalised intensity files.
EXTRA_REGIONS = {"南海道南方沖": "FAR SOUTH OFF NANKAIDO", "東北地方東方沖": "FAR EAST OFF TOHOKU", "遠地": "DISTANT"}


class Regions:
    """The catalogue's region (code, English name) for a preliminary quake.

    The daily lists name regions with JMA's coarser public names (長野県北部 covers
    both NORTHERN NAGANO PREF and NEAR MATSUSHIRO), so the region is taken from the
    position: the most common region of finalised quakes since 2000 in the same
    0.1° cell, or the nearest cell within 0.3°. The Japanese name is the fallback.
    """

    CELL = 0.1
    REACH = 3  # cells

    def __init__(self, con: duckdb.DuckDBPyConnection, interim: Path):
        self.by_name = _region_names(con, interim)
        rows = con.execute(f"""
            WITH c AS (
                SELECT floor(lat / {self.CELL})::INTEGER AS i, floor(lon / {self.CELL})::INTEGER AS j, region_code
                FROM read_parquet('{interim / 'events' / 'h*.parquet'}')
                WHERE agency = 'J' AND year >= 2000 AND lat IS NOT NULL AND region_code IS NOT NULL
            ), en AS (
                SELECT region_code, mode(region_name) AS name
                FROM read_parquet('{interim / 'events' / 'h*.parquet'}') WHERE region_code IS NOT NULL GROUP BY 1
            )
            SELECT i, j, code, en.name FROM (SELECT i, j, mode(region_code) AS code FROM c GROUP BY 1, 2) g
            JOIN en ON en.region_code = g.code
        """).fetchall()
        self.grid = {(i, j): (code, name) for i, j, code, name in rows}

    def __call__(self, lat: float | None, lon: float | None, name_ja: str) -> tuple[int | None, str | None]:
        if lat is not None and lon is not None:
            i, j = int(lat // self.CELL), int(lon // self.CELL)
            for r in range(self.REACH + 1):
                ring = [(i + a, j + b) for a in range(-r, r + 1) for b in range(-r, r + 1) if max(abs(a), abs(b)) == r]
                hits = [self.grid[c] for c in ring if c in self.grid]
                if hits:
                    return min(hits)  # deterministic when several cells tie
        if name_ja in self.by_name:
            return self.by_name[name_ja]
        return None, EXTRA_REGIONS.get(name_ja, name_ja or None)


def _region_names(con: duckdb.DuckDBPyConnection, interim: Path) -> dict[str, tuple[int, str]]:
    """Japanese region name -> its most common (region code, English name) in the finalised files."""
    rows = con.execute(f"""
        WITH ja AS (
            SELECT region_name_ja, mode(region_code) AS code
            FROM read_parquet('{interim / 'shindo_headers' / 'i*.parquet'}')
            WHERE region_name_ja <> '' AND region_code IS NOT NULL GROUP BY 1
        ), en AS (
            SELECT region_code AS code, mode(region_name) AS name
            FROM read_parquet('{interim / 'events' / 'h*.parquet'}') WHERE region_code IS NOT NULL GROUP BY 1
        )
        SELECT ja.region_name_ja, ja.code, en.name FROM ja JOIN en USING (code)
    """).fetchall()
    return {ja: (code, name) for ja, code, name in rows}


def _last_final_day(con: duckdb.DuckDBPyConnection, interim: Path) -> datetime:
    (t,) = con.execute(f"SELECT max(origin_jst) FROM read_parquet('{interim / 'events' / 'h*.parquet'}')").fetchone()
    return t


def _event_row(eid: str, t: datetime, lat: float | None, lon: float | None, depth: float | None,
               mag: float | None, region_ja: str, regions: Regions, max_shindo: str | None,
               source: str, line_no: int) -> dict:
    code, name = regions(lat, lon, region_ja)
    return {
        "id": eid, "agency": "J", "origin_jst": t, "origin_utc": t - JST_OFFSET,
        "year": t.year, "lat": lat, "lon": lon, "depth_km": depth, "depth_whole_km": True,
        "mag1": mag, "max_shindo": max_shindo, "region_code": code, "region_name": name,
        "source": source, "line_no": line_no,
    }


def _eqdb_event_id(q: EqdbQuake) -> str:
    t = q.origin_jst
    pos = "x_x" if q.lat is None or q.lon is None else f"{round(q.lat * 100)}_{round(q.lon * 100)}"
    return f"J{t:%Y%m%d%H%M%S}{t.microsecond // 10_000:02d}_{pos}"


def ingest_prelim(raw: Path, interim: Path) -> dict:
    con = duckdb.connect()
    after = _last_final_day(con, interim)
    regions = Regions(con, interim)
    src = raw / "prelim"

    # Daily lists.
    daily: list[tuple[PrelimHypocentre, str]] = []
    for f in sorted((src / "daily").glob("*.html")):
        day = datetime.strptime(f.stem, "%Y%m%d")
        if day.date() <= after.date():
            continue
        for h in parse_daily_page(f.read_text(encoding="utf-8")):
            daily.append((h, f"{PREFIX}daily/{f.name}"))
    by_minute: dict[datetime, list[PrelimHypocentre]] = {}
    for h, _ in daily:
        by_minute.setdefault(h.origin_jst.replace(second=0, microsecond=0), []).append(h)

    # Felt quakes from the intensity database.
    quakes: list[EqdbQuake] = []
    for f in sorted((src / "eqdb" / "event").glob("*.json")):
        q = parse_eqdb_event(json.loads(f.read_text(encoding="utf-8")))
        if q.origin_jst is not None and q.origin_jst.date() > after.date():
            quakes.append(q)
    quakes.sort(key=lambda q: q.origin_jst)

    events: dict[str, dict] = {}
    daily_rows: dict[int, dict] = {}  # id(PrelimHypocentre) -> its event row
    for h, source in daily:
        row = _event_row(h.event_id(), h.origin_jst, h.lat, h.lon, h.depth_km, h.mag,
                         h.region_name_ja, regions, None, source, h.line_no)
        events[row["id"]] = row
        daily_rows[id(h)] = row

    headers, obs, matched, from_eqdb, used = [], [], 0, 0, set()
    for q in quakes:
        minute = q.origin_jst.replace(second=0, microsecond=0)
        cands = [c for dm in (-1, 0, 1) for c in by_minute.get(minute + timedelta(minutes=dm), []) if id(c) not in used]
        h = match_eqdb(q, cands)
        if h is not None:
            used.add(id(h))
            row = daily_rows[id(h)]
            row["max_shindo"] = q.max_shindo
            matched += 1
        elif q.lat is not None and q.lon is not None:
            row = _event_row(_eqdb_event_id(q), q.origin_jst, q.lat, q.lon, q.depth_km, q.mag,
                             q.region_name_ja, regions, q.max_shindo, f"{PREFIX}eqdb/{q.eqdb_id}", 0)
            events[row["id"]] = row
            from_eqdb += 1
        else:
            row = None
        gid = f"{PREFIX}eqdb/{q.eqdb_id}"
        code, _ = regions(q.lat, q.lon, q.region_name_ja)
        headers.append({
            "group_id": gid, "header_index": 0, "record_type": "A", "is_event": True, "shares_readings": False,
            "located": q.lat is not None, "time_known": True,
            "event_id": row["id"] if row else None, "link_method": "prelim" if row else None,
            "header_id": _eqdb_event_id(q), "origin_jst": q.origin_jst, "year": q.origin_jst.year,
            "time_se": None, "lat": q.lat, "lon": q.lon, "depth_km": q.depth_km, "depth_whole_km": True,
            "mag1": q.mag, "max_shindo": q.max_shindo, "region_code": code,
            "region_name_ja": q.region_name_ja, "n_felt": len(q.readings),
            "key": "", "source": gid, "line_no": 0,
        })
        for r in q.readings:
            obs.append({"group_id": gid, "station_id": r.station_id, "shindo": r.shindo, "source": gid, "line_no": 0})

    # Days the daily lists and the intensity database cover (whole days, JST).
    days = [datetime.strptime(f.stem, "%Y%m%d") for f in (src / "daily").glob("*.html")]
    days += [datetime.fromisoformat(json.loads(f.read_text())["to"]) for f in (src / "eqdb" / "search").glob("*.json")]
    covered = max(days, default=after) + timedelta(days=1)  # midnight after the last covered day

    # Felt quakes since then, from the live list (minutes old, 0.1° / whole km, origin to the minute).
    live = 0
    live_path = src / "live" / "list.json"
    if live_path.exists():
        body = json.loads(live_path.read_text(encoding="utf-8"))
        for q in parse_live_list(body["items"]):
            if q.origin_jst < covered:
                continue
            eid = f"J{q.origin_jst:%Y%m%d%H%M}0000_{round(q.lat * 100)}_{round(q.lon * 100)}"
            events[eid] = _event_row(eid, q.origin_jst, q.lat, q.lon, q.depth_km, q.mag, q.region_name_ja, regions,
                                     q.max_shindo, f"{PREFIX}live/{q.report}", 0)
            live += 1
        covered = max(covered, datetime.fromisoformat(body["fetched"]))

    _write(list(events.values()), EVENT_SCHEMA, interim / "events" / "prelim.parquet")
    _write(headers, HEADER_SCHEMA, interim / "shindo_headers" / "prelim.parquet")
    _write(obs, OBS_SCHEMA, interim / "shindo_obs" / "prelim.parquet")
    new_stations = _add_stations(interim, quakes)

    unknown_regions = sorted({r["region_name"] for r in events.values()
                              if r["region_code"] is None and r["region_name"] and not r["region_name"].isascii()})
    last = max((r["origin_jst"] for r in events.values()), default=None)
    return {
        "after": after.date().isoformat(), "last": last.isoformat(timespec="seconds") if last else None,
        "daily_files": len({s for _, s in daily}), "events": len(events), "felt": len(quakes),
        "felt_matched": matched, "felt_from_eqdb": from_eqdb, "felt_unlocated": len(quakes) - matched - from_eqdb,
        "readings": len(obs), "new_stations": new_stations, "unknown_regions": unknown_regions,
        # Quakes are complete (as far as the sources go) up to here, JST.
        "live": live, "covered_to": covered.isoformat(timespec="seconds"),
    }


def _add_stations(interim: Path, quakes: list[EqdbQuake]) -> int:
    """Stations in the preliminary readings that code_p.dat doesn't list yet."""
    path = interim / "stations.parquet"
    table = pq.read_table(path)
    known = set(table.column("id").to_pylist())
    new: dict[str, dict] = {}
    for q in quakes:
        for r in q.readings:
            if r.station_id not in known and r.station_id not in new:
                new[r.station_id] = {"id": r.station_id, "name": r.name, "lat": r.lat, "lon": r.lon,
                                     "start": q.origin_jst.strftime("%Y%m%d"), "end": None}
    if new:
        rows = table.to_pylist() + list(new.values())
        tmp = path.with_suffix(".tmp")
        pq.write_table(pa.Table.from_pylist(rows, schema=STATION_SCHEMA), tmp, compression="zstd")
        tmp.rename(path)
    return len(new)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", type=Path, default=Path("data/raw"))
    ap.add_argument("--interim", type=Path, default=Path("data/interim"))
    args = ap.parse_args(argv)
    info = ingest_prelim(args.raw, args.interim)
    manifest_path = args.interim / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["prelim"] = info
    manifest_path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    print(json.dumps(info, indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
