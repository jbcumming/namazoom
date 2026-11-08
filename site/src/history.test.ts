import { describe, expect, it } from "vitest";
import { energyJ, isDestructive } from "./panel-history";

describe("energy", () => {
  it("grows about 32 times per magnitude unit", () => {
    expect(energyJ(7) / energyJ(6)).toBeCloseTo(10 ** 1.5, 6);
    expect(energyJ(0)).toBeCloseTo(10 ** 4.8, 0);
  });
});

describe("destructive quakes", () => {
  const base = { t: 0, mag: 7, depth: 10, shindo: "", cls: "1", felt: true, id: "x" };
  it("uses damage class 3+ or a damaging tsunami", () => {
    expect(isDestructive({ ...base, dmg: "3", tsu: "" })).toBe(true);
    expect(isDestructive({ ...base, dmg: "2", tsu: "" })).toBe(false); // light damage only
    expect(isDestructive({ ...base, dmg: "", tsu: "1" })).toBe(false); // gauge-only tsunami
    expect(isDestructive({ ...base, dmg: "", tsu: "T" })).toBe(true);
  });
});
