"""Download preliminary data for the period after the last finalised catalogue year.

JMA publishes the finalised catalogue (地震月報 カタログ編) about two years late.
For the months since, two preliminary sources fill the gap:

  震源リスト (daily hypocentre lists), one HTML page per day, up to two days ago:
      https://www.data.jma.go.jp/eqev/data/daily_map/YYYYMMDD.html
      -> data/raw/prelim/daily/YYYYMMDD.html
  震度データベース (intensity database), the API behind its search page, up to yesterday:
      search: felt quakes in a period  -> data/raw/prelim/eqdb/search/{from}_{to}.json
      event:  station intensities      -> data/raw/prelim/eqdb/event/{id}.json
  地震情報 (the live earthquake-information list behind www.jma.go.jp/bosai/map.html),
  felt quakes minutes after they happen, about the last month; one request per run:
      -> data/raw/prelim/live/list.json  ({"fetched": JST time, "items": [...]})

    uv run python -m pipeline.fetch_prelim                 # from the day after the last h*.zip year
    uv run python -m pipeline.fetch_prelim --start 2025-01-01

Files from the last REFRESH_DAYS days are fetched again on each run, since JMA
revises preliminary values for a while; older files are kept.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .fetch import USER_AGENT

JST = timezone(timedelta(hours=9))

DAILY_URL = "https://www.data.jma.go.jp/eqev/data/daily_map/{d:%Y%m%d}.html"
EQDB_API = "https://www.data.jma.go.jp/eqdb/data/shindo/api/"
LIVE_URL = "https://www.jma.go.jp/bosai/quake/data/list.json"
REFRESH_DAYS = 14
SEARCH_LIMIT = 1000  # the API returns at most this many quakes per search
# Pause between requests. One request at a time, at most about one a second:
# the intensity database's API serves JMA's own search page, not bulk clients.
DELAY = 1.0


class Refused(RuntimeError):
    """The server refused or rate-limited us (HTTP 403/429): stop rather than retry."""


def _request(url: str, form: list[tuple[str, str]] | None = None) -> bytes:
    data, headers = None, {"User-Agent": USER_AGENT}
    if form is not None:  # multipart/form-data, as the search page sends it
        boundary = uuid.uuid4().hex
        parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n' for k, v in form]
        data = ("".join(parts) + f"--{boundary}--\r\n").encode("utf-8")
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    req = urllib.request.Request(url, data=data, headers=headers)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 429):
                raise Refused(f"{url}: HTTP {e.code}. Stopping; files fetched so far are kept and the next "
                              "run resumes. Wait before retrying.") from e
            if attempt == 3 or e.code < 500:
                raise
        except OSError:  # network errors, timeouts
            if attempt == 3:
                raise
        time.sleep(2 ** attempt * 5)  # 5, 10, 20 s
    raise AssertionError


def _save(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_bytes(data)
    tmp.rename(path)


def _fresh(path: Path, day: date, today: date) -> bool:
    """Already downloaded and old enough not to change any more."""
    return path.exists() and path.stat().st_size > 0 and (today - day).days > REFRESH_DAYS


def search_form(d0: datetime, d1: datetime) -> list[tuple[str, str]]:
    """Every quake with intensity 1 or more between d0 and d1 (JST, to the minute)."""
    return [
        ("mode", "search"),
        ("dateTimeF[]", f"{d0:%Y-%m-%d}"), ("dateTimeF[]", f"{d0:%H:%M}"),
        ("dateTimeT[]", f"{d1:%Y-%m-%d}"), ("dateTimeT[]", f"{d1:%H:%M}"),
        ("mag[]", "0.0"), ("mag[]", "9.9"), ("dep[]", "0"), ("dep[]", "999"),
        ("epi[]", "99"), ("pref[]", "99"), ("city[]", "99"), ("station[]", "99"),
        ("obsInt", "1"), ("maxInt", "1"), ("additionalC", "false"), ("Sort", "S1"),
        ("Comp", "C0"), ("seisCount", "false"), ("observed", "false"),
    ]


def last_available(api_message: str) -> date | None:
    """The API refuses searches past its latest day and names that day."""
    m = re.search(r"(\d{4}-\d{2}-\d{2}) より後のデータはありません", api_message)
    return date.fromisoformat(m.group(1)) if m else None


def fetch_daily(dest: Path, start: date, today: date) -> int:
    n = 0
    d = start
    while d <= today - timedelta(days=2):
        path = dest / "daily" / f"{d:%Y%m%d}.html"
        if not _fresh(path, d, today):
            html = _request(DAILY_URL.format(d=d))
            if b"<pre>" not in html:
                raise RuntimeError(f"{d}: no list in the page")
            _save(path, html)
            n += 1
            time.sleep(DELAY)
        d += timedelta(days=1)
    return n


def _search(d0: datetime, d1: datetime) -> list[dict]:
    """Felt quakes from d0 to d1 inclusive, splitting the period when the API's limit is hit."""
    body = json.loads(_request(EQDB_API, search_form(d0, d1)))
    time.sleep(DELAY)
    if isinstance(body["res"], str):
        raise RuntimeError(f"search {d0}..{d1}: {body['res']}")
    if len(body["res"]) < SEARCH_LIMIT:
        return body["res"]
    if d1 - d0 <= timedelta(hours=1):
        raise RuntimeError(f"over {SEARCH_LIMIT} felt quakes between {d0} and {d1}")
    mid = d0 + (d1 - d0) / 2
    mid = mid.replace(second=0, microsecond=0)
    return _search(d0, mid) + _search(mid + timedelta(minutes=1), d1)


def fetch_eqdb(dest: Path, start: date, today: date) -> tuple[int, int]:
    # Latest day in the database (normally yesterday).
    probe = json.loads(_request(EQDB_API, search_form(datetime.combine(today, datetime.min.time()),
                                                      datetime.combine(today, datetime.min.time()))))
    end = last_available(probe["res"]) if isinstance(probe["res"], str) else today
    if end is None:
        raise RuntimeError(f"unexpected reply: {probe['res']}")

    searches = events = 0
    month = start.replace(day=1)
    while month <= end:
        nxt = (month + timedelta(days=32)).replace(day=1)
        lo, hi = max(month, start), min(nxt - timedelta(days=1), end)
        path = dest / "eqdb" / "search" / f"{lo:%Y%m%d}_{hi:%Y%m%d}.json"
        if not _fresh(path, hi, today):
            res = _search(datetime.combine(lo, datetime.min.time()), datetime.combine(hi, datetime.min.time()).replace(hour=23, minute=59))
            # A month still in progress: drop older partial searches for it.
            for old in path.parent.glob(f"{lo:%Y%m%d}_*.json"):
                old.unlink()
            _save(path, json.dumps({"from": lo.isoformat(), "to": hi.isoformat(), "res": res}, ensure_ascii=False).encode())
            searches += 1
        for q in json.loads(path.read_text())["res"]:
            ep = dest / "eqdb" / "event" / f"{q['id']}.json"
            day = date(int(q["id"][:4]), int(q["id"][4:6]), int(q["id"][6:8]))
            if _fresh(ep, day, today):
                continue
            body = json.loads(_request(EQDB_API, [("mode", "event"), ("id", q["id"])]))
            if isinstance(body["res"], str):
                raise RuntimeError(f"event {q['id']}: {body['res']}")
            _save(ep, json.dumps(body["res"], ensure_ascii=False).encode())
            events += 1
            time.sleep(DELAY)
        month = nxt
    return searches, events


def fetch_live(dest: Path) -> int:
    """The live list, replaced on every run (only its last day or two are used)."""
    fetched = datetime.now(timezone.utc).astimezone(JST).replace(tzinfo=None)
    items = json.loads(_request(LIVE_URL))
    if not isinstance(items, list):
        raise RuntimeError("live list: unexpected reply")
    _save(dest / "live" / "list.json", json.dumps({"fetched": fetched.isoformat(timespec="seconds"), "items": items},
                                                   ensure_ascii=False).encode())
    return len(items)


def default_start(raw: Path) -> date:
    """The day after the last year of the finalised hypocentre catalogue."""
    years = [int(m.group(1)) for z in raw.glob("h*.zip") if (m := re.fullmatch(r"h(\d{4})", z.stem))]
    return date(max(years) + 1, 1, 1)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", type=Path, default=Path("data/raw"))
    ap.add_argument("--start", type=date.fromisoformat)
    args = ap.parse_args(argv)
    try:
        return _run(args)
    except Refused as e:
        print(f"refused by the server: {e}", file=sys.stderr)
        return 3


def _run(args: argparse.Namespace) -> int:
    start = args.start or default_start(args.raw)
    today = date.today()
    dest = args.raw / "prelim"
    print(f"preliminary data from {start}")
    n = fetch_daily(dest, start, today)
    print(f"daily hypocentre lists: {n} downloaded")
    s, e = fetch_eqdb(dest, start, today)
    print(f"intensity database: {s} searches, {e} events downloaded")
    print(f"live earthquake list: {fetch_live(dest)} reports")
    return 0


if __name__ == "__main__":
    sys.exit(main())
