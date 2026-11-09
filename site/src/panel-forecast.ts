// Forecast tab: the 7-day ETAS forecast for the visible area, and how the same
// method did on past weeks.
import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { atMag, chance, fmtPct, fmtWindow, overForecast, type CellSum, type Forecast, type RelBin } from "./forecast";
import { trenchSection } from "./panel-trench";
import { el, fmt, hideTooltip, showTooltip, theme } from "./ui";

export interface ForecastInputs {
  status: "loading" | "ok" | "missing";
  data: Forecast | null;
  view: CellSum | null; // cells in the visible area
  areaLabel: string;
  colors: string[];
  edges: number[];
}

const RTICKS = [1e-4, 1e-3, 1e-2, 1e-1, 1];
const rtick = (d: number) => `${+(d * 100).toPrecision(1)}%`;

const dateJst = (t: number) => new Date((t + 9 * 3600) * 1000).toLocaleDateString("en-GB",
  { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const timeJst = (t: number) => {
  const d = new Date((t + 9 * 3600) * 1000);
  return `${dateJst(t)} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

function legend(items: [string, string][]) {
  const lg = el("div", "legend");
  for (const [label, color] of items) {
    const k = el("span", "key");
    const sw = el("span", "swatch"); sw.style.cssText = `height:9px;border-radius:2px;background:${color}`;
    k.append(sw, el("span", "", label));
    lg.append(k);
  }
  return lg;
}

function midText(r: number | null): string {
  if (r === null) return "";
  if (r > 1.15) return `Between 0.1% and 10% the forecast's chances were about ${r.toFixed(1)} times too high.`;
  if (r < 0.87) return `Between 0.1% and 10% the forecast's chances were too low (about ${r.toFixed(1)} times what happened).`;
  return "Between 0.1% and 10% the forecast's chances were about right.";
}

export function renderForecast(host: HTMLElement, inp: ForecastInputs) {
  const parts: HTMLElement[] = [el("h2", "", "Forecast: the next 7 days")];
  const w = Math.max(260, host.clientWidth - 32);
  if (inp.status === "missing") {
    host.replaceChildren(...parts, el("p", "sub", "No forecast in this build. Run ./run.sh build (step: forecast)."),
      ...trenchSection(w));
    return;
  }
  if (inp.status === "loading" || !inp.data || !inp.view) {
    host.replaceChildren(...parts, el("p", "sub", "Loading the forecast…"));
    return;
  }
  const f = inp.data;
  const t = theme();
  const v = inp.view;
  const b = f.live.b;
  const win = fmtWindow(f.live.t0, f.live.days);

  parts.push(el("p", "sub",
    `Shallow quakes (down to ${f.maxDepth} km), ${win} (Japan time), ${inp.areaLabel}. ` +
    "Quakes make further quakes more likely nearby for a while; this statistical model (ETAS) adds that up " +
    "from every recent quake on top of each area's usual rate."));

  if (!v.cells) {
    host.replaceChildren(...parts, el("p", "sub", "No forecast cells in the visible area; zoom out."), ...trenchSection(w));
    return;
  }
  const p5 = chance(v.lam5);
  const ratio = v.base5 > 0 ? v.lam5 / v.base5 : NaN;
  parts.push(el("p", "lead",
    `Chance of at least one M5+ quake: ${fmtPct(p5)}. The long-term average for this area is ${fmtPct(chance(v.base5))}` +
    (Number.isFinite(ratio) ? (ratio >= 1.5 ? `; the forecast is ${ratio.toFixed(1)} times that.` :
      ratio <= 0.67 ? `; the forecast is below it (${ratio.toFixed(1)} times).` : "; the forecast is close to it.") : ".")));

  // Chances by magnitude.
  const table = document.createElement("table");
  table.className = "mini";
  const head = table.createTHead().insertRow();
  for (const h of ["", "This week", "Long-term average", "Expected number"]) head.append(el("th", "", h));
  const body = table.createTBody();
  for (const m of [5, 6, 7]) {
    const lam = atMag(v.lam5, b, m), base = atMag(v.base5, b, m);
    const tr = body.insertRow();
    tr.append(el("td", "", `M${m}+`), el("td", "", fmtPct(chance(lam))), el("td", "", fmtPct(chance(base))),
      el("td", "", lam >= 0.1 ? lam.toFixed(1) : lam.toPrecision(1)));
  }
  parts.push(table);

  // Map key.
  const key = el("div", "hot-legend");
  inp.colors.forEach((c, i) => {
    const k = el("div", "hot-key");
    const sw = el("span", "hot-swatch"); sw.style.background = c;
    const lo = inp.edges[i - 1], hi = inp.edges[i];
    k.append(sw, el("span", "", i === 0 ? `< ${fmtPct(hi)}` : i === inp.colors.length - 1 ? `≥ ${fmtPct(lo)}` : `${fmtPct(lo)}–${fmtPct(hi)}`));
    key.append(k);
  });
  parts.push(el("div", "chart-title", "Map: chance of an M5+ quake in each half-degree square (about 50 km) this week"), key);
  parts.push(el("p", "note",
    `The forecast starts where the data ends, ${timeJst(f.dataEnd)} Japan time. JMA's full preliminary lists run one ` +
    "to two days behind; the most recent quakes come from its live earthquake information, which lists felt quakes " +
    "only, so small quakes far offshore may be missing. This is a statistical forecast, not a warning: official information comes from JMA, " +
    "including the Nankai Trough and Japan/Kuril Trench advisories."));

  // ---------------------------------------------------------------- the test ---
  const ts = f.test;
  parts.push(el("h2", "", "How well has this worked?"));
  parts.push(el("p", "sub",
    `The same method forecast every week from ${ts.from.slice(0, 4)} on, with its settings fitted to ${f.testFit.from.slice(0, 4)}–` +
    `${+f.testFit.to.slice(0, 4) - 1} only and each week using just the quakes before it. Across Japan, it compared with ` +
    `a forecast of the long-term average (${f.testFit.from.slice(0, 4)}–${+f.testFit.to.slice(0, 4) - 1}).`));

  // Capture tiles.
  const tiles = el("div", "readout");
  const tile = (label: string, value: string, sub: string) => {
    const d = el("div", "stat");
    d.append(document.createTextNode(label), el("strong", "", value), el("span", "hint", sub));
    tiles.append(d);
  };
  tile("M5+ quakes in the top 1%", d3.format(".0%")(ts.capture.etas["0.01"]), `long-term average: ${d3.format(".0%")(ts.capture.base["0.01"])}`);
  tile("In the top 5%", d3.format(".0%")(ts.capture.etas["0.05"]), `long-term average: ${d3.format(".0%")(ts.capture.base["0.05"])}`);
  tile("Forecast vs observed", `${fmt(Math.round(ts.pred5))} / ${fmt(ts.n5)}`, `M5+ quakes, ${ts.weeks.length} weeks`);
  parts.push(tiles, el("p", "sub",
    "Top 1%: the squares and weeks each forecast rated most likely, 1% of all of them. The forecast concentrates " +
    `quakes there about ${(ts.capture.etas["0.01"] / ts.capture.base["0.01"]).toFixed(1)} times better than the long-term average. ` +
    `In total it ran ${d3.format(".0%")(ts.pred5 / ts.n5 - 1)} high (the long-term average: ${d3.format(".0%")(ts.base5 / ts.n5 - 1)} high), ` +
    `partly because ${f.testFit.from.slice(0, 4)}–${+f.testFit.to.slice(0, 4) - 1} was busier than the years since.`));

  // Weekly totals.
  const weeks = ts.weeks.map((x) => ({ ...x, date: new Date(x.t * 1000) }));
  const yMax = Math.max(d3.max(weeks, (x) => x.obs5) ?? 1, d3.max(weeks, (x) => x.pred5) ?? 1);
  const weekly = Plot.plot({
    width: w, height: 180, marginLeft: 34, marginBottom: 24,
    style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
    x: { type: "utc", label: null },
    y: { label: "↑ M5+ quakes per week", domain: [0, yMax], grid: true },
    marks: [
      Plot.dot(weeks.filter((x) => x.obs5 > 0), { x: "date", y: "obs5", r: 2, fill: t.series[1], fillOpacity: 0.7 }),
      Plot.line(weeks, { x: "date", y: "pred5", stroke: t.series[0], strokeWidth: 2 }),
    ],
  }) as SVGSVGElement;
  const wx = (weekly as unknown as { scale(n: string): { invert(p: number): Date } }).scale("x");
  weekly.addEventListener("pointermove", (ev) => {
    const pt = weekly.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const at = +wx.invert(pt.matrixTransform(weekly.getScreenCTM()!.inverse()).x) / 1000;
    const k = d3.bisector((x: { t: number }) => x.t).right(weeks, at) - 1;
    const wk = weeks[k];
    if (!wk || at > wk.t + 7 * 86400) { hideTooltip(); return; }
    showTooltip(ev.clientX, ev.clientY, (tip) => {
      tip.append(el("div", "t-head", `Week from ${dateJst(wk.t)}`));
      const row = (a: string, c: string) => { const r = el("div", "t-row"); r.append(el("span", "", a), el("strong", "", c)); tip.append(r); };
      row("Forecast M5+", wk.pred5.toFixed(1));
      row("Observed M5+", String(wk.obs5));
      row("Long-term average", ts.baseWeek5.toFixed(1));
    });
  });
  weekly.addEventListener("pointerleave", hideTooltip);
  const c1 = el("div", "chart");
  c1.append(el("div", "chart-title", "All of Japan: forecast and observed M5+ quakes each week"),
    legend([["Forecast (expected number)", t.series[0]], ["Observed", t.series[1]]]), weekly);
  parts.push(c1, el("p", "sub",
    `${d3.format(".0%")(ts.weeksInRange)} of weeks had an observed count within the forecast's 95% range ` +
    "(about 95% would be right). The forecast jumps after large quakes and decays as their aftershocks do; " +
    "it cannot anticipate the first large quake of a sequence."));

  // Reliability.
  const rel = (bins: RelBin[], name: string) => bins.filter((x) => x.hits > 0).map((x) => ({ ...x, obs: x.hits / x.n, name }));
  const relData = [...rel(ts.reliability.etas, "Forecast"), ...rel(ts.reliability.base, "Long-term average")];
  const relPlot = Plot.plot({
    width: Math.min(w, 360), height: Math.min(w, 360) * 0.85, marginLeft: 44, marginBottom: 34,
    style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
    x: { type: "log", domain: [5e-5, 1], label: "Forecast chance →", ticks: RTICKS, tickFormat: rtick },
    y: { type: "log", domain: [5e-5, 1], label: "↑ How often it happened", ticks: RTICKS, tickFormat: rtick, grid: true },
    color: { domain: ["Forecast", "Long-term average"], range: [t.series[0], t.series[1]] },
    marks: [
      Plot.line([[5e-5, 5e-5], [1, 1]], { stroke: t.muted, strokeDasharray: "3,3" }),
      Plot.line(relData, { x: "p", y: "obs", z: "name", stroke: "name", strokeWidth: 2 }),
      Plot.dot(relData, { x: "p", y: "obs", fill: "name", r: 4, stroke: t.surface, strokeWidth: 2,
        title: (d: RelBin & { obs: number; name: string }) =>
          `${d.name}: forecast ${fmtPct(d.lo)}–${fmtPct(d.hi)} (average ${fmtPct(d.p)}); happened in ${fmt(d.hits)} of ${fmt(d.n)} square-weeks (${fmtPct(d.obs)})` }),
    ],
  });
  const c2 = el("div", "chart");
  c2.append(el("div", "chart-title", "When it said X%, how often did an M5+ quake follow? (square-weeks)"),
    legend([["Forecast", t.series[0]], ["Long-term average", t.series[1]]]), relPlot);
  const hi = ts.reliability.etas.filter((x) => x.lo >= 0.1);
  const hiN = d3.sum(hi, (x) => x.n), hiHits = d3.sum(hi, (x) => x.hits), hiP = d3.sum(hi, (x) => x.p * x.n) / (hiN || 1);
  const baseHi = ts.reliability.base.filter((x) => x.lo >= 0.1);
  const bN = d3.sum(baseHi, (x) => x.n), bHits = d3.sum(baseHi, (x) => x.hits), bP = d3.sum(baseHi, (x) => x.p * x.n) / (bN || 1);
  parts.push(c2, el("p", "sub",
    "Points on the dashed line mean the stated chances came true as often as stated. " +
    (hiN ? `Where the forecast said 10% or more (average ${fmtPct(hiP)}), an M5+ quake followed in ${hiHits} of ${hiN} square-weeks. ` : "") +
    (bN ? `Where the long-term average said 10% or more (${fmtPct(bP)}), it followed in ${bHits} of ${fmt(bN)}. ` : "") +
    midText(overForecast(ts.reliability.etas, 0.001, 0.1))));

  // Prospective record.
  parts.push(el("h2", "", "Forecasts issued so far"));
  const scored = f.issued.filter((x) => x.obs5 !== undefined);
  parts.push(el("p", "sub",
    "The test above was run after the fact. Each build also records the forecast it shows, and scores it once the data " +
    "covers its 7 days: a record that can't be tuned afterwards. The forecast is reissued whenever new data arrives " +
    `(normally daily), so the 7-day windows overlap. ${f.issued.length} recorded, ${scored.length} scored so far.`));
  if (f.issued.length) {
    const tb = document.createElement("table");
    tb.className = "mini";
    const hr = tb.createTHead().insertRow();
    for (const h of ["7 days from", "Forecast M5+", "Average", "Observed"]) hr.append(el("th", "", h));
    const bd = tb.createTBody();
    for (const x of [...f.issued].reverse().slice(0, 12)) {
      const tr = bd.insertRow();
      tr.append(el("td", "", dateJst(x.t0)), el("td", "", x.pred5.toFixed(1)), el("td", "", x.base5.toFixed(1)),
        el("td", "", x.obs5 === undefined ? "pending" : String(x.obs5)));
    }
    parts.push(tb);
  }

  // Method notes.
  const det = document.createElement("details");
  det.className = "notes";
  det.append(el("summary", "", "How it works, and its limits"));
  const fp = f.fit.params;
  for (const text of [
    "Model: space-time ETAS (epidemic-type aftershock sequence; Ogata 1988, 1998). Every M4+ quake adds a burst of " +
      "expected quakes that fades with time as Omori's law and spreads over a distance growing with its magnitude; " +
      "a background rate, estimated by separating background from triggered quakes (Zhuang, Ogata & Vere-Jones 2002), adds the rest. " +
      `Magnitudes above M4 follow Gutenberg–Richter with b = ${b.toFixed(2)}.`,
    `Fitted to ${fmt(f.fit.n)} M4+ quakes no deeper than ${f.maxDepth} km, ${f.fit.from.slice(0, 4)}–${f.fit.to.slice(0, 4)}, ` +
      `from JMA's catalogue: α = ${fp.alpha.toFixed(2)}, p = ${fp.p.toFixed(2)}, c = ${(fp.c * 1440).toFixed(0)} min; ` +
      `${d3.format(".0%")(f.fit.backgroundShare)} of quakes come out as background, and each quake directly triggers ` +
      `${f.fit.branching.toFixed(2)} others on average. Quakes since the finalised catalogue are JMA's preliminary ones.`,
    "Quakes that happen during the week trigger their own aftershocks; that is added as an average factor " +
      `(${f.live.cascade.toFixed(2)} this week). This factor was changed after a first run of the test: it used a ` +
      "theoretical branching ratio that let rare giant quakes dominate, and the forecasts ran 41% high. The test shown uses " +
      "the corrected version, so it is not fully independent of that choice.",
    "Limits: it forecasts clustering, so most of its skill comes after a quake has already happened; it cannot foresee " +
      "a large quake out of a quiet area. Swarms (such as Miyakejima in 2000) and the 2011 sequence raise its background " +
      "in places. The chances on the map are for half-degree squares; a larger area has a larger chance. " +
      "M6+ and M7+ chances are scaled from M5+ by Gutenberg–Richter and are rougher.",
  ]) det.append(el("p", "", text));
  parts.push(det);
  host.replaceChildren(...parts, ...trenchSection(w));
}
