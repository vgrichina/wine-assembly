// Win98Renderer — shared between the browser and headless Node.
// Usage: new Win98Renderer(canvas), where canvas is a DOM <canvas> in the
// browser or a lib/raster-canvas.js surface headless.

// Surfaces describe drawing in pixels; a canvas is one implementation. Works
// in both harnesses: require() in Node, the global the page installs in a
// browser.
const _surfaceLib = (typeof require !== 'undefined')
  ? require('./surface')
  : (typeof globalThis !== 'undefined' ? globalThis.surfaceLib : null);
const _presentationLib = (typeof require !== 'undefined')
  ? require('./presentation-filter')
  : (typeof globalThis !== 'undefined' ? globalThis.presentationFilter : null);

function makeSurface(canvas) {
  if (!_surfaceLib) {
    // Fail here, naming the fix, rather than let repaint() die on a null
    // surface several frames later with nothing pointing at the cause.
    throw new Error(
      'Win98Renderer: lib/surface.js is not loaded. The browser page must ' +
      'include <script src="lib/surface.js"> BEFORE lib/renderer.js.');
  }
  return _surfaceLib.surfaceFromCanvas(canvas);
}

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
    // The screen as a Surface (lib/surface.js): drawing described in pixels
    // rather than in canvas calls. `canvas`/`ctx` stay for now because
    // host-imports still reaches for them through getWindowCanvas(); the
    // renderer's own compositing goes through `surface`.
    this.surface = makeSurface(this.canvas);
    // (no pre-parsed resource table — resource access goes through WAT
    //  exports: dlg_get_*, ctrl_get_*, rsrc_exists, rsrc_find_data_wa.)
    this.windows = {};
    this.inputQueue = [];
    this.mainWasm = null;
    this.mainWasmMemory = null;
    // Chrome dirty tracking moved to WAT NC_FLAGS (bit 0 = WM_NCPAINT).
    this._repaintScheduled = false;
    this._repaintRaf = null;
    this._workerGuestSliceDepth = 0;
    // A Worker slice may end in the middle of a BeginPaint/EndPaint cycle.
    // Keep that transaction opaque even between slices: a complete x86 block
    // is not necessarily a complete WM_PAINT, and publishing after the block
    // that erased an EDIT but before the block that drew its text makes the
    // control blink black (AoE I/II's exclusive-DirectDraw name field).
    this._workerGdiPaintDepth = 0;
    this._workerGdiPaintHwnds = new Map();
    this._workerRepaintDeferred = false;
    this._workerLastCompositeAt = 0;
    this._caretBlinkMs = 530;
    this._caretBlinkState = new WeakMap();
    this._caretBlinkActiveStates = new Set();
    this._caretBlinkTimer = null;
    this._nextZ = 1;
    this._isNode = (typeof window === 'undefined');
    // --trace-composite: one line per repaint saying which path composited and
    // what each window contributed. "the pixels are right in the back canvas
    // but wrong on screen" is a compositing question, and nothing else we log
    // can answer it.
    this.traceComposite = false;
    this._exclusiveFullscreen = false;
    this._requestedBrowserFullscreen = false;
    // Set by the exit chip, cleared by an explicit request or a new app. See
    // _setExclusiveFullscreen.
    this._fullscreenDeclined = false;
    // Single-app mode (a phone-sized screen): one guest owns the whole page,
    // and whatever it puts on the desktop is zoomed to fill it. See
    // _computeSingleAppZoom.
    this.singleAppMode = false;
    // 'fit' (whole window, letterboxed) or 'zoom' (fills the screen, cropped
    // to mobileCrop when the app names one). See setViewMode/_zoomModeCrop.
    this.viewMode = 'fit';
    this.mobileCrop = null;
    // Registry `keepAspect`: this app relays its artwork out to whatever client
    // rect it is given, per axis, so handing it a portrait phone distorts the
    // picture rather than showing more of it. Maximizing it then means "the
    // largest rect that fits at its own aspect", not "the whole canvas"; the
    // ordinary single-app fit letterboxes what is left. See
    // _singleAppMaximizeRect.
    this.singleAppKeepAspect = false;
    this._exclusiveTransform = null;
    this._exclusivePresentationViewport = null;
    this._exclusivePresentationSource = null;
    this._exclusivePresentationCanvas = null;
    this.presentationScaleMode = this._normalizePresentationScaleMode(
      typeof globalThis !== 'undefined' ? globalThis.WINE_2D_SCALE_MODE : null);
    this.presentationDeditherMode = this._normalizePresentationDeditherMode(
      typeof globalThis !== 'undefined' ? globalThis.WINE_DEDITHER_MODE : null);
    this.presentationEffects = this._normalizePresentationEffects(
      typeof globalThis !== 'undefined' ? globalThis.WINE_CRT_EFFECTS : null);
    this.presentationCanvas = null;
    this.presentationFilter = null;
    if (typeof document !== 'undefined' && document.getElementById && _presentationLib) {
      const output = document.getElementById('screen-present');
      if (output && output !== this.canvas && typeof output.getContext === 'function') {
        this.presentationCanvas = output;
        this.presentationFilter = new _presentationLib.PresentationFilter(output);
        if (this.canvas.style) this.canvas.style.opacity = '0';
      }
    }
    this._directPresentation = false;
    this._syncPresentationScaleStyle();
    this._presentationScaleCanvas = null;
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

    // Dialog unit conversion (1 DLU = 1.5px x, 1.625px y)
    this.dluX = 1.5;
    // tmHeight/8 for the dialog font. A real Win98 probe measures MS Sans
    // Serif 8pt at tmHeight=13 (test/fixtures/font-metrics.json), so this is
    // 13/8. It was 1.75 (a 14px cell) for a long time, which made every
    // dialog about 8% too tall; WAT's own DLU math in 10-helpers.wat has to
    // agree with it or controls and the client rect drift apart.
    this.dluY = 1.625;

    // Offscreen canvas factory: the browser's OffscreenCanvas, or headless the
    // pure-JS surface in lib/raster-canvas.js. Everything that makes an
    // offscreen surface must route through canvas-compat, because these get
    // blitted onto the screen canvas and a surface from a different canvas
    // implementation is not a valid drawImage source.
    this._createOffscreen = (w, h) => {
      let cvs;
      if (typeof OffscreenCanvas !== 'undefined') cvs = new OffscreenCanvas(w, h);
      else try {
        const { Canvas } = require('./canvas-compat');
        cvs = new Canvas(w, h);
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

  // Is this the frontmost top-level window? Owned windows count as part of
  // their owner's group, so a dialog sitting above its parent does not make
  // the parent "behind" for the purpose of a taskbar click.
  _isForegroundWindow(win) {
    if (!win || win.isChild || !win.visible) return false;
    const group = new Set([win.hwnd]);
    for (const candidate of Object.values(this.windows)) {
      if (candidate && candidate.visible && !candidate.isChild
        && this._windowOwnerHwnd(candidate) === win.hwnd) group.add(candidate.hwnd);
    }
    const top = Object.values(this.windows)
      .filter(w => w && w.visible && !w.isChild)
      .reduce((best, w) => ((w.zOrder || 0) > (best ? best.zOrder || 0 : -1) ? w : best), null);
    return !!top && group.has(top.hwnd);
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

  _isWindowClass(win, lowerName) {
    return String((win && win.className) || '').toLowerCase() === lowerName;
  }

  _compareTopLevelZ(a, b) {
    // Explorer's Progman is the desktop plane. Guest calls such as
    // SetForegroundWindow can legitimately mutate its numeric z-order, but
    // it must still composite below the tray and application top-levels.
    const aDesktop = this._isWindowClass(a, 'progman');
    const bDesktop = this._isWindowClass(b, 'progman');
    if (aDesktop !== bDesktop) return aDesktop ? -1 : 1;
    return (a.zOrder || 0) - (b.zOrder || 0);
  }

  // MFC caches a toolbar's full ideal button span and then repositions the
  // ToolbarWindow32 child with SWP_NOSIZE, so the child arrives carrying a
  // width its AfxControlBar42 parent never had room for -- WordPad's
  // formatting toolbar is 1512px wide inside a 394px frame. The containing
  // control bar clips it, in two forms: the toolbar's own width against the
  // bar's client width (here), and its client width against its own window
  // width (below), because the same cached span reaches the client rect
  // through NCCALCSIZE. Both were written out in full at five sites across
  // renderer.js and host-window.js. The 8px slack is what separates a merely
  // rounded width from a cached ideal one.
  // Returns 0 when there is no limit: not a toolbar, or not in a control bar.
  _toolbarWidthLimit(win) {
    if (!this._isWindowClass(win, 'toolbarwindow32')) return 0;
    const parent = win.parentHwnd ? this.windows[win.parentHwnd] : null;
    if (!this._isWindowClass(parent, 'afxcontrolbar42')) return 0;
    const w = parent.clientRect && parent.clientRect.w > 0 ? parent.clientRect.w : parent.w;
    return w > 0 ? w : 0;
  }

  // Apply that limit to the toolbar's own width. True if it changed.
  _clampToolbarWidth(win) {
    const limit = this._toolbarWidthLimit(win);
    if (!limit || !(win.w > limit + 8)) return false;
    win.w = limit;
    return true;
  }

  _clampToolbarClientWidth(win, clientW) {
    if (!this._isWindowClass(win, 'toolbarwindow32')) return clientW;
    return (win.w > 0 && clientW > win.w + 8) ? win.w : clientW;
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
        const cw = this._clampToolbarClientWidth(win, r - l);
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
        const cw = this._clampToolbarClientWidth(win, r - l);
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
    const dw = w !== undefined ? w : canvas.width;
    const dh = h !== undefined ? h : canvas.height;
    const blit = () => this._drawPresentedCanvas(canvas, x, y, dw, dh);
    if (!clipRect || clipRect.w <= 0 || clipRect.h <= 0) {
      blit();
      return;
    }
    this.surface.pushClip(clipRect);
    try {
      blit();
    } finally {
      this.surface.popClip();
    }
  }

  // Blit a back-canvas onto the screen surface. Back-canvases are still canvas
  // objects (host-imports uploads WAT pixels into them through a 2D context),
  // so wrap one as a source view rather than requiring callers to know which
  // representation they hold.
  _blitSurface(canvas, dx, dy, dw, dh) {
    if (!canvas || !this.surface) return;
    const src = canvas._waSurfaceView
      || (canvas._waSurfaceView = {
        canvas,
        get width() { return canvas.width; },
        get height() { return canvas.height; },
        get data() { return canvas._data || null; },
      });
    this.surface.blit(src, 0, 0, canvas.width, canvas.height, dx, dy, dw, dh);
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

  // Monotonic counter stamped on every surface write the hosts perform, so
  // the compositor can tell which of two overlapping surfaces the guest wrote
  // last. host-imports stamps windows here.
  nextSurfaceWriteSeq() {
    this._surfaceWriteSeq = (this._surfaceWriteSeq | 0) + 1;
    return this._surfaceWriteSeq;
  }

  // staleBeforeSeq: a DirectDraw primary was presented at that write sequence.
  // On real hardware a child window's GDI output and the game's DirectDraw
  // blit land on the same primary surface, so a full-screen present made
  // after the child last painted simply covers it — no clipping involved,
  // because these popups carry no WS_CLIPCHILDREN. We give every child its
  // own canvas and blit it after the frame, which turns "covered" into
  // "permanently on top": Diablo's SDlgStatic class names LTGRAY_BRUSH as its
  // background, so the flaming-logo slot came out as a grey slab over the
  // artwork. Drop a child surface the present has already overwritten; the
  // next WM_PAINT restamps it and it composites again.
  _compositeChildSurfaces(parent, transform, staleBeforeSeq) {
    const children = Object.values(this.windows)
      .filter(child => child && child.visible && child.parentHwnd === parent.hwnd)
      .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
    const prevWasm = this.wasm;
    const prevMemory = this.wasmMemory;
    try {
      for (const child of children) {
        const ownSurface = this._usesOwnWindowSurface(child) &&
          !(staleBeforeSeq && (child._gdiWriteSeq | 0) < staleBeforeSeq);
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
        this._compositeChildSurfaces(child, transform, staleBeforeSeq);
      }
    } finally {
      this.wasm = prevWasm;
      this.wasmMemory = prevMemory;
    }
  }

  // Native child controls normally draw into their top-level window's shared
  // GDI surface rather than owning a canvas.  Under exclusive DirectDraw that
  // surface cannot replace the primary (the DX SDK samples continuously paint
  // menu chrome into it), but throwing it away also throws away the controls.
  // Keep it as a sparse overlay and copy only the visible child rectangles on
  // top of the DirectDraw frame.  AoE I and II both use a subclassed EDIT this
  // way for the player name.
  _exclusiveSharedChildRegions(parent) {
    const regions = [];
    const visit = win => {
      const children = Object.values(this.windows)
        .filter(child => child && child.visible && child.parentHwnd === win.hwnd)
        .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
      for (const child of children) {
        if (!this._usesOwnWindowSurface(child) && child.w > 0 && child.h > 0) {
          const pos = this._windowOriginForComposite(child);
          regions.push({ x: pos.x | 0, y: pos.y | 0,
            w: child.w | 0, h: child.h | 0 });
        }
        visit(child);
      }
    };
    visit(parent);
    return regions;
  }

  _compositeExclusiveSharedChildren(parent, transform) {
    const overlay = parent && parent._exclusiveGdiChildCanvas;
    if (!overlay) return;
    const regions = this._exclusiveSharedChildRegions(parent);
    if (!regions.length) return;
    const pos = this._windowOriginForComposite(parent);
    if (transform) {
      const sx = transform.dstW / Math.max(1, transform.srcW);
      const sy = transform.dstH / Math.max(1, transform.srcH);
      const dx = transform.dstX + Math.floor((pos.x - transform.srcX) * sx);
      const dy = transform.dstY + Math.floor((pos.y - transform.srcY) * sy);
      const dw = Math.max(1, Math.floor(overlay.width * sx));
      const dh = Math.max(1, Math.floor(overlay.height * sy));
      for (const region of regions) {
        this._drawImageClipped(overlay, dx, dy, dw, dh,
          this._transformClipRect(region, transform));
      }
    } else {
      for (const region of regions) {
        this._drawImageClipped(overlay, pos.x, pos.y,
          overlay.width, overlay.height, region);
      }
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

  // hwnd DirectDraw currently presents to under DDSCL_EXCLUSIVE, or 0.
  _dxExclusiveHwnd(win) {
    // The window's own instance, never a fallback: every app is a separate
    // WASM instance with its own $dx_exclusive_fullscreen, and asking the
    // wrong one answers about a different process.
    const w = win && win.wasm;
    const e = w && w.exports;
    if (!e || !e.get_dx_exclusive_hwnd) return 0;
    return e.get_dx_exclusive_hwnd() >>> 0;
  }

  // 1 while the guest holds a ChangeDisplaySettings(CDS_FULLSCREEN) mode.
  _displayFullscreen(win) {
    const e = win && win.wasm && win.wasm.exports;
    if (!e || !e.get_display_fullscreen) return false;
    return (e.get_display_fullscreen() | 0) !== 0;
  }

  _isExclusiveFullscreenWindow(win) {
    if (!win || win.isChild || !win.visible || win.w <= 0 || win.h <= 0) return false;
    // A DirectDraw app that took DDSCL_EXCLUSIVE|DDSCL_FULLSCREEN owns the
    // display outright: its primary surface covers the caption, the border and
    // the menu bar whatever style bits the window carries. The DX SDK samples
    // are the case the style heuristic below cannot see -- flip2d ("DirectDraw
    // Spinning Cube") keeps WS_CAPTION and a Cube menu, so the compositor drew
    // chrome plus an empty grey client area over the presented frame.
    const exclusiveHwnd = this._dxExclusiveHwnd(win);
    if (exclusiveHwnd === win.hwnd) return true;
    // The exclusive window is not always the topmost one, and the compositor
    // asks about the topmost. Storm stacks every Diablo menu on a screen-sized
    // SDlgDialog popup owned by the game window, so from the main menu onward
    // the top window is that popup while DirectDraw still owns the display
    // underneath it. Answering "no" for the popup dropped the whole page out
    // of exclusive mode: the game went back to being a 640x480 window in the
    // corner of a desktop-sized canvas, letterboxed by teal, from the first
    // menu to the end of the session. The stack walk below this decision
    // already knows about these popups -- it just never ran, because its entry
    // condition is this function applied to the top window.
    if (exclusiveHwnd) {
      // Owner chain, not just the immediate owner: a dialog can put another
      // dialog over itself (Diablo's Enter Name over Choose Class).
      let owner = this._windowOwnerHwnd(win);
      for (let hops = 0; owner && hops < 8; hops++) {
        if (owner === exclusiveHwnd) return true;
        const next = this.windows[owner];
        if (!next) break;
        owner = this._windowOwnerHwnd(next);
      }
    }
    // Below this line the decision is a *guess* from window geometry, and a
    // guess that fires on an ordinary app blacks out the whole page: the
    // compositor fills the canvas with #000 and
    // body.no-debug.exclusive-fullscreen hides the taskbar and the desktop
    // icons with !important. Maximized Notepad has exactly the shape the guess
    // looks for. So the guess only runs once the guest has actually asked for
    // the display, by one of the two calls that mean it:
    //   - ChangeDisplaySettings(mode, CDS_FULLSCREEN), for an app that does
    //     not use DirectDraw at all;
    //   - a DirectDraw present into this window, for a game that took the
    //     primary surface without ever calling SetCooperativeLevel exclusive.
    // A plain GDI app matches neither, whatever size its window is.
    if (!win._dxFrameLayer && !this._displayFullscreen(win)) return false;
    const hasCaption = this._hasCaption(win);
    if (hasCaption || this._hasMenuBar(win)) return false;
    if (win.x > 24 || win.y > 4) return false;
    if (win.w < 600 || win.h < 440) return false;
    return (win.w < this.canvas.width || win.h < this.canvas.height ||
            (win.w >= this.canvas.width * 0.75 && win.h >= this.canvas.height * 0.75));
  }

  _setExclusiveFullscreen(active) {
    active = !!active;
    // The user pressed "leave full screen". A guest may not take the display
    // back on its own after that -- only an explicit ask (the consent bar) or
    // a new app clears the decline.
    //
    // Without this the chip is a dead end for any app that really is
    // exclusive. Leaving full screen removes body.page-fullscreen but does not
    // change _exclusiveFullscreen, so the next repaint recomputes active=true,
    // takes the early return below, and the body keeps `exclusive-fullscreen`
    // with `page-fullscreen` gone. That combination hides #desktop-icons and
    // the taskbar while showing no app chrome -- and on a phone the icons are
    // the only launcher there is, so the visitor is left on bare background
    // with nothing to press. Reported as "cannot launch a new app after
    // closing the previous one - stuck in green desktop".
    if (active && this._fullscreenDeclined) active = false;
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
        // Where the browser has no element Fullscreen API (iPhone Safari), the
        // consent button leads nowhere but the page fallback, so skip it and
        // give the app the page now. index.html no-ops this everywhere else.
        // try/catch because this runs inside a repaint: anything thrown here
        // would take the frame with it, and a renderer that stops repainting
        // looks exactly like an app that hung.
        if (typeof window !== 'undefined' &&
            typeof window.enterPageFullscreenIfNoApi === 'function') {
          try { window.enterPageFullscreenIfNoApi(); } catch (_) {}
        }
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
        // No fullscreen element to exit means either the user never asked for
        // one or the browser has no Fullscreen API (iPhone Safari), in which
        // case the page itself is standing in for it and has to be put back.
        if (typeof window !== 'undefined' && typeof window.exitPageFullscreen === 'function') {
          window.exitPageFullscreen();
        } else if (resize) resize();
      }
    }
  }

  _normalizePresentationScaleMode(mode) {
    if (mode === 'scale2x' || mode === 'scale3x') mode = 'scale-auto';
    return mode === 'integer' || mode === 'sharp-bilinear' ||
      mode === 'browser-hq' || mode === 'sharp-hq' || mode === 'scale-auto' ||
      mode === 'fsr1'
      ? mode : 'nearest';
  }

  _normalizePresentationEffects(effects) {
    effects = effects || {};
    return {
      scanlines: !!effects.scanlines,
      mask: !!effects.mask,
      glow: !!effects.glow,
    };
  }

  _normalizePresentationDeditherMode(mode) {
    if (mode === 'checkerboard' || mode === 'ordered2') return 'mdapt';
    return mode === 'mdapt' || mode === 'jinc2' ? mode : 'off';
  }

  setPresentationScaleMode(mode) {
    const normalized = this._normalizePresentationScaleMode(mode);
    if (this.presentationScaleMode === normalized) return normalized;
    this.presentationScaleMode = normalized;
    this._syncPresentationScaleStyle();
    this.scheduleRepaint();
    return normalized;
  }

  setPresentationDeditherMode(mode) {
    const normalized = this._normalizePresentationDeditherMode(mode);
    if (this.presentationDeditherMode === normalized) return normalized;
    this.presentationDeditherMode = normalized;
    this.scheduleRepaint();
    return normalized;
  }

  setPresentationEffects(effects) {
    const normalized = this._normalizePresentationEffects(effects);
    const old = this.presentationEffects;
    if (old && old.scanlines === normalized.scanlines &&
        old.mask === normalized.mask && old.glow === normalized.glow) return normalized;
    this.presentationEffects = normalized;
    this.scheduleRepaint();
    return normalized;
  }

  _syncPresentationScaleStyle() {
    const smooth = this.presentationScaleMode === 'sharp-bilinear' ||
      this.presentationScaleMode === 'browser-hq' ||
      this.presentationScaleMode === 'sharp-hq';
    const gpuFiltered = this.presentationScaleMode === 'scale-auto' ||
      this.presentationScaleMode === 'fsr1';
    const rendering = smooth || gpuFiltered ? 'auto' : 'pixelated';
    // Both canvases: either one can be the visible surface (see
    // _canPresentDirectly), and the mode can change while it is.
    for (const canvas of [this.presentationCanvas, this.canvas]) {
      if (canvas && canvas.style) canvas.style.imageRendering = rendering;
    }
  }

  // The presentation pass exists to run a filter over the composited desktop.
  // With a plain sampling mode, no CRT effects, no dedither and no crop there
  // is no filter left to run: present() degenerates into a full-canvas
  // canvas→canvas copy that lands the same pixels the compositor would have
  // produced for free from the logical canvas. So show that canvas and let
  // CSS scale it — nearest gets `image-rendering: pixelated`, browser HQ gets
  // the compositor's own smoothing. On a phone that is a ~1M pixel blit per
  // frame gone.
  //
  // Anything with a crop (single-app zoom), a shader, or its own composited
  // source still needs the real pass; the styles flip back when it does.
  _canPresentDirectly(source) {
    if (!this.presentationCanvas || source !== this.canvas) return false;
    if (this._exclusivePresentationViewport) return false;
    if (this.presentationDeditherMode !== 'off') return false;
    const effects = this.presentationEffects;
    if (effects && (effects.scanlines || effects.mask || effects.glow)) return false;
    return this.presentationScaleMode === 'nearest' ||
      this.presentationScaleMode === 'browser-hq';
  }

  _syncDirectPresentation(direct) {
    if (this._directPresentation === direct) return;
    this._directPresentation = direct;
    if (this.canvas && this.canvas.style) {
      this.canvas.style.opacity = direct ? '1' : '0';
    }
    if (this.presentationCanvas && this.presentationCanvas.style) {
      this.presentationCanvas.style.display = direct ? 'none' : '';
    }
    this._syncPresentationScaleStyle();
  }

  _presentDisplayCanvas() {
    if (!this.presentationFilter || !this.presentationCanvas) return;
    const source = this._exclusivePresentationSource || this.canvas;
    const direct = this._canPresentDirectly(source);
    this._syncDirectPresentation(direct);
    if (direct) return;
    this.presentationFilter.present(
      source, this.presentationScaleMode, this.presentationEffects,
      {
        viewport: this._exclusivePresentationViewport,
        dedither: this.presentationDeditherMode,
      });
  }

  _computeExclusiveTransform(win) {
    if (!win || win.w <= 0 || win.h <= 0) return null;
    const srcW = Math.max(1, win.w | 0);
    const srcH = Math.max(1, win.h | 0);
    const fitScale = Math.min(this.canvas.width / srcW, this.canvas.height / srcH);
    let dstW;
    let dstH;
    const integerStage = this.presentationScaleMode === 'integer' ||
      this.presentationScaleMode === 'sharp-bilinear' ||
      this.presentationScaleMode === 'sharp-hq';
    if (integerStage && fitScale >= 1) {
      const scale = Math.max(1, Math.floor(fitScale));
      dstW = srcW * scale;
      dstH = srcH * scale;
    } else if (this.canvas.width * srcH <= this.canvas.height * srcW) {
      dstW = Math.max(1, this.canvas.width | 0);
      dstH = Math.max(1, Math.round(dstW * srcH / srcW));
    } else {
      dstH = Math.max(1, this.canvas.height | 0);
      dstW = Math.max(1, Math.round(dstH * srcW / srcH));
    }
    return {
      hwnd: win.hwnd,
      srcX: win.x,
      srcY: win.y,
      srcW,
      srcH,
      dstX: Math.floor((this.canvas.width - dstW) / 2),
      dstY: Math.floor((this.canvas.height - dstH) / 2),
      dstW,
      dstH,
    };
  }

  // `cropFromSource` says the presented source is the whole desktop canvas
  // rather than the window's own back-canvas, so the crop rectangle is the
  // window's position on that desktop instead of its origin.
  //
  // `bottomInset` (physical pixels) reserves a band at the foot of the output
  // for something that is NOT the guest -- today, the touch-control overlay.
  // Only the single-app zoom passes it; the exclusive-fullscreen path never
  // does, because a game that owns the display owns all of it.
  // `fill` says the source has already been trimmed to the output's aspect
  // (zoom mode), so the destination IS the output. Without it, integer
  // rounding of the trim leaves a one-pixel bar of desktop along one edge --
  // a seam in what is supposed to be a full-screen picture.
  _computeExclusivePresentationViewport(transform, cropFromSource, bottomInset, fill) {
    if (!transform || !this.presentationCanvas) return null;
    const mode = this.presentationScaleMode;
    const outputW = Math.max(1, this.presentationCanvas.width | 0);
    const outputH = Math.max(1, this.presentationCanvas.height | 0);
    const inset = Math.max(0, Math.min(outputH - 1, Math.round(bottomInset || 0)));
    const fitH = Math.max(1, outputH - inset);
    const nativeW = Math.max(1, transform.srcW | 0);
    const nativeH = Math.max(1, transform.srcH | 0);
    const physicalFit = Math.min(outputW / nativeW, fitH / nativeH);
    const multiplier = physicalFit >= 1 ? Math.max(1, Math.floor(physicalFit)) : 0;
    let dstW;
    let dstH;
    if (fill) {
      dstW = outputW;
      dstH = fitH;
    } else if (mode === 'integer' && multiplier > 0) {
      dstW = nativeW * multiplier;
      dstH = nativeH * multiplier;
    } else if (outputW * nativeH <= fitH * nativeW) {
      dstW = outputW;
      dstH = Math.max(1, Math.round(dstW * nativeH / nativeW));
    } else {
      dstH = fitH;
      dstW = Math.max(1, Math.round(dstH * nativeW / nativeH));
    }
    return {
      cropX: cropFromSource ? (transform.srcX | 0) : 0,
      cropY: cropFromSource ? (transform.srcY | 0) : 0,
      cropW: nativeW,
      cropH: nativeH,
      nativeX: transform.srcX,
      nativeY: transform.srcY,
      nativeW,
      nativeH,
      dstX: Math.floor((outputW - dstW) / 2),
      // Centred in what is left after the inset, so the reserved band stays
      // empty and the picture moves UP into the space it frees.
      dstY: Math.floor((fitH - dstH) / 2),
      dstW,
      dstH,
      outputW,
      outputH,
      bottomInset: inset,
      multiplier,
      // What surrounds the presented image. A fullscreen game's letterbox is
      // black the way a real monitor's is, but a *windowed* app zoomed by
      // single-app mode is still sitting on the Win98 desktop, so the bars
      // either side of it should be the desktop, not a void.
      background: cropFromSource ? this.colors.desktop : '#000000',
    };
  }

  // What "maximize" means for this window on this canvas.
  //
  // Normally it means the whole canvas, and that is right for an app that
  // answers a bigger client rect by showing more of its document (Notepad,
  // Paint). It is wrong for one that relays its artwork out to whatever it is
  // given, per axis: Taipei stretches its tiles and Pegged its holes, so a
  // portrait phone gets a distorted board rather than a bigger one. Nothing in
  // the presentation path stretches -- the distortion is the guest's own
  // layout, so the fix has to be the rect the guest is handed.
  //
  // `keepAspect` in the registry (lib/apps.js) asks for the largest rect that
  // fits the canvas at the window's own aspect ratio instead. The single-app
  // fit then letterboxes it exactly as it letterboxes a window too small to
  // fill the screen -- one presentation path, no new one.
  //
  // Returns null when the plain full-canvas maximize applies.
  _singleAppMaximizeRect(win, natural) {
    if (!this.singleAppMode || !this.singleAppKeepAspect) return null;
    if (!win || win.isChild || !natural) return null;
    const canvasW = Math.max(1, this.canvas.width | 0);
    const canvasH = Math.max(1, this.canvas.height | 0);
    const naturalW = natural.w | 0;
    const naturalH = natural.h | 0;
    if (naturalW <= 0 || naturalH <= 0) return null;
    // Preserve the CLIENT aspect, not the outer one. Caption, border and menu
    // bar are a fixed pixel band whatever the window measures, so fitting the
    // outer rect distorts the client by exactly the chrome's worth -- 42 of
    // Taipei's 300 rows, which is 14% and plainly visible. Chrome is measured
    // from the window as it stands (outer minus client) and assumed constant
    // across the resize; a menu bar that wraps to a second row at a different
    // width would break that assumption by one row.
    const cr = win.clientRect;
    const chromeW = (cr && cr.w > 0 && cr.w <= win.w) ? (win.w | 0) - (cr.w | 0) : 0;
    const chromeH = (cr && cr.h > 0 && cr.h <= win.h) ? (win.h | 0) - (cr.h | 0) : 0;
    const clientW = Math.max(1, naturalW - chromeW);
    const clientH = Math.max(1, naturalH - chromeH);
    const availW = Math.max(1, canvasW - chromeW);
    const availH = Math.max(1, canvasH - chromeH);
    const scale = Math.min(availW / clientW, availH / clientH);
    const w = Math.max(1, Math.min(canvasW, Math.round(clientW * scale) + chromeW));
    const h = Math.max(1, Math.min(canvasH, Math.round(clientH * scale) + chromeH));
    // Centred across the free axis. The zoom crop is the union of the visible
    // top-level rects, so the origin does not change what is presented -- it is
    // what the ?debug desktop behind it looks like, and where a centred dialog
    // lands.
    return {
      x: Math.max(0, (canvasW - w) >> 1),
      y: Math.max(0, (canvasH - h) >> 1),
      w,
      h,
    };
  }

  // Single-app mode zoom. The desktop canvas is composited exactly as it
  // always is — every top-level window in its own place, dialogs and popups
  // where the guest put them — and only the *presentation* is cropped to the
  // rectangle the app actually occupies, then scaled to fill the phone.
  //
  // That is deliberately not the exclusive-fullscreen path: that one presents
  // a single window's back-canvas, so a modal dialog would replace its owner
  // instead of sitting on top of it. Here the crop is the union of the visible
  // top-level windows, so a dialog that overhangs its owner simply widens the
  // zoom rather than taking the screen.
  //
  // A window that already fills the canvas (the usual case — single-app mode
  // maximizes what it can) produces no zoom at all: the crop is the canvas.
  // A keepAspect app never fills it, and is letterboxed here instead.
  _computeSingleAppZoom(topLevels) {
    if (!this.presentationCanvas) return null;
    const canvasW = Math.max(1, this.canvas.width | 0);
    const canvasH = Math.max(1, this.canvas.height | 0);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const win of topLevels) {
      if (!win || win.w <= 0 || win.h <= 0) continue;
      if (String(win.className || '').toLowerCase() === 'progman') continue;
      x0 = Math.min(x0, win.x | 0);
      y0 = Math.min(y0, win.y | 0);
      x1 = Math.max(x1, (win.x | 0) + (win.w | 0));
      y1 = Math.max(y1, (win.y | 0) + (win.h | 0));
    }
    // An open dropdown is painted straight onto the desktop canvas and can
    // extend past its window, so it has to widen the crop or the zoom cuts it
    // off at the window edge.
    const menu = this._openMenuGeometry();
    for (const rect of (menu ? menu.rects : [])) {
      if (rect.w <= 0 || rect.h <= 0) continue;
      x0 = Math.min(x0, rect.x | 0);
      y0 = Math.min(y0, rect.y | 0);
      x1 = Math.max(x1, (rect.x | 0) + (rect.w | 0));
      y1 = Math.max(y1, (rect.y | 0) + (rect.h | 0));
    }
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
    x0 = Math.max(0, Math.min(x0, canvasW - 1));
    y0 = Math.max(0, Math.min(y0, canvasH - 1));
    x1 = Math.max(x0 + 1, Math.min(x1, canvasW));
    y1 = Math.max(y0 + 1, Math.min(y1, canvasH));
    const rect = { hwnd: 0, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const inset = this._singleAppBottomInset();
    const zoomMode = this.viewMode === 'zoom';
    // A window that already fills the canvas needs no crop -- unless there is
    // a band to clear or a crop to apply, which are exactly the two reasons to
    // present something other than the whole thing.
    if (rect.w >= canvasW && rect.h >= canvasH && !zoomMode && !inset) return null;
    const source = zoomMode ? this._zoomModeCrop(rect, inset, canvasW, canvasH) : rect;
    const transform = this._computeExclusiveTransform(source);
    if (!transform) return null;
    return {
      transform,
      viewport: this._computeExclusivePresentationViewport(
        transform, true, inset, zoomMode),
    };
  }

  // Zoom (fill) mode: the picture covers the screen and what does not fit is
  // cropped away, rather than being letterboxed to show every pixel.
  //
  // Which pixels survive is an app-level judgement, not a geometric one --
  // Space Cadet's window is a tall table with a score panel beside it, and
  // filling a phone with the *window* centre puts the join down the middle of
  // the screen. So a registry entry may name the part worth filling with
  // (`mobileCrop`, fractions of the window rect); absent one, the window
  // centre is used.
  //
  // The crop is then trimmed to the output's aspect ratio, so the ordinary fit
  // below scales it to exactly fill. That keeps ONE presentation path: the
  // viewport still describes a source rectangle and a destination rectangle,
  // so input mapping and the touch zones need to know nothing about modes.
  _zoomModeCrop(rect, inset, canvasW, canvasH) {
    const outputW = Math.max(1, this.presentationCanvas
      ? this.presentationCanvas.width | 0 : this.canvas.width | 0);
    const outputH = Math.max(1, this.presentationCanvas
      ? this.presentationCanvas.height | 0 : this.canvas.height | 0);
    const fitH = Math.max(1, outputH - Math.max(0, inset || 0));
    let x = rect.x;
    let y = rect.y;
    let w = rect.w;
    let h = rect.h;
    const crop = this.mobileCrop;
    if (crop && crop.w > 0 && crop.h > 0) {
      x = rect.x + (+crop.x || 0) * rect.w;
      y = rect.y + (+crop.y || 0) * rect.h;
      w = crop.w * rect.w;
      h = crop.h * rect.h;
    }
    // Which end of the trim survives. Centred is the sane default, but a
    // pinball table is not symmetric about anything a phone cares about: the
    // flippers are the reason to play and they are at the bottom, so its crop
    // asks for anchorY: 1 and loses the trim off the top instead.
    const ax = Number.isFinite(crop && crop.anchorX) ? crop.anchorX : 0.5;
    const ay = Number.isFinite(crop && crop.anchorY) ? crop.anchorY : 0.5;
    const target = outputW / fitH;
    if (w / h > target) {
      const next = h * target;
      x += (w - next) * Math.max(0, Math.min(1, ax));
      w = next;
    } else {
      const next = w / target;
      y += (h - next) * Math.max(0, Math.min(1, ay));
      h = next;
    }
    x = Math.max(0, Math.min(Math.round(x), canvasW - 1));
    y = Math.max(0, Math.min(Math.round(y), canvasH - 1));
    w = Math.max(1, Math.min(Math.round(w), canvasW - x));
    h = Math.max(1, Math.min(Math.round(h), canvasH - y));
    return { hwnd: 0, x, y, w, h };
  }

  // 'fit' shows the whole window letterboxed; 'zoom' fills the screen and
  // crops. Returns whether the mode actually changed, so a caller driving it
  // from a gesture can tell a flip from a no-op.
  setViewMode(mode) {
    const next = mode === 'zoom' ? 'zoom' : 'fit';
    if (this.viewMode === next) return false;
    this.viewMode = next;
    if (this.scheduleRepaint) this.scheduleRepaint();
    return true;
  }

  // How much of the output to keep clear at the bottom for the touch-control
  // overlay, in presentation-canvas pixels.
  //
  // Rodent's Revenge is a square playfield on a tall phone: fitted to the
  // width it leaves a third of the screen empty, and the dpad was being drawn
  // on top of the board anyway. Reserving the band the overlay occupies moves
  // the picture up into that empty space instead.
  //
  // Two limits, both deliberate:
  //
  //   * MAX_INSET_SHARE (0.35). Past a third of the height, shrinking the game
  //     costs more than the overlap does -- at that point drawing over a
  //     corner of the picture is the lesser evil, so the reservation is capped
  //     and the overlap comes back.
  //   * Nothing is reserved at all when the app is already letterboxed enough
  //     to absorb it: the picture is simply re-centred higher and not one
  //     pixel of scale is given up. That is the common case for a 4:3 game on
  //     a 19.5:9 phone, and it falls out of passing the same inset to the
  //     viewport -- the fit only binds once the free space runs out.
  _singleAppBottomInset() {
    if (!this.presentationCanvas) return 0;
    const source = this.touchOverlay ||
      (typeof window !== 'undefined' ? window.TouchControls : null);
    if (!source || typeof source.getOccupiedFraction !== 'function') return 0;
    let fraction = 0;
    try { fraction = source.getOccupiedFraction(); } catch (_) { return 0; }
    if (!Number.isFinite(fraction) || fraction <= 0) return 0;
    const MAX_INSET_SHARE = 0.35;
    const outputH = Math.max(1, this.presentationCanvas.height | 0);
    return Math.floor(Math.min(fraction, MAX_INSET_SHARE) * outputH);
  }

  // The rectangle the guest's picture actually occupies on the page, in client
  // (viewport) CSS pixels: after the crop, the zoom, the letterbox and the
  // bottom inset above. lib/touch-controls.js positions its in-place touch
  // zones against this, so a zone stays over the part of the game it names
  // however the presentation moves.
  getPresentedRectClient() {
    let canvas = null;
    let box = null;
    for (const candidate of [this.presentationCanvas, this.canvas]) {
      if (!candidate || typeof candidate.getBoundingClientRect !== 'function') continue;
      const r = candidate.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) { canvas = candidate; box = r; break; }
    }
    if (!canvas) return null;
    const v = this._exclusivePresentationViewport;
    if (canvas === this.presentationCanvas && v &&
        v.outputW > 0 && v.outputH > 0 && v.dstW > 0 && v.dstH > 0) {
      const sx = box.width / v.outputW;
      const sy = box.height / v.outputH;
      return {
        x: box.left + v.dstX * sx, y: box.top + v.dstY * sy,
        w: v.dstW * sx, h: v.dstH * sy,
      };
    }
    const t = this._exclusiveTransform;
    if (canvas === this.canvas && t && t.dstW > 0 && t.dstH > 0) {
      const sx = box.width / Math.max(1, this.canvas.width);
      const sy = box.height / Math.max(1, this.canvas.height);
      return {
        x: box.left + t.dstX * sx, y: box.top + t.dstY * sy,
        w: t.dstW * sx, h: t.dstH * sy,
      };
    }
    return { x: box.left, y: box.top, w: box.width, h: box.height };
  }

  _buildExclusivePresentationSource(top) {
    if (!top || !top._backCanvas) return null;
    const layers = [];
    const visit = parent => {
      const children = Object.values(this.windows)
        .filter(child => child && child.visible && child.parentHwnd === parent.hwnd)
        .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
      for (const child of children) {
        if (this._usesOwnWindowSurface(child) && child._backCanvas) layers.push(child);
        visit(child);
      }
    };
    visit(top);
    const dx = top._dxFrameLayer && top._dxFrameLayer.canvas;
    if (!dx && layers.length === 0) return top._backCanvas;

    const width = Math.max(1, top._backCanvas.width | 0);
    const height = Math.max(1, top._backCanvas.height | 0);
    let canvas = this._exclusivePresentationCanvas;
    if (!canvas || canvas.width !== width || canvas.height !== height) {
      canvas = this._createOffscreen(width, height);
      this._exclusivePresentationCanvas = canvas;
    }
    if (!canvas || !canvas.getContext) return top._backCanvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;
    this._flushCanonicalCanvas(top._backCanvas);
    ctx.drawImage(top._backCanvas, 0, 0);
    if (dx) ctx.drawImage(dx, 0, 0);

    const topPos = this._windowOriginForComposite(top);
    const sharedOverlay = top._exclusiveGdiChildCanvas;
    if (sharedOverlay) {
      this._flushCanonicalCanvas(sharedOverlay);
      for (const region of this._exclusiveSharedChildRegions(top)) {
        const x = region.x - topPos.x;
        const y = region.y - topPos.y;
        ctx.drawImage(sharedOverlay, x, y, region.w, region.h,
          x, y, region.w, region.h);
      }
    }
    for (const child of layers) {
      this._flushCanonicalCanvas(child._backCanvas);
      const pos = this._windowOriginForComposite(child);
      const x = pos.x - topPos.x;
      const y = pos.y - topPos.y;
      ctx.drawImage(child._backCanvas, x, y);
      if (child._dxFrameLayer && child._dxFrameLayer.canvas) {
        ctx.drawImage(child._dxFrameLayer.canvas, x, y);
      }
    }
    return canvas;
  }

  _drawPresentedCanvas(canvas, dx, dy, dw, dh) {
    if (!canvas) return;
    const sw = Math.max(1, canvas.width | 0);
    const sh = Math.max(1, canvas.height | 0);
    const directHq = this.presentationScaleMode === 'browser-hq';
    const staged = this.presentationScaleMode === 'sharp-bilinear' ||
      this.presentationScaleMode === 'sharp-hq';
    if ((!directHq && !staged) ||
        !this._exclusiveFullscreen || !this.ctx || typeof this.ctx.drawImage !== 'function') {
      this._blitSurface(canvas, dx, dy, dw, dh);
      return;
    }

    if (directHq) {
      this._drawBrowserSmoothed(canvas, 0, 0, sw, sh, dx, dy, dw, dh, 'high');
      return;
    }

    const quality = this.presentationScaleMode === 'sharp-hq' ? 'high' : 'low';
    // Below 2x, the integer stage is identical to the source. At an exact
    // integer destination, the fractional stage does not exist. Both cases
    // can be presented directly without changing the requested result.
    const scale = Math.max(1, Math.floor(Math.min(dw / sw, dh / sh)));
    const stageW = sw * scale;
    const stageH = sh * scale;
    if (scale === 1) {
      this._drawBrowserSmoothed(canvas, 0, 0, sw, sh, dx, dy, dw, dh, quality);
      return;
    }
    if (stageW === dw && stageH === dh) {
      this._blitSurface(canvas, dx, dy, dw, dh);
      return;
    }

    // Otherwise first enlarge to the greatest whole-number scale with nearest
    // sampling, then smooth only the small remaining resize.
    let stage = this._presentationScaleCanvas;
    if (!stage || stage.width !== stageW || stage.height !== stageH) {
      stage = this._createOffscreen(stageW, stageH);
      this._presentationScaleCanvas = stage;
    }
    if (!stage) {
      this._blitSurface(canvas, dx, dy, dw, dh);
      return;
    }
    const stageCtx = stage.getContext('2d');
    stageCtx.clearRect(0, 0, stageW, stageH);
    stageCtx.imageSmoothingEnabled = false;
    stageCtx.drawImage(canvas, 0, 0, sw, sh, 0, 0, stageW, stageH);

    this._drawBrowserSmoothed(stage, 0, 0, stageW, stageH, dx, dy, dw, dh, quality);
  }

  _drawBrowserSmoothed(canvas, sx, sy, sw, sh, dx, dy, dw, dh, quality) {
    const previousSmoothing = this.ctx.imageSmoothingEnabled;
    const hasQuality = 'imageSmoothingQuality' in this.ctx;
    const previousQuality = hasQuality ? this.ctx.imageSmoothingQuality : null;
    try {
      this.ctx.imageSmoothingEnabled = true;
      if (hasQuality) this.ctx.imageSmoothingQuality = quality;
      this.ctx.drawImage(canvas, sx, sy, sw, sh, dx, dy, dw, dh);
    } finally {
      this.ctx.imageSmoothingEnabled = previousSmoothing;
      if (hasQuality) this.ctx.imageSmoothingQuality = previousQuality;
    }
  }

  mapCanvasPoint(x, y) {
    const viewport = this._exclusivePresentationViewport;
    if (viewport) {
      const physicalX = x * viewport.outputW / Math.max(1, this.canvas.width);
      const physicalY = y * viewport.outputH / Math.max(1, this.canvas.height);
      return {
        x: Math.floor(viewport.nativeX +
          (physicalX - viewport.dstX) * viewport.nativeW / Math.max(1, viewport.dstW)),
        y: Math.floor(viewport.nativeY +
          (physicalY - viewport.dstY) * viewport.nativeH / Math.max(1, viewport.dstH)),
      };
    }
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
    // A DirectDraw primary attached under DDSCL_EXCLUSIVE is the screen, and
    // it is sized to the display mode (640x480), not to the window (which
    // still carries a caption and a menu bar and so is larger). Without this
    // the size test below threw the presented frame away and installed a fresh
    // COLOR_BTNFACE canvas on every call, which is what made flip2d's spinning
    // cube blink against the window background.
    if (win._backCanvas && win._dxOwnerCanvas === win._backCanvas &&
        this._dxExclusiveHwnd(win) === (hwnd >>> 0)) {
      return { canvas: win._backCanvas, ctx: win._backCtx };
    }
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
  attachWindowSurface(hwnd, canvas, isDirectDraw = false) {
    const win = this.windows[hwnd];
    if (!win || !canvas) return false;
    // Under DDSCL_EXCLUSIVE the DirectDraw primary *is* the display, so the
    // window's ordinary GDI surface must not take the window back. flip2d
    // ("DirectDraw Spinning Cube") uploads its menu bar through that surface
    // 2000+ times a run, and each upload re-attaches: whichever surface
    // happened to attach last owned _backCanvas, and the compositor kept
    // landing on the untouched COLOR_BTNFACE one -- chrome plus an empty grey
    // client area over a perfectly rendered cube.
    // The test is the cooperative level alone, not "a DirectDraw canvas is
    // currently attached": flip2d flips between two surfaces and destroys the
    // old one each frame, so there are instants with no DirectDraw canvas
    // attached at all, and a menu-bar upload landing in one of those made the
    // window blink grey.
    if (isDirectDraw) {
      win._dxOwnerCanvas = canvas;
    } else if (win._dxOwnerCanvas && win._dxOwnerCanvas !== canvas &&
               this._dxExclusiveHwnd(win) === (hwnd >>> 0)) {
      // A native child has no surface of its own: its GDI pixels live in this
      // top-level canvas.  Preserve that canvas without letting ordinary menu
      // or chrome painting displace the exclusive DirectDraw primary.  The
      // exclusive compositor copies only visible child rectangles from it.
      // Keep it even when there is no child yet: a worker can attach the GDI
      // surface before its later CreateWindow(EDIT) host call reaches the UI
      // thread.  Gating retention on the child existing at this instant made
      // AoE I/II's player-name field order-dependent in real-thread mode.
      win._exclusiveGdiChildCanvas = canvas;
      return true;
    }
    if (!isDirectDraw && win._exclusiveGdiChildCanvas === canvas) {
      win._exclusiveGdiChildCanvas = null;
    }
    // A DirectDraw frame presented straight to the window (host-imports'
    // _presentDxSurfaceToMainWindow) parks its pixels in _dxFrameLayer, which
    // repaint() blits *over* the back canvas with alpha 255 everywhere. That
    // layer is only correct while it is the live present path: once a
    // canonical surface attaches here — the point at which a DirectDraw
    // surface DC starts uploading real frames — the old layer is a stale
    // opaque sheet that hides every later frame. SCIFI.SCR uploaded one black
    // layer during startup and then rendered its whole scene through the
    // surface DC, so the screen stayed black while the surface held the
    // picture. Drop the layer; the direct-present path recreates it on demand.
    if (win._dxFrameLayer && win._backCanvas !== canvas) win._dxFrameLayer = null;
    win._backCanvas = canvas;
    win._backCtx = canvas.getContext('2d');
    win._backW = canvas.width | 0;
    win._backH = canvas.height | 0;
    win._canonicalOwnSurface = !!win.isChild;
    return true;
  }

  detachWindowSurface(hwnd, canvas) {
    const win = this.windows[hwnd];
    if (!win) return false;
    if (win._exclusiveGdiChildCanvas === canvas) {
      win._exclusiveGdiChildCanvas = null;
      return true;
    }
    if (win._dxOwnerCanvas === canvas) win._dxOwnerCanvas = null;
    if (win._backCanvas !== canvas) return false;
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
    // A window surface that has never received a pixel upload is not on screen
    // yet — it is the untouched backing a bare GetDC(hwnd) allocated. Screen
    // savers capture the desktop with GetDC(GetDesktopWindow()) + BitBlt right
    // after creating their own still-unpainted fullscreen window; compositing
    // that blank surface hands them a uniform grey capture instead of the
    // desktop they are supposed to texture with (CITYSCAP.SCR).
    if (presentation.targetHwnd && presentation.uploaded === false) return true;
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
      .sort((a, b) => this._compareTopLevelZ(a, b));
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
    const win16Dialog = !!(e.is_win16 && e.is_win16());
    const dluX = win16Dialog ? 2 : this.dluX;
    const dluY = win16Dialog ? 2 : this.dluY;
    const clientW = Math.round(dlgCx * dluX);
    const clientH = Math.round(dlgCy * dluY);
    let x = dlgX === -32768 ? 40 : Math.round(dlgX * dluX);
    let y = Math.round(Math.max(0, dlgY) * dluY);
    let w = isChild ? clientW : clientW + (win16Dialog ? 5 : 8);
    let h = isChild ? clientH : clientH + (win16Dialog ? 24 : 30) + (menuKey ? 18 : 0);
    if (isChild && e.ctrl_get_xy && e.ctrl_get_wh) {
      const xy = e.ctrl_get_xy(hwnd) | 0;
      const wh = e.ctrl_get_wh(hwnd) >>> 0;
      x = (xy << 16) >> 16;
      y = xy >> 16;
      w = wh & 0xFFFF;
      h = (wh >>> 16) & 0xFFFF;
    }
    // x/y at this point are the template's own origin in pixels. Turning that
    // into a screen position -- owner-client relative, DS_ABSALIGN, DS_CENTER,
    // the modal-template-at-origin centering MFC dialogs rely on, and the
    // keep-it-on-the-desktop clamp -- is window placement, so it lives in WAT
    // ($dlg_place_owner_relative), which moves this window through
    // host.move_window immediately after dialog_loaded returns.
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
    // SW_SHOWMINIMIZED / SW_MINIMIZE / SW_SHOWMINNOACTIVE. cmd 2 belongs here
    // as much as 6 and 7 do; without it WAT recorded the window as iconic (it
    // reads the same SW_* code) while the renderer left it on screen.
    if ((cmd === 2 || cmd === 6 || cmd === 7) && !win.isChild) {
      if (!win._minimized) {
        win._minimizeRestoreRect = { x: win.x, y: win.y, w: win.w, h: win.h };
      }
      win.visible = false;
      win._minimized = true;
      this.invalidate(hwnd);
      this.scheduleRepaint();
      return;
    }
    const wasMinimized = !!win._minimized;
    win.visible = (cmd !== 0);
    if (win.visible && win._minimized) {
      if (win._minimizeRestoreRect) Object.assign(win, win._minimizeRestoreRect);
      win._minimized = false;
    }
    // SW_SHOWNORMAL / SW_RESTORE on a maximized window puts back the rect that
    // SW_SHOWMAXIMIZED saved. Without this the renderer stayed maximized while
    // the guest, which asked for normal, was told it was normal. Un-iconifying
    // is one step, though: a window that was maximized when it was minimized
    // comes back maximized, so SW_RESTORE that just un-minimized stops here —
    // the same fold $wnd_apply_show_state applies on the WAT side.
    if ((cmd === 1 || cmd === 9) && !win.isChild && win._maximized &&
        !(wasMinimized && cmd === 9)) {
      if (win._restoreRect) Object.assign(win, win._restoreRect);
      win._maximized = false;
      this._computeClientRect(win);
    }
    if (wasVisible && !win.visible && win.isChild && win.parentHwnd) {
      const restored = this.restoreParentUnderChild(win);
      // The WAT ShowWindow path invalidates the exact newly exposed child
      // rectangle. Re-invalidating the complete top-level tree here defeats
      // that clipping and repeatedly erases unrelated controls during an
      // animated child swap. Keep the full-tree fallback only when no saved
      // parent pixels were available to cover the child immediately.
      if (!restored) {
        let root = this.windows[win.parentHwnd];
        while (root && root.isChild && this.windows[root.parentHwnd]) {
          root = this.windows[root.parentHwnd];
        }
        if (root) this.invalidateVisibleTree(root.hwnd);
      }
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
      // The size to preserve is the one the window had before it was ever
      // maximized -- once _maximized is set, win.{w,h} is the canvas and its
      // aspect says nothing about the app.
      const fitted = this._singleAppMaximizeRect(win, win._restoreRect);
      win._maximized = true;
      if (fitted) {
        win.x = fitted.x; win.y = fitted.y;
        win.w = fitted.w; win.h = fitted.h;
      } else {
        win.x = 0; win.y = 0;
        win.w = this.canvas.width;
        win.h = this.canvas.height;
      }
      this._computeClientRect(win);
    }
    if (win.visible) {
      const isDesktopShell = !win.isChild &&
        String(win.className || '').toLowerCase() === 'progman';
      // Revealing a child places it above its visible siblings. TriPeaks
      // deliberately hides all card windows and shows them from the top row
      // down; the resulting order is what lets each lower row occlude the
      // cards above it. Top-level windows continue through their owner-group
      // ordering below.
      if (win.isChild && !wasVisible) win.zOrder = this._nextZ++;
      if (isDesktopShell) {
        // Progman is the shell's desktop owner, not an ordinary fullscreen
        // popup. Stock Explorer creates and shows the tray first, then calls
        // ShowWindow(Progman); raising it here covered Shell_TrayWnd and every
        // later application. Keep the desktop below all other top-levels.
        const lowest = Object.values(this.windows)
          .filter(candidate => candidate && candidate !== win && !candidate.isChild)
          .reduce((z, candidate) => Math.min(z, candidate.zOrder || 0), 0);
        win.zOrder = lowest - 1;
      } else {
        this._raiseWindowGroup(win);
      }
      if (!win.isChild && !isDesktopShell && this._setKeyboardInputOwner) {
        this._setKeyboardInputOwner(win);
      }
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
      const fitted = this._singleAppMaximizeRect(win, win._restoreRect);
      if (fitted) {
        win.x = fitted.x; win.y = fitted.y;
        win.w = fitted.w; win.h = fitted.h;
      } else {
        win.x = 0; win.y = 0;
        win.w = newW | 0;
        win.h = newH | 0;
      }
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

  setMenu(hwnd, menuResId, watReady = false) {
    const win = this.windows[hwnd];
    if (!win) return;
    const w = win.wasm || this.wasm;
    const we = w && w.exports;
    if (we && we.rsrc_exists) {
      // SetMenu's WAT handler runs before the host callback. A dynamic menu
      // has no RT_MENU resource, but host-window has already serialized its
      // CreateMenu/AppendMenu tree into WAT. Preserve that blob instead of
      // treating the non-resource handle as "no menu" and clearing it.
      if (watReady || (menuResId && we.menu_bar_count && we.menu_bar_count(hwnd) > 0)) {
        win._menuId = menuResId >>> 0;
        win._menuLoaded = true;
        this._computeClientRect(win);
        this.invalidate(hwnd);
        return;
      }
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
    } else if (this._workerPublicationHeld()) {
      // A Worker guest reaches the browser between every brokered host import.
      // Do not expose FillRect/erase from the middle of a WM_PAINT before the
      // following TextOut/Blt calls complete. Cooperative execution gets this
      // atomicity naturally because it blocks the browser for the whole slice;
      // publish the Worker frame at the same completed-slice boundary.
      this._workerRepaintDeferred = true;
    } else {
      this._queueRepaintFrame();
    }
  }

  _queueRepaintFrame() {
    if (this._isNode || this._repaintRaf !== null) return;
    this._repaintRaf = requestAnimationFrame(() => {
      this._repaintRaf = null;
      if (this._workerPublicationHeld()) {
        this._workerRepaintDeferred = true;
        return;
      }
      this._workerRepaintDeferred = false;
      if (this._repaintScheduled) {
        this._profileMark('raf');
        this._repaintScheduled = false;
        this.repaint();
      }
    });
  }

  beginWorkerGuestSlice() {
    this._workerGuestSliceDepth++;
  }

  endWorkerGuestSlice() {
    if (this._workerGuestSliceDepth > 0) this._workerGuestSliceDepth--;
  }

  _workerPublicationHeld() {
    if (this._workerGuestSliceDepth > 0) return true;
    if (this._workerGdiPaintDepth <= 0) return false;
    // A synchronous modal loop can outlive the WM_PAINT that entered it. Its
    // own completed surface must remain usable even though the disabled owner
    // has not reached EndPaint yet. The nested modal loop suspends the outer
    // transaction: publish what the owner drew before entering it, just as a
    // native MessageBox called from WM_PAINT does. A dialog or one of its
    // children that is itself between BeginPaint/EndPaint remains private.
    return !this._workerHasPublishableDialog();
  }

  _workerPaintTreeHeld(rootHwnd) {
    rootHwnd >>>= 0;
    for (const heldHwnd of this._workerGdiPaintHwnds.keys()) {
      let win = this.windows[heldHwnd];
      if (!win) {
        if ((heldHwnd >>> 0) === rootHwnd) return true;
        continue;
      }
      const seen = new Set();
      while (win && !seen.has(win.hwnd >>> 0)) {
        const hwnd = win.hwnd >>> 0;
        if (hwnd === rootHwnd) return true;
        seen.add(hwnd);
        if (!win.parentHwnd) break;
        win = this.windows[win.parentHwnd];
      }
    }
    return false;
  }

  _workerHasPublishableDialog() {
    return Object.values(this.windows).some(win =>
      win && win.visible && win.isDialog && win.clientPainted && win._backCanvas &&
      !this._workerPaintTreeHeld(win.hwnd));
  }

  beginWorkerGdiPaint(hwnd) {
    // BeginPaint/EndPaint is a publication transaction in both schedulers. A
    // cooperative slice blocks the browser while it runs, but it can still end
    // between those two calls; the next rAF would otherwise expose the erase
    // before the following slice draws the controls. Worker mode additionally
    // needs the complete-slice hold because every brokered import yields.
    const key = hwnd >>> 0;
    this._workerGdiPaintHwnds.set(key,
      (this._workerGdiPaintHwnds.get(key) || 0) + 1);
    this._workerGdiPaintDepth++;
  }

  endWorkerGdiPaint(hwnd) {
    const key = hwnd >>> 0;
    const count = this._workerGdiPaintHwnds.get(key) || 0;
    if (!count) return;
    if (count === 1) this._workerGdiPaintHwnds.delete(key);
    else this._workerGdiPaintHwnds.set(key, count - 1);
    if (this._workerGdiPaintDepth > 0) this._workerGdiPaintDepth--;
    if (!this._workerPublicationHeld() && this._repaintScheduled) {
      this._workerRepaintDeferred = false;
      this._queueRepaintFrame();
    }
  }

  flushRepaint(force = false) {
    if (force && !this._isNode) {
      // The browser drive loop calls this once per step, and a composite is a
      // full-desktop one: sort every window, re-sync its style, blit every
      // back-canvas. Forcing it here meant a completely idle app did all of
      // that 60 times a second.
      //
      // Nothing is lost by skipping: every path that changes what is on screen
      // already calls scheduleRepaint(). Guest pixels go through a GDI surface
      // whose onDirty hook schedules one, and geometry/z-order/visibility
      // changes schedule one directly. If neither happened, the previous frame
      // is still correct.
      if (!this._repaintScheduled && !this._repaintPending) return;
      if (this._workerPublicationHeld()) {
        this._workerRepaintDeferred = true;
        return;
      }
      // A queued rAF commonly becomes due only after the next Worker slice
      // has started, defers, and loses the same race again indefinitely. At a
      // completed slice boundary we already have the one safe publication
      // point. Use it directly when a display frame is due, capped at roughly
      // 60 Hz so a hot DirectDraw loop does not composite every 12ms slice.
      const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
      if (now - this._workerLastCompositeAt >= 16) {
        this._workerRepaintDeferred = false;
        this._repaintScheduled = false;
        this._workerLastCompositeAt = now;
        this.repaint();
        return;
      }
      if (!this._workerPublicationHeld() && this._workerRepaintDeferred &&
          this._repaintRaf === null) {
        this._workerRepaintDeferred = false;
        this._queueRepaintFrame();
      }
      this.scheduleRepaint();
      return;
    }
    if (this._repaintScheduled || force) {
      this._repaintScheduled = false;
      this.repaint();
    }
  }

  repaint() {
    // repaint() is also called directly by window-management and input paths
    // (ShowWindow is the Half-Life menu case), not only through
    // scheduleRepaint(). A brokered call can reach those paths while the guest
    // Worker is still in the middle of a slice, so guard the complete slice as
    // well as an explicit BeginPaint/EndPaint transaction. Publishing here
    // exposes whichever erase/blit happened to precede the broker round trip.
    if (this._workerPublicationHeld()) {
      this._repaintScheduled = true;
      this._workerRepaintDeferred = true;
      return;
    }
    if (this._repainting) {
      // Nested repaint request (e.g. a GDI surface upload →
      // scheduleRepaint → repaint while we're already painting). Drop a
      // flag so the outer repaint re-runs once it finishes.
      this._repaintPending = true;
      return;
    }
    this._profileMark('repaint-start');
    if (!this._isNode && this._workerGuestSliceDepth === 0) {
      this._workerLastCompositeAt =
        (typeof performance !== 'undefined' && performance.now)
          ? performance.now() : Date.now();
    }
    this._repainting = true;
    try {
      this._repaintOnce();
      // Requests that arrived mid-paint used to be replayed here, up to four
      // more full-desktop composites inside one repaint(). That is why Space
      // Cadet Pinball measured 299 composites a second against 59.8 page
      // frames: the rAF pacing above was working perfectly, and each of its
      // sixty repaint() calls was quietly doing five composites.
      //
      // Every one of those replays was redundant, and measurably so. A mid-
      // paint request on an *idle* Notepad arrives six times per composite,
      // from exactly one place:
      //
      //   _repaintOnce -> gdi_surface_upload -> GdiSurface.markDirty
      //     -> surface.onDirty -> _scheduleGdiPresentation -> scheduleRepaint
      //
      // — the composite telling itself that the surface it just uploaded has
      // changed. The pixels that notification is about are already being
      // painted by the composite that triggered it, so replaying it paints
      // identical state to the same screen. Measured on idle Notepad: 360
      // mid-paint requests a second, all from that one stack, and none from
      // any other caller.
      //
      // So drop them, which is what the old code did anyway — its `finally`
      // cleared the flag, discarding whatever was still pending after the
      // fourth replay. This discards it after the zeroth. A request that
      // genuinely represents new pixels comes from a path outside the
      // composite, and that path calls scheduleRepaint() again on its own.
      this._presentDisplayCanvas();
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
      .sort((a, b) => this._compareTopLevelZ(a, b));
    const top = sorted[sorted.length - 1];
    // Taking over the page is a single-app decision. ?debug keeps the shell up
    // and lets a second app be launched over a fullscreen game; without the
    // toolbar the desktop icons and the taskbar are the only launcher there
    // is, and exclusive mode hides both -- so a game that grabbed the display
    // would strand every other window behind a black rectangle with no way
    // back. A second app's window on screen means the desktop is in use, and
    // the game goes back to being one window among several.
    const exclusive = this._isExclusiveFullscreenWindow(top) &&
      !sorted.some(w => w !== top && w.wasm && top.wasm && w.wasm !== top.wasm);
    if (this.traceComposite) {
      console.log(`[composite] path=${exclusive ? 'exclusive' : 'normal'} windows=${sorted.length}` +
        sorted.map(w => ` hwnd=0x${(w.hwnd >>> 0).toString(16)}@${w.x},${w.y} ${w.w}x${w.h}` +
          `${w._backCanvas ? ' back' : ''}${w._dxFrameLayer ? ' dxLayer' : ''}` +
          `${w.region ? ' shaped' : ''}`).join(''));
    }
    this._setExclusiveFullscreen(exclusive);
    if (exclusive && top) {
      // Scale the stack by the *display*, not by whatever popup happens to sit
      // on top of it. Diablo's menu dialog is 640x482 over a 640x480 mode, and
      // letting it set the transform stretched every presented frame by 482/480
      // and pushed the bottom two rows off the canvas.
      const exclusiveHwnd = this._dxExclusiveHwnd(top);
      const base = (exclusiveHwnd && this.windows[exclusiveHwnd] &&
                    sorted.indexOf(this.windows[exclusiveHwnd]) >= 0)
        ? this.windows[exclusiveHwnd]
        : top;
      this._exclusiveTransform = this._computeExclusiveTransform(base);
      this._exclusivePresentationViewport =
        this._computeExclusivePresentationViewport(this._exclusiveTransform);
    } else {
      this._exclusiveTransform = null;
      this._exclusivePresentationViewport = null;
      this._exclusivePresentationSource = null;
      if (this.singleAppMode) {
        const zoom = this._computeSingleAppZoom(sorted);
        if (zoom && zoom.viewport) {
          this._exclusiveTransform = zoom.transform;
          this._exclusivePresentationViewport = zoom.viewport;
        }
      }
    }

    // Fill entire desktop (or clear to transparent if HTML desktop is below)
    if (this._exclusiveFullscreen) {
      this._exclusivePresentationSource = null;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      // A DirectDraw exclusive-fullscreen game keeps presenting into its own
      // window while the application stacks ordinary top-level windows over
      // it: Storm puts every Diablo menu on a screen-sized SDlgDialog popup
      // that owns the game window. On real hardware those share one screen —
      // the popup has a NULL class brush, so the primary surface shows
      // through wherever it does not draw. Composite the whole fullscreen
      // stack through the same transform instead of only the topmost window,
      // or the frame underneath is simply gone.
      const t = this._exclusiveTransform;
      let baseIdx = sorted.length - 1;
      while (baseIdx > 0 && this._isExclusiveFullscreenWindow(sorted[baseIdx - 1])) {
        baseIdx--;
      }
      const stack = top ? sorted.slice(baseIdx) : [];
      // The newest DirectDraw present anywhere in the fullscreen stack. Every
      // window here shares one primary surface on real hardware, so a child
      // surface older than this has already been painted over.
      let presentSeq = 0;
      for (const win of stack) {
        const layer = win._dxFrameLayer;
        if (layer && (layer.writeSeq | 0) > presentSeq) presentSeq = layer.writeSeq | 0;
      }
      let drawn = 0;
      for (const win of stack) {
        this.wasm = win.wasm;
        this.wasmMemory = win.wasmMemory;
        this.drawWindow(win);
        if (!win._backCanvas) continue;
        drawn++;
        const sx = t.dstW / Math.max(1, t.srcW);
        const sy = t.dstH / Math.max(1, t.srcH);
        const dx = t.dstX + Math.floor((win.x - t.srcX) * sx);
        const dy = t.dstY + Math.floor((win.y - t.srcY) * sy);
        const dw = Math.max(1, Math.floor(win._backCanvas.width * sx));
        const dh = Math.max(1, Math.floor(win._backCanvas.height * sy));
        this._flushCanonicalCanvas(win._backCanvas);
        // A window in this stack whose GDI surface predates the newest present
        // has already been painted over: every window here shares one primary
        // surface on real hardware, and these popups carry no clipping style
        // that would protect them from a full-screen blit. Diablo's menu
        // dialogs are the case that needs it — their SDlgStatic children erase
        // with LTGRAY_BRUSH, and those erases came out as grey slabs sitting
        // permanently over the artwork. The app's next WM_PAINT restamps the
        // surface and it composites again.
        if (!presentSeq || (win._gdiWriteSeq | 0) >= presentSeq) {
          this._drawPresentedCanvas(win._backCanvas, dx, dy, dw, dh);
        }
        if (win._dxFrameLayer && win._dxFrameLayer.canvas) {
          this._drawPresentedCanvas(win._dxFrameLayer.canvas, dx, dy, dw, dh);
        }
        this._compositeExclusiveSharedChildren(win, t);
        this._compositeChildSurfaces(win, t, presentSeq);
      }
      if (drawn && top && top._backCanvas) {
        this._exclusivePresentationSource = this._buildExclusivePresentationSource(top);
      }
      this.updateTaskbar();
      this._profileFinish('canvas-composited', { windows: drawn, exclusive: true });
      return;
    } else if (this.transparentDesktop) {
      // The normal browser desktop is an HTML layer below this canvas so its
      // icons stay behind application windows.  Keep the canvas background
      // transparent even when software GDI has attached an opaque canonical
      // desktop surface; otherwise launching the first app covers the icons.
      this.surface.clear(0, 0, this.canvas.width, this.canvas.height);
    } else if (this._desktopSurfaceCanvas) {
      this._flushCanonicalCanvas(this._desktopSurfaceCanvas);
      this._blitSurface(this._desktopSurfaceCanvas, 0, 0,
        this.canvas.width, this.canvas.height);
    } else if (this._paintWallpaper(ctx)) {
      // Wallpaper painted the desktop background.
    } else {
      this.surface.fill(0, 0, this.canvas.width, this.canvas.height, this.colors.desktop);
    }

    // Composite windows back-to-front: chrome + offscreen client canvas
    for (const win of sorted) {
      // Context Switch: ensure renderer uses this window's owner WASM
      this.wasm = win.wasm;
      this.wasmMemory = win.wasmMemory;

      // Non-rectangular windows (Winamp skins, rounded corners) arrive from
      // WAT as a band list, which is why clipping here is rectangles.
      const shaped = win.region && win.region.rects;
      this.surface.pushClip(shaped
        ? win.region.rects.map(r => ({ x: win.x + r.x, y: win.y + r.y, w: r.w, h: r.h }))
        : { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height });

      // Draw chrome overlays that are not part of the DefWindowProc NC pass
      // (currently the WAT-owned menu bar) before compositing.
      this.drawWindow(win);
      // Composite the back canvas on top — transparent areas let chrome
      // show through, opaque areas (app drawing) cover it. This handles
      // both GetDC (client area) and GetWindowDC (custom skin) drawing.
      if (win._backCanvas) {
        this._flushCanonicalCanvas(win._backCanvas);
        this._blitSurface(win._backCanvas, win.x, win.y,
          win._backCanvas.width, win._backCanvas.height);
        if (win._dxFrameLayer && win._dxFrameLayer.canvas) {
          const dxc = win._dxFrameLayer.canvas;
          this._blitSurface(dxc, win.x, win.y, dxc.width, dxc.height);
        }
      }
      this._compositeChildSurfaces(win);
      this.surface.popClip();
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
    if (!r || r.w <= 0 || r.h <= 0 || !this.surface) return;
    const x = Math.round(r.x);
    const y = Math.round(r.y);
    const w = Math.max(0, Math.round(r.w));
    const h = Math.max(0, Math.round(r.h));
    // Win98's rubber band is a marching black/white dashed outline. Drawing it
    // as an inversion means it stays legible over the desktop, over a window,
    // or over whatever the app happens to be painting underneath.
    this.surface.invert(x, y, w, 1);
    this.surface.invert(x, y + h - 1, w, 1);
    this.surface.invert(x, y + 1, 1, Math.max(0, h - 2));
    this.surface.invert(x + w - 1, y + 1, 1, Math.max(0, h - 2));
  }

  // The caret's rectangle in canvas pixels, or null when nothing has focus.
  // Updated on every composite; the on-screen keyboard handling uses it to
  // decide how far to lift the screen.
  caretRect() {
    return this._focusCaretRect;
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
    // Where the text is going, in canvas pixels. On a phone this is what the
    // on-screen keyboard has to be kept clear of, and it is the only thing
    // that knows which part of a maximized app the user is actually using.
    // Cleared each pass so it follows focus rather than going stale.
    this._focusCaretRect = null;
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

      const px = origin.x + x;
      const py = origin.y + y;
      const clipW = Math.max(0, win.w | 0);
      const clipH = Math.max(0, win.h | 0);
      if (!clipW || !clipH) continue;
      state.rect = { x: px, y: py, w, h, clipX: origin.x, clipY: origin.y, clipW, clipH };
      // Blink phase deliberately does not gate this: the caret is still where
      // the typing is on the half-second it is not painted.
      if (!this._focusCaretRect) this._focusCaretRect = { x: px, y: py, w, h };
      if (!state.phase) continue;
      this._fillCaretRect(state.rect);
    }
    this._caretBlinkActiveStates = activeStates;
    if (!activeStates.size) this._focusCaretRect = null;
    this._scheduleCaretBlink(activeStates.size > 0);
  }

  // A Win32 caret is XOR/inverted against the target pixels, not simply painted
  // into the backing store. Canvas "difference" with white gives the same
  // visible inversion — and because inversion is its own undo, the blink can
  // toggle the caret in place instead of recompositing the whole desktop.
  _fillCaretRect(r) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.clipX, r.clipY, r.clipW, r.clipH);
    ctx.clip();
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();
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
      // Toggling in place, rather than through scheduleRepaint(), is the whole
      // point: a blink is one 1x13 rect, not a reason to refill the desktop,
      // re-blit every window's back-canvas and rebuild the taskbar DOM.
      let live = 0;
      for (const state of this._caretBlinkActiveStates) {
        state.phase = !state.phase;
        if (state.rect) { this._fillCaretRect(state.rect); live++; }
      }
      if (!live) this.scheduleRepaint();
      else {
        // The toggle lands on the working canvas, which is not necessarily
        // what the page shows: with a presentation filter in play, the screen
        // keeps the last presented frame until something presents again. Push
        // the frame -- one scaled blit, still far short of a full repaint --
        // or the caret only appears to blink when the guest happens to paint.
        this._presentDisplayCanvas();
        this._scheduleCaretBlink(true);
      }
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
        } else if (this._isForegroundWindow(win)) {
          // Only the window already in front minimizes. Toggling on any click
          // meant a covered window could not be brought forward at all, and
          // two windows at the same coordinates -- two copies of one app on
          // the tab's LAN, say -- left no way to reach the one underneath.
          win.visible = false;
          win._minimized = true;
        } else {
          this._raiseWindowGroup(win);
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

  // Geometry of the dropdown WAT currently has open, without painting it:
  // `{ menu, win, top, hover, subHover, dx, dy, rects }` in screen coords, or
  // null when no menu is open. A dropdown is drawn onto the desktop canvas
  // rather than into any window's back-canvas, so the single-app zoom has to
  // ask for its rectangle separately or it crops the popup off.
  _openMenuGeometry() {
    const menu = this._openMenuContext ? this._openMenuContext() : null;
    if (!menu) return null;
    const e = menu.exports;
    const hwnd = menu.hwnd | 0;
    const win = this.windows[hwnd];
    if (!win || !e.menu_bar_item_x) return null;
    const top = e.menu_open_top() | 0;
    if (top < 0) return null;
    const pos = this._menuBarPos(win);
    if (!pos) return null;
    const hover = e.menu_open_hover() | 0;
    const subHover = e.menu_open_sub_hover ? (e.menu_open_sub_hover() | 0) : -1;
    const explicitX = e.menu_open_x ? (e.menu_open_x() | 0) : -1;
    const explicitY = e.menu_open_y ? (e.menu_open_y() | 0) : -1;
    const dx = explicitX >= 0 ? explicitX : pos.barX + (e.menu_bar_item_x(hwnd, top) | 0);
    const dy = explicitY >= 0 ? explicitY : pos.barY + pos.barH;
    const height = e.menu_dropdown_height ? (e.menu_dropdown_height(hwnd, top) | 0) : 0;
    const width = e.menu_dropdown_width ? (e.menu_dropdown_width(hwnd, top) | 0) : 180;
    const rects = [];
    if (height > 0 && width > 0) rects.push({ x: dx, y: dy, w: width, h: height });
    if (hover >= 0 && e.menu_child_sub_count) {
      const count = e.menu_child_sub_count(hwnd, top, hover) | 0;
      const subWidth = e.menu_submenu_width
        ? (e.menu_submenu_width(hwnd, top, hover) | 0) : 180;
      if (count > 0 && subWidth > 0) {
        rects.push({ x: dx + width, y: dy + 2 + hover * 20,
          w: subWidth, h: count * 20 + 4 });
      }
    }
    return { menu, win, top, hover, subHover, dx, dy, rects };
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
    const geom = this._openMenuGeometry();
    if (!geom) {
      this._dropdownOverlayPaintState = null;
      return;
    }
    let painted = false;
    let overlay = null;
    let rects = geom.rects;
    const prevWasm = this.wasm;
    const prevMemory = this.wasmMemory;
    try {
      const w = geom.menu.wasm;
      const e = geom.menu.exports;
      const hwnd = geom.menu.hwnd | 0;
      const win = geom.win;
      if (!e.menu_paint_dropdown) return;
      this.wasm = w;
      this.wasmMemory = win.wasmMemory;
      const { top, hover, subHover, dx, dy } = geom;
      if (!e.menu_prepare_overlay || !e.menu_prepare_overlay()) return;
      overlay = this._dropdownOverlay;
      if (!overlay || overlay.canvas.width !== sw || overlay.canvas.height !== sh) return;
      const rectKey = rects.map(r => `${r.x},${r.y},${r.w},${r.h}`).join(';');
      const key = [hwnd, top, hover, subHover, dx, dy, sw, sh, rectKey].join(':');
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
