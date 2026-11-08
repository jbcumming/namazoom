// Aftershock statistics for a mainshock. Pure functions, no DOM.

export interface Shock {
  t: number; // UTC seconds
  lat: number;
  lon: number;
  mag: number;
  id: string;
}

export const DAY = 86400;
export const MIN_MAINSHOCK = 5.5;
export const WINDOW_DAYS = 365;
export const FORESHOCK_DAYS = 30;

/** Subsurface rupture length, Wells & Coppersmith (1994), all slip types: log10 L = -2.44 + 0.59 M. */
export const ruptureLengthKm = (m: number) => 10 ** (-2.44 + 0.59 * m);

/** Search radius around the epicentre: the rupture length, kept between 20 and 600 km. */
export const windowRadiusKm = (m: number) => Math.min(600, Math.max(20, ruptureLengthKm(m)));

export function distKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export interface Sequence {
  radiusKm: number;
  after: (Shock & { days: number })[]; // aftershocks, days after the mainshock
  before: Shock[]; // within FORESHOCK_DAYS before
}

export function sequence(main: Shock, all: Shock[], minMag = 3): Sequence {
  const radiusKm = windowRadiusKm(main.mag);
  const after: Sequence["after"] = [];
  const before: Shock[] = [];
  for (const s of all) {
    if (s.id === main.id || s.mag < minMag) continue;
    const dt = s.t - main.t;
    if (dt < -FORESHOCK_DAYS * DAY || dt > WINDOW_DAYS * DAY) continue;
    if (distKm(main, s) > radiusKm) continue;
    if (dt > 0) after.push({ ...s, days: dt / DAY });
    else if (dt < 0) before.push(s);
  }
  after.sort((a, b) => a.t - b.t);
  return { radiusKm, after, before };
}

export interface RateBin { t0: number; t1: number; tMid: number; count: number; rate: number } // rate per day

/** Counts in log-spaced time bins (days), 4 per decade from 0.01 to WINDOW_DAYS. */
export function rateBins(days: number[], perDecade = 4, from = 0.01, to = WINDOW_DAYS): RateBin[] {
  const edges: number[] = [];
  for (let e = Math.log10(from); e < Math.log10(to) - 1e-9; e += 1 / perDecade) edges.push(10 ** e);
  edges.push(to);
  const bins: RateBin[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const [t0, t1] = [edges[i], edges[i + 1]];
    const count = days.filter((d) => d >= t0 && d < t1).length;
    bins.push({ t0, t1, tMid: Math.sqrt(t0 * t1), count, rate: count / (t1 - t0) });
  }
  return bins;
}

/**
 * Decay exponent p of Omori's law, rate ~ t^-p, from a least-squares line
 * through log rate vs log time. Only bins from `fromDay` on (the first hours
 * after a large quake are incomplete: small aftershocks are lost in the
 * mainshock's coda) and with at least `minCount` events are used.
 */
export function fitOmoriP(bins: RateBin[], fromDay = 0.1, minCount = 3): { p: number; logK: number; n: number } | null {
  const pts = bins.filter((b) => b.tMid >= fromDay && b.count >= minCount).map((b) => [Math.log10(b.tMid), Math.log10(b.rate)]);
  if (pts.length < 3) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let sxy = 0, sxx = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  const slope = sxy / sxx;
  return { p: -slope, logK: my - slope * mx, n: pts.length };
}
