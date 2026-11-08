"""Seismic intensity file. fixtures/i2019_sample.dat holds six real groups from
i2019 (CRLF, Shift-JIS), including a type-B group and a USGS-located event."""

from datetime import datetime
from pathlib import Path

import pytest

from pipeline.jma.archive import RawRecord
from pipeline.jma.fields import ParseError
from pipeline.jma.shindo import iter_shindo_groups, parse_header, parse_observation

FIXTURE = Path(__file__).parent / "fixtures" / "i2019_sample.dat"


@pytest.fixture(scope="module")
def groups():
    return list(iter_shindo_groups(FIXTURE))


def test_grouping(groups):
    assert [(len(g.headers), len(g.observations)) for g in groups] == [
        (1, 1), (1, 2), (1, 1), (2, 1), (1, 522), (1, 3)
    ]
    assert [g.record_type for g in groups] == ["A", "A", "A", "B", "A", "A"]


def test_header(groups):
    h = groups[0].headers[0]
    assert h.record_type == "A"
    assert h.origin.origin_jst == datetime(2019, 1, 1, 4, 4, 28, 540000)
    assert h.origin.mag1 == 3.2
    assert h.region_name_ja == "根室半島南東沖"
    assert (h.n_felt, h.flag, h.agency) == (1, "K", "J")


def test_observation(groups):
    o = groups[0].observations[0]
    assert o.station_id == "1670022"
    assert o.obs_time_jst == datetime(2019, 1, 1, 4, 4, 47, 900000)
    assert (o.shindo, o.instrumental) == ("1", 0.5)
    assert o.max_acc_time_jst == datetime(2019, 1, 1, 4, 4, 48, 900000)
    assert (o.acc_total_gal, o.acc_ns_gal, o.acc_ew_gal, o.acc_ud_gal) == (2.4, 2.4, 1.5, 0.6)
    assert [(p.kind, p.value) for p in o.periods] == [
        ("F", 4.5), ("F", 5.3), ("F", 5.5), ("F", 5.5), ("F", 10.3), ("F", 10.3)
    ]


def test_type_b_group_has_two_events_sharing_observations(groups):
    g = groups[3]
    assert len(g.events) == 2
    assert {e.record_type for e in g.events} == {"B"}
    assert [e.origin.mag1 for e in g.events] == [2.2, 2.0]


def test_kumamoto_6_lower(groups):
    g = groups[4]
    assert g.headers[0].origin.max_shindo == "C"
    assert max(o.instrumental for o in g.observations) >= 5.5
    assert sum(o.shindo == "C" for o in g.observations) >= 1


def test_usgs_located_event(groups):
    h = groups[5].headers[0]
    assert (h.flag, h.agency) == ("U", "U")
    assert h.region_name_ja == "サハリン近海"


# --- synthetic edge cases, built by editing real records ---------------------

HEADER = FIXTURE.read_bytes().split(b"\r\n")[0]
OBS = FIXTURE.read_bytes().split(b"\r\n")[1]


def _raw(data: bytes) -> RawRecord:
    return RawRecord("test", 1, data.ljust(96))


def test_station_time_rolls_into_next_month_and_year():
    origin = datetime(2019, 12, 31, 23, 59, 58)
    obs = b"1670022 010000051" + OBS[17:]  # day 01, 00:00:05.1
    o = parse_observation(_raw(obs), origin)
    assert o.obs_time_jst == datetime(2020, 1, 1, 0, 0, 5, 100000)


def test_max_acceleration_time_rolls_into_next_hour():
    origin = datetime(2019, 1, 1, 4, 59, 40)
    obs = OBS[:8] + b"010459555" + OBS[17:23] + b"00012" + OBS[28:]  # obs 04:59:55.5, max acc at :00:01.2
    o = parse_observation(_raw(obs), origin)
    assert o.max_acc_time_jst == datetime(2019, 1, 1, 5, 0, 1, 200000)


def test_slashes_mean_not_observed():
    obs = OBS[:20] + b"//" + OBS[22:29] + b"/////" + OBS[34:]
    o = parse_observation(_raw(obs), datetime(2019, 1, 1, 4, 4, 28))
    assert (o.instrumental, o.acc_total_gal) == (None, None)
    assert o.shindo == "1"


def test_region_name_is_decoded_by_bytes_not_characters():
    h = parse_header(_raw(HEADER))
    # 7 two-byte characters + padding fill exactly the 22-byte field; the
    # felt count and flag after it must still line up.
    assert (h.region_name_ja, h.n_felt, h.flag) == ("根室半島南東沖", 1, "K")


def test_station_record_before_header_raises(tmp_path):
    p = tmp_path / "bad.dat"
    p.write_bytes(OBS + b"\r\n")
    with pytest.raises(ParseError, match="before any header"):
        list(iter_shindo_groups(p))
