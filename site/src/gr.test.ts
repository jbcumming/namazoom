import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { curve, estimateMc, fitted, histogram, type GrData, type Histogram } from "./gr";
import parity from "./mc_parity.fixture.json";

const data: GrData = JSON.parse(readFileSync(new URL("../public/data/gr.json", import.meta.url), "utf8"));

describe("estimateMc matches the Python pipeline", () => {
  // Fixture produced by pipeline.build.completeness.estimate_mc on the same gr.json.
  for (const c of parity) {
    it(c.name, () => {
      const h = histogram(data, { from: c.from, to: c.to, cells: c.cells ? new Set(c.cells) : null });
      const est = estimateMc(h);
      const e = c.expected;
      expect(est.nEvents).toBe(e.n_events);
      expect(est.mc).toBe(e.mc);
      expect(est.method).toBe(e.method);
      expect(est.nAboveMc).toBe(e.n_above_mc);
      if (e.b_value === null) expect(est.b).toBeNull();
      else expect(est.b).toBeCloseTo(e.b_value, 2);
    });
  }
});

describe("curve", () => {
  it("accumulates from the largest magnitude down", () => {
    const h: Histogram = new Map([[10, 100], [11, 50], [20, 1]]);
    expect(curve(h)).toEqual([
      { mag: 1.0, incremental: 100, cumulative: 151 },
      { mag: 1.1, incremental: 50, cumulative: 51 },
      { mag: 2.0, incremental: 1, cumulative: 1 },
    ]);
  });
});

describe("fitted", () => {
  it("passes through the observed cumulative count at Mc", () => {
    // Exact G-R counts with b = 1 above M1.0, none below.
    const h: Histogram = new Map();
    for (let m10 = 10; m10 <= 60; m10++) {
      const m = m10 / 10;
      h.set(m10, Math.round(1e6 * (10 ** -(m - 0.05) - 10 ** -(m + 0.05))));
    }
    const est = estimateMc(h);
    expect(est.mc).toBe(1.0);
    expect(est.b).toBeCloseTo(1.0, 1);
    const atMc = curve(h).find((p) => p.mag === 1.0)!.cumulative;
    expect(fitted(est, 1.0)! / atMc).toBeCloseTo(1, 2);
  });
});
