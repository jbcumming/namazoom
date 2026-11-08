# TODO

Current priority: get the site running end to end (build, host, deploy). New
features below wait until that's done.

## Site: get it working
- [ ] Update README for everything added since the map app (footprint, depth
      section, my location, aftershocks, replay, history, links, colours).
- [ ] Choose hosting. The PMTiles basemap is 199 MB, over per-file limits of
      GitHub Pages (100 MB) and Cloudflare Pages / Netlify (25 MB), so it
      needs object storage that supports HTTP range requests (e.g. Cloudflare
      R2, S3) or a smaller extract (lower max zoom).
- [ ] One-command build: pipeline -> site data -> overlays -> basemap -> `npm run build`.
- [ ] Deploy and check in a real browser (desktop and phone), including
      gzip/brotli on the JSON and range requests on the tiles.

## Analysis features (agreed, not started)
- [ ] **"Could this have been a foreshock?" panel** for a selected large quake:
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
- [ ] Optional: ETAS (Ogata 1988) short-term forecast, tested prospectively.

## Data
- [ ] Fill 2025 → present from JMA's daily hypocentre lists / 震度データベース.
- [ ] Cross-check against USGS.
- [ ] Onland active faults (AIST Active Fault Database or GSI): needs network
      approval for gbank.gsj.jp / www.gsi.go.jp and a check of redistribution terms.

## Smaller ideas
- [ ] Density heatmap of quakes below M3 (currently only in the Magnitudes counts).
- [ ] M3–5 for ranges over 10 years outside playback (binary format or tiling).
- [ ] Verify literature figures quoted in conversation (Nankai advisory
      probability, foreshock base rates) before citing them on the site.
