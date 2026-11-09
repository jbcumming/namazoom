import { describe, expect, it } from "vitest";
import { baseRates, findRow, gapBand, type FsData, type FsRow } from "./foreshock";

const DAY = 86400;
const row = (t: number, m: number, extra: Partial<FsRow> = {}): FsRow => ({ t, lat: 35, lon: 140, m, complete: true, ...extra });

const data: FsData = {
  radiusKm: 50, days: 7, minMag: 5.5, followerMag: 4, maxDepth: 100, from: 1923, dataEnd: 100 * DAY,
  quakes: [
    row(0, 6.0, { gap24: 0.2, big: { m: 6.5, h: 30, km: 5 } }),
    row(10 * DAY, 6.4, { gap24: 1.0 }),
    row(20 * DAY, 5.5, { gap24: null }),
    row(25 * DAY, 6.1, { gap24: 0.1, big: { m: 6.3, h: 2, km: 9 } }), // larger within 24 h: no gap band
    row(26 * DAY, 5.8, { after: { m: 6.3, h: 20 } }),                // aftershock: not counted
    row(40 * DAY, 6.2, { gap24: 0.3 }),                                // 7 days not over before the quake below
    row(45 * DAY, 6.0, { gap24: 0.4 }),
  ],
};

describe("foreshock base rates", () => {
  it("bands the 24-hour gap", () => {
    expect([gapBand(null), gapBand(0.4), gapBand(0.5), gapBand(1.49), gapBand(1.5)]).toEqual(["none", "lt05", "mid", "mid", "ge15"]);
  });
  it("uses only quakes whose 7 days were over before", () => {
    const sel = findRow(data, 45 * DAY + 1, 6.0)!;
    expect(sel).toBeDefined();
    const r = baseRates(data, sel);
    expect(r.sameSize).toEqual({ lo: 5.5, hi: 6.5, n: 4, k: 2 });
    expect(r.byGap.lt05).toEqual({ n: 1, k: 1 });
    expect(r.byGap.mid).toEqual({ n: 1, k: 0 });
    expect(r.byGap.none).toEqual({ n: 1, k: 0 });
  });
});
