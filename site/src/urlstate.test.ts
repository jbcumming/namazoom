import { describe, expect, it } from "vitest";
import { formatHash, parseHash, yearFromId } from "./urlstate";

const TABS = ["magnitudes", "depth", "quake", "location", "history"];
const YEARS: [number, number] = [1919, 2024];

describe("url state", () => {
  it("round-trips a full state", () => {
    const s = { from: 2010, to: 2012, minMag: 3, tab: "quake", quake: "J2011031114461812_3810_14286",
      view: { lat: 38.1, lon: 142.86, zoom: 6.5 } };
    expect(parseHash(formatHash(s), TABS, YEARS)).toEqual(s);
  });

  it("formats a single year compactly", () => {
    expect(formatHash({ from: 1995, to: 1995 })).toBe("#y=1995");
    expect(parseHash("#y=1995", TABS, YEARS)).toEqual({ from: 1995, to: 1995 });
  });

  it("ignores malformed or out-of-range parts", () => {
    expect(parseHash("#y=1900-2050&m=2&tab=nope&q=DROP%20TABLE&v=999,1,2", TABS, YEARS)).toEqual({});
    expect(parseHash("#m=10", TABS, YEARS)).toEqual({});
    expect(parseHash("#m=6.5", TABS, YEARS)).toEqual({});
    expect(parseHash("", TABS, YEARS)).toEqual({});
  });

  it("accepts every magnitude in the Show menu", () => {
    for (const m of [3, 4, 5, 6, 7, 8, 9]) expect(parseHash(`#m=${m}`, TABS, YEARS)).toEqual({ minMag: m });
  });

  it("reads the year from an event ID", () => {
    expect(yearFromId("J2011031114461812_3810_14286")).toBe(2011);
    expect(yearFromId("U1987030618395420_-2420_-7007")).toBe(1987);
  });
});
