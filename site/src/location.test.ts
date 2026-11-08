import { describe, expect, it } from "vitest";
import { cellsForCircle, haversineKm, stationsByYear } from "./location";

describe("location helpers", () => {
  it("measures distances", () => {
    // Tokyo station to Shinjuku, ~6.2 km
    expect(haversineKm(35.6812, 139.7671, 35.6896, 139.7006)).toBeCloseTo(6.1, 0);
  });

  it("lists the 1° cells a circle touches", () => {
    expect(cellsForCircle(139.5, 35.5, 10)).toEqual(["35_139"]);
    // near a corner, a 25 km circle reaches four cells
    expect(cellsForCircle(140.01, 36.01, 25).sort()).toEqual(["35_139", "35_140", "36_139", "36_140"]);
  });

  it("counts stations operating each year", () => {
    const s = [
      { index: 0, distKm: 1, start: "1925-01-01", end: "2001-08-30T12:00" },
      { index: 1, distKm: 2, start: "1996", end: null },
    ];
    const by = stationsByYear(s, 1920, 2024);
    expect(by.find((d) => d.year === 1920)!.n).toBe(0);
    expect(by.find((d) => d.year === 1997)!.n).toBe(2);
    expect(by.find((d) => d.year === 2010)!.n).toBe(1);
  });
});
