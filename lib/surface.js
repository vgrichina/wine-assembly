// Drawing surfaces, described in pixels rather than in canvas.
//
// The renderer used to speak CanvasRenderingContext2D directly -- getContext,
// save/restore, beginPath/rect/clip, drawImage, globalCompositeOperation. That
// tied every headless run to a canvas implementation, which is how the project
// ended up depending on a native library that leaked memory per draw call, for
// a feature set it had outgrown: WAT owns GDI rasterization and hands over
// finished pixels, and clipping arrives as rectangle bands, never as paths.
//
// So the contract here is the one the renderer actually needs, and nothing
// more. Measured across the renderer's call sites, that is: fill and clear
// rectangles, blit (1:1 or scaled, nearest-neighbour), stroke a rectangle,
// invert a rectangle for the drag marquee, tile the wallpaper, move pixels in
// and out, and clip to rectangles.
//
//   RasterSurface  -- headless. Owns a Uint8ClampedArray. No dependencies
//                     beyond pngjs for encode.
//   CanvasSurface  -- the browser. A thin adapter onto a real 2D context, so
//                     the browser keeps hardware compositing and native text.
//
// Clipping is a stack of rectangles because every clip the renderer builds is
// a rectangle or a band list of them, including shaped windows. Nothing here
// needs a path engine; if something ever does, it belongs in the browser
// implementation, behind this same contract.
//
// Colors are CSS strings ('#c0c0c0', 'rgb(0,128,128)'). That is a color
// format, not a canvas concept, and it keeps the renderer's palette readable.

const RGBA_STRIDE = 4;

function clampByte(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

// Accepts the forms the renderer produces: #rgb, #rrggbb, #rrggbbaa,
// rgb(r,g,b) and rgba(r,g,b,a). Anything unrecognised is opaque black rather
// than an exception, matching how canvas ignores nonsense.
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

function intersectRect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, r - x), h: Math.max(0, btm - y) };
}

// The union's bounding box. Band lists from WAT describe a shape as adjacent
// rectangles, and the renderer only ever uses them to bound a blit, so a
// bounding box is the right precision here and keeps clipping a rect test.
function boundingBox(rects) {
  let out = null;
  for (const r of rects) {
    if (!r || r.w <= 0 || r.h <= 0) continue;
    if (!out) { out = { x: r.x, y: r.y, w: r.w, h: r.h }; continue; }
    const x = Math.min(out.x, r.x);
    const y = Math.min(out.y, r.y);
    out = {
      x, y,
      w: Math.max(out.x + out.w, r.x + r.w) - x,
      h: Math.max(out.y + out.h, r.y + r.h) - y,
    };
  }
  return out;
}

class Pixels {
  constructor(width, height, data) {
    this.width = width | 0;
    this.height = height | 0;
    this.data = data || new Uint8ClampedArray(this.width * this.height * RGBA_STRIDE);
  }
}

class RasterSurface {
  constructor(width, height) {
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.data = new Uint8ClampedArray(this.width * this.height * RGBA_STRIDE);
    this._clip = { x: 0, y: 0, w: this.width, h: this.height };
    this._clipStack = [];
  }

  get isRaster() { return true; }

  pushClip(rects) {
    this._clipStack.push(this._clip);
    const box = Array.isArray(rects) ? boundingBox(rects) : rects;
    if (box) this._clip = intersectRect(this._clip, box);
  }

  popClip() {
    if (this._clipStack.length) this._clip = this._clipStack.pop();
  }

  _bounded(x, y, w, h) {
    return intersectRect(
      { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) },
      this._clip);
  }

  _blend(i, r, g, b, a) {
    const d = this.data;
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

  fill(x, y, w, h, color, alpha = 1) {
    const [r, g, b, a0] = parseColor(color);
    const a = clampByte(a0 * alpha);
    const rect = this._bounded(x, y, w, h);
    for (let yy = rect.y; yy < rect.y + rect.h; yy++) {
      let i = (yy * this.width + rect.x) * RGBA_STRIDE;
      for (let xx = 0; xx < rect.w; xx++, i += RGBA_STRIDE) this._blend(i, r, g, b, a);
    }
  }

  clear(x, y, w, h) {
    const rect = this._bounded(x, y, w, h);
    for (let yy = rect.y; yy < rect.y + rect.h; yy++) {
      const start = (yy * this.width + rect.x) * RGBA_STRIDE;
      this.data.fill(0, start, start + rect.w * RGBA_STRIDE);
    }
  }

  // Outline of a rectangle. `dash` draws every other run of `dash` pixels,
  // which is what the focus rectangle and the rubber-band selection want.
  frame(x, y, w, h, color, lineWidth = 1, dash = 0) {
    const lw = Math.max(1, lineWidth | 0);
    if (!dash) {
      this.fill(x, y, w, lw, color);
      this.fill(x, y + h - lw, w, lw, color);
      this.fill(x, y, lw, h, color);
      this.fill(x + w - lw, y, lw, h, color);
      return;
    }
    for (let i = 0; i < w; i += dash * 2) {
      this.fill(x + i, y, Math.min(dash, w - i), lw, color);
      this.fill(x + i, y + h - lw, Math.min(dash, w - i), lw, color);
    }
    for (let i = 0; i < h; i += dash * 2) {
      this.fill(x, y + i, lw, Math.min(dash, h - i), color);
      this.fill(x + w - lw, y + i, lw, Math.min(dash, h - i), color);
    }
  }

  // The drag marquee: visible over any background without knowing it.
  invert(x, y, w, h) {
    const rect = this._bounded(x, y, w, h);
    const d = this.data;
    for (let yy = rect.y; yy < rect.y + rect.h; yy++) {
      let i = (yy * this.width + rect.x) * RGBA_STRIDE;
      for (let xx = 0; xx < rect.w; xx++, i += RGBA_STRIDE) {
        d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
        if (!d[i + 3]) d[i + 3] = 255;
      }
    }
  }

  // Nearest-neighbour throughout: Win98 pixels are not meant to be resampled.
  blit(src, sx, sy, sw, sh, dx, dy, dw, dh, alpha = 1) {
    const sdata = src.data;
    const sw0 = src.width | 0;
    const sh0 = src.height | 0;
    if (!sdata || !sw0 || !sh0 || sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
    dx = Math.round(dx); dy = Math.round(dy);
    dw = Math.round(dw); dh = Math.round(dh);
    const rect = intersectRect({ x: dx, y: dy, w: dw, h: dh }, this._clip);
    if (rect.w <= 0 || rect.h <= 0) return;
    for (let yy = rect.y; yy < rect.y + rect.h; yy++) {
      const v = sy + Math.floor(((yy - dy) * sh) / dh);
      if (v < 0 || v >= sh0) continue;
      for (let xx = rect.x; xx < rect.x + rect.w; xx++) {
        const u = sx + Math.floor(((xx - dx) * sw) / dw);
        if (u < 0 || u >= sw0) continue;
        const si = (v * sw0 + u) * RGBA_STRIDE;
        const a = clampByte(sdata[si + 3] * alpha);
        if (!a) continue;
        this._blend((yy * this.width + xx) * RGBA_STRIDE, sdata[si], sdata[si + 1], sdata[si + 2], a);
      }
    }
  }

  // Repeat a source across a region, for tiled wallpaper.
  tile(src, x, y, w, h) {
    if (!src.width || !src.height) return;
    for (let oy = 0; oy < h; oy += src.height) {
      for (let ox = 0; ox < w; ox += src.width) {
        this.blit(src, 0, 0, src.width, src.height,
          x + ox, y + oy, src.width, src.height);
      }
    }
  }

  readPixels(x, y, w, h) {
    const out = new Pixels(w | 0, h | 0);
    for (let yy = 0; yy < out.height; yy++) {
      const sy = (y | 0) + yy;
      if (sy < 0 || sy >= this.height) continue;
      for (let xx = 0; xx < out.width; xx++) {
        const sx = (x | 0) + xx;
        if (sx < 0 || sx >= this.width) continue;
        const si = (sy * this.width + sx) * RGBA_STRIDE;
        const di = (yy * out.width + xx) * RGBA_STRIDE;
        out.data[di] = this.data[si]; out.data[di + 1] = this.data[si + 1];
        out.data[di + 2] = this.data[si + 2]; out.data[di + 3] = this.data[si + 3];
      }
    }
    return out;
  }

  // Replaces destination pixels outright and ignores the clip, matching the
  // semantics WAT's surface upload relies on.
  writePixels(pixels, dx, dy) {
    for (let yy = 0; yy < pixels.height; yy++) {
      const ty = (dy | 0) + yy;
      if (ty < 0 || ty >= this.height) continue;
      for (let xx = 0; xx < pixels.width; xx++) {
        const tx = (dx | 0) + xx;
        if (tx < 0 || tx >= this.width) continue;
        const si = (yy * pixels.width + xx) * RGBA_STRIDE;
        const di = (ty * this.width + tx) * RGBA_STRIDE;
        this.data[di] = pixels.data[si]; this.data[di + 1] = pixels.data[si + 1];
        this.data[di + 2] = pixels.data[si + 2]; this.data[di + 3] = pixels.data[si + 3];
      }
    }
  }

  createPixels(w, h) { return new Pixels(w, h); }

  toPNG() {
    const { PNG } = require('pngjs');
    const png = new PNG({ width: this.width, height: this.height });
    png.data = Buffer.from(this.data.buffer, this.data.byteOffset, this.data.length);
    return PNG.sync.write(png);
  }
}

// The browser keeps a real canvas: hardware compositing, and a DOM element the
// page can present. This adapter exists so renderer.js never has to know that.
class CanvasSurface {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
  }

  get isRaster() { return false; }
  get width() { return this.canvas.width; }
  get height() { return this.canvas.height; }

  pushClip(rects) {
    const list = Array.isArray(rects) ? rects : [rects];
    this.ctx.save();
    this.ctx.beginPath();
    for (const r of list) {
      if (r && r.w > 0 && r.h > 0) this.ctx.rect(r.x, r.y, r.w, r.h);
    }
    this.ctx.clip();
  }

  popClip() { this.ctx.restore(); }

  fill(x, y, w, h, color, alpha = 1) {
    const c = this.ctx;
    const prev = c.globalAlpha;
    if (alpha !== 1) c.globalAlpha = alpha;
    c.fillStyle = color;
    c.fillRect(x, y, w, h);
    c.globalAlpha = prev;
  }

  clear(x, y, w, h) { this.ctx.clearRect(x, y, w, h); }

  frame(x, y, w, h, color, lineWidth = 1, dash = 0) {
    const c = this.ctx;
    c.save();
    c.strokeStyle = color;
    c.lineWidth = Math.max(1, lineWidth | 0);
    if (dash && c.setLineDash) c.setLineDash([dash, dash]);
    // Half-pixel offset so a 1px stroke lands on the pixel, not across two.
    const o = c.lineWidth / 2;
    c.strokeRect(x + o, y + o, Math.max(0, w - c.lineWidth), Math.max(0, h - c.lineWidth));
    c.restore();
  }

  invert(x, y, w, h) {
    const c = this.ctx;
    const prev = c.globalCompositeOperation;
    c.globalCompositeOperation = 'difference';
    c.fillStyle = '#ffffff';
    c.fillRect(x, y, w, h);
    c.globalCompositeOperation = prev;
  }

  blit(src, sx, sy, sw, sh, dx, dy, dw, dh, alpha = 1) {
    const c = this.ctx;
    const img = src.canvas || src;
    const prev = c.globalAlpha;
    if (alpha !== 1) c.globalAlpha = alpha;
    c.imageSmoothingEnabled = false;
    c.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    c.globalAlpha = prev;
  }

  tile(src, x, y, w, h) {
    const c = this.ctx;
    const img = src.canvas || src;
    const pattern = typeof c.createPattern === 'function' ? c.createPattern(img, 'repeat') : null;
    if (!pattern) return;
    c.save();
    c.translate(x, y);
    c.fillStyle = pattern;
    c.fillRect(0, 0, w, h);
    c.restore();
  }

  readPixels(x, y, w, h) {
    const img = this.ctx.getImageData(x, y, w, h);
    return new Pixels(img.width, img.height, img.data);
  }

  writePixels(pixels, dx, dy) {
    const img = this.ctx.createImageData(pixels.width, pixels.height);
    img.data.set(pixels.data);
    this.ctx.putImageData(img, dx, dy);
  }

  createPixels(w, h) {
    const img = this.ctx.createImageData(w, h);
    return new Pixels(img.width, img.height, img.data);
  }

  toPNG() {
    if (typeof this.canvas.toBufferSync === 'function') return this.canvas.toBufferSync('png');
    if (typeof this.canvas.toBuffer === 'function') return this.canvas.toBuffer('image/png');
    return null;
  }
}

// Headless gets pixels; the browser gets its canvas. Callers ask for a surface
// and never learn which they got.
function createSurface(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new CanvasSurface(new OffscreenCanvas(Math.max(1, width | 0), Math.max(1, height | 0)));
  }
  return new RasterSurface(width, height);
}

function surfaceFromCanvas(canvas) {
  return canvas && typeof canvas.getContext === 'function' ? new CanvasSurface(canvas) : null;
}

module.exports = {
  RasterSurface, CanvasSurface, Pixels,
  createSurface, surfaceFromCanvas,
  parseColor, intersectRect, boundingBox,
};
