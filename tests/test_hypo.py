"""Hypocentre records, using real lines from h2019."""

from datetime import datetime

import pytest

from pipeline.jma.archive import RawRecord
from pipeline.jma.fields import ParseError
from pipeline.jma.hypo import parse_hypo_record


def rec(line: str) -> RawRecord:
    assert len(line) <= 96
    return RawRecord("test", 1, line.encode("ascii").ljust(96))


YAMAGATA = "J2019061822221998 007 383648 025 1392876 035 139910467D65W511D212 57W OFF YAMAGATA PREF      40K"
DEPTH_SLICE = "J2019010101122633 119 363693 214 1415649 568 22     16V   521   3112FAR E OFF IBARAKI PREF   12s"
MATCHED_FILTER_LFE = "J2019010101264170     343774     1363251     3228   -7v   5M5   5209ISE BAY REGION           10a"
NO_MAGNITUDE = "J2019010103474483 005 350691 010 1381094 010 1357038      511   4157CENTRAL SHIZUOKA PREF    10k"
USGS_SW = "U2019010604253852    - 80864    - 713522    570     64B         9   WESTERN BRAZIL"
USGS_W_LONG = "U2019010603471174     512009    -1780709     30     58B59S      9   ANDREANOF IS., ALEUTIAN"


def test_full_record():
    h = parse_hypo_record(rec(YAMAGATA))
    o = h.origin
    assert h.agency == "J"
    assert o.origin_jst == datetime(2019, 6, 18, 22, 22, 19, 980000)
    assert o.origin_utc == datetime(2019, 6, 18, 13, 22, 19, 980000)
    assert o.time_se == 0.07
    assert o.lat == pytest.approx(38 + 36.48 / 60)
    assert o.lon == pytest.approx(139 + 28.76 / 60)
    assert (o.lat_se_min, o.lon_se_min) == (0.25, 0.35)
    assert (o.depth_km, o.depth_whole_km, o.depth_se_km) == (13.99, False, 1.04)
    assert (o.mag1, o.mag1_type, o.mag2, o.mag2_type) == (6.7, "D", 6.5, "W")
    assert (o.travel_time_table, o.location_precision, o.event_class) == ("5", "1", "1")
    assert (o.max_shindo, o.damage_class, o.tsunami_class) == ("D", "2", "1")
    assert (o.district, o.region_code) == (2, 57)
    assert h.region_name == "W OFF YAMAGATA PREF"
    assert (h.n_stations, h.flag) == (40, "K")
    assert h.id == "J2019061822221998_3861_13948"


def test_depth_slice_depth_is_whole_km_without_error():
    o = parse_hypo_record(rec(DEPTH_SLICE)).origin
    assert o.location_precision == "2"
    assert (o.depth_km, o.depth_whole_km, o.depth_se_km) == (22.0, True, None)
    assert o.mag1 == 1.6


def test_matched_filter_low_frequency_event():
    o = parse_hypo_record(rec(MATCHED_FILTER_LFE)).origin
    assert o.location_precision == "M"
    assert o.event_class == "5"
    # standard errors are blank for matched-filter events
    assert (o.time_se, o.lat_se_min, o.lon_se_min, o.depth_se_km) == (None, None, None, None)
    assert o.depth_km == 32.28
    assert (o.mag1, o.mag1_type) == (-0.7, "v")


def test_missing_magnitude_is_none():
    o = parse_hypo_record(rec(NO_MAGNITUDE)).origin
    assert (o.mag1, o.mag1_type, o.mag2) == (None, None, None)
    assert o.depth_km == 13.57


def test_usgs_record_southern_western_hemisphere():
    h = parse_hypo_record(rec(USGS_SW))
    o = h.origin
    assert h.agency == "U"
    assert o.lat == pytest.approx(-(8 + 8.64 / 60))
    assert o.lon == pytest.approx(-(71 + 35.22 / 60))
    assert (o.depth_km, o.depth_whole_km) == (570.0, True)
    assert (o.mag1, o.mag1_type) == (6.4, "B")
    assert (o.travel_time_table, o.location_precision, h.flag, o.region_code) == (None, None, None, None)
    assert o.district == 9
    assert h.region_name == "WESTERN BRAZIL"


def test_usgs_record_three_digit_west_longitude():
    o = parse_hypo_record(rec(USGS_W_LONG)).origin
    assert o.lon == pytest.approx(-(178 + 7.09 / 60))
    assert (o.mag1, o.mag1_type, o.mag2, o.mag2_type) == (5.8, "B", 5.9, "S")


def test_undocumented_code_raises_with_location():
    bad = YAMAGATA[:60] + "9" + YAMAGATA[61:]  # subsidiary information '9' is undocumented
    with pytest.raises(ParseError, match=r"test:1: undocumented subsidiary information code '9'"):
        parse_hypo_record(rec(bad))


def test_invalid_date_raises():
    with pytest.raises(ParseError, match="invalid origin time"):
        parse_hypo_record(rec(YAMAGATA.replace("20190618", "20190631", 1)))
