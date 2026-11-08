import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { cellTotals, curve, estimateMc, fitted, histogram, type GrData, type McEstimate, type Point } from "./gr";

// ---------------------------------------------------------------- state ---

interface Series {
  label: string;
  from: number;
  to: number;
  color: string;
  pts: Point[]; // counts divided by `per` (1, or the number of years in era mode)
  est: McEstimate; // from raw counts; Mc and b don't depend on `per`
  per: number;
}

const state = {
  mode: "single" as "single" | "eras",
  from: 1919,
  to: 2024,
  cells: null as Set<number> | null,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = d3.format(",");

function theme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    series: [v("--series-1"), v("--series-2"), v("--series-3"), v("--series-4")],
    text: v("--text-primary"), secondary: v("--text-secondary"), muted: v("--text-muted"),
    grid: v("--grid"), axis: v("--axis"), surface: v("--surface-1"), incomplete: v("--incomplete"),
    land: v("--land"), landStroke: v("--land-stroke"), seqLow: v("--seq-low"), seqHigh: v("--seq-high"),
  };
}

// ----------------------------------------------------------------- data ---

// coast.json is Natural Earth land cut to the region (scripts/coast.mjs).
const [data, landFeature]: [GrData, d3.GeoPermissibleObjects] = await Promise.all([
  fetch("./data/gr.json").then((r) => r.json()),
  fetch("./data/coast.json").then((r) => r.json()),
]);
const [firstYear, lastYear] = data.years;
state.from = firstYear;
state.to = lastYear;

// Split at visible steps in JMA's processing (see notes on the page).
const ERAS: [number, number][] = [[firstYear, 1974], [1975, 1996], [1997, 2015], [2016, lastYear]];

// Eras have different lengths, so they are compared as yearly rates.
const perYear = () => state.mode === "eras";

function buildSeries(): Series[] {
  const t = theme();
  const ranges: [number, number][] = state.mode === "single" ? [[state.from, state.to]] : ERAS;
  return ranges.map(([from, to], i) => {
    const h = histogram(data, { from, to, cells: state.cells });
    const per = perYear() ? to - from + 1 : 1;
    const pts = curve(h).map((p) => ({ mag: p.mag, incremental: p.incremental / per, cumulative: p.cumulative / per }));
    return { label: from === to ? `${from}` : `${from}–${to}`, from, to, color: t.series[i], pts, est: estimateMc(h), per };
  });
}

const fmtCount = (v: number) => (v >= 10 || Number.isInteger(v) ? fmt(Math.round(v)) : d3.format(".2~r")(v));
const fmtTick = (d: number) => {
  if (!Number.isInteger(Math.round(Math.log10(d) * 1e6) / 1e6)) return "";
  return d >= 1 ? d3.format("~s")(d) : String(d);
};

// ---------------------------------------------------------------- chart ---

const tooltip = $<HTMLDivElement>("tooltip");

function showTooltip(x: number, y: number, build: (el: HTMLElement) => void) {
  tooltip.replaceChildren();
  build(tooltip);
  tooltip.hidden = false;
  const r = tooltip.getBoundingClientRect();
  const left = x + 16 + r.width > window.innerWidth ? x - 16 - r.width : x + 16;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, Math.min(y - r.height / 2, window.innerHeight - r.height - 8))}px`;
}
const hideTooltip = () => { tooltip.hidden = true; };

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderChart(series: Series[]) {
  const t = theme();
  const host = $("chart");
  const width = Math.max(320, host.clientWidth);
  const height = Math.round(Math.min(520, Math.max(320, width * 0.6)));
  const single = series.length === 1;
  const all = series.flatMap((s) => s.pts);
  if (all.length === 0) {
    host.replaceChildren(el("p", "sub", "No earthquakes in this selection."));
    return;
  }
  const xMin = Math.max(-1.5, d3.min(all, (p) => p.mag)!);
  const xMax = d3.max(all, (p) => p.mag)! + 0.2;
  const yMinData = d3.min(all, (p) => (single ? Math.min(p.incremental, p.cumulative) : p.cumulative))!;
  const yLo = 10 ** Math.floor(Math.log10(yMinData));
  const yHi = 10 ** Math.ceil(Math.log10(d3.max(all, (p) => p.cumulative)!));
  const decades = d3.range(Math.round(Math.log10(yLo)), Math.round(Math.log10(yHi)) + 1).map((e) => 10 ** e);

  const options = (marks: Plot.Markish[]) => ({
    width, height, marginLeft: 64, marginBottom: 40, marginRight: 24,
    style: { background: "transparent", color: t.secondary, fontSize: "12px", fontFamily: "inherit" },
    x: { domain: [xMin - 0.1, xMax], label: "Magnitude (JMA) →", labelAnchor: "right" as const,
         ticks: d3.range(Math.ceil(xMin), Math.floor(xMax) + 1).filter((m) => width >= 520 || m % 2 === 0),
         tickFormat: (d: number) => `M${d}` },
    y: { type: "log" as const, domain: [yLo, yHi], ticks: decades, tickFormat: fmtTick,
         label: single ? "↑ Number of earthquakes" : "↑ Earthquakes per year" },
    marks,
  });

  const marks: Plot.Markish[] = [Plot.gridY(decades, { stroke: t.grid, strokeOpacity: 1 })];
  const s0 = series[0];
  if (single && s0.est.mc !== null) {
    marks.push(
      Plot.rectX([0], { x1: xMin - 0.1, x2: s0.est.mc - 0.05, y1: yLo, y2: yHi, fill: t.incomplete }),
      Plot.text([0], {
        x: xMin, y: yLo, text: () => "Incomplete: smaller quakes\npartly missed below Mc", textAnchor: "start",
        dy: -8, fill: t.muted, fontSize: 11, lineAnchor: "bottom",
      }),
    );
  }
  const anchors: { s: Series; p: Point }[] = [];
  for (const s of series) {
    if (single) marks.push(Plot.dot(s.pts, { x: "mag", y: "incremental", r: 2, fill: s.color, fillOpacity: 0.45 }));
    marks.push(Plot.line(s.pts, { x: "mag", y: "cumulative", stroke: s.color, strokeWidth: 2, curve: "step-after" }));
    if (s.est.mc === null) continue;
    if (s.est.b !== null) {
      const fitPts = s.pts.filter((p) => p.mag >= s.est.mc! - 1e-9).map((p) => ({ mag: p.mag, n: fitted(s.est, p.mag)! / s.per }));
      marks.push(Plot.line(fitPts, { x: "mag", y: "n", stroke: s.color, strokeWidth: 1.5, strokeDasharray: "5 4", strokeOpacity: 0.9 }));
    }
    const atMc = s.pts.find((p) => Math.abs(p.mag - s.est.mc!) < 1e-9);
    if (atMc) {
      anchors.push({ s, p: atMc });
      marks.push(Plot.dot([atMc], { x: "mag", y: "cumulative", r: 5, fill: s.color, stroke: t.surface, strokeWidth: 2 }));
    }
  }

  // Labels: measure where each Mc point lands, then push labels apart vertically
  // so they never overlap (a leader line joins a moved label to its point).
  const probe = Plot.plot(options(marks)) as unknown as { scale(n: string): { apply(v: number): number } };
  const px = probe.scale("x"), py = probe.scale("y");
  const placed = anchors
    .map((a) => ({ ...a, x: px.apply(a.p.mag), y: py.apply(a.p.cumulative), ly: py.apply(a.p.cumulative) - 14 }))
    .sort((a, b) => a.ly - b.ly);
  const GAP = 16;
  for (let i = 1; i < placed.length; i++) placed[i].ly = Math.max(placed[i].ly, placed[i - 1].ly + GAP);
  for (const l of placed) {
    const text = single ? `Mc ${l.s.est.mc!.toFixed(1)}` : `${l.s.label} · Mc ${l.s.est.mc!.toFixed(1)}`;
    const dy = l.ly - l.y;
    marks.push(Plot.text([l.p], {
      x: "mag", y: "cumulative", text: () => text, dx: 10, dy, textAnchor: "start", fill: t.text, fontSize: 12,
      stroke: t.surface, strokeWidth: 4, paintOrder: "stroke",
    }));
  }

  const svg = Plot.plot(options(marks)) as SVGSVGElement;
  // Leader lines for labels moved away from their point (drawn in pixels).
  const ns = "http://www.w3.org/2000/svg";
  for (const l of placed) {
    if (Math.abs(l.ly - l.y) <= 18) continue;
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", String(l.x + 4)); ln.setAttribute("y1", String(l.y - 4));
    ln.setAttribute("x2", String(l.x + 9)); ln.setAttribute("y2", String(l.ly + 4));
    ln.setAttribute("stroke", t.muted); ln.setAttribute("stroke-width", "1");
    svg.appendChild(ln);
  }

  // Crosshair: snaps to the nearest 0.1 magnitude bin; one tooltip lists every series.
  const x = (svg as unknown as { scale(n: string): { apply(v: number): number; invert(p: number): number } }).scale("x");
  const hair = document.createElementNS(ns, "line");
  hair.setAttribute("stroke", t.muted);
  hair.setAttribute("stroke-width", "1");
  hair.setAttribute("y1", "20");
  hair.setAttribute("y2", String(height - 40));
  hair.style.display = "none";
  svg.appendChild(hair);
  svg.addEventListener("pointermove", (ev) => {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const local = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    const mag = Math.round(x.invert(local.x) * 10) / 10;
    const rows = series.map((s) => ({ s, p: s.pts.find((p) => Math.abs(p.mag - mag) < 1e-9) }));
    if (rows.every((r) => !r.p)) { hair.style.display = "none"; hideTooltip(); return; }
    const hx = x.apply(mag);
    hair.setAttribute("x1", String(hx)); hair.setAttribute("x2", String(hx));
    hair.style.display = "";
    showTooltip(ev.clientX, ev.clientY, (tip) => {
      tip.append(el("div", "t-head", single ? `M${mag.toFixed(1)} and above` : `M${mag.toFixed(1)} and above, per year`));
      for (const { s, p } of rows) {
        const row = el("div", "t-row");
        const key = el("span", "key"); key.style.background = s.color;
        row.append(key, el("span", "", single ? "earthquakes" : s.label), el("strong", "", p ? fmtCount(p.cumulative) : "0"));
        tip.append(row);
        if (single && p) {
          const r2 = el("div", "t-row");
          const k2 = el("span", "key"); k2.style.background = "transparent";
          r2.append(k2, el("span", "", `exactly M${mag.toFixed(1)}`), el("strong", "", fmtCount(p.incremental)));
          tip.append(r2);
        }
      }
      const below = series.filter((s) => s.est.mc !== null && mag < s.est.mc - 1e-9);
      if (below.length) tip.append(el("div", "t-head", single ? "Below Mc: undercounted" : `Below Mc for ${below.map((s) => s.label).join(", ")}`));
    });
  });
  svg.addEventListener("pointerleave", () => { hair.style.display = "none"; hideTooltip(); });
  host.replaceChildren(svg);
}

function renderLegend(series: Series[]) {
  const host = $("legend");
  host.replaceChildren();
  const single = series.length === 1;
  for (const s of series) {
    const k = el("span", "key");
    const sw = el("span", "swatch"); sw.style.background = s.color;
    k.append(sw, el("span", "", single ? `At or above magnitude (${s.label})` : s.label));
    host.append(k);
  }
  if (single) {
    const dots = el("span", "key");
    const sw = el("span", "swatch"); sw.style.cssText = `width:6px;height:6px;border-radius:50%;background:${series[0].color};opacity:.45`;
    dots.append(sw, el("span", "", "In each 0.1 step"));
    const fit = el("span", "key");
    const sw2 = el("span", "swatch"); sw2.style.cssText = `background: repeating-linear-gradient(90deg, ${series[0].color} 0 5px, transparent 5px 9px)`;
    fit.append(sw2, el("span", "", "Gutenberg–Richter fit"));
    const band = el("span", "key");
    band.append(el("span", "swatch band"), el("span", "", "Below Mc"));
    host.append(dots, fit, band);
  }
}

function renderReadout(series: Series[]) {
  const host = $("readout");
  host.replaceChildren();
  const stat = (label: string, value: string, color?: string) => {
    const d = el("div", "stat");
    if (color) { const k = el("span", "key"); k.style.background = color; d.append(k); }
    d.append(document.createTextNode(label), el("strong", "", value));
    return d;
  };
  const method = (e: McEstimate) =>
    e.method === "maxc+0.2" ? "most common M + 0.2" : e.method ? `G-R fits ${e.fitPct}%` : "";
  const mcText = (e: McEstimate) => (e.mc === null ? "too few to estimate" : `M${e.mc.toFixed(1)}`);
  if (series.length === 1) {
    host.className = "readout";
    const e = series[0].est;
    host.append(
      stat("earthquakes", fmt(e.nEvents)),
      stat("Mc", e.mc === null ? mcText(e) : `${mcText(e)} (${method(e)})`),
      stat("b-value above Mc", e.b === null ? "–" : e.b.toFixed(2)),
    );
    return;
  }
  host.className = "readout eras";
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const h of ["Era", "Earthquakes", "Per year", "Mc", "b above Mc"]) head.append(el("th", "", h));
  const body = table.createTBody();
  for (const s of series) {
    const e = s.est;
    const r = body.insertRow();
    const name = el("td");
    const k = el("span", "key"); k.style.background = s.color;
    name.append(k, document.createTextNode(s.label));
    const mc = el("td", "", mcText(e));
    if (e.method) mc.title = method(e);
    r.append(name, el("td", "", fmt(e.nEvents)), el("td", "", fmt(Math.round(e.nEvents / s.per))), mc,
      el("td", "", e.b === null ? "–" : e.b.toFixed(2)));
  }
  host.append(table);
}

function renderTable(series: Series[]) {
  const mags = [...new Set(series.flatMap((s) => s.pts.map((p) => p.mag)))].sort((a, b) => a - b);
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  head.append(el("th", "", "Magnitude"));
  const single = series.length === 1;
  for (const s of series) {
    head.append(el("th", "", single ? "At or above" : `${s.label}: at or above`));
    if (single) head.append(el("th", "", "In this step"));
  }
  const body = table.createTBody();
  for (const m of mags) {
    const r = body.insertRow();
    r.append(el("td", "", `M${m.toFixed(1)}`));
    for (const s of series) {
      const p = s.pts.find((q) => Math.abs(q.mag - m) < 1e-9);
      const below = s.est.mc !== null && m < s.est.mc - 1e-9;
      r.append(el("td", "", (p ? fmt(p.cumulative) : "0") + (below ? " *" : "")));
      if (single) r.append(el("td", "", p ? fmt(p.incremental) : "0"));
    }
  }
  const wrap = el("div", "scroll");
  wrap.append(table);
  const note = el("p", "sub", "* below Mc: undercounted.");
  $("table").replaceChildren(wrap, note);
}

// ------------------------------------------------------------------ map ---

const cellFeature = (i: number): d3.GeoPermissibleObjects => {
  const [lat, lon] = data.cells[i];
  const d = data.cellDeg;
  return {
    type: "Polygon",
    coordinates: [[[lon, lat], [lon, lat + d], [lon + d, lat + d], [lon + d, lat], [lon, lat]]],
  } as d3.GeoPermissibleObjects;
};

function renderMap() {
  const t = theme();
  const host = $("map");
  const width = Math.max(260, host.clientWidth);
  const height = Math.round(width * 1.05);
  const b = data.box;
  const outline = { type: "Polygon", coordinates: [[[b.lon_min, b.lat_min], [b.lon_min, b.lat_max], [b.lon_max, b.lat_max], [b.lon_max, b.lat_min], [b.lon_min, b.lat_min]]] } as d3.GeoPermissibleObjects;
  const projection = d3.geoMercator().fitExtent([[4, 4], [width - 4, height - 4]], outline);
  const path = d3.geoPath(projection);
  const [from, to] = state.mode === "single" ? [state.from, state.to] : [firstYear, lastYear];
  const totals = cellTotals(data, from, to);
  const max = d3.max(totals) || 1;
  const color = d3.scaleSequentialLog([1, max], d3.interpolateLab(t.seqLow, t.seqHigh));

  const svg = d3.create("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("width", width).attr("height", height)
    .attr("role", "group").attr("aria-label", "Map of 2-degree squares; select squares to filter");
  svg.append("defs").append("clipPath").attr("id", "box-clip").append("path").attr("d", path(outline));
  svg.append("path").attr("d", path(outline)).attr("fill", "none").attr("stroke", t.axis);
  svg.append("path").attr("d", path(landFeature)).attr("fill", t.land).attr("stroke", t.landStroke).attr("stroke-width", 0.5).attr("clip-path", "url(#box-clip)");

  const cells = svg.append("g").attr("clip-path", "url(#box-clip)");
  data.cells.forEach((c, i) => {
    const n = totals[i];
    const selected = state.cells?.has(i) ?? false;
    const label = `${c[0]}–${c[0] + data.cellDeg}°N, ${c[1]}–${c[1] + data.cellDeg}°E: ${fmt(n)} earthquakes ${from}–${to}`;
    const p = cells.append("path").attr("class", "cell").attr("d", path(cellFeature(i)))
      .attr("fill", n > 0 ? color(n) : "transparent").attr("fill-opacity", n > 0 ? 0.75 : 1)
      .attr("stroke", selected ? t.text : t.surface).attr("stroke-width", selected ? 2.5 : 1)
      .attr("tabindex", 0).attr("role", "button").attr("aria-pressed", String(selected)).attr("aria-label", label);
    const toggle = () => { toggleCell(i); };
    p.on("click", toggle)
      .on("keydown", (ev: KeyboardEvent) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } })
      .on("pointermove", (ev: PointerEvent) => showTooltip(ev.clientX, ev.clientY, (tip) => {
        tip.append(el("div", "t-head", `${c[0]}–${c[0] + data.cellDeg}°N, ${c[1]}–${c[1] + data.cellDeg}°E`));
        const row = el("div", "t-row");
        row.append(el("span", "", `${from}–${to}`), el("strong", "", fmt(n)));
        tip.append(row, el("div", "t-head", selected ? "Click to remove" : "Click to select"));
      }))
      .on("pointerleave", hideTooltip);
  });
  // Coastline over the squares so the geography stays readable; it ignores the pointer.
  svg.append("path").attr("d", path(landFeature)).attr("fill", "none").attr("stroke", t.text)
    .attr("stroke-opacity", 0.55).attr("stroke-width", 0.75).attr("clip-path", "url(#box-clip)")
    .attr("pointer-events", "none");
  // Selected outlines on top so neighbours and the coast don't cover them.
  const sel = cells.selectAll<SVGPathElement, unknown>(".cell").filter(function () { return this.getAttribute("aria-pressed") === "true"; });
  sel.each(function () { svg.node()!.appendChild(this); });
  host.replaceChildren(svg.node()!);
}

function toggleCell(i: number) {
  const next = new Set(state.cells ?? []);
  if (next.has(i)) next.delete(i); else next.add(i);
  state.cells = next.size ? next : null;
  render();
  (document.querySelectorAll<SVGPathElement>("#map .cell")[i])?.focus();
}

// ------------------------------------------------------------- controls ---

const fromInput = $<HTMLInputElement>("from");
const toInput = $<HTMLInputElement>("to");
for (const inp of [fromInput, toInput]) { inp.min = String(firstYear); inp.max = String(lastYear); }

const presets: [string, number, number][] = [
  ["All years", firstYear, lastYear],
  ...ERAS.map(([a, b]) => [`${a}–${b}`, a, b] as [string, number, number]),
  [`Last 10 years`, lastYear - 9, lastYear],
];
for (const [label, a, b] of presets) {
  const btn = el("button", "", label) as HTMLButtonElement;
  btn.type = "button";
  btn.addEventListener("click", () => { state.from = a; state.to = b; render(); });
  $("presets").append(btn);
}

function readYears() {
  const clamp = (v: number) => Math.min(lastYear, Math.max(firstYear, v));
  let a = clamp(Number(fromInput.value) || firstYear);
  let b = clamp(Number(toInput.value) || lastYear);
  if (a > b) [a, b] = [b, a];
  state.from = a; state.to = b;
  render();
}
fromInput.addEventListener("change", readYears);
toInput.addEventListener("change", readYears);
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  r.addEventListener("change", () => { state.mode = r.value as "single" | "eras"; render(); });
}
$("region-reset").addEventListener("click", () => { state.cells = null; render(); });

// --------------------------------------------------------------- render ---

function render() {
  fromInput.value = String(state.from);
  toInput.value = String(state.to);
  $("period").hidden = state.mode === "eras";
  const n = state.cells?.size ?? 0;
  $("region-label").textContent = n === 0 ? "All of Japan" : `${n} square${n > 1 ? "s" : ""} selected`;
  ($("region-reset") as HTMLButtonElement).disabled = n === 0;

  const series = buildSeries();
  $("chart-title").textContent = state.mode === "single"
    ? "Earthquakes at or above each magnitude"
    : "Earthquakes per year at or above each magnitude";
  $("chart-sub").textContent = state.mode === "single"
    ? `${series[0].label}, ${n === 0 ? "all of Japan" : "selected squares"}. Log scale: each gridline is ten times the one below.`
    : `Four eras, ${n === 0 ? "all of Japan" : "selected squares"}, as yearly rates because the eras differ in length. ` +
      "As the network improved, each curve keeps rising further to the left before it flattens.";
  renderLegend(series);
  renderChart(series);
  renderReadout(series);
  renderTable(series);
  renderMap();
}

$("source").textContent = `Source: ${data.source}, ${firstYear}–${lastYear}. Data prepared ${data.generated}.`;
render();

let resizeTimer = 0;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(render, 120); }).observe($("chart"));
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
