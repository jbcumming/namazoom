// Geometry for depth cross-sections. Pure functions, no DOM.
//
// A section runs from A to B. Points are projected onto it with a local
// equirectangular projection centred on the line's midpoint: accurate to well
// under 1% over the few hundred km a section spans at Japan's latitudes.

export type LonLat = [number, number];

export interface Section {
  a: LonLat;
  b: LonLat;
  halfWidthKm: number;
}

const KM_PER_DEG = 111.195; // mean Earth radius 6371 km

export function frame(s: Section) {
  const lat0 = ((s.a[1] + s.b[1]) / 2) * (Math.PI / 180);
  const kx = KM_PER_DEG * Math.cos(lat0);
  const toXY = ([lon, lat]: LonLat): [number, number] => [(lon - s.a[0]) * kx, (lat - s.a[1]) * KM_PER_DEG];
  const [bx, by] = toXY(s.b);
  const length = Math.hypot(bx, by);
  const ux = bx / length, uy = by / length; // unit vector A -> B
  return {
    length,
    /** along: km from A along the line; across: signed km off the line (left positive). */
    project(p: LonLat) {
      const [x, y] = toXY(p);
      return { along: x * ux + y * uy, across: -x * uy + y * ux };
    },
    /** Inverse of project for across = 0, and offset corners for the swath. */
    unproject(along: number, across = 0): LonLat {
      const x = along * ux - across * uy;
      const y = along * uy + across * ux;
      return [s.a[0] + x / kx, s.a[1] + y / KM_PER_DEG];
    },
  };
}

export function sectionLengthKm(s: Section) {
  return frame(s).length;
}

/** Corners of the band covered by the section, for drawing on the map. */
export function swath(s: Section): LonLat[] {
  const f = frame(s);
  const w = s.halfWidthKm;
  return [f.unproject(0, w), f.unproject(f.length, w), f.unproject(f.length, -w), f.unproject(0, -w), f.unproject(0, w)];
}

/** Points within the band, with their position along the line. */
export function inSection<T>(s: Section, items: T[], pos: (t: T) => LonLat): { item: T; along: number; across: number }[] {
  const f = frame(s);
  const out = [];
  for (const item of items) {
    const { along, across } = f.project(pos(item));
    if (along >= 0 && along <= f.length && Math.abs(across) <= s.halfWidthKm) out.push({ item, along, across });
  }
  return out;
}

/** Where the section line crosses a polyline: positions along the line (km). */
export function crossings(s: Section, line: LonLat[]): number[] {
  const f = frame(s);
  const out: number[] = [];
  for (let i = 1; i < line.length; i++) {
    const p = f.project(line[i - 1]);
    const q = f.project(line[i]);
    if ((p.across > 0) === (q.across > 0)) continue; // same side: no crossing
    const t = p.across / (p.across - q.across);
    const along = p.along + t * (q.along - p.along);
    if (along >= 0 && along <= f.length) out.push(along);
  }
  return out;
}

/** Stretches of the line over land, as [from, to] km along it. Land: polygons (outer ring, then holes). */
export function landSpans(s: Section, polys: LonLat[][][], stepKm = 2): [number, number][] {
  const f = frame(s);
  const box = { w: Math.min(s.a[0], s.b[0]), e: Math.max(s.a[0], s.b[0]), s: Math.min(s.a[1], s.b[1]), n: Math.max(s.a[1], s.b[1]) };
  // Only polygons whose bounding box meets the line's.
  const near = polys.filter((poly) => {
    const xs = poly[0].map((p) => p[0]), ys = poly[0].map((p) => p[1]);
    return Math.min(...xs) <= box.e && Math.max(...xs) >= box.w && Math.min(...ys) <= box.n && Math.max(...ys) >= box.s;
  });
  const inRing = ([x, y]: LonLat, ring: LonLat[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const onLand = (p: LonLat) => near.some((poly) => inRing(p, poly[0]) && !poly.slice(1).some((hole) => inRing(p, hole)));
  const n = Math.max(2, Math.ceil(f.length / stepKm));
  const spans: [number, number][] = [];
  let start: number | null = null;
  for (let i = 0; i <= n; i++) {
    const d = (i / n) * f.length;
    const land = onLand(f.unproject(d));
    if (land && start === null) start = d;
    if (!land && start !== null) { spans.push([start, d]); start = null; }
  }
  if (start !== null) spans.push([start, f.length]);
  return spans;
}
