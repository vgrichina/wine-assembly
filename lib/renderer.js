// Win98Renderer — shared between browser and Node (skia-canvas)
// Usage: new Win98Renderer(canvas) where canvas is either a DOM <canvas> or skia-canvas Canvas instance

function setNearestCanvasContext(ctx) {
  if (ctx && 'imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = false;
  return ctx;
}

function prepareNearestCanvas(canvas) {
  if (!canvas || !canvas.getContext || canvas._nearestCanvasWrapped) return canvas;
  const origGetContext = canvas.getContext.bind(canvas);
  canvas.getContext = (type, ...rest) => {
    const ctx = origGetContext(type, ...rest);
    return type === '2d' ? setNearestCanvasContext(ctx) : ctx;
  };
  canvas._nearestCanvasWrapped = true;
  return canvas;
}

class Win98Renderer {
  constructor(canvas) {
    this.canvas = prepareNearestCanvas(canvas);
    this.ctx = this.canvas.getContext('2d');
    // (no pre-parsed resource table — resource access goes through WAT
    //  exports: dlg_get_*, ctrl_get_*, rsrc_exists, rsrc_find_data_wa.)
    this.windows = {};
    this.inputQueue = [];
    this.mainWasm = null;
    this.mainWasmMemory = null;
    // Chrome dirty tracking moved to WAT NC_FLAGS (bit 0 = WM_NCPAINT).
    this._repaintScheduled = false;
    this._caretBlinkMs = 530;
    this._caretBlinkState = new WeakMap();
    this._caretBlinkActiveStates = new Set();
    this._caretBlinkTimer = null;
    this._nextZ = 1;
    this._isNode = (typeof window === 'undefined');
    this._exclusiveFullscreen = false;
    this._requestedBrowserFullscreen = false;
    this._exclusiveTransform = null;
    this._desktopSurfaceCanvas = null;
    this._wallpaperCanvas = null;
    this._wallpaperTiled = false;
    this._activeInputProfile = null;
    this._inputProfileSeq = 0;
    // Win98 color palette
    this.colors = {
      desktop: '#008080',
      btnFace: '#c0c0c0',
      btnHighlight: '#ffffff',
      btnShadow: '#808080',
      btnDkShadow: '#000000',
      btnLight: '#dfdfdf',
      titleActive: '#000080',
      titleGrad: '#1084d0',
      titleText: '#ffffff',
      windowBg: '#c0c0c0',
      windowText: '#000000',
      menuBg: '#c0c0c0',
      menuText: '#000000',
      highlight: '#000080',
      highlightText: '#ffffff',
    };

    this.font = '11px "Microsoft Sans Serif", "MS Sans Serif", Tahoma, Arial, sans-serif';
    this.fontBold = 'bold 11px "Microsoft Sans Serif", "MS Sans Serif", Tahoma, Arial, sans-serif';
    this.fontSmall = '8px "Microsoft Sans Serif", "MS Sans Serif", Tahoma, Arial, sans-serif';

    // Dialog unit conversion (approximate: 1 DLU ≈ 1.5px x, 1.75px y)
    this.dluX = 1.5;
    this.dluY = 1.75;

    // Offscreen canvas factory (works in browser and Node with skia-canvas)
    this._createOffscreen = (w, h) => {
      let cvs;
      if (typeof OffscreenCanvas !== 'undefined') cvs = new OffscreenCanvas(w, h);
      else try {
        const { Canvas } = require('skia-canvas');
        cvs = new Canvas(w, h);
        // skia-canvas defaults to a GPU surface (Metal on macOS) and it is
        // roughly 3x faster than the CPU backend (EmPipe: 12s vs 35s), so keep
        // it. WA_CANVAS_GPU=0 forces raster if a run ever needs to rule the GPU
        // path out.
        //
        // Note for anyone chasing memory: the GPU backend is NOT the reason
        // long runs grow. skia-canvas 3.0.8 leaks about 320 bytes of native,
        // unreclaimable memory per draw call, and a standalone repro shows the
        // growth is identical on GPU and CPU, and unaffected by exporting,
        // forced GC, or throwing the Canvas away and building a new one. The
        // lever that works is drawing less -- see --repaint-every in
        // test/run.js.
        if ('gpu' in cvs) cvs.gpu = process.env.WA_CANVAS_GPU !== '0';
      } catch (e) { return null; }
      const _probeFill = typeof process !== 'undefined' && process.env.PROBE_FILL;
      const _probeSR = typeof process !== 'undefined' && process.env.PROBE_SR;
      if (_probeFill && cvs) {
        const origGetContext = cvs.getContext.bind(cvs);
        cvs.getContext = (type, ...rest) => {
          const c = origGetContext(type, ...rest);
          if (type !== '2d' || c._wrapped) return c;
          c._wrapped = true;
          c._saveDepth = 0;
          c._tag = `cvs${w}x${h}#${Math.random().toString(36).slice(2,6)}`;
          const origSave = c.save.bind(c), origRestore = c.restore.bind(c), origClip = c.clip.bind(c);
          c.save = () => { c._saveDepth++; if (_probeSR) console.error(`[${c._tag}] save → ${c._saveDepth}  ${new Error().stack.split('\n')[2]}`); return origSave(); };
          c.restore = () => { c._saveDepth--; if (_probeSR) console.error(`[${c._tag}] restore → ${c._saveDepth}  ${new Error().stack.split('\n')[2]}`); return origRestore(); };
          c.clip = (...a) => { if (_probeSR) console.error(`[${c._tag}] clip depth=${c._saveDepth}  ${new Error().stack.split('\n')[2]}`); return origClip(...a); };
          return c;
        };
      }
      return prepareNearestCanvas(cvs);
    };
  }

  _profileEnabled() {
    return !this._isNode && typeof window !== 'undefined' && !!window.DEBUG_INPUT_PROFILE;
  }

  _profileNow() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  _profileInput(label, data, startTime) {
    if (!this._profileEnabled()) return null;
    const now = this._profileNow();
    const first = Number.isFinite(startTime) ? startTime : now;
    const profile = {
      id: ++this._inputProfileSeq,
      label,
      data: data || {},
      t0: first,
      marks: [{ name: 'browser-event', t: first, data: data || {} }],
    };
    this._activeInputProfile = profile;
    return profile;
  }

  _profileMark(name, data) {
    const profile = this._activeInputProfile;
    if (!profile || !this._profileEnabled()) return;
    profile.marks.push({ name, t: this._profileNow(), data: data || {} });
  }

  _profileFinish(name, data) {
    const profile = this._activeInputProfile;
    if (!profile || !this._profileEnabled()) return;
    this._profileMark(name || 'finish', data);
    const marks = profile.marks;
    const first = marks[0].t;
    const last = marks[marks.length - 1].t;
    profile.totalMs = last - first;
    profile.steps = [];
    for (let i = 1; i < marks.length; i++) {
      profile.steps.push({
        name: marks[i].name,
        dt: marks[i].t - marks[i - 1].t,
        at: marks[i].t - first,
        data: marks[i].data,
      });
    }
    if (!window.__inputPaintProfiles) window.__inputPaintProfiles = [];
    window.__inputPaintProfiles.push(profile);
    if (window.__inputPaintProfiles.length > 100) window.__inputPaintProfiles.shift();
    if (typeof window.updateInputProfileUI === 'function') window.updateInputProfileUI(profile);
    if (window.DEBUG_INPUT_PROFILE_LOG) {
      console.log('[input-profile]', profile.label, profile.totalMs.toFixed(2) + 'ms', profile);
    }
    this._activeInputProfile = null;
  }

  // --- Window management ---

  notifyShellWindow(code, hwnd) {
    const seen = new Set();
    for (const win of Object.values(this.windows)) {
      const wasm = win && (win.wasm || this.wasm);
      if (!wasm || seen.has(wasm)) continue;
      seen.add(wasm);
      const e = wasm.exports;
      if (!e || !e.notify_shell_window) continue;
      try { e.notify_shell_window(code | 0, hwnd | 0); } catch (_) {}
    }
  }

  createWindow(hwnd, style, x, y, cx, cy, title, menuId, wasm, wasmMemory) {
    const isTopLevel = !(style & 0x40000000); // not WS_CHILD
    const isOverlapped = !(style & 0xC0000000); // neither WS_POPUP nor WS_CHILD
    const useDefault = v => v === -2147483648 || v === 0x80000000;
    // Find parent: if WS_CHILD, the most recently created top-level window is the parent
    let parentHwnd = null;
    if (!isTopLevel) {
      for (const w of Object.values(this.windows)) {
        if (!(w.style & 0x40000000)) parentHwnd = w.hwnd;
      }
    }
    // CW_USEDEFAULT: only give default size to windows with visible chrome
    // (WS_CAPTION=0x00C00000, WS_BORDER=0x00800000, WS_THICKFRAME=0x00040000)
    const hasChrome = !!(style & 0x00C40000);
    let defX = 0, defY = 0, defW = 0, defH = 0;
    if (isOverlapped && hasChrome) {
      const cascade = this._cascadePos || 20;
      defX = cascade; defY = cascade;
      defW = 400; defH = 300;
      this._cascadePos = cascade + 24;
    }
    const win = {
      hwnd, style, title,
      x: Math.max(0, useDefault(x) ? defX : x),
      y: Math.max(0, useDefault(y) ? defY : (isTopLevel && y === 0 && useDefault(x) ? defY : y)),
      w: useDefault(cx) ? defW : (isTopLevel && cx === 0 && useDefault(x) ? defW : cx),
      h: useDefault(cy) ? defH : (isTopLevel && cy === 0 && useDefault(x) ? defH : cy),
      visible: !!(style & 0x10000000), // WS_VISIBLE
      isChild: !isTopLevel,
      parentHwnd,
      zOrder: this._nextZ++,
      wasm: wasm || this.wasm,
      wasmMemory: wasmMemory || this.wasmMemory,
    };

    // CreateWindowExA in WAT resolves the class lpszMenuName when the
    // explicit hMenu arg is 0, so menuId already reflects the class menu
    // (or 0 for apps like Winamp that have no class menu). menuId may be
    // an integer MAKEINTRESOURCE value OR a guest string pointer (named
    // menu, e.g. freecell). WAT's menu_load handles both via find_resource;
    // if no menu actually exists, menu_bar_count returns 0 and the layout
    // simply skips the menu strip. For WS_CHILD, hMenu is a control ID.
    if (menuId && !win.isChild) {
      win._menuId = menuId;
    }

    // Pre-compute clientRect so desktop fill clips correctly on first repaint
    this._computeClientRect(win);

    this.windows[hwnd] = win;
    if (win._menuId) this._setWatMenu(win);
    if (!win.isChild) this.notifyShellWindow(1, hwnd);
    return hwnd;
  }

  _windowOwnerHwnd(win) {
    if (!win || win.isChild) return 0;
    if (win.ownerHwnd) return win.ownerHwnd | 0;
    const wasm = win.wasm || this.wasm;
    const e = wasm && wasm.exports;
    if (!e || !e.wnd_get_owner) return 0;
    try {
      return e.wnd_get_owner(win.hwnd | 0) | 0;
    } catch (_) {
      return 0;
    }
  }

  // Bring an owner and all of its visible owned windows forward as one
  // z-order group. Win32 keeps floating palettes above their owner even when
  // focus moves back into the owner; Paint's Fonts bar relies on that rule.
  _raiseWindowGroup(win) {
    if (!win || win.isChild) return;
    let root = win;
    const ownerWalk = new Set();
    while (root && !ownerWalk.has(root.hwnd)) {
      ownerWalk.add(root.hwnd);
      const owner = this._windowOwnerHwnd(root);
      if (!owner || !this.windows[owner] || this.windows[owner].isChild) break;
      root = this.windows[owner];
    }

    const raised = new Set([root.hwnd]);
    root.zOrder = this._nextZ++;
    let added = true;
    while (added) {
      added = false;
      const owned = Object.values(this.windows)
        .filter(candidate => candidate && candidate.visible && !candidate.isChild &&
          !raised.has(candidate.hwnd) && raised.has(this._windowOwnerHwnd(candidate)))
        .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
      for (const candidate of owned) {
        candidate.zOrder = this._nextZ++;
        raised.add(candidate.hwnd);
        added = true;
      }
    }
  }

  // True iff WAT-side menu state has at least one bar item for this hwnd.
  // Replaces the legacy `win.menu` truthy check used as a "has menu bar"
  // layout flag — that field is going away once parseMenu is deleted, but
  // even before that the WAT blob is the source of truth (an app can call
  // SetMenu after createWindow).
  _hasMenuBar(win) {
    if (!win) return false;
    if (win.isChild) return false;
    if (!win._menuId) return false;
    const w = win.wasm || this.wasm;
    const e = w && w.exports;
    if (!e || !e.menu_bar_count) return false;
    // Lazily push the JS-side menu resource into WAT — _setWatMenu only
    // marks the slot pending until first paint/hit-test, so without this
    // bar_count returns 0 on the very first repaint and the layout drops
    // 18 px of menu height.
    this._ensureWatMenu(win);
    return (e.menu_bar_count(win.hwnd) | 0) > 0;
  }

  _hasCaption(win) {
    if (!win) return false;
    const style = win.style >>> 0;
    if ((style & 0x00C00000) === 0x00C00000) return true;
    return !win.isChild && !!(style & 0x00800000) && !!(style & 0x00080000);
  }

  _computeClientRect(win) {
    // Prefer WAT-owned absolute geometry. This keeps JS from reconstructing
    // nested child origins differently from the USER/GDI state machine.
    const e = (win.wasm || this.wasm) && (win.wasm || this.wasm).exports;
    if (e && e.wnd_client_screen_x && e.wnd_client_screen_y && e.get_client_rect_l && e.get_client_rect_r) {
      const l = e.get_client_rect_l(win.hwnd) | 0;
      const t = e.get_client_rect_t(win.hwnd) | 0;
      const r = e.get_client_rect_r(win.hwnd) | 0;
      const b = e.get_client_rect_b(win.hwnd) | 0;
      if (r > l && b > t) {
        let cw = r - l;
        if (String(win.className || '').toLowerCase() === 'toolbarwindow32' &&
            win.w > 0 && cw > win.w + 8) {
          cw = win.w;
        }
        win.clientRect = {
          x: e.wnd_client_screen_x(win.hwnd) | 0,
          y: e.wnd_client_screen_y(win.hwnd) | 0,
          w: cw,
          h: b - t,
        };
        return;
      }
    }
    // Bootstrap fallback: WAT stores window-local l/t/r/b; JS stores screen
    // coords, so add win.x/win.y until absolute exports are live.
    if (e && e.get_client_rect_l && e.get_client_rect_r) {
      const l = e.get_client_rect_l(win.hwnd) | 0;
      const t = e.get_client_rect_t(win.hwnd) | 0;
      const r = e.get_client_rect_r(win.hwnd) | 0;
      const b = e.get_client_rect_b(win.hwnd) | 0;
      if (r > l && b > t) {
        let cw = r - l;
        if (String(win.className || '').toLowerCase() === 'toolbarwindow32' &&
            win.w > 0 && cw > win.w + 8) {
          cw = win.w;
        }
        win.clientRect = { x: win.x + l, y: win.y + t, w: cw, h: b - t };
        return;
      }
    }
    // Pre-init fallback (same math WAT uses, kept for bootstrap before exports bind).
    const hasCaption = this._hasCaption(win);
    const hasBorder = hasCaption || !!(win.style & 0x00800000);
    const bw = hasBorder ? 3 : 0;
    let cy = win.y + bw;
    if (hasCaption) cy += 19;
    if (this._hasMenuBar(win)) cy += 18;
    const bot = hasBorder ? 4 : 0;
    win.clientRect = { x: win.x + bw, y: cy + (hasBorder ? 1 : 0), w: win.w - bw * 2, h: win.h - (cy + (hasBorder ? 1 : 0) - win.y) - bot };
  }

  _usesOwnWindowSurface(win) {
    return !!(win && win.isChild && win._canonicalOwnSurface);
  }

  _windowOriginForComposite(win) {
    const e = (win.wasm || this.wasm) && (win.wasm || this.wasm).exports;
    if (e && e.wnd_window_screen_x && e.wnd_window_screen_y) {
      try {
        return {
          x: e.wnd_window_screen_x(win.hwnd) | 0,
          y: e.wnd_window_screen_y(win.hwnd) | 0,
        };
      } catch (_) {}
    }
    if (win.isChild && win.parentHwnd) {
      const parent = this.windows[win.parentHwnd];
      if (parent) {
        this._computeClientRect(parent);
        const cr = parent.clientRect || parent;
        return { x: cr.x + win.x, y: cr.y + win.y };
      }
    }
    return { x: win.x, y: win.y };
  }

  _topLevelWindowFor(win) {
    let cur = win;
    let guard = 0;
    while (cur && cur.parentHwnd && this.windows[cur.parentHwnd] && guard++ < 64) {
      cur = this.windows[cur.parentHwnd];
    }
    return cur || win;
  }

  _clipRectForChildSurface(win) {
    const top = this._topLevelWindowFor(win);
    if (!top) return null;
    const pos = this._windowOriginForComposite(top);
    return {
      x: pos.x | 0,
      y: pos.y | 0,
      w: Math.max(0, top.w | 0),
      h: Math.max(0, top.h | 0),
    };
  }

  _transformClipRect(clipRect, transform) {
    if (!clipRect || !transform) return clipRect;
    const sx = transform.dstW / Math.max(1, transform.srcW);
    const sy = transform.dstH / Math.max(1, transform.srcH);
    return {
      x: transform.dstX + Math.floor((clipRect.x - transform.srcX) * sx),
      y: transform.dstY + Math.floor((clipRect.y - transform.srcY) * sy),
      w: Math.max(1, Math.floor(clipRect.w * sx)),
      h: Math.max(1, Math.floor(clipRect.h * sy)),
    };
  }

  _flushCanonicalCanvas(canvas) {
    if (!canvas || typeof canvas._waFlushCanonicalSurface !== 'function') return true;
    return canvas._waFlushCanonicalSurface(true) !== 0;
  }

  _drawImageClipped(canvas, x, y, w, h, clipRect) {
    if (!canvas) return;
    this._flushCanonicalCanvas(canvas);
    const ctx = this.ctx;
    if (!clipRect || clipRect.w <= 0 || clipRect.h <= 0) {
      if (w !== undefined && h !== undefined) ctx.drawImage(canvas, x, y, w, h);
      else ctx.drawImage(canvas, x, y);
      return;
    }
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(clipRect.x, clipRect.y, clipRect.w, clipRect.h);
      ctx.clip();
      if (w !== undefined && h !== undefined) ctx.drawImage(canvas, x, y, w, h);
      else ctx.drawImage(canvas, x, y);
    } finally {
      ctx.restore();
    }
  }

  _snapshotHasContent(canvas) {
    if (!canvas || !canvas.getContext) return false;
    const w = canvas.width | 0;
    const h = canvas.height | 0;
    if (w <= 0 || h <= 0) return false;
    let data;
    try { data = canvas.getContext('2d').getImageData(0, 0, w, h).data; }
    catch (_) { return false; }
    const stride = Math.max(4, Math.floor(data.length / 1024) & ~3);
    const colors = new Set();
    let content = 0;
    for (let i = 0; i < data.length; i += stride) {
      if (!data[i + 3]) continue;
      const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      colors.add(rgb);
      if (rgb !== 0xc0c0c0 && rgb !== 0xffffff && rgb !== 0x000000) content++;
    }
    return colors.size > 8 || content > 16;
  }

  _captureParentUnderChild(child) {
    if (!child || !child.isChild || !child.parentHwnd) return null;
    const parent = this.windows[child.parentHwnd];
    if (!parent || !parent._backCanvas) return null;
    const parentPos = this._windowOriginForComposite(parent);
    const childPos = this._windowOriginForComposite(child);
    let sx = childPos.x - parentPos.x;
    let sy = childPos.y - parentPos.y;
    let sw = child.w | 0;
    let sh = child.h | 0;
    if (sx < 0) { sw += sx; sx = 0; }
    if (sy < 0) { sh += sy; sy = 0; }
    sw = Math.min(sw, parent._backCanvas.width - sx);
    sh = Math.min(sh, parent._backCanvas.height - sy);
    if (sw <= 0 || sh <= 0) return null;
    const snapshot = this._createOffscreen(sw, sh);
    if (!snapshot) return null;
    const sc = snapshot.getContext('2d');
    this._flushCanonicalCanvas(parent._backCanvas);
    sc.drawImage(parent._backCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    if (!this._snapshotHasContent(snapshot)) return null;
    const record = {
      parentHwnd: parent.hwnd,
      x: sx,
      y: sy,
      w: sw,
      h: sh,
      canvas: snapshot,
    };
    child._parentSnapshot = record;
    return record;
  }

  restoreParentUnderChild(child) {
    if (child && !child._parentSnapshot) {
      const captured = this._captureParentUnderChild(child);
      const parentForCapture = captured && this.windows[captured.parentHwnd];
      if (parentForCapture) parentForCapture._lastChildRestoreSnapshot = captured;
    }
    const parentForFallback = child && child.parentHwnd ? this.windows[child.parentHwnd] : null;
    const snapshot = (child && child._parentSnapshot) ||
      (parentForFallback && parentForFallback._lastChildRestoreSnapshot);
    if (!snapshot) return false;
    const parent = this.windows[snapshot.parentHwnd];
    if (!parent || !parent._backCtx) return false;
    parent._backCtx.drawImage(snapshot.canvas, snapshot.x, snapshot.y);
    this.scheduleRepaint();
    return true;
  }

  rememberChildExposureSnapshot(parentHwnd, x, y, w, h) {
    const parent = this.windows[parentHwnd];
    if (!parent || !parent._backCanvas) return false;
    const parentPos = this._windowOriginForComposite(parent);
    const childPages = Object.values(this.windows)
      .filter(child => child && child.parentHwnd === parent.hwnd && child.isChild && child.isDialog);
    if (!childPages.length) return false;
    x |= 0; y |= 0; w |= 0; h |= 0;
    let overlapsChild = false;
    for (const child of childPages) {
      const childPos = this._windowOriginForComposite(child);
      const cx = childPos.x - parentPos.x;
      const cy = childPos.y - parentPos.y;
      if (x < cx + child.w && x + w > cx && y < cy + child.h && y + h > cy) {
        child._drawsIntoParent = true;
        overlapsChild = true;
      }
    }
    if (!overlapsChild) return false;
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    w = Math.min(w, parent._backCanvas.width - x);
    h = Math.min(h, parent._backCanvas.height - y);
    if (w <= 0 || h <= 0) return false;
    const snapshot = this._createOffscreen(w, h);
    if (!snapshot) return false;
    this._flushCanonicalCanvas(parent._backCanvas);
    snapshot.getContext('2d').drawImage(parent._backCanvas, x, y, w, h, 0, 0, w, h);
    if (!this._snapshotHasContent(snapshot)) return false;
    parent._lastChildRestoreSnapshot = {
      parentHwnd: parent.hwnd,
      x,
      y,
      w,
      h,
      canvas: snapshot,
    };
    return true;
  }

  _compositeChildSurfaces(parent, transform) {
    const children = Object.values(this.windows)
      .filter(child => child && child.visible && child.parentHwnd === parent.hwnd)
      .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
    const prevWasm = this.wasm;
    const prevMemory = this.wasmMemory;
    try {
      for (const child of children) {
        const ownSurface = this._usesOwnWindowSurface(child);
        this.wasm = child.wasm;
        this.wasmMemory = child.wasmMemory;
        if (ownSurface) {
          const clipRect = this._clipRectForChildSurface(child);
          this.drawWindow(child);
          if (child._parentSnapshot) {
            const parentPos = this._windowOriginForComposite(parent);
            const childPos = this._windowOriginForComposite(child);
            const expectedX = (childPos.x - parentPos.x) | 0;
            const expectedY = (childPos.y - parentPos.y) | 0;
            if (child._parentSnapshot.parentHwnd !== parent.hwnd ||
                Math.abs((child._parentSnapshot.x | 0) - expectedX) > 1 ||
                Math.abs((child._parentSnapshot.y | 0) - expectedY) > 1) {
              child._parentSnapshot = null;
              this._captureParentUnderChild(child);
            }
          }
          if (child._parentSnapshot && !child._drawsIntoParent) {
            const snapshot = child._parentSnapshot;
            const parentPos = this._windowOriginForComposite(parent);
            if (transform) {
              const sx = transform.dstW / Math.max(1, transform.srcW);
              const sy = transform.dstH / Math.max(1, transform.srcH);
              this._drawImageClipped(
                snapshot.canvas,
                transform.dstX + Math.floor((parentPos.x + snapshot.x - transform.srcX) * sx),
                transform.dstY + Math.floor((parentPos.y + snapshot.y - transform.srcY) * sy),
                Math.max(1, Math.floor(snapshot.w * sx)),
                Math.max(1, Math.floor(snapshot.h * sy)),
                this._transformClipRect(clipRect, transform)
              );
            } else {
              this._drawImageClipped(snapshot.canvas, parentPos.x + snapshot.x, parentPos.y + snapshot.y,
                undefined, undefined, clipRect);
            }
          }
          if (child._backCanvas) {
            const pos = this._windowOriginForComposite(child);
            if (transform) {
              const sx = transform.dstW / Math.max(1, transform.srcW);
              const sy = transform.dstH / Math.max(1, transform.srcH);
              const tClip = this._transformClipRect(clipRect, transform);
              this._drawImageClipped(
                child._backCanvas,
                transform.dstX + Math.floor((pos.x - transform.srcX) * sx),
                transform.dstY + Math.floor((pos.y - transform.srcY) * sy),
                Math.max(1, Math.floor(child._backCanvas.width * sx)),
                Math.max(1, Math.floor(child._backCanvas.height * sy)),
                tClip
              );
              if (child._dxFrameLayer && child._dxFrameLayer.canvas) {
                this._drawImageClipped(
                  child._dxFrameLayer.canvas,
                  transform.dstX + Math.floor((pos.x - transform.srcX) * sx),
                  transform.dstY + Math.floor((pos.y - transform.srcY) * sy),
                  Math.max(1, Math.floor(child._dxFrameLayer.canvas.width * sx)),
                  Math.max(1, Math.floor(child._dxFrameLayer.canvas.height * sy)),
                  tClip
                );
              }
            } else {
              this._drawImageClipped(child._backCanvas, pos.x, pos.y,
                undefined, undefined, clipRect);
              if (child._dxFrameLayer && child._dxFrameLayer.canvas) {
                this._drawImageClipped(child._dxFrameLayer.canvas, pos.x, pos.y,
                  undefined, undefined, clipRect);
              }
            }
          }
        }
        // Own-surface grandchildren can sit under non-own container windows
        // such as MFC AfxControlBar42. Their positions are resolved in screen
        // coordinates, so recurse through every visible child, not only direct
        // own-surface children.
        this._compositeChildSurfaces(child, transform);
      }
    } finally {
      this.wasm = prevWasm;
      this.wasmMemory = prevMemory;
    }
  }

  _syncWindowStyle(win) {
    const e = (win.wasm || this.wasm) && (win.wasm || this.wasm).exports;
    if (!e || !e.wnd_get_style_export) return;
    const style = e.wnd_get_style_export(win.hwnd) >>> 0;
    if (style && style !== (win.style >>> 0)) {
      win.style = style;
      this._computeClientRect(win);
    }
  }

  _isExclusiveFullscreenWindow(win) {
    if (!win || win.isChild || !win.visible || win.w <= 0 || win.h <= 0) return false;
    const hasCaption = this._hasCaption(win);
    if (hasCaption || this._hasMenuBar(win)) return false;
    if (win.x > 24 || win.y > 4) return false;
    if (win.w < 600 || win.h < 440) return false;
    return (win.w < this.canvas.width || win.h < this.canvas.height ||
            (win.w >= this.canvas.width * 0.75 && win.h >= this.canvas.height * 0.75));
  }

  _setExclusiveFullscreen(active) {
    active = !!active;
    if (this._exclusiveFullscreen === active) return;
    this._exclusiveFullscreen = active;
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('exclusive-fullscreen', active);
      const target = document.getElementById('screen-wrap') || this.canvas;
      const resize = (typeof window !== 'undefined' && typeof window.resizeCanvas === 'function')
        ? window.resizeCanvas
        : null;
      if (active) {
        if (resize) resize();
      } else if (this._requestedBrowserFullscreen &&
                 (document.fullscreenElement || document.webkitFullscreenElement) === target &&
                 (document.exitFullscreen || document.webkitExitFullscreen)) {
        this._requestedBrowserFullscreen = false;
        try {
          const exit = document.exitFullscreen || document.webkitExitFullscreen;
          const p = exit.call(document);
          if (p && p.then) p.then(() => { if (resize) resize(); }).catch(() => {});
        } catch (_) {}
      } else {
        this._requestedBrowserFullscreen = false;
        if (resize) resize();
      }
    }
  }

  mapCanvasPoint(x, y) {
    const t = this._exclusiveTransform;
    if (!t) return { x, y };
    return {
      x: Math.floor(t.srcX + (x - t.dstX) * t.srcW / Math.max(1, t.dstW)),
      y: Math.floor(t.srcY + (y - t.dstY) * t.srcH / Math.max(1, t.dstH)),
    };
  }

  // Get or create the per-window offscreen canvas for GDI drawing.
  // Sized to full window (not just client area) so both GetDC and
  // GetWindowDC drawing land on the same surface. Client DC drawing
  // is offset by chrome margins; whole-window DC drawing starts at (0,0).
  getWindowCanvas(hwnd) {
    const win = this.windows[hwnd];
    if (!win) return null;
    this._computeClientRect(win);
    const w = Math.max(1, win.w);
    const h = Math.max(1, win.h);
    if (!win._backCanvas || win._backW !== w || win._backH !== h) {
      win._backCanvas = this._createOffscreen(w, h);
      win._backCtx = win._backCanvas.getContext('2d');
      win._backW = w;
      win._backH = h;
      if (this._usesOwnWindowSurface(win)) {
        win._backCtx.clearRect(0, 0, w, h);
      } else {
        const borderlessTopLevel = !win.isChild && !this._hasCaption(win) && !this._hasMenuBar(win);
        const nearScreen = win.x <= 24 && win.y <= 4 && win.w >= 600 && win.h >= 440;
        // Normal controls/dialogs need COLOR_3DFACE as their untouched backing
        // color. Borderless screen-sized windows, including screensavers, need
        // black so guest areas not redrawn on every frame do not expose desktop
        // gray inside the fullscreen composition.
        win._backCtx.fillStyle = (borderlessTopLevel && nearScreen) ? '#000000' : '#c0c0c0';
        win._backCtx.fillRect(0, 0, w, h);
      }
      if (typeof process !== 'undefined' && process.env && process.env.BBOX_TRAP) {
        // Instrument this back-canvas so any fillRect/drawImage/clearRect/
        // putImageData/fill/stroke/fillText call touching the trap bbox
        // (TRAP_X0,TRAP_Y0)-(TRAP_X1,TRAP_Y1) in canvas-local coords logs a
        // stack trace. Lets us find which draw path is wiping the Colors /
        // Tools palettes without instrumenting 63 separate call sites.
        const bbox = {
          x0: parseInt(process.env.TRAP_X0 || '40'),
          y0: parseInt(process.env.TRAP_Y0 || '335'),
          x1: parseInt(process.env.TRAP_X1 || '285'),
          y1: parseInt(process.env.TRAP_Y1 || '378'),
        };
        const ctx = win._backCtx;
        const hits = (x, y, rw, rh) => {
          return (x < bbox.x1 && x + rw > bbox.x0 && y < bbox.y1 && y + rh > bbox.y0);
        };
        const tag = (name, x, y, rw, rh) => {
          const st = new Error('trap').stack.split('\n').slice(2, 6).map(s => s.trim()).join(' ← ');
          console.warn(`[TRAP] hwnd=0x${hwnd.toString(16)} ${name} (${x},${y})+${rw}x${rh} ${st}`);
        };
        const wrap = (name, orig, extract) => function(...args) {
          const r = extract(args);
          if (r && hits(r.x, r.y, r.w, r.h)) tag(name, r.x, r.y, r.w, r.h);
          return orig.apply(this, args);
        };
        ctx.fillRect   = wrap('fillRect',   ctx.fillRect.bind(ctx),   a => ({ x: a[0], y: a[1], w: a[2], h: a[3] }));
        ctx.clearRect  = wrap('clearRect',  ctx.clearRect.bind(ctx),  a => ({ x: a[0], y: a[1], w: a[2], h: a[3] }));
        ctx.strokeRect = wrap('strokeRect', ctx.strokeRect.bind(ctx), a => ({ x: a[0], y: a[1], w: a[2], h: a[3] }));
        ctx.drawImage  = wrap('drawImage',  ctx.drawImage.bind(ctx),  a => {
          // sig: (img, dx, dy) | (img, dx, dy, dw, dh) | (img, sx, sy, sw, sh, dx, dy, dw, dh)
          if (a.length === 3) return { x: a[1], y: a[2], w: a[0].width, h: a[0].height };
          if (a.length === 5) return { x: a[1], y: a[2], w: a[3], h: a[4] };
          if (a.length === 9) return { x: a[5], y: a[6], w: a[7], h: a[8] };
          return null;
        });
        ctx.putImageData = wrap('putImageData', ctx.putImageData.bind(ctx), a => ({ x: a[1], y: a[2], w: a[0].width, h: a[0].height }));
      }
    }
    return { canvas: win._backCanvas, ctx: win._backCtx };
  }

  // Associate a canonical WAT surface's derived offscreen presentation with
  // a window. repaint() remains a pure compositor from this canvas into the
  // desktop canvas; no GDI operation renders directly into the desktop.
  attachWindowSurface(hwnd, canvas) {
    const win = this.windows[hwnd];
    if (!win || !canvas) return false;
    win._backCanvas = canvas;
    win._backCtx = canvas.getContext('2d');
    win._backW = canvas.width | 0;
    win._backH = canvas.height | 0;
    win._canonicalOwnSurface = !!win.isChild;
    return true;
  }

  detachWindowSurface(hwnd, canvas) {
    const win = this.windows[hwnd];
    if (!win || win._backCanvas !== canvas) return false;
    win._backCanvas = null;
    win._backCtx = null;
    win._backW = 0;
    win._backH = 0;
    win._canonicalOwnSurface = false;
    return true;
  }

  attachMenuOverlaySurface(canvas) {
    if (!canvas) return false;
    this._dropdownOverlay = { canvas, ctx: canvas.getContext('2d') };
    return true;
  }

  detachMenuOverlaySurface(canvas) {
    if (!this._dropdownOverlay || this._dropdownOverlay.canvas !== canvas) return false;
    this._dropdownOverlay = null;
    return true;
  }

  attachDesktopSurface(canvas) {
    if (!canvas) return false;
    this._desktopSurfaceCanvas = canvas;
    if (this._wallpaperCanvas) {
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (ctx) this._paintWallpaper(ctx, canvas.width, canvas.height);
    }
    return true;
  }

  detachDesktopSurface(canvas) {
    if (this._desktopSurfaceCanvas !== canvas) return false;
    this._desktopSurfaceCanvas = null;
    return true;
  }

  _canonicalPresentation(canvas) {
    const presentation = canvas && canvas._waCanonicalPresentation;
    if (!presentation || !presentation.surface || presentation.targetDesktop) return null;
    return presentation;
  }

  _canonicalScreenSignature() {
    const parts = [this.canvas.width | 0, this.canvas.height | 0,
      this._wallpaperVersion | 0, this._wallpaperTiled ? 1 : 0];
    const windows = Object.values(this.windows || {})
      .filter(win => win && win.visible && win.w > 0 && win.h > 0)
      .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
    const addPresentation = canvas => {
      const p = this._canonicalPresentation(canvas);
      parts.push(p ? `${p.serial || 0}:${p.version || 0}` : '0');
    };
    for (const win of windows) {
      const pos = this._windowOriginForComposite(win);
      parts.push(win.hwnd | 0, pos.x | 0, pos.y | 0, win.w | 0, win.h | 0,
        win.zOrder | 0, win.isChild ? 1 : 0, win.parentHwnd | 0);
      addPresentation(win._backCanvas);
      addPresentation(win._dxFrameLayer && win._dxFrameLayer.canvas);
      if (win.region && Array.isArray(win.region.rects)) {
        for (const r of win.region.rects) {
          parts.push(r.x | 0, r.y | 0, r.w | 0, r.h | 0);
        }
      }
    }
    const overlay = this._dropdownOverlay;
    const state = this._dropdownOverlayPaintState;
    addPresentation(overlay && overlay.canvas);
    if (state && Array.isArray(state.rects)) {
      for (const r of state.rects) parts.push(r.x | 0, r.y | 0, r.w | 0, r.h | 0);
    }
    return parts.join(',');
  }

  _copyCanonicalCanvasToMemory(canvas, dest, destOffset, destWidth, destHeight,
    destStride, destX, destY, clipRect) {
    const presentation = this._canonicalPresentation(canvas);
    if (!presentation) return false;
    const surface = presentation.surface;
    let left = Math.max(0, destX | 0);
    let top = Math.max(0, destY | 0);
    let right = Math.min(destWidth, (destX + surface.width) | 0);
    let bottom = Math.min(destHeight, (destY + surface.height) | 0);
    if (clipRect) {
      left = Math.max(left, clipRect.x | 0);
      top = Math.max(top, clipRect.y | 0);
      right = Math.min(right, (clipRect.x + clipRect.w) | 0);
      bottom = Math.min(bottom, (clipRect.y + clipRect.h) | 0);
    }
    if (right <= left || bottom <= top) return true;
    const srcX = left - destX;
    const srcY = top - destY;
    const copyWidth = right - left;
    const copyHeight = bottom - top;
    const storage = surface.storage;
    const storageOffset = surface.storageOffset | 0;

    // Canonical GDI window surfaces and most modern DirectDraw frames use
    // BGRA32. Copy complete runs between WASM memories without conversion.
    if (surface.bpp === 32 && (surface.stride & 3) === 0 && (destStride & 3) === 0 &&
        (storageOffset & 3) === 0 && (destOffset & 3) === 0) {
      const src32 = new Uint32Array(storage.buffer, storageOffset,
        (surface.stride * surface.height) >>> 2);
      const dst32 = new Uint32Array(dest.buffer, destOffset,
        (destStride * destHeight) >>> 2);
      const srcStride32 = surface.stride >>> 2;
      const dstStride32 = destStride >>> 2;
      for (let row = 0; row < copyHeight; row++) {
        const logicalY = srcY + row;
        const storedY = surface.topDown ? logicalY : surface.height - 1 - logicalY;
        const source = storedY * srcStride32 + srcX;
        const target = (top + row) * dstStride32 + left;
        dst32.set(src32.subarray(source, source + copyWidth), target);
      }
      return true;
    }

    // Screen capture is an uncommon path. Preserve indexed and 16/24-bit
    // DirectDraw correctness through the canonical decoder rather than adding
    // format-specific Canvas readback paths.
    if (typeof presentation.refreshPalette === 'function') presentation.refreshPalette();
    const rgba = surface.rgbaRect(srcX, srcY, copyWidth, copyHeight);
    for (let row = 0; row < copyHeight; row++) {
      let source = row * copyWidth * 4;
      let target = destOffset + (top + row) * destStride + left * 4;
      for (let col = 0; col < copyWidth; col++) {
        dest[target++] = rgba[source + 2];
        dest[target++] = rgba[source + 1];
        dest[target++] = rgba[source];
        dest[target++] = 0;
        source += 4;
      }
    }
    return true;
  }

  composeCanonicalScreenToMemory(dest, destOffset, width, height, stride) {
    width |= 0; height |= 0; stride |= 0; destOffset >>>= 0;
    if (!dest || width <= 0 || height <= 0 || stride < width * 4 ||
        destOffset + stride * height > dest.length) return false;
    if (!this._canonicalScreenReadbackCache) this._canonicalScreenReadbackCache = new WeakMap();
    const signature = this._canonicalScreenSignature();
    let cache = this._canonicalScreenReadbackCache.get(dest.buffer);
    if (!cache) {
      cache = new Map();
      this._canonicalScreenReadbackCache.set(dest.buffer, cache);
    }
    const cacheKey = `${destOffset}:${width}:${height}:${stride}`;
    if (cache.get(cacheKey) === signature) return true;

    // COLOR_DESKTOP is RGB(0,128,128), represented as little-endian BGRA32.
    for (let y = 0; y < height; y++) {
      new Uint32Array(dest.buffer, destOffset + y * stride, width).fill(0x00008080);
    }
    if (this._wallpaperDib && this._wallpaperDib.pixels) {
      const dib = this._wallpaperDib;
      const drawWallpaper = (x, y) => {
        const right = Math.min(width, x + dib.w);
        const bottom = Math.min(height, y + dib.h);
        for (let dy = Math.max(0, y); dy < bottom; dy++) {
          let source = ((dy - y) * dib.w + Math.max(0, -x)) * 4;
          let target = destOffset + dy * stride + Math.max(0, x) * 4;
          for (let dx = Math.max(0, x); dx < right; dx++) {
            dest[target++] = dib.pixels[source + 2];
            dest[target++] = dib.pixels[source + 1];
            dest[target++] = dib.pixels[source];
            dest[target++] = 0;
            source += 4;
          }
        }
      };
      if (this._wallpaperTiled) {
        for (let y = 0; y < height; y += dib.h) {
          for (let x = 0; x < width; x += dib.w) drawWallpaper(x, y);
        }
      } else {
        drawWallpaper(Math.floor((width - dib.w) / 2), Math.floor((height - dib.h) / 2));
      }
    }

    const addLayer = (canvas, x, y, clipRect) =>
      this._copyCanonicalCanvasToMemory(canvas, dest, destOffset, width, height,
        stride, x, y, clipRect);
    const visibleTopLevel = Object.values(this.windows || {})
      .filter(win => win && win.visible && !win.isChild && win.w > 0 && win.h > 0)
      .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
    const addChildren = parent => {
      const children = Object.values(this.windows || {})
        .filter(child => child && child.visible && child.parentHwnd === parent.hwnd)
        .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
      for (const child of children) {
        if (this._usesOwnWindowSurface(child)) {
          const pos = this._windowOriginForComposite(child);
          const clip = this._clipRectForChildSurface(child);
          addLayer(child._backCanvas, pos.x, pos.y, clip);
          if (child._dxFrameLayer) addLayer(child._dxFrameLayer.canvas, pos.x, pos.y, clip);
        }
        addChildren(child);
      }
    };
    for (const win of visibleTopLevel) {
      const pos = this._windowOriginForComposite(win);
      const regionRects = win.region && Array.isArray(win.region.rects) && win.region.rects.length
        ? win.region.rects : null;
      if (regionRects) {
        for (const r of regionRects) {
          addLayer(win._backCanvas, pos.x, pos.y,
            { x: pos.x + r.x, y: pos.y + r.y, w: r.w, h: r.h });
          if (win._dxFrameLayer) {
            addLayer(win._dxFrameLayer.canvas, pos.x, pos.y,
              { x: pos.x + r.x, y: pos.y + r.y, w: r.w, h: r.h });
          }
        }
      } else {
        addLayer(win._backCanvas, pos.x, pos.y, null);
        if (win._dxFrameLayer) addLayer(win._dxFrameLayer.canvas, pos.x, pos.y, null);
      }
      addChildren(win);
    }

    const overlay = this._dropdownOverlay;
    const state = this._dropdownOverlayPaintState;
    if (overlay && state && Array.isArray(state.rects)) {
      for (const r of state.rects) addLayer(overlay.canvas, 0, 0, r);
    }
    cache.set(cacheKey, signature);
    return true;
  }

  setDesktopWallpaper(dib, tiled) {
    const width = dib && dib.w | 0;
    const height = dib && dib.h | 0;
    if (width <= 0 || height <= 0 || !dib.pixels || dib.pixels.length < width * height * 4) {
      return false;
    }
    let canvas = null;
    if (typeof document !== 'undefined' && document.createElement) {
      canvas = prepareNearestCanvas(document.createElement('canvas'));
      canvas.width = width;
      canvas.height = height;
    } else {
      canvas = this._createOffscreen(width, height);
    }
    if (!canvas) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.createImageData !== 'function') return false;
    const image = ctx.createImageData(width, height);
    image.data.set(dib.pixels.subarray(0, width * height * 4));
    ctx.putImageData(image, 0, 0);
    this._wallpaperCanvas = canvas;
    this._wallpaperDib = dib;
    this._wallpaperVersion = ((this._wallpaperVersion | 0) + 1) | 0;
    this._wallpaperTiled = !!tiled;

    // A canonical desktop DC is an opaque presentation canvas and therefore
    // wins over the standalone wallpaper branch in _repaintOnce. Seed that
    // presentation with the new wallpaper so desktop GDI writes can continue
    // to overlay it without hiding the background behind stale teal pixels.
    const desktop = this._desktopSurfaceCanvas;
    if (desktop && desktop.getContext) {
      const desktopCtx = desktop.getContext('2d');
      if (desktopCtx) this._paintWallpaper(desktopCtx, desktop.width, desktop.height);
    }

    // In browser desktop mode the emulator canvas stays transparent so the
    // HTML icon layer remains visible. Put the wallpaper on its parent layer.
    const parent = this.canvas && this.canvas.parentElement;
    if (this.transparentDesktop && parent && parent.style &&
        typeof canvas.toDataURL === 'function') {
      parent.style.backgroundColor = this.colors.desktop;
      parent.style.backgroundImage = `url("${canvas.toDataURL('image/png')}")`;
      parent.style.backgroundRepeat = this._wallpaperTiled ? 'repeat' : 'no-repeat';
      parent.style.backgroundPosition = this._wallpaperTiled ? 'left top' : 'center center';
      parent.style.backgroundSize = 'auto';
    }
    this.repaint();
    return true;
  }

  _paintWallpaper(ctx, targetWidth = this.canvas.width, targetHeight = this.canvas.height) {
    const wallpaper = this._wallpaperCanvas;
    if (!wallpaper) return false;
    ctx.fillStyle = this.colors.desktop;
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.imageSmoothingEnabled = false;
    if (!this._wallpaperTiled) {
      ctx.drawImage(wallpaper,
        Math.floor((targetWidth - wallpaper.width) / 2),
        Math.floor((targetHeight - wallpaper.height) / 2));
      return true;
    }
    const pattern = typeof ctx.createPattern === 'function'
      ? ctx.createPattern(wallpaper, 'repeat') : null;
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, targetWidth, targetHeight);
      return true;
    }
    for (let y = 0; y < targetHeight; y += wallpaper.height) {
      for (let x = 0; x < targetWidth; x += wallpaper.width) {
        ctx.drawImage(wallpaper, x, y);
      }
    }
    return true;
  }

  // Build a dialog's JS-side window state. All template fields come from
  // WAT exports (dlg_* / ctrl_*) — there is no JS-side RT_DIALOG parser.
  // WAT's $dlg_load has already allocated the child HWNDs, filled
  // CONTROL_TABLE + CONTROL_GEOM, and sent WM_CREATE, so this function
  // just mirrors that state into renderer.windows[hwnd].
  createDialog(hwnd, parentHwnd, wasm, wasmMemory) {
    const e = (wasm && wasm.exports) || (this.wasm && this.wasm.exports);
    const mem = (wasmMemory) || (this.wasmMemory);
    if (!e || !e.dlg_get_style) return hwnd;

    const style = e.dlg_get_style(hwnd) >>> 0;
    const dlgX = e.dlg_get_x(hwnd);
    const dlgY = e.dlg_get_y(hwnd);
    const dlgCx = e.dlg_get_cx(hwnd);
    const dlgCy = e.dlg_get_cy(hwnd);
    // dlg_get_title_wa returns a WASM linear address (already run through
    // $g2w in WAT), so we read the ASCII bytes directly.
    const titleWa = e.dlg_get_title_wa(hwnd);
    let title = '';
    if (titleWa) {
      const u8 = new Uint8Array(mem.buffer);
      for (let i = 0; i < 256 && u8[titleWa + i]; i++) title += String.fromCharCode(u8[titleWa + i]);
    }

    const isChild = !!(parentHwnd && this.windows[parentHwnd] && (style & 0x40000000));
    const menuKey = e.dlg_get_menu(hwnd);
    const clientW = Math.round(dlgCx * this.dluX);
    const clientH = Math.round(dlgCy * this.dluY);
    let x = dlgX === -32768 ? 40 : Math.round(dlgX * this.dluX);
    let y = Math.round(Math.max(0, dlgY) * this.dluY);
    let w = isChild ? clientW : clientW + 8;
    let h = isChild ? clientH : clientH + 30 + (menuKey ? 18 : 0);
    if (isChild && e.ctrl_get_xy && e.ctrl_get_wh) {
      const xy = e.ctrl_get_xy(hwnd) | 0;
      const wh = e.ctrl_get_wh(hwnd) >>> 0;
      x = (xy << 16) >> 16;
      y = xy >> 16;
      w = wh & 0xFFFF;
      h = (wh >>> 16) & 0xFFFF;
    }
    // MFC centers owned modal resource dialogs whose template leaves the
    // origin at (0,0). They may not issue a later SetWindowPos (Paint's
    // Attributes dialog is one), so establish the USER-visible placement as
    // part of mirroring the loaded template. Keep the full frame on-screen
    // when the owner is narrower or close to a desktop edge.
    const owner = !isChild && parentHwnd ? this.windows[parentHwnd] : null;
    const modalTemplateAtOrigin = owner && (style & 0x00000080) && dlgX === 0 && dlgY === 0;
    if (modalTemplateAtOrigin) {
      x = Math.round(owner.x + (owner.w - w) / 2);
      y = Math.round(owner.y + (owner.h - h) / 2);
      x = Math.max(0, Math.min(Math.max(0, this.canvas.width - w), x));
      y = Math.max(0, Math.min(Math.max(0, this.canvas.height - h), y));
    }
    const templateW = w;
    const templateH = h;
    const win = {
      hwnd,
      style,
      title,
      x,
      y,
      w,
      h,
      _templateW: templateW,
      _templateH: templateH,
      visible: !!(style & 0x10000000),
      isChild,
      parentHwnd: isChild ? parentHwnd : 0,
      ownerHwnd: !isChild ? (parentHwnd || 0) : 0,
      isDialog: true,
      zOrder: this._nextZ++,
      wasm: wasm || this.wasm,
      wasmMemory: mem || this.wasmMemory,
    };

    // Menu field: int id or a guest ASCII ptr from the template's menu
    // OrdOrString. 0 = no menu. The WAT menu loader drives actual
    // rendering via _setWatMenu.
    if (menuKey) {
      win._menuId = menuKey;
      this._setWatMenu(win);
    }

    this.windows[hwnd] = win;
    this._computeClientRect(win);
    if (win.isChild && win.isDialog) {
      this._captureParentUnderChild(win);
      this.restoreParentUnderChild(win);
    }
    if (!win.isChild && win.visible) this.notifyShellWindow(1, hwnd);
    return hwnd;
  }

  showWindow(hwnd, cmd) {
    const win = this.windows[hwnd];
    if (!win) return;
    const wasVisible = !!win.visible;
    if ((cmd === 6 || cmd === 7) && !win.isChild) { // SW_MINIMIZE / SW_SHOWMINNOACTIVE
      if (!win._minimized) {
        win._minimizeRestoreRect = { x: win.x, y: win.y, w: win.w, h: win.h };
      }
      win.visible = false;
      win._minimized = true;
      this.invalidate(hwnd);
      this.scheduleRepaint();
      return;
    }
    win.visible = (cmd !== 0);
    if (win.visible && win._minimized) {
      if (win._minimizeRestoreRect) Object.assign(win, win._minimizeRestoreRect);
      win._minimized = false;
    }
    if (wasVisible && !win.visible && win.isChild && win.parentHwnd) {
      this.restoreParentUnderChild(win);
      let root = this.windows[win.parentHwnd];
      while (root && root.isChild && this.windows[root.parentHwnd]) {
        root = this.windows[root.parentHwnd];
      }
      if (root) this.invalidateVisibleTree(root.hwnd);
      this.scheduleRepaint();
      return;
    }
    if (cmd === 3 && !win.isChild) {
      if (!win._maximized) {
        const validRestore =
          Number.isFinite(win.x) && Number.isFinite(win.y) &&
          Number.isFinite(win.w) && Number.isFinite(win.h) &&
          win.w > 0 && win.h > 0 &&
          win.x > -1000000 && win.y > -1000000;
        win._restoreRect = validRestore
          ? { x: win.x, y: win.y, w: win.w, h: win.h }
          : {
              x: 20,
              y: 20,
              w: Math.min(640, Math.max(160, this.canvas.width - 40)),
              h: Math.min(480, Math.max(120, this.canvas.height - 40)),
            };
      }
      win._maximized = true;
      win.x = 0; win.y = 0;
      win.w = this.canvas.width;
      win.h = this.canvas.height;
      this._computeClientRect(win);
    }
    if (win.visible) {
      this._raiseWindowGroup(win);
      if (!win.isChild && this._setKeyboardInputOwner) this._setKeyboardInputOwner(win);
      this.invalidate(hwnd);
      if (!wasVisible && !win.isChild) this.notifyShellWindow(1, hwnd);
    }
  }

  handleScreenResize(oldW, oldH, newW, newH) {
    if (!newW || !newH || (oldW === newW && oldH === newH)) return;
    const we = this.wasm && this.wasm.exports;
    for (const win of Object.values(this.windows || {})) {
      if (!win || !win.visible || win.isChild) continue;
      const watMax = we && we.wnd_is_maximized ? !!we.wnd_is_maximized(win.hwnd) : false;
      const filledOldScreen =
        win.x === 0 && win.y === 0 &&
        (win.w === oldW || win.w === newW) &&
        (win.h === oldH || win.h === newH);
      if (!win._maximized && !watMax && !filledOldScreen) continue;
      win._maximized = true;
      win.x = 0; win.y = 0;
      win.w = newW | 0;
      win.h = newH | 0;
      if (we && we.host_resize_commit) {
        we.host_resize_commit(win.hwnd, win.x, win.y, win.w, win.h);
      }
      this._computeClientRect(win);
      this.invalidate(win.hwnd);
    }
  }

  setWindowClass(hwnd, className) {
    const win = this.windows[hwnd];
    if (win) win.className = className;
  }

  setMenu(hwnd, menuResId) {
    const win = this.windows[hwnd];
    if (!win) return;
    const w = win.wasm || this.wasm;
    const we = w && w.exports;
    if (we && we.rsrc_exists) {
      win._menuId = we.rsrc_exists(4, menuResId >>> 0) ? menuResId : 0;
      this._setWatMenu(win);
      this._computeClientRect(win);
      this.invalidate(hwnd);
    }
  }

  setWindowText(hwnd, text) {
    const win = this.windows[hwnd];
    if (win) {
      // RichEdit 2.0's 32767-twip empty-document sentinel reaches WordPad as
      // the literal point-size text "1638.5". Restrict the compatibility
      // default to WordPad's size combo id so arbitrary app text is untouched.
      const w = win.wasm || this.wasm;
      const e = w && w.exports;
      if (text === '1638.5' && e && e.ctrl_get_id && (e.ctrl_get_id(hwnd) | 0) === 166) text = '10';
      win.title = text;
      this.invalidate(hwnd);
    }
  }

  invalidate(hwnd) {
    // Mark chrome dirty in WAT — the next message-loop turn will deliver
    // WM_NCPAINT to the wndproc, which calls DefWindowProc to redraw chrome
    // into the back-canvas. repaint() is pure composite after this point.
    const w = (this.windows[hwnd] && this.windows[hwnd].wasm) || this.wasm;
    const e = w && w.exports;
    if (e && e.nc_post_paint) e.nc_post_paint(hwnd);
    this.scheduleRepaint();
  }

  // Get list of rects from windows above the given hwnd (for z-order clipping)
  // NOTE: No longer used for GDI clipping (per-window canvases handle that).
  // Kept for any external callers.
  getOccludingRects(hwnd) {
    const win = this.windows[hwnd];
    if (!win) return [];
    const myZ = win.zOrder || 0;
    const rects = [];
    for (const w of Object.values(this.windows)) {
      if (w === win || !w.visible || w.isChild) continue;
      if ((w.zOrder || 0) > myZ) {
        rects.push({ x: w.x, y: w.y, w: w.w, h: w.h });
      }
    }
    return rects;
  }

  // Queue WM_PAINT so the app repaints its client area (e.g. after menu closes)
  queuePaint(hwnd) {
    this.inputQueue.push({ type: 'paint', hwnd, msg: 0x000F, wParam: 0, lParam: 0 });
  }

  // Child windows share their top-level ancestor's backing surface. A parent
  // WM_PAINT can therefore cover any visible branch after a nested child is
  // hidden. Queue the whole visible hierarchy afterward, parent before child
  // and in compositor order, to model Win32's clipped child repaint pass.
  queueVisibleDescendantPaints(parentHwnd) {
    const queueChildren = hwnd => {
      const children = Object.values(this.windows)
        .filter(child => child && child.isChild &&
          child.parentHwnd === hwnd && child.visible &&
          child.w > 0 && child.h > 0)
        .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
      for (const child of children) {
        this.queuePaint(child.hwnd);
        queueChildren(child.hwnd);
      }
    };
    queueChildren(parentHwnd);
  }

  invalidateVisibleTree(rootHwnd) {
    const root = this.windows[rootHwnd];
    const w = root && (root.wasm || this.wasm);
    const e = w && w.exports;
    if (e && e.paint_invalidate_visible_tree) {
      e.paint_invalidate_visible_tree(rootHwnd);
      return;
    }
    this.queuePaint(rootHwnd);
    this.queueVisibleDescendantPaints(rootHwnd);
  }

  closeMenu() {
    const menu = this._openMenuContext ? this._openMenuContext() : null;
    if (!menu) { this._menuMode = false; return; }
    const e = menu.exports;
    const wh = menu.hwnd | 0;
    e.menu_close();
    this._menuMode = false;
    this.queuePaint(wh);
    this.repaint();
  }

  scheduleRepaint() {
    if (this._repaintScheduled) {
      this._profileMark('schedule-repaint-coalesced');
      return;
    }
    if (this._repainting) {
      this._repaintPending = true;
      this._profileMark('schedule-repaint-during-paint');
      return;
    }
    this._repaintScheduled = true;
    this._profileMark('schedule-repaint');
    if (this._isNode) {
      // In Node, defer repaint — the batch loop calls flushRepaint() after
      // each WASM batch so all GDI writes complete before compositing.
    } else {
      requestAnimationFrame(() => {
        this._profileMark('raf');
        this._repaintScheduled = false;
        this.repaint();
      });
    }
  }

  flushRepaint(force = false) {
    if (force && !this._isNode) {
      this.scheduleRepaint();
      return;
    }
    if (this._repaintScheduled || force) {
      this._repaintScheduled = false;
      this.repaint();
    }
  }

  repaint() {
    if (this._repainting) {
      // Nested repaint request (e.g. a GDI surface upload →
      // scheduleRepaint → repaint while we're already painting). Drop a
      // flag so the outer repaint re-runs once it finishes.
      this._repaintPending = true;
      return;
    }
    this._profileMark('repaint-start');
    this._repainting = true;
    try {
      this._repaintOnce();
      // Drain any requests that arrived mid-paint. Cap the loop so a pathological
      // caller can't spin forever.
      let guard = 4;
      while (this._repaintPending && guard-- > 0) {
        this._repaintPending = false;
        this._repaintOnce();
      }
    } finally {
      this._repainting = false;
      this._repaintPending = false;
    }
  }

  setWindowRgn(hwnd, rgn) {
    const win = this.windows[hwnd];
    if (win) {
      win.region = rgn;
      const w = win.wasm || this.wasm;
      const e = w && w.exports;
      if (e && e.nc_post_paint) e.nc_post_paint(hwnd);
    }
  }

  _repaintOnce() {
    const ctx = this.ctx;

    const visibleTopLevel = Object.values(this.windows)
      .filter(w => w.visible && !w.isChild && w.w > 0 && w.h > 0);
    for (const win of visibleTopLevel) this._syncWindowStyle(win);
    const sorted = visibleTopLevel
      .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
    const top = sorted[sorted.length - 1];
    const exclusive = this._isExclusiveFullscreenWindow(top);
    this._setExclusiveFullscreen(exclusive);
    if (exclusive && top) {
      const scale = Math.min(
        this.canvas.width / Math.max(1, top.w),
        this.canvas.height / Math.max(1, top.h)
      );
      const dstW = Math.max(1, Math.floor(top.w * scale));
      const dstH = Math.max(1, Math.floor(top.h * scale));
      this._exclusiveTransform = {
        hwnd: top.hwnd,
        srcX: top.x,
        srcY: top.y,
        srcW: top.w,
        srcH: top.h,
        dstX: Math.floor((this.canvas.width - dstW) / 2),
        dstY: Math.floor((this.canvas.height - dstH) / 2),
        dstW,
        dstH,
      };
    } else {
      this._exclusiveTransform = null;
    }

    // Fill entire desktop (or clear to transparent if HTML desktop is below)
    if (this._exclusiveFullscreen) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      if (top) {
        this.wasm = top.wasm;
        this.wasmMemory = top.wasmMemory;
        this.drawWindow(top);
        if (top._backCanvas) {
          const t = this._exclusiveTransform;
          ctx.imageSmoothingEnabled = false;
          this._flushCanonicalCanvas(top._backCanvas);
          ctx.drawImage(top._backCanvas, t.dstX, t.dstY, t.dstW, t.dstH);
          if (top._dxFrameLayer && top._dxFrameLayer.canvas) {
            ctx.drawImage(top._dxFrameLayer.canvas, t.dstX, t.dstY, t.dstW, t.dstH);
          }
          this._compositeChildSurfaces(top, t);
        }
      }
      this.updateTaskbar();
      this._profileFinish('canvas-composited', { windows: top ? 1 : 0, exclusive: true });
      return;
    } else if (this.transparentDesktop) {
      // The normal browser desktop is an HTML layer below this canvas so its
      // icons stay behind application windows.  Keep the canvas background
      // transparent even when software GDI has attached an opaque canonical
      // desktop surface; otherwise launching the first app covers the icons.
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    } else if (this._desktopSurfaceCanvas) {
      ctx.imageSmoothingEnabled = false;
      this._flushCanonicalCanvas(this._desktopSurfaceCanvas);
      ctx.drawImage(this._desktopSurfaceCanvas, 0, 0,
        this.canvas.width, this.canvas.height);
    } else if (this._paintWallpaper(ctx)) {
      // Wallpaper painted the desktop background.
    } else {
      ctx.fillStyle = this.colors.desktop;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    // Composite windows back-to-front: chrome + offscreen client canvas
    for (const win of sorted) {
      // Context Switch: ensure renderer uses this window's owner WASM
      this.wasm = win.wasm;
      this.wasmMemory = win.wasmMemory;

      ctx.save();
      // Non-rectangular windows (Winamp skins, rounded corners)
      if (win.region && win.region.rects) {
        ctx.beginPath();
        for (const r of win.region.rects) {
          ctx.rect(win.x + r.x, win.y + r.y, r.w, r.h);
        }
        ctx.clip();
      }

      // Draw chrome overlays that are not part of the DefWindowProc NC pass
      // (currently the WAT-owned menu bar) before compositing.
      this.drawWindow(win);
      // Composite the back canvas on top — transparent areas let chrome
      // show through, opaque areas (app drawing) cover it. This handles
      // both GetDC (client area) and GetWindowDC (custom skin) drawing.
      if (win._backCanvas) {
        this._flushCanonicalCanvas(win._backCanvas);
        ctx.drawImage(win._backCanvas, win.x, win.y);
        if (win._dxFrameLayer && win._dxFrameLayer.canvas) {
          ctx.drawImage(win._dxFrameLayer.canvas, win.x, win.y);
        }
      }
      this._compositeChildSurfaces(win);
      ctx.restore();
    }

    this._paintCaretOverlay();

    // Draw dropdown overlay on top of everything (if any menu is open)
    this._menuPaintDropdown();

    // Classic Win98 resize feedback. Keep this above all windows so the
    // dotted frame stays visible without mutating or repainting the guest
    // window until the mouse button is released.
    this._paintResizeOutline();

    // Update HTML taskbar buttons
    this.updateTaskbar();
    this._profileFinish('canvas-composited', { windows: sorted.length });
  }

  _paintResizeOutline() {
    const r = this._resizeOutline;
    if (!r || r.w <= 0 || r.h <= 0 || !this.ctx) return;
    const ctx = this.ctx;
    const x = Math.round(r.x) + 0.5;
    const y = Math.round(r.y) + 0.5;
    const w = Math.max(0, Math.round(r.w) - 1);
    const h = Math.max(0, Math.round(r.h) - 1);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineDashOffset = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.strokeStyle = '#000000';
    ctx.lineDashOffset = 0;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  _windowClientOriginOnCanvas(win) {
    let x = 0;
    let y = 0;
    let cur = win;
    let guard = 0;
    while (cur && guard++ < 32) {
      if (cur.parentHwnd && this.windows[cur.parentHwnd]) {
        if (!cur.visible) return null;
        x += cur.x | 0;
        y += cur.y | 0;
        cur = this.windows[cur.parentHwnd];
        continue;
      }
      if (!cur.visible) return null;
      this._computeClientRect(cur);
      if (cur.clientRect) {
        x += cur.clientRect.x | 0;
        y += cur.clientRect.y | 0;
      } else {
        x += cur.x | 0;
        y += cur.y | 0;
      }
      return { x, y };
    }
    return null;
  }

  _paintCaretOverlay() {
    const wasms = new Set();
    if (this.wasm) wasms.add(this.wasm);
    for (const win of Object.values(this.windows || {})) {
      if (win && win.wasm) wasms.add(win.wasm);
    }

    const activeStates = new Set();
    for (const wasm of wasms) {
      const e = wasm && wasm.exports;
      if (!e || !e.get_caret_visible || !e.get_caret_hwnd ||
          !e.get_caret_x || !e.get_caret_y) {
        continue;
      }
      let visible = 0;
      let hwnd = 0;
      try {
        visible = e.get_caret_visible() | 0;
        hwnd = e.get_caret_hwnd() >>> 0;
      } catch (_) {
        continue;
      }
      if (!visible || !hwnd) {
        this._caretBlinkState.set(wasm, { key: 'hidden', phase: true });
        continue;
      }

      const win = this.windows[hwnd];
      if (!win || !win.visible) {
        this._caretBlinkState.set(wasm, { key: 'hidden', phase: true });
        continue;
      }
      const origin = this._windowClientOriginOnCanvas(win);
      if (!origin) {
        this._caretBlinkState.set(wasm, { key: 'hidden', phase: true });
        continue;
      }

      let x = 0, y = 0, w = 1, h = 13;
      try {
        x = e.get_caret_x() | 0;
        y = e.get_caret_y() | 0;
        if (e.get_caret_w) w = e.get_caret_w() | 0;
        if (e.get_caret_h) h = e.get_caret_h() | 0;
      } catch (_) {
        continue;
      }
      w = Math.max(1, w);
      h = Math.max(1, h);

      const blinkKey = `${hwnd}:${x}:${y}:${w}:${h}`;
      let state = this._caretBlinkState.get(wasm);
      if (!state || state.key !== blinkKey) {
        state = { key: blinkKey, phase: true };
        this._caretBlinkState.set(wasm, state);
      }
      activeStates.add(state);
      if (!state.phase) continue;

      const px = origin.x + x;
      const py = origin.y + y;
      const clipW = Math.max(0, win.w | 0);
      const clipH = Math.max(0, win.h | 0);
      if (!clipW || !clipH) continue;

      const ctx = this.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(origin.x, origin.y, clipW, clipH);
      ctx.clip();
      // A Win32 caret is XOR/inverted against the target pixels, not simply
      // painted into the backing store. Canvas "difference" with white gives
      // the same visible inversion while normal repaint restores the off phase.
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(px, py, w, h);
      ctx.restore();
    }
    this._caretBlinkActiveStates = activeStates;
    this._scheduleCaretBlink(activeStates.size > 0);
  }

  _scheduleCaretBlink(active) {
    if (!active) {
      if (this._caretBlinkTimer) {
        clearTimeout(this._caretBlinkTimer);
        this._caretBlinkTimer = null;
      }
      this._caretBlinkActiveStates.clear();
      return;
    }
    if (this._caretBlinkTimer) return;
    this._caretBlinkTimer = setTimeout(() => {
      this._caretBlinkTimer = null;
      for (const state of this._caretBlinkActiveStates) {
        state.phase = !state.phase;
      }
      this.scheduleRepaint();
    }, this._caretBlinkMs);
    if (this._caretBlinkTimer && typeof this._caretBlinkTimer.unref === 'function') {
      this._caretBlinkTimer.unref();
    }
  }

  updateTaskbar() {
    const container = typeof document !== 'undefined' && document.getElementById('task-buttons');
    if (!container) return;
    container.innerHTML = '';
    const allWins = Object.values(this.windows).filter(w => !w.isChild && w.hasCaption);
    for (const win of allWins) {
      const btn = document.createElement('button');
      btn.className = 'task-btn' + (win.visible && !win._minimized ? ' active' : '');
      btn.textContent = win.title || '(window)';
      btn.onclick = () => {
        if (win._minimized || !win.visible) {
          win.visible = true;
          win._minimized = false;
          this._raiseWindowGroup(win);
        } else {
          win.visible = false;
          win._minimized = true;
        }
        this.repaint();
      };
      container.appendChild(btn);
    }
  }

  // Tell WAT to load the menu for this hwnd from the PE resource by
  // its menu_id. WAT walks the PE resource directory itself ($find_
  // resource(RT_MENU=4, id)) and parses the MENUHEADER+MENUITEMTEMPLATE
  // bytes into its own heap-resident blob — see $menu_load in
  // src/09c5-menu.wat. JS only tracks the owning window and forwards
  // input/paint entrypoints into WAT; menu parsing, geometry, hit-testing,
  // keyboard navigation, and drawing are WAT-owned.
  // Ask WAT to (re)load this window's menu from the PE resource. Note
  // that the WAT-side WND_RECORDS slot for $win.hwnd may not exist yet
  // when this is first called from createWindow — host_create_window
  // runs before $wnd_table_set in $handle_CreateWindowExA, so we mark
  // the menu as "pending" and the actual menu_load is deferred to the
  // first paint/hit-test (see _ensureWatMenu).
  _setWatMenu(win) {
    const w = (win && win.wasm) || this.wasm;
    const e = w && w.exports;
    if (!e || !e.menu_load) return;
    win._menuLoaded = false;
    if (!win._menuId) {
      if (e.menu_clear) e.menu_clear(win.hwnd);
      win._menuLoaded = true;
    }
  }

  _ensureWatMenu(win) {
    const w = (win && win.wasm) || this.wasm;
    const e = w && w.exports;
    if (!e || !e.menu_load || !win || win._menuLoaded || !win._menuId) return;
    e.menu_load(win.hwnd, win._menuId);
    win._menuLoaded = true;
  }

  // Screen rect of $win's menu bar — WAT owns the geometry so dropdown
  // painting stays aligned with WAT hit-testing and client layout.
  _menuBarPos(win) {
    const w = (win && win.wasm) || this.wasm;
    const e = w && w.exports;
    if (e && e.menu_bar_screen_x && e.menu_bar_screen_y && e.menu_bar_screen_h) {
      return {
        barX: e.menu_bar_screen_x(win.hwnd) | 0,
        barY: e.menu_bar_screen_y(win.hwnd) | 0,
        barH: e.menu_bar_screen_h() | 0,
      };
    }
    return null;
  }

  // Paint the menu bar via WAT into the window's back-canvas. (x, y) are
  // the bar's *window-local* origin — repaint()'s blit at (win.x, win.y)
  // places it on screen.
  _menuPaintBar(win, x, y, w) {
    const e = this.wasm && this.wasm.exports;
    if (!e || !e.menu_paint_bar) return 0;
    this._ensureWatMenu(win);
    const openIdx = (e.menu_open_hwnd && e.menu_open_hwnd() === win.hwnd)
      ? (e.menu_open_top() | 0) : -1;
    const wc = this.getWindowCanvas(win.hwnd);
    if (!wc) return 0;
    this._activeChildDraw = { canvas: wc.canvas, ctx: wc.ctx, ox: 0, oy: 0, hwnd: win.hwnd };
    let h = 0;
    try { h = e.menu_paint_bar(win.hwnd, x, y, w, openIdx) | 0; }
    finally { this._activeChildDraw = null; }
    return h;
  }

  // Paint whatever dropdown the WAT side currently has open. Called
  // once per repaint after all windows are composited; reads state
  // from $menu_open_hwnd / $menu_open_top / $menu_open_hover and
  // computes the screen anchor from the owning window.
  //
  // Dropdowns can extend past the owning window's back-canvas, so we
  // route paint to a dedicated screen-sized overlay canvas and blit
  // it on top after all windows composite.
  _menuPaintDropdown() {
    const sw = this.canvas.width, sh = this.canvas.height;
    const menu = this._openMenuContext ? this._openMenuContext() : null;
    if (!menu) {
      this._dropdownOverlayPaintState = null;
      return;
    }
    let painted = false;
    let overlay = null;
    let rects = [];
    const prevWasm = this.wasm;
    const prevMemory = this.wasmMemory;
    try {
      const w = menu.wasm;
      const e = menu.exports;
      const hwnd = menu.hwnd | 0;
      const win = this.windows[hwnd];
      if (!win || !e.menu_paint_dropdown || !e.menu_bar_item_x) return;
      this.wasm = w;
      this.wasmMemory = win.wasmMemory;
      const top = e.menu_open_top() | 0;
      if (top < 0) return;
      const hover = e.menu_open_hover() | 0;
      const subHover = e.menu_open_sub_hover ? (e.menu_open_sub_hover() | 0) : -1;
      const explicitX = e.menu_open_x ? (e.menu_open_x() | 0) : -1;
      const explicitY = e.menu_open_y ? (e.menu_open_y() | 0) : -1;
      const pos = this._menuBarPos(win);
      if (!pos || !e.menu_prepare_overlay || !e.menu_prepare_overlay()) return;
      overlay = this._dropdownOverlay;
      if (!overlay || overlay.canvas.width !== sw || overlay.canvas.height !== sh) return;
      const { barX, barY, barH } = pos;
      const dx = explicitX >= 0 ? explicitX : barX + (e.menu_bar_item_x(hwnd, top) | 0);
      const dy = explicitY >= 0 ? explicitY : barY + barH;
      const height = e.menu_dropdown_height ? (e.menu_dropdown_height(hwnd, top) | 0) : 0;
      if (height > 0) rects.push({ x: dx, y: dy, w: 180, h: height });
      if (hover >= 0 && e.menu_child_sub_count) {
        const count = e.menu_child_sub_count(hwnd, top, hover) | 0;
        if (count > 0) rects.push({
          x: dx + 180, y: dy + 2 + hover * 20, w: 180, h: count * 20 + 4,
        });
      }
      const key = [hwnd, top, hover, subHover, dx, dy, sw, sh].join(':');
      const old = this._dropdownOverlayPaintState;
      if (!old || old.wasm !== w || old.key !== key) {
        overlay.ctx.clearRect(0, 0, sw, sh);
        e.menu_paint_dropdown(hwnd, top, dx, dy, hover);
        this._dropdownOverlayPaintState = { wasm: w, key, rects };
      } else {
        rects = old.rects;
      }
      painted = rects.length > 0;
    } finally {
      this.wasm = prevWasm;
      this.wasmMemory = prevMemory;
    }
    if (painted && overlay) {
      for (const rect of rects) {
        const x = Math.max(0, rect.x | 0);
        const y = Math.max(0, rect.y | 0);
        const r = Math.min(sw, (rect.x + rect.w) | 0);
        const b = Math.min(sh, (rect.y + rect.h) | 0);
        if (r > x && b > y) {
          this._flushCanonicalCanvas(overlay.canvas);
          this.ctx.drawImage(overlay.canvas, x, y, r - x, b - y, x, y, r - x, b - y);
        }
      }
    }
  }

  drawWindow(win) {
    const ctx = this.ctx;
    const { x, y, w, h } = win;

    // Skip windows with zero size
    if (w <= 0 || h <= 0) return;

    win.hasCaption = this._hasCaption(win);
    const hasBorder = win.hasCaption || !!(win.style & 0x00800000);

    // Recompute client rect (window may have moved/resized)
    this._computeClientRect(win);
    const { x: clientX, y: clientY, w: clientW, h: clientH } = win.clientRect;

    // Chrome is painted via WM_NCPAINT → DefWindowProc in the message loop
    // (see src/09c4-defwndproc.wat:$defwndproc_do_ncpaint). The menu bar
    // is likewise drawn on the back-canvas when the menu state changes.
    // repaint() is pure composite — it just blits the back-canvas.
    if (hasBorder) {
      let cy = y + 3;
      if (win.hasCaption) cy += 18 + 1;
      if (this._hasMenuBar(win)) {
        const mh = this._menuPaintBar(win, 3, cy - y, w - 6);
        cy += (mh || 18);
      }
    }

    // Dialog client-area fill happens on the back-canvas via
    // $dlg_fill_bkgnd → host_erase_background, invoked from WAT right
    // after $host_register_dialog_frame (see src/09c3-controls.wat).
    // No screen-canvas fallback needed.

    // Child controls paint themselves via the normal message loop:
    // InvalidateRect pushes them onto PAINT_QUEUE, GetMessageA returns
    // WM_PAINT for each, DispatchMessageA → wat_wndproc_dispatch → the
    // class wndproc which draws into its back-canvas DC. No synchronous
    // WM_PAINT synthesis from the renderer — repaint() only composites.

    // Draw child dialog windows within this window's client area
    for (const child of Object.values(this.windows)) {
      if (child.parentHwnd === win.hwnd && child.visible && child.isDialog && !this._usesOwnWindowSurface(child)) {
        // Save and translate context to parent's client area
        ctx.save();
        ctx.translate(clientX, clientY);
        // Temporarily adjust child coordinates for drawing
        const origX = child.x, origY = child.y;
        this.drawWindow(child);
        child.x = origX; child.y = origY;
        ctx.restore();
      }
    }
  }

}

// Mix in input handling methods from renderer-input.js
if (typeof require !== 'undefined') {
  const { installInputHandlers } = require('./renderer-input');
  installInputHandlers(Win98Renderer);
} else if (typeof window !== 'undefined' && window.installInputHandlers) {
  window.installInputHandlers(Win98Renderer);
}

// Export for both Node and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Win98Renderer };
} else if (typeof window !== 'undefined') {
  window.Win98Renderer = Win98Renderer;
}
