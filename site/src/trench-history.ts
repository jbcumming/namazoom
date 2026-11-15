// Great subduction-zone quakes along Japan's trenches: the historical record and the
// official 30-year probabilities. Transcribed by hand from the Headquarters for
// Earthquake Research Promotion (HERP, 地震調査研究推進本部) long-term evaluations
// (www.jishin.go.jp, checked Nov 2026):
//   Nankai: 南海トラフの地震活動の長期評価（第二版一部改訂）, 26 Sep 2025 (nankai_3.pdf),
//     table 1 and explanation ch. 3-4.
//   Sagami: 相模トラフ沿いの地震活動の長期評価（第二版）, 2014 (sagami_2.pdf).
//   Japan Trench: 日本海溝沿いの地震活動の長期評価, 2019 (japan_trench.pdf), 4-2.
//   Kuril: 千島海溝沿いの地震活動の長期評価（第三版）, 2017 (chishima3.pdf).
//   Probabilities: 長期評価結果一覧 and the update comparison, both for 1 Jan 2026
//     (ichiran.pdf, 26jan_kakuritsu/p01_hikaku.pdf).
// Pre-1600 records are incomplete (HERP: quakes before 1361 on the Nankai Trough and
// before the Edo period on the Japan Trench may be missing), so gaps there are not
// evidence of quiet.

export interface TrenchEvent {
  year: number;
  to?: number;   // a date range (e.g. tsunami deposits dated 1611-1637)
  name: string;
  ja: string;
  m?: string;    // magnitude as given by HERP (Utsu 1999 M for historical quakes)
  sure: boolean; // false: HERP lists it as possible / uncertain
  note?: string;
}

export interface TrenchRow {
  id: string;
  label: string;
  zone: string;  // groups rows that share one probability line in the table
  events: TrenchEvent[];
}

export interface TrenchOutlook {
  zone: string;
  quake: string;
  last: string;
  interval: string;
  p30: string; // chance within 30 years from 1 Jan 2026
  rate?: number;                // plate convergence, mm/yr (PB2002), for the slip budget
  lastYears?: [number, number]; // year (range) of the last such quake, for the slip budget
  area?: string;                // id of its official source area (overlays/trench_zones.json, from J-SHIS)
}

// Relative plate velocity along each trench: the median of PB2002's boundary steps
// (Bird 2003; data/raw/plates/PB2002_steps.json, total velocity VELOCITYLE) in boxes
// off Miyagi (PA\OK), off Tokachi-Nemuro (OK/PA), along the Nankai Trough (AM/PS)
// and the Sagami Trough (OK-PS, mostly oblique).
export const PLATE_RATE = { "Japan Trench": 92, Kuril: 90, Nankai: 50, Sagami: 35 } as const;

/** Slip that would have built up since the last quake if the fault were fully locked, metres [min, max]. */
export function slipBudget(o: TrenchOutlook, year: number): [number, number] | null {
  if (!o.rate || !o.lastYears) return null;
  return [o.rate * (year - o.lastYears[1]) / 1000, o.rate * (year - o.lastYears[0]) / 1000];
}

export const AS_OF = "1 January 2026";
export const HERP_LTE = "https://www.jishin.go.jp/evaluation/long_term_evaluation/";
export const HERP_SUMMARY = "https://www.jishin.go.jp/evaluation/long_term_evaluation/lte_summary/";

const nankaiNote = "Before 1361 the record may be incomplete and which segments broke is uncertain.";

export const ROWS: TrenchRow[] = [
  {
    id: "kuril17", label: "Kuril Trench: 17th-century type, M8.8+", zone: "Kuril",
    events: [{ year: 1611, to: 1637, name: "17th-century great quake", ja: "17世紀型超巨大地震", m: "8.8+", sure: true,
      note: "Known from tsunami deposits along eastern Hokkaido; dated 1611–1637. Deposits show about 340–380-year recurrence." }],
  },
  {
    id: "tokachi", label: "Kuril Trench: off Tokachi", zone: "Kuril",
    events: [
      { year: 1843, name: "1843 Tokachi-oki / Nemuro-oki", ja: "1843年の地震", m: "8.0", sure: true, note: "May have broken the Nemuro segment too." },
      { year: 1952, name: "1952 Tokachi-oki", ja: "十勝沖地震", m: "8.2", sure: true },
      { year: 2003, name: "2003 Tokachi-oki", ja: "平成15年十勝沖地震", m: "8.0", sure: true },
    ],
  },
  {
    id: "nemuro", label: "Kuril Trench: off Nemuro", zone: "Kuril",
    events: [
      { year: 1843, name: "1843 Tokachi-oki / Nemuro-oki", ja: "1843年の地震", m: "8.0", sure: true, note: "May have broken the Tokachi segment too." },
      { year: 1894, name: "1894 Nemuro-oki", ja: "根室沖の地震", m: "7.9", sure: true },
      { year: 1973, name: "1973 Nemuro-oki", ja: "根室半島沖地震", m: "7.4", sure: true },
    ],
  },
  {
    id: "jt9", label: "Japan Trench: Tōhoku type, M9", zone: "Japan Trench",
    events: [
      { year: 869, name: "Jōgan", ja: "貞観地震", sure: true, note: "Historical record and tsunami deposits. Deposits show two older ones (4th–5th century AD, 4th–3rd century BC)." },
      { year: 1454, name: "Kyōtoku", ja: "享徳地震", sure: false, note: "Either this or the 1611 Keichō Sanriku quake was the one before 2011." },
      { year: 1611, name: "Keichō Sanriku", ja: "慶長三陸地震", sure: false, note: "Either this or the 1454 Kyōtoku quake was the one before 2011." },
      { year: 2011, name: "Tōhoku", ja: "東北地方太平洋沖地震", m: "9.0", sure: true },
    ],
  },
  {
    id: "jtTsu", label: "Japan Trench: tsunami quakes near the trench", zone: "Japan Trench",
    events: [
      { year: 1611, name: "Keichō Sanriku", ja: "慶長三陸地震", sure: true },
      { year: 1677, name: "Enpō Bōsō-oki", ja: "延宝房総沖地震", sure: true },
      { year: 1896, name: "Meiji Sanriku", ja: "明治三陸地震", sure: true, note: "Tsunami killed nearly 22,000 people." },
      { year: 2011, name: "Tōhoku", ja: "東北地方太平洋沖地震", m: "9.0", sure: true, note: "Included because its slip near the trench made the tsunami so high." },
    ],
  },
  {
    id: "sagami", label: "Sagami Trough: Kantō, M8 class", zone: "Sagami",
    events: [
      { year: 1293, name: "Einin Kantō", ja: "永仁関東地震", sure: true, note: "Treated as confirmed from records, beach ridges and tsunami deposits." },
      { year: 1703, name: "Genroku Kantō", ja: "元禄関東地震", m: "8.2", sure: true },
      { year: 1923, name: "Taishō Kantō (Great Kantō)", ja: "大正関東地震", m: "7.9", sure: true },
    ],
  },
  {
    id: "tokai", label: "Nankai Trough: east (Tōkai, Tōnankai)", zone: "Nankai",
    events: [
      { year: 684, name: "Hakuhō (Tenmu)", ja: "白鳳（天武）地震", sure: false, note: `Said to have broken both halves. ${nankaiNote}` },
      { year: 887, name: "Ninna", ja: "仁和地震", sure: false, note: `Said to have broken both halves. ${nankaiNote}` },
      { year: 1096, name: "Eichō Tōkai", ja: "永長東海地震", sure: false, note: `May also have reached the western half. ${nankaiNote}` },
      { year: 1361, name: "Shōhei (Kōan) Tōkai", ja: "正平（康安）東海地震", sure: false, note: "Likely; same day as the Nankai quake or two days before." },
      { year: 1498, name: "Meiō", ja: "明応地震", m: "8.2–8.4", sure: true },
      { year: 1605, name: "Keichō", ja: "慶長地震", m: "7.9", sure: false, note: "Weak shaking but a large tsunami: probably a tsunami earthquake, perhaps not on the usual source area." },
      { year: 1707, name: "Hōei", ja: "宝永地震", m: "8.6", sure: true, note: "Both halves at once: the largest in the historical record." },
      { year: 1854, name: "Ansei Tōkai", ja: "安政東海地震", m: "8.4", sure: true, note: "Followed about 30 hours later by Ansei Nankai." },
      { year: 1944, name: "Shōwa Tōnankai", ja: "昭和東南海地震", m: "7.9", sure: true },
    ],
  },
  {
    id: "nankai", label: "Nankai Trough: west (Nankai)", zone: "Nankai",
    events: [
      { year: 684, name: "Hakuhō (Tenmu)", ja: "白鳳（天武）地震", sure: false, note: `Said to have broken both halves. ${nankaiNote}` },
      { year: 887, name: "Ninna", ja: "仁和地震", sure: false, note: `Said to have broken both halves. ${nankaiNote}` },
      { year: 1099, name: "Kōwa Nankai", ja: "康和南海地震", sure: false, note: nankaiNote },
      { year: 1361, name: "Shōhei (Kōan) Nankai", ja: "正平（康安）南海地震", m: "8¼–8.5", sure: true },
      { year: 1605, name: "Keichō", ja: "慶長地震", m: "7.9", sure: false, note: "Weak shaking but a large tsunami: probably a tsunami earthquake, perhaps not on the usual source area." },
      { year: 1707, name: "Hōei", ja: "宝永地震", m: "8.6", sure: true, note: "Both halves at once: the largest in the historical record." },
      { year: 1854, name: "Ansei Nankai", ja: "安政南海地震", m: "8.4", sure: true },
      { year: 1946, name: "Shōwa Nankai", ja: "昭和南海地震", m: "8.0", sure: true },
    ],
  },
];

export const OUTLOOK: TrenchOutlook[] = [
  { zone: "Kuril", quake: "17th-century type, M8.8+", area: "kuril17", last: "1611–37", interval: "~340–380 yr", p30: "7–40%", rate: PLATE_RATE.Kuril, lastYears: [1611, 1637] },
  { zone: "Kuril", quake: "Off Tokachi, M8.0–8.6", area: "tokachi", last: "2003", interval: "80 yr", p30: "~20%", rate: PLATE_RATE.Kuril, lastYears: [2003, 2003] },
  { zone: "Kuril", quake: "Off Nemuro, M7.8–8.5", area: "nemuro", last: "1973", interval: "65 yr", p30: "~90%", rate: PLATE_RATE.Kuril, lastYears: [1973, 1973] },
  { zone: "Japan Trench", quake: "Tōhoku type, M9", area: "jt9", last: "2011", interval: "~550–600 yr", p30: "~0%", rate: PLATE_RATE["Japan Trench"], lastYears: [2011, 2011] },
  { zone: "Japan Trench", quake: "Tsunami quake near the trench, M8.6–9.0", last: "2011", interval: "4 in ~410 yr", p30: "~30%", rate: PLATE_RATE["Japan Trench"], lastYears: [2011, 2011] },
  { zone: "Sagami", quake: "M8 class (as 1703, 1923)", area: "sagami", last: "1923", interval: "180–590 yr", p30: "~0–6%", rate: PLATE_RATE.Sagami, lastYears: [1923, 1923] },
  { zone: "Sagami", quake: "M7 class anywhere under southern Kantō", last: "–", interval: "–", p30: "~70%" },
  { zone: "Nankai", quake: "M8–9, slip-dependent model", area: "nankai", last: "1944/46", interval: "~97 yr (next)", p30: "60–90%+", rate: PLATE_RATE.Nankai, lastYears: [1944, 1946] },
  { zone: "Nankai", quake: "M8–9, dates only", area: "nankai", last: "1944/46", interval: "117 yr", p30: "20–50%", rate: PLATE_RATE.Nankai, lastYears: [1944, 1946] },
];
