// Quake tab: "Could it have been a foreshock?" Base rates from earlier quakes only.
import * as d3 from "d3";
import { GAP_BANDS, baseRates, findRow, gapBand, type FsData } from "./foreshock";
import { el, fmt } from "./ui";

export type ForeshockState = { status: "loading" | "missing" } | { status: "ok"; data: FsData };

const pct = (k: number, n: number) => (n ? `${d3.format(".1~f")((100 * k) / n)}%` : "–");
const hours = (h: number) => (h < 48 ? `${d3.format("~g")(h)} hours` : `${d3.format(".1~f")(h / 24)} days`);

export function renderForeshock(st: ForeshockState, t: number, mag: number | null): HTMLElement | null {
  if (mag === null || mag < 5.5) return null;
  const box = el("div", "foreshock");
  box.append(el("h2", "", "Could it have been a foreshock?"));
  if (st.status !== "ok") {
    box.append(el("p", "sub", st.status === "loading" ? "Loading…" : "No foreshock statistics in this build."));
    return box;
  }
  const d = st.data;
  const row = findRow(d, t, mag);
  if (!row) {
    box.append(el("p", "sub",
      `Not in this comparison, which covers natural quakes of M${d.minMag}+ no deeper than ${d.maxDepth} km in JMA's classification.`));
    return box;
  }
  if (row.after) {
    box.append(el("p", "sub",
      `This quake came ${hours(row.after.h)} after an M${row.after.m.toFixed(1)} close by (within that quake's rupture ` +
      "length), so it counts as part of that sequence rather than as a possible foreshock."));
    return box;
  }
  const r = baseRates(d, row);
  const R = d.radiusKm;
  box.append(el("p", "lead",
    `Before this quake, ${fmt(r.sameSize.k)} of ${fmt(r.sameSize.n)} quakes of M${r.sameSize.lo.toFixed(1)}–${r.sameSize.hi.toFixed(1)} ` +
    `since ${r.firstYear} (${pct(r.sameSize.k, r.sameSize.n)}) were followed within ${d.days} days by a larger one within ${R} km.`));

  const bigFirstDay = row.big && row.big.h <= 24;
  const dayDone = row.t + 86400 <= d.dataEnd;
  const band = gapBand(row.gap24);
  if (bigFirstDay) {
    box.append(el("p", "sub", "A larger quake came within its first 24 hours, so the 24-hour comparison below doesn't apply."));
  } else if (!dayDone) {
    box.append(el("p", "sub", "Its first 24 hours aren't over in the data yet, so the comparison below may still change."));
  }
  if (!bigFirstDay) {
    box.append(el("p", "sub", row.gap24 === null || row.gap24 === undefined
      ? `In its first 24 hours no M${d.followerMag}+ quake followed within ${R} km.`
      : `In its first 24 hours the largest quake within ${R} km was M${(row.m - row.gap24).toFixed(1)}, ` +
        `${row.gap24.toFixed(1)} below it (Båth's law: typically about 1.2 for a mainshock's largest aftershock).`));
  }

  const tb = document.createElement("table");
  tb.className = "mini fs";
  const hr = tb.createTHead().insertRow();
  for (const h of ["Largest quake in the first 24 h", "Quakes", `Larger one in the next ${d.days - 1} days`]) hr.append(el("th", "", h));
  const bd = tb.createTBody();
  for (const b of GAP_BANDS) {
    const c = r.byGap[b.key];
    const tr = bd.insertRow();
    if (!bigFirstDay && b.key === band) tr.className = "this";
    tr.append(el("td", "", b.label + (!bigFirstDay && b.key === band ? " ← this quake" : "")), el("td", "", fmt(c.n)),
      el("td", "", `${pct(c.k, c.n)} (${fmt(c.k)})`));
  }
  box.append(el("div", "chart-title",
    `All M${d.minMag}+ quakes since ${r.firstYear} with no larger one in their first day, by how close the largest follower came`), tb);

  const outcome = row.big
    ? `What happened: a larger quake did follow, M${row.big.m.toFixed(1)} ${hours(row.big.h)} later, ${row.big.km} km away.`
    : row.complete ? `What happened: no larger quake followed within ${R} km in ${d.days} days.`
      : `The ${d.days} days aren't over in the data yet.`;
  box.append(el("p", "lead", outcome));

  const det = document.createElement("details");
  det.className = "notes";
  det.append(el("summary", "", "About these numbers"));
  for (const text of [
    "Context, not a prediction: most quakes are not followed by a larger one, and a small gap only raises the chance " +
      "from a few percent to around one in ten. Official advisories come from JMA (the Nankai Trough and the " +
      "Japan/Kuril Trench advisories), using worldwide statistics for much larger follow-on quakes.",
    `Counted: natural quakes of M${d.minMag}+ no deeper than ${d.maxDepth} km in JMA's catalogue since ${d.from} ` +
      `(and the preliminary data), that weren't within ${d.days} days of an equal or larger quake nearby. "Larger" means ` +
      `a strictly higher JMA magnitude within ${R} km (the radius JMA used for its Nankai advisory statistics). Only quakes ` +
      `whose ${d.days} days were over before this one count, so these numbers could have been worked out at the time.`,
    "Older years list fewer small quakes, so a few early quakes look as if nothing followed in their first day.",
  ]) det.append(el("p", "", text));
  box.append(det);
  return box;
}
