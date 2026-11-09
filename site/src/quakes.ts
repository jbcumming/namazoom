// Loading and selecting quakes for the map. Data layout: pipeline/build/site_data.py.
//   quakes/m5.json        all shown events M >= 5 (loaded at start)
//   quakes/m3/{year}.json 3 <= M < 5, and felt events without magnitude (on demand)

export interface QuakeColumns {
  t: number[]; // seconds since epoch, UTC
  lat: number[];
  lon: number[];
  depth: (number | null)[];
  mag: (number | null)[];
  shindo: string[];
  cls: string[];
  felt: boolean[];
  dmg: string[]; // damage class code (pipeline/jma/codes.DAMAGE_CLASS), "" if none
  tsu: string[]; // tsunami class code, "" if none
  id: string[];
  region?: string[]; // English region name; m5.json only
}

export interface QuakeIndex {
  generated: string;
  years: [number, number];
  prelimFrom: number | null; // UTC seconds: quakes from here on are preliminary (pipeline/build/prelim.py)
  dataEnd: number; // UTC seconds of the latest quake
  m5: number;
  m3: Record<string, number>;
}

export interface QuakeProps {
  t: number;
  mag: number | null;
  depth: number | null;
  shindo: string;
  cls: string;
  felt: boolean;
  id: string;
  dmg?: string;
  tsu?: string;
  region?: string;
  prelim?: boolean; // provisional JMA values, not yet in the finalised catalogue
}

/** Longest year range for which M3+ events are drawn all at once. */
export const MAX_YEARS_FOR_M3 = 10;

export const yearStart = (y: number) => Date.UTC(y, 0, 1) / 1000 - 9 * 3600; // JST year boundaries
export const yearEnd = (y: number) => yearStart(y + 1) - 1;
export const yearOf = (t: number) => new Date((t + 9 * 3600) * 1000).getUTCFullYear();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Japan-time date of a UTC timestamp, e.g. "7 Nov 2026". */
export function fmtDate(t: number): string {
  const d = new Date((t + 9 * 3600) * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Which yearly M3 files a view needs. */
export function yearsNeeded(fromT: number, toT: number, minMag: number): number[] {
  if (minMag >= 5) return [];
  const out: number[] = [];
  for (let y = yearOf(fromT); y <= yearOf(toT); y++) out.push(y);
  return out;
}

export class QuakeStore {
  index!: QuakeIndex;
  private m5!: QuakeColumns;
  private m3 = new Map<number, Promise<QuakeColumns>>();
  private loaded = new Map<number, QuakeColumns>();

  constructor(private base = "./data/quakes") {}

  async init() {
    const [index, m5] = await Promise.all([
      fetch(`${this.base}/index.json`).then((r) => r.json()),
      fetch(`${this.base}/m5.json`).then((r) => r.json()),
    ]);
    this.index = index;
    this.m5 = m5;
  }

  /** Fetch the yearly files (cached); resolves when all are available. */
  async ensureYears(years: number[]): Promise<void> {
    const [y0, y1] = this.index.years;
    await Promise.all(
      years.filter((y) => y >= y0 && y <= y1).map((y) => {
        if (!this.m3.has(y)) {
          const p = fetch(`${this.base}/m3/${y}.json`).then((r) => r.json()).then((c: QuakeColumns) => {
            this.loaded.set(y, c);
            return c;
          });
          this.m3.set(y, p);
        }
        return this.m3.get(y)!;
      }),
    );
  }

  /** True for quakes after the finalised catalogue (provisional values that may change). */
  isPrelim(t: number): boolean {
    return this.index.prelimFrom !== null && this.index.prelimFrom !== undefined && t >= this.index.prelimFrom;
  }

  hasYears(years: number[]): boolean {
    return years.every((y) => this.loaded.has(y) || y < this.index.years[0] || y > this.index.years[1]);
  }

  /** GeoJSON for events in [fromT, toT] at or above minMag (only from data already loaded). */
  features(fromT: number, toT: number, minMag: number): GeoJSON.FeatureCollection<GeoJSON.Point, QuakeProps> {
    const out: GeoJSON.Feature<GeoJSON.Point, QuakeProps>[] = [];
    const add = (c: QuakeColumns) => {
      for (let i = 0; i < c.t.length; i++) {
        const t = c.t[i];
        if (t < fromT || t > toT) continue;
        const m = c.mag[i];
        if (m !== null && m < minMag) continue;
        if (m === null && minMag >= 5) continue;
        out.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [c.lon[i], c.lat[i]] },
          properties: { t, mag: m, depth: c.depth[i], shindo: c.shindo[i], cls: c.cls[i], felt: c.felt[i], id: c.id[i],
            dmg: c.dmg[i], tsu: c.tsu[i], region: c.region?.[i], prelim: this.isPrelim(t) },
        });
      }
    };
    add(this.m5);
    if (minMag < 5) for (const y of yearsNeeded(fromT, toT, minMag)) { const c = this.loaded.get(y); if (c) add(c); }
    return { type: "FeatureCollection", features: out };
  }
}
