// Slow-slip tab: low-frequency earthquakes in the visible area and period.
import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import { along, axisLabel, principalAxis, weekly, type LfeColumns } from "./lfe";
import { el, fmt, isDark, theme } from "./ui";

export interface LfeInputs {
  status: "loading" | "ok";
  data: LfeColumns | null;
  idx: number[]; // events in the visible area and period
  from: number; // UTC seconds
  to: number;
  years: string;
}

export function renderLfe(host: HTMLElement, inp: LfeInputs) {
  const t = theme();
  const how = el("ul", "sub how");
  for (const text of [
    "On the map: orange dots are low-frequency events in the period and area on screen; ordinary quakes are faded.",
    "Events per week: each burst of slip shows as a spike.",
    "Where and when: each burst is a streak. A slanted streak means the tremor moved along the belt over days.",
    "Where to look: zoom to Shikoku, the Kii Peninsula or Tōkai and choose a few recent years.",
  ]) how.append(el("li", "", text));
  const parts: HTMLElement[] = [
    el("h2", "", "Slow slip: low-frequency earthquakes"),
    el("p", "sub", "Not every movement between plates is a sudden quake. In places the boundary slides slowly for days " +
      "to weeks in a slow slip event: too gentle to feel, but it gives off swarms of weak, deep tremors called " +
      "low-frequency earthquakes. JMA lists them separately from ordinary quakes; this tab shows them."),
    el("p", "sub", "The clearest belt runs under western Japan, from Tōkai through the Kii Peninsula to Shikoku, about " +
      "30 km down on the sinking Philippine Sea plate (found by Obara, 2002). It lies just below the locked part of the " +
      "plate boundary that breaks in the great Nankai Trough quakes, so it is watched closely. Bursts every few months " +
      "are normal; JMA issues a Nankai Trough advisory only for slow slip that is clearly unusual. Other low-frequency " +
      "events sit beneath volcanoes and come from magma and fluids, not plate slip."),
    how,
  ];
  if (inp.status === "loading" || !inp.data) {
    host.replaceChildren(...parts, el("p", "sub", "Loading low-frequency events…"));
    return;
  }
  const c = inp.data;
  const idx = inp.idx;
  if (idx.length < 10) {
    host.replaceChildren(...parts, el("p", "sub",
      `Too few low-frequency events in this area and period (${idx.length}). They are catalogued from 1997; try the whole of ` +
      "western Japan (Shikoku, Kii, Tōkai)."));
    return;
  }
  const mf = idx.filter((i) => c.mf[i]).length;
  const depth = d3.median(idx, (i) => c.depth[i] ?? undefined);
  parts.push(el("p", "lead",
    `${fmt(idx.length)} low-frequency events, ${inp.years}; median depth ${depth === undefined ? "–" : `${Math.round(depth)} km`}. ` +
    `${d3.format(".0%")(mf / idx.length)} found by template matching.`));

  const w = Math.max(260, host.clientWidth - 32);

  // Weekly counts, split by detection method.
  const weeks = weekly(c, idx, inp.from, inp.to);
  const stacked = weeks.flatMap((b) => [
    { t0: b.t0, n: b.standard, method: "Standard location" },
    { t0: b.t0, n: b.matched, method: "Template matching (from 2018)" },
  ]).filter((d) => d.n > 0);
  const methods = ["Standard location", "Template matching (from 2018)"];
  const legend = el("div", "legend");
  methods.forEach((m, i) => {
    const k = el("span", "key");
    const sw = el("span", "swatch"); sw.style.cssText = `height:9px;border-radius:2px;background:${t.series[i]}`;
    k.append(sw, el("span", "", m));
    legend.append(k);
  });
  const bars = Plot.plot({
    width: w, height: 170, marginLeft: 40, marginBottom: 24,
    style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
    x: { type: "time", label: null },
    y: { label: "↑ Per week", grid: true },
    color: { domain: methods, range: [t.series[0], t.series[1]] },
    marks: [
      Plot.rectY(stacked, Plot.stackY({ x1: (d) => new Date(d.t0 * 1000), x2: (d) => new Date((d.t0 + 7 * 86400) * 1000),
        y: "n", fill: "method", order: methods })),
      Plot.ruleY([0], { stroke: t.axis }),
    ],
  });
  const c1 = el("div", "chart");
  c1.append(el("div", "chart-title", "Events per week"), legend, bars);
  parts.push(c1);

  // Space-time: distance along the belt against time.
  const axis = principalAxis(idx.map((i) => c.lat[i]), idx.map((i) => c.lon[i]));
  if (axis) {
    const pts = idx.map((i) => ({ t: new Date(c.t[i] * 1000), d: along(axis, c.lat[i], c.lon[i]) }));
    const [a, b] = axisLabel(axis);
    const spaceTime = Plot.plot({
      width: w, height: 300, marginLeft: 48, marginBottom: 24,
      style: { background: "transparent", color: t.secondary, fontSize: "11px", fontFamily: "inherit" },
      x: { type: "time", label: null },
      y: { label: `↑ km along the belt (${a} → ${b})`, grid: true },
      // More events = stronger blue: depth ramp light->dark, reversed on dark backgrounds.
      // Square-root scale from the palette's lightest blue (step 100) so isolated
      // events stay faint and bursts stand out.
      color: { type: "sqrt", range: isDark() ? ["#184f95", "#cde2fb"] : ["#cde2fb", t.depth[4]], interpolate: "lab", legend: false },
      marks: [
        Plot.rect(pts, Plot.bin<Plot.RectOptions>({ fill: "count" }, {
          x: { value: "t", interval: d3.utcWeek }, y: { value: "d", interval: 10 }, inset: 0,
        })),
      ],
    });
    const c2 = el("div", "chart");
    c2.append(el("div", "chart-title", "Where and when: bursts show as streaks (darker = more events per week and 10 km)"), spaceTime);
    parts.push(c2, el("p", "sub",
      `The vertical axis follows the direction the events in view are most spread along (${a} to ${b}). In western ` +
      "Shikoku the bursts recur every few months, often migrating along the belt over days to weeks."));
  }

  parts.push(el("p", "sub",
    "Counts jump in 2018 when JMA began locating many more of these events by template matching (comparing the " +
    "records with known events), so compare periods within one method. Low-frequency events are not counted in the " +
    "magnitude statistics or shown on the main map."));
  host.replaceChildren(...parts);
}
