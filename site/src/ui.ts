// Small shared DOM helpers and theme tokens (values come from style.css).
import * as d3 from "d3";

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
