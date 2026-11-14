import { describe, expect, it } from "vitest";
import { FAMOUS, famous, quakePlace, regionLabel } from "./names";

const t = (iso: string) => Date.parse(iso) / 1000; // iso in UTC

describe("regionLabel", () => {
  it("expands JMA abbreviations and fixes the capitals", () => {
    expect(regionLabel("FAR E OFF MIYAGI PREF")).toBe("Far east off Miyagi Prefecture");
    expect(regionLabel("NEAR IZU-OSHIMA ISLAND")).toBe("Near Izu-Oshima Island");
    expect(regionLabel("NORTHERN IBARAKI PREF")).toBe("Northern Ibaraki Prefecture");
    expect(regionLabel("SE OFF BOSO PENINSULA")).toBe("South-east off Boso Peninsula");
    expect(regionLabel(undefined)).toBe("");
  });
});

describe("famous", () => {
  it("matches by Japan date and magnitude", () => {
    // 2011-03-11 14:46 JST = 05:46 UTC
    expect(famous(t("2011-03-11T05:46:18Z"), 9.0)?.short).toBe("Tōhoku 2011");
    // Same day, the M7.6 off Ibaraki is not the mainshock.
    expect(famous(t("2011-03-11T06:15:34Z"), 7.6)).toBeNull();
    // 1995-01-17 05:46 JST is 1995-01-16 20:46 UTC: the date must be taken in Japan time.
    expect(famous(t("1995-01-16T20:46:51Z"), 7.3)?.short).toBe("Kobe 1995");
    expect(famous(t("1995-01-16T20:46:51Z"), null)).toBeNull();
  });
  it("prefers the common name over the region", () => {
    expect(quakePlace({ t: t("2024-01-01T07:10:22Z"), mag: 7.6, region: "NOTO PENINSULA REGION" })).toBe("Noto Peninsula earthquake");
    expect(quakePlace({ t: t("2024-01-02T07:10:22Z"), mag: 5.0, region: "NOTO PENINSULA REGION" })).toBe("Noto Peninsula region");
  });
  it("has unique ids that start with their date", () => {
    expect(new Set(FAMOUS.map((f) => f.id)).size).toBe(FAMOUS.length);
    for (const f of FAMOUS) expect(f.id.slice(1, 9)).toBe(f.date.replaceAll("-", ""));
  });
});
