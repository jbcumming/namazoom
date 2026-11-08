"""Code tables, transcribed from JMA's format documentation (data/docs/).

hypfmt_e.html covers the hypocentre file; shindo_format_e.txt covers the
seismic intensity file, whose hypocentre header shares columns 1-68.
"""

AGENCY = {
    "J": "JMA",
    "U": "USGS",
    "I": "other international (ISC, IASPEI, ...)",
}

MAG_TYPE = {
    "J": "MJ (local meteorological office)",
    "D": "MD (displacement)",
    "d": "MD, two stations",
    "V": "MV (velocity)",
    "v": "MV, two or three stations",
    "W": "Mw",
    "B": "mb (USGS)",
    "S": "MS (USGS)",
}

TRAVEL_TIME_TABLE = {
    "1": "83A or other standard",
    "2": "far east of Sanriku (LL)",
    "3": "east of Hokkaido",
    "4": "southern Kurils (with 83A)",
    "5": "JMA2001",
    "6": "southern Kurils (with JMA2001)",
    "7": "JMA2001A / JMA2020A-C by station",
}

LOCATION_PRECISION = {
    "1": "depth-free",
    "2": "depth-slice",
    "3": "fixed depth",
    "4": "depth phase",
    "5": "S-P time",
    "7": "poor solution (before March 2016)",
    "8": "undetermined or not accepted",
    "9": "fixed at nearest station",
    "M": "matched filter",
    # Not in the docs; seen once (USGS record, h1961.zip, 1964-12-07).
    "0": "undocumented code 0",
}

# Column 61. Code 4 is "eruption earthquake and others" in the hypocentre doc
# and "noise" in the intensity doc; we keep the code and use the former label.
EVENT_CLASS = {
    "1": "natural",
    "2": "insufficient JMA stations",
    "3": "artificial",
    "4": "eruption earthquake or other",
    "5": "low-frequency",
}

# Maximum intensity (column 62 of a hypocentre record).
MAX_SHINDO = {
    "1": "1", "2": "2", "3": "3", "4": "4",
    "5": "5 (until Sep 1996)", "6": "6 (until Sep 1996)",
    "7": "7",
    "A": "5-", "B": "5+", "C": "6-", "D": "6+",
    "R": "remarkable, felt >300 km (until 1977)",
    "M": "moderate, felt 200-300 km (until 1977)",
    "S": "small, felt 100-200 km (until 1977)",
    "L": "local, felt <100 km (until 1977)",
    "F": "felt (until 1984)",
    "X": "felt by some people, not JMA observers (until Sep 1996)",
}

# Intensity reported at a single station (column 19 of a station record).
STATION_SHINDO = {
    "1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7",
    "A": "5-", "B": "5+", "C": "6-", "D": "6+",
    "9": "felt, intensity unknown",
}

# Ordering of the numeric intensity codes for comparisons ("at least 5-").
# The pre-1996 5 and 6 sit at the bottom of their bands.
SHINDO_RANK = {
    "1": 10, "2": 20, "3": 30, "4": 40,
    "5": 50, "A": 50, "B": 55,
    "6": 60, "C": 60, "D": 65,
    "7": 70,
}

# Lower bound of instrumental intensity for each class (post-1996 scale).
# Used to cross-check station records.
INSTRUMENTAL_LOWER_BOUND = [
    (6.5, "7"), (6.0, "D"), (5.5, "C"), (5.0, "B"), (4.5, "A"),
    (3.5, "4"), (2.5, "3"), (1.5, "2"), (0.5, "1"),
]

DAMAGE_CLASS = {
    "1": "slight (cracks in walls and ground)",
    "2": "light (damage to houses, roads)",
    "3": "2-19 deaths or 2-999 houses destroyed",
    "4": "20-199 deaths or 1,000-9,999 houses destroyed",
    "5": "200-1,999 deaths or 10,000-99,999 houses destroyed",
    "6": "2,000-19,999 deaths or 100,000-999,999 houses destroyed",
    "7": "20,000+ deaths or 1,000,000+ houses destroyed",
    "X": "injury or damage of unclear scale (until 1988)",
    "Y": "included in the preceding or following event (until 1988)",
}

TSUNAMI_CLASS = {
    "1": "1923-1988: on tide gauge, no damage / 1989-: ~50 cm, none",
    "2": "~1 m, very slight damage",
    "3": "~2 m, slight coastal damage",
    "4": "4-6 m, injuries",
    "5": "10-20 m, damage along >400 km of coast",
    "6": "30 m+, damage along >500 km of coast",
    "T": "tsunami generated (1923-1988)",
}

HYPO_FLAG = {
    "K": "high precision (manual, closely examined)",
    "S": "low precision (manual, closely examined)",
    "k": "middle precision (manual)",
    "s": "low precision (manual)",
    "A": "middle precision (automatic)",
    "a": "low precision (automatic)",
    "N": "undetermined, not accepted or fixed",
    "F": "far field",
}

# The intensity file's column 96 adds these to HYPO_FLAG.
SHINDO_HEADER_FLAG = HYPO_FLAG | {
    "U": "USGS hypocentre",
    "I": "ISC hypocentre",
    "R": "preliminary hypocentre",
    "H": "exact observation time unknown",
    "D": "exact observation time unknown",
    "M": "exact observation time unknown",
}

SHINDO_RECORD_TYPE = {
    "A": "hypocentre",
    "B": "one of several spatio-temporally close events sharing intensity data",
    "D": "one of several temporally close events sharing intensity data",
}


def shindo_class_from_instrumental(value: float) -> str:
    for lower, cls in INSTRUMENTAL_LOWER_BOUND:
        if value >= lower:
            return cls
    return "0"
