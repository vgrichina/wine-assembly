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
    this.drawButton(x + w - bw - 2, by, bw, bh, 'x', false);
    this.drawButton(x + w - bw * 2 - 3, by, bw, bh, '', false);
    this.drawButton(x + w - bw * 3 - 4, by, bw, bh, '_', false);

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
        const label = item.text.replace(/&/, '');
        const tw = ctx.measureText(label).width + 12;
        // Highlight if this menu is open
        if (this._openMenu && this._openMenu.winHwnd === win?.hwnd && this._openMenu.index === menuRects.length) {
          ctx.fillStyle = this.colors.highlight;
          ctx.fillRect(mx, y, tw, h);
          ctx.fillStyle = this.colors.highlightText;
        }
        ctx.fillText(label, mx + 6, y + h / 2);
        ctx.fillStyle = this.colors.menuText;
        menuRects.push({ x: mx, y, w: tw, h, item, index: menuRects.length });
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
        const label = (sub.text || '').replace(/&/g, '');
        if (menu.hoverIndex === i) {
          ctx.fillStyle = this.colors.highlight;
          ctx.fillRect(dx + 2, iy, dw - 4, itemH);
          ctx.fillStyle = this.colors.highlightText;
        } else {
          ctx.fillStyle = sub.grayed ? this.colors.btnShadow : this.colors.menuText;
        }
        ctx.fillText(label, dx + 20, iy + itemH / 2);
      }
      menu.dropdownRects.push({ x: dx + 2, y: iy, w: dw - 4, h: itemH, sub });
      iy += itemH;
    }
  }

  drawEditArea(x, y, w, h, text) {
    const ctx = this.ctx;
    this.drawInsetBorder(x, y, w, h);
    ctx.fillStyle = this.colors.editBg;
    ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
    if (text) {
      ctx.fillStyle = this.colors.editText;
      ctx.font = this.font;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 2, y + 2, w - 4, h - 4);
      ctx.clip();
      const lines = text.split('\n');
      const lineHeight = 14;
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], x + 4, y + 4 + i * lineHeight);
      }
      ctx.restore();
    }
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
    const useDefault = v => v === -2147483648 || v === 0x80000000;
    // Find parent: if WS_CHILD, the most recently created top-level window is the parent
    let parentHwnd = null;
    if (!isTopLevel) {
      for (const w of Object.values(this.windows)) {
        if (!(w.style & 0x40000000)) parentHwnd = w.hwnd;
      }
    }
    const win = {
      hwnd, style, title,
      x: Math.max(0, useDefault(x) ? 20 : x),
      y: Math.max(0, useDefault(y) ? 20 : (isTopLevel && y === 0 && useDefault(x) ? 20 : y)),
      w: useDefault(cx) ? 400 : (isTopLevel && cx === 0 && useDefault(x) ? 400 : cx),
      h: useDefault(cy) ? 300 : (isTopLevel && cy === 0 && useDefault(x) ? 300 : cy),
      visible: !!(style & 0x10000000), // WS_VISIBLE
      isChild: !isTopLevel,
      parentHwnd,
      menu: null,
      controls: [],
      editText: '',
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
      menu: null,
      controls: [],
      isDialog: true,
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
    if (win.visible) this.invalidate(hwnd);
  }

  setWindowClass(hwnd, className) {
    console.log('setWindowClass', hwnd, JSON.stringify(className));
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

    for (const win of Object.values(this.windows)) {
      if (!win.visible || win.isChild) continue;
      this.drawWindow(win);
    }

    // Draw dropdown overlay on top of everything
    if (this._openMenu) {
      this._drawDropdown(this._openMenu);
    }
  }

  drawWindow(win) {
    const ctx = this.ctx;
    const { x, y, w, h } = win;

    // Edit child windows: just draw the edit area, no frame
    if (win.isEdit) {
      this.drawEditArea(x, y, w, h, win.editText);
      return;
    }

    ctx.fillStyle = this.colors.btnFace;
    ctx.fillRect(x, y, w, h);
    this.drawOutsetBorder(x, y, w, h);

    let cy = y + 3;

    const tbh = this.drawTitleBar(x + 3, cy, w - 6, win.title, true);
    cy += tbh + 1;

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
        this.drawEditArea(clientX, clientY, clientW, clientH, child.editText);
        hasEditChild = true;
      }
    }
    // Fallback: draw edit area if no controls and no edit child
    if (!hasEditChild && win.controls.length === 0 && !win.isDialog) {
      this.drawEditArea(clientX, clientY, clientW, clientH, win.editText);
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
            this.inputQueue.push({
              type: 'command',
              hwnd: this._openMenu.winHwnd,
              msg: 0x0111, // WM_COMMAND
              wParam: dr.sub.id,
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

      // If click is within the window, send WM_LBUTTONDOWN
      if (canvasX >= win.x && canvasX < win.x + win.w &&
          canvasY >= win.y && canvasY < win.y + win.h) {
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

  handleKeyDown(vkCode) {
    const win = this._getEditWindow();
    if (win) {
      if (vkCode === 8) { // Backspace
        win.editText = win.editText.slice(0, -1);
        this.invalidate(win.hwnd);
      } else if (vkCode === 13) { // Enter
        win.editText += '\n';
        this.invalidate(win.hwnd);
      }
    }
    this.inputQueue.push({
      type: 'key',
      hwnd: 0,
      msg: 0x0100, // WM_KEYDOWN
      wParam: vkCode,
      lParam: 0,
    });
  }

  handleKeyPress(charCode) {
    const win = this._getEditWindow();
    console.log('handleKeyPress', charCode, 'editWin=', win ? win.hwnd : 'none', 'isEdit=', win?.isEdit, 'windows=', Object.keys(this.windows));
    if (win && charCode >= 32) { // printable characters
      win.editText += String.fromCharCode(charCode);
      this.invalidate(win.hwnd);
    }
    this.inputQueue.push({
      type: 'key',
      hwnd: 0,
      msg: 0x0102, // WM_CHAR
      wParam: charCode,
      lParam: 0,
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
