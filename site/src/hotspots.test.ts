import { describe, expect, it } from "vitest";
import { grid, logClass, stationRates, type StationCounts } from "./hotspots";
import type { Stations } from "./shindo";

const stations: Stations = {
  id: ["A", "B", "C", "D"],
  name: ["a", "b", "c", "d"],
  lat: [35.01, 35.05, 35.5, null],
  lon: [139.01, 139.05, 139.5, null],
  start: ["2000-01-01", "2000", null, "2000"],
  end: [null, "2001-06-30", null, null],
};

// A: shindo 1 x10 and shindo 4 x2 in 2001, felt-unknown x1; B: 2 years only; D: no position.
const counts: StationCounts = {
  st: [0, 0, 0, 1, 2, 2, 2, 3],
  y: [2001, 2001, 2001, 2001, 2001, 2002, 2003, 2001],
  k: [0, 3, -1, 0, 0, 0, 0, 0],
  n: [10, 2, 1, 5, 4, 4, 4, 9],
};

describe("station rates", () => {
  it("divides by years in operation within the period", () => {
    const r = stationRates(counts, stations, 2000, 2009, 0);
    const a = r.find((x) => x.station === 0)!;
    expect(a.years).toBe(10);
    expect(a.count).toBe(13); // 10 + 2 + 1 felt-unknown
    expect(a.rate).toBeCloseTo(1.3);
  });

  it("drops short records and stations without a position", () => {
    const ids = stationRates(counts, stations, 2000, 2009, 0).map((x) => x.station);
    expect(ids).not.toContain(1); // only 2000-2001
    expect(ids).not.toContain(3); // no position
  });

  it("counts only readings at or above the level", () => {
    const a = stationRates(counts, stations, 2000, 2009, 3).find((x) => x.station === 0)!;
    expect(a.count).toBe(2);
  });

  it("never uses fewer years than the station actually reported", () => {
    // C has no start date; within 2001-2003 it reported in 3 years
    const c = stationRates(counts, stations, 2001, 2003, 0).find((x) => x.station === 2)!;
    expect(c.years).toBe(3);
    expect(c.rate).toBeCloseTo(4);
  });
});

describe("temporary stations", () => {
  it("are left out, but a station in a temporary office is not", () => {
    const st: Stations = { id: ["T", "R"], name: ["奥尻町奥尻（臨時）", "三宅村役場臨時庁舎"], lat: [42.1, 34.1], lon: [139.5, 139.5],
      start: ["1993", "2008"], end: ["1999", null] };
    const c: StationCounts = { st: [0, 1], y: [1995, 2010], k: [0, 0], n: [500, 5] };
    const ids = stationRates(c, st, 1990, 2020, 0).map((x) => x.station);
    expect(ids).toEqual([1]);
  });
});

describe("grid", () => {
  it("averages station rates per cell", () => {
    const cells = grid([{ station: 0, rate: 1, count: 1, years: 1 }, { station: 1, rate: 3, count: 3, years: 1 },
      { station: 2, rate: 10, count: 10, years: 1 }], stations, 0.2);
    expect(cells).toHaveLength(2);
    const near = cells.find((c) => c.stations.length === 2)!;
    expect(near.rate).toBe(2);
  });

  it("assigns log-scale colour classes", () => {
    expect(logClass(0.1, 0.1, 100, 7)).toBe(0);
    expect(logClass(100, 0.1, 100, 7)).toBe(6);
    expect(logClass(5, 0.1, 100, 6)).toBe(3); // log10(5) is 0.57 of the way from 0.1 to 100
  });
});
