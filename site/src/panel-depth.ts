// Depth tab: a cross-section through the quakes along a line drawn on the map,
// with the top of the sinking plate (Slab2) and trench crossings (PB2002).
import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import type { QuakeProps } from "./quakes";
import { crossings, inSection, landSpans, sectionLengthKm, type LonLat, type Section } from "./section";
import { depthClass, el, fmt, hideTooltip, showTooltip, theme } from "./ui";

export interface Preset { name: string; section: Section; note: string }

// Lines drawn roughly perpendicular to the trenches.
export const PRESETS: Preset[] = [
  { name: "Northern Honshu", note: "Pacific plate under Tōhoku, from the Japan Trench westward",
    section: { a: [144.8, 38.6], b: [138.2, 40.0], halfWidthKm: 50 } },
  { name: "Kantō", note: "Two plates stacked under Tokyo: Philippine Sea above Pacific",
    section: { a: [143.0, 34.0], b: [138.0, 37.0], halfWidthKm: 50 } },
  { name: "Kyūshū", note: "Philippine Sea plate under Kyūshū, from the Ryukyu Trench",
    section: { a: [133.5, 30.3], b: [128.8, 33.6], halfWidthKm: 50 } },
  { name: "Izu–Bonin", note: "Pacific plate diving steeply under the Izu–Bonin arc",
    section: { a: [144.5, 29.0], b: [136.5, 29.6], halfWidthKm: 50 } },
  { name: "Hokkaidō", note: "Pacific plate under eastern Hokkaidō, from the Kuril Trench",
    section: { a: [148.0, 41.5], b: [141.0, 45.0], halfWidthKm: 50 } },
];

type LineFeature = GeoJSON.Feature<GeoJSON.MultiLineString | GeoJSON.LineString, Record<string, unknown>>;

export interface DepthInputs {
  section: Section | null;
  quakes: GeoJSON.Feature<GeoJSON.Point, QuakeProps>[];
  slabs: LineFeature[];
  plates: LineFeature[];
  land: LonLat[][][] | null; // coastline polygons, to mark land along the line (null while loading)
  drawing: boolean; // waiting for map clicks
  scopeNote: string; // which quakes are included (period, magnitude)
  onPreset(p: Preset): void;
  onDraw(): void;
  onWidth(km: number): void;
  onSelect(f: GeoJSON.Feature<GeoJSON.Point, QuakeProps>): void;
}

const lines = (f: LineFeature): LonLat[][] =>
  f.geometry.type === "MultiLineString" ? (f.geometry.coordinates as LonLat[][]) : [f.geometry.coordinates as LonLat[]];

// How a slice works: the band on the map (left) seen from the side (right). Colours follow the theme.
const DIAGRAM = `<svg class="depth-diagram" viewBox="0 0 344 124" role="img"
  aria-label="Left: a map with a line from A to B and a shaded band around it. Right: the quakes in the band seen from the side, sloping down from the trench under the land.">
  <text x="74" y="10" class="dg-t">On the map</text>
  <rect x="2" y="16" width="144" height="104" rx="6" style="fill: var(--map-sea)"/>
  <path d="M86 16 C70 40 76 70 92 92 C100 104 112 112 124 120 L146 120 L146 16 Z" style="fill: var(--map-land); stroke: var(--map-coast)"/>
  <path d="M30 16 C24 46 26 80 36 120" fill="none" stroke-width="2" style="stroke: var(--text-primary)"/>
  <polygon points="14,56 138,44 140,70 16,82" style="fill: var(--text-primary)" fill-opacity="0.1"/>
  <line x1="15" y1="69" x2="139" y2="57" stroke-width="1.5" stroke-dasharray="4 3" style="stroke: var(--text-primary)"/>
  <circle cx="15" cy="69" r="6" style="fill: var(--text-primary)"/><text x="15" y="72" class="dg-ab">A</text>
  <circle cx="139" cy="57" r="6" style="fill: var(--text-primary)"/><text x="139" y="60" class="dg-ab">B</text>
  <g style="fill: var(--depth-1)"><circle cx="40" cy="66" r="2.6"/><circle cx="52" cy="72" r="2.2"/><circle cx="60" cy="62" r="2.4"/></g>
  <g style="fill: var(--depth-3)"><circle cx="80" cy="66" r="2.4"/><circle cx="92" cy="60" r="2.2"/></g>
  <g style="fill: var(--depth-5)"><circle cx="112" cy="62" r="2.4"/><circle cx="124" cy="58" r="2.2"/></g>
  <g style="fill: var(--text-muted)" fill-opacity="0.5"><circle cx="58" cy="32" r="2"/><circle cx="104" cy="100" r="2"/><circle cx="48" cy="104" r="2"/></g>
  <text x="166" y="66" class="dg-arrow">→</text>
  <text x="264" y="10" class="dg-t">Seen from the side</text>
  <rect x="246" y="22" width="56" height="5" style="fill: var(--text-secondary)" fill-opacity="0.55"/>
  <text x="274" y="20" class="dg-s">land</text>
  <line x1="190" y1="28" x2="340" y2="28" style="stroke: var(--axis)"/>
  <path d="M214 20 l4 6 l4 -6 z" style="fill: var(--text-primary)"/>
  <text x="220" y="17" class="dg-s">trench</text>
  <text x="190" y="20" class="dg-abt">A</text><text x="340" y="20" class="dg-abt" text-anchor="end">B</text>
  <path d="M218 30 C254 44 292 70 334 116" fill="none" stroke-width="1.4" stroke-dasharray="5 3" style="stroke: var(--text-primary)"/>
  <g style="fill: var(--depth-1)"><circle cx="222" cy="36" r="2.6"/><circle cx="236" cy="42" r="2.2"/><circle cx="246" cy="38" r="2.4"/></g>
  <g style="fill: var(--depth-3)"><circle cx="268" cy="58" r="2.4"/><circle cx="280" cy="66" r="2.2"/></g>
  <g style="fill: var(--depth-5)"><circle cx="304" cy="84" r="2.4"/><circle cx="318" cy="98" r="2.2"/></g>
  <text x="194" y="116" class="dg-s" text-anchor="start">deeper ↓</text>
</svg>`;

export function renderDepth(host: HTMLElement, inp: DepthInputs) {
  const controls = el("div", "depth-controls");
  const presets = el("div", "presets");
  for (const p of PRESETS) {
    const b = el("button", "", p.name) as HTMLButtonElement;
    b.type = "button"; b.title = p.note;
    b.addEventListener("click", () => inp.onPreset(p));
    presets.append(b);
  }
  const draw = el("button", inp.drawing ? "primary" : "", inp.drawing ? "Click two points on the map…" : "Draw your own line") as HTMLButtonElement;
  draw.type = "button";
  draw.addEventListener("click", () => inp.onDraw());
  const width = document.createElement("select");
  for (const w of [25, 50, 100]) {
    const o = document.createElement("option");
    o.value = String(w); o.textContent = `±${w} km`;
    o.selected = inp.section?.halfWidthKm === w;
    width.append(o);
  }
  width.addEventListener("change", () => inp.onWidth(Number(width.value)));
  const wl = el("label", "inline", "Band ");
  wl.append(width);
  controls.append(presets, draw, wl);

  const diagram = el("div", "depth-diagram-wrap");
  diagram.innerHTML = DIAGRAM;
  const parts: HTMLElement[] = [el("h2", "", "Depth: a slice through the ground"),
    el("p", "sub", "Imagine cutting straight down through Japan along a line and looking at the cut face. This tab " +
      "takes the quakes in the shaded band on the map and shows them from the side: across is distance along the " +
      "line from A to B, down is how deep each quake was."),
    diagram,
    el("p", "sub", "Off Japan's coasts, ocean plates dive under the islands at the trenches. Many quakes happen along " +
      "the top of the sinking plate, so in a slice across a trench they form a band sloping down from the trench, " +
      "under the land and on into the mantle. The dashed line is the top of the plate as mapped by scientists " +
      "(USGS Slab2). Each preset below crosses a trench at right angles; the clearest is Northern Honshu."),
    controls];
  if (!inp.section) {
    parts.push(el("p", "sub", "Choose a preset or draw a line on the map."));
    host.replaceChildren(...parts);
    return;
  }
  const preset = PRESETS.find((p) => p.section.a === inp.section!.a && p.section.b === inp.section!.b);
  if (preset) parts.push(el("p", "note", preset.note));
  parts.push(...sectionPlot(inp, host.clientWidth));
  parts.push(el("p", "sub", inp.scopeNote));
  host.replaceChildren(...parts);
}

function sectionPlot(inp: DepthInputs, hostWidth: number): HTMLElement[] {
  const t = theme();
  const s = inp.section!;
  const L = sectionLengthKm(s);
  const pts = inSection(s, inp.quakes, (f) => f.geometry.coordinates as LonLat)
    .filter((r) => r.item.properties.depth !== null)
    .map((r) => ({ along: r.along, depth: r.item.properties.depth as number, mag: r.item.properties.mag ?? 3, f: r.item }));

  // Top of the sinking plate: where the line crosses each Slab2 contour.
  const slabPts: { along: number; depth: number; slab: string }[] = [];
  const plateName = new Map<string, string>();
  for (const f of inp.slabs) {
    plateName.set(String(f.properties.slab), String(f.properties.plate ?? "").replace(/ \(.*\)$/, "") || "plate");
    for (const ln of lines(f)) for (const a of crossings(s, ln)) {
      slabPts.push({ along: a, depth: Number(f.properties.depth), slab: String(f.properties.slab) });
    }
  }
  // Trenches crossed by the line.
  const trenches: { along: number; label: string }[] = [];
  for (const f of inp.plates) {
    if (f.properties.kind !== "subduction") continue;
    for (const ln of lines(f)) for (const a of crossings(s, ln)) trenches.push({ along: a, label: String(f.properties.label) });
  }

  const maxD = Math.max(100, Math.ceil(Math.max(d3.max(pts, (p) => p.depth) ?? 0, d3.max(slabPts, (p) => p.depth) ?? 0) / 100) * 100);
  const w = Math.max(280, hostWidth - 32);
  const plotW = w - 56;
  const trueH = (maxD / L) * plotW;
  const plotH = Math.max(180, Math.min(420, trueH));
  const exaggeration = plotH / trueH;
  const r = d3.scaleSqrt().domain([3, 9]).range([1.5, 9]).clamp(true);

  const land = inp.land ? landSpans(s, inp.land) : [];
  const px = maxD / plotH; // km of depth per pixel, to draw marks a few pixels above the surface
  const marks: Plot.Markish[] = [
    Plot.rect(land, { x1: (d) => d[0], x2: (d) => d[1], y1: () => 0, y2: () => -6 * px, fill: t.secondary, fillOpacity: 0.55 }),
    Plot.ruleY([0], { stroke: t.axis }),
    Plot.dot(pts, { x: "along", y: "depth", r: (d) => r(d.mag), fill: (d) => t.depth[depthClass(d.depth)], fillOpacity: 0.75,
      stroke: t.surface, strokeWidth: 0.5, sort: { channel: "r" } }),
  ];
  for (const slab of new Set(slabPts.map((p) => p.slab))) {
    const ps = slabPts.filter((p) => p.slab === slab).sort((a, b) => a.depth - b.depth);
    marks.push(Plot.line(ps, { x: "along", y: "depth", stroke: t.text, strokeWidth: 1.5, strokeDasharray: "6 3", curve: "catmull-rom" }));
    // Name the plate at the middle of its line, above-left of it, clear of both edges.
    const mid = ps[Math.floor(ps.length / 2)];
    marks.push(Plot.text([mid], { x: "along", y: "depth", text: () => `top of the sinking ${plateName.get(slab) ?? "plate"}`,
      dx: -8, dy: -8, textAnchor: "end", fill: t.secondary, fontSize: 10, stroke: t.surface, strokeWidth: 3, paintOrder: "stroke" }));
  }
  marks.push(
    Plot.dot(trenches, { x: "along", y: () => 0, symbol: "triangle", r: 5, fill: t.text, rotate: 180, dy: -6 }),
    Plot.text(trenches, { x: "along", y: () => 0, text: () => "trench", dy: -16, fill: t.secondary, fontSize: 10 }),
    Plot.text([0], { x: (d) => d, y: () => 0, text: () => "A", textAnchor: "start", dy: -18, fill: t.text, fontWeight: 700, fontSize: 12 }),
    Plot.text([L], { x: (d) => d, y: () => 0, text: () => "B", textAnchor: "end", dy: -18, fill: t.text, fontWeight: 700, fontSize: 12 }),
  );
  if (land.length) {
    const widest = land.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
    marks.push(Plot.text([widest], { x: (d) => (d[0] + d[1]) / 2, y: () => -6 * px, text: () => "land", dy: -7,
      fill: t.secondary, fontSize: 10 }));
  }

  const svg = Plot.plot({
    width: w, height: plotH + 64, marginLeft: 44, marginRight: 12, marginTop: 36, marginBottom: 28,
    style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
    x: { domain: [0, L], label: "Distance from A towards B (km) →", labelAnchor: "right", grid: true },
    y: { domain: [0, maxD], reverse: true, label: null, grid: true },
    marks,
  }) as SVGSVGElement;

  // Hover: nearest quake; click: select it.
  const sx = (svg as unknown as { scale(n: string): { apply(v: number): number } }).scale("x");
  const sy = (svg as unknown as { scale(n: string): { apply(v: number): number } }).scale("y");
  const nearest = (ev: PointerEvent | MouseEvent) => {
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const l = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    let best = null as (typeof pts)[number] | null, bd = 12 * 12;
    for (const p of pts) {
      const dd = (sx.apply(p.along) - l.x) ** 2 + (sy.apply(p.depth) - l.y) ** 2;
      if (dd < bd) { bd = dd; best = p; }
    }
    return best;
  };
  svg.addEventListener("pointermove", (ev) => {
    const p = nearest(ev);
    svg.style.cursor = p ? "pointer" : "";
    if (!p) { hideTooltip(); return; }
    showTooltip(ev.clientX, ev.clientY, (tip) => {
      tip.append(el("div", "t-head", new Date((p.f.properties.t + 9 * 3600) * 1000).toISOString().slice(0, 10)));
      const r1 = el("div", "t-row"); r1.append(el("span", "", `M${p.mag.toFixed(1)}`), el("strong", "", `${Math.round(p.depth)} km deep`));
      tip.append(r1, el("div", "t-head", "Click to select"));
    });
  });
  svg.addEventListener("pointerleave", hideTooltip);
  svg.addEventListener("click", (ev) => { const p = nearest(ev); if (p) inp.onSelect(p.f); });

  const wrap = el("div", "chart");
  wrap.append(el("div", "chart-title", "Depth below the surface (km) ↓"), svg);
  const facts = `${fmt(pts.length)} quakes within ±${s.halfWidthKm} km of a ${fmt(Math.round(L))} km line. ` +
    (exaggeration > 1.15 ? `Depth is stretched ×${exaggeration.toFixed(1)} to fit.` :
      exaggeration < 0.87 ? `Depth is compressed ×${(1 / exaggeration).toFixed(1)} to fit.` : "Drawn at true scale.");
  return [wrap, el("p", "sub", facts)];
}
