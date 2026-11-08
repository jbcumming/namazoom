"""Format variants found when parsing all years (1919-2024). Records are real
lines from the JMA files unless marked synthetic."""

from datetime import datetime
from pathlib import Path

import pytest

from pipeline.jma.archive import RawRecord
from pipeline.jma.hypo import parse_hypo_record
from pipeline.jma.link import candidates, link_shindo
from pipeline.jma.shindo import iter_shindo_groups, parse_header, parse_observation


def raw(line: str, encoding: str = "ascii") -> RawRecord:
    data = line.encode(encoding)
    assert len(data) <= 96
    return RawRecord("test", 1, data.ljust(96))


# --- hypocentre file ---------------------------------------------------------

def test_h2016_depth_with_separately_written_fraction():
    h = parse_hypo_record(raw(
        "J2016041811492482 024 323107 024 1303660 024  0 420707V   511   7271SOUTHERN KUMAMOTO PREF   24A"))
    assert h.origin.depth_km == 0.04


def test_h1951_blank_padded_standard_error():
    h = parse_hypo_record(raw(
        "J1955061119452748 116 362422   0 1383157   0  0     36J   531X  3 81NW GUNMA PREF            11S"))
    assert (h.origin.lat_se_min, h.origin.lon_se_min) == (0.0, 0.0)
    assert h.origin.max_shindo == "X"


def test_h1919_low_precision_minutes():
    h = parse_hypo_record(raw(
        "I19350527070345       12530      1130         0                                              46 "))
    assert h.agency == "I"
    assert h.origin.lat == pytest.approx(12 + 53 / 60)
    assert h.origin.lon == pytest.approx(113.0)


def test_undocumented_location_code_0_is_accepted_and_labelled():
    h = parse_hypo_record(raw(
        "U196412071758438      -524       15118       54     58B   10    8400NEW BRITAIN REGION"))
    assert h.origin.location_precision == "0"
    assert h.origin.lat == pytest.approx(-(5 + 24 / 60))


def test_erratum_blanks_impossible_magnitude():
    h = parse_hypo_record(raw(
        "U198703061839542     -24122     - 70044      45     57B8 S      9   NEAR COAST OF N-CHILE  5"))
    assert (h.origin.mag1, h.origin.mag2, h.origin.mag2_type) == (5.7, None, None)
    assert len(h.corrections) == 1


# --- intensity file ----------------------------------------------------------

DETAILS_UNKNOWN = "A19190101121537   99  3414   99  13510   99   0            8 1      詳細不明                  1N"
TIME_UNKNOWN = "A198104062359599                                             2      時分不明データ  　　　    1D"


def test_details_unknown_header_is_not_a_hypocentre():
    h = parse_header(raw(DETAILS_UNKNOWN, "cp932"))
    assert h.region_name_ja == "詳細不明"
    assert h.origin.location_precision == "8"
    assert not h.located and h.time_known
    # ' 99 ' error columns are placeholders, not 9.9
    assert (h.origin.time_se, h.origin.lat_se_min, h.origin.lon_se_min) == (None, None, None)
    assert h.origin.lat == pytest.approx(34 + 14 / 60)  # the reporting station's position


def test_time_unknown_header():
    h = parse_header(raw(TIME_UNKNOWN, "cp932"))
    assert h.flag == "D" and not h.time_known and not h.located
    assert h.origin.lat is None and h.origin.lon is None


def test_station_time_placeholders_tolerated_only_without_hypocentre():
    origin = datetime(1981, 4, 6, 23, 59, 59, 900000)
    rec = raw("4614300 235959999 2 // ///// ///// N///// E///// Z/////                                   *    1")
    o = parse_observation(rec, origin, strict_time=False)
    assert o.obs_time_jst is None and o.obs_time_raw == "235959999"
    with pytest.raises(Exception, match="invalid station time"):
        parse_observation(rec, origin, strict_time=True)


def test_partially_unknown_seconds():
    o = parse_observation(raw("4110000 01150526/ 1 // ///// ///// N///// E///// Z/////"), datetime(1923, 1, 1, 15, 5))
    assert o.obs_time_jst == datetime(1923, 1, 1, 15, 5, 26)


def test_euc_jp_file_is_detected(tmp_path):
    # Real 2023 header (EUC-JP region name) followed by a synthetic station line.
    # 16-byte name + 6 blanks fill the 22-byte field, then I5 felt count and flag.
    header = "A2023010103063342 003 354464 010 1364925 012  99005729V   7111  4139岐阜県美濃中西部          2K"
    p = tmp_path / "i2023.dat"
    p.write_bytes(header.encode("euc_jp") + b"\r\n"
                  + b"4110000 010306480 1 05 06481 00010 N00010 E00010 Z00010" + b"\r\n")
    (g,) = list(iter_shindo_groups(p))
    assert g.headers[0].region_name_ja == "岐阜県美濃中西部"


def test_duplicate_header_is_linked_once(tmp_path):
    # i1976 lines 954-957: the same header twice, each with one reading.
    hdr = "A1976061607425494 014 353166 054 1390074 076 189832035J   5111  4152山梨県東部・富士五湖      1K"
    p = tmp_path / "i1976.dat"
    p.write_bytes(b"".join(l + b"\r\n" for l in [
        hdr.encode("cp932"), b"4120970 160743004 1 // ///// ///// N///// E///// Z/////",
        hdr.encode("cp932"), b"4120970 160743427 1 // ///// ///// N///// E///// Z/////",
    ]))
    groups = list(iter_shindo_groups(p))
    cat = parse_hypo_record(raw(
        "J1976061607425494 014 353166 054 1390074 076 189832035J   5111  4152EASTERN YAMANASHI PREF   41K"))
    r = link_shindo(candidates([cat]), groups)
    assert [l.method for l in r.links] == ["exact", "duplicate"]


def test_link_ignores_max_intensity_column():
    # 1977-84: the catalogue says 'F' (felt), the intensity file gives the number.
    hdr = parse_header(raw("A198001010553229  05  4250   3   14654   3   40     43V   3211  1 27"))
    cat = parse_hypo_record(raw("J198001010553229  05  4250   3   14654   3   40     43V   321F  1 27FOO"))
    assert hdr.origin.key == cat.origin.key
