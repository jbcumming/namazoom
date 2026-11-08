import { describe, expect, it } from "vitest";
import { crossings, frame, inSection, sectionLengthKm, swath, type Section } from "./section";

// East-west line along 38°N, 2° of longitude.
const ew: Section = { a: [140, 38], b: [142, 38], halfWidthKm: 50 };

describe("section geometry", () => {
  it("measures length like a great circle over short distances", () => {
    // 2° of longitude at 38°N ~ 175.3 km (haversine)
    expect(sectionLengthKm(ew)).toBeCloseTo(175.3, 0);
  });

  it("projects points along and across the line", () => {
    const f = frame(ew);
    const mid = f.project([141, 38]);
    expect(mid.along).toBeCloseTo(sectionLengthKm(ew) / 2, 1);
    expect(mid.across).toBeCloseTo(0, 6);
    const north = f.project([141, 38.3]); // ~33 km north = left of an eastward line
    expect(north.across).toBeCloseTo(33.4, 0);
  });

  it("unprojects back to the same place", () => {
    const f = frame(ew);
    const p = f.unproject(80, -20);
    const back = f.project(p);
    expect(back.along).toBeCloseTo(80, 6);
    expect(back.across).toBeCloseTo(-20, 6);
  });

  it("keeps only points inside the band", () => {
    const pts: [number, number][] = [[141, 38], [141, 38.3], [141, 38.6], [139.9, 38], [142.1, 38]];
    const kept = inSection(ew, pts, (p) => p).map((r) => r.item);
    expect(kept).toEqual([[141, 38], [141, 38.3]]);
  });

  it("finds where a polyline crosses the line", () => {
    // a north-south contour at 141°E crosses once, near the middle
    const c = crossings(ew, [[141, 37], [141, 39]]);
    expect(c).toHaveLength(1);
    expect(c[0]).toBeCloseTo(sectionLengthKm(ew) / 2, 1);
    // a contour that stays north never crosses
    expect(crossings(ew, [[140.5, 38.5], [141.5, 38.6]])).toEqual([]);
  });

  it("builds a closed swath polygon", () => {
    const s = swath(ew);
    expect(s).toHaveLength(5);
    expect(s[0]).toEqual(s[4]);
  });
});
