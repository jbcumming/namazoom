// Readable place names: JMA's English region names are capitals with
// abbreviations ("FAR E OFF MIYAGI PREF"), and well-known quakes have common names.

const ABBR: Record<string, string> = {
  E: "east", W: "west", N: "north", S: "south", NE: "north-east", NW: "north-west", SE: "south-east", SW: "south-west",
  PREF: "Prefecture", PEN: "Peninsula", IS: "Islands", ISL: "Island", REG: "Region", DIST: "District",
};
const LOWER = new Set(["off", "near", "of", "and", "the", "far", "east", "west", "north", "south", "north-east",
  "north-west", "south-east", "south-west", "northern", "southern", "eastern", "western", "central", "coast", "border", "region"]);

/** "FAR E OFF MIYAGI PREF" -> "Far east off Miyagi Prefecture". */
export function regionLabel(region: string | undefined | null): string {
  if (!region) return "";
  const words = region.trim().split(/\s+/).map((w) => {
    const up = w.toUpperCase();
    if (ABBR[up]) return ABBR[up];
    const lw = w.toLowerCase();
    if (LOWER.has(lw)) return lw;
    return lw.replace(/(^|[-'])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
  });
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface Famous { date: string; m: number; id: string; name: string; short: string }

/** Well-known quakes: Japan date, JMA magnitude and catalogue id (checked against the catalogue). */
export const FAMOUS: Famous[] = [
  { date: "1923-09-01", m: 7.9, id: "J1923090111583168_3533_13914", name: "Great Kantō earthquake", short: "Kantō 1923" },
  { date: "1927-03-07", m: 7.3, id: "J1927030718273922_3563_13493", name: "Kita-Tango earthquake", short: "Kita-Tango 1927" },
  { date: "1930-11-26", m: 7.3, id: "J1930112604024690_3504_13897", name: "North Izu earthquake", short: "North Izu 1930" },
  { date: "1933-03-03", m: 8.1, id: "J1933030302304766_3913_14512", name: "Shōwa Sanriku earthquake", short: "Sanriku 1933" },
  { date: "1943-09-10", m: 7.2, id: "J1943091017365359_3547_13418", name: "Tottori earthquake", short: "Tottori 1943" },
  { date: "1944-12-07", m: 7.9, id: "J1944120713354000_3357_13618", name: "Tōnankai earthquake", short: "Tōnankai 1944" },
  { date: "1945-01-13", m: 6.8, id: "J1945011303382326_3470_13711", name: "Mikawa earthquake", short: "Mikawa 1945" },
  { date: "1946-12-21", m: 8.0, id: "J1946122104190410_3294_13585", name: "Nankai earthquake", short: "Nankai 1946" },
  { date: "1948-06-28", m: 7.1, id: "J1948062816132880_3617_13629", name: "Fukui earthquake", short: "Fukui 1948" },
  { date: "1952-03-04", m: 8.2, id: "J1952030410224358_4171_14415", name: "Tokachi-oki earthquake", short: "Tokachi-oki 1952" },
  { date: "1964-06-16", m: 7.5, id: "J1964061613014070_3837_13921", name: "Niigata earthquake", short: "Niigata 1964" },
  { date: "1968-05-16", m: 7.9, id: "J1968051609485451_4070_14360", name: "Tokachi-oki earthquake", short: "Tokachi-oki 1968" },
  { date: "1978-01-14", m: 7.0, id: "J1978011412243860_3477_13925", name: "Izu-Ōshima-kinkai earthquake", short: "Izu-Ōshima 1978" },
  { date: "1978-06-12", m: 7.4, id: "J1978061217142540_3815_14217", name: "Miyagi-ken-oki earthquake", short: "Miyagi-oki 1978" },
  { date: "1983-05-26", m: 7.7, id: "J1983052611595750_4036_13907", name: "Nihonkai-Chūbu earthquake", short: "Nihonkai-Chūbu 1983" },
  { date: "1993-01-15", m: 7.5, id: "J1993011520060720_4292_14435", name: "Kushiro-oki earthquake", short: "Kushiro-oki 1993" },
  { date: "1993-07-12", m: 7.8, id: "J1993071222171170_4278_13918", name: "Hokkaidō Nansei-oki earthquake", short: "Okushiri 1993" },
  { date: "1994-10-04", m: 8.2, id: "J1994100422225690_4338_14767", name: "Hokkaidō Tōhō-oki earthquake", short: "Tōhō-oki 1994" },
  { date: "1995-01-17", m: 7.3, id: "J1995011705465186_3460_13504", name: "Great Hanshin (Kobe) earthquake", short: "Kobe 1995" },
  { date: "2000-10-06", m: 7.3, id: "J2000100613301794_3527_13335", name: "Western Tottori earthquake", short: "Tottori 2000" },
  { date: "2003-09-26", m: 8.0, id: "J2003092604500742_4178_14408", name: "Tokachi-oki earthquake", short: "Tokachi-oki 2003" },
  { date: "2004-10-23", m: 6.8, id: "J2004102317560030_3729_13887", name: "Chūetsu earthquake", short: "Chūetsu 2004" },
  { date: "2007-07-16", m: 6.8, id: "J2007071610132255_3756_13861", name: "Chūetsu-oki earthquake", short: "Chūetsu-oki 2007" },
  { date: "2008-06-14", m: 7.2, id: "J2008061408434536_3903_14088", name: "Iwate-Miyagi Nairiku earthquake", short: "Iwate-Miyagi 2008" },
  { date: "2011-03-11", m: 9.0, id: "J2011031114461812_3810_14286", name: "Great East Japan (Tōhoku) earthquake", short: "Tōhoku 2011" },
  { date: "2016-04-14", m: 6.5, id: "J2016041421263443_3274_13081", name: "Kumamoto earthquake, foreshock", short: "Kumamoto foreshock 2016" },
  { date: "2016-04-16", m: 7.3, id: "J2016041601250547_3275_13076", name: "Kumamoto earthquake", short: "Kumamoto 2016" },
  { date: "2018-09-06", m: 6.7, id: "J2018090603075933_4269_14201", name: "Hokkaidō Eastern Iburi earthquake", short: "Iburi 2018" },
  { date: "2024-01-01", m: 7.6, id: "J2024010116102257_3750_13727", name: "Noto Peninsula earthquake", short: "Noto 2024" },
];

const jstDate = (t: number) => new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10);
const byDate = new Map<string, Famous[]>();
for (const f of FAMOUS) byDate.set(f.date, [...(byDate.get(f.date) ?? []), f]);

export function famous(t: number, mag: number | null | undefined): Famous | null {
  if (mag === null || mag === undefined) return null;
  return byDate.get(jstDate(t))?.find((f) => Math.abs(f.m - mag) < 0.05) ?? null;
}

/** For lists and labels: the common name when there is one, else the readable region. */
export function quakePlace(p: { t: number; mag: number | null; region?: string }): string {
  return famous(p.t, p.mag)?.name ?? regionLabel(p.region);
}
