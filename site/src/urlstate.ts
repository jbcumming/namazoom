// Shareable view state in the URL hash, e.g.
//   #y=2010-2012&m=3&tab=quake&q=J2011031114461812_3810_14286&v=38.10,142.86,6.5
// (3d=1: the Quakes tab's 3D view.)
// Unknown or malformed parts are ignored, so old links degrade gracefully.

export interface UrlState {
  from?: number;
  to?: number;
  minMag?: number;
  tab?: string;
  view3d?: boolean;
  place?: string; // the Shaking tab's place: a city name, or "lat,lon"
  quake?: string;
  view?: { lat: number; lon: number; zoom: number };
}

/** Tabs since folded into others: My location into Shaking, History and Magnitudes into Quake. */
const MERGED: Record<string, string> = { location: "shaking", history: "quake", magnitudes: "quake" };

export function parseHash(hash: string, tabs: string[], years: [number, number]): UrlState {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const out: UrlState = {};
  const y = p.get("y")?.match(/^(\d{4})(?:-(\d{4}))?$/);
  if (y) {
    const a = Number(y[1]), b = Number(y[2] ?? y[1]);
    if (a >= years[0] && b <= years[1] && a <= b) { out.from = a; out.to = b; }
  }
  const m = Number(p.get("m"));
  if ([3, 4, 5, 6, 7, 8, 9].includes(m)) out.minMag = m;
  const tab = p.get("tab");
  if (tab && tabs.includes(tab)) out.tab = tab;
  else if (tab && MERGED[tab] && tabs.includes(MERGED[tab])) out.tab = MERGED[tab];
  // 3D was a tab of its own before it became a view of the Quakes tab.
  if (p.get("3d") === "1" || tab === "3d") { out.view3d = true; if (tabs.includes("quake")) out.tab = "quake"; }
  const at = p.get("at");
  if (at && (/^[A-Za-z]{2,20}$/.test(at) || /^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/.test(at))) out.place = at;
  const q = p.get("q");
  if (q && /^[JUI]\d{16}_-?\d+_-?\d+$/.test(q)) out.quake = q;
  const v = p.get("v")?.split(",").map(Number);
  if (v && v.length === 3 && v.every(Number.isFinite) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180) {
    out.view = { lat: v[0], lon: v[1], zoom: v[2] };
  }
  return out;
}

export function formatHash(s: UrlState): string {
  const p = new URLSearchParams();
  if (s.from !== undefined && s.to !== undefined) p.set("y", s.from === s.to ? `${s.from}` : `${s.from}-${s.to}`);
  if (s.minMag !== undefined) p.set("m", String(s.minMag));
  if (s.tab) p.set("tab", s.tab);
  if (s.view3d) p.set("3d", "1");
  if (s.place) p.set("at", s.place);
  if (s.quake) p.set("q", s.quake);
  if (s.view) p.set("v", `${s.view.lat.toFixed(2)},${s.view.lon.toFixed(2)},${s.view.zoom.toFixed(1)}`);
  return `#${p.toString().replace(/%2C/g, ",")}`;
}

/** Year of a catalogue event from its ID (agency letter, then JST YYYY...). */
export const yearFromId = (id: string) => Number(id.slice(1, 5));
