import pytest

from pipeline.jma.fields import (
    ParseError,
    code,
    degrees_minutes,
    implied_decimal,
    magnitude,
    signed_int,
)


@pytest.mark.parametrize(
    "raw, expected",
    [
        (b"58", 5.8), (b"00", 0.0), (b"99", 9.9),
        # JMA's negative coding (hypfmt_e.html, magnitude 1)
        (b"-1", -0.1), (b"-9", -0.9),
        (b"A0", -1.0), (b"A9", -1.9), (b"B0", -2.0), (b"C0", -3.0),
        (b"  ", None),
    ],
)
def test_magnitude(raw, expected):
    assert magnitude(raw) == expected


@pytest.mark.parametrize("raw", [b"5 ", b" 5", b"a1", b"-A"])
def test_magnitude_rejects_undocumented(raw):
    with pytest.raises(ParseError):
        magnitude(raw)


@pytest.mark.parametrize(
    "raw, decimals, expected",
    [
        (b"3237", 2, 32.37),
        (b" 005", 2, 0.05),
        (b"13991", 2, 139.91),
        (b"41  ", 2, 41.0),  # fixed hypocentre: blanks after the decimal point
        (b"415 ", 2, 41.5),
        (b"479", 1, 47.9),
        (b"    ", 2, None),
    ],
)
def test_implied_decimal(raw, decimals, expected):
    assert implied_decimal(raw, decimals) == expected


@pytest.mark.parametrize("raw", [b"4 52", b"x123"])
def test_implied_decimal_rejects_garbage(raw):
    with pytest.raises(ParseError):
        implied_decimal(raw, 2)


@pytest.mark.parametrize(
    "raw, expected",
    [(b" 34", 34), (b"- 8", -8), (b"-178", -178), (b"   ", None), (b"//", None), (b"/////", None)],
)
def test_signed_int(raw, expected):
    assert signed_int(raw) == expected


def test_degrees_minutes_sign_applies_to_minutes():
    assert degrees_minutes(b"- 8", b"0864", 2) == pytest.approx(-(8 + 8.64 / 60))
    # '-0' degrees must stay negative
    assert degrees_minutes(b"- 0", b"3000", 2) == pytest.approx(-0.5)


def test_degrees_minutes_rejects_60_minutes():
    with pytest.raises(ParseError):
        degrees_minutes(b" 35", b"6000", 2)


def test_code_rejects_undocumented():
    assert code(b" ", {"1": "x"}, "f") is None
    with pytest.raises(ParseError, match="undocumented"):
        code(b"2", {"1": "x"}, "f")
