// Wine-Assembly: JS host for the WASM x86 interpreter

class WineAssembly {
  constructor() {
    this.instance = null;
    this.memory = null;
    this.running = false;
  }

  // Read a null-terminated string from WASM memory
  readString(ptr) {
    const bytes = new Uint8Array(this.memory.buffer);
    let str = '';
    for (let i = ptr; bytes[i] !== 0 && i < ptr + 1024; i++) {
      str += String.fromCharCode(bytes[i]);
    }
    return str;
  }

  // Host imports provided to the WASM module
  getImports() {
    return {
      host: {
        log: (ptr, len) => {
          const bytes = new Uint8Array(this.memory.buffer, ptr, len);
          const text = new TextDecoder().decode(bytes);
          console.log('[wine-asm]', text);
          this.logToUI('[wine-asm] ' + text);
        },

        log_i32: (val) => {
          console.log('[wine-asm] i32:', '0x' + (val >>> 0).toString(16));
          this.logToUI('[wine-asm] unknown opcode: 0x' + (val >>> 0).toString(16));
        },

        message_box: (hWnd, textPtr, captionPtr, uType) => {
          const text = this.readString(textPtr);
          const caption = this.readString(captionPtr);
          console.log(`[MessageBox] "${caption}": "${text}"`);
          this.logToUI(`[MessageBox] ${caption}: ${text}`);

          // Show as a browser dialog
          alert(`${caption}\n\n${text}`);

          // Return IDOK = 1
          return 1;
        },

        exit: (code) => {
          console.log('[ExitProcess] code:', code);
          this.logToUI('[ExitProcess] code: ' + code);
          this.running = false;
        },

        draw_rect: (x, y, w, h, color) => {
          const canvas = document.getElementById('screen');
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
          ctx.fillRect(x, y, w, h);
        },

        read_file: (namePtr, bufPtr, bufSize) => {
          // TODO: virtual filesystem
          console.log('[ReadFile] not implemented');
          return 0;
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

  async init() {
    const resp = await fetch('../build/wine-assembly.wasm');
    const bytes = await resp.arrayBuffer();
    const imports = this.getImports();
    const result = await WebAssembly.instantiate(bytes, imports);
    this.instance = result.instance;
    this.memory = this.instance.exports.memory;
  }

  async loadExe(url) {
    if (!this.instance) await this.init();

    const resp = await fetch(url);
    const exeBytes = new Uint8Array(await resp.arrayBuffer());

    // Copy PE into staging area
    const staging = this.instance.exports.get_staging();
    const dest = new Uint8Array(this.memory.buffer, staging, exeBytes.length);
    dest.set(exeBytes);

    // Parse and load the PE
    const entryPoint = this.instance.exports.load_pe(exeBytes.length);
    if (entryPoint < 0) {
      this.logToUI('ERROR: Failed to load PE (code ' + entryPoint + ')');
      return false;
    }

    this.logToUI('PE loaded. Entry point: 0x' + (entryPoint >>> 0).toString(16));
    return true;
  }

  // Run the interpreter in time-sliced chunks
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
      // Yield to browser, then continue
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

// Boot
const wine = new WineAssembly();

async function loadAndRun(exeUrl) {
  try {
    await wine.init();
    wine.logToUI('WASM module loaded.');
    const ok = await wine.loadExe(exeUrl);
    if (ok) {
      wine.logToUI('Starting execution...');
      wine.run();
    }
  } catch (e) {
    wine.logToUI('FATAL: ' + e.message);
    console.error(e);
  }
}

// Expose globally
window.wine = wine;
window.loadAndRun = loadAndRun;
