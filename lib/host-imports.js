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
  // ctx.trace          -> Set of trace categories: 'gdi', 'msg', etc. (optional)

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
    0x3001a: { type: 'font', height: 16, weight: 400, italic: 0, face: 'monospace', css: '13px monospace' }, // OEM_FIXED_FONT (10)
    0x3001b: { type: 'font', height: 16, weight: 400, italic: 0, face: 'monospace', css: '13px monospace' }, // ANSI_FIXED_FONT (11)
    0x3001c: { type: 'font', height: 16, weight: 400, italic: 0, face: 'sans-serif', css: '13px sans-serif' }, // ANSI_VAR_FONT (12)
    0x3001d: { type: 'font', height: 16, weight: 400, italic: 0, face: 'sans-serif', css: '13px sans-serif' }, // SYSTEM_FONT (13)
    0x3001e: { type: 'font', height: 16, weight: 400, italic: 0, face: 'sans-serif', css: '13px sans-serif' }, // DEVICE_DEFAULT_FONT (14)
    0x3001f: { type: 'null' },                      // DEFAULT_PALETTE (15)
    0x30020: { type: 'font', height: 16, weight: 400, italic: 0, face: 'monospace', css: '13px monospace' }, // SYSTEM_FIXED_FONT (16)
    0x30021: { type: 'font', height: 16, weight: 400, italic: 0, face: 'sans-serif', css: '13px sans-serif' }, // DEFAULT_GUI_FONT (17)
    0x30002: { type: 'brush', color: 0xFFFFFF },    // legacy default
  };
  const _dcState = {};

  const _isWindowDC = (hdc) => hdc >= 0x40000 && hdc < 0x60000;
  const _hwndFromDC = (hdc) => hdc >= 0x50000 ? hdc - 0x40000 : 0;

  const _gdiAlloc = (obj) => { const h = _nextGdiHandle++; _gdiObjects[h] = obj; return h; };
  const _getDC = (hdc) => {
    if (!_dcState[hdc]) _dcState[hdc] = { penColor: 0x000000, penWidth: 1, brushColor: 0xC0C0C0, textColor: 0x000000, bkColor: 0xFFFFFF, bkMode: 2, posX: 0, posY: 0, selectedFont: 0 };
    return _dcState[hdc];
  };

  // Resolve the CSS font string for a DC's currently selected font
  const _resolveFont = (hdc) => {
    const dc = _getDC(hdc);
    if (dc.selectedFont) {
      const font = _gdiObjects[dc.selectedFont];
      if (font && font.css) return font.css;
    }
    return '13px monospace'; // system default
  };

  // Build CSS font string from LOGFONT-like properties
  const _buildCssFont = (height, weight, italic, face) => {
    const sz = Math.max(8, Math.abs(height) || 13);
    const parts = [];
    if (italic) parts.push('italic');
    if (weight >= 700) parts.push('bold');
    parts.push(sz + 'px');
    // Map Win32 face names to CSS
    const faceMap = { 'ms sans serif': 'sans-serif', 'ms serif': 'serif', 'fixedsys': 'monospace',
      'courier': 'monospace', 'courier new': 'monospace', 'terminal': 'monospace',
      'system': 'sans-serif', 'arial': 'Arial, sans-serif', 'times new roman': 'Times New Roman, serif',
      'tahoma': 'Tahoma, sans-serif', 'verdana': 'Verdana, sans-serif' };
    const lower = (face || '').toLowerCase();
    parts.push(faceMap[lower] || face || 'sans-serif');
    return parts.join(' ');
  };

  // Create an offscreen canvas (works in browser and Node with node-canvas)
  const _createOffscreen = (w, h) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    try { const { createCanvas: cc } = require('canvas'); return cc(w, h); }
    catch (e) { return null; }
  };

  // Get the canvas context + origin for a given DC handle.
  // Memory DCs draw into their bitmap's canvas at (0,0).
  // Window DC (hdc in [0x40000, 0x60000)) draws to the renderer canvas with client offset.
  const _getDrawTarget = (hdc, hwnd) => {
    if (_isWindowDC(hdc)) {
      if (!ctx.renderer) return null;
      const resolvedHwnd = _hwndFromDC(hdc) || hwnd;
      // If still no hwnd, find the main window
      let h = resolvedHwnd;
      if (!h) {
        for (const k of Object.keys(ctx.renderer.windows)) {
          const w = ctx.renderer.windows[k];
          if (w && !w.isChild) { h = parseInt(k); break; }
        }
      }
      const o = _getClientOrigin(h);
      const win = ctx.renderer.windows[h];
      if (win) win.clientPainted = true;
      return { ctx: ctx.renderer.ctx, ox: o.x, oy: o.y };
    }
    // Memory DC — find the selected bitmap's canvas
    const dc = _getDC(hdc);
    const bmpH = dc.selectedBitmap;
    const bmp = bmpH ? _gdiObjects[bmpH] : null;
    if (bmp && bmp.canvas) {
      return { ctx: bmp.canvas.getContext('2d'), ox: 0, oy: 0 };
    }
    return null;
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
    // Must match renderer.js drawWindow: y+3, +19 for caption, +18 for menu, +1
    let cy = win.y + 3;
    if (win.style & 0x00C00000) cy += 19;
    if (win.menu) cy += 18;
    return { x: win.x + 3, y: cy + 1 };
  };

  const host = {
    // --- Logging (override for tracing/UI) ---
    log: () => {},
    log_i32: () => {},

    // --- Crash/debug ---
    crash_unimplemented: (namePtr, esp, eip, ebp) => {
      const name = readStr(namePtr, 128);
      const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
      console.error(`\n=== UNIMPLEMENTED API: ${name || '(null/ordinal)'} ===`);
      console.error(`  EIP: ${hex(eip)}  ESP: ${hex(esp)}  EBP: ${hex(ebp)}`);
      if (ctx.exports) {
        const e = ctx.exports;
        console.error(`  EAX: ${hex(e.get_eax())}  ECX: ${hex(e.get_ecx())}  EDX: ${hex(e.get_edx())}  EBX: ${hex(e.get_ebx())}`);
        console.error(`  ESI: ${hex(e.get_esi())}  EDI: ${hex(e.get_edi())}`);
        const imageBase = e.get_image_base();
        const g2w = addr => addr - imageBase + 0x12000;
        const dv = new DataView(e.memory.buffer);
        console.error('  Stack:');
        for (let i = 0; i < 16; i++) {
          const addr = esp + i * 4;
          const val = dv.getUint32(g2w(addr), true);
          console.error(`    [${hex(addr)}] = ${hex(val)}${i === 0 ? '  <- ret addr' : ''}`);
        }
      }
      console.error('  FATAL: implement this API or add a stub with correct stack cleanup');
    },

    // --- System ---
    get_screen_size: () => {
      const r = ctx.renderer;
      const w = r ? r.canvas.width : 640;
      const h = r ? r.canvas.height : 480;
      return (w & 0xFFFF) | ((h & 0xFFFF) << 16);
    },
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
    load_icon: (hInstance, resourceId) => {
      return 0x50000 | (resourceId & 0xFFFF);
    },
    load_cursor: (hInstance, resourceId) => {
      return 0x60000 | (resourceId & 0xFFFF);
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
      } else if (hbrBackground >= 0x30010 && hbrBackground <= 0x30015) {
        // Stock brush handles from GetStockObject (0x30010 + index)
        const stockColors = {
          0x30010: '#ffffff', // WHITE_BRUSH
          0x30011: '#c0c0c0', // LTGRAY_BRUSH
          0x30012: '#808080', // GRAY_BRUSH
          0x30013: '#404040', // DKGRAY_BRUSH
          0x30014: '#000000', // BLACK_BRUSH
          0x30015: null,      // NULL_BRUSH (no fill)
        };
        color = stockColors[hbrBackground];
        if (color === null) return 1; // NULL_BRUSH: don't erase
        if (color === undefined) color = '#c0c0c0';
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
      const canvas = _createOffscreen(w, h);
      return _gdiAlloc({ type: 'bitmap', w, h, pixels: new Uint8Array(w * h * 4), canvas });
    },
    gdi_create_bitmap: (w, h, bpp, lpBitsWasm) => {
      w = w | 0; h = h | 0; bpp = bpp | 0;
      if (w <= 0) w = 1;
      if (h <= 0) h = 1;
      const pixels = new Uint8Array(w * h * 4);
      const mem = new Uint8Array(ctx.getMemory());
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
            pixels[di] = (c >> 16) & 0xFF; pixels[di+1] = (c >> 8) & 0xFF; pixels[di+2] = c & 0xFF;
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
      const canvas = _createOffscreen(w, h);
      if (canvas) {
        const bc = canvas.getContext('2d');
        const imgData = bc.createImageData(w, h);
        imgData.data.set(pixels);
        bc.putImageData(imgData, 0, 0);
      }
      return _gdiAlloc({ type: 'bitmap', w, h, pixels, canvas });
    },
    gdi_select_object: (hdc, hObj) => {
      const obj = _gdiObjects[hObj];
      const dc = _getDC(hdc);
      let prev = 0x30001;
      if (obj) {
        if (obj.type === 'pen') { prev = dc.selectedPen || 0x30001; dc.selectedPen = hObj; dc.penColor = obj.color; dc.penWidth = obj.width || 1; }
        else if (obj.type === 'brush') { prev = dc.selectedBrush || 0x30001; dc.selectedBrush = hObj; dc.brushColor = obj.color; }
        else if (obj.type === 'bitmap') { prev = dc.selectedBitmap || 0x30001; dc.selectedBitmap = hObj; }
        else if (obj.type === 'font') { prev = dc.selectedFont || 0x3001d; dc.selectedFont = hObj; }
      }
      return prev;
    },
    gdi_delete_object: (h) => { delete _gdiObjects[h]; return 1; },
    gdi_delete_dc: (hdc) => { delete _dcState[hdc]; delete _gdiObjects[hdc]; return 1; },
    gdi_fill_rect: (hdc, left, top, right, bottom, hbrush) => {
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      const c = t.ctx;
      const x = t.ox + left, y = t.oy + top, w = right - left, h = bottom - top;
      // Resolve brush handle to color
      let bc;
      if (hbrush >= 0x30010 && hbrush <= 0x30015) {
        // Stock brush
        const stockColors = { 0x30010: 0xFFFFFF, 0x30011: 0xC0C0C0, 0x30012: 0x808080, 0x30013: 0x404040, 0x30014: 0x000000 };
        bc = stockColors[hbrush];
        if (bc === undefined) return 1; // NULL_BRUSH
      } else if (hbrush <= 20) {
        // System color brush (COLOR_xxx + 1)
        const sysRGB = { 6: 0xFFFFFF, 16: 0xC0C0C0, 5: 0xC0C0C0, 2: 0x808000 };
        bc = sysRGB[hbrush] || 0xC0C0C0;
      } else {
        const obj = _gdiObjects[hbrush];
        bc = (obj && obj.type === 'brush') ? obj.color : 0;
      }
      c.fillStyle = `rgb(${bc & 0xFF},${(bc >> 8) & 0xFF},${(bc >> 16) & 0xFF})`;
      c.fillRect(x, y, w, h);
      return 1;
    },
    gdi_rectangle: (hdc, left, top, right, bottom) => {
      const dc = _getDC(hdc);
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      const c = t.ctx;
      const x = t.ox + left, y = t.oy + top, w = right - left, h = bottom - top;
      const bc = dc.brushColor || 0;
      c.fillStyle = `rgb(${bc & 0xFF},${(bc >> 8) & 0xFF},${(bc >> 16) & 0xFF})`;
      c.fillRect(x, y, w, h);
      const pc = dc.penColor || 0;
      c.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
      c.lineWidth = dc.penWidth || 1;
      c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      return 1;
    },
    gdi_ellipse: (hdc, left, top, right, bottom) => {
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      const c = t.ctx;
      const dc = _getDC(hdc);
      const cx = t.ox + (left + right) / 2, cy = t.oy + (top + bottom) / 2;
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
    gdi_line_to: (hdc, x, y) => {
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      const c = t.ctx;
      const dc = _getDC(hdc);
      const pc = dc.penColor;
      c.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
      c.lineWidth = dc.penWidth;
      c.beginPath();
      c.moveTo(t.ox + dc.posX + 0.5, t.oy + dc.posY + 0.5);
      c.lineTo(t.ox + x + 0.5, t.oy + y + 0.5);
      c.stroke();
      dc.posX = x; dc.posY = y;
      return 1;
    },
    gdi_arc: (hdc, left, top, right, bottom, xStart, yStart, xEnd, yEnd) => {
      const t = _getDrawTarget(hdc);
      if (!t) return 1;
      const c = t.ctx;
      const dc = _getDC(hdc);
      const cx = t.ox + (left + right) / 2, cy = t.oy + (top + bottom) / 2;
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
    gdi_bitblt: (dstDC, dx, dy, w, bh, srcDC, sx, sy, rop) => {
      const isSrcWindow = _isWindowDC(srcDC);
      const isDstWindow = _isWindowDC(dstDC);
      // ROP constants
      const SRCCOPY     = 0x00CC0020;
      const NOTSRCCOPY  = 0x00330008;
      const SRCAND      = 0x008800C6;
      const SRCPAINT    = 0x00EE0086;
      const SRCINVERT   = 0x00660046;
      const BLACKNESS   = 0x00000042;
      const WHITENESS   = 0x00FF0062;
      const PATCOPY     = 0x00F00021;
      const DSTINVERT   = 0x00550009;

      // Resolve source and destination canvases + offsets
      const srcHwnd = isSrcWindow ? _hwndFromDC(srcDC) : 0;
      const dstHwnd = isDstWindow ? _hwndFromDC(dstDC) : 0;
      const srcTarget = isSrcWindow
        ? (ctx.renderer ? { ctx: ctx.renderer.ctx, ox: _getClientOrigin(srcHwnd).x, oy: _getClientOrigin(srcHwnd).y, canvas: ctx.renderer.canvas } : null)
        : (() => { const dc = _getDC(srcDC); const bmp = dc.selectedBitmap ? _gdiObjects[dc.selectedBitmap] : null;
            return bmp && bmp.canvas ? { ctx: bmp.canvas.getContext('2d'), ox: 0, oy: 0, canvas: bmp.canvas } : null; })();
      const dstTarget = isDstWindow
        ? (ctx.renderer ? (() => { const o = _getClientOrigin(dstHwnd); const win = ctx.renderer.windows[dstHwnd];
            if (win) win.clientPainted = true;
            return { ctx: ctx.renderer.ctx, ox: o.x, oy: o.y, canvas: ctx.renderer.canvas }; })() : null)
        : (() => { const dc = _getDC(dstDC); const bmp = dc.selectedBitmap ? _gdiObjects[dc.selectedBitmap] : null;
            return bmp && bmp.canvas ? { ctx: bmp.canvas.getContext('2d'), ox: 0, oy: 0, canvas: bmp.canvas } : null; })();

      // Clip to client rect when drawing to a window DC
      if (isDstWindow && ctx.renderer) {
        const win = ctx.renderer.windows[dstHwnd];
        if (win && win.clientRect) {
          const cr = win.clientRect;
          // Clip left
          if (dx < 0) { sx -= dx; w += dx; dx = 0; }
          // Clip top
          if (dy < 0) { sy -= dy; bh += dy; dy = 0; }
          // Clip right
          if (dx + w > cr.w) { w = cr.w - dx; }
          // Clip bottom
          if (dy + bh > cr.h) { bh = cr.h - dy; }
          // Fully clipped
          if (w <= 0 || bh <= 0) return 1;
        }
      }

      // Source-less ROPs: WHITENESS, BLACKNESS, PATCOPY, DSTINVERT
      if (rop === WHITENESS || rop === BLACKNESS || rop === PATCOPY || rop === DSTINVERT) {
        if (!dstTarget) return 1;
        const c = dstTarget.ctx;
        if (rop === DSTINVERT) {
          const imgData = c.getImageData(dstTarget.ox + dx, dstTarget.oy + dy, w, bh);
          for (let i = 0; i < imgData.data.length; i += 4) {
            imgData.data[i] = ~imgData.data[i] & 0xFF;
            imgData.data[i+1] = ~imgData.data[i+1] & 0xFF;
            imgData.data[i+2] = ~imgData.data[i+2] & 0xFF;
            imgData.data[i+3] = 255;
          }
          c.putImageData(imgData, dstTarget.ox + dx, dstTarget.oy + dy);
        } else {
          let fr = 0, fg = 0, fb = 0;
          if (rop === WHITENESS) { fr = fg = fb = 255; }
          else if (rop === PATCOPY) {
            const dc = _getDC(dstDC);
            const bc = dc.brushColor || 0;
            fr = bc & 0xFF; fg = (bc >> 8) & 0xFF; fb = (bc >> 16) & 0xFF;
          }
          c.fillStyle = `rgb(${fr},${fg},${fb})`;
          c.fillRect(dstTarget.ox + dx, dstTarget.oy + dy, w, bh);
        }
        return 1;
      }

      if (!srcTarget || !dstTarget) return 1;

      // SRCCOPY: use getImageData/putImageData to ensure opaque copy (no alpha compositing)
      if (rop === SRCCOPY) {
        const imgData = srcTarget.ctx.getImageData(srcTarget.ox + sx, srcTarget.oy + sy, w, bh);
        // Win32 has no alpha — force all pixels opaque
        for (let i = 3; i < imgData.data.length; i += 4) imgData.data[i] = 255;
        dstTarget.ctx.putImageData(imgData, dstTarget.ox + dx, dstTarget.oy + dy);
        return 1;
      }

      // Complex ROPs: pixel-level operation via getImageData
      const srcData = srcTarget.ctx.getImageData(srcTarget.ox + sx, srcTarget.oy + sy, w, bh);
      const dstData = dstTarget.ctx.getImageData(dstTarget.ox + dx, dstTarget.oy + dy, w, bh);
      for (let i = 0; i < srcData.data.length; i += 4) {
        const sr = srcData.data[i], sg = srcData.data[i+1], sb = srcData.data[i+2];
        switch (rop) {
          case NOTSRCCOPY:
            dstData.data[i] = ~sr & 0xFF; dstData.data[i+1] = ~sg & 0xFF; dstData.data[i+2] = ~sb & 0xFF; break;
          case SRCAND:
            dstData.data[i] &= sr; dstData.data[i+1] &= sg; dstData.data[i+2] &= sb; break;
          case SRCPAINT:
            dstData.data[i] |= sr; dstData.data[i+1] |= sg; dstData.data[i+2] |= sb; break;
          case SRCINVERT:
            dstData.data[i] ^= sr; dstData.data[i+1] ^= sg; dstData.data[i+2] ^= sb; break;
          default:
            dstData.data[i] = sr; dstData.data[i+1] = sg; dstData.data[i+2] = sb; break;
        }
        dstData.data[i+3] = 255;
      }
      dstTarget.ctx.putImageData(dstData, dstTarget.ox + dx, dstTarget.oy + dy);
      return 1;
    },
    gdi_stretch_blt: (dstDC, dx, dy, dw, dh, srcDC, sx, sy, sw, sh, rop) => {
      const SRCCOPY     = 0x00CC0020;
      const NOTSRCCOPY  = 0x00330008;
      const SRCAND      = 0x008800C6;
      const SRCPAINT    = 0x00EE0086;
      const SRCINVERT   = 0x00660046;
      const BLACKNESS   = 0x00000042;
      const WHITENESS   = 0x00FF0062;
      const DSTINVERT   = 0x00550009;

      const isSrcWindow = _isWindowDC(srcDC);
      const isDstWindow = _isWindowDC(dstDC);
      const srcHwnd = isSrcWindow ? _hwndFromDC(srcDC) : 0;
      const dstHwnd = isDstWindow ? _hwndFromDC(dstDC) : 0;

      const srcTarget = isSrcWindow
        ? (ctx.renderer ? { ctx: ctx.renderer.ctx, ox: _getClientOrigin(srcHwnd).x, oy: _getClientOrigin(srcHwnd).y, canvas: ctx.renderer.canvas } : null)
        : (() => { const dc = _getDC(srcDC); const bmp = dc.selectedBitmap ? _gdiObjects[dc.selectedBitmap] : null;
            return bmp && bmp.canvas ? { ctx: bmp.canvas.getContext('2d'), ox: 0, oy: 0, canvas: bmp.canvas } : null; })();
      const dstTarget = isDstWindow
        ? (ctx.renderer ? (() => { const o = _getClientOrigin(dstHwnd); const win = ctx.renderer.windows[dstHwnd];
            if (win) win.clientPainted = true;
            return { ctx: ctx.renderer.ctx, ox: o.x, oy: o.y, canvas: ctx.renderer.canvas }; })() : null)
        : (() => { const dc = _getDC(dstDC); const bmp = dc.selectedBitmap ? _gdiObjects[dc.selectedBitmap] : null;
            return bmp && bmp.canvas ? { ctx: bmp.canvas.getContext('2d'), ox: 0, oy: 0, canvas: bmp.canvas } : null; })();

      // Source-less ROPs
      if (rop === WHITENESS || rop === BLACKNESS || rop === DSTINVERT) {
        if (!dstTarget) return 1;
        const c = dstTarget.ctx;
        if (rop === DSTINVERT) {
          const imgData = c.getImageData(dstTarget.ox + dx, dstTarget.oy + dy, dw, dh);
          for (let i = 0; i < imgData.data.length; i += 4) {
            imgData.data[i] = ~imgData.data[i] & 0xFF;
            imgData.data[i+1] = ~imgData.data[i+1] & 0xFF;
            imgData.data[i+2] = ~imgData.data[i+2] & 0xFF;
            imgData.data[i+3] = 255;
          }
          c.putImageData(imgData, dstTarget.ox + dx, dstTarget.oy + dy);
        } else {
          c.fillStyle = rop === WHITENESS ? '#ffffff' : '#000000';
          c.fillRect(dstTarget.ox + dx, dstTarget.oy + dy, dw, dh);
        }
        return 1;
      }

      if (!srcTarget || !dstTarget) return 1;

      // When src and dst sizes match, use getImageData for pixel-perfect copy
      if (sw === dw && sh === dh) {
        if (rop === SRCCOPY) {
          const imgData = srcTarget.ctx.getImageData(srcTarget.ox + sx, srcTarget.oy + sy, sw, sh);
          for (let i = 3; i < imgData.data.length; i += 4) imgData.data[i] = 255;
          dstTarget.ctx.putImageData(imgData, dstTarget.ox + dx, dstTarget.oy + dy);
          return 1;
        }
        // Complex ROPs at 1:1
        const srcData = srcTarget.ctx.getImageData(srcTarget.ox + sx, srcTarget.oy + sy, sw, sh);
        const dstData = dstTarget.ctx.getImageData(dstTarget.ox + dx, dstTarget.oy + dy, dw, dh);
        for (let i = 0; i < srcData.data.length; i += 4) {
          const sr = srcData.data[i], sg = srcData.data[i+1], sb = srcData.data[i+2];
          switch (rop) {
            case NOTSRCCOPY: dstData.data[i]=~sr&0xFF; dstData.data[i+1]=~sg&0xFF; dstData.data[i+2]=~sb&0xFF; break;
            case SRCAND: dstData.data[i]&=sr; dstData.data[i+1]&=sg; dstData.data[i+2]&=sb; break;
            case SRCPAINT: dstData.data[i]|=sr; dstData.data[i+1]|=sg; dstData.data[i+2]|=sb; break;
            case SRCINVERT: dstData.data[i]^=sr; dstData.data[i+1]^=sg; dstData.data[i+2]^=sb; break;
            default: dstData.data[i]=sr; dstData.data[i+1]=sg; dstData.data[i+2]=sb; break;
          }
          dstData.data[i+3] = 255;
        }
        dstTarget.ctx.putImageData(dstData, dstTarget.ox + dx, dstTarget.oy + dy);
        return 1;
      }

      // Scaled blit: scale source to temp canvas, then apply ROP
      const tmp = _createOffscreen(dw, dh);
      if (!tmp) return 1;
      const tc = tmp.getContext('2d');
      tc.drawImage(srcTarget.canvas, srcTarget.ox + sx, srcTarget.oy + sy, sw, sh, 0, 0, dw, dh);

      if (rop === SRCCOPY) {
        const imgData = tc.getImageData(0, 0, dw, dh);
        for (let i = 3; i < imgData.data.length; i += 4) imgData.data[i] = 255;
        dstTarget.ctx.putImageData(imgData, dstTarget.ox + dx, dstTarget.oy + dy);
        return 1;
      }

      // Scaled complex ROPs
      const srcData = tc.getImageData(0, 0, dw, dh);
      const dstData = dstTarget.ctx.getImageData(dstTarget.ox + dx, dstTarget.oy + dy, dw, dh);
      for (let i = 0; i < srcData.data.length; i += 4) {
        const sr = srcData.data[i], sg = srcData.data[i+1], sb = srcData.data[i+2];
        switch (rop) {
          case NOTSRCCOPY: dstData.data[i]=~sr&0xFF; dstData.data[i+1]=~sg&0xFF; dstData.data[i+2]=~sb&0xFF; break;
          case SRCAND: dstData.data[i]&=sr; dstData.data[i+1]&=sg; dstData.data[i+2]&=sb; break;
          case SRCPAINT: dstData.data[i]|=sr; dstData.data[i+1]|=sg; dstData.data[i+2]|=sb; break;
          case SRCINVERT: dstData.data[i]^=sr; dstData.data[i+1]^=sg; dstData.data[i+2]^=sb; break;
          default: dstData.data[i]=sr; dstData.data[i+1]=sg; dstData.data[i+2]=sb; break;
        }
        dstData.data[i+3] = 255;
      }
      dstTarget.ctx.putImageData(dstData, dstTarget.ox + dx, dstTarget.oy + dy);
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
      // Fill exposed strips with white to avoid transparent gaps
      c.fillStyle = '#ffffff';
      if (dy > 0) c.fillRect(o.x, o.y, cw, dy);           // top strip
      if (dy < 0) c.fillRect(o.x, o.y + ch + dy, cw, -dy); // bottom strip
      if (dx > 0) c.fillRect(o.x, o.y, dx, ch);            // left strip
      if (dx < 0) c.fillRect(o.x + cw + dx, o.y, -dx, ch); // right strip
      return 1;
    },
    gdi_load_bitmap: (hInstance, resourceId) => {
      // Look up resources for the given module (EXE or DLL)
      let resources = ctx.resourceJson;
      if (ctx.dllResources) {
        if (ctx.dllResources[hInstance]) {
          resources = ctx.dllResources[hInstance];
        } else {
          // Debug: log mismatched hInstance
          console.log(`LoadBitmap: hInstance=0x${(hInstance>>>0).toString(16)} resId=${resourceId} (known: ${Object.keys(ctx.dllResources).map(k => '0x'+(k>>>0).toString(16)).join(',')})`);
        }
      }
      if (!resources || !resources.bitmaps) return 0;
      const bmp = resources.bitmaps[resourceId];
      if (!bmp) return 0;
      const pixels = new Uint8Array(bmp.pixels);
      const canvas = _createOffscreen(bmp.w, bmp.h);
      if (canvas) {
        const bc = canvas.getContext('2d');
        const imgData = bc.createImageData(bmp.w, bmp.h);
        imgData.data.set(pixels);
        bc.putImageData(imgData, 0, 0);
      }
      return _gdiAlloc({ type: 'bitmap', w: bmp.w, h: bmp.h, pixels, canvas });
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

    gdi_text_out: (hdc, x, y, textPtr, nCount) => {
      const mem = new Uint8Array(ctx.getMemory());
      let text = '';
      for (let i = 0; i < nCount && mem[textPtr + i]; i++) text += String.fromCharCode(mem[textPtr + i]);
      const dc = _getDC(hdc);
      const textColor = dc.textColor || 0;
      const r = textColor & 0xFF, g = (textColor >> 8) & 0xFF, b = (textColor >> 16) & 0xFF;
      const bkMode = dc.bkMode || 2; // OPAQUE=2, TRANSPARENT=1
      const bkColor = dc.bkColor !== undefined ? dc.bkColor : 0xFFFFFF;
      const font = _resolveFont(hdc);
      // Parse height from CSS font string for background rect
      const fontHeight = parseInt(font.match(/(\d+)px/)?.[1]) || 13;

      const isDstWindow = _isWindowDC(hdc);
      if (isDstWindow) {
        if (!ctx.renderer) return 1;
        const c = ctx.renderer.ctx;
        const hwnd = _hwndFromDC(hdc);
        const o = _getClientOrigin(hwnd);
        const win = ctx.renderer.windows[hwnd];
        if (win) win.clientPainted = true;
        c.font = font;
        if (bkMode === 2) { // OPAQUE
          const tw = Math.round(c.measureText(text).width);
          const br = bkColor & 0xFF, bg2 = (bkColor >> 8) & 0xFF, bb = (bkColor >> 16) & 0xFF;
          c.fillStyle = `rgb(${br},${bg2},${bb})`;
          c.fillRect(o.x + x, o.y + y, tw, fontHeight);
        }
        c.fillStyle = `rgb(${r},${g},${b})`;
        c.textBaseline = 'top';
        c.fillText(text, o.x + x, o.y + y);
        return 1;
      }

      // Memory DC: draw text directly into bitmap's canvas
      const dstBmp = dc.selectedBitmap ? _gdiObjects[dc.selectedBitmap] : null;
      if (!dstBmp || !dstBmp.canvas) return 1;
      const bc = dstBmp.canvas.getContext('2d');
      bc.font = font;
      if (bkMode === 2) { // OPAQUE
        const tw = Math.round(bc.measureText(text).width);
        const br = bkColor & 0xFF, bg2 = (bkColor >> 8) & 0xFF, bb = (bkColor >> 16) & 0xFF;
        bc.fillStyle = `rgb(${br},${bg2},${bb})`;
        bc.fillRect(x, y, tw, fontHeight);
      }
      bc.fillStyle = `rgb(${r},${g},${b})`;
      bc.textBaseline = 'top';
      bc.fillText(text, x, y);
      return 1;
    },

    gdi_get_pixel: (hdc, x, y) => {
      const t = _getDrawTarget(hdc, 0);
      if (!t) return 0xFFFFFFFF; // CLR_INVALID
      try {
        const data = t.ctx.getImageData(t.ox + x, t.oy + y, 1, 1).data;
        return data[0] | (data[1] << 8) | (data[2] << 16);
      } catch (_) { return 0; }
    },
    gdi_set_pixel: (hdc, x, y, color) => {
      const r = color & 0xFF, g = (color >> 8) & 0xFF, b = (color >> 16) & 0xFF;
      const t = _getDrawTarget(hdc, 0);
      if (!t) return color;
      t.ctx.fillStyle = `rgb(${r},${g},${b})`;
      t.ctx.fillRect(t.ox + x, t.oy + y, 1, 1);
      return color;
    },
    gdi_set_dib_bits: (hdc, hBitmap, startScan, numScans, bitsWA, bmiWA, colorUse) => {
      // SetDIBits: copy DIB pixel data into a device-dependent bitmap
      const bmp = _gdiObjects[hBitmap];
      if (!bmp || !bmp.canvas) return 0;
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      // Read BITMAPINFOHEADER
      const biSize = dv.getUint32(bmiWA, true);
      const biWidth = dv.getInt32(bmiWA + 4, true);
      const biHeight = dv.getInt32(bmiWA + 8, true);
      const biBitCount = dv.getUint16(bmiWA + 14, true);
      const biCompression = dv.getUint32(bmiWA + 16, true);
      const w = Math.abs(biWidth), h = Math.abs(biHeight);
      const topDown = biHeight < 0;
      // Read color table for indexed formats
      const palette = [];
      if (biBitCount <= 8) {
        const numColors = 1 << biBitCount;
        const palOff = bmiWA + biSize;
        for (let i = 0; i < numColors; i++) {
          const b = mem[palOff + i * 4], g = mem[palOff + i * 4 + 1], r = mem[palOff + i * 4 + 2];
          palette.push((r << 16) | (g << 8) | b);
        }
      }
      // Decode pixels
      const rowBytes = Math.ceil((w * biBitCount) / 32) * 4; // DWORD-aligned
      const pixels = new Uint8Array(w * numScans * 4);
      for (let row = 0; row < numScans; row++) {
        const srcRow = bitsWA + row * rowBytes;
        // DIB is bottom-up by default; row 0 in bits = bottom of image
        const destY = topDown ? (startScan + row) : (h - 1 - startScan - row);
        if (destY < 0 || destY >= bmp.h) continue;
        for (let x = 0; x < w && x < bmp.w; x++) {
          const di = (row * w + x) * 4;
          let r = 0, g = 0, b = 0;
          if (biBitCount === 1) {
            const bit = (mem[srcRow + (x >> 3)] >> (7 - (x & 7))) & 1;
            const c = palette[bit] || (bit ? 0xFFFFFF : 0);
            r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
          } else if (biBitCount === 4) {
            const nibble = (x & 1) ? (mem[srcRow + (x >> 1)] & 0xF) : ((mem[srcRow + (x >> 1)] >> 4) & 0xF);
            const c = palette[nibble] || 0;
            r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
          } else if (biBitCount === 8) {
            const c = palette[mem[srcRow + x]] || 0;
            r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
          } else if (biBitCount === 24) {
            const si = srcRow + x * 3;
            b = mem[si]; g = mem[si + 1]; r = mem[si + 2];
          } else if (biBitCount === 32) {
            const si = srcRow + x * 4;
            b = mem[si]; g = mem[si + 1]; r = mem[si + 2];
          }
          pixels[di] = r; pixels[di + 1] = g; pixels[di + 2] = b; pixels[di + 3] = 255;
        }
      }
      // Write to bitmap canvas
      const bc = bmp.canvas.getContext('2d');
      const imgData = bc.createImageData(w, numScans);
      imgData.data.set(pixels);
      // Place at correct Y position — for bottom-up DIB, row 0 of bits maps to bottom
      const putY = topDown ? startScan : Math.max(0, h - startScan - numScans);
      bc.putImageData(imgData, 0, putY);
      return numScans;
    },
    gdi_set_dib_to_device: (hdc, xDest, yDest, w, h, xSrc, ySrc, startScan, cLines, bitsWA, bmiWA, colorUse) => {
      // SetDIBitsToDevice: draw DIB rectangle directly to DC
      const t = _getDrawTarget(hdc, 0);
      if (!t) return 0;
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      const biWidth = dv.getInt32(bmiWA + 4, true);
      const biHeight = dv.getInt32(bmiWA + 8, true);
      const biBitCount = dv.getUint16(bmiWA + 14, true);
      const biSize = dv.getUint32(bmiWA, true);
      const imgW = Math.abs(biWidth), imgH = Math.abs(biHeight);
      const topDown = biHeight < 0;
      // Read palette
      const palette = [];
      if (biBitCount <= 8) {
        const numColors = 1 << biBitCount;
        const palOff = bmiWA + biSize;
        for (let i = 0; i < numColors; i++) {
          const b = mem[palOff + i * 4], g = mem[palOff + i * 4 + 1], r = mem[palOff + i * 4 + 2];
          palette.push((r << 16) | (g << 8) | b);
        }
      }
      const rowBytes = Math.ceil((imgW * biBitCount) / 32) * 4;
      const pixels = new Uint8Array(w * h * 4);
      for (let row = 0; row < cLines && row < h; row++) {
        const srcRow = bitsWA + (startScan + row) * rowBytes;
        const destRow = topDown ? row : (h - 1 - row);
        for (let x = 0; x < w; x++) {
          const sx = xSrc + x;
          if (sx < 0 || sx >= imgW) continue;
          const di = (destRow * w + x) * 4;
          let r = 0, g = 0, b = 0;
          if (biBitCount === 1) {
            const bit = (mem[srcRow + (sx >> 3)] >> (7 - (sx & 7))) & 1;
            const c = palette[bit] || (bit ? 0xFFFFFF : 0);
            r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
          } else if (biBitCount === 4) {
            const nibble = (sx & 1) ? (mem[srcRow + (sx >> 1)] & 0xF) : ((mem[srcRow + (sx >> 1)] >> 4) & 0xF);
            const c = palette[nibble] || 0;
            r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
          } else if (biBitCount === 8) {
            const c = palette[mem[srcRow + sx]] || 0;
            r = (c >> 16) & 0xFF; g = (c >> 8) & 0xFF; b = c & 0xFF;
          } else if (biBitCount === 24) {
            const si = srcRow + sx * 3;
            b = mem[si]; g = mem[si + 1]; r = mem[si + 2];
          } else if (biBitCount === 32) {
            const si = srcRow + sx * 4;
            b = mem[si]; g = mem[si + 1]; r = mem[si + 2];
          }
          pixels[di] = r; pixels[di + 1] = g; pixels[di + 2] = b; pixels[di + 3] = 255;
        }
      }
      try {
        const imgData = t.ctx.createImageData(w, h);
        imgData.data.set(pixels);
        t.ctx.putImageData(imgData, t.ox + xDest, t.oy + yDest);
      } catch (_) {}
      return cLines;
    },
    gdi_frame_rect: (hdc, left, top, right, bottom, hbrush, hwnd) => {
      const t = _getDrawTarget(hdc, hwnd);
      if (!t) return 1;
      const c = t.ctx;
      // Resolve brush color
      let color = '#000000';
      const brObj = _gdiObjects[hbrush];
      if (brObj && brObj.color !== undefined) {
        const cr = brObj.color & 0xFF, cg = (brObj.color >> 8) & 0xFF, cb = (brObj.color >> 16) & 0xFF;
        color = `rgb(${cr},${cg},${cb})`;
      }
      const ox = t.ox, oy = t.oy;
      c.fillStyle = color;
      // Draw 1px frame
      c.fillRect(ox + left, oy + top, right - left, 1);           // top
      c.fillRect(ox + left, oy + bottom - 1, right - left, 1);    // bottom
      c.fillRect(ox + left, oy + top, 1, bottom - top);           // left
      c.fillRect(ox + right - 1, oy + top, 1, bottom - top);     // right
      return 1;
    },

    // --- Font support ---
    create_font: (height, weight, italic, facePtr) => {
      const face = facePtr ? readStr(facePtr, 64) : '';
      const css = _buildCssFont(height, weight, italic, face);
      return _gdiAlloc({ type: 'font', height: Math.abs(height) || 16, weight, italic, face, css });
    },
    measure_text: (hdc, textPtr, nCount) => {
      const mem = new Uint8Array(ctx.getMemory());
      let text = '';
      for (let i = 0; i < nCount && mem[textPtr + i]; i++) text += String.fromCharCode(mem[textPtr + i]);
      const font = _resolveFont(hdc);
      let c;
      if (ctx.renderer) {
        c = ctx.renderer.ctx;
      } else {
        // Node/headless: approximate
        const sz = parseInt(font.match(/(\d+)px/)?.[1]) || 13;
        return text.length * Math.round(sz * 0.6);
      }
      c.font = font;
      return Math.round(c.measureText(text).width);
    },
    get_text_metrics: (hdc) => {
      // Returns packed: (height | (aveCharWidth << 16))
      const font = _resolveFont(hdc);
      const height = parseInt(font.match(/(\d+)px/)?.[1]) || 13;
      let aveW = Math.round(height * 0.6); // reasonable default
      if (ctx.renderer) {
        const c = ctx.renderer.ctx;
        c.font = font;
        aveW = Math.round(c.measureText('x').width);
      }
      return (height & 0xFFFF) | ((aveW & 0xFFFF) << 16);
    },

    // --- Math (FPU transcendentals) ---
    math_sin: Math.sin,
    math_cos: Math.cos,
    math_tan: Math.tan,
    math_atan2: Math.atan2,
  };

  // --- Tracing wrapper ---
  // Wraps host functions to log calls when a trace category is enabled.
  // Categories: 'gdi' (CreateBitmap, BitBlt, SelectObject, etc.)
  const trace = ctx.trace || new Set();

  if (trace.has('gdi')) {
    const hex = v => '0x' + (v >>> 0).toString(16);
    const ropNames = {
      0x00CC0020: 'SRCCOPY', 0x00330008: 'NOTSRCCOPY', 0x008800C6: 'SRCAND',
      0x00EE0086: 'SRCPAINT', 0x00660046: 'SRCINVERT',
      0x00000042: 'BLACKNESS', 0x00FF0062: 'WHITENESS',
      0x00F00021: 'PATCOPY', 0x00550009: 'DSTINVERT',
    };
    const wrap = (name, fn, fmt) => {
      host[name] = (...args) => {
        const r = fn(...args);
        console.log(`[gdi] ${fmt(args, r)}`);
        return r;
      };
    };
    wrap('gdi_create_bitmap', host.gdi_create_bitmap,
      ([w,h,bpp,p], r) => `CreateBitmap(${w}x${h} ${bpp}bpp bits=${hex(p)}) → ${hex(r)}`);
    wrap('gdi_create_compat_dc', host.gdi_create_compat_dc,
      ([ref], r) => `CreateCompatibleDC(${hex(ref)}) → ${hex(r)}`);
    wrap('gdi_create_compat_bitmap', host.gdi_create_compat_bitmap,
      ([dc,w,h], r) => `CreateCompatibleBitmap(${hex(dc)} ${w}x${h}) → ${hex(r)}`);
    wrap('gdi_select_object', host.gdi_select_object,
      ([dc,obj], r) => `SelectObject(${hex(dc)}, ${hex(obj)}) → ${hex(r)}`);
    wrap('gdi_bitblt', host.gdi_bitblt,
      ([ddc,dx,dy,w,h,sdc,sx,sy,rop], r) =>
        `BitBlt(dst=${hex(ddc)}(${dx},${dy}) ${w}x${h} ← src=${hex(sdc)}(${sx},${sy}) ${ropNames[rop]||hex(rop)}) → ${r}`);
    if (host.gdi_patblt) wrap('gdi_patblt', host.gdi_patblt,
      ([dc,x,y,w,h,rop], r) => `PatBlt(${hex(dc)} (${x},${y}) ${w}x${h} ${ropNames[rop]||hex(rop)}) → ${r}`);
    wrap('gdi_fill_rect', host.gdi_fill_rect,
      ([dc,l,t,r2,b,br], r) => `FillRect(${hex(dc)} (${l},${t})-(${r2},${b}) brush=${hex(br)}) → ${r}`);
    wrap('gdi_delete_object', host.gdi_delete_object,
      ([h], r) => `DeleteObject(${hex(h)}) → ${r}`);
    wrap('gdi_delete_dc', host.gdi_delete_dc,
      ([h], r) => `DeleteDC(${hex(h)}) → ${r}`);
    wrap('gdi_load_bitmap', host.gdi_load_bitmap,
      ([id], r) => `LoadBitmap(resId=${id}) → ${hex(r)}`);
    if (host.gdi_get_object) {
      wrap('gdi_get_object', host.gdi_get_object,
        ([h,sz,buf], r) => `GetObject(${hex(h)}, ${sz}, ${hex(buf)}) → ${r}`);
    }
  }

  // Merge storage imports (registry + INI files backed by localStorage)
  const _createStorageImports = (typeof StorageImports !== 'undefined' && StorageImports.createStorageImports)
    || (typeof require !== 'undefined' && (() => { try { return require('./storage').createStorageImports; } catch (_) { return null; } })());
  if (_createStorageImports) {
    const storageHost = _createStorageImports(ctx);
    Object.assign(host, storageHost);
  }

  return { host, readStr, gdi: { _gdiObjects, _dcState, _gdiAlloc, _getDC, _getClientOrigin } };
}

if (typeof module !== 'undefined') module.exports = { createHostImports };
