# QuakeTracker

A static website visualising the Japan Meteorological Agency's historical
earthquake catalogue (地震月報 カタログ編), 1919 onwards.

**Status: phase 1.** Parsers for the JMA files, validated against the 2019
sample. No site yet.

## Data sources

All from JMA's *Seismological Bulletin of Japan*
(<https://www.data.jma.go.jp/eqev/data/bulletin/index_e.html>):

| File | What | Format doc |
|---|---|---|
| `hypo/h{year}.zip` | Hypocentre catalogue, one 96-byte record per event. ASCII, LF. Some zips span several years (h1919 = 1919-50, h1951, h1961, h1967 = 1967-82) and 1997 is split (h199701, h199710). | `data/docs/hypfmt_e.html` |
| `shindo/i{year}.zip` | Seismic intensity: hypocentre headers each followed by per-station readings. Shift-JIS (cp932), CRLF. | `data/docs/shindo_format_e.txt` |
| `shindo/code_p.zip` | Intensity station list (TSV). UTF-8 in practice, although the docs say JIS. | same |

Downloads go to `data/raw/` (not committed). For phase 1 that holds
`h2019.zip`, `i2019.zip` and `code_p.zip`:

```bash
B=https://www.data.jma.go.jp/eqev/data/bulletin/data
curl -o data/raw/h2019.zip  $B/hypo/h2019.zip
curl -o data/raw/i2019.zip  $B/shindo/i2019.zip
curl -o data/raw/code_p.zip $B/shindo/code_p.zip
```

## Usage

```bash
uv sync
uv run pytest                      # unit tests + full 2019 checks (skipped if data/raw is empty)
uv run python -m pipeline.summary data/raw/h2019.zip data/raw/i2019.zip data/raw/code_p.zip
```

## Layout

```
pipeline/jma/fields.py     fixed-width decoders (implied decimals, JMA negative magnitudes, ...)
pipeline/jma/codes.py      code tables transcribed from the JMA docs
pipeline/jma/hypo.py       hypocentre file -> Hypocentre
pipeline/jma/shindo.py     intensity file -> ShindoGroup(headers, observations)
pipeline/jma/stations.py   station list -> Station
pipeline/jma/link.py       link intensity events to catalogue events; view selection rules
pipeline/known_quakes.py   independently documented quakes for sanity checks
pipeline/summary.py        sanity-check report for one year
tests/                     pytest; fixtures/ holds real records cut from the 2019 files
```

## Format notes (verified on the 2019 files)

- Columns are the 1-indexed positions from the JMA docs. Records are sliced
  as bytes: Shift-JIS region names would shift character offsets.
- Columns 2-68 are identical between a catalogue record and the matching
  intensity header, so events are linked on those bytes (all 1,580 in 2019).
  A nearest-match fallback (≤2 s, ≤0.1°) exists for other years.
- Origin time alone is not unique (7 collisions in 2019). Event IDs are
  `{agency}{JST time to 0.01 s}_{lat×100}_{lon×100}`.
- Depth is F5.2 for depth-free/matched-filter solutions and I3,2X (whole km)
  for depth-slice, fixed-depth and USGS records.
- Negative magnitudes: `-1` = −0.1, `A0` = −1.0, `B0` = −2.0, `C0` = −3.0.
- Station readings carry only day/hour/minute, so the year and month come from
  the event, rolling over at month end.
- Instrumental intensity is in tenths (`05` = 0.5); in 2019 every reading's
  class agrees with it.
- In type B/D intensity groups (several close events with inseparable
  readings), JMA gives the max shindo to the first event only. The readings
  belong to that event; later events in the group are flagged as sharing them.
- Times are JST as published; `origin_utc` is derived (−9 h).

## Decisions

- **Magnitude:** JMA's own (magnitude 1) everywhere, including the
  Gutenberg–Richter plot. Mw (magnitude 2, type `W`) is shown in event detail
  only. The current files use the post-2003 magnitude throughout.
- **USGS / other-agency hypocentres:** stored; shown only if the event has
  intensity readings in Japan.
- **Artificial events:** stored, never shown. **Low-frequency events:** shown,
  with a UI toggle.
- **Detection bias:** nothing is filtered at parse time. Location method,
  precision flag and magnitude type are kept on every event, so completeness
  can be estimated and shown, not hidden.
- `data/raw/` is not committed.
