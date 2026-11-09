// Forecast tab, long-term section: the historical great trench quakes on a timeline,
// beside HERP's official 30-year probabilities (data in trench-history.ts).
import * as Plot from "@observablehq/plot";
import { el, theme } from "./ui";
import { AS_OF, HERP_LTE, HERP_SUMMARY, OUTLOOK, ROWS, type TrenchEvent } from "./trench-history";

const X0 = 650, X1 = 2030;
const NOW = new Date().getUTCFullYear();

interface Mark extends TrenchEvent { row: string }

const ZONE_NAMES: Record<string, string> = {
  Kuril: "Kuril Trench (off eastern Hokkaido)", "Japan Trench": "Japan Trench (off Tōhoku)",
  Sagami: "Sagami Trough (Kantō, Tokyo area)", Nankai: "Nankai Trough (Shizuoka to Kyūshū)",
};

function link(href: string, text: string) {
  const a = document.createElement("a");
  a.href = href; a.textContent = text; a.target = "_blank"; a.rel = "noopener";
  return a;
}

export function trenchSection(width: number): HTMLElement[] {
  const t = theme();
  const out: HTMLElement[] = [el("h2", "", "The long view: great quakes along the trenches")];
  out.push(el("p", "sub",
    "The week-ahead forecast above can't see the rare great quakes coming. For those, the government's earthquake " +
    "research headquarters (HERP) gives long-term chances from each trench's history. Below: that history " +
    "since 684, and HERP's chances for the next 30 years."));

  const marks: Mark[] = ROWS.flatMap((r) => r.events.map((e) => ({ ...e, row: r.id })));
  const order = ROWS.map((r) => r.id);
  const label = new Map(ROWS.map((r) => [r.id, r.label]));
  const tipText = (d: Mark) =>
    `${d.to ? `${d.year}–${d.to}` : d.year}: ${d.name} (${d.ja})` + (d.m ? `, M${d.m}` : "") +
    (d.sure ? "" : " — uncertain") + (d.note ? `\n${d.note}` : "");

  const chart = Plot.plot({
    width, height: ROWS.length * 46 + 30, marginLeft: 8, marginRight: 12, marginTop: 6,
    style: { background: "transparent", color: t.secondary, fontSize: "11px" },
    x: { domain: [X0, X1], tickFormat: "d", ticks: width < 420 ? 4 : 8, label: null, grid: true },
    fy: { domain: order, axis: null, padding: 0 },
    // Each lane: label at the top, events on a line 10px below the middle.
    y: { domain: [-1, 1], axis: null },
    marks: [
      Plot.gridX({ stroke: t.grid, strokeOpacity: 1 }),
      Plot.text(order, { fy: (d) => d, frameAnchor: "top-left", dy: 2, text: (d) => label.get(d) ?? d,
        fill: t.text, fontSize: 11 }),
      Plot.ruleY(order, { fy: (d) => d, y: () => 0, dy: 10, x1: X0, x2: NOW, stroke: t.axis, strokeOpacity: 0.6 }),
      // Date ranges (tsunami-deposit dating).
      Plot.ruleY(marks.filter((d) => d.to), { fy: "row", y: () => 0, x1: "year", x2: "to", dy: 10, stroke: t.series[0],
        strokeWidth: 8, strokeLinecap: "round" }),
      Plot.dot(marks.filter((d) => !d.to), { fy: "row", x: "year", y: () => 0, dy: 10, r: 5,
        fill: (d: Mark) => (d.sure ? t.series[0] : t.surface), stroke: t.series[0], strokeWidth: 2 }),
      Plot.tip(marks, Plot.pointer({ fy: "row", x: (d: Mark) => (d.to ? (d.year + d.to) / 2 : d.year), y: () => 0, dy: 10,
        title: tipText, maxRadius: 30 })),
    ],
  });
  const key = el("div", "legend");
  for (const [txt, fill] of [["Recorded", t.series[0]], ["Possible / uncertain", t.surface]] as const) {
    const k = el("span", "key");
    const sw = el("span", "swatch");
    sw.style.cssText = `width:10px;height:10px;border-radius:50%;background:${fill};border:2px solid ${t.series[0]};box-sizing:border-box`;
    k.append(sw, el("span", "", txt));
    key.append(k);
  }
  const c = el("div", "chart");
  c.append(el("div", "chart-title", "Great quakes on each trench since 684 (hover a dot for details)"), key, chart);
  out.push(c);
  out.push(el("p", "sub",
    "Older records are thinner: before 1361 on the Nankai Trough and before about 1600 on the Japan Trench, quakes may " +
    "be missing and which segment broke is uncertain, so gaps there don't mean it was quiet. Tsunami deposits go further " +
    "back (to about 5,000 years ago on the Nankai Trough)."));

  // Official chances.
  const tb = document.createElement("table");
  tb.className = "mini trench";
  const hr = tb.createTHead().insertRow();
  for (const h of ["Quake", "Last", "Interval", "30 years"]) hr.append(el("th", "", h));
  const bd = tb.createTBody();
  let prev = "";
  for (const o of OUTLOOK) {
    if (o.zone !== prev) {
      const zr = bd.insertRow();
      zr.className = "zone";
      const td = el("td", "", ZONE_NAMES[o.zone] ?? o.zone) as HTMLTableCellElement;
      td.colSpan = 4;
      zr.append(td);
      prev = o.zone;
    }
    const tr = bd.insertRow();
    tr.append(el("td", "", o.quake), el("td", "", o.last), el("td", "", o.interval), el("td", "", o.p30));
  }
  const wrap = el("div", "trench-wrap");
  wrap.append(tb);
  out.push(el("div", "chart-title", `HERP's chances of each quake within 30 years (calculated for ${AS_OF})`), wrap);

  const src = el("p", "sub");
  src.append(
    "The Nankai Trough has two official figures since September 2025: 60–90% or more from a model that uses how much " +
    "the coast rose in past quakes (smaller Shōwa quakes, shorter wait), and 20–50% from the dates alone. HERP says " +
    "neither model can be shown to be better, and recommends stressing the higher one. The southern Kantō M7 figure " +
    "covers quakes under the Tokyo area from many sources, so it isn't a single line on the timeline. Source: ",
    link(HERP_LTE, "HERP long-term evaluations"), " and ", link(HERP_SUMMARY, "summary of results"),
    " (地震調査研究推進本部), transcribed by hand.");
  out.push(src);
  return out;
}
