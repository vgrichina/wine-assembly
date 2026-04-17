// Shared host imports for wine-assembly WASM instantiation.
// All runners (host.js, test/run.js, tools/render-png.js) use this.
// Real GDI with canvas backend — works with browser canvas or node-canvas.
//
// Usage:
//   const base = createHostImports({ getMemory, renderer, resourceJson, onExit });
//   base.host.log = (ptr, len) => { ... };  // override as needed
//   const { instance } = await WebAssembly.instantiate(wasm, { host: base.host });

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
  const _handleBox = _sharedGdi ? _sharedGdi.handleBox : { next: 0x200001 };
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
  // hwnds: 0x10001+, so client DCs: 0x50001+; window DCs: 0xD0001+; GDI handles: 0x200001+
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
      if (_isWholeWindowDC(hdc)) {
        // GetWindowDC: (0,0) = window top-left → no offset
      } else {
        // GetDC/BeginPaint: (0,0) = client area top-left → offset by chrome
        const topWin = ctx.renderer.windows[topHwnd];
        if (topWin && topWin.clientRect) {
          ox = topWin.clientRect.x - topWin.x;
          oy = topWin.clientRect.y - topWin.y;
        }
        // Child windows: add child position within parent's client area
        const childWin = ctx.renderer.windows[h];
        if (childWin && childWin.isChild) {
          ox += childWin.x;
          oy += childWin.y;
        }
        // Plus any accumulated child→parent offset chain from WAT.
        ox += childOx;
        oy += childOy;
      }
      const wdc = _getDC(hdc);
      ox += (wdc.vpOrgX | 0);
      oy += (wdc.vpOrgY | 0);
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
        return { ctx: bmp.canvas.getContext('2d'), ox: (dc.vpOrgX | 0), oy: (dc.vpOrgY | 0), canvas: bmp.canvas };
      }
    }
    return null;
  };

  // Apply DC clip region to a canvas context. Returns true if ctx.save() was called (caller must restore).
  const _applyClip = (hdc, c) => {
    const dc = _dcState[hdc];
    if (!dc || !dc.clipRgn) return false;
    const rects = dc.clipRgn.rects;
    if (!rects || rects.length === 0) return false;
    c.save();
    c.beginPath();
    for (const r of rects) c.rect(r.x, r.y, r.w, r.h);
    c.clip();
    return true;
  };

  // Rebuild bmp.pixels + bmp.canvas from the live guest DIB memory. Called on BitBlt/StretchBlt
  // source resolution so guest-side in-place pixel writes become visible to the renderer.
  const _syncDibSection = (bmp) => {
    if (!bmp || !bmp.dibSection) return;
    const { w, h, bpp, lpBitsWa, palette } = bmp;
    const mem = new Uint8Array(ctx.getMemory());
    const pixels = bmp.pixels || (bmp.pixels = new Uint8Array(w * h * 4));
    const rowBytes = ((w * bpp + 31) >> 5) << 2; // DWORD-aligned
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

  const host = {
    // --- Logging (override for tracing/UI) ---
    log: () => {},
    log_i32: () => {},

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
    register_dialog_frame: (dlgHwnd, ownerHwnd, titleWa, w, h, kind) => {
      const r = typeof ctx.renderer === 'function' ? ctx.renderer() : ctx.renderer;
      if (!r) return;
      const title = readStr(titleWa);
      const parentWin = r.windows[ownerHwnd];
      const px = parentWin ? parentWin.x : 0;
      const py = parentWin ? parentWin.y : 0;
      r.windows[dlgHwnd] = {
        hwnd: dlgHwnd, style: 0x80C80000, title,
        x: px + 40, y: py + 40, w, h,
        visible: true, isChild: false, menu: null, controls: [],
        isDialog: true,
        isAboutDialog: !!(kind & 1),
        isFindDialog:  !!(kind & 2),
        ownerHwnd, zOrder: r._nextZ++,
        wasm: r.wasm, wasmMemory: r.wasmMemory,
      };
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
      return id;
    },
    wave_out_write: (handle, pcmDataWA, byteLength) => {
      ctx._voices.writeStream(handle, pcmDataWA, byteLength);
      // Optional raw PCM dump for offline test inspection
      if (ctx._audioOutFd !== undefined) {
        try {
          const buf = Buffer.from(ctx.getMemory(), pcmDataWA, byteLength);
          require('fs').writeSync(ctx._audioOutFd, buf);
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
      console.log(`[CreateDialog] hwnd=0x${hwnd.toString(16)} parent=0x${parentHwnd.toString(16)}`);
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
      if (!(flags & 2)) { win.x = x; win.y = y; }      // SWP_NOMOVE=2
      if (!(flags & 1)) { win.w = Math.max(0, w); win.h = Math.max(0, h); } // SWP_NOSIZE=1
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
      const o = _getClientOrigin(hwnd);
      c.fillRect(o.x, o.y, w, h);
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
      const clrUsed = dv.getUint32(lpbmiWa + 32, true);
      const numColors = clrUsed || (bpp <= 8 ? (1 << bpp) : 0);
      const palette = [];
      for (let i = 0; i < numColors; i++) {
        const off = lpbmiWa + biSize + i * 4;
        palette.push([mem[off + 2], mem[off + 1], mem[off]]); // BGR → RGB
      }
      const canvas = _createOffscreen(w, h);
      return _gdiAlloc({
        type: 'bitmap', w, h, bpp,
        pixels: new Uint8Array(w * h * 4),
        canvas,
        dibSection: true,
        lpBitsWa: lpBitsWa >>> 0,
        palette,
        bottomUp: true,
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
      let prev = 0x30001;
      if (obj) {
        if (obj.type === 'pen') { prev = dc.selectedPen || 0x30001; dc.selectedPen = hObj; dc.penColor = obj.color; dc.penWidth = obj.width || 1; }
        else if (obj.type === 'brush') { prev = dc.selectedBrush || 0x30001; dc.selectedBrush = hObj; dc.brushColor = obj.color; }
        else if (obj.type === 'bitmap') { prev = dc.selectedBitmap || 0x30001; dc.selectedBitmap = hObj; }
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
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      const c = t.ctx;
      const clipped = _applyClip(hdc, c);
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
      if (clipped) c.restore();
      return 1;
    },
    gdi_fill_rect: (hdc, left, top, right, bottom, hbrush) => {
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      const c = t.ctx;
      const clipped = _applyClip(hdc, c);
      const x = t.ox + left, y = t.oy + top, w = right - left, h = bottom - top;
      // Resolve brush handle to color
      let bc;
      if (hbrush >= 0x30010 && hbrush <= 0x30015) {
        // Stock brush
        const stockColors = { 0x30010: 0xFFFFFF, 0x30011: 0xC0C0C0, 0x30012: 0x808080, 0x30013: 0x404040, 0x30014: 0x000000 };
        bc = stockColors[hbrush];
        if (bc === undefined) return 1; // NULL_BRUSH
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
      if (clipped) c.restore();
      return 1;
    },
    gdi_offset_rgn: (hrgn, x, y) => {
      const rgn = _gdiObjects[hrgn];
      if (!rgn || rgn.type !== 'region') return 0;
      for (const r of rgn.rects) { r.x += x; r.y += y; }
      return rgn.rects.length > 1 ? 3 : (rgn.rects.length === 1 ? 2 : 1);
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
      c.fillStyle = `rgb(${bc & 0xFF},${(bc >> 8) & 0xFF},${(bc >> 16) & 0xFF})`;
      for (const r of rgn.rects) {
        c.fillRect(t.ox + r.x, t.oy + r.y, r.w, r.h);
      }
      return 1;
    },
    gdi_gradient_fill_h: (hdc, left, top, right, bottom, colorL, colorR) => {
      // Horizontal linear gradient. Colors are Win32 COLORREF (0xBBGGRR).
      // Used by $defwndproc_ncpaint for the caption bar; matches the
      // shape of GdiGradientFill(GRADIENT_FILL_RECT_H) in real Win32.
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      const c = t.ctx;
      const x = t.ox + left, y = t.oy + top, w = right - left, h = bottom - top;
      if (w <= 0 || h <= 0) return 1;
      const rgb = (cr) => `rgb(${cr & 0xFF},${(cr >> 8) & 0xFF},${(cr >> 16) & 0xFF})`;
      const grad = c.createLinearGradient(x, y, x + w, y);
      grad.addColorStop(0, rgb(colorL));
      grad.addColorStop(1, rgb(colorR));
      c.fillStyle = grad;
      c.fillRect(x, y, w, h);
      return 1;
    },
    gdi_rectangle: (hdc, left, top, right, bottom) => {
      const dc = _getDC(hdc);
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      const c = t.ctx;
      const x = t.ox + left, y = t.oy + top, w = right - left, h = bottom - top;
      const bc = dc.brushColor || 0;
      c.fillStyle = `rgb(${bc & 0xFF},${(bc >> 8) & 0xFF},${(bc >> 16) & 0xFF})`;
      c.fillRect(x, y, w, h);
      const pc = dc.penColor || 0;
      c.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
      c.lineWidth = dc.penWidth || 1;
      c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      return 1;
    },
    gdi_ellipse: (hdc, left, top, right, bottom) => {
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      const c = t.ctx;
      const dc = _getDC(hdc);
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
      return 1;
    },
    gdi_polygon: (hdc, pointsWA, nCount) => {
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      if (nCount < 2) return 1;
      const dv = new DataView(ctx.getMemory());
      const c = t.ctx;
      const dc = _getDC(hdc);
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
      return 1;
    },
    gdi_create_rect_rgn: (l, t, r, b) => {
      return _gdiAlloc({ type: 'region', rects: [{ x: l, y: t, w: r - l, h: b - t }] });
    },
    gdi_set_rect_rgn: (hrgn, l, t, r, b) => {
      const rgn = _gdiObjects[hrgn];
      if (!rgn || rgn.type !== 'region') return 0;
      rgn.rects = [{ x: l, y: t, w: r - l, h: b - t }];
      return 1;
    },
    gdi_combine_rgn: (hrgnDst, hrgnSrc1, hrgnSrc2, fnCombineMode) => {
      const r1 = _gdiObjects[hrgnSrc1], r2 = _gdiObjects[hrgnSrc2];
      if (!r1 || r1.type !== 'region' || !r2 || r2.type !== 'region') return 0;
      const dst = _gdiObjects[hrgnDst];
      if (!dst || dst.type !== 'region') return 0;
      if (fnCombineMode === 2) { // RGN_OR
        dst.rects = [...r1.rects, ...r2.rects];
        return dst.rects.length > 1 ? 3 : 2;
      }
      if (fnCombineMode === 5) { // RGN_COPY
        dst.rects = [...r1.rects];
        return dst.rects.length > 1 ? 3 : 2;
      }
      return 3; // COMPLEXREGION
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
      if (hrgn === 0) { dc.clipRgn = null; return 1; } // SIMPLEREGION (reset)
      const rgn = _gdiObjects[hrgn];
      if (!rgn || rgn.type !== 'region') return 0; // ERROR
      dc.clipRgn = { rects: rgn.rects.map(r => ({...r})) };
      return rgn.rects.length > 1 ? 3 : (rgn.rects.length === 0 ? 1 : 2);
    },
    gdi_ext_select_clip_rgn: (hdc, hrgn, fnMode) => {
      const dc = _getDC(hdc);
      // fnMode: 1=RGN_COPY, 5=RGN_DIFF
      if (fnMode === 1) { // RGN_COPY — same as SelectClipRgn
        if (hrgn === 0) { dc.clipRgn = null; return 1; }
        const rgn = _gdiObjects[hrgn];
        if (!rgn || rgn.type !== 'region') return 0;
        dc.clipRgn = { rects: rgn.rects.map(r => ({...r})) };
        return rgn.rects.length > 1 ? 3 : (rgn.rects.length === 0 ? 1 : 2);
      }
      // For other modes (AND/OR/DIFF/XOR), approximate: just store the new region
      if (hrgn === 0) return 1;
      const rgn = _gdiObjects[hrgn];
      if (!rgn || rgn.type !== 'region') return 0;
      dc.clipRgn = { rects: rgn.rects.map(r => ({...r})) };
      return rgn.rects.length > 1 ? 3 : 2;
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
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      const c = t.ctx;
      const dc = _getDC(hdc);
      const pc = dc.penColor;
      c.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
      c.lineWidth = dc.penWidth;
      c.beginPath();
      c.moveTo(t.ox + dc.posX + 0.5, t.oy + dc.posY + 0.5);
      c.lineTo(t.ox + x + 0.5, t.oy + y + 0.5);
      c.stroke();
      dc.posX = x; dc.posY = y;
      return 1;
    },
    gdi_arc: (hdc, left, top, right, bottom, xStart, yStart, xEnd, yEnd) => {
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      const c = t.ctx;
      const dc = _getDC(hdc);
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

      // Source-less ROPs: WHITENESS, BLACKNESS, PATCOPY, DSTINVERT
      if (rop === WHITENESS || rop === BLACKNESS || rop === PATCOPY || rop === DSTINVERT) {
        if (!dstTarget) return 1;
        const c = dstTarget.ctx;
        if (rop === DSTINVERT) {
          const imgData = c.getImageData(dstTarget.ox + dx, dstTarget.oy + dy, w, bh);
          for (let i = 0; i < imgData.data.length; i += 4) {
            imgData.data[i] = ~imgData.data[i] & 0xFF;
            imgData.data[i+1] = ~imgData.data[i+1] & 0xFF;
            imgData.data[i+2] = ~imgData.data[i+2] & 0xFF;
            imgData.data[i+3] = 255;
          }
          _clippedPut(c, imgData, dstTarget.ox + dx, dstTarget.oy + dy);
        } else {
          let fr = 0, fg = 0, fb = 0;
          if (rop === WHITENESS) { fr = fg = fb = 255; }
          else if (rop === PATCOPY) {
            const dc = _getDC(dstDC);
            const bc = dc.brushColor || 0;
            fr = bc & 0xFF; fg = (bc >> 8) & 0xFF; fb = (bc >> 16) & 0xFF;
          }
          c.fillStyle = `rgb(${fr},${fg},${fb})`;
          c.fillRect(dstTarget.ox + dx, dstTarget.oy + dy, w, bh);
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
        _clippedPut(dstTarget.ctx, imgData, dstTarget.ox + dx, dstTarget.oy + dy);
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
      _clippedPut(dstTarget.ctx, dstData, dstTarget.ox + dx, dstTarget.oy + dy);
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
        const c = dstTarget.ctx;
        if (rop === DSTINVERT) {
          const imgData = c.getImageData(dstTarget.ox + dx, dstTarget.oy + dy, dw, dh);
          for (let i = 0; i < imgData.data.length; i += 4) {
            imgData.data[i] = ~imgData.data[i] & 0xFF;
            imgData.data[i+1] = ~imgData.data[i+1] & 0xFF;
            imgData.data[i+2] = ~imgData.data[i+2] & 0xFF;
            imgData.data[i+3] = 255;
          }
          _clippedPut(c, imgData, dstTarget.ox + dx, dstTarget.oy + dy);
        } else {
          c.fillStyle = rop === WHITENESS ? '#ffffff' : '#000000';
          c.fillRect(dstTarget.ox + dx, dstTarget.oy + dy, dw, dh);
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
          _clippedPut(dstTarget.ctx, imgData, dstTarget.ox + dx, dstTarget.oy + dy);
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
        _clippedPut(dstTarget.ctx, dstData, dstTarget.ox + dx, dstTarget.oy + dy);
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
      _clippedPut(dstTarget.ctx, dstData, dstTarget.ox + dx, dstTarget.oy + dy);
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
      // LoadBitmap converts DIBs to device-compatible (colour) DDBs, so
      // even a 1bpp DIB becomes a colour bitmap with palette colours baked
      // in.  Do NOT mark these as mono — mono→colour expansion only applies
      // to true monochrome DDBs created via CreateBitmap(1bpp).
      return _gdiAlloc({ type: 'bitmap', w: bmp.w, h: bmp.h, pixels, canvas,
        bpp: bmp.bpp, indices: bmp.indices, paletteBGRA: bmp.paletteBGRA });
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

      const isDstWindow = _isWindowDC(hdc);
      if (isDstWindow) {
        const target = _getDrawTarget(hdc);
        if (!target) return 1;
        const clipped = _applyClip(hdc, target.ctx);
        drawText(target.ctx, target.ox + x, target.oy + y);
        if (clipped) target.ctx.restore();
        return 1;
      }

      const dstBmp = dc.selectedBitmap ? _gdiObjects[dc.selectedBitmap] : null;
      if (!dstBmp || !dstBmp.canvas) return 1;
      const c2 = dstBmp.canvas.getContext('2d');
      const clipped = _applyClip(hdc, c2);
      drawText(c2, x, y);
      if (clipped) c2.restore();
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
      const c = t.ctx;
      c.font = font;

      // Read rect from guest memory (4 * i32)
      let left = dv.getInt32(rectWA, true);
      let top = dv.getInt32(rectWA + 4, true);
      let right = dv.getInt32(rectWA + 8, true);
      let bottom = dv.getInt32(rectWA + 12, true);

      const tw = Math.round(c.measureText(text).width);
      const th = fontHeight;

      if (uFormat & 0x400) { // DT_CALCRECT
        right = left + tw;
        bottom = top + th;
        dv.setInt32(rectWA + 8, right, true);
        dv.setInt32(rectWA + 12, bottom, true);
        return th;
      }

      let x = left;
      if (uFormat & 0x01) x = left + (right - left - tw) / 2; // DT_CENTER
      else if (uFormat & 0x02) x = right - tw; // DT_RIGHT

      let y = top;
      if (uFormat & 0x20) { // DT_SINGLELINE
        if (uFormat & 0x04) y = top + (bottom - top - th) / 2; // DT_VCENTER
        else if (uFormat & 0x08) y = bottom - th; // DT_BOTTOM
      }

      const textColor = dc.textColor || 0;
      const r = textColor & 0xFF, g = (textColor >> 8) & 0xFF, b = (textColor >> 16) & 0xFF;
      const bkMode = dc.bkMode || 2;
      const bkColor = dc.bkColor !== undefined ? dc.bkColor : 0xFFFFFF;

      if (bkMode === 2) { // OPAQUE
        const br = bkColor & 0xFF, bg2 = (bkColor >> 8) & 0xFF, bb = (bkColor >> 16) & 0xFF;
        c.fillStyle = `rgb(${br},${bg2},${bb})`;
        c.fillRect(t.ox + x, t.oy + y, tw, th);
      }

      c.fillStyle = `rgb(${r},${g},${b})`;
      c.textBaseline = 'top';
      c.fillText(text, t.ox + x, t.oy + y);
      // Accelerator underline (one pixel under the prefix char), in the
      // current text colour. Real Win32 DrawText draws this whenever the
      // text contains an unescaped & and DT_NOPREFIX is clear.
      if (_accelIdx >= 0) {
        const ch = text[_accelIdx];
        // Use prefix-INCLUDING-char minus char-alone width so a trailing
        // space in `prefix` doesn't get silently stripped by canvas
        // measureText (which would put the underline one space too far
        // right — exactly the "Save As..." / "Page Setup..." regression).
        const prefixIncl = c.measureText(text.substring(0, _accelIdx + 1)).width;
        const chWidth    = c.measureText(ch).width;
        const ux = t.ox + x + Math.round(prefixIncl - chWidth);
        const uw = Math.max(1, Math.round(chWidth));
        // textBaseline='top' means y is the top of the glyph box. Node
        // canvas reports actualBoundingBoxDescent as the distance from
        // that draw-y down to the bottom of the glyph (with ascent
        // returning a small NEGATIVE value because the glyph sits below
        // y, not above it). So glyph_bottom = y + descent; place the
        // underline one pixel below that. Fall back to th if the
        // metric is unavailable on this canvas backend.
        const m = c.measureText(ch);
        let glyphBottom = th;
        if (m.actualBoundingBoxDescent != null) glyphBottom = m.actualBoundingBoxDescent;
        const uy = t.oy + y + Math.round(glyphBottom) + 1;
        c.fillRect(ux, uy, uw, 1);
      }
      return th;
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
      const t = _getDrawTarget(hdc, 0);
      if (!t) return color;
      t.ctx.fillStyle = `rgb(${r},${g},${b})`;
      t.ctx.fillRect(t.ox + x, t.oy + y, 1, 1);
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
      // Read palette
      const palette = [];
      if (biBitCount <= 8) {
        const numColors = 1 << biBitCount;
        const palOff = bmiWA + biSize;
        for (let i = 0; i < numColors; i++) {
          const b = mem[palOff + i * 4], g = mem[palOff + i * 4 + 1], r = mem[palOff + i * 4 + 2];
          palette.push((r << 16) | (g << 8) | b);
        }
      }
      const rowBytes = Math.ceil((imgW * biBitCount) / 32) * 4;
      const pixels = new Uint8Array(w * h * 4);
      for (let row = 0; row < cLines && row < h; row++) {
        const srcRow = bitsWA + (startScan + row) * rowBytes;
        const destRow = topDown ? row : (h - 1 - row);
        for (let x = 0; x < w; x++) {
          const sx = xSrc + x;
          if (sx < 0 || sx >= imgW) continue;
          const di = (destRow * w + x) * 4;
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
      if (globalThis._sdiLogCount <= 3) {
        let nonZero = 0;
        for (let i = 0; i < pixels.length; i += 4) { if (pixels[i] || pixels[i+1] || pixels[i+2]) { nonZero++; break; } }
        console.log(`  pixels nonZero=${nonZero > 0} canvas=${!!t.canvas} ox=${t.ox} oy=${t.oy}`);
      }
      const tmpCanvas = _createOffscreen(w, h);
      if (tmpCanvas) {
        const tmpCtx = tmpCanvas.getContext('2d');
        const imgData = tmpCtx.createImageData(w, h);
        imgData.data.set(pixels);
        tmpCtx.putImageData(imgData, 0, 0);
        t.ctx.drawImage(tmpCanvas, t.ox + xDest, t.oy + yDest);
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
        // Draw with scaling from source size to destination size
        t.ctx.drawImage(tmpCanvas, 0, 0, sw, sh, t.ox + xDst, t.oy + yDst, Math.abs(wDst), Math.abs(hDst));
      } catch (e) { if (typeof process !== 'undefined' && process.env && process.env.SDB_DEBUG) console.log('[sdb] err', e.message); }
      // --- DEBUG: full-buffer override (env SDB_FULL_BLIT) ---
      // Re-blit the entire 600x416 back-buffer to the window every call. If
      // the resulting screen looks correct, the bug is canvas-clearing between
      // calls or sub-rect dst positioning, not pixel decoding.
      if (typeof process !== 'undefined' && process.env && process.env.SDB_FULL_BLIT && biBitCount === 8) {
        try {
          const fullPx = new Uint8Array(imgW * imgH * 4);
          for (let row = 0; row < imgH; row++) {
            const rIdx = topDown ? row : (imgH - 1 - row);
            const rowOff = bitsWA + rIdx * rowBytes;
            for (let x = 0; x < imgW; x++) {
              const di = (row * imgW + x) * 4;
              const c = palette[mem[rowOff + x]] || 0;
              fullPx[di] = (c>>16)&0xFF; fullPx[di+1] = (c>>8)&0xFF; fullPx[di+2] = c&0xFF; fullPx[di+3] = 255;
            }
          }
          const { createCanvas } = require('canvas');
          const fc = createCanvas(imgW, imgH);
          const fcc = fc.getContext('2d');
          const fid = fcc.createImageData(imgW, imgH);
          fid.data.set(fullPx);
          fcc.putImageData(fid, 0, 0);
          t.ctx.drawImage(fc, t.ox, t.oy);
        } catch (_) {}
      }
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
  };

  // --- Tracing wrapper ---
  // Wraps host functions to log calls when a trace category is enabled.
  // Categories: 'gdi' (CreateBitmap, BitBlt, SelectObject, etc.)
  const trace = ctx.trace || new Set();

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

  // --- Generic host-function tracer ---
  // Enable with --trace-host=name1,name2 (CLI) or ctx.traceHost = Set of names.
  // Wraps any host import by name and logs args/return without a bespoke
  // formatter. Useful for one-off investigations so we stop editing source
  // to add console.log. Numbers render hex when >= 0x100.
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
