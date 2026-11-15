// 3D view: hypocentres at their depths under the coastline, plate boundaries and the
// sinking-plate depth contours (Slab2). Loaded on demand (three.js is ~600 KB).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";

export interface Quake3D { lon: number; lat: number; depth: number; mag: number; id: string; label: string }
export interface Lines3D { lines: [number, number][][]; depthKm: number }
export interface Scene3DInput {
  quakes: Quake3D[];
  coast: [number, number][][];
  land: [number, number][][][]; // polygons (outer ring, then holes), filled at sea level
  plates: [number, number][][];
  slabs: Lines3D[];
  bounds: { w: number; s: number; e: number; n: number };
  exaggeration: number;
  colors: { background: string; coast: string; land: string; plates: string; slab: string; box: string; text: string; sel: string; depth: string[] };
  depthEdges: number[];
  selected: Quake3D | null; // the quake open in the panel, ringed (mag NaN when unknown)
}

const KM_LAT = 110.57;
const MAX_DEPTH = 700;

/** Equirectangular km around the view centre: x east, y north, z up (depth negative). */
function projector(b: Scene3DInput["bounds"]) {
  const lat0 = (b.s + b.n) / 2, lon0 = (b.w + b.e) / 2;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  return (lon: number, lat: number, z = 0) => new THREE.Vector3((lon - lon0) * kx, (lat - lat0) * KM_LAT, z);
}

const VERT = `
  attribute float size;
  attribute vec3 color;
  varying vec3 vColor;
  uniform float scale;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(2.0, size * scale / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = `
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c);
    if (r > 0.5) discard;
    float edge = smoothstep(0.5, 0.42, r);
    gl_FragColor = vec4(vColor, 0.85 * edge);
    #include <colorspace_fragment>
  }`;
// The open quake's ring: a 2.5 px line in the text colour with a 2 px halo in the background
// colour, so it shows on the dots and on empty space alike. pad: pixels added to the dot's size.
const RING_PAD = 20;
const RING_VERT = `
  attribute float size;
  attribute float pad;
  varying float vSize;
  uniform float scale;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vSize = max(2.0, size * scale / -mv.z) + pad;
    gl_PointSize = vSize;
    gl_Position = projectionMatrix * mv;
  }`;
const RING_FRAG = `
  varying float vSize;
  uniform vec3 ink;
  uniform vec3 halo;
  void main() {
    float d = length(gl_PointCoord - 0.5) * vSize; // pixels from the centre
    float off = abs(d - (vSize * 0.5 - 3.5));
    float a = 1.0 - smoothstep(2.8, 3.5, off);
    if (a < 0.01) discard;
    gl_FragColor = vec4(mix(halo, ink, 1.0 - smoothstep(0.6, 1.3, off)), a);
    #include <colorspace_fragment>
  }`;
const dotSize = (mag: number) => 3 + Math.max(0, (Number.isFinite(mag) ? mag : 3) - 3) * 4;

export class Scene3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 1, 100000);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private points: THREE.Points | null = null;
  private quakes: Quake3D[] = [];
  private labels: { el: HTMLElement; pos: THREE.Vector3 }[] = [];
  private labelHost: HTMLElement;
  private ray = new THREE.Raycaster();
  private frame = 0;
  private span = 1000;
  private corners: THREE.Vector3[] = []; // the box's 8 corners, for framing
  private fatLines: LineMaterial[] = []; // need the canvas size to draw their width in pixels
  private P = projector({ w: 0, s: 0, e: 1, n: 1 });
  private ex = 1;
  private inBox: (lon: number, lat: number) => boolean = () => false;
  private dotColors: (depth: number) => THREE.Color = () => new THREE.Color();
  private colors: Scene3DInput["colors"] | null = null;
  private hl = new THREE.Group(); // the open quake's ring, dot and line, drawn over everything
  private hlLabel: { el: HTMLElement; pos: THREE.Vector3; size: number } | null = null;
  private fly: { t0: number; p0: THREE.Vector3; p1: THREE.Vector3; c0: THREE.Vector3; c1: THREE.Vector3 } | null = null;
  private ro: ResizeObserver;
  onHover: (q: Quake3D | null, x: number, y: number) => void = () => {};
  onPick: (q: Quake3D) => void = () => {};

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.append(this.renderer.domElement);
    this.labelHost = document.createElement("div");
    this.labelHost.className = "v3d-labels";
    host.append(this.labelHost);
    this.renderer.localClippingEnabled = true; // the land fill is cut to the box
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener("change", () => this.request());
    this.controls.addEventListener("start", () => { this.fly = null; }); // a drag takes over from focus()
    this.scene.add(this.group);
    this.hl.renderOrder = 10;
    this.scene.add(this.hl);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);

    const el = this.renderer.domElement;
    let down: [number, number] | null = null;
    el.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener("pointermove", (e) => {
      if (e.buttons) { this.onHover(null, 0, 0); return; }
      const q = this.pick(e);
      this.onHover(q, e.clientX, e.clientY);
      el.style.cursor = q ? "pointer" : "grab";
    });
    el.addEventListener("pointerleave", () => this.onHover(null, 0, 0));
    el.addEventListener("pointerup", (e) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4) {
        const q = this.pick(e);
        if (q) this.onPick(q);
      }
      down = null;
    });
    this.resize();
  }

  set(inp: Scene3DInput, resetCamera: boolean) {
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      (o as THREE.Mesh).geometry?.dispose();
      ((o as THREE.Mesh).material as THREE.Material)?.dispose();
    }
    this.labelHost.replaceChildren();
    this.labels = [];
    this.scene.background = new THREE.Color(inp.colors.background);
    const P = projector(inp.bounds);
    const ex = inp.exaggeration;
    const b = inp.bounds;
    const inBox = (lon: number, lat: number, m = 0) => lon >= b.w - m && lon <= b.e + m && lat >= b.s - m && lat <= b.n + m;

    // Lines: coast and plate boundaries at sea level, slab contours at depth.
    const addLines = (lines: [number, number][][], z: number, color: string, opacity: number) => {
      const pts: THREE.Vector3[] = [];
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          const [a, c] = [line[i - 1], line[i]];
          if (!inBox(a[0], a[1], 0.2) && !inBox(c[0], c[1], 0.2)) continue;
          pts.push(P(a[0], a[1], z), P(c[0], c[1], z));
        }
      }
      if (!pts.length) return;
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      this.group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity })));
    };
    // Land: a faint fill at sea level, cut to the box, drawn first so quakes beneath show through;
    // the coast on top as a 1.6 px line (plain WebGL lines are always 1 px).
    const sw0 = P(b.w, b.s), ne0 = P(b.e, b.n);
    const clip = [new THREE.Plane(new THREE.Vector3(1, 0, 0), -sw0.x), new THREE.Plane(new THREE.Vector3(-1, 0, 0), ne0.x),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -sw0.y), new THREE.Plane(new THREE.Vector3(0, -1, 0), ne0.y)];
    const shapes: THREE.Shape[] = [];
    for (const poly of inp.land) {
      if (!poly[0]?.some(([lon, lat]) => inBox(lon, lat, 3))) continue;
      const ring = (r: [number, number][]) => r.map(([lon, lat]) => { const v = P(lon, lat); return new THREE.Vector2(v.x, v.y); });
      const shape = new THREE.Shape(ring(poly[0]));
      for (const hole of poly.slice(1)) shape.holes.push(new THREE.Path(ring(hole)));
      shapes.push(shape);
    }
    if (shapes.length) {
      const fill = new THREE.Mesh(new THREE.ShapeGeometry(shapes), new THREE.MeshBasicMaterial({
        color: inp.colors.land, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: clip }));
      fill.renderOrder = -1;
      this.group.add(fill);
    }
    this.fatLines = [];
    const coastPts: number[] = [];
    for (const line of inp.coast) {
      for (let i = 1; i < line.length; i++) {
        const [a, c] = [line[i - 1], line[i]];
        if (!inBox(a[0], a[1], 0.2) && !inBox(c[0], c[1], 0.2)) continue;
        const u = P(a[0], a[1]), v = P(c[0], c[1]);
        coastPts.push(u.x, u.y, u.z, v.x, v.y, v.z);
      }
    }
    if (coastPts.length) {
      const mat = new LineMaterial({ color: inp.colors.coast, linewidth: 1.6 }); // segments already cut to the box above
      mat.resolution.set(this.host.clientWidth || 1, this.host.clientHeight || 1);
      this.fatLines.push(mat);
      this.group.add(new LineSegments2(new LineSegmentsGeometry().setPositions(coastPts), mat));
    }
    addLines(inp.plates, 0, inp.colors.plates, 0.9);
    for (const s of inp.slabs) addLines(s.lines, -s.depthKm * ex, inp.colors.slab, 0.45);

    // Box: the view area at the surface and at the deepest quake, joined at the corners.
    const deepest = Math.min(MAX_DEPTH, Math.max(100, inp.selected?.depth ?? 0, ...inp.quakes.map((q) => q.depth)));
    const zb = -Math.ceil(deepest / 100) * 100 * ex;
    const corners: [number, number][] = [[b.w, b.s], [b.e, b.s], [b.e, b.n], [b.w, b.n]];
    this.corners = corners.flatMap(([lon, lat]) => [P(lon, lat, 0), P(lon, lat, zb)]);
    const boxPts: THREE.Vector3[] = [];
    corners.forEach((c, i) => {
      const d = corners[(i + 1) % 4];
      boxPts.push(P(c[0], c[1], 0), P(d[0], d[1], 0), P(c[0], c[1], zb), P(d[0], d[1], zb), P(c[0], c[1], 0), P(c[0], c[1], zb));
    });
    this.group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(boxPts),
      new THREE.LineBasicMaterial({ color: inp.colors.box, transparent: true, opacity: 0.6 })));
    // Depth ticks on one vertical edge.
    for (let d = 0; d <= -zb / ex + 1e-6; d += 100) {
      const el = document.createElement("span");
      el.textContent = `${d} km`;
      el.style.color = inp.colors.text;
      this.labelHost.append(el);
      this.labels.push({ el, pos: P(b.w, b.s, -d * ex) });
    }

    // Quakes: colour by depth class, size by magnitude.
    this.P = P;
    this.ex = ex;
    this.inBox = (lon, lat) => inBox(lon, lat);
    this.colors = inp.colors;
    const palette = inp.colors.depth.map((c) => new THREE.Color(c));
    this.dotColors = (depth) => palette[inp.depthEdges.filter((e) => depth >= e).length];
    this.quakes = inp.quakes.filter((q) => inBox(q.lon, q.lat));
    this.points = this.dots(this.quakes);
    this.group.add(this.points);

    const sw = P(b.w, b.s), ne = P(b.e, b.n);
    this.span = Math.max(ne.x - sw.x, ne.y - sw.y, -zb);
    this.ray.params.Points = { threshold: this.span / 250 };
    this.highlight(inp.selected);
    if (resetCamera) this.resetCamera(zb);
    this.updateScale();
    this.request();
  }

  /** Points for quakes, coloured by depth class and sized by magnitude. */
  private dots(quakes: Quake3D[]) {
    const n = quakes.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    quakes.forEach((q, i) => {
      const v = this.P(q.lon, q.lat, -q.depth * this.ex);
      pos.set([v.x, v.y, v.z], i * 3);
      const c = this.dotColors(q.depth);
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = dotSize(q.mag);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("size", new THREE.BufferAttribute(size, 1));
    return new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true,
      depthWrite: false, uniforms: { scale: { value: 1 } } }));
  }

  /** The open quake: its dot, a ring round it, a dashed line up to its epicentre and its magnitude and depth.
   *  Drawn over everything, so it shows through the land and the other quakes. */
  private highlight(q: Quake3D | null) {
    for (const o of [...this.hl.children]) {
      this.hl.remove(o);
      (o as THREE.Mesh).geometry.dispose();
      ((o as THREE.Mesh).material as THREE.Material).dispose();
    }
    this.fatLines = this.fatLines.filter((m) => !m.userData.hl);
    this.hlLabel?.el.remove();
    this.hlLabel = null;
    const c = this.colors;
    if (!q || !c || !this.inBox(q.lon, q.lat)) return;
    const top = this.P(q.lon, q.lat, 0), at = this.P(q.lon, q.lat, -q.depth * this.ex);
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    if (top.z - at.z > 1) {
      const mat = new LineMaterial({ color: c.sel, linewidth: 2, dashed: true, dashSize: this.span / 70, gapSize: this.span / 140,
        transparent: true, depthTest: false });
      mat.resolution.set(w, h);
      mat.userData.hl = true;
      this.fatLines.push(mat);
      const line = new LineSegments2(new LineSegmentsGeometry().setPositions([top.x, top.y, top.z, at.x, at.y, at.z]), mat);
      line.computeLineDistances();
      this.hl.add(line);
    }
    const dot = this.dots([q]);
    (dot.material as THREE.Material).depthTest = false;
    // A ring round the hypocentre, and a small one where the line meets the surface.
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([at.x, at.y, at.z, top.x, top.y, top.z]), 3));
    g.setAttribute("size", new THREE.BufferAttribute(new Float32Array([dotSize(q.mag), 0]), 1));
    g.setAttribute("pad", new THREE.BufferAttribute(new Float32Array([RING_PAD, 12]), 1));
    const ring = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: RING_VERT, fragmentShader: RING_FRAG,
      transparent: true, depthTest: false, depthWrite: false,
      uniforms: { scale: { value: 1 }, ink: { value: new THREE.Color(c.sel) }, halo: { value: new THREE.Color(c.background) } } }));
    for (const o of [dot, ring]) this.hl.add(o);
    this.hl.children.forEach((o, i) => { o.renderOrder = 10 + i; }); // the dot covers the line's end, the ring both
    const el = document.createElement("span");
    el.className = "v3d-sel";
    el.textContent = `${Number.isFinite(q.mag) ? `M${q.mag.toFixed(1)}, ` : ""}${Math.round(q.depth)} km deep`;
    this.labelHost.append(el);
    this.hlLabel = { el, pos: at, size: dotSize(q.mag) };
    this.updateScale();
  }

  /** Fly the camera in towards a quake, keeping the direction it looks from. */
  focus(q: Quake3D) {
    const at = this.P(q.lon, q.lat, -q.depth * this.ex);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const p1 = dir.multiplyScalar(this.span * 0.5).add(at);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.controls.target.copy(at);
      this.camera.position.copy(p1);
    } else {
      this.fly = { t0: performance.now(), p0: this.camera.position.clone(), p1, c0: this.controls.target.clone(), c1: at };
    }
    this.request();
  }

  resetCamera(zb?: number) {
    this.fly = null;
    const s = this.span;
    const mid = (zb ?? -300) / 2;
    this.controls.target.set(0, 0, mid);
    // From the south-east, above sea level, looking north-west and down: the Pacific slab dips away from the viewer.
    // Step back until the whole box is in view, then centre it in the space above the legend; twice,
    // since centring changes what fits. Works for any screen shape.
    const dir = new THREE.Vector3(0.9, -1.1, 1.2).normalize(); // about 40° above the horizon
    const [X, YB, YT] = [0.94, -0.72, 0.9]; // allowed area in screen units (-1..1); the legend sits bottom left
    this.camera.near = s / 1000;
    this.camera.updateProjectionMatrix();
    const target = this.controls.target;
    const place = (dist: number) => {
      this.camera.position.copy(dir).multiplyScalar(dist).add(target);
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld();
    };
    const extent = () => {
      const ps = this.corners.map((c) => c.clone().project(this.camera));
      return { x0: Math.min(...ps.map((q) => q.x)), x1: Math.max(...ps.map((q) => q.x)),
        y0: Math.min(...ps.map((q) => q.y)), y1: Math.max(...ps.map((q) => q.y)) };
    };
    let d = s * 0.5;
    for (let pass = 0; pass < 2; pass++) {
      d = s * 0.5;
      for (let i = 0; i < 80; i++) {
        place(d);
        const e = extent();
        if (e.x0 >= -X && e.x1 <= X && e.y0 >= YB && e.y1 <= YT) break;
        d *= 1.05;
      }
      const e = extent();
      const halfH = d * Math.tan((this.camera.fov * Math.PI) / 360), halfW = halfH * this.camera.aspect;
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      const shift = right.multiplyScalar(((e.x0 + e.x1) / 2) * halfW)
        .add(up.multiplyScalar(((e.y0 + e.y1) / 2 - (YB + YT) / 2) * halfH));
      target.add(shift);
      place(d);
    }
    this.camera.far = d * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.request();
  }

  set autoRotate(on: boolean) {
    this.controls.autoRotate = on;
    this.controls.autoRotateSpeed = 0.6;
    this.request();
  }

  private pick(e: PointerEvent): Quake3D | null {
    if (!this.points) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.intersectObject(this.points)[0];
    return hit?.index !== undefined ? this.quakes[hit.index] : null;
  }

  private pointScale() { return (this.renderer.domElement.clientHeight || 600) * 1.1; }

  private updateScale() {
    for (const o of [this.points, ...this.hl.children]) {
      const u = ((o as THREE.Points | null)?.material as THREE.ShaderMaterial | undefined)?.uniforms;
      if (u?.scale) u.scale.value = this.pointScale();
    }
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const m of this.fatLines) m.resolution.set(w, h);
    this.updateScale();
    this.request();
  }

  /** Render on demand; keeps going while damping or auto-rotate moves the camera. */
  request() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const f = this.fly;
      if (f) {
        const k = Math.min(1, (performance.now() - f.t0) / 800);
        const e = k < 0.5 ? 2 * k * k : 1 - (2 - 2 * k) ** 2 / 2; // ease in and out
        this.camera.position.lerpVectors(f.p0, f.p1, e);
        this.controls.target.lerpVectors(f.c0, f.c1, e);
        if (k >= 1) this.fly = null;
      }
      const moving = this.controls.update();
      this.renderer.render(this.scene, this.camera);
      const w = this.host.clientWidth, h = this.host.clientHeight;
      for (const l of this.labels) {
        const v = l.pos.clone().project(this.camera);
        l.el.style.transform = `translate(${((v.x + 1) / 2) * w + 6}px, ${((1 - v.y) / 2) * h - 7}px)`;
        l.el.hidden = v.z > 1;
      }
      const s = this.hlLabel;
      if (s) {
        // Beside the ring: half its width (as the shader sizes it) to the right.
        const v = s.pos.clone().project(this.camera);
        const dist = -s.pos.clone().applyMatrix4(this.camera.matrixWorldInverse).z;
        const r = (Math.max(2, (s.size * this.pointScale()) / dist) + RING_PAD) / 2;
        s.el.style.transform = `translate(${((v.x + 1) / 2) * w + r + 2}px, ${((1 - v.y) / 2) * h - 10}px)`;
        s.el.hidden = v.z > 1;
      }
      if (moving || f || this.controls.autoRotate) this.request();
    });
  }

  dispose() {
    this.ro.disconnect();
    cancelAnimationFrame(this.frame);
    this.controls.dispose();
    this.renderer.dispose();
    this.host.replaceChildren();
  }
}
