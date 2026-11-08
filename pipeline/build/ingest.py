"""Parse every downloaded JMA file into Parquet under data/interim/.

    uv run python -m pipeline.build.ingest

Output (one file per source zip; read them together with DuckDB globs):
  events/h{...}.parquet          hypocentre catalogue, one row per record
  shindo_headers/i{year}.parquet intensity-file hypocentre headers + link to the catalogue
  shindo_obs/i{year}.parquet     station readings, keyed by group_id
  stations.parquet               intensity station list
  manifest.json                  row counts and link statistics per file

Nothing is filtered: every record is kept with the codes needed to select
or qualify it later.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from ..jma.hypo import JST_OFFSET, iter_hypocentres
from ..jma.link import Candidate, link_shindo
from ..jma.shindo import iter_shindo_groups
from ..jma.stations import parse_stations

TS = pa.timestamp("us")

EVENT_SCHEMA = pa.schema([
    ("id", pa.string()), ("agency", pa.string()),
    ("origin_jst", TS), ("origin_utc", TS), ("year", pa.int16()),
    ("time_se", pa.float64()),
    ("lat", pa.float64()), ("lon", pa.float64()),
    ("lat_se_min", pa.float64()), ("lon_se_min", pa.float64()),
    ("depth_km", pa.float64()), ("depth_whole_km", pa.bool_()), ("depth_se_km", pa.float64()),
    ("mag1", pa.float64()), ("mag1_type", pa.string()),
    ("mag2", pa.float64()), ("mag2_type", pa.string()),
    ("travel_time_table", pa.string()), ("location_precision", pa.string()),
    ("event_class", pa.string()), ("max_shindo", pa.string()),
    ("damage_class", pa.string()), ("tsunami_class", pa.string()),
    ("district", pa.int16()), ("region_code", pa.int16()), ("region_name", pa.string()),
    ("n_stations", pa.int32()), ("flag", pa.string()),
    ("corrections", pa.string()), ("key", pa.string()),
    ("source", pa.string()), ("line_no", pa.int32()),
])

_ORIGIN_COLS = [
    "time_se", "lat", "lon", "lat_se_min", "lon_se_min", "depth_km", "depth_whole_km", "depth_se_km",
    "mag1", "mag1_type", "mag2", "mag2_type", "travel_time_table", "location_precision",
    "event_class", "max_shindo", "damage_class", "tsunami_class", "district", "region_code",
]

HEADER_SCHEMA = pa.schema([
    ("group_id", pa.string()), ("header_index", pa.int16()), ("record_type", pa.string()),
    ("is_event", pa.bool_()),  # False for alternative solutions after the first type-A header
    ("shares_readings", pa.bool_()),  # type B/D and not the group's first header
    ("located", pa.bool_()), ("time_known", pa.bool_()),
    ("event_id", pa.string()), ("link_method", pa.string()),
    ("header_id", pa.string()),  # ID built from the header itself (for unlinked events)
    ("origin_jst", TS), ("year", pa.int16()),
    *[EVENT_SCHEMA.field(c) for c in _ORIGIN_COLS],
    ("region_name_ja", pa.string()), ("n_felt", pa.int32()), ("flag", pa.string()),
    ("key", pa.string()), ("source", pa.string()), ("line_no", pa.int32()),
])

OBS_SCHEMA = pa.schema([
    ("group_id", pa.string()), ("station_id", pa.string()),
    ("obs_time_raw", pa.string()), ("obs_time_jst", TS),
    ("shindo", pa.string()), ("instrumental", pa.float64()),
    ("max_acc_time_jst", TS),
    ("acc_total_gal", pa.float64()), ("acc_ns_gal", pa.float64()),
    ("acc_ew_gal", pa.float64()), ("acc_ud_gal", pa.float64()),
    *[(f"{comp}_{what}_{part}", pa.string() if part == "kind" else pa.float64())
      for comp in ("ns", "ew", "ud") for what in ("maxacc", "pred") for part in ("kind", "value")],
    ("source", pa.string()), ("line_no", pa.int32()),
])

STATION_SCHEMA = pa.schema([
    ("id", pa.string()), ("name", pa.string()), ("lat", pa.float64()), ("lon", pa.float64()),
    ("start", pa.string()), ("end", pa.string()),
])


def _write(rows: list[dict], schema: pa.Schema, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pylist(rows, schema=schema)
    tmp = path.with_suffix(".tmp")
    pq.write_table(table, tmp, compression="zstd")
    tmp.rename(path)
    return table.num_rows


def ingest_hypocentres(zip_path: Path, out: Path) -> dict:
    rows = []
    for h in iter_hypocentres(zip_path):
        o = h.origin
        rows.append({
            "id": h.id, "agency": h.agency,
            "origin_jst": o.origin_jst, "origin_utc": o.origin_utc, "year": o.origin_jst.year,
            **{c: getattr(o, c) for c in _ORIGIN_COLS},
            "region_name": h.region_name, "n_stations": h.n_stations, "flag": h.flag,
            "corrections": "; ".join(h.corrections) or None, "key": o.key.decode("ascii"),
            "source": h.source, "line_no": h.line_no,
        })
    n = _write(rows, EVENT_SCHEMA, out / "events" / f"{zip_path.stem}.parquet")
    years = sorted({r["year"] for r in rows})
    return {"rows": n, "years": [years[0], years[-1]], "corrections": sum(1 for r in rows if r["corrections"])}


def _candidates(con: duckdb.DuckDBPyConnection, events_glob: str, year: int) -> list[Candidate]:
    lo, hi = datetime(year, 1, 1) - timedelta(days=1), datetime(year + 1, 1, 1) + timedelta(days=1)
    rows = con.execute(
        f"SELECT id, key, origin_jst, lat, lon FROM read_parquet('{events_glob}') "
        "WHERE origin_jst >= ? AND origin_jst < ?", [lo, hi]
    ).fetchall()
    return [Candidate(i, k.encode("ascii"), t, la, lo_) for i, k, t, la, lo_ in rows]


def ingest_shindo(zip_path: Path, out: Path, con: duckdb.DuckDBPyConnection) -> dict:
    groups = list(iter_shindo_groups(zip_path))
    year = int(zip_path.stem[1:])
    result = link_shindo(_candidates(con, str(out / "events" / "*.parquet"), year), groups)
    link_by_header = {id(l.header): l for l in result.links}

    headers, obs = [], []
    for g in groups:
        gid = f"{g.headers[0].source}:{g.headers[0].line_no}"
        event_headers = {id(h) for h in g.events}
        for i, h in enumerate(g.headers):
            o = h.origin
            link = link_by_header.get(id(h))
            headers.append({
                "group_id": gid, "header_index": i, "record_type": h.record_type,
                "is_event": id(h) in event_headers,
                "shares_readings": g.record_type != "A" and i > 0,
                "located": h.located, "time_known": h.time_known,
                "event_id": link.event_id if link else None,
                "link_method": link.method if link else None,
                "header_id": o.event_id(h.agency),
                "origin_jst": o.origin_jst, "year": o.origin_jst.year,
                **{c: getattr(o, c) for c in _ORIGIN_COLS},
                "region_name_ja": h.region_name_ja, "n_felt": h.n_felt, "flag": h.flag,
                "key": o.key.decode("ascii"), "source": h.source, "line_no": h.line_no,
            })
        for r in g.observations:
            row = {
                "group_id": gid, "station_id": r.station_id,
                "obs_time_raw": r.obs_time_raw, "obs_time_jst": r.obs_time_jst,
                "shindo": r.shindo, "instrumental": r.instrumental, "max_acc_time_jst": r.max_acc_time_jst,
                "acc_total_gal": r.acc_total_gal, "acc_ns_gal": r.acc_ns_gal,
                "acc_ew_gal": r.acc_ew_gal, "acc_ud_gal": r.acc_ud_gal,
                "source": r.source, "line_no": r.line_no,
            }
            names = [f"{c}_{w}" for c in ("ns", "ew", "ud") for w in ("maxacc", "pred")]
            for name, p in zip(names, r.periods):
                row[f"{name}_kind"] = p.kind if p else None
                row[f"{name}_value"] = p.value if p else None
            obs.append(row)

    _write(headers, HEADER_SCHEMA, out / "shindo_headers" / f"{zip_path.stem}.parquet")
    _write(obs, OBS_SCHEMA, out / "shindo_obs" / f"{zip_path.stem}.parquet")
    return {
        "groups": len(groups), "headers": len(headers), "observations": len(obs),
        "events": len(result.links),
        "linked_exact": result.count("exact"), "linked_nearest": result.count("nearest"),
        "unmatched_located": result.count(None, located=True),
        "duplicate": result.count("duplicate"), "ambiguous": result.count("ambiguous"),
        "no_hypocentre": result.count(None, located=False),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", type=Path, default=Path("data/raw"))
    ap.add_argument("--out", type=Path, default=Path("data/interim"))
    args = ap.parse_args(argv)
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    manifest: dict = {"built": datetime.now().isoformat(timespec="seconds"), "jst_offset_h": JST_OFFSET.seconds // 3600,
                      "hypocentre": {}, "shindo": {}}

    t0 = time.time()
    for z in sorted(args.raw.glob("h*.zip")):
        manifest["hypocentre"][z.name] = info = ingest_hypocentres(z, out)
        print(f"{z.name:14} {info['rows']:>9,} events  {info['years'][0]}-{info['years'][1]}", flush=True)

    con = duckdb.connect()
    for z in sorted(args.raw.glob("i[0-9]*.zip")):
        manifest["shindo"][z.name] = info = ingest_shindo(z, out, con)
        print(f"{z.name:14} {info['events']:>7,} felt events  {info['observations']:>8,} readings  "
              f"linked {info['linked_exact'] + info['linked_nearest']:,} "
              f"(nearest {info['linked_nearest']})  unmatched {info['unmatched_located']}  "
              f"dup {info['duplicate']} ambig {info['ambiguous']}  "
              f"no hypocentre {info['no_hypocentre']:,}", flush=True)

    stations = parse_stations(args.raw / "code_p.zip")
    _write([vars(s) if hasattr(s, "__dict__") else {f: getattr(s, f) for f in s.__slots__} for s in stations.values()],
           STATION_SCHEMA, out / "stations.parquet")
    manifest["stations"] = len(stations)
    manifest["seconds"] = round(time.time() - t0)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    print(f"done in {manifest['seconds']} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
