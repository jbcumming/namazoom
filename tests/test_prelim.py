"""Preliminary sources: daily hypocentre list and intensity database replies."""

from datetime import datetime

import pytest

from pipeline.fetch_prelim import last_available
from pipeline.jma.prelim import (
    match_eqdb,
    max_shindo,
    parse_daily_line,
    parse_daily_page,
    parse_eqdb_event,
)

PAGE = """<html><body><pre>
年   月 日 時 分 秒    緯度       経度       深さ(km)  Ｍ   震央地名
-----------------------------------------------------------------------------------------
2025  1 15 00:02  2.9  32°57.9'N 132°12.4'E   36     0.0  豊後水道
2025  1 15 00:04 13.9  28° 7.6'N 128° 6.2'E   20     1.3  奄美大島北西沖
2025  1 15 23:59 59.9  35° 0.0'N 140° 0.0'E    0       -  千葉県南部
</pre><p>補足説明</p></body></html>"""


def test_daily_page():
    hs = parse_daily_page(PAGE)
    assert len(hs) == 3
    a, b, c = hs
    assert a.origin_jst == datetime(2025, 1, 15, 0, 2, 2, 900_000)
    assert a.lat == pytest.approx(32 + 57.9 / 60)
    assert a.lon == pytest.approx(132 + 12.4 / 60)
    assert (a.depth_km, a.mag, a.region_name_ja) == (36.0, 0.0, "豊後水道")
    assert b.lat == pytest.approx(28 + 7.6 / 60)  # single-digit minutes are space-padded
    assert c.mag is None  # "-" = not determined
    assert c.origin_utc == datetime(2025, 1, 15, 14, 59, 59, 900_000)


def test_event_id_matches_catalogue_scheme():
    h = parse_daily_line("2025  1 15 00:02  2.9  32°57.9'N 132°12.4'E   36     0.0  豊後水道")
    assert h.event_id() == "J2025011500020290_3297_13221"


def test_daily_page_rejects_unknown_lines():
    with pytest.raises(ValueError, match="line"):
        parse_daily_page("<pre>\n2025  1 15 garbled\n</pre>")


EVENT = {
    "hyp": [{"id": "20250113211932", "ot": "2025/01/13 21:19:32.6", "name": "日向灘",
             "lat": "31.8283", "lon": "131.5700", "dep": "36 km", "mag": "6.6", "maxI": "震度５弱"}],
    "int": [
        {"name": "宮崎市田野町＊", "lat": "31.83", "lon": "131.3", "code": "7610132", "int": "震度５弱", "char": "A"},
        {"name": "高千穂町三田井", "lat": "32.71", "lon": "131.31", "code": "7620231", "int": "震度２", "char": "2"},
    ],
}


def test_eqdb_event():
    q = parse_eqdb_event(EVENT)
    assert q.origin_jst == datetime(2025, 1, 13, 21, 19, 32, 600_000)
    assert (q.lat, q.lon, q.depth_km, q.mag) == (31.8283, 131.57, 36.0, 6.6)
    assert q.max_shindo == "A"
    assert [(r.station_id, r.shindo) for r in q.readings] == [("7610132", "A"), ("7620231", "2")]


def test_eqdb_unknown_magnitude_and_label_fallback():
    ev = {"hyp": [{**EVENT["hyp"][0], "mag": "不明", "maxI": None}],
          "int": [{"code": "1", "int": "震度６強", "char": ""}]}
    q = parse_eqdb_event(ev)
    assert q.mag is None
    assert q.readings[0].shindo == "D"
    assert q.max_shindo == "D"


def test_max_shindo_order():
    assert max_shindo(["4", "A", "2"]) == "A"
    assert max_shindo(["B", "7", "D"]) == "7"
    assert max_shindo([]) is None


def test_match_nearest_in_time_and_place():
    q = parse_eqdb_event(EVENT)
    near = parse_daily_line("2025  1 13 21:19 32.7  31°49.7'N 131°34.2'E   36     6.6  日向灘")
    far_place = parse_daily_line("2025  1 13 21:19 32.6  35° 0.0'N 140° 0.0'E   36     2.0  千葉県南部")
    late = parse_daily_line("2025  1 13 21:19 40.0  31°49.7'N 131°34.2'E   36     2.0  日向灘")
    assert match_eqdb(q, [far_place, late, near]) is near
    assert match_eqdb(q, [far_place, late]) is None


def test_api_end_date_message():
    msg = "現時点の震度データベースには 2026-11-07 より後のデータはありません　検索終了日時の設定を見直してください"
    assert str(last_available(msg)) == "2026-11-07"


def test_fetch_stops_on_refusal(monkeypatch):
    import urllib.error

    import pipeline.fetch_prelim as fp

    calls = []

    def refuse(req, timeout):
        calls.append(req.full_url)
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, None)

    monkeypatch.setattr(fp.urllib.request, "urlopen", refuse)
    monkeypatch.setattr(fp.time, "sleep", lambda s: None)
    with pytest.raises(fp.Refused, match="429"):
        fp._request("https://example.invalid/")
    assert len(calls) == 1  # no retries
