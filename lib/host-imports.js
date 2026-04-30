// Shared host imports for wine-assembly WASM instantiation.
// All runners (host.js, test/run.js, tools/render-png.js) use this.
// Real GDI with canvas backend — works with browser canvas or node-canvas.
//
// Usage:
//   const base = createHostImports({ getMemory, renderer, resourceJson, onExit });
//   base.host.log = (ptr, len) => { ... };  // override as needed
//   const { instance } = await WebAssembly.instantiate(wasm, { host: base.host });

// Minimal Path2D shim for Node (CLI tests). Real paths are only traversed by
// the browser canvas renderer; CLI only needs bbox tracking in update rgns.
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D {
    constructor() {}
    rect() {} moveTo() {} lineTo() {} ellipse() {} closePath() {} addPath() {}
  };
}
var _mu1 = typeof require !== 'undefined' ? require('./mem-utils') : (typeof window !== 'undefined' && window.memUtils || {});
var _dib = typeof require !== 'undefined' ? require('./dib') : new Proxy({}, { get: (_, k) => (typeof window !== 'undefined' && window.dibLib && window.dibLib[k]) });

function createHostImports(ctx) {
  var _readStrA = _mu1.readStrA;
  // ctx.getMemory()    -> ArrayBuffer (late-bound)
  // ctx.renderer       -> Win98Renderer instance (optional; can be getter for late binding)
  // ctx.resourceJson   -> parsed PE resources { menus, dialogs, strings, bitmaps }
  // ctx.onExit(code)   -> called on ExitProcess
  // ctx.trace          -> Set of trace categories: 'gdi', 'msg', etc. (optional)

  const readStr = (ptr, maxLen = 512) => _readStrA(ctx.getMemory(), ptr, maxLen);
  const _trace = ctx.trace || new Set();
  const _hex = v => '0x' + (v >>> 0).toString(16);

  // --- GDI object state ---
  // Thread workers pass ctx.sharedGdi to share the main thread's GDI handles; without
  // sharing, each worker creates disjoint _gdiObjects so GDI handles from the main
  // thread would be invisible to worker BitBlt/SelectObject (breaks e.g. CITYSCAP.SCR).
  const _sharedGdi = ctx.sharedGdi || null;
  const _handleBox = _sharedGdi ? _sharedGdi.handleBox : { next: 0x400001 };
  const _gdiObjects = _sharedGdi ? _sharedGdi._gdiObjects : {
    0x30001: { type: 'bitmap', w: 1, h: 1, pixels: new Uint8Array(4) },
    // Stock objects: GetStockObject(index) → 0x30010 + index
    0x30010: { type: 'brush', color: 0xFFFFFF },   // WHITE_BRUSH (0)
    0x30011: { type: 'brush', color: 0xC0C0C0 },   // LTGRAY_BRUSH (1)
    0x30012: { type: 'brush', color: 0x808080 },    // GRAY_BRUSH (2)
    0x30013: { type: 'brush', color: 0x404040 },    // DKGRAY_BRUSH (3)
    0x30014: { type: 'brush', color: 0x000000 },    // BLACK_BRUSH (4)
    0x30015: { type: 'null' },                      // NULL_BRUSH / HOLLOW_BRUSH (5)
    0x30016: { type: 'pen', color: 0xFFFFFF, width: 1 }, // WHITE_PEN (6)
    0x30017: { type: 'pen', color: 0x000000, width: 1 }, // BLACK_PEN (7)
    0x30018: { type: 'null' },                      // NULL_PEN (8)
    0x3001a: { type: 'font', height: 16, weight: 400, italic: 0, face: 'monospace', css: '16px "Fixedsys Excelsior", "Fixedsys", "Courier New", monospace' }, // OEM_FIXED_FONT (10)
    0x3001b: { type: 'font', height: 16, weight: 400, italic: 0, face: 'monospace', css: '16px "Fixedsys Excelsior", "Fixedsys", "Courier New", monospace' }, // ANSI_FIXED_FONT (11)
    0x3001c: { type: 'font', height: 12, weight: 400, italic: 0, face: 'sans-serif', css: '12px "W95FA", "MS Sans Serif", "Microsoft Sans Serif", Tahoma, sans-serif' }, // ANSI_VAR_FONT (12)
    0x3001d: { type: 'font', height: 12, weight: 400, italic: 0, face: 'sans-serif', css: '12px "W95FA", "MS Sans Serif", "Microsoft Sans Serif", Tahoma, sans-serif' }, // SYSTEM_FONT (13)
    0x3001e: { type: 'font', height: 12, weight: 400, italic: 0, face: 'sans-serif', css: '12px "W95FA", "MS Sans Serif", "Microsoft Sans Serif", Tahoma, sans-serif' }, // DEVICE_DEFAULT_FONT (14)
    0x3001f: { type: 'null' },                      // DEFAULT_PALETTE (15)
    0x30020: { type: 'font', height: 16, weight: 400, italic: 0, face: 'monospace', css: '16px "Fixedsys Excelsior", "Fixedsys", "Courier New", monospace' }, // SYSTEM_FIXED_FONT (16)
    0x30021: { type: 'font', height: 11, weight: 400, italic: 0, face: 'MS Sans Serif', css: '11px "W95FA", "Microsoft Sans Serif", "MS Sans Serif", Tahoma, Arial, sans-serif' }, // DEFAULT_GUI_FONT (17) — Win98 dialog font
    0x30022: { type: 'font', height: 11, weight: 700, italic: 0, face: 'MS Sans Serif', css: 'bold 11px "W95FA", "Microsoft Sans Serif", "MS Sans Serif", Tahoma, Arial, sans-serif' }, // CAPTION_FONT — used by $defwndproc_ncpaint title text
    0x30002: { type: 'brush', color: 0xFFFFFF },    // legacy default
  };
  const _dcState = _sharedGdi ? _sharedGdi._dcState : {};

  // Window DC = hwnd + 0x40000 (from BeginPaint/GetDC in WAT)
  // Window DC (whole window) = hwnd + 0xC0000 (from GetWindowDC in WAT)
  // hwnds: 0x10001+, so client DCs: 0x50001+; window DCs: 0xD0001+;
  // DDraw surface DCs: 0x200000..0x2FFFFF (slot-indexed, see IDirectDrawSurface_GetDC);
  // GDI handles: 0x400001+ (kept above the reserved DDraw range to avoid collision).
  // Desktop HWND (0x10000) → GetDC returns 0x50000, so the valid window-DC
  // range starts at 0x50000 (inclusive). Screensavers call GetDC(GetDesktopWindow())
  // to obtain a screen DC and BitBlt from it.
  const _isWindowDC = (hdc) => (hdc >= 0x50000 && hdc < 0x200000) || (hdc >= 0xD0000 && hdc < 0x200000);
  const _isWholeWindowDC = (hdc) => hdc >= 0xD0001 && hdc < 0x200000;
  const _hwndFromDC = (hdc) => _isWholeWindowDC(hdc) ? hdc - 0xC0000 : (_isWindowDC(hdc) ? hdc - 0x40000 : 0);

  const _gdiAlloc = (obj) => { const h = _handleBox.next++; _gdiObjects[h] = obj; return h; };

  // ---- Voice manager ----------------------------------------------------
  // Single owner of the AudioContext + per-voice gain/pan graph. waveOut and
  // DSOUND both go through this. Each voice has a sample format and a
  // GainNode→(StereoPannerNode)→destination chain; PCM is decoded from guest
  // memory on submit and queued as AudioBufferSourceNodes.
  function _decodePcm(audioCtx, mem, ptr, len, channels, bits, rate) {
    const bps = bits / 8;
    const numSamples = (len / (bps * channels)) | 0;
    if (numSamples <= 0) return null;
    const buf = audioCtx.createBuffer(channels, numSamples, rate);
    for (let ch = 0; ch < channels; ch++) {
      const dst = buf.getChannelData(ch);
      for (let i = 0; i < numSamples; i++) {
        const off = ptr + (i * channels + ch) * bps;
        if (bits === 16) {
          const s = mem[off] | (mem[off + 1] << 8);
          dst[i] = (s > 32767 ? s - 65536 : s) / 32768;
        } else if (bits === 8) {
          dst[i] = (mem[off] - 128) / 128;
        }
      }
    }
    return buf;
  }
  const _voices = ctx._voices = {
    _next: 0x0B0001,
    _map: {},
    _ac: null,
    _ensureCtx(rate) {
      if (this._ac) return this._ac;
      const AC = (typeof AudioContext !== 'undefined') ? AudioContext :
                 (typeof webkitAudioContext !== 'undefined') ? webkitAudioContext : null;
      if (!AC) return null;
      try { this._ac = new AC({ sampleRate: rate }); } catch (_) { this._ac = null; }
      return this._ac;
    },
    open(rate, channels, bits) {
      const id = this._next++;
      const v = { id, rate, channels, bits, bytesWritten: 0, nextTime: 0,
                  gain: null, pan: null, freq: rate, currentSrc: null, playStart: 0, lastDuration: 0 };
      const ac = this._ensureCtx(rate);
      if (ac) {
        v.gain = ac.createGain();
        try { v.pan = ac.createStereoPanner(); v.gain.connect(v.pan); v.pan.connect(ac.destination); }
        catch (_) { v.gain.connect(ac.destination); }
        v.nextTime = ac.currentTime;
      }
      this._map[id] = v;
      return id;
    },
    writeStream(id, ptr, len) {
      const v = this._map[id]; if (!v) return;
      v.bytesWritten += len;
      const ac = this._ac; if (!ac) return;
      try {
        const mem = new Uint8Array(ctx.getMemory());
        const buf = _decodePcm(ac, mem, ptr, len, v.channels, v.bits, v.rate);
        if (!buf) return;
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(v.gain || ac.destination);
        const t = Math.max(ac.currentTime, v.nextTime);
        src.start(t);
        v.nextTime = t + buf.duration;
      } catch (_) {}
    },
    playRing(id, ptr, len, startOff, loop) {
      const v = this._map[id]; if (!v) return;
      const ac = this._ac; if (!ac) return;
      try {
        const mem = new Uint8Array(ctx.getMemory());
        const buf = _decodePcm(ac, mem, ptr + (startOff | 0), Math.max(0, len - (startOff | 0)),
                               v.channels, v.bits, v.rate);
        if (!buf) return;
        if (v.currentSrc) { try { v.currentSrc.stop(); } catch (_) {} v.currentSrc = null; }
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.loop = !!loop;
        if (v.freq && v.freq !== v.rate) src.playbackRate.value = v.freq / v.rate;
        src.connect(v.gain || ac.destination);
        v.playStart = ac.currentTime;
        v.lastDuration = buf.duration;
        src.start(v.playStart);
        v.currentSrc = src;
      } catch (_) {}
    },
    stop(id) {
      const v = this._map[id]; if (!v) return;
      if (v.currentSrc) { try { v.currentSrc.stop(); } catch (_) {} v.currentSrc = null; }
    },
    close(id) {
      this.stop(id);
      delete this._map[id];
    },
    getPos(id) {
      const v = this._map[id]; if (!v) return 0;
      // For STREAM voices, return total bytes written (matches old waveOut behavior).
      // For SNAPSHOT voices, derive cursor from elapsed audio time.
      if (v.currentSrc && v.lastDuration > 0 && this._ac) {
        const elapsed = this._ac.currentTime - v.playStart;
        const bytesPerSec = v.rate * v.channels * (v.bits / 8);
        const cursor = (elapsed * bytesPerSec) | 0;
        const total = (v.lastDuration * bytesPerSec) | 0;
        return total > 0 ? (cursor % total) : 0;
      }
      return v.bytesWritten;
    },
    setGain(id, g) { const v = this._map[id]; if (v && v.gain) v.gain.gain.value = g; },
    setPan(id, p)  { const v = this._map[id]; if (v && v.pan) v.pan.pan.value = p; },
    setFreq(id, hz) {
      const v = this._map[id]; if (!v) return;
      v.freq = hz || v.rate;
      if (v.currentSrc) { try { v.currentSrc.playbackRate.value = v.freq / v.rate; } catch (_) {} }
    },
  };

  const _getDC = (hdc) => {
    if (!_dcState[hdc]) _dcState[hdc] = { penColor: 0x000000, penWidth: 1, brushColor: 0xC0C0C0, textColor: 0x000000, bkColor: 0xFFFFFF, bkMode: 2, posX: 0, posY: 0, selectedFont: 0 };
    return _dcState[hdc];
  };

  // Resolve the CSS font string for a DC's currently selected font
  const _resolveFont = (hdc) => {
    const dc = _getDC(hdc);
    if (dc.selectedFont) {
      const font = _gdiObjects[dc.selectedFont];
      if (font && font.css) return font.css;
    }
    return '13px monospace'; // system default
  };

  // Build CSS font string from LOGFONT-like properties
  const _buildCssFont = (height, weight, italic, face) => {
    const sz = Math.max(8, Math.abs(height) || 13);
    const parts = [];
    if (italic) parts.push('italic');
    if (weight >= 700) parts.push('bold');
    parts.push(sz + 'px');
    // Map Win32 face names to CSS
    const W95 = '"W95FA", "Microsoft Sans Serif", "MS Sans Serif", Tahoma, sans-serif';
    const FSX = '"Fixedsys Excelsior", "Fixedsys", "Courier New", monospace';
    const faceMap = { 'ms sans serif': W95, 'microsoft sans serif': W95, 'ms serif': 'serif',
      'fixedsys': FSX, 'courier': FSX, 'courier new': FSX, 'terminal': FSX, 'fixed': FSX,
      'system': W95, 'tahoma': W95, 'ms shell dlg': W95, 'ms shell dlg 2': W95,
      'arial': 'Arial, sans-serif', 'times new roman': '"Times New Roman", serif',
      'verdana': 'Verdana, sans-serif' };
    const lower = (face || '').toLowerCase();
    parts.push(faceMap[lower] || face || 'sans-serif');
    return parts.join(' ');
  };

  // Create an offscreen canvas (works in browser and Node with node-canvas)
  const _createOffscreen = (w, h) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    try { const { createCanvas: cc } = require('canvas'); return cc(w, h); }
    catch (e) { return null; }
  };

  // --- DDraw surface DC ↔ canvas routing ---
  // Surface DCs live in [0x200000, 0x300000) with hdc = 0x200000 + slot.
  // GDI drawn via these hdcs must end up in the surface's native-bpp DIB so
  // Blt/Flip/Present pick up the pixels. We keep a per-slot RGBA offscreen
  // canvas, seed it from the DIB at GetDC (DIB→canvas), let GDI write it
  // freely, then commit back to the DIB at ReleaseDC (canvas→DIB).
  const DX_OBJECTS_WA = 0x07FF0000;
  const DX_ENTRY_SIZE = 32;
  const _surfaceCanvases = new Map(); // slot → { canvas, w, h, ctx2d }
  const _isSurfaceDC = (hdc) => hdc >= 0x200000 && hdc < 0x300000;
  const _surfaceSlotFromHDC = (hdc) => hdc - 0x200000;

  // Read surface fields from DX_OBJECTS entry. Returns null if slot is not a surface.
  const _surfaceInfo = (slot) => {
    const mem = ctx.getMemory && ctx.getMemory();
    if (!mem) return null;
    const dv = new DataView(mem);
    const entry = DX_OBJECTS_WA + slot * DX_ENTRY_SIZE;
    const type = dv.getUint32(entry, true);
    if (type !== 2) return null; // 2 = DDSurface
    return {
      slot,
      w: dv.getUint16(entry + 12, true),
      h: dv.getUint16(entry + 14, true),
      bpp: dv.getUint16(entry + 16, true),
      pitch: dv.getUint16(entry + 18, true),
      dibWa: dv.getUint32(entry + 20, true),
    };
  };

  const _getSurfaceCanvas = (slot) => {
    const info = _surfaceInfo(slot);
    if (!info || info.w === 0 || info.h === 0) return null;
    let cached = _surfaceCanvases.get(slot);
    if (!cached || cached.w !== info.w || cached.h !== info.h) {
      const canvas = _createOffscreen(info.w, info.h);
      if (!canvas) return null;
      cached = { canvas, w: info.w, h: info.h, ctx2d: canvas.getContext('2d') };
      _surfaceCanvases.set(slot, cached);
    }
    return { ...cached, info };
  };

  // Copy DIB pixels → canvas (RGBA). Handles 16bpp (RGB565) and 32bpp (XRGB).
  // 8bpp is skipped for now — we'd need to read dx_primary_pal_wa global.
  const _dibToSurfaceCanvas = (slot) => {
    const sc = _getSurfaceCanvas(slot);
    if (!sc || !sc.info.dibWa) return;
    const { w, h, bpp, pitch, dibWa } = sc.info;
    const mem = ctx.getMemory();
    const dib = new Uint8Array(mem, dibWa, pitch * h);
    const img = sc.ctx2d.createImageData(w, h);
    const rgba = img.data;
    if (bpp === 32) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const si = y * pitch + x * 4, di = (y * w + x) * 4;
          rgba[di]     = dib[si + 2]; // B→R (XRGB little-endian: B,G,R,X)
          rgba[di + 1] = dib[si + 1];
          rgba[di + 2] = dib[si];
          rgba[di + 3] = 255;
        }
      }
    } else if (bpp === 16) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const si = y * pitch + x * 2, di = (y * w + x) * 4;
          const px = dib[si] | (dib[si + 1] << 8);
          rgba[di]     = ((px >> 11) & 0x1F) * 255 / 31 | 0;
          rgba[di + 1] = ((px >> 5) & 0x3F) * 255 / 63 | 0;
          rgba[di + 2] = (px & 0x1F) * 255 / 31 | 0;
          rgba[di + 3] = 255;
        }
      }
    } else if (bpp === 8) {
      const palWa = _getPrimaryPalWa();
      const pal = palWa ? new Uint8Array(mem, palWa, 1024) : null;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = dib[y * pitch + x];
          const di = (y * w + x) * 4;
          if (pal) {
            const pi = idx * 4;
            rgba[di]     = pal[pi];
            rgba[di + 1] = pal[pi + 1];
            rgba[di + 2] = pal[pi + 2];
          } else {
            rgba[di] = rgba[di + 1] = rgba[di + 2] = idx;
          }
          rgba[di + 3] = 255;
        }
      }
    } else {
      // 4bpp/1bpp: opaque black.
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    }
    sc.ctx2d.putImageData(img, 0, 0);
  };

  const _getPrimaryPalWa = () => {
    const e = ctx.exports;
    if (e && e.get_dx_primary_pal_wa) return e.get_dx_primary_pal_wa() >>> 0;
    return 0;
  };

  // Nearest-palette-match: keyed by palette WA. Maps 24-bit RGB → index.
  // Cached so a StretchBlt of a bitmap doesn't recompute the same colors.
  const _palMatchCache = new Map();
  const _nearestPalIdx = (palWa, r, g, b) => {
    let c = _palMatchCache.get(palWa);
    if (!c) {
      const mem = ctx.getMemory();
      c = { map: new Map(), pal: new Uint8Array(mem, palWa, 1024).slice() };
      _palMatchCache.set(palWa, c);
    }
    const key = (r << 16) | (g << 8) | b;
    const hit = c.map.get(key);
    if (hit !== undefined) return hit;
    let best = 0, bestD = Infinity;
    const pal = c.pal;
    for (let i = 0; i < 256; i++) {
      const pi = i * 4;
      const dr = r - pal[pi], dg = g - pal[pi + 1], db = b - pal[pi + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
    }
    c.map.set(key, best);
    return best;
  };

  // Copy canvas (RGBA) → DIB in surface's native bpp. Mirrors _dibToSurfaceCanvas.
  const _surfaceCanvasToDib = (slot) => {
    const sc = _getSurfaceCanvas(slot);
    if (!sc || !sc.info.dibWa) return;
    const { w, h, bpp, pitch, dibWa } = sc.info;
    const mem = ctx.getMemory();
    const dib = new Uint8Array(mem, dibWa, pitch * h);
    const img = sc.ctx2d.getImageData(0, 0, w, h);
    const rgba = img.data;
    if (bpp === 32) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const di = y * pitch + x * 4, si = (y * w + x) * 4;
          dib[di]     = rgba[si + 2];
          dib[di + 1] = rgba[si + 1];
          dib[di + 2] = rgba[si];
          dib[di + 3] = 0;
        }
      }
    } else if (bpp === 16) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const di = y * pitch + x * 2, si = (y * w + x) * 4;
          const r5 = (rgba[si] * 31 / 255 + 0.5) | 0;
          const g6 = (rgba[si + 1] * 63 / 255 + 0.5) | 0;
          const b5 = (rgba[si + 2] * 31 / 255 + 0.5) | 0;
          const px = (r5 << 11) | (g6 << 5) | b5;
          dib[di] = px & 0xFF;
          dib[di + 1] = (px >> 8) & 0xFF;
        }
      }
    }
    else if (bpp === 8) {
      const palWa = _getPrimaryPalWa();
      if (palWa) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const si = (y * w + x) * 4;
            dib[y * pitch + x] = _nearestPalIdx(palWa, rgba[si], rgba[si + 1], rgba[si + 2]);
          }
        }
      }
      // No palette yet → can't encode, drop write-back.
    }
    // 4bpp/1bpp: silent drop.
  };

  // Resolve the top-level hwnd that owns a given hwnd (for per-window canvas lookup)
  const _resolveTopHwnd = (hwnd) => {
    if (!ctx.renderer) return hwnd;
    const win = ctx.renderer.windows[hwnd];
    if (!win) return hwnd;
    if (win.isChild && win.parentHwnd) return _resolveTopHwnd(win.parentHwnd);
    return hwnd;
  };

  // Get the canvas context + origin for a given DC handle.
  // All window drawing goes into one full-window-sized back canvas per window.
  // GetWindowDC: (0,0) = window top-left. GetDC/BeginPaint: (0,0) = client top-left.
  // Memory DCs draw into their bitmap's canvas at (0,0).
  const _getDrawTarget = (hdc, hwnd) => {
    if (_isSurfaceDC(hdc)) {
      const sc = _getSurfaceCanvas(_surfaceSlotFromHDC(hdc));
      if (!sc) {
        if (_trace.has('dc')) console.log(`[dc] hdc=${_hex(hdc)} SURFACE_DC (no canvas for slot ${_surfaceSlotFromHDC(hdc)})`);
        return null;
      }
      if (_trace.has('dc')) console.log(`[dc] hdc=${_hex(hdc)} SURFACE_DC slot=${sc.info.slot} ${sc.w}x${sc.h} bpp=${sc.info.bpp}`);
      return { ctx: sc.ctx2d, ox: 0, oy: 0, hwnd: 0, canvas: sc.canvas };
    }
    if (_isWindowDC(hdc)) {
      if (!ctx.renderer) return null;
      const acd = ctx.renderer._activeChildDraw;
      if (acd && _hwndFromDC(hdc) === acd.hwnd) {
        return { ctx: acd.ctx, ox: acd.ox, oy: acd.oy, hwnd: acd.hwnd, canvas: acd.canvas };
      }
      const resolvedHwnd = _hwndFromDC(hdc) || hwnd;
      let h = resolvedHwnd;
      // Walk child→parent chain via WAT (the source of truth for window
      // geometry), accumulating each child's (x,y) within parent. Stops
      // at the first ancestor that has a JS-side renderer.windows entry
      // (top-level windows + dialogs registered by host_dialog_loaded).
      let childOx = 0, childOy = 0;
      const we = ctx.renderer.wasm && ctx.renderer.wasm.exports;
      if (h && !ctx.renderer.windows[h] && we && we.wnd_get_parent && we.ctrl_get_xy) {
        for (let depth = 0; depth < 8; depth++) {
          const xy = we.ctrl_get_xy(h) >>> 0;
          childOx += xy & 0xFFFF;
          childOy += (xy >>> 16) & 0xFFFF;
          const parent = we.wnd_get_parent(h) >>> 0;
          if (!parent) { h = 0; break; }
          h = parent;
          if (ctx.renderer.windows[h]) break;
        }
      }
      // hwnd=0x10000 is the phantom desktop (GetDesktopWindow) — no window
      // record exists for it. Fall through to the top-level lookup so
      // desktop DC reads/writes land on the screensaver's main window.
      if (!h || !ctx.renderer.windows[h]) {
        for (const k of Object.keys(ctx.renderer.windows)) {
          const w = ctx.renderer.windows[k];
          if (w && !w.isChild) { h = parseInt(k); break; }
        }
        childOx = 0; childOy = 0;
      }
      const win = ctx.renderer.windows[h];
      if (win) win.clientPainted = true;
      ctx.renderer.scheduleRepaint();

      // Single back canvas per window, sized to full window
      const topHwnd = _resolveTopHwnd(h);
      const wc = ctx.renderer.getWindowCanvas(topHwnd);
      if (!wc) { if (_trace.has('dc')) console.log(`[dc] hdc=${_hex(hdc)} hwnd_in=${_hex(hwnd||0)} → hwnd=${_hex(h)} top=${_hex(topHwnd)} NO_CANVAS`); return null; }

      let ox = 0, oy = 0;
      if (_isWholeWindowDC(hdc) && h === topHwnd) {
        // GetWindowDC on top-level: (0,0) = window top-left → no offset
      } else {
        // GetDC/BeginPaint: (0,0) = client area top-left → offset by chrome.
        // GetWindowDC on child: (0,0) = child's window top-left, which sits
        // at (parent.client + child.pos) on the top-level back-canvas.
        if (!_isWholeWindowDC(hdc)) {
          const topWin = ctx.renderer.windows[topHwnd];
          if (topWin && topWin.clientRect) {
            ox = topWin.clientRect.x - topWin.x;
            oy = topWin.clientRect.y - topWin.y;
          }
        }
        // Child windows: add child position + every ancestor child's
        // position, walking up until we hit the top-level. childWin.x/y is
        // relative to parent's client area (not including parent's chrome
        // offset — that's already accumulated above via topWin.clientRect).
        const childWin = ctx.renderer.windows[h];
        if (childWin && childWin.isChild) {
          if (_isWholeWindowDC(hdc)) {
            const topWin = ctx.renderer.windows[topHwnd];
            if (topWin && topWin.clientRect) {
              ox += topWin.clientRect.x - topWin.x;
              oy += topWin.clientRect.y - topWin.y;
            }
          }
          let cw = childWin;
          while (cw && cw.isChild) {
            ox += cw.x;
            oy += cw.y;
            cw = cw.parentHwnd ? ctx.renderer.windows[cw.parentHwnd] : null;
          }
        }
        // Plus any accumulated child→parent offset chain from WAT.
        ox += childOx;
        oy += childOy;
      }
      const wdc = _getDC(hdc);
      ox += (wdc.vpOrgX | 0) - (wdc.winOrgX | 0);
      oy += (wdc.vpOrgY | 0) - (wdc.winOrgY | 0);
      if (_trace.has('dc')) console.log(`[dc] hdc=${_hex(hdc)} hwnd_in=${_hex(hwnd||0)} → hwnd=${_hex(h)} top=${_hex(topHwnd)} ox=${ox} oy=${oy} canvas=${wc.canvas&&wc.canvas.width}x${wc.canvas&&wc.canvas.height}`);
      return { ctx: wc.ctx, ox, oy, hwnd: h, canvas: wc.canvas };
    }
    // Memory DC — find the selected bitmap's canvas
    const dc = _getDC(hdc);
    const bmpH = dc.selectedBitmap;
    const bmp = bmpH ? _gdiObjects[bmpH] : null;
    if (bmp && bmp.type === 'bitmap') {
      if (!bmp.canvas) {
        bmp.canvas = _createOffscreen(bmp.w || 1, bmp.h || 1);
      }
      // DIB section: guest wrote pixels directly to mapped memory — resync before any read.
      if (bmp.dibSection) _syncDibSection(bmp);
      if (bmp.canvas) {
        return { ctx: bmp.canvas.getContext('2d'), ox: (dc.vpOrgX | 0) - (dc.winOrgX | 0), oy: (dc.vpOrgY | 0) - (dc.winOrgY | 0), canvas: bmp.canvas };
      }
    }
    return null;
  };

  // ---- HRGN model: chain-of-Path2D (Approach A) -------------------------
  // HRGN = { branches, bbox, simpleRect?, rects? }
  //   branches: ClipChain[]; ClipChain = [{ path: Path2D, rule, polarity }]
  //   region = ⋃ branches, branches disjoint by construction
  //   simpleRect: only set for as-constructed rect rgns; cleared on first
  //               combine/exclude/intersect that mutates the rgn
  //   rects: legacy rect-list (for renderer.setWindowRgn / gdi_fill_rgn).
  //          Always at least the bbox; populated by builders + offset_rgn.
  const RGN_BRANCH_CAP = 16;
  const _traceRgn = (...a) => { if (_trace.has('rgn')) console.log('[rgn]', ...a); };

  // Per-hwnd update region map. Keyed by hwnd. An empty/missing entry means
  // "paint everything" — matches the fallback behavior used by startup/ShowWindow
  // triggers that set $paint_pending without a rect.
  const _updateRgns = new Map();
  function _rgnIsEmpty(r) {
    return !r || (r.bbox.r <= r.bbox.l) || (r.bbox.b <= r.bbox.t);
  }
  // Update regions coalesce to their bbox after a few unions to avoid
  // branch-explosion through Approach-B trap — Windows itself collapses
  // disjoint invalidation rects to a single bounding rect in many cases.
  function _coalesceUpdate(rgn) {
    if (!rgn || rgn.branches.length <= 1) return rgn;
    return _makeRectRgn(rgn.bbox.l, rgn.bbox.t, rgn.bbox.r, rgn.bbox.b);
  }
  function _invalRectHwnd(hwnd, l, t, r, b) {
    const rect = _makeRectRgn(l, t, r, b);
    const prev = _updateRgns.get(hwnd);
    if (!prev) { _updateRgns.set(hwnd, rect); return; }
    // Fast path: both simple rects. Merge if they share an edge / overlap;
    // else collapse to bbox union (single rect — cheap to clip).
    const merged = _makeRectRgn(
      Math.min(prev.bbox.l, l), Math.min(prev.bbox.t, t),
      Math.max(prev.bbox.r, r), Math.max(prev.bbox.b, b));
    _updateRgns.set(hwnd, merged);
  }
  function _invalRgnHwnd(hwnd, rgn) {
    const prev = _updateRgns.get(hwnd);
    if (!prev) { _updateRgns.set(hwnd, _cloneRgn(rgn)); return; }
    const merged = _makeRectRgn(
      Math.min(prev.bbox.l, rgn.bbox.l), Math.min(prev.bbox.t, rgn.bbox.t),
      Math.max(prev.bbox.r, rgn.bbox.r), Math.max(prev.bbox.b, rgn.bbox.b));
    _updateRgns.set(hwnd, merged);
  }
  function _valRectHwnd(hwnd, l, t, r, b) {
    const prev = _updateRgns.get(hwnd);
    if (!prev) return;
    const next = _combineRgn(4, prev, _makeRectRgn(l, t, r, b));
    if (_rgnIsEmpty(next)) _updateRgns.delete(hwnd);
    else _updateRgns.set(hwnd, next);
  }
  function _valRgnHwnd(hwnd, rgn) {
    const prev = _updateRgns.get(hwnd);
    if (!prev) return;
    const next = _combineRgn(4, prev, rgn);
    if (_rgnIsEmpty(next)) _updateRgns.delete(hwnd);
    else _updateRgns.set(hwnd, next);
  }

  // Log Approach-B branch-explosion traps with full runtime context, then
  // throw a one-line summary so the WASM trap surfaces something useful too.
  function _crashApproachB(opName, info) {
    const hex = v => '0x' + ((v >>> 0)).toString(16);
    let eip = 0;
    try { eip = ctx.renderer?.wasm?.exports?.get_eip?.() >>> 0; } catch (_) {}
    const br = r => r ? `${r.branches.length}:[${r.bbox.l},${r.bbox.t},${r.bbox.r},${r.bbox.b}]` : '-';
    console.error('====================================');
    console.error('[rgn] Approach B required (not implemented)');
    console.error(`  op: CombineRgn(${opName})`);
    console.error(`  hdc: ${info.hdc != null ? hex(info.hdc) : '-'}`);
    console.error(`  src1: ${br(info.src1)}`);
    console.error(`  src2: ${br(info.src2)}`);
    console.error(`  result branches projected: ${info.projected} (cap=${RGN_BRANCH_CAP})`);
    console.error(`  EIP: ${hex(eip)}`);
    console.error(`  Hint: scratch canvas with 'destination-over' compositing,`);
    console.error(`        per-branch fill of bbox, then drawFn under each chain.`);
    console.error(`        See lib/host-imports.js _drawWithClip.`);
    console.error('====================================');
    throw new Error('Approach B required: ' + opName);
  }

  function _rectPath(l, t, r, b) {
    const p = new Path2D();
    p.rect(l, t, r - l, b - t);
    // Metadata for the Node CLI fallback (stub Path2D has no-op rect/addPath).
    p._rectXYWH = { x: l, y: t, w: r - l, h: b - t };
    return p;
  }
  // True when running in the Node CLI with the stub Path2D (rect/addPath are
  // no-ops). Branches-based clips must be expressed without Path2D there.
  const _STUB_PATH2D = (() => {
    try {
      const p = new Path2D();
      p.rect(0, 0, 10, 10);
      // Real Path2D retains the segment in opaque state; our stub does nothing
      // observable. We can't introspect reliably, so infer via presence of
      // a native binding: real Path2D in node canvas would be imported from
      // the 'canvas' module, but that module doesn't export Path2D. So if
      // we're in Node and canvas has no Path2D, assume stub.
      if (typeof require === 'undefined') return false;
      try {
        const cv = require('canvas');
        return !cv.Path2D;
      } catch (_) { return false; }
    } catch (_) { return true; }
  })();
  function _makeRectRgn(l, t, r, b) {
    if (r < l) { const x = l; l = r; r = x; }
    if (b < t) { const x = t; t = b; b = x; }
    const branch = [{ path: _rectPath(l, t, r, b), rule: 'nonzero', polarity: +1 }];
    return {
      type: 'region',
      branches: [branch],
      bbox: { l, t, r, b },
      simpleRect: { l, t, r, b },
      rects: [{ x: l, y: t, w: r - l, h: b - t }],
    };
  }
  function _makeEllipseRgn(l, t, r, b) {
    const p = new Path2D();
    const cx = (l + r) / 2, cy = (t + b) / 2;
    const rx = Math.abs((r - l) / 2), ry = Math.abs((b - t) / 2);
    p.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    p.closePath();
    const branch = [{ path: p, rule: 'nonzero', polarity: +1 }];
    return {
      type: 'region',
      branches: [branch],
      bbox: { l, t, r, b },
      simpleRect: null,
      rects: [{ x: l, y: t, w: r - l, h: b - t }],
    };
  }
  function _makePolygonRgn(points, fillMode) {
    // points: [{x,y}, ...]. fillMode: 1=ALTERNATE (evenodd), 2=WINDING (nonzero)
    const p = new Path2D();
    if (points.length === 0) {
      return _makeRectRgn(0, 0, 0, 0);
    }
    p.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) p.lineTo(points[i].x, points[i].y);
    p.closePath();
    let minx = points[0].x, miny = points[0].y, maxx = minx, maxy = miny;
    for (const pt of points) {
      if (pt.x < minx) minx = pt.x; if (pt.x > maxx) maxx = pt.x;
      if (pt.y < miny) miny = pt.y; if (pt.y > maxy) maxy = pt.y;
    }
    const branch = [{ path: p, rule: fillMode === 1 ? 'evenodd' : 'nonzero', polarity: +1 }];
    return {
      type: 'region',
      branches: [branch],
      bbox: { l: minx, t: miny, r: maxx, b: maxy },
      simpleRect: null,
      rects: [{ x: minx, y: miny, w: maxx - minx, h: maxy - miny }],
    };
  }
  function _cloneRgn(rgn) {
    return {
      type: 'region',
      branches: rgn.branches.map(ch => ch.map(e => ({ path: e.path, rule: e.rule, polarity: e.polarity }))),
      bbox: { ...rgn.bbox },
      simpleRect: rgn.simpleRect ? { ...rgn.simpleRect } : null,
      rects: rgn.rects ? rgn.rects.map(r => ({ ...r })) : [{ x: rgn.bbox.l, y: rgn.bbox.t, w: rgn.bbox.r - rgn.bbox.l, h: rgn.bbox.b - rgn.bbox.t }],
    };
  }
  function _bboxUnion(a, b) {
    return { l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) };
  }
  function _bboxIntersect(a, b) {
    const l = Math.max(a.l, b.l), t = Math.max(a.t, b.t);
    const r = Math.min(a.r, b.r), bo = Math.min(a.b, b.b);
    if (r < l || bo < t) return { l: 0, t: 0, r: 0, b: 0 };
    return { l, t, r, b: bo };
  }
  // Subtract a single chain P from a single branch A: returns list of branches.
  // A \ P  =  A ∩ ¬P  =  A ∩ (⋃_i ¬p_i)  =  ⋃_i (A ∩ ¬p_i)
  // (each entry of P flipped to polarity=-1, intersected with A separately)
  function _subtractChainFromBranch(A, P) {
    const out = [];
    for (const e of P) {
      out.push([...A, { path: e.path, rule: e.rule, polarity: -e.polarity }]);
    }
    return out;
  }
  // Subtract list-of-chains B from a single branch A: returns list of branches.
  // A \ ⋃ B = A \ B[0] \ B[1] \ ... — apply iteratively.
  function _subtractBranchesFromBranch(A, Bs) {
    let acc = [A];
    for (const P of Bs) {
      const next = [];
      for (const a of acc) for (const r of _subtractChainFromBranch(a, P)) next.push(r);
      acc = next;
      if (acc.length > RGN_BRANCH_CAP * 4) {
        _crashApproachB('subtract', { projected: acc.length });
      }
    }
    return acc;
  }
  function _combineRgn(mode, A, B) {
    // mode: 1=AND, 2=OR, 3=XOR, 4=DIFF, 5=COPY
    if (mode === 5) return _cloneRgn(A);
    if (mode === 1) {
      // cross product
      const branches = [];
      for (const a of A.branches) for (const b of B.branches) branches.push([...a, ...b]);
      if (branches.length > RGN_BRANCH_CAP) {
        _crashApproachB('AND', { src1: A, src2: B, projected: branches.length });
      }
      const bbox = _bboxIntersect(A.bbox, B.bbox);
      return {
        type: 'region', branches, bbox, simpleRect: null,
        rects: [{ x: bbox.l, y: bbox.t, w: bbox.r - bbox.l, h: bbox.b - bbox.t }],
      };
    }
    if (mode === 4) {
      // A \ B = ⋃_a (a \ B.branches)
      const branches = [];
      for (const a of A.branches) for (const r of _subtractBranchesFromBranch(a, B.branches)) branches.push(r);
      if (branches.length > RGN_BRANCH_CAP) {
        _crashApproachB('DIFF', { src1: A, src2: B, projected: branches.length });
      }
      return {
        type: 'region', branches, bbox: { ...A.bbox }, simpleRect: null,
        rects: [{ x: A.bbox.l, y: A.bbox.t, w: A.bbox.r - A.bbox.l, h: A.bbox.b - A.bbox.t }],
      };
    }
    if (mode === 2) {
      // OR: A ⋃ (B \ A) — disjoint by subtracting prior
      const branches = A.branches.map(ch => ch.slice());
      for (const b of B.branches) {
        const subs = _subtractBranchesFromBranch(b, branches);
        for (const s of subs) branches.push(s);
        if (branches.length > RGN_BRANCH_CAP) {
          _crashApproachB('OR', { src1: A, src2: B, projected: branches.length });
        }
      }
      const bbox = _bboxUnion(A.bbox, B.bbox);
      return {
        type: 'region', branches, bbox, simpleRect: null,
        rects: [{ x: bbox.l, y: bbox.t, w: bbox.r - bbox.l, h: bbox.b - bbox.t }],
      };
    }
    if (mode === 3) {
      // XOR = OR(DIFF(A,B), DIFF(B,A))
      const aMinusB = _combineRgn(4, A, B);
      const bMinusA = _combineRgn(4, B, A);
      return _combineRgn(2, aMinusB, bMinusA);
    }
    return _cloneRgn(A);
  }
  // Apply a canvas-level clip that excludes every visible child of `hwnd`
  // from the draw target. Our renderer has no per-child surfaces: children
  // paint into the parent's back-canvas, so a parent-level FillRect/BitBlt
  // without this exclusion overwrites children with no way to restore them.
  //
  // Also excludes non-descendant "cousin" windows in the same top-level tree
  // whose zOrder is higher than hwnd's — those were painted more recently on
  // the shared back-canvas and must not be clobbered. Typical case: MSPaint's
  // CPBView inside MDIClient painting over the frame-level Tools/Colors
  // palettes that sit at the same back-canvas but are not MDI descendants.
  //
  // Returns true if anything was clipped (caller must c.restore()).
  function _excludeChildrenClip(t, hwnd) {
    if (!hwnd || !ctx.renderer) return false;
    const we = ctx.renderer.wasm && ctx.renderer.wasm.exports;
    if (!we || !we.wnd_next_child_slot || !we.wnd_slot_hwnd || !we.ctrl_get_xy || !we.ctrl_get_wh) return false;
    // Walk WAT's WND_RECORDS (source of truth — renderer.windows only
    // tracks top-level + owner-draw buttons, not generic child controls).
    // CONTROL_GEOM stores child positions as parent-CLIENT-local; convert
    // to t-local the same way the cousin loop below does (via back-canvas-
    // local − t.ox/t.oy) so clipping matches where the child will paint.
    const _topHwndKids = _resolveTopHwnd(hwnd);
    const _topWinKids = ctx.renderer.windows && ctx.renderer.windows[_topHwndKids];
    let _parentBx = 0, _parentBy = 0;
    if (_topWinKids && _topWinKids.clientRect) {
      _parentBx = _topWinKids.clientRect.x - _topWinKids.x;
      _parentBy = _topWinKids.clientRect.y - _topWinKids.y;
    }
    {
      let cur = hwnd;
      for (let i = 0; i < 64; i++) {
        const w2 = ctx.renderer.windows && ctx.renderer.windows[cur];
        if (!w2 || !w2.isChild) break;
        _parentBx += w2.x | 0; _parentBy += w2.y | 0;
        cur = w2.parentHwnd >>> 0;
        if (!cur) break;
      }
    }
    // WS_CLIPCHILDREN (0x02000000) gates child exclusion: when set, GDI
    // clips parent paints away from child windows. Without it, the parent
    // is allowed to draw into its children (e.g. mspaint's CToolBar paints
    // each tool icon into its child button via the toolbar's own DC), and
    // excluding the children makes the icons disappear.
    const hwndStyle = (we.wnd_get_style ? we.wnd_get_style(hwnd) : 0) >>> 0;
    const clipChildren = (hwndStyle & 0x02000000) !== 0;
    const kids = [];
    const _walk1Raw = [];
    let slot = 0;
    for (let i = 0; i < 256; i++) {
      const next = we.wnd_next_child_slot(hwnd, slot) | 0;
      if (next < 0) break;
      const ch = we.wnd_slot_hwnd(next) >>> 0;
      slot = next + 1;
      if (!ch) continue;
      const xy = we.ctrl_get_xy(ch) >>> 0;
      const wh = we.ctrl_get_wh(ch) >>> 0;
      const cx = xy & 0xFFFF, cy = (xy >>> 16) & 0xFFFF;
      const cwidth = wh & 0xFFFF, cheight = (wh >>> 16) & 0xFFFF;
      if (_trace.has('clip')) _walk1Raw.push(`${_hex(ch)}@(${cx},${cy} ${cwidth}x${cheight})`);
      if (cwidth <= 0 || cheight <= 0) continue;
      if (!clipChildren) continue;
      kids.push({ x: _parentBx + cx - t.ox, y: _parentBy + cy - t.oy, w: cwidth, h: cheight });
    }
    if (_trace.has('clip')) {
      console.log(`[clip] hwnd=${_hex(hwnd)} style=${_hex(hwndStyle)} clipChildren=${clipChildren} walk1: ${_walk1Raw.length ? _walk1Raw.join(' ') : '(none)'}`);
    }
    // Cousin exclusion: walk renderer.windows for every window with higher
    // zOrder that lives under the same top-level and is NOT an ancestor or
    // descendant of hwnd. Convert each to back-canvas-local coords (top-
    // level-local) — that matches t's coord system for non-chrome draws.
    const r = ctx.renderer;
    const me = r.windows && r.windows[hwnd];
    const topHwnd = _resolveTopHwnd(hwnd);
    const topWin = r.windows && r.windows[topHwnd];
    if (me && topWin) {
      const myZ = me.zOrder | 0;
      // Build ancestor set for hwnd (so we never clip things containing it).
      const ancestors = new Set();
      let a = hwnd;
      while (a) {
        ancestors.add(a >>> 0);
        const w = r.windows[a];
        if (!w || !w.isChild) break;
        a = w.parentHwnd >>> 0;
      }
      // Descendant test: walk up from candidate via WAT's parent chain
      // (renderer.windows tracks isChild only for top-level + owner-draw,
      // so child controls show isChild=false there even though WAT knows
      // their real parent). True if we hit hwnd before top.
      const isDescendantOf = (cand) => {
        let x = cand >>> 0;
        for (let i = 0; i < 64 && x; i++) {
          const p = (we.wnd_get_parent ? we.wnd_get_parent(x) : 0) >>> 0;
          if (!p) {
            const w = r.windows[x];
            if (!w || !w.isChild) return false;
            x = w.parentHwnd >>> 0;
          } else {
            x = p;
          }
          if ((x >>> 0) === (hwnd >>> 0)) return true;
        }
        return false;
      };
      // Descendants are only auto-clipped when hwnd has WS_CLIPCHILDREN.
      // Without it (e.g. mspaint's CToolBar parent), the parent is allowed
      // to paint into its children's screen area (tool-icon glyphs blitted
      // via the toolbar's own DC).
      for (const k of Object.keys(r.windows)) {
        const cand = parseInt(k) >>> 0;
        if (cand === (hwnd >>> 0)) continue;
        if (ancestors.has(cand)) continue;
        const cw = r.windows[cand];
        if (!cw || !cw.visible) continue;
        if (_resolveTopHwnd(cand) !== topHwnd) continue;
        // Descendants of the top-level hwnd are always clipped
        // (WS_CLIPCHILDREN: focus events can promote the parent's zOrder
        // above its kids, so a `zOrder <= myZ` guard would drop them and
        // an unclipped fillRect would wipe the kids' regions).
        // Cousins/siblings: clipped only if their zOrder is above us.
        const isDesc = isDescendantOf(cand);
        if (isDesc && !clipChildren) continue;
        const desc = clipChildren && isDesc;
        if (!desc && (cw.zOrder | 0) <= myZ) continue;
        // Back-canvas-local rect of cand. Children x/y are parent-CLIENT-
        // local, so walking the chain summing x/y gives an offset in the
        // top-level's CLIENT coords; add the top's client-origin-within-
        // back-canvas to land in back-canvas-local space.
        let sx = 0, sy = 0, cur = cand, ok = true;
        for (let i = 0; i < 64; i++) {
          const w2 = r.windows[cur];
          if (!w2) { ok = false; break; }
          if (!w2.isChild) break;
          sx += w2.x | 0; sy += w2.y | 0;
          cur = w2.parentHwnd >>> 0;
          if (!cur) { ok = false; break; }
        }
        if (!ok) continue;
        const topOrig = _getClientOrigin(topHwnd);
        const w = cw.w | 0, h = cw.h | 0;
        if (w <= 0 || h <= 0) continue;
        const bx = sx + topOrig.x;
        const by = sy + topOrig.y;
        // _excludeChildrenClip builds the exclusion in the t's coord system,
        // where kids use window-local coords (applied with translate(ox,oy)).
        // Convert back-canvas-local → t-local by subtracting t.ox/t.oy.
        kids.push({ x: bx - t.ox, y: by - t.oy, w, h });
      }
    }
    if (_trace.has('clip')) {
      const me2 = ctx.renderer.windows && ctx.renderer.windows[hwnd];
      console.log(`[clip] hwnd=${_hex(hwnd)} myZ=${me2 ? (me2.zOrder|0) : '?'} t.ox=${t.ox} t.oy=${t.oy} kids=${kids.length}`,
        kids.slice(0, 12).map(k => `(${k.x},${k.y} ${k.w}x${k.h})`).join(' '));
    }
    if (!kids.length) {
      if (_trace.has('clip')) console.log(`[clip] hwnd=${_hex(hwnd)} no kids → no clip applied`);
      return false;
    }
    // Drop fully-contained rects as a cover-size optimization (a contained
    // inner rect is redundant — the outer already subtracts that area).
    const filtered = [];
    const contains = (a, b) => a.x <= b.x && a.y <= b.y
      && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
    outer: for (let i = 0; i < kids.length; i++) {
      for (let j = 0; j < kids.length; j++) {
        if (i !== j && contains(kids[j], kids[i]) && !(contains(kids[i], kids[j]) && j < i)) {
          continue outer;
        }
      }
      filtered.push(kids[i]);
    }
    // Build a non-overlapping cover = (outer minus union-of-filtered) via
    // rect subtraction. Each kid splits each surviving cover-rect into up
    // to 4 disjoint sub-rects, so the final clip path is a set of
    // non-overlapping rectangles — `nonzero` is exact regardless of how
    // the original kids overlapped.
    const c = t.ctx;
    c.save();
    const cw = t.canvas.width, ch = t.canvas.height;
    let cover = [{ x: -t.ox, y: -t.oy, w: cw, h: ch }];
    const subtract = (r, h) => {
      const ix0 = Math.max(r.x, h.x), iy0 = Math.max(r.y, h.y);
      const ix1 = Math.min(r.x + r.w, h.x + h.w), iy1 = Math.min(r.y + r.h, h.y + h.h);
      if (ix0 >= ix1 || iy0 >= iy1) return [r];
      const out = [];
      if (r.y < iy0)       out.push({ x: r.x, y: r.y, w: r.w,               h: iy0 - r.y });
      if (iy1 < r.y + r.h) out.push({ x: r.x, y: iy1, w: r.w,               h: r.y + r.h - iy1 });
      if (r.x < ix0)       out.push({ x: r.x, y: iy0, w: ix0 - r.x,         h: iy1 - iy0 });
      if (ix1 < r.x + r.w) out.push({ x: ix1, y: iy0, w: r.x + r.w - ix1,   h: iy1 - iy0 });
      return out;
    };
    for (const k of filtered) {
      const next = [];
      for (const r of cover) for (const s of subtract(r, k)) next.push(s);
      cover = next;
      if (cover.length > 1024) break;
    }
    if (_trace.has('clip')) {
      console.log(`[clip] hwnd=${_hex(hwnd)} cover=${cover.length}`,
        cover.slice(0, 8).map(r => `(${r.x},${r.y} ${r.w}x${r.h})`).join(' '));
    }
    c.beginPath();
    for (const r of cover) c.rect(r.x, r.y, r.w, r.h);
    c.translate(t.ox, t.oy);
    c.clip('nonzero');
    c.translate(-t.ox, -t.oy);
    return true;
  }

  function _drawWithClip(hdc, drawFn) {
    const t = _getDrawTarget(hdc);
    if (!t) return false;
    const dc = _dcState[hdc];
    const acd = ctx.renderer && ctx.renderer._activeChildDraw;
    // When drawing through _activeChildDraw (menu overlay, child control
    // composite), the dc's clipRgn was set for the window's back-canvas
    // coordinate system — applying it to a different target (e.g. the
    // full-screen dropdown overlay) mis-clips the output.
    const hwndForClip = (acd && _hwndFromDC(hdc) === acd.hwnd) ? 0 : _hwndFromDC(hdc);
    const rgn = (acd && _hwndFromDC(hdc) === acd.hwnd) ? null : (dc && dc.clipRgn);
    if (!rgn) {
      const excluded = _excludeChildrenClip(t, hwndForClip);
      try { drawFn(t); } finally { if (excluded) t.ctx.restore(); }
      return true;
    }
    const c = t.ctx;
    if (rgn.simpleRect) {
      c.save();
      c.beginPath();
      const r = rgn.simpleRect;
      c.rect(r.l + t.ox, r.t + t.oy, r.r - r.l, r.b - r.t);
      c.clip();
      const excluded = _excludeChildrenClip(t, hwndForClip);
      try { drawFn(t); } finally { if (excluded) c.restore(); c.restore(); }
      return true;
    }
    for (const chain of rgn.branches) {
      c.save();
      try {
        c.translate(t.ox, t.oy);
        if (_STUB_PATH2D) {
          // Node CLI: Path2D is a no-op stub (see top of file). Rebuild the
          // clip using native c.rect() subpaths so polarity=-1 (rect
          // subtraction) actually carves a hole, and clamp rect coords to
          // the canvas — cairo silently ignores rects spanning ~2^31, so the
          // universal (-INT..+INT) rect produced by `_combineRgn(4, ...)`
          // must be clipped down. Non-rect entries (ellipse/polygon) lose
          // precision and fall back to their bbox.
          const cw = t.canvas.width, ch = t.canvas.height;
          const cLeft = -t.ox, cTop = -t.oy;
          const cRight = cLeft + cw, cBot = cTop + ch;
          const clampRect = (x, y, w, h) => {
            const l = Math.max(x, cLeft), tp = Math.max(y, cTop);
            const r = Math.min(x + w, cRight), b = Math.min(y + h, cBot);
            return { x: l, y: tp, w: Math.max(0, r - l), h: Math.max(0, b - tp) };
          };
          for (const e of chain) {
            const rr = e.path && e.path._rectXYWH;
            c.beginPath();
            if (e.polarity > 0) {
              const q = rr ? clampRect(rr.x, rr.y, rr.w, rr.h)
                           : { x: cLeft, y: cTop, w: cw, h: ch };
              c.rect(q.x, q.y, q.w, q.h);
              c.clip('nonzero');
            } else {
              // Canvas rect XOR inner rect → ring (under evenodd).
              c.rect(cLeft, cTop, cw, ch);
              if (rr) {
                const q = clampRect(rr.x, rr.y, rr.w, rr.h);
                if (q.w > 0 && q.h > 0) c.rect(q.x, q.y, q.w, q.h);
              }
              c.clip('evenodd');
            }
          }
        } else {
          for (const { path, rule, polarity } of chain) {
            if (polarity > 0) {
              c.clip(path, rule);
            } else {
              const cw = t.canvas.width, ch = t.canvas.height;
              const notPath = new Path2D();
              notPath.rect(-t.ox, -t.oy, cw, ch);
              notPath.addPath(path);
              c.clip(notPath, 'evenodd');
            }
          }
        }
        c.translate(-t.ox, -t.oy);
        const excluded = _excludeChildrenClip(t, hwndForClip);
        try { drawFn(t); } finally { if (excluded) c.restore(); }
      } finally { c.restore(); }
    }
    return true;
  }
  // Back-compat: some legacy callsites still use _applyClip(hdc, ctx). For
  // those, fall back to bbox clipping (loses precision but correct).
  const _applyClip = (hdc, c) => {
    const dc = _dcState[hdc];
    const rgn = dc && dc.clipRgn;
    if (!rgn) return false;
    if (rgn.simpleRect) {
      c.save(); c.beginPath();
      const r = rgn.simpleRect;
      c.rect(r.l, r.t, r.r - r.l, r.b - r.t);
      c.clip();
      return true;
    }
    // Fallback: bbox-only (good enough for selectedBitmap path; full path uses _drawWithClip)
    c.save(); c.beginPath();
    const bb = rgn.bbox;
    c.rect(bb.l, bb.t, bb.r - bb.l, bb.b - bb.t);
    c.clip();
    return true;
  };

  // Rebuild bmp.pixels + bmp.canvas from the live guest DIB memory. Called on BitBlt/StretchBlt
  // source resolution so guest-side in-place pixel writes become visible to the renderer.
  // Skip when guest memory hasn't changed since last sync (sampled hash) — otherwise apps
  // that draw into a DIB section's DC via GDI would have their canvas wiped by the all-zero
  // guest buffer on every subsequent blit.
  const _syncDibSection = (bmp) => {
    if (!bmp || !bmp.dibSection) return;
    const { w, h, bpp, lpBitsWa, palette } = bmp;
    const mem = new Uint8Array(ctx.getMemory());
    const rowBytes = ((w * bpp + 31) >> 5) << 2; // DWORD-aligned
    const totalBytes = rowBytes * h;
    // Sparse hash: ~256 sample bytes spread across the buffer. Cheap enough per blit,
    // catches any meaningful pixel mutation from guest-side direct writes.
    let hash = 0 | 0;
    const step = Math.max(1, (totalBytes / 256) | 0);
    for (let off = 0; off < totalBytes; off += step) {
      hash = (Math.imul(hash, 31) + mem[lpBitsWa + off]) | 0;
    }
    if (bmp._syncedOnce && bmp._lastSyncHash === hash) return;
    bmp._syncedOnce = true;
    bmp._lastSyncHash = hash;
    const pixels = bmp.pixels || (bmp.pixels = new Uint8Array(w * h * 4));
    const bottomUp = bmp.bottomUp !== false;
    for (let y = 0; y < h; y++) {
      const srcY = bottomUp ? (h - 1 - y) : y;
      const rowBase = lpBitsWa + srcY * rowBytes;
      for (let x = 0; x < w; x++) {
        const di = (y * w + x) * 4;
        if (bpp === 8) {
          const idx = mem[rowBase + x];
          const c = palette && palette[idx];
          if (c) { pixels[di] = c[0]; pixels[di+1] = c[1]; pixels[di+2] = c[2]; }
          else { pixels[di] = pixels[di+1] = pixels[di+2] = idx; }
        } else if (bpp === 24) {
          const si = rowBase + x * 3;
          pixels[di] = mem[si+2]; pixels[di+1] = mem[si+1]; pixels[di+2] = mem[si];
        } else if (bpp === 32) {
          const si = rowBase + x * 4;
          pixels[di] = mem[si+2]; pixels[di+1] = mem[si+1]; pixels[di+2] = mem[si];
        } else if (bpp === 16) {
          const si = rowBase + x * 2;
          const v = mem[si] | (mem[si+1] << 8);
          // RGB565 assumed (most common for 16bpp DIB sections)
          pixels[di]   = ((v >> 11) & 0x1F) * 255 / 31 | 0;
          pixels[di+1] = ((v >> 5)  & 0x3F) * 255 / 63 | 0;
          pixels[di+2] = ( v        & 0x1F) * 255 / 31 | 0;
        } else if (bpp === 4) {
          const byte = mem[rowBase + (x >> 1)];
          const nib = (x & 1) ? (byte & 0xF) : ((byte >> 4) & 0xF);
          const c = palette && palette[nib];
          if (c) { pixels[di] = c[0]; pixels[di+1] = c[1]; pixels[di+2] = c[2]; }
        } else if (bpp === 1) {
          const byte = mem[rowBase + (x >> 3)];
          const bit = (byte >> (7 - (x & 7))) & 1;
          const c = palette && palette[bit];
          if (c) { pixels[di] = c[0]; pixels[di+1] = c[1]; pixels[di+2] = c[2]; }
          else { pixels[di] = pixels[di+1] = pixels[di+2] = bit ? 255 : 0; }
        }
        pixels[di+3] = 255;
      }
    }
    if (bmp.canvas) {
      const bc = bmp.canvas.getContext('2d');
      const imgData = bc.createImageData(w, h);
      imgData.data.set(pixels);
      bc.putImageData(imgData, 0, 0);
    }
  };

  // putImageData that respects canvas clip (uses temp canvas + drawImage)
  const _clippedPut = (targetCtx, imgData, x, y) => {
    const tmp = _createOffscreen(imgData.width, imgData.height);
    if (tmp) {
      tmp.getContext('2d').putImageData(imgData, 0, 0);
      targetCtx.drawImage(tmp, x, y);
    } else {
      targetCtx.putImageData(imgData, x, y); // fallback
    }
  };

  // Clip canvas to exclude windows above the given hwnd, run fn, restore
  const _withZClip = (hwnd, fn) => {
    if (!ctx.renderer || !hwnd) return fn();
    const rects = ctx.renderer.getOccludingRects(hwnd);
    if (rects.length === 0) return fn();
    const c = ctx.renderer.ctx;
    c.save();
    c.beginPath();
    c.rect(0, 0, ctx.renderer.canvas.width, ctx.renderer.canvas.height);
    for (const r of rects) {
      c.rect(r.x + r.w, r.y, -r.w, r.h);
    }
    c.clip('evenodd');
    const result = fn();
    c.restore();
    return result;
  };

  // Returns the client origin for screen-space drawing (used by erase_background
  // and other functions that need screen coords for the display canvas).
  const _getClientOriginScreen = (hwnd) => {
    const r = ctx.renderer;
    if (!r) return { x: 0, y: 0 };
    const win = r.windows[hwnd];
    if (!win) return { x: 0, y: 0 };
    if (win.isChild && win.parentHwnd) {
      const parentOrigin = _getClientOriginScreen(win.parentHwnd);
      return { x: parentOrigin.x + win.x, y: parentOrigin.y + win.y };
    }
    let cy = win.y + 3;
    if (win.style & 0x00C00000) cy += 19;
    if (r._hasMenuBar(win)) cy += 18;
    return { x: win.x + 3, y: cy + 1 };
  };

  // For GDI drawing: top-level windows draw at (0,0) on their offscreen canvas.
  // Child windows offset by their position within the parent's client area.
  const _getClientOrigin = (hwnd) => {
    const r = ctx.renderer;
    if (!r) return { x: 0, y: 0 };
    const win = r.windows[hwnd];
    if (!win) return { x: 0, y: 0 };
    if (win.isChild && win.parentHwnd) {
      return { x: win.x, y: win.y };
    }
    // Top-level: return chrome offset within the full-window back canvas
    if (win.clientRect) {
      return { x: win.clientRect.x - win.x, y: win.clientRect.y - win.y };
    }
    return { x: 0, y: 0 };
  };

  const _env = (typeof process !== 'undefined' && process.env) ? process.env : {};
  const host = {
    // --- Logging (override for tracing/UI) ---
    log: () => {},
    log_i32: (v) => { if (_env.DBG_INV) console.log('[LOG_I32]', '0x' + (v >>> 0).toString(16), v); },
    log_api_exit: () => {},
    log_block: () => {},

    // --- DirectX internal tracing hook (--trace-dx) ---
    // WAT calls this from Lock/Unlock/Blt/SetEntries/dx_present/Flip. Kept as
    // a no-op by default; replaced below if 'dx' is in the trace category set.
    dx_trace: () => {},

    // --- DDraw surface DC ↔ canvas sync (called from WAT GetDC/ReleaseDC) ---
    // dir: 0=DIB→canvas (seed canvas at GetDC), 1=canvas→DIB (commit at ReleaseDC).
    dx_surface_sync: (slot, dir) => {
      if (dir === 0) _dibToSurfaceCanvas(slot);
      else if (dir === 1) _surfaceCanvasToDib(slot);
    },

    // --- Crash/debug ---
    crash_unimplemented: (namePtr, esp, eip, ebp) => {
      const name = readStr(namePtr, 128);
      const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
      console.error(`\n=== UNIMPLEMENTED API: ${name || '(null/ordinal)'} ===`);
      console.error(`  EIP: ${hex(eip)}  ESP: ${hex(esp)}  EBP: ${hex(ebp)}`);
      if (ctx.exports) {
        const e = ctx.exports;
        console.error(`  EAX: ${hex(e.get_eax())}  ECX: ${hex(e.get_ecx())}  EDX: ${hex(e.get_edx())}  EBX: ${hex(e.get_ebx())}`);
        console.error(`  ESI: ${hex(e.get_esi())}  EDI: ${hex(e.get_edi())}`);
        const imageBase = e.get_image_base();
        const g2w = addr => addr - imageBase + 0x12000;
        const dv = new DataView(e.memory.buffer);
        console.error('  Stack:');
        for (let i = 0; i < 16; i++) {
          const addr = esp + i * 4;
          const val = dv.getUint32(g2w(addr), true);
          console.error(`    [${hex(addr)}] = ${hex(val)}${i === 0 ? '  <- ret addr' : ''}`);
        }
      }
      console.error('  FATAL: implement this API');
    },

    // --- System ---
    get_screen_size: () => {
      const r = ctx.renderer;
      const w = r ? r.canvas.width : 640;
      const h = r ? r.canvas.height : 480;
      return (w & 0xFFFF) | ((h & 0xFFFF) << 16);
    },
    // Window property store for GetPropA/SetPropA
    show_find_dialog: (dlgHwnd, ownerHwnd, frGuestAddr) => {
      // Bare log only — the WAT side ($create_findreplace_dialog) drives
      // all renderer state via host_register_dialog_frame. The
      // [FindTextA] log line is the existing test gate's anchor.
      console.log(`[FindTextA] hwnd=0x${dlgHwnd.toString(16)} owner=0x${ownerHwnd.toString(16)} fr=0x${frGuestAddr.toString(16)}`);
      return dlgHwnd;
    },
    shell_about: (dlgHwnd, ownerHwnd, appPtr) => {
      console.log(`[ShellAbout] dlg=0x${dlgHwnd.toString(16)} owner=0x${ownerHwnd.toString(16)} "${readStr(appPtr)}"`);
      return 1;
    },
    shell_execute: (hwnd, opWa, fileWa, paramsWa, dirWa, nShow) => {
      const op = opWa ? readStr(opWa) : 'open';
      const file = fileWa ? readStr(fileWa) : '';
      const params = paramsWa ? readStr(paramsWa) : '';
      console.log(`[ShellExecute] hwnd=0x${hwnd.toString(16)} op="${op}" file="${file}" params="${params}"`);
      // Browser: try to open links in new tab
      if (typeof window !== 'undefined' && file.startsWith('http')) {
        window.open(file, '_blank');
        return 33;
      }
      return 33; // Success
    },
    // Open / Save dialog web hooks. Default impls are headless no-ops:
    // - has_dom() returns 0, so $create_open_dialog skips the upload/
    //   download buttons in test/render-png contexts.
    // - pick_file_upload / file_download are unreachable from headless
    //   tests but defined as no-ops for safety in case has_dom is overridden.
    // The browser host (host.js) overrides all three with real DOM impls.
    has_dom: () => 0,
    pick_file_upload: (dlgHwnd, destDirWa) => { /* headless no-op */ },
    file_download: (pathWa) => { /* headless no-op */ },

    // WAT-driven dialog frame registration. Called from $create_about_dialog
    // (and any future $create_xxx_dialog) — JS adds a renderer.windows[]
    // entry but does no Win32 logic. The dialog children come from
    // $ctrl_create_child and are walked via _drawWatChildren during paint.
    //
    //   kind bit 0 = isAboutDialog (modal block flag)
    //   kind bit 1 = isFindDialog
    //   kind bit 2 = isPopup (WS_POPUP — no caption/border chrome, drawn at win.x/win.y)
    register_dialog_frame: (dlgHwnd, ownerHwnd, titleWa, w, h, kind) => {
      const r = typeof ctx.renderer === 'function' ? ctx.renderer() : ctx.renderer;
      if (!r) return;
      const title = readStr(titleWa);
      const parentWin = r.windows[ownerHwnd];
      const px = parentWin ? parentWin.x : 0;
      const py = parentWin ? parentWin.y : 0;
      const isPopup = !!(kind & 4);
      r.windows[dlgHwnd] = {
        hwnd: dlgHwnd, style: isPopup ? 0x80000000 : 0x80C80000, title,
        x: px + 40, y: py + 40, w, h,
        visible: !isPopup, isChild: false, menu: null, controls: [],
        isDialog: !isPopup,
        isAboutDialog: !!(kind & 1),
        isFindDialog:  !!(kind & 2),
        isPopup,
        hasCaption: !isPopup,
        ownerHwnd, zOrder: r._nextZ + (isPopup ? 1000000 : 0),
        wasm: r.wasm, wasmMemory: r.wasmMemory,
      };
      r._nextZ++;
      // Populate clientRect so WAT can call host_erase_background right after
      // registration to fill the back-canvas with COLOR_BTNFACE.
      r._computeClientRect(r.windows[dlgHwnd]);
      r.invalidate(dlgHwnd);
    },
    message_box: (hWnd, textPtr, captionPtr, uType) => {
      console.log(`[MessageBox] "${readStr(captionPtr)}": "${readStr(textPtr)}"`);
      return 1;
    },
    exit: (code) => {
      console.log('[Exit] code=' + code);
      if (ctx.onExit) ctx.onExit(code);
    },
    message_beep: (uType) => {
      // Play a system beep using Web Audio API or AudioContext
      if (typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined') {
        try {
          const AC = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
          const audioCtx = new AC();
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          // Map uType to frequency: 0x10=error(200Hz), 0x30=warning(400Hz), 0x40=info(600Hz), default=800Hz
          const freqMap = { 0x10: 200, 0x20: 300, 0x30: 400, 0x40: 600 };
          osc.frequency.value = freqMap[uType] || 800;
          osc.type = 'square';
          gain.gain.value = 0.1;
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start();
          osc.stop(audioCtx.currentTime + 0.15);
        } catch (_) {}
      }
    },
    play_sound: (wasmPtr, length) => {
      // Play WAV data from WASM memory using Web Audio API
      if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return;
      try {
        const AC = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
        if (!ctx._audioCtx) ctx._audioCtx = new AC();
        const audioCtx = ctx._audioCtx;
        // Copy WAV data from WASM memory
        const wavData = new Uint8Array(ctx.getMemory(), wasmPtr, length).slice();
        audioCtx.decodeAudioData(wavData.buffer).then(audioBuffer => {
          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioCtx.destination);
          source.start();
        }).catch(() => {});
      } catch (_) {}
    },
    get_ticks: () => Date.now() & 0x7FFFFFFF,
    yield: (reason) => { /* no-op in CLI — browser host can use this to pause */ },

    // ---- Unified voice audio bridge ----
    // Both waveOut (stream submit) and DSOUND (snapshot/loop) sit on top of a
    // single VoiceManager. Each voice = one mixer slot with format + gain/pan/rate
    // + connection to the shared AudioContext destination.
    //   wave_out_*       → voice in STREAM mode (queued one-shots, no random write)
    //   IDirectSoundBuffer_* → voice in SNAPSHOT mode (Play() captures the guest
    //                          ring at that moment, optionally looped)
    // Streaming-music DSOUND (write-during-play) isn't supported yet — would need
    // a real AudioWorklet ring; no current test binary exercises it.
    voice_open: (sampleRate, channels, bitsPerSample) => {
      return ctx._voices.open(sampleRate, channels, bitsPerSample);
    },
    voice_write_stream: (id, pcmDataWA, byteLength) => {
      ctx._voices.writeStream(id, pcmDataWA, byteLength);
      return 0;
    },
    voice_play_ring: (id, pcmDataWA, byteLength, startOffset, loop) => {
      ctx._voices.playRing(id, pcmDataWA, byteLength, startOffset, loop);
      return 0;
    },
    voice_stop: (id) => { ctx._voices.stop(id); return 0; },
    voice_close: (id) => { ctx._voices.close(id); return 0; },
    voice_get_pos: (id) => ctx._voices.getPos(id),
    voice_set_volume_linear: (id, vol_0_65535) => {
      ctx._voices.setGain(id, Math.max(0, Math.min(1, vol_0_65535 / 65535)));
    },
    voice_set_volume_db: (id, centibels) => {
      // DSOUND attenuation: 0 = full, -10000 = silent. Linear = 10^(cB/2000).
      const cB = Math.max(-10000, Math.min(0, centibels | 0));
      ctx._voices.setGain(id, Math.pow(10, cB / 2000));
    },
    voice_set_pan: (id, centibels) => {
      // DSOUND pan: -10000 = full left, +10000 = full right. Linear in [-1, 1].
      const cB = Math.max(-10000, Math.min(10000, centibels | 0));
      ctx._voices.setPan(id, cB / 10000);
    },
    voice_set_freq: (id, hz) => { ctx._voices.setFreq(id, hz | 0); },

    // ---- waveOut compatibility shims (wrap a single STREAM voice) ----
    wave_out_open: (sampleRate, channels, bitsPerSample, callbackType) => {
      const id = ctx._voices.open(sampleRate, channels, bitsPerSample);
      console.log(`[waveOut] open: ${sampleRate}Hz ${channels}ch ${bitsPerSample}bit -> voice#${id}`);
      // Capture format for an optional WAV-header finalize at exit.
      ctx._audioOutFormat = { rate: sampleRate, ch: channels, bits: bitsPerSample };
      return id;
    },
    wave_out_write: (handle, pcmDataWA, byteLength) => {
      ctx._voices.writeStream(handle, pcmDataWA, byteLength);
      // Optional raw PCM dump for offline test inspection
      if (ctx._audioOutFd !== undefined) {
        try {
          const buf = Buffer.from(ctx.getMemory(), pcmDataWA, byteLength);
          require('fs').writeSync(ctx._audioOutFd, buf);
          ctx._audioOutBytes = (ctx._audioOutBytes || 0) + byteLength;
        } catch (_) {}
      }
      return 0;
    },
    wave_out_close: (handle) => {
      console.log(`[waveOut] close voice#${handle}`);
      ctx._voices.close(handle);
      return 0;
    },
    wave_out_get_pos: (handle) => ctx._voices.getPos(handle),
    wave_out_set_volume: (handle, volume) => {
      ctx._voices.setGain(handle, Math.max(0, Math.min(1, volume / 65535)));
    },

    resolve_ordinal: (dllNameWA, ordinal) => {
      const dllName = readStr(dllNameWA).toUpperCase();
      const key = dllName + '#' + ordinal;
      // Shell32 ordinal exports (undocumented Win9x APIs)
      const ORDINAL_MAP = {
        'SHELL32.DLL#2': 'SHChangeNotifyRegister',
        'SHELL32.DLL#4': 'SHChangeNotifyDeregister',
        'SHELL32.DLL#60': 'ExitWindowsDialog',
        'SHELL32.DLL#61': 'RunFileDlg',
        'SHELL32.DLL#62': 'PickIconDlg',
        'SHELL32.DLL#63': 'GetFileNameFromBrowse',
        'SHELL32.DLL#71': 'IsLFNDriveA',
        'SHELL32.DLL#152': 'SHGetSpecialFolderLocation',
        'SHELL32.DLL#165': 'SHGetPathFromIDListA',
        'SHELL32.DLL#167': 'SHBrowseForFolderA',
        'SHELL32.DLL#181': 'RegisterShellHook',
        'SHELL32.DLL#184': 'ArrangeWindows',
        'SHELL32.DLL#232': 'SHFileOperationA',
        'SHELL32.DLL#640': 'NTSHChangeNotifyRegister',
        // COMCTL32 ordinal exports (named ones have low ordinals)
        'COMCTL32.DLL#2': 'MenuHelp',
        'COMCTL32.DLL#3': 'ShowHideMenuCtl',
        'COMCTL32.DLL#4': 'GetEffectiveClientRect',
        'COMCTL32.DLL#5': 'DrawStatusTextA',
        'COMCTL32.DLL#6': 'CreateStatusWindowA',
        'COMCTL32.DLL#7': 'CreateToolbar',
        'COMCTL32.DLL#8': 'CreateMappedBitmap',
        'COMCTL32.DLL#17': 'InitCommonControls',
        // COMCTL32 internal heap (ordinal-only)
        'COMCTL32.DLL#71': 'Comctl32_Alloc',
        'COMCTL32.DLL#72': 'Comctl32_ReAlloc',
        'COMCTL32.DLL#73': 'Comctl32_Free',
        'COMCTL32.DLL#74': 'Comctl32_GetSize',
        // COMCTL32 DSA/DPA utility (ordinal-only)
        'COMCTL32.DLL#320': 'DSA_Create',
        'COMCTL32.DLL#321': 'DSA_Destroy',
        'COMCTL32.DLL#322': 'DSA_GetItem',
        'COMCTL32.DLL#323': 'DSA_GetItemPtr',
        'COMCTL32.DLL#324': 'DSA_InsertItem',
        'COMCTL32.DLL#326': 'DSA_DeleteItem',
        'COMCTL32.DLL#328': 'DPA_Create',
        'COMCTL32.DLL#329': 'DPA_Destroy',
        'COMCTL32.DLL#332': 'DPA_GetPtr',
        'COMCTL32.DLL#334': 'DPA_InsertPtr',
        'COMCTL32.DLL#336': 'DPA_DeletePtr',
        'COMCTL32.DLL#337': 'DPA_DeleteAllPtrs',
        // COMCTL32 string utilities (ordinal-only, later in shlwapi)
        'COMCTL32.DLL#350': 'StrChrA',
        'COMCTL32.DLL#357': 'StrToIntA',
        // Named exports at higher ordinals
        'COMCTL32.DLL#84': 'InitCommonControlsEx',
        // WSOCK32 ordinal exports
        'WSOCK32.DLL#1': 'accept',
        'WSOCK32.DLL#2': 'bind',
        'WSOCK32.DLL#3': 'closesocket',
        'WSOCK32.DLL#4': 'connect',
        'WSOCK32.DLL#5': 'getpeername',
        'WSOCK32.DLL#6': 'getsockname',
        'WSOCK32.DLL#7': 'getsockopt',
        'WSOCK32.DLL#8': 'htonl',
        'WSOCK32.DLL#9': 'htons',
        'WSOCK32.DLL#10': 'inet_addr',
        'WSOCK32.DLL#11': 'inet_ntoa',
        'WSOCK32.DLL#12': 'ioctlsocket',
        'WSOCK32.DLL#13': 'listen',
        'WSOCK32.DLL#14': 'ntohl',
        'WSOCK32.DLL#15': 'ntohs',
        'WSOCK32.DLL#16': 'recv',
        'WSOCK32.DLL#17': 'recvfrom',
        'WSOCK32.DLL#18': 'select',
        'WSOCK32.DLL#19': 'send',
        'WSOCK32.DLL#20': 'sendto',
        'WSOCK32.DLL#21': 'setsockopt',
        'WSOCK32.DLL#22': 'shutdown',
        'WSOCK32.DLL#23': 'socket',
        'WSOCK32.DLL#115': 'WSAStartup',
        'WSOCK32.DLL#116': 'WSACleanup',
        // OLEAUT32 — BSTR and variant management (official MSDN ordinals)
        'OLEAUT32.DLL#2': 'SysAllocString',
        'OLEAUT32.DLL#4': 'SysAllocStringLen',
        'OLEAUT32.DLL#6': 'SysFreeString',
        'OLEAUT32.DLL#7': 'SysStringLen',
        'OLEAUT32.DLL#9': 'VariantClear',
        'OLEAUT32.DLL#150': 'LoadTypeLib',
        // DirectSound ordinal exports
        'DSOUND.DLL#1': 'DirectSoundCreate',
        // DirectPlay (DPLAYX) — stubs that report "not available" so apps
        // fall back to single-player. Out of scope per directx.md.
        'DPLAYX.DLL#1': 'DirectPlayCreate',
        'DPLAYX.DLL#2': 'DirectPlayEnumerate',
        'DPLAYX.DLL#3': 'DirectPlayEnumerateA',
        'DPLAYX.DLL#4': 'DirectPlayLobbyCreateA',
      };
      const name = ORDINAL_MAP[key];
      if (!name) {
        if (ctx.verbose) console.log(`  [ordinal] ${dllName}#${ordinal} -> unknown`);
        return -1;
      }
      // Look up API ID by name hash (FNV-1a)
      const apiTable = ctx.apiTable;
      if (apiTable) {
        const entry = apiTable.find(e => e.name === name);
        if (entry) {
          if (ctx.verbose) console.log(`  [ordinal] ${dllName}#${ordinal} -> ${name} (API #${entry.id})`);
          return entry.id;
        }
      }
      if (ctx.verbose) console.log(`  [ordinal] ${dllName}#${ordinal} -> ${name} (no handler)`);
      return -1;
    },

    read_file: (pathWA, bufWA, maxLen) => {
      const path = readStr(pathWA);
      if (ctx.readFile) {
        const data = ctx.readFile(path);
        if (data && data.length > 0) {
          const len = Math.min(data.length, maxLen);
          new Uint8Array(ctx.getMemory(), bufWA, len).set(data.subarray ? data.subarray(0, len) : data.slice(0, len));
          return len;
        }
      }
      return 0;
    },

    // --- Help system imports ---
    help_open: (pathWA) => {
      // Return cached parser's topic count if already loaded
      if (ctx._helpParser) return ctx._helpParser.topics.length;
      const filePath = readStr(pathWA);
      const HlpParserClass = (typeof HlpParser !== 'undefined') ? HlpParser
        : (typeof require !== 'undefined' ? require('./hlp-parser').HlpParser : null);
      if (!HlpParserClass) return 0;
      // Try sync readFile (works in Node; browser returns null for HLP)
      if (ctx.readFile) {
        const data = ctx.readFile(filePath);
        if (data && data.length > 0) {
          try {
            const parser = new HlpParserClass(data);
            if (parser.parse()) {
              ctx._helpParser = parser;
              return parser.topics.length;
            }
          } catch (e) { return 0; }
        }
      }
      // No sync data — store path for async fetch, return -1 to signal yield
      ctx._helpPendingPath = filePath;
      return -1;
    },
    help_get_topic: (index, destWA, maxLen) => {
      const parser = ctx._helpParser;
      if (!parser) return 0;
      let text;
      if (index === 0) {
        // Contents page: title + numbered list of topics
        let lines = parser.helpTitle || 'Help Topics';
        lines += '\n';
        for (let i = 0; i < parser.topics.length; i++) {
          lines += '\n' + (i + 1) + '. ' + (parser.topics[i].title || '(untitled)');
        }
        text = lines;
      } else if (index > 0 && index <= parser.topics.length) {
        const topic = parser.topics[index - 1];
        text = (topic.title ? topic.title + '\n\n' : '') + topic.text;
      } else {
        return 0;
      }
      const enc = new TextEncoder();
      const encoded = enc.encode(text);
      const len = Math.min(encoded.length, maxLen);
      new Uint8Array(ctx.getMemory(), destWA, len).set(encoded.subarray(0, len));
      new Uint8Array(ctx.getMemory())[destWA + len] = 0; // NUL-terminate
      return len;
    },
    help_get_title: (destWA, maxLen) => {
      const parser = ctx._helpParser;
      if (!parser || !parser.helpTitle) return 0;
      const enc = new TextEncoder();
      const encoded = enc.encode(parser.helpTitle);
      const len = Math.min(encoded.length, maxLen);
      new Uint8Array(ctx.getMemory(), destWA, len).set(encoded.subarray(0, len));
      new Uint8Array(ctx.getMemory())[destWA + len] = 0;
      return len;
    },

    // --- Drawing ---
    draw_rect: (x, y, w, h, color) => {
      if (!ctx.renderer) return;
      const c = ctx.renderer.ctx;
      c.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
      c.fillRect(x, y, w, h);
    },
    draw_text: (x, y, textPtr, textLen, color) => {
      if (!ctx.renderer) return;
      const bytes = new Uint8Array(ctx.getMemory(), textPtr, textLen);
      const text = new TextDecoder().decode(bytes);
      const c = ctx.renderer.ctx;
      c.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
      c.font = ctx.renderer.font;
      c.textAlign = 'left';
      c.textBaseline = 'top';
      c.fillText(text, x, y);
    },

    // --- Window management ---
    set_parent: (hwnd, newParent) => {
      const r = ctx.renderer;
      if (!r) return;
      const win = r.windows[hwnd];
      if (!win) return;
      win.parentHwnd = newParent || 0;
      win.isChild = !!(newParent && r.windows[newParent]);
    },
    create_window: (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
      const title = readStr(titlePtr);
      console.log(`[CreateWindow] hwnd=0x${hwnd.toString(16)} title="${title}" menu=${menuId}`);
      if (ctx.renderer) ctx.renderer.createWindow(hwnd, style, x, y, cx, cy, title, menuId);
      return hwnd;
    },
    sys_command: (hwnd, sc) => {
      // WAT DefWindowProcA routes SC_MINIMIZE/SC_MAXIMIZE/SC_RESTORE here
      // so renderer-side window state stays in sync with the guest.
      const r = ctx.renderer;
      if (!r) return;
      const win = r.windows[hwnd];
      if (!win) return;
      if (sc === 0xF020) { // SC_MINIMIZE
        win.visible = false;
        win._minimized = true;
      } else if (sc === 0xF030) { // SC_MAXIMIZE
        if (!win._maximized) {
          win._restoreRect = { x: win.x, y: win.y, w: win.w, h: win.h };
          win.x = 0; win.y = 0;
          win.w = r.canvas.width;
          win.h = r.canvas.height;
          win._maximized = true;
        }
      } else if (sc === 0xF120) { // SC_RESTORE
        if (win._maximized && win._restoreRect) {
          win.x = win._restoreRect.x;
          win.y = win._restoreRect.y;
          win.w = win._restoreRect.w;
          win.h = win._restoreRect.h;
          win._maximized = false;
        }
        if (win._minimized) {
          win.visible = true;
          win._minimized = false;
        }
      }
      if (r.repaint) r.repaint();
    },
    show_window: (hwnd, cmd) => {
      console.log(`[ShowWindow] hwnd=0x${hwnd.toString(16)} cmd=${cmd}`);
      if (ctx.renderer) ctx.renderer.showWindow(hwnd, cmd);
      const win = ctx.renderer && ctx.renderer.windows[hwnd];
      if (win && win.clientRect) {
        const packed = (win.clientRect.w & 0xFFFF) | ((win.clientRect.h & 0xFFFF) << 16);
        return packed;
      }
      return 0;
    },
    dialog_loaded: (hwnd, parentHwnd) => {
      // WAT's $dlg_load has parsed the RT_DIALOG template into WND_DLG_RECORDS
      // and CONTROL_TABLE. The renderer reads all state from WAT exports —
      // there is no JS-side template parser left.
      if (ctx.renderer) ctx.renderer.createDialog(hwnd, parentHwnd);
    },
    load_icon: (hInstance, resourceId) => {
      return 0x50000 | (resourceId & 0xFFFF);
    },
    load_cursor: (hInstance, resourceId) => {
      return 0x60000 | (resourceId & 0xFFFF);
    },
    set_cursor: (hcur) => {
      const canvas = ctx.renderer && ctx.renderer.canvas;
      if (!canvas || !canvas.style) return;
      const idc = hcur & 0xFFFF;
      let css;
      switch (idc) {
        case 0x7F00: css = 'default'; break;      // IDC_ARROW
        case 0x7F01: css = 'text'; break;         // IDC_IBEAM
        case 0x7F02: css = 'wait'; break;         // IDC_WAIT
        case 0x7F03: css = 'crosshair'; break;    // IDC_CROSS
        case 0x7F04: css = 'crosshair'; break;    // IDC_UPARROW → no good CSS match
        case 0x7F82: css = 'nwse-resize'; break;  // IDC_SIZENWSE
        case 0x7F83: css = 'nesw-resize'; break;  // IDC_SIZENESW
        case 0x7F84: css = 'ew-resize'; break;    // IDC_SIZEWE
        case 0x7F85: css = 'ns-resize'; break;    // IDC_SIZENS
        case 0x7F86: css = 'move'; break;         // IDC_SIZEALL
        case 0x7F88: css = 'not-allowed'; break;  // IDC_NO
        case 0x7F89: css = 'pointer'; break;      // IDC_HAND
        case 0x7F8A: css = 'progress'; break;     // IDC_APPSTARTING
        case 0x7F8B: css = 'help'; break;         // IDC_HELP
        default:     css = 'default'; break;
      }
      if (canvas.style.cursor !== css) canvas.style.cursor = css;
    },
    send_ctrl_msg: (ctrlHwnd, msg, wParam, lParam) => {
      // Progress bar / richedit-style messages to a child control. WAT
      // CONTROL_TABLE and the renderer's GDI paint path are the source of
      // truth; this host import is a no-op stub kept so WAT's call site
      // doesn't trap.
    },
    richedit_stream: (ctrlHwnd, textPtr) => {
      let text = readStr(textPtr, 65536);
      // Strip RTF if it starts with '{'
      if (text.startsWith('{\\rtf')) {
        text = text.replace(/\{[^{}]*\}/g, '').replace(/\\[a-z]+\d* ?/g, '').replace(/[{}]/g, '').trim();
      }
      console.log(`[RichEdit] hwnd=0x${ctrlHwnd.toString(16)} text=${text.length} chars`);
    },
    set_window_text: (hwnd, textPtr) => {
      const text = readStr(textPtr);
      if (!ctx._windowText) ctx._windowText = new Map();
      ctx._windowText.set(hwnd, text);
      if (ctx.renderer) ctx.renderer.setWindowText(hwnd, text);
    },
    set_window_class: (hwnd, classPtr) => {
      if (ctx.renderer) ctx.renderer.setWindowClass(hwnd, readStr(classPtr));
    },
    get_window_text: (hwnd, bufWA, maxLen) => {
      if (!ctx._windowText) return 0;
      const text = ctx._windowText.get(hwnd) || '';
      const bytes = new Uint8Array(ctx.getMemory());
      const len = Math.min(text.length, maxLen - 1);
      for (let i = 0; i < len; i++) bytes[bufWA + i] = text.charCodeAt(i) & 0xFF;
      bytes[bufWA + len] = 0;
      return len;
    },
    invalidate: (hwnd) => {
      if (_env.DBG_INV) console.log('[INVALIDATE] hwnd=0x' + hwnd.toString(16));
      if (ctx.renderer) ctx.renderer.invalidate(hwnd);
    },
    get_window_client_size: (hwnd) => {
      if (!ctx.renderer) return (640 & 0xFFFF) | (480 << 16);
      const win = ctx.renderer.windows[hwnd];
      if (!win) return (640 & 0xFFFF) | (480 << 16);
      if (win.isChild) {
        // Child windows: client = full window area (no chrome)
        return (win.w & 0xFFFF) | (win.h << 16);
      }
      // Top-level: prefer WAT get_client_rect_wh (authoritative after NCCALCSIZE).
      const e = ctx.renderer.wasm && ctx.renderer.wasm.exports;
      if (e && e.get_client_rect_wh) {
        const packed = e.get_client_rect_wh(hwnd) | 0;
        if (packed) return packed;
      }
      const cr = win.clientRect;
      if (cr) return (cr.w & 0xFFFF) | (cr.h << 16);
      return (win.w & 0xFFFF) | (win.h << 16);
    },
    get_window_rect: (hwnd, rectPtr) => {
      const mem = new DataView(ctx.getMemory());
      if (!ctx.renderer) {
        // Desktop fallback
        mem.setInt32(rectPtr, 0, true);
        mem.setInt32(rectPtr + 4, 0, true);
        mem.setInt32(rectPtr + 8, 640, true);
        mem.setInt32(rectPtr + 12, 480, true);
        return;
      }
      const win = ctx.renderer.windows[hwnd];
      if (!win) {
        // Child control hwnds live in WAT's CONTROL_GEOM. Walk up to the
        // owning dialog so screen coords are correct.
        const we = ctx.renderer.wasm && ctx.renderer.wasm.exports;
        if (we && we.ctrl_get_wh && we.ctrl_get_class && we.ctrl_get_class(hwnd) !== 0
            && we.ctrl_get_xy && we.wnd_get_parent) {
          const xy = we.ctrl_get_xy(hwnd) >>> 0;
          const wh = we.ctrl_get_wh(hwnd) >>> 0;
          const cx = (xy & 0xFFFF), cy = ((xy >>> 16) & 0xFFFF);
          const cw = (wh & 0xFFFF), ch = ((wh >>> 16) & 0xFFFF);
          let ox = 0, oy = 0;
          const parent = we.wnd_get_parent(hwnd) >>> 0;
          const pwin = parent && ctx.renderer.windows[parent];
          if (pwin) {
            const cr = pwin.clientRect;
            ox = pwin.x + (cr ? (cr.x - pwin.x) : 0);
            oy = pwin.y + (cr ? (cr.y - pwin.y) : 0);
          }
          mem.setInt32(rectPtr, ox + cx, true);
          mem.setInt32(rectPtr + 4, oy + cy, true);
          mem.setInt32(rectPtr + 8, ox + cx + cw, true);
          mem.setInt32(rectPtr + 12, oy + cy + ch, true);
          return;
        }
        // hwnd=0 or unknown → desktop rect
        mem.setInt32(rectPtr, 0, true);
        mem.setInt32(rectPtr + 4, 0, true);
        mem.setInt32(rectPtr + 8, 640, true);
        mem.setInt32(rectPtr + 12, 480, true);
        return;
      }
      mem.setInt32(rectPtr, win.x, true);      // left
      mem.setInt32(rectPtr + 4, win.y, true);   // top
      mem.setInt32(rectPtr + 8, win.x + win.w, true);  // right
      mem.setInt32(rectPtr + 12, win.y + win.h, true);  // bottom
    },
    move_window: (hwnd, x, y, w, h, flags) => {
      if (!ctx.renderer) return;
      const win = ctx.renderer.windows[hwnd];
      if (!win) return;
      // CW_USEDEFAULT (-2147483648) means "keep existing position/size";
      // common when MFC echoes back unset WINDOWPLACEMENT fields.
      const useDefault = v => v === -2147483648 || v === 0x80000000 | 0;
      if (!(flags & 2)) {
        if (!useDefault(x)) win.x = x;
        if (!useDefault(y)) win.y = y;
      }
      if (!(flags & 1)) {
        if (!useDefault(w)) win.w = Math.max(0, w);
        if (!useDefault(h)) win.h = Math.max(0, h);
      }
      // SWP_SHOWWINDOW=0x40 / SWP_HIDEWINDOW=0x80 — SDL relies on this to reveal
      // the window after SetVideoMode (no explicit ShowWindow(SW_SHOW) call).
      if (flags & 0x40) {
        win.visible = true;
        // Re-bump zOrder on show so popups (combobox dropdowns) reappear ON
        // TOP of the parent dialog. Without this, a hidden popup keeps its
        // last bumped value, but the parent dialog gets bumped on every click
        // that hits it — so the popup ends up behind the dialog the second
        // time it opens.
        win.zOrder = ctx.renderer._nextZ++ + (win.isPopup ? 1000000 : 0);
      }
      if (flags & 0x80) win.visible = false;
      ctx.renderer._computeClientRect(win);
      if (!win.isChild) ctx.renderer.scheduleRepaint();
    },
    destroy_window: (hwnd) => {
      if (!ctx.renderer) return;
      // Drop any per-window menu data the WAT side is holding for this hwnd.
      const we = ctx.renderer.wasm && ctx.renderer.wasm.exports;
      if (we && we.menu_clear) we.menu_clear(hwnd);
      for (const k of Object.keys(ctx.renderer.windows)) {
        if (ctx.renderer.windows[k].parentHwnd === hwnd) {
          delete ctx.renderer.windows[k];
        }
      }
      delete ctx.renderer.windows[hwnd];
      ctx.renderer.scheduleRepaint();
    },
    erase_background: (hwnd, hbrBackground) => {
      if (_env.DBG_INV) console.log('[ERASE] hwnd=0x' + hwnd.toString(16) + ' brush=0x' + hbrBackground.toString(16));
      // WM_ERASEBKGND default handler: fill client area with WNDCLASS.hbrBackground
      // hbrBackground=0 means NULL_BRUSH — don't erase (app handles it)
      if (hbrBackground === 0) return 1;
      if (!ctx.renderer) return 1;
      const win = ctx.renderer.windows[hwnd];
      if (!win) return 1;
      const topHwnd = _resolveTopHwnd(hwnd);
      const wc = ctx.renderer.getWindowCanvas(topHwnd);
      if (!wc) return 1;
      if (!win.clientRect) return 1;
      const { w, h } = win.clientRect;
      if (w <= 0 || h <= 0) return 1;
      const c = wc.ctx;
      // Interpret hbrBackground: small values are COLOR_xxx+1, stock object handles, or GDI brush handles
      // COLOR_WINDOW+1 = 6, COLOR_BTNFACE+1 = 16, COLOR_APPWORKSPACE+1 = 13
      // GetStockObject: WHITE_BRUSH=0, LTGRAY_BRUSH=1, GRAY_BRUSH=2, DKGRAY_BRUSH=3, BLACK_BRUSH=4
      // Our GetStockObject returns 0x30002 for everything, so also check that
      let color;
      if (hbrBackground <= 20) {
        // COLOR_xxx + 1 system color index
        const sysColors = {
          1: '#c0c0c0', // COLOR_SCROLLBAR
          2: '#008080', // COLOR_BACKGROUND/DESKTOP
          3: '#000080', // COLOR_ACTIVECAPTION
          4: '#808080', // COLOR_INACTIVECAPTION
          5: '#c0c0c0', // COLOR_MENU
          6: '#ffffff', // COLOR_WINDOW
          7: '#000000', // COLOR_WINDOWFRAME
          8: '#000000', // COLOR_MENUTEXT
          9: '#000000', // COLOR_WINDOWTEXT
          10: '#ffffff', // COLOR_CAPTIONTEXT
          11: '#c0c0c0', // COLOR_ACTIVEBORDER
          12: '#c0c0c0', // COLOR_INACTIVEBORDER
          13: '#808080', // COLOR_APPWORKSPACE
          14: '#000080', // COLOR_HIGHLIGHT
          15: '#ffffff', // COLOR_HIGHLIGHTTEXT
          16: '#c0c0c0', // COLOR_BTNFACE
        };
        color = sysColors[hbrBackground] || '#c0c0c0';
      } else if (hbrBackground >= 0x30010 && hbrBackground <= 0x30015) {
        // Stock brush handles from GetStockObject (0x30010 + index)
        const stockColors = {
          0x30010: '#ffffff', // WHITE_BRUSH
          0x30011: '#c0c0c0', // LTGRAY_BRUSH
          0x30012: '#808080', // GRAY_BRUSH
          0x30013: '#404040', // DKGRAY_BRUSH
          0x30014: '#000000', // BLACK_BRUSH
          0x30015: null,      // NULL_BRUSH (no fill)
        };
        color = stockColors[hbrBackground];
        if (color === null) return 1; // NULL_BRUSH: don't erase
        if (color === undefined) color = '#c0c0c0';
      } else {
        // GDI brush handle — look up color from object table
        const obj = _gdiObjects[hbrBackground];
        if (obj && obj.type === 'brush') {
          const bc = obj.color;
          color = 'rgb(' + (bc & 0xFF) + ',' + ((bc>>8) & 0xFF) + ',' + ((bc>>16) & 0xFF) + ')';
        } else {
          color = '#c0c0c0'; // fallback to btnFace
        }
      }
      c.fillStyle = color;
      // Back-canvas-local origin for child: parent-chain screen origin minus top-level screen pos.
      // For top-level: use chrome offset within its own back canvas.
      let ox, oy;
      if (win.isChild && win.parentHwnd) {
        const screenO = _getClientOriginScreen(hwnd);
        const topWin = ctx.renderer.windows[topHwnd];
        ox = screenO.x - (topWin ? topWin.x : 0);
        oy = screenO.y - (topWin ? topWin.y : 0);
      } else {
        const o = _getClientOrigin(hwnd);
        ox = o.x; oy = o.y;
      }
      // Exclude cousin/child windows from the erase so we don't paint over
      // sibling palettes that share the top-level back-canvas (see
      // _excludeChildrenClip). Build a minimal target matching _drawWithClip's
      // contract: {ctx, canvas, ox, oy} where ox/oy is the client origin
      // within the back-canvas.
      const _eraseTarget = { ctx: c, canvas: wc.canvas, ox, oy };
      const _eraseExcluded = _excludeChildrenClip(_eraseTarget, hwnd);
      try {
        c.fillRect(ox, oy, w, h);
      } finally { if (_eraseExcluded) c.restore(); }
      win.clientPainted = true;
      ctx.renderer.scheduleRepaint();
      return 1;
    },
    set_menu: (hwnd, menuResId) => {
      if (ctx.renderer) ctx.renderer.setMenu(hwnd, menuResId);
    },

    // --- Input (override for interactive/test) ---
    check_input: () => 0,
    check_input_lparam: () => 0,
    check_input_hwnd: () => 0,
    get_async_key_state: (vKey) => ctx.renderer ? ctx.renderer.getAsyncKeyState(vKey) : 0,

    // --- Real GDI implementations ---
    gdi_create_pen: (style, width, color) => {
      return _gdiAlloc({ type: 'pen', style, width, color: color & 0xFFFFFF });
    },
    gdi_create_solid_brush: (color) => {
      return _gdiAlloc({ type: 'brush', color: color & 0xFFFFFF });
    },
    gdi_create_compat_dc: (hdcSrc) => {
      const h = _gdiAlloc({ type: 'dc' });
      _dcState[h] = { penColor: 0, penWidth: 1, brushColor: 0xFFFFFF, posX: 0, posY: 0 };
      return h;
    },
    gdi_create_compat_bitmap: (hdc, w, h) => {
      w = w | 0; h = h | 0;
      if (w <= 0) w = 1;
      if (h <= 0) h = 1;
      const canvas = _createOffscreen(w, h);
      return _gdiAlloc({ type: 'bitmap', w, h, pixels: new Uint8Array(w * h * 4), canvas });
    },
    gdi_create_bitmap: (w, h, bpp, lpBitsWasm) => {
      w = w | 0; h = h | 0; bpp = bpp | 0;
      if (w <= 0) w = 1;
      if (h <= 0) h = 1;
      const isMono = (bpp === 1);
      // NULL bits: create blank bitmap (all black for mono, all black for color)
      if (!lpBitsWasm) {
        const canvas = _createOffscreen(w, h);
        return _gdiAlloc({ type: 'bitmap', w, h, pixels: new Uint8Array(w * h * 4), canvas, mono: isMono });
      }
      const pixels = new Uint8Array(w * h * 4);
      const mem = new Uint8Array(ctx.getMemory());
      // Row stride: each row is WORD-aligned (padded to 2-byte boundary)
      const rowBytes = Math.ceil((w * bpp) / 16) * 2;
      // DDB rows are top-down
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const di = (y * w + x) * 4;
          if (bpp === 1) {
            // Monochrome: 1=white, 0=black
            const byteIdx = lpBitsWasm + y * rowBytes + (x >> 3);
            const bit = (mem[byteIdx] >> (7 - (x & 7))) & 1;
            pixels[di] = pixels[di+1] = pixels[di+2] = bit ? 255 : 0;
          } else if (bpp === 4) {
            const byteIdx = lpBitsWasm + y * rowBytes + (x >> 1);
            const nibble = (x & 1) ? (mem[byteIdx] & 0xF) : ((mem[byteIdx] >> 4) & 0xF);
            // Standard 16-color VGA palette
            const pal16 = [0x000000,0x800000,0x008000,0x808000,0x000080,0x800080,0x008080,0xC0C0C0,
                           0x808080,0xFF0000,0x00FF00,0xFFFF00,0x0000FF,0xFF00FF,0x00FFFF,0xFFFFFF];
            const c = pal16[nibble] || 0;
            pixels[di] = (c >> 16) & 0xFF; pixels[di+1] = (c >> 8) & 0xFF; pixels[di+2] = c & 0xFF;
          } else if (bpp === 8) {
            const v = mem[lpBitsWasm + y * rowBytes + x];
            pixels[di] = pixels[di+1] = pixels[di+2] = v;
          } else if (bpp === 24) {
            const si = lpBitsWasm + y * rowBytes + x * 3;
            pixels[di] = mem[si+2]; pixels[di+1] = mem[si+1]; pixels[di+2] = mem[si]; // BGR→RGB
          } else if (bpp === 32) {
            const si = lpBitsWasm + y * rowBytes + x * 4;
            pixels[di] = mem[si+2]; pixels[di+1] = mem[si+1]; pixels[di+2] = mem[si]; // BGR→RGB
          }
          pixels[di+3] = 255;
        }
      }
      const canvas = _createOffscreen(w, h);
      if (canvas) {
        const bc = canvas.getContext('2d');
        const imgData = bc.createImageData(w, h);
        imgData.data.set(pixels);
        bc.putImageData(imgData, 0, 0);
      }
      return _gdiAlloc({ type: 'bitmap', w, h, pixels, canvas, mono: isMono });
    },
    gdi_create_dib_section: (w, h, bpp, lpBitsWa, lpbmiWa) => {
      w = w | 0; h = h | 0; bpp = bpp | 0;
      if (w <= 0) w = 1;
      if (h <= 0) h = 1;
      // Read palette from BITMAPINFO (header + color table) for paletted formats
      const dv = new DataView(ctx.getMemory());
      const mem = new Uint8Array(ctx.getMemory());
      const biSize = dv.getInt32(lpbmiWa, true);
      const biHeight = dv.getInt32(lpbmiWa + 8, true);
      const bottomUp = biHeight >= 0;
      const clrUsed = dv.getUint32(lpbmiWa + 32, true);
      const numColors = clrUsed || (bpp <= 8 ? (1 << bpp) : 0);
      const palette = [];
      for (let i = 0; i < numColors; i++) {
        const off = lpbmiWa + biSize + i * 4;
        palette.push([mem[off + 2], mem[off + 1], mem[off]]); // BGR → RGB
      }
      const canvas = _createOffscreen(w, h);
      // Record initial (zero) hash so the first blit-time sync becomes a no-op when the
      // guest never wrote directly — GDI draws into the DC can't be wiped by a resync.
      const rowBytes = ((w * bpp + 31) >> 5) << 2;
      const totalBytes = rowBytes * h;
      const step = Math.max(1, (totalBytes / 256) | 0);
      let initHash = 0 | 0;
      for (let off = 0; off < totalBytes; off += step) {
        initHash = (Math.imul(initHash, 31) + mem[(lpBitsWa + off) >>> 0]) | 0;
      }
      return _gdiAlloc({
        type: 'bitmap', w, h, bpp,
        pixels: new Uint8Array(w * h * 4),
        canvas,
        dibSection: true,
        lpBitsWa: lpBitsWa >>> 0,
        palette,
        bottomUp,
        _syncedOnce: true,
        _lastSyncHash: initHash,
      });
    },
    gdi_create_dib_bitmap: (lpbmiWa, lpbInitWa, fdwInit) => {
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      // Read BITMAPINFOHEADER
      const biSize = dv.getInt32(lpbmiWa, true);
      const w = dv.getInt32(lpbmiWa + 4, true);
      let h = dv.getInt32(lpbmiWa + 8, true);
      const bottomUp = h > 0;
      h = Math.abs(h);
      const bpp = dv.getUint16(lpbmiWa + 14, true);
      const clrUsed = dv.getUint32(lpbmiWa + 32, true);
      // Read color table for paletted formats
      const palOffset = lpbmiWa + biSize;
      const numColors = clrUsed || (bpp <= 8 ? (1 << bpp) : 0);
      const palette = [];
      for (let i = 0; i < numColors; i++) {
        const off = palOffset + i * 4;
        palette.push([mem[off + 2], mem[off + 1], mem[off]]); // BGR → RGB
      }
      const compression = dv.getUint32(lpbmiWa + 16, true);
      const pixels = new Uint8Array(w * h * 4);
      if (fdwInit === 4 && lpbInitWa) { // CBM_INIT
        const rowBytes = ((w * bpp + 31) >> 5) << 2; // DWORD-aligned
        // RLE8 decompression
        if (compression === 1 && bpp === 8) {
          const indices = new Uint8Array(w * h);
          let p = lpbInitWa, x = 0, y = 0;
          while (p < mem.length) {
            const a = mem[p++], b = mem[p++];
            if (a === 0) {
              if (b === 0) { x = 0; y++; }
              else if (b === 1) break;
              else if (b === 2) { x += mem[p++]; y += mem[p++]; }
              else {
                for (let i = 0; i < b; i++) {
                  if (x < w && y < h) indices[(h - 1 - y) * w + x] = mem[p + i];
                  x++;
                }
                p += b;
                if (b & 1) p++;
              }
            } else {
              for (let i = 0; i < a; i++) {
                if (x < w && y < h) indices[(h - 1 - y) * w + x] = b;
                x++;
              }
            }
          }
          for (let i = 0; i < w * h; i++) {
            const idx = indices[i];
            const di = i * 4;
            if (idx < palette.length) { pixels[di] = palette[idx][0]; pixels[di+1] = palette[idx][1]; pixels[di+2] = palette[idx][2]; }
            pixels[di+3] = 255;
          }
        // RLE4 decompression
        } else if (compression === 2 && bpp === 4) {
          const indices = new Uint8Array(w * h);
          let p = lpbInitWa, x = 0, y = 0;
          while (p < mem.length) {
            const a = mem[p++], b = mem[p++];
            if (a === 0) {
              if (b === 0) { x = 0; y++; }
              else if (b === 1) break;
              else if (b === 2) { x += mem[p++]; y += mem[p++]; }
              else {
                const bytes = (b + 1) >> 1;
                for (let i = 0; i < b; i++) {
                  const byte = mem[p + (i >> 1)];
                  const nib = (i & 1) ? (byte & 0xF) : (byte >> 4);
                  if (x < w && y < h) indices[(h - 1 - y) * w + x] = nib;
                  x++;
                }
                p += bytes;
                if (bytes & 1) p++;
              }
            } else {
              const hi = b >> 4, lo = b & 0xF;
              for (let i = 0; i < a; i++) {
                const nib = (i & 1) ? lo : hi;
                if (x < w && y < h) indices[(h - 1 - y) * w + x] = nib;
                x++;
              }
            }
          }
          for (let i = 0; i < w * h; i++) {
            const idx = indices[i];
            const di = i * 4;
            if (idx < palette.length) { pixels[di] = palette[idx][0]; pixels[di+1] = palette[idx][1]; pixels[di+2] = palette[idx][2]; }
            pixels[di+3] = 255;
          }
        } else {
          // Uncompressed
          for (let y = 0; y < h; y++) {
            const srcY = bottomUp ? (h - 1 - y) : y;
            for (let x = 0; x < w; x++) {
              const di = (y * w + x) * 4;
              let r = 0, g = 0, b = 0;
              if (bpp === 8) {
                const idx = mem[lpbInitWa + srcY * rowBytes + x];
                if (idx < palette.length) { [r, g, b] = palette[idx]; }
              } else if (bpp === 4) {
                const byteIdx = lpbInitWa + srcY * rowBytes + (x >> 1);
                const nibble = (x & 1) ? (mem[byteIdx] & 0xF) : ((mem[byteIdx] >> 4) & 0xF);
                if (nibble < palette.length) { [r, g, b] = palette[nibble]; }
              } else if (bpp === 1) {
                const byteIdx = lpbInitWa + srcY * rowBytes + (x >> 3);
                const bit = (mem[byteIdx] >> (7 - (x & 7))) & 1;
                if (bit < palette.length) { [r, g, b] = palette[bit]; } else { r = g = b = bit ? 255 : 0; }
              } else if (bpp === 24) {
                const si = lpbInitWa + srcY * rowBytes + x * 3;
                b = mem[si]; g = mem[si+1]; r = mem[si+2];
              } else if (bpp === 32) {
                const si = lpbInitWa + srcY * rowBytes + x * 4;
                b = mem[si]; g = mem[si+1]; r = mem[si+2];
              }
              pixels[di] = r; pixels[di+1] = g; pixels[di+2] = b; pixels[di+3] = 255;
            }
          }
        }
      }
      const canvas = _createOffscreen(w, h);
      if (canvas) {
        const bc = canvas.getContext('2d');
        const imgData = bc.createImageData(w, h);
        imgData.data.set(pixels);
        bc.putImageData(imgData, 0, 0);
      }
      return _gdiAlloc({ type: 'bitmap', w, h, pixels, canvas, mono: (bpp === 1) });
      },

    gdi_select_object: (hdc, hObj) => {
      const obj = _gdiObjects[hObj];
      const dc = _getDC(hdc);
      // "Previous" sentinel must match get_current_object defaults so saving+restoring
      // round-trips through our handle table with the correct type. Using a single
      // shared default (e.g. 0x30001) causes brush-restore to be misrouted as a
      // bitmap swap when 0x30001 is typed as bitmap in _gdiObjects.
      let prev = 0x30001;
      if (obj) {
        if (obj.type === 'pen') { prev = dc.selectedPen || 0x30023; dc.selectedPen = hObj; dc.penColor = obj.color; dc.penWidth = obj.width || 1; }
        else if (obj.type === 'brush') { prev = dc.selectedBrush || 0x30002; dc.selectedBrush = hObj; dc.brushColor = obj.color; }
        else if (obj.type === 'bitmap') { prev = dc.selectedBitmap || 0x30007; dc.selectedBitmap = hObj; }
        else if (obj.type === 'font') { prev = dc.selectedFont || 0x3001d; dc.selectedFont = hObj; }
      }
      return prev;
    },
    gdi_get_current_object: (hdc, objType) => {
      const dc = _getDC(hdc);
      // OBJ_PEN=1, OBJ_BRUSH=2, OBJ_PAL=5, OBJ_FONT=6, OBJ_BITMAP=7
      if (objType === 1) return dc.selectedPen || 0x30001;
      if (objType === 2) return dc.selectedBrush || 0x30002;
      if (objType === 5) return 0x30005; // default palette
      if (objType === 6) return dc.selectedFont || 0x3001d;
      if (objType === 7) return dc.selectedBitmap || 0x30007;
      return 0;
    },
    gdi_delete_object: (h) => { delete _gdiObjects[h]; return 1; },
    gdi_delete_dc: (hdc) => { delete _dcState[hdc]; delete _gdiObjects[hdc]; return 1; },
    gdi_get_clip_box: (hdc) => {
      if (hdc >= 0x40000) {
        const hwnd = hdc - 0x40000;
        if (hwnd === 0) return 640 | (480 << 16);
        if (ctx.renderer && ctx.renderer.windows) {
          const w = ctx.renderer.windows[hwnd];
          if (w && w.client) return w.client.w | (w.client.h << 16);
        }
        return 640 | (480 << 16);
      }
      const dc = _getDC(hdc);
      if (dc && dc.selectedBitmap) {
        const bmp = _gdiObjects[dc.selectedBitmap];
        if (bmp) return bmp.w | (bmp.h << 16);
      }
      return 1 | (1 << 16);
    },
    gdi_draw_edge: (hdc, left, top, right, bottom, edge, grfFlags) => {
     _drawWithClip(hdc, (t) => {
      const c = t.ctx;
      const ox = t.ox, oy = t.oy;
      // Win32 3D edge colors
      const BF_LEFT = 1, BF_TOP = 2, BF_RIGHT = 4, BF_BOTTOM = 8;
      const BF_FLAT = 0x4000, BF_MONO = 0x8000;
      const isFlat = grfFlags & (BF_FLAT | BF_MONO);
      // Colors: light=white, highlight=0xC0C0C0, shadow=0x808080, dark=0x404040
      const light = '#FFFFFF', hilite = '#C0C0C0', shadow = '#808080', dark = '#404040';
      // Edge type decomposition
      const outerRaised = (edge & 1), outerSunken = (edge & 2);
      const innerRaised = (edge & 4), innerSunken = (edge & 8);
      // Outer edge colors
      let outerTL, outerBR;
      if (isFlat) { outerTL = shadow; outerBR = shadow; }
      else if (outerRaised) { outerTL = light; outerBR = dark; }
      else if (outerSunken) { outerTL = dark; outerBR = light; }
      // Inner edge colors
      let innerTL, innerBR;
      if (isFlat) { innerTL = hilite; innerBR = hilite; }
      else if (innerRaised) { innerTL = hilite; innerBR = shadow; }
      else if (innerSunken) { innerTL = shadow; innerBR = hilite; }
      // Draw helper: horizontal/vertical lines
      const hline = (x, y, w, color) => { c.fillStyle = color; c.fillRect(ox + x, oy + y, w, 1); };
      const vline = (x, y, h, color) => { c.fillStyle = color; c.fillRect(ox + x, oy + y, 1, h); };
      // Outer edge
      if (outerTL || outerBR) {
        if ((grfFlags & BF_TOP) && outerTL) hline(left, top, right - left, outerTL);
        if ((grfFlags & BF_LEFT) && outerTL) vline(left, top, bottom - top, outerTL);
        if ((grfFlags & BF_BOTTOM) && outerBR) hline(left, bottom - 1, right - left, outerBR);
        if ((grfFlags & BF_RIGHT) && outerBR) vline(right - 1, top, bottom - top, outerBR);
        // Shrink for inner edge
        if (grfFlags & BF_TOP) top++;
        if (grfFlags & BF_LEFT) left++;
        if (grfFlags & BF_BOTTOM) bottom--;
        if (grfFlags & BF_RIGHT) right--;
      }
      // Inner edge
      if (innerTL || innerBR) {
        if ((grfFlags & BF_TOP) && innerTL) hline(left, top, right - left, innerTL);
        if ((grfFlags & BF_LEFT) && innerTL) vline(left, top, bottom - top, innerTL);
        if ((grfFlags & BF_BOTTOM) && innerBR) hline(left, bottom - 1, right - left, innerBR);
        if ((grfFlags & BF_RIGHT) && innerBR) vline(right - 1, top, bottom - top, innerBR);
      }
     });
     return 1;
    },
    gdi_fill_rect: (hdc, left, top, right, bottom, hbrush) => {
     _drawWithClip(hdc, (t) => {
      const c = t.ctx;
      const x = t.ox + left, y = t.oy + top, w = right - left, h = bottom - top;
      // Resolve brush handle to color
      let bc;
      if (hbrush >= 0x30010 && hbrush <= 0x30015) {
        // Stock brush
        const stockColors = { 0x30010: 0xFFFFFF, 0x30011: 0xC0C0C0, 0x30012: 0x808080, 0x30013: 0x404040, 0x30014: 0x000000 };
        bc = stockColors[hbrush];
        if (bc === undefined) return; // NULL_BRUSH
      } else if (hbrush <= 30) {
        // System color brush — handle = COLOR_xxx + 1 (same convention as
        // erase_background's sysColors table; aligned so the two paths
        // agree). Colors are 0xBBGGRR (Win32 COLORREF).
        const sysRGB = {
          1: 0xC0C0C0,   // COLOR_SCROLLBAR
          2: 0x808000,   // COLOR_BACKGROUND/DESKTOP (teal in BGR)
          3: 0x800000,   // COLOR_ACTIVECAPTION (navy)
          4: 0x808080,   // COLOR_INACTIVECAPTION
          5: 0xC0C0C0,   // COLOR_MENU
          6: 0xFFFFFF,   // COLOR_WINDOW
          7: 0x000000,   // COLOR_WINDOWFRAME
          14: 0x800000,  // COLOR_HIGHLIGHT (navy)
          15: 0xFFFFFF,  // COLOR_HIGHLIGHTTEXT
          16: 0xC0C0C0,  // COLOR_BTNFACE
        };
        bc = sysRGB[hbrush] || 0xC0C0C0;
      } else {
        const obj = _gdiObjects[hbrush];
        bc = (obj && obj.type === 'brush') ? obj.color : 0;
      }
      c.fillStyle = `rgb(${bc & 0xFF},${(bc >> 8) & 0xFF},${(bc >> 16) & 0xFF})`;
      c.fillRect(x, y, w, h);
     });
     return 1;
    },
    gdi_offset_rgn: (hrgn, x, y) => {
      const rgn = _gdiObjects[hrgn];
      if (!rgn || rgn.type !== 'region') return 0;
      // Translate every Path2D in every branch via DOMMatrix (fall back to rebuild).
      const xform = (typeof DOMMatrix !== 'undefined') ? new DOMMatrix().translate(x, y) : null;
      for (const ch of rgn.branches) {
        for (const e of ch) {
          if (xform) {
            const p = new Path2D();
            p.addPath(e.path, xform);
            e.path = p;
          }
        }
      }
      rgn.bbox.l += x; rgn.bbox.r += x;
      rgn.bbox.t += y; rgn.bbox.b += y;
      if (rgn.simpleRect) {
        rgn.simpleRect.l += x; rgn.simpleRect.r += x;
        rgn.simpleRect.t += y; rgn.simpleRect.b += y;
      }
      if (rgn.rects) for (const r of rgn.rects) { r.x += x; r.y += y; }
      _traceRgn('OffsetRgn', '0x'+hrgn.toString(16), x, y, 'branches=', rgn.branches.length);
      return rgn.branches.length > 1 ? 3 : 2;
    },
    gdi_fill_rgn: (hdc, hrgn, hbrush) => {
      const rgn = _gdiObjects[hrgn];
      if (!rgn || rgn.type !== 'region') return 0;
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      const c = t.ctx;
      let bc;
      if (hbrush === 0) {
        bc = _getDC(hdc).brushColor || 0;
      } else if (hbrush >= 0x30010 && hbrush <= 0x30015) {
        const stockColors = { 0x30010: 0xFFFFFF, 0x30011: 0xC0C0C0, 0x30012: 0x808080, 0x30013: 0x404040, 0x30014: 0x000000 };
        bc = stockColors[hbrush];
        if (bc === undefined) return 1;
      } else if (hbrush <= 30) {
        const sysRGB = { 1: 0xC0C0C0, 2: 0x808000, 3: 0x800000, 4: 0x808080, 5: 0xC0C0C0, 6: 0xFFFFFF, 7: 0x000000, 14: 0x800000, 15: 0xFFFFFF, 16: 0xC0C0C0 };
        bc = sysRGB[hbrush] || 0xC0C0C0;
      } else {
        const obj = _gdiObjects[hbrush];
        bc = (obj && obj.type === 'brush') ? obj.color : 0;
      }
      const fillStyle = `rgb(${bc & 0xFF},${(bc >> 8) & 0xFF},${(bc >> 16) & 0xFF})`;
      // Iterate disjoint branches, fill bbox under each chain's clip.
      for (const chain of rgn.branches) {
        c.save();
        try {
          c.translate(t.ox, t.oy);
          for (const { path, rule, polarity } of chain) {
            if (polarity > 0) {
              c.clip(path, rule);
            } else {
              const notPath = new Path2D();
              notPath.rect(-t.ox, -t.oy, t.canvas.width, t.canvas.height);
              notPath.addPath(path);
              c.clip(notPath, 'evenodd');
            }
          }
          c.translate(-t.ox, -t.oy);
          c.fillStyle = fillStyle;
          const bb = rgn.bbox;
          c.fillRect(t.ox + bb.l, t.oy + bb.t, bb.r - bb.l, bb.b - bb.t);
        } finally { c.restore(); }
      }
      return 1;
    },
    gdi_gradient_fill_h: (hdc, left, top, right, bottom, colorL, colorR) => {
      _drawWithClip(hdc, (t) => {
        const c = t.ctx;
        const x = t.ox + left, y = t.oy + top, w = right - left, h = bottom - top;
        if (w <= 0 || h <= 0) return;
        const rgb = (cr) => `rgb(${cr & 0xFF},${(cr >> 8) & 0xFF},${(cr >> 16) & 0xFF})`;
        const grad = c.createLinearGradient(x, y, x + w, y);
        grad.addColorStop(0, rgb(colorL));
        grad.addColorStop(1, rgb(colorR));
        c.fillStyle = grad;
        c.fillRect(x, y, w, h);
      });
      return 1;
    },
    gdi_draw_focus_rect: (hdc, left, top, right, bottom) => {
      // Win98 focus rect is a stipple of every other pixel, not a Canvas
      // dashed stroke. setLineDash([1,1]) + strokeRect renders as a solid
      // line under both node-canvas and browser sub-pixel strokes — draw
      // the dots explicitly via 1×1 fillRects so it's pixel-perfect.
      _drawWithClip(hdc, (t) => {
        const c = t.ctx;
        const x0 = t.ox + left, y0 = t.oy + top;
        const x1 = t.ox + right - 1, y1 = t.oy + bottom - 1;
        c.save();
        c.fillStyle = '#000';
        for (let x = x0; x <= x1; x += 2) { c.fillRect(x, y0, 1, 1); c.fillRect(x, y1, 1, 1); }
        for (let y = y0 + 2; y <= y1 - 2; y += 2) { c.fillRect(x0, y, 1, 1); c.fillRect(x1, y, 1, 1); }
        c.restore();
      });
      return 1;
    },
    gdi_rectangle: (hdc, left, top, right, bottom) => {
      const dc = _getDC(hdc);
      _drawWithClip(hdc, (t) => {
        const c = t.ctx;
        const x = t.ox + left, y = t.oy + top, w = right - left, h = bottom - top;
        const bc = dc.brushColor || 0;
        c.fillStyle = `rgb(${bc & 0xFF},${(bc >> 8) & 0xFF},${(bc >> 16) & 0xFF})`;
        c.fillRect(x, y, w, h);
        const pc = dc.penColor || 0;
        c.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
        c.lineWidth = dc.penWidth || 1;
        c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      });
      return 1;
    },
    gdi_ellipse: (hdc, left, top, right, bottom) => {
      const dc = _getDC(hdc);
      _drawWithClip(hdc, (t) => {
        const c = t.ctx;
        const cx = t.ox + (left + right) / 2, cy = t.oy + (top + bottom) / 2;
        const rx = (right - left) / 2, ry = (bottom - top) / 2;
        c.beginPath();
        c.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
        const bc = dc.brushColor;
        c.fillStyle = `rgb(${bc & 0xFF},${(bc >> 8) & 0xFF},${(bc >> 16) & 0xFF})`;
        c.fill();
        const pc = dc.penColor;
        c.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
        c.lineWidth = dc.penWidth;
        c.stroke();
      });
      return 1;
    },
    gdi_polygon: (hdc, pointsWA, nCount) => {
      if (nCount < 2) return 1;
      const dv = new DataView(ctx.getMemory());
      const dc = _getDC(hdc);
      _drawWithClip(hdc, (t) => {
        const c = t.ctx;
        c.beginPath();
        c.moveTo(t.ox + dv.getInt32(pointsWA, true), t.oy + dv.getInt32(pointsWA + 4, true));
        for (let i = 1; i < nCount; i++) {
          c.lineTo(t.ox + dv.getInt32(pointsWA + i * 8, true), t.oy + dv.getInt32(pointsWA + i * 8 + 4, true));
        }
        c.closePath();
        const bc = dc.brushColor;
        c.fillStyle = `rgb(${bc & 0xFF},${(bc >> 8) & 0xFF},${(bc >> 16) & 0xFF})`;
        c.fill();
        const pc = dc.penColor;
        c.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
        c.lineWidth = dc.penWidth;
        c.stroke();
      });
      return 1;
    },
    gdi_create_rect_rgn: (l, t, r, b) => {
      const h = _gdiAlloc(_makeRectRgn(l, t, r, b));
      _traceRgn('CreateRectRgn', l, t, r, b, '→', '0x'+h.toString(16));
      return h;
    },
    gdi_create_ellipse_rgn: (l, t, r, b) => {
      const h = _gdiAlloc(_makeEllipseRgn(l, t, r, b));
      _traceRgn('CreateEllipticRgn', l, t, r, b, '→', '0x'+h.toString(16));
      return h;
    },
    gdi_create_polygon_rgn: (ptsWA, n, fillMode) => {
      const dv = new DataView(ctx.getMemory());
      const pts = [];
      for (let i = 0; i < n; i++) {
        pts.push({
          x: dv.getInt32(ptsWA + i * 8, true),
          y: dv.getInt32(ptsWA + i * 8 + 4, true),
        });
      }
      const h = _gdiAlloc(_makePolygonRgn(pts, fillMode));
      _traceRgn('CreatePolygonRgn', 'n=', n, 'fill=', fillMode, '→', '0x'+h.toString(16));
      return h;
    },
    gdi_get_rgn_box: (hrgn, lprectWA) => {
      const rgn = _gdiObjects[hrgn];
      if (!rgn || rgn.type !== 'region') return 0;
      if (lprectWA) {
        const dv = new DataView(ctx.getMemory());
        dv.setInt32(lprectWA, rgn.bbox.l, true);
        dv.setInt32(lprectWA + 4, rgn.bbox.t, true);
        dv.setInt32(lprectWA + 8, rgn.bbox.r, true);
        dv.setInt32(lprectWA + 12, rgn.bbox.b, true);
      }
      const empty = (rgn.bbox.r <= rgn.bbox.l) || (rgn.bbox.b <= rgn.bbox.t);
      if (empty) return 1;
      return rgn.branches.length > 1 ? 3 : 2;
    },
    gdi_set_rect_rgn: (hrgn, l, t, r, b) => {
      const rgn = _gdiObjects[hrgn];
      if (!rgn || rgn.type !== 'region') return 0;
      const fresh = _makeRectRgn(l, t, r, b);
      rgn.branches = fresh.branches;
      rgn.bbox = fresh.bbox;
      rgn.simpleRect = fresh.simpleRect;
      rgn.rects = fresh.rects;
      return 1;
    },
    gdi_combine_rgn: (hrgnDst, hrgnSrc1, hrgnSrc2, fnCombineMode) => {
      const r1 = _gdiObjects[hrgnSrc1];
      const dst = _gdiObjects[hrgnDst];
      if (!r1 || r1.type !== 'region' || !dst || dst.type !== 'region') return 0;
      // RGN_COPY only needs src1; everything else needs src2.
      let result;
      try {
        if (fnCombineMode === 5) {
          result = _cloneRgn(r1);
        } else {
          const r2 = _gdiObjects[hrgnSrc2];
          if (!r2 || r2.type !== 'region') return 0;
          result = _combineRgn(fnCombineMode, r1, r2);
        }
      } catch (e) {
        console.error('[rgn] CombineRgn failed:', e.message);
        throw e;
      }
      dst.branches = result.branches;
      dst.bbox = result.bbox;
      dst.simpleRect = null; // any combine clears simpleRect
      dst.rects = result.rects;
      _traceRgn('CombineRgn mode=', fnCombineMode, 'dst=', '0x'+hrgnDst.toString(16),
        'branches=', dst.branches.length);
      const empty = (dst.bbox.r <= dst.bbox.l) || (dst.bbox.b <= dst.bbox.t);
      if (empty) return 1;
      return dst.branches.length > 1 ? 3 : 2;
    },
    gdi_set_window_rgn: (hwnd, hrgn, redraw) => {
      const rgn = _gdiObjects[hrgn];
      if (!rgn || rgn.type !== 'region') return 0;
      if (ctx.renderer) {
        ctx.renderer.setWindowRgn(hwnd, rgn);
        if (redraw) ctx.renderer.scheduleRepaint();
      }
      return 1;
    },
    gdi_select_clip_rgn: (hdc, hrgn) => {
      const dc = _getDC(hdc);
      if (hrgn === 0) { dc.clipRgn = null; _traceRgn('SelectClipRgn(NULL) on', '0x'+hdc.toString(16)); return 1; }
      const rgn = _gdiObjects[hrgn];
      if (!rgn || rgn.type !== 'region') return 0;
      dc.clipRgn = _cloneRgn(rgn);
      _traceRgn('SelectClipRgn', '0x'+hdc.toString(16), '←', '0x'+hrgn.toString(16),
        'branches=', dc.clipRgn.branches.length);
      const empty = (dc.clipRgn.bbox.r <= dc.clipRgn.bbox.l) || (dc.clipRgn.bbox.b <= dc.clipRgn.bbox.t);
      if (empty) return 1;
      return dc.clipRgn.branches.length > 1 ? 3 : 2;
    },
    gdi_ext_select_clip_rgn: (hdc, hrgn, fnMode) => {
      const dc = _getDC(hdc);
      // fnMode: 1=AND, 2=OR, 3=XOR, 4=DIFF, 5=COPY  (matches CombineRgn modes)
      if (fnMode === 5 || hrgn === 0) {
        if (hrgn === 0) { dc.clipRgn = null; return 1; }
        const rgn = _gdiObjects[hrgn];
        if (!rgn || rgn.type !== 'region') return 0;
        dc.clipRgn = _cloneRgn(rgn);
        return dc.clipRgn.branches.length > 1 ? 3 : 2;
      }
      const rgn = _gdiObjects[hrgn];
      if (!rgn || rgn.type !== 'region') return 0;
      const base = dc.clipRgn || _makeRectRgn(-1 << 30, -1 << 30, 1 << 30, 1 << 30);
      try {
        dc.clipRgn = _combineRgn(fnMode, base, rgn);
      } catch (e) {
        console.error('[rgn] ExtSelectClipRgn failed:', e.message);
        throw e;
      }
      const empty = (dc.clipRgn.bbox.r <= dc.clipRgn.bbox.l) || (dc.clipRgn.bbox.b <= dc.clipRgn.bbox.t);
      if (empty) return 1;
      return dc.clipRgn.branches.length > 1 ? 3 : 2;
    },
    gdi_exclude_clip_rect: (hdc, l, t, r, b) => {
      const dc = _getDC(hdc);
      const rect = _makeRectRgn(l, t, r, b);
      const base = dc.clipRgn || _makeRectRgn(-1 << 30, -1 << 30, 1 << 30, 1 << 30);
      dc.clipRgn = _combineRgn(4, base, rect);
      _traceRgn('ExcludeClipRect', '0x'+hdc.toString(16), l, t, r, b,
        'branches=', dc.clipRgn.branches.length);
      const empty = (dc.clipRgn.bbox.r <= dc.clipRgn.bbox.l) || (dc.clipRgn.bbox.b <= dc.clipRgn.bbox.t);
      if (empty) return 1;
      return dc.clipRgn.branches.length > 1 ? 3 : 2;
    },
    // --- Phase 2: per-hwnd update regions ---
    invalidate_rect: (hwnd, l, t, r, b, erase) => {
      if (!hwnd) return;
      _invalRectHwnd(hwnd, l, t, r, b);
      if (ctx.renderer) ctx.renderer.invalidate(hwnd);
    },
    invalidate_rgn: (hwnd, hrgn, erase) => {
      if (!hwnd) return;
      const rgn = _gdiObjects[hrgn];
      if (rgn && rgn.type === 'region') _invalRgnHwnd(hwnd, rgn);
      if (ctx.renderer) ctx.renderer.invalidate(hwnd);
    },
    validate_rect: (hwnd, l, t, r, b) => {
      if (!hwnd) return 0;
      _valRectHwnd(hwnd, l, t, r, b);
      return _updateRgns.has(hwnd) ? 0 : 1;
    },
    validate_rgn: (hwnd, hrgn) => {
      if (!hwnd) return 0;
      const rgn = _gdiObjects[hrgn];
      if (rgn && rgn.type === 'region') _valRgnHwnd(hwnd, rgn);
      return _updateRgns.has(hwnd) ? 0 : 1;
    },
    // Write update-rect bbox to guest memory. Returns 1 if non-empty.
    get_update_rect: (hwnd, rectWA) => {
      const rgn = _updateRgns.get(hwnd);
      if (!rgn || _rgnIsEmpty(rgn)) {
        if (rectWA) {
          const dv = new DataView(ctx.getMemory());
          dv.setInt32(rectWA, 0, true); dv.setInt32(rectWA + 4, 0, true);
          dv.setInt32(rectWA + 8, 0, true); dv.setInt32(rectWA + 12, 0, true);
        }
        return 0;
      }
      if (rectWA) {
        const dv = new DataView(ctx.getMemory());
        dv.setInt32(rectWA, rgn.bbox.l, true);
        dv.setInt32(rectWA + 4, rgn.bbox.t, true);
        dv.setInt32(rectWA + 8, rgn.bbox.r, true);
        dv.setInt32(rectWA + 12, rgn.bbox.b, true);
      }
      return 1;
    },
    // Copy per-hwnd update rgn into an existing HRGN. Returns region type.
    get_update_rgn: (hwnd, dstHrgn) => {
      const dst = _gdiObjects[dstHrgn];
      if (!dst || dst.type !== 'region') return 0;
      const src = _updateRgns.get(hwnd);
      if (!src || _rgnIsEmpty(src)) {
        const fresh = _makeRectRgn(0, 0, 0, 0);
        dst.branches = fresh.branches; dst.bbox = fresh.bbox;
        dst.simpleRect = null; dst.rects = fresh.rects;
        return 1;
      }
      const clone = _cloneRgn(src);
      dst.branches = clone.branches; dst.bbox = clone.bbox;
      dst.simpleRect = clone.simpleRect; dst.rects = clone.rects;
      return clone.branches.length > 1 ? 3 : 2;
    },
    // Install updateRgn as DC clipRgn and clear updateRgn. Returns packed
    // bbox for BeginPaint rcPaint: low16=l|t<<16? No — we need 4 ints.
    // Simpler: caller passes rectWA; we write bbox there + install clip +
    // clear updateRgn. Returns 1 if updateRgn was non-empty (partial paint),
    // 0 if we returned full-client (no clip installed).
    // Walk update-region map in renderer z-order; return topmost dirty hwnd
    // or 0. Foundation for region-driven WM_PAINT delivery (Step 2).
    next_dirty_hwnd: () => {
      if (!_updateRgns.size) return 0;
      let best = 0, bestZ = -1;
      const wins = (ctx.renderer && ctx.renderer.windows) || {};
      for (const hwnd of _updateRgns.keys()) {
        const rgn = _updateRgns.get(hwnd);
        if (_rgnIsEmpty(rgn)) continue;
        const w = wins[hwnd];
        const z = w ? (w.zOrder | 0) : 0;
        if (z > bestZ) { bestZ = z; best = hwnd >>> 0; }
      }
      return best >>> 0;
    },
    begin_paint_clip: (hdc, hwnd, rectWA) => {
      const rgn = _updateRgns.get(hwnd);
      const dv = rectWA ? new DataView(ctx.getMemory()) : null;
      if (!rgn || _rgnIsEmpty(rgn)) {
        _updateRgns.delete(hwnd);
        if (dv) { dv.setInt32(rectWA, 0, true); dv.setInt32(rectWA + 4, 0, true); dv.setInt32(rectWA + 8, 0, true); dv.setInt32(rectWA + 12, 0, true); }
        return 0;
      }
      const dc = _getDC(hdc);
      dc.clipRgn = _cloneRgn(rgn);
      if (dv) {
        dv.setInt32(rectWA, rgn.bbox.l, true);
        dv.setInt32(rectWA + 4, rgn.bbox.t, true);
        dv.setInt32(rectWA + 8, rgn.bbox.r, true);
        dv.setInt32(rectWA + 12, rgn.bbox.b, true);
      }
      _traceRgn('BeginPaint clip from updateRgn hwnd=0x'+hwnd.toString(16),
        'bbox=', rgn.bbox.l, rgn.bbox.t, rgn.bbox.r, rgn.bbox.b,
        'branches=', rgn.branches.length);
      _updateRgns.delete(hwnd);
      return 1;
    },
    // Phase 3b/3c: apply WS_CLIPCHILDREN / WS_CLIPSIBLINGS by walking the
    // renderer's window map and calling ExcludeClipRect for each child /
    // z-above-sibling rect. Coords are window-local on the parent's DC.
    apply_window_clip: (hdc, hwnd) => {
      if (!ctx.renderer) return 0;
      const we = ctx.renderer.wasm && ctx.renderer.wasm.exports;
      if (!we || !we.wnd_get_style || !we.wnd_get_parent || !we.ctrl_get_xy || !we.ctrl_get_wh) return 0;
      const style = we.wnd_get_style(hwnd) >>> 0;
      // WS_CLIPCHILDREN (0x02000000): clip parent paints away from child
      // windows. Per-draw exclusion in `_excludeChildrenClip` is the real
      // enforcement layer; this DC-clipRgn copy mirrors the same policy so
      // guest queries (GetClipBox, IntersectClipRect) see consistent state.
      const clipChildren = !!(style & 0x02000000);
      const clipSiblings = !!(style & 0x04000000);
      const dc = _getDC(hdc);
      // Child clip: exclude every visible child of hwnd, in window-local coords.
      if (clipChildren && we.ctrl_get_xy && we.ctrl_get_wh) {
        // Walk WND_RECORDS via JS-side renderer.windows when available.
        const wins = ctx.renderer.windows || {};
        for (const k of Object.keys(wins)) {
          const cw = wins[k]; if (!cw) continue;
          const ch = parseInt(k);
          if ((we.wnd_get_parent(ch) >>> 0) !== hwnd) continue;
          const xy = we.ctrl_get_xy(ch) >>> 0;
          const wh = we.ctrl_get_wh(ch) >>> 0;
          const cx = xy & 0xFFFF, cy = (xy >>> 16) & 0xFFFF;
          const cwidth = wh & 0xFFFF, cheight = (wh >>> 16) & 0xFFFF;
          if (cwidth <= 0 || cheight <= 0) continue;
          const rect = _makeRectRgn(cx, cy, cx + cwidth, cy + cheight);
          const base = dc.clipRgn || _makeRectRgn(-1 << 30, -1 << 30, 1 << 30, 1 << 30);
          try { dc.clipRgn = _combineRgn(4, base, rect); } catch (e) { break; }
        }
      }
      // Sibling clip: exclude siblings with higher zOrder than hwnd.
      if (clipSiblings) {
        const wins = ctx.renderer.windows || {};
        const me = wins[hwnd];
        if (me) {
          const myZ = me.zOrder | 0;
          const parent = (we.wnd_get_parent(hwnd) >>> 0) || 0;
          for (const k of Object.keys(wins)) {
            const sw = wins[k]; if (!sw) continue;
            const sh = parseInt(k);
            if (sh === hwnd) continue;
            if (((we.wnd_get_parent(sh) >>> 0) || 0) !== parent) continue;
            if ((sw.zOrder | 0) <= myZ) continue;
            const xy = we.ctrl_get_xy(sh) >>> 0;
            const wh = we.ctrl_get_wh(sh) >>> 0;
            const cx = xy & 0xFFFF, cy = (xy >>> 16) & 0xFFFF;
            const cwidth = wh & 0xFFFF, cheight = (wh >>> 16) & 0xFFFF;
            if (cwidth <= 0 || cheight <= 0) continue;
            const rect = _makeRectRgn(cx, cy, cx + cwidth, cy + cheight);
            const base = dc.clipRgn || _makeRectRgn(-1 << 30, -1 << 30, 1 << 30, 1 << 30);
            try { dc.clipRgn = _combineRgn(4, base, rect); } catch (e) { break; }
          }
        }
      }
      return 1;
    },
    gdi_intersect_clip_rect: (hdc, l, t, r, b) => {
      const dc = _getDC(hdc);
      const rect = _makeRectRgn(l, t, r, b);
      const base = dc.clipRgn || _makeRectRgn(-1 << 30, -1 << 30, 1 << 30, 1 << 30);
      dc.clipRgn = _combineRgn(1, base, rect);
      _traceRgn('IntersectClipRect', '0x'+hdc.toString(16), l, t, r, b,
        'branches=', dc.clipRgn.branches.length);
      const empty = (dc.clipRgn.bbox.r <= dc.clipRgn.bbox.l) || (dc.clipRgn.bbox.b <= dc.clipRgn.bbox.t);
      if (empty) return 1;
      return dc.clipRgn.branches.length > 1 ? 3 : 2;
    },
    treeview_paint: (hwnd) => {
      if (!ctx.renderer) return;
      const e = ctx.renderer.wasm && ctx.renderer.wasm.exports;
      if (!e || !e.ctrl_get_xy || !e.ctrl_get_wh) return;
      const xyPacked = e.ctrl_get_xy(hwnd) >>> 0;
      const whPacked = e.ctrl_get_wh(hwnd) >>> 0;
      const cx = xyPacked & 0xFFFF, cy = (xyPacked >>> 16) & 0xFFFF;
      const cw = whPacked & 0xFFFF, ch = (whPacked >>> 16) & 0xFFFF;
      if (cw <= 0 || ch <= 0) return;
      // Find parent window's back canvas
      const parentHwnd = e.wnd_get_parent ? e.wnd_get_parent(hwnd) : 0;
      if (!parentHwnd) return;
      const topHwnd = _resolveTopHwnd(parentHwnd);
      const wc = ctx.renderer.getWindowCanvas(topHwnd);
      if (!wc) return;
      const c = wc.ctx;
      // Compute offset: parent's client area origin on the back-canvas
      const topWin = ctx.renderer.windows[topHwnd];
      let ox = 0, oy = 0;
      if (topWin && topWin.clientRect) {
        ox = topWin.clientRect.x - topWin.x;
        oy = topWin.clientRect.y - topWin.y;
      }
      const x0 = ox + cx, y0 = oy + cy;
      // White background
      c.fillStyle = '#ffffff';
      c.fillRect(x0, y0, cw, ch);
      // 3D sunken border
      c.fillStyle = '#808080'; c.fillRect(x0, y0, cw, 1); c.fillRect(x0, y0, 1, ch);
      c.fillStyle = '#ffffff'; c.fillRect(x0, y0 + ch - 1, cw, 1); c.fillRect(x0 + cw - 1, y0, 1, ch);
      c.fillStyle = '#404040'; c.fillRect(x0 + 1, y0 + 1, cw - 2, 1); c.fillRect(x0 + 1, y0 + 1, 1, ch - 2);
      c.fillStyle = '#c0c0c0'; c.fillRect(x0 + 1, y0 + ch - 2, cw - 2, 1); c.fillRect(x0 + cw - 2, y0 + 1, 1, ch - 2);
      // Read tree items from WASM memory and draw them
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      const TV_TABLE = 0x9000;
      const ITEM_SIZE = 32;
      const INDENT = 16;
      const ROW_H = 16;
      // Collect root items (parent == 0), then recurse
      const items = [];
      for (let i = 0; i < 32; i++) {
        const base = TV_TABLE + i * ITEM_SIZE;
        const handle = dv.getInt32(base, true);
        if (handle === 0) continue;
        items.push({
          handle, parent: dv.getInt32(base + 4, true),
          firstChild: dv.getInt32(base + 8, true),
          nextSib: dv.getInt32(base + 12, true),
          state: dv.getInt32(base + 20, true),
          textPtr: dv.getUint32(base + 28, true),
        });
      }
      const byHandle = {};
      for (const it of items) byHandle[it.handle] = it;
      // Read NUL-terminated ASCII string from guest memory
      const readStr = (guestPtr) => {
        if (!guestPtr) return '';
        const wa = (guestPtr - (e.get_image_base ? e.get_image_base() : 0x400000)) + 0x12000;
        if (wa < 0 || wa >= mem.length) return '';
        let s = '';
        for (let i = 0; i < 128 && mem[wa + i]; i++) s += String.fromCharCode(mem[wa + i]);
        return s;
      };
      // Draw items recursively
      let drawY = y0 + 3;
      const drawItem = (item, depth) => {
        if (drawY > y0 + ch - 4) return;
        const ix = x0 + 4 + depth * INDENT;
        const hasChildren = item.firstChild !== 0;
        // Expand/collapse box
        if (hasChildren) {
          c.strokeStyle = '#808080'; c.lineWidth = 1;
          c.strokeRect(ix, drawY + 3, 8, 8);
          c.fillStyle = '#000000';
          c.fillRect(ix + 2, drawY + 7, 5, 1); // minus
          c.fillRect(ix + 4, drawY + 5, 1, 5); // plus vertical
        }
        // Checkbox (state bit 12-15 = checkbox state, 0x2000 = checked)
        const checkState = (item.state >> 12) & 0xF;
        if (checkState > 0) {
          const cbx = ix + (hasChildren ? 12 : 0);
          c.strokeStyle = '#808080'; c.lineWidth = 1;
          c.strokeRect(cbx, drawY + 1, 12, 12);
          c.fillStyle = '#ffffff';
          c.fillRect(cbx + 1, drawY + 2, 11, 11);
          if (checkState >= 2) {
            // Checkmark
            c.strokeStyle = '#000000'; c.lineWidth = 1.5;
            c.beginPath();
            c.moveTo(cbx + 3, drawY + 7);
            c.lineTo(cbx + 5, drawY + 10);
            c.lineTo(cbx + 10, drawY + 4);
            c.stroke();
          }
        }
        // Text
        const textX = ix + (hasChildren ? 12 : 0) + (checkState > 0 ? 16 : 0);
        const text = readStr(item.textPtr);
        if (text) {
          c.fillStyle = '#000000';
          c.font = '12px "W95FA", "MS Sans Serif", Arial, sans-serif';
          c.textBaseline = 'top';
          c.fillText(text, textX, drawY + 1, cw - (textX - x0) - 4);
        }
        drawY += ROW_H;
        // Draw children (always expanded for now)
        if (item.firstChild) {
          let child = byHandle[item.firstChild];
          while (child) {
            drawItem(child, depth + 1);
            child = child.nextSib ? byHandle[child.nextSib] : null;
          }
        }
      };
      // Draw root items
      for (const it of items) {
        if (it.parent === 0) drawItem(it, 0);
      }
      ctx.renderer.scheduleRepaint();
    },
    gdi_move_to: (hdc, x, y) => {
      const dc = _getDC(hdc);
      dc.posX = x; dc.posY = y;
      return 1;
    },
    gdi_line_to: (hdc, x, y) => {
      const dc = _getDC(hdc);
      _drawWithClip(hdc, (t) => {
        const c = t.ctx;
        const pc = dc.penColor;
        c.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
        c.lineWidth = dc.penWidth;
        c.beginPath();
        c.moveTo(t.ox + dc.posX + 0.5, t.oy + dc.posY + 0.5);
        c.lineTo(t.ox + x + 0.5, t.oy + y + 0.5);
        c.stroke();
      });
      dc.posX = x; dc.posY = y;
      return 1;
    },
    gdi_arc: (hdc, left, top, right, bottom, xStart, yStart, xEnd, yEnd) => {
      const dc = _getDC(hdc);
      _drawWithClip(hdc, (t) => {
        const c = t.ctx;
        const cx = t.ox + (left + right) / 2, cy = t.oy + (top + bottom) / 2;
        const rx = (right - left) / 2, ry = (bottom - top) / 2;
        const startAngle = Math.atan2(yStart - (top + bottom) / 2, xStart - (left + right) / 2);
        const endAngle = Math.atan2(yEnd - (top + bottom) / 2, xEnd - (left + right) / 2);
        c.beginPath();
        c.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, startAngle, endAngle, true);
        const pc = dc.penColor;
        c.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
        c.lineWidth = dc.penWidth;
        c.stroke();
      });
      return 1;
    },
    gdi_bitblt: (dstDC, dx, dy, w, bh, srcDC, sx, sy, rop) => {
      // Guard against 0-size blits (e.g. 0x0 windows) — canvas throws IndexSizeError
      if (w <= 0 || bh <= 0) return 1;
      const isSrcWindow = _isWindowDC(srcDC);
      const isDstWindow = _isWindowDC(dstDC);
      // ROP constants
      const SRCCOPY     = 0x00CC0020;
      const NOTSRCCOPY  = 0x00330008;
      const SRCAND      = 0x008800C6;
      const SRCPAINT    = 0x00EE0086;
      const SRCINVERT   = 0x00660046;
      const BLACKNESS   = 0x00000042;
      const WHITENESS   = 0x00FF0062;
      const PATCOPY     = 0x00F00021;
      const DSTINVERT   = 0x00550009;

      // Resolve source and destination canvases + offsets
      const srcTarget = _getDrawTarget(srcDC);
      const dstTarget = _getDrawTarget(dstDC);
      const dstHwnd = isDstWindow ? _hwndFromDC(dstDC) : 0;
      if (globalThis.process && globalThis.process.env && globalThis.process.env.BLT_DBG) {
        if (!globalThis._bltDbg) globalThis._bltDbg = 0;
        if (globalThis._bltDbg++ < 40) console.log(`[BLT] dst=${dstDC.toString(16)}(${isDstWindow?'win':'mem'}) src=${srcDC.toString(16)}(${isSrcWindow?'win':'mem'}) rop=${rop.toString(16)} dstT=${dstTarget?'Y':'N'} srcT=${srcTarget?'Y':'N'} ${w}x${bh}@${dx},${dy}`);
      }

      // Clip to client rect when drawing to a client DC (not whole-window DC)
      if (isDstWindow && !_isWholeWindowDC(dstDC) && ctx.renderer) {
        const win = ctx.renderer.windows[dstHwnd];
        if (win && win.clientRect) {
          const cr = win.clientRect;
          // Clip left
          if (dx < 0) { sx -= dx; w += dx; dx = 0; }
          // Clip top
          if (dy < 0) { sy -= dy; bh += dy; dy = 0; }
          // Clip right
          if (dx + w > cr.w) { w = cr.w - dx; }
          // Clip bottom
          if (dy + bh > cr.h) { bh = cr.h - dy; }
          // Fully clipped
          if (w <= 0 || bh <= 0) return 1;
        }
      }
      // Clip to back-canvas bounds in canvas coords (ox+dx, oy+dy). Real GDI
      // silently clips dst to the surface; canvas getImageData throws on
      // out-of-bounds dims (e.g. Winamp vis emits w=0x26<<cl, exceeding 2GB).
      // Done in effective coords so child whole-window DCs (which translate
      // dx,dy by ox/oy into the parent back-canvas) clip correctly too.
      if (dstTarget && dstTarget.canvas) {
        const cw = dstTarget.canvas.width, ch = dstTarget.canvas.height;
        const ox = dstTarget.ox | 0, oy = dstTarget.oy | 0;
        let eX = ox + dx, eY = oy + dy;
        if (eX < 0) { sx -= eX; w += eX; dx -= eX; eX = 0; }
        if (eY < 0) { sy -= eY; bh += eY; dy -= eY; eY = 0; }
        if (eX + w > cw) w = cw - eX;
        if (eY + bh > ch) bh = ch - eY;
        if (w <= 0 || bh <= 0) return 1;
      }

      // Source-less ROPs: WHITENESS, BLACKNESS, PATCOPY, DSTINVERT
      if (rop === WHITENESS || rop === BLACKNESS || rop === PATCOPY || rop === DSTINVERT) {
        if (!dstTarget) return 1;
        if (rop === DSTINVERT) {
          // getImageData is unaffected by clip; only the put needs clipping.
          const imgData = dstTarget.ctx.getImageData(dstTarget.ox + dx, dstTarget.oy + dy, w, bh);
          for (let i = 0; i < imgData.data.length; i += 4) {
            imgData.data[i] = ~imgData.data[i] & 0xFF;
            imgData.data[i+1] = ~imgData.data[i+1] & 0xFF;
            imgData.data[i+2] = ~imgData.data[i+2] & 0xFF;
            imgData.data[i+3] = 255;
          }
          _drawWithClip(dstDC, (t) => {
            _clippedPut(t.ctx, imgData, t.ox + dx, t.oy + dy);
          });
        } else {
          let fr = 0, fg = 0, fb = 0;
          if (rop === WHITENESS) { fr = fg = fb = 255; }
          else if (rop === PATCOPY) {
            const dc = _getDC(dstDC);
            const bc = dc.brushColor || 0;
            fr = bc & 0xFF; fg = (bc >> 8) & 0xFF; fb = (bc >> 16) & 0xFF;
          }
          _drawWithClip(dstDC, (t) => {
            t.ctx.fillStyle = `rgb(${fr},${fg},${fb})`;
            t.ctx.fillRect(t.ox + dx, t.oy + dy, w, bh);
          });
        }
        return 1;
      }

      if (!srcTarget || !dstTarget) return 1;

      // Check if destination is a monochrome bitmap — color→mono conversion needed
      const dstDCState = !isDstWindow ? _getDC(dstDC) : null;
      const dstBmpObj = dstDCState && dstDCState.selectedBitmap ? _gdiObjects[dstDCState.selectedBitmap] : null;
      const dstIsMono = dstBmpObj && dstBmpObj.mono;

      // Check if source is monochrome — mono→color expansion needed
      const srcDCState2 = !isSrcWindow ? _getDC(srcDC) : null;
      const srcBmpObj = srcDCState2 && srcDCState2.selectedBitmap ? _gdiObjects[srcDCState2.selectedBitmap] : null;
      const srcIsMono = srcBmpObj && srcBmpObj.mono;

      // Mono→color expansion: bit 0→dest text color, bit 1→dest bg color
      let monoTextR = 0, monoTextG = 0, monoTextB = 0;
      let monoBgcR = 255, monoBgcG = 255, monoBgcB = 255;
      // Foreground colour of the mono bitmap's palette (palette[0]).
      // Default black; overridden when the bitmap stores a non-black
      // foreground (e.g. hearts/diamonds cards use red).
      let monoFgR = 0, monoFgG = 0, monoFgB = 0;
      if (srcIsMono) {
        const ddc = _getDC(dstDC);
        const tc = ddc.textColor !== undefined ? ddc.textColor : 0x000000;
        monoTextR = tc & 0xFF; monoTextG = (tc >> 8) & 0xFF; monoTextB = (tc >> 16) & 0xFF;
        const bc = ddc.bkColor !== undefined ? ddc.bkColor : 0xFFFFFF;
        monoBgcR = bc & 0xFF; monoBgcG = (bc >> 8) & 0xFF; monoBgcB = (bc >> 16) & 0xFF;
        if (srcBmpObj && srcBmpObj.monoFg) {
          monoFgR = srcBmpObj.monoFg.r; monoFgG = srcBmpObj.monoFg.g; monoFgB = srcBmpObj.monoFg.b;
        }
      }

      // SRCCOPY: use getImageData/putImageData to ensure opaque copy (no alpha compositing)
      if (rop === SRCCOPY) {
        const imgData = srcTarget.ctx.getImageData(srcTarget.ox + sx, srcTarget.oy + sy, w, bh);
        if (srcIsMono && !dstIsMono) {
          for (let i = 0; i < imgData.data.length; i += 4) {
            const isBit0 = (imgData.data[i] === monoFgR && imgData.data[i+1] === monoFgG && imgData.data[i+2] === monoFgB);
            imgData.data[i]   = isBit0 ? monoTextR : monoBgcR;
            imgData.data[i+1] = isBit0 ? monoTextG : monoBgcG;
            imgData.data[i+2] = isBit0 ? monoTextB : monoBgcB;
            imgData.data[i+3] = 255;
          }
        } else if (dstIsMono) {
          // Color→mono conversion: src bg color → white, else → black
          const srcDCState = _getDC(srcDC);
          const bgc = srcDCState.bkColor !== undefined ? srcDCState.bkColor : 0xFFFFFF;
          const bgR = bgc & 0xFF, bgG = (bgc >> 8) & 0xFF, bgB = (bgc >> 16) & 0xFF;
          for (let i = 0; i < imgData.data.length; i += 4) {
            const match = (imgData.data[i] === bgR && imgData.data[i+1] === bgG && imgData.data[i+2] === bgB);
            imgData.data[i] = imgData.data[i+1] = imgData.data[i+2] = match ? 255 : 0;
            imgData.data[i+3] = 255;
          }
        } else {
          // Win32 has no alpha — force all pixels opaque
          for (let i = 3; i < imgData.data.length; i += 4) imgData.data[i] = 255;
        }
        _drawWithClip(dstDC, (t) => {
          _clippedPut(t.ctx, imgData, t.ox + dx, t.oy + dy);
        });
        return 1;
      }

      // Complex ROPs: pixel-level operation via getImageData
      const srcData = srcTarget.ctx.getImageData(srcTarget.ox + sx, srcTarget.oy + sy, w, bh);
      const dstData = dstTarget.ctx.getImageData(dstTarget.ox + dx, dstTarget.oy + dy, w, bh);
      // For mono destination: get source DC background color for thresholding
      let monoDstBgR = 255, monoDstBgG = 255, monoDstBgB = 255;
      if (dstIsMono) {
        const srcDCState = _getDC(srcDC);
        const bgc = srcDCState.bkColor !== undefined ? srcDCState.bkColor : 0xFFFFFF;
        monoDstBgR = bgc & 0xFF; monoDstBgG = (bgc >> 8) & 0xFF; monoDstBgB = (bgc >> 16) & 0xFF;
      }
      for (let i = 0; i < srcData.data.length; i += 4) {
        let sr = srcData.data[i], sg = srcData.data[i+1], sb = srcData.data[i+2];
        // Mono→color expansion before ROP
        if (srcIsMono && !dstIsMono) {
          const isBit0 = (sr === monoFgR && sg === monoFgG && sb === monoFgB);
          sr = isBit0 ? monoTextR : monoBgcR;
          sg = isBit0 ? monoTextG : monoBgcG;
          sb = isBit0 ? monoTextB : monoBgcB;
        }
        let dr, dg, db;
        switch (rop) {
          case NOTSRCCOPY:
            dr = ~sr & 0xFF; dg = ~sg & 0xFF; db = ~sb & 0xFF; break;
          case SRCAND:
            dr = dstData.data[i] & sr; dg = dstData.data[i+1] & sg; db = dstData.data[i+2] & sb; break;
          case SRCPAINT:
            dr = dstData.data[i] | sr; dg = dstData.data[i+1] | sg; db = dstData.data[i+2] | sb; break;
          case SRCINVERT:
            dr = dstData.data[i] ^ sr; dg = dstData.data[i+1] ^ sg; db = dstData.data[i+2] ^ sb; break;
          case 0x00220326: // DSna: dst & ~src
            dr = dstData.data[i] & (~sr & 0xFF); dg = dstData.data[i+1] & (~sg & 0xFF); db = dstData.data[i+2] & (~sb & 0xFF); break;
          case 0x00440328: // SRCERASE / SDna: ~dst & src
            dr = (~dstData.data[i] & 0xFF) & sr; dg = (~dstData.data[i+1] & 0xFF) & sg; db = (~dstData.data[i+2] & 0xFF) & sb; break;
          case 0x001100A6: // NOTSRCERASE: ~(dst | src)
            dr = ~(dstData.data[i] | sr) & 0xFF; dg = ~(dstData.data[i+1] | sg) & 0xFF; db = ~(dstData.data[i+2] | sb) & 0xFF; break;
          case 0x00BB0226: // MERGEPAINT: dst | ~src
            dr = dstData.data[i] | (~sr & 0xFF); dg = dstData.data[i+1] | (~sg & 0xFF); db = dstData.data[i+2] | (~sb & 0xFF); break;
          default:
            dr = sr; dg = sg; db = sb; break;
        }
        if (dstIsMono) {
          const match = (sr === monoDstBgR && sg === monoDstBgG && sb === monoDstBgB);
          let mono = match ? 255 : 0;
          if (rop === NOTSRCCOPY) mono = mono ^ 255;
          dr = dg = db = mono;
        }
        dstData.data[i] = dr; dstData.data[i+1] = dg; dstData.data[i+2] = db;
        dstData.data[i+3] = 255;
      }
      _drawWithClip(dstDC, (t) => {
        _clippedPut(t.ctx, dstData, t.ox + dx, t.oy + dy);
      });
      return 1;
    },
    gdi_stretch_blt: (dstDC, dx, dy, dw, dh, srcDC, sx, sy, sw, sh, rop) => {
      const SRCCOPY     = 0x00CC0020;
      const NOTSRCCOPY  = 0x00330008;
      const SRCAND      = 0x008800C6;
      const SRCPAINT    = 0x00EE0086;
      const SRCINVERT   = 0x00660046;
      const BLACKNESS   = 0x00000042;
      const WHITENESS   = 0x00FF0062;
      const DSTINVERT   = 0x00550009;

      const isSrcWindow = _isWindowDC(srcDC);
      const isDstWindow = _isWindowDC(dstDC);
      const dstHwnd = isDstWindow ? _hwndFromDC(dstDC) : 0;

      const srcTarget = _getDrawTarget(srcDC);
      const dstTarget = _getDrawTarget(dstDC);

      // Source-less ROPs
      if (rop === WHITENESS || rop === BLACKNESS || rop === DSTINVERT) {
        if (!dstTarget) return 1;
        if (rop === DSTINVERT) {
          const imgData = dstTarget.ctx.getImageData(dstTarget.ox + dx, dstTarget.oy + dy, dw, dh);
          for (let i = 0; i < imgData.data.length; i += 4) {
            imgData.data[i] = ~imgData.data[i] & 0xFF;
            imgData.data[i+1] = ~imgData.data[i+1] & 0xFF;
            imgData.data[i+2] = ~imgData.data[i+2] & 0xFF;
            imgData.data[i+3] = 255;
          }
          _drawWithClip(dstDC, (t) => {
            _clippedPut(t.ctx, imgData, t.ox + dx, t.oy + dy);
          });
        } else {
          _drawWithClip(dstDC, (t) => {
            t.ctx.fillStyle = rop === WHITENESS ? '#ffffff' : '#000000';
            t.ctx.fillRect(t.ox + dx, t.oy + dy, dw, dh);
          });
        }
        return 1;
      }

      if (!srcTarget || !dstTarget) return 1;

      // Mono→color expansion for source
      const sbSrcDC = !isSrcWindow ? _getDC(srcDC) : null;
      const sbSrcBmp = sbSrcDC && sbSrcDC.selectedBitmap ? _gdiObjects[sbSrcDC.selectedBitmap] : null;
      const sbSrcMono = sbSrcBmp && sbSrcBmp.mono;
      let sbMtR = 0, sbMtG = 0, sbMtB = 0, sbMbR = 255, sbMbG = 255, sbMbB = 255;
      let sbFgR = 0, sbFgG = 0, sbFgB = 0;
      if (sbSrcMono) {
        const ddc = _getDC(dstDC);
        const tc2 = ddc.textColor !== undefined ? ddc.textColor : 0x000000;
        sbMtR = tc2 & 0xFF; sbMtG = (tc2 >> 8) & 0xFF; sbMtB = (tc2 >> 16) & 0xFF;
        const bc2 = ddc.bkColor !== undefined ? ddc.bkColor : 0xFFFFFF;
        sbMbR = bc2 & 0xFF; sbMbG = (bc2 >> 8) & 0xFF; sbMbB = (bc2 >> 16) & 0xFF;
        if (sbSrcBmp && sbSrcBmp.monoFg) {
          sbFgR = sbSrcBmp.monoFg.r; sbFgG = sbSrcBmp.monoFg.g; sbFgB = sbSrcBmp.monoFg.b;
        }
      }

      // When src and dst sizes match, use getImageData for pixel-perfect copy
      if (sw === dw && sh === dh) {
        if (rop === SRCCOPY) {
          const imgData = srcTarget.ctx.getImageData(srcTarget.ox + sx, srcTarget.oy + sy, sw, sh);
          if (sbSrcMono) {
            for (let i = 0; i < imgData.data.length; i += 4) {
              const isBit0 = (imgData.data[i] === sbFgR && imgData.data[i+1] === sbFgG && imgData.data[i+2] === sbFgB);
              imgData.data[i] = isBit0 ? sbMtR : sbMbR;
              imgData.data[i+1] = isBit0 ? sbMtG : sbMbG;
              imgData.data[i+2] = isBit0 ? sbMtB : sbMbB;
              imgData.data[i+3] = 255;
            }
          } else {
            for (let i = 3; i < imgData.data.length; i += 4) imgData.data[i] = 255;
          }
          _drawWithClip(dstDC, (t) => {
            _clippedPut(t.ctx, imgData, t.ox + dx, t.oy + dy);
          });
          return 1;
        }
        // Complex ROPs at 1:1
        const srcData = srcTarget.ctx.getImageData(srcTarget.ox + sx, srcTarget.oy + sy, sw, sh);
        const dstData = dstTarget.ctx.getImageData(dstTarget.ox + dx, dstTarget.oy + dy, dw, dh);
        for (let i = 0; i < srcData.data.length; i += 4) {
          let sr = srcData.data[i], sg = srcData.data[i+1], sb = srcData.data[i+2];
          if (sbSrcMono) {
            const isBit0 = (sr === sbFgR && sg === sbFgG && sb === sbFgB);
            sr = isBit0 ? sbMtR : sbMbR; sg = isBit0 ? sbMtG : sbMbG; sb = isBit0 ? sbMtB : sbMbB;
          }
          switch (rop) {
            case NOTSRCCOPY: dstData.data[i]=~sr&0xFF; dstData.data[i+1]=~sg&0xFF; dstData.data[i+2]=~sb&0xFF; break;
            case SRCAND: dstData.data[i]&=sr; dstData.data[i+1]&=sg; dstData.data[i+2]&=sb; break;
            case SRCPAINT: dstData.data[i]|=sr; dstData.data[i+1]|=sg; dstData.data[i+2]|=sb; break;
            case SRCINVERT: dstData.data[i]^=sr; dstData.data[i+1]^=sg; dstData.data[i+2]^=sb; break;
            default: dstData.data[i]=sr; dstData.data[i+1]=sg; dstData.data[i+2]=sb; break;
          }
          dstData.data[i+3] = 255;
        }
        _drawWithClip(dstDC, (t) => {
          _clippedPut(t.ctx, dstData, t.ox + dx, t.oy + dy);
        });
        return 1;
      }

      // Scaled blit: scale source to temp canvas, then apply ROP
      const tmp = _createOffscreen(dw, dh);
      if (!tmp) return 1;
      const tc = tmp.getContext('2d');
      tc.drawImage(srcTarget.canvas, srcTarget.ox + sx, srcTarget.oy + sy, sw, sh, 0, 0, dw, dh);

      if (rop === SRCCOPY) {
        const imgData = tc.getImageData(0, 0, dw, dh);
        if (sbSrcMono) {
          for (let i = 0; i < imgData.data.length; i += 4) {
            const isBit0 = (imgData.data[i] === sbFgR && imgData.data[i+1] === sbFgG && imgData.data[i+2] === sbFgB);
            imgData.data[i] = isBit0 ? sbMtR : sbMbR;
            imgData.data[i+1] = isBit0 ? sbMtG : sbMbG;
            imgData.data[i+2] = isBit0 ? sbMtB : sbMbB;
            imgData.data[i+3] = 255;
          }
        } else {
          for (let i = 3; i < imgData.data.length; i += 4) imgData.data[i] = 255;
        }
        _clippedPut(dstTarget.ctx, imgData, dstTarget.ox + dx, dstTarget.oy + dy);
        return 1;
      }

      // Scaled complex ROPs
      const srcData = tc.getImageData(0, 0, dw, dh);
      const dstData = dstTarget.ctx.getImageData(dstTarget.ox + dx, dstTarget.oy + dy, dw, dh);
      for (let i = 0; i < srcData.data.length; i += 4) {
        let sr = srcData.data[i], sg = srcData.data[i+1], sb = srcData.data[i+2];
        if (sbSrcMono) {
          const isBit0 = (sr === sbFgR && sg === sbFgG && sb === sbFgB);
          sr = isBit0 ? sbMtR : sbMbR; sg = isBit0 ? sbMtG : sbMbG; sb = isBit0 ? sbMtB : sbMbB;
        }
        switch (rop) {
          case NOTSRCCOPY: dstData.data[i]=~sr&0xFF; dstData.data[i+1]=~sg&0xFF; dstData.data[i+2]=~sb&0xFF; break;
          case SRCAND: dstData.data[i]&=sr; dstData.data[i+1]&=sg; dstData.data[i+2]&=sb; break;
          case SRCPAINT: dstData.data[i]|=sr; dstData.data[i+1]|=sg; dstData.data[i+2]|=sb; break;
          case SRCINVERT: dstData.data[i]^=sr; dstData.data[i+1]^=sg; dstData.data[i+2]^=sb; break;
          default: dstData.data[i]=sr; dstData.data[i+1]=sg; dstData.data[i+2]=sb; break;
        }
        dstData.data[i+3] = 255;
      }
      _drawWithClip(dstDC, (t) => {
        _clippedPut(t.ctx, dstData, t.ox + dx, t.oy + dy);
      });
      return 1;
    },
    gdi_scroll_window: (hwnd, dx, dy) => {
      if (!ctx.renderer) return 1;
      const win = ctx.renderer.windows[hwnd];
      if (!win) return 1;
      const topHwnd = _resolveTopHwnd(hwnd);
      const wc = ctx.renderer.getWindowCanvas(topHwnd);
      if (!wc) return 1;
      const cw = wc.canvas.width;
      const ch = wc.canvas.height;
      if (cw <= 0 || ch <= 0) return 1;
      const c = wc.ctx;
      const imgData = c.getImageData(0, 0, cw, ch);
      c.clearRect(0, 0, cw, ch);
      _clippedPut(c, imgData, dx, dy);
      // Fill exposed strips with white to avoid transparent gaps
      c.fillStyle = '#ffffff';
      if (dy > 0) c.fillRect(0, 0, cw, dy);           // top strip
      if (dy < 0) c.fillRect(0, ch + dy, cw, -dy);     // bottom strip
      if (dx > 0) c.fillRect(0, 0, dx, ch);            // left strip
      if (dx < 0) c.fillRect(cw + dx, 0, -dx, ch);    // right strip
      ctx.renderer.scheduleRepaint();
      return 1;
    },
    gdi_load_bitmap: (hInstance, resourceId) => {
      // Main EXE: walk RT_BITMAP in WAT via the rsrc_find_data_wa export
      // ($find_resource handles int IDs and guest string pointers). DLL
      // bitmaps still come from the per-module dllResources map that
      // host.js/test/run.js populates at DLL load time — WAT's resource
      // walker only knows about $rsrc_rva (the main EXE), so cards.dll
      // etc. can't go through it yet.
      let bytes = null;
      if (ctx.dllResources && ctx.dllResources[hInstance]) {
        bytes = ctx.dllResources[hInstance].bitmapBytes &&
                ctx.dllResources[hInstance].bitmapBytes[resourceId >>> 0];
      }
      if (!bytes) {
        const we = ctx.exports || (ctx.renderer && ctx.renderer.wasm && ctx.renderer.wasm.exports);
        if (!we || !we.rsrc_find_data_wa) return 0;
        const dataWa = we.rsrc_find_data_wa(2, resourceId >>> 0);
        if (!dataWa) return 0;
        const size = we.rsrc_last_size();
        bytes = new Uint8Array(ctx.getMemory(), dataWa, size);
      }
      const bmp = _dib.parseDIB(bytes);
      if (!bmp) return 0;
      const pixels = new Uint8Array(bmp.pixels);
      const canvas = _createOffscreen(bmp.w, bmp.h);
      if (canvas) {
        const bc = canvas.getContext('2d');
        const imgData = bc.createImageData(bmp.w, bmp.h);
        imgData.data.set(pixels);
        bc.putImageData(imgData, 0, 0);
      }
      // LoadBitmap of a 1bpp DIB with the standard {black,white} palette
      // produces a monochrome DDB: at BitBlt time the two bit-values
      // expand to the destination DC's text/bg colors (mono→color
      // expansion). This lets apps use the same mask bitmap against
      // different surfaces with inverted text/bg to pre-AND masks into
      // color sprites (classic Win98 cartoon-screensaver trick).
      // 1bpp DIBs with a colored palette (e.g. cards.dll's diamond/heart
      // cards have palette[0]=red) are NOT masks — Win9x LoadBitmap
      // promotes them to color DDBs preserving the palette colors, so we
      // skip the mono flag and let SRCCOPY copy the canvas as-is.
      const isStdMono = (bmp.bpp === 1) && bmp.monoFg
        && bmp.monoFg.r === 0 && bmp.monoFg.g === 0 && bmp.monoFg.b === 0;
      return _gdiAlloc({ type: 'bitmap', w: bmp.w, h: bmp.h, pixels, canvas,
        bpp: bmp.bpp, indices: bmp.indices, paletteBGRA: bmp.paletteBGRA,
        mono: isStdMono, monoFg: bmp.monoFg });
    },
    gdi_get_object_w: (hObj) => {
      const obj = _gdiObjects[hObj];
      if (!obj || obj.type !== 'bitmap') return 0;
      return obj.w;
    },
    gdi_get_object_h: (hObj) => {
      const obj = _gdiObjects[hObj];
      if (!obj || obj.type !== 'bitmap') return 0;
      return obj.h;
    },

    // --- DC state setters ---
    gdi_set_text_color: (hdc, color) => {
      const dc = _getDC(hdc);
      const prev = dc.textColor || 0;
      dc.textColor = color & 0xFFFFFF;
      return prev;
    },
    gdi_get_bk_color: (hdc) => {
      const dc = _getDC(hdc);
      return dc.bkColor !== undefined ? dc.bkColor : 0xFFFFFF;
    },
    gdi_get_text_color: (hdc) => {
      const dc = _getDC(hdc);
      return dc.textColor !== undefined ? dc.textColor : 0x000000;
    },
    gdi_set_bk_color: (hdc, color) => {
      const dc = _getDC(hdc);
      const prev = dc.bkColor !== undefined ? dc.bkColor : 0xFFFFFF;
      dc.bkColor = color & 0xFFFFFF;
      return prev;
    },
    gdi_set_bk_mode: (hdc, mode) => {
      const dc = _getDC(hdc);
      const prev = dc.bkMode || 2; // OPAQUE=2
      dc.bkMode = mode;
      return prev;
    },
    gdi_set_text_align: (hdc, fMode) => {
      const dc = _getDC(hdc);
      const prev = dc.textAlign !== undefined ? dc.textAlign : 0; // default TA_LEFT|TA_TOP|TA_NOUPDATECP
      dc.textAlign = fMode >>> 0;
      return prev;
    },
    gdi_get_text_align: (hdc) => {
      const dc = _getDC(hdc);
      return dc.textAlign !== undefined ? dc.textAlign : 0;
    },
    gdi_set_viewport_org: (hdc, x, y) => {
      const dc = _getDC(hdc);
      dc.vpOrgX = x | 0;
      dc.vpOrgY = y | 0;
      return 0;
    },
    gdi_get_viewport_org_x: (hdc) => _getDC(hdc).vpOrgX | 0,
    gdi_get_viewport_org_y: (hdc) => _getDC(hdc).vpOrgY | 0,
    // Window origin: logical coord → device = logical - WindowOrg + ViewportOrg.
    // With MM_TEXT (1:1 extents) this is the only mapping piece we track.
    gdi_set_window_org: (hdc, x, y) => {
      const dc = _getDC(hdc);
      dc.winOrgX = x | 0;
      dc.winOrgY = y | 0;
      return 0;
    },
    gdi_get_window_org_x: (hdc) => _getDC(hdc).winOrgX | 0,
    gdi_get_window_org_y: (hdc) => _getDC(hdc).winOrgY | 0,

    gdi_text_out: (hdc, x, y, textPtr, nCount, isWide) => {
      const mem = new Uint8Array(ctx.getMemory());
      let text = '';
      if (isWide) {
        const dv = new DataView(ctx.getMemory());
        for (let i = 0; i < nCount; i++) {
          const ch = dv.getUint16(textPtr + i * 2, true);
          if (!ch) break;
          text += String.fromCharCode(ch);
        }
      } else {
        for (let i = 0; i < nCount && mem[textPtr + i]; i++) text += String.fromCharCode(mem[textPtr + i]);
      }

      const dc = _getDC(hdc);
      const textColor = dc.textColor || 0;
      const r = textColor & 0xFF, g = (textColor >> 8) & 0xFF, b = (textColor >> 16) & 0xFF;
      const bkMode = dc.bkMode || 2; // OPAQUE=2, TRANSPARENT=1
      const bkColor = dc.bkColor !== undefined ? dc.bkColor : 0xFFFFFF;
      const font = _resolveFont(hdc);
      const fontHeight = parseInt(font.match(/(\d+)px/)?.[1]) || 13;

      // TA_* flags: horizontal (mask 6) → LEFT=0, RIGHT=2, CENTER=6;
      // vertical (mask 24) → TOP=0, BOTTOM=8, BASELINE=24.
      const ta = dc.textAlign | 0;
      const hAlign = ta & 6;
      const vAlign = ta & 24;
      const canvasAlign = hAlign === 2 ? 'right' : hAlign === 6 ? 'center' : 'left';
      const canvasBaseline = vAlign === 24 ? 'alphabetic' : vAlign === 8 ? 'bottom' : 'top';

      const drawText = (c, dx, dy) => {
        c.font = font;
        const tw = Math.round(c.measureText(text).width);
        // Background rect must match the aligned glyph box, not a fixed top-left anchor.
        let bgX = dx;
        if (hAlign === 2) bgX = dx - tw;
        else if (hAlign === 6) bgX = dx - (tw >> 1);
        let bgY = dy;
        if (vAlign === 8) bgY = dy - fontHeight;
        else if (vAlign === 24) bgY = dy - Math.round(fontHeight * 0.8);
        if (bkMode === 2) {
          const br = bkColor & 0xFF, bg2 = (bkColor >> 8) & 0xFF, bb = (bkColor >> 16) & 0xFF;
          c.fillStyle = `rgb(${br},${bg2},${bb})`;
          c.fillRect(bgX, bgY, tw, fontHeight);
        }
        c.fillStyle = `rgb(${r},${g},${b})`;
        c.textAlign = canvasAlign;
        c.textBaseline = canvasBaseline;
        c.fillText(text, dx, dy);
        c.textAlign = 'left';
        c.textBaseline = 'alphabetic';
      };

      if (_isWindowDC(hdc) || _isSurfaceDC(hdc)) {
        _drawWithClip(hdc, (target) => {
          drawText(target.ctx, target.ox + x, target.oy + y);
        });
        return 1;
      }

      const dstBmp = dc.selectedBitmap ? _gdiObjects[dc.selectedBitmap] : null;
      if (!dstBmp || !dstBmp.canvas) return 1;
      // Bitmap-DC path: _getDrawTarget already routes here, so reuse _drawWithClip.
      _drawWithClip(hdc, (target) => { drawText(target.ctx, target.ox + x, target.oy + y); });
      return 1;
    },

    gdi_draw_text: (hdc, textPtr, nCount, rectWA, uFormat, isWide) => {
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      let text = '';
      if (isWide) {
        if (nCount === -1) {
          for (let i = 0; ; i++) {
            const ch = dv.getUint16(textPtr + i * 2, true);
            if (!ch) break;
            text += String.fromCharCode(ch);
          }
        } else {
          for (let i = 0; i < nCount; i++) text += String.fromCharCode(dv.getUint16(textPtr + i * 2, true));
        }
      } else {
        if (nCount === -1) {
          for (let i = 0; ; i++) {
            const ch = mem[textPtr + i];
            if (!ch) break;
            text += String.fromCharCode(ch);
          }
        } else {
          for (let i = 0; i < nCount; i++) text += String.fromCharCode(mem[textPtr + i]);
        }
      }

      // Default Win32 DrawText processes & as a mnemonic prefix (strip the
      // & and underline the next char). DT_NOPREFIX (0x800) disables it.
      // We strip here and remember the underline target so it can be drawn
      // after the text is laid out below. Matches the old _drawAccelText
      // behaviour previously hand-rolled by the JS menu painter.
      let _accelIdx = -1; // index *in stripped text* of the char to underline
      if (!(uFormat & 0x800) && text.indexOf('&') !== -1) {
        let stripped = '';
        for (let i = 0; i < text.length; i++) {
          if (text[i] === '&' && i + 1 < text.length) {
            if (text[i + 1] === '&') { stripped += '&'; i++; continue; }
            if (_accelIdx < 0) _accelIdx = stripped.length;
            stripped += text[i + 1];
            i++;
            continue;
          }
          stripped += text[i];
        }
        text = stripped;
      }

      const dc = _getDC(hdc);
      const font = _resolveFont(hdc);
      const fontHeight = parseInt(font.match(/(\d+)px/)?.[1]) || 13;

      const t = _getDrawTarget(hdc, 0);
      if (!t) return fontHeight;
      t.ctx.font = font;

      // Read rect from guest memory (4 * i32)
      let left = dv.getInt32(rectWA, true);
      let top = dv.getInt32(rectWA + 4, true);
      let right = dv.getInt32(rectWA + 8, true);
      let bottom = dv.getInt32(rectWA + 12, true);

      const th = fontHeight;
      const rectW = right - left;

      // DT_WORDBREAK (0x10) without DT_SINGLELINE: split text into lines
      // that fit within rectW. Plain greedy word-wrap by spaces; long words
      // that don't fit get a line of their own (still clipped, matches GDI).
      const wantsWrap = (uFormat & 0x10) && !(uFormat & 0x20) && rectW > 0;
      let lines;
      if (wantsWrap) {
        lines = [];
        // Split by space but keep words; preserve no-break for empty input.
        const words = text.split(' ');
        let cur = '';
        for (let wi = 0; wi < words.length; wi++) {
          const word = words[wi];
          const candidate = cur === '' ? word : cur + ' ' + word;
          if (Math.round(t.ctx.measureText(candidate).width) <= rectW) {
            cur = candidate;
          } else {
            if (cur !== '') lines.push(cur);
            cur = word;
          }
        }
        if (cur !== '') lines.push(cur);
        if (lines.length === 0) lines = [''];
      } else {
        lines = [text];
      }

      const tw = Math.round(t.ctx.measureText(lines[0]).width);
      const totalH = th * lines.length;

      if (uFormat & 0x400) { // DT_CALCRECT
        let maxW = 0;
        for (const ln of lines) maxW = Math.max(maxW, Math.round(t.ctx.measureText(ln).width));
        right = left + maxW;
        bottom = top + totalH;
        dv.setInt32(rectWA + 8, right, true);
        dv.setInt32(rectWA + 12, bottom, true);
        return totalH;
      }

      let yStart = top;
      // DT_VCENTER applies to single-line only; for word-wrap GDI ignores it.
      if (uFormat & 0x20) { // DT_SINGLELINE
        if (uFormat & 0x04) yStart = top + (bottom - top - th) / 2; // DT_VCENTER
        else if (uFormat & 0x08) yStart = bottom - th; // DT_BOTTOM
      }

      const textColor = dc.textColor || 0;
      const r = textColor & 0xFF, g = (textColor >> 8) & 0xFF, b = (textColor >> 16) & 0xFF;
      const bkMode = dc.bkMode || 2;
      const bkColor = dc.bkColor !== undefined ? dc.bkColor : 0xFFFFFF;

      _drawWithClip(hdc, (tt) => {
        const c = tt.ctx;
        c.font = font;
        c.textBaseline = 'top';
        for (let li = 0; li < lines.length; li++) {
          const ln = lines[li];
          const lw = Math.round(c.measureText(ln).width);
          let lx = left;
          if (uFormat & 0x01) lx = left + (right - left - lw) / 2; // DT_CENTER
          else if (uFormat & 0x02) lx = right - lw; // DT_RIGHT
          const ly = yStart + li * th;
          if (bkMode === 2) { // OPAQUE
            const br = bkColor & 0xFF, bg2 = (bkColor >> 8) & 0xFF, bb = (bkColor >> 16) & 0xFF;
            c.fillStyle = `rgb(${br},${bg2},${bb})`;
            c.fillRect(tt.ox + lx, tt.oy + ly, lw, th);
          }
          c.fillStyle = `rgb(${r},${g},${b})`;
          c.fillText(ln, tt.ox + lx, tt.oy + ly);
          // Underline accelerator only if it lands on this line. _accelIdx
          // is in the original (pre-wrap) string; map it through line splits.
          if (_accelIdx >= 0 && li === 0 /* simple: only first line */ && !wantsWrap) {
            const ch = ln[_accelIdx];
            if (ch != null) {
              const prefixIncl = c.measureText(ln.substring(0, _accelIdx + 1)).width;
              const chWidth    = c.measureText(ch).width;
              const ux = tt.ox + lx + Math.round(prefixIncl - chWidth);
              const uw = Math.max(1, Math.round(chWidth));
              const m = c.measureText(ch);
              let glyphBottom = th;
              if (m.actualBoundingBoxDescent != null) glyphBottom = m.actualBoundingBoxDescent;
              const uy = tt.oy + ly + Math.round(glyphBottom) + 1;
              c.fillRect(ux, uy, uw, 1);
            }
          }
        }
      });
      return totalH;
    },

    gdi_get_pixel: (hdc, x, y) => {
      const t = _getDrawTarget(hdc, 0);
      if (!t) return 0xFFFFFFFF; // CLR_INVALID
      const px = t.ox + x, py = t.oy + y;
      // Real GDI returns CLR_INVALID for out-of-bounds reads. node-canvas
      // returns transparent black (0) instead, which breaks bitmap edge-scan
      // loops (e.g. Winamp's button-strip parser at 0x40c180 that uses
      // GetPixel == -1 as the only loop exit condition).
      if (px < 0 || py < 0 || px >= t.canvas.width || py >= t.canvas.height) {
        return 0xFFFFFFFF;
      }
      try {
        const data = t.ctx.getImageData(px, py, 1, 1).data;
        return data[0] | (data[1] << 8) | (data[2] << 16);
      } catch (_) { return 0xFFFFFFFF; }
    },
    gdi_set_pixel: (hdc, x, y, color) => {
      const r = color & 0xFF, g = (color >> 8) & 0xFF, b = (color >> 16) & 0xFF;
      _drawWithClip(hdc, (t) => {
        t.ctx.fillStyle = `rgb(${r},${g},${b})`;
        t.ctx.fillRect(t.ox + x, t.oy + y, 1, 1);
      });
      return color;
    },
    gdi_get_di_bits: (hdc, hBitmap, startScan, numScans, bitsGA, bmiWA, colorUse) => {
      // GetDIBits: read pixel data from a device-dependent bitmap into a DIB buffer
      const bmp = _gdiObjects[hBitmap];
      if (!bmp || !bmp.canvas) {
        // If lpvBits is NULL (bitsGA=0), just fill in the BITMAPINFOHEADER
        if (!bitsGA && bmiWA) {
          const dv = new DataView(ctx.getMemory());
          // Fill with basic info — caller wants dimensions/format
          dv.setUint32(bmiWA, 40, true);     // biSize
          dv.setInt32(bmiWA + 4, 1, true);   // biWidth
          dv.setInt32(bmiWA + 8, 1, true);   // biHeight
          dv.setUint16(bmiWA + 12, 1, true); // biPlanes
          dv.setUint16(bmiWA + 14, 24, true);// biBitCount
          return 1;
        }
        return 0;
      }
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      const w = bmp.w, h = bmp.h;
      // If lpvBits is NULL, fill BITMAPINFOHEADER with bitmap dimensions.
      // Report the bitmap's true bpp so the caller (e.g. winamp's skin loader)
      // allocates the right buffer size and we can hand back palette indices
      // in the second pass.
      if (!bitsGA) {
        if (bmiWA) {
          const trueBpp = bmp.indices ? 8 : 24;
          dv.setUint32(bmiWA, 40, true);     // biSize
          dv.setInt32(bmiWA + 4, w, true);   // biWidth
          dv.setInt32(bmiWA + 8, h, true);   // biHeight (positive = bottom-up)
          dv.setUint16(bmiWA + 12, 1, true); // biPlanes
          dv.setUint16(bmiWA + 14, trueBpp, true);
          dv.setUint32(bmiWA + 16, 0, true); // biCompression = BI_RGB
          dv.setUint32(bmiWA + 20, 0, true); // biSizeImage
        }
        return h;
      }
      // Read the requested format from BITMAPINFOHEADER
      const biBitCount = bmiWA ? dv.getUint16(bmiWA + 14, true) : 24;
      const biHeight = bmiWA ? dv.getInt32(bmiWA + 8, true) : h;
      const topDown = biHeight < 0;
      const rowBytes = Math.ceil((w * biBitCount) / 32) * 4;
      const g2w = ctx.g2w || (addr => addr - 0x400000 + 0x12000);
      const dstBase = g2w(bitsGA);
      // Fast path for 8bpp source → 8bpp dest: copy palette indices verbatim
      // and write the BMP-format palette right after the BITMAPINFOHEADER.
      if (biBitCount === 8 && bmp.indices) {
        if (bmiWA && bmp.paletteBGRA) {
          const palOff = bmiWA + 40;
          mem.set(bmp.paletteBGRA, palOff);
        }
        for (let row = 0; row < numScans; row++) {
          const scanY = startScan + row;
          if (scanY >= h) break;
          const srcY = topDown ? scanY : (h - 1 - scanY);
          const dstOff = dstBase + row * rowBytes;
          for (let x = 0; x < w; x++) {
            mem[dstOff + x] = bmp.indices[srcY * w + x];
          }
        }
        return numScans;
      }
      // Generic path: read RGBA from canvas
      const bc = bmp.canvas.getContext('2d');
      const imgData = bc.getImageData(0, 0, w, h);
      const src = imgData.data;
      for (let row = 0; row < numScans; row++) {
        const scanY = startScan + row;
        if (scanY >= h) break;
        // Bottom-up: scan 0 = bottom of image
        const srcY = topDown ? scanY : (h - 1 - scanY);
        const dstOff = dstBase + row * rowBytes;
        for (let x = 0; x < w; x++) {
          const si = (srcY * w + x) * 4;
          const r = src[si], g = src[si + 1], b = src[si + 2];
          if (biBitCount === 24) {
            mem[dstOff + x * 3] = b;
            mem[dstOff + x * 3 + 1] = g;
            mem[dstOff + x * 3 + 2] = r;
          } else if (biBitCount === 32) {
            mem[dstOff + x * 4] = b;
            mem[dstOff + x * 4 + 1] = g;
            mem[dstOff + x * 4 + 2] = r;
            mem[dstOff + x * 4 + 3] = 0;
          } else if (biBitCount === 8) {
            // Quantize to 8-bit (simple grayscale approximation)
            mem[dstOff + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
          }
        }
      }
      return numScans;
    },
    gdi_get_dib_color_table: (hdc, startIdx, numEntries, colorsGA) => {
      // GetDIBColorTable: read the palette of the DIB section selected into hdc.
      const dc = _getDC(hdc);
      const bmpH = dc && dc.selectedBitmap;
      const bmp = bmpH ? _gdiObjects[bmpH] : null;
      if (!bmp || !bmp.paletteBGRA) return 0;
      const palLen = bmp.paletteBGRA.length / 4;
      const count = Math.min(numEntries, Math.max(0, palLen - startIdx));
      if (count <= 0) return 0;
      const mem = new Uint8Array(ctx.getMemory());
      const g2w = ctx.g2w || (addr => addr - 0x400000 + 0x12000);
      const dst = g2w(colorsGA);
      mem.set(bmp.paletteBGRA.subarray(startIdx * 4, (startIdx + count) * 4), dst);
      return count;
    },
    gdi_set_dib_bits: (hdc, hBitmap, startScan, numScans, bitsWA, bmiWA, colorUse) => {
      // SetDIBits: copy DIB pixel data into a device-dependent bitmap
      const bmp = _gdiObjects[hBitmap];
      if (!bmp || !bmp.canvas) return 0;
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      // Read BITMAPINFOHEADER
      const biSize = dv.getUint32(bmiWA, true);
      const biWidth = dv.getInt32(bmiWA + 4, true);
      const biHeight = dv.getInt32(bmiWA + 8, true);
      const biBitCount = dv.getUint16(bmiWA + 14, true);
      const biCompression = dv.getUint32(bmiWA + 16, true);
      const w = Math.abs(biWidth), h = Math.abs(biHeight);
      const topDown = biHeight < 0;
      // Read color table for indexed formats
      const palette = [];
      if (biBitCount <= 8) {
        const numColors = 1 << biBitCount;
        const palOff = bmiWA + biSize;
        for (let i = 0; i < numColors; i++) {
          const b = mem[palOff + i * 4], g = mem[palOff + i * 4 + 1], r = mem[palOff + i * 4 + 2];
          palette.push((r << 16) | (g << 8) | b);
        }
      }
      // Decode pixels
      const rowBytes = Math.ceil((w * biBitCount) / 32) * 4; // DWORD-aligned
      const pixels = new Uint8Array(w * numScans * 4);
      for (let row = 0; row < numScans; row++) {
        const srcRow = bitsWA + row * rowBytes;
        // DIB is bottom-up by default; row 0 in bits = bottom of image
        const destY = topDown ? (startScan + row) : (h - 1 - startScan - row);
        if (destY < 0 || destY >= bmp.h) continue;
        for (let x = 0; x < w && x < bmp.w; x++) {
          const di = (row * w + x) * 4;
          let r = 0, g = 0, b = 0;
          if (biBitCount === 1) {
            const bit = (mem[srcRow + (x >> 3)] >> (7 - (x & 7))) & 1;
            const c = palette[bit] || (bit ? 0xFFFFFF : 0);
            r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
          } else if (biBitCount === 4) {
            const nibble = (x & 1) ? (mem[srcRow + (x >> 1)] & 0xF) : ((mem[srcRow + (x >> 1)] >> 4) & 0xF);
            const c = palette[nibble] || 0;
            r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
          } else if (biBitCount === 8) {
            const c = palette[mem[srcRow + x]] || 0;
            r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
          } else if (biBitCount === 24) {
            const si = srcRow + x * 3;
            b = mem[si]; g = mem[si + 1]; r = mem[si + 2];
          } else if (biBitCount === 32) {
            const si = srcRow + x * 4;
            b = mem[si]; g = mem[si + 1]; r = mem[si + 2];
          }
          pixels[di] = r; pixels[di + 1] = g; pixels[di + 2] = b; pixels[di + 3] = 255;
        }
      }
      // Write to bitmap canvas
      const bc = bmp.canvas.getContext('2d');
      const imgData = bc.createImageData(w, numScans);
      imgData.data.set(pixels);
      // Place at correct Y position — for bottom-up DIB, row 0 of bits maps to bottom
      const putY = topDown ? startScan : Math.max(0, h - startScan - numScans);
      bc.putImageData(imgData, 0, putY);
      return numScans;
    },
    gdi_set_dib_to_device: (hdc, xDest, yDest, w, h, xSrc, ySrc, startScan, cLines, bitsWA, bmiWA, colorUse) => {
      // Perf instrumentation: set `globalThis.PROF_SDI = true` in DevTools
      // (or PROF_SDI=1 env in node). Logs running stats every ~120 calls.
      const _profOn = (typeof globalThis !== 'undefined' && globalThis.PROF_SDI) || _env.PROF_SDI;
      const _t0 = _profOn ? performance.now() : 0;
      // SetDIBitsToDevice: draw DIB rectangle directly to DC
      const t = _getDrawTarget(hdc, 0);
      if (!t) { if (!globalThis._sdiNoTarget) { globalThis._sdiNoTarget = true; console.warn(`SetDIBitsToDevice: no draw target for hdc=0x${hdc.toString(16)}`); } return 0; }
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      const biWidth = dv.getInt32(bmiWA + 4, true);
      const biHeight = dv.getInt32(bmiWA + 8, true);
      const biBitCount = dv.getUint16(bmiWA + 14, true);
      const biSize = dv.getUint32(bmiWA, true);
      const biCompression = dv.getUint32(bmiWA + 16, true);
      const imgW = Math.abs(biWidth), imgH = Math.abs(biHeight);
      const topDown = biHeight < 0;
      if (!globalThis._sdiLogCount) globalThis._sdiLogCount = 0;
      if (globalThis._sdiLogCount++ < 3) console.log(`SetDIBitsToDevice: ${imgW}x${imgH} ${biBitCount}bpp topDown=${topDown} comp=${biCompression} dest=${xDest},${yDest} src=${xSrc},${ySrc} cLines=${cLines}`);
      // Palette: pack as ABGR u32 (little-endian RGBA in canvas ImageData).
      let pal32 = null;
      if (biBitCount <= 8) {
        const numColors = 1 << biBitCount;
        const palOff = bmiWA + biSize;
        pal32 = globalThis._sdiPalBuf || (globalThis._sdiPalBuf = new Uint32Array(256));
        for (let i = 0; i < numColors; i++) {
          const b = mem[palOff + i * 4], g = mem[palOff + i * 4 + 1], r = mem[palOff + i * 4 + 2];
          pal32[i] = 0xFF000000 | (b << 16) | (g << 8) | r;
        }
      }
      const rowBytes = Math.ceil((imgW * biBitCount) / 32) * 4;
      const need = w * h;
      let p32 = globalThis._sdiPixBuf32;
      if (!p32 || p32.length < need) {
        globalThis._sdiPixBuf = new Uint8ClampedArray(need * 4);
        p32 = globalThis._sdiPixBuf32 = new Uint32Array(globalThis._sdiPixBuf.buffer);
      }
      const rows = Math.min(cLines, h);
      // When the requested window lies entirely inside the source DIB
      // (the dx_present case: xSrc=ySrc=0, w=imgW), we can skip the per-pixel
      // bounds check. Saves a branch per pixel — big win for 307K-iter loops.
      const srcInBounds = (xSrc >= 0) && (xSrc + w <= imgW);
      // Fast paths by bpp. All write little-endian ABGR into p32.
      if (biBitCount === 8) {
        if (srcInBounds) {
          for (let row = 0; row < rows; row++) {
            const srcRow = bitsWA + (startScan + row) * rowBytes + xSrc;
            const destRow = topDown ? row : (h - 1 - row);
            const dstBase = destRow * w;
            for (let x = 0; x < w; x++) {
              p32[dstBase + x] = pal32[mem[srcRow + x]];
            }
          }
        } else {
          for (let row = 0; row < rows; row++) {
            const srcRow = bitsWA + (startScan + row) * rowBytes;
            const destRow = topDown ? row : (h - 1 - row);
            const dstBase = destRow * w;
            for (let x = 0; x < w; x++) {
              const sx = xSrc + x;
              if (sx < 0 || sx >= imgW) { p32[dstBase + x] = 0xFF000000; continue; }
              p32[dstBase + x] = pal32[mem[srcRow + sx]];
            }
          }
        }
      } else if (biBitCount === 16) {
        if (srcInBounds) {
          for (let row = 0; row < rows; row++) {
            const srcRow = bitsWA + (startScan + row) * rowBytes + xSrc * 2;
            const destRow = topDown ? row : (h - 1 - row);
            const dstBase = destRow * w;
            for (let x = 0; x < w; x++) {
              const si = srcRow + x * 2;
              const px = mem[si] | (mem[si + 1] << 8);
              const r = (px >> 11) << 3, g = ((px >> 5) & 0x3F) << 2, b = (px & 0x1F) << 3;
              p32[dstBase + x] = 0xFF000000 | (b << 16) | (g << 8) | r;
            }
          }
        } else {
          for (let row = 0; row < rows; row++) {
            const srcRow = bitsWA + (startScan + row) * rowBytes;
            const destRow = topDown ? row : (h - 1 - row);
            const dstBase = destRow * w;
            for (let x = 0; x < w; x++) {
              const sx = xSrc + x;
              if (sx < 0 || sx >= imgW) { p32[dstBase + x] = 0xFF000000; continue; }
              const si = srcRow + sx * 2;
              const px = mem[si] | (mem[si + 1] << 8);
              const r = (px >> 11) << 3, g = ((px >> 5) & 0x3F) << 2, b = (px & 0x1F) << 3;
              p32[dstBase + x] = 0xFF000000 | (b << 16) | (g << 8) | r;
            }
          }
        }
      } else if (biBitCount === 24) {
        if (srcInBounds) {
          for (let row = 0; row < rows; row++) {
            const srcRow = bitsWA + (startScan + row) * rowBytes + xSrc * 3;
            const destRow = topDown ? row : (h - 1 - row);
            const dstBase = destRow * w;
            for (let x = 0; x < w; x++) {
              const si = srcRow + x * 3;
              p32[dstBase + x] = 0xFF000000 | (mem[si] << 16) | (mem[si + 1] << 8) | mem[si + 2];
            }
          }
        } else {
          for (let row = 0; row < rows; row++) {
            const srcRow = bitsWA + (startScan + row) * rowBytes;
            const destRow = topDown ? row : (h - 1 - row);
            const dstBase = destRow * w;
            for (let x = 0; x < w; x++) {
              const sx = xSrc + x;
              if (sx < 0 || sx >= imgW) { p32[dstBase + x] = 0xFF000000; continue; }
              const si = srcRow + sx * 3;
              p32[dstBase + x] = 0xFF000000 | (mem[si] << 16) | (mem[si + 1] << 8) | mem[si + 2];
            }
          }
        }
      } else if (biBitCount === 32) {
        if (srcInBounds) {
          for (let row = 0; row < rows; row++) {
            const srcRow = bitsWA + (startScan + row) * rowBytes + xSrc * 4;
            const destRow = topDown ? row : (h - 1 - row);
            const dstBase = destRow * w;
            for (let x = 0; x < w; x++) {
              const si = srcRow + x * 4;
              p32[dstBase + x] = 0xFF000000 | (mem[si] << 16) | (mem[si + 1] << 8) | mem[si + 2];
            }
          }
        } else {
          for (let row = 0; row < rows; row++) {
            const srcRow = bitsWA + (startScan + row) * rowBytes;
            const destRow = topDown ? row : (h - 1 - row);
            const dstBase = destRow * w;
            for (let x = 0; x < w; x++) {
              const sx = xSrc + x;
              if (sx < 0 || sx >= imgW) { p32[dstBase + x] = 0xFF000000; continue; }
              const si = srcRow + sx * 4;
              p32[dstBase + x] = 0xFF000000 | (mem[si] << 16) | (mem[si + 1] << 8) | mem[si + 2];
            }
          }
        }
      } else {
        // Slow path: 1bpp / 4bpp
        for (let row = 0; row < rows; row++) {
          const srcRow = bitsWA + (startScan + row) * rowBytes;
          const destRow = topDown ? row : (h - 1 - row);
          const dstBase = destRow * w;
          for (let x = 0; x < w; x++) {
            const sx = xSrc + x;
            if (sx < 0 || sx >= imgW) { p32[dstBase + x] = 0xFF000000; continue; }
            let idx = 0;
            if (biBitCount === 1) idx = (mem[srcRow + (sx >> 3)] >> (7 - (sx & 7))) & 1;
            else if (biBitCount === 4) idx = (sx & 1) ? (mem[srcRow + (sx >> 1)] & 0xF) : ((mem[srcRow + (sx >> 1)] >> 4) & 0xF);
            p32[dstBase + x] = pal32[idx];
          }
        }
      }
      const _tLoop = _profOn ? performance.now() : 0;
      // Blit: if target ctx supports putImageData directly, skip the tmp-canvas bounce.
      const pixels = globalThis._sdiPixBuf;
      if (typeof t.ctx.putImageData === 'function') {
        const imgData = (need === w * h && globalThis._sdiImgDataCache && globalThis._sdiImgDataCache.w === w && globalThis._sdiImgDataCache.h === h)
          ? globalThis._sdiImgDataCache.img
          : (globalThis._sdiImgDataCache = { w, h, img: t.ctx.createImageData(w, h) }).img;
        imgData.data.set(pixels.subarray(0, w * h * 4));
        t.ctx.putImageData(imgData, t.ox + xDest, t.oy + yDest);
      } else {
        const tmpCanvas = _createOffscreen(w, h);
        if (tmpCanvas) {
          const tmpCtx = tmpCanvas.getContext('2d');
          const imgData = tmpCtx.createImageData(w, h);
          imgData.data.set(pixels.subarray(0, w * h * 4));
          tmpCtx.putImageData(imgData, 0, 0);
          t.ctx.drawImage(tmpCanvas, t.ox + xDest, t.oy + yDest);
        }
      }
      if (_profOn) {
        const tEnd = performance.now();
        const dtLoop = _tLoop - _t0;
        const dtBlit = tEnd - _tLoop;
        const dtAll  = tEnd - _t0;
        const p = globalThis._sdiProf || (globalThis._sdiProf = {
          n: 0, loopSum: 0, blitSum: 0, max: 0,
          winN: 0, winLoop: 0, winBlit: 0, winMax: 0, winStart: tEnd,
        });
        p.n++; p.loopSum += dtLoop; p.blitSum += dtBlit;
        if (dtAll > p.max) p.max = dtAll;
        p.winN++; p.winLoop += dtLoop; p.winBlit += dtBlit;
        if (dtAll > p.winMax) p.winMax = dtAll;
        if (p.n % 120 === 0) {
          const wall = tEnd - p.winStart;
          const fps = wall > 0 ? (p.winN * 1000 / wall).toFixed(0) : '?';
          console.log(
            `[PROF sdi] n=${p.n} ${biBitCount}bpp ${w}x${h} ` +
            `last120 avg=${(p.winLoop / p.winN + p.winBlit / p.winN).toFixed(2)}ms ` +
            `(loop ${(p.winLoop / p.winN).toFixed(2)} + blit ${(p.winBlit / p.winN).toFixed(2)}) ` +
            `max=${p.winMax.toFixed(1)}ms present-rate=${fps}/s ` +
            `overall avg=${((p.loopSum + p.blitSum) / p.n).toFixed(2)}ms max=${p.max.toFixed(1)}ms`
          );
          p.winN = 0; p.winLoop = 0; p.winBlit = 0; p.winMax = 0; p.winStart = tEnd;
        }
      }
      return cLines;
    },
    gdi_stretch_dib_bits: (hdc, xDst, yDst, wDst, hDst, xSrc, ySrc, wSrc, hSrc, bitsWA, bmiWA, colorUse, rop) => {
      // StretchDIBits: render DIB rectangle to DC, with optional scaling
      if (!globalThis._sdbCount) globalThis._sdbCount = 0;
      if (globalThis._sdbCount++ < 3) console.log(`StretchDIBits hdc=0x${hdc.toString(16)} dst=${wDst}x${hDst} src=${wSrc}x${hSrc}`);
      const t = _getDrawTarget(hdc, 0);
      if (!t) { if (globalThis._sdbCount < 5) console.warn('StretchDIBits: no draw target!'); return 0; }
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      const biWidth = dv.getInt32(bmiWA + 4, true);
      const biHeight = dv.getInt32(bmiWA + 8, true);
      const biBitCount = dv.getUint16(bmiWA + 14, true);
      const biSize = dv.getUint32(bmiWA, true);
      const imgW = Math.abs(biWidth), imgH = Math.abs(biHeight);
      const topDown = biHeight < 0;
      // Read palette for indexed color
      const palette = [];
      if (biBitCount <= 8) {
        const numColors = 1 << biBitCount;
        const palOff = bmiWA + biSize;
        if (colorUse === 1) {
          // DIB_PAL_COLORS: color table contains WORD indices into the selected palette.
          // SelectPalette mirrors the current palette index (0-3) at 0x6020 so we can
          // pick the right table here — pinball selects between several palettes per blit.
          let palIdx = dv.getUint32(0x6020, true);
          if (palIdx > 3) palIdx = 0;
          const palBase = 0x6040 + palIdx * 1024;
          for (let i = 0; i < numColors; i++) {
            const idx = dv.getUint16(palOff + i * 2, true);
            const r = mem[palBase + idx * 4], g = mem[palBase + idx * 4 + 1], b = mem[palBase + idx * 4 + 2];
            palette.push((r << 16) | (g << 8) | b);
          }
        } else {
          // DIB_RGB_COLORS: color table contains RGBQUAD entries
          for (let i = 0; i < numColors; i++) {
            const b = mem[palOff + i * 4], g = mem[palOff + i * 4 + 1], r = mem[palOff + i * 4 + 2];
            palette.push((r << 16) | (g << 8) | b);
          }
        }
      }
      // Decode source region from DIB into pixel buffer (wSrc × hSrc)
      const sw = Math.abs(wSrc), sh = Math.abs(hSrc);
      const rowBytes = Math.ceil((imgW * biBitCount) / 32) * 4;
      const pixels = new Uint8Array(sw * sh * 4);
      for (let row = 0; row < sh; row++) {
        // Source row in the DIB bitmap data
        // For bottom-up DIBs, MSDN specifies ySrc is measured from the
        // BOTTOM-LEFT corner of the bitmap. So the source rect spans bitmap
        // data rows ySrc..ySrc+sh-1, where row 0 of the data is the bottom
        // visual row. Output row 0 (top of dst) corresponds to data row
        // ySrc+sh-1; output row sh-1 (bottom of dst) corresponds to ySrc.
        // Pinball relies on this — it computes ySrc = bitmap.height - dstY -
        // rectH and would render to the wrong rows under top-relative ySrc.
        const srcRowIdx = topDown ? (ySrc + row) : (ySrc + sh - 1 - row);
        if (srcRowIdx < 0 || srcRowIdx >= imgH) continue;
        const srcRow = bitsWA + srcRowIdx * rowBytes;
        for (let x = 0; x < sw; x++) {
          const sx = xSrc + x;
          if (sx < 0 || sx >= imgW) continue;
          const di = (row * sw + x) * 4;
          let r = 0, g = 0, b = 0;
          if (biBitCount === 1) {
            const bit = (mem[srcRow + (sx >> 3)] >> (7 - (sx & 7))) & 1;
            const c = palette[bit] || (bit ? 0xFFFFFF : 0);
            r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
          } else if (biBitCount === 4) {
            const nibble = (sx & 1) ? (mem[srcRow + (sx >> 1)] & 0xF) : ((mem[srcRow + (sx >> 1)] >> 4) & 0xF);
            const c = palette[nibble] || 0;
            r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
          } else if (biBitCount === 8) {
            const c = palette[mem[srcRow + sx]] || 0;
            r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
          } else if (biBitCount === 16) {
            const si = srcRow + sx * 2;
            const px = mem[si] | (mem[si + 1] << 8);
            r = (px >> 11) << 3; g = ((px >> 5) & 0x3F) << 2; b = (px & 0x1F) << 3;
          } else if (biBitCount === 24) {
            const si = srcRow + sx * 3;
            b = mem[si]; g = mem[si + 1]; r = mem[si + 2];
          } else if (biBitCount === 32) {
            const si = srcRow + sx * 4;
            b = mem[si]; g = mem[si + 1]; r = mem[si + 2];
          }
          pixels[di] = r; pixels[di + 1] = g; pixels[di + 2] = b; pixels[di + 3] = 255;
        }
      }
      try {
        if (typeof process !== 'undefined' && process.env && process.env.SDB_DEBUG && globalThis._sdbCount <= 12) console.log(`[sdb #${globalThis._sdbCount}] bmi=0x${bmiWA.toString(16)} bits=0x${bitsWA.toString(16)} biW=${biWidth} biH=${biHeight} bpp=${biBitCount} rowBytes=${rowBytes} src=(${xSrc},${ySrc} ${sw}x${sh}) dst=(${xDst},${yDst} ${wDst}x${hDst})`);
        const tmpCanvas = _createOffscreen(sw, sh);
        const tmpCtx = tmpCanvas.getContext('2d');
        const imgData = tmpCtx.createImageData(sw, sh);
        imgData.data.set(pixels);
        tmpCtx.putImageData(imgData, 0, 0);
        // Draw with scaling from source size to destination size. Apply the
        // cousin/children clip so the blit can't clobber sibling palettes on
        // the shared back-canvas (see _excludeChildrenClip).
        const _clipExcluded = _excludeChildrenClip(t, _hwndFromDC(hdc));
        try {
          t.ctx.drawImage(tmpCanvas, 0, 0, sw, sh, t.ox + xDst, t.oy + yDst, Math.abs(wDst), Math.abs(hDst));
        } finally { if (_clipExcluded) t.ctx.restore(); }
      } catch (e) { if (typeof process !== 'undefined' && process.env && process.env.SDB_DEBUG) console.log('[sdb] err', e.message); }
      // --- Diagnostic dump (--dump-sdb) ---
      // Records every blit's parameters and decodes the FULL source DIB once
      // per unique (bitsWA, imgW, imgH, biBitCount) tuple so we can inspect
      // sprite-sheet layout vs. the sub-rects pinball asks for.
      if (ctx.dumpSdb) {
        const callIdx = ctx.dumpSdb.log.length;
        const palIdx = (colorUse === 1) ? (dv.getUint32(0x6020, true) & 3) : -1;
        const key = `${bitsWA.toString(16)}_${imgW}x${imgH}_bpp${biBitCount}` +
                    (palIdx >= 0 ? `_pal${palIdx}` : '');
        // Read caller return address — top of stack at the time of the host
        // call (handle_StretchDIBits hasn't yet popped its 56-byte arg frame).
        let retAddr = 0;
        try {
          if (ctx.exports) {
            const e = ctx.exports;
            const esp = e.get_esp();
            const imageBase = e.get_image_base();
            retAddr = dv.getUint32(esp - imageBase + 0x12000, true);
          }
        } catch (_) {}
        ctx.dumpSdb.log.push(
          `#${callIdx} key=${key} ret=0x${retAddr.toString(16)} biH=${biHeight} (${topDown?'top-down':'bot-up'}) ` +
          `src=(${xSrc},${ySrc} ${wSrc}x${hSrc}) dst=(${xDst},${yDst} ${wDst}x${hDst}) ` +
          `rop=0x${(rop>>>0).toString(16)} colorUse=${colorUse} bits=0x${bitsWA.toString(16)} hdc=0x${hdc.toString(16)}`
        );
        // Snapshot the source DIB at multiple points so we can see if pinball
        // is mutating the back-buffer between blits. Tag each snapshot with the
        // call index it was captured at.
        const snapPoints = [0, 1, 5, 6, 100, 1000, 5000];
        const snapKey = snapPoints.includes(callIdx) ? `${key}_at${callIdx}` : null;
        // Save the SUB-RECT pixels for the first 30 sub-rect blits — shows what
        // pinball is reading at each blit, regardless of what surrounds it.
        if (callIdx < 30 && (wSrc !== imgW || hSrc !== imgH)) {
          const subKey = `subrect_${String(callIdx).padStart(3,'0')}_src${xSrc}x${ySrc}_${sw}x${sh}_dst${xDst}x${yDst}`;
          if (!ctx.dumpSdb.images.has(subKey)) {
            ctx.dumpSdb.images.set(subKey, { w: sw, h: sh, pixels: pixels.slice() });
          }
        }
        const decodeKey = snapKey || (ctx.dumpSdb.images.has(key) ? null : key);
        if (decodeKey && !ctx.dumpSdb.images.has(decodeKey)) {
          // Decode the entire source bitmap once
          const fullPx = new Uint8Array(imgW * imgH * 4);
          for (let row = 0; row < imgH; row++) {
            const rIdx = topDown ? row : (imgH - 1 - row);
            const rowOff = bitsWA + rIdx * rowBytes;
            for (let x = 0; x < imgW; x++) {
              const di = (row * imgW + x) * 4;
              let r = 0, g = 0, b = 0;
              if (biBitCount === 1) {
                const bit = (mem[rowOff + (x >> 3)] >> (7 - (x & 7))) & 1;
                const c = palette[bit] || (bit ? 0xFFFFFF : 0);
                r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
              } else if (biBitCount === 4) {
                const nib = (x & 1) ? (mem[rowOff + (x >> 1)] & 0xF) : ((mem[rowOff + (x >> 1)] >> 4) & 0xF);
                const c = palette[nib] || 0;
                r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
              } else if (biBitCount === 8) {
                const c = palette[mem[rowOff + x]] || 0;
                r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
              } else if (biBitCount === 24) {
                const si = rowOff + x * 3;
                b = mem[si]; g = mem[si + 1]; r = mem[si + 2];
              } else if (biBitCount === 32) {
                const si = rowOff + x * 4;
                b = mem[si]; g = mem[si + 1]; r = mem[si + 2];
              }
              fullPx[di] = r; fullPx[di + 1] = g; fullPx[di + 2] = b; fullPx[di + 3] = 255;
            }
          }
          ctx.dumpSdb.images.set(decodeKey, { w: imgW, h: imgH, pixels: fullPx });
        }
      }
      return Math.abs(hDst);
    },
    gdi_frame_rect: (hdc, left, top, right, bottom, hbrush, hwnd) => {
      const t = _getDrawTarget(hdc, hwnd);
      if (!t) return 1;
      const c = t.ctx;
      // Resolve brush color
      let color = '#000000';
      const brObj = _gdiObjects[hbrush];
      if (brObj && brObj.color !== undefined) {
        const cr = brObj.color & 0xFF, cg = (brObj.color >> 8) & 0xFF, cb = (brObj.color >> 16) & 0xFF;
        color = `rgb(${cr},${cg},${cb})`;
      }
      const ox = t.ox, oy = t.oy;
      c.fillStyle = color;
      // Draw 1px frame
      c.fillRect(ox + left, oy + top, right - left, 1);           // top
      c.fillRect(ox + left, oy + bottom - 1, right - left, 1);    // bottom
      c.fillRect(ox + left, oy + top, 1, bottom - top);           // left
      c.fillRect(ox + right - 1, oy + top, 1, bottom - top);     // right
      return 1;
    },

    // --- Font support ---
    create_font: (height, weight, italic, facePtr) => {
      const face = facePtr ? readStr(facePtr, 64) : '';
      const css = _buildCssFont(height, weight, italic, face);
      return _gdiAlloc({ type: 'font', height: Math.abs(height) || 16, weight, italic, face, css });
    },
    measure_text: (hdc, textPtr, nCount) => {
      const mem = new Uint8Array(ctx.getMemory());
      let text = '';
      for (let i = 0; i < nCount && mem[textPtr + i]; i++) text += String.fromCharCode(mem[textPtr + i]);
      const font = _resolveFont(hdc);
      let c;
      if (ctx.renderer) {
        c = ctx.renderer.ctx;
      } else {
        // Node/headless: approximate
        const sz = parseInt(font.match(/(\d+)px/)?.[1]) || 13;
        return text.length * Math.round(sz * 0.6);
      }
      c.font = font;
      return Math.round(c.measureText(text).width);
    },
    get_text_metrics: (hdc) => {
      // Returns packed: (height | (aveCharWidth << 16))
      const font = _resolveFont(hdc);
      const height = parseInt(font.match(/(\d+)px/)?.[1]) || 13;
      let aveW = Math.round(height * 0.6); // reasonable default
      if (ctx.renderer) {
        const c = ctx.renderer.ctx;
        c.font = font;
        aveW = Math.round(c.measureText('x').width);
      }
      return (height & 0xFFFF) | ((aveW & 0xFFFF) << 16);
    },

    // --- Math (FPU transcendentals) ---
    math_sin: Math.sin,
    math_cos: Math.cos,
    math_tan: Math.tan,
    math_atan2: Math.atan2,
    math_log2: Math.log2,
    math_pow2: (x) => 2 ** x,

    // --- Thread/event stubs (overridden by ThreadManager when active) ---
    create_thread: (startAddr, param, stackSize) => 0,
    exit_thread: (exitCode) => {},
    get_exit_code_thread: (handle) => 0x103, // STILL_ACTIVE
    create_event: (manualReset, initialState) => 0,
    set_event: (handle) => 1,
    reset_event: (handle) => 1,
    wait_single: (handle, timeout) => 0, // WAIT_OBJECT_0 — immediate success
    create_semaphore: (initialCount, maxCount) => 0,
    release_semaphore: (handle, releaseCount, lpPrevCountWA) => 1,
  };

  // --- Tracing wrapper ---
  // Wraps host functions to log calls when a trace category is enabled.
  // Categories: 'gdi' (CreateBitmap, BitBlt, SelectObject, etc.)
  const trace = ctx.trace || new Set();

  if (trace.has('wave') || trace.has('audio-stats')) {
    const hex = v => '0x' + (v >>> 0).toString(16);
    const traceWave = trace.has('wave');
    const stride = ctx.audioStatsStride || 50;
    // Share stats across threads: T4 is where waveOutWrite actually fires for Winamp.
    // Without this, the main-thread stats stay at 0 and the final summary lies.
    const stats = ctx._waveStats = ctx._waveStats || { open: 0, write: 0, writeBytes: 0, close: 0, lastFmt: null, lastWriteAt: 0 };
    const waveWrap = (name, fn, fmt) => {
      if (!host[name]) return;
      const orig = host[name];
      host[name] = (...args) => {
        const r = orig(...args);
        // fmt also accumulates stats — must run unconditionally,
        // not just when traceWave is on.
        const line = fmt(args, r);
        if (traceWave) console.log(`[wave] ${line}`);
        return r;
      };
    };
    waveWrap('wave_out_open', host.wave_out_open,
      ([rate, ch, bits, cb], r) => {
        stats.open++;
        stats.lastFmt = { rate, ch, bits };
        return `open(${rate}Hz ${ch}ch ${bits}bit cb=${hex(cb)}) → voice#${r}`;
      });
    waveWrap('wave_out_write', host.wave_out_write,
      ([h, p, len], r) => {
        stats.write++;
        stats.writeBytes += len;
        stats.lastWriteAt = Date.now();
        if (trace.has('audio-stats') && stats.write % stride === 0) {
          const f = stats.lastFmt;
          const secs = f ? (stats.writeBytes / (f.rate * f.ch * (f.bits / 8))).toFixed(2) : '?';
          const fmtStr = f ? `${f.rate}Hz s${f.bits}x${f.ch}` : '?';
          console.log(`[audio] ${stats.write} buffers, ${stats.writeBytes} B, ~${secs}s @ ${fmtStr}`);
        }
        return `write #${stats.write} h=${hex(h)} buf=${hex(p)} ${len} B`;
      });
    waveWrap('wave_out_close', host.wave_out_close,
      ([h], r) => { stats.close++; return `close(h=${hex(h)})`; });
    waveWrap('wave_out_get_pos', host.wave_out_get_pos,
      ([h], r) => `getPos(h=${hex(h)}) → ${r}`);
    waveWrap('wave_out_set_volume', host.wave_out_set_volume,
      ([h, v], r) => `setVolume(h=${hex(h)} v=${hex(v)})`);
    ctx._finalizeWaveTrace = () => {
      if (trace.has('wave')) {
        console.log(`[wave] totals: open=${stats.open} write=${stats.write} (${stats.writeBytes} B) close=${stats.close}`);
      }
      if (trace.has('audio-stats')) {
        const idle = stats.lastWriteAt ? ((Date.now() - stats.lastWriteAt) / 1000).toFixed(1) : '?';
        console.log(`[audio] final: ${stats.write} buffers / ${stats.writeBytes} B; idle since last write: ${idle}s`);
      }
    };
  }

  if (trace.has('gdi')) {
    const hex = v => '0x' + (v >>> 0).toString(16);
    const ropNames = {
      0x00CC0020: 'SRCCOPY', 0x00330008: 'NOTSRCCOPY', 0x008800C6: 'SRCAND',
      0x00EE0086: 'SRCPAINT', 0x00660046: 'SRCINVERT',
      0x00000042: 'BLACKNESS', 0x00FF0062: 'WHITENESS',
      0x00F00021: 'PATCOPY', 0x00550009: 'DSTINVERT',
    };
    const wrap = (name, fn, fmt) => {
      host[name] = (...args) => {
        const r = fn(...args);
        console.log(`[gdi] ${fmt(args, r)}`);
        return r;
      };
    };
    wrap('gdi_create_bitmap', host.gdi_create_bitmap,
      ([w,h,bpp,p], r) => `CreateBitmap(${w}x${h} ${bpp}bpp bits=${hex(p)}) → ${hex(r)}`);
    wrap('gdi_create_dib_bitmap', host.gdi_create_dib_bitmap,
      ([bmi,bits,init], r) => { const o=_gdiObjects[r]; return `CreateDIBitmap(bmi=${hex(bmi)} bits=${hex(bits)} init=${init}) → ${hex(r)} ${o?o.w+'x'+o.h+' mono='+!!o.mono:'?'}`; });
    wrap('gdi_create_dib_section', host.gdi_create_dib_section,
      ([w,h,bpp,lp,bmi], r) => `CreateDIBSection(${w}x${h} ${bpp}bpp bits=${hex(lp)} bmi=${hex(bmi)}) → ${hex(r)}`);
    wrap('gdi_create_compat_dc', host.gdi_create_compat_dc,
      ([ref], r) => `CreateCompatibleDC(${hex(ref)}) → ${hex(r)}`);
    wrap('gdi_create_compat_bitmap', host.gdi_create_compat_bitmap,
      ([dc,w,h], r) => `CreateCompatibleBitmap(${hex(dc)} ${w}x${h}) → ${hex(r)}`);
    wrap('gdi_select_object', host.gdi_select_object,
      ([dc,obj], r) => `SelectObject(${hex(dc)}, ${hex(obj)}) → ${hex(r)}`);
    wrap('gdi_get_current_object', host.gdi_get_current_object,
      ([dc,t], r) => `GetCurrentObject(${hex(dc)}, type=${t}) → ${hex(r)}`);
    wrap('gdi_bitblt', host.gdi_bitblt,
      ([ddc,dx,dy,w,h,sdc,sx,sy,rop], r) =>
        `BitBlt(dst=${hex(ddc)}(${dx},${dy}) ${w}x${h} ← src=${hex(sdc)}(${sx},${sy}) ${ropNames[rop]||hex(rop)}) → ${r}`);
    if (host.gdi_patblt) wrap('gdi_patblt', host.gdi_patblt,
      ([dc,x,y,w,h,rop], r) => `PatBlt(${hex(dc)} (${x},${y}) ${w}x${h} ${ropNames[rop]||hex(rop)}) → ${r}`);
    wrap('gdi_stretch_blt', host.gdi_stretch_blt,
      ([ddc,dx,dy,dw,dh,sdc,sx,sy,sw,sh,rop], r) =>
        `StretchBlt(dst=${hex(ddc)}(${dx},${dy}) ${dw}x${dh} ← src=${hex(sdc)}(${sx},${sy}) ${sw}x${sh} ${ropNames[rop]||hex(rop)}) → ${r}`);
    wrap('gdi_fill_rect', host.gdi_fill_rect,
      ([dc,l,t,r2,b,br], r) => `FillRect(${hex(dc)} (${l},${t})-(${r2},${b}) brush=${hex(br)}) → ${r}`);
    if (host.gdi_draw_edge) wrap('gdi_draw_edge', host.gdi_draw_edge,
      ([dc,l,t,r2,b,e,f], r) => `DrawEdge(${hex(dc)} (${l},${t})-(${r2},${b}) edge=${hex(e)} flags=${hex(f)}) → ${r}`);
    if (host.gdi_rectangle) wrap('gdi_rectangle', host.gdi_rectangle,
      ([dc,l,t,r2,b], r) => `Rectangle(${hex(dc)} (${l},${t})-(${r2},${b})) → ${r}`);
    if (host.gdi_ellipse) wrap('gdi_ellipse', host.gdi_ellipse,
      ([dc,l,t,r2,b], r) => `Ellipse(${hex(dc)} (${l},${t})-(${r2},${b})) → ${r}`);
    if (host.gdi_polygon) wrap('gdi_polygon', host.gdi_polygon,
      ([dc,pts,n], r) => `Polygon(${hex(dc)} pts=${hex(pts)} n=${n}) → ${r}`);
    if (host.gdi_move_to) wrap('gdi_move_to', host.gdi_move_to,
      ([dc,x,y], r) => `MoveTo(${hex(dc)} ${x},${y}) → ${r}`);
    if (host.gdi_line_to) wrap('gdi_line_to', host.gdi_line_to,
      ([dc,x,y], r) => `LineTo(${hex(dc)} ${x},${y}) → ${r}`);
    if (host.gdi_arc) wrap('gdi_arc', host.gdi_arc,
      ([dc,l,t,r2,b], r) => `Arc(${hex(dc)} (${l},${t})-(${r2},${b})) → ${r}`);
    if (host.gdi_set_pixel) wrap('gdi_set_pixel', host.gdi_set_pixel,
      ([dc,x,y,c], r) => `SetPixel(${hex(dc)} ${x},${y} color=${hex(c)}) → ${hex(r)}`);
    if (host.gdi_set_text_color) wrap('gdi_set_text_color', host.gdi_set_text_color,
      ([dc,c], r) => `SetTextColor(${hex(dc)} ${hex(c)}) → ${hex(r)}`);
    if (host.gdi_set_bk_color) wrap('gdi_set_bk_color', host.gdi_set_bk_color,
      ([dc,c], r) => `SetBkColor(${hex(dc)} ${hex(c)}) → ${hex(r)}`);
    if (host.gdi_set_bk_mode) wrap('gdi_set_bk_mode', host.gdi_set_bk_mode,
      ([dc,m], r) => `SetBkMode(${hex(dc)} ${m}) → ${r}`);
    if (host.gdi_draw_text) wrap('gdi_draw_text', host.gdi_draw_text,
      ([dc,tp,n,rc,fmt,w], r) => {
        let s = '';
        try { const len = n === -1 ? 16 : Math.min(n, 32); const mem = new Uint8Array(ctx.getMemory(), tp, len); s = new TextDecoder(w ? 'utf-16le' : 'ascii').decode(mem).replace(/\0.*/,''); } catch (_) {}
        return `DrawText(${hex(dc)} "${s}" rect=${hex(rc)} fmt=${hex(fmt)}) → ${r}`;
      });
    if (host.gdi_text_out) wrap('gdi_text_out', host.gdi_text_out,
      ([dc,x,y,tp,n,w], r) => {
        let s = '';
        try { const bytes = w ? Math.min(n, 32) * 2 : Math.min(n, 32); const mem = new Uint8Array(ctx.getMemory(), tp, bytes); s = new TextDecoder(w ? 'utf-16le' : 'ascii').decode(mem).replace(/\0.*/,''); } catch (_) {}
        return `TextOut(${hex(dc)} ${x},${y} "${s}" n=${n}${w?'W':''}) → ${r}`;
      });
    wrap('gdi_delete_object', host.gdi_delete_object,
      ([h], r) => `DeleteObject(${hex(h)}) → ${r}`);
    wrap('gdi_delete_dc', host.gdi_delete_dc,
      ([h], r) => `DeleteDC(${hex(h)}) → ${r}`);
    wrap('gdi_get_clip_box', host.gdi_get_clip_box,
      ([dc], r) => `GetClipBox(${hex(dc)}) → ${r & 0xFFFF}×${r >>> 16}`);
    wrap('gdi_load_bitmap', host.gdi_load_bitmap,
      ([hInst, id], r) => `LoadBitmap(hInst=${hex(hInst)}, resId=${id}) → ${hex(r)}`);
    wrap('gdi_create_solid_brush', host.gdi_create_solid_brush,
      ([color], r) => `CreateSolidBrush(0x${(color>>>0).toString(16).padStart(6,'0')}) → ${hex(r)}`);
    if (host.gdi_get_object) {
      wrap('gdi_get_object', host.gdi_get_object,
        ([h,sz,buf], r) => `GetObject(${hex(h)}, ${sz}, ${hex(buf)}) → ${r}`);
    }
  }

  if (trace.has('dx')) {
    const hex = v => '0x' + (v >>> 0).toString(16);
    const surfCap = (flags) => {
      const parts = [];
      if (flags & 1) parts.push('PRI');
      if (flags & 2) parts.push('BACK');
      if (flags & 4) parts.push('OFFSCR');
      if (flags & 0x100) parts.push('CK');
      return parts.join('|') || '?';
    };
    // Sample the first non-zero byte in a DIB region (up to 'max' bytes).
    // Returns -1 if all-zero, else the offset. Used to tell "empty DIB" apart
    // from "drawn but wrong colors".
    const firstNonZero = (wa, max) => {
      if (!wa) return -2;
      try {
        const mem = new Uint8Array(ctx.getMemory(), wa, max);
        for (let i = 0; i < max; i++) if (mem[i]) return i;
      } catch (_) { return -3; }
      return -1;
    };
    const sampleDwords = (wa, n) => {
      if (!wa) return [];
      try {
        const dv = new DataView(ctx.getMemory(), wa, n * 4);
        const out = [];
        for (let i = 0; i < n; i++) out.push('0x' + dv.getUint32(i * 4, true).toString(16).padStart(8, '0'));
        return out;
      } catch (_) { return ['?']; }
    };
    host.dx_trace = (kind, slot, a, b, c) => {
      switch (kind) {
        case 1: // Lock
          console.log(`[dx] Lock    slot=${slot} caps=${surfCap(a)} dib=${hex(b)} firstNonZero=${firstNonZero(b, 65536)}`);
          break;
        case 2: { // Unlock
          const where = firstNonZero(b, 65536);
          console.log(`[dx] Unlock  slot=${slot} caps=${surfCap(a)} dib=${hex(b)} firstNonZero=${where}${where >= 0 ? ' first4=' + sampleDwords(b + where, 1).join(',') : ''}`);
          break;
        }
        case 3: { // Blt: slot=dst_slot, a=src_slot(-1=fill), b=dst_dib, c=flags
          const fill = (c & 0x400) ? ' COLORFILL' : '';
          const src = a === 0xFFFFFFFF ? 'null' : a;
          console.log(`[dx] Blt     dst=${slot} ← src=${src}${fill} dstDib=${hex(b)} flags=${hex(c)}`);
          break;
        }
        case 4: // SetEntries: slot=palette_slot, a=startIdx, b=count, c=pal_wa
          console.log(`[dx] SetPal  palSlot=${slot} start=${a} count=${b} palWA=${hex(c)} first4=${sampleDwords(c + a * 4, 4).join(' ')}`);
          break;
        case 5: { // dx_present: slot=surface, a=bpp, b=dib_wa, c=primary_pal_wa
          const where = firstNonZero(b, 65536);
          const palFirst = c ? sampleDwords(c, 4).join(' ') : '(none)';
          let nz = 0;
          try {
            const scan = new Uint8Array(ctx.getMemory(), b, 640 * 480 * (a >> 3 || 4));
            for (let i = 0; i < scan.length; i++) if (scan[i]) nz++;
          } catch (_) {}
          console.log(`[dx] Present slot=${slot} bpp=${a} dib=${hex(b)} firstNonZero=${where} nzBytes=${nz} pal=${hex(c)} first4=${palFirst}`);
          break;
        }
        case 6: // Flip: slot=front, a=back_slot, b=new_front_dib, c=old_front_dib
          console.log(`[dx] Flip    front=${slot} back=${a} newFrontDib=${hex(b)} oldFrontDib=${hex(c)}`);
          break;
        case 7: { // D3DIM Execute instruction: slot=opcode, a=bSize, b=wCount, c=off
          const opNames = {
            1: 'POINT', 2: 'LINE', 3: 'TRIANGLE', 4: 'MATRIXLOAD', 5: 'MATRIXMULT',
            6: 'STATETRANSFORM', 7: 'STATELIGHT', 8: 'STATERENDER', 9: 'PROCESSVERTICES',
            10: 'TEXTURELOAD', 11: 'EXIT', 12: 'BRANCHFORWARD', 13: 'SPAN',
            14: 'SETSTATUS',
          };
          console.log(`[dx] Exec    op=${slot}(${opNames[slot] || '?'}) size=${a} count=${b} off=${hex(c)}`);
          break;
        }
        case 8: { // Execute entry: slot=bufPtr(guest), a=instr_off, b=instr_len
          const e = ctx.exports;
          const imageBase = e ? e.get_image_base() : 0;
          let retAddr = 0;
          try {
            const esp = e.get_esp();
            const retWa = esp - imageBase + 0x12000;
            retAddr = new DataView(ctx.getMemory(), retWa, 4).getUint32(0, true);
          } catch (_) {}
          let caller2 = 0;
          try {
            const ebp = e.get_ebp();
            if (ebp) {
              const callerRetWa = ebp + 4 - imageBase + 0x12000;
              caller2 = new DataView(ctx.getMemory(), callerRetWa, 4).getUint32(0, true);
            }
          } catch (_) {}
          console.log(`[dx] ExecIn bufGuest=${hex(slot)} instrOff=${a} instrLen=${b} caller=${hex(retAddr)} caller2=${hex(caller2)}`);
          if (trace.has('dx-raw') && b > 0 && b < 65536) {
            try {
              const wa = slot - imageBase + 0x12000 + a;
              const bytes = new Uint8Array(ctx.getMemory(), wa, b);
              const opNames = {
                1: 'POINT', 2: 'LINE', 3: 'TRIANGLE', 4: 'MATRIXLOAD', 5: 'MATRIXMULT',
                6: 'STATETRANSFORM', 7: 'STATELIGHT', 8: 'STATERENDER', 9: 'PROCESSVERTICES',
                10: 'TEXTURELOAD', 11: 'EXIT', 12: 'BRANCHFORWARD', 13: 'SPAN', 14: 'SETSTATUS',
              };
              // Walk D3DINSTRUCTIONs: 4-byte header (op, bSize, wCount), then bSize*wCount payload
              let off = 0;
              while (off + 4 <= bytes.length) {
                const op = bytes[off], bSize = bytes[off + 1];
                const wCount = bytes[off + 2] | (bytes[off + 3] << 8);
                const payload = bSize * wCount;
                const head = `  @+${off.toString().padStart(4)} op=${op}(${opNames[op] || '?'}) bSize=${bSize} wCount=${wCount} payload=${payload}`;
                let hexRow = '';
                const payEnd = Math.min(off + 4 + payload, bytes.length, off + 4 + 64);
                for (let i = off + 4; i < payEnd; i++) hexRow += bytes[i].toString(16).padStart(2, '0') + ' ';
                console.log(`[dx-raw]${head}${payload ? ' | ' + hexRow.trim() : ''}${payload > 64 ? ' ...' : ''}`);
                if (op === 11 || bSize === 0) break;
                off += 4 + payload;
              }
            } catch (err) {
              console.log(`[dx-raw] error: ${err.message}`);
            }
          }
          break;
        }
        case 14: // BltFastPos: slot=dst, a=src, b=dwX, c=dwY
          console.log(`[dx] BFPos   dst=${slot} ← src=${a} at=${b},${c}`);
          break;
        case 13: // ColorFill: slot=dst, a=fillColor, b=dx, c=dy
          console.log(`[dx] CFill   dst=${slot} color=${hex(a)} at=${b},${c}`);
          break;
        case 12: { // BltRect: slot=dst, a=src, b=lpDestRectGuest, c=lpSrcRectGuest
          const e = ctx.exports;
          const imageBase = e ? e.get_image_base() : 0;
          const readRect = (g) => {
            if (!g) return 'NULL';
            try {
              const wa = g - imageBase + 0x12000;
              const dv = new DataView(ctx.getMemory(), wa, 16);
              return `${dv.getInt32(0, true)},${dv.getInt32(4, true)}-${dv.getInt32(8, true)},${dv.getInt32(12, true)}`;
            } catch (_) { return '?'; }
          };
          console.log(`[dx] BltRect dst=${slot} ← src=${a === 0xFFFFFFFF ? 'null' : a} dstR=${readRect(b)} srcR=${readRect(c)}`);
          break;
        }
        case 11: { // BltFast: slot=dst, a=src, b=src_ckey, c=trans
          console.log(`[dx] BltFast dst=${slot} ← src=${a} srcCkey=${hex(b)} trans=${hex(c)}`);
          break;
        }
        case 10: { // Device2 DrawPrimitive: slot=primType, a=vtxType, b=count, c=lpvVerts(guest)
          const e = ctx.exports;
          const imageBase = e ? e.get_image_base() : 0;
          let retAddr = 0;
          try {
            const esp = e.get_esp();
            const retWa = esp - imageBase + 0x12000;
            retAddr = new DataView(ctx.getMemory(), retWa, 4).getUint32(0, true);
          } catch (_) {}
          const vWa = c - imageBase + 0x12000;
          let vs = ` <read OOB vWa=${hex(vWa)} memSize=${ctx.getMemory().byteLength}>`;
          try {
            const n = Math.min(b, 4);
            const dv = new DataView(ctx.getMemory(), vWa, n * 32);
            const out = [];
            for (let i = 0; i < n; i++) {
              const o = i * 32;
              const fx = dv.getFloat32(o, true).toFixed(2);
              const fy = dv.getFloat32(o + 4, true).toFixed(2);
              const fz = dv.getFloat32(o + 8, true).toFixed(2);
              const rhw = dv.getFloat32(o + 12, true).toFixed(2);
              const col = hex(dv.getUint32(o + 16, true));
              out.push(`v${i}(${fx},${fy},${fz},rhw=${rhw}) col=${col}`);
            }
            vs = '\n    ' + out.join('\n    ');
          } catch (e) { vs = ` <err: ${e.message}>`; }
          console.log(`[dx] DP2     primType=${slot} vtxType=${a} count=${b} lpv=${hex(c)} caller=${hex(retAddr)}${vs}`);
          break;
        }
        default:
          console.log(`[dx] kind=${kind} slot=${slot} a=${hex(a)} b=${hex(b)} c=${hex(c)}`);
      }
    };
  }

  // Merge storage imports (registry + INI files backed by localStorage)
  const _createStorageImports = (typeof StorageImports !== 'undefined' && StorageImports.createStorageImports)
    || (typeof require !== 'undefined' && (() => { try { return require('./storage').createStorageImports; } catch (_) { return null; } })());
  if (_createStorageImports) {
    const storageHost = _createStorageImports(ctx);
    Object.assign(host, storageHost);
  }

  // Merge filesystem imports (virtual FS backed by in-memory Map)
  const _createFsImports = (typeof FilesystemImports !== 'undefined' && FilesystemImports.createFilesystemImports)
    || (typeof require !== 'undefined' && (() => { try { return require('./filesystem').createFilesystemImports; } catch (_) { return null; } })());
  if (_createFsImports) {
    const fsHost = _createFsImports(ctx);
    Object.assign(host, fsHost);
  }

  // --- Generic host-function tracer ---
  // Enable with --trace-host=name1,name2 (CLI) or ctx.traceHost = Set of names.
  // Wraps any host import by name and logs args/return without a bespoke
  // formatter. Useful for one-off investigations so we stop editing source
  // to add console.log. Numbers render hex when >= 0x100.
  // Runs AFTER storage/fs/other merges so wrappable names include fs_* etc.
  if (ctx.traceHost && ctx.traceHost.size > 0) {
    const fmt = v => (typeof v === 'number')
      ? (Math.abs(v) >= 0x100 ? '0x' + (v >>> 0).toString(16) : String(v))
      : String(v);
    for (const name of ctx.traceHost) {
      if (typeof host[name] !== 'function') {
        console.warn(`[trace-host] no such host import: ${name}`);
        continue;
      }
      const orig = host[name];
      host[name] = (...args) => {
        const r = orig(...args);
        console.log(`[host] ${name}(${args.map(fmt).join(', ')}) → ${fmt(r)}`);
        return r;
      };
    }
  }

  // Z-order clipping no longer needed — each window draws to its own offscreen canvas.
  // The compositor in repaint() handles overlap by blitting back-to-front.

  // DLL file check for dynamic LoadLibraryA — check VFS for DLL files
  host.has_dll_file = (nameWA) => {
    const name = readStr(nameWA);
    const fileName = name.split('\\').pop().toLowerCase();
    if (ctx.vfs) {
      const tryPaths = [name.toLowerCase(), 'c:\\' + fileName, 'c:\\plugins\\' + fileName];
      for (const p of tryPaths) {
        if (ctx.vfs.files.has(p)) return 1;
      }
    }
    return 0;
  };

  return { host, readStr, gdi: { _gdiObjects, _dcState, _gdiAlloc, _getDC, _getClientOrigin, handleBox: _handleBox } };
}

if (typeof module !== 'undefined') module.exports = { createHostImports };
