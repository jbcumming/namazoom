"""Download the JMA catalogue files into data/raw/.

The file list is read from JMA's own index pages, so newly published years
are picked up automatically. Files already present are skipped.

    uv run python -m pipeline.fetch            # everything
    uv run python -m pipeline.fetch --only h   # hypocentre files only
"""

from __future__ import annotations

import argparse
import re
import sys
import time
import urllib.request
from pathlib import Path

BASE = "https://www.data.jma.go.jp/eqev/data/bulletin/"
INDEXES = {
    "h": ("hypo_e.html", r"\./data/hypo/(h\d+\.zip)", "data/hypo/"),
    "i": ("shindo_e.html", r"\./data/shindo/((?:i\d+|code_p)\.zip)", "data/shindo/"),
}
USER_AGENT = "QuakeTracker data pipeline (python-urllib)"


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def list_files(kind: str) -> list[tuple[str, str]]:
    page, pattern, prefix = INDEXES[kind]
    html = _get(BASE + page).decode("utf-8", errors="replace")
    names = sorted(set(re.findall(pattern, html)))
    return [(name, BASE + prefix + name) for name in names]


def fetch(dest: Path, kinds: list[str], delay: float = 0.5) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for kind in kinds:
        files = list_files(kind)
        print(f"{kind}: {len(files)} files listed")
        for name, url in files:
            target = dest / name
            if target.exists() and target.stat().st_size > 0:
                continue
            data = _get(url)
            if not data.startswith(b"PK"):
                raise RuntimeError(f"{url}: not a zip ({data[:80]!r})")
            tmp = target.with_suffix(".part")
            tmp.write_bytes(data)
            tmp.rename(target)
            print(f"  {name}  {len(data) / 1e6:.1f} MB")
            time.sleep(delay)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dest", type=Path, default=Path("data/raw"))
    ap.add_argument("--only", choices=sorted(INDEXES), action="append")
    args = ap.parse_args(argv)
    fetch(args.dest, args.only or sorted(INDEXES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
