# QuakeTracker

A static website visualising the Japan Meteorological Agency's historical
earthquake catalogue (地震月報 カタログ編), 1919 onwards.

**Status:** all JMA files (1919-2024) are parsed and checked, and preliminary
JMA data fills 2025 to two days ago; the map app runs locally (`./run.sh`).
Hosting and further analysis: see TODO.md.

Full pipeline:

```bash
uv run python -m pipeline.fetch                 # download everything listed on JMA's index pages
uv run python -m pipeline.fetch_prelim          # preliminary data after the last finalised year
uv run python -m pipeline.build.ingest          # -> data/interim/*.parquet (~3 min), incl. preliminary
uv run python -m pipeline.build.prelim          # re-ingest only the preliminary data (seconds)
uv run python -m pipeline.build.completeness    # Mc / b-value per 2°x2° cell per 5 years
uv run python -m pipeline.build.overview        # checks + data/interim/overview.txt
```

Phase 2 format findings (all handled, all tested in `tests/test_format_variants.py`):
- Numeric fields are read with blanks as zeros (Fortran BZ): `'  0 4'` = 0.04 km.
- Intensity files are EUC-JP from 2023 (Shift-JIS before); detected per file.
- 89,975 intensity headers are 'details unknown' (詳細不明): felt reports with
  no hypocentre; their position is the reporting station's. 135 more have
  unknown time. Both are kept with `located = false`.
- The link key leaves out column 62 (max shindo): the catalogue says 'F'
  (felt) for 1977-84 where the intensity file gives the number.
- 291 located felt events are not in the catalogue; 1 header is duplicated
  (i1976); 1 erratum applied (`pipeline/jma/errata.py`).
- A single national Mc per year misleads (b ≈ 0.5-0.7 from mixing dense land
  and sparse sea coverage); completeness is computed per region instead.
- The catalogue includes JMA-located distant events (Taiwan, Marianas, far
  field); views will need a spatial filter.

## Data sources

All from JMA's *Seismological Bulletin of Japan*
(<https://www.data.jma.go.jp/eqev/data/bulletin/index_e.html>):

| File | What | Format doc |
|---|---|---|
| `hypo/h{year}.zip` | Hypocentre catalogue, one 96-byte record per event. ASCII, LF. Some zips span several years (h1919 = 1919-50, h1951, h1961, h1967 = 1967-82) and 1997 is split (h199701, h199710). | `data/docs/hypfmt_e.html` |
| `shindo/i{year}.zip` | Seismic intensity: hypocentre headers each followed by per-station readings. Shift-JIS (cp932), CRLF. | `data/docs/shindo_format_e.txt` |
| `shindo/code_p.zip` | Intensity station list (TSV). UTF-8 in practice, although the docs say JIS. | same |

**Preliminary data.** The finalised bulletin arrives about two years late. For
the months since, `pipeline/fetch_prelim.py` downloads JMA's daily hypocentre
lists (震源リスト, `daily_map/YYYYMMDD.html`, up to two days ago, available from
2025-01-01) and, for felt quakes, the station intensities from the intensity
database (震度データベース, the JSON API behind its search page, up to
yesterday). `pipeline/build/prelim.py` writes them in the catalogue's schemas
(`*/prelim.parquet`, `source` starting `prelim:`), matching each felt quake to
its daily-list hypocentre by time (≤3 s) and position (≤0.3°). Only days after
the last finalised year are used, so publishing `h2025.zip` replaces 2025's
preliminary rows automatically. Limits: values are provisional; there is no
event class (natural / low-frequency / artificial), so the magnitude statistics
and the Slow slip tab leave these quakes out; readings have no instrumental
intensity or arrival time. The site marks these quakes "Preliminary" and
marks them on the timeline.

**Attribution.** JMA's terms of use (compatible with CC BY 4.0) ask for the
source to be named and linked, and for a note when the data has been processed.
The site does this in the header line (a footer on phones): "出典：気象庁ホームページ"
linked to <https://www.jma.go.jp/>, links to each dataset, and "Processed for
this site". The map's credits repeat "出典：気象庁 (processed)".

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

## Running the site

```bash
./run.sh          # build whatever is missing, then serve on http://0.0.0.0:4173
./run.sh build    # build only;  ./run.sh serve  serves the existing build
REBUILD=1 ./run.sh  # redo pipeline steps even if their outputs exist
PRELIM=0 ./run.sh   # skip refreshing the preliminary recent data
FORECAST=0 ./run.sh # skip rebuilding the 7-day forecast
```

A first run downloads the JMA catalogue (~185 MB), plate boundaries, USGS Slab2
(140 MB) and an OpenStreetMap basemap extract (~200 MB), parses everything
(~3 min) and builds `site/dist` (~325 MB, mostly the basemap). Later runs only
rebuild the site. Inside the sandbox, publish the port from the host with
`sbx ports <sandbox-name> --publish 4173:4173`. Hosting is not set up yet (see
TODO.md); the server must support HTTP range requests for the basemap file.

## Site

`site/` is a static, map-driven app (Vite + TypeScript, MapLibre GL, Observable
Plot). Everything shown is pre-built from the pipeline; the browser never loads
the catalogue as a whole.

**Map.** Quakes coloured by depth (0-40, 40-100, 100-200, 200-300, 300+ km),
sized by magnitude. M5+ for all years loads at start; M3-5 per year, drawn at
once for ranges of up to 10 years or year by year during playback. Smaller
quakes appear only in the magnitude counts. Timeline: year range, play/pause
(pause holds the frame), minimum magnitude, trail. Overlays: plate boundaries
(Bird 2003 PB2002, ODC-By; trenches heavier) and depth to the top of the sinking
plate (USGS Slab2, Hayes 2018), contoured at the quake colour boundaries.
Views are shareable: years, filter, tab, selected quake and map position are
kept in the URL hash.

**Tabs** (follow the visible map area and the timeline's years):
- *Magnitudes* - Gutenberg-Richter curves with Mc and b estimated in the browser
  (a port of the pipeline estimator, parity-tested against Python); era
  comparison as yearly rates.
- *Depth* - cross-section along a drawn line or preset, with the Slab2 plate top
  and trench crossings; true scale where it fits.
- *Quake* - the selected quake: details; shindo footprint (stations coloured
  by intensity, intensity vs distance, strongest readings); replay of the
  shaking at recorded station times beside model P/S wave fronts; aftershocks
  for M5.5+ (window from Wells & Coppersmith rupture length, Omori p fit,
  Båth's law, foreshocks).
- *My location* - quakes felt near a point (city presets, map pick or browser
  location): per year by strongest nearby intensity, stations operating
  nearby, strongest shakings, their epicentres on the map.
- *History* - energy released per year and its concentration in a few great
  quakes; destructive quakes (damage class 3+ or damaging tsunami), ringed on
  the map.
- *Shaking* - hotspots of felt shaking: each station's yearly rate at a chosen
  intensity (shindo 1+ to 5-+), averaged on a 0.2° grid so dense networks don't
  look hotter; temporary (臨時) stations left out.
- *Slow slip* - the 182k low-frequency earthquakes (event class 5): the Nankai
  tremor belt and volcanic clusters on the map, weekly counts split by
  detection method (template matching from 2018 multiplies the counts), and a
  space-time density plot along the belt where episodic tremor-and-slip bursts
  show as streaks.
- *Forecast* - the chance of M5+/M6+/M7+ quakes in the 7 days after the data
  ends, for the visible area and per half-degree square on the map, against the
  long-term average; and how the same method did on every week since 2016
  (see below). Ignores the timeline.

**Forecast.** `pipeline/forecast/etas.py` is a space-time ETAS model (Ogata
1988, 1998; background by stochastic declustering, Zhuang, Ogata & Vere-Jones
2002) fitted by maximum likelihood to M4+ quakes no deeper than 100 km in the
Japan box (JMA natural classes plus the preliminary data), with each quake's
influence cut off after 3 years and beyond ~3 rupture lengths. Within-week
cascades are added as an average factor from the realised branching ratio.
`pipeline/build/forecast.py` caches two fits in `data/interim/forecast/`
(2000-2015 for the test; 2000 to the end of the finalised catalogue for the
live forecast; ~6 min each), then:
- *test (pseudo-prospective)*: each week from 2016 forecast from the quakes
  before it with the 2000-2015 fit, scored against the M5+ quakes that followed
  on a 0.5° grid, alongside the long-term average 2000-2015. Results at the
  time of writing: information gain 0.98 per M5+ quake; the top 1% of
  square-weeks held 34% of M5+ quakes (long-term average: 15%); in total 1,327
  forecast vs 1,070 observed (average: 1,601). The within-week cascade factor
  was changed after a first run of this test (it used the theoretical branching
  ratio, which ran 41% high), which the site says.
- *prospective record*: each build appends the forecast it shows to
  `data/forecasts/issued.jsonl` (not committed, like the rest of `data/`) and
  scores entries once the data covers their week.

Shindo colours run yellow (1) to purple (7): a multi-hue scale with evenly
falling lightness, validated separately for light and dark mode.

**Data notes.** Footprints use only readings attributable to one quake (type
B/D groups share readings). Station 5399999, the 1995 Kobe shindo-7 survey
area, has no position (recorded as 0,0) and is shown as an area-wide note.
My location uses every reading, including felt reports without a located
hypocentre.

**Build pieces:** `pipeline/build/site_data.py` (quakes, footprints, felt
history, G-R counts), `pipeline/build/overlays.py` (plates, slabs),
`site/scripts/coast.mjs` (fallback coastline), `site/scripts/basemap.sh`
(Protomaps extract + fonts/sprites), `site/scripts/screenshots.mjs` (headless
checks). Event selection for every view: `pipeline/selection.py`.

Raw overlay inputs live in `data/raw/plates/` and `data/raw/slab2/`.

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
pipeline/selection.py      which events the site shows (one definition)
pipeline/forecast/etas.py  ETAS model: likelihood, fit, background, grid forecasts, simulation
pipeline/build/            ingest, completeness, overview, site_data, overlays, prelim, forecast
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
