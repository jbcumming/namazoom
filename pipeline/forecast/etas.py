"""Space-time ETAS model (Ogata 1988, 1998). Pure functions on numpy arrays.

The rate of quakes of magnitude >= M0 at time t (days) and position x is

    lambda(t, x) = mu * u(x) + sum over earlier quakes j of
                   K exp(alpha m_j) (t - t_j + c)^-p  *  f(x - x_j | m_j)

with m_j = M_j - M0, u a background density (integrates to 1 over the region)
and f the spatial spread of each quake's aftershocks,

    f(r | m) = (q - 1) / (pi s2) * (1 + r^2 / s2)^-q,   s2 = d exp(gamma m)  [km^2].

Each quake's influence is cut off after TMAX days and beyond R(m) km, and the
likelihood's integral term uses the same cut-offs, so the model is consistent.
Magnitudes follow Gutenberg-Richter with one b-value.

Only first-generation triggering is summed when forecasting a window: quakes
that happen inside the window add their own aftershocks, which `cascade`
accounts for on average (see there).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
from scipy.optimize import minimize

EARTH_R = 6371.0
TMAX = 3 * 365.25  # days
M0 = 4.0  # smallest magnitude modelled


def reach_km(m: np.ndarray) -> np.ndarray:
    """Distance beyond which a quake's influence is cut off: about three rough rupture
    lengths (L = 10^(0.5 M - 1.8) km), at least 100 km, at most 800 km.
    M6 -> 100 km, M7 -> 170 km, M8 -> 540 km, M9 -> 800 km."""
    M = np.asarray(m, float) + M0
    return np.clip(3 * 10 ** (0.5 * M - 1.8), 100.0, 800.0)


@dataclass
class Params:
    mu: float      # background quakes per day in the region
    K: float
    alpha: float
    c: float       # days
    p: float
    d: float       # km^2
    q: float
    gamma: float

    def vector(self) -> np.ndarray:
        return np.array([np.log(self.mu), np.log(self.K), self.alpha, np.log(self.c), self.p,
                         np.log(self.d), self.q, self.gamma])

    @classmethod
    def from_vector(cls, v: np.ndarray) -> Params:
        return cls(np.exp(v[0]), np.exp(v[1]), v[2], np.exp(v[3]), v[4], np.exp(v[5]), v[6], v[7])

    def as_dict(self) -> dict:
        return {k: float(v) for k, v in asdict(self).items()}


BOUNDS = [(-10, 10), (-15, 5), (0.2, 3.5), (np.log(1e-5), np.log(1.0)), (0.8, 2.0),
          (np.log(0.1), np.log(1e4)), (1.05, 5.0), (0.0, 3.5)]


# --- geometry -----------------------------------------------------------------

def dist2_km(lat1, lon1, lat2, lon2) -> np.ndarray:
    """Squared great-circle distance in km^2 (haversine)."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dphi = p2 - p1
    dl = np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return (2 * EARTH_R * np.arcsin(np.sqrt(np.clip(a, 0, 1)))) ** 2


# --- kernels ------------------------------------------------------------------

def omori_integral(tau: np.ndarray, c: float, p: float) -> np.ndarray:
    """Integral of (s + c)^-p from 0 to tau (tau cut at TMAX)."""
    tau = np.minimum(np.maximum(tau, 0.0), TMAX)
    if abs(p - 1) < 1e-6:
        return np.log1p(tau / c)
    return ((tau + c) ** (1 - p) - c ** (1 - p)) / (1 - p)


def spatial_pdf(r2: np.ndarray, s2: np.ndarray, q: float) -> np.ndarray:
    return (q - 1) / (np.pi * s2) * (1 + r2 / s2) ** (-q)


def spatial_mass(r2max: np.ndarray, s2: np.ndarray, q: float) -> np.ndarray:
    """Share of f within r2max of the quake."""
    return 1 - (1 + r2max / s2) ** (1 - q)


# --- catalogue ------------------------------------------------------------------

@dataclass
class Catalogue:
    t: np.ndarray    # days, sorted
    lat: np.ndarray
    lon: np.ndarray
    m: np.ndarray    # magnitude minus M0

    def __len__(self) -> int:
        return len(self.t)


@dataclass
class Pairs:
    """Earlier quake j within reach of quake i: the terms of lambda at each quake."""
    i: np.ndarray
    j: np.ndarray
    dt: np.ndarray
    r2: np.ndarray


def build_pairs(cat: Catalogue, targets: np.ndarray) -> Pairs:
    """Pairs (target i, earlier j) with t_i - t_j <= TMAX and distance <= reach(m_j)."""
    reach2 = reach_km(cat.m) ** 2
    out_i, out_j, out_dt, out_r2 = [], [], [], []
    for i in np.flatnonzero(targets):
        lo = np.searchsorted(cat.t, cat.t[i] - TMAX)
        j = np.arange(lo, i)
        if not len(j):
            continue
        r2 = dist2_km(cat.lat[i], cat.lon[i], cat.lat[j], cat.lon[j])
        ok = (r2 <= reach2[j]) & (cat.t[j] < cat.t[i])
        if ok.any():
            j = j[ok]
            out_i.append(np.full(len(j), i, dtype=np.int32))
            out_j.append(j.astype(np.int32))
            out_dt.append(cat.t[i] - cat.t[j])
            out_r2.append(r2[ok])
    cat_ = (lambda xs, dt: np.concatenate(xs) if xs else np.zeros(0, dt))
    return Pairs(cat_(out_i, np.int32), cat_(out_j, np.int32), cat_(out_dt, float), cat_(out_r2, float))


# --- likelihood -----------------------------------------------------------------

def triggered_at_targets(P: Params, cat: Catalogue, pairs: Pairs, n: int) -> np.ndarray:
    """Sum of the triggering terms at each quake (length n, zero for non-targets)."""
    mj = cat.m[pairs.j]
    s2 = P.d * np.exp(P.gamma * mj)
    terms = P.K * np.exp(P.alpha * mj) * (pairs.dt + P.c) ** (-P.p) * spatial_pdf(pairs.r2, s2, P.q)
    return np.bincount(pairs.i, weights=terms, minlength=n)


def expected_triggered(P: Params, cat: Catalogue, t1: float, t2: float) -> float:
    """Expected number of quakes in [t1, t2] triggered (first generation) by quakes before t2."""
    j = cat.t < t2
    m, tj = cat.m[j], cat.t[j]
    s2 = P.d * np.exp(P.gamma * m)
    mass = spatial_mass(reach_km(m) ** 2, s2, P.q)
    dH = omori_integral(t2 - tj, P.c, P.p) - omori_integral(t1 - tj, P.c, P.p)
    return float(np.sum(P.K * np.exp(P.alpha * m) * dH * mass))


def neg_loglik(v: np.ndarray, cat: Catalogue, pairs: Pairs, targets: np.ndarray,
               u_at: np.ndarray, t1: float, t2: float) -> float:
    P = Params.from_vector(v)
    lam = P.mu * u_at[targets] + triggered_at_targets(P, cat, pairs, len(cat))[targets]
    if np.any(lam <= 0) or not np.all(np.isfinite(lam)):
        return 1e30
    integral = P.mu * (t2 - t1) + expected_triggered(P, cat, t1, t2)
    return float(integral - np.sum(np.log(lam)))


def fit(cat: Catalogue, targets: np.ndarray, u_at: np.ndarray, t1: float, t2: float,
        start: Params, pairs: Pairs | None = None) -> tuple[Params, float]:
    pairs = pairs or build_pairs(cat, targets)
    res = minimize(neg_loglik, start.vector(), args=(cat, pairs, targets, u_at, t1, t2),
                   method="L-BFGS-B", bounds=BOUNDS, options={"maxiter": 500})
    return Params.from_vector(res.x), -float(res.fun)


def background_probability(P: Params, cat: Catalogue, pairs: Pairs, targets: np.ndarray, u_at: np.ndarray) -> np.ndarray:
    """Probability that each target quake belongs to the background (Zhuang et al. 2002)."""
    bg = P.mu * u_at
    lam = bg + triggered_at_targets(P, cat, pairs, len(cat))
    out = np.zeros(len(cat))
    out[targets] = bg[targets] / lam[targets]
    return out


# --- background density ----------------------------------------------------------

@dataclass
class Grid:
    lat0: float
    lon0: float
    step: float
    ny: int
    nx: int

    @property
    def lats(self) -> np.ndarray:
        return self.lat0 + self.step * (np.arange(self.ny) + 0.5)

    @property
    def lons(self) -> np.ndarray:
        return self.lon0 + self.step * (np.arange(self.nx) + 0.5)

    def area_km2(self) -> np.ndarray:
        """Cell areas, shape (ny, nx)."""
        k = np.pi / 180 * EARTH_R * self.step
        return np.repeat((k * k * np.cos(np.radians(self.lats)))[:, None], self.nx, axis=1)

    def index(self, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return (np.floor((lat - self.lat0) / self.step).astype(int), np.floor((lon - self.lon0) / self.step).astype(int))


def bandwidths(cat: Catalogue, idx: np.ndarray, k: int = 10, floor_km: float = 5.0) -> np.ndarray:
    """Adaptive kernel widths: distance to the k-th nearest other quake (Zhuang et al. 2002)."""
    lat, lon = cat.lat[idx], cat.lon[idx]
    # Local flat-earth coordinates are accurate enough for picking a bandwidth.
    x = lon * 111.32 * np.cos(np.radians(lat))
    y = lat * 110.57
    from scipy.spatial import cKDTree
    d, _ = cKDTree(np.c_[x, y]).query(np.c_[x, y], k=min(k + 1, len(idx)))
    return np.maximum(d[:, -1], floor_km)


def smooth_density(cat: Catalogue, weights: np.ndarray, grid: Grid, idx: np.ndarray, h: np.ndarray) -> np.ndarray:
    """Weighted Gaussian kernel density of quakes idx on the grid, per km^2, integrating to 1 over the grid."""
    dens = np.zeros((grid.ny, grid.nx))
    lats, lons = grid.lats, grid.lons
    for n, k in enumerate(idx):
        w = weights[k]
        if w <= 0:
            continue
        hk = h[n]
        span = 3 * hk / 111.0
        ilo, ihi = np.searchsorted(lats, cat.lat[k] - span), np.searchsorted(lats, cat.lat[k] + span)
        cs = span / max(np.cos(np.radians(cat.lat[k])), 0.2)
        jlo, jhi = np.searchsorted(lons, cat.lon[k] - cs), np.searchsorted(lons, cat.lon[k] + cs)
        if ilo >= ihi or jlo >= jhi:
            continue
        r2 = dist2_km(cat.lat[k], cat.lon[k], lats[ilo:ihi, None], lons[None, jlo:jhi])
        dens[ilo:ihi, jlo:jhi] += w * np.exp(-r2 / (2 * hk * hk)) / (2 * np.pi * hk * hk)
    total = np.sum(dens * grid.area_km2())
    return dens / total if total > 0 else dens


def density_at(dens: np.ndarray, grid: Grid, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    i, j = grid.index(lat, lon)
    i, j = np.clip(i, 0, grid.ny - 1), np.clip(j, 0, grid.nx - 1)
    return dens[i, j]


# --- forecasts -------------------------------------------------------------------

def triggered_grid(P: Params, cat: Catalogue, grid: Grid, t0: float, days: float, min_weight: float = 1e-7) -> np.ndarray:
    """Expected first-generation triggered quakes (>= M0) per cell in [t0, t0 + days], from quakes before t0."""
    out = np.zeros((grid.ny, grid.nx))
    j = np.flatnonzero((cat.t < t0) & (cat.t >= t0 - TMAX))
    m = cat.m[j]
    dH = omori_integral(t0 + days - cat.t[j], P.c, P.p) - omori_integral(t0 - cat.t[j], P.c, P.p)
    weight = P.K * np.exp(P.alpha * m) * dH
    lats, lons, area = grid.lats, grid.lons, grid.area_km2()
    half2 = (grid.step * 111.0 / 2) ** 2  # smooth the kernel over about half a cell
    for k, w, mk in zip(j, weight, m):
        if w < min_weight:
            continue
        s2 = P.d * np.exp(P.gamma * mk)
        R = float(reach_km(mk))
        span = R / 111.0
        ilo, ihi = np.searchsorted(lats, cat.lat[k] - span), np.searchsorted(lats, cat.lat[k] + span)
        cs = span / max(np.cos(np.radians(cat.lat[k])), 0.2)
        jlo, jhi = np.searchsorted(lons, cat.lon[k] - cs), np.searchsorted(lons, cat.lon[k] + cs)
        if ilo >= ihi or jlo >= jhi:
            continue
        r2 = dist2_km(cat.lat[k], cat.lon[k], lats[ilo:ihi, None], lons[None, jlo:jhi])
        f = np.where(r2 <= R * R, spatial_pdf(r2 + half2, s2, P.q), 0.0) * area[ilo:ihi, jlo:jhi]
        tot = f.sum()
        if tot > 0:
            out[ilo:ihi, jlo:jhi] += w * spatial_mass(R * R, s2, P.q) * f / tot
    return out


def branching_ratio(P: Params, b: float) -> float:
    """Average number of direct aftershocks (>= M0) per quake, for G-R magnitudes with this b-value (unbounded)."""
    beta = b * np.log(10)
    if P.alpha >= beta:
        return float("inf")
    return float(P.K * beta / (beta - P.alpha) * omori_integral(np.array(TMAX), P.c, P.p))


def realised_branching(P: Params, cat: Catalogue, idx: np.ndarray) -> float:
    """Average number of direct aftershocks per quake for the quakes idx (their actual magnitudes).

    Unlike branching_ratio, this doesn't extrapolate Gutenberg-Richter to
    unbounded magnitudes, which overweights the rare giant quake."""
    m = cat.m[idx]
    s2 = P.d * np.exp(P.gamma * m)
    mass = spatial_mass(reach_km(m) ** 2, s2, P.q)
    return float(np.mean(P.K * np.exp(P.alpha * m) * mass) * omori_integral(np.array(TMAX), P.c, P.p))


def cascade(P: Params, n: float, first_gen: float, days: float, steps: int = 56) -> float:
    """Factor turning first-generation expected counts in a window into all-generation ones.

    Solves the renewal equation for the expected rate inside the window,
    rate(t) = rate0(t) + n * integral of g(t - s) rate(s) ds, with the
    first-generation rate taken as uniform over the window and g the
    normalised Omori kernel, and n the branching ratio (realised_branching).
    A rough, average correction; it ignores space.
    """
    if not np.isfinite(n) or n <= 0 or first_gen <= 0:
        return 1.0
    dt = days / steps
    edges = np.arange(steps + 1) * dt
    G = omori_integral(edges, P.c, P.p) / omori_integral(np.array(TMAX), P.c, P.p)
    g = np.diff(G)  # share of a quake's offspring in each step after it
    rate0 = np.full(steps, first_gen / steps)
    total = np.zeros(steps)
    for s in range(steps):
        total[s] = rate0[s] + n * np.sum(total[:s][::-1] * g[:s])
    return float(total.sum() / first_gen)


def simulate(P: Params, b: float, days: float, box: tuple[float, float, float, float],
             rng: np.random.Generator, max_m: float = 5.0) -> Catalogue:
    """Synthetic ETAS catalogue: uniform background in box (lat0, lat1, lon0, lon1), G-R magnitudes
    (m = M - M0 below max_m). Used to test the fit."""
    lat0, lat1, lon0, lon1 = box
    beta = b * np.log(10)

    def mags(n):
        u = rng.random(n)
        return -np.log(1 - u * (1 - np.exp(-beta * max_m))) / beta

    n_bg = rng.poisson(P.mu * days)
    t = list(rng.uniform(0, days, n_bg))
    lat = list(rng.uniform(lat0, lat1, n_bg))
    lon = list(rng.uniform(lon0, lon1, n_bg))
    m = list(mags(n_bg))
    queue = list(range(n_bg))
    norm = omori_integral(np.array(TMAX), P.c, P.p)
    while queue:
        k = queue.pop()
        n_kids = rng.poisson(P.K * np.exp(P.alpha * m[k]) * norm)
        for _ in range(n_kids):
            # time: invert the truncated Omori CDF numerically
            target = rng.random() * norm
            lo, hi = 0.0, TMAX
            for _ in range(60):
                mid = (lo + hi) / 2
                if omori_integral(np.array(mid), P.c, P.p) < target:
                    lo = mid
                else:
                    hi = mid
            tk = t[k] + lo
            if tk > days:
                continue
            s2 = P.d * np.exp(P.gamma * m[k])
            R2 = float(reach_km(m[k])) ** 2
            # radius: invert the truncated spatial CDF
            v = rng.random() * spatial_mass(R2, s2, P.q)
            r = np.sqrt(s2 * ((1 - v) ** (1 / (1 - P.q)) - 1))
            th = rng.uniform(0, 2 * np.pi)
            t.append(tk)
            lat.append(lat[k] + r * np.cos(th) / 111.2)
            lon.append(lon[k] + r * np.sin(th) / (111.2 * np.cos(np.radians(lat[k]))))
            m.append(float(mags(1)[0]))
            queue.append(len(t) - 1)
    order = np.argsort(t)
    return Catalogue(np.array(t)[order], np.array(lat)[order], np.array(lon)[order], np.array(m)[order])


def b_value(mags: np.ndarray, m0: float, bin_width: float = 0.1) -> float:
    """Aki-Utsu maximum-likelihood b-value for magnitudes >= m0 binned at bin_width."""
    return float(np.log10(np.e) / (np.mean(mags) - (m0 - bin_width / 2)))
