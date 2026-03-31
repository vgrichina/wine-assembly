// Shared host imports for wine-assembly WASM instantiation.
// All runners (host.js, test/run.js, tools/render-png.js) use this.
// Real GDI with canvas backend — works with browser canvas or node-canvas.
//
// Usage:
//   const base = createHostImports({ getMemory, renderer, resourceJson, onExit });
//   base.host.log = (ptr, len) => { ... };  // override as needed
//   const { instance } = await WebAssembly.instantiate(wasm, { host: base.host });

function createHostImports(ctx) {
  // ctx.getMemory()    -> ArrayBuffer (late-bound)
  // ctx.renderer       -> Win98Renderer instance (optional; can be getter for late binding)
  // ctx.resourceJson   -> parsed PE resources { menus, dialogs, strings, bitmaps }
  // ctx.onExit(code)   -> called on ExitProcess

  const readStr = (ptr, maxLen = 512) => {
    const mem = new Uint8Array(ctx.getMemory());
    let s = '';
    for (let i = ptr; i < ptr + maxLen; i++) {
      if (!mem[i]) break;
      s += String.fromCharCode(mem[i]);
    }
    return s;
  };

  // --- GDI object state ---
  let _nextGdiHandle = 0x80001;
  const _gdiObjects = {
    0x30001: { type: 'bitmap', w: 1, h: 1, pixels: new Uint8Array(4) },
    // Stock objects: GetStockObject(index) → 0x30010 + index
    0x30010: { type: 'brush', color: 0xFFFFFF },   // WHITE_BRUSH (0)
    0x30011: { type: 'brush', color: 0xC0C0C0 },   // LTGRAY_BRUSH (1)
    0x30012: { type: 'brush', color: 0x808080 },    // GRAY_BRUSH (2)
    0x30013: { type: 'brush', color: 0x404040 },    // DKGRAY_BRUSH (3)
    0x30014: { type: 'brush', color: 0x000000 },    // BLACK_BRUSH (4)
    0x30015: { type: 'null' },                      // NULL_BRUSH / HOLLOW_BRUSH (5)
    0x30016: { type: 'pen', color: 0xFFFFFF, width: 1 }, // WHITE_PEN (6)
    0x30017: { type: 'pen', color: 0x000000, width: 1 }, // BLACK_PEN (7)
    0x30018: { type: 'null' },                      // NULL_PEN (8)
    // 10=OEM_FIXED_FONT, 11=ANSI_FIXED_FONT, 12=ANSI_VAR_FONT, 13=SYSTEM_FONT
    // 14=DEVICE_DEFAULT_FONT, 15=DEFAULT_PALETTE, 16=SYSTEM_FIXED_FONT, 17=DEFAULT_GUI_FONT
    0x30002: { type: 'brush', color: 0xFFFFFF },    // legacy default
  };
  const _dcState = {};

  const _gdiAlloc = (obj) => { const h = _nextGdiHandle++; _gdiObjects[h] = obj; return h; };
  const _getDC = (hdc) => {
    if (!_dcState[hdc]) _dcState[hdc] = { penColor: 0x000000, penWidth: 1, brushColor: 0xC0C0C0, textColor: 0x000000, bkColor: 0xFFFFFF, bkMode: 2, posX: 0, posY: 0 };
    return _dcState[hdc];
  };
  const _getClientOrigin = (hwnd) => {
    const r = ctx.renderer;
    if (!r) return { x: 0, y: 0 };
    const win = r.windows[hwnd];
    if (!win) return { x: 0, y: 0 };
    // Child window: origin = parent's client origin + child's (x, y)
    if (win.isChild && win.parentHwnd) {
      const parentOrigin = _getClientOrigin(win.parentHwnd);
      return { x: parentOrigin.x + win.x, y: parentOrigin.y + win.y };
    }
    // Top-level window: client area starts after border + caption + menu
    let cy = win.y + 2;
    if (win.style & 0x00C00000) cy += 20;
    if (win.menu) cy += 20;
    return { x: win.x + 3, y: cy + 1 };
  };

  const host = {
    // --- Logging (override for tracing/UI) ---
    log: () => {},
    log_i32: () => {},

    // --- System ---
    shell_about: (hWnd, appPtr) => {
      console.log(`[ShellAbout] "${readStr(appPtr)}"`);
      return 1;
    },
    message_box: (hWnd, textPtr, captionPtr, uType) => {
      console.log(`[MessageBox] "${readStr(captionPtr)}": "${readStr(textPtr)}"`);
      return 1;
    },
    exit: (code) => {
      console.log('[Exit] code=' + code);
      if (ctx.onExit) ctx.onExit(code);
    },
    read_file: () => 0,

    // --- Drawing ---
    draw_rect: (x, y, w, h, color) => {
      if (!ctx.renderer) return;
      const c = ctx.renderer.ctx;
      c.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
      c.fillRect(x, y, w, h);
    },
    draw_text: (x, y, textPtr, textLen, color) => {
      if (!ctx.renderer) return;
      const bytes = new Uint8Array(ctx.getMemory(), textPtr, textLen);
      const text = new TextDecoder().decode(bytes);
      const c = ctx.renderer.ctx;
      c.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
      c.font = ctx.renderer.font;
      c.textAlign = 'left';
      c.textBaseline = 'top';
      c.fillText(text, x, y);
    },

    // --- Window management ---
    create_window: (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
      const title = readStr(titlePtr);
      console.log(`[CreateWindow] hwnd=0x${hwnd.toString(16)} title="${title}" menu=${menuId}`);
      if (ctx.renderer) ctx.renderer.createWindow(hwnd, style, x, y, cx, cy, title, menuId);
      return hwnd;
    },
    show_window: (hwnd, cmd) => {
      console.log(`[ShowWindow] hwnd=0x${hwnd.toString(16)} cmd=${cmd}`);
      if (ctx.renderer) ctx.renderer.showWindow(hwnd, cmd);
    },
    create_dialog: (hwnd, dlgId) => {
      console.log(`[CreateDialog] hwnd=0x${hwnd.toString(16)} dlg=${dlgId}`);
      if (ctx.renderer) return ctx.renderer.createDialog(hwnd, dlgId);
      return hwnd;
    },
    load_string: (id, bufPtr, bufLen) => {
      if (!ctx.resourceJson || !ctx.resourceJson.strings) return 0;
      const str = ctx.resourceJson.strings[id];
      if (!str || bufLen <= 0) return 0;
      const bytes = new Uint8Array(ctx.getMemory());
      const maxLen = Math.min(str.length, bufLen - 1);
      for (let i = 0; i < maxLen; i++) bytes[bufPtr + i] = str.charCodeAt(i) & 0xFF;
      bytes[bufPtr + maxLen] = 0;
      return maxLen;
    },
    set_dlg_item_text: (hwnd, ctrlId, textPtr) => {
      const text = readStr(textPtr);
      if (ctx.renderer) ctx.renderer.setDlgItemText(hwnd, ctrlId, text);
    },
    check_dlg_button: (hwnd, ctrlId, checkState) => {
      if (ctx.renderer) ctx.renderer.checkDlgButton(hwnd, ctrlId, checkState);
    },
    check_radio_button: (hwnd, firstId, lastId, checkId) => {
      if (ctx.renderer) ctx.renderer.checkRadioButton(hwnd, firstId, lastId, checkId);
    },
    set_window_text: (hwnd, textPtr) => {
      const text = readStr(textPtr);
      if (ctx.renderer) ctx.renderer.setWindowText(hwnd, text);
    },
    set_window_class: (hwnd, classPtr) => {
      if (ctx.renderer) ctx.renderer.setWindowClass(hwnd, readStr(classPtr));
    },
    invalidate: (hwnd) => {
      if (ctx.renderer) ctx.renderer.invalidate(hwnd);
    },
    move_window: (hwnd, x, y, w, h) => {
      if (!ctx.renderer) return;
      const win = ctx.renderer.windows[hwnd];
      if (!win) return;
      win.x = x; win.y = y;
      win.w = Math.max(0, w); win.h = Math.max(0, h);
      if (!win.isChild) ctx.renderer.scheduleRepaint();
    },
    erase_background: (hwnd, hbrBackground) => {
      // WM_ERASEBKGND default handler: fill client area with WNDCLASS.hbrBackground
      if (!ctx.renderer) return 1;
      const win = ctx.renderer.windows[hwnd];
      if (!win || !win.clientRect) return 1;
      const { x, y, w, h } = win.clientRect;
      if (w <= 0 || h <= 0) return 1;
      const c = ctx.renderer.ctx;
      // Interpret hbrBackground: small values are COLOR_xxx+1, stock object handles, or GDI brush handles
      // COLOR_WINDOW+1 = 6, COLOR_BTNFACE+1 = 16, COLOR_APPWORKSPACE+1 = 13
      // GetStockObject: WHITE_BRUSH=0, LTGRAY_BRUSH=1, GRAY_BRUSH=2, DKGRAY_BRUSH=3, BLACK_BRUSH=4
      // Our GetStockObject returns 0x30002 for everything, so also check that
      let color;
      if (hbrBackground <= 20) {
        // COLOR_xxx + 1 system color index
        const sysColors = {
          1: '#c0c0c0', // COLOR_SCROLLBAR
          2: '#008080', // COLOR_BACKGROUND/DESKTOP
          3: '#000080', // COLOR_ACTIVECAPTION
          4: '#808080', // COLOR_INACTIVECAPTION
          5: '#c0c0c0', // COLOR_MENU
          6: '#ffffff', // COLOR_WINDOW
          7: '#000000', // COLOR_WINDOWFRAME
          8: '#000000', // COLOR_MENUTEXT
          9: '#000000', // COLOR_WINDOWTEXT
          10: '#ffffff', // COLOR_CAPTIONTEXT
          11: '#c0c0c0', // COLOR_ACTIVEBORDER
          12: '#c0c0c0', // COLOR_INACTIVEBORDER
          13: '#808080', // COLOR_APPWORKSPACE
          14: '#000080', // COLOR_HIGHLIGHT
          15: '#ffffff', // COLOR_HIGHLIGHTTEXT
          16: '#c0c0c0', // COLOR_BTNFACE
        };
        color = sysColors[hbrBackground] || '#c0c0c0';
      } else {
        // GDI brush handle — look up color from object table
        const obj = _gdiObjects[hbrBackground];
        if (obj && obj.type === 'brush') {
          const bc = obj.color;
          color = 'rgb(' + (bc & 0xFF) + ',' + ((bc>>8) & 0xFF) + ',' + ((bc>>16) & 0xFF) + ')';
        } else {
          color = '#c0c0c0'; // fallback to btnFace
        }
      }
      c.fillStyle = color;
      c.fillRect(x, y, w, h);
      win.clientPainted = true;
      return 1;
    },
    set_menu: (hwnd, menuResId) => {
      if (ctx.renderer) ctx.renderer.setMenu(hwnd, menuResId);
    },

    // --- Input (override for interactive/test) ---
    check_input: () => 0,
    check_input_lparam: () => 0,
    check_input_hwnd: () => 0,

    // --- Real GDI implementations ---
    gdi_create_pen: (style, width, color) => {
      return _gdiAlloc({ type: 'pen', style, width, color: color & 0xFFFFFF });
    },
    gdi_create_solid_brush: (color) => {
      return _gdiAlloc({ type: 'brush', color: color & 0xFFFFFF });
    },
    gdi_create_compat_dc: (hdcSrc) => {
      const h = _gdiAlloc({ type: 'dc' });
      _dcState[h] = { penColor: 0, penWidth: 1, brushColor: 0xFFFFFF, posX: 0, posY: 0 };
      return h;
    },
    gdi_create_compat_bitmap: (hdc, w, h) => {
      w = w | 0; h = h | 0;
      if (w <= 0) w = 1;
      if (h <= 0) h = 1;
      return _gdiAlloc({ type: 'bitmap', w, h, pixels: new Uint8Array(w * h * 4) });
    },
    gdi_create_bitmap: (w, h, bpp, lpBitsWasm) => {
      w = w | 0; h = h | 0; bpp = bpp | 0;
      if (w <= 0) w = 1;
      if (h <= 0) h = 1;
      const pixels = new Uint8Array(w * h * 4);
      const mem = new Uint8Array(ctx.memory.buffer);
      // Row stride: each row is WORD-aligned (padded to 2-byte boundary)
      const rowBytes = Math.ceil((w * bpp) / 16) * 2;
      // DDB rows are top-down
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const di = (y * w + x) * 4;
          if (bpp === 1) {
            // Monochrome: 1=white, 0=black
            const byteIdx = lpBitsWasm + y * rowBytes + (x >> 3);
            const bit = (mem[byteIdx] >> (7 - (x & 7))) & 1;
            pixels[di] = pixels[di+1] = pixels[di+2] = bit ? 255 : 0;
          } else if (bpp === 4) {
            const byteIdx = lpBitsWasm + y * rowBytes + (x >> 1);
            const nibble = (x & 1) ? (mem[byteIdx] & 0xF) : ((mem[byteIdx] >> 4) & 0xF);
            // Standard 16-color VGA palette
            const pal16 = [0x000000,0x800000,0x008000,0x808000,0x000080,0x800080,0x008080,0xC0C0C0,
                           0x808080,0xFF0000,0x00FF00,0xFFFF00,0x0000FF,0xFF00FF,0x00FFFF,0xFFFFFF];
            const c = pal16[nibble] || 0;
            pixels[di] = c & 0xFF; pixels[di+1] = (c >> 8) & 0xFF; pixels[di+2] = (c >> 16) & 0xFF;
          } else if (bpp === 8) {
            const v = mem[lpBitsWasm + y * rowBytes + x];
            pixels[di] = pixels[di+1] = pixels[di+2] = v;
          } else if (bpp === 24) {
            const si = lpBitsWasm + y * rowBytes + x * 3;
            pixels[di] = mem[si+2]; pixels[di+1] = mem[si+1]; pixels[di+2] = mem[si]; // BGR→RGB
          } else if (bpp === 32) {
            const si = lpBitsWasm + y * rowBytes + x * 4;
            pixels[di] = mem[si+2]; pixels[di+1] = mem[si+1]; pixels[di+2] = mem[si]; // BGR→RGB
          }
          pixels[di+3] = 255;
        }
      }
      return _gdiAlloc({ type: 'bitmap', w, h, pixels });
    },
    gdi_select_object: (hdc, hObj) => {
      const obj = _gdiObjects[hObj];
      const dc = _getDC(hdc);
      let prev = 0x30001;
      if (obj) {
        if (obj.type === 'pen') { prev = dc.selectedPen || 0x30001; dc.selectedPen = hObj; dc.penColor = obj.color; dc.penWidth = obj.width || 1; }
        else if (obj.type === 'brush') { prev = dc.selectedBrush || 0x30001; dc.selectedBrush = hObj; dc.brushColor = obj.color; }
        else if (obj.type === 'bitmap') { prev = dc.selectedBitmap || 0x30001; dc.selectedBitmap = hObj; }
      }
      return prev;
    },
    gdi_delete_object: (h) => { delete _gdiObjects[h]; return 1; },
    gdi_delete_dc: (hdc) => { delete _dcState[hdc]; delete _gdiObjects[hdc]; return 1; },
    gdi_rectangle: (hdc, left, top, right, bottom, hwnd) => {
      const dc = _getDC(hdc);
      const bmpH = dc.selectedBitmap;
      const bmp = bmpH ? _gdiObjects[bmpH] : null;
      if (bmp && bmp.pixels) {
        const bc = dc.brushColor || 0;
        const r = bc & 0xFF, g = (bc >> 8) & 0xFF, b = (bc >> 16) & 0xFF;
        const y0 = Math.max(0, top), y1 = Math.min(bottom, bmp.h);
        const x0 = Math.max(0, left), x1 = Math.min(right, bmp.w);
        for (let y = y0; y < y1; y++) {
          const rowOff = y * bmp.w * 4;
          for (let x = x0; x < x1; x++) {
            const i = rowOff + x * 4;
            bmp.pixels[i] = r; bmp.pixels[i+1] = g; bmp.pixels[i+2] = b; bmp.pixels[i+3] = 255;
          }
        }
        return 1;
      }
      if (!ctx.renderer) return 1;
      const c = ctx.renderer.ctx;
      const o = _getClientOrigin(hwnd);
      const x = o.x + left, y = o.y + top, w = right - left, h = bottom - top;
      const bc = dc.brushColor || 0;
      c.fillStyle = `rgb(${bc & 0xFF},${(bc >> 8) & 0xFF},${(bc >> 16) & 0xFF})`;
      c.fillRect(x, y, w, h);
      const pc = dc.penColor || 0;
      c.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
      c.lineWidth = dc.penWidth || 1;
      c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      return 1;
    },
    gdi_ellipse: (hdc, left, top, right, bottom, hwnd) => {
      if (!ctx.renderer) return 1;
      const c = ctx.renderer.ctx;
      const o = _getClientOrigin(hwnd);
      const dc = _getDC(hdc);
      const cx = o.x + (left + right) / 2, cy = o.y + (top + bottom) / 2;
      const rx = (right - left) / 2, ry = (bottom - top) / 2;
      c.beginPath();
      c.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
      const bc = dc.brushColor;
      c.fillStyle = `rgb(${bc & 0xFF},${(bc >> 8) & 0xFF},${(bc >> 16) & 0xFF})`;
      c.fill();
      const pc = dc.penColor;
      c.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
      c.lineWidth = dc.penWidth;
      c.stroke();
      return 1;
    },
    gdi_move_to: (hdc, x, y) => {
      const dc = _getDC(hdc);
      dc.posX = x; dc.posY = y;
      return 1;
    },
    gdi_line_to: (hdc, x, y, hwnd) => {
      if (!ctx.renderer) return 1;
      const c = ctx.renderer.ctx;
      const o = _getClientOrigin(hwnd);
      const dc = _getDC(hdc);
      const pc = dc.penColor;
      c.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
      c.lineWidth = dc.penWidth;
      c.beginPath();
      c.moveTo(o.x + dc.posX + 0.5, o.y + dc.posY + 0.5);
      c.lineTo(o.x + x + 0.5, o.y + y + 0.5);
      c.stroke();
      dc.posX = x; dc.posY = y;
      return 1;
    },
    gdi_arc: (hdc, left, top, right, bottom, xStart, yStart, xEnd, yEnd, hwnd) => {
      if (!ctx.renderer) return 1;
      const c = ctx.renderer.ctx;
      const o = _getClientOrigin(hwnd);
      const dc = _getDC(hdc);
      const cx = o.x + (left + right) / 2, cy = o.y + (top + bottom) / 2;
      const rx = (right - left) / 2, ry = (bottom - top) / 2;
      const startAngle = Math.atan2(yStart - (top + bottom) / 2, xStart - (left + right) / 2);
      const endAngle = Math.atan2(yEnd - (top + bottom) / 2, xEnd - (left + right) / 2);
      c.beginPath();
      c.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, startAngle, endAngle, true);
      const pc = dc.penColor;
      c.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
      c.lineWidth = dc.penWidth;
      c.stroke();
      return 1;
    },
    gdi_bitblt: (dstDC, dx, dy, w, bh, srcDC, sx, sy, rop, hwnd) => {
      const isSrcWindow = (srcDC === 0x50001);
      const isDstWindow = (dstDC === 0x50001);
      // ROP constants
      const SRCCOPY     = 0x00CC0020;
      const NOTSRCCOPY  = 0x00330008;
      const SRCAND      = 0x008800C6;
      const SRCPAINT    = 0x00EE0086;
      const SRCINVERT   = 0x00660046;
      const BLACKNESS   = 0x00000042;
      const WHITENESS   = 0x00FF0062;

      if (isSrcWindow && isDstWindow) {
        // Window DC → Window DC: screen-to-screen copy (scroll)
        if (!ctx.renderer) return 1;
        const c = ctx.renderer.ctx;
        const o = _getClientOrigin(hwnd);
        const imgData = c.getImageData(o.x + sx, o.y + sy, w, bh);
        c.putImageData(imgData, o.x + dx, o.y + dy);
        return 1;
      }

      if (isSrcWindow) {
        // Window DC → Memory DC: capture screen to bitmap
        const dstState = _getDC(dstDC);
        const dstBmp = dstState.selectedBitmap ? _gdiObjects[dstState.selectedBitmap] : null;
        if (!dstBmp || !dstBmp.pixels) return 1;
        if (!ctx.renderer) return 1;
        const c = ctx.renderer.ctx;
        const o = _getClientOrigin(hwnd);
        const imgData = c.getImageData(o.x + sx, o.y + sy, w, bh);
        for (let row = 0; row < bh; row++) {
          for (let col = 0; col < w; col++) {
            const dX = dx + col, dY = dy + row;
            if (dX < 0 || dX >= dstBmp.w || dY < 0 || dY >= dstBmp.h) continue;
            const si = (row * w + col) * 4;
            const di = (dY * dstBmp.w + dX) * 4;
            dstBmp.pixels[di] = imgData.data[si];
            dstBmp.pixels[di+1] = imgData.data[si+1];
            dstBmp.pixels[di+2] = imgData.data[si+2];
            dstBmp.pixels[di+3] = 255;
          }
        }
        return 1;
      }

      // Source-less ROPs (PatBlt): WHITENESS, BLACKNESS, PATCOPY, DSTINVERT
      const PATCOPY   = 0x00F00021;
      const DSTINVERT = 0x00550009;
      if (rop === WHITENESS || rop === BLACKNESS || rop === PATCOPY || rop === DSTINVERT) {
        let fr = 0, fg = 0, fb = 0;
        if (rop === WHITENESS) { fr = fg = fb = 255; }
        else if (rop === PATCOPY) {
          const dc = _getDC(dstDC);
          const bc = dc.brushColor || 0;
          fr = bc & 0xFF; fg = (bc >> 8) & 0xFF; fb = (bc >> 16) & 0xFF;
        }
        // Destination is a memory DC bitmap
        const dstState = _getDC(dstDC);
        const dstBmp = dstState.selectedBitmap ? _gdiObjects[dstState.selectedBitmap] : null;
        if (dstBmp && dstBmp.pixels) {
          const x0 = Math.max(0, dx), y0 = Math.max(0, dy);
          const x1 = Math.min(dx + w, dstBmp.w), y1 = Math.min(dy + bh, dstBmp.h);
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const di = (y * dstBmp.w + x) * 4;
              if (rop === DSTINVERT) {
                dstBmp.pixels[di] = ~dstBmp.pixels[di] & 0xFF;
                dstBmp.pixels[di+1] = ~dstBmp.pixels[di+1] & 0xFF;
                dstBmp.pixels[di+2] = ~dstBmp.pixels[di+2] & 0xFF;
              } else {
                dstBmp.pixels[di] = fr; dstBmp.pixels[di+1] = fg; dstBmp.pixels[di+2] = fb;
              }
              dstBmp.pixels[di+3] = 255;
            }
          }
          return 1;
        }
        // Destination is window DC
        if (isDstWindow && ctx.renderer) {
          const c = ctx.renderer.ctx;
          const o = _getClientOrigin(hwnd);
          const win = ctx.renderer.windows[hwnd];
          if (win) win.clientPainted = true;
          if (rop === DSTINVERT) {
            const imgData = c.getImageData(o.x + dx, o.y + dy, w, bh);
            for (let i = 0; i < imgData.data.length; i += 4) {
              imgData.data[i] = ~imgData.data[i] & 0xFF;
              imgData.data[i+1] = ~imgData.data[i+1] & 0xFF;
              imgData.data[i+2] = ~imgData.data[i+2] & 0xFF;
              imgData.data[i+3] = 255;
            }
            c.putImageData(imgData, o.x + dx, o.y + dy);
          } else {
            c.fillStyle = `rgb(${fr},${fg},${fb})`;
            c.fillRect(o.x + dx, o.y + dy, w, bh);
          }
        }
        return 1;
      }

      // Source is a memory DC
      const srcState = _getDC(srcDC);
      const srcBmp = srcState.selectedBitmap ? _gdiObjects[srcState.selectedBitmap] : null;
      if (!srcBmp || !srcBmp.pixels) return 1;

      if (isDstWindow) {
        // Memory DC → Window DC: blit to screen (alpha always 255, Win32 has no alpha)
        if (!ctx.renderer) return 1;
        const c = ctx.renderer.ctx;
        const o = _getClientOrigin(hwnd);
        // Mark window as having app-painted content (WM_PAINT done)
        const win = ctx.renderer.windows[hwnd];
        if (win) win.clientPainted = true;
        const imgData = c.createImageData(w, bh);
        for (let row = 0; row < bh; row++) {
          for (let col = 0; col < w; col++) {
            const sX = sx + col, sY = sy + row;
            if (sX < 0 || sX >= srcBmp.w || sY < 0 || sY >= srcBmp.h) continue;
            const si = (sY * srcBmp.w + sX) * 4;
            const di = (row * w + col) * 4;
            imgData.data[di] = srcBmp.pixels[si];
            imgData.data[di+1] = srcBmp.pixels[si+1];
            imgData.data[di+2] = srcBmp.pixels[si+2];
            imgData.data[di+3] = 255;
          }
        }
        c.putImageData(imgData, o.x + dx, o.y + dy);
      } else {
        // Memory DC → Memory DC: apply ROP codes
        const dstState = _getDC(dstDC);
        const dstBmp = dstState.selectedBitmap ? _gdiObjects[dstState.selectedBitmap] : null;
        if (!dstBmp || !dstBmp.pixels) return 1;
        for (let row = 0; row < bh; row++) {
          for (let col = 0; col < w; col++) {
            const sX = sx + col, sY = sy + row;
            const dX = dx + col, dY = dy + row;
            if (sX < 0 || sX >= srcBmp.w || sY < 0 || sY >= srcBmp.h) continue;
            if (dX < 0 || dX >= dstBmp.w || dY < 0 || dY >= dstBmp.h) continue;
            const si = (sY * srcBmp.w + sX) * 4;
            const di = (dY * dstBmp.w + dX) * 4;
            const sr = srcBmp.pixels[si], sg = srcBmp.pixels[si+1], sb = srcBmp.pixels[si+2];
            switch (rop) {
              case NOTSRCCOPY:
                dstBmp.pixels[di] = ~sr & 0xFF;
                dstBmp.pixels[di+1] = ~sg & 0xFF;
                dstBmp.pixels[di+2] = ~sb & 0xFF;
                break;
              case SRCAND:
                dstBmp.pixels[di] &= sr;
                dstBmp.pixels[di+1] &= sg;
                dstBmp.pixels[di+2] &= sb;
                break;
              case SRCPAINT:
                dstBmp.pixels[di] |= sr;
                dstBmp.pixels[di+1] |= sg;
                dstBmp.pixels[di+2] |= sb;
                break;
              case SRCINVERT:
                dstBmp.pixels[di] ^= sr;
                dstBmp.pixels[di+1] ^= sg;
                dstBmp.pixels[di+2] ^= sb;
                break;
              default: // SRCCOPY and others
                dstBmp.pixels[di] = sr;
                dstBmp.pixels[di+1] = sg;
                dstBmp.pixels[di+2] = sb;
                break;
            }
            dstBmp.pixels[di+3] = 255;
          }
        }
      }
      return 1;
    },
    gdi_scroll_window: (hwnd, dx, dy) => {
      if (!ctx.renderer) return 1;
      const o = _getClientOrigin(hwnd);
      const win = ctx.renderer.windows[hwnd];
      if (!win) return 1;
      const cw = win.w - 6;
      const ch = win.h - (o.y - win.y) - 2;
      if (cw <= 0 || ch <= 0) return 1;
      const c = ctx.renderer.ctx;
      const imgData = c.getImageData(o.x, o.y, cw, ch);
      c.clearRect(o.x, o.y, cw, ch);
      c.putImageData(imgData, o.x + dx, o.y + dy);
      return 1;
    },
    gdi_load_bitmap: (resourceId) => {
      if (!ctx.resourceJson || !ctx.resourceJson.bitmaps) return 0;
      const bmp = ctx.resourceJson.bitmaps[resourceId];
      if (!bmp) return 0;
      return _gdiAlloc({ type: 'bitmap', w: bmp.w, h: bmp.h, pixels: new Uint8Array(bmp.pixels) });
    },
    gdi_get_object_w: (hObj) => {
      const obj = _gdiObjects[hObj];
      if (!obj || obj.type !== 'bitmap') return 0;
      return obj.w;
    },
    gdi_get_object_h: (hObj) => {
      const obj = _gdiObjects[hObj];
      if (!obj || obj.type !== 'bitmap') return 0;
      return obj.h;
    },

    // --- DC state setters ---
    gdi_set_text_color: (hdc, color) => {
      const dc = _getDC(hdc);
      const prev = dc.textColor || 0;
      dc.textColor = color & 0xFFFFFF;
      return prev;
    },
    gdi_set_bk_color: (hdc, color) => {
      const dc = _getDC(hdc);
      const prev = dc.bkColor !== undefined ? dc.bkColor : 0xFFFFFF;
      dc.bkColor = color & 0xFFFFFF;
      return prev;
    },
    gdi_set_bk_mode: (hdc, mode) => {
      const dc = _getDC(hdc);
      const prev = dc.bkMode || 2; // OPAQUE=2
      dc.bkMode = mode;
      return prev;
    },

    gdi_text_out: (hdc, x, y, textPtr, nCount, hwnd) => {
      const mem = new Uint8Array(ctx.getMemory());
      let text = '';
      for (let i = 0; i < nCount && mem[textPtr + i]; i++) text += String.fromCharCode(mem[textPtr + i]);
      const dc = _getDC(hdc);
      const textColor = dc.textColor || 0;
      const r = textColor & 0xFF, g = (textColor >> 8) & 0xFF, b = (textColor >> 16) & 0xFF;
      const bkMode = dc.bkMode || 2; // OPAQUE=2, TRANSPARENT=1
      const bkColor = dc.bkColor !== undefined ? dc.bkColor : 0xFFFFFF;
      const charW = 8, charH = 16; // match our GetTextMetricsA stub

      const isDstWindow = (hdc === 0x50001);
      if (isDstWindow) {
        if (!ctx.renderer) return 1;
        const c = ctx.renderer.ctx;
        const o = _getClientOrigin(hwnd);
        const win = ctx.renderer.windows[hwnd];
        if (win) win.clientPainted = true;
        if (bkMode === 2) { // OPAQUE
          const br = bkColor & 0xFF, bg2 = (bkColor >> 8) & 0xFF, bb = (bkColor >> 16) & 0xFF;
          c.fillStyle = `rgb(${br},${bg2},${bb})`;
          c.fillRect(o.x + x, o.y + y, text.length * charW, charH);
        }
        c.fillStyle = `rgb(${r},${g},${b})`;
        c.font = '13px monospace';
        c.textBaseline = 'top';
        c.fillText(text, o.x + x, o.y + y);
        return 1;
      }

      // Memory DC: render text via offscreen canvas, copy pixels into bitmap
      const dstBmp = dc.selectedBitmap ? _gdiObjects[dc.selectedBitmap] : null;
      if (!dstBmp || !dstBmp.pixels) return 1;
      const tw = text.length * charW, th = charH;
      if (tw <= 0) return 1;
      const createCanvas = typeof OffscreenCanvas !== 'undefined'
        ? (w, h) => new OffscreenCanvas(w, h)
        : (w, h) => { const { createCanvas: cc } = require('canvas'); return cc(w, h); };
      const tc = createCanvas(tw, th);
      const tc2 = tc.getContext('2d');
      if (bkMode === 2) { // OPAQUE
        const br = bkColor & 0xFF, bg2 = (bkColor >> 8) & 0xFF, bb = (bkColor >> 16) & 0xFF;
        tc2.fillStyle = `rgb(${br},${bg2},${bb})`;
        tc2.fillRect(0, 0, tw, th);
      }
      tc2.fillStyle = `rgb(${r},${g},${b})`;
      tc2.font = '13px monospace';
      tc2.textBaseline = 'top';
      tc2.fillText(text, 0, 0);
      const imgData = tc2.getImageData(0, 0, tw, th);
      for (let py = 0; py < th; py++) {
        for (let px = 0; px < tw; px++) {
          const dx = x + px, dy = y + py;
          if (dx < 0 || dx >= dstBmp.w || dy < 0 || dy >= dstBmp.h) continue;
          const si = (py * tw + px) * 4;
          const di = (dy * dstBmp.w + dx) * 4;
          const a = imgData.data[si + 3];
          if (a > 0 || bkMode === 2) {
            dstBmp.pixels[di] = imgData.data[si];
            dstBmp.pixels[di+1] = imgData.data[si+1];
            dstBmp.pixels[di+2] = imgData.data[si+2];
            dstBmp.pixels[di+3] = 255;
          }
        }
      }
      return 1;
    },

    // --- Math (FPU transcendentals) ---
    math_sin: Math.sin,
    math_cos: Math.cos,
    math_tan: Math.tan,
    math_atan2: Math.atan2,
  };

  return { host, readStr, gdi: { _gdiObjects, _dcState, _gdiAlloc, _getDC, _getClientOrigin } };
}

if (typeof module !== 'undefined') module.exports = { createHostImports };
