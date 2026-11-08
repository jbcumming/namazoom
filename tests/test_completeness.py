import math

import pytest

from pipeline.build.completeness import estimate_mc


def synthetic(mc: float, b: float, n_total: int, roll_off: float = 0.6) -> dict[float, int]:
    """Gutenberg-Richter counts above mc, with detection falling off
    smoothly below it - the shape of a real catalogue."""
    a = math.log10(n_total) + b * (mc - 0.05)
    counts = {}
    for m10 in range(-10, 80):
        m = m10 / 10
        n = 10 ** (a - b * (m - 0.05)) - 10 ** (a - b * (m + 0.05))
        if m < mc - 1e-9:
            n *= math.exp(-((mc - m) / roll_off) ** 2 * 3)
        if round(n) > 0:
            counts[m] = round(n)
    return counts


@pytest.mark.parametrize("mc, b", [(1.0, 1.0), (2.5, 0.8), (0.3, 1.1)])
def test_recovers_mc_and_b(mc, b):
    est = estimate_mc(synthetic(mc, b, 20_000))
    assert est["method"].startswith("gft")
    assert abs(est["mc"] - mc) <= 0.2
    assert est["b_value"] == pytest.approx(b, abs=0.1)


def test_too_few_events_gives_no_estimate():
    est = estimate_mc({3.0: 50, 3.1: 40})
    assert est["mc"] is None and est["n_events"] == 90
