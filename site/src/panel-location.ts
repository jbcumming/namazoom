// My location tab: how often, and how strongly, shaking was recorded near a place.
import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { stationsByYear, type FeltQuake, type NearbyStation } from "./location";
import { CLASSES, shindoColors, type Stations } from "./shindo";
import { famous } from "./names";
import { el, fmt, hideTooltip, rowAction, shindoScale, showTooltip, theme } from "./ui";

export interface Place { name: string; lonlat: [number, number] }

export const PLACES: Place[] = [
  { name: "Tokyo", lonlat: [139.767, 35.681] },
  { name: "Sendai", lonlat: [140.882, 38.268] },
  { name: "Kobe", lonlat: [135.196, 34.690] },
  { name: "Niigata", lonlat: [139.036, 37.916] },
  { name: "Fukuoka", lonlat: [130.402, 33.590] },
  { name: "Sapporo", lonlat: [141.354, 43.062] },
  { name: "Naha", lonlat: [127.681, 26.212] },
];

export interface LocationInputs {
  place: Place | null;
  radiusKm: number;
  picking: boolean;
  status: "idle" | "loading" | "ok";
  quakes: FeltQuake[];
  stations: NearbyStation[];
  allStations: Stations | null;
  years: [number, number];
  onPlace(p: Place): void;
  onPick(): void;
  onGeolocate(): void;
  onRadius(km: number): void;
  onSelectQuake(q: FeltQuake): void;
}

const when = (t: number) => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10);

export function renderLocation(host: HTMLElement, inp: LocationInputs) {
  const controls = el("div", "depth-controls");
  const presets = el("div", "presets");
  for (const p of PLACES) {
    const b = el("button", inp.place?.name === p.name ? "primary" : "", p.name) as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => inp.onPlace(p));
    presets.append(b);
  }
  const pick = el("button", inp.picking ? "primary" : "", inp.picking ? "Click a place on the map…" : "Pick on map") as HTMLButtonElement;
  pick.type = "button";
  pick.addEventListener("click", () => inp.onPick());
  const geo = el("button", "", "Use my location") as HTMLButtonElement;
  geo.type = "button";
  geo.addEventListener("click", () => inp.onGeolocate());
  const radius = document.createElement("select");
  radius.setAttribute("aria-label", "Distance from the place");
  for (const r of [10, 25, 50]) {
    const o = document.createElement("option");
    o.value = String(r); o.textContent = `within ${r} km`; o.selected = r === inp.radiusKm;
    radius.append(o);
  }
  radius.addEventListener("change", () => inp.onRadius(Number(radius.value)));
  controls.append(presets, pick, geo, radius);

  const parts: HTMLElement[] = [
    el("h2", "", inp.place ? `My location: ${inp.place.name}` : "My location"),
    el("p", "sub", "How often the ground shook near a place, from the readings of seismic intensity stations nearby. " +
      "Each quake is counted once, at the strongest intensity recorded within the distance you choose."),
    controls,
  ];
  if (!inp.place) {
    parts.push(el("p", "sub", "Choose a city, pick a point on the map, or use your location."));
  } else if (inp.status === "loading" || !inp.allStations) {
    parts.push(el("p", "sub", `Loading readings near ${inp.place.name}…`));
  } else if (!inp.stations.length) {
    parts.push(el("p", "note", `No intensity stations within ${inp.radiusKm} km of ${inp.place.name}. Try a larger distance.`),
      lookingAhead(inp.place));
  } else {
    parts.push(...summary(inp, host.clientWidth));
  }
  host.replaceChildren(...parts);
}

/** This tab is the past; the official outlook for the same spot is NIED's J-SHIS hazard map. */
function lookingAhead(place: Place): HTMLElement {
  const [lon, lat] = place.lonlat;
  const p = el("p", "note");
  const a = document.createElement("a");
  // J-SHIS map links take center=lon,lat (from its API documentation).
  a.href = `https://www.j-shis.bosai.go.jp/map/?lang=en&zoom=12&center=${lon.toFixed(5)},${lat.toFixed(5)}`;
  a.target = "_blank"; a.rel = "noopener";
  a.textContent = "Open J-SHIS at this spot ↗";
  p.append("This is how often it has shaken. For the official chance of strong shaking here in the coming decades, " +
    "see J-SHIS, the national hazard map from NIED (Japan's disaster research institute). ", a);
  return p;
}

function summary(inp: LocationInputs, width: number): HTMLElement[] {
  const t = theme();
  const CLASS_COLORS = shindoColors();
  const out: HTMLElement[] = [];
  const q = inp.quakes;
  const st = inp.allStations!;
  const first = q.length ? new Date((q[0].t + 9 * 3600) * 1000).getUTCFullYear() : inp.years[0];
  const atLeast = (i: number) => q.filter((x) => x.cls >= i).length;
  const stats = el("div", "readout");
  const stat = (label: string, value: string, hint?: string) => {
    const d = el("div", "stat");
    d.append(document.createTextNode(label), el("strong", "", value));
    if (hint) d.append(el("span", "hint", hint));
    return d;
  };
  const strongest = q.reduce<FeltQuake | null>((a, b) => (!a || b.cls > a.cls || (b.cls === a.cls && (b.instrumental ?? 0) > (a.instrumental ?? 0)) ? b : a), null);
  stats.append(
    stat("Quakes felt", fmt(q.length), `since ${first}`),
    stat("Shindo 4 or more", fmt(atLeast(3)), "most people startled"),
    stat("Strongest", strongest ? (CLASSES[strongest.cls]?.label ?? "felt") : "–", strongest ? when(strongest.t) : undefined),
  );
  out.push(stats, lookingAhead(inp.place!));

  // Felt quakes per year, stacked by intensity.
  const w = Math.max(260, width - 32);
  const rows = q.filter((x) => x.cls >= 0).map((x) => ({
    year: new Date((x.t + 9 * 3600) * 1000).getUTCFullYear(), cls: x.cls, label: CLASSES[x.cls].label,
  }));
  const [y0, y1] = inp.years;
  const bars = Plot.plot({
    width: w, height: 180, marginLeft: 36, marginBottom: 24,
    style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
    x: { domain: [y0, y1 + 1], label: null, tickFormat: "d" },
    y: { label: "↑ Quakes felt", grid: true },
    color: { domain: CLASSES.map((c) => c.label), range: CLASS_COLORS },
    marks: [
      Plot.rectY(rows, Plot.binX<Plot.RectYOptions>({ y: "count" }, {
        x: "year", interval: 1, fill: "label", order: CLASSES.map((c) => c.label), insetLeft: 0.3, insetRight: 0.3,
      })),
      Plot.ruleY([0], { stroke: t.axis }),
    ],
  }) as SVGSVGElement;
  attachYearTooltip(bars, rows);
  const chart = el("div", "chart");
  chart.append(el("div", "chart-title", "Quakes felt each year, by strongest intensity nearby"), bars);
  out.push(chart);

  // Context: how many stations were there to feel them.
  const sy = stationsByYear(inp.stations, y0, y1);
  const strip = Plot.plot({
    width: w, height: 90, marginLeft: 36, marginBottom: 24,
    style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
    x: { domain: [y0, y1 + 1], label: null, tickFormat: "d" },
    y: { label: "↑ Stations", grid: true, ticks: 3 },
    marks: [Plot.areaY(sy, { x: "year", y: "n", curve: "step-after", fill: t.muted, fillOpacity: 0.35 }),
      Plot.lineY(sy, { x: "year", y: "n", curve: "step-after", stroke: t.muted })],
  });
  const strip2 = el("div", "chart");
  strip2.append(el("div", "chart-title", `Intensity stations operating within ${inp.radiusKm} km`), strip);
  out.push(strip2,
    el("p", "sub", "More stations, especially after the 1996 switch to instrumental intensity meters, mean more small " +
      "shaking gets recorded: the rise in counts is partly the network, not the earth."));

  // Strongest shakings.
  const top = [...q].filter((x) => x.cls >= 0)
    .sort((a, b) => b.cls - a.cls || (b.instrumental ?? 0) - (a.instrumental ?? 0) || a.t - b.t).slice(0, 10);
  const table = document.createElement("table");
  table.className = "mini";
  const head = table.createTHead().insertRow();
  for (const h of ["Date", "Shindo", "Quake", "Epicentre"]) head.append(el("th", "", h));
  const body = table.createTBody();
  for (const x of top) {
    const tr = body.insertRow();
    tr.append(
      el("td", "", when(x.t)),
      el("td", "", CLASSES[x.cls].label + (x.instrumental !== null ? ` (${x.instrumental.toFixed(1)})` : "")),
      el("td", "", (x.mag === null ? (x.id ? "M?" : "no hypocentre") : `M${x.mag.toFixed(1)}`) +
        (famous(x.t, x.mag) ? ` ${famous(x.t, x.mag)!.short}` : "")),
      el("td", "", x.epiKm === null ? "–" : `${fmt(Math.round(x.epiKm))} km away`),
    );
    if (x.id) rowAction(tr, "Show this quake", () => inp.onSelectQuake(x));
  }
  const tw = el("div", "chart");
  tw.append(el("div", "chart-title", "Strongest shaking recorded nearby (click a row to show the quake)"), table);
  out.push(tw, shindoScale(CLASS_COLORS));

  const noHyp = q.filter((x) => !x.id).length;
  const nearest = inp.stations.slice(0, 3).map((s) => `${st.name[s.index] || st.id[s.index]} (${s.distKm.toFixed(1)} km)`).join(", ");
  out.push(el("p", "sub",
    `${fmt(inp.stations.length)} stations within ${inp.radiusKm} km; nearest: ${nearest}. ` +
    (noHyp ? `${fmt(noHyp)} of the felt quakes have no located hypocentre (early or swarm felt reports). ` : "") +
    "Epicentres of the felt quakes are shown on the map in the same colours."));
  return out;
}

function attachYearTooltip(svg: SVGSVGElement, rows: { year: number; cls: number; label: string }[]) {
  const CLASS_COLORS = shindoColors();
  const x = (svg as unknown as { scale(n: string): { invert(p: number): number } }).scale("x");
  const byYear = d3.group(rows, (r) => r.year);
  svg.addEventListener("pointermove", (ev) => {
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const l = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    const year = Math.floor(x.invert(l.x));
    const rs = byYear.get(year);
    if (!rs) { hideTooltip(); return; }
    showTooltip(ev.clientX, ev.clientY, (tip) => {
      tip.append(el("div", "t-head", `${year}: ${fmt(rs.length)} felt`));
      for (let i = CLASSES.length - 1; i >= 0; i--) {
        const n = rs.filter((r) => r.cls === i).length;
        if (!n) continue;
        const row = el("div", "t-row");
        const k = el("span", "key"); k.style.cssText = `background:${CLASS_COLORS[i]};height:8px;border-radius:2px`;
        row.append(k, el("span", "", `Shindo ${CLASSES[i].label}`), el("strong", "", fmt(n)));
        tip.append(row);
      }
    });
  });
  svg.addEventListener("pointerleave", hideTooltip);
}
