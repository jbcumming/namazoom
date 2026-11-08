// Gutenberg-Richter data and statistics. Pure functions, no DOM.
//
// estimateMc is a port of pipeline/build/completeness.py:estimate_mc and must
// stay in step with it (gr.test.ts checks parity on fixtures the Python code
// produced).

export interface GrData {
  generated: string;
  source: string;
  selection: string;
  box: { lat_min: number; lat_max: number; lon_min: number; lon_max: number };
  cellDeg: number;
  windowYears: number;
  years: [number, number];
  cells: [number, number][]; // south-west corner [lat, lon]
  counts: { year: number[]; cell: number[]; m10: number[]; n: number[] };
}

/** Magnitude (x10, integer) -> number of events. */
export type Histogram = Map<number, number>;

export interface Selection {
  from: number; // inclusive years
  to: number;
  cells: Set<number> | null; // null = all cells
}

export function histogram(data: GrData, sel: Selection): Histogram {
  const { year, cell, m10, n } = data.counts;
  const h: Histogram = new Map();
  for (let i = 0; i < year.length; i++) {
    if (year[i] < sel.from || year[i] > sel.to) continue;
    if (sel.cells && !sel.cells.has(cell[i])) continue;
    h.set(m10[i], (h.get(m10[i]) ?? 0) + n[i]);
  }
  return h;
}

/** Events per cell for a period (for shading the region map). */
export function cellTotals(data: GrData, from: number, to: number): Float64Array {
  const out = new Float64Array(data.cells.length);
  const { year, cell, n } = data.counts;
  for (let i = 0; i < year.length; i++) {
    if (year[i] >= from && year[i] <= to) out[cell[i]] += n[i];
  }
  return out;
}

export interface Point {
  mag: number;
  incremental: number; // events in this 0.1 bin
  cumulative: number; // events with magnitude >= mag
}

export function curve(h: Histogram): Point[] {
  const mags = [...h.keys()].sort((a, b) => a - b);
  let cum = 0;
  const pts: Point[] = [];
  for (let i = mags.length - 1; i >= 0; i--) {
    cum += h.get(mags[i])!;
    pts.push({ mag: mags[i] / 10, incremental: h.get(mags[i])!, cumulative: cum });
  }
  return pts.reverse();
}

// --- completeness (keep in step with completeness.py) ----------------------

export const BIN = 0.1;
export const MIN_EVENTS = 200;
export const MIN_ABOVE_MC = 50;
export const MAXC_CORRECTION = 0.2;

export interface McEstimate {
  nEvents: number;
  mc: number | null;
  b: number | null; // unrounded; round for display only
  a: number | null; // log10 N(M >= mc - bin/2) + b (mc - bin/2): cumulative G-R intercept
  nAboveMc: number | null;
  method: "gft95" | "gft90" | "maxc+0.2" | null;
  fitPct: number | null;
}

function akiB(h: Histogram, mc10: number): { b: number | null; total: number } {
  let total = 0;
  let sum = 0;
  for (const [m10, n] of h) {
    if (m10 >= mc10) {
      total += n;
      sum += m10 * n;
    }
  }
  if (total < MIN_ABOVE_MC) return { b: null, total };
  const denom = sum / total / 10 - (mc10 / 10 - BIN / 2);
  if (denom <= 0) return { b: null, total };
  return { b: Math.LOG10E / denom, total };
}

function gftResidual(h: Histogram, mc10: number): { pct: number; b: number; total: number } | null {
  const { b, total } = akiB(h, mc10);
  if (b === null) return null;
  const mc = mc10 / 10;
  const a = Math.log10(total) + b * (mc - BIN / 2);
  let resid = 0;
  for (const [m10, n] of h) {
    if (m10 >= mc10) {
      const m = m10 / 10;
      const expected = 10 ** (a - b * (m - BIN / 2)) - 10 ** (a - b * (m + BIN / 2));
      resid += Math.abs(n - expected);
    }
  }
  return { pct: 100 - (100 * resid) / total, b, total };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export function estimateMc(h: Histogram): McEstimate {
  let nEvents = 0;
  for (const n of h.values()) nEvents += n;
  const none: McEstimate = { nEvents, mc: null, b: null, a: null, nAboveMc: null, method: null, fitPct: null };
  if (nEvents < MIN_EVENTS) return none;

  const mags = [...h.keys()].sort((x, y) => x - y);
  const fits: { mc10: number; pct: number; b: number; total: number }[] = [];
  for (let mc10 = mags[0]; mc10 <= mags[mags.length - 1]; mc10++) {
    const r = gftResidual(h, mc10);
    if (r === null) break;
    fits.push({ mc10, ...r });
  }
  const intercept = (mc10: number, b: number, total: number) => Math.log10(total) + b * (mc10 / 10 - BIN / 2);
  for (const level of [95, 90] as const) {
    const f = fits.find((x) => x.pct >= level);
    if (f) {
      return {
        nEvents, mc: f.mc10 / 10, b: f.b, a: intercept(f.mc10, f.b, f.total),
        nAboveMc: f.total, method: `gft${level}`, fitPct: round(f.pct, 1),
      };
    }
  }
  // maximum curvature: most populated bin, larger magnitude wins ties
  let maxc = mags[0];
  for (const m of mags) if (h.get(m)! > h.get(maxc)! || (h.get(m) === h.get(maxc) && m > maxc)) maxc = m;
  const mc10 = maxc + Math.round(MAXC_CORRECTION * 10);
  const { b, total } = akiB(h, mc10);
  return {
    nEvents, mc: mc10 / 10, b, a: b === null ? null : intercept(mc10, b, total),
    nAboveMc: total, method: "maxc+0.2", fitPct: null,
  };
}

/** Fitted cumulative count for bin `mag`: the bin holds M in [mag - bin/2,
 * mag + bin/2), so N(>= bin) = 10^(a - b (mag - bin/2)). */
export function fitted(est: McEstimate, mag: number): number | null {
  if (est.a === null || est.b === null) return null;
  return 10 ** (est.a - est.b * (mag - BIN / 2));
}
