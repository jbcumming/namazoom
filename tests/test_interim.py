"""Checks on the full ingested dataset. Skipped until the pipeline has been run
(see README: fetch, ingest, completeness)."""

from pathlib import Path

import pytest

from pipeline.build.overview import report

INTERIM = Path(__file__).parent.parent / "data" / "interim"

pytestmark = pytest.mark.skipif(
    not (INTERIM / "manifest.json").exists() or not (INTERIM / "completeness_national.parquet").exists(),
    reason="data/interim not built",
)


def test_overview_checks_pass():
    # IDs unique across the whole catalogue, every reading's group exists,
    # instrumental intensity agrees with class, and the historic quakes match.
    text, ok = report(INTERIM)
    assert ok, text
