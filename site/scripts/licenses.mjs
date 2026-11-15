// Writes public/THIRD_PARTY_LICENSES.txt: the licence of every package bundled into the site
// (the runtime dependencies and theirs), taken from each package's own licence file.
// The minified bundles drop these notices, and BSD/MIT/ISC ask that they travel with copies.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seen = new Map();
function visit(name, from) {
  // Resolve like Node: the nearest node_modules up from the requiring package.
  let dir = from;
  let pkgDir = null;
  for (;;) {
    const cand = join(dir, "node_modules", name);
    if (existsSync(join(cand, "package.json"))) { pkgDir = cand; break; }
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
  if (seen.has(pkgDir)) return;
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const file = readdirSync(pkgDir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  seen.set(pkgDir, { name: pkg.name, version: pkg.version, license: pkg.license ?? "see package",
    repo: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "",
    text: file ? readFileSync(join(pkgDir, file), "utf8").trim() : "" });
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, pkgDir);
}
const top = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const dep of Object.keys(top.dependencies ?? {})) visit(dep, root);

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const out = ["Namazoom uses these open-source packages. Their licences follow.", ""];
for (const e of entries) {
  out.push("=".repeat(72), `${e.name} ${e.version} (${e.license})${e.repo ? `\n${e.repo.replace(/^git\+/, "")}` : ""}`, "");
  out.push(e.text || `This package ships no licence file; it is published under ${e.license}. See its repository above.`, "");
}
writeFileSync(join(root, "public", "THIRD_PARTY_LICENSES.txt"), out.join("\n"));
console.log(`THIRD_PARTY_LICENSES.txt: ${entries.length} packages`);
