// Win98Renderer input handling — split from renderer.js
// Mixed into Win98Renderer.prototype

function installInputHandlers(R) {
  const P = R.prototype;

  P._findTopWindow = function(hwnd) {
    const win = this.windows[hwnd];
    if (!win) return null;
    if (win.isChild && win.parentHwnd) return this.windows[win.parentHwnd] || null;
    return win;
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
    if (!we || !we.wnd_get_parent) return null;
    const cr = topWin.clientRect;
    const topOx = cr ? cr.x : (topWin.isPopup ? topWin.x : topWin.x + 3);
    const topOy = cr ? cr.y : (topWin.isPopup ? topWin.y : topWin.y + 3 + 18 + (this._hasMenuBar(topWin) ? 18 : 0) + 1);
    const skipClass = new Set([3, 5, 6]); // ListBox, ComboBox, ScrollBar
    // Walk every renderer-known window. A window is a descendant of topWin
    // iff its WAT parent chain reaches topWin.hwnd. For each such descendant
    // accumulate screen origin = topClientOrigin + sum(child.x,y along chain).
    // The deepest (longest chain) visible descendant whose rect contains the
    // click wins.
    let best = null, bestDepth = -1;
    for (const w of Object.values(this.windows)) {
      if (w.hwnd === topWin.hwnd) continue;
      if (!w.visible) continue;
      const klass = we.ctrl_get_class ? (we.ctrl_get_class(w.hwnd) | 0) : 0;
      if (skipClass.has(klass)) continue;
      // Walk WAT parents up to topWin, accumulating ancestor offsets.
      const chain = [];
      let cur = w.hwnd, depth = 0, ok = false;
      for (let i = 0; i < 16 && cur; i++) {
        const p = we.wnd_get_parent(cur) | 0;
        if (p === topWin.hwnd) { ok = true; break; }
        if (!p) break;
        chain.push(p);
        cur = p;
        depth++;
      }
      if (!ok) continue;
      // Sum ancestor offsets (in client-area coords of their parent).
      let dx = 0, dy = 0;
      for (const anc of chain) {
        const anw = this.windows[anc];
        if (!anw) { dx = NaN; break; }
        dx += anw.x; dy += anw.y;
      }
      if (Number.isNaN(dx)) continue;
      const sx = topOx + dx + w.x;
      const sy = topOy + dy + w.y;
      if (cx < sx || cx >= sx + w.w || cy < sy || cy >= sy + w.h) continue;
      if (depth > bestDepth) {
        best = { hwnd: w.hwnd, sx, sy };
        bestDepth = depth;
      }
    }
    return best;
  };

  // Resolve a captured-mouse target (from SetCapture / $capture_hwnd) to the
  // screen origin of the coordinate space its WM_MOUSEMOVE/WM_LBUTTONUP
  // lParams should be relative to. Handles three cases:
  //   1. Top-level window in this.windows → origin = client origin.
  //   2. Renderer-known child (isChild) → origin = parent client origin.
  //   3. WAT-native child control (not in this.windows) → walk wnd_get_parent
  //      summing ctrl_get_xy offsets until we hit a known top window, then
  //      origin = parent client origin + accumulated child offset. Covers
  //      controls created via DialogBoxParam/listbox thumb drag/etc.
  // Returns { win, screenX, screenY, targetHwnd } or null.
  P._resolveCaptureTarget = function(capHwnd) {
    if (!capHwnd) return null;
    const direct = this.windows[capHwnd];
    if (direct) {
      const top = direct.isChild && direct.parentHwnd
        ? (this.windows[direct.parentHwnd] || direct)
        : direct;
      // WS_POPUP windows (combobox dropdowns, menus) have no caption/border
      // chrome — capture coords are relative to the window's own origin.
      if (top.isPopup) {
        return { win: top, screenX: top.x, screenY: top.y, targetHwnd: capHwnd };
      }
      const screenX = top.x + 3;
      const screenY = top.y + 3 + 18 + (this._hasMenuBar(top) ? 18 : 0) + 1;
      return { win: top, screenX, screenY, targetHwnd: capHwnd };
    }
    const we = this.wasm && this.wasm.exports;
    if (!we || !we.wnd_get_parent || !we.ctrl_get_xy) return null;
    let cur = capHwnd, dx = 0, dy = 0;
    for (let i = 0; i < 8 && cur; i++) {
      const xy = we.ctrl_get_xy(cur) | 0;
      dx += (xy << 16) >> 16;      // sign-extend lo 16 = x
      dy += (xy >> 16);            // sign-extend hi 16 = y
      const parent = we.wnd_get_parent(cur) | 0;
      if (!parent) return null;
      const top = this.windows[parent];
      if (top) {
        const clientX = top.isPopup ? top.x : top.x + 3;
        const clientY = top.isPopup ? top.y
          : top.y + 3 + 18 + (this._hasMenuBar(top) ? 18 : 0) + 1;
        return { win: top, screenX: clientX + dx, screenY: clientY + dy, targetHwnd: capHwnd };
      }
      cur = parent;
    }
    return null;
  };

  P.handleMouseDown = function(canvasX, canvasY, button) {
    // Modal dialog: block input to other windows
    const modal = Object.values(this.windows).find(w => w.visible && w.isAboutDialog);
    if (modal) {
      // Only allow clicks within the modal
      if (canvasX < modal.x || canvasX >= modal.x + modal.w ||
          canvasY < modal.y || canvasY >= modal.y + modal.h) {
        return; // block
      }
    }

    // Menu tracking is fully WAT-side. If a dropdown is currently
    // open, route the click through the WAT helpers: hit-test the
    // dropdown first, then the bar (to switch top item), and fall
    // through to a close if neither matches.
    {
      const we = this.wasm && this.wasm.exports;
      if (we && we.menu_open_hwnd && we.menu_open_hwnd() !== 0) {
        const tracked = we.menu_open_hwnd() | 0;
        const win = this.windows[tracked];
        if (win) {
          const top = we.menu_open_top() | 0;
          const { barX, barY, barH } = this._menuBarPos(win);
          const dx = barX + (we.menu_bar_item_x(tracked, top) | 0);
          const dy = barY + barH;
          const cidx = we.menu_hittest_dropdown(tracked, top, dx, dy, canvasX, canvasY) | 0;
          if (cidx >= 0) {
            // Edit-menu commands still have a JS-side intercept (clipboard etc.)
            const id = we.menu_child_id(tracked, top, cidx) | 0;
            if (this._handleEditCommand(id)) { we.menu_close(); this.repaint(); return; }
            we.menu_set_hover(cidx);
            we.menu_activate();
            this.repaint();
            return;
          }
          const newTop = we.menu_hittest_bar(tracked, barX, barY, canvasX, canvasY) | 0;
          if (newTop >= 0) {
            we.menu_open(tracked, newTop);
            this.repaint();
            return;
          }
        }
        we.menu_close();
        this.repaint();
        return;
      }
    }

    // Find which window was clicked (topmost first for correct z-order hit testing)
    const sortedWins = Object.values(this.windows)
      .filter(w => w.visible && !w.isChild)
      .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
    for (const win of sortedWins) {
      // Skip windows that don't contain the click point
      if (canvasX < win.x || canvasX >= win.x + win.w ||
          canvasY < win.y || canvasY >= win.y + win.h) continue;

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
        const we = this.wasm && this.wasm.exports;
        if (we && we.set_focus_hwnd) we.set_focus_hwnd(0);
      }

      // Title-bar button clicks — classify via WAT hittest_sync; post
      // WM_NCLBUTTONDOWN so the guest wndproc can intercept. DefWindowProcA
      // translates sysbutton hits into WM_SYSCOMMAND posts (SC_CLOSE/
      // SC_MINIMIZE/SC_MAXIMIZE) which the wndproc may veto. For WAT
      // dialogs, SendMessage(WM_CLOSE) keeps the synchronous destroy path.
      if (win.hasCaption) {
        const we = this.wasm && this.wasm.exports;
        const hit = (we && we.hittest_sync) ? (we.hittest_sync(win.hwnd, canvasX, canvasY) | 0) : 0;
        if (hit === 20 || hit === 8 || hit === 9) {
          // Begin sysbutton press: show sunken visual now, defer the actual
          // SC_CLOSE/SC_MIN/SC_MAX dispatch until release. Matches Win98:
          // releasing outside the button cancels the action. The original
          // sysbutton hit (and the hwnd) is stashed on the renderer; mouseup
          // re-hit-tests the cursor and only fires WM_NCLBUTTONDOWN if it's
          // still over the same button.
          if (we && we.nc_set_pressed) we.nc_set_pressed(win.hwnd, hit);
          if (we && we.nc_repaint_now) we.nc_repaint_now(win.hwnd);
          this._sysBtnDrag = { hwnd: win.hwnd, hit, win, shown: true };
          this.repaint();
          return;
        }
      }

      // Resize-edge drag. WAT's $defwndproc_do_nchittest returns HT codes
      // 10..17 (LEFT/RIGHT/TOP/BOTTOM + corners) only for windows with
      // WS_THICKFRAME, so the style gate lives on the guest side.
      {
        const we = this.wasm && this.wasm.exports;
        const hit = (we && we.hittest_sync) ? (we.hittest_sync(win.hwnd, canvasX, canvasY) | 0) : 0;
        if (hit >= 10 && hit <= 17) {
          this._resizingWin = {
            hwnd: win.hwnd, win, hit,
            startX: canvasX, startY: canvasY,
            origX: win.x, origY: win.y, origW: win.w, origH: win.h,
          };
          return;
        }
      }

      // Title bar drag to move window
      if (win.hasCaption) {
        const tbY = win.y + 3, tbH = 18;
        if (canvasY >= tbY && canvasY < tbY + tbH && canvasX >= win.x + 3 && canvasX < win.x + win.w - 3) {
          this._draggingWin = { win, offsetX: canvasX - win.x, offsetY: canvasY - win.y };
          return;
        }
      }

      // Check menu bar clicks (WAT-side hit-test reads the per-window
      // menu blob and returns the bar item idx; -1 = miss).
      if (this._hasMenuBar(win)) {
        const we = this.wasm && this.wasm.exports;
        if (we && we.menu_hittest_bar) {
          const { barX, barY } = this._menuBarPos(win);
          const idx = we.menu_hittest_bar(win.hwnd, barX, barY, canvasX, canvasY) | 0;
          if (idx >= 0) {
            we.menu_open(win.hwnd, idx);
            this.repaint();
            return;
          }
        }
      }

      const clientX = win.isPopup ? win.x : win.x + 3;
      const clientY = win.isPopup ? win.y : win.y + 3 + 18 + (this._hasMenuBar(win) ? 18 : 0) + 1;

      // WAT-managed dialogs: route the click into WAT, which hit-tests
      // CONTROL_GEOM children and dispatches WM_LBUTTONDOWN/UP to the
      // matching button / edit / listbox / colorgrid. Group-boxes are
      // filtered out WAT-side. Covers FindReplace, About, and
      // DialogBoxParamA/CreateDialogParamA dialogs.
      if ((win.isFindDialog || win.isAboutDialog || win.isDialog) && button !== 2) {
        const we = this.wasm && this.wasm.exports;
        if (we && we.dialog_route_mouse) {
          const lx = canvasX - clientX;
          const ly = canvasY - clientY;
          const lParam = ((lx & 0xFFFF) | ((ly & 0xFFFF) << 16)) >>> 0;
          // Auto-detect double-click: a second LBUTTONDOWN within 500ms
          // and 4px of the same dialog becomes WM_LBUTTONDBLCLK so the
          // edit's word-select handler fires. Same window matches real
          // Win32 behavior (no CS_DBLCLKS check — we always fold).
          const now = Date.now();
          const dx = Math.abs(canvasX - (this._lastLBtnX || 0));
          const dy = Math.abs(canvasY - (this._lastLBtnY || 0));
          let msg = 0x0201; // WM_LBUTTONDOWN
          if (this._lastLBtnTime && (now - this._lastLBtnTime) < 500 && dx < 4 && dy < 4
              && this._lastLBtnHwnd === win.hwnd) {
            msg = 0x0203; // WM_LBUTTONDBLCLK
            this._lastLBtnTime = 0;
          } else {
            this._lastLBtnTime = now;
          }
          this._lastLBtnX = canvasX;
          this._lastLBtnY = canvasY;
          this._lastLBtnHwnd = win.hwnd;
          // Send the down (or dblclk) now; defer WM_LBUTTONUP to
          // handleMouseUp so the user actually sees the button's pressed
          // state while held. (button_wndproc sets the pressed flag on
          // DOWN and clears it on UP; if both fire in the same tick, the
          // pressed visual is never composited.) Cache (parent, lParam)
          // so mouseup can route UP to the same child via
          // dialog_route_mouse.
          if (we.dialog_route_mouse(win.hwnd, msg, 0x0001, lParam)) {
            this._dialogBtnDrag = { parent: win.hwnd, downLParam: lParam, clientX, clientY };
            this.scheduleRepaint();
          }
        }
        return;
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
          const now = Date.now();
          const dx = Math.abs(canvasX - (this._lastLBtnX || 0));
          const dy = Math.abs(canvasY - (this._lastLBtnY || 0));
          if (this._lastLBtnTime && (now - this._lastLBtnTime) < 500 && dx < 4 && dy < 4
              && this._lastLBtnHwnd === win.hwnd) {
            msg = 0x0203; // WM_LBUTTONDBLCLK
            this._lastLBtnTime = 0;
          } else {
            this._lastLBtnTime = now;
          }
          this._lastLBtnX = canvasX;
          this._lastLBtnY = canvasY;
          this._lastLBtnHwnd = win.hwnd;
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
    if (this._resizingWin) {
      const r = this._resizingWin;
      this._resizingWin = null;
      const we = this.wasm && this.wasm.exports;
      if (we && we.host_resize_commit) {
        we.host_resize_commit(r.hwnd, r.win.x, r.win.y, r.win.w, r.win.h);
      }
      this.queuePaint(r.hwnd);
      this.repaint();
      return;
    }
    if (this._draggingWin) {
      this.queuePaint(this._draggingWin.win.hwnd);
    }
    this._draggingWin = null;

    // End deferred dialog button press. Send WM_LBUTTONUP to the same
    // control that received the DOWN by routing through the parent again
    // with the cursor's current position. button_wndproc clears its
    // pressed flag and (for kinds that auto-toggle) processes the click.
    if (this._dialogBtnDrag && button !== 2) {
      const drag = this._dialogBtnDrag;
      this._dialogBtnDrag = null;
      const we = this.wasm && this.wasm.exports;
      if (we && we.dialog_route_mouse) {
        const lx = canvasX - drag.clientX;
        const ly = canvasY - drag.clientY;
        const lParam = ((lx & 0xFFFF) | ((ly & 0xFFFF) << 16)) >>> 0;
        // Try UP at current pos first (matches the button if the user is
        // still over it). If that misses (released outside), fall back to
        // routing UP at the original DOWN coordinates so the originating
        // button still clears its pressed flag.
        if (!we.dialog_route_mouse(drag.parent, 0x0202, 0, lParam)) {
          we.dialog_route_mouse(drag.parent, 0x0202, 0, drag.downLParam);
        }
        this.scheduleRepaint();
      }
      return;
    }

    // End sysbutton press. If still over the original button, dispatch the
    // syscommand by posting WM_NCLBUTTONDOWN — the WAT defwndproc handler
    // turns sysbutton hits into WM_SYSCOMMAND posts. Releasing outside the
    // button cancels (Win98 behavior).
    if (this._sysBtnDrag && button !== 2) {
      const drag = this._sysBtnDrag;
      this._sysBtnDrag = null;
      const we = this.wasm && this.wasm.exports;
      if (we && we.nc_clear_pressed) we.nc_clear_pressed();
      if (we && we.nc_repaint_now) we.nc_repaint_now(drag.hwnd);
      const win = this.windows[drag.hwnd];
      if (we && win) {
        const curHit = we.hittest_sync ? (we.hittest_sync(drag.hwnd, canvasX, canvasY) | 0) : 0;
        if (curHit === drag.hit) {
          if (drag.hit === 20 && (win.isAboutDialog || win.isFindDialog || win.isDialog)) {
            if (we.send_message) we.send_message(drag.hwnd, 0x0010, 0, 0); // WM_CLOSE
            else delete this.windows[drag.hwnd];
            if (win.isDialog && this.windows[drag.hwnd] && we.destroy_dialog_frame) {
              we.destroy_dialog_frame(drag.hwnd);
            }
          } else if (we.post_message_q) {
            const lParam = ((canvasY & 0xFFFF) << 16) | (canvasX & 0xFFFF);
            we.post_message_q(drag.hwnd, 0x00A1, drag.hit, lParam); // WM_NCLBUTTONDOWN
          } else if (drag.hit === 20) {
            this.inputQueue.push({ type: 'close', hwnd: drag.hwnd, msg: 0x0010, wParam: 0, lParam: 0 });
          }
        }
      }
      this.repaint();
      return;
    }

    // If a window has mouse capture, route mouse-up to it regardless of position.
    // Works for both renderer-known windows and WAT-native child controls.
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
        const clientX = win.isPopup ? win.x : win.x + 3;
        const clientY = win.isPopup ? win.y : win.y + 3 + 18 + (this._hasMenuBar(win) ? 18 : 0) + 1;
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
      const we0 = this.wasm && this.wasm.exports;
      if (we0 && we0.hittest_sync && we0.nc_set_pressed && we0.nc_clear_pressed) {
        const drag = this._sysBtnDrag;
        const curHit = we0.hittest_sync(drag.hwnd, canvasX, canvasY) | 0;
        const wasPressed = drag.shown !== false;
        const nowPressed = curHit === drag.hit;
        if (nowPressed !== wasPressed) {
          if (nowPressed) we0.nc_set_pressed(drag.hwnd, drag.hit);
          else we0.nc_clear_pressed();
          if (we0.nc_repaint_now) we0.nc_repaint_now(drag.hwnd);
          drag.shown = nowPressed;
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
      const we0 = this.wasm && this.wasm.exports;
      if (we0 && we0.post_message_q) {
        // HTCAPTION(2) — DefWindowProc maps to arrow (Phase 7 default).
        // The "drag" visual is a JS canvas cursor override layered on top.
        const hwnd = this._draggingWin.win.hwnd;
        const lParam = (2 & 0xFFFF) | ((0x0200 & 0xFFFF) << 16);
        we0.post_message_q(hwnd, 0x0020, hwnd, lParam >>> 0);
      }
      const { win, offsetX, offsetY } = this._draggingWin;
      const oldCR = win.clientRect;
      win.x = canvasX - offsetX;
      win.y = canvasY - offsetY;
      // Move client area pixels to new position
      if (oldCR && oldCR.w > 0 && oldCR.h > 0 && win.clientPainted) {
        this._computeClientRect(win);
        const newCR = win.clientRect;
        try {
          const imgData = this.ctx.getImageData(oldCR.x, oldCR.y, oldCR.w, oldCR.h);
          this.ctx.putImageData(imgData, newCR.x, newCR.y);
        } catch (_) {}
      }
      this.repaint();
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
        wParam: 0x0001, // MK_LBUTTON (capture typically active during drag)
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
          wParam: 0x0001, // MK_LBUTTON — we're mid-drag
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
          wParam: 0,
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
    const win = this.windows[hwnd];
    if (!win) return;
    const top = we.menu_open_top() | 0;
    const { barX, barY, barH } = this._menuBarPos(win);
    const dx = barX + (we.menu_bar_item_x(hwnd, top) | 0);
    const dy = barY + barH;
    const newHover = we.menu_hittest_dropdown(hwnd, top, dx, dy, canvasX, canvasY) | 0;
    const oldHover = we.menu_open_hover() | 0;
    if (newHover !== oldHover) {
      we.menu_set_hover(newHover);
      this.repaint();
    }
  }

  P._findWatEditTarget = function() {
    const we = this.wasm && this.wasm.exports;
    if (!we || !we.send_message) return 0;
    let target = we.get_focus_hwnd ? (we.get_focus_hwnd() | 0) : 0;
    if (target && we.ctrl_get_class && we.ctrl_get_class(target) === 2) return target;
    for (const w of Object.values(this.windows)) {
      if (w.visible && we.ctrl_get_class && we.ctrl_get_class(w.hwnd) === 2) {
        we.send_message(w.hwnd, 0x0007, 0, 0); // WM_SETFOCUS: show caret + set focus hwnd
        return w.hwnd;
      }
    }
    return 0;
  }

  // Route Edit-menu WM_COMMAND ids to the focused WAT edit. Returns true when
  // the id was handled (to suppress the default menu_activate path).
  P._handleEditCommand = function(id) {
    const we = this.wasm && this.wasm.exports;
    if (!we || !we.send_message) return false;
    const target = this._findWatEditTarget();
    if (!target) return false;
    let msg = 0, wParam = 0, lParam = 0;
    if (id === 7)        { msg = 0x00B1; lParam = -1; }           // Select All -> EM_SETSEL(0,-1)
    else if (id === 768) { msg = 0x0300; }                         // Cut   -> WM_CUT
    else if (id === 769) { msg = 0x0301; }                         // Copy  -> WM_COPY
    else if (id === 770) { msg = 0x0302; }                         // Paste -> WM_PASTE
    else if (id === 771) { msg = 0x0303; }                         // Delete-> WM_CLEAR
    else return false;
    we.send_message(target, msg, wParam, lParam);
    this.invalidate(target);
    const parentWin = this._findParentWindow(target);
    if (parentWin) this.invalidate(parentWin.hwnd);
    return true;
  }

  P._findParentWindow = function(hwnd) {
    for (const w of Object.values(this.windows)) {
      if (!w.visible) continue;
      // Check if hwnd is a child of this window
      for (const c of Object.values(this.windows)) {
        if (c.hwnd === hwnd && c.parentHwnd === w.hwnd) return w;
      }
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
      if (menuOpenHwnd) { we.menu_close(); this.repaint(); return; }
      if (this._menuMode) { this._menuMode = false; return; }
    }

    // Arrow / Enter nav while a dropdown is open. The state machine
    // in $menu_advance / $menu_switch_top / $menu_activate owns the
    // cursor and the activation path; this only routes the raw VK.
    if (menuOpenHwnd) {
      if (vkCode === 40) { we.menu_advance(1);  this.repaint(); return; } // Down
      if (vkCode === 38) { we.menu_advance(-1); this.repaint(); return; } // Up
      if (vkCode === 39) { we.menu_switch_top(1);  this.repaint(); return; } // Right
      if (vkCode === 37) { we.menu_switch_top(-1); this.repaint(); return; } // Left
      if (vkCode === 13) { // Enter
        const top = we.menu_open_top() | 0;
        const hover = we.menu_open_hover() | 0;
        if (hover >= 0) {
          const id = we.menu_child_id(menuOpenHwnd, top, hover) | 0;
          if (this._handleEditCommand(id)) { we.menu_close(); this.repaint(); return; }
        }
        we.menu_activate();
        this.repaint();
        return;
      }
    }

    // Any non-Alt key cancels the alt-tap
    this._altTapped = false;

    // Menu mode or Alt+letter: open the matching top item via the
    // WAT bar accelerator table. Walk visible top-level windows that
    // own a menu and ask each whether it has a match.
    if ((this._menuMode || this._altDown) && vkCode >= 65 && vkCode <= 90) {
      if (we && we.menu_find_bar_accel) {
        for (const w of Object.values(this.windows)) {
          if (!w.visible || w.isChild || !this._hasMenuBar(w)) continue;
          this._ensureWatMenu(w);
          const idx = we.menu_find_bar_accel(w.hwnd, vkCode) | 0;
          if (idx >= 0) {
            we.menu_open(w.hwnd, idx);
            this._menuMode = false;
            this._altDown = false;
            this._suppressNextKeyPress = true;
            this.repaint();
            return;
          }
        }
      }
      this._menuMode = false;
      this._altDown = false;
    }

    // Letter while a dropdown is open: walk children for an accel
    // match. Edit-menu commands still need a JS intercept (clipboard
    // etc.) so we don't go through menu_handle_letter directly.
    if (menuOpenHwnd && vkCode >= 65 && vkCode <= 90) {
      const top = we.menu_open_top() | 0;
      const n = we.menu_child_count(menuOpenHwnd, top) | 0;
      for (let i = 0; i < n; i++) {
        const f = we.menu_child_flags(menuOpenHwnd, top, i) | 0;
        if (f & 3) continue; // separator or grayed
        if ((we.menu_child_accel(menuOpenHwnd, top, i) | 0) === vkCode) {
          const id = we.menu_child_id(menuOpenHwnd, top, i) | 0;
          this._suppressNextKeyPress = true;
          if (this._handleEditCommand(id)) { we.menu_close(); this.repaint(); return; }
          we.menu_set_hover(i);
          we.menu_activate();
          this.repaint();
          return;
        }
      }
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

      // Dialog focus traversal (Tab/Shift+Tab/Enter/Esc/arrows).
      // Gated on the focused hwnd having a dialog ancestor. $dlg_load
      // allocates child hwnds contiguously from dlgHwnd+1, so the tab
      // list is just that range filtered by style.
      if (vkCode === 9 || vkCode === 13 || vkCode === 27 || vkCode === 32
          || vkCode === 37 || vkCode === 38 || vkCode === 39 || vkCode === 40) {
        const focus = (we && we.get_focus_hwnd) ? (we.get_focus_hwnd() | 0) : 0;
        // Walk parents via WAT exports — WAT-only children (most buttons,
        // edits, statics in dialogs) aren't in this.windows. A dialog is
        // any hwnd with dlg_get_ctrl_count > 0.
        let dlg = 0;
        if (we && we.dlg_get_ctrl_count && we.wnd_get_parent) {
          for (let h = focus, hop = 0; h && hop < 16; hop++) {
            if ((we.dlg_get_ctrl_count(h) | 0) > 0) { dlg = h; break; }
            h = we.wnd_get_parent(h) | 0;
          }
        }
        if (dlg && we.dlg_get_ctrl_count && we.wnd_get_style_export) {
          // Esc → IDCANCEL. Doesn't need the tab list.
          if (vkCode === 27 && we.post_message_q) {
            we.post_message_q(dlg, 0x0111, 2, 0);                  // WM_COMMAND IDCANCEL
            return;
          }
          // Arrow keys: radio-group navigation if focus is BS_AUTORADIOBUTTON
          // (style&0xF == 9). Up/Left = prev, Down/Right = next.
          if (vkCode === 37 || vkCode === 38 || vkCode === 39 || vkCode === 40) {
            if (focus && we.radio_group_step
                && (we.wnd_get_style_export(focus) & 0xF) === 9) {
              const dir = (vkCode === 38 || vkCode === 37) ? -1 : 1;
              const peer = we.radio_group_step(focus, dir) | 0;
              if (peer && peer !== focus) {
                if (we.send_message) we.send_message(peer, 0x00F1, 1, 0); // BM_SETCHECK
                if (we.set_focus) we.set_focus(peer); else if (we.set_focus_hwnd) we.set_focus_hwnd(peer);
                if (we.post_message_q && we.ctrl_get_id) {
                  const id = we.ctrl_get_id(peer) & 0xFFFF;
                  we.post_message_q(dlg, 0x0111, id, peer);
                }
                this.scheduleRepaint();
                return;
              }
            }
            // Not in a radio group — fall through (don't consume).
          }
          const n = we.dlg_get_ctrl_count(dlg) | 0;
          const list = [];
          for (let i = 0; i < n; i++) {
            const ch = (dlg + 1 + i) >>> 0;
            const st = we.wnd_get_style_export(ch) >>> 0;
            if ((st & 0x10000000) === 0) continue;       // !WS_VISIBLE
            if ((st & 0x08000000) !== 0) continue;       // WS_DISABLED
            if ((st & 0x00010000) === 0) continue;       // !WS_TABSTOP
            list.push(ch);
          }
          if (list.length > 0) {
            if (vkCode === 9) {
              const dir = shift ? -1 : 1;
              let idx = list.indexOf(focus);
              if (idx < 0) idx = dir > 0 ? -1 : 0;
              const next = list[(idx + dir + list.length) % list.length];
              if (we.set_focus) we.set_focus(next);
              else if (we.set_focus_hwnd) we.set_focus_hwnd(next);
              // Don't invalidate the dialog itself — that triggers a
              // WM_NCPAINT whose full-window fill_rect (clipped to NC via
              // ExcludeClipRect) wipes children on Node-CLI Path2D-stub
              // surfaces. set_focus already invalidated the old + new
              // focus controls; just composite.
              this.scheduleRepaint();
              return;
            }
            if (vkCode === 13) {
              // Default button: prefer the runtime "current default"
              // (bit2 set) since focus may have flipped it. Fall back to
              // BS_DEFPUSHBUTTON style if no flag is set.
              let def = we.dlg_get_default_btn ? (we.dlg_get_default_btn(dlg) | 0) : 0;
              if (!def) {
                for (const ch of list) {
                  if ((we.ctrl_get_class && we.ctrl_get_class(ch) | 0) !== 1) continue;
                  if ((we.wnd_get_style_export(ch) & 0xF) === 1) { def = ch; break; }
                }
              }
              if (def && we.post_message_q && we.ctrl_get_id) {
                const id = we.ctrl_get_id(def) & 0xFFFF;
                we.post_message_q(dlg, 0x0111, id, def);
                return;
              }
            }
            if (vkCode === 32) {
              if (focus && we.ctrl_get_class && (we.ctrl_get_class(focus) | 0) === 1
                       && we.post_message_q && we.ctrl_get_id) {
                const id = we.ctrl_get_id(focus) & 0xFFFF;
                we.post_message_q(dlg, 0x0111, id, focus);
                return;
              }
            }
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
