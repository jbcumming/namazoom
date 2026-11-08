"""Read 96-byte records from JMA zips (or already-extracted files)."""

from __future__ import annotations

import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from .fields import ParseError

RECORD_LENGTH = 96


@dataclass(frozen=True, slots=True)
class RawRecord:
    source: str  # "h2019.zip:h2019"
    line_no: int  # 1-based within the member
    data: bytes  # exactly RECORD_LENGTH bytes


def _split(source: str, payload: bytes) -> Iterator[RawRecord]:
    # Hypocentre files use LF, intensity files CRLF.
    for n, line in enumerate(payload.split(b"\n"), start=1):
        line = line.rstrip(b"\r")
        if not line:
            continue
        if len(line) > RECORD_LENGTH:
            raise ParseError(f"{source}:{n}: record is {len(line)} bytes, expected {RECORD_LENGTH}")
        # Trailing blanks are significant (blank = missing); restore any that were trimmed.
        yield RawRecord(source, n, line.ljust(RECORD_LENGTH, b" "))


def iter_members(path: str | Path) -> Iterator[tuple[str, bytes]]:
    """(source name, contents) for each member of a .zip, in name order, or a plain file."""
    path = Path(path)
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            for name in sorted(n for n in zf.namelist() if not n.endswith("/")):
                yield f"{path.name}:{name}", zf.read(name)
    else:
        yield path.name, path.read_bytes()


def split_records(source: str, payload: bytes) -> Iterator[RawRecord]:
    return _split(source, payload)


def iter_raw_records(path: str | Path) -> Iterator[RawRecord]:
    """Yield every record from a .zip (all members, in name order) or a plain file."""
    for source, payload in iter_members(path):
        yield from _split(source, payload)


def read_member_bytes(path: str | Path) -> bytes:
    """Contents of a single-member zip, or of a plain file."""
    path = Path(path)
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            names = [n for n in zf.namelist() if not n.endswith("/")]
            if len(names) != 1:
                raise ParseError(f"{path.name}: expected one member, found {names}")
            return zf.read(names[0])
    return path.read_bytes()
