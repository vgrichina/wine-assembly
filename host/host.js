// Wine-Assembly: JS host for the WASM x86 interpreter
// Win98Renderer is loaded from lib/renderer.js (included via <script> in index.html)

class WineAssembly {
  constructor() {
    this.instance = null;
    this.memory = null;
    this.running = false;
    this.renderer = null;
    this.resourceJson = null;
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
          const bytes = new Uint8Array(self.memory.buffer, ptr, len);
          const text = new TextDecoder().decode(bytes);
          console.log('[wine-asm]', text);
          self.logToUI('[wine-asm] ' + text);
        },

        log_i32: (val) => {
          console.log('[wine-asm] i32:', '0x' + (val >>> 0).toString(16));
          self.logToUI('[wine-asm] i32: 0x' + (val >>> 0).toString(16));
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
          self.running = false;
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

        set_window_text: (hwnd, textPtr) => {
          const text = self.readString(textPtr);
          console.log(`[SetWindowText] hwnd=0x${hwnd.toString(16)} "${text}"`);
          if (self.renderer) {
            self.renderer.setWindowText(hwnd, text);
          }
        },

        invalidate: (hwnd) => {
          if (self.renderer) {
            self.renderer.invalidate(hwnd);
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

        check_input: () => {
          if (!self.renderer) return 0;
          const evt = self.renderer.checkInput();
          if (!evt) return 0;
          return (evt.wParam << 16) | (evt.msg & 0xFFFF);
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

  async loadResources(jsonUrl) {
    try {
      const resp = await fetch(jsonUrl);
      this.resourceJson = await resp.json();
      if (this.renderer) {
        this.renderer.loadResources(this.resourceJson);
      }
      console.log('Resources loaded:', jsonUrl);
    } catch (e) {
      console.warn('No resources:', jsonUrl, e.message);
    }
  }

  async loadExe(url) {
    if (!this.instance) await this.init();

    const resp = await fetch(url);
    const exeBytes = new Uint8Array(await resp.arrayBuffer());

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
