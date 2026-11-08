import { Map as MLMap, NavigationControl, setWorkerUrl, type ExpressionSpecification, type GeoJSONSource } from "maplibre-gl";
// MapLibre finds its worker relative to its own file, which bundling breaks;
// let Vite bundle the worker and hand MapLibre the resulting URL.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { basemapStyle } from "./basemap";
import type { GrData } from "./gr";
import { cellsInBounds, renderMagnitudes, type MagSelection } from "./panel-magnitudes";
import { renderQuake, type Footprint } from "./panel-quake";
import { renderAftershocks, type AftershockState } from "./panel-aftershocks";
import { DAY, FORESHOCK_DAYS, MIN_MAINSHOCK, WINDOW_DAYS, sequence, type Shock } from "./aftershocks";
import { PRESETS, renderDepth } from "./panel-depth";
import { PLACES, renderLocation, type Place } from "./panel-location";
import { LocationStore, type FeltQuake, type NearbyStation } from "./location";
import { swath, type LonLat, type Section } from "./section";
import { Marker } from "maplibre-gl";
import { CLASSES, CLASS_COLORS, classOf, ShindoStore } from "./shindo";
import { MAX_YEARS_FOR_M3, QuakeStore, yearEnd, yearOf, yearStart, yearsNeeded, type QuakeProps } from "./quakes";
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
  magMode: "single" as MagSelection["mode"],
  tab: "magnitudes",
  selected: null as { props: QuakeProps; coords: [number, number] } | null,
};

const store = new QuakeStore();
const [grData] = await Promise.all([fetch("./data/gr.json").then((r) => r.json() as Promise<GrData>), store.init()]);
[state.from, state.to] = store.index.years;

// ------------------------------------------------------------------ map ---

setWorkerUrl(maplibreWorkerUrl);

const box = grData.box;
const { style, tiles } = await basemapStyle(isDark());
const map = new MLMap({
  container: "map",
  style,
  bounds: [[box.lon_min, box.lat_min], [box.lon_max, box.lat_max]],
  fitBoundsOptions: { padding: 20 },
  minZoom: 3,
  maxZoom: 11,
  attributionControl: { compact: true },
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
  addSectionLayers();
  addLocationLayers();
  map.addLayer({
    id: "selected", type: "circle", source: "quakes", filter: ["==", ["get", "id"], ""],
    paint: { "circle-radius": radiusPlus(4), "circle-color": "transparent", "circle-stroke-color": theme().text, "circle-stroke-width": 2 },
  });
  if (state.selected) map.setFilter("selected", ["==", ["get", "id"], state.selected.props.id]);
  refreshData();
  showFootprint(); // after a style change the source starts empty
  drawSection();
  drawLocation();
}

const fitJapan = () => map.fitBounds([[box.lon_min, box.lat_min], [box.lon_max, box.lat_max]], { padding: 20, duration: 0 });
map.on("load", () => {
  // The container may have been sized before the panel layout settled.
  map.resize();
  fitJapan();
  addQuakeLayers();
});

// ------------------------------------------------------------- overlays ---

const overlays = { plates: true, slabs: true };
const OVERLAY_LAYERS: Record<keyof typeof overlays, string[]> = {
  plates: ["plates-other", "plates-sub", "plates-hit"],
  slabs: ["slabs", "slabs-label", "slabs-hit"],
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
}

const KIND_LABEL: Record<string, string> = {
  subduction: "Subduction zone (trench)", convergent: "Convergent boundary", transform: "Transform boundary",
  spreading: "Spreading ridge", rift: "Rift",
};
const overQuake = (p: { x: number; y: number }) => map.queryRenderedFeatures([p.x, p.y], { layers: ["quakes"] }).length > 0;
map.on("mousemove", "plates-hit", (e) => {
  if (overQuake(e.point)) return; // quakes win
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
  if (overQuake(e.point) || map.queryRenderedFeatures([e.point.x, e.point.y], { layers: ["plates-hit"] }).length) return;
  const f = e.features?.[0];
  if (!f) return;
  const p = f.properties as { depth: number; plate: string };
  showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, (tip) => {
    tip.append(el("div", "t-head", "Slab depth contour"));
    tip.append(el("div", "", `Top of the ${p.plate} is ${p.depth} km down here`));
  });
});
map.on("mouseleave", "slabs-hit", hideTooltip);

map.on("mousemove", "quakes", (e) => {
  map.getCanvas().style.cursor = "pointer";
  const f = e.features?.[0];
  if (!f) return;
  const p = f.properties as unknown as QuakeProps;
  showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, (tip) => {
    tip.append(el("div", "t-head", new Date((p.t + 9 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " ") + " JST"));
    const r = el("div", "t-row");
    r.append(el("span", "", p.mag === null ? "magnitude unknown" : `M${Number(p.mag).toFixed(1)}`),
      el("strong", "", p.depth === null || p.depth === undefined ? "" : `${Math.round(Number(p.depth))} km deep`));
    tip.append(r, el("div", "t-head", "Click for details"));
  });
});
map.on("mouseleave", "quakes", () => { map.getCanvas().style.cursor = ""; hideTooltip(); });
map.on("click", "quakes", (e) => {
  if (sectionState.drawing || loc.picking) return; // clicks place points instead
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
let selectToken = 0;

function footprintColor(): ExpressionSpecification {
  const m: (string | number)[] = [];
  CLASS_COLORS.forEach((c, i) => m.push(i, c));
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

async function select(sel: typeof state.selected) {
  stopReplay();
  const token = ++selectToken;
  state.selected = sel;
  map.setFilter("selected", ["==", ["get", "id"], sel?.props.id ?? ""]);
  footprint = sel?.props.felt ? { status: "loading" } : { status: "none" };
  showFootprint();
  setTab("quake");
  if (sel) loadAftershocks(sel, token);
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
  aftershocks = { status: "ok", main, seq: sequence(main, shocks), dataEnd: yearEnd(store.index.years[1]) };
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
  const fc = store.features(lo, hi, minMag);
  (map.getSource("quakes") as GeoJSONSource).setData(fc);
  shownQuakes = fc.features;
  shownMinMag = minMag;
  if (state.tab === "depth") renderPanel();
  loadedRange = [lo, hi];
  applyTimeFilter();
  updateStatus(fc.features.length, minMag);
}
let loadedRange: [number, number] = [0, 0];
let shownQuakes: GeoJSON.Feature<GeoJSON.Point, QuakeProps>[] = [];
let shownMinMag = 5;

// --------------------------------------------------------- depth section ---

const sectionState = {
  section: PRESETS[0].section as Section | null,
  drawing: false,
  first: null as LonLat | null,
};
const overlayData: { slabs: GeoJSON.FeatureCollection | null; plates: GeoJSON.FeatureCollection | null } = { slabs: null, plates: null };
Promise.all([
  fetch("./data/overlays/slabs.json").then((r) => r.json()),
  fetch("./data/overlays/plates.json").then((r) => r.json()),
]).then(([slabs, plates]) => { overlayData.slabs = slabs; overlayData.plates = plates; if (state.tab === "depth") renderPanel(); });

const markerEl = (label: string) => { const d = el("div", "section-marker", label); return d; };
const markers = { a: new Marker({ element: markerEl("A") }), b: new Marker({ element: markerEl("B") }) };

function addSectionLayers() {
  map.addSource("section", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "section-swath", type: "fill", source: "section", filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": theme().text, "fill-opacity": 0.06 } });
  map.addLayer({ id: "section-line", type: "line", source: "section", filter: ["==", ["geometry-type"], "LineString"],
    paint: { "line-color": theme().text, "line-width": 2, "line-dasharray": [2, 1] } });
}

function drawSection() {
  const src = map.getSource("section") as GeoJSONSource | undefined;
  const s = sectionState.section;
  const visible = state.tab === "depth";
  if (src) {
    src.setData({
      type: "FeatureCollection",
      features: visible && s ? [
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [swath(s)] } },
        { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [s.a, s.b] } },
      ] : [],
    });
  }
  const a = visible ? (sectionState.drawing ? sectionState.first : s?.a) : null;
  const b = visible && !sectionState.drawing ? s?.b : null;
  if (a) markers.a.setLngLat(a).addTo(map); else markers.a.remove();
  if (b) markers.b.setLngLat(b).addTo(map); else markers.b.remove();
}

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
  map.addLayer({ id: "place-felt", type: "circle", source: "place", filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": radius, "circle-color": footprintColor(), "circle-opacity": 0.85,
      "circle-stroke-color": theme().text, "circle-stroke-width": 0.4,
    },
    layout: { "circle-sort-key": ["get", "k"] } });
}

function drawLocation() {
  const src = map.getSource("place") as GeoJSONSource | undefined;
  const visible = state.tab === "location" && loc.place !== null;
  if (src) {
    src.setData({
      type: "FeatureCollection",
      features: visible ? [
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circle(loc.place!.lonlat, loc.radiusKm)] } },
        ...loc.quakes.filter((q) => q.lat !== null && q.cls >= 0).map((q) => ({
          type: "Feature" as const, properties: { k: q.cls, mag: q.mag },
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
  loc.status = place ? "loading" : "idle";
  loc.quakes = []; loc.stations = [];
  drawLocation(); renderPanel();
  if (!place) return;
  const stations = await shindo.loadStations();
  const r = await locStore.query(stations, place.lonlat[0], place.lonlat[1], loc.radiusKm);
  if (token !== locToken) return;
  Object.assign(loc, { status: "ok", quakes: r.quakes, stations: r.stations });
  drawLocation(); renderPanel();
}

map.on("click", (e) => {
  if (!loc.picking) return;
  setPlace({ name: `${e.lngLat.lat.toFixed(2)}°N, ${e.lngLat.lng.toFixed(2)}°E`, lonlat: [e.lngLat.lng, e.lngLat.lat] });
});

map.on("click", (e) => {
  if (!sectionState.drawing) return;
  const p: LonLat = [e.lngLat.lng, e.lngLat.lat];
  if (!sectionState.first) {
    sectionState.first = p;
  } else {
    sectionState.section = { a: sectionState.first, b: p, halfWidthKm: sectionState.section?.halfWidthKm ?? 50 };
    sectionState.drawing = false;
    sectionState.first = null;
    map.getCanvas().style.cursor = "";
  }
  drawSection();
  renderPanel();
});

function applyTimeFilter() {
  if (!map.getLayer("quakes")) return;
  if (state.anim) {
    const lo = state.playhead - state.trail;
    const hi = state.playhead;
    map.setFilter("quakes", ["all", [">=", ["get", "t"], lo], ["<=", ["get", "t"], hi]]);
    map.setPaintProperty("quakes", "circle-opacity", ["interpolate", ["linear"], ["get", "t"], lo, 0.08, hi, 0.95]);
  } else {
    map.setFilter("quakes", null);
    const dim = footprint.status === "ok" || (state.tab === "location" && loc.place !== null);
    map.setPaintProperty("quakes", "circle-opacity", dim ? 0.15 : 0.7);
  }
}

function updateStatus(n: number, minMag: number) {
  const years = state.to - state.from + 1;
  $("status").textContent = state.anim ? "" : `${fmt(n)} quakes M${minMag}+ shown`;
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
  $("range-label").textContent = state.from === state.to ? `${state.from}` : `${state.from}–${state.to}`;
  const span = store.index.years[1] - store.index.years[0];
  const pct = (y: number) => ((y - store.index.years[0]) / span) * 100;
  const fill = $("range-fill");
  fill.style.left = `${pct(state.from)}%`;
  fill.style.width = `${pct(state.to) - pct(state.from)}%`;
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
  refreshData();
});
$<HTMLSelectElement>("trail").addEventListener("change", (e) => {
  state.trail = Number((e.target as HTMLSelectElement).value);
  if (state.anim) { refreshData(); applyTimeFilter(); }
});

let raf = 0;
let lastFrame = 0;
let lastYear = 0;
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
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (state.selected) select(null);
  else if (state.anim) stop();
});

// ---------------------------------------------------------------- panel ---

const TABS = ["magnitudes", "depth", "quake", "location"];

function setTab(tab: string) {
  state.tab = tab;
  document.body.classList.remove("panel-closed");
  for (const t of TABS) {
    const btn = $(`tab-${t}`);
    btn.setAttribute("aria-selected", String(t === tab));
    btn.tabIndex = t === tab ? 0 : -1;
    $(`pane-${t}`).hidden = t !== tab;
  }
  renderPanel();
  drawSection();
  drawLocation();
  map.resize();
}
for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => setTab(t));
$("tabs").addEventListener("keydown", (e) => {
  const i = TABS.indexOf(state.tab);
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next);
    $(`tab-${next}`).focus();
  }
});
$("panel-toggle").addEventListener("click", () => {
  document.body.classList.toggle("panel-closed");
  $("panel-toggle").setAttribute("aria-expanded", String(!document.body.classList.contains("panel-closed")));
  setTimeout(() => map.resize(), 0);
});

function visibleCells() {
  const b = map.getBounds();
  return cellsInBounds(grData, b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
}

function renderPanel() {
  if (document.body.classList.contains("panel-closed")) return;
  if (state.tab === "magnitudes") {
    const host = $("mag-body");
    const cells = visibleCells();
    const areaLabel = cells === null ? "all of Japan" : `the visible map area (${cells.size} 2° squares)`;
    renderMagnitudes(host, grData, { from: state.from, to: state.to, cells, areaLabel, mode: state.magMode });
  } else if (state.tab === "depth") {
    const years = state.from === state.to ? `${state.from}` : `${state.from}–${state.to}`;
    renderDepth($("pane-depth"), {
      section: sectionState.section,
      quakes: state.anim ? [] : shownQuakes,
      slabs: (overlayData.slabs?.features ?? []) as never,
      plates: (overlayData.plates?.features ?? []) as never,
      drawing: sectionState.drawing,
      scopeNote: state.anim
        ? "Paused playback shows only part of the period; press Esc to return to the full range."
        : `Showing M${shownMinMag}+ quakes from ${years}, as on the map. ` +
          (shownMinMag >= 5 ? `For M3+, narrow the timeline to ${MAX_YEARS_FOR_M3} years or less and choose M3+.` : ""),
      onPreset: (p) => {
        sectionState.section = { ...p.section, halfWidthKm: sectionState.section?.halfWidthKm ?? p.section.halfWidthKm };
        sectionState.section.a = p.section.a; sectionState.section.b = p.section.b;
        sectionState.drawing = false; sectionState.first = null;
        drawSection(); renderPanel();
        const s = sectionState.section;
        map.fitBounds([[Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1])], [Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])]], { padding: 80, maxZoom: 7 });
      },
      onDraw: () => {
        sectionState.drawing = !sectionState.drawing;
        sectionState.first = null;
        map.getCanvas().style.cursor = sectionState.drawing ? "crosshair" : "";
        drawSection(); renderPanel();
      },
      onWidth: (km) => {
        if (sectionState.section) sectionState.section = { ...sectionState.section, halfWidthKm: km };
        drawSection(); renderPanel();
      },
      onSelect: (f) => select({ props: f.properties, coords: f.geometry.coordinates as [number, number] }),
    });
  } else if (state.tab === "location") {
    renderLocation($("pane-location"), {
      ...loc,
      allStations: shindo.stations,
      years: store.index.years,
      onPlace: (p) => { setPlace(p); map.flyTo({ center: p.lonlat, zoom: 7 }); },
      onPick: () => { loc.picking = !loc.picking; map.getCanvas().style.cursor = loc.picking ? "crosshair" : ""; renderPanel(); },
      onGeolocate: () => {
        navigator.geolocation?.getCurrentPosition(
          (pos) => { const p: Place = { name: "your location", lonlat: [pos.coords.longitude, pos.coords.latitude] }; setPlace(p); map.flyTo({ center: p.lonlat, zoom: 7 }); },
          () => { $("pane-location").append(el("p", "note", "Location unavailable: the browser didn't share it.")); },
          { maximumAge: 600000, timeout: 10000 },
        );
      },
      onRadius: (km) => { loc.radiusKm = km; setPlace(loc.place); },
      onSelectQuake: (q) => {
        const f = shownQuakes.find((x) => x.properties.id === q.id);
        const props: QuakeProps = f ? f.properties
          : { t: q.t, mag: q.mag, depth: q.depth, shindo: "", cls: "", felt: true, id: q.id };
        select({ props, coords: [q.lon!, q.lat!] });
      },
    });
  } else if (state.tab === "quake") {
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
          `(${P_KMS} and ${S_KMS} km/s) for comparison.` + (missing ? ` ${fmt(missing)} readings have no recorded time and are left out.` : "")), rb);
      }
    }
    if (state.selected) extra.append(renderAftershocks(aftershocks, $("pane-quake").clientWidth), clear);
    renderQuake($("pane-quake-body"), state.selected?.props ?? null, state.selected?.coords, footprint,
      state.selected ? extra : undefined);
  }
}

for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mag-mode"]')) {
  r.addEventListener("change", () => { state.magMode = r.value as MagSelection["mode"]; renderPanel(); });
}

let moveTimer = 0;
map.on("moveend", () => { clearTimeout(moveTimer); moveTimer = window.setTimeout(renderPanel, 200); });
new ResizeObserver(() => { clearTimeout(moveTimer); moveTimer = window.setTimeout(renderPanel, 150); }).observe($("panel"));

// Theme changes: swap basemap flavour and re-add the quake layers.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", async () => {
  const { style: next } = await basemapStyle(isDark());
  map.setStyle(next);
  map.once("style.load", addQuakeLayers);
  renderPanel();
});

// Legend for the map symbols (depth colours, sizes).
function renderLegend() {
  const t = theme();
  const host = $("map-legend");
  const layers = el("div", "lg-row");
  layers.append(el("span", "lg-title", "Lines"));
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
  layers.append(toggle, slabToggle);
  const depth = el("div", "lg-row");
  depth.append(el("span", "lg-title", "Depth"));
  DEPTH_LABELS.forEach((label, i) => {
    const k = el("span", "lg-key");
    const dot = el("span", "lg-dot"); dot.style.background = t.depth[i];
    k.append(dot, document.createTextNode(label));
    depth.append(k);
  });
  const size = el("div", "lg-row");
  size.append(el("span", "lg-title", "Size"));
  for (const [m, r] of [[3, 1.6], [5, 3.6], [7, 9]] as const) {
    const k = el("span", "lg-key");
    const dot = el("span", "lg-dot hollow"); dot.style.width = dot.style.height = `${r * 2 * 1.4}px`;
    k.append(dot, document.createTextNode(`M${m}`));
    size.append(k);
  }
  const rows = [depth, size, layers];
  if (footprint.status === "ok" || (state.tab === "location" && loc.place !== null)) {
    const fr = el("div", "lg-row");
    fr.append(el("span", "lg-title", "Shindo"));
    CLASSES.forEach((c, i) => {
      const k = el("span", "lg-key");
      const dot = el("span", "lg-dot"); dot.style.background = CLASS_COLORS[i];
      k.append(dot, document.createTextNode(c.label));
      fr.append(k);
    });
    rows.unshift(fr);
  }
  host.replaceChildren(...rows);
}

renderLegend();
syncTimeline();
setTab("magnitudes");
$("source").textContent = `Data: JMA Seismological Bulletin of Japan, ${store.index.years[0]}–${store.index.years[1]}.`;
