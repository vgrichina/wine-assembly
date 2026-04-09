// Win98Renderer input handling — split from renderer.js
// Mixed into Win98Renderer.prototype

function installInputHandlers(R) {
  const P = R.prototype;


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

    // Check if clicking on an open dropdown first
    if (this._openMenu && this._openMenu.dropdownRects) {
      for (const dr of this._openMenu.dropdownRects) {
        if (canvasX >= dr.x && canvasX < dr.x + dr.w && canvasY >= dr.y && canvasY < dr.y + dr.h) {
          if (dr.sub && dr.sub.id && !dr.sub.separator) {
            const id = dr.sub.id;
            // Handle Edit menu commands in the renderer
            if (this._handleEditCommand(id)) {
              this.closeMenu();
              return;
            }
            // Exit menu item (id=28): send WM_CLOSE so DefWindowProc handles it
            const isExit = id === 28;
            this.inputQueue.push({
              type: isExit ? 'close' : 'command',
              hwnd: this._openMenu.winHwnd,
              msg: isExit ? 0x0010 : 0x0111, // WM_CLOSE or WM_COMMAND
              wParam: isExit ? 0 : id,
              lParam: 0,
            });
          }
          this.closeMenu();
          return;
        }
      }
      // Clicked outside dropdown — check if switching to another menu bar item
      const menuWin = Object.values(this.windows).find(w => w.hwnd === this._openMenu.winHwnd);
      if (menuWin && menuWin._menuRects) {
        for (const mr of menuWin._menuRects) {
          if (canvasX >= mr.x && canvasX < mr.x + mr.w && canvasY >= mr.y && canvasY < mr.y + mr.h) {
            this.queuePaint(menuWin.hwnd);
            this._openMenu = { winHwnd: menuWin.hwnd, index: mr.index, item: mr.item, x: mr.x, y: mr.y, h: mr.h, hoverIndex: -1 };
            this.repaint();
            return;
          }
        }
      }
      this.closeMenu();
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

      // Check menu bar clicks
      if (win._menuRects) {
        for (const mr of win._menuRects) {
          if (canvasX >= mr.x && canvasX < mr.x + mr.w && canvasY >= mr.y && canvasY < mr.y + mr.h) {
            this._openMenu = { winHwnd: win.hwnd, index: mr.index, item: mr.item, x: mr.x, y: mr.y, h: mr.h, hoverIndex: -1 };
            this.repaint();
            return;
          }
        }
      }

      const clientX = win.x + 3;
      const clientY = win.y + 3 + 18 + (win.menu ? 18 : 0) + 1;

      // WAT-managed dialogs (find / about): hit-test against WAT-side
      // children. The dialog has no JS controls[] — all geometry / state
      // lives in CONTROL_GEOM and ButtonState/EditState. A hit on a button
      // dispatches WM_LBUTTONDOWN/UP through send_message; $button_wndproc
      // posts WM_COMMAND; the parent wndproc ($findreplace_wndproc /
      // $about_wndproc) reacts. A hit on an edit control sets focus via WAT.
      if ((win.isFindDialog || win.isAboutDialog) && button !== 2) {
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
                we.set_focus_hwnd(ch);
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

      // Check button controls first for WM_COMMAND (left-click only)
      if (button !== 2)
      for (const ctrl of win.controls) {
        const cx = clientX + ctrl.x;
        const cy = clientY + ctrl.y;
        if (canvasX >= cx && canvasX < cx + ctrl.w && canvasY >= cy && canvasY < cy + ctrl.h) {
          if (ctrl.className === 'Button' && ctrl.type !== 'groupbox') {
            if (win.isAboutDialog) {
              delete this.windows[win.hwnd];
              this.repaint();
              return;
            }
            // Auto-toggle for checkbox/radio types
            if (ctrl.type === 'autocheckbox') {
              ctrl.checked = !ctrl.checked;
            } else if (ctrl.type === 'autoradiobutton') {
              // Uncheck all radio buttons in same group, check this one
              for (const c of win.controls) {
                if ((c.type === 'autoradiobutton' || c.type === 'radiobutton') && c !== ctrl) {
                  c.checked = false;
                }
              }
              ctrl.checked = true;
            }
            ctrl.pressed = true;
            this.invalidate(win.hwnd);
            this.inputQueue.push({
              type: 'command',
              hwnd: win.hwnd,
              id: ctrl.id,
              msg: 0x0111, // WM_COMMAND
              wParam: ctrl.id,
              lParam: 0,
            });
            return;
          }
        }
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
        this.inputQueue.push({
          type: 'mouse',
          hwnd: win.hwnd,
          msg: button === 2 ? 0x0204 : 0x0201, // WM_RBUTTONDOWN / WM_LBUTTONDOWN
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
    // Clear pressed state on all controls
    for (const win of Object.values(this.windows)) {
      if (!win.visible) continue;
      for (const ctrl of win.controls) {
        if (ctrl.pressed) {
          ctrl.pressed = false;
          this.invalidate(win.hwnd);
        }
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
        const clientY = win.y + 3 + 18 + (win.menu ? 18 : 0) + 1;
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
    for (const win of Object.values(this.windows)) {
      if (!win.visible) continue;
      if (canvasX >= win.x && canvasX < win.x + win.w &&
          canvasY >= win.y && canvasY < win.y + win.h) {
        const clientX = win.x + 3;
        const clientY = win.y + 3 + 18 + (win.menu ? 18 : 0) + 1;
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
    if (!this._openMenu || !this._openMenu.dropdownRects) return;
    let newHover = -1;
    for (let i = 0; i < this._openMenu.dropdownRects.length; i++) {
      const dr = this._openMenu.dropdownRects[i];
      if (canvasX >= dr.x && canvasX < dr.x + dr.w && canvasY >= dr.y && canvasY < dr.y + dr.h) {
        if (dr.sub && !dr.sub.separator) newHover = i;
      }
    }
    if (newHover !== this._openMenu.hoverIndex) {
      this._openMenu.hoverIndex = newHover;
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

  P._getEditWindow = function() {
    // If a dialog edit control is focused, return a wrapper that proxies to the control
    if (this._focusedDialogEdit) {
      const ctrl = this._focusedDialogEdit;
      const dlg = this._focusedDialogEditWin;
      if (dlg && this.windows[dlg.hwnd]) {
        if (!ctrl.editText) ctrl.editText = ctrl.text || '';
        if (ctrl._cursor == null) ctrl._cursor = ctrl.editText.length;
        if (ctrl._selStart == null) ctrl._selStart = ctrl._cursor;
        // Return the ctrl directly — it has editText, _cursor, _selStart
        ctrl.hwnd = dlg.hwnd;
        return ctrl;
      }
      this._focusedDialogEdit = null;
    }
    // Find an Edit-class child window first
    for (const win of Object.values(this.windows)) {
      if (win.isEdit) return win;
    }
    // Fallback: top-level non-dialog window with no controls
    for (const win of Object.values(this.windows)) {
      if (win.visible && win.controls.length === 0 && !win.isDialog) return win;
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
    if (vkCode === 18) { this._altDown = true; this._altTapped = true; return; } // Alt
    if (vkCode === 27) { // Escape
      if (this._openMenu) { this.closeMenu(); return; }
      if (this._menuMode) { this._menuMode = false; return; }
    }

    // Arrow/Enter navigation in open menu
    if (this._openMenu) {
      const items = this._openMenu.item.children || [];
      if (items.length && (vkCode === 40 || vkCode === 38)) { // Down/Up
        let h = this._openMenu.hoverIndex;
        do { h = (h + (vkCode === 40 ? 1 : items.length - 1)) % items.length; } while (items[h].separator);
        this._openMenu.hoverIndex = h;
        this.repaint(); return;
      } else if (vkCode === 13 && items.length) { // Enter
        const h = this._openMenu.hoverIndex;
        if (h >= 0 && items[h] && !items[h].separator) {
          const sub = items[h];
          if (this._handleEditCommand(sub.id)) { this.closeMenu(); return; }
          const isExit = sub.id === 28;
          this.inputQueue.push({ type: isExit ? 'close' : 'command', hwnd: this._openMenu.winHwnd, msg: isExit ? 0x0010 : 0x0111, wParam: isExit ? 0 : sub.id, lParam: 0 });
          this.closeMenu(); return;
        }
      } else if (vkCode === 37 || vkCode === 39) { // Left/Right: switch menu
        const menuWin = Object.values(this.windows).find(w => w.hwnd === this._openMenu.winHwnd);
        if (menuWin && menuWin._menuRects) {
          const len = menuWin._menuRects.length;
          const newIdx = (this._openMenu.index + (vkCode === 39 ? 1 : len - 1)) % len;
          const mr = menuWin._menuRects[newIdx];
          this.queuePaint(menuWin.hwnd);
          this._openMenu = { winHwnd: menuWin.hwnd, index: newIdx, item: mr.item, x: mr.x, y: mr.y, h: mr.h, hoverIndex: -1 };
          this.repaint(); return;
        }
      }
    }

    // Any non-Alt key cancels the alt-tap
    this._altTapped = false;

    // Menu mode or Alt+letter: open menu by accelerator key
    if ((this._menuMode || this._altDown) && vkCode >= 65 && vkCode <= 90) {
      const ch = String.fromCharCode(vkCode);
      for (const w of Object.values(this.windows)) {
        if (!w.visible || w.isChild || !w._menuRects) continue;
        for (const mr of w._menuRects) {
          if (mr.accelChar === ch) {
            this._openMenu = { winHwnd: w.hwnd, index: mr.index, item: mr.item, x: mr.x, y: mr.y, h: mr.h, hoverIndex: -1 };
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

    // If dropdown open, handle accel keys for items
    if (this._openMenu && vkCode >= 65 && vkCode <= 90) {
      const ch = String.fromCharCode(vkCode);
      const children = this._openMenu.item.children || [];
      for (let i = 0; i < children.length; i++) {
        const sub = children[i];
        if (sub.separator || sub.grayed) continue;
        const ampIdx = (sub.text || '').indexOf('&');
        if (ampIdx >= 0 && ampIdx + 1 < sub.text.length && sub.text[ampIdx + 1].toUpperCase() === ch) {
          this._suppressNextKeyPress = true;
          if (this._handleEditCommand(sub.id)) {
            this.closeMenu();
            return;
          }
          const isExit = sub.id === 28;
          this.inputQueue.push({
            type: isExit ? 'close' : 'command',
            hwnd: this._openMenu.winHwnd,
            msg: isExit ? 0x0010 : 0x0111,
            wParam: isExit ? 0 : sub.id,
            lParam: 0,
          });
          this.closeMenu();
          return;
        }
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
    const win = this._getEditWindow();
    console.log('[keypress]', charCode, 'focused=', !!this._focusedDialogEdit, 'win=', win ? (win.hwnd || win.id || 'obj') : 'null', 'editText=', win ? JSON.stringify(win.editText) : '-');
    if (win && charCode >= 32 && !this._ctrlDown) {
      this._editEnsureCursor(win);
      this._editDeleteSelection(win);
      win.editText = win.editText.substring(0, win._cursor) + String.fromCharCode(charCode) + win.editText.substring(win._cursor);
      win._cursor++;
      win._selStart = win._cursor;
      if (win.text != null) win.text = win.editText;  // sync for dialog controls
      console.log('[keypress] after:', JSON.stringify(win.editText), 'hwnd=', win.hwnd);
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
    return evt;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { installInputHandlers };
} else if (typeof window !== 'undefined') {
  window.installInputHandlers = installInputHandlers;
}
