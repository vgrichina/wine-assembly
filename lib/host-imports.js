// Shared host imports for wine-assembly WASM instantiation.
// All runners (host.js, test/run.js, tools/render-png.js) use this.
// Real GDI with canvas backend — works with browser canvas or node-canvas.
//
// Usage:
//   const base = createHostImports({ getMemory, renderer, resourceJson, onExit });
//   base.host.log = (ptr, len) => { ... };  // override as needed
//   const { instance } = await WebAssembly.instantiate(wasm, { host: base.host });

var _mu1 = typeof require !== 'undefined' ? require('./mem-utils') : (typeof window !== 'undefined' && window.memUtils || {});

function createHostImports(ctx) {
  var _readStrA = _mu1.readStrA;
  // ctx.getMemory()    -> ArrayBuffer (late-bound)
  // ctx.renderer       -> Win98Renderer instance (optional; can be getter for late binding)
  // ctx.resourceJson   -> parsed PE resources { menus, dialogs, strings, bitmaps }
  // ctx.onExit(code)   -> called on ExitProcess
  // ctx.trace          -> Set of trace categories: 'gdi', 'msg', etc. (optional)

  const readStr = (ptr, maxLen = 512) => _readStrA(ctx.getMemory(), ptr, maxLen);

  // --- Window property store (GetPropA/SetPropA) ---
  const _windowProps = new Map();

  // --- GDI object state ---
  let _nextGdiHandle = 0x200001;  // above window DC range (hwnd+0x40000, hwnds up to 0x1FFFFF)
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

  // Window DC = hwnd + 0x40000 (from BeginPaint/GetDC in WAT)
  // hwnds: 0x10001+, so window DCs: 0x50001-0x1FFFFF; GDI handles: 0x200001+
  const _isWindowDC = (hdc) => hdc >= 0x50001 && hdc < 0x200000;
  const _hwndFromDC = (hdc) => _isWindowDC(hdc) ? hdc - 0x40000 : 0;

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

  // Resolve the top-level hwnd that owns a given hwnd (for per-window canvas lookup)
  const _resolveTopHwnd = (hwnd) => {
    if (!ctx.renderer) return hwnd;
    const win = ctx.renderer.windows[hwnd];
    if (!win) return hwnd;
    if (win.isChild && win.parentHwnd) return _resolveTopHwnd(win.parentHwnd);
    return hwnd;
  };

  // Get the canvas context + origin for a given DC handle.
  // Window DCs draw into the per-window offscreen canvas at client-relative coords.
  // Memory DCs draw into their bitmap's canvas at (0,0).
  const _getDrawTarget = (hdc, hwnd) => {
    if (_isWindowDC(hdc)) {
      if (!ctx.renderer) return null;
      const resolvedHwnd = _hwndFromDC(hdc) || hwnd;
      let h = resolvedHwnd;
      if (!h) {
        for (const k of Object.keys(ctx.renderer.windows)) {
          const w = ctx.renderer.windows[k];
          if (w && !w.isChild) { h = parseInt(k); break; }
        }
      }
      const win = ctx.renderer.windows[h];
      if (win) win.clientPainted = true;
      // Get per-window offscreen canvas
      const topHwnd = _resolveTopHwnd(h);
      const wc = ctx.renderer.getWindowCanvas(topHwnd);
      if (!wc) return null;
      // Mark window dirty so compositor repaints
      ctx.renderer.scheduleRepaint();
      // For child windows, offset by child position within parent's client area
      const childWin = ctx.renderer.windows[h];
      let ox = 0, oy = 0;
      if (childWin && childWin.isChild) {
        ox = childWin.x;
        oy = childWin.y;
      }
      return { ctx: wc.ctx, ox, oy, hwnd: h, canvas: wc.canvas };
    }
    // Memory DC — find the selected bitmap's canvas
    const dc = _getDC(hdc);
    const bmpH = dc.selectedBitmap;
    const bmp = bmpH ? _gdiObjects[bmpH] : null;
    if (bmp && bmp.canvas) {
      return { ctx: bmp.canvas.getContext('2d'), ox: 0, oy: 0, canvas: bmp.canvas };
    }
    return null;
  };

  // putImageData that respects canvas clip (uses temp canvas + drawImage)
  const _clippedPut = (targetCtx, imgData, x, y) => {
    try {
      const _C = typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas : null;
      const tmp = _C ? new _C(imgData.width, imgData.height)
        : (() => { const c = document.createElement('canvas'); c.width = imgData.width; c.height = imgData.height; return c; })();
      tmp.getContext('2d').putImageData(imgData, 0, 0);
      targetCtx.drawImage(tmp, x, y);
    } catch (_) {
      targetCtx.putImageData(imgData, x, y); // fallback
    }
  };

  // Clip canvas to exclude windows above the given hwnd, run fn, restore
  const _withZClip = (hwnd, fn) => {
    if (!ctx.renderer || !hwnd) return fn();
    const rects = ctx.renderer.getOccludingRects(hwnd);
    if (rects.length === 0) return fn();
    const c = ctx.renderer.ctx;
    c.save();
    c.beginPath();
    c.rect(0, 0, ctx.renderer.canvas.width, ctx.renderer.canvas.height);
    for (const r of rects) {
      c.rect(r.x + r.w, r.y, -r.w, r.h);
    }
    c.clip('evenodd');
    const result = fn();
    c.restore();
    return result;
  };

  // Returns the client origin for screen-space drawing (used by erase_background
  // and other functions that need screen coords for the display canvas).
  const _getClientOriginScreen = (hwnd) => {
    const r = ctx.renderer;
    if (!r) return { x: 0, y: 0 };
    const win = r.windows[hwnd];
    if (!win) return { x: 0, y: 0 };
    if (win.isChild && win.parentHwnd) {
      const parentOrigin = _getClientOriginScreen(win.parentHwnd);
      return { x: parentOrigin.x + win.x, y: parentOrigin.y + win.y };
    }
    let cy = win.y + 3;
    if (win.style & 0x00C00000) cy += 19;
    if (win.menu) cy += 18;
    return { x: win.x + 3, y: cy + 1 };
  };

  // For GDI drawing: top-level windows draw at (0,0) on their offscreen canvas.
  // Child windows offset by their position within the parent's client area.
  const _getClientOrigin = (hwnd) => {
    const r = ctx.renderer;
    if (!r) return { x: 0, y: 0 };
    const win = r.windows[hwnd];
    if (!win) return { x: 0, y: 0 };
    if (win.isChild && win.parentHwnd) {
      return { x: win.x, y: win.y };
    }
    return { x: 0, y: 0 };
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
      console.error('  FATAL: implement this API');
    },

    // --- System ---
    get_screen_size: () => {
      const r = ctx.renderer;
      const w = r ? r.canvas.width : 640;
      const h = r ? r.canvas.height : 480;
      return (w & 0xFFFF) | ((h & 0xFFFF) << 16);
    },
    // Window property store for GetPropA/SetPropA
    get_prop: (hwnd, namePtr) => {
      const name = readStr(namePtr);
      const key = `${hwnd}:${name}`;
      return _windowProps.get(key) || 0;
    },
    set_prop: (hwnd, namePtr, value) => {
      const name = readStr(namePtr);
      const key = `${hwnd}:${name}`;
      _windowProps.set(key, value);
      return 1;
    },
    remove_prop: (hwnd, namePtr) => {
      const name = readStr(namePtr);
      const key = `${hwnd}:${name}`;
      const val = _windowProps.get(key) || 0;
      _windowProps.delete(key);
      return val;
    },
    show_find_dialog: (dlgHwnd, ownerHwnd, frGuestAddr) => {
      console.log(`[FindTextA] hwnd=0x${dlgHwnd.toString(16)} owner=0x${ownerHwnd.toString(16)} fr=0x${frGuestAddr.toString(16)}`);
      const r = typeof ctx.renderer === 'function' ? ctx.renderer() : ctx.renderer;
      if (r && r.showFindDialog) r.showFindDialog(dlgHwnd, ownerHwnd, frGuestAddr);
      return dlgHwnd;
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
    message_beep: (uType) => {
      // Play a system beep using Web Audio API or AudioContext
      if (typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined') {
        try {
          const AC = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
          const audioCtx = new AC();
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          // Map uType to frequency: 0x10=error(200Hz), 0x30=warning(400Hz), 0x40=info(600Hz), default=800Hz
          const freqMap = { 0x10: 200, 0x20: 300, 0x30: 400, 0x40: 600 };
          osc.frequency.value = freqMap[uType] || 800;
          osc.type = 'square';
          gain.gain.value = 0.1;
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start();
          osc.stop(audioCtx.currentTime + 0.15);
        } catch (_) {}
      }
    },
    play_sound: (wasmPtr, length) => {
      // Play WAV data from WASM memory using Web Audio API
      if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return;
      try {
        const AC = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
        if (!ctx._audioCtx) ctx._audioCtx = new AC();
        const audioCtx = ctx._audioCtx;
        // Copy WAV data from WASM memory
        const wavData = new Uint8Array(ctx.getMemory(), wasmPtr, length).slice();
        audioCtx.decodeAudioData(wavData.buffer).then(audioBuffer => {
          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioCtx.destination);
          source.start();
        }).catch(() => {});
      } catch (_) {}
    },
    get_ticks: () => Date.now() & 0x7FFFFFFF,
    yield: (reason) => { /* no-op in CLI — browser host can use this to pause */ },

    resolve_ordinal: (dllNameWA, ordinal) => {
      const dllName = readStr(dllNameWA).toUpperCase();
      const key = dllName + '#' + ordinal;
      // Shell32 ordinal exports (undocumented Win9x APIs)
      const ORDINAL_MAP = {
        'SHELL32.DLL#2': 'SHChangeNotifyRegister',
        'SHELL32.DLL#4': 'SHChangeNotifyDeregister',
        'SHELL32.DLL#60': 'ExitWindowsDialog',
        'SHELL32.DLL#61': 'RunFileDlg',
        'SHELL32.DLL#62': 'PickIconDlg',
        'SHELL32.DLL#63': 'GetFileNameFromBrowse',
        'SHELL32.DLL#71': 'IsLFNDriveA',
        'SHELL32.DLL#152': 'SHGetSpecialFolderLocation',
        'SHELL32.DLL#165': 'SHGetPathFromIDListA',
        'SHELL32.DLL#167': 'SHBrowseForFolderA',
        'SHELL32.DLL#181': 'RegisterShellHook',
        'SHELL32.DLL#184': 'ArrangeWindows',
        'SHELL32.DLL#232': 'SHFileOperationA',
        'SHELL32.DLL#640': 'NTSHChangeNotifyRegister',
        // COMCTL32 ordinal exports (named ones have low ordinals)
        'COMCTL32.DLL#2': 'MenuHelp',
        'COMCTL32.DLL#3': 'ShowHideMenuCtl',
        'COMCTL32.DLL#4': 'GetEffectiveClientRect',
        'COMCTL32.DLL#5': 'DrawStatusTextA',
        'COMCTL32.DLL#6': 'CreateStatusWindowA',
        'COMCTL32.DLL#7': 'CreateToolbar',
        'COMCTL32.DLL#8': 'CreateMappedBitmap',
        'COMCTL32.DLL#17': 'InitCommonControls',
        // COMCTL32 internal heap (ordinal-only)
        'COMCTL32.DLL#71': 'Comctl32_Alloc',
        'COMCTL32.DLL#72': 'Comctl32_ReAlloc',
        'COMCTL32.DLL#73': 'Comctl32_Free',
        'COMCTL32.DLL#74': 'Comctl32_GetSize',
        // COMCTL32 DSA/DPA utility (ordinal-only)
        'COMCTL32.DLL#320': 'DSA_Create',
        'COMCTL32.DLL#321': 'DSA_Destroy',
        'COMCTL32.DLL#322': 'DSA_GetItem',
        'COMCTL32.DLL#323': 'DSA_GetItemPtr',
        'COMCTL32.DLL#324': 'DSA_InsertItem',
        'COMCTL32.DLL#326': 'DSA_DeleteItem',
        'COMCTL32.DLL#328': 'DPA_Create',
        'COMCTL32.DLL#329': 'DPA_Destroy',
        'COMCTL32.DLL#332': 'DPA_GetPtr',
        'COMCTL32.DLL#334': 'DPA_InsertPtr',
        'COMCTL32.DLL#336': 'DPA_DeletePtr',
        'COMCTL32.DLL#337': 'DPA_DeleteAllPtrs',
        // COMCTL32 string utilities (ordinal-only, later in shlwapi)
        'COMCTL32.DLL#350': 'StrChrA',
        'COMCTL32.DLL#357': 'StrToIntA',
        // Named exports at higher ordinals
        'COMCTL32.DLL#84': 'InitCommonControlsEx',
      };
      const name = ORDINAL_MAP[key];
      if (!name) {
        if (ctx.verbose) console.log(`  [ordinal] ${dllName}#${ordinal} -> unknown`);
        return -1;
      }
      // Look up API ID by name hash (FNV-1a)
      const apiTable = ctx.apiTable;
      if (apiTable) {
        const entry = apiTable.find(e => e.name === name);
        if (entry) {
          if (ctx.verbose) console.log(`  [ordinal] ${dllName}#${ordinal} -> ${name} (API #${entry.id})`);
          return entry.id;
        }
      }
      if (ctx.verbose) console.log(`  [ordinal] ${dllName}#${ordinal} -> ${name} (no handler)`);
      return -1;
    },

    read_file: (pathWA, bufWA, maxLen) => {
      const path = readStr(pathWA);
      if (ctx.readFile) {
        const data = ctx.readFile(path);
        if (data && data.length > 0) {
          const len = Math.min(data.length, maxLen);
          new Uint8Array(ctx.getMemory(), bufWA, len).set(data.subarray ? data.subarray(0, len) : data.slice(0, len));
          return len;
        }
      }
      return 0;
    },

    // --- Help system imports ---
    help_open: (pathWA) => {
      // Return cached parser's topic count if already loaded
      if (ctx._helpParser) return ctx._helpParser.topics.length;
      const filePath = readStr(pathWA);
      const HlpParserClass = (typeof HlpParser !== 'undefined') ? HlpParser
        : (typeof require !== 'undefined' ? require('./hlp-parser').HlpParser : null);
      if (!HlpParserClass) return 0;
      // Try sync readFile (works in Node; browser returns null for HLP)
      if (ctx.readFile) {
        const data = ctx.readFile(filePath);
        if (data && data.length > 0) {
          try {
            const parser = new HlpParserClass(data);
            if (parser.parse()) {
              ctx._helpParser = parser;
              return parser.topics.length;
            }
          } catch (e) { return 0; }
        }
      }
      // No sync data — store path for async fetch, return -1 to signal yield
      ctx._helpPendingPath = filePath;
      return -1;
    },
    help_get_topic: (index, destWA, maxLen) => {
      const parser = ctx._helpParser;
      if (!parser) return 0;
      let text;
      if (index === 0) {
        // Contents page: title + numbered list of topics
        let lines = parser.helpTitle || 'Help Topics';
        lines += '\n';
        for (let i = 0; i < parser.topics.length; i++) {
          lines += '\n' + (i + 1) + '. ' + (parser.topics[i].title || '(untitled)');
        }
        text = lines;
      } else if (index > 0 && index <= parser.topics.length) {
        const topic = parser.topics[index - 1];
        text = (topic.title ? topic.title + '\n\n' : '') + topic.text;
      } else {
        return 0;
      }
      const enc = new TextEncoder();
      const encoded = enc.encode(text);
      const len = Math.min(encoded.length, maxLen);
      new Uint8Array(ctx.getMemory(), destWA, len).set(encoded.subarray(0, len));
      new Uint8Array(ctx.getMemory())[destWA + len] = 0; // NUL-terminate
      return len;
    },
    help_get_title: (destWA, maxLen) => {
      const parser = ctx._helpParser;
      if (!parser || !parser.helpTitle) return 0;
      const enc = new TextEncoder();
      const encoded = enc.encode(parser.helpTitle);
      const len = Math.min(encoded.length, maxLen);
      new Uint8Array(ctx.getMemory(), destWA, len).set(encoded.subarray(0, len));
      new Uint8Array(ctx.getMemory())[destWA + len] = 0;
      return len;
    },

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
    create_dialog: (hwnd, dlgId, parentHwnd) => {
      console.log(`[CreateDialog] hwnd=0x${hwnd.toString(16)} dlg=${dlgId} parent=0x${parentHwnd.toString(16)}`);
      if (ctx.renderer) return ctx.renderer.createDialog(hwnd, dlgId, parentHwnd);
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
      if (!ctx._controlText) ctx._controlText = new Map();
      ctx._controlText.set(`${hwnd}:${ctrlId}`, text);
      if (ctx.renderer) ctx.renderer.setDlgItemText(hwnd, ctrlId, text);
    },
    send_ctrl_msg: (ctrlHwnd, msg, wParam, lParam) => {
      if (ctx.renderer) ctx.renderer.sendControlMessage(ctrlHwnd, msg, wParam, lParam);
    },
    richedit_stream: (ctrlHwnd, textPtr) => {
      let text = readStr(textPtr, 65536);
      // Strip RTF if it starts with '{'
      if (text.startsWith('{\\rtf')) {
        text = text.replace(/\{[^{}]*\}/g, '').replace(/\\[a-z]+\d* ?/g, '').replace(/[{}]/g, '').trim();
      }
      console.log(`[RichEdit] hwnd=0x${ctrlHwnd.toString(16)} text=${text.length} chars`);
      if (ctx.renderer) ctx.renderer.setControlText(ctrlHwnd, text);
    },
    check_dlg_button: (hwnd, ctrlId, checkState) => {
      if (!ctx._checkStates) ctx._checkStates = new Map();
      ctx._checkStates.set(`${hwnd}:${ctrlId}`, checkState);
      if (ctx.renderer) ctx.renderer.checkDlgButton(hwnd, ctrlId, checkState);
    },
    is_dlg_button_checked: (hwnd, ctrlId) => {
      if (!ctx._checkStates) return 0;
      return ctx._checkStates.get(`${hwnd}:${ctrlId}`) || 0;
    },
    check_radio_button: (hwnd, firstId, lastId, checkId) => {
      if (ctx.renderer) ctx.renderer.checkRadioButton(hwnd, firstId, lastId, checkId);
    },
    set_window_text: (hwnd, textPtr) => {
      const text = readStr(textPtr);
      if (!ctx._windowText) ctx._windowText = new Map();
      ctx._windowText.set(hwnd, text);
      if (ctx.renderer) ctx.renderer.setWindowText(hwnd, text);
    },
    set_window_class: (hwnd, classPtr) => {
      if (ctx.renderer) ctx.renderer.setWindowClass(hwnd, readStr(classPtr));
    },
    get_dlg_item_text: (hwnd, ctrlId, bufWA, maxLen) => {
      if (!ctx._controlText) return 0;
      const text = ctx._controlText.get(`${hwnd}:${ctrlId}`) || '';
      const bytes = new Uint8Array(ctx.getMemory());
      const len = Math.min(text.length, maxLen - 1);
      for (let i = 0; i < len; i++) bytes[bufWA + i] = text.charCodeAt(i) & 0xFF;
      bytes[bufWA + len] = 0;
      return len;
    },
    get_window_text: (hwnd, bufWA, maxLen) => {
      if (!ctx._windowText) return 0;
      const text = ctx._windowText.get(hwnd) || '';
      const bytes = new Uint8Array(ctx.getMemory());
      const len = Math.min(text.length, maxLen - 1);
      for (let i = 0; i < len; i++) bytes[bufWA + i] = text.charCodeAt(i) & 0xFF;
      bytes[bufWA + len] = 0;
      return len;
    },
    invalidate: (hwnd) => {
      if (ctx.renderer) ctx.renderer.invalidate(hwnd);
    },
    get_window_client_size: (hwnd) => {
      if (!ctx.renderer) return (640 & 0xFFFF) | (480 << 16);
      const win = ctx.renderer.windows[hwnd];
      if (!win) return (640 & 0xFFFF) | (480 << 16);
      if (win.isChild) {
        // Child windows: client = full window area (no chrome)
        return (win.w & 0xFFFF) | (win.h << 16);
      }
      // Top-level: compute from clientRect
      const cr = win.clientRect;
      if (cr) return (cr.w & 0xFFFF) | (cr.h << 16);
      return (win.w & 0xFFFF) | (win.h << 16);
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
      const { w, h } = win.clientRect;
      if (w <= 0 || h <= 0) return 1;
      const topHwnd = _resolveTopHwnd(hwnd);
      const wc = ctx.renderer.getWindowCanvas(topHwnd);
      if (!wc) return 1;
      const c = wc.ctx;
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
      const o = _getClientOrigin(hwnd);
      c.fillRect(o.x, o.y, w, h);
      win.clientPainted = true;
      ctx.renderer.scheduleRepaint();
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
      const isMono = (bpp === 1);
      // NULL bits: create blank bitmap (all black for mono, all black for color)
      if (!lpBitsWasm) {
        const canvas = _createOffscreen(w, h);
        return _gdiAlloc({ type: 'bitmap', w, h, pixels: new Uint8Array(w * h * 4), canvas, mono: isMono });
      }
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
      return _gdiAlloc({ type: 'bitmap', w, h, pixels, canvas, mono: isMono });
    },
    gdi_create_dib_bitmap: (lpbmiWa, lpbInitWa, fdwInit) => {
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      // Read BITMAPINFOHEADER
      const biSize = dv.getInt32(lpbmiWa, true);
      const w = dv.getInt32(lpbmiWa + 4, true);
      let h = dv.getInt32(lpbmiWa + 8, true);
      const bottomUp = h > 0;
      h = Math.abs(h);
      const bpp = dv.getUint16(lpbmiWa + 14, true);
      const clrUsed = dv.getUint32(lpbmiWa + 32, true);
      // Read color table for paletted formats
      const palOffset = lpbmiWa + biSize;
      const numColors = clrUsed || (bpp <= 8 ? (1 << bpp) : 0);
      const palette = [];
      for (let i = 0; i < numColors; i++) {
        const off = palOffset + i * 4;
        palette.push([mem[off + 2], mem[off + 1], mem[off]]); // BGR → RGB
      }
      const pixels = new Uint8Array(w * h * 4);
      if (fdwInit === 4 && lpbInitWa) { // CBM_INIT
        const rowBytes = Math.ceil((w * bpp + 31) / 32) * 4; // DWORD-aligned
        for (let y = 0; y < h; y++) {
          const srcY = bottomUp ? (h - 1 - y) : y;
          for (let x = 0; x < w; x++) {
            const di = (y * w + x) * 4;
            let r = 0, g = 0, b = 0;
            if (bpp === 8) {
              const idx = mem[lpbInitWa + srcY * rowBytes + x];
              if (idx < palette.length) { [r, g, b] = palette[idx]; }
            } else if (bpp === 4) {
              const byteIdx = lpbInitWa + srcY * rowBytes + (x >> 1);
              const nibble = (x & 1) ? (mem[byteIdx] & 0xF) : ((mem[byteIdx] >> 4) & 0xF);
              if (nibble < palette.length) { [r, g, b] = palette[nibble]; }
            } else if (bpp === 1) {
              const byteIdx = lpbInitWa + srcY * rowBytes + (x >> 3);
              const bit = (mem[byteIdx] >> (7 - (x & 7))) & 1;
              if (bit < palette.length) { [r, g, b] = palette[bit]; } else { r = g = b = bit ? 255 : 0; }
            } else if (bpp === 24) {
              const si = lpbInitWa + srcY * rowBytes + x * 3;
              b = mem[si]; g = mem[si+1]; r = mem[si+2];
            } else if (bpp === 32) {
              const si = lpbInitWa + srcY * rowBytes + x * 4;
              b = mem[si]; g = mem[si+1]; r = mem[si+2];
            }
            pixels[di] = r; pixels[di+1] = g; pixels[di+2] = b; pixels[di+3] = 255;
          }
        }
      }
      const canvas = _createOffscreen(w, h);
      if (canvas) {
        const bc = canvas.getContext('2d');
        const imgData = bc.createImageData(w, h);
        imgData.data.set(pixels);
        bc.putImageData(imgData, 0, 0);
      }
      return _gdiAlloc({ type: 'bitmap', w, h, pixels, canvas, mono: (bpp === 1) });
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
    gdi_get_current_object: (hdc, objType) => {
      const dc = _getDC(hdc);
      // OBJ_PEN=1, OBJ_BRUSH=2, OBJ_PAL=5, OBJ_FONT=6, OBJ_BITMAP=7
      if (objType === 1) return dc.selectedPen || 0x30001;
      if (objType === 2) return dc.selectedBrush || 0x30002;
      if (objType === 5) return 0x30005; // default palette
      if (objType === 6) return dc.selectedFont || 0x3001d;
      if (objType === 7) return dc.selectedBitmap || 0x30007;
      return 0;
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
      const srcTarget = _getDrawTarget(srcDC);
      const dstTarget = _getDrawTarget(dstDC);
      const dstHwnd = isDstWindow ? _hwndFromDC(dstDC) : 0;

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
          _clippedPut(c, imgData, dstTarget.ox + dx, dstTarget.oy + dy);
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

      // Check if destination is a monochrome bitmap — color→mono conversion needed
      const dstDCState = !isDstWindow ? _getDC(dstDC) : null;
      const dstBmpObj = dstDCState && dstDCState.selectedBitmap ? _gdiObjects[dstDCState.selectedBitmap] : null;
      const dstIsMono = dstBmpObj && dstBmpObj.mono;

      // SRCCOPY: use getImageData/putImageData to ensure opaque copy (no alpha compositing)
      if (rop === SRCCOPY) {
        const imgData = srcTarget.ctx.getImageData(srcTarget.ox + sx, srcTarget.oy + sy, w, bh);
        if (dstIsMono) {
          // Color→mono conversion: src bg color → white, else → black
          const srcDCState = _getDC(srcDC);
          const bgc = srcDCState.bkColor !== undefined ? srcDCState.bkColor : 0xFFFFFF;
          const bgR = bgc & 0xFF, bgG = (bgc >> 8) & 0xFF, bgB = (bgc >> 16) & 0xFF;
          for (let i = 0; i < imgData.data.length; i += 4) {
            const match = (imgData.data[i] === bgR && imgData.data[i+1] === bgG && imgData.data[i+2] === bgB);
            imgData.data[i] = imgData.data[i+1] = imgData.data[i+2] = match ? 255 : 0;
            imgData.data[i+3] = 255;
          }
        } else {
          // Win32 has no alpha — force all pixels opaque
          for (let i = 3; i < imgData.data.length; i += 4) imgData.data[i] = 255;
        }
        _clippedPut(dstTarget.ctx, imgData, dstTarget.ox + dx, dstTarget.oy + dy);
        return 1;
      }

      // Complex ROPs: pixel-level operation via getImageData
      const srcData = srcTarget.ctx.getImageData(srcTarget.ox + sx, srcTarget.oy + sy, w, bh);
      const dstData = dstTarget.ctx.getImageData(dstTarget.ox + dx, dstTarget.oy + dy, w, bh);
      // For mono destination: get source DC background color for thresholding
      let monoBgR = 255, monoBgG = 255, monoBgB = 255;
      if (dstIsMono) {
        const srcDCState = _getDC(srcDC);
        const bgc = srcDCState.bkColor !== undefined ? srcDCState.bkColor : 0xFFFFFF;
        monoBgR = bgc & 0xFF; monoBgG = (bgc >> 8) & 0xFF; monoBgB = (bgc >> 16) & 0xFF;
      }
      for (let i = 0; i < srcData.data.length; i += 4) {
        let sr = srcData.data[i], sg = srcData.data[i+1], sb = srcData.data[i+2];
        let dr, dg, db;
        switch (rop) {
          case NOTSRCCOPY:
            dr = ~sr & 0xFF; dg = ~sg & 0xFF; db = ~sb & 0xFF; break;
          case SRCAND:
            dr = dstData.data[i] & sr; dg = dstData.data[i+1] & sg; db = dstData.data[i+2] & sb; break;
          case SRCPAINT:
            dr = dstData.data[i] | sr; dg = dstData.data[i+1] | sg; db = dstData.data[i+2] | sb; break;
          case SRCINVERT:
            dr = dstData.data[i] ^ sr; dg = dstData.data[i+1] ^ sg; db = dstData.data[i+2] ^ sb; break;
          default:
            dr = sr; dg = sg; db = sb; break;
        }
        if (dstIsMono) {
          // Color→mono conversion: bg color → white(1), non-bg → black(0)
          // Then apply the ROP (NOT for NOTSRCCOPY)
          const match = (sr === monoBgR && sg === monoBgG && sb === monoBgB);
          // Base mono: bg=white(255), sprite=black(0)
          let mono = match ? 255 : 0;
          if (rop === NOTSRCCOPY) mono = mono ^ 255; // invert
          dr = dg = db = mono;
        }
        dstData.data[i] = dr; dstData.data[i+1] = dg; dstData.data[i+2] = db;
        dstData.data[i+3] = 255;
      }
      _clippedPut(dstTarget.ctx, dstData, dstTarget.ox + dx, dstTarget.oy + dy);
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
      const dstHwnd = isDstWindow ? _hwndFromDC(dstDC) : 0;

      const srcTarget = _getDrawTarget(srcDC);
      const dstTarget = _getDrawTarget(dstDC);

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
          _clippedPut(c, imgData, dstTarget.ox + dx, dstTarget.oy + dy);
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
          _clippedPut(dstTarget.ctx, imgData, dstTarget.ox + dx, dstTarget.oy + dy);
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
        _clippedPut(dstTarget.ctx, dstData, dstTarget.ox + dx, dstTarget.oy + dy);
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
        _clippedPut(dstTarget.ctx, imgData, dstTarget.ox + dx, dstTarget.oy + dy);
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
      _clippedPut(dstTarget.ctx, dstData, dstTarget.ox + dx, dstTarget.oy + dy);
      return 1;
    },
    gdi_scroll_window: (hwnd, dx, dy) => {
      if (!ctx.renderer) return 1;
      const win = ctx.renderer.windows[hwnd];
      if (!win) return 1;
      const topHwnd = _resolveTopHwnd(hwnd);
      const wc = ctx.renderer.getWindowCanvas(topHwnd);
      if (!wc) return 1;
      const cw = wc.canvas.width;
      const ch = wc.canvas.height;
      if (cw <= 0 || ch <= 0) return 1;
      const c = wc.ctx;
      const imgData = c.getImageData(0, 0, cw, ch);
      c.clearRect(0, 0, cw, ch);
      _clippedPut(c, imgData, dx, dy);
      // Fill exposed strips with white to avoid transparent gaps
      c.fillStyle = '#ffffff';
      if (dy > 0) c.fillRect(0, 0, cw, dy);           // top strip
      if (dy < 0) c.fillRect(0, ch + dy, cw, -dy);     // bottom strip
      if (dx > 0) c.fillRect(0, 0, dx, ch);            // left strip
      if (dx < 0) c.fillRect(cw + dx, 0, -dx, ch);    // right strip
      ctx.renderer.scheduleRepaint();
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
      // resourceId > 0xFFFF means it's a guest pointer to a string name
      let lookupId = resourceId;
      if ((resourceId >>> 0) > 0xFFFF) {
        const imageBase = ctx.exports ? ctx.exports.get_image_base() : 0x400000;
        const wasmAddr = _mu1.g2w(resourceId, imageBase);
        const name = _readStrA(ctx.getMemory(), wasmAddr);
        // Search bitmaps by name (case-insensitive)
        const lname = name.toLowerCase();
        for (const [id, bmp] of Object.entries(resources.bitmaps)) {
          if (bmp.name && bmp.name.toLowerCase() === lname) { lookupId = id; break; }
        }
        if (lookupId === resourceId) return 0; // not found
      }
      const bmp = resources.bitmaps[lookupId];
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
        const target = _getDrawTarget(hdc);
        if (!target) return 1;
        const c = target.ctx;
        c.font = font;
        if (bkMode === 2) { // OPAQUE
          const tw = Math.round(c.measureText(text).width);
          const br = bkColor & 0xFF, bg2 = (bkColor >> 8) & 0xFF, bb = (bkColor >> 16) & 0xFF;
          c.fillStyle = `rgb(${br},${bg2},${bb})`;
          c.fillRect(target.ox + x, target.oy + y, tw, fontHeight);
        }
        c.fillStyle = `rgb(${r},${g},${b})`;
        c.textBaseline = 'top';
        c.fillText(text, target.ox + x, target.oy + y);
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

    gdi_draw_text: (hdc, textPtr, nCount, rectWA, uFormat, isWide) => {
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      let text = '';
      if (isWide) {
        if (nCount === -1) {
          for (let i = 0; ; i++) {
            const ch = dv.getUint16(textPtr + i * 2, true);
            if (!ch) break;
            text += String.fromCharCode(ch);
          }
        } else {
          for (let i = 0; i < nCount; i++) text += String.fromCharCode(dv.getUint16(textPtr + i * 2, true));
        }
      } else {
        if (nCount === -1) {
          for (let i = 0; ; i++) {
            const ch = mem[textPtr + i];
            if (!ch) break;
            text += String.fromCharCode(ch);
          }
        } else {
          for (let i = 0; i < nCount; i++) text += String.fromCharCode(mem[textPtr + i]);
        }
      }

      const dc = _getDC(hdc);
      const font = _resolveFont(hdc);
      const fontHeight = parseInt(font.match(/(\d+)px/)?.[1]) || 13;

      const t = _getDrawTarget(hdc, 0);
      if (!t) return fontHeight;
      const c = t.ctx;
      c.font = font;

      // Read rect from guest memory (4 * i32)
      let left = dv.getInt32(rectWA, true);
      let top = dv.getInt32(rectWA + 4, true);
      let right = dv.getInt32(rectWA + 8, true);
      let bottom = dv.getInt32(rectWA + 12, true);

      const tw = Math.round(c.measureText(text).width);
      const th = fontHeight;

      if (uFormat & 0x400) { // DT_CALCRECT
        right = left + tw;
        bottom = top + th;
        dv.setInt32(rectWA + 8, right, true);
        dv.setInt32(rectWA + 12, bottom, true);
        return th;
      }

      let x = left;
      if (uFormat & 0x01) x = left + (right - left - tw) / 2; // DT_CENTER
      else if (uFormat & 0x02) x = right - tw; // DT_RIGHT

      let y = top;
      if (uFormat & 0x20) { // DT_SINGLELINE
        if (uFormat & 0x04) y = top + (bottom - top - th) / 2; // DT_VCENTER
        else if (uFormat & 0x08) y = bottom - th; // DT_BOTTOM
      }

      const textColor = dc.textColor || 0;
      const r = textColor & 0xFF, g = (textColor >> 8) & 0xFF, b = (textColor >> 16) & 0xFF;
      const bkMode = dc.bkMode || 2;
      const bkColor = dc.bkColor !== undefined ? dc.bkColor : 0xFFFFFF;

      if (bkMode === 2) { // OPAQUE
        const br = bkColor & 0xFF, bg2 = (bkColor >> 8) & 0xFF, bb = (bkColor >> 16) & 0xFF;
        c.fillStyle = `rgb(${br},${bg2},${bb})`;
        c.fillRect(t.ox + x, t.oy + y, tw, th);
      }

      c.fillStyle = `rgb(${r},${g},${b})`;
      c.textBaseline = 'top';
      c.fillText(text, t.ox + x, t.oy + y);
      return th;
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
    gdi_get_di_bits: (hdc, hBitmap, startScan, numScans, bitsGA, bmiWA, colorUse) => {
      // GetDIBits: read pixel data from a device-dependent bitmap into a DIB buffer
      const bmp = _gdiObjects[hBitmap];
      if (!bmp || !bmp.canvas) {
        // If lpvBits is NULL (bitsGA=0), just fill in the BITMAPINFOHEADER
        if (!bitsGA && bmiWA) {
          const dv = new DataView(ctx.getMemory());
          // Fill with basic info — caller wants dimensions/format
          dv.setUint32(bmiWA, 40, true);     // biSize
          dv.setInt32(bmiWA + 4, 1, true);   // biWidth
          dv.setInt32(bmiWA + 8, 1, true);   // biHeight
          dv.setUint16(bmiWA + 12, 1, true); // biPlanes
          dv.setUint16(bmiWA + 14, 24, true);// biBitCount
          return 1;
        }
        return 0;
      }
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      const w = bmp.w, h = bmp.h;
      // If lpvBits is NULL, fill BITMAPINFOHEADER with bitmap dimensions
      if (!bitsGA) {
        if (bmiWA) {
          dv.setUint32(bmiWA, 40, true);     // biSize
          dv.setInt32(bmiWA + 4, w, true);   // biWidth
          dv.setInt32(bmiWA + 8, h, true);   // biHeight (positive = bottom-up)
          dv.setUint16(bmiWA + 12, 1, true); // biPlanes
          dv.setUint16(bmiWA + 14, 24, true);// biBitCount
          dv.setUint32(bmiWA + 16, 0, true); // biCompression = BI_RGB
          dv.setUint32(bmiWA + 20, 0, true); // biSizeImage
        }
        return h;
      }
      // Read bitmap pixels from canvas
      const bc = bmp.canvas.getContext('2d');
      const imgData = bc.getImageData(0, 0, w, h);
      const src = imgData.data;
      // Read the requested format from BITMAPINFOHEADER
      const biBitCount = bmiWA ? dv.getUint16(bmiWA + 14, true) : 24;
      const biHeight = bmiWA ? dv.getInt32(bmiWA + 8, true) : h;
      const topDown = biHeight < 0;
      const rowBytes = Math.ceil((w * biBitCount) / 32) * 4;
      const g2w = ctx.g2w || (addr => addr - 0x400000 + 0x12000);
      const dstBase = g2w(bitsGA);
      for (let row = 0; row < numScans; row++) {
        const scanY = startScan + row;
        if (scanY >= h) break;
        // Bottom-up: scan 0 = bottom of image
        const srcY = topDown ? scanY : (h - 1 - scanY);
        const dstOff = dstBase + row * rowBytes;
        for (let x = 0; x < w; x++) {
          const si = (srcY * w + x) * 4;
          const r = src[si], g = src[si + 1], b = src[si + 2];
          if (biBitCount === 24) {
            mem[dstOff + x * 3] = b;
            mem[dstOff + x * 3 + 1] = g;
            mem[dstOff + x * 3 + 2] = r;
          } else if (biBitCount === 32) {
            mem[dstOff + x * 4] = b;
            mem[dstOff + x * 4 + 1] = g;
            mem[dstOff + x * 4 + 2] = r;
            mem[dstOff + x * 4 + 3] = 0;
          } else if (biBitCount === 8) {
            // Quantize to 8-bit (simple grayscale approximation)
            mem[dstOff + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
          }
        }
      }
      return numScans;
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
        // Use drawImage via temp canvas instead of putImageData (respects clip region)
        const _C = typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas : null;
        const tmpCanvas = _C ? new _C(w, h) : (() => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; })();
        const tmpCtx = tmpCanvas.getContext('2d');
        const imgData = tmpCtx.createImageData(w, h);
        imgData.data.set(pixels);
        tmpCtx.putImageData(imgData, 0, 0);
        t.ctx.drawImage(tmpCanvas, t.ox + xDest, t.oy + yDest);
      } catch (_) {}
      return cLines;
    },
    gdi_stretch_dib_bits: (hdc, xDst, yDst, wDst, hDst, xSrc, ySrc, wSrc, hSrc, bitsWA, bmiWA, colorUse, rop) => {
      // StretchDIBits: render DIB rectangle to DC, with optional scaling
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
      // Read palette for indexed color
      const palette = [];
      if (biBitCount <= 8) {
        const numColors = 1 << biBitCount;
        const palOff = bmiWA + biSize;
        if (colorUse === 1) {
          // DIB_PAL_COLORS: color table contains WORD indices into the selected palette
          // Read the selected palette from WASM memory at 0x6040 + pal_idx * 1024 (RGBX entries)
          // Find which palette is selected by scanning palette slots
          let palBase = 0x6040; // default to first palette
          for (let pi = 0; pi < 4; pi++) {
            const handle = dv.getUint32(0x6000 + pi * 8, true);
            const count = dv.getUint32(0x6000 + pi * 8 + 4, true);
            if (count > 0) { palBase = 0x6040 + pi * 1024; break; }
          }
          for (let i = 0; i < numColors; i++) {
            const idx = dv.getUint16(palOff + i * 2, true);
            const r = mem[palBase + idx * 4], g = mem[palBase + idx * 4 + 1], b = mem[palBase + idx * 4 + 2];
            palette.push((r << 16) | (g << 8) | b);
          }
        } else {
          // DIB_RGB_COLORS: color table contains RGBQUAD entries
          for (let i = 0; i < numColors; i++) {
            const b = mem[palOff + i * 4], g = mem[palOff + i * 4 + 1], r = mem[palOff + i * 4 + 2];
            palette.push((r << 16) | (g << 8) | b);
          }
        }
      }
      // Decode source region from DIB into pixel buffer (wSrc × hSrc)
      const sw = Math.abs(wSrc), sh = Math.abs(hSrc);
      const rowBytes = Math.ceil((imgW * biBitCount) / 32) * 4;
      const pixels = new Uint8Array(sw * sh * 4);
      for (let row = 0; row < sh; row++) {
        // Source row in the DIB bitmap data
        const srcRowIdx = topDown ? (ySrc + row) : (imgH - 1 - ySrc - row);
        if (srcRowIdx < 0 || srcRowIdx >= imgH) continue;
        const srcRow = bitsWA + srcRowIdx * rowBytes;
        for (let x = 0; x < sw; x++) {
          const sx = xSrc + x;
          if (sx < 0 || sx >= imgW) continue;
          const di = (row * sw + x) * 4;
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
        let tmpCanvas;
        if (typeof OffscreenCanvas !== 'undefined') {
          tmpCanvas = new OffscreenCanvas(sw, sh);
        } else if (typeof document !== 'undefined') {
          tmpCanvas = document.createElement('canvas');
          tmpCanvas.width = sw; tmpCanvas.height = sh;
        } else {
          // Node.js with node-canvas
          const { createCanvas } = require('canvas');
          tmpCanvas = createCanvas(sw, sh);
        }
        const tmpCtx = tmpCanvas.getContext('2d');
        const imgData = tmpCtx.createImageData(sw, sh);
        imgData.data.set(pixels);
        tmpCtx.putImageData(imgData, 0, 0);
        // Draw with scaling from source size to destination size
        t.ctx.drawImage(tmpCanvas, 0, 0, sw, sh, t.ox + xDst, t.oy + yDst, Math.abs(wDst), Math.abs(hDst));
      } catch (e) { console.warn('StretchDIBits render error:', e); }
      return Math.abs(hDst);
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

    // --- Thread/event stubs (overridden by ThreadManager when active) ---
    create_thread: (startAddr, param, stackSize) => 0,
    exit_thread: (exitCode) => {},
    create_event: (manualReset, initialState) => 0,
    set_event: (handle) => 1,
    reset_event: (handle) => 1,
    wait_single: (handle, timeout) => 0, // WAIT_OBJECT_0 — immediate success
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
    wrap('gdi_create_dib_bitmap', host.gdi_create_dib_bitmap,
      ([bmi,bits,init], r) => `CreateDIBitmap(bmi=${hex(bmi)} bits=${hex(bits)} init=${init}) → ${hex(r)}`);
    wrap('gdi_create_compat_dc', host.gdi_create_compat_dc,
      ([ref], r) => `CreateCompatibleDC(${hex(ref)}) → ${hex(r)}`);
    wrap('gdi_create_compat_bitmap', host.gdi_create_compat_bitmap,
      ([dc,w,h], r) => `CreateCompatibleBitmap(${hex(dc)} ${w}x${h}) → ${hex(r)}`);
    wrap('gdi_select_object', host.gdi_select_object,
      ([dc,obj], r) => `SelectObject(${hex(dc)}, ${hex(obj)}) → ${hex(r)}`);
    wrap('gdi_get_current_object', host.gdi_get_current_object,
      ([dc,t], r) => `GetCurrentObject(${hex(dc)}, type=${t}) → ${hex(r)}`);
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

  // Merge filesystem imports (virtual FS backed by in-memory Map)
  const _createFsImports = (typeof FilesystemImports !== 'undefined' && FilesystemImports.createFilesystemImports)
    || (typeof require !== 'undefined' && (() => { try { return require('./filesystem').createFilesystemImports; } catch (_) { return null; } })());
  if (_createFsImports) {
    const fsHost = _createFsImports(ctx);
    Object.assign(host, fsHost);
  }

  // Z-order clipping no longer needed — each window draws to its own offscreen canvas.
  // The compositor in repaint() handles overlap by blitting back-to-front.

  return { host, readStr, gdi: { _gdiObjects, _dcState, _gdiAlloc, _getDC, _getClientOrigin } };
}

if (typeof module !== 'undefined') module.exports = { createHostImports };
