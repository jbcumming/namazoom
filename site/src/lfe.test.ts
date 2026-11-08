import { describe, expect, it } from "vitest";
import { along, axisLabel, principalAxis, weekly, type LfeColumns } from "./lfe";

describe("principal axis", () => {
  it("finds the direction of a belt and orders points along it", () => {
    // Points along a WSW-ENE line (like the Nankai tremor belt), with a little scatter.
    const lats: number[] = [], lons: number[] = [];
    for (let i = 0; i <= 20; i++) {
      lons.push(132 + i * 0.25);
      lats.push(33 + i * 0.1 + (i % 2 ? 0.02 : -0.02));
    }
    const a = principalAxis(lats, lons)!;
    expect(axisLabel(a)).toEqual(["WSW", "ENE"]);
    const d = lats.map((la, i) => along(a, la, lons[i]));
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThan(d[i - 1]);
    // ~5° of longitude at 33-35N plus 2° of latitude: ~490 km end to end
    expect(d[20] - d[0]).toBeGreaterThan(450);
    expect(d[20] - d[0]).toBeLessThan(530);
  });

  it("needs at least two points", () => {
    expect(principalAxis([33], [132])).toBeNull();
  });
});

describe("weekly counts", () => {
  it("bins by week and detection method", () => {
    const c: LfeColumns = { t: [0, 86400, 8 * 86400, 30 * 86400], lat: [0, 0, 0, 0], lon: [0, 0, 0, 0],
      depth: [30, 30, 30, 30], mag: [0, 0, 0, 0], mf: [false, true, false, false] };
    const w = weekly(c, [0, 1, 2, 3], 0, 14 * 86400);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ standard: 1, matched: 1 });
    expect(w[1]).toMatchObject({ standard: 1, matched: 0 }); // day 30 is outside
  });
});
