import { describe, expect, it } from "vitest";
import { QuakeStore, fmtDate, type QuakeColumns } from "./quakes";

describe("dates in Japan time", () => {
  it("formats the JST date of a UTC timestamp", () => {
    // 2026-11-07 20:00 UTC is already 8 November in Japan.
    expect(fmtDate(Date.UTC(2026, 10, 7, 20) / 1000)).toBe("8 Nov 2026");
    expect(fmtDate(Date.UTC(2026, 10, 7, 10) / 1000)).toBe("7 Nov 2026");
  });
});

describe("preliminary flag", () => {
  const cols = (t: number[]): QuakeColumns => ({
    t, lat: t.map(() => 35), lon: t.map(() => 140), depth: t.map(() => 10), mag: t.map(() => 5.5),
    shindo: t.map(() => ""), cls: t.map(() => ""), felt: t.map(() => false), dmg: t.map(() => ""),
    tsu: t.map(() => ""), id: t.map((x) => `q${x}`),
  });
  const store = (prelimFrom: number | null) => {
    const s = new QuakeStore();
    s.index = { generated: "", years: [2024, 2025], prelimFrom, dataEnd: 300, m5: 2, m3: {} };
    (s as unknown as { m5: QuakeColumns }).m5 = cols([100, 200]);
    return s;
  };

  it("marks quakes from prelimFrom on", () => {
    const f = store(150).features(0, 1000, 5).features.map((x) => x.properties.prelim);
    expect(f).toEqual([false, true]);
  });

  it("marks nothing without preliminary data", () => {
    expect(store(null).features(0, 1000, 5).features.some((x) => x.properties.prelim)).toBe(false);
  });
});
