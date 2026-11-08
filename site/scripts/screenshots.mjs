// Render the built app in headless Chromium and save screenshots.
//   npm run build && node scripts/screenshots.mjs <out-dir>
import { chromium } from "playwright";
import { preview } from "vite";

const out = process.argv[2] ?? "screenshots";
const server = await preview({ preview: { port: 4173, host: "127.0.0.1" } });
const url = "http://127.0.0.1:4173/";
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

async function shot(name, { width = 1440, height = 900, dark = false, act } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: dark ? "dark" : "light" });
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(url);
  await idle(page);
  if (act) { await act(page); await idle(page); }
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
await shot("05-dark", { dark: true });
await shot("06-mobile", { width: 390, height: 844 });

await browser.close();
await server.close();
console.log(errors.length ? errors.join("\n") : "no console errors, no horizontal overflow");
