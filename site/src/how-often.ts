// "How often quakes happen": a folded table on the Quakes tab (while nothing is open) for the
// visible map area and the timeline's years, from the finalised catalogue's counts (gr.json).
import * as d3 from "d3";
import { estimateMc, histogram, type GrData } from "./gr";
import { el, fmt } from "./ui";

export interface HowOftenInputs {
  from: number;
  to: number;
  cells: Set<number> | null; // 2° squares in view; null for all of Japan
  areaLabel: string;
  open: boolean;
  onToggle(open: boolean): void;
}

/** Steps in JMA's processing where detection of small quakes improved. */
export function erasFor(data: GrData): [number, number][] {
  const [a, b] = data.years;
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
 * How often quakes of each size happen in the area, as yearly averages over the timeline's
 * years. Detection improved over time, so each size is averaged only over the eras in which
 * it was fully recorded (the era's magnitude of completeness at or below it).
 */
export function howOftenSection(data: GrData, inp: HowOftenInputs): HTMLElement {
  const d = el("details", "notes fold") as HTMLDetailsElement;
  d.open = inp.open;
  d.addEventListener("toggle", () => inp.onToggle(d.open));
  d.append(el("summary", "", "How often quakes happen"));
  const last = data.years[1];
  if (inp.from > last) {
    d.append(el("p", "sub", `These counts use the finalised catalogue, which ends in ${last}. ` +
      `Move the start of the timeline to ${last} or earlier.`));
    return d;
  }
  const to = Math.min(inp.to, last);
  const years = to - inp.from + 1;
  const span = (a: number, b: number) => (a === b ? `${a}` : `${a}–${b}`);
  // Each era's completeness: from the area if it has enough quakes, else from all of Japan.
  const parts = erasFor(data).flatMap(([a, b]) => {
    const lo = Math.max(a, inp.from), hi = Math.min(b, to);
    if (lo > hi) return [];
    const mc = estimateMc(histogram(data, { from: a, to: b, cells: inp.cells })).mc
      ?? estimateMc(histogram(data, { from: a, to: b, cells: null })).mc ?? 5;
    return [{ lo, hi, mc, h: histogram(data, { from: lo, to: hi, cells: inp.cells }) }];
  });
  const atLeast = (h: Map<number, number>, m: number) => { let n = 0; for (const [m10, c] of h) if (m10 >= m * 10) n += c; return n; };
  const table = document.createElement("table");
  table.className = "mini how-often";
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
  if (years > 3) notes.push("Quakes cluster, so single years vary a lot.");
  if (partial) notes.push("Smaller quakes weren't all recorded in earlier years, so those sizes count only the years " +
    "when they were (\"from …\").");
  if (inp.to > last) notes.push(`Counts stop at the end of ${last} (the finalised catalogue).`);
  d.append(el("p", "sub", `${inp.areaLabel[0].toUpperCase()}${inp.areaLabel.slice(1)}, ${span(inp.from, to)}.`),
    table, el("p", "sub", notes.join(" ")));
  return d;
}
