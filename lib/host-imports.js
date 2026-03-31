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
    0x30002: { type: 'brush', color: 0xFFFFFF },
  };
  const _dcState = {};

  const _gdiAlloc = (obj) => { const h = _nextGdiHandle++; _gdiObjects[h] = obj; return h; };
  const _getDC = (hdc) => {
    if (!_dcState[hdc]) _dcState[hdc] = { penColor: 0x000000, penWidth: 1, brushColor: 0xC0C0C0, posX: 0, posY: 0 };
    return _dcState[hdc];
  };
  const _getClientOrigin = (hwnd) => {
    const r = ctx.renderer;
    if (!r) return { x: 0, y: 0 };
    const win = r.windows[hwnd];
    if (!win) return { x: 0, y: 0 };
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
            dstBmp.pixels[di+3] = imgData.data[si+3];
          }
        }
        return 1;
      }

      // Source is a memory DC
      const srcState = _getDC(srcDC);
      const srcBmp = srcState.selectedBitmap ? _gdiObjects[srcState.selectedBitmap] : null;
      if (!srcBmp || !srcBmp.pixels) return 1;

      if (isDstWindow) {
        // Memory DC → Window DC: blit to screen
        if (!ctx.renderer) return 1;
        const c = ctx.renderer.ctx;
        const o = _getClientOrigin(hwnd);
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
            imgData.data[di+3] = srcBmp.pixels[si+3];
          }
        }
        c.putImageData(imgData, o.x + dx, o.y + dy);
      } else {
        // Memory DC → Memory DC
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
            dstBmp.pixels[di] = srcBmp.pixels[si];
            dstBmp.pixels[di+1] = srcBmp.pixels[si+1];
            dstBmp.pixels[di+2] = srcBmp.pixels[si+2];
            dstBmp.pixels[di+3] = srcBmp.pixels[si+3];
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

    // --- Math (FPU transcendentals) ---
    math_sin: Math.sin,
    math_cos: Math.cos,
    math_tan: Math.tan,
    math_atan2: Math.atan2,
  };

  return { host, readStr, gdi: { _gdiObjects, _dcState, _gdiAlloc, _getDC, _getClientOrigin } };
}

if (typeof module !== 'undefined') module.exports = { createHostImports };
