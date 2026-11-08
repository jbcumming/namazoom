// History tab: energy released over time, and destructive quakes, for the
// visible map area and the timeline's years.
import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import type { QuakeProps } from "./quakes";
import { el, fmt, hideTooltip, showTooltip, theme } from "./ui";

type QF = GeoJSON.Feature<GeoJSON.Point, QuakeProps>;

/** Radiated seismic energy in joules from magnitude: log10 E = 1.5 M + 4.8 (Gutenberg & Richter 1956). */
export const energyJ = (m: number) => 10 ** (1.5 * m + 4.8);
const KT_TNT = 4.184e12; // joules per kiloton of TNT

export const DAMAGE: Record<string, string> = {
  "3": "2–19 deaths or 2–999 houses destroyed",
  "4": "20–199 deaths or 1,000–9,999 houses destroyed",
  "5": "200–1,999 deaths or 10,000–99,999 houses destroyed",
  "6": "2,000–19,999 deaths or 100,000–999,999 houses destroyed",
  "7": "20,000+ deaths or 1,000,000+ houses destroyed",
};
export const TSUNAMI: Record<string, string> = {
  "2": "~1 m tsunami", "3": "~2 m tsunami", "4": "4–6 m tsunami", "5": "10–20 m tsunami", "6": "30 m+ tsunami",
  T: "tsunami (size not graded)",
};
export const isDestructive = (p: QuakeProps) => (p.dmg ?? "") in DAMAGE || (p.tsu ?? "") in TSUNAMI;

function energyText(j: number) {
  const kt = j / KT_TNT;
  if (kt >= 1000) return `${d3.format(".2~s")(kt / 1000)} megatons of TNT`;
  if (kt >= 1) return `${d3.format(".2~r")(kt)} kilotons of TNT`;
  return `${d3.format(".2~r")(kt * 1000)} tons of TNT`;
}

export interface HistoryInputs {
  quakes: QF[]; // M5+ in the visible area and period
  from: number;
  to: number;
  areaLabel: string;
  onSelect(f: QF): void;
}

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const sup = (n: number) => String(n).split("").map((c) => SUP[Number(c)] ?? c).join("");

const yearOf = (t: number) => new Date((t + 9 * 3600) * 1000).getUTCFullYear();
const dateOf = (t: number) => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10);

export function renderHistory(host: HTMLElement, inp: HistoryInputs) {
  const t = theme();
  const w = Math.max(260, host.clientWidth - 32);
  const q = inp.quakes.filter((f) => f.properties.mag !== null);
  const parts: HTMLElement[] = [el("h2", "", "History"),
    el("p", "sub", `M5+ quakes, ${inp.from === inp.to ? inp.from : `${inp.from}–${inp.to}`}, ${inp.areaLabel}.`)];
  if (!q.length) {
    host.replaceChildren(...parts, el("p", "sub", "No M5+ quakes in this area and period."));
    return;
  }

  // --- energy -------------------------------------------------------------
  const total = d3.sum(q, (f) => energyJ(f.properties.mag!));
  const sorted = [...q].sort((a, b) => b.properties.mag! - a.properties.mag!);
  const top = sorted[0];
  const topShare = energyJ(top.properties.mag!) / total;
  parts.push(el("h2", "", "Energy released"));
  parts.push(el("p", "lead",
    `The largest quake here, M${top.properties.mag!.toFixed(1)} on ${dateOf(top.properties.t)}, released ` +
    `${d3.format(".0%")(topShare)} of the seismic energy of all ${fmt(q.length)} M5+ quakes in this view.`));

  const byYear = d3.rollups(q, (v) => d3.sum(v, (f) => energyJ(f.properties.mag!)), (f) => yearOf(f.properties.t))
    .map(([year, e]) => ({ year, e }));
  const eMax = d3.max(byYear, (d) => d.e)!;
  const eMin = d3.min(byYear, (d) => d.e)!;
  const yearBars = Plot.plot({
    width: w, height: 170, marginLeft: 44, marginBottom: 24,
    style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
    x: { domain: [inp.from, inp.to + 1], label: null, tickFormat: "d" },
    y: { type: "log", domain: [10 ** Math.floor(Math.log10(eMin)), 10 ** Math.ceil(Math.log10(eMax))], label: "↑ Joules",
         tickFormat: (v: number) => (Number.isInteger(Math.log10(v)) && Math.log10(v) % 2 === 0 ? `10${sup(Math.log10(v))}` : "") },
    marks: [Plot.rectY(byYear, { x1: "year", x2: (d) => d.year + 1, y1: 10 ** Math.floor(Math.log10(eMin)), y2: "e",
      fill: t.series[0], insetLeft: 0.3, insetRight: 0.3 })],
  }) as SVGSVGElement;
  const ex = (yearBars as unknown as { scale(n: string): { invert(p: number): number } }).scale("x");
  const eByYear = new Map(byYear.map((d) => [d.year, d.e]));
  yearBars.addEventListener("pointermove", (ev) => {
    const pt = yearBars.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const year = Math.floor(ex.invert(pt.matrixTransform(yearBars.getScreenCTM()!.inverse()).x));
    const e = eByYear.get(year);
    if (e === undefined) { hideTooltip(); return; }
    showTooltip(ev.clientX, ev.clientY, (tip) => {
      tip.append(el("div", "t-head", String(year)));
      tip.append(el("div", "", `≈ ${energyText(e)}`));
    });
  });
  yearBars.addEventListener("pointerleave", hideTooltip);
  const c1 = el("div", "chart");
  c1.append(el("div", "chart-title", "Seismic energy released each year (log scale)"), yearBars);
  parts.push(c1);

  // Concentration: how much of the energy the largest N quakes account for.
  let cum = 0;
  const conc = sorted.slice(0, 30).map((f, i) => { cum += energyJ(f.properties.mag!); return { n: i + 1, share: cum / total }; });
  const concPlot = Plot.plot({
    width: w, height: 150, marginLeft: 44, marginBottom: 32,
    style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
    x: { label: "Largest N quakes →", domain: [1, conc.length] },
    y: { label: "↑ Share of energy", domain: [0, 1], tickFormat: "%", grid: true },
    marks: [
      Plot.line(conc, { x: "n", y: "share", stroke: t.series[0], strokeWidth: 2 }),
      Plot.dot(conc.filter((d) => d.n === 1 || d.n === 10), { x: "n", y: "share", r: 4, fill: t.series[0] }),
      Plot.text(conc.filter((d) => d.n === 1 || d.n === 10), { x: "n", y: "share", text: (d) => `${d.n === 1 ? "largest" : "top 10"}: ${d3.format(".0%")(d.share)}`,
        dx: 6, dy: 12, textAnchor: "start", fill: t.text, fontSize: 11 }),
    ],
  });
  const c2 = el("div", "chart");
  c2.append(el("div", "chart-title", "A few great quakes release most of the energy"), concPlot);
  parts.push(c2, el("p", "sub",
    "Energy from magnitude with log₁₀E = 1.5M + 4.8 (joules), so each magnitude step is about 32 times more energy. " +
    "Quakes below M5 add little: in a typical year, all of them together release less energy than a single M7."));

  // --- destructive quakes ------------------------------------------------------
  const bad = q.filter((f) => isDestructive(f.properties)).sort((a, b) => a.properties.t - b.properties.t);
  parts.push(el("h2", "", "Destructive quakes"));
  if (!bad.length) {
    parts.push(el("p", "sub", "None recorded in this area and period."));
  } else {
    parts.push(el("p", "sub", `${fmt(bad.length)} quakes with deaths or destroyed houses, or a damaging tsunami, ringed on the map. ` +
      "Damage classes follow Utsu's catalogue as recorded by JMA; click a row to show the quake."));
    const table = document.createElement("table");
    table.className = "mini";
    const head = table.createTHead().insertRow();
    for (const h of ["Date", "M", "Where", "Damage / tsunami"]) head.append(el("th", "", h));
    const body = table.createTBody();
    for (const f of [...bad].reverse()) {
      const p = f.properties;
      const tr = body.insertRow();
      tr.className = "clickable";
      const what = [DAMAGE[p.dmg ?? ""], TSUNAMI[p.tsu ?? ""]].filter(Boolean).join("; ");
      tr.append(el("td", "", dateOf(p.t)), el("td", "", p.mag!.toFixed(1)), el("td", "", (p.region ?? "").toLowerCase()), el("td", "", what));
      tr.addEventListener("click", () => inp.onSelect(f));
    }
    const wrap = el("div", "table-scroll");
    wrap.append(table);
    parts.push(wrap);
  }
  host.replaceChildren(...parts);
}
