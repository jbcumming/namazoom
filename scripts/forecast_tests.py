"""Extra forecast tests, beyond the one on the site (results are not shown on the site).

    uv run python scripts/forecast_tests.py [out.json]   # from the repo root, ~10 min

Uses the cached 2000-2015 fit from pipeline.build.forecast (run that first).
Each quake's spatial spread is computed once as a sparse matrix, so thousands of
forecasts are fast; the weekly ETAS forecast matches forecast_m0 exactly.

Test 1: ETAS vs simpler rules on the weekly 2016+ test, each simple rule being the
long-term average plus one shape scaled by a constant fitted on 2000-2015:
  - "last week repeats": last week's M4+ quakes, spread like aftershocks;
  - "aftershock formula": Reasenberg & Jones (1989) generic Omori decay with
    productivity 10^(b*M), no secondary aftershocks.
Both borrow ETAS's fitted spatial spread, so they test timing and productivity only.
Test 2: forecast length (1/7/30 days) and data delay (daily windows, with data cut
0 h to 7 days before the window, or at the start of its week), over all days and
over the days within 3 days after an M6+.

Results (Nov 2026 run; gain = information gain per M5+ quake over the long-term average):
  test 1  long-term 0 | last week repeats 0.42 | aftershock formula 0.53 | ETAS 0.98
  length  1 day 1.57 | 7 days 0.98 | 30 days 0.61
  delay   0 h 1.57 | 1 h 1.56 | 6 h 1.47 | 1 day 1.20 | 3 days 0.91 | 7 days 0.67 | weekly issue 1.02
  after M6+ (315 days, 159 quakes): 0 h 3.13 | 6 h 2.97 | 1 day 1.99 | 3 days 0.80 | weekly issue 1.41
"""
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
from scipy import sparse
from scipy.optimize import minimize_scalar

sys.path.insert(0, ".")
from pipeline.build import forecast as fc  # noqa: E402
from pipeline.forecast import etas  # noqa: E402

interim = Path("data/interim")
cat, mag = fc.load(interim)
fit = fc.fit_period(cat, mag, fc.day_of(fc.FIT_START), fc.day_of(fc.TEST_START), interim / "forecast")
P, b = fit.params, fit.b
grid = fc.fine_grid()
k5 = round(fc.COARSE / fc.FINE)
ncy, ncx = grid.ny // k5, grid.nx // k5
NC = ncy * ncx
to5 = 10 ** (-b * (5.0 - etas.M0))

# --- spatial footprints: row k = expected share of quake k's aftershocks per coarse cell (as triggered_grid)
t_ = time.time()
lats, lons, area = grid.lats, grid.lons, grid.area_km2()
half2 = (grid.step * 111.0 / 2) ** 2
rows, cols, vals = [], [], []
for k in range(len(cat.t)):
    mk = cat.m[k]
    s2 = P.d * np.exp(P.gamma * mk)
    R = float(etas.reach_km(mk))
    span = R / 111.0
    ilo, ihi = np.searchsorted(lats, cat.lat[k] - span), np.searchsorted(lats, cat.lat[k] + span)
    cs = span / max(np.cos(np.radians(cat.lat[k])), 0.2)
    jlo, jhi = np.searchsorted(lons, cat.lon[k] - cs), np.searchsorted(lons, cat.lon[k] + cs)
    if ilo >= ihi or jlo >= jhi:
        continue
    r2 = etas.dist2_km(cat.lat[k], cat.lon[k], lats[ilo:ihi, None], lons[None, jlo:jhi])
    f = np.where(r2 <= R * R, etas.spatial_pdf(r2 + half2, s2, P.q), 0.0) * area[ilo:ihi, jlo:jhi]
    tot = f.sum()
    if tot <= 0:
        continue
    f = f * etas.spatial_mass(R * R, s2, P.q) / tot
    ii, jj = np.nonzero(f)
    c = ((ii + ilo) // k5) * ncx + (jj + jlo) // k5
    rows.append(np.full(len(c), k)); cols.append(c); vals.append(f[ii, jj])
F = sparse.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(len(cat.t), NC))
F.sum_duplicates()
print(f"footprints: {len(cat.t):,} quakes, {time.time() - t_:.0f} s", flush=True)

bg_day = fc.coarse(P.mu * fit.background * area).ravel()  # background M0+ per day per coarse cell
base5_day = fc.coarse(fit.long_term).ravel() * to5     # long-term average M5+ per day per coarse cell
prod = P.K * np.exp(P.alpha * cat.m)


def etas_lam5(t_data, t0, days):
    """ETAS expected M5+ per coarse cell in [t0, t0+days) from quakes before t_data (<= t0)."""
    j = np.flatnonzero((cat.t < t_data) & (cat.t >= t0 - etas.TMAX))
    dH = etas.omori_integral(t0 + days - cat.t[j], P.c, P.p) - etas.omori_integral(t0 - cat.t[j], P.c, P.p)
    trig = (prod[j] * dH) @ F[j]
    bg = bg_day * days
    k = etas.cascade(P, fit.branching, float(trig.sum() + bg.sum()), days)
    return (trig + bg) * k * to5


# Persistence: last week's M4+ quakes, smoothed with the same footprints.
foot_norm = np.asarray(F.sum(axis=1)).ravel()
foot_norm[foot_norm == 0] = 1
Fn = sparse.diags(1 / foot_norm) @ F


def persist_shape(t0):
    j = np.flatnonzero((cat.t < t0) & (cat.t >= t0 - 7))
    return np.ones(len(j)) @ Fn[j] if len(j) else np.zeros(NC)


# Generic aftershock formula (Reasenberg & Jones 1989): rate ~ 10^(b*Mmain) * (t+c)^-p,
# California generic c=0.05 d, p=1.08; no secondary aftershocks; productivity scaled by one fitted constant.
RJ_C, RJ_P = 0.05, 1.08


def rj_shape(t0, days):
    j = np.flatnonzero((cat.t < t0) & (cat.t >= t0 - etas.TMAX))
    dH = etas.omori_integral(t0 + days - cat.t[j], RJ_C, RJ_P) - etas.omori_integral(t0 - cat.t[j], RJ_C, RJ_P)
    return (10 ** (b * cat.m[j]) * dH) @ Fn[j]


def obs5(t0, days):
    return fc.observed(cat, mag, t0, days, 5.0).ravel()


def pll(lam, n):
    lam = np.maximum(lam, 1e-12)
    return float(np.sum(-lam + n * np.log(lam)))  # constant term cancels in differences


def windows(t_start, t_end, days):
    t = t_start
    while t + days <= t_end:
        yield t
        t += days


data_end = float(cat.t.max())
fit_weeks = list(windows(fc.day_of(fc.FIT_START), fc.day_of(fc.TEST_START), 7))
test_weeks = list(windows(fc.day_of(fc.TEST_START), data_end, 7))

# Check against the site's weekly test for one week.
w0 = test_weeks[100]
ref = fc.coarse(fc.to_mag(fc.forecast_m0(fit, cat, w0)[0], b, 5.0)).ravel()
print(f"check vs forecast_m0: {etas_lam5(w0, w0, 7).sum():.4f} vs {ref.sum():.4f}", flush=True)


def fit_scale(shapes, obs, base):
    """One constant a >= 0 for lam = base + a * shape, by maximum likelihood on the fit period."""
    def nll(la):
        a = math.exp(la)
        return -sum(pll(base + a * s, o) for s, o in zip(shapes, obs))
    r = minimize_scalar(nll, bounds=(-20, 10), method="bounded")
    return math.exp(r.x)


base_w = base5_day * 7
fo = [obs5(t, 7) for t in fit_weeks]
a_p = fit_scale([persist_shape(t) * to5 for t in fit_weeks], fo, base_w)
a_rj = fit_scale([rj_shape(t, 7) * to5 for t in fit_weeks], fo, base_w)
print(f"fitted scales: persistence {a_p:.3g}, aftershock formula {a_rj:.3g}", flush=True)


def score(lams, obs, base):
    n = sum(o.sum() for o in obs)
    gain = (sum(pll(l, o) for l, o in zip(lams, obs)) - sum(pll(base, o) for o in obs)) / n
    p = np.concatenate([1 - np.exp(-l) for l in lams])
    hits = np.concatenate(obs)
    order = np.argsort(-p, kind="stable")
    cap = {f: float(hits[order[: int(len(p) * f)]].sum() / hits.sum()) for f in (0.01, 0.05)}
    return {"quakes": int(n), "pred": round(float(sum(l.sum() for l in lams)), 1),
            "gain": round(gain, 3), "top1": round(cap[0.01], 3), "top5": round(cap[0.05], 3)}


out = {}
to = [obs5(t, 7) for t in test_weeks]
models = {
    "long-term average": [base_w for _ in test_weeks],
    "last week repeats": [base_w + a_p * persist_shape(t) * to5 for t in test_weeks],
    "aftershock formula": [base_w + a_rj * rj_shape(t, 7) * to5 for t in test_weeks],
    "ETAS": [etas_lam5(t, t, 7) for t in test_weeks],
}
out["test1"] = {k: score(v, to, base_w) for k, v in models.items()}
print(json.dumps(out["test1"], indent=1), flush=True)

# Test 2a: forecast length, no delay.
out["length"] = {}
for days in (1, 7, 30):
    ws = list(windows(fc.day_of(fc.TEST_START), data_end, days))
    ob = [obs5(t, days) for t in ws]
    out["length"][days] = score([etas_lam5(t, t, days) for t in ws], ob, base5_day * days)
    print(days, out["length"][days], flush=True)

# Test 2b: delay. Daily windows; data cut L days before the window starts.
days_ = list(windows(fc.day_of(fc.TEST_START), data_end, 1))
ob = [obs5(t, 1) for t in days_]
out["delay"] = {}
for label, L in [("0", 0), ("1 h", 1 / 24), ("6 h", 0.25), ("1 day", 1), ("3 days", 3), ("7 days", 7)]:
    out["delay"][label] = score([etas_lam5(t - L, t, 1) for t in days_], ob, base5_day)
    print(label, out["delay"][label], flush=True)
# Weekly issue: each day forecast from data at the start of its week (what the site does now).
wk0 = fc.day_of(fc.TEST_START)
out["delay"]["weekly issue"] = score([etas_lam5(wk0 + 7 * ((t - wk0) // 7), t, 1) for t in days_], ob, base5_day)
print("weekly issue", out["delay"]["weekly issue"], flush=True)

# Same, only for days within 3 days after an M6+ (where timing should matter most).
m6t = cat.t[mag >= 6.0]
near = [i for i, t in enumerate(days_) if np.any((m6t < t) & (m6t >= t - 3))]
out["delay_afterM6"] = {"days": len(near)}
for label, L in [("0", 0), ("6 h", 0.25), ("1 day", 1), ("3 days", 3)]:
    out["delay_afterM6"][label] = score([etas_lam5(days_[i] - L, days_[i], 1) for i in near], [ob[i] for i in near], base5_day)
out["delay_afterM6"]["weekly issue"] = score(
    [etas_lam5(wk0 + 7 * ((days_[i] - wk0) // 7), days_[i], 1) for i in near], [ob[i] for i in near], base5_day)
print(json.dumps(out["delay_afterM6"], indent=1), flush=True)

Path(sys.argv[1] if len(sys.argv) > 1 else "data/interim/forecast/tests.json").write_text(json.dumps(out, indent=1))
