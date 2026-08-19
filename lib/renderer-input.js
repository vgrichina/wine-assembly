// Win98Renderer input handling — split from renderer.js
// Mixed into Win98Renderer.prototype

function installInputHandlers(R) {
  const P = R.prototype;

  // DefWindowProc currently preserves the application-selected cursor for
  // HTCLIENT because WNDCLASS cursor lookup is not implemented yet.  That is
  // useful for app-defined cursors, but a resize cursor must never leak back
  // into the client area after the pointer leaves a sizing border.
  P._clearStaleResizeCursor = function(hit) {
    if (hit >= 10 && hit <= 17) return false;
    const style = this.canvas && this.canvas.style;
    if (!style) return false;
    if (style.cursor !== 'ew-resize' && style.cursor !== 'ns-resize' &&
        style.cursor !== 'nwse-resize' && style.cursor !== 'nesw-resize') {
      return false;
    }
    style.cursor = 'default';
    return true;
  };

  // Non-client sizing cursors are determined entirely by the hit-test code,
  // so update the browser cursor synchronously.  WM_SETCURSOR is still queued
  // below for the guest, but waiting for its next message-pump turn makes the
  // cursor visibly lag (and sometimes miss a short edge hover altogether).
  P._syncResizeCursor = function(hit) {
    const style = this.canvas && this.canvas.style;
    if (!style) return false;
    let cursor = '';
    if (hit === 10 || hit === 11) cursor = 'ew-resize';
    else if (hit === 12 || hit === 15) cursor = 'ns-resize';
    else if (hit === 13 || hit === 17) cursor = 'nwse-resize';
    else if (hit === 14 || hit === 16) cursor = 'nesw-resize';
    if (!cursor) return this._clearStaleResizeCursor(hit);
    if (style.cursor === cursor) return false;
    style.cursor = cursor;
    return true;
  };

  P._findTopWindow = function(hwnd) {
    const direct = this.windows[hwnd];
    const wasm = (direct && direct.wasm) || this.wasm;
    const we = wasm && wasm.exports;
    if (we && we.wnd_top_level) {
      try {
        const top = we.wnd_top_level(hwnd) >>> 0;
        if (top && this.windows[top]) return this.windows[top];
      } catch (_) {}
    }
    const win = direct;
    if (!win) return null;
    if (win.isChild && win.parentHwnd) return this.windows[win.parentHwnd] || null;
    return win;
  };

  P._inputWasmAtPoint = function(canvasX, canvasY) {
    const hit = Object.values(this.windows || {})
      .filter(win => win && win.visible && !win.isChild &&
        canvasX >= win.x && canvasX < win.x + win.w &&
        canvasY >= win.y && canvasY < win.y + win.h)
      .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0))[0];
    return (hit && hit.wasm) || this.wasm;
  };

  P._setKeyboardInputOwner = function(win) {
    if (!win || !win.wasm) return;
    this._keyboardInputWasm = win.wasm;
    this._keyboardInputMemory = win.wasmMemory || null;
    this.wasm = win.wasm;
    if (win.wasmMemory) this.wasmMemory = win.wasmMemory;
  };

  P._restoreKeyboardInputOwner = function() {
    const ownedWindow = this._keyboardInputWasm && Object.values(this.windows || {})
      .some(win => win && win.visible && !win.isChild && win.wasm === this._keyboardInputWasm);
    if (!ownedWindow) {
      const front = Object.values(this.windows || {})
        .filter(win => win && win.visible && !win.isChild && win.wasm)
        .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0))[0];
      if (front) this._setKeyboardInputOwner(front);
    }
    if (!this._keyboardInputWasm) return;
    this.wasm = this._keyboardInputWasm;
    if (this._keyboardInputMemory) this.wasmMemory = this._keyboardInputMemory;
  };

  P._modalDialogHwnd = function(wasm) {
    const ownerWasm = wasm || this.wasm;
    const we = ownerWasm && ownerWasm.exports;
    if (we && we.modal_dialog_hwnd) {
      try {
        const hwnd = we.modal_dialog_hwnd() >>> 0;
        if (hwnd) {
          const win = this.windows && this.windows[hwnd];
          if (win && win.visible) return hwnd;
          if (we.modal_cancel_if_hwnd) we.modal_cancel_if_hwnd(hwnd);
        }
      } catch (_) {}
    }
    const modal = Object.values(this.windows).find(w =>
      w.visible && w.isAboutDialog && (!ownerWasm || w.wasm === ownerWasm));
    return modal ? (modal.hwnd | 0) : 0;
  };

  P._clientOriginScreen = function(hwnd) {
    const win = this.windows[hwnd];
    const wasm = (win && win.wasm) || this.wasm;
    const we = wasm && wasm.exports;
    if (we && we.wnd_client_screen_x && we.wnd_client_screen_y) {
      try { return { x: we.wnd_client_screen_x(hwnd) | 0, y: we.wnd_client_screen_y(hwnd) | 0 }; } catch (_) {}
    }
    if (!win) return { x: 0, y: 0 };
    if (win.isChild && win.parentHwnd) {
      const parentOrigin = this._clientOriginScreen(win.parentHwnd);
      return { x: parentOrigin.x + win.x, y: parentOrigin.y + win.y };
    }
    if (typeof this._computeClientRect === 'function') this._computeClientRect(win);
    if (win.clientRect) return { x: win.clientRect.x, y: win.clientRect.y };
    const y = win.y + 3 + (((win.style & 0x00C00000) === 0x00C00000) ? 19 : 0) + (this._hasMenuBar(win) ? 18 : 0) + 1;
    return { x: win.x + 3, y };
  };

  P._windowOriginScreen = function(hwnd) {
    const win = this.windows[hwnd];
    const wasm = (win && win.wasm) || this.wasm;
    const we = wasm && wasm.exports;
    if (we && we.wnd_window_screen_x && we.wnd_window_screen_y) {
      try { return { x: we.wnd_window_screen_x(hwnd) | 0, y: we.wnd_window_screen_y(hwnd) | 0 }; } catch (_) {}
    }
    if (!win) return { x: 0, y: 0 };
    if (win.isChild && win.parentHwnd) {
      const parentOrigin = this._clientOriginScreen(win.parentHwnd);
      return { x: parentOrigin.x + win.x, y: parentOrigin.y + win.y };
    }
    return { x: win.x, y: win.y };
  };

  P._mouseMsgOriginScreen = function(hwnd) {
    const win = this.windows[hwnd];
    if (win && !win.isChild && win.region) return this._windowOriginScreen(hwnd);
    const wasm = (win && win.wasm) || this.wasm;
    const we = wasm && wasm.exports;
    if (we && we.wnd_mouse_msg_origin_x && we.wnd_mouse_msg_origin_y) {
      try { return { x: we.wnd_mouse_msg_origin_x(hwnd) | 0, y: we.wnd_mouse_msg_origin_y(hwnd) | 0 }; } catch (_) {}
    }
    return win && win.isPopup ? this._windowOriginScreen(hwnd) : this._clientOriginScreen(hwnd);
  };

  P._windowRectScreen = function(win) {
    const origin = this._windowOriginScreen(win.hwnd);
    const wasm = (win && win.wasm) || this.wasm;
    const we = wasm && wasm.exports;
    if (we && we.wnd_screen_w && we.wnd_screen_h) {
      try {
        const w = we.wnd_screen_w(win.hwnd) | 0;
        const h = we.wnd_screen_h(win.hwnd) | 0;
        if (w > 0 && h > 0) return { x: origin.x, y: origin.y, w, h };
      } catch (_) {}
    }
    return { x: origin.x, y: origin.y, w: win.w, h: win.h };
  };

  // Some MFC floating palettes host a modeless child dialog directly under a
  // non-dialog popup (Paint's Fonts palette is the canonical example). Route
  // those clicks from the popup root so dialog_route_mouse can recurse using
  // the parent's stable client origin. The child dialog's standalone client
  // rect may not have received WM_NCCALCSIZE and can otherwise swallow every
  // combobox click despite painting at the correct screen position.
  P._dialogMouseRouteRoot = function(win) {
    if (!win || !win.isDialog || !win.isChild || !win.parentHwnd) return win;
    const parent = this.windows && this.windows[win.parentHwnd];
    return parent && !parent.isDialog ? parent : win;
  };

  P._mouseMaskForButton = function(button) {
    if (button === 2) return 0x0002; // MK_RBUTTON
    return 0x0001;                  // MK_LBUTTON (browser: 0, test harness: 1)
  };

  P._snapWinampEqButtonPoint = function(win, canvasX, canvasY, button) {
    if (!win || button === 2 || win.title !== 'Winamp Equalizer') {
      return { x: canvasX, y: canvasY, snapped: false };
    }
    const scaleX = (win.w || 0) / 275;
    const scaleY = (win.h || 0) / 116;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
      return { x: canvasX, y: canvasY, snapped: false };
    }
    const lx = (canvasX - win.x) / scaleX;
    const ly = (canvasY - win.y) / scaleY;
    const targets = [
      { x1: 10, y1: 14, x2: 43, y2: 33, cx: 26, cy: 24 },   // ON
      { x1: 39, y1: 14, x2: 76, y2: 33, cx: 55, cy: 24 },   // AUTO
      { x1: 211, y1: 14, x2: 269, y2: 33, cx: 237, cy: 24 }, // PRESETS
    ];
    for (const t of targets) {
      if (lx >= t.x1 && lx < t.x2 && ly >= t.y1 && ly < t.y2) {
        return {
          x: Math.round(win.x + t.cx * scaleX),
          y: Math.round(win.y + t.cy * scaleY),
          snapped: true,
        };
      }
    }
    return { x: canvasX, y: canvasY, snapped: false };
  };

  P._setMousePoint = function(x, y) {
    this._mouseX = x | 0;
    this._mouseY = y | 0;
  };

  P.setMousePosition = function(x, y) {
    const clipped = this._applyCursorClip ? this._applyCursorClip(x | 0, y | 0) : { x: x | 0, y: y | 0 };
    this._setMousePoint(clipped.x, clipped.y);
    this._activeInputEvent = null;
    return this.getMousePosition();
  };

  P.getMousePosition = function() {
    const active = this._activeInputEvent;
    if (active && active.type === 'mouse' && active.mouseX !== undefined && active.mouseY !== undefined) {
      return (((active.mouseY || 0) & 0xFFFF) << 16) | ((active.mouseX || 0) & 0xFFFF);
    }
    return (((this._mouseY || 0) & 0xFFFF) << 16) | ((this._mouseX || 0) & 0xFFFF);
  };

  P.getMouseButtons = function() {
    const active = this._activeInputEvent;
    if (active && active.type === 'mouse' && active.mouseButtons !== undefined) return active.mouseButtons >>> 0;
    return (this._mouseButtonsMask || 0) >>> 0;
  };

  P._signalDirectInputDevice = function(deviceType) {
    const handles = this._directInputEventHandles;
    const signal = this._directInputSignalEvent;
    if (!handles || !signal) return;
    const handle = handles[deviceType >>> 0] >>> 0;
    if (!handle) return;
    try { signal(handle); } catch (_) {}
  };

  P._consumeAsyncPressBit = function(vKey) {
    const key = vKey & 0xFF;
    if (!this._asyncPressedKeys || !this._asyncPressedKeys[key]) return 0;
    this._asyncPressedKeys[key] = false;
    return 1;
  };

  P.peekAsyncKeyState = function(vKey) {
    const key = vKey & 0xFF;
    const active = this._activeInputEvent;
    const buttons = active && active.type === 'mouse' && active.mouseButtons !== undefined
      ? active.mouseButtons
      : (this._mouseButtonsMask || 0);
    if (key === 0x01) return (buttons & 0x0001) ? 0x8000 : 0;
    if (key === 0x02) return (buttons & 0x0002) ? 0x8000 : 0;
    if (!this._asyncKeys) return 0;
    return this._asyncKeys[key] ? 0x8000 : 0;
  };

  P._applyCursorClip = function(canvasX, canvasY) {
    const we = this.wasm && this.wasm.exports;
    if (!we || !we.clip_cursor_active || !we.clip_cursor_active()) {
      return { x: canvasX, y: canvasY, active: false };
    }
    const l = we.clip_cursor_left ? (we.clip_cursor_left() | 0) : 0;
    const t = we.clip_cursor_top ? (we.clip_cursor_top() | 0) : 0;
    const r = we.clip_cursor_right ? (we.clip_cursor_right() | 0) : 0;
    const b = we.clip_cursor_bottom ? (we.clip_cursor_bottom() | 0) : 0;
    if (r <= l || b <= t) return { x: canvasX, y: canvasY, active: false };
    return {
      x: Math.min(Math.max(canvasX | 0, l), r - 1),
      y: Math.min(Math.max(canvasY | 0, t), b - 1),
      active: true,
    };
  };

  P._mapExclusiveInputPoint = function(canvasX, canvasY) {
    const t = this._exclusiveTransform;
    if (!t) return { x: canvasX, y: canvasY };
    if (canvasX < t.dstX || canvasX >= t.dstX + t.dstW ||
        canvasY < t.dstY || canvasY >= t.dstY + t.dstH) {
      return { x: -1, y: -1, outside: true };
    }
    return {
      x: t.srcX + Math.floor((canvasX - t.dstX) * t.srcW / Math.max(1, t.dstW)),
      y: t.srcY + Math.floor((canvasY - t.dstY) * t.srcH / Math.max(1, t.dstH)),
    };
  };

  P._beginWindowDrag = function(win, canvasX, canvasY) {
    this._draggingWin = {
      win,
      offsetX: canvasX - win.x,
      offsetY: canvasY - win.y,
      pendingX: win.x,
      pendingY: win.y,
    };
  };

  P._wakeMessageWait = function() {
    if (typeof performance !== 'undefined' && performance.now) {
      this._recentMessageWakeAt = performance.now();
    } else {
      this._recentMessageWakeAt = Date.now();
    }
  };

  P._closeWatDialogFrame = function(hwnd, wasm) {
    const w = wasm || this.wasm;
    const we = w && w.exports;
    if (we && we.send_message) {
      // Win32 turns a titlebar close into WM_NCLBUTTONDOWN/HTCLOSE ->
      // WM_SYSCOMMAND/SC_CLOSE -> WM_CLOSE, and applications hang their
      // shutdown work off the SC_CLOSE arm, not off WM_CLOSE. Calculator is
      // the clearest case: its whole main window is a dialog, so it comes
      // through here, and PostQuitMessage(0) exists at exactly one address
      // (0x1005bb6) inside its WM_SYSCOMMAND handler -- WM_CLOSE only calls
      // DestroyWindow. Jumping straight to WM_CLOSE therefore closed the
      // window without ever posting the quit, and did the same to every other
      // app that saves state on SC_CLOSE.
      we.send_message(hwnd, 0x0112, 0xF060, 0); // WM_SYSCOMMAND / SC_CLOSE
      // An app that leaves SC_CLOSE to DefWindowProc still gets WM_CLOSE: the
      // WAT arm posts it (09a5-handlers-window.wat), so it arrives on the
      // app's own pump. If that already tore the frame down, or the app
      // posted a quit, there is nothing further to force here.
      if (!this.windows[hwnd] || (we.get_quit_flag && we.get_quit_flag())) {
        if (we.modal_cancel_if_hwnd) we.modal_cancel_if_hwnd(hwnd);
        this._wakeMessageWait();
        this.scheduleRepaint();
        this.repaint();
        return;
      }
      const before = this.windows[hwnd];
      we.send_message(hwnd, 0x0010, 0, 0); // WM_CLOSE
      const after = this.windows[hwnd];
      if (after && after === before && after.isDialog && !after.isAboutDialog && !after.isFindDialog) {
        // Modeless CreateDialogParamA windows can return 0 from their dialog
        // proc and rely on DefDlgProc/DefWindowProc to destroy the frame. The
        // exported synchronous SendMessage path does not run that default
        // fallback, so finish the titlebar close here.
        if (we.modal_cancel_if_hwnd) we.modal_cancel_if_hwnd(hwnd);
        if (we.wnd_destroy_tree) we.wnd_destroy_tree(hwnd);
        if (we.destroy_dialog_frame) {
          we.destroy_dialog_frame(hwnd);
        } else {
          for (const k of Object.keys(this.windows)) {
            if (this.windows[k] && this.windows[k].parentHwnd === hwnd) delete this.windows[k];
          }
          delete this.windows[hwnd];
        }
      }
      if (we.modal_cancel_if_hwnd) we.modal_cancel_if_hwnd(hwnd);
      this._wakeMessageWait();
      this.scheduleRepaint();
      this.repaint();
      return;
    }
    if (we && we.modal_cancel_if_hwnd) we.modal_cancel_if_hwnd(hwnd);
    if (we && we.destroy_dialog_frame) {
      we.destroy_dialog_frame(hwnd);
    } else {
      for (const k of Object.keys(this.windows)) {
        if (this.windows[k] && this.windows[k].parentHwnd === hwnd) delete this.windows[k];
      }
      delete this.windows[hwnd];
      this.scheduleRepaint();
      this.repaint();
    }
  };

  // WindowFromPoint-style deep hit-test: given a top-level window and a
  // canvas-space click, walk the renderer's child tree to find the deepest
  // visible descendant whose rect contains the point, and return its hwnd
  // plus screen origin so callers can compute a child-local lParam. When
  // the click lands in the top window's client area but not in any child,
  // returns null (caller keeps the original top-window routing).
  //
  // Gated on `skipClass`: children whose WAT ctrl_get_class matches an
  // entry are treated as "message-transparent" for routing purposes, so
  // apps like notepad keep their existing "click goes to frame" semantics
  // for the built-in edit control (class 2). Everything else (MDI client /
  // MDI document / custom view windows) is eligible.
  P._hitTestDeepChild = function(topWin, cx, cy) {
    if (!topWin) return null;
    const wasm = topWin.wasm || this.wasm;
    const we = wasm && wasm.exports;
    if (!we || !we.wnd_child_from_point_deep || !we.wnd_window_screen_x || !we.wnd_window_screen_y) return null;
    const hwnd = we.wnd_child_from_point_deep(topWin.hwnd, cx, cy) >>> 0;
    if (!hwnd) return null;
    return {
      hwnd,
      sx: we.wnd_window_screen_x(hwnd) | 0,
      sy: we.wnd_window_screen_y(hwnd) | 0,
    };
  };

  // Native registered controls inside resource dialogs must receive mouse
  // input through the guest message loop. Synchronously calling their x86
  // wndproc while the app is yielded in GetMessage can skip stateful work on
  // WM_LBUTTONDOWN (notably SysTabControl32's selection notifications).
  P._queueNativeDialogChildMouseDown = function(win, canvasX, canvasY, msg, wParam) {
    if (!win) return false;
    const wasm = win.wasm || this.wasm;
    const we = wasm && wasm.exports;
    if (!we || !we.ctrl_get_class || !we.wnd_get_proc_export) return false;
    const deep = this._hitTestDeepChild(win, canvasX, canvasY);
    if (!deep) return false;
    const childClass = we.ctrl_get_class(deep.hwnd) | 0;
    const childProc = we.wnd_get_proc_export(deep.hwnd) >>> 0;
    // class=0 distinguishes registered/custom controls from WAT-owned USER
    // controls. WAT proc markers occupy the high 0xFFFFxxxx range; nested
    // dialog pages use one of those markers and stay on dialog_route_mouse.
    if (childClass !== 0 || childProc === 0 || childProc >= 0xFFFF0000) return false;
    const relX = canvasX - deep.sx;
    const relY = canvasY - deep.sy;
    this.wasm = wasm;
    this.wasmMemory = win.wasmMemory || this.wasmMemory;
    this._dispatchMouseEvent(win, {
      type: 'mouse',
      hwnd: deep.hwnd,
      msg,
      wParam,
      lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
    });
    this._directMouseDown = {
      win,
      targetHwnd: deep.hwnd,
      screenX: deep.sx,
      screenY: deep.sy,
    };
    this._lastDeepChild = {
      topHwnd: win.hwnd,
      childHwnd: deep.hwnd,
      sx: deep.sx,
      sy: deep.sy,
      wasm,
    };
    return true;
  };

  // Resolve a captured-mouse target (from SetCapture / $capture_hwnd) to the
  // screen origin of the coordinate space its WM_MOUSEMOVE/WM_LBUTTONUP
  // lParams should be relative to. Handles three cases:
  //   1. Top-level window in this.windows → origin = client origin.
  //   2. Renderer-known child (isChild) → origin = parent client origin.
  //   3. WAT-native child control (not in this.windows) → ask WAT for the
  //      absolute child origin and top-level owner. Covers controls created
  //      via DialogBoxParam/listbox thumb drag/etc.
  // Returns { win, screenX, screenY, targetHwnd } or null.
  P._resolveCaptureTarget = function(capHwnd, captureWasm) {
    if (!capHwnd) return null;
    const wasm = captureWasm || this.wasm;
    const we = wasm && wasm.exports;
    if (we && we.wnd_top_level && we.wnd_mouse_msg_origin_x && we.wnd_mouse_msg_origin_y) {
      const topHwnd = we.wnd_top_level(capHwnd) >>> 0;
      const top = topHwnd ? this.windows[topHwnd] : null;
      if (top) {
        const origin = {
          x: we.wnd_mouse_msg_origin_x(capHwnd) | 0,
          y: we.wnd_mouse_msg_origin_y(capHwnd) | 0,
        };
        return {
          win: top,
          screenX: origin.x,
          screenY: origin.y,
          targetHwnd: capHwnd,
          wasm,
        };
      }
    }
    const direct = this.windows[capHwnd];
    if (!direct) return null;
    const origin = direct.isPopup ? this._windowOriginScreen(capHwnd) : this._clientOriginScreen(capHwnd);
    return { win: direct, screenX: origin.x, screenY: origin.y, targetHwnd: capHwnd, wasm };
  };

  P._dispatchMouseEvent = function(ownerWin, evt) {
    this._activeInputEvent = null;
    if (evt && evt.type === 'mouse') {
      evt.mouseX = this._mouseX || 0;
      evt.mouseY = this._mouseY || 0;
      evt.mouseButtons = this._mouseButtonsMask || 0;
    }
    this.inputQueue.push(evt);
    this._wakeMessageWait();
    return false;
  };

  // Win98 Paint updates its coordinate status pane for every pointer move,
  // including moves over its floating tool/color palettes. Its MFC status
  // control keeps guest layout state but paints through WAT, so explicitly
  // refresh that tiny surface after the renderer updates the host mouse point.
  // The paired MFC control IDs make this specific to Paint rather than adding
  // redraw traffic to every application with a status bar.
  P._refreshPaintStatusForPointer = function(ownerWin, exports) {
    const e = exports || (ownerWin && ownerWin.wasm && ownerWin.wasm.exports) ||
      (this.wasm && this.wasm.exports);
    if (!ownerWin || !e || !e.wnd_next_child_slot || !e.wnd_slot_hwnd ||
        !e.ctrl_get_id || !e.send_message) return false;
    let frameHwnd = ownerWin.hwnd >>> 0;
    if (e.wnd_get_owner) {
      const owner = e.wnd_get_owner(frameHwnd) >>> 0;
      if (owner) frameHwnd = owner;
    }
    const frameWin = this.windows && this.windows[frameHwnd];
    const frameTitle = frameWin && typeof frameWin.title === 'string' ? frameWin.title : '';
    if (frameTitle !== 'Paint' && !frameTitle.endsWith(' - Paint')) return false;
    if (!this._paintStatusPointerCache) this._paintStatusPointerCache = new Map();
    const cachedStatus = this._paintStatusPointerCache.get(frameHwnd) >>> 0;
    if (cachedStatus && (e.ctrl_get_id(cachedStatus) | 0) === 0xE801) {
      e.send_message(cachedStatus, 0x000F, 0, 0); // WM_PAINT
      return true;
    }
    this._paintStatusPointerCache.delete(frameHwnd);
    let viewHwnd = 0;
    let statusHwnd = 0;
    for (let slot = 0; slot >= 0;) {
      slot = e.wnd_next_child_slot(frameHwnd, slot) | 0;
      if (slot < 0) break;
      const child = e.wnd_slot_hwnd(slot) >>> 0;
      const id = e.ctrl_get_id(child) | 0;
      if (id === 0xE900) viewHwnd = child;
      if (id === 0xE801) statusHwnd = child;
      if (viewHwnd && statusHwnd) break;
      slot++;
    }
    if (!viewHwnd || !statusHwnd) return false;
    this._paintStatusPointerCache.set(frameHwnd, statusHwnd);
    e.send_message(statusHwnd, 0x000F, 0, 0); // WM_PAINT
    return true;
  };

  P._scrollbarHitPartShared = function(wasm, longDim, coord, pos, min, max) {
    const e = wasm && wasm.exports;
    if (e && e.scrollbar_hit_part) {
      return e.scrollbar_hit_part(longDim | 0, coord | 0, pos | 0, min | 0, max | 0) | 0;
    }
    const arrow = longDim >= 36 ? 16 : 0;
    if (arrow && coord < arrow) return 1;
    if (arrow && coord >= longDim - arrow) return 2;
    const range = (max | 0) - (min | 0);
    if (range <= 0) return 0;
    const trackLen = longDim - (arrow ? arrow * 2 : 4);
    if (trackLen <= 0) return 0;
    const thumbSize = Math.max(16, Math.min(trackLen, Math.floor(trackLen / (range + 1))));
    const travel = trackLen - thumbSize;
    const thumbPos = (arrow || 2) + (travel > 0 ? Math.floor(((pos - min) * travel) / range) : 0);
    if (coord < thumbPos) return 3;
    if (coord >= thumbPos + thumbSize) return 4;
    return 5;
  };

  P._scrollbarDragPosShared = function(wasm, longDim, coord, anchorCoord, anchorPos, min, max) {
    const e = wasm && wasm.exports;
    if (e && e.scrollbar_drag_pos) {
      return e.scrollbar_drag_pos(longDim | 0, coord | 0, anchorCoord | 0, anchorPos | 0, min | 0, max | 0) | 0;
    }
    const range = (max | 0) - (min | 0);
    if (range <= 0) return min | 0;
    const arrow = longDim >= 36 ? 16 : 0;
    const trackLen = longDim - (arrow ? arrow * 2 : 4);
    if (trackLen <= 0) return anchorPos | 0;
    const thumbSize = Math.max(16, Math.min(trackLen, Math.floor(trackLen / (range + 1))));
    const travel = trackLen - thumbSize;
    if (travel <= 0) return anchorPos | 0;
    let next = (anchorPos | 0) + (((coord | 0) - (anchorCoord | 0)) * range / travel | 0);
    if (next < min) next = min | 0;
    if (next > max) next = max | 0;
    return next | 0;
  };

  P._nativeVerticalScrollInfo = function(wasm, hwnd) {
    const e = wasm && wasm.exports;
    if (!e || !e.send_message) return null;
    let pos = 0;
    let lineCount = 0;
    try {
      pos = e.send_message(hwnd, 0x00CE, 0, 0) | 0;      // EM_GETFIRSTVISIBLELINE
      lineCount = e.send_message(hwnd, 0x00BA, 0, 0) | 0; // EM_GETLINECOUNT
    } catch (_) {
      return null;
    }
    if (lineCount <= 1) return null;
    return {
      min: 0,
      max: Math.max(0, pos | 0, (lineCount | 0) - 1),
      pos: Math.max(0, pos | 0),
      lineCount: lineCount | 0,
    };
  };

  P._standardScrollInfo = function(wasm, hwnd, axis) {
    const e = wasm && wasm.exports;
    if (!e || !e.standard_scroll_pos || !e.standard_scroll_min ||
        !e.standard_scroll_max || !e.standard_scroll_page) return null;
    const bar = axis === 'v' ? 1 : 0;
    const min = e.standard_scroll_min(hwnd, bar) | 0;
    const rawMax = e.standard_scroll_max(hwnd, bar) | 0;
    const page = e.standard_scroll_page(hwnd, bar) >>> 0;
    const max = Math.max(min, rawMax - Math.max(0, page - 1));
    return {
      min,
      max,
      rawMax,
      page,
      pos: Math.max(min, Math.min(max, e.standard_scroll_pos(hwnd, bar) | 0)),
    };
  };

  P._standardScrollbarMetrics = function(longDim, info) {
    const arrow = longDim >= 36 ? 16 : 0;
    const track = Math.max(0, (longDim | 0) - arrow * 2);
    const total = Math.max(0, (info.rawMax | 0) - (info.min | 0) + 1);
    let thumb = info.page && total
      ? Math.floor(track * info.page / total)
      : 16;
    thumb = Math.max(0, Math.min(track, Math.max(16, thumb)));
    const range = Math.max(0, (info.max | 0) - (info.min | 0));
    const travel = Math.max(0, track - thumb);
    const thumbPos = arrow + (range && travel
      ? Math.floor(((info.pos | 0) - (info.min | 0)) * travel / range)
      : 0);
    return { arrow, track, thumb, range, travel, thumbPos };
  };

  P._standardScrollbarHitPart = function(longDim, coord, info) {
    const metrics = this._standardScrollbarMetrics(longDim, info);
    if (metrics.arrow && coord < metrics.arrow) return 1;
    if (metrics.arrow && coord >= longDim - metrics.arrow) return 2;
    if (!metrics.track || !metrics.range) return 0;
    if (coord < metrics.thumbPos) return 3;
    if (coord >= metrics.thumbPos + metrics.thumb) return 4;
    return 5;
  };

  P._standardScrollbarDragPos = function(drag, coord) {
    const metrics = this._standardScrollbarMetrics(drag.longDim, drag.info);
    if (!metrics.range || !metrics.travel) return drag.anchorPos | 0;
    let next = (drag.anchorPos | 0) +
      ((((coord | 0) - (drag.anchorCoord | 0)) * metrics.range / metrics.travel) | 0);
    if (next < drag.info.min) next = drag.info.min | 0;
    if (next > drag.info.max) next = drag.info.max | 0;
    return next | 0;
  };

  P._sendNativeVerticalScroll = function(wasm, hwnd, code, pos) {
    const e = wasm && wasm.exports;
    if (!e || !e.send_message || !hwnd) return false;
    const clampedPos = Math.max(0, pos | 0);
    const wParam = ((code & 0xFFFF) | ((clampedPos & 0xFFFF) << 16)) >>> 0;
    let before = 0;
    try { before = e.send_message(hwnd, 0x00CE, 0, 0) | 0; } catch (_) {}
    try {
      e.send_message(hwnd, 0x0115, wParam, 0); // WM_VSCROLL
    } catch (_) {
      return false;
    }
    // Native RichEdit builds differ in how much standard-scrollbar plumbing
    // reaches their wndproc in this environment. If a thumb message did not
    // move the viewport, reuse the standard edit scroll primitive as a narrow
    // fallback for the same requested position.
    if ((code === 4 || code === 5) && clampedPos !== before) {
      let after = before;
      try { after = e.send_message(hwnd, 0x00CE, 0, 0) | 0; } catch (_) {}
      if (after === before) {
        try { e.send_message(hwnd, 0x00B6, 0, clampedPos - before); } catch (_) {} // EM_LINESCROLL
      }
    }
    this.invalidate(hwnd);
    const parentWin = this._findParentWindow(hwnd);
    if (parentWin) this.invalidate(parentWin.hwnd);
    this.scheduleRepaint();
    return true;
  };

  P._sendStandardScroll = function(wasm, hwnd, axis, code, pos) {
    const e = wasm && wasm.exports;
    if (!e || !e.send_message || !hwnd) return false;
    const clampedPos = Math.max(0, pos | 0);
    const wParam = ((code & 0xFFFF) | ((clampedPos & 0xFFFF) << 16)) >>> 0;
    e.send_message(hwnd, axis === 'v' ? 0x0115 : 0x0114, wParam, 0);
    this.invalidate(hwnd);
    const parentWin = this._findParentWindow(hwnd);
    if (parentWin) this.invalidate(parentWin.hwnd);
    this.scheduleRepaint();
    return true;
  };

  P._nativeScrollbarHit = function(topWin, deep, canvasX, canvasY, ownerWasm) {
    if (!topWin || !deep || !deep.hwnd || !ownerWasm) return null;
    const e = ownerWasm.exports;
    if (!e || !e.send_message || !e.wnd_screen_w || !e.wnd_screen_h) return null;
    const hwnd = deep.hwnd | 0;
    if (e.ctrl_get_class) {
      const ctrlClass = e.ctrl_get_class(hwnd) | 0;
      if (ctrlClass === 2 || ctrlClass === 7) return null; // WAT EDIT/SCROLLBAR own their routing.
    }
    const childWin = this.windows && this.windows[hwnd];
    const className = String((childWin && childWin.className) || '').toLowerCase();
    const style = e.wnd_get_style_export ? (e.wnd_get_style_export(hwnd) >>> 0) : ((childWin && childWin.style) >>> 0);
    const looksRichEdit = className.indexOf('richedit') === 0;
    const hasVScroll = !!(style & 0x00200000);
    const hasHScroll = !!(style & 0x00100000);
    if (!looksRichEdit && !hasVScroll && !hasHScroll) return null;
    const sx = e.wnd_window_screen_x ? (e.wnd_window_screen_x(hwnd) | 0) : (deep.sx | 0);
    const sy = e.wnd_window_screen_y ? (e.wnd_window_screen_y(hwnd) | 0) : (deep.sy | 0);
    const w = e.wnd_screen_w(hwnd) | 0;
    const h = e.wnd_screen_h(hwnd) | 0;
    const bar = 16;
    if (w <= bar || h <= bar) return null;
    let axis = null;
    let coord = 0;
    let longDim = 0;
    if (hasVScroll && canvasX >= sx + w - bar && canvasX < sx + w &&
        canvasY >= sy && canvasY < sy + h - (hasHScroll ? bar : 0)) {
      axis = 'v';
      coord = (canvasY - sy) | 0;
      longDim = h - (hasHScroll ? bar : 0);
    } else if (hasHScroll && canvasY >= sy + h - bar && canvasY < sy + h &&
               canvasX >= sx && canvasX < sx + w - (hasVScroll ? bar : 0)) {
      axis = 'h';
      coord = (canvasX - sx) | 0;
      longDim = w - (hasVScroll ? bar : 0);
    } else {
      return null;
    }
    const standard = !looksRichEdit;
    const info = standard
      ? this._standardScrollInfo(ownerWasm, hwnd, axis)
      : this._nativeVerticalScrollInfo(ownerWasm, hwnd);
    if (!info) return null;
    const part = standard
      ? this._standardScrollbarHitPart(longDim, coord, info)
      : this._scrollbarHitPartShared(ownerWasm, longDim, coord, info.pos, info.min, info.max);
    if (!part) return null;
    return { hwnd, wasm: ownerWasm, topWin, axis, sx, sy, w, h, longDim, coord, part, info, standard };
  };

  P._handleNativeScrollbarDown = function(topWin, deep, canvasX, canvasY, ownerWasm) {
    const hit = this._nativeScrollbarHit(topWin, deep, canvasX, canvasY, ownerWasm);
    if (!hit) return false;
    const e = ownerWasm && ownerWasm.exports;
    if (e) {
      if (e.set_focus) e.set_focus(hit.hwnd);
      if (e.set_focus_hwnd && (!e.get_focus_hwnd || (e.get_focus_hwnd() | 0) !== hit.hwnd)) e.set_focus_hwnd(hit.hwnd);
    }
    const code = hit.part === 1 ? 0 :
      hit.part === 2 ? 1 :
      hit.part === 3 ? 2 :
      hit.part === 4 ? 3 : -1;
    if (code >= 0) {
      if (hit.standard) this._sendStandardScroll(ownerWasm, hit.hwnd, hit.axis, code, hit.info.pos);
      else this._sendNativeVerticalScroll(ownerWasm, hit.hwnd, code, hit.info.pos);
    }
    this._nativeScrollbarDrag = {
      hwnd: hit.hwnd,
      wasm: ownerWasm,
      topWin,
      axis: hit.axis,
      sx: hit.sx,
      sy: hit.sy,
      longDim: hit.longDim,
      part: hit.part,
      anchorCoord: hit.coord,
      anchorPos: hit.info.pos,
      min: hit.info.min,
      max: hit.info.max,
      info: hit.info,
      lastPos: hit.info.pos,
      standard: hit.standard,
    };
    return true;
  };

  P._handleNativeScrollbarMove = function(canvasX, canvasY) {
    const drag = this._nativeScrollbarDrag;
    if (!drag) return false;
    if (drag.part === 5) {
      const coord = drag.axis === 'v' ? ((canvasY - drag.sy) | 0) : ((canvasX - drag.sx) | 0);
      const next = drag.standard
        ? this._standardScrollbarDragPos(drag, coord)
        : this._scrollbarDragPosShared(
          drag.wasm,
          drag.longDim,
          coord,
          drag.anchorCoord,
          drag.anchorPos,
          drag.min,
          drag.max
        );
      if (next !== drag.lastPos) {
        drag.lastPos = next;
        if (drag.standard) this._sendStandardScroll(drag.wasm, drag.hwnd, drag.axis, 5, next);
        else this._sendNativeVerticalScroll(drag.wasm, drag.hwnd, 5, next); // SB_THUMBTRACK
      }
    }
    return true;
  };

  P._handleNativeScrollbarUp = function(canvasX, canvasY) {
    const drag = this._nativeScrollbarDrag;
    if (!drag) return false;
    if (drag.part === 5) {
      this._handleNativeScrollbarMove(canvasX, canvasY);
      if (drag.standard) this._sendStandardScroll(drag.wasm, drag.hwnd, drag.axis, 4, drag.lastPos);
      else this._sendNativeVerticalScroll(drag.wasm, drag.hwnd, 4, drag.lastPos); // SB_THUMBPOSITION
    }
    this._nativeScrollbarDrag = null;
    if (drag.standard) this._sendStandardScroll(drag.wasm, drag.hwnd, drag.axis, 8, drag.lastPos);
    else this._sendNativeVerticalScroll(drag.wasm, drag.hwnd, 8, drag.lastPos); // SB_ENDSCROLL
    return true;
  };

  P._openWorkerContextMenu = function(win, canvasX, canvasY) {
    const wasm = win && win.wasm;
    const e = wasm && wasm.exports;
    if (!win || !/wVis Plug-in/i.test(win.title || '')) return false;
    if (!e || !e.menu_track_popup_open_module || !e.get_dll_count || !e.get_dll_table || !e.get_image_base) return false;
    const mem = (win && win.wasmMemory) || this.wasmMemory;
    if (!mem || !mem.buffer) return false;

    const imageBase = e.get_image_base() >>> 0;
    const guestBase = e.get_guest_base ? (e.get_guest_base() >>> 0) : 0x12000;
    const g2w = (addr) => ((addr >>> 0) - imageBase + guestBase) >>> 0;
    const dv = new DataView(mem.buffer);
    const bytes = new Uint8Array(mem.buffer);
    const readStr = (wa, max) => {
      if (!Number.isFinite(wa) || wa < 0 || wa >= bytes.length) return '';
      let s = '';
      for (let i = 0; i < max && wa + i < bytes.length; i++) {
        const ch = bytes[wa + i];
        if (!ch) break;
        s += String.fromCharCode(ch);
      }
      return s;
    };

    let hinst = 0;
    const count = Math.max(0, Math.min(32, e.get_dll_count() | 0));
    const table = e.get_dll_table() >>> 0;
    for (let i = 0; i < count; i++) {
      const row = table + i * 32;
      if (row + 12 > dv.byteLength) break;
      const base = dv.getUint32(row, true) >>> 0;
      const expRva = dv.getUint32(row + 8, true) >>> 0;
      if (!base || !expRva) continue;
      const expWa = g2w(base + expRva);
      if (expWa + 16 > dv.byteLength) continue;
      const nameRva = dv.getUint32(expWa + 12, true) >>> 0;
      const name = readStr(g2w(base + nameRva), 96);
      if (/^(vis_w|wvis)(\.dll)?$/i.test(name) || /vis_w|wvis/i.test(name)) {
        hinst = base;
        break;
      }
    }
    if (!hinst) return false;

    // This direct worker export can allocate the menu blob. Keep the shared
    // heap pointer in sync just like ThreadManager does around worker slices.
    const mainExports = (this.mainWasm && this.mainWasm.exports) ||
      (this.wasm && this.wasm.exports) || null;
    const syncWorkerHeapIn = () => {
      if (mainExports && mainExports.get_heap_ptr && e.set_heap_ptr) {
        e.set_heap_ptr(mainExports.get_heap_ptr());
      }
      if (mainExports && mainExports.get_heap_sparse_ptr && e.set_heap_sparse_ptr) {
        e.set_heap_sparse_ptr(mainExports.get_heap_sparse_ptr());
      }
      if (mainExports && mainExports.get_heap_sparse_end && e.set_heap_sparse_end) {
        e.set_heap_sparse_end(mainExports.get_heap_sparse_end());
      }
      if (mainExports && mainExports.get_virtual_alloc_top && e.set_virtual_alloc_top) {
        e.set_virtual_alloc_top(mainExports.get_virtual_alloc_top());
      }
      if (mainExports && mainExports.get_dll_count) {
        const dllCount = mainExports.get_dll_count() | 0;
        if (e.set_dll_count) e.set_dll_count(dllCount);
        else if (e.test_set_dll_count) e.test_set_dll_count(dllCount);
      }
    };
    const syncWorkerHeapOut = () => {
      if (mainExports && mainExports.set_heap_ptr && e.get_heap_ptr) {
        mainExports.set_heap_ptr(e.get_heap_ptr());
      }
      if (mainExports && mainExports.set_heap_sparse_ptr && e.get_heap_sparse_ptr) {
        mainExports.set_heap_sparse_ptr(e.get_heap_sparse_ptr());
      }
      if (mainExports && mainExports.set_heap_sparse_end && e.get_heap_sparse_end) {
        mainExports.set_heap_sparse_end(e.get_heap_sparse_end());
      }
      if (mainExports && mainExports.set_virtual_alloc_top && e.get_virtual_alloc_top) {
        mainExports.set_virtual_alloc_top(e.get_virtual_alloc_top());
      }
    };
    const openPopup = (x, y) => {
      syncWorkerHeapIn();
      try {
        return e.menu_track_popup_open_module(win.hwnd >>> 0, hinst, 101, 0, x | 0, y | 0) | 0;
      } finally {
        syncWorkerHeapOut();
      }
    };

    let popupX = canvasX | 0;
    let popupY = canvasY | 0;
    const opened = openPopup(popupX, popupY);
    if (!opened) return false;
    if (e.menu_child_count && this.canvas) {
      const count = e.menu_child_count(win.hwnd >>> 0, 0) | 0;
      const menuW = 180;
      const menuH = count > 0 ? count * 20 + 4 : 0;
      const nextX = Math.max(0, Math.min(popupX, (this.canvas.width | 0) - menuW));
      const nextY = menuH > 0 ? Math.max(0, Math.min(popupY, (this.canvas.height | 0) - menuH)) : popupY;
      if (nextX !== popupX || nextY !== popupY) {
        popupX = nextX;
        popupY = nextY;
        openPopup(popupX, popupY);
      }
    }
    this._menuMouseCapture = true;
    this._wakeMessageWait();
    this.scheduleRepaint();
    this.repaint();
    return true;
  };

  P._openMenuContext = function() {
    const seen = new Set();
    const wasms = [];
    const add = (w) => {
      if (w && !seen.has(w)) {
        seen.add(w);
        wasms.push(w);
      }
    };
    add(this.mainWasm);
    add(this.wasm);
    for (const win of Object.values(this.windows || {})) add(win && win.wasm);
    for (const wasm of wasms) {
      const exports = wasm && wasm.exports;
      if (!exports || !exports.menu_open_hwnd) continue;
      const hwnd = exports.menu_open_hwnd() | 0;
      if (hwnd) return { wasm, exports, hwnd };
    }
    return null;
  };

  P.handleMouseDown = function(canvasX, canvasY, button, opts) {
    const mapped = this._mapExclusiveInputPoint(canvasX, canvasY);
    if (mapped.outside) return;
    canvasX = mapped.x;
    canvasY = mapped.y;
    const clipped = this._applyCursorClip(canvasX, canvasY);
    canvasX = clipped.x;
    canvasY = clipped.y;
    const forceDoubleClick = !!(opts && opts.doubleClick);
    const buttonMask = this._mouseMaskForButton(button);
    const ctrlDown = !!((opts && opts.ctrlKey) || this._ctrlDown);
    const shiftDown = !!((opts && opts.shiftKey) || this._shiftDown);
    const mouseWParam = buttonMask | (shiftDown ? 0x0004 : 0) | (ctrlDown ? 0x0008 : 0);
    const inputWasm = this._inputWasmAtPoint(canvasX, canvasY);
    this._pointerInputWasm = inputWasm;
    this._mouseButtonsMask = (this._mouseButtonsMask || 0) | buttonMask;
    this._signalDirectInputDevice(2);
    if (!this._asyncPressedKeys) this._asyncPressedKeys = Object.create(null);
    if (buttonMask & 0x0001) this._asyncPressedKeys[0x01] = true;
    if (buttonMask & 0x0002) this._asyncPressedKeys[0x02] = true;
    this._setMousePoint(canvasX, canvasY);
    // Modal dialog: block input to other windows
    const modalHwnd = this._modalDialogHwnd(inputWasm);
    const modal = modalHwnd ? this.windows[modalHwnd] : null;
    if (modalHwnd) {
      // Only allow clicks within the modal
      const modalWasm = (modal && modal.wasm) || this.wasm;
      const modalExports = modalWasm && modalWasm.exports;
      const mx = modalExports && modalExports.wnd_window_screen_x ? (modalExports.wnd_window_screen_x(modalHwnd) | 0) : (modal ? modal.x : 0);
      const my = modalExports && modalExports.wnd_window_screen_y ? (modalExports.wnd_window_screen_y(modalHwnd) | 0) : (modal ? modal.y : 0);
      const mw = modalExports && modalExports.wnd_screen_w ? (modalExports.wnd_screen_w(modalHwnd) | 0) : (modal ? modal.w : 0);
      const mh = modalExports && modalExports.wnd_screen_h ? (modalExports.wnd_screen_h(modalHwnd) | 0) : (modal ? modal.h : 0);
      if (canvasX < mx || canvasX >= mx + mw ||
          canvasY < my || canvasY >= my + mh) {
        return; // block
      }
      if (button !== 2 && this._queueNativeDialogChildMouseDown(
          modal, canvasX, canvasY, forceDoubleClick ? 0x0203 : 0x0201, mouseWParam)) {
        return;
      }
      if (button !== 2 && modalExports && (modalExports.dialog_route_mouse_screen || modalExports.dialog_route_mouse)) {
        const msg = forceDoubleClick ? 0x0203 : 0x0201;
        const routed = modalExports.dialog_route_mouse_screen
          ? (modalExports.dialog_route_mouse_screen(modalHwnd, msg, mouseWParam, canvasX, canvasY) | 0)
          : (() => {
              const ox = modalExports.wnd_client_screen_x ? (modalExports.wnd_client_screen_x(modalHwnd) | 0) : (modal ? modal.clientRect.x : 0);
              const oy = modalExports.wnd_client_screen_y ? (modalExports.wnd_client_screen_y(modalHwnd) | 0) : (modal ? modal.clientRect.y : 0);
              const lp = (((canvasX - ox) & 0xFFFF) | (((canvasY - oy) & 0xFFFF) << 16)) >>> 0;
              return modalExports.dialog_route_mouse(modalHwnd, msg, mouseWParam, lp) | 0;
            })();
        if (routed) {
          this.wasm = modalWasm;
          this.wasmMemory = modal.wasmMemory || this.wasmMemory;
          this._wakeMessageWait();
          this._dialogBtnDrag = { parent: modalHwnd, downLParam: 0, clientX: 0, clientY: 0, wasm: modalWasm };
          this.scheduleRepaint();
          this.repaint();
          return;
        }
      }
    }

    // Menu tracking is WAT-side. JS only forwards the screen point.
    {
      const menu = this._openMenuContext();
      if (menu) {
        const we = menu.exports;
        let handled = 0;
        if (we.menu_handle_mouse_open) handled = we.menu_handle_mouse_open(canvasX, canvasY) | 0;
        if (handled && we.get_capture_hwnd && we.get_capture_hwnd() !== 0 && we.release_capture) {
          we.release_capture();
        }
        this._menuMouseCapture = true;
        this.repaint();
        return;
      }
    }

    // Direct WAT child hit-test for the modeless Find dialog. Its frame is a
    // top-level browser canvas, but all child controls live only in WAT.
    {
      const findWindows = Object.values(this.windows)
        .filter(w => w && w.visible && w.isFindDialog &&
          canvasX >= w.x && canvasX < w.x + w.w &&
          canvasY >= w.y && canvasY < w.y + w.h)
        .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
      const fallbackWasm = this.wasm;
      if (!findWindows.length && fallbackWasm && fallbackWasm.exports && fallbackWasm.exports.get_findreplace_dlg) {
        const dlg = fallbackWasm.exports.get_findreplace_dlg() | 0;
        if (dlg) findWindows.push({ hwnd: dlg, wasm: fallbackWasm });
      }
      for (const findWin of findWindows) {
        const wasm = findWin.wasm || fallbackWasm;
        const we = wasm && wasm.exports;
        const dlg = findWin.hwnd | 0;
        if (!dlg || button === 2 || !we || !we.wnd_next_child_slot || !we.wnd_slot_hwnd ||
            !we.wnd_window_screen_x || !we.wnd_window_screen_y || !we.wnd_screen_w || !we.wnd_screen_h ||
            !we.send_message) continue;
        let slot = 0;
        while ((slot = we.wnd_next_child_slot(dlg, slot)) !== -1) {
          const ch = we.wnd_slot_hwnd(slot) | 0;
          slot++;
          if (!ch) continue;
          const x = we.wnd_window_screen_x(ch) | 0;
          const y = we.wnd_window_screen_y(ch) | 0;
          const w = we.wnd_screen_w(ch) | 0;
          const h = we.wnd_screen_h(ch) | 0;
          if (canvasX < x || canvasX >= x + w || canvasY < y || canvasY >= y + h) continue;
          const style = we.wnd_get_style_export ? (we.wnd_get_style_export(ch) >>> 0) : 0;
          if ((style & 0x0F) === 7) continue; // BS_GROUPBOX is a visual frame, not the click target.
          const msg = forceDoubleClick ? 0x0203 : 0x0201;
          const lp = (((canvasY - y) & 0xFFFF) << 16) | ((canvasX - x) & 0xFFFF);
          we.send_message(ch, msg, mouseWParam, lp);
          this._dialogBtnDrag = { target: ch, sx: x, sy: y, wasm };
          this.scheduleRepaint();
          this.repaint();
          return;
        }
      }
    }

    // Find which window was clicked. Embedded wizard pages are separate
    // dialog windows inside the outer frame; when dialogs overlap at the
    // pointer, prefer the innermost/smaller dialog so child controls receive
    // mouse input instead of the frame swallowing it.
    const sortedWins = Object.values(this.windows)
      .filter(w => w.visible && (!w.isChild || w.isFindDialog || w.isAboutDialog || w.isDialog))
      .filter(w => {
        const r = this._windowRectScreen(w);
        return canvasX >= r.x && canvasX < r.x + r.w &&
               canvasY >= r.y && canvasY < r.y + r.h;
      })
      .sort((a, b) => {
        // Keep the inner-dialog preference local to one emulator instance.
        // Cross-app overlap follows the renderer's global z-order.
        if (a.wasm !== b.wasm) return (b.zOrder || 0) - (a.zOrder || 0);
        // An owned popup that really is above the other window wins outright.
        // A combobox dropdown is a WS_POPUP owned by the combo and is not a
        // dialog, so the inner-dialog preference below used to hand every
        // click over its open list to the dialog underneath -- the list
        // dismissed and nothing was ever picked. Pinball's Player Controls is
        // the visible case: clicking a key in the Left Flipper list fell
        // through to whichever combo sat beneath the popup and opened THAT.
        const aPopup = !!(a.ownerHwnd && !a.isDialog && !a.isChild);
        const bPopup = !!(b.ownerHwnd && !b.isDialog && !b.isChild);
        if (aPopup !== bPopup) {
          const az = a.zOrder || 0, bz = b.zOrder || 0;
          if (aPopup && az > bz) return -1;
          if (bPopup && bz > az) return 1;
        }
        const ad = !!(a.isFindDialog || a.isAboutDialog || a.isDialog);
        const bd = !!(b.isFindDialog || b.isAboutDialog || b.isDialog);
        if (ad !== bd) return ad ? -1 : 1;
        if (ad && bd) return (a.w * a.h) - (b.w * b.h) || ((b.zOrder || 0) - (a.zOrder || 0));
        return (b.zOrder || 0) - (a.zOrder || 0);
      });
    for (const win of sortedWins) {
      // Bring clicked window to front
      this._raiseWindowGroup(win);
      this._setKeyboardInputOwner(win);
      this.scheduleRepaint();

      // Clicking outside any WAT-managed dialog transfers focus to the
      // clicked top-level window. Native edits still receive
      // WM_KILLFOCUS/EN_KILLFOCUS (Paint commits its active text object
      // during this step), while an already-focused game window remains
      // focused instead of receiving a spurious WM_KILLFOCUS to NULL.
      // Native child clicks retain the established two-step transfer: release
      // here, then focus the deep child in the client-routing path below.
      // Skip for *any* dialog — modal dialogs
      // (DialogBoxParamA/W) also own WAT-native edits and need
      // edit_wndproc's focus-transfer path to deliver WM_KILLFOCUS when
      // the user clicks between their fields.
      if (!win.isFindDialog && !win.isAboutDialog && !win.isDialog) {
        const w = win.wasm || this.wasm;
        const we = w && w.exports;
        const deepFocusTarget = button !== 2 ? this._hitTestDeepChild(win, canvasX, canvasY) : null;
        const targetFocus = deepFocusTarget ? 0 : (win.hwnd | 0);
        const currentFocus = (we && we.get_focus_hwnd) ? (we.get_focus_hwnd() | 0) : 0;
        if (we && currentFocus !== targetFocus) {
          if (we.set_focus) we.set_focus(targetFocus);
          // Native top-level wndprocs do not necessarily mirror
          // WM_SETFOCUS into the emulator's focus global.
          if (we.set_focus_hwnd && (!we.get_focus_hwnd || (we.get_focus_hwnd() | 0) !== targetFocus)) {
            we.set_focus_hwnd(targetFocus);
          }
        }
      }

      // Modal dialogs have WAT-native child controls, but their frame is
      // renderer-known. Keep non-client dialog clicks out of the generic
      // guest mouse route; that path can re-enter app code that expects a
      // client message.
      if (win.isDialog && !win.isAboutDialog && (win.ownerHwnd || win.parentHwnd) && button !== 2) {
        const r = this._windowRectScreen(win);
        if (typeof this._computeClientRect === 'function') this._computeClientRect(win);
        const client = win.clientRect || {
          x: r.x + 3,
          y: r.y + 23,
          w: Math.max(0, r.w - 6),
          h: Math.max(0, r.h - 26),
        };
        const inClient = canvasX >= client.x && canvasX < client.x + client.w &&
                         canvasY >= client.y && canvasY < client.y + client.h;
        if (!inClient) {
          const w = win.wasm || this.wasm;
          const we = w && w.exports;
          const hit = (we && we.hittest_sync) ? (we.hittest_sync(win.hwnd, canvasX, canvasY) | 0) : 0;
          if (hit === 2) {
            this._beginWindowDrag(win, canvasX, canvasY);
            return;
          }
          const inClose =
            canvasX >= r.x + r.w - 24 && canvasX < r.x + r.w - 3 &&
            canvasY >= r.y + 3 && canvasY < r.y + 23;
          if (hit === 20 || inClose) {
            this._closeWatDialogFrame(win.hwnd, w);
          }
          if (win.isChild && win.parentHwnd) continue;
          return;
        }
      }

      const appDrawnChrome = !!win.region;

      // Title-bar button clicks. WAT owns hit-test, pressed visual state,
      // cancel-on-release-outside, and eventual WM_NCLBUTTONDOWN posting.
      if (!appDrawnChrome && this._hasCaption(win)) {
        const w = win.wasm || this.wasm;
        const we = w && w.exports;
        const hit = (we && we.nc_sysbutton_down)
          ? (we.nc_sysbutton_down(win.hwnd, canvasX, canvasY) | 0)
          : 0;
        if (hit) {
          this._sysBtnDrag = { hwnd: win.hwnd, wasm: w };
          this.repaint();
          return;
        }
      }

      // Resize-edge drag. WAT's $defwndproc_do_nchittest returns HT codes
      // 10..17 (LEFT/RIGHT/TOP/BOTTOM + corners) only for windows with
      // WS_THICKFRAME, so the style gate lives on the guest side.
      {
        const w = win.wasm || this.wasm;
        const we = w && w.exports;
        const hit = (!appDrawnChrome && we && we.hittest_sync) ? (we.hittest_sync(win.hwnd, canvasX, canvasY) | 0) : 0;
        if (hit >= 10 && hit <= 17) {
          this._syncResizeCursor(hit);
          this._resizingWin = {
            hwnd: win.hwnd, win, hit, wasm: w,
            startX: canvasX, startY: canvasY,
            origX: win.x, origY: win.y, origW: win.w, origH: win.h,
          };
          return;
        }
      }

      // Title bar drag to move window
      if (!appDrawnChrome && (this._hasCaption(win) || win.hasCaption)) {
        const w = win.wasm || this.wasm;
        const we = w && w.exports;
        const hit = (we && we.hittest_sync) ? (we.hittest_sync(win.hwnd, canvasX, canvasY) | 0) : 0;
        if (hit === 2) {
          this._beginWindowDrag(win, canvasX, canvasY);
          return;
        }
      }

      // Check menu bar clicks. Ask WAT even when the bar has not painted yet;
      // early headless snapshots can have a pending menu blob before chrome
      // pixels are visible.
      if (!appDrawnChrome && !win.isChild && win._menuId) {
        if (typeof this._ensureWatMenu === 'function') this._ensureWatMenu(win);
        const w = win.wasm || this.wasm;
        const we = w && w.exports;
        if (we && we.menu_handle_bar_click) {
          const opened = we.menu_handle_bar_click(win.hwnd, canvasX, canvasY) | 0;
          if (opened) {
            this._menuMouseCapture = true;
            this.repaint();
            return;
          }
        }
      }

      if (typeof this._computeClientRect === 'function') this._computeClientRect(win);
      const clientOrigin = this._mouseMsgOriginScreen(win.hwnd);
      const clientX = clientOrigin.x;
      const clientY = clientOrigin.y;

      // WAT-managed dialogs: route the click into WAT, which hit-tests
      // CONTROL_GEOM children and dispatches WM_LBUTTONDOWN/UP to the
      // matching button / edit / listbox / colorgrid. Group-boxes are
      // filtered out WAT-side. Covers FindReplace, About, and
      // DialogBoxParamA/CreateDialogParamA dialogs.
      const isWatDialog = !!(win.isFindDialog || win.isAboutDialog || win.isDialog);
      if (button !== 2 && isWatDialog) {
        const dialogWasm = win.wasm || this.wasm;
        const we = dialogWasm && dialogWasm.exports;
        if (this._queueNativeDialogChildMouseDown(
            win, canvasX, canvasY, forceDoubleClick ? 0x0203 : 0x0201, mouseWParam)) {
          return;
        }
          if (we && (we.dialog_route_mouse_screen || we.dialog_route_mouse)) {
            let routeWin = this._dialogMouseRouteRoot(win);
            let routeHwnd = routeWin.hwnd;
            if (routeWin && typeof this._computeClientRect === 'function') this._computeClientRect(routeWin);
          const routeOrigin = routeWin && routeWin.isPopup
            ? this._windowOriginScreen(routeHwnd)
            : this._clientOriginScreen(routeHwnd);
          const routeClientX = routeOrigin.x;
          const routeClientY = routeOrigin.y;
          const lx = canvasX - routeClientX;
          const ly = canvasY - routeClientY;
          const lParam = ((lx & 0xFFFF) | ((ly & 0xFFFF) << 16)) >>> 0;
          // Auto-detect double-click: a second LBUTTONDOWN within 500ms
          // and 4px of the same dialog becomes WM_LBUTTONDBLCLK so the
          // edit's word-select handler fires. Same window matches real
          // Win32 behavior (no CS_DBLCLKS check — we always fold).
          const msg = forceDoubleClick ? 0x0203 : 0x0201; // WM_LBUTTONDBLCLK / WM_LBUTTONDOWN
          // Send the down (or dblclk) now; defer WM_LBUTTONUP to
          // handleMouseUp so the user actually sees the button's pressed
          // state while held. (button_wndproc sets the pressed flag on
          // DOWN and clears it on UP; if both fire in the same tick, the
          // pressed visual is never composited.) Cache (parent, lParam)
          // so mouseup can route UP to the same child via
          // dialog_route_mouse.
          let routed = we.dialog_route_mouse_screen
            ? (we.dialog_route_mouse_screen(routeHwnd, msg, mouseWParam, canvasX, canvasY) | 0)
            : (we.dialog_route_mouse(routeHwnd, msg, mouseWParam, lParam) | 0);
          let routedLParam = lParam;
          let routedClientX = routeClientX;
          let routedClientY = routeClientY;
          if (!routed && routeWin && routeWin.isChild && we.dialog_ancestor) {
            const parentHwnd = we.dialog_ancestor(routeHwnd) | 0;
            if (parentHwnd && parentHwnd !== routeHwnd) {
              const parentOrigin = {
                x: we.wnd_mouse_msg_origin_x ? (we.wnd_mouse_msg_origin_x(parentHwnd) | 0) : this._clientOriginScreen(parentHwnd).x,
                y: we.wnd_mouse_msg_origin_y ? (we.wnd_mouse_msg_origin_y(parentHwnd) | 0) : this._clientOriginScreen(parentHwnd).y,
              };
              const parentLx = canvasX - parentOrigin.x;
              const parentLy = canvasY - parentOrigin.y;
              const parentLParam = ((parentLx & 0xFFFF) | ((parentLy & 0xFFFF) << 16)) >>> 0;
              const ok = we.dialog_route_mouse_screen
                ? we.dialog_route_mouse_screen(parentHwnd, msg, mouseWParam, canvasX, canvasY)
                : we.dialog_route_mouse(parentHwnd, msg, mouseWParam, parentLParam);
              if (ok) {
                routed = 1;
                routeHwnd = parentHwnd;
                routedLParam = parentLParam;
                routedClientX = parentOrigin.x;
                routedClientY = parentOrigin.y;
              }
            }
          }
          if (routed) {
            this.wasm = dialogWasm;
            this.wasmMemory = win.wasmMemory || this.wasmMemory;
            this._wakeMessageWait();
            this._dialogBtnDrag = {
              parent: routeHwnd,
              downLParam: routedLParam,
              clientX: routedClientX,
              clientY: routedClientY,
              wasm: dialogWasm,
            };
            this.scheduleRepaint();
            this.repaint();
            return;
          }
        }
        if (isWatDialog) return;
      }

      if (canvasX >= win.x && canvasX < win.x + win.w &&
          canvasY >= win.y && canvasY < win.y + win.h) {
        const snapped = this._snapWinampEqButtonPoint(win, canvasX, canvasY, button);
        if (snapped.snapped) {
          canvasX = snapped.x;
          canvasY = snapped.y;
          this._setMousePoint(canvasX, canvasY);
        }
        // WindowFromPoint: if a child of this top-level contains the click,
        // deliver to the child with child-local lParam (MDI document etc.).
        const deep = this._hitTestDeepChild(win, canvasX, canvasY);
        const targetHwnd = deep ? deep.hwnd : win.hwnd;
        const relX = deep ? (canvasX - deep.sx) : (canvasX - clientX);
        const relY = deep ? (canvasY - deep.sy) : (canvasY - clientY);
        const ownerWasm = (win && win.wasm) || this.wasm;
        let msg = button === 2 ? 0x0204 : 0x0201; // WM_RBUTTONDOWN / WM_LBUTTONDOWN
        if (button !== 2) {
          if (forceDoubleClick) msg = 0x0203; // WM_LBUTTONDBLCLK
        }
        {
          const we = this.wasm && this.wasm.exports;
          if (button !== 2 && isWatDialog && deep && we && (we.dialog_route_mouse_screen || we.dialog_route_mouse)) {
            const routedLParam = ((relX & 0xFFFF) | ((relY & 0xFFFF) << 16)) >>> 0;
            const ok = we.dialog_route_mouse_screen
              ? we.dialog_route_mouse_screen(targetHwnd, msg, mouseWParam, canvasX, canvasY)
              : we.dialog_route_mouse(targetHwnd, msg, mouseWParam, routedLParam);
            if (ok) {
              this._wakeMessageWait();
              this._dialogBtnDrag = { parent: targetHwnd, downLParam: routedLParam, clientX: deep.sx, clientY: deep.sy };
              this.scheduleRepaint();
              this.repaint();
              return;
            }
          }
        }
        if (button !== 2 && deep && this._handleNativeScrollbarDown(win, deep, canvasX, canvasY, ownerWasm)) {
          this._lastDeepChild = null;
          this.scheduleRepaint();
          this.repaint();
          return;
        }
        const mainWasm = this.mainWasm || this.wasm;
        if (button !== 2 && deep && targetHwnd && ownerWasm && ownerWasm.exports) {
          const e = ownerWasm.exports;
          const currentFocus = e.get_focus_hwnd ? (e.get_focus_hwnd() | 0) : 0;
          if (currentFocus !== (targetHwnd | 0)) {
            if (e.set_focus) e.set_focus(targetHwnd | 0);
            if (e.set_focus_hwnd && (!e.get_focus_hwnd || (e.get_focus_hwnd() | 0) !== (targetHwnd | 0))) {
              e.set_focus_hwnd(targetHwnd | 0);
            }
          }
          this.wasm = ownerWasm;
          this.wasmMemory = win.wasmMemory || this.wasmMemory;
        }
        if (button === 2 && ownerWasm && ownerWasm !== mainWasm &&
            ownerWasm.exports && ownerWasm.exports.send_message) {
          this._directMouseDown = { win, targetHwnd, screenX: deep ? deep.sx : clientX, screenY: deep ? deep.sy : clientY };
          this._lastDeepChild = null;
          return;
        }
        const dispatchedDirect = this._dispatchMouseEvent(win, {
          type: 'mouse',
          hwnd: targetHwnd,
          msg,
          wParam: mouseWParam,
          lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
        });
        if (dispatchedDirect) {
          this._directMouseDown = { win, targetHwnd, screenX: deep ? deep.sx : clientX, screenY: deep ? deep.sy : clientY };
        }
        this._lastDeepChild = deep
          ? { topHwnd: win.hwnd, childHwnd: deep.hwnd, sx: deep.sx, sy: deep.sy, wasm: ownerWasm }
          : null;
        return;
      }
    }
  }

  P.handleMouseUp = function(canvasX, canvasY, button) {
    const mapped = this._mapExclusiveInputPoint(canvasX, canvasY);
    if (mapped.outside) {
      const mask = this._mouseMaskForButton(button);
      this._mouseButtonsMask = (this._mouseButtonsMask || 0) & ~mask;
      return;
    }
    canvasX = mapped.x;
    canvasY = mapped.y;
    const clipped = this._applyCursorClip(canvasX, canvasY);
    canvasX = clipped.x;
    canvasY = clipped.y;
    const upMask = this._mouseMaskForButton(button);
    const inputWasm = this._pointerInputWasm || this._inputWasmAtPoint(canvasX, canvasY);
    this._pointerInputWasm = null;
    this._mouseButtonsMask = (this._mouseButtonsMask || 0) & ~upMask;
    this._signalDirectInputDevice(2);
    this._setMousePoint(canvasX, canvasY);
    if (this._resizingWin) {
      const r = this._resizingWin;
      this._resizingWin = null;
      const nx = Number.isFinite(r.pendingX) ? r.pendingX : r.origX;
      const ny = Number.isFinite(r.pendingY) ? r.pendingY : r.origY;
      const nw = Number.isFinite(r.pendingW) ? r.pendingW : r.origW;
      const nh = Number.isFinite(r.pendingH) ? r.pendingH : r.origH;
      r.win.x = nx | 0;
      r.win.y = ny | 0;
      r.win.w = nw | 0;
      r.win.h = nh | 0;
      r.win._backCanvas = null;
      r.win._backCtx = null;
      r.win._backW = 0;
      r.win._backH = 0;
      this._resizeOutline = null;
      const w = r.wasm || (r.win && r.win.wasm) || this.wasm;
      const we = w && w.exports;
      if (we && we.host_resize_commit) {
        we.host_resize_commit(r.hwnd, r.win.x, r.win.y, r.win.w, r.win.h);
      }
      const hit = we && we.hittest_sync
        ? (we.hittest_sync(r.hwnd, canvasX, canvasY) | 0)
        : 0;
      this._syncResizeCursor(hit);
      this.queuePaint(r.hwnd);
      this.repaint();
      return;
    }
    if (this._draggingWin) {
      const drag = this._draggingWin;
      this._draggingWin = null;
      const win = drag.win;
      const nx = Number.isFinite(drag.pendingX) ? drag.pendingX : canvasX - drag.offsetX;
      const ny = Number.isFinite(drag.pendingY) ? drag.pendingY : canvasY - drag.offsetY;
      win.x = nx | 0;
      win.y = ny | 0;
      if (typeof this._computeClientRect === 'function') this._computeClientRect(win);
      const w = win.wasm || this.wasm;
      const we = w && w.exports;
      if (we && we.host_move_commit) {
        we.host_move_commit(win.hwnd, win.x, win.y);
      }
      this.queuePaint(win.hwnd);
      this.repaint();
      return;
    }
    if (button !== 2 && this._handleNativeScrollbarUp(canvasX, canvasY)) {
      this.scheduleRepaint();
      this.repaint();
      return;
    }
    const modalHwnd = this._modalDialogHwnd(inputWasm);
    const modal = modalHwnd ? this.windows[modalHwnd] : null;
    if (modal && button !== 2) {
      if (this._dialogBtnDrag && this._dialogBtnDrag.parent !== modalHwnd) {
        this._dialogBtnDrag = null;
        this.scheduleRepaint();
        this.repaint();
        return;
      }
      if (canvasX < modal.x || canvasX >= modal.x + modal.w ||
          canvasY < modal.y || canvasY >= modal.y + modal.h) {
        return;
      }
    }
    if (button !== 2) {
      const dialogWins = Object.values(this.windows)
        .filter(w => w && w.visible && w.wasm === inputWasm &&
          w.isDialog && !w.isAboutDialog && (w.ownerHwnd || w.parentHwnd))
        .filter(w => {
          const r = this._windowRectScreen(w);
          return canvasX >= r.x && canvasX < r.x + r.w &&
                 canvasY >= r.y && canvasY < r.y + r.h;
        })
        .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
      const dlg = dialogWins[0];
      if (dlg) {
        const r = this._windowRectScreen(dlg);
        if (typeof this._computeClientRect === 'function') this._computeClientRect(dlg);
        const client = dlg.clientRect || {
          x: r.x + 3,
          y: r.y + 23,
          w: Math.max(0, r.w - 6),
          h: Math.max(0, r.h - 26),
        };
        const inClient =
          canvasX >= client.x && canvasX < client.x + client.w &&
          canvasY >= client.y && canvasY < client.y + client.h;
        if (!inClient) {
          if (canvasX >= r.x + r.w - 24 && canvasX < r.x + r.w - 3 &&
              canvasY >= r.y + 3 && canvasY < r.y + 23) {
            this._closeWatDialogFrame(dlg.hwnd, dlg.wasm || this.wasm);
          }
          if (!(dlg.isChild && dlg.parentHwnd)) return;
        }
      }
    }

    // End deferred dialog button press. Send WM_LBUTTONUP to the same
    // control that received the DOWN by routing through the parent again
    // with the cursor's current position. button_wndproc clears its
    // pressed flag and (for kinds that auto-toggle) processes the click.
    if (this._dialogBtnDrag && button !== 2) {
      const drag = this._dialogBtnDrag;
      this._dialogBtnDrag = null;
      const dragWasm = drag.wasm || this.wasm;
      const we = dragWasm && dragWasm.exports;
      if (drag.target && we) {
        const lx = canvasX - drag.sx;
        const ly = canvasY - drag.sy;
        const lParam = ((lx & 0xFFFF) | ((ly & 0xFFFF) << 16)) >>> 0;
        this.wasm = dragWasm;
        this._dispatchMouseEvent(this.windows[drag.target] || null, {
          type: 'mouse', hwnd: drag.target, msg: 0x0202, wParam: 0, lParam,
        });
        this.scheduleRepaint();
        this.repaint();
        return;
      }
      if (we && (we.dialog_route_mouse_screen || we.dialog_route_mouse)) {
        // A dialog button captures the mouse on DOWN. Deliver its UP through
        // GetMessage/DispatchMessage so a modal loop resumes after the button
        // procedure returns. Calling the child synchronously while the guest
        // is yielded inside GetMessage can strand native modal controls after
        // they set their completion state (for example, a property sheet).
        // WAT-owned modal dialogs run through the emulator's synchronous
        // dialog manager, so their release must stay on dialog_route_mouse.
        // Native guest dialogs have no WAT modal hwnd and need a queued UP to
        // wake their GetMessage/DispatchMessage loop.
        const captureHwnd = !modalHwnd && we.get_capture_hwnd ? (we.get_capture_hwnd() | 0) : 0;
        const capture = captureHwnd ? this._resolveCaptureTarget(captureHwnd, dragWasm) : null;
        if (capture) {
          const lx = canvasX - capture.screenX;
          const ly = canvasY - capture.screenY;
          this.wasm = dragWasm;
          this.wasmMemory = capture.win.wasmMemory || this.wasmMemory;
          const lp = (((ly & 0xFFFF) << 16) | (lx & 0xFFFF)) >>> 0;
          const captureClass = we.ctrl_get_class ? (we.ctrl_get_class(capture.targetHwnd) | 0) : 0;
          const captureTop = we.wnd_top_level ? (we.wnd_top_level(capture.targetHwnd) | 0) : 0;
          const captureOwner = captureTop && we.wnd_get_owner ? (we.wnd_get_owner(captureTop) | 0) : 0;
          if (captureClass && (captureClass !== 1 || !captureOwner) && we.send_message) {
            // WAT-owned controls do not need the guest GetMessage loop to
            // dispatch their captured release. Buttons in owned native guest
            // dialogs remain queued because their modal loops must resume;
            // ownerless main dialogs such as sndvol32 can dispatch directly.
            we.send_message(capture.targetHwnd, 0x0202, 0, lp);
          } else {
            this._dispatchMouseEvent(capture.win, {
              type: 'mouse',
              hwnd: capture.targetHwnd,
              msg: 0x0202,
              wParam: 0,
              lParam: lp,
            });
          }
          this.scheduleRepaint();
          this.repaint();
          return;
        }
        const lx = canvasX - drag.clientX;
        const ly = canvasY - drag.clientY;
        const lParam = ((lx & 0xFFFF) | ((ly & 0xFFFF) << 16)) >>> 0;
        // Try UP at current pos first (matches the button if the user is
        // still over it). If that misses (released outside), fall back to
        // routing UP at the original DOWN coordinates so the originating
        // button still clears its pressed flag.
        const upOk = we.dialog_route_mouse_screen
          ? we.dialog_route_mouse_screen(drag.parent, 0x0202, 0, canvasX, canvasY)
          : we.dialog_route_mouse(drag.parent, 0x0202, 0, lParam);
        if (!upOk) {
          if (we.dialog_route_mouse_screen) {
            we.dialog_route_mouse(drag.parent, 0x0202, 0, drag.downLParam);
          } else {
            we.dialog_route_mouse(drag.parent, 0x0202, 0, drag.downLParam);
          }
        }
        this._wakeMessageWait();
        this.scheduleRepaint();
        this.repaint();
      }
      return;
    }

    if (this._directMouseDown) {
      const d = this._directMouseDown;
      this._directMouseDown = null;
      if (button === 2 && this._openWorkerContextMenu(d.win, canvasX, canvasY)) {
        this._lastDeepChild = null;
        return;
      }
      const relX = canvasX - d.screenX;
      const relY = canvasY - d.screenY;
      this._dispatchMouseEvent(d.win, {
        type: 'mouse',
        hwnd: d.targetHwnd,
        msg: button === 2 ? 0x0205 : 0x0202,
        wParam: 0,
        lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
      });
      this._lastDeepChild = null;
      return;
    }

    // End sysbutton press. WAT owns release/cancel/dispatch.
    if (this._sysBtnDrag && button !== 2) {
      const drag = this._sysBtnDrag;
      this._sysBtnDrag = null;
      const w = drag.wasm || this.wasm;
      const we = w && w.exports;
      const dragWin = this.windows[drag.hwnd];
      if (dragWin && dragWin.isDialog && !dragWin.isAboutDialog) {
        this._closeWatDialogFrame(drag.hwnd, w);
        return;
      }
      if (we && we.nc_sysbutton_up) we.nc_sysbutton_up(canvasX, canvasY);
      this.repaint();
      return;
    }

    // Menus capture the mouse while tracking. The opening/selection work is
    // done on button-down in the WAT menu tracker; the matching button-up
    // must be consumed instead of leaking to the app window underneath.
    if (this._menuMouseCapture && button !== 2) {
      this._menuMouseCapture = false;
      this.repaint();
      return;
    }

    // If a window has mouse capture, route mouse-up to it regardless of position.
    // Works for both renderer-known windows and WAT-native child controls. This
    // runs after _dialogBtnDrag so dialog buttons get their synchronous
    // WM_LBUTTONUP/WM_COMMAND path instead of a generic queued mouse message.
    const captureWasm = (this._dialogBtnDrag && this._dialogBtnDrag.wasm) ||
      (this._lastDeepChild && this._lastDeepChild.wasm) || this.wasm;
    const we = captureWasm && captureWasm.exports;
    const capHwnd = we && we.get_capture_hwnd && we.get_capture_hwnd();
    const cap = capHwnd ? this._resolveCaptureTarget(capHwnd, captureWasm) : null;
    if (cap) {
      const capWin = this.windows[cap.targetHwnd] || cap.win;
      const snapped = this._snapWinampEqButtonPoint(capWin, canvasX, canvasY, button);
      const upX = snapped.snapped ? snapped.x : canvasX;
      const upY = snapped.snapped ? snapped.y : canvasY;
      if (snapped.snapped) this._setMousePoint(upX, upY);
      const relX = upX - cap.screenX;
      const relY = upY - cap.screenY;
      const msg = button === 2 ? 0x0205 : 0x0202; // WM_RBUTTONUP / WM_LBUTTONUP
      const lParam = (((relY & 0xFFFF) << 16) | (relX & 0xFFFF)) >>> 0;
      const captureClass = we.ctrl_get_class ? (we.ctrl_get_class(cap.targetHwnd) | 0) : 0;
      if (captureClass && we.send_message) {
        we.send_message(cap.targetHwnd, msg, 0, lParam);
      } else {
        this._dispatchMouseEvent(cap.win, {
          type: 'mouse', hwnd: cap.targetHwnd, msg, wParam: 0, lParam,
        });
      }
      this._lastDeepChild = null;
      return;
    }

    // Send mouse-up to topmost window under cursor
    const sortedWins = Object.values(this.windows)
      .filter(w => w.visible && !w.isChild)
      .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
    for (const win of sortedWins) {
      if (canvasX >= win.x && canvasX < win.x + win.w &&
          canvasY >= win.y && canvasY < win.y + win.h) {
        const snapped = this._snapWinampEqButtonPoint(win, canvasX, canvasY, button);
        if (snapped.snapped) {
          canvasX = snapped.x;
          canvasY = snapped.y;
          this._setMousePoint(canvasX, canvasY);
        }
        if (typeof this._computeClientRect === 'function') this._computeClientRect(win);
        const clientOrigin = this._mouseMsgOriginScreen(win.hwnd);
        const clientX = clientOrigin.x;
        const clientY = clientOrigin.y;
        const deep = this._hitTestDeepChild(win, canvasX, canvasY);
        const targetHwnd = deep ? deep.hwnd : win.hwnd;
        const relX = deep ? (canvasX - deep.sx) : (canvasX - clientX);
        const relY = deep ? (canvasY - deep.sy) : (canvasY - clientY);
        this._dispatchMouseEvent(win, {
          type: 'mouse',
          hwnd: targetHwnd,
          msg: button === 2 ? 0x0205 : 0x0202, // WM_RBUTTONUP / WM_LBUTTONUP
          wParam: 0,
          lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
        });
        this._lastDeepChild = null;
        return;
      }
    }
  }

  P.handleMouseMove = function(canvasX, canvasY) {
    const mapped = this._mapExclusiveInputPoint(canvasX, canvasY);
    if (mapped.outside) return;
    canvasX = mapped.x;
    canvasY = mapped.y;
    const clipped = this._applyCursorClip(canvasX, canvasY);
    canvasX = clipped.x;
    canvasY = clipped.y;
    this._setMousePoint(canvasX, canvasY);
    this._signalDirectInputDevice(2);
    // Sysbutton press tracking: pressed visual is shown only while the
    // cursor stays over the original button (mirrors real Windows).
    if (this._sysBtnDrag) {
      const w0 = this._sysBtnDrag.wasm || this.wasm;
      const we0 = w0 && w0.exports;
      if (we0 && we0.nc_sysbutton_move) {
        if (we0.nc_sysbutton_move(canvasX, canvasY)) {
          this.repaint();
        }
      }
      return;
    }

    // Resize drag. Win98's classic interaction leaves the window intact and
    // moves an outline until release.  Changing win.{x,y,w,h} here while
    // deferring WM_SIZE used to detach Paint's menu/status child surfaces
    // from a discarded backing canvas, producing a broken mid-drag frame.
    if (this._resizingWin) {
      const r = this._resizingWin;
      this._syncResizeCursor(r.hit);
      const dx = canvasX - r.startX;
      const dy = canvasY - r.startY;
      const MIN_W = 80, MIN_H = 40;
      let nx = r.origX, ny = r.origY, nw = r.origW, nh = r.origH;
      // Left edges move x+w together (dragging left shrinks width).
      if (r.hit === 10 || r.hit === 13 || r.hit === 16) { // HTLEFT/TOPLEFT/BOTTOMLEFT
        let cdx = dx;
        if (nw - cdx < MIN_W) cdx = nw - MIN_W;
        nx = r.origX + cdx;
        nw = r.origW - cdx;
      }
      if (r.hit === 11 || r.hit === 14 || r.hit === 17) { // HTRIGHT/TOPRIGHT/BOTTOMRIGHT
        nw = Math.max(MIN_W, r.origW + dx);
      }
      if (r.hit === 12 || r.hit === 13 || r.hit === 14) { // HTTOP/TOPLEFT/TOPRIGHT
        let cdy = dy;
        if (nh - cdy < MIN_H) cdy = nh - MIN_H;
        ny = r.origY + cdy;
        nh = r.origH - cdy;
      }
      if (r.hit === 15 || r.hit === 16 || r.hit === 17) { // HTBOTTOM/BOTTOMLEFT/BOTTOMRIGHT
        nh = Math.max(MIN_H, r.origH + dy);
      }
      r.pendingX = nx;
      r.pendingY = ny;
      r.pendingW = nw;
      r.pendingH = nh;
      this._resizeOutline = { x: nx, y: ny, w: nw, h: nh };
      this.repaint();
      return;
    }
    // Window dragging
    if (this._draggingWin) {
      this._draggingWin.pendingX = (canvasX - this._draggingWin.offsetX) | 0;
      this._draggingWin.pendingY = (canvasY - this._draggingWin.offsetY) | 0;
      return;
    }
    if (this._handleNativeScrollbarMove(canvasX, canvasY)) {
      this.scheduleRepaint();
      return;
    }
    // If a window has mouse capture, route all moves to it regardless of position.
    // Works for both renderer-known windows and WAT-native child controls
    // (listbox thumb drag, etc). Child-local lParam is computed from the
    // resolved screen origin, not the top window's client origin.
    const captureWasm = (this._dialogBtnDrag && this._dialogBtnDrag.wasm) ||
      (this._lastDeepChild && this._lastDeepChild.wasm) || this.wasm;
    const we = captureWasm && captureWasm.exports;
    const capHwnd = we && we.get_capture_hwnd && we.get_capture_hwnd();
    const cap = capHwnd ? this._resolveCaptureTarget(capHwnd, captureWasm) : null;
    if (cap) {
      const relX = canvasX - cap.screenX;
      const relY = canvasY - cap.screenY;
      if (we.post_message_q && this.windows[cap.targetHwnd]) {
        // WM_SETCURSOR is only meaningful for top-level windows; skip for
        // WAT-native children (hittest_sync would miss and the cursor would
        // flicker to the arrow as the captured control moves off-bounds).
        const hit = (we.hittest_sync ? (we.hittest_sync(cap.targetHwnd, canvasX, canvasY) | 0) : 1);
        this._syncResizeCursor(hit);
        const lp = (hit & 0xFFFF) | ((0x0200 & 0xFFFF) << 16);
        we.post_message_q(cap.targetHwnd, 0x0020, cap.targetHwnd, lp >>> 0);
      }
      const lParam = (((relY & 0xFFFF) << 16) | (relX & 0xFFFF)) >>> 0;
      const captureClass = we.ctrl_get_class ? (we.ctrl_get_class(cap.targetHwnd) | 0) : 0;
      if (captureClass && we.send_message) {
        we.send_message(cap.targetHwnd, 0x0200,
          this._mouseButtonsMask || 0x0001, lParam);
      } else {
        this._dispatchMouseEvent(cap.win, {
          type: 'mouse',
          hwnd: cap.targetHwnd,
          msg: 0x0200, // WM_MOUSEMOVE
          wParam: this._mouseButtonsMask || 0x0001, // captured drags expect button state
          lParam,
        });
      }
      this._refreshPaintStatusForPointer(cap.win, we);
      this.scheduleRepaint();
      return;
    }
    // If a previous mousedown landed on a deep child (MDI document etc.),
    // route moves to that same child with child-local lParam and MK_LBUTTON
    // so the pencil/view stays in "drag in progress" mode.
    if (this._lastDeepChild) {
      const d = this._lastDeepChild;
      const top = this.windows[d.topHwnd];
      if (top && top.visible) {
        const relX = canvasX - d.sx;
        const relY = canvasY - d.sy;
        this._dispatchMouseEvent(top, {
          type: 'mouse',
          hwnd: d.childHwnd,
          msg: 0x0200, // WM_MOUSEMOVE
          wParam: this._mouseButtonsMask || 0x0001, // we're mid-drag
          lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
        });
        this._refreshPaintStatusForPointer(top, d.wasm && d.wasm.exports);
        this.scheduleRepaint();
        return;
      }
    }
    for (const win of Object.values(this.windows)) {
      if (!win.visible) continue;
      if (canvasX >= win.x && canvasX < win.x + win.w &&
          canvasY >= win.y && canvasY < win.y + win.h) {
        if (typeof this._computeClientRect === 'function') this._computeClientRect(win);
        const clientOrigin = this._mouseMsgOriginScreen(win.hwnd);
        const clientX = clientOrigin.x;
        const clientY = clientOrigin.y;
        const deep = this._hitTestDeepChild(win, canvasX, canvasY);
        const targetHwnd = deep ? deep.hwnd : win.hwnd;
        const relX = deep ? (canvasX - deep.sx) : (canvasX - clientX);
        const relY = deep ? (canvasY - deep.sy) : (canvasY - clientY);
        const ownerWasm = win.wasm || this.wasm;
        const ownerExports = ownerWasm && ownerWasm.exports;
        // Post WM_SETCURSOR before WM_MOUSEMOVE so the guest wndproc sees
        // them in real-DispatchMessage order (post queue drains before the
        // host input poll in GetMessageA).
        if (ownerExports && ownerExports.post_message_q) {
          // WindowFromPoint locates the child by its *window* rect, which
          // includes any non-client scrollbar strips, so a deep hit is not
          // automatically client-area input. Hit-test the child too, but
          // trust only the scrollbar codes from it: a WAT-native control
          // whose rect does not resolve reports HTNOWHERE, and treating that
          // as chrome would flip the cursor to the arrow over its content.
          // Top-level chrome still needs the full code, for resize cursors.
          const hitTarget = deep ? deep.hwnd : win.hwnd;
          let hit = 1;
          if (ownerExports.hittest_sync) {
            const raw = ownerExports.hittest_sync(hitTarget, canvasX, canvasY) | 0;
            hit = deep ? ((raw === 4 || raw === 6 || raw === 7) ? raw : 1) : raw;
          }
          this._syncResizeCursor(hit);
          const lp = (hit & 0xFFFF) | ((0x0200 & 0xFFFF) << 16);
          ownerExports.post_message_q(targetHwnd, 0x0020, targetHwnd, lp >>> 0);
        }
        this._dispatchMouseEvent(win, {
          type: 'mouse',
          hwnd: targetHwnd,
          msg: 0x0200, // WM_MOUSEMOVE
          wParam: this._mouseButtonsMask || 0,
          lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
        });
        this._refreshPaintStatusForPointer(win, ownerExports);
        return;
      }
    }
    // Off every window: the desktop. Windows gives it a class cursor of
    // IDC_ARROW like any other window, but ours is a renderer surface with no
    // hwnd to send WM_SETCURSOR to (GetDesktopWindow hands out a bare
    // constant), so the reset happens here. Without it the pointer keeps
    // whatever the last window set — you drag mspaint's pencil out onto the
    // desktop and it stays a pencil.
    this._syncResizeCursor(0);
    const style = this.canvas && this.canvas.style;
    if (style && style.cursor !== 'default') style.cursor = 'default';
  }

  P.handleWheel = function(canvasX, canvasY, deltaY) {
    const we = this.wasm && this.wasm.exports;
    if (!we || !we.send_message) return;
    const delta = deltaY > 0 ? -120 : 120;
    const wParam = ((delta & 0xFFFF) << 16) >>> 0;
    let target = this._findWatEditTarget();
    if (!target && we.get_focus_hwnd) {
      const focus = we.get_focus_hwnd() | 0;
      if (focus && (!we.ctrl_get_class || ((we.ctrl_get_class(focus) | 0) !== 2))) {
        target = focus;
      }
    }
    if (!target) return;
    const lParam = (((canvasY | 0) & 0xFFFF) << 16) | ((canvasX | 0) & 0xFFFF);
    we.send_message(target, 0x020A, wParam, lParam >>> 0);
    this.invalidate(target);
    const parentWin = this._findParentWindow(target);
    if (parentWin) this.invalidate(parentWin.hwnd);
  }

  P.handleMenuHover = function(canvasX, canvasY) {
    const menu = this._openMenuContext();
    if (!menu) return;
    const we = menu.exports;
    if (!we.menu_hover_from_point || !we.menu_open_hover) return;
    const oldHover = we.menu_open_hover() | 0;
    const oldSubHover = we.menu_open_sub_hover ? (we.menu_open_sub_hover() | 0) : -1;
    const newHover = we.menu_hover_from_point(canvasX, canvasY) | 0;
    const newSubHover = we.menu_open_sub_hover ? (we.menu_open_sub_hover() | 0) : -1;
    if (newHover !== oldHover || newSubHover !== oldSubHover) {
      this.repaint();
    }
  }

  P._findWatEditTarget = function() {
    const we = this.wasm && this.wasm.exports;
    if (we && we.send_message && we.get_focus_hwnd) {
      const focus = we.get_focus_hwnd() | 0;
      if (focus && we.ctrl_get_class) {
        const cls = we.ctrl_get_class(focus) | 0;
        if (cls === 2) return focus;
        // Focused native child windows, notably WordPad's RichEdit20A, must
        // keep keyboard events on the queued native-focus path. Asking WAT's
        // edit_command_target() here would fall back to the first visible WAT
        // EDIT, which is often a toolbar combobox child.
        const parent = we.wnd_get_parent ? (we.wnd_get_parent(focus) | 0) : 0;
        if (parent) return 0;
      }
    }

    if (we && we.send_message && we.edit_command_target) {
      const target = we.edit_command_target() | 0;
      if (target && (!we.ctrl_get_class || ((we.ctrl_get_class(target) | 0) === 2))) return target;
    }

    // Browser focus can legitimately sit on the top-level frame while the
    // user expects typing to go into its child EDIT. Do a renderer-side
    // WindowFromFocus-style fallback across visible child EDIT controls,
    // preferring controls in the frontmost top-level window. WAT remains the
    // owner of focus state; JS only chooses which WAT instance/control to ask.
    const tops = Object.values(this.windows || {})
      .filter(w => w && w.visible && !w.isChild)
      .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
    for (const top of tops) {
      const wasm = top.wasm || this.wasm;
      const e = wasm && wasm.exports;
      if (!e || !e.ctrl_get_class || !e.send_message) continue;
      const edit = Object.values(this.windows || {}).find(w =>
        w && w.visible && w.isChild && w.parentHwnd === top.hwnd &&
        (w.wasm || this.wasm) === wasm &&
        (e.ctrl_get_class(w.hwnd) | 0) === 2);
      if (!edit) continue;
      this.wasm = wasm;
      this.wasmMemory = top.wasmMemory || edit.wasmMemory || this.wasmMemory;
      if (e.set_focus) e.set_focus(edit.hwnd);
      else if (e.set_focus_hwnd) e.set_focus_hwnd(edit.hwnd);
      return edit.hwnd | 0;
    }
    return 0;
  }

  P._guestToWasmAddress = function(guestAddr, wasm, memory) {
    const e = wasm && wasm.exports;
    if (!e || !e.get_image_base) return 0;
    const buffer = memory && memory.buffer ? memory.buffer : memory;
    const imageBase = e.get_image_base() >>> 0;
    const guestBase = e.get_guest_base ? (e.get_guest_base() >>> 0) : 0x12000;
    const direct = ((guestAddr >>> 0) - imageBase + guestBase) >>> 0;
    if (direct < 0x08000000) return direct;
    if (!buffer) return 0;
    try {
      const dv = new DataView(buffer);
      const count = dv.getUint32(0x07F02400, true) >>> 0;
      for (let i = 0; i < count; i++) {
        const rec = 0x07F02410 + i * 16;
        const base = dv.getUint32(rec, true) >>> 0;
        const size = dv.getUint32(rec + 4, true) >>> 0;
        const backing = dv.getUint32(rec + 8, true) >>> 0;
        if ((guestAddr >>> 0) >= base && (guestAddr >>> 0) < ((base + size) >>> 0)) {
          return (backing + ((guestAddr >>> 0) - base)) >>> 0;
        }
      }
    } catch (_) {}
    return 0;
  };

  P._nativeTextEditState = function(hwnd) {
    const wasm = this.wasm;
    const we = wasm && wasm.exports;
    const memory = this.wasmMemory;
    if (!hwnd || !we || !we.send_message || !we.guest_alloc || !memory || !memory.buffer) return null;
    if (we.ctrl_get_class && ((we.ctrl_get_class(hwnd) | 0) === 2)) return null;

    const cap = 8192;
    const textG = we.guest_alloc(cap) >>> 0;
    const startG = we.guest_alloc(4) >>> 0;
    const endG = we.guest_alloc(4) >>> 0;
    if (!textG || !startG || !endG) {
      if (we.guest_free) {
        if (textG) we.guest_free(textG);
        if (startG) we.guest_free(startG);
        if (endG) we.guest_free(endG);
      }
      return null;
    }

    const textWa = this._guestToWasmAddress(textG, wasm, memory);
    const startWa = this._guestToWasmAddress(startG, wasm, memory);
    const endWa = this._guestToWasmAddress(endG, wasm, memory);
    if (!textWa || !startWa || !endWa || textWa >= memory.buffer.byteLength) {
      if (we.guest_free) {
        we.guest_free(textG);
        we.guest_free(startG);
        we.guest_free(endG);
      }
      return null;
    }

    const dv = new DataView(memory.buffer);
    const bytes = new Uint8Array(memory.buffer);
    dv.setUint32(startWa, 0, true);
    dv.setUint32(endWa, 0, true);

    let len = 0;
    try {
      len = we.send_message(hwnd, 0x000D, cap, textG) | 0; // WM_GETTEXT
      we.send_message(hwnd, 0x00B0, startG, endG);         // EM_GETSEL
    } catch (_) {
      if (we.guest_free) {
        we.guest_free(textG);
        we.guest_free(startG);
        we.guest_free(endG);
      }
      return null;
    }

    const viewLen = Math.max(0, Math.min(len, cap - 1, memory.buffer.byteLength - textWa));
    let text = '';
    for (let i = 0; i < viewLen; i++) text += String.fromCharCode(bytes[textWa + i] || 0);
    const selStart = dv.getUint32(startWa, true) >>> 0;
    const selEnd = dv.getUint32(endWa, true) >>> 0;
    if (we.guest_free) {
      we.guest_free(textG);
      we.guest_free(startG);
      we.guest_free(endG);
    }
    return { hwnd, text, selStart, selEnd };
  };

  P._nativeTextLogicalToStringIndex = function(text, logicalPos) {
    const want = Math.max(0, logicalPos >>> 0);
    let logical = 0;
    let i = 0;
    while (i < text.length && logical < want) {
      if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) i += 2;
      else i += 1;
      logical += 1;
    }
    return i;
  };

  P._replaceNativeTextSelection = function(hwnd, text) {
    const wasm = this.wasm;
    const we = wasm && wasm.exports;
    const memory = this.wasmMemory;
    if (!hwnd || !we || !we.send_message || !we.guest_alloc || !memory || !memory.buffer) return false;

    const bytes = [];
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xFF);
    bytes.push(0);

    const g = we.guest_alloc(bytes.length) >>> 0;
    const wa = this._guestToWasmAddress(g, wasm, memory);
    if (!g || !wa || wa + bytes.length > memory.buffer.byteLength) {
      if (g && we.guest_free) we.guest_free(g);
      return false;
    }
    new Uint8Array(memory.buffer).set(bytes, wa);

    try {
      we.send_message(hwnd, 0x00C2, 1, g); // EM_REPLACESEL, allow undo
      if (we.guest_free) we.guest_free(g);
      this.invalidate(hwnd);
      const parentWin = this._findParentWindow(hwnd);
      if (parentWin) this.invalidate(parentWin.hwnd);
      this.scheduleRepaint();
      return true;
    } catch (_) {
      if (we.guest_free) we.guest_free(g);
      return false;
    }
  };

  P._handleNativeTextShortcut = function(vkCode) {
    const we = this.wasm && this.wasm.exports;
    if (!we || !we.get_focus_hwnd || !we.send_message) return false;
    const ctrl = !!(this._asyncKeys && this._asyncKeys[17]);
    if (!ctrl || (vkCode !== 65 && vkCode !== 67 && vkCode !== 86 && vkCode !== 88)) return false;

    const hwnd = we.get_focus_hwnd() | 0;
    if (!hwnd) return false;
    if (we.ctrl_get_class && ((we.ctrl_get_class(hwnd) | 0) === 2)) return false;

    if (vkCode === 65) { // Ctrl+A
      try {
        we.send_message(hwnd, 0x00B1, 0, 0xFFFFFFFF >>> 0); // EM_SETSEL 0,-1
        this.invalidate(hwnd);
        const parentWin = this._findParentWindow(hwnd);
        if (parentWin) this.invalidate(parentWin.hwnd);
        this._suppressNextKeyPress = vkCode;
        return true;
      } catch (_) {
        return false;
      }
    }

    if (vkCode === 86) { // Ctrl+V
      if (we.native_richedit_clipboard_paste) {
        try {
          const ret = we.native_richedit_clipboard_paste(hwnd) >>> 0;
          this.invalidate(hwnd);
          const parentWin = this._findParentWindow(hwnd);
          if (parentWin) this.invalidate(parentWin.hwnd);
          this.scheduleRepaint();
          this._suppressNextKeyPress = vkCode;
          return !!ret;
        } catch (_) {
          return false;
        }
      }
      if (!this._nativeTextClipboard) {
        this._suppressNextKeyPress = vkCode;
        return true;
      }
      if (this._replaceNativeTextSelection(hwnd, this._nativeTextClipboard)) {
        this._suppressNextKeyPress = vkCode;
        return true;
      }
      return false;
    }

    if ((vkCode === 67 || vkCode === 88) &&
        we.native_richedit_clipboard_copy &&
        we.native_richedit_clipboard_cut) {
      try {
        const ret = vkCode === 88
          ? (we.native_richedit_clipboard_cut(hwnd) >>> 0)
          : (we.native_richedit_clipboard_copy(hwnd) >>> 0);
        if (vkCode === 88) {
          this.invalidate(hwnd);
          const parentWin = this._findParentWindow(hwnd);
          if (parentWin) this.invalidate(parentWin.hwnd);
          this.scheduleRepaint();
        }
        this._suppressNextKeyPress = vkCode;
        return !!ret;
      } catch (_) {
        return false;
      }
    }

    const state = this._nativeTextEditState(hwnd);
    if (!state) return false;
    const lo = Math.min(state.selStart, state.selEnd);
    const hi = Math.max(state.selStart, state.selEnd);
    if (hi > lo) {
      const a = this._nativeTextLogicalToStringIndex(state.text, lo);
      const b = this._nativeTextLogicalToStringIndex(state.text, hi);
      this._nativeTextClipboard = state.text.slice(a, b);
      if (vkCode === 88) this._replaceNativeTextSelection(hwnd, '');
    }
    this._suppressNextKeyPress = vkCode;
    return true;
  };

  P._findParentWindow = function(hwnd) {
    const we = this.wasm && this.wasm.exports;
    if (we && we.wnd_top_level) {
      const top = we.wnd_top_level(hwnd) >>> 0;
      if (top && this.windows[top]) return this.windows[top];
    }
    return null;
  }

  P.handleKeyDown = function(vkCode) {
    if (this._exited) return;
    this._restoreKeyboardInputOwner();
    // Update async key state up-front so handlers that read it (edit's
    // Shift/Ctrl+arrow, Ctrl+A, etc.) see the right modifier state for
    // *this* keystroke. Otherwise the _asyncKeys bump that checkInput
    // does later only lands after the next modifier press, which loses
    // chords issued in the same batch.
    if (!this._asyncKeys) this._asyncKeys = Object.create(null);
    if (!this._asyncPressedKeys) this._asyncPressedKeys = Object.create(null);
    this._asyncKeys[vkCode & 0xFF] = true;
    this._asyncPressedKeys[vkCode & 0xFF] = true;
    this._signalDirectInputDevice(1);
    const we = this.wasm && this.wasm.exports;
    const menu = this._openMenuContext();
    const menuOpenHwnd = menu ? menu.hwnd : 0;

    if (vkCode === 18) { this._altDown = true; this._altTapped = true; return; } // Alt
    if (vkCode === 27) { // Escape
      if (menuOpenHwnd) {
        if (menu.exports.menu_handle_key_open) menu.exports.menu_handle_key_open(vkCode);
        this.repaint();
        return;
      }
      if (this._menuMode) { this._menuMode = false; return; }
    }
    // A modal dialog owns Enter/Esc even if the previous modeless dialog's
    // child still has the WAT focus. This happens when Notepad's modeless
    // Find dialog opens a not-found MessageBox.
    if ((vkCode === 13 || vkCode === 27) && we && (we.send_message || we.post_message_q)) {
      const modalHwnd = this._modalDialogHwnd();
      if (modalHwnd) {
        if (we.dialog_handle_key) we.dialog_handle_key(modalHwnd, vkCode, 0);
        this.scheduleRepaint();
        return;
      }
    }

    // Open dropdown keyboard routing is WAT-side.
    if (menuOpenHwnd) {
      if (we.menu_handle_key_open && we.menu_handle_key_open(vkCode)) {
        this.repaint();
        if (vkCode >= 65 && vkCode <= 90) this._suppressNextKeyPress = vkCode;
        return;
      }
    }

    // Any non-Alt key cancels the alt-tap
    this._altTapped = false;

    // Menu mode or Alt+letter: WAT opens the matching top-level bar item.
    if ((this._menuMode || this._altDown) && vkCode >= 65 && vkCode <= 90) {
      if (we && we.menu_open_bar_accel && we.menu_open_bar_accel(vkCode)) {
        this._menuMode = false;
        this._altDown = false;
        this._suppressNextKeyPress = vkCode;
        this.repaint();
        return;
      }
      this._menuMode = false;
      this._altDown = false;
    }

    // Global Win98 shortcuts that don't conflict with the browser.
    // Use _asyncKeys (set at top of this fn) for modifier state — the
    // _shiftDown/_ctrlDown locals only update after edit routing.
    {
      const shift = !!(this._asyncKeys && this._asyncKeys[16]);
      // F10: activate menu mode (mirror Alt-tap toggle)
      if (vkCode === 121 && !shift) {
        this._menuMode = !this._menuMode;
        return;
      }
      // Shift+F10: WM_CONTEXTMENU to focused hwnd at (-1,-1) sentinel
      if (vkCode === 121 && shift) {
        const hwnd = (we && we.get_focus_hwnd) ? (we.get_focus_hwnd() | 0) : 0;
        if (hwnd && we.post_message_q) {
          we.post_message_q(hwnd, 0x007B, hwnd, 0xFFFFFFFF >>> 0);
        }
        return;
      }
      // F1: WM_HELP to focused hwnd (apps that handle it pop context help)
      if (vkCode === 112) {
        const hwnd = (we && we.get_focus_hwnd) ? (we.get_focus_hwnd() | 0) : 0;
        if (hwnd && we.post_message_q) {
          we.post_message_q(hwnd, 0x0053, 0, 0);
        }
        return;
      }
      // Alt+Down: combobox dropdown (CB_SHOWDROPDOWN). Cheap stub: only
      // fires when focus is a combobox child; WAT side decides what to do.
      if (vkCode === 40 && this._altDown) {
        const hwnd = (we && we.get_focus_hwnd) ? (we.get_focus_hwnd() | 0) : 0;
        if (hwnd && we.send_message) {
          we.send_message(hwnd, 0x014F, 1, 0);
          this.invalidate(hwnd);
          return;
        }
      }

      // Dialog focus/default-button traversal lives in WAT; JS only decides
      // whether a raw browser key should be offered to that dialog helper.
      if (vkCode === 9 || vkCode === 13 || vkCode === 27 || vkCode === 32
          || vkCode === 37 || vkCode === 38 || vkCode === 39 || vkCode === 40) {
        const focus = (we && we.get_focus_hwnd) ? (we.get_focus_hwnd() | 0) : 0;
        if (we && we.dialog_handle_key) {
          let dlg = 0;
          const modalHwnd = this._modalDialogHwnd();
          if (modalHwnd) dlg = modalHwnd;
          else if (we.dialog_ancestor) dlg = we.dialog_ancestor(focus) | 0;
          if (!dlg && we.get_findreplace_dlg) dlg = we.get_findreplace_dlg() | 0;
          if (dlg && we.dialog_handle_key(dlg, vkCode, shift ? 1 : 0)) {
            this.scheduleRepaint();
            return;
          }
        }
      }
    }

    if (this._handleNativeTextShortcut(vkCode)) return;

    // Route WM_KEYDOWN to WAT EditState — WAT is sole source of truth for
    // edit text. Handles both WAT-only controls and JS-visible Edit children.
    {
      const editTarget = this._findWatEditTarget();
      if (editTarget && we.send_message) {
        we.send_message(editTarget, 0x0100, vkCode, 0);
        this.invalidate(editTarget);
        const parentWin = this._findParentWindow(editTarget);
        if (parentWin) this.invalidate(parentWin.hwnd);
        // send_message already enters an installed x86 edit subclass and
        // chains to the native EDIT proc synchronously. Queuing the same
        // WM_KEYDOWN again made Backspace/Delete/navigation run twice.
        return;
      }
    }

    if (vkCode === 16) this._shiftDown = true;
    else if (vkCode === 17) this._ctrlDown = true;
    this.inputQueue.push({
      type: 'key', hwnd: 0, msg: 0x0100, wParam: vkCode, lParam: 0,
    });
  }

  P.handleKeyUp = function(vkCode) {
    this._restoreKeyboardInputOwner();
    if (this._asyncKeys) this._asyncKeys[vkCode & 0xFF] = false;
    this._signalDirectInputDevice(1);
    if (vkCode === 16) this._shiftDown = false;
    if (vkCode === 17) this._ctrlDown = false;
    if (vkCode === 18) {
      this._altDown = false;
      // Alt tap (press and release without other keys) activates menu mode
      if (this._altTapped) {
        this._menuMode = !this._menuMode;
        this._altTapped = false;
      }
    }
    this.inputQueue.push({
      type: 'key', hwnd: 0, msg: 0x0101, wParam: vkCode, lParam: 0,
    });
  }

  P.handleKeyPress = function(charCode) {
    if (this._exited) return;
    this._restoreKeyboardInputOwner();
    if (this._suppressNextKeyPress) {
      const suppress = this._suppressNextKeyPress;
      let shouldSuppress = suppress === true;
      if (!shouldSuppress && suppress >= 65 && suppress <= 90) {
        shouldSuppress = charCode === suppress || charCode === suppress + 32;
      }
      this._suppressNextKeyPress = false;
      if (shouldSuppress) return;
    }
    if (this._activeInputProfile) {
      this._profileMark && this._profileMark('handle-keypress', { charCode });
    } else {
      this._profileInput && this._profileInput('keypress', { charCode });
    }
    // Route WM_CHAR to WAT EditState — WAT is sole source of truth for edit text.
    const we = this.wasm && this.wasm.exports;
    const editTarget = this._findWatEditTarget();
    if (editTarget && we.send_message) {
      this._profileMark && this._profileMark('wm-char-send-start', { hwnd: editTarget });
      we.send_message(editTarget, 0x0102, charCode, 0);
      this._profileMark && this._profileMark('wm-char-send-end', { hwnd: editTarget });
      this.invalidate(editTarget);
      const parentWin = this._findParentWindow(editTarget);
      if (parentWin) this.invalidate(parentWin.hwnd);
      return;
    }
    this._profileMark && this._profileMark('queue-wm-char');
    this.inputQueue.push({
      type: 'key', hwnd: 0, msg: 0x0102, wParam: charCode, lParam: 0,
    });
  }

  P._compositionTarget = function() {
    const we = this.wasm && this.wasm.exports;
    return this._findWatEditTarget() ||
      ((we && we.get_focus_hwnd) ? (we.get_focus_hwnd() | 0) : 0);
  };

  P.handleCompositionStart = function() {
    if (this._exited) return;
    this._restoreKeyboardInputOwner();
    const hwnd = this._compositionTarget();
    this._imeComposition = { hwnd, text: '' };
  };

  P.handleCompositionUpdate = function(text) {
    if (this._exited) return;
    const state = this._imeComposition || { hwnd: this._compositionTarget(), text: '' };
    state.text = String(text || '');
    this._imeComposition = state;
  };

  P.handleCompositionEnd = function(text) {
    if (this._exited) return;
    const we = this.wasm && this.wasm.exports;
    const state = this._imeComposition || { hwnd: this._compositionTarget(), text: '' };
    const committed = String(text || '');
    if (state.hwnd && we && we.send_message) {
      // The browser owns pre-edit/candidate UI. Sending WM_IME_STARTCOMPOSITION
      // to the Win98 RichEdit20A control without a guest IMM module corrupts
      // its native buffer, so only finalized UTF-16 units enter the guest.
      // WM_CHAR accepts UTF-16 code units and therefore preserves surrogate
      // pairs as well as BMP text. An empty commit is a cancellation.
      for (let i = 0; i < committed.length; i++) {
        we.send_message(state.hwnd, 0x0102, committed.charCodeAt(i), 0);
      }
      this.invalidate(state.hwnd);
      const parentWin = this._findParentWindow(state.hwnd);
      if (parentWin) this.invalidate(parentWin.hwnd);
      this.scheduleRepaint();
    }
    this._imeComposition = null;
  };

  P.checkInput = function() {
    if (this.inputQueue.length === 0) {
      this._activeInputEvent = null;
      return 0;
    }
    const evt = this.inputQueue.shift();
    this._activeInputEvent = evt || null;
    if (evt && (evt.msg === 0x0100 || evt.msg === 0x0102 || evt.msg === 0x0104)) {
      this._profileMark && this._profileMark('input-queue-dispatch', { msg: evt.msg, wParam: evt.wParam });
    }
    // After delivering WM_PAINT, schedule repaint so menus redraw on top
    if (evt.msg === 0x000F) this.scheduleRepaint();
    // Track async key state for GetAsyncKeyState
    if (evt.msg === 0x0100 || evt.msg === 0x0104) { // WM_KEYDOWN, WM_SYSKEYDOWN
      if (!this._asyncKeys) this._asyncKeys = Object.create(null);
      if (!this._asyncPressedKeys) this._asyncPressedKeys = Object.create(null);
      this._asyncKeys[evt.wParam & 0xFF] = true;
      this._asyncPressedKeys[evt.wParam & 0xFF] = true;
    } else if (evt.msg === 0x0101 || evt.msg === 0x0105) { // WM_KEYUP, WM_SYSKEYUP
      if (this._asyncKeys) this._asyncKeys[evt.wParam & 0xFF] = false;
    }
    return evt;
  }

  // GetAsyncKeyState(vKey) — high bit set while down, low bit set once
  // after a press until consumed by GetAsyncKeyState.
  P.getAsyncKeyState = function(vKey) {
    return this.peekAsyncKeyState(vKey) | this._consumeAsyncPressBit(vKey);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { installInputHandlers };
} else if (typeof window !== 'undefined') {
  window.installInputHandlers = installInputHandlers;
}
