import { Map as MLMap, NavigationControl, setWorkerUrl, type ExpressionSpecification, type FilterSpecification, type GeoJSONSource } from "maplibre-gl";
// MapLibre finds its worker relative to its own file, which bundling breaks;
// let Vite bundle the worker and hand MapLibre the resulting URL.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { basemapStyle } from "./basemap";
import type { GrData } from "./gr";
import { cellsInBounds, howOftenSection } from "./how-often";
import { renderQuake, type Footprint } from "./panel-quake";
import { renderAftershocks, type AftershockState } from "./panel-aftershocks";
import { renderForeshock, type ForeshockState } from "./panel-foreshock";
import type { Quake3D, Scene3D } from "./view3d";
import type { FsData } from "./foreshock";
import { DAY, FORESHOCK_DAYS, MIN_MAINSHOCK, WINDOW_DAYS, sequence, type Shock } from "./aftershocks";
import { PLACES, type Place } from "./panel-location";
import { destructiveList } from "./destructive";
import { HOT_STEPS, fmtRate, hotColors, renderShaking, scaleRange } from "./panel-shaking";
import { fcColors, renderForecast } from "./panel-forecast";
import { P_EDGES, chance, fmtPct, fmtWindow, pClass, sumCells, type Forecast } from "./forecast";
import { CELL_DEG, grid, LEVELS, logClass, stationRates, type Cell, type StationCounts } from "./hotspots";
import { formatHash, parseHash, yearFromId } from "./urlstate";
import { LocationStore, type FeltQuake, type NearbyStation } from "./location";
import { Marker } from "maplibre-gl";
import { CLASSES, classOf, shindoColors, shindoFeel, ShindoStore } from "./shindo";
import { FAMOUS, famous, quakePlace, regionLabel } from "./names";
import { MAX_YEARS_FOR_M3, QuakeStore, fmtDate, yearEnd, yearOf, yearStart, yearsNeeded, type QuakeProps } from "./quakes";
import { $, DEPTH_EDGES, DEPTH_LABELS, el, fmt, hideTooltip, isDark, showTooltip, theme } from "./ui";

// ---------------------------------------------------------------- state ---

const state = {
  from: 1919,
  to: 2024,
  minMag: 5,
  trail: 365 * 86400, // seconds of history shown behind the playhead
  playing: false, // animation running
  anim: false, // in playback view (playing or paused on a frame)
  playhead: 0, // seconds, UTC
  tab: "quake",
  view3d: false, // the Quakes tab shows the 3D view instead of the map
  dmgOpen: false, // the Quakes tab's Destructive quakes list is open (rings on the map)
  howOpen: false, // the Quakes tab's How often table is open
  selected: null as { props: QuakeProps; coords: [number, number] } | null,
};

const narrow = () => matchMedia("(max-width: 760px)").matches; // phone layout: panel under the map

const store = new QuakeStore();
const [grData] = await Promise.all([fetch("./data/gr.json").then((r) => r.json() as Promise<GrData>), store.init()]);
[state.from, state.to] = store.index.years;
// A shared link may set the view; applied before the first render.
const fromUrl = parseHash(location.hash, ["quake", "shaking", "forecast"], store.index.years);
if (fromUrl.from !== undefined) { state.from = fromUrl.from; state.to = fromUrl.to!; }
if (fromUrl.minMag !== undefined) state.minMag = fromUrl.minMag;

// ------------------------------------------------------------------ map ---

setWorkerUrl(maplibreWorkerUrl);

const box = grData.box;
const JMA_HOME = "https://www.jma.go.jp/";
const JMA_BULLETIN = "https://www.data.jma.go.jp/eqev/data/bulletin/index_e.html";
const JMA_DAILY = "https://www.data.jma.go.jp/eqev/data/daily_map/index.html";
const JMA_EQDB = "https://www.data.jma.go.jp/eqdb/data/shindo/";
const JMA_LIVE = "https://www.jma.go.jp/bosai/map.html#contents=earthquake_map";
const { style, tiles } = await basemapStyle(isDark());
const map = new MLMap({
  container: "map",
  style,
  bounds: [[box.lon_min, box.lat_min], [box.lon_max, box.lat_max]],
  fitBoundsOptions: { padding: 20 },
  minZoom: 3,
  maxZoom: 11,
  attributionControl: {
    compact: true,
    customAttribution: `<a href="${JMA_HOME}" target="_blank" rel="noopener">出典：気象庁</a> (processed)`,
  },
  dragRotate: false,
  pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();
(window as unknown as { quakeMap: MLMap }).quakeMap = map; // used by scripts/screenshots.mjs
map.addControl(new NavigationControl({ showCompass: false }), "top-left");
if (!tiles) $("basemap-note").hidden = false;


function depthStep(input: ExpressionSpecification): ExpressionSpecification {
  const d = theme().depth;
  return ["step", input, d[0], DEPTH_EDGES[0], d[1], DEPTH_EDGES[1], d[2], DEPTH_EDGES[2], d[3], DEPTH_EDGES[3], d[4]];
}

function depthColor(): ExpressionSpecification {
  return ["case", ["==", ["get", "depth"], null], theme().noDepth, depthStep(["get", "depth"])];
}

// Area roughly proportional to released energy would swamp the map; this
// grows ~1.6x per magnitude unit, and with zoom.
const baseRadius: ExpressionSpecification = ["interpolate", ["exponential", 1.6], ["coalesce", ["get", "mag"], 3],
  3, 1.1, 5, 2.4, 7, 6, 9, 15];
// zoom may only appear in a top-level interpolate, so any offset goes inside the stops.
const radiusPlus = (extra: number): ExpressionSpecification =>
  ["interpolate", ["linear"], ["zoom"], 4, ["+", baseRadius, extra], 6, ["+", ["*", 1.7, baseRadius], extra],
    9, ["+", ["*", 3, baseRadius], extra]];
const radius = radiusPlus(0);

/** First basemap label layer: our layers go beneath it so place names stay readable. */
const beforeLabels = () => map.getStyle().layers.find((l) => l.type === "symbol")?.id;

function addQuakeLayers() {
  if (map.getSource("quakes")) return; // overlapping theme switches can queue this twice
  const before = beforeLabels();
  addSlabLayers(before);
  map.addSource("quakes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "quakes", type: "circle", source: "quakes",
    paint: {
      "circle-radius": radius,
      "circle-color": depthColor(),
      "circle-opacity": 0.7,
      "circle-stroke-color": theme().surface,
      "circle-stroke-width": 0.6,
      "circle-stroke-opacity": 0.8,
    },
    layout: { "circle-sort-key": ["coalesce", ["get", "mag"], 0] },
  }, before);
  addPlateLayers(before);
  addWavefrontLayer();
  addFootprintLayer();
  addLocationLayers();
  addHotspotLayer();
  addTremorLayer(before);
  addForecastLayer();
  addZoneLayers();
  // Rings round destructive quakes (damage class 3+ or a damaging tsunami), while their list is open.
  map.addLayer({
    id: "destructive", type: "circle", source: "quakes",
    filter: ["any", ["in", ["get", "dmg"], ["literal", ["3", "4", "5", "6", "7"]]],
      ["in", ["get", "tsu"], ["literal", ["2", "3", "4", "5", "6", "T"]]]],
    layout: { visibility: destructiveShown() ? "visible" : "none" },
    paint: { "circle-radius": radiusPlus(3), "circle-color": "transparent", "circle-stroke-color": theme().text, "circle-stroke-width": 1.5 },
  });
  map.addLayer({
    id: "selected", type: "circle", source: "quakes", filter: ["==", ["get", "id"], ""],
    paint: { "circle-radius": radiusPlus(4), "circle-color": "transparent", "circle-stroke-color": theme().text, "circle-stroke-width": 2 },
  });
  if (state.selected) map.setFilter("selected", ["==", ["get", "id"], state.selected.props.id]);
  refreshData();
  showFootprint(); // after a style change the source starts empty
  drawLocation();
  drawHotspots();
  drawForecast();
}

const fitJapan = () => map.fitBounds([[box.lon_min, box.lat_min], [box.lon_max, box.lat_max]], { padding: 20, duration: 0 });
map.on("load", () => {
  // The container may have been sized before the panel layout settled.
  map.resize();
  // Compact attribution opens expanded; on a phone it covers the legend button, and the
  // full credit is in the About box anyway. It stays one tap away behind its (i) button.
  if (narrow()) document.querySelector(".maplibregl-compact-show")?.classList.remove("maplibregl-compact-show");
  if (fromUrl.view) map.jumpTo({ center: [fromUrl.view.lon, fromUrl.view.lat], zoom: fromUrl.view.zoom });
  else fitJapan();
  addQuakeLayers();
  if (fromUrl.quake) restoreQuake(fromUrl.quake);
});

/** Select a quake by catalogue id: find it in its year's data. A shared link keeps the tab it
 * was on (the selection chip shows above it); a quick pick opens the Quakes tab. */
async function findQuake(id: string) {
  const y = yearFromId(id);
  if (!Number.isFinite(y)) return null;
  await store.ensureYears([y]);
  return store.features(yearStart(y), yearEnd(y), 3).features.find((x) => x.properties.id === id) ?? null;
}

/** Set when a link names a quake the map data doesn't have (shown on the Quakes tab). */
let missingQuake: string | null = null;

async function restoreQuake(id: string, openTab = false) {
  const f = await findQuake(id);
  if (f) { missingQuake = null; select({ props: f.properties, coords: f.geometry.coordinates as [number, number] }, openTab); return; }
  missingQuake = id;
  if (state.selected) select(null);
  setTab("quake");
}

/** Buttons that open well-known quakes (Quakes tab empty state). */
function quakeExamples(): HTMLElement {
  const row = el("div", "presets");
  for (const short of ["Kantō 1923", "Kobe 1995", "Tōhoku 2011", "Kumamoto 2016", "Noto 2024"]) {
    const f = FAMOUS.find((x) => x.short === short)!;
    const b = el("button", "", short) as HTMLButtonElement;
    b.type = "button"; b.title = f.name;
    b.addEventListener("click", () => restoreQuake(f.id, true));
    row.append(b);
  }
  return row;
}

/** First-visit orientation at the top of the opening tab; dismissed for good with "Hide". */
function renderIntro() {
  const host = $("intro-host");
  let hidden = false;
  try { hidden = localStorage.getItem("intro-hidden") === "1"; } catch { /* storage blocked: show it */ }
  if (hidden) { host.replaceChildren(); return; }
  const card = el("div", "intro");
  const head = el("div", "intro-head");
  const close = el("button", "intro-close", "Hide") as HTMLButtonElement;
  close.type = "button";
  close.addEventListener("click", () => {
    try { localStorage.setItem("intro-hidden", "1"); } catch { /* fine: hidden for this visit */ }
    host.replaceChildren();
  });
  head.append(el("h2", "", "Start here"), close);
  card.append(head, el("p", "",
    "Each dot is an earthquake recorded by the Japan Meteorological Agency: its colour shows how deep it " +
    "was, its size the magnitude. Drag the timeline below to choose years, press ▶ to watch them unfold, and click " +
    "any dot to open it here. Some places to start:"));
  const row = el("div", "presets");
  const btn = (text: string, fn: () => void) => {
    const b = el("button", "", text) as HTMLButtonElement;
    b.type = "button"; b.addEventListener("click", fn); row.append(b);
  };
  btn("Japan's plates in 3D", () => setView3d(true));
  btn("How often has Tokyo shaken?", () => { setTab("shaking"); setPlace(PLACES[0]); map.flyTo({ center: PLACES[0].lonlat, zoom: 7 }); });
  btn("This week's forecast", () => setTab("forecast"));
  btn("Destructive quakes", () => {
    state.dmgOpen = true; renderPanel(); syncDestructive();
    document.querySelector("#pane-quake .dmg")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  card.append(row);
  host.replaceChildren(card);
}

let urlTimer = 0;
function updateUrl() {
  clearTimeout(urlTimer);
  urlTimer = window.setTimeout(() => {
    const c = map.getCenter();
    const [y0, y1] = store.index.years;
    const hash = formatHash({
      ...(state.from !== y0 || state.to !== y1 ? { from: state.from, to: state.to } : {}),
      ...(state.minMag !== 5 ? { minMag: state.minMag } : {}),
      ...(state.tab !== "quake" ? { tab: state.tab } : {}),
      ...(in3d() ? { view3d: true } : {}),
      ...(state.selected ? { quake: state.selected.props.id } : {}),
      view: { lat: c.lat, lon: c.lng, zoom: map.getZoom() },
    });
    if (hash !== location.hash) history.replaceState(null, "", hash);
  }, 300);
}
map.on("moveend", updateUrl);

// ------------------------------------------------------------- overlays ---

const overlays = { plates: true, slabs: true, tremor: false };
const OVERLAY_LAYERS: Record<keyof typeof overlays, string[]> = {
  plates: ["plates-other", "plates-sub", "plates-hit"],
  slabs: ["slabs", "slabs-label", "slabs-hit"],
  tremor: ["tremor"],
};
const vis = (name: keyof typeof overlays) => (overlays[name] ? "visible" : "none") as "visible" | "none";

/** Slab2 depth contours: top of the subducting plate, coloured like the quakes at that depth. */
function addSlabLayers(before?: string) {
  map.addSource("slabs", {
    type: "geojson", data: "./data/overlays/slabs.json",
    attribution: "Slab depths: USGS Slab2 (Hayes 2018)",
  });
  map.addLayer({
    id: "slabs", type: "line", source: "slabs",
    layout: { visibility: vis("slabs"), "line-join": "round" },
    paint: { "line-color": depthStep(["get", "depth"]), "line-width": 1.4, "line-opacity": 0.9 },
  }, before);
  map.addLayer({
    id: "slabs-hit", type: "line", source: "slabs", layout: { visibility: vis("slabs") },
    paint: { "line-color": "#000", "line-opacity": 0, "line-width": 10 },
  }, before);
  if (tiles) { // labels need the basemap's fonts
    map.addLayer({
      id: "slabs-label", type: "symbol", source: "slabs",
      layout: {
        visibility: vis("slabs"), "symbol-placement": "line", "symbol-spacing": 280,
        "text-field": ["concat", ["to-string", ["get", "depth"]], " km"],
        "text-font": ["Noto Sans Regular"], "text-size": 11,
      },
      paint: { "text-color": theme().secondary, "text-halo-color": theme().surface, "text-halo-width": 1.5 },
    });
  }
}

function addPlateLayers(before?: string) {
  const t = theme();
  map.addSource("plates", {
    type: "geojson", data: "./data/overlays/plates.json",
    attribution: "Plate boundaries: Bird (2003) PB2002, ODC-By",
  });
  map.addLayer({
    id: "plates-other", type: "line", source: "plates", filter: ["!=", ["get", "kind"], "subduction"],
    layout: { visibility: vis("plates"), "line-cap": "round" },
    paint: { "line-color": t.text, "line-opacity": 0.45, "line-width": 1, "line-dasharray": [3, 2] },
  }, before);
  map.addLayer({
    id: "plates-sub", type: "line", source: "plates", filter: ["==", ["get", "kind"], "subduction"],
    layout: { visibility: vis("plates"), "line-cap": "round", "line-join": "round" },
    paint: { "line-color": t.text, "line-opacity": 0.8, "line-width": 2.2 },
  }, before);
  // Wide invisible line so the thin boundaries are easy to hover.
  map.addLayer({
    id: "plates-hit", type: "line", source: "plates", layout: { visibility: vis("plates") },
    paint: { "line-color": "#000", "line-opacity": 0, "line-width": 12 },
  }, before);
}

function setOverlay(name: keyof typeof overlays, on: boolean) {
  overlays[name] = on;
  for (const id of OVERLAY_LAYERS[name]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis(name));
  }
  if (name === "tremor") { if (on) loadTremor(); return; } // map only, not in 3D
  if (in3d()) draw3d();
}

const KIND_LABEL: Record<string, string> = {
  subduction: "Subduction zone (trench)", convergent: "Convergent boundary", transform: "Transform boundary",
  spreading: "Spreading ridge", rift: "Rift",
};
const overQuake = (p: { x: number; y: number }) => map.queryRenderedFeatures([p.x, p.y], { layers: ["quakes"] }).length > 0;
map.on("mousemove", "plates-hit", (e) => {
  if (overQuake(e.point) || overTremor(e.point)) return; // quakes and tremor win
  const f = e.features?.[0];
  if (!f) return;
  const p = f.properties as { kind: string; label: string };
  showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, (tip) => {
    tip.append(el("div", "t-head", KIND_LABEL[p.kind] ?? "Plate boundary"));
    tip.append(el("div", "", p.label));
  });
});
map.on("mouseleave", "plates-hit", hideTooltip);
map.on("mousemove", "slabs-hit", (e) => {
  if (overQuake(e.point) || overTremor(e.point) || map.queryRenderedFeatures([e.point.x, e.point.y], { layers: ["plates-hit"] }).length) return;
  const f = e.features?.[0];
  if (!f) return;
  const p = f.properties as { depth: number; plate: string };
  showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, (tip) => {
    tip.append(el("div", "t-head", "Slab depth contour"));
    tip.append(el("div", "", `Top of the ${p.plate} is ${p.depth} km down here`));
  });
});
map.on("mouseleave", "slabs-hit", hideTooltip);

/** True when an epicentre of a quake felt at the Shaking tab's place is under the pointer: it takes priority over the dimmed quakes. */
const overPlaceFelt = (p: { x: number; y: number }) =>
  !!map.getLayer("place-felt") && map.queryRenderedFeatures([p.x, p.y], { layers: ["place-felt"] }).length > 0;

/** On the Shaking tab the faded quakes are only a backdrop: clicks go to the squares, the place's felt
 *  epicentres, or empty map (back to all of Japan). */
const quakesInert = () => state.tab === "shaking";
/** The click that chose the Shaking tab's place (a square or a map pick), which mustn't also clear it. */
let placeClick: MouseEvent | null = null;

map.on("mousemove", "quakes", (e) => {
  if (overPlaceFelt(e.point) || quakesInert()) return;
  map.getCanvas().style.cursor = "pointer";
  const f = e.features?.[0];
  if (!f) return;
  const p = f.properties as unknown as QuakeProps;
  showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, (tip) => {
    tip.append(el("div", "t-head", new Date((p.t + 9 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " ") + " JST"));
    const r = el("div", "t-row");
    r.append(el("span", "", p.mag === null ? "magnitude unknown" : `M${Number(p.mag).toFixed(1)}`),
      el("strong", "", p.depth === null || p.depth === undefined ? "" : `${Math.round(Number(p.depth))} km deep`));
    tip.append(r);
    const where = quakePlace({ t: Number(p.t), mag: p.mag === null ? null : Number(p.mag), region: p.region });
    if (where) tip.append(el("div", "", where));
    if (store.isPrelim(Number(p.t))) tip.append(el("div", "t-note", "Preliminary: values may still change"));
    tip.append(el("div", "t-head", "Click for details"));
  });
});
map.on("mouseleave", "quakes", () => { map.getCanvas().style.cursor = ""; hideTooltip(); });
map.on("click", "quakes", (e) => {
  if (loc.picking || quakesInert()) return; // clicks place the point, or choose a square
  if (overPlaceFelt(e.point)) return; // handled by the place-felt layer
  const f = e.features?.[0];
  if (!f) return;
  const props = f.properties as unknown as QuakeProps;
  // GeoJSON properties come back from the worker as plain values; null may arrive as the string "null".
  const num = (v: unknown) => (v === null || v === "null" || v === undefined ? null : Number(v));
  select({
    props: { ...props, mag: num(props.mag), depth: num(props.depth), felt: String(props.felt) === "true", t: Number(props.t) },
    coords: (f.geometry as GeoJSON.Point).coordinates as [number, number],
  });
});

// ------------------------------------------------------- shindo footprint ---

const shindo = new ShindoStore();
let footprint: Footprint = { status: "none" };
let aftershocks: AftershockState = { status: "small" };
let foreshock: ForeshockState = { status: "loading" };
let fsPromise: Promise<FsData | null> | null = null;

/** Foreshock base rates (data/foreshock.json), fetched the first time an M5.5+ quake is selected. */
async function loadForeshock() {
  if (foreshock.status !== "loading") return;
  fsPromise ??= fetch("./data/foreshock.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const d = await fsPromise;
  foreshock = d ? { status: "ok", data: d } : { status: "missing" };
  renderPanel();
}
let selectToken = 0;

function footprintColor(): ExpressionSpecification {
  const m: (string | number)[] = [];
  shindoColors().forEach((c, i) => m.push(i, c));
  return ["match", ["get", "k"], ...m, theme().muted] as unknown as ExpressionSpecification;
}

function addFootprintLayer() {
  map.addSource("footprint", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "footprint", type: "circle", source: "footprint",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 2.4, 7, 4.5, 10, 7],
      "circle-color": footprintColor(),
      "circle-stroke-color": theme().text, "circle-stroke-width": 0.4, "circle-stroke-opacity": 0.6,
    },
    layout: { "circle-sort-key": ["get", "k"] },
  });
}

function showFootprint() {
  const src = map.getSource("footprint") as GeoJSONSource | undefined;
  if (!src) return;
  const r = footprint.status === "ok" ? footprint.readings! : [];
  const st = footprint.stations;
  src.setData({
    type: "FeatureCollection",
    features: st ? r.filter((x) => x.distanceKm !== null).map((x) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [st.lon[x.station]!, st.lat[x.station]!] },
      properties: { k: classOf(x.code), name: st.name[x.station] || st.id[x.station], code: x.code, iv: x.instrumental ?? -1,
        dist: Math.round(x.distanceKm!), ot: x.obsSec ?? -1 },
    })) : [],
  });
  applyTimeFilter();
  renderLegend();
}

// ------------------------------------------------------- shaking replay ---

const P_KMS = 6.0, S_KMS = 3.5; // typical crustal wave speeds, for the model rings only
let replayRaf = 0;

function addWavefrontLayer() {
  map.addSource("wavefront", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "wavefront", type: "line", source: "wavefront",
    paint: { "line-color": theme().text, "line-width": ["match", ["get", "wave"], "S", 2, 1], "line-opacity": 0.7,
      "line-dasharray": [3, 2] } });
}

function stopReplay() {
  cancelAnimationFrame(replayRaf);
  replayRaf = 0;
  (map.getSource("wavefront") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
  if (map.getLayer("footprint")) {
    map.setFilter("footprint", null);
    map.setPaintProperty("footprint", "circle-radius", ["interpolate", ["linear"], ["zoom"], 4, 2.4, 7, 4.5, 10, 7]);
  }
  if (!state.anim) $("playhead").hidden = true;
}

function replay() {
  if (footprint.status !== "ok" || !state.selected) return;
  if (in3d()) setView3d(false); // the stations light up on the map
  stopReplay();
  const timed = footprint.readings!.filter((r) => r.obsSec !== null && r.obsSec >= 0 && r.distanceKm !== null);
  if (!timed.length) return;
  const last = Math.min(600, Math.max(...timed.map((r) => r.obsSec!)));
  const speed = Math.max(1, Math.ceil(last / 12)); // finish in about 12 s
  const { coords } = state.selected;
  const depth = state.selected.props.depth ?? 10;
  const start = performance.now();
  const ring = (v: number, tSec: number, wave: string): GeoJSON.Feature | null => {
    const surf = (v * tSec) ** 2 - depth ** 2;
    if (surf <= 0) return null;
    return { type: "Feature", properties: { wave }, geometry: { type: "LineString", coordinates: circle(coords, Math.sqrt(surf), 96) } };
  };
  const frame = (now: number) => {
    const tSec = ((now - start) / 1000) * speed;
    map.setFilter("footprint", ["all", [">=", ["get", "ot"], 0], ["<=", ["get", "ot"], tSec]]);
    // Stations that have just started shaking are drawn larger.
    map.setPaintProperty("footprint", "circle-radius", ["interpolate", ["linear"], ["zoom"],
      4, ["interpolate", ["linear"], ["-", tSec, ["get", "ot"]], 0, 6, 3 * speed, 2.4],
      7, ["interpolate", ["linear"], ["-", tSec, ["get", "ot"]], 0, 10, 3 * speed, 4.5],
      10, ["interpolate", ["linear"], ["-", tSec, ["get", "ot"]], 0, 14, 3 * speed, 7]]);
    (map.getSource("wavefront") as GeoJSONSource).setData({ type: "FeatureCollection",
      features: [ring(P_KMS, tSec, "P"), ring(S_KMS, tSec, "S")].filter((f): f is GeoJSON.Feature => f !== null) });
    const ph = $("playhead");
    ph.hidden = false;
    ph.textContent = `+${tSec.toFixed(tSec < 100 ? 1 : 0)} s  (×${speed})`;
    if (tSec < last + 2 * speed) replayRaf = requestAnimationFrame(frame);
    else { replayRaf = 0; setTimeout(() => { if (!replayRaf) stopReplay(); }, 1500); }
  };
  replayRaf = requestAnimationFrame(frame);
}

async function select(sel: typeof state.selected, openTab = true) {
  stopReplay();
  hideTooltip();
  if (sel) sel = { ...sel, props: { ...sel.props, prelim: store.isPrelim(sel.props.t) } };
  const token = ++selectToken;
  state.selected = sel;
  updateUrl();
  syncDestructive();
  map.setFilter("selected", ["==", ["get", "id"], sel?.props.id ?? ""]);
  footprint = sel?.props.felt ? { status: "loading" } : { status: "none" };
  showFootprint();
  // Picked from a list while the map looks elsewhere: bring the epicentre into view.
  if (sel && openTab && !map.getBounds().contains(sel.coords)) map.easeTo({ center: sel.coords, zoom: Math.max(map.getZoom(), 5) });
  // Selecting opens the Quakes tab; clearing stays on the current tab.
  if (sel) missingQuake = null;
  if (sel && openTab) {
    setTab("quake");
    // On a phone the panel sits under the map: bring the details into view.
    if (narrow()) $("tabs").scrollIntoView({ behavior: "smooth", block: "start" });
  } else { updateSelChip(); renderPanel(); if (in3d()) draw3d(); }
  if (sel) loadAftershocks(sel, token);
  if (sel && sel.props.mag !== null && sel.props.mag >= 5.5) loadForeshock();
  if (!sel || !sel.props.felt) return;
  const { props, coords } = sel;
  const readings = await shindo.readings(props.id, props.t, coords[1], coords[0], props.depth);
  if (token !== selectToken) return;
  footprint = readings && readings.length ? { status: "ok", readings, stations: shindo.stations! } : { status: "none" };
  showFootprint();
  renderPanel();
}

async function loadAftershocks(sel: NonNullable<typeof state.selected>, token: number) {
  const { props, coords } = sel;
  if (props.mag === null || props.mag < MIN_MAINSHOCK) { aftershocks = { status: "small" }; return; }
  aftershocks = { status: "loading" };
  const lo = props.t - FORESHOCK_DAYS * DAY, hi = props.t + WINDOW_DAYS * DAY;
  await store.ensureYears(yearsNeeded(lo, hi, 3));
  if (token !== selectToken) return;
  const shocks: Shock[] = store.features(lo, hi, 3).features
    .filter((f) => f.properties.mag !== null)
    .map((f) => ({ t: f.properties.t, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], mag: f.properties.mag!, id: f.properties.id }));
  const main: Shock = { t: props.t, lat: coords[1], lon: coords[0], mag: props.mag, id: props.id };
  aftershocks = { status: "ok", main, seq: sequence(main, shocks), dataEnd: store.index.dataEnd ?? yearEnd(store.index.years[1]) };
  renderPanel();
}

const SHINDO_TIP: Record<string, string> = Object.fromEntries(CLASSES.flatMap((c) => c.codes.map((k) => [k, c.label])));
map.on("mousemove", "footprint", (e) => {
  const f = e.features?.[0];
  if (!f) return;
  const p = f.properties as { name: string; code: string; iv: number; dist: number };
  showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, (tip) => {
    tip.append(el("div", "t-head", p.name));
    const r = el("div", "t-row"); r.append(el("span", "", "Shindo"), el("strong", "", SHINDO_TIP[p.code] ?? "felt")); tip.append(r);
    const k = classOf(p.code);
    if (k >= 0) tip.append(el("div", "t-note", CLASSES[k].feel));
    if (Number(p.iv) >= 0) { const r2 = el("div", "t-row"); r2.append(el("span", "", "Instrumental"), el("strong", "", Number(p.iv).toFixed(1))); tip.append(r2); }
    const r3 = el("div", "t-row"); r3.append(el("span", "", "Distance"), el("strong", "", `${fmt(Number(p.dist))} km`)); tip.append(r3);
  });
});
map.on("mouseleave", "footprint", hideTooltip);

// -------------------------------------------------------- data on the map ---

/** Minimum magnitude actually drawn for a static view (M3+ only for short ranges). */
function effectiveMinMag(): number {
  const years = state.to - state.from + 1;
  return state.minMag < 5 && years > MAX_YEARS_FOR_M3 && !state.anim ? 5 : state.minMag;
}

let dataToken = 0;
async function refreshData() {
  const token = ++dataToken;
  const minMag = effectiveMinMag();
  // While playing, load only around the playhead; otherwise the whole range.
  const [lo, hi] = state.anim
    ? [Math.max(yearStart(state.from), state.playhead - state.trail - 86400), Math.min(yearEnd(state.to), state.playhead + 366 * 86400)]
    : [yearStart(state.from), yearEnd(state.to)];
  const years = yearsNeeded(lo, hi, minMag);
  if (!store.hasYears(years)) {
    $("loading").hidden = false;
    await store.ensureYears(years);
    $("loading").hidden = true;
  }
  if (token !== dataToken || !map.getSource("quakes")) return;
  $("loading").hidden = true; // also covers the first visit, when it shows from the start
  $("loading").textContent = "Loading…";
  const fc = store.features(lo, hi, minMag);
  (map.getSource("quakes") as GeoJSONSource).setData(fc);
  shownQuakes = fc.features;
  shownMinMag = minMag;
  loadedRange = [lo, hi];
  applyTimeFilter();
  updateStatus(fc.features.length, minMag);
  if (in3d()) draw3d();
}
let loadedRange: [number, number] = [0, 0];
let shownQuakes: GeoJSON.Feature<GeoJSON.Point, QuakeProps>[] = [];
let shownMinMag = 5;

// ------------------------------------------------------------------- 3D ---

// The 3D view always frames JAPAN_3D, which holds 99% of the M5+ quakes (out to the Kuril Islands).
const JAPAN_3D = { w: 120, s: 22, e: 152, n: 48 };
const v3d = { scene: null as Scene3D | null, loading: false, n: 0, capped: false };

/** The quake open in the panel, for the 3D view; null without one or without a depth. */
function selected3d(): Quake3D | null {
  const s = state.selected;
  if (!s || s.props.depth === null) return null;
  return { lon: s.coords[0], lat: s.coords[1], depth: s.props.depth, mag: s.props.mag ?? NaN, id: s.props.id,
    label: [fmtDate(s.props.t), quakePlace(s.props)].filter(Boolean).join(", ") };
}
let coastRings: [number, number][][] | null = null;
let landPolys: [number, number][][][] = [];
let coastPromise: Promise<void> | null = null;
/** The coastline for the 3D view, fetched once. */
function loadCoast(): Promise<void> {
  coastPromise ??= fetch("./data/coast.json").then((r) => r.json()).then((coast) => {
    landPolys = coast.geometry.coordinates as [number, number][][][];
    coastRings = landPolys.flat();
  }).catch(() => { landPolys = []; coastRings = []; });
  return coastPromise;
}
const MAX_3D = 60000;

/** Show the 3D scene instead of the map while the Quakes tab is in 3D, with the map's quakes (timeline and magnitude). */
async function draw3d(resetCamera = false) {
  const on = in3d();
  $("view3d").hidden = !on;
  $("map").style.visibility = on ? "hidden" : "";
  if (!on) { $("v3d-controls").hidden = true; return; }
  if (!v3d.scene) {
    if (v3d.loading) return;
    v3d.loading = true;
    const [{ Scene3D: S }] = await Promise.all([import("./view3d"), loadCoast()]);
    v3d.scene = new S($("view3d"));
    v3d.scene.onHover = (q, x, y) => {
      if (!q) { hideTooltip(); return; }
      showTooltip(x, y, (tip) => { tip.append(el("div", "t-head", q.label), el("div", "", `M${q.mag.toFixed(1)}, ${fmt(Math.round(q.depth))} km deep`)); });
    };
    v3d.scene.onPick = (q) => {
      const f = shownQuakes.find((x) => x.properties.id === q.id);
      if (f) select({ props: f.properties, coords: f.geometry.coordinates as [number, number] });
    };
    v3d.loading = false;
    resetCamera = true;
    if (!in3d()) { draw3d(); return; }
  }
  const bounds = JAPAN_3D;
  // During playback, the same window as the map: the trail up to the playhead.
  const [t0, t1] = state.anim ? [state.playhead - state.trail, state.playhead] : [-Infinity, Infinity];
  let quakes = shownQuakes
    .filter((f) => f.properties.depth !== null && f.properties.mag !== null && f.properties.t >= t0 && f.properties.t <= t1)
    .filter((f) => { const [lo, la] = f.geometry.coordinates; return lo >= bounds.w && lo <= bounds.e && la >= bounds.s && la <= bounds.n; });
  v3d.capped = quakes.length > MAX_3D;
  if (v3d.capped) quakes = [...quakes].sort((a, c) => c.properties.mag! - a.properties.mag!).slice(0, MAX_3D);
  v3d.n = quakes.length;
  const lines = (fc: GeoJSON.FeatureCollection | null) => (fc?.features ?? []).flatMap((f) =>
    f.geometry.type === "MultiLineString" ? (f.geometry.coordinates as [number, number][][])
      : f.geometry.type === "LineString" ? [f.geometry.coordinates as [number, number][]] : []);
  const t = theme();
  v3d.scene.set({
    quakes: quakes.map((f) => ({
      lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], depth: f.properties.depth!, mag: f.properties.mag!,
      id: f.properties.id, label: [fmtDate(f.properties.t), quakePlace(f.properties)].filter(Boolean).join(", "),
    })),
    coast: coastRings ?? [], land: landPolys, plates: overlays.plates ? lines(overlayData.plates) : [],
    slabs: (overlays.slabs ? overlayData.slabs?.features ?? [] : []).map((f) => ({ depthKm: Number(f.properties?.depth), lines: lines({ type: "FeatureCollection", features: [f] }) })),
    bounds, depthEdges: DEPTH_EDGES, selected: selected3d(),
    colors: { background: t.surface, coast: t.secondary, land: t.text, plates: t.text, slab: t.series[0], box: t.axis, text: t.muted,
      sel: t.text, depth: t.depth },
  }, resetCamera);
  render3dControls();
  renderPanel();
}

function in3d() { return state.view3d && state.tab === "quake"; }

/** Rings round destructive quakes: on the Quakes tab's map while their list is open. */
function destructiveShown() { return state.tab === "quake" && !state.selected && state.dmgOpen && !in3d(); }
function syncDestructive() {
  if (map.getLayer("destructive")) map.setLayoutProperty("destructive", "visibility", destructiveShown() ? "visible" : "none");
}

/** The Quakes tab's Map / 3D switch. */
function setView3d(on: boolean) {
  state.view3d = on;
  hideTooltip();
  if (on) stopReplay();
  if (state.tab !== "quake") { setTab("quake"); return; }
  updateUrl();
  syncViewSwitch();
  syncDestructive();
  renderPanel();
  draw3d();
}
function syncViewSwitch() {
  $("view-switch").hidden = state.tab !== "quake";
  $("view-map").setAttribute("aria-pressed", String(!in3d()));
  $("view-3d").setAttribute("aria-pressed", String(in3d()));
  document.body.classList.toggle("in3d", in3d());
}
$("view-map").addEventListener("click", () => setView3d(false));
$("view-3d").addEventListener("click", () => setView3d(true));

/** In the Quake panel while nothing is open: what the 3D view shows and how to move it. */
function render3dIntro() {
  const card = el("div", "intro");
  card.append(el("h2", "", "3D: quakes at their depths"), el("p", "",
    "Each quake is placed at its depth under the coastline. Deep quakes trace the plates sinking under Japan: the " +
    "Pacific plate dipping west from the Japan and Kuril trenches down to about 600 km, and the Philippine Sea plate " +
    "under western Japan. Blue lines: the top of the sinking plates every 20–100 km (USGS Slab2). Colours are depth " +
    "and size is magnitude, as on the map."), el("p", "sub",
    "Drag to turn, scroll or pinch to zoom, right-drag or two fingers to move; click a quake to open it here. Depths " +
    "are to scale, so the plates look thin: the islands are about 2,500 km long and the deepest quakes 700 km down."));
  card.append(el("p", "sub", v3d.scene
    ? `${fmt(v3d.n)} quakes` + (v3d.capped ? ` (the ${fmt(MAX_3D)} largest)` : "") + `, ${state.anim
        ? `playback at ${new Date((state.playhead + 9 * 3600) * 1000).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })}`
        : state.from === state.to ? state.from : `${state.from}–${state.to}`}, M${effectiveMinMag()}+: set the years and ` +
      "magnitude on the timeline."
    : "Loading the 3D view…"));
  $("v3d-host").replaceChildren(card);
}

/** Over the 3D view: Reset view, Zoom to quake when one is open, or why it isn't shown. */
function render3dControls() {
  const host = $("v3d-controls");
  host.hidden = !in3d();
  if (host.hidden) return;
  const row = el("div", "v3d-buttons");
  const btn = (text: string, fn: () => void) => {
    const b = el("button", "", text) as HTMLButtonElement;
    b.type = "button"; b.addEventListener("click", fn); row.append(b);
  };
  btn("Reset view", () => draw3d(true));
  const parts: HTMLElement[] = [row];
  const q = selected3d(), b = JAPAN_3D;
  if (state.selected) {
    if (!q) parts.push(el("p", "pill muted", "This quake has no recorded depth, so it can't be placed in 3D."));
    else if (q.lon < b.w || q.lon > b.e || q.lat < b.s || q.lat > b.n) parts.push(el("p", "pill muted", "This quake is outside the 3D area."));
    else btn("Zoom to quake", () => v3d.scene?.focus(q));
  }
  host.replaceChildren(...parts);
}

// ------------------------------------------------------ plate overlays ---

const overlayData: { slabs: GeoJSON.FeatureCollection | null; plates: GeoJSON.FeatureCollection | null } = { slabs: null, plates: null };
Promise.all([
  fetch("./data/overlays/slabs.json").then((r) => r.json()),
  fetch("./data/overlays/plates.json").then((r) => r.json()),
]).then(([slabs, plates]) => { overlayData.slabs = slabs; overlayData.plates = plates; });

// ------------------------------------------------------------- hotspots ---

const hot = {
  level: 0,
  counts: null as StationCounts | null,
  cells: [] as Cell[],
  range: [0.1, 1] as [number, number],
  key: "",
};
let countsPromise: Promise<StationCounts> | null = null;

function addHotspotLayer() {
  map.addSource("hotspots", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const colors = hotColors();
  const m: (number | string)[] = [];
  colors.forEach((c, i) => m.push(i, c));
  map.addLayer({
    id: "hotspots", type: "fill", source: "hotspots",
    paint: { "fill-color": ["match", ["get", "c"], ...m, colors[0]] as unknown as ExpressionSpecification,
      "fill-opacity": 0.8, "fill-outline-color": theme().surface },
  }, "quakes");
}

/** Recompute cells when the period or level changes, then draw them (only on the Shaking tab). */
async function drawHotspots() {
  const src = map.getSource("hotspots") as GeoJSONSource | undefined;
  if (!src) return;
  if (state.tab !== "shaking" || loc.place) { src.setData({ type: "FeatureCollection", features: [] }); return; }
  countsPromise ??= fetch("./data/station_counts.json").then((r) => r.json());
  const [counts, stations] = await Promise.all([countsPromise, shindo.loadStations()]);
  hot.counts = counts;
  const key = `${state.from}-${state.to}-${hot.level}`;
  if (key !== hot.key) {
    hot.cells = grid(stationRates(counts, stations, state.from, state.to, LEVELS[hot.level].minClass), stations);
    hot.range = scaleRange(hot.cells);
    hot.key = key;
    renderPanel();
    renderLegend();
  }
  if (state.tab !== "shaking" || loc.place) return;
  const [lo, hi] = hot.range;
  src.setData({
    type: "FeatureCollection",
    features: hot.cells.map((c, i) => ({
      type: "Feature", properties: { c: logClass(c.rate, lo, hi, HOT_STEPS), i },
      geometry: { type: "Polygon", coordinates: [[[c.lon, c.lat], [c.lon + CELL_DEG, c.lat], [c.lon + CELL_DEG, c.lat + CELL_DEG],
        [c.lon, c.lat + CELL_DEG], [c.lon, c.lat]]] },
    })),
  });
}

map.on("mousemove", "hotspots", (e) => {
  const f = e.features?.[0];
  const c = f ? hot.cells[Number((f.properties as { i: number }).i)] : undefined;
  const st = shindo.stations;
  if (!c || !st) return;
  const busiest = c.stations.reduce((a, b) => (b.rate > a.rate ? b : a));
  showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, (tip) => {
    tip.append(el("div", "t-head", `${LEVELS[hot.level].label}, ${state.from === state.to ? state.from : `${state.from}–${state.to}`}`));
    const row = (k: string, v: string) => { const r = el("div", "t-row"); r.append(el("span", "", k), el("strong", "", v)); tip.append(r); };
    row("Per year (average)", c.rate >= 10 ? fmt(Math.round(c.rate)) : c.rate.toPrecision(2));
    row("Stations", String(c.stations.length));
    row("Busiest", `${st.name[busiest.station] || st.id[busiest.station]} (${busiest.rate.toPrecision(2)}/yr)`);
    tip.append(el("div", "t-head", "Click to see what was felt here"));
  });
  map.getCanvas().style.cursor = "pointer";
});
map.on("mouseleave", "hotspots", () => { map.getCanvas().style.cursor = ""; hideTooltip(); });
map.on("click", "hotspots", (e) => {
  if (loc.picking || state.tab !== "shaking" || loc.place) return;
  const f = e.features?.[0];
  const c = f ? hot.cells[Number((f.properties as { i: number }).i)] : undefined;
  if (c) { placeClick = e.originalEvent; chooseCell(c); }
});
/** A square as the Shaking tab's place: its centre, with the usual distance around it. */
function chooseCell(c: Cell) {
  const lon = c.lon + CELL_DEG / 2, lat = c.lat + CELL_DEG / 2;
  hideTooltip();
  setPlace({ name: `${lat.toFixed(1)}°N, ${lon.toFixed(1)}°E`, lonlat: [lon, lat] });
  map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 7) });
}

// ---------------------------------------------------- slow-slip tremor ---

// JMA's low-frequency earthquakes counted in 0.02° squares (data/tremor.json), shown when the
// legend's "Slow-slip tremor" box is ticked: where they happen, all years together.
interface TremorGrid { step: number; years: [number, number]; lat: number[]; lon: number[]; n: number[] }
let tremor: { fc: GeoJSON.FeatureCollection<GeoJSON.Point, { n: number }>; years: [number, number] } | null = null;
let tremorPromise: Promise<void> | null = null;

function addTremorLayer(before?: string) {
  map.addSource("tremor", { type: "geojson", data: tremor?.fc ?? { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "tremor", type: "circle", source: "tremor", layout: { visibility: vis("tremor") },
    paint: {
      // About the size of a square, so the belt reads as one band when zoomed out.
      "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 4, 1.5, 7, 3.4, 10, 22],
      "circle-color": theme().series[1],
      "circle-opacity": ["interpolate", ["linear"], ["ln", ["get", "n"]], 0, 0.3, 4.6, 0.8], // 1 event to 100+
    },
  }, before);
}

/** Fetch the squares the first time the layer is shown. */
function loadTremor() {
  tremorPromise ??= fetch("./data/tremor.json").then((r) => r.json()).then((g: TremorGrid) => {
    tremor = {
      years: g.years,
      fc: { type: "FeatureCollection", features: g.n.map((n, i) => ({
        type: "Feature", properties: { n }, geometry: { type: "Point", coordinates: [g.lon[i], g.lat[i]] } })) },
    };
    (map.getSource("tremor") as GeoJSONSource | undefined)?.setData(tremor.fc);
  }).catch(() => { tremorPromise = null; }); // try again next time it's ticked
  return tremorPromise;
}

const overTremor = (p: { x: number; y: number }) =>
  overlays.tremor && !!map.getLayer("tremor") && map.queryRenderedFeatures([p.x, p.y], { layers: ["tremor"] }).length > 0;
map.on("mousemove", "tremor", (e) => {
  if (overQuake(e.point)) return; // quakes win
  const n = Number(e.features?.[0]?.properties?.n);
  if (!n || !tremor) return;
  const [y0, y1] = tremor.years;
  showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, (tip) => {
    tip.append(el("div", "t-head", "Slow-slip tremor"));
    tip.append(el("div", "", `${fmt(n)} low-frequency ${n === 1 ? "quake" : "quakes"} here, ${y0}–${y1}`));
    tip.append(el("div", "t-note", "Weak, deep tremor, too faint to feel. The belt under western Japan comes from the " +
      "sinking plate slowly slipping, just below the part that breaks in Nankai Trough quakes; clusters elsewhere are " +
      "under volcanoes."));
  });
});
map.on("mouseleave", "tremor", hideTooltip);

// -------------------------------------------------------------- forecast ---

const fc = { data: null as Forecast | null, status: "loading" as "loading" | "ok" | "missing" };
let fcPromise: Promise<Forecast | null> | null = null;

/** The official source area of a great trench quake, shown from the Forecast tab's 30-year table. */
let fcZone: string | null = null;
let zonesPromise: Promise<GeoJSON.FeatureCollection | null> | null = null;
const loadZones = () => (zonesPromise ??= fetch("./data/overlays/trench_zones.json").then((r) => (r.ok ? r.json() : null)).catch(() => null));

function addZoneLayers() {
  map.addSource("trench-zones", { type: "geojson", data: "./data/overlays/trench_zones.json",
    attribution: "Source areas: J-SHIS (NIED), processed" });
  const t = theme();
  const filter = ["==", ["get", "zone"], fcZone ?? ""] as unknown as FilterSpecification;
  const visibility = state.tab === "forecast" ? "visible" : "none";
  map.addLayer({ id: "trench-zone-fill", type: "fill", source: "trench-zones", filter, layout: { visibility },
    paint: { "fill-color": t.text, "fill-opacity": 0.12 } });
  map.addLayer({ id: "trench-zone-line", type: "line", source: "trench-zones", filter, layout: { visibility },
    paint: { "line-color": t.text, "line-width": 2.5 } });
}

/** Show one quake's source area (or none), and bring it into view. */
async function setZone(id: string | null) {
  fcZone = id;
  syncZones();
  renderPanel();
  if (!id) return;
  const fc = await loadZones();
  const f = fc?.features.find((x: GeoJSON.Feature) => x.properties?.zone === id);
  if (!f || fcZone !== id) return;
  const pts = (f.geometry as GeoJSON.MultiPolygon).coordinates.flat(2);
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: 60, maxZoom: 7, duration: 900 });
  showMapOnPhone();
}
function syncZones() {
  const visibility = state.tab === "forecast" ? "visible" : "none";
  for (const id of ["trench-zone-fill", "trench-zone-line"]) {
    if (!map.getLayer(id)) continue;
    map.setFilter(id, ["==", ["get", "zone"], fcZone ?? ""]);
    map.setLayoutProperty(id, "visibility", visibility);
  }
}

function addForecastLayer() {
  map.addSource("forecast", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const colors = fcColors();
  const m: (number | string)[] = [];
  colors.forEach((c, i) => m.push(i, c));
  map.addLayer({
    id: "forecast", type: "fill", source: "forecast",
    paint: { "fill-color": ["match", ["get", "c"], ...m, colors[0]] as unknown as ExpressionSpecification,
      // the lowest class (the usual quiet background) faint, so raised areas stand out
      "fill-opacity": ["match", ["get", "c"], 0, 0.25, 1, 0.5, 0.8] as unknown as ExpressionSpecification,
      "fill-outline-color": theme().surface },
  }, "quakes");
}

/** Load the forecast once; draw its cells while the tab is open. */
async function drawForecast() {
  const src = map.getSource("forecast") as GeoJSONSource | undefined;
  if (!src) return;
  if (state.tab !== "forecast") { src.setData({ type: "FeatureCollection", features: [] }); return; }
  fcPromise ??= fetch("./data/forecast.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const f = await fcPromise;
  const first = fc.status === "loading";
  fc.data = f;
  fc.status = f ? "ok" : "missing";
  if (first) renderPanel();
  if (!f || state.tab !== "forecast") return;
  const { lat0, lon0, step } = f.grid;
  src.setData({
    type: "FeatureCollection",
    features: f.live.cells.map(([i, j, lam5], k) => {
      const lat = lat0 + i * step, lon = lon0 + j * step;
      return {
        type: "Feature", properties: { c: pClass(chance(lam5)), k },
        geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + step, lat], [lon + step, lat + step], [lon, lat + step], [lon, lat]]] },
      };
    }),
  });
}

map.on("mousemove", "forecast", (e) => {
  const f = e.features?.[0];
  const d = fc.data;
  if (!f || !d) return;
  const [, , lam5, base5] = d.live.cells[Number((f.properties as { k: number }).k)];
  showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, (tip) => {
    tip.append(el("div", "t-head", `M5+ in this square, ${fmtWindow(d.live.t0, d.live.days)}`));
    const row = (k: string, v: string) => { const r = el("div", "t-row"); r.append(el("span", "", k), el("strong", "", v)); tip.append(r); };
    row("Forecast chance", fmtPct(chance(lam5)));
    row("Long-term average", fmtPct(chance(base5)));
    if (base5 > 0) row("Ratio", `${(lam5 / base5).toFixed(1)}×`);
  });
});
map.on("mouseleave", "forecast", hideTooltip);

// ------------------------------------------------------------ my location ---

const locStore = new LocationStore();
const loc = {
  place: null as Place | null,
  radiusKm: 25,
  picking: false,
  status: "idle" as "idle" | "loading" | "ok",
  quakes: [] as FeltQuake[],
  stations: [] as NearbyStation[],
};
const placeMarker = new Marker({ element: el("div", "place-marker") });
let locToken = 0;

function circle([lon, lat]: [number, number], km: number, n = 72): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    out.push([lon + (km / (111.2 * Math.cos((lat * Math.PI) / 180))) * Math.sin(a), lat + (km / 111.2) * Math.cos(a)]);
  }
  return out;
}

function addLocationLayers() {
  map.addSource("place", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "place-radius", type: "line", source: "place", filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "line-color": theme().text, "line-width": 1.5, "line-dasharray": [2, 1] } });
  // Thousands of epicentres: drawn under the place names, smaller than the quake dots,
  // with shindo 1-2 faint so the stronger ones and the chosen place stay readable.
  map.addLayer({ id: "place-felt", type: "circle", source: "place", filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, ["*", 0.7, baseRadius], 9, ["*", 1.8, baseRadius]],
      "circle-color": footprintColor(),
      "circle-opacity": ["case", ["<=", ["get", "k"], 1], 0.3, 0.85],
      "circle-stroke-color": theme().text, "circle-stroke-width": ["case", ["<=", ["get", "k"], 1], 0, 0.4],
    },
    layout: { "circle-sort-key": ["get", "k"] } }, beforeLabels());
}

function drawLocation() {
  const src = map.getSource("place") as GeoJSONSource | undefined;
  const visible = state.tab === "shaking" && loc.place !== null;
  if (src) {
    src.setData({
      type: "FeatureCollection",
      features: visible ? [
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circle(loc.place!.lonlat, loc.radiusKm)] } },
        ...loc.quakes.map((q, i) => ({ q, i })).filter(({ q }) => q.lat !== null && q.cls >= 0).map(({ q, i }) => ({
          type: "Feature" as const, properties: { k: q.cls, mag: q.mag, i },
          geometry: { type: "Point" as const, coordinates: [q.lon!, q.lat!] },
        })),
      ] : [],
    });
  }
  if (visible) placeMarker.setLngLat(loc.place!.lonlat).addTo(map); else placeMarker.remove();
  if (map.getLayer("quakes")) applyTimeFilter();
  renderLegend();
}

async function setPlace(place: Place | null) {
  const token = ++locToken;
  loc.place = place;
  loc.picking = false;
  map.getCanvas().style.cursor = "";
  syncMapHint();
  loc.status = place ? "loading" : "idle";
  loc.quakes = []; loc.stations = [];
  drawLocation(); drawHotspots(); renderPanel();
  if (!place) return;
  const stations = await shindo.loadStations();
  const r = await locStore.query(stations, place.lonlat[0], place.lonlat[1], loc.radiusKm);
  if (token !== locToken) return;
  Object.assign(loc, { status: "ok", quakes: r.quakes, stations: r.stations });
  drawLocation(); renderPanel();
}

/** Open a quake from the felt list in the Quakes tab (full catalogue details when loaded). */
let feltToken = 0;
async function selectFelt(q: FeltQuake) {
  if (!q.id || q.lat === null || q.lon === null) return;
  const token = ++feltToken;
  // Most felt quakes are below M5 and not loaded yet: fetch their year for the full details.
  const f = shownQuakes.find((x) => x.properties.id === q.id) ?? await findQuake(q.id);
  if (token !== feltToken) return; // a later click won
  // Under M3 the map data has no entry: show what the shaking record gives.
  const props: QuakeProps = f ? f.properties
    : { t: q.t, mag: q.mag, depth: q.depth, shindo: "", cls: "-", felt: true, id: q.id }; // cls "-": type unknown
  select({ props, coords: f ? f.geometry.coordinates as [number, number] : [q.lon, q.lat] });
}

// Hover and click on the epicentres of quakes felt at the chosen place.
map.on("mousemove", "place-felt", (e) => {
  map.getCanvas().style.cursor = "pointer";
  const f = e.features?.[0];
  const q = f ? loc.quakes[Number((f.properties as { i: number }).i)] : undefined;
  if (!q) return;
  const st = shindo.stations;
  showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, (tip) => {
    tip.append(el("div", "t-head", `${new Date((q.t + 9 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " ")} JST`));
    const row = (k: string, v: string) => { const r = el("div", "t-row"); r.append(el("span", "", k), el("strong", "", v)); tip.append(r); };
    row("Magnitude", q.mag === null ? "unknown" : `M${q.mag.toFixed(1)}`);
    if (q.depth !== null) row("Depth", `${Math.round(q.depth)} km`);
    row(`Felt near ${loc.place?.name ?? "here"}`, (CLASSES[q.cls]?.label ?? "felt") + (q.instrumental !== null ? ` (${q.instrumental.toFixed(1)})` : ""));
    if (st) row("Strongest at", st.name[q.station] || st.id[q.station]);
    if (q.epiKm !== null) row("Epicentre", `${fmt(Math.round(q.epiKm))} km away`);
    tip.append(el("div", "t-head", q.id ? "Click to open in the Quakes tab" : "No catalogue entry"));
  });
});
map.on("mouseleave", "place-felt", () => { map.getCanvas().style.cursor = ""; hideTooltip(); });
map.on("click", "place-felt", (e) => {
  if (loc.picking) return;
  const f = e.features?.[0];
  const q = f ? loc.quakes[Number((f.properties as { i: number }).i)] : undefined;
  if (q) selectFelt(q);
});

/** Turn off "Pick on map" (Esc, or leaving its tab). */
function cancelMapModes() {
  const was = loc.picking;
  loc.picking = false;
  map.getCanvas().style.cursor = "";
  syncMapHint();
  if (was) renderPanel();
}

/** On-map prompt while a click places something instead of selecting a quake. */
function syncMapHint() {
  const hint = $("map-hint");
  const text = loc.picking ? "Click the map to choose a place" : "";
  hint.hidden = !text;
  hint.replaceChildren(text, " · ");
  const cancel = el("button", "hint-cancel", "Cancel (Esc)") as HTMLButtonElement;
  cancel.type = "button";
  cancel.addEventListener("click", cancelMapModes);
  hint.append(cancel);
}

/** Phones show the panel under the map: bring the map back when a click on it is needed. */
function showMapOnPhone() {
  if (narrow()) $("map").scrollIntoView({ behavior: "smooth", block: "start" });
}

// Clicking empty map clears the selected quake.
map.on("click", (e) => {
  if (!state.selected || loc.picking || state.tab === "shaking") return; // there, clicks choose or clear a place
  const layers = ["quakes", "place-felt", "selected"].filter((l) => map.getLayer(l));
  if (map.queryRenderedFeatures(e.point, { layers }).length) return;
  select(null);
});

map.on("click", (e) => {
  if (!loc.picking) return;
  placeClick = e.originalEvent;
  setPlace({ name: `${e.lngLat.lat.toFixed(2)}°N, ${e.lngLat.lng.toFixed(2)}°E`, lonlat: [e.lngLat.lng, e.lngLat.lat] });
});

// Shaking tab with a place chosen: a click on empty map (not a felt epicentre) goes back to the squares.
map.on("click", (e) => {
  if (state.tab !== "shaking" || !loc.place || loc.picking || e.originalEvent === placeClick) return;
  if (overPlaceFelt(e.point)) return;
  setPlace(null);
});

function applyTimeFilter() {
  if (!map.getLayer("quakes")) return;
  // With a place chosen on the Shaking tab its felt epicentres tell the story: the other quakes are hidden.
  map.setLayoutProperty("quakes", "visibility", state.tab === "shaking" && loc.place ? "none" : "visible");
  // A selected quake's station dots belong to its own time, not the playback's (its ring stays).
  for (const id of ["footprint", "wavefront"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", state.anim ? "none" : "visible");
  }
  if (state.anim) {
    const lo = state.playhead - state.trail;
    const hi = state.playhead;
    map.setFilter("quakes", ["all", [">=", ["get", "t"], lo], ["<=", ["get", "t"], hi]]);
    map.setPaintProperty("quakes", "circle-opacity", ["interpolate", ["linear"], ["get", "t"], lo, 0.08, hi, 0.95]);
  } else {
    map.setFilter("quakes", null);
    const dim = footprint.status === "ok" || state.tab === "shaking" || state.tab === "forecast";
    map.setPaintProperty("quakes", "circle-opacity", dim ? 0.15 : 0.7);
  }
}

function updateStatus(n: number, minMag: number) {
  const years = state.to - state.from + 1;
  $("status").textContent = state.anim ? "" : `${fmt(n)} ${n === 1 ? "quake" : "quakes"} M${minMag}+ shown`;
  const note = $("mag-note");
  note.hidden = !(state.minMag < 5 && minMag === 5 && !state.anim);
  note.textContent = `M${state.minMag}+ is drawn for ranges of up to ${MAX_YEARS_FOR_M3} years (this one is ${years}); press play to step through it.`;
}

// ------------------------------------------------------------- timeline ---

const fromInput = $<HTMLInputElement>("range-from");
const toInput = $<HTMLInputElement>("range-to");
for (const inp of [fromInput, toInput]) { inp.min = String(store.index.years[0]); inp.max = String(store.index.years[1]); }

function syncTimeline() {
  fromInput.value = String(state.from);
  toInput.value = String(state.to);
  const label = $("range-label");
  label.textContent = state.from === state.to ? `${state.from}` : `${state.from}–${state.to}`;
  if (store.index.prelimFrom && state.to >= yearOf(store.index.prelimFrom)) {
    const b = el("span", "badge-prelim", "Preliminary");
    b.title = `Quakes from ${fmtDate(store.index.prelimFrom)} on are preliminary: JMA's provisional values, which may change`;
    label.append(" ", b);
  }
  const span = store.index.years[1] - store.index.years[0];
  const pct = (y: number) => ((y - store.index.years[0]) / span) * 100;
  const fill = $("range-fill");
  fill.style.left = `${pct(state.from)}%`;
  fill.style.width = `${pct(state.to) - pct(state.from)}%`;
  if (store.index.prelimFrom) {
    const band = $("range-prelim");
    band.hidden = false;
    band.style.left = `${pct(yearOf(store.index.prelimFrom))}%`;
    band.title = `Hatched: preliminary data (from ${fmtDate(store.index.prelimFrom)})`;
  }
  updateUrl();
  $("exit-play").hidden = !state.anim;
  $("trail-wrap").hidden = !state.anim;
  if ($("map-legend").childElementCount) renderLegend(); // the shindo row hides during playback
  $("play").textContent = state.playing ? "❚❚" : "▶";
  $("play").setAttribute("aria-label", state.playing ? "Pause" : "Play through the period");
}

let rangeTimer = 0;
function onRangeInput(which: "from" | "to") {
  let a = Number(fromInput.value), b = Number(toInput.value);
  if (a > b) { if (which === "from") b = a; else a = b; }
  state.from = a; state.to = b;
  if (state.anim) stop();
  syncTimeline();
  clearTimeout(rangeTimer);
  rangeTimer = window.setTimeout(() => { refreshData(); renderPanel(); }, 150);
}
fromInput.addEventListener("input", () => onRangeInput("from"));
toInput.addEventListener("input", () => onRangeInput("to"));

$<HTMLSelectElement>("min-mag").addEventListener("change", (e) => {
  state.minMag = Number((e.target as HTMLSelectElement).value);
  updateUrl();
  refreshData();
});
$<HTMLSelectElement>("trail").addEventListener("change", (e) => {
  state.trail = Number((e.target as HTMLSelectElement).value);
  if (state.anim) { refreshData(); applyTimeFilter(); }
});

let raf = 0;
let lastFrame = 0;
let lastYear = 0;
let last3d = 0;
function frame(now: number) {
  if (!state.playing) return;
  const years = state.to - state.from + 1;
  const duration = Math.min(90, Math.max(12, years * 1.2)) * 1000; // whole range, ms
  const dt = lastFrame ? now - lastFrame : 0;
  lastFrame = now;
  state.playhead += ((yearEnd(state.to) - yearStart(state.from)) * dt) / duration;
  if (state.playhead >= yearEnd(state.to)) { stop(); return; }
  const y = yearOf(state.playhead);
  if (y !== lastYear || state.playhead > loadedRange[1] - 86400) { lastYear = y; refreshData(); }
  applyTimeFilter();
  if (in3d() && now - last3d > 300) { last3d = now; draw3d(); }
  const d = new Date((state.playhead + 9 * 3600) * 1000);
  $("playhead").textContent = d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
  const fill = $("range-fill");
  const frac = (state.playhead - yearStart(state.from)) / (yearEnd(state.to) - yearStart(state.from));
  $("progress").style.left = fill.style.left;
  $("progress").style.width = `calc(${fill.style.width} * ${frac.toFixed(4)})`;
  raf = requestAnimationFrame(frame);
}

function play() {
  if (!state.anim) {
    state.anim = true;
    state.playhead = yearStart(state.from);
    lastYear = 0;
    $("playhead").hidden = false;
    $("progress").hidden = false;
    refreshData();
  }
  state.playing = true;
  lastFrame = 0;
  syncTimeline();
  raf = requestAnimationFrame(frame);
}
/** Freeze on the current frame; play resumes from here. */
function pause() {
  state.playing = false;
  cancelAnimationFrame(raf);
  syncTimeline();
}
/** Leave playback and show the whole range again. */
function stop() {
  state.playing = false;
  state.anim = false;
  cancelAnimationFrame(raf);
  $("playhead").hidden = true;
  $("progress").hidden = true;
  syncTimeline();
  refreshData();
}
$("play").addEventListener("click", () => (state.playing ? pause() : play()));
$("exit-play").addEventListener("click", stop);
// Esc undoes the most recent kind of thing: a half-done map pick, then playback, then the selection.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.querySelector("dialog[open]")) return; // the browser closes the dialog
  // Esc in a dropdown or text box only closes that control.
  if ((e.target as HTMLElement | null)?.closest?.("select, input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea")) return;
  if (loc.picking) cancelMapModes();
  else if (state.anim) stop();
  else if (state.selected) select(null);
});

// ---------------------------------------------------------------- panel ---

const TABS = ["quake", "shaking", "forecast"];

function setTab(tab: string) {
  if (tab !== state.tab) cancelMapModes(); // a pick belongs to the tab that started it
  if (tab !== "quake") state.view3d = false; // 3D is a view of the Quakes tab only
  state.tab = tab;
  updateUrl();
  document.body.classList.remove("panel-closed");
  syncPanelToggle();
  for (const t of TABS) {
    const btn = $(`tab-${t}`);
    btn.setAttribute("aria-selected", String(t === tab));
    btn.tabIndex = t === tab ? 0 : -1;
    $(`pane-${t}`).hidden = t !== tab;
  }
  updateSelChip();
  syncViewSwitch();
  renderPanel();
  drawLocation();
  drawHotspots();
  drawForecast();
  syncZones();
  draw3d();
  if (map.getLayer("quakes")) applyTimeFilter();
  syncDestructive();
  map.resize();
}
for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => setTab(t));

/** "Selected: M7.0 · 14 Jan 1978 ✕" above every tab but the Quakes tab (which has its own clear button). */
function updateSelChip() {
  const s = state.selected;
  $("sel-chip").hidden = !s || state.tab === "quake";
  if (!s) return;
  const p = s.props;
  const where = quakePlace(p);
  $("sel-show").textContent =
    `Selected: ${p.mag === null ? "felt quake" : `M${p.mag.toFixed(1)}`} · ${fmtDate(p.t)}${where ? ` · ${where}` : ""}`;
}
$("sel-show").addEventListener("click", () => setTab("quake"));
$("sel-clear").addEventListener("click", () => select(null));
$("tabs").addEventListener("keydown", (e) => {
  const i = TABS.indexOf(state.tab);
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next);
    $(`tab-${next}`).focus();
  }
});
/** The header's panel button: its state and label follow whether the panel is shown. */
function syncPanelToggle() {
  const open = !document.body.classList.contains("panel-closed");
  const btn = $("panel-toggle");
  btn.setAttribute("aria-expanded", String(open));
  const label = open ? "Hide the panel" : "Show the panel";
  btn.setAttribute("aria-label", label);
  btn.title = label;
}
$("panel-toggle").addEventListener("click", () => {
  document.body.classList.toggle("panel-closed");
  syncPanelToggle();
  setTimeout(() => map.resize(), 0);
});

function visibleCells() {
  const b = map.getBounds();
  return cellsInBounds(grData, b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
}

const FOCUSABLE = "button, select, input, a[href], [tabindex='0']";
const focusKey = (e: Element) => `${e.tagName}|${(e.textContent ?? "").trim().slice(0, 40)}|${(e as HTMLInputElement).value ?? ""}`;

/** Re-render the open tab. Panes are rebuilt from scratch, so put keyboard focus back on the
 * matching control (same text, else same position) instead of losing it to <body>. */
function renderPanel() {
  const pane = $(`pane-${state.tab}`);
  const a = document.activeElement;
  const inPane = a && a !== document.body && pane.contains(a);
  const before = inPane ? [...pane.querySelectorAll(FOCUSABLE)] : [];
  const idx = inPane ? before.indexOf(a) : -1;
  const key = inPane ? focusKey(a) : "";
  renderPanelBody();
  if (!inPane || pane.contains(a)) return;
  const after = [...pane.querySelectorAll<HTMLElement>(FOCUSABLE)];
  (after.find((e) => focusKey(e) === key) ?? after[Math.min(idx, after.length - 1)])?.focus({ preventScroll: true });
}

function renderPanelBody() {
  if (document.body.classList.contains("panel-closed")) return;
  if (state.tab === "forecast") {
    if (fc.status === "loading") drawForecast();
    const b = map.getBounds();
    const all = visibleCells() === null;
    renderForecast($("pane-forecast"), {
      status: fc.status, data: fc.data,
      view: fc.data ? sumCells(fc.data, all ? null : { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() }) : null,
      areaLabel: all ? "all of Japan" : "the visible map area",
      colors: fcColors(), edges: P_EDGES,
      zones: { zone: fcZone, onZone: setZone },
    });
  } else if (state.tab === "shaking") {
    renderShaking($("pane-shaking"), {
      status: hot.key === `${state.from}-${state.to}-${hot.level}` ? "ok" : "loading",
      level: hot.level, from: state.from, to: state.to, years: store.index.years,
      cells: hot.cells, range: hot.range, stations: shindo.stations,
      onLevel: (i) => { hot.level = i; renderPanel(); drawHotspots(); },
      onInstrumentalEra: () => { state.from = 1997; state.to = store.index.years[1]; syncTimeline(); refreshData(); drawHotspots(); renderPanel(); },
      onCell: chooseCell,
    }, {
      ...loc,
      allStations: shindo.stations,
      years: store.index.years,
      onPlace: (p) => { setPlace(p); map.flyTo({ center: p.lonlat, zoom: 7 }); },
      onPick: () => {
        loc.picking = !loc.picking;
        map.getCanvas().style.cursor = loc.picking ? "crosshair" : "";
        syncMapHint(); renderPanel();
        if (loc.picking) showMapOnPhone();
      },
      onGeolocate: () => {
        navigator.geolocation?.getCurrentPosition(
          (pos) => { const p: Place = { name: "your location", lonlat: [pos.coords.longitude, pos.coords.latitude] }; setPlace(p); map.flyTo({ center: p.lonlat, zoom: 7 }); },
          () => { $("pane-shaking").append(el("p", "note", "Location unavailable: the browser didn't share it.")); },
          { maximumAge: 600000, timeout: 10000 },
        );
      },
      onRadius: (km) => { loc.radiusKm = km; setPlace(loc.place); },
      onSelectQuake: selectFelt,
      onClear: () => setPlace(null),
    });
    if (!loc.place && hot.key !== `${state.from}-${state.to}-${hot.level}`) drawHotspots();
  } else if (state.tab === "quake") {
    // While nothing is open: the Start here card, or in 3D what the 3D view shows.
    $("intro-host").hidden = !!state.selected || in3d();
    $("v3d-host").hidden = !!state.selected || !in3d();
    if (in3d() && !state.selected) render3dIntro();
    const clear = el("button", "clear-btn", "Clear selection (Esc)") as HTMLButtonElement;
    clear.type = "button";
    clear.addEventListener("click", () => select(null));
    const extra = el("div");
    if (state.selected && footprint.status === "ok") {
      const timed = footprint.readings!.filter((r) => r.obsSec !== null && r.distanceKm !== null).length;
      if (timed) {
        const rb = el("button", "primary", "▶ Replay the shaking") as HTMLButtonElement;
        rb.type = "button";
        rb.addEventListener("click", replay);
        const missing = footprint.readings!.length - timed;
        extra.append(el("h2", "", "Replay"), el("p", "sub",
          "Stations light up at the time they recorded the shaking. The dashed rings are model P and S wave fronts " +
          `(${P_KMS} and ${S_KMS} km/s) for comparison.` + (missing ? ` ${fmt(missing)} ${missing === 1 ? "reading has" : "readings have"} no recorded time and ${missing === 1 ? "is" : "are"} left out.` : "")), rb);
      }
    }
    if (state.selected) {
      extra.append(renderAftershocks(aftershocks, $("pane-quake").clientWidth));
      const fs = renderForeshock(foreshock, state.selected.props.t, state.selected.props.mag);
      if (fs) extra.append(fs);
      extra.append(clear);
    }
    let empty: HTMLElement | null = null;
    if (!state.selected) {
      empty = el("div");
      if (missingQuake) empty.append(el("p", "note", `The linked quake (${missingQuake}) isn't in the map data, which ` +
        "covers quakes of M3 and above. Smaller felt quakes can be opened from the Shaking tab, after choosing a place."));
      empty.append(quakeExamples());
      const b = map.getBounds();
      const cells = visibleCells();
      empty.append(howOftenSection(grData, {
        from: state.from, to: state.to, cells,
        areaLabel: cells === null ? "all of Japan" : `the visible map area (${cells.size} 2° squares)`,
        open: state.howOpen, onToggle: (open) => { state.howOpen = open; },
      }));
      const quakes = store.features(yearStart(state.from), yearEnd(state.to), 5).features.filter((f) => {
        if (cells === null) return true; // "all of Japan": not just what fits on screen
        const [lon, lat] = f.geometry.coordinates;
        return lon >= b.getWest() && lon <= b.getEast() && lat >= b.getSouth() && lat <= b.getNorth();
      });
      empty.append(destructiveList({
        quakes, period: state.from === state.to ? `${state.from}` : `${state.from}–${state.to}`,
        areaLabel: cells === null ? "all of Japan" : "the visible map area", open: state.dmgOpen,
        onToggle: (open) => { state.dmgOpen = open; syncDestructive(); },
        onSelect: (f) => select({ props: f.properties, coords: f.geometry.coordinates as [number, number] }),
      }));
    }
    renderQuake($("pane-quake-body"), state.selected?.props ?? null, state.selected?.coords, footprint, empty ?? extra);
  }
}


let moveTimer = 0;
map.on("moveend", () => { clearTimeout(moveTimer); moveTimer = window.setTimeout(renderPanel, 200); });
new ResizeObserver(() => { clearTimeout(moveTimer); moveTimer = window.setTimeout(renderPanel, 150); }).observe($("panel"));

// Theme changes: swap basemap flavour and re-add the quake layers.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", async () => {
  const { style: next } = await basemapStyle(isDark());
  // A diffed setStyle may keep the old style object and skip "style.load" while still dropping
  // our sources, so replace the style outright and listen before starting.
  map.once("style.load", addQuakeLayers);
  map.setStyle(next, { diff: false });
  renderLegend();
  renderPanel();
  if (in3d()) draw3d();
});

// Legend for the map symbols (depth colours, sizes).
function renderLegend() {
  const t = theme();
  const host = $("map-legend");
  const layers = el("div", "lg-row lg-lines");
  layers.append(el("span", "lg-title", "Layers"));
  const toggle = el("label", "lg-key lg-toggle");
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = overlays.plates;
  cb.addEventListener("change", () => setOverlay("plates", cb.checked));
  const solid = el("span", "lg-line"); solid.style.borderTop = `2px solid ${t.text}`;
  const dashed = el("span", "lg-line"); dashed.style.borderTop = `1px dashed ${t.text}`; dashed.style.opacity = "0.6";
  toggle.append(cb, document.createTextNode("Plate boundaries "), solid, document.createTextNode("trench "), dashed, document.createTextNode("other"));
  const slabToggle = el("label", "lg-key lg-toggle");
  const cb2 = document.createElement("input");
  cb2.type = "checkbox"; cb2.checked = overlays.slabs;
  cb2.addEventListener("change", () => setOverlay("slabs", cb2.checked));
  const slabLine = el("span", "lg-line"); slabLine.style.borderTop = `2px solid ${t.depth[2]}`;
  slabToggle.append(cb2, document.createTextNode("Sinking plate depth "), slabLine);
  const tremorToggle = el("label", "lg-key lg-toggle lg-tremor"); // map only: hidden in 3D
  tremorToggle.title = "Weak, deep tremor from the plates slowly slipping (JMA's low-frequency earthquakes)";
  const cb3 = document.createElement("input");
  cb3.type = "checkbox"; cb3.checked = overlays.tremor;
  cb3.addEventListener("change", () => setOverlay("tremor", cb3.checked));
  const tremorDot = el("span", "lg-dot"); tremorDot.style.background = t.series[1];
  tremorToggle.append(cb3, document.createTextNode("Slow-slip tremor "), tremorDot);
  layers.append(toggle, slabToggle, tremorToggle);
  const depth = el("div", "lg-row lg-depth");
  depth.append(el("span", "lg-title", "Depth"));
  DEPTH_LABELS.forEach((label, i) => {
    const k = el("span", "lg-key");
    const dot = el("span", "lg-dot"); dot.style.background = t.depth[i];
    k.append(dot, document.createTextNode(label));
    depth.append(k);
  });
  const size = el("div", "lg-row lg-size");
  size.append(el("span", "lg-title", "Size"));
  for (const [m, r] of [[3, 1.6], [5, 3.6], [7, 9]] as const) {
    const k = el("span", "lg-key");
    const dot = el("span", "lg-dot hollow"); dot.style.width = dot.style.height = `${r * 2 * 1.4}px`;
    k.append(dot, document.createTextNode(`M${m}`));
    size.append(k);
  }
  // A place on the Shaking tab hides the depth-coloured quakes: only the shindo colours apply.
  const rows = state.tab === "shaking" && loc.place ? [size, layers] : [depth, size, layers];
  if ((footprint.status === "ok" && !state.anim) || (state.tab === "shaking" && loc.place !== null)) {
    const shindo_ = shindoColors();
    const fr = el("div", "lg-row lg-shindo");
    const title = el("span", "lg-title", "Shindo");
    title.title = "How strongly the ground shook at each station (JMA scale). Hover a level for what it feels like.";
    fr.append(title);
    CLASSES.forEach((c, i) => {
      const k = el("span", "lg-key");
      k.title = shindoFeel(i);
      const dot = el("span", "lg-dot"); dot.style.background = shindo_[i];
      k.append(dot, document.createTextNode(c.label));
      fr.append(k);
    });
    rows.unshift(fr);
  }
  // The squares on the Forecast and Shaking tabs measure different things: name each one.
  const ramp = (title: string, tip: string, colors: string[], lo: string, hi: string) => {
    const r = el("div", "lg-row");
    const t_ = el("span", "lg-title", title); t_.title = tip;
    const bar = el("span", "lg-ramp");
    for (const c of colors) { const sw = el("span", "lg-swatch"); sw.style.background = c; bar.append(sw); }
    r.append(t_, el("span", "", lo), bar, el("span", "", hi));
    rows.unshift(r);
  };
  if (state.tab === "forecast") {
    ramp("Squares: chance of M5+ in 7 days", "Each half-degree square's forecast chance of at least one M5+ quake in the next 7 days",
      fcColors(), `<${fmtPct(P_EDGES[0])}`, `≥${fmtPct(P_EDGES[P_EDGES.length - 1])}`);
  } else if (state.tab === "shaking" && !loc.place && hot.cells.length) {
    ramp(`Squares: times per year at ${LEVELS[hot.level].label.replace(/ \(.*\)/, "")}`, "Average yearly count at the seismic stations in each square, over the timeline's years",
      hotColors(), fmtRate(hot.range[0]), fmtRate(hot.range[1]));
  }
  const btn = el("button", "lg-toggle-btn", legendOpen ? "Legend ▾" : "Legend ▸") as HTMLButtonElement;
  btn.type = "button";
  btn.setAttribute("aria-expanded", String(legendOpen));
  btn.addEventListener("click", () => { legendOpen = !legendOpen; renderLegend(); });
  host.replaceChildren(btn, ...(legendOpen ? rows : []));
}
// Open on wide screens; on a phone the legend would cover a quarter of the map.
let legendOpen = !narrow();

// A link pasted into a tab that already has the site open changes only the hash.
// (Our own updates use replaceState, which doesn't fire this.)
window.addEventListener("hashchange", () => {
  const h = parseHash(location.hash, TABS, store.index.years);
  missingQuake = null; // a note about an earlier link
  if (state.anim) stop();
  const [y0, y1] = store.index.years;
  const [from, to] = h.from !== undefined ? [h.from, h.to!] : [y0, y1];
  const minMag = h.minMag ?? 5;
  if (from !== state.from || to !== state.to || minMag !== state.minMag) {
    state.from = from; state.to = to; state.minMag = minMag;
    $<HTMLSelectElement>("min-mag").value = String(minMag);
    syncTimeline(); refreshData();
  }
  if (h.view) map.jumpTo({ center: [h.view.lon, h.view.lat], zoom: h.view.zoom });
  state.view3d = !!h.view3d;
  setTab(h.tab ?? "quake");
  if (h.quake && h.quake !== state.selected?.props.id) restoreQuake(h.quake);
  else if (!h.quake && state.selected) select(null);
});

renderLegend();
renderIntro();
syncTimeline();
$<HTMLSelectElement>("min-mag").value = String(state.minMag);
state.view3d = !!fromUrl.view3d;
setTab(fromUrl.tab ?? "quake");
// Sources, in the About box (header button). Attribution as JMA's terms of use ask: the
// source named and linked, and a note that the data has been processed. The
// map's attribution control repeats the short form.
{
  const link = (href: string, text: string) => {
    const a = document.createElement("a");
    a.href = href; a.textContent = text; a.target = "_blank"; a.rel = "noopener";
    return a;
  };
  const p = (...kids: (string | Node)[]) => { const x = el("p"); x.append(...kids); return x; };
  const li = (...kids: (string | Node)[]) => { const x = el("li"); x.append(...kids); return x; };
  const ul = (...items: HTMLElement[]) => { const x = el("ul"); x.append(...items); return x; };
  const { years, prelimFrom, dataEnd } = store.index;
  const final = prelimFrom ? `${years[0]}–${yearOf(prelimFrom) - 1}` : `${years[0]}–${years[1]}`;
  $("about-sources").replaceChildren(
    el("h4", "", "Earthquake data"),
    p("出典：", link(JMA_HOME, "気象庁ホームページ"), " (Japan Meteorological Agency):"),
    ul(
      li(link(JMA_BULLETIN, "Seismological Bulletin of Japan"), ` (地震月報（カタログ編）), ${final}`),
      ...(prelimFrom
        ? [li(link(JMA_DAILY, "daily hypocentre lists"), ", the ", link(JMA_EQDB, "intensity database"),
            " (震度データベース) and ", link(JMA_LIVE, "earthquake information"),
            `, ${yearOf(prelimFrom)} to ${fmtDate(dataEnd)}, marked "Preliminary" on this site`)]
        : []),
    ),
    p("地震月報（カタログ編）・震度データベース等（気象庁）を加工して作成。 The data has been processed for this site: " +
      "the maps, counts, statistics and forecasts here are this site's own work, not JMA's."),
    el("h4", "", "Map and overlays"),
    ul(
      li("Basemap: © ", link("https://www.openstreetmap.org/copyright", "OpenStreetMap contributors"),
        " (ODbL), tiles made with ", link("https://protomaps.com", "Protomaps")),
      li("Coastline when the map tiles are missing: ", link("https://www.naturalearthdata.com", "Natural Earth")),
      li("Depth of the sinking plates: ", link("https://doi.org/10.5066/F7PV6JNV", "USGS Slab2"), " (Hayes, 2018)"),
      li("Plate boundaries: ", link("https://doi.org/10.1029/2001GC000252", "PB2002"), " (Bird, 2003), ODC-By"),
      li("Source areas of the great trench quakes: ", link("https://www.j-shis.bosai.go.jp/", "J-SHIS"),
        " (防災科学技術研究所 NIED), seismic activity model 2024, outlines simplified by this site"),
    ),
  );
  const dlg = $<HTMLDialogElement>("about");
  $("about-btn").addEventListener("click", () => dlg.showModal());
  $("about-close").addEventListener("click", () => dlg.close());
  // A click on the backdrop (outside the box) closes it too.
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
}
