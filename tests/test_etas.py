"""ETAS model: kernels, likelihood consistency, and recovering known parameters."""

import numpy as np
import pytest
from scipy.integrate import quad

from pipeline.forecast import etas
from pipeline.forecast.etas import Catalogue, Grid, Params

TRUE = Params(mu=0.5, K=0.02, alpha=1.6, c=0.01, p=1.15, d=4.0, q=1.8, gamma=1.0)
BOX = (34.0, 40.0, 136.0, 142.0)


def test_omori_integral_matches_numeric():
    for p in (0.9, 1.0, 1.2):
        got = etas.omori_integral(np.array(30.0), 0.01, p)
        want, _ = quad(lambda s: (s + 0.01) ** -p, 0, 30, limit=200)
        assert got == pytest.approx(want, rel=1e-6)
    # cut off at TMAX
    assert etas.omori_integral(np.array(1e6), 0.01, 1.1) == pytest.approx(etas.omori_integral(np.array(etas.TMAX), 0.01, 1.1))


def test_spatial_pdf_integrates_to_mass():
    s2, q, R = 25.0, 1.7, 100.0
    num, _ = quad(lambda r: 2 * np.pi * r * etas.spatial_pdf(r * r, s2, q), 0, R, limit=200)
    assert num == pytest.approx(etas.spatial_mass(R * R, s2, q), rel=1e-6)


def test_reach_grows_with_magnitude():
    r = etas.reach_km(np.array([0.0, 2.0, 3.0, 4.0, 5.0]))
    assert r[0] == 100 and r[-1] == 800
    assert np.all(np.diff(r) >= 0)


def test_b_value():
    rng = np.random.default_rng(0)
    # b = 1 above 3.95, rounded to 0.1: the 4.0 bin holds 3.95-4.05
    m = np.round(3.95 + rng.exponential(1 / np.log(10), 200_000), 1)
    assert etas.b_value(m, 4.0) == pytest.approx(1.0, abs=0.02)


def test_cascade():
    assert etas.cascade(TRUE, 0.0, 10.0, 7) == pytest.approx(1.0)
    n = etas.branching_ratio(TRUE, 1.0)
    k = etas.cascade(TRUE, n, 10.0, 7)
    assert 1.0 < k < 1 / (1 - n)
    assert etas.cascade(TRUE, n / 2, 10.0, 7) < k


def test_realised_branching_close_to_theory_for_gr_magnitudes():
    rng = np.random.default_rng(2)
    beta = np.log(10)
    m = rng.exponential(1 / beta, 400_000)
    m = m[m < 5]  # G-R up to M9 when M0 = 4
    cat = Catalogue(np.zeros(len(m)), np.zeros(len(m)), np.zeros(len(m)), m)
    got = etas.realised_branching(TRUE, cat, np.arange(len(m)))
    assert got == pytest.approx(etas.branching_ratio(TRUE, 1.0), rel=0.1)


def test_fit_recovers_known_parameters():
    rng = np.random.default_rng(1)
    cat = etas.simulate(TRUE, 1.0, 2000, BOX, rng)
    area = (BOX[1] - BOX[0]) * 110.57 * (BOX[3] - BOX[2]) * 111.32 * np.cos(np.radians(37))
    targets = cat.t >= 200
    start = Params(mu=1, K=0.05, alpha=1.0, c=0.05, p=1.1, d=10, q=1.5, gamma=0.5)
    P, _ = etas.fit(cat, targets, np.full(len(cat), 1 / area), 200, 2000, start)
    assert P.mu == pytest.approx(TRUE.mu, rel=0.15)
    assert P.alpha == pytest.approx(TRUE.alpha, abs=0.25)
    assert P.p == pytest.approx(TRUE.p, abs=0.08)
    assert etas.branching_ratio(P, 1.0) == pytest.approx(etas.branching_ratio(TRUE, 1.0), abs=0.1)


def test_triggered_grid_spreads_the_expected_count():
    """One quake's expected first-generation aftershocks in a window, summed over the grid."""
    cat = Catalogue(np.array([0.0]), np.array([37.0]), np.array([139.0]), np.array([2.0]))
    grid = Grid(30.0, 130.0, 0.1, 140, 180)
    got = etas.triggered_grid(TRUE, cat, grid, 1.0, 7.0).sum()
    want = etas.expected_triggered(TRUE, cat, 1.0, 8.0)
    assert got == pytest.approx(want, rel=1e-6)
