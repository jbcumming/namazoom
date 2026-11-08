"""Low-level decoders for JMA fixed-width fields.

Column positions throughout the package are the 1-indexed, inclusive positions
used in JMA's format documentation (data/docs/), so code can be checked against
the docs line by line. Records are handled as *bytes*: the seismic intensity
files contain Shift-JIS region names, where one character is two bytes, so
character-based slicing would shift every later column.
"""

from __future__ import annotations


class ParseError(ValueError):
    """A record that does not match the documented format."""


def col(rec: bytes, start: int, end: int | None = None) -> bytes:
    """Slice columns `start`..`end` (1-indexed, inclusive) as in the JMA docs."""
    return rec[start - 1 : (start if end is None else end)]


def _text(raw: bytes) -> str:
    try:
        return raw.decode("ascii")
    except UnicodeDecodeError as e:
        raise ParseError(f"non-ASCII bytes in numeric field {raw!r}") from e


def is_missing(raw: bytes) -> bool:
    """Blank, or JMA's '/' fill meaning 'not observed'."""
    return raw.strip(b" /") == b""


def signed_int(raw: bytes) -> int | None:
    """Integer field (Fortran I). A leading '-' may be separated from the
    digits by spaces, e.g. latitude degrees '- 8' in USGS records."""
    if is_missing(raw):
        return None
    s = _text(raw).strip()
    neg = s.startswith("-")
    digits = s[1:].strip() if neg else s
    if not digits.isdigit():
        raise ParseError(f"bad integer field {raw!r}")
    return -int(digits) if neg else int(digits)


def implied_decimal(raw: bytes, decimals: int) -> float | None:
    """Fortran F field with an implied decimal point, e.g. F4.2 '4752' -> 47.52.

    Blanks inside the field are read as zeros (Fortran's BZ mode). This is
    the one rule that fits every variant in the catalogue:
      '41  '  -> 41.00  seconds of a fixed hypocentre (documented: blank after the point)
      '530 '  -> 53.00  low-precision minutes in early records
      '  0 4' -> 0.04   whole and fractional parts written separately (h2016 depths)
      '   0'  -> 0.00   (h1955 standard error)
    An all-blank field is missing (None), not zero. '/' marks an unknown
    digit and is read like a blank: station seconds '26/' -> 26.0.
    """
    if is_missing(raw):
        return None
    s = _text(raw).replace("/", " ").lstrip()
    if "." in s:
        try:
            return float(s.replace(" ", ""))
        except ValueError as e:
            raise ParseError(f"bad decimal field {raw!r}") from e
    neg = s.startswith("-")
    digits = (s[1:] if neg else s).replace(" ", "0")
    if not digits.isdigit():
        raise ParseError(f"bad decimal field {raw!r}")
    value = int(digits) / 10**decimals
    return round(-value if neg else value, decimals)


def magnitude(raw: bytes) -> float | None:
    """Two-byte magnitude field (F2.1) with JMA's negative-value coding:

    '-1'..'-9' = -0.1..-0.9, 'A0'..'A9' = -1.0..-1.9, 'B0' = -2.0, 'C0' = -3.0.
    """
    if raw.strip() == b"":
        return None
    s = _text(raw)
    if len(s) != 2 or not s[1].isdigit():
        raise ParseError(f"bad magnitude field {raw!r}")
    first, tenth = s[0], int(s[1])
    if first.isdigit():
        return round(int(first) + tenth / 10, 1)
    if first == "-":
        return round(-tenth / 10, 1)
    if "A" <= first <= "Z":
        return round(-(ord(first) - ord("A") + 1) - tenth / 10, 1)
    raise ParseError(f"bad magnitude field {raw!r}")


def degrees_minutes(deg_raw: bytes, min_raw: bytes, min_decimals: int) -> float | None:
    """Degrees + decimal minutes -> signed decimal degrees.

    The sign is carried on the degrees field only ('- 0' must still be
    negative), and applies to the minutes too.
    """
    if is_missing(deg_raw):
        return None
    neg = _text(deg_raw).strip().startswith("-")
    deg = abs(signed_int(deg_raw))  # type: ignore[arg-type]
    minutes = implied_decimal(min_raw, min_decimals) or 0.0
    # Exactly 60 minutes occurs in two 'details unknown' intensity headers
    # (1967, 1974) and means the next whole degree.
    if not 0 <= minutes <= 60:
        raise ParseError(f"minutes out of range: {min_raw!r}")
    value = deg + minutes / 60
    return -value if neg else value


def code(raw: bytes, allowed: dict[str, str] | frozenset[str], field: str) -> str | None:
    """Single-character code; blank -> None; anything undocumented raises."""
    s = _text(raw)
    if s.strip() == "":
        return None
    if s not in allowed:
        raise ParseError(f"undocumented {field} code {s!r}")
    return s
