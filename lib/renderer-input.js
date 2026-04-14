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
      // (e.g. Find dialog edit) so subsequent keystrokes fall back to the
      // JS-side _getEditWindow path for x86 wndprocs like notepad's edit.
      if (!win.isFindDialog && !win.isAboutDialog) {
        const we = this.wasm && this.wasm.exports;
        if (we && we.set_focus_hwnd) we.set_focus_hwnd(0);
      }

      // Check title bar button clicks (close, maximize, minimize)
      if (win.hasCaption) {
        const bw = 16, bh = 14, bby = win.y + 3 + 2;
        const tbw = win.w - 6;
        const closeX = win.x + 3 + tbw - bw - 2;
        const maxX = win.x + 3 + tbw - bw * 2 - 4;
        const minX = win.x + 3 + tbw - bw * 3 - 4;
        if (canvasY >= bby && canvasY < bby + bh) {
          if (canvasX >= closeX && canvasX < closeX + bw) {
            // WAT-managed dialogs (find / about) route the title-bar X
            // through send_message → WM_CLOSE → wndproc, which calls
            // $wnd_destroy_tree + $host_destroy_window. Doing a direct
            // delete here would leak the dialog's child WND_RECORDS
            // slots.
            if (win.isAboutDialog || win.isFindDialog) {
              const we = this.wasm && this.wasm.exports;
              if (we && we.send_message) {
                we.send_message(win.hwnd, 0x0010, 0, 0); // WM_CLOSE
              } else {
                delete this.windows[win.hwnd];
              }
              this.repaint();
              return;
            }
            this.inputQueue.push({ type: 'close', hwnd: win.hwnd, msg: 0x0010, wParam: 0, lParam: 0 });
            return;
          }
          if (canvasX >= maxX && canvasX < maxX + bw) {
            if (win._maximized) {
              // Restore
              win.x = win._restoreRect.x;
              win.y = win._restoreRect.y;
              win.w = win._restoreRect.w;
              win.h = win._restoreRect.h;
              win._maximized = false;
            } else {
              // Maximize
              win._restoreRect = { x: win.x, y: win.y, w: win.w, h: win.h };
              win.x = 0; win.y = 0;
              win.w = this.canvas.width;
              win.h = this.canvas.height;
              win._maximized = true;
            }
            this.repaint();
            return;
          }
          if (canvasX >= minX && canvasX < minX + bw) {
            win.visible = false;
            win._minimized = true;
            this.repaint();
            return;
          }
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

      const clientX = win.x + 3;
      const clientY = win.y + 3 + 18 + (this._hasMenuBar(win) ? 18 : 0) + 1;

      // WAT-managed dialogs: hit-test against WAT-side children.
      // Geometry / state lives in CONTROL_GEOM and ButtonState/EditState.
      // A hit on a button dispatches WM_LBUTTONDOWN/UP through send_message;
      // $button_wndproc posts WM_COMMAND to the parent wndproc.
      // Covers FindReplace, About, and DialogBoxParamA/CreateDialogParamA dialogs.
      if ((win.isFindDialog || win.isAboutDialog || win.isDialog) && button !== 2) {
        const we = this.wasm && this.wasm.exports;
        if (we && we.wnd_next_child_slot) {
          let s = 0;
          while ((s = we.wnd_next_child_slot(win.hwnd, s)) !== -1) {
            const ch = we.wnd_slot_hwnd(s);
            const cls = we.ctrl_get_class(ch);
            const xy = we.ctrl_get_xy(ch);
            const wh = we.ctrl_get_wh(ch);
            const cx = clientX + (xy & 0xFFFF);
            const cy = clientY + ((xy >>> 16) & 0xFFFF);
            const cw = wh & 0xFFFF;
            const ckh = (wh >>> 16) & 0xFFFF;
            if (canvasX >= cx && canvasX < cx + cw && canvasY >= cy && canvasY < cy + ckh) {
              if (cls === 1) { // Button
                const style = we.wnd_get_style_export(ch);
                const kind = style & 0x0F;
                if (kind === 7) { s++; continue; } // groupbox — not interactive
                we.send_message(ch, 0x0201, 0, 0); // WM_LBUTTONDOWN
                we.send_message(ch, 0x0202, 0, 0); // WM_LBUTTONUP
                this.invalidate(win.hwnd);
                return;
              } else if (cls === 2) { // Edit — focus
                // Send WM_LBUTTONDOWN so $edit_wndproc sets $focus_hwnd
                // AND flips EditState bit3 (focused) — needed for caret render
                // and for routing keystrokes via $focus_hwnd below.
                we.send_message(ch, 0x0201, 0, 0);
                this.invalidate(win.hwnd);
                return;
              } else if (cls === 6) { // ColorGrid — dispatch WM_LBUTTONDOWN
                const lx = canvasX - cx;
                const ly = canvasY - cy;
                const lParam = (lx & 0xFFFF) | ((ly & 0xFFFF) << 16);
                we.send_message(ch, 0x0201, 0, lParam);
                we.send_message(ch, 0x0202, 0, lParam);
                this.invalidate(win.hwnd);
                return;
              } else if (cls === 4) { // ListBox — dispatch WM_LBUTTONDOWN
                // wndproc reads y from lParam hi 16 bits, sets cur_sel,
                // posts WM_COMMAND(LBN_SELCHANGE) to parent. y is relative
                // to the listbox client (top of border = 0).
                const lx = canvasX - cx;
                const ly = canvasY - cy;
                const lParam = (lx & 0xFFFF) | ((ly & 0xFFFF) << 16);
                we.send_message(ch, 0x0201, 0, lParam); // WM_LBUTTONDOWN
                we.send_message(ch, 0x0202, 0, lParam); // WM_LBUTTONUP
                this.invalidate(win.hwnd);
                return;
              }
            }
            s++;
          }
        }
        return;
      }

      // Check click in edit area
      if (canvasX >= win.x && canvasX < win.x + win.w &&
          canvasY >= win.y && canvasY < win.y + win.h) {
        // Find edit child
        for (const child of Object.values(this.windows)) {
          if (child.parentHwnd === win.hwnd && child.isEdit) {
            // Check scrollbar click
            if (child._scrollbarBounds) {
              const sb = child._scrollbarBounds;
              if (canvasX >= sb.x && canvasX < sb.x + sb.w) {
                if (canvasY >= sb.y - sb.btnH && canvasY < sb.y) {
                  // Up arrow button
                  child._scrollBtnPressed = 'up';
                  child._scrollTop = Math.max(0, (child._scrollTop || 0) - 1);
                  this._startScrollRepeat(child, -1);
                  this.repaint(); return;
                } else if (canvasY >= sb.y + sb.troughH && canvasY < sb.y + sb.troughH + sb.btnH) {
                  // Down arrow button
                  child._scrollBtnPressed = 'down';
                  child._scrollTop = Math.min(child._maxScroll || 0, (child._scrollTop || 0) + 1);
                  this._startScrollRepeat(child, 1);
                  this.repaint(); return;
                } else if (canvasY >= sb.y && canvasY < sb.thumbY) {
                  // Page up (above thumb)
                  child._scrollTop = Math.max(0, (child._scrollTop || 0) - (child._visibleLines || 10));
                  this.repaint(); return;
                } else if (canvasY >= sb.thumbY + sb.thumbH && canvasY < sb.y + sb.troughH) {
                  // Page down (below thumb)
                  child._scrollTop = Math.min(child._maxScroll || 0, (child._scrollTop || 0) + (child._visibleLines || 10));
                  this.repaint(); return;
                } else if (canvasY >= sb.thumbY && canvasY < sb.thumbY + sb.thumbH) {
                  // Thumb drag start
                  this._draggingThumb = { editWin: child, offsetY: canvasY - sb.thumbY, troughY: sb.y, troughH: sb.troughH, thumbH: sb.thumbH };
                  return;
                }
              }
            }
            if (child._editBounds) {
            const b = child._editBounds;
            if (canvasX >= b.x && canvasX < b.x + b.w && canvasY >= b.y && canvasY < b.y + b.h) {
              const off = this._hitTestEdit(child, canvasX, canvasY);
              const now = Date.now();
              const dblClick = this._lastClickTime && (now - this._lastClickTime) < 400
                && this._lastClickEdit === child;
              const triClick = this._lastDblTime && (now - this._lastDblTime) < 400
                && this._lastClickEdit === child;

              if (triClick) {
                // Triple-click: select entire line
                const text = child.editText;
                const lines = text.split('\n');
                let lineStart = 0;
                for (const line of lines) {
                  if (off <= lineStart + line.length) {
                    child._selStart = lineStart;
                    child._cursor = lineStart + line.length;
                    break;
                  }
                  lineStart += line.length + 1;
                }
                this._lastDblTime = 0;
              } else if (dblClick) {
                // Double-click: select word
                const text = child.editText;
                const isWord = c => /\w/.test(c);
                let start = off, end = off;
                if (off < text.length && isWord(text[off])) {
                  while (start > 0 && isWord(text[start - 1])) start--;
                  while (end < text.length && isWord(text[end])) end++;
                } else if (off > 0 && isWord(text[off - 1])) {
                  start = off - 1; end = off;
                  while (start > 0 && isWord(text[start - 1])) start--;
                  while (end < text.length && isWord(text[end])) end++;
                }
                child._selStart = start;
                child._cursor = end;
                this._lastDblTime = now;
              } else {
                // Single click
                child._cursor = off;
                if (!this._shiftDown) child._selStart = off;
              }
              this._lastClickTime = now;
              this._lastClickEdit = child;
              this._draggingEdit = child;
              this._resetCaret();
              this.invalidate(win.hwnd);
            }
            }
          }
        }
        const relX = canvasX - clientX;
        const relY = canvasY - clientY;
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
          hwnd: win.hwnd,
          msg,
          wParam: button === 2 ? 0x0002 : 0x0001, // MK_RBUTTON / MK_LBUTTON
          lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
        });
        return;
      }
    }
  }

  P.handleMouseUp = function(canvasX, canvasY, button) {
    if (this._draggingWin) {
      this.queuePaint(this._draggingWin.win.hwnd);
    }
    this._draggingWin = null;
    this._draggingEdit = null;
    this._draggingThumb = null;
    this._stopScrollRepeat();

    // If a window has mouse capture, route mouse-up to it regardless of position
    const we = this.wasm && this.wasm.exports;
    const capHwnd = we && we.get_capture_hwnd && we.get_capture_hwnd();
    if (capHwnd) {
      const win = this._findTopWindow(capHwnd);
      if (win) {
        const clientX = win.x + 3;
        const clientY = win.y + 3 + 18 + (this._hasMenuBar(win) ? 18 : 0) + 1;
        const relX = canvasX - clientX;
        const relY = canvasY - clientY;
        this.inputQueue.push({
          type: 'mouse',
          hwnd: capHwnd,
          msg: button === 2 ? 0x0205 : 0x0202, // WM_RBUTTONUP / WM_LBUTTONUP
          wParam: 0,
          lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
        });
        return;
      }
    }

    // Send mouse-up to topmost window under cursor
    const sortedWins = Object.values(this.windows)
      .filter(w => w.visible && !w.isChild)
      .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
    for (const win of sortedWins) {
      if (canvasX >= win.x && canvasX < win.x + win.w &&
          canvasY >= win.y && canvasY < win.y + win.h) {
        const clientX = win.x + 3;
        const clientY = win.y + 3 + 18 + (this._hasMenuBar(win) ? 18 : 0) + 1;
        const relX = canvasX - clientX;
        const relY = canvasY - clientY;
        this.inputQueue.push({
          type: 'mouse',
          hwnd: win.hwnd,
          msg: button === 2 ? 0x0205 : 0x0202, // WM_RBUTTONUP / WM_LBUTTONUP
          wParam: 0,
          lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
        });
        return;
      }
    }
  }

  P.handleMouseMove = function(canvasX, canvasY) {
    // Window dragging
    if (this._draggingWin) {
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
    // Scrollbar thumb drag
    if (this._draggingThumb) {
      const dt = this._draggingThumb;
      const scrollRange = dt.troughH - dt.thumbH;
      if (scrollRange > 0 && dt.editWin._maxScroll > 0) {
        const thumbPos = canvasY - dt.offsetY - dt.troughY;
        const ratio = Math.max(0, Math.min(1, thumbPos / scrollRange));
        dt.editWin._scrollTop = Math.round(ratio * dt.editWin._maxScroll);
        this.repaint();
      }
      return;
    }
    // Drag-to-select in edit area
    if (this._draggingEdit) {
      const off = this._hitTestEdit(this._draggingEdit, canvasX, canvasY);
      this._draggingEdit._cursor = off;
      this.repaint();
      return;
    }
    // If a window has mouse capture, route all moves to it regardless of position
    const we = this.wasm && this.wasm.exports;
    const capHwnd = we && we.get_capture_hwnd && we.get_capture_hwnd();
    if (capHwnd) {
      const win = this._findTopWindow(capHwnd);
      if (win) {
        const clientX = win.x + 3;
        const clientY = win.y + 3 + 18 + (this._hasMenuBar(win) ? 18 : 0) + 1;
        const relX = canvasX - clientX;
        const relY = canvasY - clientY;
        this.inputQueue.push({
          type: 'mouse',
          hwnd: capHwnd,
          msg: 0x0200, // WM_MOUSEMOVE
          wParam: 0x0001, // MK_LBUTTON (capture typically active during drag)
          lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
        });
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
    const editWin = this._getEditWindow();
    if (!editWin) return;
    if (editWin._scrollTop == null) editWin._scrollTop = 0;
    // Recompute display lines to get accurate maxScroll
    if (editWin._editBounds) {
      this.ctx.font = this.font;
      const wrapEnabled = editWin.isEdit && !(editWin.style & 0x80);
      const maxWidth = wrapEnabled ? editWin._editBounds.w : 0;
      const dlines = this._buildDisplayLines(editWin.editText, maxWidth);
      const lineHeight = 14;
      const visibleLines = Math.floor((editWin._editBounds.h) / lineHeight);
      editWin._maxScroll = Math.max(0, dlines.length - visibleLines);
      editWin._displayLines = dlines;
      editWin._visibleLines = visibleLines;
    }
    const lines = deltaY > 0 ? 3 : -3;
    const maxScroll = editWin._maxScroll || 0;
    const newScroll = Math.max(0, Math.min(maxScroll, editWin._scrollTop + lines));
    if (newScroll !== editWin._scrollTop) {
      editWin._scrollTop = newScroll;
      this.repaint();
    }
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

  P._handleEditCommand = function(id) {
    const win = this._getEditWindow();
    if (!win) return false;
    this._editEnsureCursor(win);
    const text = win.editText;
    const s = Math.min(win._selStart, win._cursor);
    const e = Math.max(win._selStart, win._cursor);
    if (id === 7) { // Select All
      win._selStart = 0;
      win._cursor = text.length;
      this.invalidate(win.hwnd);
      return true;
    } else if (id === 769) { // Copy
      if (s !== e && typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(text.substring(s, e));
      }
      return true;
    } else if (id === 768) { // Cut
      if (s !== e) {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          navigator.clipboard.writeText(text.substring(s, e));
        }
        this._editDeleteSelection(win);
        this.invalidate(win.hwnd);
      }
      return true;
    } else if (id === 770) { // Paste
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.readText().then(t => {
          if (t) {
            this._editDeleteSelection(win);
            win.editText = win.editText.substring(0, win._cursor) + t + win.editText.substring(win._cursor);
            win._cursor += t.length;
            win._selStart = win._cursor;
            this.invalidate(win.hwnd);
          }
        });
      }
      return true;
    } else if (id === 771) { // Delete
      this._editDeleteSelection(win);
      this.invalidate(win.hwnd);
      return true;
    }
    return false;
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

  P._getEditWindow = function() {
    // Find an Edit-class child window first
    for (const win of Object.values(this.windows)) {
      if (win.isEdit) return win;
    }
    // Fallback: top-level non-dialog window (notepad-style single-edit apps)
    for (const win of Object.values(this.windows)) {
      if (win.visible && !win.isDialog && !win.isChild) return win;
    }
    return null;
  }

  P._editDeleteSelection = function(win) {
    const sMin = Math.min(win._selStart, win._cursor);
    const sMax = Math.max(win._selStart, win._cursor);
    if (sMin !== sMax) {
      win.editText = win.editText.substring(0, sMin) + win.editText.substring(sMax);
      win._cursor = sMin;
      win._selStart = sMin;
      return true;
    }
    return false;
  }

  P._editEnsureCursor = function(win) {
    if (win._cursor == null) { win._cursor = win.editText.length; win._selStart = win._cursor; }
  }

  P._resetCaret = function() {
    this._caretVisible = true;
    if (this._caretTimer) { clearInterval(this._caretTimer); this._caretTimer = null; }
  }

  P.handleKeyDown = function(vkCode) {
    if (this._exited) return;
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

    // Route WM_KEYDOWN to WAT EditState — WAT is sole source of truth for
    // edit text. Handles both WAT-only controls and JS-visible Edit children.
    {
      let watFocus = we && we.get_focus_hwnd ? we.get_focus_hwnd() : 0;
      if (!watFocus && we && we.send_message) {
        for (const w of Object.values(this.windows)) {
          if (w.isEdit && w.visible && we.ctrl_get_class && we.ctrl_get_class(w.hwnd) === 2) {
            we.send_message(w.hwnd, 0x0007, 0, 0);
            watFocus = w.hwnd;
            break;
          }
        }
      }
      if (watFocus && we.send_message) {
        we.send_message(watFocus, 0x0100, vkCode, 0);
        this.invalidate(watFocus);
        const parentWin = this._findParentWindow(watFocus);
        if (parentWin) this.invalidate(parentWin.hwnd);
        this.inputQueue.push({
          type: 'key', hwnd: 0, msg: 0x0100, wParam: vkCode, lParam: 0,
        });
        return;
      }
    }

    const win = this._getEditWindow();
    if (win) {
      this._resetCaret();
      this._editEnsureCursor(win);
      const text = win.editText;
      const lines = text.split('\n');
      const shift = this._shiftDown;
      const ctrl = this._ctrlDown;

      // Helper: offset to line,col
      const toLC = (off) => {
        let rem = off;
        for (let i = 0; i < lines.length; i++) {
          if (rem <= lines[i].length) return { line: i, col: rem };
          rem -= lines[i].length + 1;
        }
        return { line: lines.length - 1, col: lines[lines.length - 1].length };
      };
      const toOff = (line, col) => {
        let off = 0;
        for (let i = 0; i < line; i++) off += lines[i].length + 1;
        return off + col;
      };

      if (vkCode === 16) { this._shiftDown = true; }
      else if (vkCode === 17) { this._ctrlDown = true; }
      else if (vkCode === 8) { // Backspace
        if (!this._editDeleteSelection(win) && win._cursor > 0) {
          win.editText = text.substring(0, win._cursor - 1) + text.substring(win._cursor);
          win._cursor--;
          win._selStart = win._cursor;
        }
        this.invalidate(win.hwnd);
      } else if (vkCode === 46) { // Delete
        if (!this._editDeleteSelection(win) && win._cursor < text.length) {
          win.editText = text.substring(0, win._cursor) + text.substring(win._cursor + 1);
          win._selStart = win._cursor;
        }
        this.invalidate(win.hwnd);
      } else if (vkCode === 13) { // Enter
        this._editDeleteSelection(win);
        win.editText = win.editText.substring(0, win._cursor) + '\n' + win.editText.substring(win._cursor);
        win._cursor++;
        win._selStart = win._cursor;
        this.invalidate(win.hwnd);
      } else if (vkCode === 37) { // Left
        if (win._cursor > 0) {
          if (ctrl) {
            // Word left
            let p = win._cursor - 1;
            while (p > 0 && text[p - 1] === ' ') p--;
            while (p > 0 && text[p - 1] !== ' ' && text[p - 1] !== '\n') p--;
            win._cursor = p;
          } else {
            win._cursor--;
          }
        }
        if (!shift) win._selStart = win._cursor;
        this.invalidate(win.hwnd);
      } else if (vkCode === 39) { // Right
        if (win._cursor < text.length) {
          if (ctrl) {
            let p = win._cursor;
            while (p < text.length && text[p] !== ' ' && text[p] !== '\n') p++;
            while (p < text.length && text[p] === ' ') p++;
            win._cursor = p;
          } else {
            win._cursor++;
          }
        }
        if (!shift) win._selStart = win._cursor;
        this.invalidate(win.hwnd);
      } else if (vkCode === 38) { // Up
        const lc = toLC(win._cursor);
        if (lc.line > 0) {
          win._cursor = toOff(lc.line - 1, Math.min(lc.col, lines[lc.line - 1].length));
        }
        if (!shift) win._selStart = win._cursor;
        this.invalidate(win.hwnd);
      } else if (vkCode === 40) { // Down
        const lc = toLC(win._cursor);
        if (lc.line < lines.length - 1) {
          win._cursor = toOff(lc.line + 1, Math.min(lc.col, lines[lc.line + 1].length));
        }
        if (!shift) win._selStart = win._cursor;
        this.invalidate(win.hwnd);
      } else if (vkCode === 36) { // Home
        const lc = toLC(win._cursor);
        win._cursor = toOff(lc.line, 0);
        if (!shift) win._selStart = win._cursor;
        this.invalidate(win.hwnd);
      } else if (vkCode === 35) { // End
        const lc = toLC(win._cursor);
        win._cursor = toOff(lc.line, lines[lc.line].length);
        if (!shift) win._selStart = win._cursor;
        this.invalidate(win.hwnd);
      } else if (ctrl && vkCode === 65) { // Ctrl+A select all
        win._selStart = 0;
        win._cursor = text.length;
        this.invalidate(win.hwnd);
      } else if (ctrl && vkCode === 67) { // Ctrl+C copy
        const s = Math.min(win._selStart, win._cursor);
        const e = Math.max(win._selStart, win._cursor);
        if (s !== e && typeof navigator !== 'undefined' && navigator.clipboard) {
          navigator.clipboard.writeText(text.substring(s, e));
        }
      } else if (ctrl && vkCode === 88) { // Ctrl+X cut
        const s = Math.min(win._selStart, win._cursor);
        const e = Math.max(win._selStart, win._cursor);
        if (s !== e) {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            navigator.clipboard.writeText(text.substring(s, e));
          }
          this._editDeleteSelection(win);
          this.invalidate(win.hwnd);
        }
      } else if (ctrl && vkCode === 86) { // Ctrl+V paste
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          navigator.clipboard.readText().then(t => {
            if (t) {
              this._editDeleteSelection(win);
              win.editText = win.editText.substring(0, win._cursor) + t + win.editText.substring(win._cursor);
              win._cursor += t.length;
              win._selStart = win._cursor;
              this.invalidate(win.hwnd);
            }
          });
        }
      }
    }
    this.inputQueue.push({
      type: 'key', hwnd: 0, msg: 0x0100, wParam: vkCode, lParam: 0,
    });
  }

  P.handleKeyUp = function(vkCode) {
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
    // Route WM_CHAR to WAT EditState — WAT is sole source of truth for edit text.
    const we = this.wasm && this.wasm.exports;
    let watFocus = we && we.get_focus_hwnd ? we.get_focus_hwnd() : 0;
    // If no WAT focus, try to find a visible Edit window and give it focus
    if (!watFocus && we && we.send_message) {
      for (const w of Object.values(this.windows)) {
        if (w.isEdit && w.visible && we.ctrl_get_class && we.ctrl_get_class(w.hwnd) === 2) {
          we.send_message(w.hwnd, 0x0007, 0, 0); // WM_SETFOCUS
          watFocus = w.hwnd;
          break;
        }
      }
    }
    if (watFocus && we.send_message) {
      we.send_message(watFocus, 0x0102, charCode, 0);
      this.invalidate(watFocus);
      const parentWin = this._findParentWindow(watFocus);
      if (parentWin) this.invalidate(parentWin.hwnd);
      return;
    }
    const win = this._getEditWindow();
    if (win && charCode >= 32 && !this._ctrlDown) {
      this._editEnsureCursor(win);
      this._editDeleteSelection(win);
      win.editText = win.editText.substring(0, win._cursor) + String.fromCharCode(charCode) + win.editText.substring(win._cursor);
      win._cursor++;
      win._selStart = win._cursor;
      if (win.text != null) win.text = win.editText;
      this.invalidate(win.hwnd);
    }
    this.inputQueue.push({
      type: 'key', hwnd: 0, msg: 0x0102, wParam: charCode, lParam: 0,
    });
  }

  P.checkInput = function() {
    if (this.inputQueue.length === 0) return 0;
    const evt = this.inputQueue.shift();
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
