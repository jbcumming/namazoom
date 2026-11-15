// Forecast tab: the 7-day ETAS forecast for the visible area, and how the same
// method did on past weeks.
import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { atMag, chance, fmtPct, fmtWindow, overForecast, type CellSum, type Forecast, type RelBin } from "./forecast";
import { trenchSection, type ZoneInputs } from "./panel-trench";
import { el, fmt, hideTooltip, showTooltip, theme } from "./ui";

/** Forecast map colours: a violet ramp, kept apart from the Shaking tab's green rates. */
export function fcColors(): string[] {
  const css = getComputedStyle(document.documentElement);
  return d3.range(7).map((i) => css.getPropertyValue(`--fc-${i + 1}`).trim());
}

export interface ForecastInputs {
  status: "loading" | "ok" | "missing";
  data: Forecast | null;
  view: CellSum | null; // cells in the visible area
  areaLabel: string;
  colors: string[];
  edges: number[];
  zones: ZoneInputs;
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

/** Says plainly what the weekly numbers are, before any of them. */
function experimentNote(): HTMLElement {
  const box = el("div", "experiment");
  const a = document.createElement("a");
  a.href = "https://www.jma.go.jp/jma/indexe.html"; a.target = "_blank"; a.rel = "noopener"; a.textContent = "JMA";
  const p = el("p");
  p.append("This site runs a simple statistical model on JMA's data to see how well it does. It can't foresee a " +
    "large quake, isn't official, and isn't a basis for any decision. For warnings and advisories, follow ", a, ".");
  box.append(el("strong", "", "A statistical experiment, not a prediction"), p);
  return box;
}

export function renderForecast(host: HTMLElement, inp: ForecastInputs) {
  const parts: HTMLElement[] = [el("h2", "", "Forecast: the next 7 days"), el("p", "sub",
    "Quakes cluster: after any quake, more are likely nearby for a while. This model adds that up from recent quakes " +
    "to give the chance of quakes in the coming week."), experimentNote()];
  const w = Math.max(260, host.clientWidth - 32);
  if (inp.status === "missing") {
    host.replaceChildren(...parts, el("p", "sub", "No forecast in this build. Run ./run.sh build (step: forecast)."),
      ...trenchSection(w, inp.zones));
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

  if (!v.cells) {
    host.replaceChildren(...parts, el("p", "sub", "No forecast squares in the visible area; zoom out."), ...trenchSection(w, inp.zones));
    return;
  }
  const p5 = chance(v.lam5);
  const ratio = v.base5 > 0 ? v.lam5 / v.base5 : NaN;

  // This week against usual, then by magnitude.
  const level = !Number.isFinite(ratio) ? "" : ratio >= 1.5 ? `above usual (${ratio.toFixed(1)} times)`
    : ratio <= 0.67 ? "below usual" : "about usual";
  const sum = el("div", "summary");
  const line1 = el("p");
  line1.append(`This week, ${inp.areaLabel}: `, el("strong", "", fmtPct(p5)),
    ` chance of at least one M5+ quake; usually ${fmtPct(chance(v.base5))}` + (level ? `, so ${level}.` : "."));
  sum.append(line1);
  parts.push(sum, el("p", "sub", `${win} (Japan time), quakes down to ${f.maxDepth} km. For the area on the map: zoom or pan to change it.`));

  const table = document.createElement("table");
  table.className = "mini";
  const head = table.createTHead().insertRow();
  for (const h of ["", "This week", "Usually"]) head.append(el("th", "", h));
  const body = table.createTBody();
  for (const m of [5, 6, 7]) {
    const lam = atMag(v.lam5, b, m), base = atMag(v.base5, b, m);
    const tr = body.insertRow();
    tr.append(el("td", "", `M${m}+`), el("td", "", fmtPct(chance(lam))), el("td", "", fmtPct(chance(base))));
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
  parts.push(el("div", "chart-title", "Map: chance of an M5+ quake in each square (about 50 km) this week"), key,
    el("p", "sub", "Squares near recent quakes stand out. Even 5% means 19 weeks in 20 pass with none."));

  // ---------------------------------------------------------------- the test ---
  const ts = f.test;
  const testStart = parts.length;
  parts.push(el("h2", "", "How well has this worked?"));
  const fitYears = `${f.testFit.from.slice(0, 4)}–${+f.testFit.to.slice(0, 4) - 1}`;
  parts.push(el("p", "sub",
    `Run on every week since ${ts.from.slice(0, 4)}, with settings fitted to ${fitYears} only and each week using just ` +
    "the quakes before it, against simply forecasting the long-term average."));

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
    `Top 1%: the 1% of squares and weeks it rated most likely, where it caught M5+ quakes about ` +
    `${(ts.capture.etas["0.01"] / ts.capture.base["0.01"]).toFixed(1)} times better than the long-term average. Overall it ` +
    `ran ${d3.format(".0%")(ts.pred5 / ts.n5 - 1)} high (the long-term average: ${d3.format(".0%")(ts.base5 / ts.n5 - 1)}), ` +
    `partly because ${fitYears} was busier than the years since.`));

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
    `${d3.format(".0%")(ts.weeksInRange)} of weeks fell within its 95% range. It jumps after large quakes and fades ` +
    "with their aftershocks; it can't see the first large quake of a sequence coming."));

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
    "On the dashed line, stated chances came true as often as stated. " +
    (hiN ? `Where it said 10% or more (average ${fmtPct(hiP)}), an M5+ quake followed in ${hiHits} of ${hiN} square-weeks` +
      (bN ? ` (the long-term average: ${bHits} of ${fmt(bN)} at ${fmtPct(bP)}). ` : ". ") : "") +
    midText(overForecast(ts.reliability.etas, 0.001, 0.1))));

  // Prospective record.
  parts.push(el("h2", "", "Forecasts issued so far"));
  const scored = f.issued.filter((x) => x.obs5 !== undefined);
  parts.push(el("p", "sub",
    "The test above was run after the fact. Each daily build also records the forecast it shows and scores it once its " +
    `7 days are in the data, a record that can't be tuned afterwards. ${f.issued.length} recorded, ${scored.length} scored so far.`));
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

  // The back-test and the record, folded away: useful, but long.
  const testParts = parts.splice(testStart);
  const tdet = document.createElement("details");
  tdet.className = "notes";
  const tsum = el("summary", "", "How well has it done?");
  tdet.append(tsum, ...testParts.slice(1)); // the h2 is replaced by the summary
  parts.push(tdet);

  // Method notes.
  const det = document.createElement("details");
  det.className = "notes";
  det.append(el("summary", "", "How the model works"));
  const fp = f.fit.params;
  for (const text of [
    "ETAS (Ogata 1988, 1998): every M4+ quake adds expected quakes nearby that fade over time (Omori's law), on top of " +
      `each area's background rate (Zhuang, Ogata & Vere-Jones 2002). Sizes follow Gutenberg–Richter with b = ${b.toFixed(2)}, ` +
      "so the M6+ and M7+ chances are scaled from M5+ and are rougher.",
    `Fitted to ${fmt(f.fit.n)} M4+ quakes down to ${f.maxDepth} km, ${f.fit.from.slice(0, 4)}–${f.fit.to.slice(0, 4)}: ` +
      `α = ${fp.alpha.toFixed(2)}, p = ${fp.p.toFixed(2)}, c = ${(fp.c * 1440).toFixed(0)} min; ` +
      `${d3.format(".0%")(f.fit.backgroundShare)} of quakes are background, and each triggers ${f.fit.branching.toFixed(2)} others ` +
      `on average. Quakes during the week add their own aftershocks as an average factor (${f.live.cascade.toFixed(2)}); ` +
      "this was changed after a first run of the test, so the test isn't fully independent of it.",
    `Data up to ${timeJst(f.dataEnd)} Japan time. The newest days come from JMA's live list of felt quakes, so small ` +
      "quakes far offshore may be missing. Swarms and the 2011 sequence raise the background in places; a larger area has " +
      "a larger chance than one square.",
  ]) det.append(el("p", "", text));
  parts.push(det);
  host.replaceChildren(...parts, ...trenchSection(w, inp.zones));
}
