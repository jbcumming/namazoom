import { describe, expect, it } from "vitest";
import { OUTLOOK, ROWS } from "./trench-history";

describe("trench history", () => {
  it("has events in order, within the timeline", () => {
    for (const r of ROWS) {
      const years = r.events.map((e) => e.year);
      expect(years).toEqual([...years].sort((a, b) => a - b));
      for (const e of r.events) {
        expect(e.year).toBeGreaterThanOrEqual(684);
        expect(e.to ?? e.year).toBeLessThanOrEqual(2026);
        expect(e.to ?? e.year).toBeGreaterThanOrEqual(e.year);
      }
    }
  });
  it("gives every trench on the timeline an official chance", () => {
    const zones = new Set(OUTLOOK.map((o) => o.zone));
    for (const r of ROWS) expect(zones.has(r.zone)).toBe(true);
    expect(new Set(ROWS.map((r) => r.id)).size).toBe(ROWS.length);
  });
});
