"""Preliminary JMA data for the months after the finalised catalogue.

Two sources (downloaded by pipeline.fetch_prelim):

震源リスト - daily hypocentre list, an HTML page with a fixed-format <pre> block:

    年   月 日 時 分 秒    緯度       経度       深さ(km)  Ｍ   震央地名
    2025  1 15 00:02  2.9  32°57.9'N 132°12.4'E   36     0.0  豊後水道

  Times are JST, positions in degrees and decimal minutes, depth in whole km,
  magnitude "-" when not determined. Values are provisional (暫定値) and the
  list does not say which events are low-frequency or artificial.

震度データベース - JSON from the intensity database's search API: per quake
  the hypocentre (decimal degrees, depth "36 km", magnitude or "不明") and the
  station intensities, with station codes as in code_p.dat.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from datetime import datetime, timedelta

JST_OFFSET = timedelta(hours=9)

_LINE = re.compile(
    r"^(?P<y>\d{4}) +(?P<mo>\d{1,2}) +(?P<d>\d{1,2}) +(?P<h>\d{1,2}):(?P<mi>\d{2}) +(?P<s>\d{1,2}\.\d)"
    r" +(?P<latd>\d{1,2})° *(?P<latm>\d{1,2}\.\d)'(?P<ns>[NS])"
    r" +(?P<lond>\d{1,3})° *(?P<lonm>\d{1,2}\.\d)'(?P<ew>[EW])"
    r" +(?P<dep>\d+) +(?P<mag>-?\d+\.\d|-) +(?P<region>.*?)\s*$"
)


@dataclass(frozen=True, slots=True)
class PrelimHypocentre:
    origin_jst: datetime
    lat: float
    lon: float
    depth_km: float
    mag: float | None
    region_name_ja: str
    line_no: int

    @property
    def origin_utc(self) -> datetime:
        return self.origin_jst - JST_OFFSET

    def event_id(self) -> str:
        """Same scheme as the catalogue (pipeline.jma.hypo.Origin.event_id)."""
        t = self.origin_jst
        return f"J{t:%Y%m%d%H%M%S}{t.microsecond // 10_000:02d}_{round(self.lat * 100)}_{round(self.lon * 100)}"


def _origin(y: int, mo: int, d: int, h: int, mi: int, sec: float) -> datetime:
    whole = int(sec)
    return datetime(y, mo, d, h, mi) + timedelta(seconds=whole, microseconds=round((sec - whole) * 10) * 100_000)


def parse_daily_line(line: str, line_no: int = 0) -> PrelimHypocentre | None:
    m = _LINE.match(line)
    if not m:
        return None
    g = m.groupdict()
    lat = int(g["latd"]) + float(g["latm"]) / 60
    lon = int(g["lond"]) + float(g["lonm"]) / 60
    return PrelimHypocentre(
        origin_jst=_origin(int(g["y"]), int(g["mo"]), int(g["d"]), int(g["h"]), int(g["mi"]), float(g["s"])),
        lat=-lat if g["ns"] == "S" else lat,
        lon=-lon if g["ew"] == "W" else lon,
        depth_km=float(g["dep"]),
        mag=None if g["mag"] == "-" else float(g["mag"]),
        region_name_ja=g["region"].strip(" 　"),
        line_no=line_no,
    )


def parse_daily_page(page: str) -> list[PrelimHypocentre]:
    """Every hypocentre in a daily list page. Raises on a line in the list that doesn't parse."""
    parts = page.split("<pre>", 1)
    if len(parts) < 2:
        raise ValueError("no <pre> block")
    block = html.unescape(parts[1].split("</pre>", 1)[0])
    out = []
    for i, line in enumerate(block.splitlines(), start=1):
        if not line.strip() or line.lstrip().startswith(("年", "-")):
            continue
        h = parse_daily_line(line, i)
        if h is None:
            raise ValueError(f"line {i}: {line!r}")
        out.append(h)
    return out


# Intensity labels used by the database, to the catalogue's station intensity codes.
SHINDO_LABEL = {
    "震度１": "1", "震度２": "2", "震度３": "3", "震度４": "4",
    "震度５弱": "A", "震度５強": "B", "震度６弱": "C", "震度６強": "D", "震度７": "7",
}
_SHINDO_ORDER = "1234ABCD7"


def max_shindo(codes: list[str]) -> str | None:
    known = [c for c in codes if c in _SHINDO_ORDER]
    return max(known, key=_SHINDO_ORDER.index) if known else None


@dataclass(frozen=True, slots=True)
class EqdbReading:
    station_id: str
    name: str
    lat: float | None
    lon: float | None
    shindo: str  # station intensity code, as in the catalogue


@dataclass(frozen=True, slots=True)
class EqdbQuake:
    eqdb_id: str
    origin_jst: datetime | None
    lat: float | None
    lon: float | None
    depth_km: float | None
    mag: float | None
    region_name_ja: str
    max_shindo: str | None
    readings: tuple[EqdbReading, ...]


def _float(v: object) -> float | None:
    try:
        return float(str(v).replace("km", "").strip())
    except (TypeError, ValueError):
        return None


def parse_eqdb_event(res: dict) -> EqdbQuake:
    """One reply of the intensity database's event API ({"hyp": [...], "int": [...]})."""
    hyp = res["hyp"][0]
    ot = None
    m = re.fullmatch(r"(\d{4})/(\d{2})/(\d{2}) (\d{2}):(\d{2}):(\d{2}(?:\.\d)?)", hyp.get("ot") or "")
    if m:
        ot = _origin(*(int(x) for x in m.groups()[:5]), float(m.group(6)))
    readings = []
    for r in res["int"]:
        code = r.get("char") or SHINDO_LABEL.get(r.get("int", ""), "")
        if code not in _SHINDO_ORDER:
            raise ValueError(f"{hyp['id']}: unknown intensity {r!r}")
        readings.append(EqdbReading(r["code"], r.get("name", ""), _float(r.get("lat")), _float(r.get("lon")), code))
    return EqdbQuake(
        eqdb_id=hyp["id"], origin_jst=ot,
        lat=_float(hyp.get("lat")), lon=_float(hyp.get("lon")), depth_km=_float(hyp.get("dep")),
        mag=_float(hyp.get("mag")), region_name_ja=(hyp.get("name") or "").strip(),
        max_shindo=SHINDO_LABEL.get(hyp.get("maxI") or "") or max_shindo([r.shindo for r in readings]),
        readings=tuple(readings),
    )


def match_eqdb(q: EqdbQuake, candidates: list[PrelimHypocentre],
               max_dt: float = 3.0, max_deg: float = 0.3) -> PrelimHypocentre | None:
    """The daily-list hypocentre for a felt quake: nearest in time within max_dt
    seconds and max_deg in latitude and longitude. Both come from JMA's
    preliminary processing, so they normally agree to a fraction of a second."""
    if q.origin_jst is None:
        return None
    best, best_dt = None, max_dt
    for c in candidates:
        dt = abs((c.origin_jst - q.origin_jst).total_seconds())
        if dt > best_dt:
            continue
        if q.lat is not None and q.lon is not None and (abs(c.lat - q.lat) > max_deg or abs(c.lon - q.lon) > max_deg):
            continue
        best, best_dt = c, dt
    return best
