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
    this._nextZ = 1;
    this._isNode = (typeof window === 'undefined');
    this._exclusiveFullscreen = false;
    this._requestedBrowserFullscreen = false;
    this._exclusiveTransform = null;
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
      else try { const { Canvas } = require('skia-canvas'); cvs = new Canvas(w, h); }
        catch (e) { return null; }
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
    return hwnd;
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
        win.clientRect = {
          x: e.wnd_client_screen_x(win.hwnd) | 0,
          y: e.wnd_client_screen_y(win.hwnd) | 0,
          w: r - l,
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
        win.clientRect = { x: win.x + l, y: win.y + t, w: r - l, h: b - t };
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
    if (!win || !win.isChild) return false;
    if (win.isDialog || win.className === 'Button') return true;
    const className = String(win.className || '').toLowerCase();
    if (className === 'systreeview32' || className === 'syslistview32') return true;
    const e = (win.wasm || this.wasm) && (win.wasm || this.wasm).exports;
    try {
      const cls = e && e.ctrl_get_class ? (e.ctrl_get_class(win.hwnd) | 0) : 0;
      return cls === 1 || cls === 8 || cls === 18;
    } catch (_) {
      return false;
    }
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
      .filter(child => child && child.visible && child.parentHwnd === parent.hwnd && this._usesOwnWindowSurface(child))
      .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
    const prevWasm = this.wasm;
    const prevMemory = this.wasmMemory;
    try {
      for (const child of children) {
        this.wasm = child.wasm;
        this.wasmMemory = child.wasmMemory;
        this._ensureListViewFallbackSurface(child);
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
            this.ctx.drawImage(
              snapshot.canvas,
              transform.dstX + Math.floor((parentPos.x + snapshot.x - transform.srcX) * sx),
              transform.dstY + Math.floor((parentPos.y + snapshot.y - transform.srcY) * sy),
              Math.max(1, Math.floor(snapshot.w * sx)),
              Math.max(1, Math.floor(snapshot.h * sy))
            );
          } else {
            this.ctx.drawImage(snapshot.canvas, parentPos.x + snapshot.x, parentPos.y + snapshot.y);
          }
        }
        if (child._backCanvas) {
          const pos = this._windowOriginForComposite(child);
          if (transform) {
            const sx = transform.dstW / Math.max(1, transform.srcW);
            const sy = transform.dstH / Math.max(1, transform.srcH);
            this.ctx.drawImage(
              child._backCanvas,
              transform.dstX + Math.floor((pos.x - transform.srcX) * sx),
              transform.dstY + Math.floor((pos.y - transform.srcY) * sy),
              Math.max(1, Math.floor(child._backCanvas.width * sx)),
              Math.max(1, Math.floor(child._backCanvas.height * sy))
            );
            if (child._dxFrameLayer && child._dxFrameLayer.canvas) {
              this.ctx.drawImage(
                child._dxFrameLayer.canvas,
                transform.dstX + Math.floor((pos.x - transform.srcX) * sx),
                transform.dstY + Math.floor((pos.y - transform.srcY) * sy),
                Math.max(1, Math.floor(child._dxFrameLayer.canvas.width * sx)),
                Math.max(1, Math.floor(child._dxFrameLayer.canvas.height * sy))
              );
            }
          } else {
            this.ctx.drawImage(child._backCanvas, pos.x, pos.y);
            if (child._dxFrameLayer && child._dxFrameLayer.canvas) {
              this.ctx.drawImage(child._dxFrameLayer.canvas, pos.x, pos.y);
            }
          }
        }
        this._compositeChildSurfaces(child, transform);
      }
    } finally {
      this.wasm = prevWasm;
      this.wasmMemory = prevMemory;
    }
  }

  _ensureListViewFallbackSurface(win) {
    const className = String(win && win.className || '').toLowerCase();
    if (className !== 'syslistview32' || win.clientPainted) return;
    if (win.w <= 0 || win.h <= 0) return;
    if (win._backCanvas && win._backW === win.w && win._backH === win.h) return;
    const wc = this.getWindowCanvas(win.hwnd);
    if (!wc || !wc.ctx) return;
    const ctx = wc.ctx;
    const w = Math.max(1, win.w | 0);
    const h = Math.max(1, win.h | 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, w, 1);
    ctx.fillRect(0, 0, 1, h);
    ctx.fillStyle = '#404040';
    ctx.fillRect(1, 1, Math.max(0, w - 2), 1);
    ctx.fillRect(1, 1, 1, Math.max(0, h - 2));
    ctx.fillStyle = '#dfdfdf';
    ctx.fillRect(1, h - 2, Math.max(0, w - 2), 1);
    ctx.fillRect(w - 2, 1, 1, Math.max(0, h - 2));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, h - 1, w, 1);
    ctx.fillRect(w - 1, 0, 1, h);
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
        if (!document.fullscreenElement && target && target.requestFullscreen) {
          this._requestedBrowserFullscreen = true;
          try {
            const p = target.requestFullscreen();
            if (p && p.then) p.then(() => { if (resize) resize(); }).catch(() => {});
          } catch (_) {}
        }
        if (resize) resize();
      } else if (this._requestedBrowserFullscreen && document.fullscreenElement === target && document.exitFullscreen) {
        this._requestedBrowserFullscreen = false;
        try {
          const p = document.exitFullscreen();
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
    const clientW = Math.round(dlgCx * this.dluX);
    const clientH = Math.round(dlgCy * this.dluY);
    let x = dlgX === -32768 ? 40 : Math.round(dlgX * this.dluX);
    let y = Math.round(Math.max(0, dlgY) * this.dluY);
    let w = isChild ? clientW : clientW + 8;
    let h = isChild ? clientH : clientH + 30;
    if (isChild && e.ctrl_get_xy && e.ctrl_get_wh) {
      const xy = e.ctrl_get_xy(hwnd) | 0;
      const wh = e.ctrl_get_wh(hwnd) >>> 0;
      x = (xy << 16) >> 16;
      y = xy >> 16;
      w = wh & 0xFFFF;
      h = (wh >>> 16) & 0xFFFF;
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
    const menuKey = e.dlg_get_menu(hwnd);
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
    return hwnd;
  }

  showWindow(hwnd, cmd) {
    const win = this.windows[hwnd];
    if (!win) return;
    const wasVisible = !!win.visible;
    win.visible = (cmd !== 0);
    if (wasVisible && !win.visible && win.isChild && win.parentHwnd) {
      this.restoreParentUnderChild(win);
      this.queuePaint(win.parentHwnd);
      this.invalidate(win.parentHwnd);
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
      win.zOrder = this._nextZ++;  // bring to front
      this.invalidate(hwnd);
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
      // Nested repaint request (e.g. gdi_draw_text → _getDrawTarget →
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
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
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

      // Browser GDI can deliver client/background draws after the queued
      // non-client paint has already populated the back-canvas. Real USER
      // clips client DCs away from the frame; refresh the WAT-owned non-client
      // band before final menu/composite so a stale client fill cannot erase
      // caption, frame, or sysbuttons on screen.
      const e = (win.wasm || this.wasm) && (win.wasm || this.wasm).exports;
      if (!win.isChild && !win.region && this._hasCaption(win) && e && e.nc_repaint_now) {
        e.nc_repaint_now(win.hwnd);
      }
      // Draw chrome overlays that are not part of the DefWindowProc NC pass
      // (currently the WAT-owned menu bar) before compositing.
      this.drawWindow(win);
      // Composite the back canvas on top — transparent areas let chrome
      // show through, opaque areas (app drawing) cover it. This handles
      // both GetDC (client area) and GetWindowDC (custom skin) drawing.
      if (win._backCanvas) {
        ctx.drawImage(win._backCanvas, win.x, win.y);
        if (win._dxFrameLayer && win._dxFrameLayer.canvas) {
          ctx.drawImage(win._dxFrameLayer.canvas, win.x, win.y);
        }
      }
      this._compositeChildSurfaces(win);
      ctx.restore();
    }

    // Draw dropdown overlay on top of everything (if any menu is open)
    this._menuPaintDropdown();

    // Update HTML taskbar buttons
    this.updateTaskbar();
    this._profileFinish('canvas-composited', { windows: sorted.length });
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
          win.zOrder = this._nextZ++;
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
    let overlay = this._dropdownOverlay;
    if (!overlay || overlay.canvas.width !== sw || overlay.canvas.height !== sh) {
      const c = this._createOffscreen(sw, sh);
      overlay = this._dropdownOverlay = { canvas: c, ctx: c.getContext('2d') };
    }
    let painted = false;
    const prevWasm = this.wasm;
    const prevMemory = this.wasmMemory;
    const wasms = new Set(Object.values(this.windows).map(w => w.wasm).filter(Boolean));
    try {
      for (const w of wasms) {
        this.wasm = w;
        const e = w.exports;
        if (!e || !e.menu_paint_dropdown || !e.menu_open_hwnd || !e.menu_bar_item_x) continue;
        const hwnd = e.menu_open_hwnd() | 0;
        if (!hwnd) continue;
        const win = this.windows[hwnd];
        if (!win) continue;
        this.wasmMemory = win.wasmMemory;
        const top = e.menu_open_top() | 0;
        if (top < 0) continue;
        const hover = e.menu_open_hover() | 0;
        const explicitX = e.menu_open_x ? (e.menu_open_x() | 0) : -1;
        const explicitY = e.menu_open_y ? (e.menu_open_y() | 0) : -1;
        const pos = this._menuBarPos(win);
        if (!pos) continue;
        const { barX, barY, barH } = pos;
        const dx = explicitX >= 0 ? explicitX : barX + (e.menu_bar_item_x(hwnd, top) | 0);
        const dy = explicitY >= 0 ? explicitY : barY + barH;
        if (!painted) { overlay.ctx.clearRect(0, 0, sw, sh); painted = true; }
        this._activeChildDraw = { canvas: overlay.canvas, ctx: overlay.ctx, ox: 0, oy: 0, hwnd };
        try { e.menu_paint_dropdown(hwnd, top, dx, dy, hover); }
        finally { this._activeChildDraw = null; }
        if (w !== this.mainWasm && explicitX >= 0 && explicitY >= 0) {
          this._menuPaintDropdownJs(overlay.ctx, e, win.wasmMemory || this.wasmMemory, hwnd, top, dx, dy, hover);
        }
      }
    } finally {
      this.wasm = prevWasm;
      this.wasmMemory = prevMemory;
    }
    if (painted) this.ctx.drawImage(overlay.canvas, 0, 0);
  }

  _menuReadAscii(memory, ptr, len) {
    if (!memory || !memory.buffer || !ptr || len <= 0) return '';
    const bytes = new Uint8Array(memory.buffer);
    if (ptr < 0 || ptr >= bytes.length) return '';
    let s = '';
    const end = Math.min(bytes.length, ptr + len);
    for (let p = ptr; p < end; p++) s += String.fromCharCode(bytes[p]);
    return s;
  }

  _menuFormatText(raw) {
    const src = raw == null ? '' : String(raw);
    const tab = src.indexOf('\t');
    const labelSrc = tab >= 0 ? src.slice(0, tab) : src;
    const shortcutSrc = tab >= 0 ? src.slice(tab + 1) : '';
    const label = this._menuStripMnemonic(labelSrc, true);
    const shortcut = this._menuStripMnemonic(shortcutSrc, false);
    return { text: label.text, shortcut: shortcut.text, underline: label.underline };
  }

  _menuStripMnemonic(raw, trackUnderline) {
    let text = '';
    let underline = -1;
    const src = raw == null ? '' : String(raw);
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch !== '&') {
        text += ch;
        continue;
      }
      const next = src[i + 1];
      if (next === '&') {
        text += '&';
        i++;
        continue;
      }
      if (next && trackUnderline && underline < 0) underline = text.length;
    }
    return { text, underline };
  }

  _menuDrawText(ctx, text, x, y, underline) {
    ctx.fillText(text, x, y);
    if (underline < 0 || underline >= text.length || !ctx.measureText) return;
    const before = text.slice(0, underline);
    const ch = text[underline];
    const ux = x + ctx.measureText(before).width;
    const uw = Math.max(1, Math.ceil(ctx.measureText(ch).width));
    ctx.fillRect(Math.round(ux), Math.round(y + 6), uw, 1);
  }

  _menuPaintDropdownJs(ctx, e, memory, hwnd, top, dx, dy, hover) {
    if (!e || !e.menu_child_count || !e.menu_child_label_ptr || !e.menu_child_label_len) return;
    const count = e.menu_child_count(hwnd, top) | 0;
    if (count <= 0) return;
    const width = 180;
    const itemH = 20;
    const drawFrame = (x, y, rows) => {
      const height = rows * itemH + 4;
      ctx.fillStyle = '#c0c0c0';
      ctx.fillRect(x, y, width, height);
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(x, y + height - 1);
      ctx.lineTo(x, y);
      ctx.lineTo(x + width - 1, y);
      ctx.stroke();
      ctx.strokeStyle = '#404040';
      ctx.beginPath();
      ctx.moveTo(x + width - 1, y);
      ctx.lineTo(x + width - 1, y + height - 1);
      ctx.lineTo(x, y + height - 1);
      ctx.stroke();
    };
    const drawCheck = (x, y, active) => {
      ctx.strokeStyle = active ? '#ffffff' : '#000000';
      ctx.beginPath();
      ctx.moveTo(x + 5, y + 10);
      ctx.lineTo(x + 8, y + 14);
      ctx.lineTo(x + 14, y + 6);
      ctx.moveTo(x + 5, y + 11);
      ctx.lineTo(x + 8, y + 15);
      ctx.lineTo(x + 14, y + 7);
      ctx.stroke();
    };
    const drawArrow = (x, y, active) => {
      ctx.fillStyle = active ? '#ffffff' : '#000000';
      ctx.beginPath();
      ctx.moveTo(x + width - 14, y + 6);
      ctx.lineTo(x + width - 8, y + 10);
      ctx.lineTo(x + width - 14, y + 14);
      ctx.closePath();
      ctx.fill();
    };
    const drawRows = (x, y, rows, rowHover, getFlags, getLabel, getShortcut, hasSubmenu) => {
      drawFrame(x, y, rows);
      for (let i = 0; i < rows; i++) {
        const iy = y + 2 + i * itemH;
        const flags = getFlags(i) | 0;
        if (flags & 0x01) {
          ctx.fillStyle = '#808080';
          ctx.fillRect(x + 4, iy + 9, width - 8, 1);
          continue;
        }
        const isHover = i === rowHover;
        if (isHover) {
          ctx.fillStyle = '#000080';
          ctx.fillRect(x + 2, iy, width - 4, itemH);
        }
        const disabled = !!(flags & 0x02);
        ctx.fillStyle = isHover ? '#ffffff' : (disabled ? '#808080' : '#000000');
        if (flags & 0x04) drawCheck(x, iy, isHover);
        const label = this._menuFormatText(getLabel(i));
        this._menuDrawText(ctx, label.text, x + 20, iy + 10, label.underline);
        const explicitShortcut = getShortcut ? getShortcut(i) : '';
        const shortcut = explicitShortcut ? this._menuFormatText(explicitShortcut).text : label.shortcut;
        if (shortcut) {
          ctx.textAlign = 'right';
          ctx.fillText(shortcut, x + width - 20, iy + 10);
          ctx.textAlign = 'left';
        }
        if (hasSubmenu && hasSubmenu(i)) drawArrow(x, iy, isHover);
      }
    };

    ctx.save();
    ctx.font = '11px "W95FA", "Microsoft Sans Serif", "MS Sans Serif", Tahoma, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    drawRows(
      dx,
      dy,
      count,
      hover,
      i => e.menu_child_flags ? (e.menu_child_flags(hwnd, top, i) | 0) : 0,
      i => this._menuReadAscii(memory, e.menu_child_label_ptr(hwnd, top, i) >>> 0, e.menu_child_label_len(hwnd, top, i) | 0),
      i => {
        if (!e.menu_child_shortcut_ptr || !e.menu_child_shortcut_len) return '';
        const len = e.menu_child_shortcut_len(hwnd, top, i) | 0;
        return len > 0 ? this._menuReadAscii(memory, e.menu_child_shortcut_ptr(hwnd, top, i) >>> 0, len) : '';
      },
      i => (e.menu_child_sub_count && (e.menu_child_sub_count(hwnd, top, i) | 0) > 0) ||
           !!((e.menu_child_flags ? (e.menu_child_flags(hwnd, top, i) | 0) : 0) & 0x08)
    );

    if (hover >= 0 && e.menu_child_sub_count && e.menu_subchild_label_ptr && e.menu_subchild_label_len) {
      const subCount = e.menu_child_sub_count(hwnd, top, hover) | 0;
      if (subCount > 0) {
        const subHover = e.menu_open_sub_hover ? (e.menu_open_sub_hover() | 0) : -1;
        drawRows(
          dx + width,
          dy + 2 + hover * itemH,
          subCount,
          subHover,
          i => e.menu_subchild_flags ? (e.menu_subchild_flags(hwnd, top, hover, i) | 0) : 0,
          i => this._menuReadAscii(memory, e.menu_subchild_label_ptr(hwnd, top, hover, i) >>> 0, e.menu_subchild_label_len(hwnd, top, hover, i) | 0),
          null,
          null
        );
      }
    }
    ctx.restore();
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
