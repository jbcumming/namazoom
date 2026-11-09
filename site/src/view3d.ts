// 3D view: hypocentres at their depths under the coastline, plate boundaries and the
// sinking-plate depth contours (Slab2). Loaded on demand (three.js is ~600 KB).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export interface Quake3D { lon: number; lat: number; depth: number; mag: number; id: string; label: string }
export interface Lines3D { lines: [number, number][][]; depthKm: number }
export interface Scene3DInput {
  quakes: Quake3D[];
  coast: [number, number][][];
  plates: [number, number][][];
  slabs: Lines3D[];
  bounds: { w: number; s: number; e: number; n: number };
  exaggeration: number;
  colors: { background: string; coast: string; plates: string; slab: string; box: string; text: string; depth: string[] };
  depthEdges: number[];
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
  }`;

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
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener("change", () => this.request());
    this.scene.add(this.group);
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
    addLines(inp.coast, 0, inp.colors.coast, 1);
    addLines(inp.plates, 0, inp.colors.plates, 0.9);
    for (const s of inp.slabs) addLines(s.lines, -s.depthKm * ex, inp.colors.slab, 0.45);

    // Box: the view area at the surface and at the deepest quake, joined at the corners.
    const deepest = Math.min(MAX_DEPTH, Math.max(100, ...inp.quakes.map((q) => q.depth)));
    const zb = -Math.ceil(deepest / 100) * 100 * ex;
    const corners: [number, number][] = [[b.w, b.s], [b.e, b.s], [b.e, b.n], [b.w, b.n]];
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
    this.quakes = inp.quakes.filter((q) => inBox(q.lon, q.lat));
    const n = this.quakes.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    const palette = inp.colors.depth.map((c) => new THREE.Color(c));
    this.quakes.forEach((q, i) => {
      const v = P(q.lon, q.lat, -q.depth * ex);
      pos.set([v.x, v.y, v.z], i * 3);
      const c = palette[inp.depthEdges.filter((e) => q.depth >= e).length];
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = 3 + Math.max(0, q.mag - 3) * 4;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("size", new THREE.BufferAttribute(size, 1));
    const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      uniforms: { scale: { value: 1 } } });
    this.points = new THREE.Points(g, mat);
    this.group.add(this.points);

    const sw = P(b.w, b.s), ne = P(b.e, b.n);
    this.span = Math.max(ne.x - sw.x, ne.y - sw.y, -zb);
    this.ray.params.Points = { threshold: this.span / 250 };
    if (resetCamera) this.resetCamera(zb);
    this.updateScale();
    this.request();
  }

  resetCamera(zb?: number) {
    const s = this.span;
    const mid = (zb ?? -300) / 2;
    this.controls.target.set(0, 0, mid);
    // From the south-east, above sea level, looking north-west and down: the Pacific slab dips away from the viewer.
    // Tall (phone) screens need to stand further back to fit the width.
    const k = Math.max(1, 1.3 / Math.max(this.camera.aspect, 0.3));
    this.camera.position.set(s * 0.9 * k, -s * 1.1 * k, s * 0.55 * k);
    this.camera.near = s / 1000; this.camera.far = s * 20 * k;
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

  private updateScale() {
    if (!this.points) return;
    const h = this.renderer.domElement.clientHeight || 600;
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = h * 1.1;
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.updateScale();
    this.request();
  }

  /** Render on demand; keeps going while damping or auto-rotate moves the camera. */
  request() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const moving = this.controls.update();
      this.renderer.render(this.scene, this.camera);
      const w = this.host.clientWidth, h = this.host.clientHeight;
      for (const l of this.labels) {
        const v = l.pos.clone().project(this.camera);
        l.el.style.transform = `translate(${((v.x + 1) / 2) * w + 6}px, ${((1 - v.y) / 2) * h - 7}px)`;
        l.el.hidden = v.z > 1;
      }
      if (moving || this.controls.autoRotate) this.request();
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
