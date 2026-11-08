// Cut Natural Earth 1:50m land (world-atlas) down to the polygons near the
// Japan box, so the page doesn't ship the whole world.
//   node scripts/coast.mjs  ->  public/data/coast.json (GeoJSON)
import { readFileSync, writeFileSync } from "node:fs";
import { feature } from "topojson-client";

const gr = JSON.parse(readFileSync(new URL("../public/data/gr.json", import.meta.url)));
const b = gr.box;
const PAD = 2; // degrees around the box, so coasts reach the edge before clipping
const topo = JSON.parse(readFileSync(new URL("../node_modules/world-atlas/land-50m.json", import.meta.url)));
const land = feature(topo, topo.objects.land);

const near = (ring) => ring.some(([lon, lat]) =>
  lon >= b.lon_min - PAD && lon <= b.lon_max + PAD && lat >= b.lat_min - PAD && lat <= b.lat_max + PAD);
const r3 = (x) => Math.round(x * 1000) / 1000;

const features = land.type === "FeatureCollection" ? land.features : [land];
const polygons = features
  .flatMap((f) => (f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates]))
  .filter((poly) => near(poly[0]))
  .map((poly) => poly.map((ring) => ring.map(([lon, lat]) => [r3(lon), r3(lat)])));

const out = { type: "Feature", properties: { source: "Natural Earth 1:50m land via world-atlas" },
  geometry: { type: "MultiPolygon", coordinates: polygons } };
const path = new URL("../public/data/coast.json", import.meta.url);
writeFileSync(path, JSON.stringify(out));
console.log(`${polygons.length} polygons, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
