// Wine-Assembly: JS host for the WASM x86 interpreter
// Win98Renderer is loaded from lib/renderer.js (included via <script> in index.html)

class WineAssembly {
  constructor() {
    this.instance = null;
    this.memory = null;
    this.running = false;
    this.renderer = null;
    this.resourceJson = null;
    this.threadManager = null;
    this._wasmModule = null;
    this.verbose = false;
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
    const ctx = {
      getMemory: () => self.memory.buffer,
      get renderer() { return self.renderer; },
      get resourceJson() { return self.resourceJson; },
      get dllResources() { return self.dllResources; },
      readFile: (name) => {
        const baseName = name.replace(/^.*[\\\/]/, '');
        try {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', 'binaries/' + baseName, false);
          xhr.responseType = 'arraybuffer';
          xhr.send();
          if (xhr.status === 200) return new Uint8Array(xhr.response);
        } catch (_) {}
        return null;
      },
      onExit: (code) => {
        self.running = false;
        if (self.renderer && !self._multiApp) {
          self.renderer._exited = true;
          self.renderer.windows = {};
          self.renderer.repaint();
        }
      },
    };
    self._helpCtx = ctx;
    const base = createHostImports(ctx);
    const h = base.host;

    // --- Browser-specific overrides ---
    h.log = (ptr, len) => {
      if (self.verbose) {
        const bytes = new Uint8Array(self.memory.buffer, ptr, len);
        const text = new TextDecoder().decode(bytes);
        console.log('[wine-asm]', text);
        self.logToUI('[wine-asm] ' + text);
      }
    };
    h.log_i32 = (val) => {
      if (self.verbose) {
        console.log('[wine-asm] i32:', '0x' + (val >>> 0).toString(16));
        self.logToUI('[wine-asm] i32: 0x' + (val >>> 0).toString(16));
      }
    };
    h.shell_about = (hWnd, szAppPtr) => {
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
    };
    h.message_box = (hWnd, textPtr, captionPtr, uType) => {
      const text = self.readString(textPtr);
      const caption = self.readString(captionPtr);
      console.log(`[MessageBox] "${caption}": "${text}"`);
      self.logToUI(`[MessageBox] ${caption}: ${text}`);
      if (caption.includes('Assertion')) return 1;
      alert(`${caption}\n\n${text}`);
      return 1;
    };
    h.exit = (code) => {
      console.log('[ExitProcess] code:', code);
      if (!self._inDllInit) {
        self.logToUI('[ExitProcess] code: ' + code);
        self.logToUI('--- Program exited ---');
        self.running = false;
        if (self.renderer && !self._multiApp) {
          self.renderer._exited = true;
          self.renderer.windows = {};
          self.renderer.repaint();
        }
      }
    };
    h.create_window = (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
      const title = self.readString(titlePtr);
      console.log(`[CreateWindow] hwnd=0x${hwnd.toString(16)} title="${title}" menu=${menuId} pos=${x},${y} size=${cx}x${cy}`);
      self.logToUI(`[CreateWindow] "${title}"`);
      if (self.renderer) self.renderer.createWindow(hwnd, style, x, y, cx, cy, title, menuId);
      return hwnd;
    };
    h.create_dialog = (hwnd, dlgId) => {
      console.log(`[CreateDialog] hwnd=0x${hwnd.toString(16)} dlgId=${dlgId}`);
      self.logToUI(`[CreateDialog] template=${dlgId}`);
      if (self.renderer) return self.renderer.createDialog(hwnd, dlgId);
      return hwnd;
    };
    h.set_window_text = (hwnd, textPtr) => {
      const text = self.readString(textPtr);
      console.log(`[SetWindowText] hwnd=0x${hwnd.toString(16)} "${text}"`);
      if (self.renderer) self.renderer.setWindowText(hwnd, text);
    };
    h.set_menu = (hwnd, menuResId) => {
      console.log(`[SetMenu] hwnd=0x${hwnd.toString(16)} menuRes=${menuResId}`);
      if (self.renderer) self.renderer.setMenu(hwnd, menuResId);
    };

    // --- Input ---
    h.check_input = () => {
      if (!self.renderer) return 0;
      // In multi-app mode, only dequeue events for this app's hwnd range
      let evt;
      if (self._hwndBase && self._multiApp) {
        const lo = self._hwndBase;
        const hi = lo + 0x10000;
        const q = self.renderer.inputQueue;
        const idx = q.findIndex(e => !e.hwnd || (e.hwnd >= lo && e.hwnd < hi));
        if (idx < 0) return 0;
        evt = q.splice(idx, 1)[0];
        if (evt.msg === 0x000F) self.renderer.scheduleRepaint();
      } else {
        evt = self.renderer.checkInput();
      }
      if (!evt) return 0;
      self._lastInputEvent = evt;
      if (evt.msg !== 0x200) {
        self.logToUI('[input] msg=0x' + evt.msg.toString(16) + ' wParam=0x' + evt.wParam.toString(16));
      }
      return (evt.wParam << 16) | (evt.msg & 0xFFFF);
    };
    h.check_input_lparam = () => {
      return self._lastInputEvent ? (self._lastInputEvent.lParam | 0) : 0;
    };
    h.check_input_hwnd = () => {
      return self._lastInputEvent ? (self._lastInputEvent.hwnd | 0) : 0;
    };

    // Wire thread/event imports to ThreadManager
    h.create_thread = (s, p, sz) => self.threadManager ? self.threadManager.createThread(s, p, sz) : 0;
    h.exit_thread = (c) => self.threadManager && self.threadManager.exitThread(c);
    h.create_event = (m, i) => self.threadManager ? self.threadManager.createEvent(m, i) : 0;
    h.set_event = (handle) => self.threadManager ? self.threadManager.setEvent(handle) : 1;
    h.reset_event = (handle) => self.threadManager ? self.threadManager.resetEvent(handle) : 1;
    h.wait_single = (handle, t) => self.threadManager ? self.threadManager.waitSingle(handle, t) : 0;

    // Memory is set later in init()
    h.memory = null;

    return { host: h };
  }

  logToUI(msg) {
    console.log(msg);
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
      const needle = 'VS_VERSION_INFO';
      const searchStart = 0x12000;
      const searchEnd = Math.min(searchStart + 0x200000, mem.length);
      let viBase = 0;
      for (let p = searchStart; p < searchEnd - needle.length * 2; p += 2) {
        let match = true;
        for (let j = 0; j < needle.length; j++) {
          if (mem[p + j * 2] !== needle.charCodeAt(j) || mem[p + j * 2 + 1] !== 0) { match = false; break; }
        }
        if (match) { viBase = p - 6; break; }
      }
      if (!viBase) return info;
      const dv = new DataView(this.memory.buffer);
      const viSize = dv.getUint16(viBase, true);
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
    const resp = await fetch('../build/wine-assembly.wasm?v=14');
    const bytes = await resp.arrayBuffer();
    const imports = this.getImports();

    // Create shared memory externally
    this.memory = new WebAssembly.Memory({ initial: 1024 });
    imports.host.memory = this.memory;

    const result = await WebAssembly.instantiate(bytes, imports);
    this.instance = result.instance;
    this._wasmModule = result.module;

    // Create ThreadManager
    const self = this;
    const makeWorkerImports = (tid) => {
      const wi = self.getImports();
      wi.host.memory = self.memory;
      wi.host.log = () => {};
      wi.host.log_i32 = () => {};
      wi.host.exit = () => {};
      return wi;
    };
    this.threadManager = new ThreadManager(this._wasmModule, this.memory, this.instance, makeWorkerImports);

    if (canvas && !this.renderer) {
      this.renderer = new Win98Renderer(canvas);
    }
  }

  async loadExe(url) {
    if (!this.instance) await this.init();

    const resp = await fetch(url);
    const exeBytes = new Uint8Array(await resp.arrayBuffer());
    this._exeBytes = exeBytes;

    // Parse PE resources directly from EXE bytes
    if (typeof parseResources === 'function') {
      this.resourceJson = parseResources(exeBytes);
      if (this.renderer) {
        this.renderer.loadResources(this.resourceJson);
      }
    }

    // Load EXE into staging buffer
    const staging = this.instance.exports.get_staging();
    const mem = new Uint8Array(this.memory.buffer);
    mem.set(exeBytes, staging);

    // Load PE
    const entry = this.instance.exports.load_pe(exeBytes.length);
    console.log('PE loaded. Entry: 0x' + (entry >>> 0).toString(16).padStart(8, '0'));

    // Set EXE name from URL
    const exeName = url.replace(/^.*[\\\/]/, '');
    if (this.instance.exports.set_exe_name) {
      const enc = new TextEncoder();
      const nameBytes = enc.encode(exeName);
      const mem2 = new Uint8Array(this.memory.buffer);
      const tmpOff = staging; // reuse staging as scratch
      mem2.set(nameBytes, tmpOff);
      this.instance.exports.set_exe_name(tmpOff, nameBytes.length);
    }

    return entry;
  }

  async loadDlls(dllPaths) {
    if (!this.instance) return;
    const _loadDlls = (typeof DllLoader !== 'undefined' && DllLoader.loadDlls) || (typeof loadDlls === 'function' && loadDlls);
    if (!_loadDlls) return;
    // dllPaths can be strings (URLs) or {name, bytes} objects
    const configs = [];
    for (const item of dllPaths) {
      if (typeof item === 'string') {
        const resp = await fetch(item);
        if (!resp.ok) { console.error('Failed to fetch DLL:', item); continue; }
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const name = item.split('/').pop();
        configs.push({ name, bytes });
      } else {
        configs.push(item);
      }
    }
    const exeBytes = this._exeBytes;
    this._inDllInit = true;
    const results = _loadDlls(this.instance.exports, this.memory.buffer, exeBytes, configs, console.log);
    this._inDllInit = false;
    // Parse DLL resources for bitmap loading
    const _parseResources = (typeof parseResources === 'function') ? parseResources : (typeof ResourceParser !== 'undefined' && ResourceParser.parseResources);
    if (_parseResources && results) {
      this.dllResources = this.dllResources || {};
      for (let i = 0; i < configs.length && i < results.length; i++) {
        try {
          const dllRes = _parseResources(configs[i].bytes);
          if (dllRes && dllRes.bitmaps && Object.keys(dllRes.bitmaps).length > 0) {
            this.dllResources[results[i].loadAddr] = dllRes;
            console.log(`DLL resources: ${configs[i].name} has ${Object.keys(dllRes.bitmaps).length} bitmaps`);
          }
        } catch (_) {}
      }
    }
    this.running = true;
  }

  async handleComDllLoad() {
    const exports = this.instance.exports;
    // Read pending DLL name from COM yield state
    const dllNameWA = exports.get_com_dll_name ? exports.get_com_dll_name() : 0;
    if (!dllNameWA) {
      console.error('COM yield but no pending DLL name');
      exports.clear_yield();
      return;
    }
    const mem = new Uint8Array(this.memory.buffer);
    let dllName = '';
    for (let i = 0; i < 260; i++) {
      const ch = mem[dllNameWA + i];
      if (!ch) break;
      dllName += String.fromCharCode(ch);
    }
    // Extract just the filename
    const fileName = dllName.split('\\').pop().toLowerCase();
    console.log(`[COM] Loading DLL: ${fileName}`);

    try {
      // Try to fetch the DLL
      const paths = [`dlls/${fileName}`, `../test/binaries/dlls/${fileName}`];
      let dllBytes = null;
      for (const p of paths) {
        try {
          const resp = await fetch(p);
          if (resp.ok) {
            dllBytes = new Uint8Array(await resp.arrayBuffer());
            console.log(`[COM] Fetched ${p} (${dllBytes.length} bytes)`);
            break;
          }
        } catch (_) {}
      }
      if (!dllBytes) {
        console.error(`[COM] Failed to fetch DLL: ${fileName}`);
        // Clear yield and let CoCreateInstance fail with REGDB_E_CLASSNOTREG
        exports.clear_yield();
        // Set EAX to error, advance ESP past the 5 stdcall args
        exports.set_eax(0x80040154);
        exports.set_esp(exports.get_esp() + 24);
        return;
      }

      // Load the DLL using existing infrastructure
      const _loadDll = (typeof DllLoader !== 'undefined' && DllLoader.loadDll) || null;
      if (_loadDll) {
        const result = _loadDll(exports, this.memory.buffer, dllBytes);
        console.log(`[COM] DLL loaded at 0x${result.loadAddr.toString(16)}`);
        // Patch EXE imports if we have EXE bytes
        if (this._exeBytes) {
          const _patchExeImports = (typeof DllLoader !== 'undefined' && DllLoader.patchExeImports) || null;
          if (_patchExeImports) {
            _patchExeImports(exports, this.memory.buffer, this._exeBytes, console.log);
          }
        }
        // Call DllMain if entry point exists
        if (result.dllMain) {
          const _callDllMain = (typeof DllLoader !== 'undefined' && DllLoader.callDllMain) || null;
          if (_callDllMain) {
            _callDllMain(exports, result.loadAddr, result.dllMain, console.log);
          }
        }
      }

      // Clear yield — run() will re-enter CoCreateInstance handler
      // which will retry and find the DLL now loaded
      exports.clear_yield();
      // Don't advance ESP — the handler will be re-invoked by the dispatch
    } catch (e) {
      console.error('[COM] DLL load error:', e);
      exports.clear_yield();
      exports.set_eax(0x80004005); // E_FAIL
      exports.set_esp(exports.get_esp() + 24);
    }
  }

  async handleHelpLoad() {
    const ctx = this._helpCtx;
    const baseName = (ctx._helpPendingPath || '').replace(/^.*[\\\/]/, '');
    if (!baseName) {
      this.instance.exports.clear_yield();
      return;
    }
    const paths = ['binaries/help/' + baseName, 'binaries/' + baseName];
    let data = null;
    for (const url of paths) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          data = new Uint8Array(await resp.arrayBuffer());
          break;
        }
      } catch (_) {}
    }
    if (data && typeof HlpParser !== 'undefined') {
      try {
        const parser = new HlpParser(data);
        if (parser.parse()) {
          ctx._helpParser = parser;
          console.log(`[HelpLoad] Parsed ${baseName}: ${parser.topics.length} topics`);
        }
      } catch (e) {
        console.error('[HelpLoad] Parse error:', e);
      }
    }
    ctx._helpPendingPath = null;
    this.instance.exports.clear_yield();
  }

  run(stepsPerSlice = 50000) {
    this.running = true;
    const self = this;
    const step = async () => {
      if (!self.running) return;
      try {
        // Check if main thread is waiting
        if (self.threadManager && self.threadManager.checkMainYield()) {
          // Main still waiting — just run worker threads
        } else {
          self.instance.exports.run(stepsPerSlice);
        }
        if (!self.instance.exports.get_eip() && !self.instance.exports.get_yield_reason()) {
          self.logToUI('--- Program exited ---');
          self.running = false;
          return;
        }
        // Handle yield reasons
        const yieldReason = self.instance.exports.get_yield_reason();
        if (yieldReason === 3) {
          await self.handleComDllLoad();
          if (self.running) { setTimeout(step, 0); }
          return;
        }
        if (yieldReason === 4) {
          await self.handleHelpLoad();
          if (self.running) { setTimeout(step, 0); }
          return;
        }
        // Spawn and run worker threads
        if (self.threadManager) {
          if (self.threadManager._pendingThreads.length) {
            await self.threadManager.spawnPending();
          }
          if (self.threadManager.hasActiveThreads()) {
            self.threadManager.runSlice(Math.min(stepsPerSlice, 10000));
          }
        }
      } catch (e) {
        console.error('WASM crash:', e);
        self.logToUI('ERROR: ' + e.message);
        self.running = false;
        return;
      }
      if (self.running) {
        setTimeout(step, 0);
      }
    };
    step();
  }
}
