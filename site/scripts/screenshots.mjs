// Render the built site in headless Chromium and save screenshots.
//   npm run build && node scripts/screenshots.mjs <out-dir>
import { chromium } from "playwright";
import { preview } from "vite";

const out = process.argv[2] ?? "screenshots";
const server = await preview({ preview: { port: 4173, host: "127.0.0.1" } });
const url = "http://127.0.0.1:4173/";
const browser = await chromium.launch();
const errors = [];

async function shot(name, { width = 1280, height = 1100, dark = false, act } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: dark ? "dark" : "light" });
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector("#chart svg");
  if (act) await act(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) errors.push(`${name}: horizontal overflow ${overflow}px`);
  await page.close();
}

await shot("01-single");
await shot("02-eras", { act: (p) => p.click("text=Compare eras") });
await shot("03-region-hover", {
  act: async (p) => {
    const cells = p.locator("#map .cell");
    const n = await cells.count();
    // pick the busiest-looking inland square: 34-36N 136-138E if present
    for (let i = 0; i < n; i++) {
      const label = await cells.nth(i).getAttribute("aria-label");
      if (label?.startsWith("34–36°N, 136–138°E")) { await cells.nth(i).click(); break; }
    }
    const box = await p.locator("#chart svg").boundingBox();
    await p.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  },
});
await shot("04-dark-eras", { dark: true, act: (p) => p.click("text=Compare eras") });
await shot("05-mobile", { width: 390, height: 900 });

await browser.close();
await server.close();
console.log(errors.length ? errors.join("\n") : "no console errors, no horizontal overflow");
