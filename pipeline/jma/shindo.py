"""Parser for the JMA seismic intensity file (震度データ, i*.zip).

Format: data/docs/shindo_format_e.txt. Unlike the hypocentre file it has
CRLF line endings and Japanese region names: Shift-JIS (cp932) up to 2022,
EUC-JP from 2023. The encoding is detected per file.

The file is a sequence of groups: one or more hypocentre headers (record
type A/B/D in column 1) followed by that group's station records.
  - Type A: one event. If there are several A headers, the first is JMA's
    preferred solution and the rest are alternatives.
  - Type B/D: several close events whose intensity data cannot be separated;
    each header is a distinct event and they all share the station records.

Not every header is a located earthquake:
  - 'details unknown' (詳細不明) headers, location method 8, flag N: felt at
    a station but no hypocentre was determined. The position given is the
    reporting station's, and the standard errors read ' 99 ' (unknown).
  - flags H/D/M: exact time unknown; the origin time is a placeholder such
    as 23:59:59.9 and there is no position.
"""

from __future__ import annotations

import calendar
from collections.abc import Iterator
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from pathlib import Path

from . import codes
from .archive import RawRecord, iter_members, split_records
from .fields import ParseError, code, col, implied_decimal, is_missing, signed_int
from .hypo import Origin, parse_origin

ENCODINGS = ("cp932", "euc_jp")
TIME_UNKNOWN_FLAGS = frozenset("HDM")
UNKNOWN = 99  # day/hour/minute value meaning "not known"


@dataclass(frozen=True, slots=True)
class ShindoHeader:
    record_type: str  # A / B / D
    origin: Origin
    region_name_ja: str  # A22 bytes
    n_felt: int | None  # number of stations reporting the shock
    flag: str | None  # K/S/k/s/A/a/N/U/I/R/H/D/M
    source: str
    line_no: int

    @property
    def agency(self) -> str:
        """Who located the event, in the hypocentre file's terms (J/U/I)."""
        return self.flag if self.flag in ("U", "I") else "J"

    @property
    def time_known(self) -> bool:
        return self.flag not in TIME_UNKNOWN_FLAGS

    @property
    def located(self) -> bool:
        """True if the header carries a real hypocentre (not a station
        position or a placeholder)."""
        return self.time_known and self.origin.lat is not None and self.origin.location_precision != "8"


@dataclass(frozen=True, slots=True)
class Period:
    kind: str  # 'F' = frequency in 0.1 Hz units, 'P' = period in 0.1 s units
    value: float  # Hz if kind == 'F', seconds if kind == 'P'


@dataclass(frozen=True, slots=True)
class ShindoObs:
    station_id: str
    obs_time_raw: str  # columns 9-17 as published (DDhhmmss.s), kept when the time can't be decoded
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


def parse_header(raw: RawRecord, encoding: str = "cp932") -> ShindoHeader:
    rec = raw.data
    try:
        record_type = code(col(rec, 1), codes.SHINDO_RECORD_TYPE, "record type")
        origin = parse_origin(rec)
        if origin.location_precision == "8":
            # ' 99 ' in the error columns is a placeholder, not 9.9
            origin = replace(origin, time_se=None, lat_se_min=None, lon_se_min=None, depth_se_km=None)
        return ShindoHeader(
            record_type=record_type,  # type: ignore[arg-type]
            origin=origin,
            region_name_ja=col(rec, 69, 90).decode(encoding).rstrip(" 　"),
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
    earlier than the origin's (a quake just before midnight at month end).
    Old records write 99 for an unknown part (the convention code_p.dat
    documents); the time is then unknown."""
    if None in (day, hour, minute) or UNKNOWN in (day, hour, minute):
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):  # type: ignore[operator]
        raise ParseError(f"invalid station time {day:02d} {hour:02d}:{minute:02d}")
    year, month = origin.year, origin.month
    if day < origin.day:  # type: ignore[operator]
        year, month = _add_month(origin)
    if not 1 <= day <= calendar.monthrange(year, month)[1]:  # type: ignore[operator]
        raise ParseError(f"day {day} invalid for {year}-{month:02d}")
    return datetime(year, month, day, hour, minute) + timedelta(  # type: ignore[arg-type]
        microseconds=round((second or 0.0) * 1_000_000)
    )


def _acc_time(obs_time: datetime | None, minute: int | None, second: float | None) -> datetime | None:
    """Max-acceleration time is given as minute + second only; it falls within
    the hour after the observation time."""
    if obs_time is None or minute is None or minute == UNKNOWN:
        return None
    if not 0 <= minute <= 59:
        raise ParseError(f"invalid max-acceleration minute {minute}")
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


def parse_observation(raw: RawRecord, origin: datetime, strict_time: bool = True) -> ShindoObs:
    """strict_time=False (for groups without a located, timed hypocentre) turns
    an undecodable station time into None instead of an error; the raw text
    is kept either way."""
    rec = raw.data
    try:
        station_id = col(rec, 1, 7).decode("ascii").strip()
        if not station_id.isdigit():
            raise ParseError(f"bad station number {station_id!r}")
        for c, expected in ((36, b"N"), (43, b"E"), (50, b"Z")):
            if col(rec, c) not in (expected, b" "):
                raise ParseError(f"column {c}: expected {expected!r}, got {col(rec, c)!r}")
        try:
            obs_time = _station_time(
                origin,
                signed_int(col(rec, 9, 10)),
                signed_int(col(rec, 11, 12)),
                signed_int(col(rec, 13, 14)),
                implied_decimal(col(rec, 15, 17), 1),
            )
            acc_time = _acc_time(obs_time, signed_int(col(rec, 24, 25)), implied_decimal(col(rec, 26, 28), 1))
        except ParseError:
            if strict_time:
                raise
            obs_time = acc_time = None
        instrumental = signed_int(col(rec, 21, 22))
        shindo = code(col(rec, 19), codes.STATION_SHINDO, "station intensity")
        if shindo is None:
            raise ParseError("blank station intensity")
        return ShindoObs(
            station_id=station_id,
            obs_time_raw=col(rec, 9, 17).decode("ascii"),
            obs_time_jst=obs_time,
            shindo=shindo,
            instrumental=None if instrumental is None else instrumental / 10,
            max_acc_time_jst=acc_time,
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


def detect_encoding(source: str, payload: bytes) -> str:
    for enc in ENCODINGS:
        try:
            payload.decode(enc)
            return enc
        except UnicodeDecodeError:
            continue
    raise ParseError(f"{source}: not decodable as any of {ENCODINGS}")


def iter_shindo_groups(path: str | Path) -> Iterator[ShindoGroup]:
    for source, payload in iter_members(path):
        encoding = detect_encoding(source, payload)
        group: ShindoGroup | None = None
        for raw in split_records(source, payload):
            if raw.data[:1] in (b"A", b"B", b"D"):
                if group is not None and group.observations:
                    yield group
                    group = None
                if group is None:
                    group = ShindoGroup()
                header = parse_header(raw, encoding)
                if group.headers and header.record_type != group.record_type:
                    raise ParseError(f"{raw.source}:{raw.line_no}: mixed header types in one group")
                group.headers.append(header)
            else:
                if group is None:
                    raise ParseError(f"{raw.source}:{raw.line_no}: station record before any header")
                first = group.headers[0]
                group.observations.append(
                    parse_observation(raw, first.origin.origin_jst, strict_time=first.located)
                )
        if group is not None:
            yield group
