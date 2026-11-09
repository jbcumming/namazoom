// 7-day ETAS forecast (pipeline/build/forecast.py): types and pure helpers.

export interface FitInfo {
  from: string; to: string; n: number; b: number;
  params: Record<string, number>;
  branching: number; backgroundShare: number;
}
export interface RelBin { lo: number; hi: number; n: number; p: number; hits: number }
export interface TestWeek { t: number; pred5: number; pred6: number; obs5: number; obs6: number; cascade: number }
export interface Forecast {
  m0: number;
  maxDepth: number;
  grid: { lat0: number; lon0: number; step: number };
  dataEnd: number; // UTC seconds
  fit: FitInfo;
  testFit: FitInfo;
  live: {
    t0: number; days: number; b: number; cascade: number;
    expected: Record<string, number>; baseline: Record<string, number>;
    cells: [number, number, number, number][]; // i, j, expected M5+, long-term expected M5+
  };
  test: {
    from: string; weeks: TestWeek[]; baseWeek5: number;
    n5: number; pred5: number; base5: number; gainPerQuake: number;
    reliability: { etas: RelBin[]; base: RelBin[] };
    capture: { etas: Record<string, number>; base: Record<string, number> };
    weeksInRange: number;
  };
  issued: { t0: number; issued: string; pred5: number; base5: number; obs5?: number }[];
}

/** Chance of at least one quake when the expected number is lam (Poisson). */
export const chance = (lam: number) => 1 - Math.exp(-lam);

/** Expected number at or above magnitude m from the expected number of M5+, by Gutenberg-Richter. */
export const atMag = (lam5: number, b: number, m: number) => lam5 * 10 ** (-b * (m - 5));

export interface CellSum { lam5: number; base5: number; cells: number }

/** Sum the cells whose centres are inside the bounds (all cells when bounds is null). */
export function sumCells(f: Forecast, bounds: { w: number; s: number; e: number; n: number } | null): CellSum {
  const { lat0, lon0, step } = f.grid;
  let lam5 = 0, base5 = 0, cells = 0;
  for (const [i, j, l, b] of f.live.cells) {
    const lat = lat0 + (i + 0.5) * step, lon = lon0 + (j + 0.5) * step;
    if (bounds && (lon < bounds.w || lon > bounds.e || lat < bounds.s || lat > bounds.n)) continue;
    lam5 += l; base5 += b; cells++;
  }
  return { lam5, base5, cells };
}

/** Probability classes for the map, fixed so colours mean the same after every rebuild. */
export const P_EDGES = [0.0003, 0.001, 0.003, 0.01, 0.03, 0.1];
export const pClass = (p: number) => P_EDGES.filter((e) => p >= e).length;

export function fmtPct(p: number): string {
  if (p >= 0.995) return ">99%";
  if (p >= 0.1) return `${Math.round(p * 100)}%`;
  if (p >= 0.01) return `${(p * 100).toFixed(1).replace(/\.0$/, "")}%`;
  if (p >= 0.001) return `${(p * 100).toFixed(2).replace(/0$/, "")}%`;
  if (p >= 0.0001) return `${+(p * 100).toPrecision(1)}%`;
  if (p > 0) return "<0.01%";
  return "0%";
}

/** "8–14 Nov 2026": the forecast window's days in JST (end exclusive). */
export function fmtWindow(t0: number, days: number): string {
  const d = (t: number) => new Date((t + 9 * 3600) * 1000);
  const a = d(t0), b = d(t0 + (days - 1) * 86400);
  const mon = (x: Date) => x.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  if (a.getUTCMonth() === b.getUTCMonth()) return `${a.getUTCDate()}–${b.getUTCDate()} ${mon(b)} ${b.getUTCFullYear()}`;
  if (a.getUTCFullYear() === b.getUTCFullYear()) return `${a.getUTCDate()} ${mon(a)} – ${b.getUTCDate()} ${mon(b)} ${b.getUTCFullYear()}`;
  return `${a.getUTCDate()} ${mon(a)} ${a.getUTCFullYear()} – ${b.getUTCDate()} ${mon(b)} ${b.getUTCFullYear()}`;
}

/** Ratio of forecast to observed frequency over the reliability bins between lo and hi (counts-weighted). */
export function overForecast(bins: RelBin[], lo: number, hi: number): number | null {
  const sel = bins.filter((b) => b.lo >= lo && b.hi <= hi);
  const pred = sel.reduce((a, b) => a + b.p * b.n, 0);
  const hits = sel.reduce((a, b) => a + b.hits, 0);
  return hits ? pred / hits : null;
}
