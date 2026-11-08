// Selected quake tab: details of the quake clicked on the map.
import type { QuakeProps } from "./quakes";
import { el } from "./ui";

const SHINDO: Record<string, string> = {
  "1": "1", "2": "2", "3": "3", "4": "4", "5": "5 (old scale)", "6": "6 (old scale)", "7": "7",
  A: "5 lower", B: "5 upper", C: "6 lower", D: "6 upper",
  R: "felt over 300 km away", M: "felt 200–300 km away", S: "felt 100–200 km away", L: "felt within 100 km",
  F: "felt", X: "felt by some people",
};
const CLASS: Record<string, string> = {
  "1": "natural earthquake", "2": "natural (few JMA stations)", "4": "volcanic or other", "5": "low-frequency event",
};

function when(t: number, offsetH: number, label: string) {
  const d = new Date((t + offsetH * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${label}`;
}

export function renderQuake(host: HTMLElement, q: QuakeProps | null, coords?: [number, number]) {
  if (!q || !coords) {
    host.replaceChildren(
      el("h2", "", "Selected quake"),
      el("p", "sub", "Click a quake on the map to see its details here."),
    );
    return;
  }
  const dl = el("dl", "facts");
  const row = (k: string, v: string) => dl.append(el("dt", "", k), el("dd", "", v));
  row("Time (Japan)", when(q.t, 9, "JST"));
  row("Time (UTC)", when(q.t, 0, "UTC"));
  row("Magnitude", q.mag === null ? "not determined" : `M${q.mag.toFixed(1)} (JMA)`);
  row("Depth", q.depth === null ? "unknown" : `${q.depth.toFixed(q.depth < 10 ? 1 : 0)} km`);
  row("Epicentre", `${coords[1].toFixed(3)}°N, ${coords[0].toFixed(3)}°E`);
  row("Max shindo", q.shindo ? SHINDO[q.shindo] ?? q.shindo : q.felt ? "felt" : "not felt / not reported");
  row("Type", CLASS[q.cls] ?? "located by another agency");
  row("Catalogue ID", q.id);
  host.replaceChildren(
    el("h2", "", q.mag === null ? "Felt earthquake" : `M${q.mag.toFixed(1)} earthquake`),
    dl,
    el("p", "sub", q.felt
      ? "Station-by-station shaking (the shindo footprint) will appear here in the next step."
      : "No intensity readings: this quake was not reported as felt."),
  );
}
