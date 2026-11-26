import * as THREE from 'three';
import Delaunator from 'delaunator';
import { ovalLoop } from './tracker';

const N = 468; // face-mesh points (the 10 iris points after them are ignored)
const INNER_LIPS = [78,191,80,81,82,13,312,311,310,415,308,324,318,402,317,14,87,178,88,95];
const TONE_POINTS = [205, 425, 151]; // cheeks + forehead, used to match skin brightness

const inPoly = (p, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const distSeg = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};
const smooth01 = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/**
 * Draws the webcam video, then warps the uploaded picture's face onto the live face mesh.
 * The canvas is sized to the video, so canvas.captureStream() gives a ready-made call feed.
 */
export class FaceSwapStage {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1); // 0..1 = whole frame

    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, depthTest: false }));
    this.bg.position.set(0.5, 0.5, 0);
    this.scene.add(this.bg);

    this.mesh = null;
    this.sm = new Float32Array(N * 2); // smoothed landmark positions
    this.hasPrev = false;
    this.frame = 0;
    this.tone = [1, 1, 1];
    this.sampler = document.createElement('canvas');
    this.sampler.width = 160;
    this.sampler.height = 120;
    this.sctx = this.sampler.getContext('2d', { willReadFrequently: true });
  }

  /** photo: a canvas with the picture; lm: its face landmarks from the IMAGE tracker. */
  setPhoto(photo, lm) {
    const w = photo.width, h = photo.height;
    const pts = lm.slice(0, N).map((p) => [p.x * w, p.y * h]);

    const flat = new Float64Array(N * 2);
    pts.forEach(([x, y], i) => { flat[2 * i] = x; flat[2 * i + 1] = y; });
    const tris = new Delaunator(flat).triangles;

    const oval = ovalLoop().map((i) => pts[i]);
    const mouth = INNER_LIPS.map((i) => pts[i]);
    const index = [];
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      const ctr = [(pts[a][0] + pts[b][0] + pts[c][0]) / 3, (pts[a][1] + pts[b][1] + pts[c][1]) / 3];
      // keep triangles inside the face outline, but leave the mouth open so your real mouth shows
      if (inPoly(ctr, oval) && !inPoly(ctr, mouth)) index.push(a, b, c);
    }

    // soft edge: opacity fades to 0 at the face outline
    const fade = Math.hypot(pts[234][0] - pts[454][0], pts[234][1] - pts[454][1]) * 0.1;
    const colors = new Float32Array(N * 4);
    const uvs = new Float32Array(N * 2);
    pts.forEach((p, i) => {
      let alpha = 0;
      if (inPoly(p, oval)) {
        let d = Infinity;
        for (let k = 0; k < oval.length; k++) d = Math.min(d, distSeg(p, oval[k], oval[(k + 1) % oval.length]));
        alpha = smooth01(d / fade);
      }
      colors.set([1, 1, 1, alpha], i * 4);
      uvs[2 * i] = lm[i].x;
      uvs[2 * i + 1] = 1 - lm[i].y;
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    geo.setIndex(index);

    const map = new THREE.CanvasTexture(photo);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map, vertexColors: true, transparent: true, depthTest: false, side: THREE.DoubleSide });

    this._disposeMesh();
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.scene.add(this.mesh);
    this.hasPrev = false;

    // average skin colour of the picture, for tone matching
    const g = photo.getContext('2d');
    const avg = [0, 0, 0];
    for (const i of TONE_POINTS) {
      const x = Math.max(0, Math.min(w - 5, Math.round(pts[i][0]) - 2));
      const y = Math.max(0, Math.min(h - 5, Math.round(pts[i][1]) - 2));
      const d = g.getImageData(x, y, 5, 5).data;
      for (let k = 0; k < d.length; k += 4) { avg[0] += d[k]; avg[1] += d[k + 1]; avg[2] += d[k + 2]; }
    }
    const n = TONE_POINTS.length * 25 * 255;
    this.photoColor = avg.map((v) => Math.max(0.05, v / n));
    this.tone = [1, 1, 1];
  }

  _disposeMesh() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.map?.dispose();
    this.mesh.material.dispose();
    this.mesh = null;
  }

  fit() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return false;
    if (this.canvas.width !== vw || this.canvas.height !== vh) this.renderer.setSize(vw, vh, false);
    return true;
  }

  _matchTone(lm) {
    if (!this.photoColor || this.frame % 5) return;
    this.sctx.drawImage(this.video, 0, 0, 160, 120);
    const sum = [0, 0, 0];
    for (const i of TONE_POINTS) {
      const x = Math.max(0, Math.min(155, Math.round(lm[i].x * 159) - 2));
      const y = Math.max(0, Math.min(115, Math.round(lm[i].y * 119) - 2));
      const d = this.sctx.getImageData(x, y, 5, 5).data;
      for (let k = 0; k < d.length; k += 4) { sum[0] += d[k]; sum[1] += d[k + 1]; sum[2] += d[k + 2]; }
    }
    const n = TONE_POINTS.length * 25 * 255;
    for (let c = 0; c < 3; c++) {
      const ratio = Math.min(1.6, Math.max(0.55, sum[c] / n / this.photoColor[c]));
      this.tone[c] += (ratio - this.tone[c]) * 0.2;
    }
    this.mesh.material.color.setRGB(...this.tone.map((t) => t ** 2.2)); // linear-space multiplier
  }

  /** lm: live face landmarks (or null when no face is visible). */
  render(lm) {
    if (!this.fit()) return;
    this.frame++;
    const m = this.mesh;
    if (m) {
      if (lm) {
        const pos = m.geometry.attributes.position.array;
        const k = this.hasPrev ? 0.7 : 1; // light smoothing against jitter
        for (let i = 0; i < N; i++) {
          this.sm[2 * i] += (lm[i].x - this.sm[2 * i]) * k;
          this.sm[2 * i + 1] += (1 - lm[i].y - this.sm[2 * i + 1]) * k;
          pos[3 * i] = this.sm[2 * i];
          pos[3 * i + 1] = this.sm[2 * i + 1];
        }
        m.geometry.attributes.position.needsUpdate = true;
        m.visible = true;
        this.hasPrev = true;
        this._matchTone(lm);
      } else {
        m.visible = false;
        this.hasPrev = false;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this._disposeMesh();
    this.bg.material.map.dispose();
    this.bg.material.dispose();
    this.bg.geometry.dispose();
    this.renderer.dispose();
  }
}
