import { Map as MLMap, NavigationControl, setWorkerUrl, type ExpressionSpecification, type GeoJSONSource } from "maplibre-gl";
// MapLibre finds its worker relative to its own file, which bundling breaks;
// let Vite bundle the worker and hand MapLibre the resulting URL.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { basemapStyle } from "./basemap";
import type { GrData } from "./gr";
import { cellsInBounds, renderMagnitudes, type MagSelection } from "./panel-magnitudes";
import { renderQuake } from "./panel-quake";
import { MAX_YEARS_FOR_M3, QuakeStore, yearEnd, yearOf, yearStart, yearsNeeded, type QuakeProps } from "./quakes";
import { $, el, fmt, hideTooltip, isDark, showTooltip, theme } from "./ui";

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

// Depth classes. The edges match the slab contours drawn by the overlay
// (pipeline/build/overlays.py SLAB_DEPTHS), so a contour is a colour boundary.
const DEPTH_EDGES = [40, 100, 200, 300];
const DEPTH_LABELS = ["0–40", "40–100", "100–200", "200–300", "300+ km"];

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
  map.addLayer({
    id: "selected", type: "circle", source: "quakes", filter: ["==", ["get", "id"], ""],
    paint: { "circle-radius": radiusPlus(4), "circle-color": "transparent", "circle-stroke-color": theme().text, "circle-stroke-width": 2 },
  });
  refreshData();
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
  const f = e.features?.[0];
  if (!f) return;
  const props = f.properties as unknown as QuakeProps;
  // GeoJSON properties come back from the worker as plain values; null may arrive as the string "null".
  const num = (v: unknown) => (v === null || v === "null" || v === undefined ? null : Number(v));
  state.selected = {
    props: { ...props, mag: num(props.mag), depth: num(props.depth), felt: String(props.felt) === "true", t: Number(props.t) },
    coords: (f.geometry as GeoJSON.Point).coordinates as [number, number],
  };
  map.setFilter("selected", ["==", ["get", "id"], props.id]);
  setTab("quake");
});

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
  loadedRange = [lo, hi];
  applyTimeFilter();
  updateStatus(fc.features.length, minMag);
}
let loadedRange: [number, number] = [0, 0];

function applyTimeFilter() {
  if (!map.getLayer("quakes")) return;
  if (state.anim) {
    const lo = state.playhead - state.trail;
    const hi = state.playhead;
    map.setFilter("quakes", ["all", [">=", ["get", "t"], lo], ["<=", ["get", "t"], hi]]);
    map.setPaintProperty("quakes", "circle-opacity", ["interpolate", ["linear"], ["get", "t"], lo, 0.08, hi, 0.95]);
  } else {
    map.setFilter("quakes", null);
    map.setPaintProperty("quakes", "circle-opacity", 0.7);
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
  if (e.key === "Escape" && state.anim) stop();
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
  } else if (state.tab === "quake") {
    renderQuake($("pane-quake-body"), state.selected?.props ?? null, state.selected?.coords);
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
  host.replaceChildren(depth, size, layers);
}

renderLegend();
syncTimeline();
setTab("magnitudes");
$("source").textContent = `Data: JMA Seismological Bulletin of Japan, ${store.index.years[0]}–${store.index.years[1]}.`;
