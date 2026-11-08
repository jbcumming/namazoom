#!/usr/bin/env bash
# Build the self-hosted basemap: a Japan extract of the Protomaps (OpenStreetMap)
# planet build, plus the fonts and sprites its style needs.
#
#   scripts/basemap.sh assets          # fonts + sprites (from GitHub)
#   scripts/basemap.sh tiles [YYYYMMDD]  # Japan extract (default: newest daily build)
#   scripts/basemap.sh                 # both
#
# Output (served with the site, not committed):
#   public/tiles/japan.pmtiles
#   public/basemap-assets/{fonts,sprites}
# Map data © OpenStreetMap contributors (ODbL); fonts: SIL OFL (see fonts/OFL.txt).
set -euo pipefail
cd "$(dirname "$0")/.."

PMTILES=${PMTILES:-../tools/pmtiles}
BBOX=120,22,150,47   # a little wider than the 24-46N, 122-148E data box
MAXZOOM=11           # the app's maximum zoom; MapLibre over-zooms beyond it

assets() {
  local tmp
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  curl -fsSL -o "$tmp/assets.zip" https://codeload.github.com/protomaps/basemaps-assets/zip/refs/heads/main
  unzip -q "$tmp/assets.zip" -d "$tmp"
  rm -rf public/basemap-assets
  mkdir -p public/basemap-assets/sprites
  cp -r "$tmp"/basemaps-assets-main/fonts public/basemap-assets/fonts
  cp -r "$tmp"/basemaps-assets-main/sprites/v4 public/basemap-assets/sprites/v4
  du -sh public/basemap-assets
}

latest_build() {
  # Daily builds are named YYYYMMDD.pmtiles; take the newest that exists.
  for i in $(seq 0 14); do
    local d
    d=$(date -u -d "-$i day" +%Y%m%d)
    if curl -fsI "https://build.protomaps.com/$d.pmtiles" >/dev/null 2>&1; then echo "$d"; return; fi
  done
  echo "no Protomaps build found in the last 14 days" >&2
  return 1
}

tiles() {
  local d=${1:-$(latest_build)}
  mkdir -p public/tiles
  "$PMTILES" extract "https://build.protomaps.com/$d.pmtiles" public/tiles/japan.pmtiles \
    --bbox="$BBOX" --maxzoom="$MAXZOOM"
  echo "$d" > public/tiles/BUILD
  du -sh public/tiles/japan.pmtiles
}

case "${1:-all}" in
  assets) assets ;;
  tiles) tiles "${2:-}" ;;
  all) assets; tiles "${2:-}" ;;
  *) echo "usage: $0 [assets|tiles [YYYYMMDD]|all]" >&2; exit 2 ;;
esac
