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
    depth_km: float
    mag: float  # JMA magnitude
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
        problems = []
        if h.origin.mag1 != self.mag:
            problems.append(f"magnitude {h.origin.mag1} != {self.mag}")
        if h.origin.max_shindo != self.max_shindo:
            problems.append(f"max shindo {h.origin.max_shindo} != {self.max_shindo}")
        if h.origin.depth_km is None or abs(h.origin.depth_km - self.depth_km) > 5:
            problems.append(f"depth {h.origin.depth_km} km vs ~{self.depth_km} km")
        return problems


KNOWN_QUAKES: dict[int, list[KnownQuake]] = {
    2019: [
        KnownQuake("Kumamoto (Nagomi 6-)", datetime(2019, 1, 3, 18, 10), 33.0, 130.6, 10, 5.1, "C"),
        KnownQuake("Iburi central, Hokkaido", datetime(2019, 2, 21, 21, 22), 42.8, 142.0, 33, 5.8, "C"),
        KnownQuake("Hyuganada", datetime(2019, 5, 10, 8, 48), 31.8, 132.0, 25, 6.3, "A"),
        KnownQuake("Off Yamagata (Murakami 6+)", datetime(2019, 6, 18, 22, 22), 38.6, 139.5, 14, 6.7, "D"),
        KnownQuake("Off Fukushima", datetime(2019, 8, 4, 19, 23), 37.7, 141.6, 45, 6.4, "A"),
    ],
}
