// Aftershock section of the Quake tab.
import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { FORESHOCK_DAYS, MIN_MAINSHOCK, WINDOW_DAYS, fitOmoriP, rateBins, type Sequence, type Shock } from "./aftershocks";
import { el, fmt, theme } from "./ui";

export type AftershockState =
  | { status: "small" }
  | { status: "loading" }
  | { status: "ok"; main: Shock; seq: Sequence; dataEnd: number };

/** 0.01 -> "14 min", 0.1 -> "2.4 h", 2.54 -> "2.5 days", 10 -> "10 days". */
function fmtDays(d: number): string {
  if (d >= 1) { const n = d >= 10 ? Math.round(d) : +d.toPrecision(2); return `${n} ${n === 1 ? "day" : "days"}`; }
  const h = d * 24;
  return h >= 1 ? `${+h.toPrecision(2)} h` : `${Math.round(h * 60)} min`;
}
const dayTicks = [0.01, 0.1, 1, 10, 100];

function laterText(days: number) {
  return `${fmtDays(days)} later`;
}

export function renderAftershocks(st: AftershockState, width: number): HTMLElement {
  const box = el("div", "aftershocks");
  box.append(el("h2", "", "Aftershocks"));
  if (st.status === "small") {
    box.append(el("p", "sub", `Aftershock statistics are shown for quakes of M${MIN_MAINSHOCK} and above.`));
    return box;
  }
  if (st.status === "loading") {
    box.append(el("p", "sub", "Loading the following year's quakes…"));
    return box;
  }
  const t = theme();
  const { main, seq, dataEnd } = st;
  const a = seq.after;
  const truncated = main.t + WINDOW_DAYS * 86400 > dataEnd;
  box.append(el("p", "sub",
    `M3+ quakes within ${fmt(Math.round(seq.radiusKm))} km of the epicentre in the ${WINDOW_DAYS} days after ` +
    `(about the rupture length expected for M${main.mag.toFixed(1)}, after Wells & Coppersmith 1994)` +
    (truncated ? "; the catalogue ends before the year is up." : ".")));

  const largest = a.reduce<(typeof a)[number] | null>((m, s) => (!m || s.mag > m.mag ? s : m), null);
  const stats = el("div", "readout");
  const stat = (label: string, value: string, hint?: string) => {
    const d = el("div", "stat");
    d.append(document.createTextNode(label), el("strong", "", value));
    if (hint) d.append(el("span", "hint", hint));
    return d;
  };
  stats.append(
    stat("Aftershocks M3+", fmt(a.length), `${fmt(a.filter((s) => s.mag >= 5).length)} of M5+`),
    stat("Largest", largest ? `M${largest.mag.toFixed(1)}` : "–",
      largest ? laterText(largest.days) : undefined),
    stat("Foreshocks M3+", fmt(seq.before.length), `in the ${FORESHOCK_DAYS} days before`),
  );
  box.append(stats);
  if (largest) {
    const gap = main.mag - largest.mag;
    box.append(el("p", "sub",
      `Largest aftershock ${gap.toFixed(1)} magnitude units below the mainshock. Båth's law says this gap is typically about 1.2, ` +
      "whatever the mainshock's size."));
  }
  if (a.length < 10) {
    box.append(el("p", "sub", "Too few M3+ aftershocks to chart their decay."));
    return box;
  }

  const w = Math.max(260, width - 32);
  const bins = rateBins(a.map((s) => s.days));
  const fit = fitOmoriP(bins);
  const shown = bins.filter((b) => b.count > 0);
  const marks: Plot.Markish[] = [
    Plot.dot(shown, { x: "tMid", y: "rate", r: 3.5, fill: t.series[0], stroke: t.surface, strokeWidth: 1 }),
  ];
  if (fit) {
    const line = [0.1, WINDOW_DAYS].map((d) => ({ d, r: 10 ** (fit.logK - fit.p * Math.log10(d)) }));
    marks.push(
      Plot.line(line, { x: "d", y: "r", stroke: t.series[0], strokeDasharray: "5 4", strokeWidth: 1.5 }),
      Plot.text([line[1]], { x: "d", y: "r", text: () => `p ≈ ${fit.p.toFixed(2)}`, dy: -10, textAnchor: "end", fill: t.text,
        fontSize: 11, stroke: t.surface, strokeWidth: 3, paintOrder: "stroke" }),
    );
  }
  const rates = shown.map((b) => b.rate);
  const yDomain: [number, number] = [10 ** Math.floor(Math.log10(d3.min(rates)!)), 10 ** Math.ceil(Math.log10(d3.max(rates)!))];
  const decay = Plot.plot({
    width: w, height: 200, marginLeft: 46, marginBottom: 32,
    style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
    x: { type: "log", label: "Time after the mainshock →", ticks: dayTicks, tickFormat: fmtDays, grid: true },
    y: { type: "log", label: "↑ Aftershocks per day", grid: true, domain: yDomain,
         ticks: d3.range(-3, 7).map((e) => 10 ** e).filter((v) => v >= yDomain[0] && v <= yDomain[1]),
         tickFormat: (v: number) => (v >= 1 ? d3.format("~s")(v) : String(v)) },
    marks,
  });
  const c1 = el("div", "chart");
  c1.append(el("div", "chart-title", "How fast the aftershocks die away (Omori's law)"), decay);
  box.append(c1, el("p", "sub",
    "On log–log axes a steady decay is a straight line; its slope p is usually close to 1, meaning the rate falls " +
    "roughly as 1/time. " + (fit ? `Fitted from ${fit.n} time bins after the first ${fmtDays(0.1)}, ` +
      "when small aftershocks are still being missed in the mainshock's shaking." : "Not enough data for a fit.")));

  const r = d3.scaleSqrt().domain([3, 9]).range([1.4, 8]).clamp(true);
  const mt = Plot.plot({
    width: w, height: 170, marginLeft: 46, marginBottom: 32, marginTop: 22,
    style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
    x: { type: "log", label: "Time after the mainshock →", domain: [0.01, WINDOW_DAYS], ticks: dayTicks, tickFormat: fmtDays, grid: true },
    y: { label: "↑ Magnitude", grid: true },
    marks: [
      Plot.dot(a, { x: (s) => Math.max(0.01, s.days), y: "mag", r: (s) => r(s.mag), fill: t.series[0], fillOpacity: 0.6,
        stroke: t.surface, strokeWidth: 0.5 }),
      Plot.ruleY([main.mag], { stroke: t.muted, strokeDasharray: "3 3" }),
      Plot.text([main.mag], { x: () => WINDOW_DAYS, y: (m) => m, text: () => `mainshock M${main.mag.toFixed(1)}`, dy: -7,
        textAnchor: "end", fill: t.muted, fontSize: 10 }),
    ],
  });
  const c2 = el("div", "chart");
  c2.append(el("div", "chart-title", "Aftershock magnitudes over time"), mt);
  box.append(c2);
  return box;
}
