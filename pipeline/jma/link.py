"""Link intensity-file events to hypocentre-catalogue events, and decide which
events appear in the site's views."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import timedelta

from .hypo import Hypocentre
from .shindo import ShindoGroup, ShindoHeader

# Fallback tolerances, for headers whose columns 2-68 don't match the
# catalogue byte for byte (e.g. if one file was revised and the other not).
MAX_TIME_DIFF = timedelta(seconds=2)
MAX_DEG_DIFF = 0.1


@dataclass(slots=True)
class LinkResult:
    # event id -> (header, group); several events can share one group (type B/D)
    linked: dict[str, tuple[ShindoHeader, ShindoGroup]] = field(default_factory=dict)
    exact: int = 0
    nearest: int = 0
    unmatched: list[ShindoHeader] = field(default_factory=list)


def link_shindo(hypos: Iterable[Hypocentre], groups: Iterable[ShindoGroup]) -> LinkResult:
    by_key: dict[bytes, list[Hypocentre]] = defaultdict(list)
    by_minute: dict[tuple, list[Hypocentre]] = defaultdict(list)
    for h in hypos:
        by_key[h.origin.key].append(h)
        by_minute[h.origin.origin_jst.replace(second=0, microsecond=0)].append(h)

    result = LinkResult()
    for group in groups:
        for header in group.events:
            cands = by_key.get(header.origin.key, [])
            if len(cands) == 1:
                match = cands[0]
                result.exact += 1
            elif len(cands) > 1:
                raise ValueError(f"{header.source}:{header.line_no}: ambiguous match {[c.id for c in cands]}")
            else:
                match = _nearest(header, by_minute)
                if match is None:
                    result.unmatched.append(header)
                    continue
                result.nearest += 1
            if match.id in result.linked:
                raise ValueError(f"{header.source}:{header.line_no}: event {match.id} linked twice")
            result.linked[match.id] = (header, group)
    return result


def _nearest(header: ShindoHeader, by_minute) -> Hypocentre | None:
    t = header.origin.origin_jst
    minute = t.replace(second=0, microsecond=0)
    best, best_score = None, None
    for m in (minute - timedelta(minutes=1), minute, minute + timedelta(minutes=1)):
        for h in by_minute.get(m, []):
            dt = abs(h.origin.origin_jst - t)
            dlat, dlon = abs(h.origin.lat - header.origin.lat), abs(h.origin.lon - header.origin.lon)
            if dt <= MAX_TIME_DIFF and dlat <= MAX_DEG_DIFF and dlon <= MAX_DEG_DIFF:
                score = dt.total_seconds() + dlat + dlon
                if best_score is None or score < best_score:
                    best, best_score = h, score
    return best


def include_in_views(h: Hypocentre, has_shindo: bool) -> bool:
    """Agreed selection rules (see README, "Decisions"):
    - artificial events (subsidiary code 3) are stored but never shown;
    - events located by USGS / other agencies are shown only if they have
      intensity observations in Japan;
    - everything else, including low-frequency events, is shown (LFEs get
      a toggle in the UI).
    """
    if h.origin.event_class == "3":
        return False
    if h.agency != "J":
        return has_shindo
    return True
