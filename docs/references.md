# Checked figures and sources

Figures quoted on the site or in discussion, checked against primary sources on
9 Nov 2026. Japanese originals are quoted where the wording matters.

## Long-term probabilities (HERP, 地震調査研究推進本部)

Calculated for 1 January 2026 ([summary list](https://www.jishin.go.jp/main/choukihyoka/ichiran.pdf),
[changes from 2025](https://www.jishin.go.jp/main/chousa/26jan_kakuritsu/p01_hikaku.pdf)).

| Quake | 30-year chance | Notes |
|---|---|---|
| Nankai Trough M8-9 | 60-90% or more (slip-dependent BPT); 20-50% (BPT, dates only) | Revised 26 Sep 2025 ([points](https://www.jishin.go.jp/main/chousa/25sep_nankai/nankai_gaiyou1_3.pdf), [evaluation](https://www.jishin.go.jp/main/chousa/kaikou_pdf/nankai_3.pdf)); was "about 80%" (2nd edition, 2013). HERP: neither model can be shown to be better; authorities should stress rank III and, when a number is needed, the higher figure ("疑わしいときは行動せよ"). Same values on 1 Jan 2025 and 1 Jan 2026. |
| Southern Kantō M7 class (プレートの沈み込みに伴うM7程度の地震) | about 70% (10 yr: ~30%, 50 yr: ~80%) | Poisson; any of many sources under the Tokyo area. |
| Sagami Trough M8 class | almost 0-6% | Intervals 180-590 yr; last 1923. |
| Japan Trench Tōhoku-type M9 | almost 0% | Interval ~550-600 yr; last 2011. |
| Japan Trench near-trench tsunami quakes (Mt 8.6-9.0) | about 30% | Poisson; 1611, 1677, 1896, 2011. |
| Kuril Trench 17th-century type M8.8+ | 7-40% | Interval ~340-380 yr; last 1611-1637 (tsunami deposits); elapsed ratio 1.02-1.20. Unchanged since the 3rd edition (Dec 2017). |
| Kuril, off Tokachi M8.0-8.6 | about 20% | Interval 80.3 yr; last 2003. |
| Kuril, off Nemuro M7.8-8.5 | about 90% (85%) | Interval 65.1 yr; last 1973. |

Rank III = 26% or more in 30 years (trench quakes).

## Advisories after a large quake

**Nankai Trough Earthquake Extra Information (Megaquake Advisory), first issued 8 Aug 2024**
after the M7.1 Hyūga-nada quake ([JMA press release, 8 Aug 2024 19:45](https://www.jma.go.jp/jma/press/2408/08e/NT_202408081945sv.pdf)):
- 1904-2014, worldwide: after 1,437 Mw7.0+ quakes, an Mw7.8+ quake followed within
  7 days in 6 cases ("数百回に1回程度", roughly 1 in several hundred; ~0.4%).
- For comparison, the 30-year 70-80% figure is about 1 in 1,000 per 7 days, so the
  advisory chance is "数倍" (several times) the usual one.
- Cabinet Office review ([20 Dec 2024](https://www.bousai.go.jp/jishin/nankai/taisaku_wg_02/24/pdf/shiryo1.pdf)):
  6 of 1,437 (~0.4%) for the advisory case; after an M8.0+ quake, an M8-class quake
  in the adjacent area in 7 of 103 cases (~7%, the "megaquake warning" case).

**Hokkaido/Sanriku Subsequent Earthquake Advisory (北海道・三陸沖後発地震注意情報)**
([JMA explainer](https://www.jma.go.jp/jma/kishou/know/jishin/nceq/info_guide.html),
[Cabinet Office guideline, rev. July 2026](https://www.bousai.go.jp/jishin/nihonkaiko_chishima/hokkaido/pdf/guideline_honbun.pdf)):
- 1904-2021, worldwide (ISC-GEM): after 1,529 Mw7.0+ quakes, an Mw7.8+ quake within
  500 km followed within 7 days in 19 cases (~1%, "百回に1回程度"), about ten times
  the usual chance; after Mw8.0+, 9 of 108 (~10%).
- Issued twice so far: 9 Dec 2025 02:00 JST, after the 8 Dec 23:15 quake east off
  Aomori ([Cabinet Office/JMA](https://www.bousai.go.jp/pdf/25120901_siryo.pdf)); and
  20 Apr 2026 19:30 JST, after the M7.7 (Mw7.4) Sanriku-oki quake at 16:52
  ([JMA](https://www.jma.go.jp/jma/press/2604/20b/nceq01.pdf)).

## Historical great trench quakes

Transcribed into `site/src/trench-history.ts` from the HERP long-term evaluations:
[Nankai (2025)](https://www.jishin.go.jp/main/chousa/kaikou_pdf/nankai_3.pdf) table 1
and explanation; [Sagami (2014)](https://www.jishin.go.jp/main/chousa/kaikou_pdf/sagami_2.pdf);
[Japan Trench (2019)](https://www.jishin.go.jp/main/chousa/kaikou_pdf/japan_trench.pdf) 4-2;
[Kuril (2017)](https://www.jishin.go.jp/main/chousa/kaikou_pdf/chishima3.pdf).

## Plate rates for the slip budget

Medians of the PB2002 boundary steps (Bird 2003, `data/raw/plates/PB2002_steps.json`,
total relative velocity) in boxes along each trench: Japan Trench off Miyagi
(Pacific/Okhotsk) 92 mm/yr, Kuril off Tokachi-Nemuro (Okhotsk/Pacific) 90 mm/yr,
Nankai Trough (Amur/Philippine Sea) 50 mm/yr, Sagami Trough (Okhotsk/Philippine
Sea) 35 mm/yr, mostly strike-slip there. Check: 2011's 50 m+ peak slip (HERP)
equals 400-550 years at 92 mm/yr, the time since the 1611 or 1454 quake.

## Site formulas and classes

- Damage classes 1-7 (after Utsu) and tsunami classes (Utsu to 1988, Imamura-Iida
  from 1989): match JMA's hypocentre format document (`data/docs/hypfmt_e.html`).
- Energy, log10 E[J] = 1.5 M + 4.8 (Gutenberg & Richter 1956; 11.8 in erg) and
  rupture length, log10 L[km] = -2.44 + 0.59 M (Wells & Coppersmith 1994, subsurface
  length, all slip types): standard published forms; the papers themselves were not
  re-read online.
- Båth's law, largest aftershock about 1.2 below the mainshock (Båth 1965): standard.

## Not yet checked

- USGS, "about 5% chance a quake is followed by a larger one nearby within a week":
  earthquake.usgs.gov needs network approval. Not used on the site.
