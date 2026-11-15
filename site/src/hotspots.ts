// Shaking hotspots: how often the ground shook at stations, averaged on a grid.
// Data: pipeline/build/site_data.py build_station_counts. Pure functions, no DOM.
import type { Stations } from "./shindo";

export interface StationCounts { st: number[]; y: number[]; k: number[]; n: number[] }

export const CELL_DEG = 0.2;
export const MIN_YEARS = 3;

/** Temporary stations, installed during an active sequence and removed after it
 * (e.g. 奥尻町奥尻（臨時）, 1993-95): their rates are inflated by design, so they
 * are left out. "臨時庁舎" (a temporary town-office building) is a regular station. */
export const isTemporary = (name: string) => name.includes("（臨時）");

/** Levels offered: index into the shindo classes (0 = shindo 1, 3 = 4, 4 = 5-). */
export const LEVELS = [
  { minClass: 0, label: "shindo 1+ (felt at all)", short: "1+" },
  { minClass: 2, label: "shindo 3+", short: "3+" },
  { minClass: 3, label: "shindo 4+", short: "4+" },
  { minClass: 4, label: "shindo 5− or stronger", short: "5−+" },
];

export interface StationRate { station: number; rate: number; count: number; years: number }

const yearOfIso = (s: string | null) => (s ? Number(s.slice(0, 4)) : null);

/**
 * Felt readings per year at each station with at least MIN_YEARS of record in
 * [from, to]. Readings of "felt, intensity unknown" (k = -1) count only for
 * the lowest level. Years in operation come from the station list, but never
 * fewer than the years the station actually reported something, so a
 * missing start date can't inflate a rate.
 */
export function stationRates(c: StationCounts, stations: Stations, from: number, to: number, minClass: number): StationRate[] {
  const count = new Map<number, number>();
  const reportYears = new Map<number, Set<number>>();
  for (let i = 0; i < c.st.length; i++) {
    const y = c.y[i];
    if (y < from || y > to) continue;
    const s = c.st[i];
    if (!reportYears.has(s)) reportYears.set(s, new Set());
    reportYears.get(s)!.add(y);
    const k = c.k[i];
    if (k >= minClass || (k === -1 && minClass === 0)) count.set(s, (count.get(s) ?? 0) + c.n[i]);
  }
  const out: StationRate[] = [];
  for (let s = 0; s < stations.id.length; s++) {
    if (stations.lat[s] === null || stations.lon[s] === null) continue;
    if (isTemporary(stations.name[s])) continue;
    const a = Math.max(from, yearOfIso(stations.start[s]) ?? from);
    const b = Math.min(to, yearOfIso(stations.end[s]) ?? to);
    const years = Math.max(b - a + 1, reportYears.get(s)?.size ?? 0, 0);
    if (years < MIN_YEARS) continue;
    const n = count.get(s) ?? 0;
    out.push({ station: s, rate: n / years, count: n, years });
  }
  return out;
}

export interface Cell {
  lat: number; // south-west corner
  lon: number;
  rate: number; // mean of station rates
  stations: StationRate[];
}

/** Average station rates on a CELL_DEG grid (an average, not a sum, so dense networks don't look hotter). */
export function grid(rates: StationRate[], stations: Stations, cellDeg = CELL_DEG): Cell[] {
  const cells = new Map<string, Cell>();
  for (const r of rates) {
    const lat = Math.floor(stations.lat[r.station]! / cellDeg) * cellDeg;
    const lon = Math.floor(stations.lon[r.station]! / cellDeg) * cellDeg;
    const key = `${lat.toFixed(2)}_${lon.toFixed(2)}`;
    if (!cells.has(key)) cells.set(key, { lat, lon, rate: 0, stations: [] });
    cells.get(key)!.stations.push(r);
  }
  for (const c of cells.values()) c.rate = c.stations.reduce((s, r) => s + r.rate, 0) / c.stations.length;
  return [...cells.values()];
}

/** Colour class 0..steps-1 for a rate on a log scale between lo and hi. */
export function logClass(rate: number, lo: number, hi: number, steps: number): number {
  if (rate <= lo) return 0;
  if (rate >= hi) return steps - 1;
  return Math.min(steps - 1, Math.floor(((Math.log10(rate) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * steps));
}
