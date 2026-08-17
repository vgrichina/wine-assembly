// A small RGBA raster canvas for headless runs.
//
// WHY: the CLI used skia-canvas, a native dependency that leaks roughly 320
// bytes per draw call and cannot be made to give it back. It was adopted
// (259623f) because node-canvas had no Path2D and the CLI's clip path was a
// no-op stub, so headless renders silently disagreed with the browser. That
// reason has since evaporated: WAT owns GDI rasterization and hands JavaScript
// finished pixels via gdi_surface_upload, and clipping arrives as rectangle
// bands, never as paths. What is left for the presenter to do is blit and
// clip rectangles -- measured across notepad/calc/mspaint, the screen canvas
// uses exactly six members, and back-canvases see no 2D calls at all.
//
// So this implements that measured surface and nothing more. Every clip in the
// renderer is built from ctx.rect() alone, so clipping here is an intersection
// of rectangles rather than a path engine. If something ever needs real paths
// or text, it belongs in the browser renderer, not here.
//
// The browser keeps using the real canvas; this is CLI/test only.

const { PNG } = require('pngjs');

function clampByte(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

// Accepts the forms the renderer actually produces: #rgb, #rrggbb, #rrggbbaa,
// rgb(r,g,b) and rgba(r,g,b,a). Anything else paints opaque black rather than
// throwing, matching canvas's habit of ignoring nonsense.
function parseColor(style) {
  if (typeof style !== 'string') return [0, 0, 0, 255];
  const s = style.trim();
  if (s[0] === '#') {
    const h = s.slice(1);
    if (h.length === 3) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 255];
    }
    if (h.length === 6 || h.length === 8) {
      return [
        parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
        h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255,
      ];
    }
    return [0, 0, 0, 255];
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(',').map(x => parseFloat(x));
    return [clampByte(p[0]), clampByte(p[1]), clampByte(p[2]),
      p.length > 3 ? clampByte(p[3] * 255) : 255];
  }
  return [0, 0, 0, 255];
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, r - x), h: Math.max(0, btm - y) };
}

class ImageDataPoly {
  constructor(dataOrW, wOrH, h) {
    if (typeof dataOrW === 'number') {
      this.width = dataOrW | 0;
      this.height = wOrH | 0;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      this.data = dataOrW;
      this.width = wOrH | 0;
      this.height = h | 0;
    }
  }
}

class RasterContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.globalAlpha = 1;
    this.imageSmoothingEnabled = false;
    this._clip = { x: 0, y: 0, w: canvas.width, h: canvas.height };
    this._stack = [];
    this._path = [];
  }

  save() {
    this._stack.push({
      fillStyle: this.fillStyle, strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth, globalAlpha: this.globalAlpha,
      imageSmoothingEnabled: this.imageSmoothingEnabled,
      clip: this._clip,
    });
  }

  restore() {
    const s = this._stack.pop();
    if (!s) return;
    this.fillStyle = s.fillStyle;
    this.strokeStyle = s.strokeStyle;
    this.lineWidth = s.lineWidth;
    this.globalAlpha = s.globalAlpha;
    this.imageSmoothingEnabled = s.imageSmoothingEnabled;
    this._clip = s.clip;
  }

  beginPath() { this._path = []; }
  moveTo() {}
  lineTo() {}
  closePath() {}
  rect(x, y, w, h) { this._path.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }); }

  // Rectangles only. The renderer builds every clip from rect() -- a plain
  // client rect, or the band list of a shaped window -- so the clip is the
  // union of the pending rects, intersected with the clip already in force.
  clip() {
    if (!this._path.length) return;
    let union = null;
    for (const r of this._path) {
      if (r.w <= 0 || r.h <= 0) continue;
      union = union ? {
        x: Math.min(union.x, r.x), y: Math.min(union.y, r.y),
        w: Math.max(union.x + union.w, r.x + r.w) - Math.min(union.x, r.x),
        h: Math.max(union.y + union.h, r.y + r.h) - Math.min(union.y, r.y),
      } : { ...r };
    }
    if (union) this._clip = intersect(this._clip, union);
    this._path = [];
  }

  _blend(i, r, g, b, a) {
    const d = this.canvas._data;
    if (a >= 255) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; return; }
    if (a <= 0) return;
    const sa = a / 255;
    const da = d[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; return; }
    d[i] = (r * sa + d[i] * da * (1 - sa)) / outA;
    d[i + 1] = (g * sa + d[i + 1] * da * (1 - sa)) / outA;
    d[i + 2] = (b * sa + d[i + 2] * da * (1 - sa)) / outA;
    d[i + 3] = outA * 255;
  }

  _span(x, y, w, h) {
    return intersect({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, this._clip);
  }

  fillRect(x, y, w, h) {
    const [r, g, b, a0] = parseColor(this.fillStyle);
    const a = clampByte(a0 * this.globalAlpha);
    const rect = this._span(x, y, w, h);
    const cw = this.canvas.width;
    for (let yy = rect.y; yy < rect.y + rect.h; yy++) {
      let i = (yy * cw + rect.x) * 4;
      for (let xx = 0; xx < rect.w; xx++, i += 4) this._blend(i, r, g, b, a);
    }
  }

  clearRect(x, y, w, h) {
    const rect = this._span(x, y, w, h);
    const d = this.canvas._data;
    const cw = this.canvas.width;
    for (let yy = rect.y; yy < rect.y + rect.h; yy++) {
      d.fill(0, (yy * cw + rect.x) * 4, (yy * cw + rect.x + rect.w) * 4);
    }
  }

  // Outline only; the renderer uses this for 1px focus/frame rectangles.
  strokeRect(x, y, w, h) {
    const saved = this.fillStyle;
    this.fillStyle = this.strokeStyle;
    const lw = Math.max(1, this.lineWidth | 0);
    this.fillRect(x, y, w, lw);
    this.fillRect(x, y + h - lw, w, lw);
    this.fillRect(x, y, lw, h);
    this.fillRect(x + w - lw, y, lw, h);
    this.fillStyle = saved;
  }

  createImageData(w, h) { return new ImageDataPoly(w, h); }

  getImageData(x, y, w, h) {
    const out = new ImageDataPoly(w | 0, h | 0);
    const src = this.canvas._data;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    for (let yy = 0; yy < out.height; yy++) {
      const sy = (y | 0) + yy;
      if (sy < 0 || sy >= ch) continue;
      for (let xx = 0; xx < out.width; xx++) {
        const sx = (x | 0) + xx;
        if (sx < 0 || sx >= cw) continue;
        const si = (sy * cw + sx) * 4;
        const di = (yy * out.width + xx) * 4;
        out.data[di] = src[si]; out.data[di + 1] = src[si + 1];
        out.data[di + 2] = src[si + 2]; out.data[di + 3] = src[si + 3];
      }
    }
    return out;
  }

  // Canvas semantics: putImageData ignores both the clip and globalAlpha, and
  // replaces destination pixels outright rather than compositing.
  putImageData(img, dx, dy) {
    const d = this.canvas._data;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    for (let yy = 0; yy < img.height; yy++) {
      const ty = (dy | 0) + yy;
      if (ty < 0 || ty >= ch) continue;
      for (let xx = 0; xx < img.width; xx++) {
        const tx = (dx | 0) + xx;
        if (tx < 0 || tx >= cw) continue;
        const si = (yy * img.width + xx) * 4;
        const di = (ty * cw + tx) * 4;
        d[di] = img.data[si]; d[di + 1] = img.data[si + 1];
        d[di + 2] = img.data[si + 2]; d[di + 3] = img.data[si + 3];
      }
    }
  }

  drawImage(src, ...a) {
    const sw0 = src.width | 0;
    const sh0 = src.height | 0;
    if (!sw0 || !sh0) return;
    let sx = 0, sy = 0, sw = sw0, sh = sh0, dx = 0, dy = 0, dw = sw0, dh = sh0;
    if (a.length === 2) { [dx, dy] = a; }
    else if (a.length === 4) { [dx, dy, dw, dh] = a; }
    else if (a.length === 8) { [sx, sy, sw, sh, dx, dy, dw, dh] = a; }
    else return;

    const sdata = src._data || (src.data instanceof Uint8ClampedArray ? src.data : null);
    if (!sdata) return;

    dx = Math.round(dx); dy = Math.round(dy);
    dw = Math.round(dw); dh = Math.round(dh);
    if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;

    const rect = intersect({ x: dx, y: dy, w: dw, h: dh }, this._clip);
    if (rect.w <= 0 || rect.h <= 0) return;

    const cw = this.canvas.width;
    const alpha = this.globalAlpha;
    // Nearest neighbour. Win98 pixels are not meant to be resampled, and the
    // renderer sets imageSmoothingEnabled=false everywhere for that reason.
    for (let yy = rect.y; yy < rect.y + rect.h; yy++) {
      const v = sy + Math.floor(((yy - dy) * sh) / dh);
      if (v < 0 || v >= sh0) continue;
      for (let xx = rect.x; xx < rect.x + rect.w; xx++) {
        const u = sx + Math.floor(((xx - dx) * sw) / dw);
        if (u < 0 || u >= sw0) continue;
        const si = (v * sw0 + u) * 4;
        const a4 = clampByte(sdata[si + 3] * alpha);
        if (!a4) continue;
        this._blend((yy * cw + xx) * 4, sdata[si], sdata[si + 1], sdata[si + 2], a4);
      }
    }
  }

  // Present only so callers that set them do not crash; nothing headless reads
  // back text metrics -- WAT measures and rasterizes all text itself.
  measureText(text) { return { width: (String(text).length * 8) }; }
  fillText() {}
  strokeText() {}
  setTransform() {}
  translate() {}
  scale() {}
  fill() {}
  stroke() {}
}

class RasterCanvas {
  constructor(w, h) {
    this.width = Math.max(1, w | 0);
    this.height = Math.max(1, h | 0);
    this._data = new Uint8ClampedArray(this.width * this.height * 4);
    this._ctx = null;
  }

  getContext(type) {
    if (type && type !== '2d') return null;
    if (!this._ctx) this._ctx = new RasterContext(this);
    return this._ctx;
  }

  toBufferSync() {
    const png = new PNG({ width: this.width, height: this.height });
    png.data = Buffer.from(this._data.buffer, this._data.byteOffset, this._data.length);
    return PNG.sync.write(png);
  }

  // skia-canvas types toBuffer() as async; callers here have always used it
  // synchronously, so keep it synchronous and let toBufferSync be the honest name.
  toBuffer() { return this.toBufferSync(); }
}

function createCanvas(w, h) { return new RasterCanvas(w, h); }

async function loadImage(src) {
  const fs = require('fs');
  const buf = Buffer.isBuffer(src) ? src : fs.readFileSync(src);
  const png = PNG.sync.read(buf);
  const img = new RasterCanvas(png.width, png.height);
  img._data.set(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length));
  return img;
}

function registerFont() { /* WAT owns fonts; nothing to register headless. */ }

module.exports = {
  createCanvas, loadImage, registerFont,
  Canvas: RasterCanvas, Image: RasterCanvas, ImageData: ImageDataPoly,
};
