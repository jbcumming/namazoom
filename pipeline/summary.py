"""Sanity-check summary of one year of JMA data.

    uv run python -m pipeline.summary data/raw/h2019.zip data/raw/i2019.zip data/raw/code_p.zip
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from .jma import codes
from .jma.codes import SHINDO_RANK, shindo_class_from_instrumental
from .jma.hypo import Hypocentre, iter_hypocentres
from .jma.link import LinkResult, include_in_views, link_shindo
from .jma.shindo import ShindoGroup, iter_shindo_groups
from .jma.stations import Station, parse_stations
from .known_quakes import KNOWN_QUAKES


@dataclass
class YearData:
    hypos: list[Hypocentre]
    groups: list[ShindoGroup]
    stations: dict[str, Station]
    link: LinkResult


def load(hypo_path: Path, shindo_path: Path, stations_path: Path) -> YearData:
    hypos = list(iter_hypocentres(hypo_path))
    groups = list(iter_shindo_groups(shindo_path))
    return YearData(hypos, groups, parse_stations(stations_path), link_shindo(hypos, groups))


def _fmt_counter(c: Counter, labels: dict[str, str] | None = None) -> str:
    rows = []
    for k, n in c.most_common():
        name = "(blank)" if k is None else k
        label = f"  {labels[k]}" if labels and k in labels else ""
        rows.append(f"    {name!s:>8} {n:>9,}{label}")
    return "\n".join(rows)


def report(d: YearData) -> tuple[str, bool]:
    out: list[str] = []
    ok = True
    p = out.append
    hypos, link = d.hypos, d.link
    jma = [h for h in hypos if h.agency == "J"]
    shown = [h for h in hypos if include_in_views(h, h.id in link.linked)]

    p("HYPOCENTRE CATALOGUE")
    p(f"  records          {len(hypos):,}")
    p(f"  by agency\n{_fmt_counter(Counter(h.agency for h in hypos), codes.AGENCY)}")
    times = [h.origin.origin_jst for h in hypos]
    p(f"  origin range     {min(times)} .. {max(times)} JST")
    mags = [h.origin.mag1 for h in jma if h.origin.mag1 is not None]
    p(f"  JMA magnitude    {min(mags)} .. {max(mags)}   ({len(jma) - len(mags):,} events have none)")
    bins = Counter(int(m // 1) for m in mags)
    p("  by magnitude     " + "  ".join(f"[{b},{b + 1}): {bins[b]:,}" for b in sorted(bins)))
    p(f"  magnitude type\n{_fmt_counter(Counter(h.origin.mag1_type for h in jma), codes.MAG_TYPE)}")
    p(f"  event class\n{_fmt_counter(Counter(h.origin.event_class for h in jma), codes.EVENT_CLASS)}")
    p(f"  location method\n{_fmt_counter(Counter(h.origin.location_precision for h in jma), codes.LOCATION_PRECISION)}")
    depths = [h.origin.depth_km for h in jma if h.origin.depth_km is not None]
    p(f"  depth            {min(depths)} .. {max(depths)} km")
    p(f"  shown in views   {len(shown):,}  (rules: README 'Decisions')")

    p("\n  ten largest (JMA magnitude)")
    for h in sorted(jma, key=lambda h: h.origin.mag1 or -9, reverse=True)[:10]:
        o = h.origin
        p(f"    {o.origin_jst:%Y-%m-%d %H:%M} M{o.mag1}  {o.depth_km:5.0f} km  "
          f"shindo {codes.MAX_SHINDO.get(o.max_shindo or '', '-'):>3}  {h.region_name}")

    strong = [h for h in jma if SHINDO_RANK.get(h.origin.max_shindo or "", 0) >= SHINDO_RANK["A"]]
    p(f"\n  maximum shindo 5- or stronger: {len(strong)}")
    for h in strong:
        o = h.origin
        p(f"    {o.origin_jst:%Y-%m-%d %H:%M} M{o.mag1}  shindo {codes.MAX_SHINDO[o.max_shindo]:>2}  {h.region_name}")

    p("\nSEISMIC INTENSITY")
    obs = [o for g in d.groups for o in g.observations]
    p(f"  groups           {len(d.groups):,}  ({sum(g.record_type != 'A' for g in d.groups)} with shared data, type B/D)")
    p(f"  events           {sum(len(g.events) for g in d.groups):,}")
    p(f"  station readings {len(obs):,}")
    p(f"  linked exactly   {link.exact:,}   by nearest match {link.nearest:,}   unmatched {len(link.unmatched):,}")
    if link.unmatched:
        ok = False
    foreign = [i for i in link.linked if not i.startswith("J")]
    p(f"  non-JMA hypocentres with readings in Japan: {len(foreign)}  {foreign}")
    unknown = {o.station_id for o in obs} - d.stations.keys()
    p(f"  stations         {len(d.stations):,} in list, {len({o.station_id for o in obs}):,} reporting, "
      f"{len(unknown)} not in list")
    ok &= not unknown
    mismatch = [o for o in obs if o.instrumental is not None
                and shindo_class_from_instrumental(o.instrumental) != o.shindo]
    p(f"  intensity class vs instrumental value: {len(mismatch)} disagreements")
    ok &= not mismatch
    # The event's max shindo should equal its strongest reading. In B/D groups
    # JMA gives the max shindo to the first event only; the others are blank.
    agree, disagree, secondary = 0, 0, 0
    for hdr, g in link.linked.values():
        if g.record_type != "A" and hdr is not g.headers[0]:
            secondary += hdr.origin.max_shindo is None
            disagree += hdr.origin.max_shindo is not None
            continue
        top = max((o.shindo for o in g.observations), key=lambda s: SHINDO_RANK.get(s, 0))
        if top == hdr.origin.max_shindo:
            agree += 1
        else:
            disagree += 1
    p(f"  event max shindo = strongest station reading: {agree:,} agree, {disagree} disagree; "
      f"{secondary} secondary events in shared groups (max shindo blank, readings not attributable)")
    ok &= disagree == 0

    year = min(times).year
    p(f"\nKNOWN QUAKES ({year})")
    for k in KNOWN_QUAKES.get(year, []):
        h = k.find(jma)
        problems = k.check(h)
        ok &= not problems
        status = "OK  " if not problems else "FAIL"
        got = (f"M{h.origin.mag1} shindo {codes.MAX_SHINDO.get(h.origin.max_shindo or '', '-')} "
               f"{h.origin.depth_km:.0f} km  {h.region_name}  [{h.id}]") if h else ""
        p(f"  {status} {k.name:<28} {got}  {'; '.join(problems)}")
    return "\n".join(out), ok


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("hypo", type=Path)
    ap.add_argument("shindo", type=Path)
    ap.add_argument("stations", type=Path)
    args = ap.parse_args(argv)
    text, ok = report(load(args.hypo, args.shindo, args.stations))
    print(text)
    print("\nALL CHECKS PASSED" if ok else "\nSOME CHECKS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
