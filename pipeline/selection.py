"""Which events the site shows. One definition, used by every build step.

Agreed rules (README, "Decisions"):
- Geographic: epicentre inside JAPAN_BOX, or the event has intensity readings
  in Japan (so a distant event that was felt still appears).
- Artificial events (class 3) never; events located by USGS/other agencies
  only when felt in Japan.
- Low-frequency events are shown, with a UI toggle; Gutenberg-Richter
  statistics use natural earthquakes only (NATURAL).
"""

JAPAN_BOX = {"lat_min": 24.0, "lat_max": 46.0, "lon_min": 122.0, "lon_max": 148.0}

IN_BOX = (
    f"(lat BETWEEN {JAPAN_BOX['lat_min']} AND {JAPAN_BOX['lat_max']} "
    f"AND lon BETWEEN {JAPAN_BOX['lon_min']} AND {JAPAN_BOX['lon_max']})"
)

# JMA-located natural earthquakes with a magnitude: the population whose
# magnitude-frequency distribution is meaningful.
NATURAL = "agency = 'J' AND event_class IN ('1', '2') AND mag1 IS NOT NULL"

# For Gutenberg-Richter counts and completeness. Felt-but-distant events are
# left out here: they would add a few large magnitudes from regions whose
# small events are never catalogued.
GR_SELECTION = f"{NATURAL} AND {IN_BOX}"


def shown(felt_column: str = "felt") -> str:
    """SQL predicate for events shown on maps, given a boolean column saying
    whether the event has intensity readings in Japan."""
    return (
        f"event_class IS DISTINCT FROM '3' "
        f"AND (agency = 'J' OR {felt_column}) "
        f"AND ({IN_BOX} OR {felt_column})"
    )
