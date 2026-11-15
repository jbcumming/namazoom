// Render the built app in headless Chromium and save screenshots.
//   npm run build && node scripts/screenshots.mjs <out-dir>
import { chromium } from "playwright";
import { preview } from "vite";

const out = process.argv[2] ?? "screenshots";
// Not 4173, so it can run next to `./run.sh serve`.
const port = Number(process.env.SHOT_PORT ?? 4174);
const server = await preview({ preview: { port, host: "127.0.0.1", strictPort: true } });
const url = `http://127.0.0.1:${port}/`;
// MapLibre needs WebGL2; SwiftShader provides it without a GPU. A WAYLAND_DISPLAY
// in the environment makes Chromium pick a Wayland surface that SwiftShader can't
// use, so drop it.
const env = { ...process.env };
delete env.WAYLAND_DISPLAY;
const browser = await chromium.launch({ env, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const errors = [];

const idle = (page) => page.waitForFunction(() => {
  const m = window.quakeMap;
  return m && m.loaded() && m.areTilesLoaded() && document.getElementById("loading").hidden;
}, null, { timeout: 30000 });

async function shot(name, { width = 1440, height = 900, dark = false, act, hash = "" } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: dark ? "dark" : "light" });
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(url + hash);
  await idle(page);
  if (act) { await act(page); if (!name.includes("replay")) await idle(page); }
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) errors.push(`${name}: horizontal overflow ${overflow}px`);
  await page.close();
}

const clickAt = async (page, lon, lat) => {
  const pt = await page.evaluate(([lo, la]) => { const p = window.quakeMap.project([lo, la]); return { x: p.x, y: p.y }; }, [lon, lat]);
  const box = await page.locator("#map").boundingBox();
  await page.mouse.click(box.x + pt.x, box.y + pt.y);
};

await shot("01-map");
await shot("02-quake-tohoku", {
  act: async (p) => { await clickAt(p, 142.861, 38.1035); await p.waitForSelector("#pane-quake .chart-title", { timeout: 20000 }); },
});
await shot("13-aftershocks-kumamoto", {
  act: async (p) => {
    await p.evaluate(() => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("input")); };
      set("range-from", "2016"); set("range-to", "2016");
      window.quakeMap.jumpTo({ center: [130.8, 32.8], zoom: 7 });
    });
    await p.waitForTimeout(800);
    await clickAt(p, 130.763, 32.7545);
    await p.waitForSelector("#pane-quake .aftershocks svg", { timeout: 30000 });
    await p.evaluate(() => { document.getElementById("pane-quake").scrollTop = 99999; });
  },
});
await shot("14-replay-kumamoto", {
  act: async (p) => {
    await p.evaluate(() => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("input")); };
      set("range-from", "2016"); set("range-to", "2016");
      window.quakeMap.jumpTo({ center: [131.5, 33.5], zoom: 5.6 });
    });
    await p.waitForTimeout(800);
    await clickAt(p, 130.763, 32.7545);
    await p.waitForSelector("text=Replay the shaking", { timeout: 30000 });
    await p.click("text=Replay the shaking");
    await p.waitForTimeout(3500);
  },
});
await shot("08-kobe-1995", {
  act: async (p) => {
    await p.evaluate(() => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event("input")); };
      set("range-from", "1995"); set("range-to", "1995");
      window.quakeMap.jumpTo({ center: [135.2, 34.8], zoom: 6.3 });
    });
    await p.waitForTimeout(800);
    await clickAt(p, 135.035, 34.5983);
    await p.waitForSelector("#pane-quake .chart-title", { timeout: 20000 });
  },
});
await shot("03-eras", { act: (p) => p.click("text=Compare eras") });
await shot("04-playing", {
  act: async (p) => {
    await p.evaluate(() => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event(e.tagName === "SELECT" ? "change" : "input")); };
      set("range-from", "2010"); set("range-to", "2012"); set("min-mag", "3"); set("trail", "7776000");
    });
    await p.waitForTimeout(500);
    await p.click("#play");
    await p.waitForTimeout(6500); // a few months into 2011 at the default speed
    await p.click("#play"); // pause: freezes on this frame
  },
});
await shot("07-plates", {
  act: async (p) => {
    await p.evaluate(() => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event(e.tagName === "SELECT" ? "change" : "input")); };
      set("range-from", "2015"); set("range-to", "2024"); set("min-mag", "3");
      window.quakeMap.jumpTo({ center: [139.5, 35.5], zoom: 5.2 });
    });
    await p.waitForTimeout(800);
    // hover the boundary feature nearest the Nankai Trough
    const pt = await p.evaluate(() => {
      const m = window.quakeMap;
      const f = m.querySourceFeatures("plates").find((x) => x.properties.boundary === "AM/PS");
      const line = f.geometry.type === "MultiLineString" ? f.geometry.coordinates[0] : f.geometry.coordinates;
      const c = line.reduce((best, q) => (Math.abs(q[0] - 136) < Math.abs(best[0] - 136) ? q : best));
      const s = m.project(c);
      return { x: s.x, y: s.y };
    });
    const box = await p.locator("#map").boundingBox();
    await p.mouse.move(box.x + pt.x, box.y + pt.y);
  },
});
for (const [n, city] of [["11", "Sendai"], ["12", "Tokyo"]]) {
  await shot(`${n}-location-${city.toLowerCase()}`, {
    act: async (p) => {
      await p.click("#tab-location");
      await p.click(`#pane-location >> text=${city}`);
      await p.waitForSelector("#pane-location svg", { timeout: 30000 });
      await p.waitForTimeout(1500); // flyTo
    },
  });
}
await shot("15-history", {
  act: async (p) => { await p.click("#tab-history"); await p.waitForSelector("#pane-history svg", { timeout: 20000 }); },
});
await shot("16-shared-link", {
  hash: "#y=2016&m=3&tab=quake&q=J2016041601250547_3275_13076&v=32.80,130.80,7.0",
  act: async (p) => { await p.waitForSelector("#pane-quake .chart-title", { timeout: 30000 }); },
});
await shot("17-footprint-dark", {
  dark: true,
  hash: "#y=2016&m=3&tab=quake&q=J2016041601250547_3275_13076&v=32.80,130.80,7.0",
  act: async (p) => { await p.waitForSelector("#pane-quake .chart-title", { timeout: 30000 }); },
});
await shot("18-location-hover", {
  act: async (p) => {
    await p.click("#tab-location");
    await p.click("#pane-location >> text=Sendai");
    await p.waitForSelector("#pane-location svg", { timeout: 30000 });
    await p.waitForTimeout(1500);
    // hover the 2011 Tohoku epicentre circle
    const pt = await p.evaluate(() => { const s = window.quakeMap.project([142.861, 38.1035]); return { x: s.x, y: s.y }; });
    const box = await p.locator("#map").boundingBox();
    await p.mouse.move(box.x + pt.x, box.y + pt.y);
  },
});
for (const [name, hash, level] of [
  ["19-shaking-1997-felt", "#y=1997-2024&tab=shaking", null],
  ["20-shaking-1997-4plus", "#y=1997-2024&tab=shaking", "2"],
  ["21-shaking-1919-1996", "#y=1919-1996&tab=shaking", null],
]) {
  await shot(name, {
    hash,
    act: async (p) => {
      await p.waitForSelector("#pane-shaking .hot-legend", { timeout: 30000 });
      if (level) {
        await p.selectOption("#pane-shaking select", level);
        await p.waitForFunction((l) => document.querySelector("#pane-shaking select")?.value === l, level);
      }
      await p.waitForTimeout(1200);
    },
  });
}
await shot("22-slow-slip", {
  hash: "#y=2004-2017&tab=slow&v=33.80,134.50,6.0",
  act: async (p) => { await p.waitForSelector("#pane-slow svg", { timeout: 30000 }); await p.waitForTimeout(1500); },
});
await shot("23-slow-slip-shikoku-2019", {
  hash: "#y=2019-2020&tab=slow&v=33.50,132.60,7.5",
  act: async (p) => { await p.waitForSelector("#pane-slow svg", { timeout: 30000 }); await p.waitForTimeout(1500); },
});
// Preliminary data after the finalised catalogue: the 2026 Kumamoto M7.1 (shindo 7).
await shot("24-prelim-kumamoto-2026", {
  hash: "#y=2026&m=3&tab=quake&q=J2026072816271520_3262_13068&v=32.60,130.70,7.0",
  act: async (p) => { await p.waitForSelector(".badge-prelim", { timeout: 30000 }); await p.waitForTimeout(1500); },
});
await shot("25-prelim-2025-2026", { hash: "#y=2025-2026&m=4" });
await shot("05-dark", { dark: true });
await shot("06-mobile", { width: 390, height: 844 });

await browser.close();
await server.close();
console.log(errors.length ? errors.join("\n") : "no console errors, no horizontal overflow");
