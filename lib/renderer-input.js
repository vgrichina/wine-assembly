// Win98Renderer input handling — split from renderer.js
// Mixed into Win98Renderer.prototype

function installInputHandlers(R) {
  const P = R.prototype;

  P._findTopWindow = function(hwnd) {
    const we = this.wasm && this.wasm.exports;
    if (we && we.wnd_top_level) {
      try {
        const top = we.wnd_top_level(hwnd) >>> 0;
        if (top && this.windows[top]) return this.windows[top];
      } catch (_) {}
    }
    const win = this.windows[hwnd];
    if (!win) return null;
    if (win.isChild && win.parentHwnd) return this.windows[win.parentHwnd] || null;
    return win;
  };

  P._modalDialogHwnd = function() {
    const we = this.wasm && this.wasm.exports;
    if (we && we.modal_dialog_hwnd) {
      try {
        const hwnd = we.modal_dialog_hwnd() >>> 0;
        if (hwnd) return hwnd;
      } catch (_) {}
    }
    const modal = Object.values(this.windows).find(w => w.visible && w.isAboutDialog);
    return modal ? (modal.hwnd | 0) : 0;
  };

  P._clientOriginScreen = function(hwnd) {
    const we = this.wasm && this.wasm.exports;
    if (we && we.wnd_client_screen_x && we.wnd_client_screen_y) {
      try { return { x: we.wnd_client_screen_x(hwnd) | 0, y: we.wnd_client_screen_y(hwnd) | 0 }; } catch (_) {}
    }
    const win = this.windows[hwnd];
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
    const we = this.wasm && this.wasm.exports;
    if (we && we.wnd_window_screen_x && we.wnd_window_screen_y) {
      try { return { x: we.wnd_window_screen_x(hwnd) | 0, y: we.wnd_window_screen_y(hwnd) | 0 }; } catch (_) {}
    }
    const win = this.windows[hwnd];
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
    const we = this.wasm && this.wasm.exports;
    if (we && we.wnd_mouse_msg_origin_x && we.wnd_mouse_msg_origin_y) {
      try { return { x: we.wnd_mouse_msg_origin_x(hwnd) | 0, y: we.wnd_mouse_msg_origin_y(hwnd) | 0 }; } catch (_) {}
    }
    return win && win.isPopup ? this._windowOriginScreen(hwnd) : this._clientOriginScreen(hwnd);
  };

  P._windowRectScreen = function(win) {
    const origin = this._windowOriginScreen(win.hwnd);
    const we = this.wasm && this.wasm.exports;
    if (we && we.wnd_screen_w && we.wnd_screen_h) {
      try {
        const w = we.wnd_screen_w(win.hwnd) | 0;
        const h = we.wnd_screen_h(win.hwnd) | 0;
        if (w > 0 && h > 0) return { x: origin.x, y: origin.y, w, h };
      } catch (_) {}
    }
    return { x: origin.x, y: origin.y, w: win.w, h: win.h };
  };

  P._mouseMaskForButton = function(button) {
    if (button === 2) return 0x0002; // MK_RBUTTON
    return 0x0001;                  // MK_LBUTTON (browser: 0, test harness: 1)
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
      const before = this.windows[hwnd];
      we.send_message(hwnd, 0x0010, 0, 0); // WM_CLOSE
      const after = this.windows[hwnd];
      if (after && after === before && after.isDialog && !after.isAboutDialog && !after.isFindDialog) {
        // Modeless CreateDialogParamA windows can return 0 from their dialog
        // proc and rely on DefDlgProc/DefWindowProc to destroy the frame. The
        // exported synchronous SendMessage path does not run that default
        // fallback, so finish the titlebar close here.
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
      this._wakeMessageWait();
      this.scheduleRepaint();
      this.repaint();
      return;
    }
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
    const we = this.wasm && this.wasm.exports;
    if (!we || !we.wnd_child_from_point_deep || !we.wnd_window_screen_x || !we.wnd_window_screen_y) return null;
    const hwnd = we.wnd_child_from_point_deep(topWin.hwnd, cx, cy) >>> 0;
    if (!hwnd) return null;
    return {
      hwnd,
      sx: we.wnd_window_screen_x(hwnd) | 0,
      sy: we.wnd_window_screen_y(hwnd) | 0,
    };
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
  P._resolveCaptureTarget = function(capHwnd) {
    if (!capHwnd) return null;
    const we = this.wasm && this.wasm.exports;
    if (we && we.wnd_top_level && we.wnd_mouse_msg_origin_x && we.wnd_mouse_msg_origin_y) {
      const topHwnd = we.wnd_top_level(capHwnd) >>> 0;
      const top = topHwnd ? this.windows[topHwnd] : null;
      if (top) {
        const origin = this._mouseMsgOriginScreen(capHwnd);
        return {
          win: top,
          screenX: origin.x,
          screenY: origin.y,
          targetHwnd: capHwnd,
        };
      }
    }
    const direct = this.windows[capHwnd];
    if (!direct) return null;
    const origin = direct.isPopup ? this._windowOriginScreen(capHwnd) : this._clientOriginScreen(capHwnd);
    return { win: direct, screenX: origin.x, screenY: origin.y, targetHwnd: capHwnd };
  };

  P.handleMouseDown = function(canvasX, canvasY, button, opts) {
    const forceDoubleClick = !!(opts && opts.doubleClick);
    this._mouseButtonsMask = (this._mouseButtonsMask || 0) | this._mouseMaskForButton(button);
    // Modal dialog: block input to other windows
    const modalHwnd = this._modalDialogHwnd();
    const modal = modalHwnd ? this.windows[modalHwnd] : null;
    if (modalHwnd) {
      // Only allow clicks within the modal
      const we = this.wasm && this.wasm.exports;
      const mx = we && we.wnd_window_screen_x ? (we.wnd_window_screen_x(modalHwnd) | 0) : (modal ? modal.x : 0);
      const my = we && we.wnd_window_screen_y ? (we.wnd_window_screen_y(modalHwnd) | 0) : (modal ? modal.y : 0);
      const mw = we && we.wnd_screen_w ? (we.wnd_screen_w(modalHwnd) | 0) : (modal ? modal.w : 0);
      const mh = we && we.wnd_screen_h ? (we.wnd_screen_h(modalHwnd) | 0) : (modal ? modal.h : 0);
      if (canvasX < mx || canvasX >= mx + mw ||
          canvasY < my || canvasY >= my + mh) {
        return; // block
      }
      if (button !== 2 && we && (we.dialog_route_mouse_screen || we.dialog_route_mouse)) {
        const msg = forceDoubleClick ? 0x0203 : 0x0201;
        const routed = we.dialog_route_mouse_screen
          ? (we.dialog_route_mouse_screen(modalHwnd, msg, 0x0001, canvasX, canvasY) | 0)
          : (() => {
              const ox = we.wnd_client_screen_x ? (we.wnd_client_screen_x(modalHwnd) | 0) : (modal ? modal.clientRect.x : 0);
              const oy = we.wnd_client_screen_y ? (we.wnd_client_screen_y(modalHwnd) | 0) : (modal ? modal.clientRect.y : 0);
              const lp = (((canvasX - ox) & 0xFFFF) | (((canvasY - oy) & 0xFFFF) << 16)) >>> 0;
              return we.dialog_route_mouse(modalHwnd, msg, 0x0001, lp) | 0;
            })();
        if (routed) {
          this._wakeMessageWait();
          this._dialogBtnDrag = { parent: modalHwnd, downLParam: 0, clientX: 0, clientY: 0 };
          this.scheduleRepaint();
          this.repaint();
          return;
        }
      }
    }

    // Menu tracking is WAT-side. JS only forwards the screen point.
    {
      const we = this.wasm && this.wasm.exports;
      if (we && we.menu_open_hwnd && we.menu_open_hwnd() !== 0) {
        const tracked = we.menu_open_hwnd() | 0;
        const trackedWin = this.windows[tracked];
        let handled = 0;
        const menuFromBar = !we.menu_open_x || (we.menu_open_x() | 0) < 0;
        if (menuFromBar && trackedWin && trackedWin._menuId &&
            we.menu_hittest_bar && (we.menu_handle_bar_click || we.menu_open)) {
          const idx = we.menu_hittest_bar(
            tracked, (trackedWin.x | 0) + 3, (trackedWin.y | 0) + 22, canvasX, canvasY) | 0;
          if (idx >= 0) {
            const activated = we.menu_activate_bar_command
              ? (we.menu_activate_bar_command(tracked, idx) | 0)
              : 0;
            if (!activated) {
              if (we.menu_handle_bar_click) we.menu_handle_bar_click(tracked, canvasX, canvasY);
              else we.menu_open(tracked, idx);
            }
            this._menuMouseCapture = true;
            this.repaint();
            return;
          }
        }
        if (we.menu_handle_mouse_open) handled = we.menu_handle_mouse_open(canvasX, canvasY) | 0;
        else if (we.menu_close) { we.menu_close(); handled = 1; }
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
          we.send_message(ch, msg, 0x0001, lp);
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
        const ad = !!(a.isFindDialog || a.isAboutDialog || a.isDialog);
        const bd = !!(b.isFindDialog || b.isAboutDialog || b.isDialog);
        if (ad !== bd) return ad ? -1 : 1;
        if (ad && bd) return (a.w * a.h) - (b.w * b.h) || ((b.zOrder || 0) - (a.zOrder || 0));
        return (b.zOrder || 0) - (a.zOrder || 0);
      });
    for (const win of sortedWins) {
      // Bring clicked window to front
      win.zOrder = this._nextZ++;
      this.scheduleRepaint();

      // Clicking outside any WAT-managed dialog clears stale $focus_hwnd
      // (e.g. Find dialog edit) so the next edit pickup re-scans for a
      // visible WAT Edit control. Skip for *any* dialog — modal dialogs
      // (DialogBoxParamA/W) also own WAT-native edits and need
      // edit_wndproc's focus-transfer path to deliver WM_KILLFOCUS when
      // the user clicks between their fields.
      if (!win.isFindDialog && !win.isAboutDialog && !win.isDialog) {
        const w = win.wasm || this.wasm;
        const we = w && w.exports;
        if (we && we.set_focus_hwnd) we.set_focus_hwnd(0);
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
        const we = this.wasm && this.wasm.exports;
        if (we) {
          const opened = we.menu_handle_bar_click
            ? (we.menu_handle_bar_click(win.hwnd, canvasX, canvasY) | 0)
            : 0;
          if (opened || (we.menu_hittest_bar && we.menu_open && (() => {
            const barX = (win.x | 0) + 3;
            const barY = (win.y | 0) + 22;
            const idx = we.menu_hittest_bar(win.hwnd, barX, barY, canvasX, canvasY) | 0;
            if (idx < 0) return false;
            if (we.menu_activate_bar_command &&
                (we.menu_activate_bar_command(win.hwnd, idx) | 0)) return true;
            we.menu_open(win.hwnd, idx);
            return true;
          })())) {
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
        const we = this.wasm && this.wasm.exports;
          if (we && (we.dialog_route_mouse_screen || we.dialog_route_mouse)) {
            let routeHwnd = win.hwnd;
            let routeWin = win;
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
            ? (we.dialog_route_mouse_screen(routeHwnd, msg, 0x0001, canvasX, canvasY) | 0)
            : (we.dialog_route_mouse(routeHwnd, msg, 0x0001, lParam) | 0);
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
                ? we.dialog_route_mouse_screen(parentHwnd, msg, 0x0001, canvasX, canvasY)
                : we.dialog_route_mouse(parentHwnd, msg, 0x0001, parentLParam);
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
            this._wakeMessageWait();
            this._dialogBtnDrag = { parent: routeHwnd, downLParam: routedLParam, clientX: routedClientX, clientY: routedClientY };
            this.scheduleRepaint();
            this.repaint();
            return;
          }
        }
        if (isWatDialog) return;
      }

      if (canvasX >= win.x && canvasX < win.x + win.w &&
          canvasY >= win.y && canvasY < win.y + win.h) {
        // WindowFromPoint: if a child of this top-level contains the click,
        // deliver to the child with child-local lParam (MDI document etc.).
        const deep = this._hitTestDeepChild(win, canvasX, canvasY);
        const targetHwnd = deep ? deep.hwnd : win.hwnd;
        const relX = deep ? (canvasX - deep.sx) : (canvasX - clientX);
        const relY = deep ? (canvasY - deep.sy) : (canvasY - clientY);
        let msg = button === 2 ? 0x0204 : 0x0201; // WM_RBUTTONDOWN / WM_LBUTTONDOWN
        if (button !== 2) {
          if (forceDoubleClick) msg = 0x0203; // WM_LBUTTONDBLCLK
        }
        {
          const we = this.wasm && this.wasm.exports;
          if (button !== 2 && isWatDialog && deep && we && (we.dialog_route_mouse_screen || we.dialog_route_mouse)) {
            const routedLParam = ((relX & 0xFFFF) | ((relY & 0xFFFF) << 16)) >>> 0;
            const ok = we.dialog_route_mouse_screen
              ? we.dialog_route_mouse_screen(targetHwnd, msg, 0x0001, canvasX, canvasY)
              : we.dialog_route_mouse(targetHwnd, msg, 0x0001, routedLParam);
            if (ok) {
              this._wakeMessageWait();
              this._dialogBtnDrag = { parent: targetHwnd, downLParam: routedLParam, clientX: deep.sx, clientY: deep.sy };
              this.scheduleRepaint();
              this.repaint();
              return;
            }
          }
        }
        this.inputQueue.push({
          type: 'mouse',
          hwnd: targetHwnd,
          msg,
          wParam: button === 2 ? 0x0002 : 0x0001, // MK_RBUTTON / MK_LBUTTON
          lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
        });
        this._lastDeepChild = deep ? { topHwnd: win.hwnd, childHwnd: deep.hwnd, sx: deep.sx, sy: deep.sy } : null;
        return;
      }
    }
  }

  P.handleMouseUp = function(canvasX, canvasY, button) {
    const upMask = this._mouseMaskForButton(button);
    this._mouseButtonsMask = (this._mouseButtonsMask || 0) & ~upMask;
    if (this._resizingWin) {
      const r = this._resizingWin;
      this._resizingWin = null;
      const w = r.wasm || (r.win && r.win.wasm) || this.wasm;
      const we = w && w.exports;
      if (we && we.host_resize_commit) {
        we.host_resize_commit(r.hwnd, r.win.x, r.win.y, r.win.w, r.win.h);
      }
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
    const modalHwnd = this._modalDialogHwnd();
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
        .filter(w => w && w.visible && w.isDialog && !w.isAboutDialog && (w.ownerHwnd || w.parentHwnd))
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
          return;
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
      if (drag.target && we && we.send_message) {
        const lx = canvasX - drag.sx;
        const ly = canvasY - drag.sy;
        const lParam = ((lx & 0xFFFF) | ((ly & 0xFFFF) << 16)) >>> 0;
        we.send_message(drag.target, 0x0202, 0, lParam);
        this._wakeMessageWait();
        this.scheduleRepaint();
        this.repaint();
        return;
      }
      if (we && (we.dialog_route_mouse_screen || we.dialog_route_mouse)) {
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

    // End sysbutton press. WAT owns release/cancel/dispatch.
    if (this._sysBtnDrag && button !== 2) {
      const drag = this._sysBtnDrag;
      this._sysBtnDrag = null;
      const w = drag.wasm || this.wasm;
      const we = w && w.exports;
      const dragWin = this.windows[drag.hwnd];
      if (dragWin && dragWin.isDialog && !dragWin.isAboutDialog && (dragWin.ownerHwnd || dragWin.parentHwnd)) {
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
    const we = this.wasm && this.wasm.exports;
    const capHwnd = we && we.get_capture_hwnd && we.get_capture_hwnd();
    const cap = capHwnd ? this._resolveCaptureTarget(capHwnd) : null;
    if (cap) {
      const relX = canvasX - cap.screenX;
      const relY = canvasY - cap.screenY;
      this.inputQueue.push({
        type: 'mouse',
        hwnd: cap.targetHwnd,
        msg: button === 2 ? 0x0205 : 0x0202, // WM_RBUTTONUP / WM_LBUTTONUP
        wParam: 0,
        lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
      });
      return;
    }

    // Send mouse-up to topmost window under cursor
    const sortedWins = Object.values(this.windows)
      .filter(w => w.visible && !w.isChild)
      .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
    for (const win of sortedWins) {
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
        this.inputQueue.push({
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

    // Resize drag. Update win.{x,y,w,h} live so NC chrome tracks the
    // cursor; actual guest-side WM_SIZE is deferred to mouseup so we
    // don't flood the guest with resizes mid-drag.
    if (this._resizingWin) {
      const r = this._resizingWin;
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
      r.win.x = nx; r.win.y = ny; r.win.w = nw; r.win.h = nh;
      // Reallocate back-canvas to the new size; previous contents are
      // discarded since the guest will repaint on WM_SIZE anyway.
      r.win._backCanvas = null;
      this.repaint();
      return;
    }
    // Window dragging
    if (this._draggingWin) {
      this._draggingWin.pendingX = (canvasX - this._draggingWin.offsetX) | 0;
      this._draggingWin.pendingY = (canvasY - this._draggingWin.offsetY) | 0;
      return;
    }
    // If a window has mouse capture, route all moves to it regardless of position.
    // Works for both renderer-known windows and WAT-native child controls
    // (listbox thumb drag, etc). Child-local lParam is computed from the
    // resolved screen origin, not the top window's client origin.
    const we = this.wasm && this.wasm.exports;
    const capHwnd = we && we.get_capture_hwnd && we.get_capture_hwnd();
    const cap = capHwnd ? this._resolveCaptureTarget(capHwnd) : null;
    if (cap) {
      const relX = canvasX - cap.screenX;
      const relY = canvasY - cap.screenY;
      if (we.post_message_q && this.windows[cap.targetHwnd]) {
        // WM_SETCURSOR is only meaningful for top-level windows; skip for
        // WAT-native children (hittest_sync would miss and the cursor would
        // flicker to the arrow as the captured control moves off-bounds).
        const hit = (we.hittest_sync ? (we.hittest_sync(cap.targetHwnd, canvasX, canvasY) | 0) : 1);
        const lp = (hit & 0xFFFF) | ((0x0200 & 0xFFFF) << 16);
        we.post_message_q(cap.targetHwnd, 0x0020, cap.targetHwnd, lp >>> 0);
      }
      this.inputQueue.push({
        type: 'mouse',
        hwnd: cap.targetHwnd,
        msg: 0x0200, // WM_MOUSEMOVE
        wParam: this._mouseButtonsMask || 0x0001, // captured drags expect button state
        lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
      });
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
        this.inputQueue.push({
          type: 'mouse',
          hwnd: d.childHwnd,
          msg: 0x0200, // WM_MOUSEMOVE
          wParam: this._mouseButtonsMask || 0x0001, // we're mid-drag
          lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
        });
        this.scheduleRepaint();
        return;
      }
    }
    for (const win of Object.values(this.windows)) {
      if (!win.visible) continue;
      if (canvasX >= win.x && canvasX < win.x + win.w &&
          canvasY >= win.y && canvasY < win.y + win.h) {
        const clientX = win.x + 3;
        const clientY = win.y + 3 + 18 + (this._hasMenuBar(win) ? 18 : 0) + 1;
        const relX = canvasX - clientX;
        const relY = canvasY - clientY;
        // Post WM_SETCURSOR before WM_MOUSEMOVE so the guest wndproc sees
        // them in real-DispatchMessage order (post queue drains before the
        // host input poll in GetMessageA).
        if (we && we.post_message_q) {
          const hit = (we.hittest_sync ? (we.hittest_sync(win.hwnd, canvasX, canvasY) | 0) : 1);
          const lp = (hit & 0xFFFF) | ((0x0200 & 0xFFFF) << 16);
          we.post_message_q(win.hwnd, 0x0020, win.hwnd, lp >>> 0);
        }
        this.inputQueue.push({
          type: 'mouse',
          hwnd: win.hwnd,
          msg: 0x0200, // WM_MOUSEMOVE
          wParam: this._mouseButtonsMask || 0,
          lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
        });
        return;
      }
    }
  }

  P.handleWheel = function(canvasX, canvasY, deltaY) {
    const we = this.wasm && this.wasm.exports;
    if (!we || !we.send_message) return;
    const target = this._findWatEditTarget();
    if (!target) return;
    const delta = deltaY > 0 ? -120 : 120;
    const wParam = ((delta & 0xFFFF) << 16) >>> 0;
    we.send_message(target, 0x020A, wParam, 0);
    this.invalidate(target);
    const parentWin = this._findParentWindow(target);
    if (parentWin) this.invalidate(parentWin.hwnd);
  }

  P.handleMenuHover = function(canvasX, canvasY) {
    const we = this.wasm && this.wasm.exports;
    if (!we || !we.menu_open_hwnd) return;
    const hwnd = we.menu_open_hwnd() | 0;
    if (!hwnd) return;
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
    if (we && we.send_message && we.edit_command_target) {
      const target = we.edit_command_target() | 0;
      if (target) return target;
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
    // Update async key state up-front so handlers that read it (edit's
    // Shift/Ctrl+arrow, Ctrl+A, etc.) see the right modifier state for
    // *this* keystroke. Otherwise the _asyncKeys bump that checkInput
    // does later only lands after the next modifier press, which loses
    // chords issued in the same batch.
    if (!this._asyncKeys) this._asyncKeys = Object.create(null);
    this._asyncKeys[vkCode & 0xFF] = true;
    const we = this.wasm && this.wasm.exports;
    const menuOpenHwnd = (we && we.menu_open_hwnd) ? (we.menu_open_hwnd() | 0) : 0;

    if (vkCode === 18) { this._altDown = true; this._altTapped = true; return; } // Alt
    if (vkCode === 27) { // Escape
      if (menuOpenHwnd) {
        if (we.menu_handle_key_open) we.menu_handle_key_open(vkCode);
        else we.menu_close();
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
        if (vkCode >= 65 && vkCode <= 90) this._suppressNextKeyPress = true;
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
        this._suppressNextKeyPress = true;
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

    // Route WM_KEYDOWN to WAT EditState — WAT is sole source of truth for
    // edit text. Handles both WAT-only controls and JS-visible Edit children.
    {
      const editTarget = this._findWatEditTarget();
      if (editTarget && we.send_message) {
        we.send_message(editTarget, 0x0100, vkCode, 0);
        this.invalidate(editTarget);
        const parentWin = this._findParentWindow(editTarget);
        if (parentWin) this.invalidate(parentWin.hwnd);
        this.inputQueue.push({
          type: 'key', hwnd: 0, msg: 0x0100, wParam: vkCode, lParam: 0,
        });
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
    if (this._asyncKeys) this._asyncKeys[vkCode & 0xFF] = false;
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
    if (this._suppressNextKeyPress) { this._suppressNextKeyPress = false; return; }
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

  P.checkInput = function() {
    if (this.inputQueue.length === 0) return 0;
    const evt = this.inputQueue.shift();
    if (evt && (evt.msg === 0x0100 || evt.msg === 0x0102 || evt.msg === 0x0104)) {
      this._profileMark && this._profileMark('input-queue-dispatch', { msg: evt.msg, wParam: evt.wParam });
    }
    // After delivering WM_PAINT, schedule repaint so menus redraw on top
    if (evt.msg === 0x000F) this.scheduleRepaint();
    // Track async key state for GetAsyncKeyState
    if (evt.msg === 0x0100 || evt.msg === 0x0104) { // WM_KEYDOWN, WM_SYSKEYDOWN
      if (!this._asyncKeys) this._asyncKeys = Object.create(null);
      this._asyncKeys[evt.wParam & 0xFF] = true;
    } else if (evt.msg === 0x0101 || evt.msg === 0x0105) { // WM_KEYUP, WM_SYSKEYUP
      if (this._asyncKeys) this._asyncKeys[evt.wParam & 0xFF] = false;
    }
    return evt;
  }

  // GetAsyncKeyState(vKey) — high bit set if key is currently down
  P.getAsyncKeyState = function(vKey) {
    if (!this._asyncKeys) return 0;
    return this._asyncKeys[vKey & 0xFF] ? 0x8000 : 0;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { installInputHandlers };
} else if (typeof window !== 'undefined') {
  window.installInputHandlers = installInputHandlers;
}
