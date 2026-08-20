// Shared host imports for wine-assembly WASM instantiation.
// All runners (host.js, test/run.js, tools/render-png.js) use this.
// Real GDI with a canvas backend — the browser's canvas, or the pure-JS
// surface in lib/raster-canvas.js when headless.
//
// Usage:
//   const base = createHostImports({ getMemory, renderer, resourceJson, onExit });
//   base.host.log = (ptr, len) => { ... };  // override as needed
//   const { instance } = await WebAssembly.instantiate(wasm, { host: base.host });

// The browser supplies a real Path2D. Node does not need one: the region model
// below stores geometry as rectangle bands, and the only consumer -- the
// compositor masking a shaped window -- reads `rgn.rects`, never a path. So
// rather than pull in a native canvas for a type we do not draw with, record
// the rectangles and keep them inspectable. (Do NOT downgrade this to a no-op
// stub; an earlier one made clips collapse silently, which is how mspaint came
// to render a blank back-canvas while every GDI call reported success.)
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D {
    constructor() { this.rects = []; }
    rect(x, y, w, h) { this.rects.push({ x, y, w, h }); }
    addPath(p) { if (p && p.rects) this.rects.push(...p.rects); }
    moveTo() {} lineTo() {} ellipse() {} closePath() {}
  };
}
var _mu1 = typeof require !== 'undefined' ? require('./mem-utils') : (typeof window !== 'undefined' && window.memUtils || {});
var _dib = typeof require !== 'undefined' ? require('./dib') : new Proxy({}, { get: (_, k) => (typeof window !== 'undefined' && window.dibLib && window.dibLib[k]) });
var _gdiSurface = typeof require !== 'undefined' ? require('./gdi-surface') : (typeof window !== 'undefined' && window.gdiSurfaceLib || {});
var _traceFmt = typeof require !== 'undefined' ? require('./api-format') : (typeof window !== 'undefined' && window.apiFormat || null);
// The audio half. In the browser it is a plain classic script, so its factory
// arrives as a global rather than through an export object.
var _hostAudio = typeof require !== 'undefined' ? require('./host-audio') : { createAudioHost: createAudioHost };
var _hostWindow = typeof require !== 'undefined' ? require('./host-window') : { createWindowHost: createWindowHost };

// A TextDecoder is stateless for our use and safe to share; constructing one
// per decoded string is pure per-call garbage on a path that runs once per
// drawn string.
var _textDecoder = new TextDecoder();

function createHostImports(ctx) {
  var _readStrA = _mu1.readStrA;
  // ctx.getMemory()    -> ArrayBuffer (late-bound)
  // ctx.renderer       -> Win98Renderer instance (optional; can be getter for late binding)
  // ctx.resourceJson   -> parsed PE resources { menus, dialogs, strings, bitmaps }
  // ctx.onExit(code)   -> called on ExitProcess
  // ctx.trace          -> Set of trace categories: 'gdi', 'msg', etc. (optional)

  const readStr = (ptr, maxLen = 512) => _readStrA(ctx.getMemory(), ptr, maxLen);

  // --trace-net: one line per vln/1 frame on this process's wire. The header
  // is fixed-width, so decoding it here costs nothing and turns an opaque
  // byte blob into a readable conversation.
  const VLN_TYPES = { 1: 'SYN', 2: 'SYNACK', 3: 'DATA', 4: 'FIN', 5: 'RST' };
  const _ip4 = (v) => `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
  const traceNet = (ctx.trace && ctx.trace.has('net')) ? (dir, bytes) => {
    if (bytes.length < 28) { console.log(`[net] ${dir} malformed ${bytes.length}B`); return; }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = dv.getUint32(4, true);
    const name = VLN_TYPES[type] || `type${type}`;
    const len = dv.getUint32(24, true);
    console.log(`[net] ${dir === 'send' ? '->' : '<-'} ${name} `
      + `${_ip4(dv.getUint32(8, true))}:${dv.getUint32(12, true)} `
      + `-> ${_ip4(dv.getUint32(16, true))}:${dv.getUint32(20, true)}`
      + (len ? ` len=${len}` : ''));
  } : null;
  const readStrW = (ptr, maxLen = 512) => {
    if (!ptr) return '';
    const dv = new DataView(ctx.getMemory());
    let s = '';
    for (let i = 0; i < maxLen && ptr + i * 2 + 1 < dv.byteLength; i++) {
      const c = dv.getUint16(ptr + i * 2, true);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const readBytesString = (ptr, len) => {
    if (!ptr || !len) return '';
    const bytes = new Uint8Array(ctx.getMemory());
    let s = '';
    const end = Math.min(bytes.length, ptr + len);
    for (let p = ptr; p < end; p++) s += String.fromCharCode(bytes[p]);
    return s;
  };
  const _trace = ctx.trace || new Set();
  const _hex = v => '0x' + (v >>> 0).toString(16);
  const DIB_BACKING_BASE = 0x1C000000;
  const _traceFmtCtx = () => ({
    dv: new DataView(ctx.getMemory()),
    memory: ctx.getMemory(),
    ptrSpace: 'wasm',
    hex: _hex,
  });
  const _profileNow = () => {
    if (typeof performance !== 'undefined' && performance && performance.now) return performance.now();
    return Date.now();
  };
  const _profileEvent = (name, startedAt, data) => {
    const cb = (typeof globalThis !== 'undefined' && typeof globalThis.__waProfileHostEvent === 'function')
      ? globalThis.__waProfileHostEvent
      : null;
    if (!cb || !startedAt) return;
    try {
      cb({
        name,
        elapsedMs: Math.max(0, _profileNow() - startedAt),
        threadId: ((ctx.sharedAudio || ctx).profileThreadId || ctx.threadId || 0) | 0,
        data: data || {},
      });
    } catch (_) {}
  };
  const _formatHostTrace = (name, args, ret) => {
    if (!_traceFmt || !_traceFmt.formatHostCall) return null;
    try { return _traceFmt.formatHostCall(name, args, ret, _traceFmtCtx()); }
    catch (_) { return null; }
  };

  // --- Derived GDI presentations ---
  // Thread workers share derived surface presentations. Fonts are not among
  // them: every face the guest can name now resolves to a bitmap strike owned
  // by WAT, so there is no host-side font table to keep in sync.
  const _sharedGdi = ctx.sharedGdi || null;
  const _regionPresentations = _sharedGdi
    ? (_sharedGdi.regionPresentations || (_sharedGdi.regionPresentations = {}))
    : {};
  const _gdiSurfacePresentations = _sharedGdi
    ? (_sharedGdi.surfacePresentations || (_sharedGdi.surfacePresentations = new Map()))
    : new Map();

  // Indexed palettes live in canonical WAT memory. GdiSurface keeps only the
  // decoded RGB tuples needed to format a browser upload, so refresh that
  // derived view immediately before it is read.
  const _refreshGdiSurfacePalette = presentation => {
    if (!presentation || !presentation.surface || presentation.surface.bpp > 8 ||
        !presentation.paletteWa || presentation.paletteCount <= 0) return;
    const { surface } = presentation;
    const mem = new Uint8Array(ctx.getMemory());
    const count = Math.min(presentation.paletteCount, 1 << surface.bpp);
    const directDraw = presentation.id >= 0x200000 && presentation.id < 0x300000;
    surface.palette = [];
    for (let i = 0; i < count; i++) {
      const p = presentation.paletteWa + i * 4;
      surface.palette.push(directDraw
        ? [mem[p], mem[p + 1], mem[p + 2]]
        : [mem[p + 2], mem[p + 1], mem[p]]);
    }
    surface._paletteCache.clear();
  };

  const _scheduleGdiPresentation = presentation => {
    if (!presentation || !ctx.renderer || !ctx.renderer.scheduleRepaint) return;
    if (presentation.targetHwnd) {
      const win = ctx.renderer.windows && ctx.renderer.windows[presentation.targetHwnd];
      if (win) win.clientPainted = true;
    }
    if (presentation.targetHwnd || presentation.targetDesktop || presentation.targetOverlay) {
      ctx.renderer.scheduleRepaint();
    }
  };

  const _flushGdiSurfacePresentation = (presentation, syncForComposite = false) => {
    if (!presentation || !presentation.surface || !presentation.canvasContext) return 0;
    const dirty = presentation.surface.takeDirtyRect();
    if (!dirty) {
      if (syncForComposite && presentation.needsCompositeSync &&
          ctx.renderer && ctx.renderer._isNode && presentation.rawGetImageData) {
        presentation.rawGetImageData(presentation.syncX || 0, presentation.syncY || 0, 1, 1);
        presentation.needsCompositeSync = false;
      }
      return 1;
    }
    try {
      _refreshGdiSurfacePalette(presentation);
      // Reuse the ImageData across flushes and decode straight into it. A
      // full-surface dirty rect is ~2MB, and this path runs on every presented
      // frame: allocating an ImageData plus a staging array and copying between
      // them made a fullscreen game generate megabytes of garbage per frame,
      // which shows up as periodic GC stalls rather than a steady slowdown.
      // The size only changes when the dirty rect does, so a game redrawing the
      // same region every frame allocates nothing here after the first.
      let image = presentation.flushImage;
      if (!image || image.width !== dirty.w || image.height !== dirty.h) {
        image = presentation.canvasContext.createImageData(dirty.w, dirty.h);
        presentation.flushImage = image;
      }
      presentation.surface.rgbaRect(dirty.x, dirty.y, dirty.w, dirty.h, image.data);
      presentation.canvasContext.putImageData(image, dirty.x, dirty.y);
      if (ctx.trace && ctx.trace.has('dx')) {
        let lit = 0;
        for (let i = 0; i < image.data.length; i += 4) {
          if (image.data[i] || image.data[i + 1] || image.data[i + 2]) lit++;
        }
        console.log(`[dx] Flush   id=0x${(presentation.id >>> 0).toString(16)} ` +
          `dirty=${dirty.x},${dirty.y} ${dirty.w}x${dirty.h} litPixels=${lit} ` +
          `hwnd=0x${(presentation.targetHwnd || 0).toString(16)}`);
      }
      presentation.needsCompositeSync = !!(ctx.renderer && ctx.renderer._isNode);
      presentation.syncX = dirty.x;
      presentation.syncY = dirty.y;
      // A canvas backend may defer putImageData past an immediate
      // cross-canvas drawImage. Force any queued work visible before the Node
      // compositor consumes this presentation; browser Canvas is synchronous.
      // (The raster surface writes straight through, so this is a no-op there.)
      if (syncForComposite && ctx.renderer && ctx.renderer._isNode && presentation.rawGetImageData) {
        presentation.rawGetImageData(dirty.x, dirty.y, 1, 1);
        presentation.needsCompositeSync = false;
      }
      presentation.flushCount++;
      presentation.flushedPixels += dirty.w * dirty.h;
      // A flush with a real dirty rect is one frame the guest put on screen.
      // This — not the compositor's rate — is the number a player calls fps.
      if (typeof window !== 'undefined' && window.WinePerf) window.WinePerf.guestFrame();
      _invalidatePixelCache(presentation.canvas);
      return 1;
    } catch (_) {
      presentation.surface.markDirty(dirty.x, dirty.y, dirty.w, dirty.h);
      return 0;
    }
  };

  const _pixelCache = _sharedGdi && _sharedGdi.pixelCache ? _sharedGdi.pixelCache : new WeakMap();
  const _invalidatePixelCache = (canvas) => {
    if (canvas) _pixelCache.delete(canvas);
  };

  const _readVfsFile = (path) => {
    if (!path) return null;
    if (ctx.readFile) {
      try {
        const data = ctx.readFile(path);
        if (data && data.length) return data instanceof Uint8Array ? data : new Uint8Array(data);
      } catch (_) {}
    }
    const vfs = ctx.vfs;
    if (!vfs || !vfs.files) return null;
    const candidates = [];
    try { candidates.push(vfs._resolvePath(path)); } catch (_) {}
    candidates.push(path.toLowerCase().replace(/\//g, '\\'));
    const base = path.replace(/\//g, '\\').split('\\').pop().toLowerCase();
    for (const p of candidates) {
      const entry = vfs.files.get(p);
      if (entry && entry.data) return entry.data;
    }
    for (const [p, entry] of vfs.files) {
      const name = String(p).split('\\').pop();
      if (name === base && entry && entry.data) return entry.data;
    }
    return null;
  };

  // The same read for a caller that can wait. The CLI reads its VFS off a
  // real directory, so this always settles with what `_readVfsFile` already
  // returned; in the page a miss becomes an off-thread fetch (see host.js
  // `readFileAsync`) instead of a synchronous one that freezes the tab.
  const _readVfsFileAsync = (path) => {
    const now = _readVfsFile(path);
    if (now) return Promise.resolve(now);
    if (path && ctx.readFileAsync) {
      try {
        return Promise.resolve(ctx.readFileAsync(path))
          .then(d => (d && d.length ? (d instanceof Uint8Array ? d : new Uint8Array(d)) : null))
          .catch(() => null);
      } catch (_) {}
    }
    return Promise.resolve(null);
  };

  // Hang a BMP on the desktop. Split out of `set_wallpaper` so the same
  // bytes-to-desktop path serves a file that was mounted and one that had to
  // be fetched; returns the BOOL SystemParametersInfo hands back.
  const _applyWallpaper = (path, bytes, tiled) => {
    if (!bytes || bytes.length < 18 || bytes[0] !== 0x42 || bytes[1] !== 0x4D) return 0;
    let dib = null;
    try { dib = _dib.parseDIB(bytes.subarray(14)); } catch (_) { return 0; }
    if (!dib || dib.w <= 0 || dib.h <= 0 || !dib.pixels ||
        dib.pixels.length < dib.w * dib.h * 4) return 0;
    ctx.desktopWallpaper = { path, tiled: !!tiled, dib };
    const r = ctx.renderer;
    if (r && typeof r.setDesktopWallpaper === 'function') {
      return r.setDesktopWallpaper(dib, !!tiled) ? 1 : 0;
    }
    return 1;
  };

  // The mixer/voice/waveIn/MIDI/MCI half lives in lib/host-audio.js. It gets
  // the few helpers it shares with this half here; `getHost` is deferred
  // because the import map it returns into does not exist yet.
  const _audioHost = _hostAudio.createAudioHost(ctx, {
    readStr,
    readStrW,
    readVfsFile: _readVfsFile,
    readVfsFileAsync: _readVfsFileAsync,
    profileNow: _profileNow,
    profileEvent: _profileEvent,
    getHost: () => host,
  });

  const _setNearestCanvasContext = (ctx2d) => {
    if (ctx2d && 'imageSmoothingEnabled' in ctx2d) ctx2d.imageSmoothingEnabled = false;
    return ctx2d;
  };
  const _prepareNearestCanvas = (canvas) => {
    if (!canvas || !canvas.getContext || canvas._nearestCanvasWrapped) return canvas;
    const origGetContext = canvas.getContext.bind(canvas);
    canvas.getContext = (type, ...rest) => {
      const ctx2d = origGetContext(type, ...rest);
      return type === '2d' ? _setNearestCanvasContext(ctx2d) : ctx2d;
    };
    canvas._nearestCanvasWrapped = true;
    return canvas;
  };

  // Create an offscreen canvas. Must use the same implementation as
  // renderer.js's own factory: the compositor blits these onto the screen
  // canvas, and a surface from a different canvas library is not a valid
  // drawImage source for it.
  const _createOffscreen = (w, h) => {
    if (typeof OffscreenCanvas !== 'undefined') return _prepareNearestCanvas(new OffscreenCanvas(w, h));
    try { const { Canvas } = require('./canvas-compat'); return _prepareNearestCanvas(new Canvas(w, h)); }
    catch (e) { return null; }
  };

  // DirectDraw presentation helpers inspect the canonical DX_OBJECTS table.
  // GDI never draws through a separate JS surface cache: DirectDraw HDCs are
  // bound to the native DIB by WAT and Canvas is presentation/text only.
  const DX_OBJECTS_WA = 0x07FF0000;
  const DX_ENTRY_SIZE = 32;
  const _dxPresentedSignatures = new Map();
  let _dxHadExplicitPrimaryPresent = false;
  const _cursorCssCache = new Map();
  const _readRsrcBytes = (typeId, nameId) => {
    const we = ctx.exports || (ctx.renderer && ctx.renderer.wasm && ctx.renderer.wasm.exports);
    if (!we || !we.rsrc_find_data_wa || !we.rsrc_last_size) return null;
    const ptr = we.rsrc_find_data_wa(typeId >>> 0, nameId >>> 0);
    if (!ptr) return null;
    const size = we.rsrc_last_size() >>> 0;
    if (!size) return null;
    return new Uint8Array(ctx.getMemory(), ptr, size).slice();
  };
  const _bytesToBase64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    if (typeof btoa === 'function') return btoa(s);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    return null;
  };
  const _decodeCursorResource = (resourceId) => {
    const group = _readRsrcBytes(12, resourceId);
    if (!group || group.length < 6) return null;
    const r16 = (buf, o) => buf[o] | (buf[o + 1] << 8);
    const r32 = (buf, o) => (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;
    const count = r16(group, 4);
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 14;
      if (o + 14 > group.length) break;
      const w = group[o] || 256;
      const h = group[o + 1] || 256;
      const bytes = r32(group, o + 8);
      const score = (w <= 32 ? 1000 + w : 512 - w) * 1000 + (h <= 32 ? h : 0) * 10 + Math.min(bytes, 999);
      if (score > bestScore) { bestScore = score; best = o; }
    }
    if (best < 0) return null;
    let hotX = r16(group, best + 4);
    let hotY = r16(group, best + 6);
    let width = group[best] || 256;
    let height = group[best + 1] || 256;
    const colorCount = group[best + 2];
    const imageId = r16(group, best + 12);
    const image = _readRsrcBytes(1, imageId);
    if (!image || !image.length) return null;
    const cursorImage = (() => {
      if (image.length < 16) return image;
      const idv = new DataView(image.buffer, image.byteOffset, image.byteLength);
      const at0 = idv.getUint32(0, true);
      const at4 = idv.getUint32(4, true);
      const isDibHeader = v => v === 12 || v === 40 || v === 52 || v === 56 || v === 108 || v === 124;
      if (isDibHeader(at4) && !isDibHeader(at0)) {
        hotX = idv.getUint16(0, true);
        hotY = idv.getUint16(2, true);
        return image.slice(4);
      }
      return image;
    })();
    if (cursorImage.length >= 16) {
      const cdv = new DataView(cursorImage.buffer, cursorImage.byteOffset, cursorImage.byteLength);
      const biSize = cdv.getUint32(0, true);
      if (biSize === 12) {
        width = cdv.getUint16(4, true);
        height = cdv.getUint16(6, true) >>> 1;
      } else if (biSize >= 40) {
        width = cdv.getInt32(4, true);
        height = Math.abs(cdv.getInt32(8, true)) >>> 1;
      }
    }
    const cur = new Uint8Array(22 + cursorImage.length);
    const dv = new DataView(cur.buffer);
    dv.setUint16(0, 0, true);              // ICONDIR.idReserved
    dv.setUint16(2, 2, true);              // ICONDIR.idType = cursor
    dv.setUint16(4, 1, true);              // ICONDIR.idCount
    cur[6] = width === 256 ? 0 : width;    // ICONDIRENTRY.bWidth
    cur[7] = height === 256 ? 0 : height;  // ICONDIRENTRY.bHeight
    cur[8] = colorCount;
    cur[9] = 0;
    dv.setUint16(10, hotX, true);          // cursor hotspot x
    dv.setUint16(12, hotY, true);          // cursor hotspot y
    dv.setUint32(14, cursorImage.length, true);  // bytes in RT_CURSOR image
    dv.setUint32(18, 22, true);            // image offset
    cur.set(cursorImage, 22);
    const b64 = _bytesToBase64(cur);
    if (!b64) return null;
    const dataUrl = `data:image/x-icon;base64,${b64}`;
    return { dataUrl, hotX, hotY };
  };
  const _cursorCssForHandle = (hcur) => {
    const id = hcur & 0xFFFF;
    if (_cursorCssCache.has(id)) return _cursorCssCache.get(id);
    const cur = _decodeCursorResource(id);
    const css = cur ? `url(${cur.dataUrl}) ${cur.hotX} ${cur.hotY}, default` : null;
    _cursorCssCache.set(id, css);
    return css;
  };
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

  const _getPrimaryPalWa = () => {
    const e = ctx.exports;
    if (e && e.get_dx_primary_pal_wa) return e.get_dx_primary_pal_wa() >>> 0;
    return 0;
  };

  const _dxSurfaceContentScore = (surface) => {
    if (!surface || !surface.dibWa || !surface.w || !surface.h || !surface.pitch) {
      return { colors: 0, nonZero: 0, total: 0 };
    }
    const colors = new Set();
    let nonZero = 0;
    let total = 0;
    try {
      const mem = new Uint8Array(ctx.getMemory());
      const palWa = surface.bpp === 8 ? _getPrimaryPalWa() : 0;
      const step = Math.max(1, Math.ceil(Math.sqrt((surface.w * surface.h) / 2048)));
      for (let y = 0; y < surface.h; y += step) {
        const srcRow = surface.dibWa + y * surface.pitch;
        for (let x = 0; x < surface.w; x += step) {
          let key = 0;
          if (surface.bpp === 8) {
            const idx = mem[srcRow + x] || 0;
            if (palWa) {
              const pi = palWa + idx * 4;
              key = ((mem[pi] || 0) << 16) | ((mem[pi + 1] || 0) << 8) | (mem[pi + 2] || 0);
            } else {
              key = idx;
            }
          } else if (surface.bpp === 16) {
            key = (mem[srcRow + x * 2] || 0) | ((mem[srcRow + x * 2 + 1] || 0) << 8);
          } else if (surface.bpp === 24) {
            const pi = srcRow + x * 3;
            key = ((mem[pi + 2] || 0) << 16) | ((mem[pi + 1] || 0) << 8) | (mem[pi] || 0);
          } else if (surface.bpp === 32) {
            const pi = srcRow + x * 4;
            key = ((mem[pi + 2] || 0) << 16) | ((mem[pi + 1] || 0) << 8) | (mem[pi] || 0);
          }
          colors.add(key >>> 0);
          if (key !== 0) nonZero++;
          total++;
        }
      }
    } catch (_) {}
    return { colors: colors.size, nonZero, total };
  };

  const _chooseDxPresentationSurface = (primary, offscreen) => {
    const scored = (surface) => ({ surface, score: _dxSurfaceContentScore(surface) });
    const useful = (item) => item && item.score.nonZero > 0;
    const bestByDiversity = (items) => items
      .filter(useful)
      .sort((a, b) =>
        (b.score.colors - a.score.colors) ||
        (b.score.nonZero - a.score.nonZero))[0] || null;

    const primaryCandidates = primary.map(scored);
    const offscreenCandidates = offscreen
      .filter(s => s.w >= 320 && s.h >= 200)
      .map(scored);
    const bestPrimary = bestByDiversity(primaryCandidates);
    const bestOffscreen = bestByDiversity(offscreenCandidates);

    if (!bestPrimary) {
      for (const p of primary) {
        const matching = bestByDiversity(offscreenCandidates.filter(item =>
          item.surface.w === p.w &&
          item.surface.h === p.h &&
          item.surface.bpp === p.bpp));
        if (matching) return matching.surface;
      }
      return bestOffscreen ? bestOffscreen.surface : null;
    }

    if (bestOffscreen &&
        bestOffscreen.score.colors >= 16 &&
        bestOffscreen.score.colors >= Math.max(bestPrimary.score.colors + 8, bestPrimary.score.colors * 4)) {
      return bestOffscreen.surface;
    }

    return bestPrimary.surface;
  };

  const _noteDxPresent = (slot) => {
    const info = _surfaceInfo(slot);
    if (!info || !info.dibWa || !info.w || !info.h) return;
    try {
      const flags = new DataView(ctx.getMemory()).getUint32(DX_OBJECTS_WA + (slot >>> 0) * DX_ENTRY_SIZE + 28, true);
      if (flags & 1) _dxHadExplicitPrimaryPresent = true;
    } catch (_) {}
  };

  const _surfacePresentSignature = (surface) => {
    if (!surface || !surface.dibWa || !surface.bytes) return '';
    let h = 2166136261 >>> 0;
    const mix = (v) => {
      h ^= v & 0xFF;
      h = Math.imul(h, 16777619) >>> 0;
    };
    try {
      const mem = new Uint8Array(ctx.getMemory());
      const step = Math.max(1, surface.pitch >>> 2);
      for (let i = 0; i < surface.bytes; i += step) mix(mem[surface.dibWa + i]);
      mix(mem[surface.dibWa + surface.bytes - 1]);
      const palWa = surface.bpp === 8 ? _getPrimaryPalWa() : 0;
      if (palWa) {
        for (let i = 0; i < 1024; i += 16) {
          mix(mem[palWa + i]);
          mix(mem[palWa + i + 1]);
          mix(mem[palWa + i + 2]);
        }
      }
    } catch (_) {}
    return `${surface.slot}:${surface.w}x${surface.h}:${surface.bpp}:${h}`;
  };

  const _presentDxSurfaceToMainWindow = (surface) => {
    const e = ctx.exports;
    if (!e || !e.get_main_hwnd || !surface || !surface.dibWa) return 0;
    const hwnd = e.get_main_hwnd() >>> 0;
    if (!hwnd) return 0;

    if (ctx.renderer && ctx.renderer.getWindowCanvas) {
      const wc = ctx.renderer.getWindowCanvas(hwnd);
      if (wc && wc.ctx) {
        const win = ctx.renderer.windows && ctx.renderer.windows[hwnd];
        const mem = new Uint8Array(ctx.getMemory());
        let dxLayer = win && win._dxFrameLayer;
        if (!dxLayer || dxLayer.w !== surface.w || dxLayer.h !== surface.h) {
          const canvas = _createOffscreen(surface.w, surface.h);
          dxLayer = canvas ? {
            canvas,
            ctx: canvas.getContext('2d'),
            w: surface.w,
            h: surface.h,
          } : null;
          if (win) win._dxFrameLayer = dxLayer;
        }
        const targetCtx = dxLayer ? dxLayer.ctx : wc.ctx;
        const img = targetCtx.createImageData(surface.w, surface.h);
        const data = img.data;
        const palWa = _getPrimaryPalWa();
        for (let y = 0; y < surface.h; y++) {
          const srcRow = surface.dibWa + y * surface.pitch;
          for (let x = 0; x < surface.w; x++) {
            const di = (y * surface.w + x) * 4;
            let r = 0, g = 0, b = 0;
            if (surface.bpp === 8) {
              const idx = mem[srcRow + x];
              if (palWa) {
                const pi = palWa + idx * 4;
                r = mem[pi];
                g = mem[pi + 1];
                b = mem[pi + 2];
              } else {
                r = g = b = idx;
              }
            } else if (surface.bpp === 16) {
              const px = mem[srcRow + x * 2] | (mem[srcRow + x * 2 + 1] << 8);
              r = ((px >> 11) & 0x1F) * 255 / 31 | 0;
              g = ((px >> 5) & 0x3F) * 255 / 63 | 0;
              b = (px & 0x1F) * 255 / 31 | 0;
            } else if (surface.bpp === 24) {
              b = mem[srcRow + x * 3];
              g = mem[srcRow + x * 3 + 1];
              r = mem[srcRow + x * 3 + 2];
            } else if (surface.bpp === 32) {
              b = mem[srcRow + x * 4];
              g = mem[srcRow + x * 4 + 1];
              r = mem[srcRow + x * 4 + 2];
            }
            data[di] = r;
            data[di + 1] = g;
            data[di + 2] = b;
            data[di + 3] = 255;
          }
        }
        targetCtx.putImageData(img, 0, 0);
        if (!dxLayer) wc.ctx.putImageData(img, 0, 0);
        if (ctx.trace && ctx.trace.has('dx')) {
          // The [dx] Present line above says what the guest DIB holds; this
          // says what the window surface received after palette mapping, and
          // which surface it landed on. A present with content that still
          // shows black is one of these two lines disagreeing.
          let lit = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] || data[i + 1] || data[i + 2]) lit++;
          }
          console.log(`[dx] Upload  slot=${surface.slot} ${surface.w}x${surface.h} ` +
            `target=${dxLayer ? 'dxLayer' : 'backCanvas'} hwnd=0x${hwnd.toString(16)} litPixels=${lit}`);
        }
        if (win) win.clientPainted = true;
        ctx.renderer.scheduleRepaint && ctx.renderer.scheduleRepaint();
        return 1;
      }
    }

    if (typeof host.gdi_set_dib_to_device !== 'function') return 0;

    const mem = ctx.getMemory();
    const dv = new DataView(mem);
    // Keep this separate from PAINT_SCRATCH (0xAD40), which WAT window
    // paint/update helpers reuse while DirectDraw frames are being presented.
    const bmiWa = 0x00011140;
    const palWa = _getPrimaryPalWa();
    const bmiLen = 40 + (surface.bpp <= 8 ? 1024 : 12);
    new Uint8Array(mem, bmiWa, bmiLen).fill(0);
    dv.setUint32(bmiWa, 40, true);
    dv.setInt32(bmiWa + 4, surface.w | 0, true);
    dv.setInt32(bmiWa + 8, -surface.h, true);
    dv.setUint16(bmiWa + 12, 1, true);
    dv.setUint16(bmiWa + 14, surface.bpp, true);
    if (surface.bpp <= 8 && palWa) {
      const pal = new Uint8Array(mem, palWa, 1024);
      const bmi = new Uint8Array(mem, bmiWa + 40, 1024);
      for (let i = 0; i < 256; i++) {
        const pi = i * 4;
        bmi[pi] = pal[pi + 2];     // RGBQUAD blue
        bmi[pi + 1] = pal[pi + 1]; // green
        bmi[pi + 2] = pal[pi];     // red
      }
    } else if (surface.bpp === 16) {
      dv.setUint32(bmiWa + 16, 3, true); // BI_BITFIELDS
      dv.setUint32(bmiWa + 40, 0xF800, true);
      dv.setUint32(bmiWa + 44, 0x07E0, true);
      dv.setUint32(bmiWa + 48, 0x001F, true);
    }

    host.gdi_set_dib_to_device(
      hwnd + 0x40000,
      0, 0,
      surface.w, surface.h,
      0, 0,
      0, surface.h,
      surface.dibWa,
      bmiWa,
      0);
    return 1;
  };

  const _presentBestDxOffscreen = (force = false) => {
    if (!force && _dxHadExplicitPrimaryPresent) return 0;
    const primary = [];
    const offscreen = [];
    for (let slot = 0; slot < 32; slot++) {
      const info = _surfaceInfo(slot);
      if (!info || !info.dibWa || !info.w || !info.h) continue;
      const flags = new DataView(ctx.getMemory()).getUint32(DX_OBJECTS_WA + slot * DX_ENTRY_SIZE + 28, true);
      const surface = { ...info, flags, bytes: info.pitch * info.h };
      if (flags & 1) primary.push(surface);
      else if (flags & 4) offscreen.push(surface);
    }

    const presentIfChanged = (surface) => {
      if (!surface) return 0;
      const sig = _surfacePresentSignature(surface);
      if (!force && _dxPresentedSignatures.get(surface.slot) === sig) return 0;
      const r = _presentDxSurfaceToMainWindow(surface);
      if (r) _dxPresentedSignatures.set(surface.slot, sig);
      return r;
    };

    return presentIfChanged(_chooseDxPresentationSurface(primary, offscreen));
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
    console.error(`        Region rasterization must remain in WAT.`);
    console.error('====================================');
    throw new Error('Approach B required: ' + opName);
  }

  function _rectPath(l, t, r, b) {
    const p = new Path2D();
    p.rect(l, t, r - l, b - t);
    return p;
  }
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
  // WAT owns canonical region geometry. This adapter only rebuilds the
  // browser-facing Path2D/rectangle cache used by the Canvas presenter.
  function _makeBandRgn(rects) {
    const valid = rects.filter(rect => rect.r > rect.l && rect.b > rect.t);
    if (!valid.length) {
      return { type: 'region', branches: [], bbox: { l: 0, t: 0, r: 0, b: 0 }, simpleRect: null, rects: [] };
    }
    let l = valid[0].l, t = valid[0].t, r = valid[0].r, b = valid[0].b;
    const branches = [];
    const legacyRects = [];
    for (const rect of valid) {
      l = Math.min(l, rect.l); t = Math.min(t, rect.t);
      r = Math.max(r, rect.r); b = Math.max(b, rect.b);
      branches.push([{ path: _rectPath(rect.l, rect.t, rect.r, rect.b), rule: 'nonzero', polarity: +1 }]);
      legacyRects.push({ x: rect.l, y: rect.t, w: rect.r - rect.l, h: rect.b - rect.t });
    }
    return {
      type: 'region', branches, bbox: { l, t, r, b },
      simpleRect: valid.length === 1 ? { ...valid[0] } : null,
      rects: legacyRects,
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

  // putImageData that respects canvas clip (uses temp canvas + drawImage)

  // Clip canvas to exclude windows above the given hwnd, run fn, restore

  // Returns the client origin for screen-space drawing (used by erase_background
  // and other functions that need screen coords for the display canvas).

  const _getClientOriginScreen = (hwnd) => {
    const r = ctx.renderer;
    if (!r) return { x: 0, y: 0 };
    const we = r.wasm && r.wasm.exports;
    if (we && we.wnd_client_screen_x && we.wnd_client_screen_y) {
      try { return { x: we.wnd_client_screen_x(hwnd) | 0, y: we.wnd_client_screen_y(hwnd) | 0 }; } catch (_) {}
    }
    const win = r.windows[hwnd];
    if (!win) return { x: 0, y: 0 };
    if (win.isChild && win.parentHwnd) {
      const parentOrigin = _getClientOriginScreen(win.parentHwnd);
      return { x: parentOrigin.x + win.x, y: parentOrigin.y + win.y };
    }
    let cy = win.y + 3;
    if ((win.style & 0x00C00000) === 0x00C00000) cy += 19;
    if (r._hasMenuBar(win)) cy += 18;
    return { x: win.x + 3, y: cy + 1 };
  };

  // For GDI drawing: top-level windows draw at (0,0) on their offscreen canvas.
  // Child windows offset by their position within the parent's client area.
  const _getClientOrigin = (hwnd) => {
    const r = ctx.renderer;
    if (!r) return { x: 0, y: 0 };
    const we = r.wasm && r.wasm.exports;
    if (we && we.wnd_client_screen_x && we.wnd_client_screen_y && we.wnd_window_screen_x && we.wnd_window_screen_y) {
      try {
        return {
          x: (we.wnd_client_screen_x(hwnd) | 0) - (we.wnd_window_screen_x(hwnd) | 0),
          y: (we.wnd_client_screen_y(hwnd) | 0) - (we.wnd_window_screen_y(hwnd) | 0),
        };
      } catch (_) {}
    }
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

  // The window/scrollbar/cursor/input half lives in lib/host-window.js.
  const _windowHost = _hostWindow.createWindowHost(ctx, {
    readStr,
    readStrW,
    cursorCssForHandle: _cursorCssForHandle,
  });

  const _env = (typeof process !== 'undefined' && process.env) ? process.env : {};
  const host = {
    // --- Logging (override for tracing/UI) ---
    log: () => {},
    log_i32: (v) => { if (_env.DBG_INV) console.log('[LOG_I32]', '0x' + (v >>> 0).toString(16), v); },
    log_api_exit: () => {},
    log_block: () => {},
    log_eip: () => {},

    // --- DirectX internal tracing hook (--trace-dx) ---
    // WAT calls this from Lock/Unlock/Blt/SetEntries/dx_present/Flip.
    dx_trace: (kind, slot) => {
      if (kind === 5) _noteDxPresent(slot);
    },

    // --- WAT-native control paint tracing (--trace-ctrl) ---
    // Overridden below when the category is on; a no-op otherwise so the
    // call costs nothing on the normal path.
    ctrl_paint_trace: () => {},
    ctrl_sb_trace: () => {},

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
        const g2w = ctx.g2w || (addr => addr - imageBase + 0x12000);
        const dv = new DataView(e.memory.buffer);
        console.error('  Stack:');
        for (let i = 0; i < 16; i++) {
          const addr = esp + i * 4;
          const val = dv.getUint32(g2w(addr), true);
          console.error(`    [${hex(addr)}] = ${hex(val)}${i === 0 ? '  <- ret addr' : ''}`);
        }
      }
      console.error('  FATAL: implement this API');
      ctx.lastUnimplemented = name || `(ordinal@${hex(namePtr)})`;
    },

    // --- System ---
    get_screen_size: () => {
      const r = ctx.renderer;
      const w = r ? r.canvas.width : 640;
      const h = r ? r.canvas.height : 480;
      return (w & 0xFFFF) | ((h & 0xFFFF) << 16);
    },
    set_wallpaper: (pathWa, tiled) => {
      const path = readStr(pathWa);
      const bytes = _readVfsFile(path);
      if (bytes) return _applyWallpaper(path, bytes, tiled);
      // Not mounted. Where a miss can still be fetched (the page), pull it off
      // the main thread and hang it on the desktop when it lands — a wallpaper
      // is the one thing in Win32 that can appear a beat late without any
      // caller noticing, and the app is told the same TRUE it used to get back
      // when that read blocked the tab. Where a miss is final (the CLI reads a
      // real directory), the file is simply not there.
      if (!ctx.readFileAsync) return 0;
      _readVfsFileAsync(path).then(late => {
        if (late) _applyWallpaper(path, late, tiled);
      });
      return 1;
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
        processId: (ctx.processId >>> 0) || 1000,
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
    // Mixer, MCI, MIDI, voices, waveOut and waveIn — see lib/host-audio.js.
    // They are spread in rather than nested so the guest still imports one
    // flat namespace.
    ..._audioHost.imports,
    // The guest's clock. Every timing API the guest can see comes from here,
    // so this is the one place that decides whether "wait 20ms" means 20ms of
    // the user's life or 20ms of emulated time.
    get_ticks: () => (ctx.guestNowMs ? ctx.guestNowMs() : Date.now()) & 0x7FFFFFFF,
    // Wall clock, deliberately NOT the guest clock. get_ticks above is the
    // guest's own notion of time and a harness is free to synthesise it —
    // test/run.js derives it from the batch counter, so "3000 ms" of it can be
    // fifteen batches. Anything timing out a wait on real-world progress (a
    // peer in another process answering, for instance) has to ask this one.
    real_time_ms: () => Date.now() & 0x7FFFFFFF,
    yield: (reason) => { /* no-op in CLI — browser host can use this to pause */ },

    // ---- Virtual LAN wire (docs/virtual-lan-party.md) ----
    // ctx.vlanWire is a lib/vlan-wire.js endpoint, or absent when this
    // process is not in a room. With no wire the room is this process
    // alone: sends succeed into nothing and nothing ever arrives, which is
    // exactly how a machine with no cable behaves. WAT still routes every
    // in-process connection through its own table, so a solo run is
    // unaffected.
    net_frame_send: (framePtr, len) => {
      const wire = ctx.vlanWire;
      if (!wire) return 1;
      if (len <= 0) return 1;
      const bytes = new Uint8Array(ctx.getMemory(), framePtr, len).slice();
      if (traceNet) traceNet('send', bytes);
      return wire.send(bytes) ? 1 : 0;
    },
    net_frame_peek: (bufPtr, cap) => {
      const wire = ctx.vlanWire;
      if (!wire) return 0;
      const frame = wire.peek();
      if (!frame) return 0;
      if (frame.length > cap) return -1;
      new Uint8Array(ctx.getMemory(), bufPtr, frame.length).set(frame);
      return frame.length;
    },
    net_frame_commit: () => {
      const wire = ctx.vlanWire;
      if (!wire) return;
      if (traceNet) { const f = wire.peek(); if (f) traceNet('recv', f); }
      wire.commit();
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
        'DSOUND.DLL#2': 'DirectSoundEnumerateA',
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
      // One decoder for the process. Constructing a TextDecoder per call is
      // not free, and this runs once per drawn string.
      const text = _textDecoder.decode(bytes);
      const c = ctx.renderer.ctx;
      c.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
      c.font = ctx.renderer.font;
      c.textAlign = 'left';
      c.textBaseline = 'top';
      c.fillText(text, x, y);
    },

    // Window management, scrollbars, capture, cursor and the input pollers —
    // see lib/host-window.js. Spread in rather than nested so the guest still
    // imports one flat namespace.
    ..._windowHost.imports,

    // A 16-bit LoadLibrary for a module nothing imported: WAT has given the
    // name a module id and needs its bytes in that id's staging slot before it
    // can load it. Pre-staging every DLL beside the exe is not an option —
    // there are more of them than there are slots — so the file is fetched at
    // the moment the task asks for it. Answers 0 when there is no such file,
    // which is a LoadLibrary failure and not an error here.
    win16_stage_module: (pstr, id) => {
      if (!ctx.win16StageModule) return 0;
      const mem = new Uint8Array(ctx.getMemory());
      const n = mem[pstr];
      let name = '';
      for (let i = 0; i < n; i++) name += String.fromCharCode(mem[pstr + 1 + i]);
      return ctx.win16StageModule(name, id) ? 1 : 0;
    },

    // --- Real GDI presentation boundaries ---
    gdi_set_region_bands: (hrgn, rectsWA, count) => {
      if (count === -1) {
        delete _regionPresentations[hrgn];
        return 1;
      }
      if (count < 0 || count > 208) return 0;
      let rgn = _regionPresentations[hrgn];
      if (!rgn) rgn = _regionPresentations[hrgn] = _makeRectRgn(0, 0, 0, 0);
      if (rgn.type !== 'region') return 0;
      const dv = new DataView(ctx.getMemory());
      const rects = [];
      for (let i = 0; i < count; i++) {
        const p = rectsWA + i * 16;
        rects.push({
          l: dv.getInt32(p, true), t: dv.getInt32(p + 4, true),
          r: dv.getInt32(p + 8, true), b: dv.getInt32(p + 12, true),
        });
      }
      const fresh = _makeBandRgn(rects);
      rgn.branches = fresh.branches;
      rgn.bbox = fresh.bbox;
      rgn.simpleRect = fresh.simpleRect;
      rgn.rects = fresh.rects;
      return 1;
    },
    gdi_set_window_rgn: (hwnd, hrgn, redraw) => {
      if (!hrgn) {
        if (ctx.renderer) {
          ctx.renderer.setWindowRgn(hwnd, null);
          if (redraw) ctx.renderer.scheduleRepaint();
        }
        return 1;
      }
      const rgn = _regionPresentations[hrgn];
      if (!rgn || rgn.type !== 'region') return 0;
      if (ctx.renderer) {
        ctx.renderer.setWindowRgn(hwnd, rgn);
        if (redraw) ctx.renderer.scheduleRepaint();
      }
      return 1;
    },
    invalidate_rect: (hwnd, l, t, r, b, erase) => {
      if (!hwnd) return;
      if (ctx.renderer) ctx.renderer.invalidate(hwnd);
    },
    invalidate_rgn: (hwnd, hrgn, erase) => {
      if (!hwnd) return;
      if (ctx.renderer) ctx.renderer.invalidate(hwnd);
    },
    validate_rect: (hwnd, l, t, r, b) => {
      return 1;
    },
    validate_rgn: (hwnd, hrgn) => {
      return 1;
    },
    get_update_rect: (hwnd, rectWA) => {
      if (rectWA) {
        const dv = new DataView(ctx.getMemory());
        dv.setInt32(rectWA, 0, true); dv.setInt32(rectWA + 4, 0, true);
        dv.setInt32(rectWA + 8, 0, true); dv.setInt32(rectWA + 12, 0, true);
      }
      return 0;
    },
    get_update_rgn: (hwnd, dstHrgn) => {
      const dst = _regionPresentations[dstHrgn];
      if (!dst || dst.type !== 'region') return 0;
      const fresh = _makeRectRgn(0, 0, 0, 0);
      dst.branches = fresh.branches; dst.bbox = fresh.bbox;
      dst.simpleRect = null; dst.rects = fresh.rects;
      return 1;
    },
    next_dirty_hwnd: () => {
      return 0;
    },
    seed_child_paints: () => 0,
    begin_paint_clip: (hdc, hwnd, rectWA) => {
      if (rectWA) {
        const dv = new DataView(ctx.getMemory());
        dv.setInt32(rectWA, 0, true); dv.setInt32(rectWA + 4, 0, true);
        dv.setInt32(rectWA + 8, 0, true); dv.setInt32(rectWA + 12, 0, true);
      }
      return 0;
    },
    // Compatibility for stale prebuilt wasm artifacts. Current WAT computes
    // window visibility clips itself via dc_apply_* helpers.
    apply_window_clip: () => 1,
    gdi_surface_create: (id, width, height, bpp, bitsWa, stride, topDown,
      paletteWa, paletteCount, redMask, greenMask, blueMask) => {
      id >>>= 0; width |= 0; height |= 0; bpp |= 0; bitsWa >>>= 0; stride |= 0;
      paletteWa >>>= 0; paletteCount |= 0;
      redMask >>>= 0; greenMask >>>= 0; blueMask >>>= 0;
      if (!id || width <= 0 || height <= 0 || !bitsWa || stride <= 0 ||
          ![1, 4, 8, 16, 24, 32].includes(bpp)) return 0;
      const byteLength = stride * height;
      if (!Number.isSafeInteger(byteLength) || byteLength <= 0 ||
          bitsWa + byteLength > ctx.getMemory().byteLength) return 0;
      // DirectDraw may present the same locked primary surface many times per
      // frame (DX-Ball's intro fade does this once per scanline). Preserve the
      // derived canvas and coalesce dirty uploads when the canonical storage
      // identity has not changed instead of rebuilding a full RGBA cache for
      // every Unlock.
      const existing = _gdiSurfacePresentations.get(id);
      if (existing && existing.width === width && existing.height === height &&
          existing.surface && existing.surface.bpp === bpp &&
          existing.bitsWa === bitsWa && existing.surface.stride === stride &&
          existing.surface.topDown === !!topDown) {
        existing.paletteWa = paletteWa;
        existing.paletteCount = paletteCount;
        existing.masks = bpp === 16 && (redMask || greenMask || blueMask)
          ? [redMask, greenMask, blueMask]
          : undefined;
        existing.surface.masks = existing.masks;
        existing.surface.storage = new Uint8Array(ctx.getMemory());
        existing.surface.storageOffset = bitsWa;
        existing.version = ((existing.version | 0) + 1) | 0;
        return 1;
      }
      // Canonical top-level window surfaces occupy the WAT-assigned
      // 0x610001..0x610100 id range. Seed their otherwise undefined pixels
      // with COLOR_BTNFACE before sparse primitives start uploading bounding
      // rectangles. This prevents untouched pixels inside DrawEdge/FrameRect
      // bounds from appearing as an opaque black slab around Paint's options
      // well and other incrementally painted Win98 controls.
      if (bpp === 32 && id >= 0x00610001 && id <= 0x00610100) {
        const storage = new Uint8Array(ctx.getMemory());
        if ((bitsWa & 3) === 0 && (byteLength & 3) === 0) {
          new Uint32Array(storage.buffer, bitsWa, byteLength >>> 2).fill(0xFFC0C0C0);
        } else {
          for (let p = bitsWa; p < bitsWa + byteLength; p += 4) {
            storage[p] = 0xC0;
            storage[p + 1] = 0xC0;
            storage[p + 2] = 0xC0;
            storage[p + 3] = 0xFF;
          }
        }
      }
      const palette = [];
      if (bpp <= 8 && paletteWa && paletteCount > 0) {
        const mem = new Uint8Array(ctx.getMemory());
        const count = Math.min(paletteCount, 1 << bpp);
        if (paletteWa + count * 4 > mem.length) return 0;
        const directDraw = id >= 0x200000 && id < 0x300000;
        for (let i = 0; i < count; i++) {
          const p = paletteWa + i * 4;
          palette.push(directDraw
            ? [mem[p], mem[p + 1], mem[p + 2]]
            : [mem[p + 2], mem[p + 1], mem[p]]);
        }
      }
      const masks = bpp === 16 && (redMask || greenMask || blueMask)
        ? [redMask, greenMask, blueMask]
        : undefined;
      const canvas = _createOffscreen(width, height);
      if (!canvas || !_gdiSurface.GdiSurface) return 0;
      try {
        const surface = new _gdiSurface.GdiSurface({
          width, height, bpp, stride, topDown: !!topDown,
          storage: new Uint8Array(ctx.getMemory()), storageOffset: bitsWa,
          palette, masks, format: bpp === 32 ? 'bgra32' : `dib${bpp}`,
        });
        // Canvas is only a derived presentation cache. Seed it from the full
        // canonical surface before attaching it anywhere; otherwise pixels
        // that have not appeared in a later dirty upload stay transparent.
        // On window surfaces those holes showed through as white client-edge
        // gaps even though WAT memory already contained COLOR_BTNFACE.
        const canvasContext = canvas.getContext('2d');
        const initialImage = canvasContext.createImageData(width, height);
        initialImage.data.set(surface.rgbaRect(0, 0, width, height));
        canvasContext.putImageData(initialImage, 0, 0);
        const presentation = {
          id, width, height, canvas, surface, bitsWa, byteLength,
          paletteWa, paletteCount, masks, canvasContext,
          flushCount: 0, flushedPixels: 0, version: 1,
        };
        presentation.rawGetImageData = canvasContext.getImageData.bind(canvasContext);
        presentation.flush = syncForComposite =>
          _flushGdiSurfacePresentation(presentation, !!syncForComposite);
        presentation.refreshPalette = () => _refreshGdiSurfacePalette(presentation);
        surface.onDirty = () => _scheduleGdiPresentation(presentation);
        canvas._waFlushCanonicalSurface = presentation.flush;
        canvas._waCanonicalPresentation = presentation;
        canvasContext.getImageData = (...args) => {
          presentation.flush();
          return presentation.rawGetImageData(...args);
        };
        if (typeof canvas.toBuffer === 'function') {
          const rawToBuffer = canvas.toBuffer.bind(canvas);
          canvas.toBuffer = (...args) => {
            presentation.flush();
            return rawToBuffer(...args);
          };
        }
        if (typeof canvas.toDataURL === 'function') {
          const rawToDataURL = canvas.toDataURL.bind(canvas);
          canvas.toDataURL = (...args) => {
            presentation.flush();
            return rawToDataURL(...args);
          };
        }
        _gdiSurfacePresentations.set(id, presentation);
        return 1;
      } catch (_) {
        return 0;
      }
    },
    gdi_surface_upload: (id, left, top, right, bottom) => {
      const presentation = _gdiSurfacePresentations.get(id >>> 0);
      if (!presentation) return 0;
      const { width, height, surface } = presentation;
      left = Math.max(0, left | 0); top = Math.max(0, top | 0);
      right = Math.min(width, right | 0); bottom = Math.min(height, bottom | 0);
      if (right <= left || bottom <= top) return 1;
      presentation.version = ((presentation.version | 0) + 1) | 0;
      surface.markDirty(left, top, right - left, bottom - top);
      return 1;
    },
    gdi_screen_readback: (bitsWa, width, height, stride) => {
      bitsWa >>>= 0; width |= 0; height |= 0; stride |= 0;
      const renderer = ctx.renderer;
      const memory = new Uint8Array(ctx.getMemory());
      if (!bitsWa || width <= 0 || height <= 0 || stride < width * 4 ||
          bitsWa + stride * height > memory.length) return 0;
      // A renderer-less harness has no cross-process scene to materialize;
      // retain the caller's existing canonical screen bytes.
      if (!renderer || typeof renderer.composeCanonicalScreenToMemory !== 'function') return 1;
      return renderer.composeCanonicalScreenToMemory(
        memory, bitsWa, width, height, stride) ? 1 : 0;
    },
    gdi_surface_attach: (id, hwnd) => {
      const presentation = _gdiSurfacePresentations.get(id >>> 0);
      hwnd |= 0;
      if (!presentation || !ctx.renderer) return 0;
      if (hwnd === -1) {
        if (!ctx.renderer.attachDesktopSurface) return 0;
        if (!ctx.renderer.attachDesktopSurface(presentation.canvas)) return 0;
        presentation.targetDesktop = true;
        _scheduleGdiPresentation(presentation);
        return 1;
      }
      if (!hwnd) {
        if (!ctx.renderer.attachMenuOverlaySurface) return 0;
        if (!ctx.renderer.attachMenuOverlaySurface(presentation.canvas)) return 0;
        presentation.targetOverlay = true;
        _scheduleGdiPresentation(presentation);
        return 1;
      }
      if (!ctx.renderer.attachWindowSurface) return 0;
      if (!ctx.renderer.attachWindowSurface(hwnd, presentation.canvas)) return 0;
      presentation.targetHwnd = hwnd;
      _scheduleGdiPresentation(presentation);
      return 1;
    },
    gdi_surface_delete: (id) => {
      id >>>= 0;
      const presentation = _gdiSurfacePresentations.get(id);
      if (presentation && presentation.targetHwnd && ctx.renderer && ctx.renderer.detachWindowSurface) {
        ctx.renderer.detachWindowSurface(presentation.targetHwnd, presentation.canvas);
      }
      if (presentation && presentation.targetOverlay && ctx.renderer && ctx.renderer.detachMenuOverlaySurface) {
        ctx.renderer.detachMenuOverlaySurface(presentation.canvas);
      }
      if (presentation && presentation.targetDesktop && ctx.renderer && ctx.renderer.detachDesktopSurface) {
        ctx.renderer.detachDesktopSurface(presentation.canvas);
      }
      if (presentation && presentation.surface) presentation.surface.onDirty = null;
      if (presentation) presentation.refreshPalette = null;
      if (presentation && presentation.canvas) {
        delete presentation.canvas._waFlushCanonicalSurface;
        delete presentation.canvas._waCanonicalPresentation;
      }
      return _gdiSurfacePresentations.delete(id) ? 1 : 0;
    },
    note_richedit_charformat_size: (yHeightTwips, selectionLo, selectionHi) => {
      const twips = yHeightTwips | 0;
      if (twips > 0 && twips < 32767) {
        const px = Math.round(twips * 96 / 1440);
        if (px >= 8 && px <= 128) {
          ctx._richeditLastYHeightTwips = twips;
          ctx._richeditLastSelectionLo = Math.max(0, selectionLo | 0);
          ctx._richeditLastSelectionHi = Math.max(ctx._richeditLastSelectionLo, selectionHi | 0);
        }
      }
    },
    // --- Math (FPU transcendentals) ---
    math_sin: Math.sin,
    math_cos: Math.cos,
    math_tan: Math.tan,
    math_atan2: Math.atan2,
    math_log2: Math.log2,
    math_pow: Math.pow,
    math_pow2: (x) => 2 ** x,

    // --- Thread/event stubs (overridden by ThreadManager when active) ---
    create_thread: (startAddr, param, stackSize, creationFlags) => 0,
    suspend_thread: (handle) => 0xFFFFFFFF,
    resume_thread: (handle) => 0xFFFFFFFF,
    exit_thread: (exitCode) => {},
    get_exit_code_thread: (handle) => 0x103, // STILL_ACTIVE
    create_event: (manualReset, initialState) => 0,
    set_event: (handle) => 1,
    reset_event: (handle) => 1,
    wait_single: (handle, timeout) => 0, // WAIT_OBJECT_0 — immediate success
    di_set_event_notification: (deviceType, handle) => {
      const r = ctx.renderer;
      if (r) {
        if (!r._directInputEventHandles) r._directInputEventHandles = Object.create(null);
        const type = deviceType >>> 0;
        if (handle) r._directInputEventHandles[type] = handle >>> 0;
        else delete r._directInputEventHandles[type];
        r._directInputSignalEvent = (h) => host.set_event ? host.set_event(h >>> 0) : 1;
      }
      if (handle && host.set_event) host.set_event(handle >>> 0);
      return 1;
    },
    create_semaphore: (initialCount, maxCount) => 0,
    release_semaphore: (handle, releaseCount, lpPrevCountWA) => 1,
  };

  const _profileWrapHost = (name, profileName, dataFn) => {
    const orig = host[name];
    if (typeof orig !== 'function') return;
    host[name] = (...args) => {
      const startedAt = _profileNow();
      try {
        return orig(...args);
      } finally {
        let data = null;
        try { data = dataFn ? dataFn(args) : null; } catch (_) {}
        _profileEvent(profileName || name, startedAt, data);
      }
    };
  };
  _profileWrapHost('wave_out_write', 'host.waveOutWrite', ([handle, ptr, len]) => ({
    handle: handle >>> 0,
    bytes: len | 0,
  }));
  _profileWrapHost('wave_out_schedule_done', 'host.waveOutScheduleDone', ([handle, waveHdrWA, waveHdrGA, len]) => ({
    handle: handle >>> 0,
    bytes: (len === undefined ? waveHdrGA : len) | 0,
  }));
  _profileWrapHost('gdi_bitblt', 'gdi.bitblt', ([dstDC, dx, dy, w, h, srcDC, sx, sy, rop]) => ({
    dstDC: dstDC >>> 0,
    srcDC: srcDC >>> 0,
    w: w | 0,
    h: h | 0,
    pixels: Math.max(0, (w | 0) * (h | 0)),
    rop: rop >>> 0,
  }));
  _profileWrapHost('gdi_stretch_blt', 'gdi.stretchBlt', ([dstDC, dx, dy, dw, dh, srcDC, sx, sy, sw, sh, rop]) => ({
    dstDC: dstDC >>> 0,
    srcDC: srcDC >>> 0,
    w: dw | 0,
    h: dh | 0,
    pixels: Math.max(0, (dw | 0) * (dh | 0)),
    srcW: sw | 0,
    srcH: sh | 0,
    rop: rop >>> 0,
  }));

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
    const stats = ctx._waveStats = ctx._waveStats || { open: 0, write: 0, writeBytes: 0, reset: 0, close: 0, lastFmt: null, lastWriteAt: 0 };
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
    waveWrap('wave_out_reset', host.wave_out_reset,
      ([h], r) => { stats.reset = (stats.reset || 0) + 1; return `reset(h=${hex(h)})`; });
    waveWrap('wave_out_get_pos', host.wave_out_get_pos,
      ([h], r) => `getPos(h=${hex(h)}) → ${r}`);
    waveWrap('wave_out_set_volume', host.wave_out_set_volume,
      ([h, v], r) => `setVolume(h=${hex(h)} v=${hex(v)})`);
    ctx._finalizeWaveTrace = () => {
      if (trace.has('wave')) {
        console.log(`[wave] totals: open=${stats.open} write=${stats.write} (${stats.writeBytes} B) reset=${stats.reset} close=${stats.close}`);
      }
      if (trace.has('audio-stats')) {
        const idle = stats.lastWriteAt ? ((Date.now() - stats.lastWriteAt) / 1000).toFixed(1) : '?';
        console.log(`[audio] final: ${stats.write} buffers / ${stats.writeBytes} B; idle since last write: ${idle}s`);
      }
    };
  }

  // GDI trace wrapping is intentionally limited to the permanent JS policy
  // surface. Non-text raster/state calls no longer cross this module.
  if (trace.has('gdi')) {
    const wrap = (name, fn) => {
      host[name] = (...args) => {
        const result = fn(...args);
        console.log(`[gdi] ${_formatHostTrace(name, args, result) || name}`);
        return result;
      };
    };
    for (const name of [
      'gdi_set_region_bands', 'gdi_set_window_rgn',
      'gdi_surface_create', 'gdi_surface_upload', 'gdi_surface_delete', 'gdi_surface_attach',
    ]) wrap(name, host[name]);
  }

  // Which NE modules a 16-bit task asks for by name at runtime, and whether
  // there were bytes to give it. Nothing else names them: they are absent from
  // the module-reference table by definition, so an app that quietly stops
  // because its LoadLibrary came back zero looks like an app that decided to
  // exit. The browser has to be told these names in advance (see
  // `win16Modules` in lib/apps.js), and this is how the list is found.
  if (trace.has('win16')) {
    const staged = host.win16_stage_module;
    host.win16_stage_module = (pstr, id) => {
      const result = staged(pstr, id);
      const mem = new Uint8Array(ctx.getMemory());
      let name = '';
      for (let i = 0; i < mem[pstr]; i++) name += String.fromCharCode(mem[pstr + 1 + i]);
      console.log(`[win16] stage ${name} as module ${id}: ${result ? 'staged' : 'no file'}`);
      return result;
    };
  }

  // Which WAT-native control painted, where, and in what order. The class
  // numbers are the ones $control_wndproc_dispatch switches on.
  if (trace.has('ctrl')) {
    const CTRL_CLASS = {
      1: 'Button', 2: 'Edit', 3: 'Static', 4: 'ListBox', 5: 'ComboBox',
      6: 'ColorGrid', 7: 'ScrollBar', 8: 'TreeView', 9: 'ComboPopup',
      10: 'FindReplace', 11: 'ShellAbout', 12: 'OpenSave', 13: 'StubDlg',
      14: 'FontDlg', 15: 'ColorDlg', 16: 'MessageBox', 17: 'Progress',
      18: 'ListView', 19: 'TrackBar', 20: 'Tooltip', 21: 'Toolbar',
      22: 'StatusBar', 23: 'ColorSpectrum', 24: 'RichEdit1', 25: 'RichEdit2',
      26: 'ColorPreview', 27: 'HelpTab', 28: 'SysLink', 29: 'ShellDlg',
    };
    // hvis packs the height with the effective-visibility bit: a control that
    // paints with vis=0 is one some path let through while it or an ancestor
    // was still hidden, and its pixels are a ghost nothing will erase.
    // Why a flagged control did not paint. A control missing from this trace
    // entirely was never asked -- nothing invalidated it.
    const SKIP = { 1: 'ancestor-pending', 2: 'hidden', 3: 'empty-update', 4: 'no-class' };
    host.ctrl_paint_trace = (hwnd, clsAndReason, sx, sy, w, hvis, parent) => {
      const cls = clsAndReason & 0xff;
      const reason = clsAndReason >>> 8;
      console.log(`[ctrl] ${reason ? 'skip:' + SKIP[reason] : 'paint'}`
        + ` hwnd=0x${(hwnd >>> 0).toString(16)}`
        + ` ${CTRL_CLASS[cls] || 'class' + cls}`
        + ` at ${sx},${sy} ${w}x${hvis >>> 1}`
        + ` vis=${hvis & 1}`
        + ` parent=0x${(parent & 0xffffff).toString(16)}`
        + ` state=${(parent >>> 25) & 1}`
        + ` kind=${(parent >>> 26) & 0xf}`);
    };
    host.ctrl_sb_trace = (hdc, x, y, w, h, vert, pos, smin, smax, page) => {
      console.log(`[ctrl] sb ${vert ? 'vert' : 'horz'} hdc=0x${(hdc >>> 0).toString(16)}`
        + ` at ${x},${y} ${w}x${h}`
        + ` pos=${pos} range=${smin}..${smax} page=${page}`);
    };
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
      if (kind === 5) _noteDxPresent(slot);
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
        case 15: { // Device3 DrawPrimitive: slot=primType, a=FVF, b=count, c=lpvVerts(guest)
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
              const spec = hex(dv.getUint32(o + 20, true));
              out.push(`v${i}(${fx},${fy},${fz},rhw=${rhw}) col=${col} spec=${spec}`);
            }
            vs = '\n    ' + out.join('\n    ');
          } catch (e) { vs = ` <err: ${e.message}>`; }
          console.log(`[dx] DP3     primType=${slot} fvf=${hex(a)} count=${b} lpv=${hex(c)} caller=${hex(retAddr)}${vs}`);
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

  // Z-order clipping no longer needed — each window draws to its own offscreen canvas.
  // The compositor in repaint() handles overlap by blitting back-to-front.

  // DLL file check for dynamic LoadLibraryA — check VFS and browser-known DLLs.
  host.has_dll_file = (nameWA) => {
    const name = readStr(nameWA);
    const fileName = name.split('\\').pop().toLowerCase();
    if (ctx.vfs) {
      const tryPaths = [name.toLowerCase(), 'c:\\' + fileName, 'c:\\plugins\\' + fileName];
      for (const p of tryPaths) {
        if (ctx.vfs.files.has(p)) return 1;
      }
    }
    const available = ctx.availableDllFiles;
    if (available) {
      const lowerName = name.toLowerCase().replace(/\//g, '\\');
      if (typeof available.has === 'function') {
        if (available.has(fileName) || available.has(lowerName)) return 1;
      } else if (available[fileName] || available[lowerName]) {
        return 1;
      }
    }
    return 0;
  };

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
        if (name === 'has_dll_file') {
          console.log(`[host] has_dll_file("${readStr(args[0])}") => ${fmt(r)}`);
          return r;
        }
        console.log(`[host] ${_formatHostTrace(name, args, r) || `${name}(${args.map(fmt).join(', ')}) => ${fmt(r)}`}`);
        return r;
      };
    }
  }

  ctx.pumpAudioCompletions = _audioHost.pumpWaveOutCompletions;

  return { host, readStr, gdi: {
    regionPresentations: _regionPresentations,
    surfacePresentations: _gdiSurfacePresentations,
    pixelCache: _pixelCache,
    getClientOrigin: _getClientOrigin,
    presentBestDxOffscreen: _presentBestDxOffscreen,
    flushSurfacePresentation: id =>
      _flushGdiSurfacePresentation(_gdiSurfacePresentations.get(id >>> 0)),
  } };
}

if (typeof module !== 'undefined') module.exports = { createHostImports };
