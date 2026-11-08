"""Individual records whose values are clearly wrong in JMA's files.

Each erratum blanks a column range (making the value missing) in one record,
identified by its first 17 bytes (record type + origin time). It applies only
if the bytes still read as expected, so a corrected JMA release is left alone.
Applied errata are recorded on the parsed event.
"""

from __future__ import annotations

from dataclasses import dataclass

from .fields import col


@dataclass(frozen=True)
class Erratum:
    record_prefix: bytes
    start: int  # 1-indexed inclusive columns, as in the JMA docs
    end: int
    expected: bytes
    reason: str


HYPO_ERRATA = [
    Erratum(
        b"U198703061839542 ", 56, 58, b"8 S",
        "magnitude 2 reads MS '8 ' (8.0) for an mb 5.7 event; not a valid F2.1 value",
    ),
]

_BY_PREFIX = {e.record_prefix: e for e in HYPO_ERRATA}


def apply_hypo_errata(rec: bytes) -> tuple[bytes, tuple[str, ...]]:
    e = _BY_PREFIX.get(rec[:17])
    if e is None or col(rec, e.start, e.end) != e.expected:
        return rec, ()
    blanked = rec[: e.start - 1] + b" " * (e.end - e.start + 1) + rec[e.end :]
    return blanked, (e.reason,)
