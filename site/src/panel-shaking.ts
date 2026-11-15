// Shaking tab: hotspots of felt shaking (the average yearly rate of the stations
// in each grid cell) for all of Japan, or what was felt near a chosen place.
import * as d3 from "d3";
import { CELL_DEG, LEVELS, MIN_YEARS, type Cell } from "./hotspots";
import { placeBody, placeControls, type LocationInputs } from "./panel-location";
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

export interface HotspotInputs {
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
  onCell(c: Cell): void; // choose the square as the place
}

/** Shaking tab: the squares for all of Japan, or once a place is chosen, what was felt there. */
export function renderShaking(host: HTMLElement, hot: HotspotInputs, place: LocationInputs) {
  const parts: HTMLElement[] = [
    el("h2", "", place.place ? `Shaking near ${place.place.name}` : "Shaking"),
    el("p", "sub", "How often the ground shook, from the readings at Japan's seismic intensity stations."),
    placeControls(place),
  ];
  if (place.place) {
    parts.push(levelButtons(hot.level, hot.onLevel, "The map shows the epicentres of quakes felt here at this shindo or stronger"),
      ...placeBody(place, host.clientWidth));
  } else {
    const [hint, ...rest] = hotspots(hot); // "Or click a square…" stays next to the place buttons
    parts.push(hint, levelButtons(hot.level, hot.onLevel, "The squares count shaking at this shindo or stronger"), ...rest);
  }
  host.replaceChildren(...parts);
}

/** Shindo 1+ · 3+ · 4+ · 5−+: which shaking the squares count, or the place's map shows. */
function levelButtons(level: number, onLevel: (i: number) => void, tip: string): HTMLElement {
  const row = el("div", "presets levels");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Shindo");
  row.title = tip;
  row.append(el("span", "levels-title", "Shindo"));
  LEVELS.forEach((l, i) => {
    const b = el("button", i === level ? "primary" : "", l.short) as HTMLButtonElement;
    b.type = "button";
    b.title = `${l.label}. ${tip}`;
    b.setAttribute("aria-pressed", String(i === level));
    b.addEventListener("click", () => onLevel(i));
    row.append(b);
  });
  return row;
}

function hotspots(inp: HotspotInputs): HTMLElement[] {
  const parts: HTMLElement[] = [el("p", "sub", "Or click a square on the map to see what was felt there.")];
  const controls = el("div", "controls-row");
  if (inp.from < 1997) {
    const era = el("button", "", "Use 1997–" + inp.years[1]) as HTMLButtonElement;
    era.type = "button";
    era.title = "Instrumental intensity meters replaced human observers in 1996";
    era.addEventListener("click", () => inp.onInstrumentalEra());
    controls.append(era);
  }
  if (controls.childElementCount) parts.push(controls);

  if (inp.status === "loading" || !inp.stations) return [...parts, el("p", "sub", "Loading station records…")];
  const period = inp.from === inp.to ? `${inp.from}` : `${inp.from}–${inp.to}`;

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
  parts.push(el("div", "chart-title", `Times per year with ${LEVELS[inp.level].label}, ${period}`), legend);

  // Most shaken squares.
  const top = [...inp.cells].sort((a, b) => b.rate - a.rate).slice(0, 10);
  const table = document.createElement("table");
  table.className = "mini";
  const head = table.createTHead().insertRow();
  for (const h of ["Square", "Per year", "Busiest station"]) head.append(el("th", "", h));
  const body = table.createTBody();
  for (const c of top) {
    const busiest = c.stations.reduce((a, b) => (b.rate > a.rate ? b : a));
    const tr = body.insertRow();
    tr.append(
      el("td", "", `${(c.lat + CELL_DEG / 2).toFixed(1)}°N ${(c.lon + CELL_DEG / 2).toFixed(1)}°E`),
      el("td", "", fmtRate(c.rate)),
      el("td", "", inp.stations.name[busiest.station] || inp.stations.id[busiest.station]),
    );
    rowAction(tr, "See what was felt here", () => inp.onCell(c));
  }
  const tw = el("div", "chart");
  tw.append(el("div", "chart-title", "Most shaken squares (click one to see what was felt there)"), table);
  parts.push(tw);

  const notes = el("details", "notes");
  notes.append(el("summary", "", "How this is counted"), el("p", "sub",
    `Each ${CELL_DEG}° square shows the average yearly count of its stations (each in operation at least ${MIN_YEARS} ` +
    "years of the period), so places with many stations don't look busier just for having them. Long periods are " +
    "dominated by big sequences, above all 2011 off Tōhoku. Before 1996 intensities were reported by people, not " +
    "instruments. Temporary stations (臨時) are left out. In station names, ＊ marks stations run by local governments " +
    "or NIED, and （旧） one that has since closed or moved."));
  parts.push(notes);
  return parts;
}
