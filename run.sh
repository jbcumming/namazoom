#!/usr/bin/env bash
# Build everything the site needs, then serve it locally.
#
#   ./run.sh            build what's missing, then serve on 0.0.0.0:4173
#   ./run.sh build      build only
#   ./run.sh serve      serve the existing build
#   ./run.sh live       build and serve, then rebuild every 24 h (new preliminary
#                       data and a new forecast) while serving; REFRESH_HOURS=24
#   REBUILD=1 ./run.sh  redo the pipeline steps even if their outputs exist
#   PRELIM=0 ./run.sh   don't download or refresh the preliminary recent data
#   FORECAST=0 ./run.sh don't rebuild the 7-day forecast
#
# Steps are skipped when their output already exists, so a second run only
# rebuilds the site itself. Downloads need network access to
# www.data.jma.go.jp, raw.githubusercontent.com, www.sciencebase.gov,
# build.protomaps.com and codeload.github.com.
set -euo pipefail
cd "$(dirname "$0")"

PORT=${PORT:-4173}
need() { [[ -n "${REBUILD:-}" || ! -e "$1" ]]; }
step() { printf '\n==> %s\n' "$*"; }

build() {
  step "Python environment"
  uv sync --quiet

  if need data/raw/h2024.zip; then
    step "Download JMA catalogue (data/raw)"
    uv run python -m pipeline.fetch
  fi
  if need data/interim/manifest.json; then
    step "Parse all years into Parquet (data/interim, ~3 min)"
    uv run python -m pipeline.build.ingest
  fi
  # Preliminary data after the last finalised year: refreshed on every build
  # (only new days and the last two weeks are downloaded). PRELIM=0 skips it.
  if [[ "${PRELIM:-1}" != 0 ]]; then
    step "Preliminary data since the finalised catalogue (JMA daily lists, intensity database)"
    uv run python -m pipeline.fetch_prelim || echo "preliminary download incomplete; continuing with what is cached"
    uv run python -m pipeline.build.prelim >/dev/null && echo "preliminary data ingested (data/interim/*/prelim.parquet)"
  fi
  if need data/interim/completeness.parquet; then
    step "Completeness"
    uv run python -m pipeline.build.completeness >/dev/null
  fi
  step "Check the dataset"
  uv run python -m pipeline.build.overview >/dev/null && echo "overview: all checks passed (data/interim/overview.txt)"

  if need data/raw/plates/PB2002_steps.json; then
    step "Download plate boundaries (PB2002)"
    mkdir -p data/raw/plates
    base=https://raw.githubusercontent.com/fraxen/tectonicplates/master
    curl -fsSL -o data/raw/plates/PB2002_steps.json "$base/GeoJSON/PB2002_steps.json"
    curl -fsSL -o data/raw/plates/LICENSE.md "$base/LICENSE.md"
  fi
  if need data/raw/slab2/kur_slab2_dep_02.24.18_contours.in; then
    step "Download USGS Slab2 and extract Japan contours"
    mkdir -p data/raw/slab2
    url=$(curl -fsSL "https://www.sciencebase.gov/catalog/item/5aa1b00ee4b0b1c392e86467?format=json" |
      python3 -c "import json,sys; print(next(f['url'] for f in json.load(sys.stdin)['files'] if f['name']=='Slab2Distribute_Mar2018.tar.gz'))")
    curl -fsSL -o data/raw/slab2/Slab2Distribute_Mar2018.tar.gz "$url"
    tar -xzf data/raw/slab2/Slab2Distribute_Mar2018.tar.gz -C data/raw/slab2 --strip-components=2 2>/dev/null \
      Slab2Distribute_Mar2018/Slab2_CONTOURS/kur_slab2_dep_02.24.18_contours.in \
      Slab2Distribute_Mar2018/Slab2_CONTOURS/izu_slab2_dep_02.24.18_contours.in \
      Slab2Distribute_Mar2018/Slab2_CONTOURS/ryu_slab2_dep_02.26.18_contours.in
  fi

  step "Site data (quakes, footprints, felt history, G-R counts, overlays)"
  uv run python -m pipeline.build.site_data
  uv run python -m pipeline.build.overlays
  if [[ "${FORECAST:-1}" != 0 ]]; then
    step "7-day forecast (ETAS; the first run fits the model, ~15 min)"
    uv run python -m pipeline.build.forecast >/dev/null && echo "forecast written (site/public/data/forecast.json; record in data/forecasts/issued.jsonl)"
  fi

  step "Front end"
  cd site
  [[ -d node_modules ]] || npm ci
  npm run --silent data
  if [[ ! -e public/tiles/japan.pmtiles || ! -d public/basemap-assets ]]; then
    if [[ ! -x ../tools/pmtiles ]]; then
      step "Download pmtiles tool"
      mkdir -p ../tools && tmp=$(mktemp -d)
      curl -fsSL -o "$tmp/p.tgz" https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Linux_x86_64.tar.gz
      tar -xzf "$tmp/p.tgz" -C "$tmp" && mv "$tmp/pmtiles" ../tools/pmtiles && rm -rf "$tmp"
    fi
    step "Basemap (Japan extract, ~200 MB)"
    scripts/basemap.sh
  fi
  npm test --silent
  npm run --silent build
  cd ..
  echo; echo "Built: site/dist ($(du -sh site/dist | cut -f1))"
}

serve() {
  step "Serving site/dist on http://0.0.0.0:$PORT"
  echo "From your machine: publish the port with"
  echo "  sbx ports ${SANDBOX_NAME:-<sandbox-name>} --publish $PORT:$PORT"
  echo "then open http://localhost:$PORT/"
  cd site && exec npx vite preview --host 0.0.0.0 --port "$PORT" --strictPort
}

# Serve, and rebuild in a separate process every REFRESH_HOURS (a failed rebuild
# leaves the previous build in place; vite rebuilds site/dist in a few seconds).
live() {
  build
  serve & local server=$!
  trap 'kill $server 2>/dev/null' EXIT
  while sleep "$(( ${REFRESH_HOURS:-24} * 3600 ))"; do
    step "Refresh $(date -u +%FT%TZ)"
    "$0" build || echo "refresh failed; still serving the previous build"
  done
}

case "${1:-all}" in
  build) build ;;
  serve) serve ;;
  live) live ;;
  all) build; serve ;;
  *) echo "usage: $0 [build|serve|live|all]" >&2; exit 2 ;;
esac
