"""Parser for the JMA hypocentre file (地震月報 カタログ編, h*.zip).

Format: data/docs/hypfmt_e.html - one 96-byte record per event.
Columns 2-68 are shared with the hypocentre header of the seismic intensity
file, so they are parsed once here into `Origin`.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from . import codes
from .archive import RawRecord, iter_raw_records
from .fields import (
    ParseError,
    code,
    col,
    degrees_minutes,
    implied_decimal,
    magnitude,
    signed_int,
)

JST_OFFSET = timedelta(hours=9)


@dataclass(frozen=True, slots=True)
class Origin:
    """Columns 2-68: time, location, magnitudes and event codes."""

    origin_jst: datetime  # JMA publishes Japan Standard Time (UTC+9)
    time_se: float | None  # seconds
    lat: float  # decimal degrees, north positive
    lat_se_min: float | None  # standard error in arc-minutes, as published
    lon: float  # decimal degrees, east positive
    lon_se_min: float | None
    depth_km: float | None
    depth_whole_km: bool  # True when written as I3,2X (depth-slice / fixed depth)
    depth_se_km: float | None
    mag1: float | None  # JMA's own magnitude, used throughout the site
    mag1_type: str | None
    mag2: float | None  # second magnitude, often Mw for large events
    mag2_type: str | None
    travel_time_table: str | None
    location_precision: str | None
    event_class: str | None
    max_shindo: str | None
    damage_class: str | None
    tsunami_class: str | None
    district: int | None
    region_code: int | None
    key: bytes  # raw columns 2-68, used to link intensity records to catalogue events

    @property
    def origin_utc(self) -> datetime:
        return self.origin_jst - JST_OFFSET

    def event_id(self, agency: str) -> str:
        """Stable ID: agency + JST origin time to the centisecond + position to 0.01°.

        Origin time alone is not unique (7 collisions in 2019 between quakes in
        different regions)."""
        t = self.origin_jst
        cs = t.microsecond // 10_000
        return f"{agency}{t:%Y%m%d%H%M%S}{cs:02d}_{round(self.lat * 100)}_{round(self.lon * 100)}"


def parse_origin(rec: bytes) -> Origin:
    year, month, day = signed_int(col(rec, 2, 5)), signed_int(col(rec, 6, 7)), signed_int(col(rec, 8, 9))
    hour, minute = signed_int(col(rec, 10, 11)), signed_int(col(rec, 12, 13))
    if None in (year, month, day, hour, minute):
        raise ParseError("incomplete origin date/time")
    second = implied_decimal(col(rec, 14, 17), 2)
    try:
        origin = datetime(year, month, day, hour, minute) + timedelta(
            microseconds=round((second or 0.0) * 1_000_000)
        )
    except ValueError as e:
        raise ParseError(f"invalid origin time: {e}") from e

    lat = degrees_minutes(col(rec, 22, 24), col(rec, 25, 28), 2)
    lon = degrees_minutes(col(rec, 33, 36), col(rec, 37, 40), 2)
    if lat is None or lon is None:
        raise ParseError("missing latitude/longitude")

    depth_raw = col(rec, 45, 49)
    depth_whole_km = depth_raw[3:] == b"  " and depth_raw[:3].strip() != b""
    depth = signed_int(depth_raw[:3]) if depth_whole_km else implied_decimal(depth_raw, 2)

    return Origin(
        origin_jst=origin,
        time_se=implied_decimal(col(rec, 18, 21), 2),
        lat=lat,
        lat_se_min=implied_decimal(col(rec, 29, 32), 2),
        lon=lon,
        lon_se_min=implied_decimal(col(rec, 41, 44), 2),
        depth_km=None if depth is None else float(depth),
        depth_whole_km=depth_whole_km,
        depth_se_km=implied_decimal(col(rec, 50, 52), 2),
        mag1=magnitude(col(rec, 53, 54)),
        mag1_type=code(col(rec, 55), codes.MAG_TYPE, "magnitude type 1"),
        mag2=magnitude(col(rec, 56, 57)),
        mag2_type=code(col(rec, 58), codes.MAG_TYPE, "magnitude type 2"),
        travel_time_table=code(col(rec, 59), codes.TRAVEL_TIME_TABLE, "travel time table"),
        location_precision=code(col(rec, 60), codes.LOCATION_PRECISION, "location precision"),
        event_class=code(col(rec, 61), codes.EVENT_CLASS, "subsidiary information"),
        max_shindo=code(col(rec, 62), codes.MAX_SHINDO, "maximum intensity"),
        damage_class=code(col(rec, 63), codes.DAMAGE_CLASS, "damage class"),
        tsunami_class=code(col(rec, 64), codes.TSUNAMI_CLASS, "tsunami class"),
        district=signed_int(col(rec, 65)),
        region_code=signed_int(col(rec, 66, 68)),
        key=col(rec, 2, 68),
    )


@dataclass(frozen=True, slots=True)
class Hypocentre:
    agency: str  # J / U / I
    origin: Origin
    region_name: str  # English name (A24)
    n_stations: int | None  # stations used to locate the event
    flag: str | None  # K/S/k/s/A/a/N/F
    source: str
    line_no: int

    @property
    def id(self) -> str:
        return self.origin.event_id(self.agency)


def parse_hypo_record(raw: RawRecord) -> Hypocentre:
    rec = raw.data
    try:
        agency = code(col(rec, 1), codes.AGENCY, "record type")
        if agency is None:
            raise ParseError("blank record type")
        return Hypocentre(
            agency=agency,
            origin=parse_origin(rec),
            region_name=col(rec, 69, 92).decode("ascii").rstrip(),
            n_stations=signed_int(col(rec, 93, 95)),
            flag=code(col(rec, 96), codes.HYPO_FLAG, "hypocentre flag"),
            source=raw.source,
            line_no=raw.line_no,
        )
    except (ParseError, UnicodeDecodeError) as e:
        raise ParseError(f"{raw.source}:{raw.line_no}: {e}\n  {rec!r}") from e


def iter_hypocentres(path: str | Path) -> Iterator[Hypocentre]:
    for raw in iter_raw_records(path):
        yield parse_hypo_record(raw)
