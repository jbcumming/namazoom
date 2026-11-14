// Small shared DOM helpers and theme tokens (values come from style.css).
import * as d3 from "d3";
import { CLASSES } from "./shindo";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export const fmt = d3.format(",");

// Depth classes for colouring quakes. The edges match the Slab2 contours drawn on
// the map (pipeline/build/overlays.py SLAB_DEPTHS), so a contour is a colour boundary.
export const DEPTH_EDGES = [40, 100, 200, 300];
export const DEPTH_LABELS = ["0–40", "40–100", "100–200", "200–300", "300+ km"];
export const depthClass = (d: number) => DEPTH_EDGES.filter((e) => d >= e).length;

export const isDark = () =>
  document.documentElement.dataset.theme === "dark" ||
  (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);

export function theme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    series: [v("--series-1"), v("--series-2"), v("--series-3"), v("--series-4")],
    text: v("--text-primary"), secondary: v("--text-secondary"), muted: v("--text-muted"),
    grid: v("--grid"), axis: v("--axis"), surface: v("--surface-1"), incomplete: v("--incomplete"),
    depth: [1, 2, 3, 4, 5].map((i) => v(`--depth-${i}`)),
    noDepth: v("--text-muted"),
  };
}

const tooltip = () => $<HTMLDivElement>("tooltip");

export function showTooltip(x: number, y: number, build: (el: HTMLElement) => void) {
  const tip = tooltip();
  tip.replaceChildren();
  build(tip);
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = x + 16 + r.width > window.innerWidth ? x - 16 - r.width : x + 16;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, Math.min(y - r.height / 2, window.innerHeight - r.height - 8))}px`;
}

export const hideTooltip = () => { tooltip().hidden = true; };

/** A collapsible "what each shindo level feels like" list, with the colour of each level. */
export function shindoScale(colors: string[], open = false): HTMLElement {
  const d = el("details", "shindo-scale") as HTMLDetailsElement;
  d.open = open;
  d.append(el("summary", "", "What each shindo level feels like"));
  const list = el("dl");
  CLASSES.forEach((c, i) => {
    const dt = el("dt");
    const sw = el("span", "lg-dot"); sw.style.background = colors[i];
    dt.append(sw, document.createTextNode(c.label));
    list.append(dt, el("dd", "", c.feel));
  });
  d.append(list, el("p", "sub",
    "Shindo is the Japan Meteorological Agency's scale of how strongly the ground shook at a place (0–7, with 5 and 6 " +
    "split into lower and upper). Magnitude is the size of the quake itself; one quake gives many shindo readings, " +
    "strongest near the source. Descriptions shortened from JMA's explanation table."));
  return d;
}

/** Make a table row act like a button: click, or Enter/Space when focused with the keyboard. */
export function rowAction(tr: HTMLTableRowElement, label: string, fn: () => void) {
  tr.classList.add("clickable");
  tr.tabIndex = 0;
  tr.title = label;
  tr.setAttribute("aria-label", `${label}: ${tr.textContent ?? ""}`);
  tr.addEventListener("click", fn);
  tr.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
  });
}
