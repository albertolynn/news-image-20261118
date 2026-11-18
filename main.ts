// news-image-20261118 — "The World in One Day"
// Draws a newspaper front page summing up the world news of
// Wednesday 18 November 2026, entirely in code: own PNG encoder,
// own rasteriser, own vector stroke font. No assets, no network.
// Deterministic: two runs write byte-identical entry.png.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- PNG writer
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    rgb.copy(raw, row + 1, y * width * 3, (y + 1) * width * 3);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------- raster surface
const SS = 2; // supersampling factor

class Surface {
  constructor(w, h) {
    this.w = w * SS;
    this.h = h * SS;
    this.data = new Uint8ClampedArray(this.w * this.h * 3);
  }
  set(x, y, col) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.data[i] = col[0];
    this.data[i + 1] = col[1];
    this.data[i + 2] = col[2];
  }
  fill(col) {
    for (let i = 0; i < this.data.length; i += 3) {
      this.data[i] = col[0];
      this.data[i + 1] = col[1];
      this.data[i + 2] = col[2];
    }
  }
  rect(x, y, w, h, col) {
    const x0 = Math.round(x * SS), y0 = Math.round(y * SS);
    const x1 = Math.round((x + w) * SS), y1 = Math.round((y + h) * SS);
    for (let yy = y0; yy < y1; yy++)
      for (let xx = x0; xx < x1; xx++) this.set(xx, yy, col);
  }
  // thick line segment with round caps, coordinates in final-res units
  line(x1, y1, x2, y2, width, col) {
    const ax = x1 * SS, ay = y1 * SS, bx = x2 * SS, by = y2 * SS;
    const r = (width * SS) / 2;
    const minx = Math.floor(Math.min(ax, bx) - r - 1), maxx = Math.ceil(Math.max(ax, bx) + r + 1);
    const miny = Math.floor(Math.min(ay, by) - r - 1), maxy = Math.ceil(Math.max(ay, by) + r + 1);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    for (let yy = miny; yy <= maxy; yy++) {
      for (let xx = minx; xx <= maxx; xx++) {
        let t = ((xx - ax) * dx + (yy - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + t * dx, py = ay + t * dy;
        const ddx = xx - px, ddy = yy - py;
        if (ddx * ddx + ddy * ddy <= r * r) this.set(xx, yy, col);
      }
    }
  }
  polyline(pts, width, col) {
    for (let i = 0; i + 1 < pts.length; i++)
      this.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], width, col);
    if (pts.length === 1) this.line(pts[0][0], pts[0][1], pts[0][0], pts[0][1], width, col);
  }
  // filled polygon, points in final-res units
  poly(pts, col) {
    const P = pts.map((p) => [p[0] * SS, p[1] * SS]);
    let miny = Infinity, maxy = -Infinity;
    for (const p of P) { miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }
    const y0 = Math.max(0, Math.floor(miny)), y1 = Math.min(this.h - 1, Math.ceil(maxy));
    for (let yy = y0; yy <= y1; yy++) {
      const xs = [];
      for (let i = 0; i < P.length; i++) {
        const a = P[i], b = P[(i + 1) % P.length];
        if ((a[1] <= yy && b[1] > yy) || (b[1] <= yy && a[1] > yy)) {
          xs.push(a[0] + ((yy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(0, Math.round(xs[i])), xb = Math.min(this.w - 1, Math.round(xs[i + 1]));
        for (let xx = xa; xx <= xb; xx++) this.set(xx, yy, col);
      }
    }
  }
  circle(cx, cy, r, col) { this.ellipse(cx, cy, r, r, col); }
  ellipse(cx, cy, rx, ry, col) {
    const CX = cx * SS, CY = cy * SS, RX = rx * SS, RY = ry * SS;
    const x0 = Math.floor(CX - RX), x1 = Math.ceil(CX + RX);
    const y0 = Math.floor(CY - RY), y1 = Math.ceil(CY + RY);
    for (let yy = y0; yy <= y1; yy++)
      for (let xx = x0; xx <= x1; xx++) {
        const nx = (xx - CX) / RX, ny = (yy - CY) / RY;
        if (nx * nx + ny * ny <= 1) this.set(xx, yy, col);
      }
  }
  downsampled() {
    const W = this.w / SS, H = this.h / SS;
    const out = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < SS; dy++)
          for (let dx = 0; dx < SS; dx++) {
            const i = ((y * SS + dy) * this.w + (x * SS + dx)) * 3;
            r += this.data[i]; g += this.data[i + 1]; b += this.data[i + 2];
          }
        const o = (y * W + x) * 3, n = SS * SS;
        out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
      }
    }
    return { width: W, height: H, rgb: out };
  }
}

// ------------------------------------------------------------- stroke font
// Glyphs live on a 12 x 16 grid (y down, 0 = cap top, 16 = baseline).
// s: strokes (polylines). d: filled dots [x, y, r]. w: advance width.
const G = {
  A: { w: 12, s: [[[0, 16], [6, 0], [12, 16]], [[2.3, 10.5], [9.7, 10.5]]] },
  B: { w: 12, s: [[[0, 0], [0, 16]], [[0, 0], [6.8, 0], [9.6, 2.2], [9.6, 5.4], [6.8, 7.8], [0, 7.8]], [[6.8, 7.8], [9.9, 10.2], [9.9, 13.6], [6.8, 16], [0, 16]]] },
  C: { w: 12, s: [[[11.2, 3.6], [8.6, 1], [4.6, 1], [1.6, 3.6], [1.6, 12.4], [4.6, 15], [8.6, 15], [11.2, 12.4]]] },
  D: { w: 12, s: [[[0, 0], [0, 16]], [[0, 0], [6.4, 0], [10, 4.2], [10, 11.8], [6.4, 16], [0, 16]]] },
  E: { w: 11, s: [[[11, 0], [0, 0], [0, 16], [11, 16]], [[0, 8], [8.2, 8]]] },
  F: { w: 11, s: [[[11, 0], [0, 0], [0, 16]], [[0, 8], [8, 8]]] },
  G: { w: 12, s: [[[11.2, 3.6], [8.6, 1], [4.6, 1], [1.6, 3.6], [1.6, 12.4], [4.6, 15], [8.6, 15], [11.4, 12.2], [11.4, 9], [6.8, 9]]] },
  H: { w: 12, s: [[[0, 0], [0, 16]], [[12, 0], [12, 16]], [[0, 8], [12, 8]]] },
  I: { w: 6, s: [[[3, 0], [3, 16]], [[0.4, 0], [5.6, 0]], [[0.4, 16], [5.6, 16]]] },
  J: { w: 11, s: [[[11, 0], [11, 11.6], [8.8, 15], [4.6, 15.4], [1.6, 12.6]], [[7.6, 0], [11, 0]]] },
  K: { w: 12, s: [[[0, 0], [0, 16]], [[11.2, 0], [1.8, 8.6]], [[3.4, 6.8], [11.4, 16]]] },
  L: { w: 11, s: [[[0, 0], [0, 16], [11, 16]]] },
  M: { w: 13, s: [[[0, 16], [0, 0], [6.5, 9.5], [13, 0], [13, 16]]] },
  N: { w: 12, s: [[[0, 16], [0, 0], [12, 16], [12, 0]]] },
  O: { w: 12, s: [[[6, 0], [9.8, 1.6], [11.6, 5], [11.6, 11], [9.8, 14.4], [6, 16], [2.2, 14.4], [0.4, 11], [0.4, 5], [2.2, 1.6], [6, 0]]] },
  P: { w: 12, s: [[[0, 16], [0, 0]], [[0, 0], [7.4, 0], [10.4, 2.6], [10.4, 6], [7.4, 8.6], [0, 8.6]]] },
  Q: { w: 12, s: [[[6, 0], [9.8, 1.6], [11.6, 5], [11.6, 11], [9.8, 14.4], [6, 16], [2.2, 14.4], [0.4, 11], [0.4, 5], [2.2, 1.6], [6, 0]], [[7.8, 11], [12.2, 16.4]]] },
  R: { w: 12, s: [[[0, 16], [0, 0]], [[0, 0], [7.4, 0], [10.4, 2.6], [10.4, 6], [7.4, 8.6], [0, 8.6]], [[6.2, 8.6], [11.4, 16]]] },
  S: { w: 11, s: [[[10.8, 3.2], [8.2, 1], [4.4, 1], [1.8, 3.2], [2.4, 6.2], [5.2, 8.2], [9.2, 10.2], [10.6, 13], [8.4, 15.2], [4.2, 15.4], [1, 13.2]]] },
  T: { w: 12, s: [[[0, 0], [12, 0]], [[6, 0], [6, 16]]] },
  U: { w: 12, s: [[[0, 0], [0, 11.4], [2.4, 14.8], [6, 16], [9.6, 14.8], [12, 11.4], [12, 0]]] },
  V: { w: 12, s: [[[0, 0], [6, 16], [12, 0]]] },
  W: { w: 14, s: [[[0, 0], [3, 16], [7, 6], [11, 16], [14, 0]]] },
  X: { w: 12, s: [[[0, 0], [12, 16]], [[12, 0], [0, 16]]] },
  Y: { w: 12, s: [[[0, 0], [6, 7.6]], [[12, 0], [6, 7.6]], [[6, 7.6], [6, 16]]] },
  Z: { w: 12, s: [[[0, 0], [12, 0], [0, 16], [12, 16]]] },
  "0": { w: 11, s: [[[5.5, 0], [8.8, 1.6], [10.4, 5], [10.4, 11], [8.8, 14.4], [5.5, 16], [2.2, 14.4], [0.6, 11], [0.6, 5], [2.2, 1.6], [5.5, 0]]] },
  "1": { w: 10, s: [[[3.2, 3.6], [7.4, 0], [7.4, 16]], [[2.8, 16], [11, 16]]] },
  "2": { w: 11, s: [[[1.4, 3.6], [4, 1], [7.8, 1], [10.4, 3.6], [10.4, 6.8], [0.8, 16], [11.2, 16]]] },
  "3": { w: 11, s: [[[1.4, 2.6], [4.4, 0.8], [7.8, 1], [10, 3.6], [8, 6.6], [4.4, 7.6]], [[4.4, 7.6], [8.2, 7.9], [10.4, 10.6], [8.8, 14.6], [4.8, 15.8], [1.4, 13.4]]] },
  "4": { w: 12, s: [[[7.6, 16], [7.6, 0], [0.4, 11.2], [11.8, 11.2]]] },
  "5": { w: 11, s: [[[10.8, 0], [2, 0], [1.6, 7], [5.2, 6.2], [9, 7.6], [10.6, 10.6], [9.2, 14.6], [4.8, 16], [1.4, 13.4]]] },
  "6": { w: 11, s: [[[10.4, 2.6], [6.4, 0.8], [3, 3], [1.4, 8], [1.4, 12.4], [4.4, 15.4], [8.4, 15], [10.4, 11.6], [8.6, 8.2], [4.6, 7.8], [1.8, 10]]] },
  "7": { w: 11, s: [[[0.8, 0], [11.4, 0], [4.8, 16]]] },
  "8": { w: 11, s: [[[4.2, 8], [2, 5.4], [3.4, 1.6], [7.6, 1.6], [9.4, 5.4], [7.2, 8], [9.8, 11], [8.6, 14.8], [3, 14.8], [1.4, 11], [4.2, 8]]] },
  "9": { w: 11, s: [[[1.4, 13.4], [5.4, 15.2], [9, 13], [10.4, 8], [10.4, 3.6], [7.4, 0.6], [3.4, 1], [1.4, 4.6], [3, 7.6], [7.4, 8.2], [10.2, 5.6]]] },
  ".": { w: 5, d: [[2.5, 14.8, 1.05]] },
  ",": { w: 5, d: [[2.7, 14.2, 1.0]], s: [[[3.9, 15], [2.6, 18.2]]] },
  "'": { w: 5, s: [[[3.6, 0], [2.2, 4.4]]] },
  ":": { w: 5, d: [[2.5, 4.6, 1.05], [2.5, 12.6, 1.05]] },
  ";": { w: 5, d: [[2.5, 4.6, 1.05], [2.7, 12, 1.0]], s: [[[3.9, 12.8], [2.6, 16]]] },
  "-": { w: 10, s: [[[1, 8], [9, 8]]] },
  "·": { w: 5, d: [[2.5, 8, 1.05]] },
  "$": { w: 12, s: [[[10.8, 3.2], [8.2, 1], [4.4, 1], [1.8, 3.2], [2.4, 6.2], [5.2, 8.2], [9.2, 10.2], [10.6, 13], [8.4, 15.2], [4.2, 15.4], [1, 13.2]], [[6, -0.6], [6, 16.6]]] },
  "%": { w: 13, s: [[[10.8, 0.8], [2.2, 15.2]]], d: [[3.6, 3.8, 2.1], [9.6, 12.2, 2.1]] },
  "+": { w: 11, s: [[[5.5, 3], [5.5, 13]], [[0.5, 8], [10.5, 8]]] },
  "/": { w: 10, s: [[[1, 16], [9.6, 0]]] },
  "(": { w: 7, s: [[[8, 1], [5, 4.4], [3.8, 8], [5, 11.6], [8, 15]]] },
  ")": { w: 7, s: [[[-1, 1], [2, 4.4], [3.2, 8], [2, 11.6], [-1, 15]]] },
  "!": { w: 5, s: [[[2.5, 0], [2.5, 10.4]]], d: [[2.5, 14.8, 1.05]] },
  "?": { w: 11, s: [[[1.2, 3.4], [4, 1], [7.6, 1.2], [9.8, 4], [8.4, 7.4], [5.6, 9.4], [5.6, 12]]], d: [[5.6, 15, 1.05]] },
  " ": { w: 6 },
};

// text engine — size is the glyph-box height in final-res px.
function textWidth(text, size, ls = 0) {
  const k = size / 16;
  let w = 0;
  for (const ch of text) {
    const g = G[ch] || G[" "];
    w += g.w * k + ls;
  }
  return w - (text.length ? ls : 0);
}

function drawText(surf, text, x, y, size, col, weight = 1.35, ls = 0, align = "left") {
  const k = size / 16;
  const total = textWidth(text, size, ls);
  let cx = align === "center" ? x - total / 2 : align === "right" ? x - total : x;
  const lw = Math.max(0.7, weight * k);
  for (const ch of text) {
    const g = G[ch] || G[" "];
    if (g.s) {
      for (const stroke of g.s) {
        const pts = stroke.map((p) => [cx + p[0] * k, y + p[1] * k]);
        surf.polyline(pts, lw, col);
      }
    }
    if (g.d) {
      for (const d of g.d) surf.circle(cx + d[0] * k, y + d[1] * k, Math.max(d[2] * k, lw * 0.62), col);
    }
    cx += g.w * k + ls;
  }
  return total;
}

// greedy word wrap; returns lines that fit maxWidth
function wrap(text, size, maxWidth, ls = 0) {
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const word of words) {
    const trial = cur ? cur + " " + word : word;
    if (textWidth(trial, size, ls) <= maxWidth || !cur) cur = trial;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ------------------------------------------------------------------ the page
const PAPER = [246, 241, 229];
const INK = [25, 21, 16];
const RED = [176, 35, 24];
const BLUE = [29, 78, 121];
const GOLD = [154, 116, 20];
const GRAY = [92, 84, 72];
const WHITE = [250, 248, 242];

function rule(s, x, y, w, h, col = INK) { s.rect(x, y, w, h, col); }

function drawScene(s) {
  const x0 = 36, y0 = 480, w = 952, h = 148, y1 = y0 + h;
  // sky and sea
  s.rect(x0, y0, w, 52, [168, 200, 221]);
  s.rect(x0, y0 + 52, w, 28, [203, 224, 232]);
  s.rect(x0, y0 + 80, w, h - 80, [47, 109, 140]);
  s.line(x0, y0 + 80, x0 + w, y0 + 80, 1.6, [230, 238, 240]);
  // sun
  s.circle(x0 + 872, y0 + 26, 15, [242, 211, 138]);
  s.circle(x0 + 872, y0 + 26, 19, [246, 226, 170]);
  s.circle(x0 + 872, y0 + 26, 15, [242, 211, 138]);
  // island landmass on the waterline
  const isl = [[250, 560], [330, 540], [470, 533], [620, 541], [706, 560], [706, 576], [250, 576]];
  s.poly(isl, [216, 189, 133]);
  s.poly([[250, 560], [330, 540], [470, 533], [620, 541], [706, 560], [660, 552], [480, 545], [340, 551], [280, 561]], [122, 154, 82]);
  drawText(s, "QESHM ISLAND", x0 + 478, 560, 12.5, INK, 1.5, 1, "center");
  // missile site: boxes and a launcher
  s.rect(428, 524, 15, 9, [60, 58, 52]);
  s.rect(452, 521, 15, 12, [60, 58, 52]);
  s.rect(476, 525, 13, 8, [60, 58, 52]);
  s.line(505, 533, 524, 516, 4.5, [40, 38, 34]);
  s.rect(498, 529, 14, 6, [40, 38, 34]);
  // explosion at the site
  const ex = 522, ey = 512;
  s.poly([[ex, ey - 20], [ex + 5, ey - 7], [ex + 18, ey - 12], [ex + 9, ey - 2], [ex + 20, ey + 3], [ex + 8, ey + 6], [ex + 12, ey + 17], [ex, ey + 9], [ex - 12, ey + 17], [ex - 8, ey + 6], [ex - 20, ey + 3], [ex - 9, ey - 2], [ex - 18, ey - 12], [ex - 5, ey - 7]], [232, 106, 23]);
  s.circle(ex, ey, 7.5, [245, 185, 33]);
  s.circle(ex, ey, 3.6, [176, 35, 24]);
  // smoke
  s.circle(512, 492, 8, [141, 133, 120]);
  s.circle(528, 484, 6, [160, 152, 140]);
  s.circle(498, 486, 5.5, [160, 152, 140]);
  // jets with contrails
  const jet = (jx, jy) => {
    s.poly([[jx, jy], [jx + 30, jy - 4.5], [jx + 44, jy], [jx + 30, jy + 4.5]], [60, 70, 80]);
    s.poly([[jx + 10, jy], [jx + 22, jy - 11], [jx + 28, jy]], [60, 70, 80]);
    s.poly([[jx + 10, jy], [jx + 22, jy + 11], [jx + 28, jy]], [60, 70, 80]);
    s.line(jx - 66, jy - 2, jx - 2, jy - 0.5, 2.2, [233, 238, 240]);
    s.line(jx - 66, jy + 3, jx - 2, jy + 1.5, 2.2, [233, 238, 240]);
  };
  jet(120, 508);
  jet(196, 494);
  // dashed red trajectory from the island toward the Gulf states
  let px = 640, py = 548;
  for (let i = 1; i <= 14; i++) {
    const t = i / 14;
    const cxp = 640 + (905 - 640) * t;
    const cyp = 548 - Math.sin(t * Math.PI) * 34 + (566 - 548) * t;
    if (i % 2 === 0) s.line(px, py, cxp, cyp, 2.4, RED);
    px = cxp; py = cyp;
  }
  // drones on the arc
  const drone = (dx, dy) => {
    s.rect(dx - 6, dy - 2, 12, 4, [35, 33, 30]);
    s.line(dx - 9, dy - 5, dx - 3, dy - 1, 1.6, [35, 33, 30]);
    s.line(dx + 9, dy - 5, dx + 3, dy - 1, 1.6, [35, 33, 30]);
    s.line(dx - 9, dy + 5, dx - 3, dy + 1, 1.6, [35, 33, 30]);
    s.line(dx + 9, dy + 5, dx + 3, dy + 1, 1.6, [35, 33, 30]);
  };
  drone(742, 512);
  drone(800, 502);
  drone(856, 516);
  // right-hand shore: the Gulf states
  s.poly([[884, 628], [900, 592], [952, 584], [988, 590], [988, 628]], [216, 189, 133]);
  drawText(s, "BAHRAIN · KUWAIT", x0 + w - 8, 566, 12, WHITE, 1.5, 0.6, "right");
  drawText(s, "STRAIT OF HORMUZ", x0 + 16, 600, 12, [214, 230, 238], 1.4, 1.6, "left");
  // waves
  for (const [wx, wy] of [[120, 596], [210, 610], [330, 600], [560, 606], [660, 596], [120, 618], [760, 610]]) {
    s.line(wx, wy, wx + 26, wy, 1.8, [120, 175, 200]);
  }
  // frame
  s.line(x0, y0, x0 + w, y0, 2.4, INK);
  s.line(x0, y1, x0 + w, y1, 2.4, INK);
  s.line(x0, y0, x0, y1, 2.4, INK);
  s.line(x0 + w, y0, x0 + w, y1, 2.4, INK);
}

function panel(s, x, y, w, accent, kicker, headLines, body) {
  rule(s, x, y, w, 3.5, accent);
  drawText(s, kicker, x + 1, y + 9, 12.5, accent, 1.5, 0.8);
  headLines.forEach((ln, i) => drawText(s, ln, x + 1, y + 28 + i * 27, 21.5, INK, 1.65, 0.2));
  const lines = wrap(body, 15, w - 4, 0.1);
  lines.forEach((ln, i) => drawText(s, ln, x + 1, y + 85 + i * 19, 15, [46, 41, 34], 1.25, 0.1));
}

function drawPage() {
  const s = new Surface(1024, 1024);
  s.fill(PAPER);
  const CX = 512;
  // masthead
  rule(s, 36, 26, 952, 3);
  rule(s, 36, 33, 952, 1);
  drawText(s, "THE WORLD IN ONE DAY", CX, 42, 36, INK, 1.8, 5, "center");
  rule(s, 36, 90, 952, 4);
  rule(s, 36, 98, 952, 1);
  drawText(s, "WEDNESDAY", CX, 106, 100, INK, 2.1, 3, "center");
  rule(s, 56, 243, 140, 3, RED);
  rule(s, 828, 243, 140, 3, RED);
  drawText(s, "18 NOVEMBER 2026", CX, 216, 54, INK, 1.9, 2, "center");
  drawText(s, "FROM WIRE REPORTS · EVERY STORY DATED TODAY", CX, 280, 13, GRAY, 1.3, 1.2, "center");
  rule(s, 36, 294, 952, 2);
  // lead story
  drawText(s, "CONFLICT · QESHM ISLAND, IRAN", 36, 304, 14, RED, 1.6, 0.8);
  drawText(s, "THE LEAD STORY", 988, 304, 14, INK, 1.5, 0.8, "right");
  drawText(s, "US JETS STRIKE IRAN MISSILE SITE", 36, 322, 38, INK, 1.95, 0.4);
  drawText(s, "ON QESHM ISLAND IN THE GULF", 36, 374, 38, INK, 1.95, 0.4);
  drawText(s, "IRAN ANSWERS WITH DRONES ON BAHRAIN AND KUWAIT", 36, 424, 21.5, RED, 1.6, 0.4);
  drawScene(s);
  const cap = wrap("US FIGHTERS HIT A REVOLUTIONARY GUARD LAUNCH SITE ON QESHM. IRAN ANSWERED WITH DRONES ON A US RADAR SITE IN BAHRAIN AND KUWAIT'S ALI AL-SALEM BASE.", 16, 952, 0.1);
  cap.forEach((ln, i) => drawText(s, ln, 36, 640 + i * 20, 16, [46, 41, 34], 1.3, 0.1));
  rule(s, 36, 690, 952, 2);
  // panels
  panel(s, 36, 698, 464, BLUE, "UKRAINE WAR · KERCH STRAIT",
    ["CRIMEA BRIDGE ARCH CRASHES", "INTO THE KERCH STRAIT"],
    "UKRAINE HIT THE BRIDGE A SECOND DAY; ZELENSKY CALLED IT UNPRECEDENTED.");
  panel(s, 524, 698, 464, RED, "DIPLOMACY · APEC SUMMIT",
    ["XI AND PUTIN MEET IN SHENZHEN", "AS APEC SUMMIT OPENS"],
    "XI URGED FREE TRADE AND AI PARTNERSHIP. THURSDAY: A FIRST SUMMIT WITH TRUMP.");
  panel(s, 36, 824, 464, GOLD, "HEALTH · UNITED STATES",
    ["US LOSES MEASLES-FREE STATUS", "AFTER 26 YEARS"],
    "PAHO ENDED THE STATUS AS 2026 CASES PASSED 5,400 WITH 10 DEATHS REPORTED.");
  panel(s, 524, 824, 464, INK, "BUSINESS · CHIP GIANT",
    ["NVIDIA POSTS A RECORD", "$115.8BN QUARTER"],
    "REVENUE DOUBLED IN A YEAR. BOARD RULES OUT BRINGING BACK FOUNDER JENSEN HUANG.");
  // ticker
  s.rect(36, 952, 952, 64, INK);
  drawText(s, "ALSO TODAY · EBOLA IN DR CONGO PASSES 11,000 CASES AND 5,400 DEATHS, UN SAYS", CX, 959, 14.5, WHITE, 1.35, 0.3, "center");
  drawText(s, "PELTOLA WINS ALASKA · DEMOCRATS REACH 56 SENATE SEATS · S+P 500 DOWN 1.03%", CX, 978, 14.5, WHITE, 1.35, 0.3, "center");
  drawText(s, "RUSSIAN AN-12 CRASH KILLS ALL 19 IN SIBERIA · CYCLONE XAVIER HITS COOK ISLANDS", CX, 997, 14.5, WHITE, 1.35, 0.3, "center");
  return s;
}

function main() {
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "out";
  mkdirSync(outDir, { recursive: true });
  const img = drawPage().downsampled();
  const png = encodePNG(img.width, img.height, img.rgb);
  const file = join(outDir, "entry.png");
  writeFileSync(file, png);
  console.log(`wrote ${file}: ${img.width}x${img.height}, ${png.length} bytes`);
}

main();
