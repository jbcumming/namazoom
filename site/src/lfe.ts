// Low-frequency earthquakes: helpers for the slow-slip tab. Pure functions, no DOM.
// Data: pipeline/build/site_data.py build_lfe.

export interface LfeColumns {
  t: number[]; // UTC seconds
  lat: number[];
  lon: number[];
  depth: (number | null)[];
  mag: (number | null)[];
  mf: boolean[]; // matched-filter detection
}

const KM_PER_DEG = 111.195;

export interface Axis {
  lat0: number;
  lon0: number;
  ux: number; // unit vector, east component (km frame)
  uy: number; // north component
  kx: number; // km per degree of longitude at lat0
}

/**
 * Direction along which the points are most spread out (first principal
 * component), so the space-time plot follows the belt whatever area is in view.
 * Oriented to run roughly west/south-west to east/north-east.
 */
export function principalAxis(lats: number[], lons: number[]): Axis | null {
  const n = lats.length;
  if (n < 2) return null;
  const lat0 = lats.reduce((a, b) => a + b, 0) / n;
  const lon0 = lons.reduce((a, b) => a + b, 0) / n;
  const kx = KM_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = (lons[i] - lon0) * kx, y = (lats[i] - lat0) * KM_PER_DEG;
    sxx += x * x; syy += y * y; sxy += x * y;
  }
  // Eigenvector of [[sxx, sxy], [sxy, syy]] for the larger eigenvalue.
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ux = Math.cos(angle), uy = Math.sin(angle);
  if (ux < 0 || (Math.abs(ux) < 1e-9 && uy < 0)) { ux = -ux; uy = -uy; }
  return { lat0, lon0, ux, uy, kx };
}

/** Signed distance (km) along the axis from the centre. */
export const along = (a: Axis, lat: number, lon: number) =>
  (lon - a.lon0) * a.kx * a.ux + (lat - a.lat0) * KM_PER_DEG * a.uy;

/** Compass name of the axis direction, e.g. "WSW → ENE". */
export function axisLabel(a: Axis): [string, string] {
  const deg = (Math.atan2(a.ux, a.uy) * 180) / Math.PI; // bearing of the positive end
  const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const name = (b: number) => names[Math.round((((b % 360) + 360) % 360) / 22.5) % 16];
  return [name(deg + 180), name(deg)];
}

export interface WeekBin { t0: number; standard: number; matched: number }

const WEEK = 7 * 86400;

/** Weekly counts split by detection method, from `from` to `to` (UTC seconds). */
export function weekly(c: LfeColumns, idx: number[], from: number, to: number): WeekBin[] {
  const n = Math.max(1, Math.ceil((to - from) / WEEK));
  const bins: WeekBin[] = Array.from({ length: n }, (_, i) => ({ t0: from + i * WEEK, standard: 0, matched: 0 }));
  for (const i of idx) {
    const k = Math.floor((c.t[i] - from) / WEEK);
    if (k < 0 || k >= n) continue;
    if (c.mf[i]) bins[k].matched++; else bins[k].standard++;
  }
  return bins;
}
