// Canonical pixel storage for the software GDI migration. Geometry and text
// remain outside this module; it owns native-format pixel access and dirtiness.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.gdiSurfaceLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_PALETTE_16 = [
    [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
    [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
    [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
    [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
  ];

  const clampByte = value => Math.max(0, Math.min(255, value | 0));
  const colorRef = (r, g, b) => clampByte(r) | (clampByte(g) << 8) | (clampByte(b) << 16);
  const colorParts = color => [color & 0xFF, (color >>> 8) & 0xFF, (color >>> 16) & 0xFF];

  function defaultStride(width, bpp, alignment) {
    const bits = Math.max(0, width | 0) * Math.max(1, bpp | 0);
    const align = alignment === 2 ? 2 : 4;
    return Math.ceil(Math.ceil(bits / 8) / align) * align;
  }

  class GdiSurface {
    constructor(options) {
      options = options || {};
      this.width = options.width | 0;
      this.height = options.height | 0;
      this.bpp = options.bpp | 0;
      if (this.width <= 0 || this.height <= 0) throw new RangeError('surface dimensions must be positive');
      if (![1, 4, 8, 16, 24, 32].includes(this.bpp)) throw new RangeError(`unsupported surface bpp ${this.bpp}`);

      this.format = options.format || (this.bpp === 32 ? 'bgra32' : `dib${this.bpp}`);
      this.stride = options.stride === undefined
        ? defaultStride(this.width, this.bpp, options.alignment)
        : options.stride | 0;
      if (this.stride < Math.ceil(this.width * this.bpp / 8)) throw new RangeError('surface stride is too small');
      this.topDown = options.topDown !== false;
      this.storageOffset = options.storageOffset >>> 0;
      this.storage = options.storage instanceof Uint8Array
        ? options.storage
        : new Uint8Array(options.storage || this.storageOffset + this.stride * this.height);
      if (this.storageOffset + this.stride * this.height > this.storage.length) {
        throw new RangeError('surface storage is too small');
      }
      this.palette = options.palette || null;
      this.onDirty = typeof options.onDirty === 'function' ? options.onDirty : null;
      this.dirtyRect = null;
      this._paletteCache = new Map();
    }

    contains(x, y) {
      return (x | 0) === x && (y | 0) === y && x >= 0 && y >= 0 && x < this.width && y < this.height;
    }

    _rowOffset(y) {
      const storageY = this.topDown ? y : this.height - 1 - y;
      return this.storageOffset + storageY * this.stride;
    }

    _paletteColor(index) {
      const entry = this.palette && this.palette[index];
      if (entry) {
        if (Array.isArray(entry) || ArrayBuffer.isView(entry)) return colorRef(entry[0], entry[1], entry[2]);
        if (typeof entry === 'number') return entry & 0xFFFFFF;
        return colorRef(entry.r, entry.g, entry.b);
      }
      if (this.bpp === 1) return index ? 0xFFFFFF : 0;
      if (this.bpp === 4) {
        const c = DEFAULT_PALETTE_16[index & 15];
        return colorRef(c[0], c[1], c[2]);
      }
      return colorRef(index, index, index);
    }

    _nearestPaletteIndex(color) {
      color &= 0xFFFFFF;
      const cached = this._paletteCache.get(color);
      if (cached !== undefined) return cached;
      const count = this.bpp === 1 ? 2 : this.bpp === 4 ? 16 : 256;
      const [r, g, b] = colorParts(color);
      let best = 0;
      let bestDistance = Infinity;
      for (let i = 0; i < count; i++) {
        const candidate = this._paletteColor(i);
        const [pr, pg, pb] = colorParts(candidate);
        const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (distance < bestDistance) {
          best = i;
          bestDistance = distance;
          if (distance === 0) break;
        }
      }
      this._paletteCache.set(color, best);
      return best;
    }

    readPixel(x, y) {
      x |= 0;
      y |= 0;
      if (!this.contains(x, y)) return null;
      const row = this._rowOffset(y);
      const bytes = this.storage;
      if (this.bpp === 1) {
        return this._paletteColor((bytes[row + (x >> 3)] >>> (7 - (x & 7))) & 1);
      }
      if (this.bpp === 4) {
        const packed = bytes[row + (x >> 1)];
        return this._paletteColor((x & 1) ? packed & 15 : packed >>> 4);
      }
      if (this.bpp === 8) return this._paletteColor(bytes[row + x]);
      if (this.bpp === 16) {
        const offset = row + x * 2;
        const value = bytes[offset] | (bytes[offset + 1] << 8);
        const r = Math.round(((value >>> 11) & 31) * 255 / 31);
        const g = Math.round(((value >>> 5) & 63) * 255 / 63);
        const b = Math.round((value & 31) * 255 / 31);
        return colorRef(r, g, b);
      }
      const offset = row + x * (this.bpp >>> 3);
      if (this.format === 'rgba32') return colorRef(bytes[offset], bytes[offset + 1], bytes[offset + 2]);
      return colorRef(bytes[offset + 2], bytes[offset + 1], bytes[offset]);
    }

    writePixel(x, y, color) {
      x |= 0;
      y |= 0;
      color &= 0xFFFFFF;
      if (!this.contains(x, y)) return null;
      const row = this._rowOffset(y);
      const bytes = this.storage;
      if (this.bpp === 1) {
        const offset = row + (x >> 3);
        const mask = 1 << (7 - (x & 7));
        const index = this._nearestPaletteIndex(color);
        bytes[offset] = index ? bytes[offset] | mask : bytes[offset] & ~mask;
      } else if (this.bpp === 4) {
        const offset = row + (x >> 1);
        const index = this._nearestPaletteIndex(color) & 15;
        bytes[offset] = (x & 1) ? (bytes[offset] & 0xF0) | index : (bytes[offset] & 0x0F) | (index << 4);
      } else if (this.bpp === 8) {
        bytes[row + x] = this._nearestPaletteIndex(color);
      } else {
        const [r, g, b] = colorParts(color);
        if (this.bpp === 16) {
          const offset = row + x * 2;
          const value = (Math.round(r * 31 / 255) << 11) |
            (Math.round(g * 63 / 255) << 5) | Math.round(b * 31 / 255);
          bytes[offset] = value & 0xFF;
          bytes[offset + 1] = value >>> 8;
        } else {
          const offset = row + x * (this.bpp >>> 3);
          if (this.format === 'rgba32') {
            bytes[offset] = r;
            bytes[offset + 1] = g;
            bytes[offset + 2] = b;
          } else {
            bytes[offset] = b;
            bytes[offset + 1] = g;
            bytes[offset + 2] = r;
          }
          if (this.bpp === 32) bytes[offset + 3] = 255;
        }
      }
      this.markDirty(x, y, 1, 1);
      return this.readPixel(x, y);
    }

    fillRect(x, y, width, height, color) {
      x |= 0;
      y |= 0;
      width |= 0;
      height |= 0;
      const left = Math.max(0, x);
      const top = Math.max(0, y);
      const right = Math.min(this.width, x + width);
      const bottom = Math.min(this.height, y + height);
      if (right <= left || bottom <= top) return false;
      const dirtyCallback = this.onDirty;
      this.onDirty = null;
      for (let py = top; py < bottom; py++) {
        for (let px = left; px < right; px++) this.writePixel(px, py, color);
      }
      this.onDirty = dirtyCallback;
      this.markDirty(left, top, right - left, bottom - top);
      return true;
    }

    markDirty(x, y, width, height) {
      let left = Math.max(0, x | 0);
      let top = Math.max(0, y | 0);
      let right = Math.min(this.width, (x | 0) + (width | 0));
      let bottom = Math.min(this.height, (y | 0) + (height | 0));
      if (right <= left || bottom <= top) return;
      const current = this.dirtyRect;
      this.dirtyRect = current ? {
        x: Math.min(current.x, left),
        y: Math.min(current.y, top),
        w: Math.max(current.x + current.w, right) - Math.min(current.x, left),
        h: Math.max(current.y + current.h, bottom) - Math.min(current.y, top),
      } : { x: left, y: top, w: right - left, h: bottom - top };
      if (this.onDirty) this.onDirty({ x: left, y: top, w: right - left, h: bottom - top });
    }

    takeDirtyRect() {
      const dirty = this.dirtyRect;
      this.dirtyRect = null;
      return dirty;
    }

    rgbaRect(x, y, width, height) {
      x |= 0;
      y |= 0;
      width |= 0;
      height |= 0;
      if (x < 0 || y < 0 || width < 0 || height < 0 || x + width > this.width || y + height > this.height) {
        throw new RangeError('RGBA read rectangle is outside the surface');
      }
      const output = new Uint8ClampedArray(width * height * 4);
      for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
          const color = this.readPixel(x + px, y + py);
          const offset = (py * width + px) * 4;
          output[offset] = color & 0xFF;
          output[offset + 1] = (color >>> 8) & 0xFF;
          output[offset + 2] = (color >>> 16) & 0xFF;
          output[offset + 3] = 255;
        }
      }
      return output;
    }
  }

  return { GdiSurface, defaultStride, colorRef };
});
