import { describe, expect, it } from "vitest";
import { DAY, fitOmoriP, rateBins, ruptureLengthKm, sequence, windowRadiusKm, type Shock } from "./aftershocks";

describe("aftershock window", () => {
  it("scales with magnitude (Wells & Coppersmith 1994)", () => {
    expect(ruptureLengthKm(7)).toBeCloseTo(49, 0);
    expect(windowRadiusKm(5.5)).toBe(20); // floor
    expect(windowRadiusKm(9.5)).toBe(600); // cap
  });

  it("separates aftershocks, foreshocks and unrelated quakes", () => {
    const main: Shock = { t: 1000 * DAY, lat: 38, lon: 142, mag: 7, id: "main" };
    const all: Shock[] = [
      main,
      { t: main.t + 2 * DAY, lat: 38.1, lon: 142.1, mag: 4, id: "a1" }, // after, near
      { t: main.t + 2 * DAY, lat: 40, lon: 142, mag: 4, id: "far" }, // too far (~222 km)
      { t: main.t + 400 * DAY, lat: 38, lon: 142, mag: 4, id: "late" }, // after the window
      { t: main.t - 5 * DAY, lat: 38, lon: 142, mag: 3.5, id: "f1" }, // foreshock
      { t: main.t + 1 * DAY, lat: 38, lon: 142, mag: 2.5, id: "small" }, // below minMag
    ];
    const s = sequence(main, all);
    expect(s.after.map((a) => a.id)).toEqual(["a1"]);
    expect(s.after[0].days).toBeCloseTo(2);
    expect(s.before.map((b) => b.id)).toEqual(["f1"]);
  });
});

describe("Omori decay", () => {
  it("recovers p from synthetic 1/t^p aftershock times", () => {
    // Inverse-transform sample of rate ~ t^-1.1 between 0.01 and 365 days.
    const p = 1.1, a = 0.01, b = 365, n = 20000;
    const days: number[] = [];
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const q = 1 - p;
      days.push((a ** q + u * (b ** q - a ** q)) ** (1 / q));
    }
    const fit = fitOmoriP(rateBins(days))!;
    expect(fit.p).toBeCloseTo(1.1, 1);
  });

  it("needs enough populated bins", () => {
    expect(fitOmoriP(rateBins([0.5, 0.6]))).toBeNull();
  });
});
