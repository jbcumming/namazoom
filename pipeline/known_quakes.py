"""Well-documented quakes used to sanity-check parsed catalogues.

Values come from JMA's published reports on each event (origin time to the
minute in JST, JMA magnitude, maximum intensity), not from the files being
checked, so a match is independent evidence that the parser reads them right.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from .jma.hypo import Hypocentre


@dataclass(frozen=True)
class KnownQuake:
    name: str
    origin_jst: datetime  # to the minute
    lat: float
    lon: float
    depth_km: float | None  # None where we have no independent reference value
    mag: float  # JMA magnitude (magnitude 1; Mw for the largest events, e.g. 2011)
    max_shindo: str  # code, see codes.MAX_SHINDO

    def find(self, hypos: list[Hypocentre]) -> Hypocentre | None:
        """Largest JMA event within 90 s and 0.3° of the reported origin."""
        cands = [
            h for h in hypos
            if h.agency == "J"
            and abs(h.origin.origin_jst - self.origin_jst) <= timedelta(seconds=90)
            and abs(h.origin.lat - self.lat) <= 0.3
            and abs(h.origin.lon - self.lon) <= 0.3
        ]
        return max(cands, key=lambda h: h.origin.mag1 or -9, default=None)

    def check(self, h: Hypocentre | None) -> list[str]:
        """Problems found; empty means the catalogue agrees."""
        if h is None:
            return ["not found"]
        return self.check_values(h.origin.mag1, h.origin.max_shindo, h.origin.depth_km)

    def check_values(self, mag: float | None, max_shindo: str | None, depth_km: float | None) -> list[str]:
        problems = []
        if mag != self.mag:
            problems.append(f"magnitude {mag} != {self.mag}")
        if max_shindo != self.max_shindo:
            problems.append(f"max shindo {max_shindo} != {self.max_shindo}")
        if self.depth_km is not None and (depth_km is None or abs(depth_km - self.depth_km) > 5):
            problems.append(f"depth {depth_km} km vs ~{self.depth_km} km")
        return problems


# Max shindo before October 1996 is on the old scale ('5', '6'); 7 exists from 1949.
HISTORIC = [
    KnownQuake("1923 Great Kanto", datetime(1923, 9, 1, 11, 58), 35.33, 139.14, 23, 7.9, "6"),
    KnownQuake("1933 Showa Sanriku", datetime(1933, 3, 3, 2, 30), 39.13, 145.12, None, 8.1, "5"),
    KnownQuake("1944 Tonankai", datetime(1944, 12, 7, 13, 35), 33.57, 136.18, 40, 7.9, "6"),
    KnownQuake("1946 Nankai", datetime(1946, 12, 21, 4, 19), 32.94, 135.85, 24, 8.0, "5"),
    KnownQuake("1948 Fukui", datetime(1948, 6, 28, 16, 13), 36.17, 136.29, None, 7.1, "6"),
    KnownQuake("1995 Hyogo-ken Nanbu (Kobe)", datetime(1995, 1, 17, 5, 46), 34.60, 135.04, 16, 7.3, "7"),
    KnownQuake("2004 Chuetsu", datetime(2004, 10, 23, 17, 56), 37.29, 138.87, 13, 6.8, "7"),
    KnownQuake("2011 Tohoku", datetime(2011, 3, 11, 14, 46), 38.10, 142.86, 24, 9.0, "7"),
    KnownQuake("2016 Kumamoto mainshock", datetime(2016, 4, 16, 1, 25), 32.75, 130.76, 12, 7.3, "7"),
    KnownQuake("2018 Hokkaido Iburi East", datetime(2018, 9, 6, 3, 7), 42.69, 142.01, 37, 6.7, "7"),
    KnownQuake("2024 Noto Peninsula", datetime(2024, 1, 1, 16, 10), 37.50, 137.27, 16, 7.6, "7"),
]

KNOWN_QUAKES: dict[int, list[KnownQuake]] = {
    2019: [
        KnownQuake("Kumamoto (Nagomi 6-)", datetime(2019, 1, 3, 18, 10), 33.0, 130.6, 10, 5.1, "C"),
        KnownQuake("Iburi central, Hokkaido", datetime(2019, 2, 21, 21, 22), 42.8, 142.0, 33, 5.8, "C"),
        KnownQuake("Hyuganada", datetime(2019, 5, 10, 8, 48), 31.8, 132.0, 25, 6.3, "A"),
        KnownQuake("Off Yamagata (Murakami 6+)", datetime(2019, 6, 18, 22, 22), 38.6, 139.5, 14, 6.7, "D"),
        KnownQuake("Off Fukushima", datetime(2019, 8, 4, 19, 23), 37.7, 141.6, 45, 6.4, "A"),
    ],
}
