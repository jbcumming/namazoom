// Quakes tab: details of the quake clicked on the map, its shindo footprint
// (station readings) and, when available, its aftershock sequence.
import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import type { QuakeProps } from "./quakes";
import { CLASSES, classOf, shindoColors, type Reading, type Stations } from "./shindo";
import { el, fmt, hideTooltip, showTooltip, shindoScale, theme } from "./ui";
import { famous, regionLabel } from "./names";

const SHINDO: Record<string, string> = {
  "1": "1", "2": "2", "3": "3", "4": "4", "5": "5 (old scale)", "6": "6 (old scale)", "7": "7",
  A: "5 lower", B: "5 upper", C: "6 lower", D: "6 upper",
  R: "felt over 300 km away", M: "felt 200–300 km away", S: "felt 100–200 km away", L: "felt within 100 km",
  F: "felt", X: "felt by some people", "9": "felt (intensity unknown)",
};
const CLASS: Record<string, string> = {
  "1": "natural earthquake", "2": "natural (few JMA stations)", "4": "volcanic or other", "5": "low-frequency event",
};

export interface Footprint {
  status: "loading" | "none" | "ok";
  readings?: Reading[];
  stations?: Stations;
}

function when(t: number, offsetH: number, label: string) {
  const d = new Date((t + offsetH * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${label}`;
}

export function renderQuake(host: HTMLElement, q: QuakeProps | null, coords: [number, number] | undefined,
                            fp: Footprint, extra?: HTMLElement) {
  if (!q || !coords) {
    host.replaceChildren(
      el("h2", "", "Selected quake"),
      el("p", "sub", "Click a quake to see its details, where it was felt, and its aftershocks. Or start with one of these:"),
      ...(extra ? [extra] : []),
    );
    return;
  }
  const name = famous(q.t, q.mag);
  const dl = el("dl", "facts");
  const row = (k: string, v: string) => dl.append(el("dt", "", k), el("dd", "", v));
  row("Time (Japan)", when(q.t, 9, "JST"));
  row("Time (UTC)", when(q.t, 0, "UTC"));
  row("Magnitude", q.mag === null ? "not determined" : `M${q.mag.toFixed(1)} (JMA)`);
  row("Depth", q.depth === null ? "unknown" : `${q.depth.toFixed(q.depth < 10 ? 1 : 0)} km`);
  if (q.region) row("Region", regionLabel(q.region));
  row("Epicentre", `${coords[1].toFixed(3)}°N, ${coords[0].toFixed(3)}°E`);
  // Without a catalogue value, the strongest station reading stands in.
  const top = fp.status === "ok" ? Math.max(-1, ...fp.readings!.map((r) => classOf(r.code))) : -1;
  row("Max shindo", q.shindo ? SHINDO[q.shindo] ?? q.shindo : top >= 0 ? CLASSES[top].label : q.felt ? "felt" : "not felt / not reported");
  if (q.cls !== "-") row("Type", q.prelim ? "not yet classified" : CLASS[q.cls] ?? "located by another agency");
  row(q.prelim ? "ID" : "Catalogue ID", q.id);

  const size = q.mag === null ? "Felt earthquake" : `M${q.mag.toFixed(1)} earthquake`;
  const title = el("h2", "", name ? `${name.name}, M${q.mag!.toFixed(1)}` : size);
  const parts: HTMLElement[] = [title];
  if (q.prelim) {
    title.append(" ", el("span", "badge-prelim", "Preliminary"));
    parts.push(el("p", "note",
      "Provisional values from JMA's daily hypocentre list and intensity database. They can change, and the quake " +
      "isn't yet classified (natural, low-frequency or artificial), until JMA publishes the finalised catalogue, " +
      "about two years later."));
  }
  parts.push(dl);
  parts.push(el("h2", "", "Where it was felt"));
  if (!q.felt) {
    parts.push(el("p", "sub", "No intensity readings: this quake was not reported as felt."));
  } else if (fp.status === "loading") {
    parts.push(el("p", "sub", "Loading station readings…"));
  } else if (fp.status === "none" || !fp.readings || !fp.stations) {
    parts.push(el("p", "sub",
      "Felt, but its station readings are shared with another quake close in time, so they can't be shown for this one alone."));
  } else {
    parts.push(...footprintSection(fp.readings, fp.stations, host.clientWidth));
    if (q.prelim) parts.push(el("p", "sub",
      "Preliminary readings give each station's shindo only: no instrumental value or arrival time yet, so there is no replay."));
  }
  if (extra) parts.push(extra);
  host.replaceChildren(...parts);
}

function footprintSection(all: Reading[], stations: Stations, width: number): HTMLElement[] {
  const t = theme();
  const CLASS_COLORS = shindoColors();
  const out: HTMLElement[] = [];
  const readings = all.filter((r) => r.distanceKm !== null);
  const areas = all.filter((r) => r.distanceKm === null);
  const far = d3.max(readings, (r) => r.distanceKm!) ?? 0;
  out.push(el("p", "sub",
    `${fmt(readings.length)} stations reported shaking, up to ${fmt(Math.round(far))} km from the hypocentre. ` +
    "The coloured dots on the map are those stations, from yellow (1) to purple (7)."));
  for (const a of areas) {
    out.push(el("p", "note",
      `Shindo ${CLASSES[classOf(a.code)]?.label ?? a.code} was also assigned to "${stations.name[a.station]}" as a whole ` +
      "(an area-wide value, e.g. from a damage survey), so it has no single position on the map."));
  }

  // Stations per intensity class.
  const counts = CLASSES.map((c, i) => ({ label: c.label, i, n: all.filter((r) => classOf(r.code) === i).length }))
    .filter((d) => d.n > 0);
  const unknown = all.filter((r) => classOf(r.code) < 0).length;
  const w = Math.max(260, width - 32);
  const bars = Plot.plot({
    width: w, height: 28 + counts.length * 22, marginLeft: 36, marginRight: 48,
    style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
    x: { axis: null }, y: { label: null, domain: counts.map((d) => d.label) },
    marks: [
      Plot.barX(counts, { x: "n", y: "label", fill: (d) => CLASS_COLORS[d.i], rx: 2, insetTop: 2, insetBottom: 2 }),
      Plot.text(counts, { x: "n", y: "label", text: (d) => fmt(d.n), dx: 4, textAnchor: "start", fill: t.text }),
    ],
  });
  const barsWrap = el("div", "chart");
  barsWrap.append(el("div", "chart-title", "Stations by intensity (shindo)"), bars);
  if (all.some((r) => r.code === "5" || r.code === "6")) {
    barsWrap.append(el("p", "sub",
      "Before October 1996 the scale had single grades 5 and 6 (not split into lower/upper); they are counted under 5− and 6−."));
  }
  if (unknown) barsWrap.append(el("p", "sub", `${fmt(unknown)} more reported it felt without an intensity.`));
  out.push(barsWrap, shindoScale(CLASS_COLORS));

  // Intensity vs distance: how shaking fades away from the source.
  const withInstr = readings.filter((r) => r.instrumental !== null);
  const useInstr = withInstr.length >= readings.length / 2;
  const pts = (useInstr ? withInstr : readings.filter((r) => classOf(r.code) >= 0))
    .map((r) => ({ ...r, y: useInstr ? r.instrumental! : classOf(r.code) + 1, d: Math.max(1, r.distanceKm!) }));
  if (pts.length >= 3) {
    const svg = Plot.plot({
      width: w, height: 220, marginLeft: 40, marginBottom: 34,
      style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
      x: { type: "log", label: "Distance from hypocentre (km) →", grid: true },
      y: useInstr
        ? { label: "↑ Instrumental intensity", domain: [0, 7], grid: true }
        : { label: "↑ Intensity class", domain: [0.5, 9.5], ticks: d3.range(1, 10), tickFormat: (v: number) => CLASSES[v - 1]?.label ?? "", grid: true },
      marks: [
        Plot.dot(pts, { x: "d", y: "y", r: 2.6, fill: (d) => CLASS_COLORS[Math.max(0, classOf(d.code))], fillOpacity: 0.85,
          stroke: t.surface, strokeWidth: 0.5 }),
      ],
    }) as SVGSVGElement;
    const x = (svg as unknown as { scale(n: string): { apply(v: number): number } }).scale("x");
    const y = (svg as unknown as { scale(n: string): { apply(v: number): number } }).scale("y");
    svg.addEventListener("pointermove", (ev) => {
      const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
      const l = pt.matrixTransform(svg.getScreenCTM()!.inverse());
      let best = null as (typeof pts)[number] | null, bd = 14 * 14;
      for (const p of pts) {
        const dd = (x.apply(p.d) - l.x) ** 2 + (y.apply(p.y) - l.y) ** 2;
        if (dd < bd) { bd = dd; best = p; }
      }
      if (!best) { hideTooltip(); return; }
      const b = best;
      showTooltip(ev.clientX, ev.clientY, (tip) => {
        tip.append(el("div", "t-head", stations.name[b.station] || stations.id[b.station]));
        const r1 = el("div", "t-row"); r1.append(el("span", "", "Shindo"), el("strong", "", CLASSES[classOf(b.code)]?.label ?? "felt"));
        tip.append(r1);
        if (b.instrumental !== null) {
          const r2 = el("div", "t-row"); r2.append(el("span", "", "Instrumental"), el("strong", "", b.instrumental.toFixed(1))); tip.append(r2);
        }
        const r3 = el("div", "t-row"); r3.append(el("span", "", "Distance"), el("strong", "", `${fmt(Math.round(b.distanceKm!))} km`)); tip.append(r3);
      });
    });
    svg.addEventListener("pointerleave", hideTooltip);
    const wrap = el("div", "chart");
    wrap.append(el("div", "chart-title", useInstr ? "Shaking fades with distance" : "Reported intensity by distance"), svg);
    out.push(wrap);
  }

  // Strongest readings.
  const top = [...all].sort((a, b) => (b.instrumental ?? classOf(b.code)) - (a.instrumental ?? classOf(a.code))).slice(0, 8);
  const table = document.createElement("table");
  table.className = "mini";
  const head = table.createTHead().insertRow();
  for (const h of ["Station", "Shindo", "Distance"]) head.append(el("th", "", h));
  const body = table.createTBody();
  for (const r of top) {
    const tr = body.insertRow();
    tr.append(el("td", "", stations.name[r.station] || stations.id[r.station]),
      el("td", "", (CLASSES[classOf(r.code)]?.label ?? "felt") + (r.instrumental !== null ? ` (${r.instrumental.toFixed(1)})` : "")),
      el("td", "", r.distanceKm === null ? "area" : `${fmt(Math.round(r.distanceKm))} km`));
  }
  const details = el("details", "table-view");
  details.append(el("summary", "", "Strongest readings"), table);
  out.push(details);
  return out;
}
