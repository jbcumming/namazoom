// Destructive quakes: a folded list on the Quake tab (while nothing is open), ringed on the map
// while the list is open.
import { type QuakeProps } from "./quakes";
import { el, fmt, rowAction } from "./ui";
import { quakePlace } from "./names";

type QF = GeoJSON.Feature<GeoJSON.Point, QuakeProps>;

export const DAMAGE: Record<string, string> = {
  "3": "2–19 deaths or 2–999 houses destroyed",
  "4": "20–199 deaths or 1,000–9,999 houses destroyed",
  "5": "200–1,999 deaths or 10,000–99,999 houses destroyed",
  "6": "2,000–19,999 deaths or 100,000–999,999 houses destroyed",
  "7": "20,000+ deaths or 1,000,000+ houses destroyed",
};
export const TSUNAMI: Record<string, string> = {
  "2": "~1 m tsunami", "3": "~2 m tsunami", "4": "4–6 m tsunami", "5": "10–20 m tsunami", "6": "30 m+ tsunami",
  T: "tsunami (size not graded)",
};
/** Damage class 3+ (Utsu's catalogue as recorded by JMA) or a damaging tsunami. */
export const isDestructive = (p: QuakeProps) => (p.dmg ?? "") in DAMAGE || (p.tsu ?? "") in TSUNAMI;

const dateOf = (t: number) => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10);

export interface DestructiveInputs {
  quakes: QF[]; // M5+ in the area and period
  period: string;
  areaLabel: string;
  open: boolean;
  onToggle(open: boolean): void;
  onSelect(f: QF): void;
}

export function destructiveList(inp: DestructiveInputs): HTMLElement {
  const bad = inp.quakes.filter((f) => f.properties.mag !== null && isDestructive(f.properties))
    .sort((a, b) => b.properties.t - a.properties.t);
  const d = el("details", "notes fold dmg") as HTMLDetailsElement;
  d.open = inp.open;
  d.addEventListener("toggle", () => inp.onToggle(d.open));
  d.append(el("summary", "", `Destructive quakes (${fmt(bad.length)})`));
  if (!bad.length) {
    d.append(el("p", "sub", `None recorded in ${inp.areaLabel}, ${inp.period}.`));
    return d;
  }
  d.append(el("p", "sub", `Quakes that killed people, destroyed houses or caused a damaging tsunami, ${inp.period}, ` +
    `${inp.areaLabel}. Ringed on the map; click one to open it.`));
  const table = document.createElement("table");
  table.className = "mini";
  const head = table.createTHead().insertRow();
  for (const h of ["Date", "M", "Where", "Damage / tsunami"]) head.append(el("th", "", h));
  const body = table.createTBody();
  for (const f of bad) {
    const p = f.properties;
    const tr = body.insertRow();
    const what = [DAMAGE[p.dmg ?? ""], TSUNAMI[p.tsu ?? ""]].filter(Boolean).join("; ");
    tr.append(el("td", "", dateOf(p.t)), el("td", "", p.mag!.toFixed(1)), el("td", "", quakePlace(p)), el("td", "", what));
    rowAction(tr, "Show this quake", () => inp.onSelect(f));
  }
  const wrap = el("div", "table-scroll");
  wrap.append(table);
  d.append(wrap);
  return d;
}
