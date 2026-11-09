# TODO

Current priority: the site runs locally with `./run.sh`; hosting comes later.
New features below wait until that's settled.

## Site
- [x] Update README for the map app features.
- [x] One-command build and local serve (`./run.sh`).
- [ ] Choose hosting (deferred). First option to check: Fastmail's static
      website hosting (Files): storage quota on the plan, per-file size limit,
      and whether it serves HTTP range requests (needed for the basemap).
      The PMTiles basemap is 199 MB, over the per-file limits of GitHub Pages
      (100 MB) and Cloudflare Pages / Netlify (25 MB). Fallbacks: object
      storage with range requests (Cloudflare R2, S3) for the tiles, or a
      smaller extract (lower max zoom).
- [ ] Deploy and check in a real browser (desktop and phone), including
      gzip/brotli on the JSON and range requests on the tiles.

## Analysis features (agreed, not started)
- [x] **"Could this have been a foreshock?" panel** for a selected large quake
      (Quake tab, `pipeline/build/foreshock.py`). Not done: the ETAS chance of a
      larger quake per event.
      Original spec:
      magnitude gap to its largest follower so far vs Båth's law (~1.2), and
      how often past Japanese sequences with a similar gap produced a larger
      quake. Base rates from data before the quake only (out-of-sample).
      Framed as context, never as a prediction.
      Cases to show: Tōhoku 2011 (M7.3 → M9.0 51 h later, 44 km; gap 0.5),
      Kumamoto 2016 (M6.5 → M7.3 28 h later, 5 km; gap 0.1).
- [ ] **Clustering tab**
  - [ ] Base rates: after a quake of a given size/region, how often a larger one
        followed within days, *with aftershock sequences separated out*
        (declustering). Sanity check against the ~5% literature figure; the
        raw, undeclustered numbers (24–33%) are inflated by ongoing sequences.
  - [ ] Swarm catalogue: detect swarms (clusters without a dominant mainshock),
        map them and show how each ended (e.g. Matsushiro 1965–67 fizzled,
        Noto 2020–23 preceded the 2024 M7.6).
  - [ ] b-value and Mc over time for a selected area, with completeness shown
        alongside so detection changes (2016 automatic/matched-filter jump,
        regional Mc) aren't read as physics.
- [x] ETAS (Ogata 1988) 7-day forecast, Forecast tab, with a pseudo-prospective
      test from 2016 and a prospective record (`data/forecasts/issued.jsonl`).
  - [x] Further tests (`scripts/forecast_tests.py`): simpler rules, forecast
        length, data delay. Daily reissue (`./run.sh live`) and the record
        committed as a result.
  - [ ] Possible improvements: simulation-based forecasts (proper spread of
        counts instead of Poisson), a magnitude-dependent depth limit, and a
        background that down-weights swarms.
  - [x] Fresher data: felt quakes from JMA's live earthquake information after
        the intensity database's last day, so the forecast starts at the hour of
        the build. `./run.sh live` commits the forecast record after each build.

## Data
- [x] Fill 2025 → present from JMA's daily hypocentre lists / 震度データベース
      (marked "Preliminary"; refreshed by `./run.sh`).
- [ ] When JMA publishes h2025/i2025: re-run `pipeline.fetch` + ingest; the
      preliminary 2025 rows drop out by themselves. The daily lists only go back
      to 2025-01-01 on JMA's site, so keep `data/raw/prelim` until then.
- [ ] Cross-check against USGS.
- [ ] Onland active faults (AIST Active Fault Database or GSI): needs network
      approval for gbank.gsj.jp / www.gsi.go.jp and a check of redistribution terms.

## Done since this list was written
- [x] Shaking hotspots tab (felt rate per station, gridded average).
- [x] Slow slip tab (low-frequency earthquakes, episodic tremor and slip).
- [x] Hover/click on felt-quake epicentres in My location.

## More ideas discussed
- [ ] Seismic quiescence / gaps: areas unusually quiet compared with their own
      past (needs a careful false-alarm discussion).
- [x] Recurrence along the trenches (Kuril, Japan Trench, Sagami, Nankai east/west):
      timeline since 684 and HERP's 30-year chances, in the Forecast tab
      (`site/src/trench-history.ts`, sources in `docs/references.md`).
  - [ ] Update the chances each January (HERP recalculates for 1 Jan).
- [ ] Slow slip burst intervals per segment over time (Slow slip tab): detect
      ETS episodes per tremor segment (western Shikoku, Kii, Tōkai), chart the
      interval between bursts and their along-dip/along-strike position, and flag
      changes (shortening intervals, up-dip migration, merging or quiet segments).
      Descriptive only: no great Nankai quake since 1946, so it can't be
      validated as a precursor. Mind the 2018 matched-filter jump when
      detecting episodes (threshold per method or per era).

## Smaller ideas
- [ ] Density heatmap of quakes below M3 (currently only in the Magnitudes counts).
- [ ] M3–5 for ranges over 10 years outside playback (binary format or tiling).
- [x] Verify literature figures quoted in conversation: all confirmed against
      HERP, JMA and Cabinet Office documents (`docs/references.md`). Corrections:
      the Japan/Kuril Trench advisory was issued twice (9 Dec 2025 and 20 Apr
      2026), not once.
  - [ ] USGS "~5% followed by a larger quake within a week": needs
        earthquake.usgs.gov allowed. Not used on the site.
