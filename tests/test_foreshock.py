import numpy as np

from pipeline.build.foreshock import rupture_km


def test_rupture_length_utsu():
    # log10 L = 0.5 M - 1.85: M7 -> ~45 km, M9 -> ~450 km
    assert np.isclose(rupture_km(np.array(7.0)), 44.7, atol=0.1)
    assert np.isclose(rupture_km(np.array(9.0)), 446.7, atol=0.1)
