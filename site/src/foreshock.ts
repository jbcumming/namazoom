// "Could this have been a foreshock?" (pipeline/build/foreshock.py): types and pure helpers.

export interface FsRow {
  t: number; lat: number; lon: number; m: number;
  gap24?: number | null;                       // magnitude minus the largest quake in the next 24 h (null: none M4+)
  big?: { m: number; h: number; km: number };  // first larger quake within the radius and 7 days
  after?: { m: number; h: number };            // part of an earlier, equal or larger quake's sequence
  complete?: boolean;                          // its 7 days are over
}
export interface FsData {
  radiusKm: number; days: number; minMag: number; followerMag: number; maxDepth: number;
  from: number; dataEnd: number; quakes: FsRow[];
}

/** Bands of the 24-hour gap. */
export const GAP_BANDS = [
  { key: "none", label: "No M4+ quake in the first 24 h" },
  { key: "lt05", label: "Within 0.5 of it" },
  { key: "mid", label: "0.5 to 1.5 below" },
  { key: "ge15", label: "1.5 or more below" },
] as const;
export type GapBand = (typeof GAP_BANDS)[number]["key"];

export function gapBand(g: number | null | undefined): GapBand {
  if (g === null || g === undefined) return "none";
  return g < 0.5 ? "lt05" : g < 1.5 ? "mid" : "ge15";
}

export interface Count { n: number; k: number }
export interface BaseRates {
  row: FsRow;
  sameSize: Count & { lo: number; hi: number };      // larger quake within 7 days
  byGap: Record<GapBand, Count>;                      // given none in the first 24 h: larger in the next 6 days
  firstYear: number;
}

/** The selected quake's row: same time (to 2 s) and magnitude. */
export function findRow(d: FsData, t: number, m: number): FsRow | undefined {
  return d.quakes.find((r) => Math.abs(r.t - t) <= 2 && Math.abs(r.m - m) < 0.05);
}

/** Base rates from quakes whose 7 days were over before this one happened (as could have been known then). */
export function baseRates(d: FsData, row: FsRow): BaseRates {
  const prior = d.quakes.filter((r) => !r.after && r.complete && r.t + d.days * 86400 <= row.t);
  const lo = Math.round((row.m - 0.5) * 10) / 10, hi = Math.round((row.m + 0.5) * 10) / 10;
  const same = prior.filter((r) => r.m >= lo - 1e-9 && r.m <= hi + 1e-9);
  const byGap = Object.fromEntries(GAP_BANDS.map((b) => [b.key, { n: 0, k: 0 }])) as Record<GapBand, Count>;
  for (const r of prior) {
    if (r.big && r.big.h <= 24) continue; // a larger one came within the first day: no 24-hour gap to compare
    const c = byGap[gapBand(r.gap24)];
    c.n++;
    if (r.big) c.k++;
  }
  return {
    row, byGap,
    sameSize: { lo, hi, n: same.length, k: same.filter((r) => r.big).length },
    firstYear: prior.length ? new Date(prior[0].t * 1000).getUTCFullYear() : d.from,
  };
}
