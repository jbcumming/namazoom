// Station readings (shindo) for felt quakes. Data: pipeline/build/site_data.py build_shindo.

export interface Stations {
  id: string[];
  name: string[];
  lat: (number | null)[]; // null: area entry without a single position (e.g. 1995 Kobe shindo-7 survey area)
  lon: (number | null)[];
  start: (string | null)[];
  end: (string | null)[];
}

interface MonthFile {
  ids: string[];
  start: number[];
  st: number[];
  sh: string;
  iv: number[];
  ot: (number | null)[]; // tenths of a second after origin
}

export interface Reading {
  station: number; // index into Stations
  code: string; // station intensity code
  instrumental: number | null;
  distanceKm: number | null; // hypocentral distance; null when the station has no position
  obsSec: number | null; // recorded observation time, seconds after the origin time
}

// Intensity classes in order. Old-scale 5/6 (until Sep 1996) sit with 5-/6-.
export const CLASSES = [
  { codes: ["1"], label: "1" },
  { codes: ["2"], label: "2" },
  { codes: ["3"], label: "3" },
  { codes: ["4"], label: "4" },
  { codes: ["A", "5"], label: "5−" },
  { codes: ["B"], label: "5+" },
  { codes: ["C", "6"], label: "6−" },
  { codes: ["D"], label: "6+" },
  { codes: ["7"], label: "7" },
];
export const classOf = (code: string) => CLASSES.findIndex((c) => c.codes.includes(code)); // -1 for '9' (felt, unknown)

/** One colour per class, from the --shindo-1..9 tokens in style.css: an ordered
 * scale whose hue moves yellow -> orange -> red -> crimson -> purple while
 * lightness falls evenly, so neighbouring levels differ in hue *and* the order
 * still reads light -> dark (validated as an ordinal ramp, light and dark
 * mode separately). No blue, which is taken by depth. */
export function shindoColors(): string[] {
  const css = getComputedStyle(document.documentElement);
  return CLASSES.map((_, i) => css.getPropertyValue(`--shindo-${i + 1}`).trim());
}

const R = 6371;
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export class ShindoStore {
  stations: Stations | null = null;
  private months = new Map<string, Promise<MonthFile | null>>();

  constructor(private base = "./data") {}

  loadStations(): Promise<Stations> {
    if (this.stations) return Promise.resolve(this.stations);
    return fetch(`${this.base}/stations.json`).then((r) => r.json()).then((s) => (this.stations = s));
  }

  private month(ym: string): Promise<MonthFile | null> {
    if (!this.months.has(ym)) {
      this.months.set(ym, fetch(`${this.base}/shindo/${ym}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    }
    return this.months.get(ym)!;
  }

  /** Readings for one quake, strongest first; null if the quake has no attributable readings. */
  async readings(id: string, t: number, lat: number, lon: number, depthKm: number | null): Promise<Reading[] | null> {
    const d = new Date((t + 9 * 3600) * 1000); // month of origin, JST
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const [stations, m] = await Promise.all([this.loadStations(), this.month(ym)]);
    if (!m) return null;
    const k = m.ids.indexOf(id);
    if (k < 0) return null;
    const end = k + 1 < m.start.length ? m.start[k + 1] : m.st.length;
    const out: Reading[] = [];
    for (let i = m.start[k]; i < end; i++) {
      const s = m.st[i];
      const sLat = stations.lat[s], sLon = stations.lon[s];
      out.push({
        station: s,
        code: m.sh[i],
        instrumental: m.iv[i] < 0 ? null : m.iv[i] / 10,
        distanceKm: sLat === null || sLon === null ? null : Math.hypot(haversineKm(lat, lon, sLat, sLon), depthKm ?? 0),
        obsSec: m.ot[i] === null || m.ot[i] === undefined ? null : m.ot[i]! / 10,
      });
    }
    return out;
  }
}
