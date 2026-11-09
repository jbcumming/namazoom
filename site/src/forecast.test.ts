import { describe, expect, it } from "vitest";
import { atMag, chance, fmtPct, fmtWindow, overForecast, pClass, sumCells, type Forecast } from "./forecast";

const f = {
  grid: { lat0: 24, lon0: 122, step: 0.5 },
  live: { cells: [[0, 0, 0.1, 0.05], [20, 30, 0.2, 0.1]] },
} as unknown as Forecast;

describe("forecast helpers", () => {
  it("turns expected counts into chances", () => {
    expect(chance(0)).toBe(0);
    expect(chance(1)).toBeCloseTo(0.632, 3);
  });
  it("scales by Gutenberg-Richter", () => {
    expect(atMag(1, 1, 6)).toBeCloseTo(0.1);
    expect(atMag(1, 1, 5)).toBe(1);
  });
  it("sums cells by centre", () => {
    expect(sumCells(f, null)).toEqual({ lam5: expect.closeTo(0.3), base5: expect.closeTo(0.15), cells: 2 });
    // cell (20, 30) is centred at 34.25N 137.25E
    expect(sumCells(f, { w: 137, s: 34, e: 138, n: 35 }).cells).toBe(1);
    expect(sumCells(f, { w: 137.3, s: 34, e: 138, n: 35 }).cells).toBe(0);
  });
  it("classes and formats", () => {
    expect(pClass(0.0001)).toBe(0);
    expect(pClass(0.02)).toBe(4);
    expect(pClass(0.5)).toBe(6);
    expect(fmtPct(0.4)).toBe("40%");
    expect(fmtPct(0.025)).toBe("2.5%");
    expect(fmtPct(0.0015)).toBe("0.15%");
    expect(fmtPct(0.0003)).toBe("0.03%");
    expect(fmtPct(0.00004)).toBe("<0.01%");
  });
  it("formats the window in JST", () => {
    // 2026-11-07T15:00Z = 8 Nov 00:00 JST
    expect(fmtWindow(Date.UTC(2026, 10, 7, 15) / 1000, 7)).toBe("8–14 Nov 2026");
    expect(fmtWindow(Date.UTC(2026, 10, 27, 15) / 1000, 7)).toBe("28 Nov – 4 Dec 2026");
  });
});

describe("calibration", () => {
  it("weights bins by count", () => {
    const bins = [{ lo: 0.001, hi: 0.003, n: 1000, p: 0.002, hits: 1 }, { lo: 0.003, hi: 0.01, n: 100, p: 0.005, hits: 1 }, { lo: 0.1, hi: 0.3, n: 10, p: 0.2, hits: 2 }];
    expect(overForecast(bins, 0.001, 0.01)).toBeCloseTo(1.25);
    expect(overForecast(bins, 0.5, 1)).toBeNull();
  });
});
