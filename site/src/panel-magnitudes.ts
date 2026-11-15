// Magnitudes tab: Gutenberg-Richter curves for the visible map area and the
// timeline's year range.
import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { curve, estimateMc, fitted, histogram, type GrData, type McEstimate, type Point } from "./gr";
import { el, fmt, hideTooltip, showTooltip, theme } from "./ui";

export interface MagSelection {
  from: number;
  to: number;
  cells: Set<number> | null;
  areaLabel: string;
  mode: "single" | "eras";
}

interface Series {
  label: string;
  color: string;
  pts: Point[]; // divided by `per`
  est: McEstimate;
  per: number;
}

export function erasFor(data: GrData): [number, number][] {
  const [a, b] = data.years;
  // Split at visible steps in JMA's processing (see the notes in this tab).
  return [[a, 1974], [1975, 1996], [1997, 2015], [2016, b]];
}

/** 2° squares overlapping a lon/lat rectangle; null when that is all of them. */
export function cellsInBounds(data: GrData, west: number, south: number, east: number, north: number): Set<number> | null {
  const d = data.cellDeg;
  const s = new Set<number>();
  data.cells.forEach(([lat, lon], i) => {
    if (lon < east && lon + d > west && lat < north && lat + d > south) s.add(i);
  });
  return s.size === data.cells.length ? null : s;
}

const fmtCount = (v: number) => (v >= 10 || Number.isInteger(v) ? fmt(Math.round(v)) : d3.format(".2~r")(v));
const fmtTick = (d: number) => {
  if (!Number.isInteger(Math.round(Math.log10(d) * 1e6) / 1e6)) return "";
  return d >= 1 ? d3.format("~s")(d) : String(d);
};

function buildSeries(data: GrData, sel: MagSelection): Series[] {
  const t = theme();
  const eras = sel.mode === "eras";
  const ranges: [number, number][] = eras ? erasFor(data) : [[sel.from, sel.to]];
  return ranges.map(([from, to], i) => {
    const h = histogram(data, { from, to, cells: sel.cells });
    const per = eras ? to - from + 1 : 1;
    const pts = curve(h).map((p) => ({ mag: p.mag, incremental: p.incremental / per, cumulative: p.cumulative / per }));
    return { label: from === to ? `${from}` : `${from}–${to}`, color: t.series[i], pts, est: estimateMc(h), per };
  });
}

export function renderMagnitudes(host: HTMLElement, data: GrData, sel: MagSelection) {
  // Magnitude statistics use the finalised catalogue only: later (preliminary)
  // quakes are unreviewed and not classified natural / low-frequency / artificial.
  const last = data.years[1];
  const why = "Later quakes come from JMA's preliminary lists: unreviewed, and not yet classified as natural, " +
    "low-frequency or artificial, so they are left out of these statistics.";
  if (sel.mode === "single" && sel.from > last) {
    host.replaceChildren(
      el("h2", "", "Earthquakes at or above each magnitude"),
      el("p", "note", `Magnitude statistics use the finalised catalogue, which ends in ${last}. ${why} ` +
        `Move the start of the timeline to ${last} or earlier.`));
    return;
  }
  const clipped = sel.mode === "single" && sel.to > last;
  if (clipped) sel = { ...sel, to: last };
  const series = buildSeries(data, sel);
  const single = series.length === 1;
  const title = el("h2", "", single ? "Earthquakes at or above each magnitude" : "Earthquakes per year at or above each magnitude");
  const sub = el("p", "sub", single
    ? `${series[0].label}, ${sel.areaLabel}. Log scale: each gridline is ten times the one below.`
    : `Four eras, ${sel.areaLabel}, as yearly rates because the eras differ in length.`);
  const legend = el("div", "legend");
  const chart = el("div", "chart");
  const readout = el("div", "readout");
  const table = el("details", "table-view");
  host.replaceChildren(title, sub, ...(clipped ? [el("p", "note", `Counts stop at the end of ${last}. ${why}`)] : []),
    legend, chart, readout, table);
  renderLegend(legend, series);
  renderChart(chart, series, Math.max(280, host.clientWidth));
  renderReadout(readout, series);
  renderTable(table, series);
}

function renderChart(host: HTMLElement, series: Series[], width: number) {
  const t = theme();
  const height = Math.round(Math.max(260, Math.min(420, width * 0.75)));
  const single = series.length === 1;
  const all = series.flatMap((s) => s.pts);
  if (all.length === 0) {
    host.replaceChildren(el("p", "sub", "No earthquakes in this area and period."));
    return;
  }
  const xMin = Math.max(-1.5, d3.min(all, (p) => p.mag)!);
  const xMax = d3.max(all, (p) => p.mag)! + 0.2;
  const yMinData = d3.min(all, (p) => (single ? Math.min(p.incremental, p.cumulative) : p.cumulative))!;
  const yLo = 10 ** Math.floor(Math.log10(yMinData));
  const yHi = 10 ** Math.ceil(Math.log10(d3.max(all, (p) => p.cumulative)!));
  const decades = d3.range(Math.round(Math.log10(yLo)), Math.round(Math.log10(yHi)) + 1).map((e) => 10 ** e);

  const options = (marks: Plot.Markish[]) => ({
    width, height, marginLeft: 52, marginBottom: 36, marginRight: 16, marginTop: 24,
    style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
    x: { domain: [xMin - 0.1, xMax], label: "Magnitude →", labelAnchor: "right" as const,
         ticks: d3.range(Math.ceil(xMin), Math.floor(xMax) + 1).filter((m) => width >= 420 || m % 2 === 0),
         tickFormat: (d: number) => `M${d}` },
    y: { type: "log" as const, domain: [yLo, yHi], ticks: decades, tickFormat: fmtTick,
         label: single ? "↑ Earthquakes" : "↑ Per year" },
    marks,
  });

  const marks: Plot.Markish[] = [Plot.gridY(decades, { stroke: t.grid, strokeOpacity: 1 })];
  const s0 = series[0];
  if (single && s0.est.mc !== null) {
    marks.push(Plot.rectX([0], { x1: xMin - 0.1, x2: s0.est.mc - 0.05, y1: yLo, y2: yHi, fill: t.incomplete }));
  }
  const anchors: { s: Series; p: Point }[] = [];
  for (const s of series) {
    if (single) marks.push(Plot.dot(s.pts, { x: "mag", y: "incremental", r: 1.8, fill: s.color, fillOpacity: 0.45 }));
    marks.push(Plot.line(s.pts, { x: "mag", y: "cumulative", stroke: s.color, strokeWidth: 2, curve: "step-after" }));
    if (s.est.mc === null) continue;
    if (s.est.b !== null) {
      const fitPts = s.pts.filter((p) => p.mag >= s.est.mc! - 1e-9).map((p) => ({ mag: p.mag, n: fitted(s.est, p.mag)! / s.per }));
      marks.push(Plot.line(fitPts, { x: "mag", y: "n", stroke: s.color, strokeWidth: 1.5, strokeDasharray: "5 4", strokeOpacity: 0.9 }));
    }
    const atMc = s.pts.find((p) => Math.abs(p.mag - s.est.mc!) < 1e-9);
    if (atMc) {
      anchors.push({ s, p: atMc });
      marks.push(Plot.dot([atMc], { x: "mag", y: "cumulative", r: 4.5, fill: s.color, stroke: t.surface, strokeWidth: 2 }));
    }
  }

  // Labels: measure where each Mc point lands, then push labels apart vertically.
  const probe = Plot.plot(options(marks)) as unknown as { scale(n: string): { apply(v: number): number } };
  const px = probe.scale("x"), py = probe.scale("y");
  const placed = anchors
    .map((a) => ({ ...a, x: px.apply(a.p.mag), y: py.apply(a.p.cumulative), ly: py.apply(a.p.cumulative) - 12 }))
    .sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < placed.length; i++) placed[i].ly = Math.max(placed[i].ly, placed[i - 1].ly + 15);
  for (const l of placed) {
    const text = single ? `Mc ${l.s.est.mc!.toFixed(1)}` : `${l.s.label} · Mc ${l.s.est.mc!.toFixed(1)}`;
    marks.push(Plot.text([l.p], {
      x: "mag", y: "cumulative", text: () => text, dx: 9, dy: l.ly - l.y, textAnchor: "start", fill: t.text, fontSize: 11,
      stroke: t.surface, strokeWidth: 4, paintOrder: "stroke",
    }));
  }

  const svg = Plot.plot(options(marks)) as SVGSVGElement;
  const ns = "http://www.w3.org/2000/svg";
  for (const l of placed) {
    if (Math.abs(l.ly - l.y) <= 16) continue;
    const ln = document.createElementNS(ns, "line");
    ln.setAttribute("x1", String(l.x + 4)); ln.setAttribute("y1", String(l.y - 4));
    ln.setAttribute("x2", String(l.x + 8)); ln.setAttribute("y2", String(l.ly + 4));
    ln.setAttribute("stroke", t.muted);
    svg.appendChild(ln);
  }

  // Crosshair snapping to 0.1-magnitude bins; one tooltip for every series.
  const x = (svg as unknown as { scale(n: string): { apply(v: number): number; invert(p: number): number } }).scale("x");
  const hair = document.createElementNS(ns, "line");
  hair.setAttribute("stroke", t.muted);
  hair.setAttribute("y1", "20");
  hair.setAttribute("y2", String(height - 36));
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
          r2.append(el("span", "key"), el("span", "", `exactly M${mag.toFixed(1)}`), el("strong", "", fmtCount(p.incremental)));
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

function renderLegend(host: HTMLElement, series: Series[]) {
  const single = series.length === 1;
  for (const s of series) {
    const k = el("span", "key");
    const sw = el("span", "swatch"); sw.style.background = s.color;
    k.append(sw, el("span", "", single ? "At or above" : s.label));
    host.append(k);
  }
  if (single) {
    const dots = el("span", "key");
    const sw = el("span", "swatch"); sw.style.cssText = `width:6px;height:6px;border-radius:50%;background:${series[0].color};opacity:.45`;
    dots.append(sw, el("span", "", "In each 0.1 step"));
    const fit = el("span", "key");
    const sw2 = el("span", "swatch"); sw2.style.cssText = `background: repeating-linear-gradient(90deg, ${series[0].color} 0 5px, transparent 5px 9px)`;
    fit.append(sw2, el("span", "", "G-R fit"));
    const band = el("span", "key");
    band.append(el("span", "swatch band"), el("span", "", "Below Mc"));
    host.append(dots, fit, band);
  }
}

function renderReadout(host: HTMLElement, series: Series[]) {
  const method = (e: McEstimate) =>
    e.method === "maxc+0.2" ? "most common M + 0.2" : e.method ? `G-R fits ${e.fitPct}%` : "";
  const mcText = (e: McEstimate) => (e.mc === null ? "too few" : `M${e.mc.toFixed(1)}`);
  if (series.length === 1) {
    const e = series[0].est;
    const stat = (label: string, value: string, hint?: string) => {
      const d = el("div", "stat");
      d.append(document.createTextNode(label), el("strong", "", value));
      if (hint) d.append(el("span", "hint", hint));
      return d;
    };
    host.append(
      stat("Earthquakes", fmt(e.nEvents)),
      stat("Complete above (Mc)", mcText(e), method(e)),
      stat("b-value", e.b === null ? "–" : e.b.toFixed(2)),
    );
    return;
  }
  host.classList.add("eras");
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const h of ["Era", "Per year", "Mc", "b"]) head.append(el("th", "", h));
  const body = table.createTBody();
  for (const s of series) {
    const e = s.est;
    const r = body.insertRow();
    const name = el("td");
    const k = el("span", "key"); k.style.background = s.color;
    name.append(k, document.createTextNode(s.label));
    const mc = el("td", "", mcText(e));
    if (e.method) mc.title = method(e);
    r.append(name, el("td", "", fmt(Math.round(e.nEvents / s.per))), mc, el("td", "", e.b === null ? "–" : e.b.toFixed(2)));
  }
  host.append(table);
}

function renderTable(host: HTMLElement, series: Series[]) {
  host.append(el("summary", "", "Show as a table"));
  const mags = [...new Set(series.flatMap((s) => s.pts.map((p) => p.mag)))].sort((a, b) => a - b);
  const table = document.createElement("table");
  const single = series.length === 1;
  const head = table.createTHead().insertRow();
  head.append(el("th", "", "Magnitude"));
  for (const s of series) {
    head.append(el("th", "", single ? "At or above" : s.label));
    if (single) head.append(el("th", "", "In this step"));
  }
  const body = table.createTBody();
  for (const m of mags) {
    const r = body.insertRow();
    r.append(el("td", "", `M${m.toFixed(1)}`));
    for (const s of series) {
      const p = s.pts.find((q) => Math.abs(q.mag - m) < 1e-9);
      const below = s.est.mc !== null && m < s.est.mc - 1e-9;
      r.append(el("td", "", (p ? fmtCount(p.cumulative) : "0") + (below ? " *" : "")));
      if (single) r.append(el("td", "", p ? fmtCount(p.incremental) : "0"));
    }
  }
  const wrap = el("div", "scroll");
  wrap.append(table);
  host.append(wrap, el("p", "sub", single ? "* below Mc: undercounted." : "Yearly rates. * below Mc: undercounted."));
}

/** "Once every 9 years", "about 18 a year": a yearly rate in words. */
export function howOften(n: number, years: number, period: string): string {
  if (years <= 3) return n === 0 ? `none in ${period}` : `${fmt(n)} in ${period}`;
  if (n === 0) return `none in ${years} years`;
  const rate = n / years;
  if (rate >= 1.5) return `about ${fmt(Math.round(rate))} a year`;
  if (rate >= 0.67) return "about one a year";
  return `about once every ${fmt(Math.round(years / n))} years`;
}

/**
 * The plain-language lead: how often quakes of each size happen in the area, as yearly
 * averages over the timeline's years. Detection improved over time, so each size is
 * averaged only over the eras in which it was fully recorded (era Mc at or below it).
 */
export function renderMagLead(host: HTMLElement, data: GrData, sel: MagSelection) {
  const last = data.years[1];
  const head = el("h2", "", "How often quakes of each size happen");
  if (sel.from > last) {
    host.replaceChildren(head, el("p", "note", `These counts use the finalised catalogue, which ends in ${last}. ` +
      `Move the start of the timeline to ${last} or earlier.`));
    return;
  }
  const to = Math.min(sel.to, last);
  const years = to - sel.from + 1;
  const span = (a: number, b: number) => (a === b ? `${a}` : `${a}–${b}`);
  // Each era's completeness: from the area if it has enough quakes, else from all of Japan.
  const parts = erasFor(data).flatMap(([a, b]) => {
    const lo = Math.max(a, sel.from), hi = Math.min(b, to);
    if (lo > hi) return [];
    const mc = estimateMc(histogram(data, { from: a, to: b, cells: sel.cells })).mc
      ?? estimateMc(histogram(data, { from: a, to: b, cells: null })).mc ?? 5;
    return [{ lo, hi, mc, h: histogram(data, { from: lo, to: hi, cells: sel.cells }) }];
  });
  const atLeast = (h: Map<number, number>, m: number) => { let n = 0; for (const [m10, c] of h) if (m10 >= m * 10) n += c; return n; };
  const table = document.createElement("table");
  table.className = "mini mag-lead";
  const hr = table.createTHead().insertRow();
  for (const t of ["", years <= 3 ? "Quakes" : "On average", "Count"]) hr.append(el("th", "", t));
  const body = table.createTBody();
  let partial = false;
  for (let m = 3; m <= 8; m++) {
    const used = parts.filter((p) => p.mc <= m + 1e-9);
    if (!used.length) continue; // not fully recorded in any of these years
    const yrs = d3.sum(used, (p) => p.hi - p.lo + 1);
    const n = d3.sum(used, (p) => atLeast(p.h, m));
    const from = d3.min(used, (p) => p.lo)!;
    const cell = el("td", "", howOften(n, yrs, span(from, to)));
    if (used.length < parts.length) {
      partial = true;
      // Completeness only improves with time here, so the years used run to the end.
      if (years > 3) cell.append(el("span", "muted", ` (from ${from})`));
    }
    const tr = body.insertRow();
    tr.append(el("td", "", `M${m}+`), cell, el("td", "", fmt(n)));
  }
  const notes: string[] = [];
  if (years > 3) notes.push("Yearly averages: quakes cluster, so single years vary a lot.");
  if (partial) notes.push("Smaller quakes weren't all recorded in earlier years, so those sizes are averaged only " +
    "over the years when they were (\"from …\").");
  if (sel.to > last) notes.push(`Counts stop at the end of ${last} (the finalised catalogue).`);
  host.replaceChildren(head, el("p", "sub", `${sel.areaLabel[0].toUpperCase()}${sel.areaLabel.slice(1)}, ${span(sel.from, to)}.`),
    table, el("p", "sub", notes.join(" ")));
}
