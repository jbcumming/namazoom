// Basemap style. Uses the self-hosted Protomaps extract (public/tiles/japan.pmtiles,
// built by scripts/basemap.sh) when it is present; otherwise falls back to the
// Natural Earth coastline so the app still works without it.
import { layers, namedFlavor } from "@protomaps/basemaps";
import { addProtocol, type StyleSpecification } from "maplibre-gl";
import { Protocol } from "pmtiles";

const abs = (p: string) => new URL(p, location.href).href;
let protocolAdded = false;

async function exists(path: string): Promise<boolean> {
  try {
    const r = await fetch(path, { method: "HEAD" });
    return r.ok && (r.headers.get("content-type") ?? "").indexOf("text/html") === -1;
  } catch {
    return false;
  }
}

/** Sea and land in the app's own pale tones (style.css), lighter than the stock flavours. */
function seaAndLand() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return { water: v("--map-sea"), earth: v("--map-land"), background: v("--map-land") };
}

export async function basemapStyle(dark: boolean): Promise<{ style: StyleSpecification; tiles: boolean }> {
  // Neutral flavours, so the quakes' blue depth colours are the only strong colour on the map.
  const flavor = dark ? "dark" : "grayscale";
  if (await exists("./tiles/japan.pmtiles")) {
    if (!protocolAdded) {
      addProtocol("pmtiles", new Protocol().tile);
      protocolAdded = true;
    }
    return {
      tiles: true,
      style: {
        version: 8,
        // Append the template as text: new URL() would percent-encode the {placeholders}.
        glyphs: `${abs("./basemap-assets/fonts/")}{fontstack}/{range}.pbf`,
        sprite: abs(`./basemap-assets/sprites/v4/${flavor}`),
        sources: {
          protomaps: {
            type: "vector",
            url: `pmtiles://${abs("./tiles/japan.pmtiles")}`,
            attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://protomaps.com">Protomaps</a>',
          },
        },
        layers: layers("protomaps", { ...namedFlavor(flavor), ...seaAndLand() }, { lang: "en" }),
      },
    };
  }
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    tiles: false,
    style: {
      version: 8,
      sources: {
        coast: { type: "geojson", data: abs("./data/coast.json"), attribution: "Natural Earth" },
      },
      layers: [
        { id: "sea", type: "background", paint: { "background-color": v("--map-sea") } },
        { id: "land", type: "fill", source: "coast", paint: { "fill-color": v("--map-land") } },
        { id: "coast", type: "line", source: "coast", paint: { "line-color": v("--map-coast"), "line-width": 0.6 } },
      ],
    },
  };
}
