"""Link intensity-file events to hypocentre-catalogue events, and decide which
events appear in the site's views."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import NamedTuple

from .hypo import Hypocentre
from .shindo import ShindoGroup, ShindoHeader

# Fallback tolerances, for headers whose link key doesn't match the
# catalogue byte for byte (e.g. if one file was revised and the other not).
MAX_TIME_DIFF = timedelta(seconds=2)
MAX_DEG_DIFF = 0.1


class Candidate(NamedTuple):
    """The catalogue fields linking needs (so the build can supply them
    from Parquet instead of full Hypocentre objects)."""

    id: str
    key: bytes  # Origin.key: raw columns 2-61 + 63-68
    origin_jst: datetime
    lat: float
    lon: float


def candidates(hypos: Iterable[Hypocentre]) -> list[Candidate]:
    return [Candidate(h.id, h.origin.key, h.origin.origin_jst, h.origin.lat, h.origin.lon) for h in hypos]  # type: ignore[arg-type]


@dataclass(slots=True)
class Link:
    header: ShindoHeader
    group: ShindoGroup
    event_id: str | None  # catalogue event, None if not linked
    method: str | None  # 'exact' | 'nearest' | 'duplicate' | 'ambiguous' | None (no match)


@dataclass(slots=True)
class LinkResult:
    links: list[Link] = field(default_factory=list)

    @property
    def linked(self) -> dict[str, Link]:
        return {l.event_id: l for l in self.links if l.event_id is not None}

    def count(self, method: str | None, located: bool | None = None) -> int:
        return sum(1 for l in self.links if l.method == method and (located is None or l.header.located == located))


def link_shindo(cands: Iterable[Candidate], groups: Iterable[ShindoGroup]) -> LinkResult:
    """Link every event header (see ShindoGroup.events) to at most one
    catalogue event: exact match on Origin.key, else the nearest event
    within MAX_TIME_DIFF and MAX_DEG_DIFF. Headers without a hypocentre
    (see ShindoHeader.located) are not linked."""
    by_key: dict[bytes, list[Candidate]] = defaultdict(list)
    by_minute: dict[datetime, list[Candidate]] = defaultdict(list)
    for c in cands:
        by_key[c.key].append(c)
        by_minute[c.origin_jst.replace(second=0, microsecond=0)].append(c)

    result = LinkResult()
    used: set[str] = set()
    for group in groups:
        for header in group.events:
            match, method = None, None
            if header.located:
                exact = by_key.get(header.origin.key, [])
                if len(exact) > 1:
                    method = "ambiguous"  # several catalogue events with the same key
                elif exact:
                    match, method = exact[0], "exact"
                else:
                    match = _nearest(header, by_minute)
                    method = "nearest" if match else None
            if match is not None and match.id in used:
                # A header repeated in the intensity file (e.g. i1976 lines 954
                # and 956): the first keeps the link, later copies are not linked.
                match, method = None, "duplicate"
            if match is not None:
                used.add(match.id)
            result.links.append(Link(header, group, match.id if match else None, method))
    return result


def _nearest(header: ShindoHeader, by_minute: dict[datetime, list[Candidate]]) -> Candidate | None:
    t = header.origin.origin_jst
    minute = t.replace(second=0, microsecond=0)
    best, best_score = None, None
    for m in (minute - timedelta(minutes=1), minute, minute + timedelta(minutes=1)):
        for c in by_minute.get(m, []):
            dt = abs(c.origin_jst - t)
            dlat, dlon = abs(c.lat - header.origin.lat), abs(c.lon - header.origin.lon)  # type: ignore[operator]
            if dt <= MAX_TIME_DIFF and dlat <= MAX_DEG_DIFF and dlon <= MAX_DEG_DIFF:
                score = dt.total_seconds() + dlat + dlon
                if best_score is None or score < best_score:
                    best, best_score = c, score
    return best


def include_in_views(h: Hypocentre, has_shindo: bool) -> bool:
    """Agreed selection rules (see README, "Decisions"):
    - artificial events (subsidiary code 3) are stored but never shown;
    - events located by USGS / other agencies are shown only if they have
      intensity observations in Japan;
    - everything else, including low-frequency events, is shown (LFEs get
      a toggle in the UI).
    """
    return view_rule(h.agency, h.origin.event_class, has_shindo)


def view_rule(agency: str, event_class: str | None, has_shindo: bool) -> bool:
    if event_class == "3":
        return False
    if agency != "J":
        return has_shindo
    return True
