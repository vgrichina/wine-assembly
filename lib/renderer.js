// Win98Renderer — shared between browser and Node (node-canvas)
// Usage: new Win98Renderer(canvas) where canvas is either a DOM <canvas> or node-canvas instance

class Win98Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resources = null;
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
  }

  loadResources(json) {
    this.resources = json;
  }

  // --- Drawing primitives ---

  drawOutsetBorder(x, y, w, h) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.colors.btnHighlight;
    ctx.beginPath(); ctx.moveTo(x, y + h - 1); ctx.lineTo(x, y); ctx.lineTo(x + w - 1, y); ctx.stroke();
    ctx.strokeStyle = this.colors.btnLight;
    ctx.beginPath(); ctx.moveTo(x + 1, y + h - 2); ctx.lineTo(x + 1, y + 1); ctx.lineTo(x + w - 2, y + 1); ctx.stroke();
    ctx.strokeStyle = this.colors.btnDkShadow;
    ctx.beginPath(); ctx.moveTo(x, y + h - 1); ctx.lineTo(x + w - 1, y + h - 1); ctx.lineTo(x + w - 1, y); ctx.stroke();
    ctx.strokeStyle = this.colors.btnShadow;
    ctx.beginPath(); ctx.moveTo(x + 1, y + h - 2); ctx.lineTo(x + w - 2, y + h - 2); ctx.lineTo(x + w - 2, y + 1); ctx.stroke();
  }

  drawInsetBorder(x, y, w, h) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.colors.btnShadow;
    ctx.beginPath(); ctx.moveTo(x, y + h - 1); ctx.lineTo(x, y); ctx.lineTo(x + w - 1, y); ctx.stroke();
    ctx.strokeStyle = this.colors.btnDkShadow;
    ctx.beginPath(); ctx.moveTo(x + 1, y + h - 2); ctx.lineTo(x + 1, y + 1); ctx.lineTo(x + w - 2, y + 1); ctx.stroke();
    ctx.strokeStyle = this.colors.btnHighlight;
    ctx.beginPath(); ctx.moveTo(x, y + h - 1); ctx.lineTo(x + w - 1, y + h - 1); ctx.lineTo(x + w - 1, y); ctx.stroke();
    ctx.strokeStyle = this.colors.btnLight;
    ctx.beginPath(); ctx.moveTo(x + 1, y + h - 2); ctx.lineTo(x + w - 2, y + h - 2); ctx.lineTo(x + w - 2, y + 1); ctx.stroke();
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
      ctx.fillText(text, x + w / 2 + off, y + h / 2 + off);
    }
  }

  drawTitleBar(x, y, w, title, active) {
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
    const maxX = x + w - bw * 2 - 4;
    const minX = x + w - bw * 3 - 4;
    this.drawButton(closeX, by, bw, bh, '', false);
    this.drawButton(maxX, by, bw, bh, '', false);
    this.drawButton(minX, by, bw, bh, '', false);

    // Draw close X glyph
    ctx.strokeStyle = this.colors.windowText;
    ctx.lineWidth = 1.5;
    const cx = closeX + 4, cy = by + 3, cs = 7;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + cs, cy + cs); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + cs, cy); ctx.lineTo(cx, cy + cs); ctx.stroke();

    // Draw maximize/restore box glyph
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.colors.windowText;
    ctx.fillStyle = this.colors.windowText;
    if (this._currentWin && this._currentWin._maximized) {
      // Restore glyph: two overlapping boxes
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
    ctx.lineWidth = 1;

    return h;
  }

  drawMenuBar(x, y, w, menuItems, win) {
    const ctx = this.ctx;
    const h = 18;
    ctx.fillStyle = this.colors.menuBg;
    ctx.fillRect(x, y, w, h);

    ctx.fillStyle = this.colors.menuText;
    ctx.font = this.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // Store menu item hit regions for click handling
    const menuRects = [];
    let mx = x + 4;
    if (menuItems) {
      for (const item of menuItems) {
        if (!item.text) continue;
        const label = Win98Renderer._stripAccel(item.text);
        const tw = ctx.measureText(label).width + 12;
        // Highlight if this menu is open
        if (this._openMenu && this._openMenu.winHwnd === win?.hwnd && this._openMenu.index === menuRects.length) {
          ctx.fillStyle = this.colors.highlight;
          ctx.fillRect(mx, y, tw, h);
          ctx.fillStyle = this.colors.highlightText;
        }
        const { accelChar } = this._drawAccelText(mx + 6, y + h / 2, item.text);
        ctx.fillStyle = this.colors.menuText;
        menuRects.push({ x: mx, y, w: tw, h, item, index: menuRects.length, accelChar });
        mx += tw;
      }
    }
    if (win) win._menuRects = menuRects;
    ctx.strokeStyle = this.colors.btnShadow;
    ctx.beginPath(); ctx.moveTo(x, y + h - 1); ctx.lineTo(x + w, y + h - 1); ctx.stroke();

    return h;
  }

  _drawDropdown(menu) {
    const ctx = this.ctx;
    const item = menu.item;
    const children = item.children;
    if (!children || !children.length) return;

    const dx = menu.x;
    const dy = menu.y + menu.h;
    const dw = 180;
    const itemH = 20;
    const dh = children.length * itemH + 4;

    // Background
    ctx.fillStyle = this.colors.menuBg;
    ctx.fillRect(dx, dy, dw, dh);
    this.drawOutsetBorder(dx, dy, dw, dh);

    // Store dropdown item rects for click handling
    menu.dropdownRects = [];
    let iy = dy + 2;
    ctx.font = this.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < children.length; i++) {
      const sub = children[i];
      if (sub.separator) {
        ctx.strokeStyle = this.colors.btnShadow;
        ctx.beginPath(); ctx.moveTo(dx + 4, iy + itemH / 2); ctx.lineTo(dx + dw - 4, iy + itemH / 2); ctx.stroke();
      } else {
        const tabParts = (sub.text || '').split('\t');
        const labelRaw = tabParts[0];
        const shortcut = tabParts[1] || '';
        if (menu.hoverIndex === i) {
          ctx.fillStyle = this.colors.highlight;
          ctx.fillRect(dx + 2, iy, dw - 4, itemH);
          ctx.fillStyle = this.colors.highlightText;
        } else {
          ctx.fillStyle = sub.grayed ? this.colors.btnShadow : this.colors.menuText;
        }
        this._drawAccelText(dx + 20, iy + itemH / 2, labelRaw);
        if (shortcut) {
          ctx.textAlign = 'right';
          ctx.fillText(shortcut, dx + dw - 20, iy + itemH / 2);
          ctx.textAlign = 'left';
        }
      }
      menu.dropdownRects.push({ x: dx + 2, y: iy, w: dw - 4, h: itemH, sub });
      iy += itemH;
    }
  }

  // Draw text with & accelerator underlines. Returns {text, accelChar}.
  _drawAccelText(x, y, rawText) {
    const ctx = this.ctx;
    let drawn = 0;
    let accelChar = null;
    for (let i = 0; i < rawText.length; i++) {
      if (rawText[i] === '&' && i + 1 < rawText.length && rawText[i + 1] !== '&') {
        // Next char is the accelerator
        const ch = rawText[i + 1];
        if (!accelChar) accelChar = ch.toUpperCase();
        const prefix = rawText.substring(0, i).replace(/&/g, '');
        const px = x + ctx.measureText(prefix).width;
        const cw = ctx.measureText(ch).width;
        // Draw underline
        const baseline = y + 5; // approximate baseline offset from middle
        ctx.fillRect(px, baseline, cw, 1);
        i++; // skip the accel char (it'll be drawn as part of full text)
      }
    }
    const clean = rawText.replace(/&&/g, '\x00').replace(/&/g, '').replace(/\x00/g, '&');
    ctx.fillText(clean, x, y);
    return { text: clean, accelChar };
  }

  // Strip & from text
  static _stripAccel(text) {
    return (text || '').replace(/&&/g, '\x00').replace(/&/g, '').replace(/\x00/g, '&');
  }

  drawEditArea(x, y, w, h, text, editWin) {
    const ctx = this.ctx;
    const lineHeight = 14;
    this.drawInsetBorder(x, y, w, h);
    ctx.fillStyle = this.colors.editBg;
    ctx.fillRect(x + 2, y + 2, w - 4, h - 4);

    // Store edit area bounds for click handling
    if (editWin) {
      editWin._editBounds = { x: x + 2, y: y + 2, w: w - 4, h: h - 4 };
    }

    ctx.font = this.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 2, w - 4, h - 4);
    ctx.clip();

    const lines = (text || '').split('\n');
    const cursor = editWin ? (editWin._cursor != null ? editWin._cursor : text.length) : 0;
    const selStart = editWin ? (editWin._selStart != null ? editWin._selStart : cursor) : 0;
    const selEnd = cursor;
    const sMin = Math.min(selStart, selEnd);
    const sMax = Math.max(selStart, selEnd);

    // Convert offset to line,col
    const offsetToLC = (off) => {
      let rem = off;
      for (let i = 0; i < lines.length; i++) {
        if (rem <= lines[i].length) return { line: i, col: rem };
        rem -= lines[i].length + 1; // +1 for \n
      }
      return { line: lines.length - 1, col: lines[lines.length - 1].length };
    };

    const charWidth = ctx.measureText('m').width * 0.62; // approximate monospace

    for (let i = 0; i < lines.length; i++) {
      const ly = y + 4 + i * lineHeight;
      const lx = x + 4;
      const lineStart = lines.slice(0, i).reduce((s, l) => s + l.length + 1, 0);
      const lineEnd = lineStart + lines[i].length;

      // Draw selection highlight for this line
      if (sMin !== sMax && lineEnd > sMin && lineStart < sMax) {
        const selColStart = Math.max(0, sMin - lineStart);
        const selColEnd = Math.min(lines[i].length, sMax - lineStart);
        const sx = lx + ctx.measureText(lines[i].substring(0, selColStart)).width;
        const sw = ctx.measureText(lines[i].substring(selColStart, selColEnd)).width;
        ctx.fillStyle = this.colors.highlight;
        ctx.fillRect(sx, ly, sw || 4, lineHeight);
      }

      // Draw text
      if (sMin !== sMax && lineEnd > sMin && lineStart < sMax) {
        // Draw with selection colors
        const selColStart = Math.max(0, sMin - lineStart);
        const selColEnd = Math.min(lines[i].length, sMax - lineStart);
        // Before selection
        if (selColStart > 0) {
          ctx.fillStyle = this.colors.editText;
          ctx.fillText(lines[i].substring(0, selColStart), lx, ly);
        }
        // Selected text
        const sx = lx + ctx.measureText(lines[i].substring(0, selColStart)).width;
        ctx.fillStyle = this.colors.highlightText;
        ctx.fillText(lines[i].substring(selColStart, selColEnd), sx, ly);
        // After selection
        if (selColEnd < lines[i].length) {
          const ax = lx + ctx.measureText(lines[i].substring(0, selColEnd)).width;
          ctx.fillStyle = this.colors.editText;
          ctx.fillText(lines[i].substring(selColEnd), ax, ly);
        }
      } else {
        ctx.fillStyle = this.colors.editText;
        ctx.fillText(lines[i], lx, ly);
      }
    }

    // Draw cursor (blinking caret)
    if (editWin && sMin === sMax && this._caretVisible) {
      const cc = offsetToLC(cursor);
      const cx = x + 4 + ctx.measureText(lines[cc.line].substring(0, cc.col)).width;
      const cy = y + 4 + cc.line * lineHeight;
      ctx.fillStyle = this.colors.editText;
      ctx.fillRect(cx, cy, 1, lineHeight);
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
  }

  // Convert canvas coordinates to text offset in an edit window
  _hitTestEdit(editWin, canvasX, canvasY) {
    const ctx = this.ctx;
    ctx.font = this.font;
    const b = editWin._editBounds;
    if (!b) return editWin.editText.length;
    const lines = editWin.editText.split('\n');
    const lineHeight = 14;
    const relY = canvasY - (b.y + 2);
    let line = Math.floor(relY / lineHeight);
    line = Math.max(0, Math.min(line, lines.length - 1));
    const relX = canvasX - (b.x + 2);
    // Find column by measuring text widths
    let col = 0;
    for (let c = 0; c <= lines[line].length; c++) {
      const w = ctx.measureText(lines[line].substring(0, c)).width;
      if (w > relX) break;
      col = c;
    }
    // Convert line,col to offset
    let offset = 0;
    for (let i = 0; i < line; i++) offset += lines[i].length + 1;
    return offset + col;
  }

  drawStaticText(x, y, w, h, text) {
    const ctx = this.ctx;
    ctx.fillStyle = this.colors.windowText;
    ctx.font = this.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (text) ctx.fillText(text, x, y + h / 2);
  }

  drawGroupBox(x, y, w, h, text) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.colors.btnShadow;
    ctx.strokeRect(x + 0.5, y + 6.5, w - 1, h - 7);
    ctx.strokeStyle = this.colors.btnHighlight;
    ctx.strokeRect(x + 1.5, y + 7.5, w - 1, h - 7);
    if (text) {
      ctx.fillStyle = this.colors.btnFace;
      const tw = ctx.measureText(text).width + 8;
      ctx.fillRect(x + 8, y, tw, 13);
      ctx.fillStyle = this.colors.windowText;
      ctx.font = this.font;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + 12, y + 6);
    }
  }

  drawRadioButton(x, y, w, h, text, checked) {
    const ctx = this.ctx;
    const r = 6;
    ctx.strokeStyle = this.colors.btnShadow;
    ctx.beginPath(); ctx.arc(x + r, y + h / 2, r, 0, Math.PI * 2); ctx.stroke();
    if (checked) {
      ctx.fillStyle = this.colors.windowText;
      ctx.beginPath(); ctx.arc(x + r, y + h / 2, 3, 0, Math.PI * 2); ctx.fill();
    }
    if (text) {
      ctx.fillStyle = this.colors.windowText;
      ctx.font = this.font;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + r * 2 + 4, y + h / 2);
    }
  }

  drawCheckbox(x, y, w, h, text, checked) {
    const ctx = this.ctx;
    const s = 12;
    this.drawInsetBorder(x, y + (h - s) / 2, s, s);
    ctx.fillStyle = this.colors.editBg;
    ctx.fillRect(x + 2, y + (h - s) / 2 + 2, s - 4, s - 4);
    if (checked) {
      ctx.strokeStyle = this.colors.windowText;
      ctx.lineWidth = 2;
      const bx = x + 3, by = y + (h - s) / 2 + 3;
      ctx.beginPath(); ctx.moveTo(bx, by + 3); ctx.lineTo(bx + 3, by + 6); ctx.lineTo(bx + 7, by); ctx.stroke();
      ctx.lineWidth = 1;
    }
    if (text) {
      ctx.fillStyle = this.colors.windowText;
      ctx.font = this.font;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + s + 4, y + h / 2);
    }
  }

  // --- Window management ---

  createWindow(hwnd, style, x, y, cx, cy, title, menuId) {
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
      menu: null,
      controls: [],
      editText: '',
      zOrder: this._nextZ++,
    };

    if (this.resources && this.resources.menus) {
      if (menuId) {
        win.menu = this.resources.menus[menuId] || null;
      } else if (!(style & 0x40000000)) {
        // Top-level window with no explicit menu — use first available (class menu)
        const keys = Object.keys(this.resources.menus);
        if (keys.length) win.menu = this.resources.menus[keys[0]];
      }
    }

    this.windows[hwnd] = win;
    return hwnd;
  }

  createDialog(hwnd, dlgId) {
    if (!this.resources || !this.resources.dialogs) return hwnd;
    const dlg = this.resources.dialogs[dlgId];
    if (!dlg) return hwnd;

    const win = {
      hwnd,
      style: dlg.style,
      title: dlg.title || '',
      x: dlg.x === -32768 ? 40 : Math.round(dlg.x * this.dluX),
      y: Math.round(Math.max(0, dlg.y) * this.dluY),
      w: Math.round(dlg.cx * this.dluX) + 8,
      h: Math.round(dlg.cy * this.dluY) + 30,
      visible: false,
      isChild: false,
      menu: null,
      controls: [],
      editText: '',
      isDialog: true,
      zOrder: this._nextZ++,
    };

    if (dlg.menu && this.resources.menus) {
      win.menu = this.resources.menus[dlg.menu] || null;
    }

    for (const c of dlg.controls) {
      win.controls.push({
        id: c.id,
        className: c.className,
        type: c.type || '',
        text: c.text || '',
        x: Math.round(c.x * this.dluX),
        y: Math.round(c.y * this.dluY),
        w: Math.round(c.cx * this.dluX),
        h: Math.round(c.cy * this.dluY),
        style: c.style,
        pressed: false,
        checked: false,
      });
    }

    this.windows[hwnd] = win;
    return hwnd;
  }

  showWindow(hwnd, cmd) {
    const win = this.windows[hwnd];
    if (!win) return;
    win.visible = (cmd !== 0);
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
      }
    }
  }

  setMenu(hwnd, menuResId) {
    const win = this.windows[hwnd];
    if (win && this.resources && this.resources.menus) {
      win.menu = this.resources.menus[menuResId] || null;
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

  scheduleRepaint() {
    if (this._repaintScheduled) return;
    this._repaintScheduled = true;
    if (this._isNode) {
      // In Node, repaint synchronously (no rAF)
      this._repaintScheduled = false;
      this.repaint();
    } else {
      requestAnimationFrame(() => {
        this._repaintScheduled = false;
        this.repaint();
      });
    }
  }

  repaint() {
    const ctx = this.ctx;
    ctx.fillStyle = this.colors.desktop;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Sort by z-order (lower = behind, higher = in front)
    const sorted = Object.values(this.windows)
      .filter(w => w.visible && !w.isChild)
      .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
    for (const win of sorted) {
      this.drawWindow(win);
    }

    // Draw dropdown overlay on top of everything
    if (this._openMenu) {
      this._drawDropdown(this._openMenu);
    }

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

  drawWindow(win) {
    const ctx = this.ctx;
    const { x, y, w, h } = win;

    // Edit child windows: just draw the edit area, no frame
    if (win.isEdit) {
      this.drawEditArea(x, y, w, h, win.editText, win);
      return;
    }

    // Skip windows with zero size
    if (w <= 0 || h <= 0) return;

    const hasCaption = !!(win.style & 0x00C00000); // WS_CAPTION
    win.hasCaption = hasCaption;

    ctx.fillStyle = this.colors.btnFace;
    ctx.fillRect(x, y, w, h);
    this.drawOutsetBorder(x, y, w, h);

    let cy = y + 3;

    if (hasCaption) {
      this._currentWin = win;
      const tbh = this.drawTitleBar(x + 3, cy, w - 6, win.title, true);
      cy += tbh + 1;
    }

    if (win.menu) {
      const mh = this.drawMenuBar(x + 3, cy, w - 6, win.menu, win);
      cy += mh;
    }

    const clientX = x + 3;
    const clientY = cy + 1;
    const clientW = w - 6;
    const clientH = h - (cy - y) - 4;

    // Draw child windows (e.g. Edit control) in parent's client area
    let hasEditChild = false;
    for (const child of Object.values(this.windows)) {
      if (child.parentHwnd === win.hwnd && child.visible && child.isEdit) {
        // Clip child to parent's client area
        const ew = Math.min(child.w || clientW, clientW - child.x);
        const eh = Math.min(child.h || clientH, clientH - child.y);
        this.drawEditArea(clientX + child.x, clientY + child.y, ew, eh, child.editText, child);
        hasEditChild = true;
      }
    }

    // Draw controls
    for (const ctrl of win.controls) {
      const cx = clientX + ctrl.x;
      const cy2 = clientY + ctrl.y;

      if (ctrl.className === 'Button') {
        if (ctrl.type === 'groupbox') {
          this.drawGroupBox(cx, cy2, ctrl.w, ctrl.h, ctrl.text);
        } else if (ctrl.type === 'radiobutton') {
          this.drawRadioButton(cx, cy2, ctrl.w, ctrl.h, ctrl.text, ctrl.checked);
        } else if (ctrl.type === 'checkbox' || ctrl.type === 'autocheckbox') {
          this.drawCheckbox(cx, cy2, ctrl.w, ctrl.h, ctrl.text, ctrl.checked);
        } else {
          this.drawButton(cx, cy2, ctrl.w, ctrl.h, ctrl.text, ctrl.pressed);
        }
      } else if (ctrl.className === 'Static') {
        if (ctrl.id === 403) {
          // Calculator display
          this.drawInsetBorder(cx, cy2, ctrl.w, ctrl.h);
          ctx.fillStyle = this.colors.editBg;
          ctx.fillRect(cx + 2, cy2 + 2, ctrl.w - 4, ctrl.h - 4);
          ctx.fillStyle = this.colors.editText;
          ctx.font = '14px "Courier New", monospace';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(ctrl.text || '0.', cx + ctrl.w - 6, cy2 + ctrl.h / 2);
        } else {
          this.drawStaticText(cx, cy2, ctrl.w, ctrl.h, ctrl.text);
        }
      } else if (ctrl.className === 'Edit') {
        this.drawEditArea(cx, cy2, ctrl.w, ctrl.h, ctrl.text);
      }
    }
  }

  // --- Input handling ---

  handleMouseDown(canvasX, canvasY) {
    // Check if clicking on an open dropdown first
    if (this._openMenu && this._openMenu.dropdownRects) {
      for (const dr of this._openMenu.dropdownRects) {
        if (canvasX >= dr.x && canvasX < dr.x + dr.w && canvasY >= dr.y && canvasY < dr.y + dr.h) {
          if (dr.sub && dr.sub.id && !dr.sub.separator) {
            const id = dr.sub.id;
            // Handle Edit menu commands in the renderer
            if (this._handleEditCommand(id)) {
              this._openMenu = null;
              this.repaint();
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
          this._openMenu = null;
          this.repaint();
          return;
        }
      }
      // Clicked outside dropdown — close it
      this._openMenu = null;
      this.repaint();
    }

    // Find which window was clicked
    for (const win of Object.values(this.windows)) {
      if (!win.visible || win.isChild) continue;

      // Check title bar button clicks (close, maximize, minimize)
      if (win.hasCaption) {
        const bw = 16, bh = 14, bby = win.y + 3 + 2;
        const tbw = win.w - 6;
        const closeX = win.x + 3 + tbw - bw - 2;
        const maxX = win.x + 3 + tbw - bw * 2 - 4;
        const minX = win.x + 3 + tbw - bw * 3 - 4;
        if (canvasY >= bby && canvasY < bby + bh) {
          if (canvasX >= closeX && canvasX < closeX + bw) {
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

      // Check button controls first for WM_COMMAND
      for (const ctrl of win.controls) {
        const cx = clientX + ctrl.x;
        const cy = clientY + ctrl.y;
        if (canvasX >= cx && canvasX < cx + ctrl.w && canvasY >= cy && canvasY < cy + ctrl.h) {
          if (ctrl.className === 'Button' && ctrl.type !== 'groupbox') {
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
          if (child.parentHwnd === win.hwnd && child.isEdit && child._editBounds) {
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
        const relX = canvasX - clientX;
        const relY = canvasY - clientY;
        this.inputQueue.push({
          type: 'mouse',
          hwnd: win.hwnd,
          msg: 0x0201, // WM_LBUTTONDOWN
          wParam: 0x0001, // MK_LBUTTON
          lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
        });
        return;
      }
    }
  }

  handleMouseUp(canvasX, canvasY) {
    this._draggingEdit = null;
    for (const win of Object.values(this.windows)) {
      if (!win.visible) continue;
      for (const ctrl of win.controls) {
        if (ctrl.pressed) {
          ctrl.pressed = false;
          this.invalidate(win.hwnd);
        }
      }

      // Send WM_LBUTTONUP if within window
      if (canvasX >= win.x && canvasX < win.x + win.w &&
          canvasY >= win.y && canvasY < win.y + win.h) {
        const clientX = win.x + 3;
        const clientY = win.y + 3 + 18 + (win.menu ? 18 : 0) + 1;
        const relX = canvasX - clientX;
        const relY = canvasY - clientY;
        this.inputQueue.push({
          type: 'mouse',
          hwnd: win.hwnd,
          msg: 0x0202, // WM_LBUTTONUP
          wParam: 0,
          lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
        });
        return;
      }
    }
  }

  handleMouseMove(canvasX, canvasY) {
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

  handleMenuHover(canvasX, canvasY) {
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

  _handleEditCommand(id) {
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

  _getEditWindow() {
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

  _editDeleteSelection(win) {
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

  _editEnsureCursor(win) {
    if (win._cursor == null) { win._cursor = win.editText.length; win._selStart = win._cursor; }
  }

  _resetCaret() {
    this._caretVisible = true;
    if (this._caretTimer) { clearInterval(this._caretTimer); this._caretTimer = null; }
  }

  handleKeyDown(vkCode) {
    if (this._exited) return;
    if (vkCode === 18) { this._altDown = true; this._altTapped = true; return; } // Alt
    if (vkCode === 27) { // Escape
      if (this._openMenu) { this._openMenu = null; this._menuMode = false; this.repaint(); return; }
      if (this._menuMode) { this._menuMode = false; return; }
    }

    // Arrow/Enter navigation in open menu
    if (this._openMenu && this._openMenu.dropdownRects) {
      const dr = this._openMenu.dropdownRects;
      if (vkCode === 40) { // Down
        let h = this._openMenu.hoverIndex;
        do { h = (h + 1) % dr.length; } while (dr[h].sub && dr[h].sub.separator);
        this._openMenu.hoverIndex = h;
        this.repaint(); return;
      } else if (vkCode === 38) { // Up
        let h = this._openMenu.hoverIndex;
        do { h = (h - 1 + dr.length) % dr.length; } while (dr[h].sub && dr[h].sub.separator);
        this._openMenu.hoverIndex = h;
        this.repaint(); return;
      } else if (vkCode === 13) { // Enter
        const h = this._openMenu.hoverIndex;
        if (h >= 0 && dr[h].sub && !dr[h].sub.separator) {
          const sub = dr[h].sub;
          if (this._handleEditCommand(sub.id)) { this._openMenu = null; this.repaint(); return; }
          const isExit = sub.id === 28;
          this.inputQueue.push({ type: isExit ? 'close' : 'command', hwnd: this._openMenu.winHwnd, msg: isExit ? 0x0010 : 0x0111, wParam: isExit ? 0 : sub.id, lParam: 0 });
          this._openMenu = null; this.repaint(); return;
        }
      } else if (vkCode === 37 || vkCode === 39) { // Left/Right: switch menu
        const menuWin = Object.values(this.windows).find(w => w.hwnd === this._openMenu.winHwnd);
        if (menuWin && menuWin._menuRects) {
          const len = menuWin._menuRects.length;
          const newIdx = (this._openMenu.index + (vkCode === 39 ? 1 : len - 1)) % len;
          const mr = menuWin._menuRects[newIdx];
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
            this.repaint();
            return;
          }
        }
      }
      this._menuMode = false;
      this._altDown = false;
    }

    // If dropdown open, handle accel keys for items
    if (this._openMenu && this._openMenu.dropdownRects && vkCode >= 65 && vkCode <= 90) {
      const ch = String.fromCharCode(vkCode);
      const children = this._openMenu.item.children || [];
      for (let i = 0; i < children.length; i++) {
        const sub = children[i];
        if (sub.separator || sub.grayed) continue;
        const ampIdx = (sub.text || '').indexOf('&');
        if (ampIdx >= 0 && ampIdx + 1 < sub.text.length && sub.text[ampIdx + 1].toUpperCase() === ch) {
          if (this._handleEditCommand(sub.id)) {
            this._openMenu = null;
            this.repaint();
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
          this._openMenu = null;
          this.repaint();
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

  handleKeyUp(vkCode) {
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
  }

  handleKeyPress(charCode) {
    if (this._exited) return;
    const win = this._getEditWindow();
    if (win && charCode >= 32 && !this._ctrlDown) {
      this._editEnsureCursor(win);
      this._editDeleteSelection(win);
      win.editText = win.editText.substring(0, win._cursor) + String.fromCharCode(charCode) + win.editText.substring(win._cursor);
      win._cursor++;
      win._selStart = win._cursor;
      this.invalidate(win.hwnd);
    }
    this.inputQueue.push({
      type: 'key', hwnd: 0, msg: 0x0102, wParam: charCode, lParam: 0,
    });
  }

  checkInput() {
    if (this.inputQueue.length === 0) return 0;
    return this.inputQueue.shift();
  }
}

// Export for both Node and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Win98Renderer };
} else if (typeof window !== 'undefined') {
  window.Win98Renderer = Win98Renderer;
}
