from dataclasses import replace
from datetime import timedelta
from pathlib import Path

import pytest

from pipeline.jma.archive import RawRecord
from pipeline.jma.fields import ParseError
from pipeline.jma.hypo import parse_hypo_record
from pipeline.jma.link import candidates, include_in_views, link_shindo
from pipeline.jma.shindo import iter_shindo_groups
from pipeline.jma.stations import parse_stations, partial_datetime

FIXTURE = Path(__file__).parent / "fixtures" / "i2019_sample.dat"

# Real rows from code_p.dat
STATIONS = (
    "1000000\t石狩市花川\t4310\t14119\t199604011200\t\n"
    "8070030\t竹富町西表東祖納＊\t2423\t12345\t200303101200\t200703051200\n"
    "8070070\t竹富町西表\t2423\t12345\t195499999999\t200303109999\n"
)


def test_parse_stations(tmp_path):
    p = tmp_path / "code_p.dat"
    p.write_text(STATIONS, encoding="utf-8")
    st = parse_stations(p)
    assert st["1000000"].name == "石狩市花川"
    assert st["1000000"].lat == pytest.approx(43 + 10 / 60)
    assert st["1000000"].lon == pytest.approx(141 + 19 / 60)
    assert (st["1000000"].start, st["1000000"].end) == ("1996-04-01T12:00", None)
    assert st["8070030"].end == "2007-03-05T12:00"
    # 99 / 9999 mark unknown parts
    assert (st["8070070"].start, st["8070070"].end) == ("1954", "2003-03-10")


def test_station_list_accepts_shift_jis(tmp_path):
    p = tmp_path / "code_p.dat"
    p.write_bytes(STATIONS.encode("cp932"))
    assert parse_stations(p)["1000000"].name == "石狩市花川"


def test_partial_datetime_rejects_garbage():
    with pytest.raises(ParseError):
        partial_datetime("1996040112")


def _hypo_from_header(header_line: bytes, agency: bytes = b"J") -> RawRecord:
    # A catalogue record shares columns 2-68 with the intensity header.
    return RawRecord("h", 1, agency + header_line[1:68] + b"REGION".ljust(24) + b" 10K")


def test_link_exact_and_nearest():
    groups = list(iter_shindo_groups(FIXTURE))
    headers = [e for g in groups for e in g.events]
    hypos = [parse_hypo_record(_hypo_from_header(e_raw)) for e_raw in _raw_headers()]
    # Perturb one catalogue record so only the nearest-match fallback can find it.
    o = hypos[0].origin
    hypos[0] = replace(hypos[0], origin=replace(o, origin_jst=o.origin_jst + timedelta(seconds=0.5), key=b"changed"))
    r = link_shindo(candidates(hypos), groups)
    assert (r.count("exact"), r.count("nearest"), r.count(None)) == (len(headers) - 1, 1, 0)


def test_link_reports_unmatched():
    groups = list(iter_shindo_groups(FIXTURE))
    r = link_shindo([], groups)
    assert r.count("exact") == r.count("nearest") == 0
    assert r.count(None) == sum(len(g.events) for g in groups)


def _raw_headers() -> list[bytes]:
    return [l for l in FIXTURE.read_bytes().split(b"\r\n") if l[:1] in (b"A", b"B", b"D")]


@pytest.mark.parametrize(
    "agency, event_class, has_shindo, shown",
    [
        (b"J", b"1", False, True),
        (b"J", b"5", False, True),   # low-frequency: shown (UI toggle)
        (b"J", b"3", True, False),   # artificial: never shown
        (b"U", b" ", False, False),  # USGS, not felt in Japan
        (b"U", b" ", True, True),    # USGS, felt in Japan
    ],
)
def test_include_in_views(agency, event_class, has_shindo, shown):
    line = _raw_headers()[0]
    line = line[:60] + event_class + line[61:]
    h = parse_hypo_record(_hypo_from_header(line, agency))
    assert include_in_views(h, has_shindo) is shown
