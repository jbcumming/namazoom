"""Parser for the JMA seismic intensity file (震度データ, i*.zip).

Format: data/docs/shindo_format_e.txt. Unlike the hypocentre file it is
Shift-JIS (cp932) with CRLF line endings.

The file is a sequence of groups: one or more hypocentre headers (record
type A/B/D in column 1) followed by that group's station records.
  - Type A: one event. If there are several A headers, the first is JMA's
    preferred solution and the rest are alternatives.
  - Type B/D: several close events whose intensity data cannot be separated;
    each header is a distinct event and they all share the station records.
"""

from __future__ import annotations

import calendar
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from . import codes
from .archive import RawRecord, iter_raw_records
from .fields import ParseError, code, col, implied_decimal, is_missing, signed_int
from .hypo import Origin, parse_origin

TEXT_ENCODING = "cp932"


@dataclass(frozen=True, slots=True)
class ShindoHeader:
    record_type: str  # A / B / D
    origin: Origin
    region_name_ja: str  # A22 bytes, Shift-JIS
    n_felt: int | None  # number of stations reporting the shock
    flag: str | None  # K/S/k/s/A/a/N/U/I/R/H/D/M
    source: str
    line_no: int

    @property
    def agency(self) -> str:
        """Who located the event, in the hypocentre file's terms (J/U/I)."""
        return self.flag if self.flag in ("U", "I") else "J"


@dataclass(frozen=True, slots=True)
class Period:
    kind: str  # 'F' = frequency in 0.1 Hz units, 'P' = period in 0.1 s units
    value: float  # Hz if kind == 'F', seconds if kind == 'P'


@dataclass(frozen=True, slots=True)
class ShindoObs:
    station_id: str
    obs_time_jst: datetime | None
    shindo: str  # station intensity code, see codes.STATION_SHINDO
    instrumental: float | None  # instrumental intensity (one decimal)
    max_acc_time_jst: datetime | None
    acc_total_gal: float | None  # cm/s², vector sum of three components
    acc_ns_gal: float | None
    acc_ew_gal: float | None
    acc_ud_gal: float | None
    # (max-acceleration period, predominant period) for NS, EW, UD; from Oct 2000.
    periods: tuple[Period | None, ...]
    source: str
    line_no: int


@dataclass(slots=True)
class ShindoGroup:
    headers: list[ShindoHeader] = field(default_factory=list)
    observations: list[ShindoObs] = field(default_factory=list)

    @property
    def record_type(self) -> str:
        return self.headers[0].record_type

    @property
    def events(self) -> list[ShindoHeader]:
        """Distinct events: the preferred header for type A, all headers for B/D."""
        return self.headers[:1] if self.record_type == "A" else list(self.headers)


def parse_header(raw: RawRecord) -> ShindoHeader:
    rec = raw.data
    try:
        record_type = code(col(rec, 1), codes.SHINDO_RECORD_TYPE, "record type")
        return ShindoHeader(
            record_type=record_type,  # type: ignore[arg-type]
            origin=parse_origin(rec),
            region_name_ja=col(rec, 69, 90).decode(TEXT_ENCODING).rstrip(" 　"),
            n_felt=signed_int(col(rec, 91, 95)),
            flag=code(col(rec, 96), codes.SHINDO_HEADER_FLAG, "hypocentre flag"),
            source=raw.source,
            line_no=raw.line_no,
        )
    except (ParseError, UnicodeDecodeError) as e:
        raise ParseError(f"{raw.source}:{raw.line_no}: {e}\n  {rec!r}") from e


def _add_month(t: datetime) -> tuple[int, int]:
    return (t.year + 1, 1) if t.month == 12 else (t.year, t.month + 1)


def _station_time(origin: datetime, day: int | None, hour: int | None, minute: int | None,
                  second: float | None) -> datetime | None:
    """Station records give only day/hour/minute/second. Take year and month
    from the event origin, rolling into the next month when the day is
    earlier than the origin's (a quake just before midnight at month end)."""
    if None in (day, hour, minute):
        return None
    year, month = origin.year, origin.month
    if day < origin.day:  # type: ignore[operator]
        year, month = _add_month(origin)
    if day > calendar.monthrange(year, month)[1]:  # type: ignore[operator]
        raise ParseError(f"day {day} invalid for {year}-{month:02d}")
    return datetime(year, month, day, hour, minute) + timedelta(  # type: ignore[arg-type]
        microseconds=round((second or 0.0) * 1_000_000)
    )


def _acc_time(obs_time: datetime | None, minute: int | None, second: float | None) -> datetime | None:
    """Max-acceleration time is given as minute + second only; it falls within
    the hour after the observation time."""
    if obs_time is None or minute is None:
        return None
    t = obs_time.replace(minute=minute, second=0, microsecond=0) + timedelta(
        microseconds=round((second or 0.0) * 1_000_000)
    )
    if t < obs_time - timedelta(minutes=1):
        t += timedelta(hours=1)
    return t


def _gal(raw: bytes) -> float | None:
    v = signed_int(raw)  # unit 0.1 cm/s²
    return None if v is None else v / 10


def _period(raw: bytes) -> Period | None:
    if is_missing(raw):
        return None
    kind = raw[:1].decode("ascii")
    if kind not in ("F", "P"):
        raise ParseError(f"bad period identifier {raw!r}")
    v = signed_int(raw[1:])
    return None if v is None else Period(kind, v / 10)


def parse_observation(raw: RawRecord, origin: datetime) -> ShindoObs:
    rec = raw.data
    try:
        station_id = col(rec, 1, 7).decode("ascii").strip()
        if not station_id.isdigit():
            raise ParseError(f"bad station number {station_id!r}")
        for c, expected in ((36, b"N"), (43, b"E"), (50, b"Z")):
            if col(rec, c) not in (expected, b" "):
                raise ParseError(f"column {c}: expected {expected!r}, got {col(rec, c)!r}")
        obs_time = _station_time(
            origin,
            signed_int(col(rec, 9, 10)),
            signed_int(col(rec, 11, 12)),
            signed_int(col(rec, 13, 14)),
            implied_decimal(col(rec, 15, 17), 1),
        )
        instrumental = signed_int(col(rec, 21, 22))
        shindo = code(col(rec, 19), codes.STATION_SHINDO, "station intensity")
        if shindo is None:
            raise ParseError("blank station intensity")
        return ShindoObs(
            station_id=station_id,
            obs_time_jst=obs_time,
            shindo=shindo,
            instrumental=None if instrumental is None else instrumental / 10,
            max_acc_time_jst=_acc_time(obs_time, signed_int(col(rec, 24, 25)), implied_decimal(col(rec, 26, 28), 1)),
            acc_total_gal=_gal(col(rec, 30, 34)),
            acc_ns_gal=_gal(col(rec, 37, 41)),
            acc_ew_gal=_gal(col(rec, 44, 48)),
            acc_ud_gal=_gal(col(rec, 51, 55)),
            periods=tuple(_period(col(rec, c, c + 3)) for c in range(57, 81, 4)),
            source=raw.source,
            line_no=raw.line_no,
        )
    except ParseError as e:
        raise ParseError(f"{raw.source}:{raw.line_no}: {e}\n  {rec!r}") from e


def iter_shindo_groups(path: str | Path) -> Iterator[ShindoGroup]:
    group: ShindoGroup | None = None
    for raw in iter_raw_records(path):
        if raw.data[:1] in (b"A", b"B", b"D"):
            if group is not None and group.observations:
                yield group
                group = None
            if group is None:
                group = ShindoGroup()
            header = parse_header(raw)
            if group.headers and header.record_type != group.record_type:
                raise ParseError(f"{raw.source}:{raw.line_no}: mixed header types in one group")
            group.headers.append(header)
        else:
            if group is None:
                raise ParseError(f"{raw.source}:{raw.line_no}: station record before any header")
            group.observations.append(parse_observation(raw, group.headers[0].origin.origin_jst))
    if group is not None:
        yield group
