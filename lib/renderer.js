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
      editBg: '#ffffff',
      editText: '#000000',
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

  drawTitleBar(x, y, w, title, active, dialogStyle) {
    const ctx = this.ctx;
    const h = 18;
    const grad = ctx.createLinearGradient(x, y, x + w, y);
    if (active) {
      grad.addColorStop(0, this.colors.titleActive);
      grad.addColorStop(1, this.colors.titleGrad);
    } else {
      grad.addColorStop(0, '#808080');
      grad.addColorStop(1, '#c0c0c0');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);

    ctx.fillStyle = this.colors.titleText;
    ctx.font = this.fontBold;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(title || '', x + 4, y + h / 2);

    // Window buttons (minimize, maximize, close)
    const bw = 16, bh = 14, by = y + 2;
    const closeX = x + w - bw - 2;
    this.drawButton(closeX, by, bw, bh, '', false);
    const maxX = dialogStyle ? 0 : x + w - bw * 2 - 4;
    const minX = dialogStyle ? 0 : x + w - bw * 3 - 4;
    if (!dialogStyle) {
      this.drawButton(maxX, by, bw, bh, '', false);
      this.drawButton(minX, by, bw, bh, '', false);
    }

    // Draw close X glyph
    ctx.strokeStyle = this.colors.windowText;
    ctx.lineWidth = 1.5;
    const cx = closeX + 4, cy = by + 3, cs = 7;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + cs, cy + cs); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + cs, cy); ctx.lineTo(cx, cy + cs); ctx.stroke();

    if (!dialogStyle) {
      // Draw maximize/restore box glyph
      ctx.lineWidth = 1;
      ctx.strokeStyle = this.colors.windowText;
      ctx.fillStyle = this.colors.windowText;
      if (this._currentWin && this._currentWin._maximized) {
        const mx = maxX + 5, my = by + 2, ms = 7;
        ctx.strokeRect(mx, my, ms, ms);
        ctx.fillRect(mx, my, ms + 1, 2);
        const mx2 = maxX + 3, my2 = by + 4;
        ctx.fillStyle = this.colors.btnFace;
        ctx.fillRect(mx2, my2, ms, ms);
        ctx.strokeStyle = this.colors.windowText;
        ctx.strokeRect(mx2, my2, ms, ms);
        ctx.fillStyle = this.colors.windowText;
        ctx.fillRect(mx2, my2, ms + 1, 2);
      } else {
        const mx = maxX + 3, my = by + 3, ms = 9;
        ctx.strokeRect(mx, my, ms, ms - 1);
        ctx.fillRect(mx, my, ms + 1, 2);
      }

      // Draw minimize line glyph
      ctx.fillStyle = this.colors.windowText;
      ctx.fillRect(minX + 4, by + bh - 5, 7, 2);
    }
    ctx.lineWidth = 1;

    return h;
  }

  // Build display lines from text, wrapping at maxWidth if > 0.
  // Returns array of { text, offset } where offset is absolute position in original text.
  _buildDisplayLines(text, maxWidth) {
    const ctx = this.ctx;
    const logicalLines = (text || '').split('\n');
    const displayLines = [];
    let offset = 0;
    for (let i = 0; i < logicalLines.length; i++) {
      const line = logicalLines[i];
      if (!maxWidth || ctx.measureText(line).width <= maxWidth) {
        displayLines.push({ text: line, offset });
      } else {
        // Wrap this line
        let pos = 0;
        while (pos < line.length) {
          // Find how many chars fit in maxWidth
          let end = pos;
          for (let c = pos + 1; c <= line.length; c++) {
            if (ctx.measureText(line.substring(pos, c)).width > maxWidth) break;
            end = c;
          }
          if (end === pos) end = pos + 1; // at least one char
          // Try to break at a space (word boundary)
          if (end < line.length) {
            let spaceIdx = -1;
            for (let s = end; s > pos; s--) {
              if (line[s] === ' ') { spaceIdx = s; break; }
            }
            if (spaceIdx > pos) end = spaceIdx + 1; // include the space in this line
          }
          displayLines.push({ text: line.substring(pos, end), offset: offset + pos });
          pos = end;
        }
        if (pos === 0) displayLines.push({ text: '', offset }); // empty line
      }
      offset += line.length + 1; // +1 for \n
    }
    return displayLines;
  }

  drawEditArea(x, y, w, h, text, editWin) {
    const ctx = this.ctx;
    const lineHeight = 14;
    const hasVScroll = editWin && !!(editWin.style & 0x00200000); // WS_VSCROLL
    const sbWidth = 16;
    const textAreaW = hasVScroll ? w - sbWidth : w;

    this.drawInsetBorder(x, y, textAreaW, h);
    ctx.fillStyle = this.colors.editBg;
    ctx.fillRect(x + 2, y + 2, textAreaW - 4, h - 4);

    // Store edit area bounds for click handling
    if (editWin) {
      editWin._editBounds = { x: x + 2, y: y + 2, w: textAreaW - 4, h: h - 4 };
    }

    ctx.font = this.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    // ES_AUTOHSCROLL = 0x80: when absent on an Edit control, word-wrap is active
    const wrapEnabled = editWin && editWin.isEdit && !(editWin.style & 0x80);
    const maxWidth = wrapEnabled ? (textAreaW - 8) : 0;
    const dlines = this._buildDisplayLines(text, maxWidth);
    if (editWin) editWin._displayLines = dlines;

    const cursor = editWin ? (editWin._cursor != null ? editWin._cursor : text.length) : 0;
    const selStart = editWin ? (editWin._selStart != null ? editWin._selStart : cursor) : 0;
    const selEnd = cursor;
    const sMin = Math.min(selStart, selEnd);
    const sMax = Math.max(selStart, selEnd);

    // Scroll: ensure cursor line is visible
    const visibleLines = Math.floor((h - 8) / lineHeight);
    if (editWin) {
      if (editWin._scrollTop == null) editWin._scrollTop = 0;
      // Find cursor's display line
      let cursorLine = dlines.length - 1;
      for (let i = 0; i < dlines.length; i++) {
        const dl = dlines[i];
        const nextOff = (i + 1 < dlines.length) ? dlines[i + 1].offset : dl.offset + dl.text.length + 1;
        if (cursor >= dl.offset && cursor < nextOff) { cursorLine = i; break; }
        if (cursor === dl.offset + dl.text.length && (i + 1 >= dlines.length || dlines[i + 1].offset > cursor)) { cursorLine = i; break; }
      }
      editWin._cursorLine = cursorLine;
      // Auto-scroll to keep cursor visible only when cursor moved
      if (editWin._lastCursor !== cursor) {
        editWin._lastCursor = cursor;
        if (cursorLine < editWin._scrollTop) editWin._scrollTop = cursorLine;
        if (cursorLine >= editWin._scrollTop + visibleLines) editWin._scrollTop = cursorLine - visibleLines + 1;
      }
      // Clamp
      const maxScroll = Math.max(0, dlines.length - visibleLines);
      editWin._scrollTop = Math.max(0, Math.min(editWin._scrollTop, maxScroll));
      editWin._maxScroll = maxScroll;
      editWin._visibleLines = visibleLines;
    }

    const scrollTop = editWin ? editWin._scrollTop : 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 2, textAreaW - 4, h - 4);
    ctx.clip();

    for (let i = scrollTop; i < dlines.length && (i - scrollTop) < visibleLines + 1; i++) {
      const ly = y + 4 + (i - scrollTop) * lineHeight;
      const lx = x + 4;
      const dl = dlines[i];
      const lineStart = dl.offset;
      const lineEnd = lineStart + dl.text.length;

      // Draw selection highlight for this line
      if (sMin !== sMax && lineEnd > sMin && lineStart < sMax) {
        const selColStart = Math.max(0, sMin - lineStart);
        const selColEnd = Math.min(dl.text.length, sMax - lineStart);
        const sx = lx + ctx.measureText(dl.text.substring(0, selColStart)).width;
        const sw = ctx.measureText(dl.text.substring(selColStart, selColEnd)).width;
        ctx.fillStyle = this.colors.highlight;
        ctx.fillRect(sx, ly, sw || 4, lineHeight);
      }

      // Draw text
      if (sMin !== sMax && lineEnd > sMin && lineStart < sMax) {
        const selColStart = Math.max(0, sMin - lineStart);
        const selColEnd = Math.min(dl.text.length, sMax - lineStart);
        if (selColStart > 0) {
          ctx.fillStyle = this.colors.editText;
          ctx.fillText(dl.text.substring(0, selColStart), lx, ly);
        }
        const sx = lx + ctx.measureText(dl.text.substring(0, selColStart)).width;
        ctx.fillStyle = this.colors.highlightText;
        ctx.fillText(dl.text.substring(selColStart, selColEnd), sx, ly);
        if (selColEnd < dl.text.length) {
          const ax = lx + ctx.measureText(dl.text.substring(0, selColEnd)).width;
          ctx.fillStyle = this.colors.editText;
          ctx.fillText(dl.text.substring(selColEnd), ax, ly);
        }
      } else {
        ctx.fillStyle = this.colors.editText;
        ctx.fillText(dl.text, lx, ly);
      }
    }

    // Draw cursor (blinking caret)
    if (editWin && sMin === sMax) {
      const ci = editWin._cursorLine || 0;
      if (ci >= scrollTop && ci - scrollTop <= Math.max(visibleLines, 1)) {
        const col = cursor - dlines[ci].offset;
        const cx = x + 4 + ctx.measureText(dlines[ci].text.substring(0, col)).width;
        const cy = y + 4 + (ci - scrollTop) * lineHeight;
        ctx.fillStyle = this.colors.editText;
        ctx.fillRect(cx, cy, 1, lineHeight);
      }
    }
    // Start blink timer if not already running
    if (editWin && !this._caretTimer && !this._isNode) {
      this._caretVisible = true;
      this._caretTimer = setInterval(() => {
        this._caretVisible = !this._caretVisible;
        this.repaint();
      }, 530);
    }

    ctx.restore();

    // Draw vertical scrollbar
    if (hasVScroll) {
      this._drawVScrollbar(x + textAreaW, y, sbWidth, h, editWin);
    }
  }

  _drawVScrollbar(x, y, w, h, editWin) {
    const ctx = this.ctx;
    const btnH = w; // square buttons

    // Scrollbar trough
    ctx.fillStyle = this.colors.btnFace;
    ctx.fillRect(x, y, w, h);
    this.drawInsetBorder(x, y, w, h);

    // Trough area (between buttons) - checkered pattern
    const troughY = y + btnH;
    const troughH = h - 2 * btnH;
    ctx.fillStyle = '#c0c0c0';
    ctx.fillRect(x + 1, troughY, w - 2, troughH);

    // Up arrow button
    const pressedDir = editWin && editWin._scrollBtnPressed;
    this._drawScrollButton(x, y, w, btnH, 'up', pressedDir === 'up');
    // Down arrow button
    this._drawScrollButton(x, y + h - btnH, w, btnH, 'down', pressedDir === 'down');

    // Thumb
    if (editWin && editWin._maxScroll > 0) {
      const totalLines = (editWin._displayLines || []).length;
      const visLines = editWin._visibleLines || 1;
      const thumbMinH = 20;
      const thumbH = Math.max(thumbMinH, Math.floor(troughH * visLines / totalLines));
      const scrollRange = troughH - thumbH;
      const thumbY = troughY + Math.floor(scrollRange * editWin._scrollTop / editWin._maxScroll);
      ctx.fillStyle = this.colors.btnFace;
      ctx.fillRect(x + 1, thumbY, w - 2, thumbH);
      this.drawOutsetBorder(x + 1, thumbY, w - 2, thumbH);
      editWin._scrollbarBounds = { x, y: troughY, w, troughH, btnH, thumbY, thumbH, sbTop: y, sbH: h };
    } else if (editWin) {
      // Full-size thumb when content fits
      ctx.fillStyle = this.colors.btnFace;
      ctx.fillRect(x + 1, troughY, w - 2, troughH);
      this.drawOutsetBorder(x + 1, troughY, w - 2, troughH);
      editWin._scrollbarBounds = { x, y: troughY, w, troughH, btnH, thumbY: troughY, thumbH: troughH, sbTop: y, sbH: h };
    }
  }

  _drawScrollButton(x, y, w, h, dir, pressed) {
    const ctx = this.ctx;
    ctx.fillStyle = this.colors.btnFace;
    ctx.fillRect(x, y, w, h);
    if (pressed) {
      this.drawInsetBorder(x, y, w, h);
    } else {
      this.drawOutsetBorder(x, y, w, h);
    }
    // Draw arrow (shift 1px down-right when pressed)
    const off = pressed ? 1 : 0;
    const cx = x + w / 2 + off;
    const cy = y + h / 2 + off;
    const sz = 3;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    if (dir === 'up') {
      ctx.moveTo(cx, cy - sz);
      ctx.lineTo(cx - sz, cy + sz);
      ctx.lineTo(cx + sz, cy + sz);
    } else {
      ctx.moveTo(cx, cy + sz);
      ctx.lineTo(cx - sz, cy - sz);
      ctx.lineTo(cx + sz, cy - sz);
    }
    ctx.fill();
  }

  _startScrollRepeat(editWin, dir) {
    this._stopScrollRepeat();
    this._scrollRepeatWin = editWin;
    // Initial delay 300ms, then repeat every 50ms
    this._scrollRepeatTimer = setTimeout(() => {
      this._scrollRepeatTimer = setInterval(() => {
        if (!this._scrollRepeatWin) return;
        const w = this._scrollRepeatWin;
        w._scrollTop = Math.max(0, Math.min(w._maxScroll || 0, (w._scrollTop || 0) + dir));
        this.repaint();
      }, 50);
    }, 300);
  }

  _stopScrollRepeat() {
    if (this._scrollRepeatTimer) {
      clearTimeout(this._scrollRepeatTimer);
      clearInterval(this._scrollRepeatTimer);
      this._scrollRepeatTimer = null;
    }
    if (this._scrollRepeatWin) {
      this._scrollRepeatWin._scrollBtnPressed = null;
      this._scrollRepeatWin = null;
      this.repaint();
    }
  }

  // Convert canvas coordinates to text offset in an edit window
  _hitTestEdit(editWin, canvasX, canvasY) {
    const ctx = this.ctx;
    ctx.font = this.font;
    const b = editWin._editBounds;
    if (!b) return editWin.editText.length;
    const lineHeight = 14;
    const scrollTop = editWin._scrollTop || 0;
    const relY = canvasY - (b.y + 2);
    const dlines = editWin._displayLines || this._buildDisplayLines(editWin.editText, 0);
    let line = Math.floor(relY / lineHeight) + scrollTop;
    line = Math.max(0, Math.min(line, dlines.length - 1));
    const relX = canvasX - (b.x + 2);
    let col = 0;
    for (let c = 0; c <= dlines[line].text.length; c++) {
      const w = ctx.measureText(dlines[line].text.substring(0, c)).width;
      if (w > relX) break;
      col = c;
    }
    return dlines[line].offset + col;
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
      editText: '',
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
    const e = this.wasm && this.wasm.exports;
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
    console.error(`[createDialog] hwnd=0x${hwnd.toString(16)} dlgCx=${dlgCx} dlgCy=${dlgCy} → w=${Math.round(dlgCx * this.dluX) + 8} h=${Math.round(dlgCy * this.dluY) + 30}`);
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
      editText: '',
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
    if (win) {
      win.className = className;
      // Edit controls are editable text areas
      if (className === 'Edit' || className === 'edit' || className === 'EDIT') {
        win.isEdit = true;
        win.editText = '';
        win._scrollTop = 0;
      }
    }
  }

  setMenu(hwnd, menuResId) {
    const win = this.windows[hwnd];
    const we = this.wasm && this.wasm.exports;
    if (win && we && we.rsrc_exists) {
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
      // Redraw edit children AFTER backCanvas blit so text isn't overwritten
      // Only if no higher-z window overlaps (e.g. Find dialog on top)
      if (win._backCanvas) {
        const we3 = this.wasm && this.wasm.exports;
        for (const child of Object.values(this.windows)) {
          if (child.parentHwnd === win.hwnd && child.visible && child.isEdit) {
            const menuH = this._hasMenuBar(win) ? 18 : 0;
            const clientX = win.x + 3;
            const clientY = win.y + 3 + 18 + menuH + 1;
            const clientW = win.w - 6;
            const clientH = win.h - 6 - 18 - menuH - 1;
            const ew = Math.min(child.w || clientW, clientW - child.x);
            const eh = Math.min(child.h || clientH, clientH - child.y);
            // WAT-managed edit: dispatch WM_PAINT after backCanvas blit
            if (we3 && we3.ctrl_get_class && we3.ctrl_get_class(child.hwnd) === 2 && we3.send_message) {
              if (we3.ctrl_set_geom) we3.ctrl_set_geom(child.hwnd, child.x || 0, child.y || 0, ew, eh);
              this._activeChildDraw = { canvas: this.canvas, ctx: this.ctx,
                ox: clientX + (child.x || 0), oy: clientY + (child.y || 0), hwnd: child.hwnd };
              try { we3.send_message(child.hwnd, 0x000F, 0, 0); }
              finally { this._activeChildDraw = null; }
              continue;
            }
            if (child.editText) {
              this.drawEditArea(clientX + child.x, clientY + child.y, ew, eh, child.editText, child);
            }
          }
        }
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
    // (no defocus distinction yet) — match drawTitleBar's old behaviour.
    let flags = 0x01;
    if (win.isAboutDialog) flags |= 0x02;
    if (win._maximized) flags |= 0x04;
    if (win.hasCaption) flags |= 0x08;
    this._activeChildDraw = { canvas: this.canvas, ctx: this.ctx, ox: x, oy: y, hwnd: win.hwnd };
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
    const e = this.wasm && this.wasm.exports;
    if (!e || !e.menu_load) return;
    win._menuLoaded = false;
    if (!win._menuId) {
      if (e.menu_clear) e.menu_clear(win.hwnd);
      win._menuLoaded = true;
    }
  }

  _ensureWatMenu(win) {
    const e = this.wasm && this.wasm.exports;
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

  // Paint the menu bar via WAT (replaces the old JS drawMenuBar). The
  // _activeChildDraw routing puts gdi_* output onto the screen canvas
  // at the bar's screen position, same pattern as title bar.
  _menuPaintBar(win, x, y, w) {
    const e = this.wasm && this.wasm.exports;
    if (!e || !e.menu_paint_bar) return 0;
    this._ensureWatMenu(win);
    const openIdx = (e.menu_open_hwnd && e.menu_open_hwnd() === win.hwnd)
      ? (e.menu_open_top() | 0) : -1;
    this._activeChildDraw = { canvas: this.canvas, ctx: this.ctx, ox: 0, oy: 0, hwnd: win.hwnd };
    let h = 0;
    try { h = e.menu_paint_bar(win.hwnd, x, y, w, openIdx) | 0; }
    finally { this._activeChildDraw = null; }
    return h;
  }

  // Paint whatever dropdown the WAT side currently has open. Called
  // once per repaint after all windows are composited; reads state
  // from $menu_open_hwnd / $menu_open_top / $menu_open_hover and
  // computes the screen anchor from the owning window.
  _menuPaintDropdown() {
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
      this._activeChildDraw = { canvas: this.canvas, ctx: this.ctx, ox: 0, oy: 0, hwnd };
      try { e.menu_paint_dropdown(hwnd, top, dx, dy, hover); }
      finally { this._activeChildDraw = null; }
    }
  }

  // Enumerate WAT-managed child controls of $win.hwnd via the wnd_next_child_slot
  // export and draw them with the existing primitives. Returns true if any were
  // drawn, in which case drawWindow() skips its JS controls[] loop. Returns
  // false if there's no wasm instance, no exports, or the parent has no WAT
  // children (then the JS controls[] loop runs as before).
  _drawWatChildren(win, clientX, clientY) {
    const e = this._ensureWatScratch();
    if (!e || !e.wnd_next_child_slot) return false;
    const imgBase = this._watImgBase;
    const scratchG = this._watScratchG;
    const u8 = new Uint8Array(this.wasmMemory.buffer);
    const scratchWa = scratchG - imgBase + 0x12000; // g2w
    const readText = (getter, h) => {
      const n = getter(h, scratchG, 255);
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(u8[scratchWa + i]);
      return s;
    };
    // Clip child control drawing to the dialog's client area
    const ctx = this.ctx;
    const cr = win.clientRect;
    if (cr) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cr.x, cr.y, cr.w, cr.h);
      ctx.clip();
    }
    let slot = 0, drewAny = false;
    while ((slot = e.wnd_next_child_slot(win.hwnd, slot)) !== -1) {
      const h = e.wnd_slot_hwnd(slot);
      const cls = e.ctrl_get_class(h);
      slot++;
      if (cls === 0) continue;
      const xy = e.ctrl_get_xy(h);
      const wh = e.ctrl_get_wh(h);
      const cx2 = clientX + (xy & 0xFFFF);
      const cy2 = clientY + ((xy >>> 16) & 0xFFFF);
      const ww = wh & 0xFFFF;
      const hh = (wh >>> 16) & 0xFFFF;
      if (cls === 1) {
        // Button — dispatch WM_PAINT to WAT button_wndproc, which composes
        // the bevel/checkbox/radio/groupbox visuals from GDI primitives.
        // Same _activeChildDraw routing as the static path below.
        if (e.send_message) {
          this._activeChildDraw = { canvas: this.canvas, ctx: this.ctx, ox: cx2, oy: cy2, hwnd: h };
          try { e.send_message(h, 0x000F, 0, 0); }
          finally { this._activeChildDraw = null; }
        }
      } else if (cls === 2) {
        // Edit — dispatch WM_PAINT to WAT edit_wndproc (single-line dialog
        // edit only; the multi-line main editor goes through the
        // drawEditArea path on the JS-side windows[] array, not here).
        if (e.send_message) {
          this._activeChildDraw = { canvas: this.canvas, ctx: this.ctx, ox: cx2, oy: cy2, hwnd: h };
          try { e.send_message(h, 0x000F, 0, 0); }
          finally { this._activeChildDraw = null; }
        }
      } else if (cls === 3) {
        // Static — dispatch WM_PAINT to WAT static_wndproc, which calls
        // host gdi_* primitives. _activeChildDraw tells host-imports to
        // route those calls to the screen canvas at (cx2, cy2) — same
        // target the rest of _drawWatChildren writes to, so the static
        // composes correctly with the surrounding controls.
        if (e.send_message) {
          this._activeChildDraw = { canvas: this.canvas, ctx: this.ctx, ox: cx2, oy: cy2, hwnd: h };
          try { e.send_message(h, 0x000F, 0, 0); }
          finally { this._activeChildDraw = null; }
        }
      } else if (cls === 4 || cls === 6 || cls === 7) {
        // ListBox / ColorGrid / ScrollBar — all have a WM_PAINT handler in their
        // WAT wndproc (composes from GDI primitives via _activeChildDraw).
        if (e.send_message) {
          this._activeChildDraw = { canvas: this.canvas, ctx: this.ctx, ox: cx2, oy: cy2, hwnd: h };
          try { e.send_message(h, 0x000F, 0, 0); }
          finally { this._activeChildDraw = null; }
        }
      }
      drewAny = true;
    }
    if (cr) ctx.restore();
    return drewAny;
  }

  drawWindow(win) {
    const ctx = this.ctx;
    const { x, y, w, h } = win;

    // Edit child windows: if WAT-managed, skip (painted by parent's _drawWatChildren).
    // Otherwise fall back to JS drawEditArea.
    if (win.isEdit) {
      const we3 = this.wasm && this.wasm.exports;
      if (we3 && we3.ctrl_get_class && we3.ctrl_get_class(win.hwnd) === 2) return;
      this.drawEditArea(x, y, w, h, win.editText, win);
      return;
    }

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
    const ncPainted = this._defwndprocNcpaint(win, x, y, w, h);
    if (!ncPainted) {
      ctx.fillStyle = this.colors.btnFace;
      ctx.fillRect(x, y, w, clientY - y);
      ctx.fillRect(x, clientY, 3, clientH);
      ctx.fillRect(x + w - 3, clientY, 3, clientH);
      ctx.fillRect(x, clientY + clientH, w, y + h - clientY - clientH);
      this.drawOutsetBorder(x, y, w, h);
      if (win.hasCaption) {
        this._currentWin = win;
        const tbh = this.drawTitleBar(x + 3, cy, w - 6, win.title, true, win.isAboutDialog);
        cy += tbh + 1;
      }
    } else if (win.hasCaption) {
      cy += 18 + 1;
    }

    if (hasBorder && this._hasMenuBar(win)) {
      const mh = this._menuPaintBar(win, x + 3, cy, w - 6);
      cy += (mh || 18);
    }
    } // end hasBorder else block

    // Draw child windows (e.g. Edit control) in parent's client area.
    let hasEditChild = false;
    const we2 = this.wasm && this.wasm.exports;
    for (const child of Object.values(this.windows)) {
      if (child.parentHwnd === win.hwnd && child.visible && child.isEdit) {
        const ew = Math.min(child.w || clientW, clientW - child.x);
        const eh = Math.min(child.h || clientH, clientH - child.y);
        // WAT-managed edit: sync geom from JS, let _drawWatChildren paint via WM_PAINT
        if (we2 && we2.ctrl_get_class && we2.ctrl_get_class(child.hwnd) === 2) {
          if (we2.ctrl_set_geom) we2.ctrl_set_geom(child.hwnd, child.x || 0, child.y || 0, ew, eh);
          hasEditChild = true;
          continue;
        }
        // Legacy JS-managed edit
        this.drawEditArea(clientX + child.x, clientY + child.y, ew, eh, child.editText, child);
        hasEditChild = true;
      }
    }

    // Fill dialog client area with button face color
    if (win.isDialog && !hasEditChild) {
      ctx.fillStyle = this.colors.btnFace;
      ctx.fillRect(clientX, clientY, clientW, clientH);
    }

    // Draw WAT-managed children if available. If any are found, they
    // replace the JS controls[] loop for this window — the geometry,
    // text and state come from WAT-side ButtonState/EditState/StaticState
    // via the per-class WM_PAINT in src/09c3-controls.wat. Every dialog
    // we exercise today (CreateDialogParamA, host_register_dialog_frame)
    // registers each control as a WAT child, so this path covers them.
    this._drawWatChildren(win, clientX, clientY);

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
