"""Full parse of the 2019 sample. Skipped if data/raw has not been downloaded
(see README). Expected numbers were established by inspecting the raw files
independently of the parser (line counts, column profiles)."""

from collections import Counter
from pathlib import Path

import pytest

from pipeline.jma.codes import shindo_class_from_instrumental
from pipeline.known_quakes import KNOWN_QUAKES
from pipeline.summary import load, report

RAW = Path(__file__).parent.parent / "data" / "raw"
FILES = [RAW / "h2019.zip", RAW / "i2019.zip", RAW / "code_p.zip"]

pytestmark = pytest.mark.skipif(not all(f.exists() for f in FILES), reason="2019 sample not downloaded")


@pytest.fixture(scope="module")
def year():
    return load(*FILES)


def test_record_counts(year):
    assert len(year.hypos) == 223_367
    assert Counter(h.agency for h in year.hypos) == {"J": 223_302, "U": 65}
    assert len(year.groups) == 1_564
    assert sum(len(g.headers) for g in year.groups) == 1_580
    assert sum(len(g.observations) for g in year.groups) == 45_960
    assert len(year.stations) == 7_258


def test_ids_unique(year):
    assert len({h.id for h in year.hypos}) == len(year.hypos)


def test_depth_format_matches_documented_method(year):
    # I3,2X depths are exactly the depth-slice (2), fixed-depth (3) and USGS records.
    whole = Counter(h.origin.location_precision for h in year.hypos if h.origin.depth_whole_km)
    assert whole == {"2": 21_734, "3": 163, None: 65}


def test_magnitudes(year):
    mags = [h.origin.mag1 for h in year.hypos if h.agency == "J" and h.origin.mag1 is not None]
    assert (min(mags), max(mags)) == (-1.3, 6.7)
    assert sum(m < 0 for m in mags) == 27_953
    assert sum(h.origin.mag1 is None for h in year.hypos) == 3_558


def test_every_intensity_event_links_exactly(year):
    assert year.link.exact == 1_580
    assert year.link.nearest == 0 and year.link.unmatched == []


def test_all_reporting_stations_are_in_station_list(year):
    assert {o.station_id for g in year.groups for o in g.observations} <= year.stations.keys()


def test_instrumental_intensity_agrees_with_class(year):
    obs = [o for g in year.groups for o in g.observations]
    assert all(o.instrumental is not None for o in obs)
    assert all(shindo_class_from_instrumental(o.instrumental) == o.shindo for o in obs)


@pytest.mark.parametrize("quake", KNOWN_QUAKES[2019], ids=lambda k: k.name)
def test_known_quake(year, quake):
    assert quake.check(quake.find(year.hypos)) == []


def test_summary_passes(year):
    _, ok = report(year)
    assert ok
