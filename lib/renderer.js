// Win98Renderer — shared between browser and Node (node-canvas)
// Usage: new Win98Renderer(canvas) where canvas is either a DOM <canvas> or node-canvas instance

class Win98Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    // (no pre-parsed resource table — resource access goes through WAT
    //  exports: dlg_get_*, ctrl_get_*, rsrc_exists, rsrc_find_data_wa.)
    this.windows = {};
    this.inputQueue = [];
    this.dirtyWindows = new Set();
    this._repaintScheduled = false;
    this._nextZ = 1;
    this._isNode = (typeof window === 'undefined');

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

    // Offscreen canvas factory (works in browser and Node with node-canvas)
    this._createOffscreen = (w, h) => {
      if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
      try { const { createCanvas: cc } = require('canvas'); return cc(w, h); }
      catch (e) { return null; }
    };
  }

  // --- Drawing primitives ---

  // Draw Win98 outset 3D border using fillRect (pixel-perfect, no anti-aliasing)
  drawOutsetBorder(x, y, w, h) {
    const ctx = this.ctx;
    // Outer highlight: top + left
    ctx.fillStyle = this.colors.btnHighlight;
    ctx.fillRect(x, y, w, 1);       // top
    ctx.fillRect(x, y, 1, h);       // left
    // Inner highlight: top + left
    ctx.fillStyle = this.colors.btnLight;
    ctx.fillRect(x + 1, y + 1, w - 2, 1);
    ctx.fillRect(x + 1, y + 1, 1, h - 2);
    // Outer shadow: bottom + right
    ctx.fillStyle = this.colors.btnDkShadow;
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x + w - 1, y, 1, h);
    // Inner shadow: bottom + right
    ctx.fillStyle = this.colors.btnShadow;
    ctx.fillRect(x + 1, y + h - 2, w - 2, 1);
    ctx.fillRect(x + w - 2, y + 1, 1, h - 2);
  }

  // Draw Win98 inset 3D border using fillRect (pixel-perfect, no anti-aliasing)
  drawInsetBorder(x, y, w, h) {
    const ctx = this.ctx;
    // Outer shadow: top + left
    ctx.fillStyle = this.colors.btnShadow;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y, 1, h);
    // Inner shadow: top + left
    ctx.fillStyle = this.colors.btnDkShadow;
    ctx.fillRect(x + 1, y + 1, w - 2, 1);
    ctx.fillRect(x + 1, y + 1, 1, h - 2);
    // Outer highlight: bottom + right
    ctx.fillStyle = this.colors.btnHighlight;
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x + w - 1, y, 1, h);
    // Inner highlight: bottom + right
    ctx.fillStyle = this.colors.btnLight;
    ctx.fillRect(x + 1, y + h - 2, w - 2, 1);
    ctx.fillRect(x + w - 2, y + 1, 1, h - 2);
  }

  drawButton(x, y, w, h, text, pressed) {
    const ctx = this.ctx;
    ctx.fillStyle = this.colors.btnFace;
    ctx.fillRect(x, y, w, h);
    if (pressed) {
      this.drawInsetBorder(x, y, w, h);
    } else {
      this.drawOutsetBorder(x, y, w, h);
    }
    if (text) {
      ctx.fillStyle = this.colors.windowText;
      ctx.font = this.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const off = pressed ? 1 : 0;
      this._drawTextWithMnemonic(ctx, text, x + w / 2 + off, y + h / 2 + off, 'center');
    }
  }

  _stripMnemonic(text) {
    return text.replace(/&&/g, '\x00').replace(/&(.)/g, '$1').replace(/\x00/g, '&');
  }

  _drawTextWithMnemonic(ctx, text, x, y, align) {
    // Parse mnemonic: && = literal &, &X = underline X
    const clean = text.replace(/&&/g, '\x00');
    const mnIdx = clean.indexOf('&');
    const display = clean.replace(/&(.)/g, '$1').replace(/\x00/g, '&');
    ctx.fillText(display, x, y);
    if (mnIdx >= 0) {
      const before = display.substring(0, mnIdx);
      const ch = display[mnIdx];
      const metrics = ctx.measureText(display);
      const totalW = metrics.width;
      let charX;
      if (align === 'center') {
        const startX = x - totalW / 2;
        charX = startX + ctx.measureText(before).width;
      } else {
        charX = x + ctx.measureText(before).width;
      }
      const charW = ctx.measureText(ch).width;
      const lineY = y + 7;
      ctx.fillRect(charX, lineY, charW, 1);
    }
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
    // simply skips the menu strip — so we trust any non-zero menuId here.
    if (menuId) {
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
    const w = win.wasm || this.wasm;
    const e = w && w.exports;
    if (!e || !e.menu_bar_count) return !!win._menuId; // pre-instance fallback
    // Lazily push the JS-side menu resource into WAT — _setWatMenu only
    // marks the slot pending until first paint/hit-test, so without this
    // bar_count returns 0 on the very first repaint and the layout drops
    // 18 px of menu height.
    this._ensureWatMenu(win);
    return (e.menu_bar_count(win.hwnd) | 0) > 0;
  }

  _computeClientRect(win) {
    const hasCaption = !!(win.style & 0x00C00000);
    const hasBorder = !!(win.style & 0x00C00000) || !!(win.style & 0x00800000); // WS_CAPTION or WS_BORDER
    const bw = hasBorder ? 3 : 0; // border width
    let cy = win.y + bw;
    if (hasCaption) cy += 19;
    if (this._hasMenuBar(win)) cy += 18;
    const bot = hasBorder ? 4 : 0;
    win.clientRect = { x: win.x + bw, y: cy + (hasBorder ? 1 : 0), w: win.w - bw * 2, h: win.h - (cy + (hasBorder ? 1 : 0) - win.y) - bot };
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
    const ctrlCount = e.dlg_get_ctrl_count(hwnd);
    // dlg_get_title_wa returns a WASM linear address (already run through
    // $g2w in WAT), so we read the ASCII bytes directly.
    const titleWa = e.dlg_get_title_wa(hwnd);
    let title = '';
    if (titleWa) {
      const u8 = new Uint8Array(mem.buffer);
      for (let i = 0; i < 256 && u8[titleWa + i]; i++) title += String.fromCharCode(u8[titleWa + i]);
    }

    const isChild = !!(parentHwnd && this.windows[parentHwnd] && (style & 0x40000000));
    const win = {
      hwnd,
      style,
      title,
      x: dlgX === -32768 ? 40 : Math.round(dlgX * this.dluX),
      y: Math.round(Math.max(0, dlgY) * this.dluY),
      w: Math.round(dlgCx * this.dluX) + 8,
      h: Math.round(dlgCy * this.dluY) + 30,
      visible: false,
      isChild,
      parentHwnd: isChild ? parentHwnd : 0,
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

    // $dlg_load allocates ctrl hwnds contiguously from dlgHwnd+1. We only
    // register owner-draw buttons as child windows so mouse hit-testing can
    // find them; everything else (text, checked state, paint) lives in WAT
    // CONTROL_TABLE / ButtonState and paints via GDI primitives.
    for (let i = 0; i < ctrlCount; i++) {
      const ctrlHwnd = hwnd + 1 + i;
      const classEnum = e.ctrl_get_class(ctrlHwnd);
      if (classEnum !== 1 || !e.wnd_get_style_export) continue;
      const btnKind = e.wnd_get_style_export(ctrlHwnd) & 0xF;
      if (btnKind !== 0xB) continue;
      const xyPacked = e.ctrl_get_xy(ctrlHwnd) >>> 0;
      const whPacked = e.ctrl_get_wh(ctrlHwnd) >>> 0;
      this.windows[ctrlHwnd] = {
        hwnd: ctrlHwnd,
        x: xyPacked & 0xFFFF,
        y: (xyPacked >>> 16) & 0xFFFF,
        w: whPacked & 0xFFFF,
        h: (whPacked >>> 16) & 0xFFFF,
        isChild: true,
        parentHwnd: hwnd,
        visible: true,
      };
    }

    this.windows[hwnd] = win;
    return hwnd;
  }

  showWindow(hwnd, cmd) {
    const win = this.windows[hwnd];
    if (!win) return;
    win.visible = (cmd !== 0);
    if (cmd === 3 && !win.isChild) {
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
    this.dirtyWindows.add(hwnd);
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
    const e = this.wasm && this.wasm.exports;
    if (!e || !e.menu_open_hwnd) { this._menuMode = false; return; }
    const wh = e.menu_open_hwnd() | 0;
    if (!wh) { this._menuMode = false; return; }
    e.menu_close();
    this._menuMode = false;
    this.queuePaint(wh);
    this.repaint();
  }

  scheduleRepaint() {
    if (this._repaintScheduled) return;
    if (this._repainting) {
      this._repaintPending = true;
      return;
    }
    this._repaintScheduled = true;
    if (this._isNode) {
      // In Node, defer repaint — the batch loop calls flushRepaint() after
      // each WASM batch so all GDI writes complete before compositing.
    } else {
      requestAnimationFrame(() => {
        this._repaintScheduled = false;
        this.repaint();
      });
    }
  }

  flushRepaint() {
    if (this._repaintScheduled) {
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
      this.dirtyWindows.add(hwnd);
    }
  }

  _repaintOnce() {
    const ctx = this.ctx;

    const sorted = Object.values(this.windows)
      .filter(w => w.visible && !w.isChild && w.w > 0 && w.h > 0)
      .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
    // Fill entire desktop (or clear to transparent if HTML desktop is below)
    if (this.transparentDesktop) {
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

      // Draw chrome (borders, title bar, menu) first
      this.drawWindow(win);
      // Composite the back canvas on top — transparent areas let chrome
      // show through, opaque areas (app drawing) cover it. This handles
      // both GetDC (client area) and GetWindowDC (custom skin) drawing.
      if (win._backCanvas) {
        ctx.drawImage(win._backCanvas, win.x, win.y);
      }
      ctx.restore();
    }

    this.dirtyWindows.clear();

    // Draw dropdown overlay on top of everything (if any menu is open)
    this._menuPaintDropdown();

    // Update HTML taskbar buttons
    this.updateTaskbar();
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

  // Lazily allocate a 256-byte guest scratch buffer used by both
  // _defwndprocNcpaint (encoding the title text for WAT to draw) and
  // _drawWatChildren (reading text out of WAT control state). Returns
  // null if the wasm instance isn't ready yet.
  _ensureWatScratch() {
    const e = this.wasm && this.wasm.exports;
    if (!e || !e.guest_alloc || !e.get_image_base) return null;
    if (!this._watScratchG) {
      this._watScratchG = e.guest_alloc(256);
      this._watImgBase = e.get_image_base();
    }
    return e;
  }

  // Dispatch to WAT $defwndproc_ncpaint to draw the window's non-client
  // area (3D frame, caption gradient, title text, system buttons). Returns
  // true if it ran (caller skips the legacy JS chrome path), false if the
  // export isn't available yet so the caller falls back.
  _defwndprocNcpaint(win, x, y, w, h) {
    const e = this._ensureWatScratch();
    if (!e || !e.defwndproc_ncpaint) return false;
    const imgBase = this._watImgBase;
    const scratchG = this._watScratchG;
    const scratchWa = scratchG - imgBase + 0x12000;
    // Encode title (ASCII bytes, no NUL needed — length is passed explicitly).
    const title = win.title || '';
    const u8 = new Uint8Array(this.wasmMemory.buffer);
    let n = title.length;
    if (n > 200) n = 200;
    for (let i = 0; i < n; i++) u8[scratchWa + i] = title.charCodeAt(i) & 0xFF;
    // Flags: bit0 active, bit1 dialog_style, bit2 maximized, bit3 has_caption.
    // Active: top window today is always treated as active by the renderer
    // (no defocus distinction yet).
    let flags = 0x01;
    // FlashWindow inverts the active appearance of the titlebar
    if (e.get_flash_state && e.get_flash_state(win.hwnd)) flags ^= 0x01;
    if (win.isAboutDialog) flags |= 0x02;
    if (win._maximized) flags |= 0x04;
    if (win.hasCaption) flags |= 0x08;
    // Draw ncpaint into the window's back-canvas at window-local (0, 0) —
    // the subsequent repaint() blit places the whole back-canvas at (win.x,
    // win.y) on screen, so chrome lands at (x, y) without an explicit offset.
    const wc = this.getWindowCanvas(win.hwnd);
    if (!wc) return false;
    this._activeChildDraw = { canvas: wc.canvas, ctx: wc.ctx, ox: 0, oy: 0, hwnd: win.hwnd };
    try {
      e.defwndproc_ncpaint(win.hwnd, w, h, scratchWa, n, flags);
    } finally {
      this._activeChildDraw = null;
    }
    return true;
  }

  // Tell WAT to load the menu for this hwnd from the PE resource by
  // its menu_id. WAT walks the PE resource directory itself ($find_
  // resource(RT_MENU=4, id)) and parses the MENUHEADER+MENUITEMTEMPLATE
  // bytes into its own heap-resident blob — see $menu_load in
  // src/09c5-menu.wat. The JS parser in resources.js still runs because
  // keyboard nav (renderer-input.js) reads the parsed JS tree, but
  // paint/hit-test go through this WAT-side copy.
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

  // Screen rect of $win's menu bar — needed by both the JS input
  // forwarder (to call $menu_hittest_bar) and the dropdown overlay
  // painter (to anchor the dropdown under the open bar item). The
  // bar always sits immediately under the title bar and is 18 px
  // tall; for caption-less windows it sits at win.y+3.
  _menuBarPos(win) {
    const hasCaption = !!(win.style & 0x00C00000);
    return { barX: win.x + 3, barY: win.y + 3 + (hasCaption ? 19 : 0), barH: 18 };
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
    const wasms = new Set(Object.values(this.windows).map(w => w.wasm).filter(Boolean));
    for (const w of wasms) {
      this.wasm = w;
      const e = w.exports;
      if (!e || !e.menu_paint_dropdown || !e.menu_open_hwnd) continue;
      const hwnd = e.menu_open_hwnd() | 0;
      if (!hwnd) continue;
      const win = this.windows[hwnd];
      if (!win) continue;
      this.wasmMemory = win.wasmMemory;
      const top = e.menu_open_top() | 0;
      if (top < 0) continue;
      const hover = e.menu_open_hover() | 0;
      const { barX, barY, barH } = this._menuBarPos(win);
      const dx = barX + (e.menu_bar_item_x(hwnd, top) | 0);
      const dy = barY + barH;
      if (!painted) { overlay.ctx.clearRect(0, 0, sw, sh); painted = true; }
      this._activeChildDraw = { canvas: overlay.canvas, ctx: overlay.ctx, ox: 0, oy: 0, hwnd };
      try { e.menu_paint_dropdown(hwnd, top, dx, dy, hover); }
      finally { this._activeChildDraw = null; }
    }
    if (painted) this.ctx.drawImage(overlay.canvas, 0, 0);
  }

  drawWindow(win) {
    const ctx = this.ctx;
    const { x, y, w, h } = win;

    // Skip windows with zero size
    if (w <= 0 || h <= 0) return;

    win.hasCaption = !!(win.style & 0x00C00000);
    const hasBorder = win.hasCaption || !!(win.style & 0x00800000);

    // Recompute client rect (window may have moved/resized)
    this._computeClientRect(win);
    const { x: clientX, y: clientY, w: clientW, h: clientH } = win.clientRect;

    // Borderless windows (style=0, WS_POPUP without WS_BORDER): skip all chrome
    if (!hasBorder) {
      // Still run child drawing below, but no frame/title/menubar
    } else {
    // WM_NCPAINT: delegate frame + caption to WAT $defwndproc_ncpaint via
    // _activeChildDraw routing — same path used by Button/Edit/etc. wndprocs.
    let cy = y + 3;
    this._defwndprocNcpaint(win, x, y, w, h);
    if (win.hasCaption) cy += 18 + 1;

    if (hasBorder && this._hasMenuBar(win)) {
      // Pass window-local coords; _menuPaintBar writes to back-canvas.
      const mh = this._menuPaintBar(win, 3, cy - y, w - 6);
      cy += (mh || 18);
    }
    } // end hasBorder else block

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
      if (child.parentHwnd === win.hwnd && child.visible && child.isDialog) {
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
