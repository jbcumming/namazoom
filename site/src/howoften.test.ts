import { describe, expect, it } from "vitest";
import { howOften } from "./how-often";

describe("howOften", () => {
  it("says a rate in words", () => {
    expect(howOften(1945, 106, "1919–2024")).toBe("about 18 a year");
    expect(howOften(100, 100, "x")).toBe("about one a year");
    expect(howOften(12, 106, "1919–2024")).toBe("about once every 9 years");
    expect(howOften(0, 50, "x")).toBe("none in 50 years");
  });
  it("gives plain counts for short periods", () => {
    expect(howOften(9, 1, "2011")).toBe("9 in 2011");
    expect(howOften(0, 2, "2010–2011")).toBe("none in 2010–2011");
  });
});
