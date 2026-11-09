"""7-day earthquake forecasts (ETAS) and their test.

    uv run python -m pipeline.build.forecast

Model: pipeline.forecast.etas, fitted to shallow (<= 100 km) quakes of M4 and
above in the Japan box, with JMA's natural-earthquake classes plus the
preliminary data.

Test (pseudo-prospective): parameters and background fitted on 2000-2015 only;
then each week from 2016 on is forecast from the quakes before it, and
compared with the M5+ quakes that followed, alongside a baseline that always
forecasts the long-term average rate. "Pseudo" because it was run after the
fact, but nothing from a test week is used to forecast it.

Live forecast: parameters refitted on 2000 to the end of the finalised
catalogue; the 7 days after the data ends. Each new live forecast is appended
to data/forecasts/issued.jsonl, and scored once the data covers its week: that
record is truly prospective.

Writes site/public/data/forecast.json. Fits are cached in data/interim/forecast/.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import duckdb
import numpy as np

from ..forecast import etas
from ..forecast.etas import M0, Catalogue, Grid, Params
from ..selection import IN_BOX, JAPAN_BOX, NATURAL

FIT_START = "2000-01-01"
TEST_START = "2016-01-01"  # the test's fit ends here
CATALOGUE_START = 1990  # earlier quakes still trigger, so they are loaded as parents
DAYS = 7
FINE = 0.1  # forecast grid, degrees
COARSE = 0.5  # cells shown and scored
MAX_DEPTH_KM = 100
EPOCH = datetime(1970, 1, 1)


def day_of(s: str | datetime) -> float:
    d = datetime.fromisoformat(s) if isinstance(s, str) else s
    return (d - EPOCH).total_seconds() / 86400


def iso(day: float) -> str:
    return (EPOCH + timedelta(days=day)).isoformat(timespec="seconds") + "Z"


def selection() -> str:
    """Natural quakes, plus preliminary ones (which are not classified yet)."""
    return (f"(({NATURAL}) OR (source LIKE 'prelim:%' AND mag1 IS NOT NULL)) AND {IN_BOX} "
            f"AND depth_km <= {MAX_DEPTH_KM} AND mag1 >= {M0} AND year >= {CATALOGUE_START}")


def load(interim: Path) -> tuple[Catalogue, np.ndarray]:
    con = duckdb.connect()
    r = con.execute(f"""
        SELECT epoch(origin_utc) / 86400.0 AS t, lat, lon, mag1
        FROM read_parquet('{interim / 'events' / '*.parquet'}') WHERE {selection()} ORDER BY t
    """).fetchnumpy()
    t, lat, lon, mag = (np.asarray(r[k], float) for k in ("t", "lat", "lon", "mag1"))
    return Catalogue(t, lat, lon, mag - M0), mag


def fine_grid() -> Grid:
    b = JAPAN_BOX
    return Grid(b["lat_min"], b["lon_min"], FINE, round((b["lat_max"] - b["lat_min"]) / FINE),
                round((b["lon_max"] - b["lon_min"]) / FINE))


def coarse(a: np.ndarray) -> np.ndarray:
    k = round(COARSE / FINE)
    ny, nx = a.shape
    return a.reshape(ny // k, k, nx // k, k).sum(axis=(1, 3))


@dataclass
class Fit:
    start: float
    end: float
    params: Params
    b: float
    background: np.ndarray  # density per km^2 on the fine grid
    long_term: np.ndarray   # all M0+ quakes per day per cell (fine grid), clustering included
    n_fit: int
    loglik: float
    background_share: float
    branching: float  # realised: average direct aftershocks per fitted quake


def fit_period(cat: Catalogue, mag: np.ndarray, t1: float, t2: float, cache: Path) -> Fit:
    key = f"fit_{iso(t1)[:10]}_{iso(t2)[:10]}_n{int(((cat.t >= t1) & (cat.t < t2)).sum())}"
    path = cache / f"{key}.npz"
    grid = fine_grid()
    targets = (cat.t >= t1) & (cat.t < t2)
    idx = np.flatnonzero(targets)
    h = etas.bandwidths(cat, idx)
    if path.exists():
        z = np.load(path)
        P = Params.from_vector(z["v"])
        return Fit(t1, t2, P, float(z["b"]), z["dens"], z["long"], int(targets.sum()), float(z["ll"]), float(z["share"]),
                   etas.realised_branching(P, cat, idx))
    t0 = time.time()
    pairs = etas.build_pairs(cat, targets)
    phi = np.where(targets, 0.5, 0.0)
    P = Params(mu=0.5, K=0.02, alpha=1.5, c=0.01, p=1.1, d=10.0, q=1.6, gamma=1.0)
    ll_prev = -math.inf
    for _ in range(8):  # background <-> parameters, until the likelihood settles (Zhuang et al. 2002)
        dens = etas.smooth_density(cat, phi, grid, idx, h)
        u_at = etas.density_at(dens, grid, cat.lat, cat.lon)
        P, ll = etas.fit(cat, targets, u_at, t1, t2, P, pairs)
        phi = etas.background_probability(P, cat, pairs, targets, u_at)
        if ll - ll_prev < 5:
            break
        ll_prev = ll
    b = etas.b_value(mag[targets], M0)
    ones = np.where(targets, 1.0, 0.0)
    long = etas.smooth_density(cat, ones, grid, idx, h) * grid.area_km2() * targets.sum() / (t2 - t1)
    share = float(phi[targets].mean())
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(path, v=P.vector(), b=b, dens=dens, long=long, ll=ll, share=share)
    print(f"  fitted {iso(t1)[:10]}..{iso(t2)[:10]}: {targets.sum():,} quakes, {time.time() - t0:.0f} s")
    return Fit(t1, t2, P, b, dens, long, int(targets.sum()), ll, share, etas.realised_branching(P, cat, idx))


def forecast_m0(fit: Fit, cat: Catalogue, t0: float, days: float = DAYS) -> tuple[np.ndarray, float]:
    """Expected M0+ quakes per fine cell in [t0, t0 + days], and the cascade factor used."""
    grid = fine_grid()
    P = fit.params
    trig = etas.triggered_grid(P, cat, grid, t0, days)
    bg = P.mu * days * fit.background * grid.area_km2()
    k = etas.cascade(P, fit.branching, float(trig.sum() + bg.sum()), days)
    return (bg + trig) * k, k


def to_mag(lam_m0: np.ndarray | float, b: float, m: float):
    return lam_m0 * 10 ** (-b * (m - M0))


def observed(cat: Catalogue, mag: np.ndarray, t0: float, days: float, m: float) -> np.ndarray:
    """M+ quakes per coarse cell in [t0, t0 + days)."""
    grid = fine_grid()
    sel = (cat.t >= t0) & (cat.t < t0 + days) & (mag >= m - 1e-9)
    out = np.zeros((grid.ny, grid.nx))
    i, j = grid.index(cat.lat[sel], cat.lon[sel])
    ok = (i >= 0) & (i < grid.ny) & (j >= 0) & (j < grid.nx)
    np.add.at(out, (i[ok], j[ok]), 1)
    return coarse(out)


def poisson_range(lam: float, n: int) -> bool:
    """n within the central 95% of a Poisson(lam) count."""
    from scipy.stats import poisson
    return bool(poisson.ppf(0.025, lam) <= n <= poisson.ppf(0.975, lam))


def poisson_ll(lam: np.ndarray, n: np.ndarray) -> float:
    lam = np.maximum(lam, 1e-12)
    return float(np.sum(-lam + n * np.log(lam) - np.vectorize(math.lgamma)(n + 1)))


def run_test(cat: Catalogue, mag: np.ndarray, fit: Fit, data_end: float) -> dict:
    """Weekly forecasts from TEST_START with the pre-2016 fit, scored against M5+ quakes."""
    weeks = []
    rel = {"etas": [], "base": []}  # per coarse cell-week: (probability, M5+ count)
    ll = {"etas": 0.0, "base": 0.0}
    base5 = coarse(to_mag(fit.long_term * DAYS, fit.b, 5.0))
    t0 = day_of(TEST_START)
    t_start = time.time()
    while t0 + DAYS <= data_end:
        lam4, k = forecast_m0(fit, cat, t0)
        lam5 = coarse(to_mag(lam4, fit.b, 5.0))
        obs5 = observed(cat, mag, t0, DAYS, 5.0)
        tot4 = float(lam4.sum())
        ll["etas"] += poisson_ll(lam5, obs5)
        ll["base"] += poisson_ll(base5, obs5)
        n = obs5.ravel()
        rel["etas"].append(np.c_[1 - np.exp(-lam5.ravel()), n])
        rel["base"].append(np.c_[1 - np.exp(-base5.ravel()), n])
        weeks.append({
            "t": round(t0 * 86400), "pred5": round(float(to_mag(tot4, fit.b, 5.0)), 3),
            "pred6": round(float(to_mag(tot4, fit.b, 6.0)), 4), "obs5": int(obs5.sum()),
            "obs6": int(((cat.t >= t0) & (cat.t < t0 + DAYS) & (mag >= 6.0)).sum()),
            "cascade": round(k, 3),
        })
        t0 += DAYS
    base_week5 = float(base5.sum())
    n5 = sum(w["obs5"] for w in weeks)
    print(f"  test: {len(weeks)} weeks, {n5} M5+ quakes, {time.time() - t_start:.0f} s")

    def reliability(rows: list[np.ndarray]) -> list[dict]:
        a = np.vstack(rows)
        edges = [0, 1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.3, 1.0001]
        out = []
        for lo, hi in zip(edges[:-1], edges[1:]):
            s = a[(a[:, 0] >= lo) & (a[:, 0] < hi)]
            if len(s):
                out.append({"lo": lo, "hi": min(hi, 1.0), "n": int(len(s)), "p": float(s[:, 0].mean()),
                            "hits": int((s[:, 1] > 0).sum())})
        return out

    def capture(rows: list[np.ndarray]) -> dict:
        """Share of M5+ quakes inside the top 1% / 5% of cell-weeks, ranked by forecast probability."""
        a = np.vstack(rows)
        a = a[np.argsort(-a[:, 0], kind="stable")]
        total = a[:, 1].sum()
        return {str(f): round(float(a[: int(len(a) * f), 1].sum() / total), 3) for f in (0.01, 0.05)}

    pred = np.array([w["pred5"] for w in weeks])
    obs = np.array([w["obs5"] for w in weeks])
    return {
        "from": iso(day_of(TEST_START)), "weeks": weeks, "baseWeek5": round(base_week5, 3),
        "n5": n5, "pred5": round(float(pred.sum()), 1), "base5": round(base_week5 * len(weeks), 1),
        # Information gain per earthquake (natural log units) over the long-term average.
        "gainPerQuake": round((ll["etas"] - ll["base"]) / max(n5, 1), 3),
        "llEtas": round(ll["etas"], 1), "llBase": round(ll["base"], 1),
        "reliability": {k: reliability(v) for k, v in rel.items()},
        "capture": {k: capture(v) for k, v in rel.items()},
        "weeksInRange": round(float(np.mean([poisson_range(p_, o_) for p_, o_ in zip(pred, obs)])), 3),
    }


def cell_list(lam5: np.ndarray, base5: np.ndarray, min_lam: float = 1e-4) -> list[list]:
    """Sparse coarse cells [i, j, expected M5+, long-term expected M5+]."""
    out = []
    for i, j in zip(*np.nonzero((lam5 >= min_lam) | (base5 >= min_lam))):
        out.append([int(i), int(j), round(float(lam5[i, j]), 5), round(float(base5[i, j]), 5)])
    return out


def score_issued(log: Path, cat: Catalogue, mag: np.ndarray, data_end: float) -> list[dict]:
    if not log.exists():
        return []
    out = []
    for line in log.read_text().splitlines():
        e = json.loads(line)
        t0 = e["t0"] / 86400
        row = {"t0": e["t0"], "issued": e["issued"], "pred5": e["pred5"], "base5": e["base5"]}
        if t0 + DAYS <= data_end:
            row["obs5"] = int(((cat.t >= t0) & (cat.t < t0 + DAYS) & (mag >= 5.0)).sum())
        out.append(row)
    return out


def build(interim: Path, out: Path, forecasts: Path) -> dict:
    cat, mag = load(interim)
    manifest = json.loads((interim / "manifest.json").read_text())
    # Data end: the time the preliminary sources cover to (the live list's download
    # time, on the hour), or else midnight JST after the last day with quakes.
    prelim = manifest.get("prelim") or {}
    if prelim.get("covered_to"):
        end_jst = datetime.fromisoformat(prelim["covered_to"]).replace(minute=0, second=0)
    else:
        if prelim.get("last"):
            last_jst = datetime.fromisoformat(prelim["last"])
        else:  # no preliminary data: the end of the last catalogue day
            last_jst = EPOCH + timedelta(days=float(cat.t.max()), hours=9)
        end_jst = datetime.combine(last_jst.date() + timedelta(days=1), datetime.min.time())
    data_end = day_of(end_jst - timedelta(hours=9))
    final_end = day_of(f"{prelim['after'][:4]}-12-31T15:00:00") if prelim.get("after") else data_end

    cache = interim / "forecast"
    test_fit = fit_period(cat, mag, day_of(FIT_START), day_of(TEST_START), cache)
    live_fit = fit_period(cat, mag, day_of(FIT_START), final_end, cache)
    test = run_test(cat, mag, test_fit, data_end)

    lam4, k = forecast_m0(live_fit, cat, data_end)
    lam5 = coarse(to_mag(lam4, live_fit.b, 5.0))
    base5 = coarse(to_mag(live_fit.long_term * DAYS, live_fit.b, 5.0))
    total4 = float(lam4.sum())
    live = {
        "t0": round(data_end * 86400), "days": DAYS, "b": round(live_fit.b, 3), "cascade": round(k, 3),
        "expected": {str(m): round(float(to_mag(total4, live_fit.b, m)), 4) for m in (5, 6, 7)},
        "baseline": {str(m): round(float(to_mag(live_fit.long_term.sum() * DAYS, live_fit.b, m)), 4) for m in (5, 6, 7)},
        "cells": cell_list(lam5, base5),
    }

    # Prospective record: one entry per forecast start.
    forecasts.mkdir(parents=True, exist_ok=True)
    log = forecasts / "issued.jsonl"
    seen = {json.loads(x)["t0"] for x in log.read_text().splitlines()} if log.exists() else set()
    if live["t0"] not in seen:
        with log.open("a") as f:
            f.write(json.dumps({"t0": live["t0"], "issued": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                "pred5": live["expected"]["5"], "base5": live["baseline"]["5"],
                                "params": live_fit.params.as_dict(), "b": live_fit.b, "cells": live["cells"]}) + "\n")

    def fit_info(f: Fit) -> dict:
        return {"from": iso(f.start), "to": iso(f.end), "n": f.n_fit, "b": round(f.b, 3),
                "params": {k: round(v, 5) for k, v in f.params.as_dict().items()},
                "branching": round(f.branching, 3),
                "backgroundShare": round(f.background_share, 3)}

    data = {
        "m0": M0, "maxDepth": MAX_DEPTH_KM, "grid": {"lat0": JAPAN_BOX["lat_min"], "lon0": JAPAN_BOX["lon_min"], "step": COARSE},
        "dataEnd": round(data_end * 86400), "fit": fit_info(live_fit), "testFit": fit_info(test_fit),
        "live": live, "test": test, "issued": score_issued(log, cat, mag, data_end),
    }
    out.mkdir(parents=True, exist_ok=True)
    path = out / "forecast.json"
    path.write_text(json.dumps(data, separators=(",", ":")))
    return {"path": str(path), "bytes": path.stat().st_size,
            "test": {k: test[k] for k in ("n5", "pred5", "base5", "gainPerQuake", "capture", "weeksInRange")},
            "live": live["expected"], "baseline": live["baseline"]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interim", type=Path, default=Path("data/interim"))
    ap.add_argument("--out", type=Path, default=Path("site/public/data"))
    ap.add_argument("--forecasts", type=Path, default=Path("data/forecasts"))
    args = ap.parse_args(argv)
    info = build(args.interim, args.out, args.forecasts)
    print(json.dumps(info, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
