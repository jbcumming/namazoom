// Shaking tab: hotspots of felt shaking, as the average yearly rate of the
// stations in each grid cell.
import * as d3 from "d3";
import { CELL_DEG, LEVELS, MIN_YEARS, type Cell } from "./hotspots";
import type { Stations } from "./shindo";
import { el, fmt, rowAction } from "./ui";

export const HOT_STEPS = 7;

export function hotColors(): string[] {
  const css = getComputedStyle(document.documentElement);
  return d3.range(HOT_STEPS).map((i) => css.getPropertyValue(`--hot-${i + 1}`).trim());
}

/** Log-scale range for the colours: from the 5th to the 99th percentile, widened to 1-2-5 steps. */
export function scaleRange(cells: Cell[]): [number, number] {
  const rates = cells.map((c) => c.rate).filter((r) => r > 0).sort(d3.ascending);
  if (!rates.length) return [0.1, 1];
  const nice = (v: number, up: boolean) => {
    const e = Math.floor(Math.log10(v));
    const steps = [1, 2, 5, 10];
    const m = v / 10 ** e;
    const s = up ? steps.find((x) => x >= m - 1e-9)! : [...steps].reverse().find((x) => x <= m + 1e-9)!;
    return s * 10 ** e;
  };
  const lo = nice(d3.quantile(rates, 0.05)!, false);
  const hi = nice(d3.quantile(rates, 0.99)!, true);
  return hi > lo ? [lo, hi] : [lo, lo * 10];
}

export const fmtRate = (v: number) => (v >= 10 ? fmt(Math.round(v)) : d3.format(".2~r")(v));

export interface ShakingInputs {
  status: "loading" | "ok";
  level: number; // index into LEVELS
  from: number;
  to: number;
  years: [number, number];
  cells: Cell[];
  range: [number, number];
  stations: Stations | null;
  onLevel(i: number): void;
  onInstrumentalEra(): void;
  onCell(c: Cell): void;
}

export function renderShaking(host: HTMLElement, inp: ShakingInputs) {
  const parts: HTMLElement[] = [
    el("h2", "", "Shaking hotspots"),
    el("p", "sub", "How often the ground shook, from seismic intensity stations: each square shows the average yearly " +
      "rate of its stations, so places with many stations don't look busier just for having them."),
  ];
  const controls = el("div", "controls-row");
  const level = document.createElement("select");
  LEVELS.forEach((l, i) => {
    const o = document.createElement("option");
    o.value = String(i); o.textContent = l.label; o.selected = i === inp.level;
    level.append(o);
  });
  level.addEventListener("change", () => inp.onLevel(Number(level.value)));
  const ll = el("label", "inline", "Count ");
  ll.append(level);
  controls.append(ll);
  if (inp.from < 1997) {
    const era = el("button", "", "Use 1997–" + inp.years[1]) as HTMLButtonElement;
    era.type = "button";
    era.title = "Instrumental intensity meters replaced human observers in 1996";
    era.addEventListener("click", () => inp.onInstrumentalEra());
    controls.append(era);
  }
  parts.push(controls);

  if (inp.status === "loading" || !inp.stations) {
    host.replaceChildren(...parts, el("p", "sub", "Loading station records…"));
    return;
  }
  const period = inp.from === inp.to ? `${inp.from}` : `${inp.from}–${inp.to}`;
  const nStations = d3.sum(inp.cells, (c) => c.stations.length);
  parts.push(el("p", "lead", `${LEVELS[inp.level].label[0].toUpperCase()}${LEVELS[inp.level].label.slice(1)} per year, ${period}: ` +
    `${fmt(nStations)} stations in ${fmt(inp.cells.length)} squares of ${CELL_DEG}°.`));

  // Legend with the class edges.
  const colors = hotColors();
  const [lo, hi] = inp.range;
  const edges = d3.range(HOT_STEPS + 1).map((i) => 10 ** (Math.log10(lo) + ((Math.log10(hi) - Math.log10(lo)) * i) / HOT_STEPS));
  const legend = el("div", "hot-legend");
  colors.forEach((c, i) => {
    const k = el("div", "hot-key");
    const sw = el("span", "hot-swatch"); sw.style.background = c;
    k.append(sw, el("span", "", i === 0 ? `< ${fmtRate(edges[1])}` : i === HOT_STEPS - 1 ? `≥ ${fmtRate(edges[i])}` : `${fmtRate(edges[i])}–${fmtRate(edges[i + 1])}`));
    legend.append(k);
  });
  parts.push(el("div", "chart-title", "Times per year (average of the stations in a square)"), legend);

  // Hottest squares.
  const top = [...inp.cells].sort((a, b) => b.rate - a.rate).slice(0, 10);
  const table = document.createElement("table");
  table.className = "mini";
  const head = table.createTHead().insertRow();
  for (const h of ["Square", "Per year", "Stations", "Busiest station"]) head.append(el("th", "", h));
  const body = table.createTBody();
  for (const c of top) {
    const busiest = c.stations.reduce((a, b) => (b.rate > a.rate ? b : a));
    const tr = body.insertRow();
    tr.append(
      el("td", "", `${(c.lat + CELL_DEG / 2).toFixed(1)}°N ${(c.lon + CELL_DEG / 2).toFixed(1)}°E`),
      el("td", "", fmtRate(c.rate)),
      el("td", "", String(c.stations.length)),
      el("td", "", inp.stations.name[busiest.station] || inp.stations.id[busiest.station]),
    );
    rowAction(tr, "Show on the map", () => inp.onCell(c));
  }
  const tw = el("div", "chart");
  tw.append(el("div", "chart-title", "Hottest squares (click to show on the map)"), table);
  parts.push(tw);

  parts.push(el("p", "sub",
    `A station counts once per quake it felt at the chosen level, divided by its years in operation within the period ` +
    `(at least ${MIN_YEARS}). Long periods are dominated by big sequences, above all 2011 off Tōhoku; narrow the timeline ` +
    "to compare quieter times. Before 1996 intensities were reported by people, not instruments, and weak shaking was " +
    "recorded less consistently. Temporary stations (臨時), set up during a sequence, are left out. In station names, " +
    "＊ marks stations run by local governments or NIED rather than JMA, and （旧） a station that has since closed or moved."));
  host.replaceChildren(...parts);
}
