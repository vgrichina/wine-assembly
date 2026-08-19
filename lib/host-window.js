// Window half of the host import layer: the imports WAT calls to create,
// move, show, order, style and destroy windows, plus scrollbars, capture,
// the cursor, and the input pollers both hosts override.
//
// Split out of lib/host-imports.js, which still owns the flat `host` import
// namespace: it calls createWindowHost() once and spreads `.imports` into the
// same object the guest sees, so nothing about the WASM import shape changed.
// Everything here talks to ctx.renderer; the four things it needs from the
// other half arrive through `shared`.

function createWindowHost(ctx, shared) {
  const readStr = shared.readStr;
  const readStrW = shared.readStrW;
  const _cursorCssForHandle = shared.cursorCssForHandle;
  const _env = (typeof process !== 'undefined' && process.env) ? process.env : {};

  // Window title bookkeeping. GetWindowText/GetWindowTextLength answer from
  // here first, because the renderer's record is a *display* title and can be
  // decorated. Both hosts override create_window and set_window_text to add
  // their own logging, and each used to poke this Map itself — three copies of
  // the same two lines, which meant a change here (clearing on destroy, say)
  // would silently not apply to either host.
  ctx.recordWindowText = (hwnd, text) => {
    if (!ctx._windowText) ctx._windowText = new Map();
    ctx._windowText.set(hwnd >>> 0, text);
  };
  ctx.forgetWindowText = (hwnd) => {
    if (ctx._windowText) ctx._windowText.delete(hwnd >>> 0);
  };
  const _windowTextOf = (hwnd) => {
    const local = ctx._windowText && ctx._windowText.get(hwnd >>> 0);
    if (local !== undefined) return local;
    const win = ctx.renderer && ctx.renderer.windows && ctx.renderer.windows[hwnd >>> 0];
    return (win && win.title) || '';
  };
  const _queueParentExposePaint = (win) => {
    const r = ctx.renderer;
    if (!r || !win || !win.isChild || !win.parentHwnd) return;
    if (!r.windows[win.parentHwnd]) return;
    if (r.restoreParentUnderChild) r.restoreParentUnderChild(win);
    let root = r.windows[win.parentHwnd];
    while (root && root.isChild && r.windows[root.parentHwnd]) {
      root = r.windows[root.parentHwnd];
    }
    if (root && r.invalidateVisibleTree) r.invalidateVisibleTree(root.hwnd);
    else if (r.queuePaint) r.queuePaint(win.parentHwnd);
    if (r.scheduleRepaint) r.scheduleRepaint();
  };

  // The window slice of the flat host import namespace. host-imports.js
  // spreads these into `host` in place, so the guest still sees one object.
  const imports = {
    // --- Window management ---
    set_parent: (hwnd, newParent) => {
      const r = ctx.renderer;
      if (!r) return;
      const win = r.windows[hwnd];
      if (!win) return;
      win.parentHwnd = newParent || 0;
      win.isChild = !!(newParent && r.windows[newParent]);
      if (String(win.className || '').toLowerCase() === 'toolbarwindow32' &&
          win.parentHwnd && r.windows[win.parentHwnd]) {
        const parent = r.windows[win.parentHwnd];
        if (String(parent.className || '').toLowerCase() === 'afxcontrolbar42') {
          const parentW = parent.clientRect && parent.clientRect.w > 0 ? parent.clientRect.w : parent.w;
          if (parentW > 0 && win.w > parentW + 8) win.w = parentW;
          r._computeClientRect(win);
        }
      }
    },
    create_window: (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
      const title = readStr(titlePtr);
      console.log(`[CreateWindow] hwnd=0x${hwnd.toString(16)} title="${title}" menu=${menuId}`);
      ctx.recordWindowText(hwnd, title);
      if (ctx.renderer) {
        ctx.renderer.createWindow(hwnd, style, x, y, cx, cy, title, menuId, ctx.instance || null, ctx.wasmMemory || null);
        const win = ctx.renderer.windows && ctx.renderer.windows[hwnd];
        if (win) win.processId = (ctx.processId >>> 0) || 1000;
      }
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
                w: Math.min(640, Math.max(160, r.canvas.width - 40)),
                h: Math.min(480, Math.max(120, r.canvas.height - 40)),
              };
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
      if (typeof r._computeClientRect === 'function') r._computeClientRect(win);
      if (r.invalidate) r.invalidate(hwnd);
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
      if (ctx.renderer) {
        ctx.renderer.createDialog(hwnd, parentHwnd);
        const win = ctx.renderer.windows && ctx.renderer.windows[hwnd];
        if (win) win.processId = (ctx.processId >>> 0) || 1000;
      }
    },
    load_icon: (hInstance, resourceId) => {
      return 0x50000 | (resourceId & 0xFFFF);
    },
    load_cursor: (hInstance, resourceId) => {
      if (!hInstance) return 0x60000 | (resourceId & 0xFFFF);
      return 0x680000 | (resourceId & 0xFFFF);
    },
    set_cursor: (hcur) => {
      const canvas = ctx.renderer && ctx.renderer.canvas;
      if (!canvas || !canvas.style) return;
      if ((hcur & 0xFF0000) === 0x680000) {
        const custom = _cursorCssForHandle(hcur);
        if (custom && canvas.style.cursor !== custom) canvas.style.cursor = custom;
        return;
      }
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
      ctx.recordWindowText(hwnd, text);
      if (ctx.renderer) ctx.renderer.setWindowText(hwnd, text);
    },
    set_window_class: (hwnd, classPtr) => {
      if (ctx.renderer) ctx.renderer.setWindowClass(hwnd, readStr(classPtr));
    },
    get_window_class: (hwnd, bufWA, maxLen) => {
      const win = ctx.renderer && ctx.renderer.windows && ctx.renderer.windows[hwnd >>> 0];
      const className = (win && win.className) || '';
      if (maxLen <= 0) return 0;
      const bytes = new Uint8Array(ctx.getMemory());
      const len = Math.min(className.length, maxLen - 1);
      for (let i = 0; i < len; i++) bytes[bufWA + i] = className.charCodeAt(i) & 0xFF;
      bytes[bufWA + len] = 0;
      return len;
    },
    get_window_text: (hwnd, bufWA, maxLen) => {
      const text = _windowTextOf(hwnd);
      if (maxLen <= 0) return 0;
      const bytes = new Uint8Array(ctx.getMemory());
      const len = Math.min(text.length, maxLen - 1);
      for (let i = 0; i < len; i++) bytes[bufWA + i] = text.charCodeAt(i) & 0xFF;
      bytes[bufWA + len] = 0;
      return len;
    },
    get_window_text_length: (hwnd) => _windowTextOf(hwnd).length,
    get_window_related: (hwnd, cmd) => {
      const r = ctx.renderer;
      const windows = r && r.windows;
      if (!windows) return 0;
      const win = windows[hwnd >>> 0];
      const sortedByZ = list => list
        .filter(w => w && w.hwnd)
        .sort((a, b) => ((b.zOrder || 0) - (a.zOrder || 0)) || ((b.hwnd || 0) - (a.hwnd || 0)));
      // GetDesktopWindow is a WAT-side phantom handle. Its GW_CHILD relation
      // is the renderer's top-level z-order, spanning every app instance.
      if ((!win && (hwnd >>> 0) === 0x10000) || (!win && !hwnd)) {
        if (cmd !== 5) return 0;
        const top = sortedByZ(Object.values(windows).filter(w => w && !w.isChild));
        return top.length ? (top[0].hwnd >>> 0) : 0;
      }
      if (!win) return 0;
      const sameSiblingGroup = w => {
        if (!w) return false;
        if (!!w.isChild !== !!win.isChild) return false;
        if (win.isChild) return (w.parentHwnd >>> 0) === (win.parentHwnd >>> 0);
        return !w.isChild;
      };
      if (cmd === 0 || cmd === 1 || cmd === 2 || cmd === 3) { // GW_HWNDFIRST/LAST/NEXT/PREV
        const siblings = sortedByZ(Object.values(windows).filter(sameSiblingGroup));
        if (!siblings.length) return 0;
        if (cmd === 0) return siblings[0].hwnd >>> 0;
        if (cmd === 1) return siblings[siblings.length - 1].hwnd >>> 0;
        const pos = siblings.findIndex(w => (w.hwnd >>> 0) === (hwnd >>> 0));
        if (pos < 0) return 0;
        if (cmd === 2) return pos + 1 < siblings.length ? (siblings[pos + 1].hwnd >>> 0) : 0;
        return pos > 0 ? (siblings[pos - 1].hwnd >>> 0) : 0;
      }
      if (cmd === 4) { // GW_OWNER
        return (win.ownerHwnd || 0) >>> 0;
      }
      if (cmd === 5) { // GW_CHILD
        const children = sortedByZ(Object.values(windows).filter(w =>
          w && w.isChild && (w.parentHwnd >>> 0) === (hwnd >>> 0)));
        return children.length ? (children[0].hwnd >>> 0) : 0;
      }
      if (cmd === 6) { // GW_ENABLEDPOPUP
        const popups = sortedByZ(Object.values(windows).filter(w =>
          w && !w.isChild &&
          (w.ownerHwnd >>> 0) === (hwnd >>> 0) &&
          w.visible !== false &&
          w.enabled !== false));
        return popups.length ? (popups[0].hwnd >>> 0) : (hwnd >>> 0);
      }
      return 0;
    },
    get_window_info: (hwnd, prop) => {
      const win = ctx.renderer && ctx.renderer.windows && ctx.renderer.windows[hwnd >>> 0];
      if (!win) return 0;
      if (prop === 0) return win.style >>> 0;
      if (prop === 1) return win.visible !== false ? 1 : 0;
      if (prop === 2) return win.enabled === false ? 0 : 1;
      if (prop === 3) return (win.processId >>> 0) || 0;
      return 0;
    },
    post_window_message: (hwnd, msg, wParam, lParam) => {
      const r = ctx.renderer;
      const win = r && r.windows && r.windows[hwnd >>> 0];
      const e = (win && win.wasm && win.wasm.exports) || ctx.exports || (r && r.wasm && r.wasm.exports);
      if (!e || typeof e.post_message_q !== 'function') return 0;
      e.post_message_q(hwnd >>> 0, msg >>> 0, wParam >>> 0, lParam >>> 0);
      return 1;
    },
    activate_window: (hwnd) => {
      const r = ctx.renderer;
      if (!r || !r.windows) return 1;
      const win = r.windows[hwnd >>> 0];
      if (win) {
        win.zOrder = r._nextZ++;
        if (typeof r._setKeyboardInputOwner === 'function') r._setKeyboardInputOwner(win);
        if (typeof r.invalidate === 'function') r.invalidate(hwnd);
        if (typeof r.scheduleRepaint === 'function') r.scheduleRepaint();
        else if (typeof r.repaint === 'function') r.repaint();
      }
      return 1;
    },
    arrange_windows: (mode, flags, rectWa, count, hwndsWa) => {
      const r = ctx.renderer;
      if (!r || !r.windows) return 0;
      const dv = new DataView(ctx.getMemory());
      let left = 0, top = 0, right = r.canvas ? r.canvas.width : 640;
      let bottom = r.canvas ? r.canvas.height : 480;
      if (rectWa && rectWa + 16 <= dv.byteLength) {
        left = dv.getInt32(rectWa, true);
        top = dv.getInt32(rectWa + 4, true);
        right = dv.getInt32(rectWa + 8, true);
        bottom = dv.getInt32(rectWa + 12, true);
      }
      if (r.canvas) {
        left = Math.max(0, Math.min(left, r.canvas.width - 1));
        top = Math.max(0, Math.min(top, r.canvas.height - 1));
        right = Math.max(left + 1, Math.min(right, r.canvas.width));
        bottom = Math.max(top + 1, Math.min(bottom, r.canvas.height));
      }
      const width = Math.max(1, right - left);
      const height = Math.max(1, bottom - top);
      let windows = [];
      if (mode === 2) {
        windows = Object.values(r.windows).filter(win =>
          win && !win.isChild && win._minimized && win.hasCaption !== false);
      } else {
        const limit = Math.max(0, Math.min(count | 0, 256));
        for (let i = 0; i < limit && hwndsWa + i * 4 + 4 <= dv.byteLength; i++) {
          const win = r.windows[dv.getUint32(hwndsWa + i * 4, true)];
          if (win && !win.isChild) windows.push(win);
        }
      }
      if (!windows.length) return 0;
      if (mode === 0) {
        const step = 24;
        const w = Math.max(160, width - step * Math.max(0, windows.length - 1));
        const h = Math.max(100, height - step * Math.max(0, windows.length - 1));
        windows.forEach((win, i) => {
          win.x = left + i * step; win.y = top + i * step;
          win.w = w; win.h = h; win.visible = true; win._minimized = false;
          const e = win.wasm && win.wasm.exports;
          if (e && e.post_resize_messages) e.post_resize_messages(win.hwnd, 0);
          if (r._computeClientRect) r._computeClientRect(win);
        });
      } else if (mode === 1) {
        const horizontal = !!(flags & 1); // MDITILE_HORIZONTAL
        windows.forEach((win, i) => {
          if (horizontal) {
            const y0 = top + Math.floor(height * i / windows.length);
            const y1 = top + Math.floor(height * (i + 1) / windows.length);
            win.x = left; win.y = y0; win.w = width; win.h = y1 - y0;
          } else {
            const x0 = left + Math.floor(width * i / windows.length);
            const x1 = left + Math.floor(width * (i + 1) / windows.length);
            win.x = x0; win.y = top; win.w = x1 - x0; win.h = height;
          }
          win.visible = true; win._minimized = false;
          const e = win.wasm && win.wasm.exports;
          if (e && e.post_resize_messages) e.post_resize_messages(win.hwnd, 0);
          if (r._computeClientRect) r._computeClientRect(win);
        });
      } else {
        const iconW = 160, iconH = 28;
        const cols = Math.max(1, Math.floor(width / iconW));
        windows.forEach((win, i) => {
          const row = Math.floor(i / cols);
          const col = i % cols;
          win.x = left + col * iconW;
          win.y = bottom - (row + 1) * iconH;
          win.w = Math.min(iconW, width);
          win.h = iconH;
          if (r._computeClientRect) r._computeClientRect(win);
        });
        if (r.scheduleRepaint) r.scheduleRepaint();
        return Math.ceil(windows.length / cols) * iconH;
      }
      for (const win of windows) {
        win.zOrder = r._nextZ++;
        if (r.invalidate) r.invalidate(win.hwnd);
      }
      if (r.scheduleRepaint) r.scheduleRepaint();
      return windows.length;
    },
    // Client-area damage. WAT has already recorded the update region and set
    // the paint flag; all that is owed here is a composite. Posting WM_NCPAINT
    // from here would make every keystroke in an edit control redraw its
    // top-level window's caption, border and menu bar.
    invalidate: (hwnd) => {
      if (_env.DBG_INV) console.log('[INVALIDATE] hwnd=0x' + hwnd.toString(16));
      if (ctx.renderer) ctx.renderer.scheduleRepaint();
    },
    // Non-client damage: the caller changed something the frame draws.
    invalidate_frame: (hwnd) => {
      if (_env.DBG_INV) console.log('[INVALIDATE-NC] hwnd=0x' + hwnd.toString(16));
      if (ctx.renderer) ctx.renderer.invalidate(hwnd);
    },
    get_window_client_size: (hwnd) => {
      if (!ctx.renderer) return (640 & 0xFFFF) | (480 << 16);
      const win = ctx.renderer.windows[hwnd];
      if (!win) return (640 & 0xFFFF) | (480 << 16);
      // Prefer WAT get_client_rect_wh (authoritative after NCCALCSIZE). This
      // matters for child controls with non-client borders such as Solitaire's
      // status child.
      const e = ctx.exports || (ctx.renderer.wasm && ctx.renderer.wasm.exports);
      if (e && e.get_client_rect_wh) {
        const packed = e.get_client_rect_wh(hwnd) | 0;
        if (packed) return packed;
      }
      const cr = win.clientRect;
      if (cr) return (cr.w & 0xFFFF) | (cr.h << 16);
      if (win.isChild) {
        return (win.w & 0xFFFF) | (win.h << 16);
      }
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
      if (win) {
        const we = ctx.exports || (ctx.renderer.wasm && ctx.renderer.wasm.exports);
        if (win.isChild && we && we.wnd_window_screen_x && we.wnd_window_screen_y && we.wnd_screen_w && we.wnd_screen_h) {
          try {
            const x = we.wnd_window_screen_x(hwnd) | 0;
            const y = we.wnd_window_screen_y(hwnd) | 0;
            const w = we.wnd_screen_w(hwnd) | 0;
            const h = we.wnd_screen_h(hwnd) | 0;
            mem.setInt32(rectPtr, x, true);
            mem.setInt32(rectPtr + 4, y, true);
            mem.setInt32(rectPtr + 8, x + w, true);
            mem.setInt32(rectPtr + 12, y + h, true);
            return;
          } catch (_) {}
        }
        mem.setInt32(rectPtr, win.x, true);
        mem.setInt32(rectPtr + 4, win.y, true);
        mem.setInt32(rectPtr + 8, win.x + win.w, true);
        mem.setInt32(rectPtr + 12, win.y + win.h, true);
        return;
      }
      if (ctx._getWindowRectFallbackDepth) {
        mem.setInt32(rectPtr, 0, true);
        mem.setInt32(rectPtr + 4, 0, true);
        mem.setInt32(rectPtr + 8, 640, true);
        mem.setInt32(rectPtr + 12, 480, true);
        return;
      }
      const we = ctx.exports || (ctx.renderer.wasm && ctx.renderer.wasm.exports);
      if (we && we.wnd_get_style_export && we.wnd_window_screen_x && we.wnd_window_screen_y && we.wnd_screen_w && we.wnd_screen_h) {
        try {
          ctx._getWindowRectFallbackDepth = (ctx._getWindowRectFallbackDepth || 0) + 1;
          const style = we.wnd_get_style_export(hwnd) >>> 0;
          if (style & 0x40000000) {
            const x = we.wnd_window_screen_x(hwnd) | 0;
            const y = we.wnd_window_screen_y(hwnd) | 0;
            const w = we.wnd_screen_w(hwnd) | 0;
            const h = we.wnd_screen_h(hwnd) | 0;
            mem.setInt32(rectPtr, x, true);
            mem.setInt32(rectPtr + 4, y, true);
            mem.setInt32(rectPtr + 8, x + w, true);
            mem.setInt32(rectPtr + 12, y + h, true);
            return;
          }
        } catch (_) {
        } finally {
          ctx._getWindowRectFallbackDepth = Math.max(0, (ctx._getWindowRectFallbackDepth || 1) - 1);
        }
      }
      // hwnd=0 or unknown → desktop rect
      mem.setInt32(rectPtr, 0, true);
      mem.setInt32(rectPtr + 4, 0, true);
      mem.setInt32(rectPtr + 8, 640, true);
      mem.setInt32(rectPtr + 12, 480, true);
    },
    move_window: (hwnd, x, y, w, h, flags) => {
      if (!ctx.renderer) return;
      const win = ctx.renderer.windows[hwnd];
      if (!win) return;
      const wasVisible = !!win.visible;
      // CW_USEDEFAULT (-2147483648) means "keep existing position/size";
      // common when MFC echoes back unset WINDOWPLACEMENT fields.
      const useDefault = v => v === -2147483648 || v === 0x80000000 | 0;
      if (!(flags & 2)) {
        if (!useDefault(x)) win.x = x;
        if (!useDefault(y)) win.y = y;
      }
      if (!(flags & 1)) {
        const preserveHiddenTopLevelSize =
          !win.isChild && !win.visible &&
          w === 0 && h === 0 &&
          win.w > 0 && win.h > 0;
        if (!preserveHiddenTopLevelSize) {
          if (!useDefault(w)) win.w = Math.max(0, w);
          if (!useDefault(h)) win.h = Math.max(0, h);
        }
        // Fixed resource dialogs (Win98 Calculator standard view) can issue a
        // SetWindowPos with the template width and an oversized height while
        // probing/changing layout. Real USER keeps the fixed dialog frame at
        // the template bounds; otherwise our per-window canvas becomes a tall
        // stale gray hit target.
        if (win.isDialog && win._templateW && win._templateH &&
            Math.abs(win.w - win._templateW) <= 8 &&
            win.h > win._templateH + 64) {
          win.w = win._templateW;
          win.h = win._templateH;
        }
      }
      // SWP_SHOWWINDOW=0x40 / SWP_HIDEWINDOW=0x80 — SDL relies on this to reveal
      // the window after SetVideoMode (no explicit ShowWindow(SW_SHOW) call).
      if (flags & 0x40) {
        win.visible = true;
        // Re-bump windows that are actually becoming visible. Reused popups
        // also need a fresh bump so a combobox dropdown stays above its
        // parent. Repeated SWP_SHOWWINDOW on an already-visible normal window
        // must not steal z-order from a later SetForegroundWindow call.
        if (!wasVisible || win.isPopup) {
          win.zOrder = ctx.renderer._nextZ++ + (win.isPopup ? 1000000 : 0);
        }
      }
      if (flags & 0x80) win.visible = false;
      // MFC control bars may cache a toolbar's full ideal button span and then
      // reposition the ToolbarWindow32 child with SWP_NOSIZE. The toolbar still
      // needs to be clipped by the containing AfxControlBar surface; otherwise
      // WordPad's formatting toolbar dumps/allocates as a 1512px-wide child in
      // a 394px frame.
      if (String(win.className || '').toLowerCase() === 'toolbarwindow32' &&
          win.parentHwnd && ctx.renderer.windows[win.parentHwnd]) {
        const parent = ctx.renderer.windows[win.parentHwnd];
        if (String(parent.className || '').toLowerCase() === 'afxcontrolbar42') {
          const parentW = parent.clientRect && parent.clientRect.w > 0 ? parent.clientRect.w : parent.w;
          if (parentW > 0 && win.w > parentW + 8) win.w = parentW;
        }
      }
      if (String(win.className || '').toLowerCase() === 'afxcontrolbar42') {
        const parentW = win.clientRect && win.clientRect.w > 0 ? win.clientRect.w : win.w;
        if (parentW > 0) {
          for (const child of Object.values(ctx.renderer.windows)) {
            if (!child || child.parentHwnd !== hwnd) continue;
            if (String(child.className || '').toLowerCase() !== 'toolbarwindow32') continue;
            if (child.w > parentW + 8) {
              child.w = parentW;
              ctx.renderer._computeClientRect(child);
            }
          }
        }
      }
      ctx.renderer._computeClientRect(win);
      if (wasVisible && !win.visible) _queueParentExposePaint(win);
      if (!win.isChild) ctx.renderer.scheduleRepaint();
    },
    sync_window_client: (hwnd, x, y, w, h) => {
      if (!ctx.renderer) return;
      const win = ctx.renderer.windows[hwnd];
      if (!win) return;
      let width = Math.max(0, w | 0);
      if (String(win.className || '').toLowerCase() === 'toolbarwindow32' &&
          win.w > 0 && width > win.w + 8) {
        width = win.w;
      }
      win.clientRect = {
        x: x | 0,
        y: y | 0,
        w: width,
        h: Math.max(0, h | 0),
      };
    },
    destroy_window: (hwnd) => {
      if (!ctx.renderer) return;
      const destroyed = ctx.renderer.windows[hwnd];
      const wasTopLevel = destroyed && !destroyed.isChild;
      const exposedParent = destroyed && destroyed.isChild ? destroyed : (destroyed && destroyed.visible ? destroyed : null);
      // Drop any per-window menu data the WAT side is holding for this hwnd.
      const we = ctx.exports || (ctx.renderer.wasm && ctx.renderer.wasm.exports);
      if (we && we.menu_clear) we.menu_clear(hwnd);
      for (const k of Object.keys(ctx.renderer.windows)) {
        if (ctx.renderer.windows[k].parentHwnd === hwnd) {
          delete ctx.renderer.windows[k];
        }
      }
      delete ctx.renderer.windows[hwnd];
      if (wasTopLevel && ctx.renderer.notifyShellWindow) {
        ctx.renderer.notifyShellWindow(2, hwnd);
      }
      if (wasTopLevel && ctx.onTopLevelWindowDestroyed) {
        try { ctx.onTopLevelWindowDestroyed(hwnd, destroyed); } catch (_) {}
      }
      _queueParentExposePaint(exposedParent);
      ctx.renderer.scheduleRepaint();
    },
    set_menu: (hwnd, menuResId) => {
      if (ctx.renderer) ctx.renderer.setMenu(hwnd, menuResId);
    },
    menu_create: () => {
      if (!ctx._hostMenus) ctx._hostMenus = new Map();
      const h = ctx._nextHostMenu || 0x800001;
      ctx._nextHostMenu = h + 1;
      ctx._hostMenus.set(h, []);
      return h;
    },
    menu_destroy: (hMenu) => {
      if (ctx._hostMenus) ctx._hostMenus.delete(hMenu >>> 0);
      return 1;
    },
    menu_append: (hMenu, flags, idOrSubmenu, textWA, isWide) => {
      if (!ctx._hostMenus) ctx._hostMenus = new Map();
      const h = hMenu >>> 0;
      if (!ctx._hostMenus.has(h)) ctx._hostMenus.set(h, []);
      const text = textWA ? (isWide ? readStrW(textWA) : readStr(textWA)) : '';
      const f = flags >>> 0;
      ctx._hostMenus.get(h).push({
        flags: f,
        id: idOrSubmenu >>> 0,
        submenu: (f & 0x0010) ? (idOrSubmenu >>> 0) : 0, // MF_POPUP
        popup: !!(f & 0x0010),
        separator: !!(f & 0x0800), // MF_SEPARATOR
        disabled: !!(f & 0x0003),  // MF_GRAYED | MF_DISABLED
        text,
        isWide: !!isWide,
      });
      return 1;
    },
    // --- Input (override for interactive/test) ---
    check_input: () => 0,
    check_input_lparam: () => 0,
    check_input_hwnd: () => 0,
    get_mouse_position: () => ctx.renderer && ctx.renderer.getMousePosition ? ctx.renderer.getMousePosition() : 0,
    set_mouse_position: (x, y) => { if (ctx.renderer && ctx.renderer.setMousePosition) ctx.renderer.setMousePosition(x, y); },
    get_mouse_buttons: () => ctx.renderer && ctx.renderer.getMouseButtons ? ctx.renderer.getMouseButtons() : 0,
    get_async_key_state: (vKey) => ctx.renderer ? ctx.renderer.getAsyncKeyState(vKey) : 0,
    get_key_down_state: (vKey) => ctx.renderer && ctx.renderer.peekAsyncKeyState ? ctx.renderer.peekAsyncKeyState(vKey) : 0,

  };

  return { imports };
}

if (typeof module !== 'undefined') module.exports = { createWindowHost };
