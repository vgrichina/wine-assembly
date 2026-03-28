// Wine-Assembly: JS host for the WASM x86 interpreter
// Win98Renderer is loaded from lib/renderer.js (included via <script> in index.html)

class WineAssembly {
  constructor() {
    this.instance = null;
    this.memory = null;
    this.running = false;
    this.renderer = null;
    this.resourceJson = null;
    this.verbose = false;
    // GDI state
    this._nextGdiHandle = 0x80001;
    this._gdiObjects = {}; // handle -> {type, color, width, ...}
    this._dcState = {};    // hdc -> {penColor, penWidth, brushColor, posX, posY}
  }

  _gdiAlloc(obj) {
    const h = this._nextGdiHandle++;
    this._gdiObjects[h] = obj;
    return h;
  }

  _getDC(hdc) {
    if (!this._dcState[hdc]) {
      this._dcState[hdc] = { penColor: 0x000000, penWidth: 1, brushColor: 0xC0C0C0, posX: 0, posY: 0 };
    }
    return this._dcState[hdc];
  }

  _getClientOrigin(hwnd) {
    if (!this.renderer) return { x: 0, y: 0 };
    // Find the window and compute client area origin
    const win = this.renderer.windows[hwnd];
    if (!win) return { x: 0, y: 0 };
    let cy = win.y + 2; // border
    const hasCaption = !!(win.style & 0x00C00000);
    if (hasCaption) cy += 20; // titlebar height approx
    if (win.menu) cy += 20; // menubar height approx
    return { x: win.x + 3, y: cy + 1 };
  }

  readString(ptr) {
    const bytes = new Uint8Array(this.memory.buffer);
    let str = '';
    for (let i = ptr; bytes[i] !== 0 && i < ptr + 1024; i++) {
      str += String.fromCharCode(bytes[i]);
    }
    return str;
  }

  getImports() {
    const self = this;
    return {
      host: {
        log: (ptr, len) => {
          if (self.verbose) {
            const bytes = new Uint8Array(self.memory.buffer, ptr, len);
            const text = new TextDecoder().decode(bytes);
            console.log('[wine-asm]', text);
            self.logToUI('[wine-asm] ' + text);
          }
        },

        log_i32: (val) => {
          if (self.verbose) {
            console.log('[wine-asm] i32:', '0x' + (val >>> 0).toString(16));
            self.logToUI('[wine-asm] i32: 0x' + (val >>> 0).toString(16));
          }
        },

        shell_about: (hWnd, szAppPtr) => {
          const appName = self.readString(szAppPtr);
          const versionInfo = self._getVersionInfo();
          let text = appName;
          if (versionInfo.FileVersion) text += '\nVersion ' + versionInfo.FileVersion;
          if (versionInfo.LegalCopyright) text += '\n' + versionInfo.LegalCopyright;
          console.log(`[ShellAbout] "${appName}"`);
          self.logToUI(`[ShellAbout] ${appName}`);
          if (self.renderer) {
            self.renderer.showAboutDialog(hWnd, appName, versionInfo);
          } else {
            alert(text);
          }
          return 1;
        },

        message_box: (hWnd, textPtr, captionPtr, uType) => {
          const text = self.readString(textPtr);
          const caption = self.readString(captionPtr);
          console.log(`[MessageBox] "${caption}": "${text}"`);
          self.logToUI(`[MessageBox] ${caption}: ${text}`);
          alert(`${caption}\n\n${text}`);
          return 1;
        },

        exit: (code) => {
          console.log('[ExitProcess] code:', code);
          self.logToUI('[ExitProcess] code: ' + code);
          self.logToUI('--- Program exited ---');
          self.running = false;
          if (self.renderer) {
            self.renderer._exited = true;
            self.renderer.windows = {};
            self.renderer.repaint();
          }
        },

        draw_rect: (x, y, w, h, color) => {
          if (!self.renderer) return;
          const ctx = self.renderer.ctx;
          ctx.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
          ctx.fillRect(x, y, w, h);
        },

        read_file: (namePtr, bufPtr, bufSize) => {
          return 0;
        },

        // --- GUI host imports ---

        create_window: (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
          const title = self.readString(titlePtr);
          console.log(`[CreateWindow] hwnd=0x${hwnd.toString(16)} title="${title}" menu=${menuId} pos=${x},${y} size=${cx}x${cy}`);
          self.logToUI(`[CreateWindow] "${title}"`);
          if (self.renderer) {
            self.renderer.createWindow(hwnd, style, x, y, cx, cy, title, menuId);
          }
          return hwnd;
        },

        show_window: (hwnd, cmd) => {
          console.log(`[ShowWindow] hwnd=0x${hwnd.toString(16)} cmd=${cmd}`);
          if (self.renderer) {
            self.renderer.showWindow(hwnd, cmd);
          }
        },

        create_dialog: (hwnd, dlgId) => {
          console.log(`[CreateDialog] hwnd=0x${hwnd.toString(16)} dlgId=${dlgId}`);
          self.logToUI(`[CreateDialog] template=${dlgId}`);
          if (self.renderer) {
            return self.renderer.createDialog(hwnd, dlgId);
          }
          return hwnd;
        },

        load_string: (stringId, bufPtr, bufLen) => {
          if (!self.resourceJson || !self.resourceJson.strings) return 0;
          const str = self.resourceJson.strings[stringId];
          if (!str || bufLen <= 0) return 0;
          const bytes = new Uint8Array(self.memory.buffer);
          const maxLen = Math.min(str.length, bufLen - 1);
          for (let i = 0; i < maxLen; i++) {
            bytes[bufPtr + i] = str.charCodeAt(i) & 0xFF;
          }
          bytes[bufPtr + maxLen] = 0;
          return maxLen;
        },

        set_dlg_item_text: (hwnd, ctrlId, textPtr) => {
          const text = self.readString(textPtr);
          if (self.renderer) {
            self.renderer.setDlgItemText(hwnd, ctrlId, text);
          }
        },

        check_dlg_button: (hwnd, ctrlId, checkState) => {
          if (self.renderer) self.renderer.checkDlgButton(hwnd, ctrlId, checkState);
        },
        check_radio_button: (hwnd, firstId, lastId, checkId) => {
          if (self.renderer) self.renderer.checkRadioButton(hwnd, firstId, lastId, checkId);
        },

        set_window_text: (hwnd, textPtr) => {
          const text = self.readString(textPtr);
          console.log(`[SetWindowText] hwnd=0x${hwnd.toString(16)} "${text}"`);
          if (self.renderer) {
            self.renderer.setWindowText(hwnd, text);
          }
        },

        set_window_class: (hwnd, classPtr) => {
          if (self.renderer) {
            const className = self.readString(classPtr);
            self.renderer.setWindowClass(hwnd, className);
          }
        },

        invalidate: (hwnd) => {
          if (self.renderer) {
            self.renderer.invalidate(hwnd);
          }
        },

        set_menu: (hwnd, menuResId) => {
          console.log(`[SetMenu] hwnd=0x${hwnd.toString(16)} menuRes=${menuResId}`);
          if (self.renderer) {
            self.renderer.setMenu(hwnd, menuResId);
          }
        },

        draw_text: (x, y, textPtr, textLen, color) => {
          if (!self.renderer) return;
          const bytes = new Uint8Array(self.memory.buffer, textPtr, textLen);
          const text = new TextDecoder().decode(bytes);
          const ctx = self.renderer.ctx;
          ctx.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
          ctx.font = self.renderer.font;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(text, x, y);
        },

        // --- GDI host imports ---
        gdi_create_pen: (style, width, color) => {
          return self._gdiAlloc({ type: 'pen', style, width, color: color & 0xFFFFFF });
        },
        gdi_create_solid_brush: (color) => {
          return self._gdiAlloc({ type: 'brush', color: color & 0xFFFFFF });
        },
        gdi_create_compat_dc: (hdcSrc) => {
          const h = self._gdiAlloc({ type: 'dc' });
          self._dcState[h] = { penColor: 0, penWidth: 1, brushColor: 0xFFFFFF, posX: 0, posY: 0 };
          return h;
        },
        gdi_create_compat_bitmap: (hdc, w, h) => {
          const pixels = new Uint8Array(w * h * 4);
          return self._gdiAlloc({ type: 'bitmap', w, h, pixels });
        },
        gdi_select_object: (hdc, hObj) => {
          const obj = self._gdiObjects[hObj];
          const dc = self._getDC(hdc);
          let prev = 0x30001; // generic previous handle
          if (obj) {
            if (obj.type === 'pen') { dc.penColor = obj.color; dc.penWidth = obj.width || 1; }
            if (obj.type === 'brush') { dc.brushColor = obj.color; }
            if (obj.type === 'bitmap') { prev = dc.selectedBitmap || 0x30001; dc.selectedBitmap = hObj; }
          }
          return prev;
        },
        gdi_delete_object: (h) => {
          delete self._gdiObjects[h];
          return 1;
        },
        gdi_delete_dc: (hdc) => {
          delete self._dcState[hdc];
          delete self._gdiObjects[hdc];
          return 1;
        },
        gdi_rectangle: (hdc, left, top, right, bottom, hwnd) => {
          if (!self.renderer) return 1;
          const ctx = self.renderer.ctx;
          const o = self._getClientOrigin(hwnd);
          const dc = self._getDC(hdc);
          const x = o.x + left, y = o.y + top, w = right - left, h = bottom - top;
          // Fill with brush
          const bc = dc.brushColor;
          ctx.fillStyle = `rgb(${bc & 0xFF},${(bc >> 8) & 0xFF},${(bc >> 16) & 0xFF})`;
          ctx.fillRect(x, y, w, h);
          // Stroke with pen
          const pc = dc.penColor;
          ctx.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
          ctx.lineWidth = dc.penWidth;
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          return 1;
        },
        gdi_ellipse: (hdc, left, top, right, bottom, hwnd) => {
          if (!self.renderer) return 1;
          const ctx = self.renderer.ctx;
          const o = self._getClientOrigin(hwnd);
          const dc = self._getDC(hdc);
          const cx = o.x + (left + right) / 2, cy = o.y + (top + bottom) / 2;
          const rx = (right - left) / 2, ry = (bottom - top) / 2;
          ctx.beginPath();
          ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
          const bc = dc.brushColor;
          ctx.fillStyle = `rgb(${bc & 0xFF},${(bc >> 8) & 0xFF},${(bc >> 16) & 0xFF})`;
          ctx.fill();
          const pc = dc.penColor;
          ctx.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
          ctx.lineWidth = dc.penWidth;
          ctx.stroke();
          return 1;
        },
        gdi_move_to: (hdc, x, y) => {
          const dc = self._getDC(hdc);
          dc.posX = x; dc.posY = y;
          return 1;
        },
        gdi_line_to: (hdc, x, y, hwnd) => {
          if (!self.renderer) return 1;
          const ctx = self.renderer.ctx;
          const o = self._getClientOrigin(hwnd);
          const dc = self._getDC(hdc);
          const pc = dc.penColor;
          ctx.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
          ctx.lineWidth = dc.penWidth;
          ctx.beginPath();
          ctx.moveTo(o.x + dc.posX + 0.5, o.y + dc.posY + 0.5);
          ctx.lineTo(o.x + x + 0.5, o.y + y + 0.5);
          ctx.stroke();
          dc.posX = x; dc.posY = y;
          return 1;
        },
        gdi_arc: (hdc, left, top, right, bottom, xStart, yStart, xEnd, yEnd, hwnd) => {
          if (!self.renderer) return 1;
          const ctx = self.renderer.ctx;
          const o = self._getClientOrigin(hwnd);
          const dc = self._getDC(hdc);
          const cx = o.x + (left + right) / 2, cy = o.y + (top + bottom) / 2;
          const rx = (right - left) / 2, ry = (bottom - top) / 2;
          const startAngle = Math.atan2(yStart - (top + bottom) / 2, xStart - (left + right) / 2);
          const endAngle = Math.atan2(yEnd - (top + bottom) / 2, xEnd - (left + right) / 2);
          ctx.beginPath();
          ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, startAngle, endAngle, true);
          const pc = dc.penColor;
          ctx.strokeStyle = `rgb(${pc & 0xFF},${(pc >> 8) & 0xFF},${(pc >> 16) & 0xFF})`;
          ctx.lineWidth = dc.penWidth;
          ctx.stroke();
          return 1;
        },
        gdi_bitblt: (dstDC, dx, dy, w, h, srcDC, sx, sy, rop, hwnd) => {
          if (!self.renderer) return 1;
          // Find source bitmap
          const srcState = self._getDC(srcDC);
          const srcBmpH = srcState.selectedBitmap;
          const srcBmp = srcBmpH ? self._gdiObjects[srcBmpH] : null;
          if (!srcBmp || !srcBmp.pixels) return 1;
          // Check if dst is a window DC (0x50001 = BeginPaint/GetDC)
          const isWindowDC = (dstDC === 0x50001);
          if (isWindowDC) {
            const o = self._getClientOrigin(hwnd);
            const imgData = self.renderer.ctx.createImageData(w, h);
            for (let row = 0; row < h; row++) {
              for (let col = 0; col < w; col++) {
                const srcX = sx + col, srcY = sy + row;
                if (srcX < 0 || srcX >= srcBmp.w || srcY < 0 || srcY >= srcBmp.h) continue;
                const si = (srcY * srcBmp.w + srcX) * 4;
                const di = (row * w + col) * 4;
                imgData.data[di] = srcBmp.pixels[si];
                imgData.data[di + 1] = srcBmp.pixels[si + 1];
                imgData.data[di + 2] = srcBmp.pixels[si + 2];
                imgData.data[di + 3] = srcBmp.pixels[si + 3];
              }
            }
            self.renderer.ctx.putImageData(imgData, o.x + dx, o.y + dy);
          } else {
            // Memory DC to memory DC copy
            const dstState = self._getDC(dstDC);
            const dstBmpH = dstState.selectedBitmap;
            const dstBmp = dstBmpH ? self._gdiObjects[dstBmpH] : null;
            if (!dstBmp || !dstBmp.pixels) return 1;
            for (let row = 0; row < h; row++) {
              for (let col = 0; col < w; col++) {
                const srcX = sx + col, srcY = sy + row;
                const dstX = dx + col, dstY = dy + row;
                if (srcX < 0 || srcX >= srcBmp.w || srcY < 0 || srcY >= srcBmp.h) continue;
                if (dstX < 0 || dstX >= dstBmp.w || dstY < 0 || dstY >= dstBmp.h) continue;
                const si = (srcY * srcBmp.w + srcX) * 4;
                const di = (dstY * dstBmp.w + dstX) * 4;
                dstBmp.pixels[di] = srcBmp.pixels[si];
                dstBmp.pixels[di + 1] = srcBmp.pixels[si + 1];
                dstBmp.pixels[di + 2] = srcBmp.pixels[si + 2];
                dstBmp.pixels[di + 3] = srcBmp.pixels[si + 3];
              }
            }
          }
          return 1;
        },
        gdi_load_bitmap: (resourceId) => {
          if (!self.resourceJson || !self.resourceJson.bitmaps) return 0;
          const bmp = self.resourceJson.bitmaps[resourceId];
          if (!bmp) return 0;
          return self._gdiAlloc({ type: 'bitmap', w: bmp.w, h: bmp.h, pixels: new Uint8Array(bmp.pixels) });
        },
        gdi_get_object_w: (hObj) => {
          const obj = self._gdiObjects[hObj];
          if (!obj || obj.type !== 'bitmap') return 0;
          return obj.w;
        },
        gdi_get_object_h: (hObj) => {
          const obj = self._gdiObjects[hObj];
          if (!obj || obj.type !== 'bitmap') return 0;
          return obj.h;
        },

        // Math imports for FPU transcendentals
        math_sin: (x) => Math.sin(x),
        math_cos: (x) => Math.cos(x),
        math_tan: (x) => Math.tan(x),
        math_atan2: (y, x) => Math.atan2(y, x),

        check_input: () => {
          if (!self.renderer) return 0;
          const evt = self.renderer.checkInput();
          if (!evt) return 0;
          self._lastInputEvent = evt;
          if (evt.msg !== 0x200) { // skip WM_MOUSEMOVE spam
            self.logToUI('[input] msg=0x' + evt.msg.toString(16) + ' wParam=0x' + evt.wParam.toString(16));
          }
          return (evt.wParam << 16) | (evt.msg & 0xFFFF);
        },
        check_input_lparam: () => {
          return self._lastInputEvent ? (self._lastInputEvent.lParam | 0) : 0;
        },
        check_input_hwnd: () => {
          return self._lastInputEvent ? (self._lastInputEvent.hwnd | 0) : 0;
        },
      },
    };
  }

  logToUI(msg) {
    const el = document.getElementById('log');
    if (el) {
      el.textContent += msg + '\n';
      el.scrollTop = el.scrollHeight;
    }
  }

  _getVersionInfo() {
    const info = {};
    try {
      const mem = new Uint8Array(this.memory.buffer);
      // Scan guest memory for VS_VERSION_INFO (UTF-16LE) signature
      // The PE sections are loaded at GUEST_BASE (0x12000) + section RVA
      const needle = 'VS_VERSION_INFO';
      const searchStart = 0x12000;
      const searchEnd = Math.min(searchStart + 0x200000, mem.length);
      let viBase = 0;
      for (let p = searchStart; p < searchEnd - needle.length * 2; p += 2) {
        let match = true;
        for (let j = 0; j < needle.length; j++) {
          if (mem[p + j * 2] !== needle.charCodeAt(j) || mem[p + j * 2 + 1] !== 0) { match = false; break; }
        }
        if (match) { viBase = p - 6; break; } // -6 for wLength + wValueLength + wType before string
      }
      if (!viBase) return info;
      const dv = new DataView(this.memory.buffer);
      const viSize = dv.getUint16(viBase, true);
      // Scan for UTF-16LE key-value pairs within the version resource
      const keys = ['CompanyName', 'FileDescription', 'FileVersion', 'LegalCopyright', 'ProductName', 'ProductVersion'];
      for (const key of keys) {
        for (let p = viBase; p < viBase + viSize - key.length * 2; p += 2) {
          let match = true;
          for (let j = 0; j < key.length; j++) {
            if (mem[p + j * 2] !== key.charCodeAt(j) || mem[p + j * 2 + 1] !== 0) { match = false; break; }
          }
          if (!match) continue;
          let vp = p + (key.length + 1) * 2;
          while (vp % 4 !== 0) vp++;
          let val = '';
          for (let j = vp; j < viBase + viSize - 1; j += 2) {
            const ch = mem[j] | (mem[j + 1] << 8);
            if (ch === 0) break;
            val += String.fromCharCode(ch);
          }
          if (val) info[key] = val;
          break;
        }
      }
    } catch (e) {
      console.warn('[ShellAbout] version info parse error:', e);
    }
    return info;
  }

  async init(canvas) {
    const resp = await fetch('../build/wine-assembly.wasm');
    const bytes = await resp.arrayBuffer();
    const imports = this.getImports();
    const result = await WebAssembly.instantiate(bytes, imports);
    this.instance = result.instance;
    this.memory = this.instance.exports.memory;

    if (canvas) {
      this.renderer = new Win98Renderer(canvas);
    }
  }

  async loadExe(url) {
    if (!this.instance) await this.init();

    const resp = await fetch(url);
    const exeBytes = new Uint8Array(await resp.arrayBuffer());

    // Parse PE resources directly from EXE bytes
    if (typeof parseResources === 'function') {
      this.resourceJson = parseResources(exeBytes);
      if (this.renderer) {
        this.renderer.loadResources(this.resourceJson);
      }
      const rm = Object.keys(this.resourceJson.menus).length;
      const rd = Object.keys(this.resourceJson.dialogs).length;
      const rs = Object.keys(this.resourceJson.strings).length;
      this.logToUI(`Resources: ${rm} menus, ${rd} dialogs, ${rs} strings`);
    }

    const staging = this.instance.exports.get_staging();
    const dest = new Uint8Array(this.memory.buffer, staging, exeBytes.length);
    dest.set(exeBytes);

    const entryPoint = this.instance.exports.load_pe(exeBytes.length);
    if (entryPoint < 0) {
      this.logToUI('ERROR: Failed to load PE (code ' + entryPoint + ')');
      return false;
    }

    this.logToUI('PE loaded. Entry point: 0x' + (entryPoint >>> 0).toString(16));
    return true;
  }

  run(stepsPerSlice = 10000) {
    this.running = true;
    const step = () => {
      if (!this.running) {
        this.logToUI('--- Execution stopped ---');
        this.dumpRegs();
        return;
      }
      try {
        this.instance.exports.run(stepsPerSlice);
        if (!this.instance.exports.get_eip()) {
          this.logToUI('--- Program exited ---');
          this.running = false;
          if (this.renderer) {
            this.renderer.ctx.fillStyle = '#008080';
            this.renderer.ctx.fillRect(0, 0, this.renderer.canvas.width, this.renderer.canvas.height);
          }
          return;
        }
      } catch (e) {
        this.logToUI('ERROR: ' + e.message);
        this.running = false;
        this.dumpRegs();
        return;
      }
      if (this.running) {
        setTimeout(step, 0);
      }
    };
    step();
  }

  dumpRegs() {
    const e = this.instance.exports;
    const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
    this.logToUI(`EIP=${hex(e.get_eip())} ESP=${hex(e.get_esp())}`);
    this.logToUI(`EAX=${hex(e.get_eax())} ECX=${hex(e.get_ecx())} EDX=${hex(e.get_edx())} EBX=${hex(e.get_ebx())}`);
    this.logToUI(`EBP=${hex(e.get_ebp())} ESI=${hex(e.get_esi())} EDI=${hex(e.get_edi())}`);
  }
}

// Expose globally
window.WineAssembly = WineAssembly;
