// Shared host imports for wine-assembly WASM instantiation.
// All three runners (host.js, test/run.js, tools/render-png.js) use this as a base.
//
// Usage:
//   const { createHostImports } = require('../lib/host-imports');
//   const base = createHostImports({ getMemory, renderer, resourceJson, onExit });
//   // Override specific functions as needed:
//   base.host.log = (ptr, len) => { ... };
//   const { instance } = await WebAssembly.instantiate(wasm, { host: base.host });

function createHostImports(ctx) {
  // ctx.getMemory()    -> ArrayBuffer (late-bound, since instance doesn't exist at creation time)
  // ctx.renderer       -> Win98Renderer instance (optional, null for headless)
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

    // --- GDI stubs (override in host.js for real implementations) ---
    gdi_create_pen: () => 0x80001,
    gdi_create_solid_brush: () => 0x80002,
    gdi_create_compat_dc: () => 0x50003,
    gdi_create_compat_bitmap: () => 0x80003,
    gdi_select_object: () => 0x30001,
    gdi_delete_object: () => 1,
    gdi_delete_dc: () => 1,
    gdi_rectangle: () => 1,
    gdi_ellipse: () => 1,
    gdi_move_to: () => 1,
    gdi_line_to: () => 1,
    gdi_arc: () => 1,
    gdi_bitblt: () => 1,
    gdi_scroll_window: () => 1,
    gdi_load_bitmap: () => 0,
    gdi_get_object_w: () => 0,
    gdi_get_object_h: () => 0,

    // --- Math (FPU transcendentals) ---
    math_sin: Math.sin,
    math_cos: Math.cos,
    math_tan: Math.tan,
    math_atan2: Math.atan2,
  };

  return { host, readStr };
}

if (typeof module !== 'undefined') module.exports = { createHostImports };
