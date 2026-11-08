// Felt history at a place. Data: pipeline/build/site_data.py build_felt.
import { classOf, type Stations } from "./shindo";

interface CellFile {
  events: { t: number[]; lat: (number | null)[]; lon: (number | null)[]; depth: (number | null)[]; mag: (number | null)[]; id: string[] };
  st: number[];
  ev: number[];
  sh: string;
  iv: number[];
}

export interface FeltQuake {
  key: string;
  t: number; // UTC seconds
  id: string; // catalogue ID, "" for felt reports without a located hypocentre
  lat: number | null;
  lon: number | null;
  depth: number | null;
  mag: number | null;
  cls: number; // strongest intensity class index nearby (-1: felt, unknown)
  code: string;
  instrumental: number | null;
  station: number; // station where the strongest shaking was recorded
  epiKm: number | null; // distance from the chosen point to the epicentre
}

export interface NearbyStation {
  index: number;
  distKm: number;
  start: string | null;
  end: string | null;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** 1° cells (south-west corners) that a circle can touch. */
export function cellsForCircle(lon: number, lat: number, radiusKm: number): string[] {
  const dLat = radiusKm / 111.2;
  const dLon = radiusKm / (111.2 * Math.cos((lat * Math.PI) / 180));
  const out: string[] = [];
  for (let a = Math.floor(lat - dLat); a <= Math.floor(lat + dLat); a++) {
    for (let b = Math.floor(lon - dLon); b <= Math.floor(lon + dLon); b++) out.push(`${a}_${b}`);
  }
  return out;
}

/** Strength order of a reading: class first, then instrumental value. */
const strength = (cls: number, iv: number | null) => cls * 100 + (iv ?? 0);

export class LocationStore {
  private index: Promise<Set<string>>;
  private cells = new Map<string, Promise<CellFile>>();

  constructor(private base = "./data/felt") {
    this.index = fetch(`${base}/index.json`).then((r) => r.json()).then((d) => new Set<string>(d.cells));
  }

  private cell(key: string): Promise<CellFile> {
    if (!this.cells.has(key)) this.cells.set(key, fetch(`${this.base}/${key}.json`).then((r) => r.json()));
    return this.cells.get(key)!;
  }

  async query(stations: Stations, lon: number, lat: number, radiusKm: number):
      Promise<{ quakes: FeltQuake[]; stations: NearbyStation[] }> {
    const have = await this.index;
    const keys = cellsForCircle(lon, lat, radiusKm).filter((k) => have.has(k));
    const files = await Promise.all(keys.map((k) => this.cell(k)));

    const nearby = new Map<number, number>(); // station index -> distance
    const quakes = new Map<string, FeltQuake>();
    for (const f of files) {
      for (let i = 0; i < f.st.length; i++) {
        const s = f.st[i];
        let d = nearby.get(s);
        if (d === undefined) {
          const sLat = stations.lat[s], sLon = stations.lon[s];
          d = sLat === null || sLon === null ? Infinity : haversineKm(lat, lon, sLat, sLon);
          nearby.set(s, d);
        }
        if (d > radiusKm) continue;
        const e = f.ev[i];
        const ev = f.events;
        const key = `${ev.t[e]}|${ev.id[e]}|${ev.lat[e]}`;
        const cls = classOf(f.sh[i]);
        const iv = f.iv[i] < 0 ? null : f.iv[i] / 10;
        const prev = quakes.get(key);
        if (!prev || strength(cls, iv) > strength(prev.cls, prev.instrumental)) {
          const eLat = ev.lat[e], eLon = ev.lon[e];
          quakes.set(key, {
            key, t: ev.t[e], id: ev.id[e], lat: eLat, lon: eLon, depth: ev.depth[e], mag: ev.mag[e],
            cls, code: f.sh[i], instrumental: iv, station: s,
            epiKm: eLat === null || eLon === null ? null : haversineKm(lat, lon, eLat, eLon),
          });
        }
      }
    }
    const near: NearbyStation[] = [];
    for (const [index, distKm] of nearby) {
      if (distKm <= radiusKm) near.push({ index, distKm, start: stations.start[index], end: stations.end[index] });
    }
    return { quakes: [...quakes.values()].sort((a, b) => a.t - b.t), stations: near.sort((a, b) => a.distKm - b.distKm) };
  }
}

/** Number of nearby stations operating in each year (start/end are ISO prefixes; unknown start = assume from 1919). */
export function stationsByYear(stations: NearbyStation[], from: number, to: number): { year: number; n: number }[] {
  const out = [];
  for (let y = from; y <= to; y++) {
    let n = 0;
    for (const s of stations) {
      const a = s.start ? Number(s.start.slice(0, 4)) : from;
      const b = s.end ? Number(s.end.slice(0, 4)) : to;
      if (a <= y && y <= b) n++;
    }
    out.push({ year: y, n });
  }
  return out;
}
