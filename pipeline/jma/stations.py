"""Parser for the seismic intensity station list (code_p.zip -> code_p.dat).

Tab-separated, six columns (data/docs/shindo_format_e.txt). The docs say the
names are JIS-encoded, but the current file is UTF-8; we accept either.
Coordinates are JGD2000 to the nearest arc-minute (~1.8 km).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .archive import read_member_bytes
from .fields import ParseError


@dataclass(frozen=True, slots=True)
class Station:
    id: str
    name: str
    lat: float
    lon: float
    start: str | None  # ISO prefix, as precise as JMA knows it: '1954', '2003-03-10T12:00'
    end: str | None  # None while the station is still operating


def partial_datetime(raw: str) -> str | None:
    """'YYYYMMDDhhmm' where unknown parts are 99/9999 -> ISO prefix up to the
    first unknown part. Blank -> None."""
    raw = raw.strip()
    if not raw:
        return None
    if len(raw) != 12 or not raw.isdigit():
        raise ParseError(f"bad station date {raw!r}")
    year, parts = raw[:4], [raw[4:6], raw[6:8], raw[8:10], raw[10:12]]
    if year == "9999":
        return None
    out = year
    for sep, part in zip(("-", "-", "T", ":"), parts):
        if part == "99":
            break
        out += sep + part
    return out


def _dm(raw: str, deg_width: int) -> float:
    if len(raw) != deg_width + 2 or not raw.isdigit():
        raise ParseError(f"bad coordinate {raw!r}")
    minutes = int(raw[deg_width:])
    if minutes >= 60:
        raise ParseError(f"bad coordinate minutes {raw!r}")
    return int(raw[:deg_width]) + minutes / 60


def _decode(data: bytes) -> str:
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("cp932")


def parse_stations(path: str | Path) -> dict[str, Station]:
    stations: dict[str, Station] = {}
    for n, line in enumerate(_decode(read_member_bytes(path)).splitlines(), start=1):
        if not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) != 6:
            raise ParseError(f"code_p line {n}: expected 6 columns, got {len(cols)}")
        sid, name, lat, lon, start, end = cols
        if sid in stations:
            raise ParseError(f"code_p line {n}: duplicate station {sid}")
        try:
            stations[sid] = Station(sid, name.strip(), _dm(lat, 2), _dm(lon, 3),
                                    partial_datetime(start), partial_datetime(end))
        except ParseError as e:
            raise ParseError(f"code_p line {n}: {e}") from e
    return stations
