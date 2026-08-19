// Wine-Assembly: JS host for the WASM x86 interpreter
// Win98Renderer is loaded from lib/renderer.js (included via <script> in index.html)

// The boot steps this host shares with the CLI harness: staging the EXE,
// load_pe, the exe-name/cmdline pokes, and the DLL dependency walk.
// lib/process-boot.js is a classic script loaded ahead of this one.
const ProcessBoot = (typeof window !== 'undefined' && window.processBoot) || null;

class WineAssembly {
  static SOURCE_VERSION = '207';
  static _nextProcessId = 1000;

  static hasRemainingAppWindow(destroyed, remainingTopLevel) {
    // A hidden startup/helper window disappearing is not a user-visible app
    // close. Pinball hides and destroys its splash before its main frame is
    // ready; stopping synchronously here prevents the guest from reaching the
    // later ShowWindow call even when no renderer window currently remains.
    if (destroyed && destroyed.visible === false) return true;
    if (!remainingTopLevel || remainingTopLevel.length === 0) return false;
    if (!destroyed || !destroyed.isDialog) return true;

    // A dialog-only application usually leaves one invisible owner behind
    // when its last visible dialog closes. Pinball does the inverse during
    // startup: its independent main frame may exist but not be shown yet.
    // Keep a hidden independent frame, but not the dialog's hidden owner.
    const ownerHwnd = destroyed.ownerHwnd >>> 0;
    return remainingTopLevel.some(w =>
      w && (w.visible || (w.hwnd >>> 0) !== ownerHwnd)
    );
  }

  constructor() {
    // One WineAssembly object models one Win32 process. Worker WASM instances
    // created by ThreadManager are threads of this process and share its PID
    // through the process's SharedArrayBuffer-backed memory.
    this.processId = WineAssembly._nextProcessId++;
    this.instance = null;
    this.memory = null;
    this.running = false;
    this.renderer = null;
    this.resourceJson = null;
    this.threadManager = null;
    this._wasmModule = null;
    this.stepsPerSlice = 100000;
    this.verbose = false;
  }

  _guestTickState(sharedAudio) {
    const shared = sharedAudio || this._sharedAudio || (this._sharedAudio = {});
    if (!shared.guestTickState) {
      shared.guestTickState = { wallStartMs: 0, batchMs: 0, callsInBatch: 0, lastReturnedMs: 0 };
    }
    return shared.guestTickState;
  }

  _beginGuestTickBatch(sharedAudio) {
    const st = this._guestTickState(sharedAudio);
    const now = this._audioSchedulerNow();
    if (!Number.isFinite(st.wallStartMs) || st.wallStartMs <= 0) st.wallStartMs = now;
    const elapsed = Math.max(0, Math.floor(now - st.wallStartMs));
    st.batchMs = Math.max(Number.isFinite(st.batchMs) ? st.batchMs : 0, elapsed) & 0x7FFFFFFF;
    st.callsInBatch = 0;
  }

  _guestTickMs(sharedAudio) {
    const st = this._guestTickState(sharedAudio);
    const now = this._audioSchedulerNow();
    if (!Number.isFinite(st.wallStartMs) || st.wallStartMs <= 0) st.wallStartMs = now;
    const elapsed = Math.max(0, Math.floor(now - st.wallStartMs));
    const batchMs = Math.max(Number.isFinite(st.batchMs) ? st.batchMs : 0, elapsed);
    const last = Number.isFinite(st.lastReturnedMs) ? st.lastReturnedMs : 0;
    const tick = Math.max(batchMs, last) & 0x7FFFFFFF;
    st.batchMs = tick;
    st.lastReturnedMs = tick;
    st.callsInBatch = (Number.isFinite(st.callsInBatch) ? st.callsInBatch : 0) + 1;
    return tick;
  }

  _guestAudioClockMs(sharedAudio) {
    const st = this._guestTickState(sharedAudio);
    return Number.isFinite(st.batchMs) ? st.batchMs : 0;
  }

  readString(ptr) {
    const bytes = new Uint8Array(this.memory.buffer);
    let str = '';
    for (let i = ptr; bytes[i] !== 0 && i < ptr + 1024; i++) {
      str += String.fromCharCode(bytes[i]);
    }
    return str;
  }

  _cleanupWinampVisualizerThread(info) {
    const ex = this.instance && this.instance.exports;
    if (!ex || !this.memory || !this.memory.buffer) return;
    const imageBase = ex.get_image_base ? (ex.get_image_base() >>> 0) : 0;
    const guestBase = ex.get_guest_base ? (ex.get_guest_base() >>> 0) : 0x12000;
    if (!imageBase) return;
    const dv = new DataView(this.memory.buffer);
    const g2w = (ptr) => ((ptr >>> 0) - imageBase + guestBase) >>> 0;
    const read32 = (ptr) => {
      const wa = g2w(ptr);
      return wa + 4 <= dv.byteLength ? (dv.getUint32(wa, true) >>> 0) : 0;
    };
    const write32 = (ptr, value) => {
      const wa = g2w(ptr);
      if (wa + 4 <= dv.byteLength) dv.setUint32(wa, value >>> 0, true);
    };
    const readStr = (ptr, max) => {
      const wa = g2w(ptr);
      if (wa >= dv.byteLength) return '';
      let s = '';
      for (let i = 0; i < max && wa + i < dv.byteLength; i++) {
        const c = dv.getUint8(wa + i);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s;
    };
    const readLinearStr = (wa, max) => {
      if (wa >= dv.byteLength) return '';
      let s = '';
      for (let i = 0; i < max && wa + i < dv.byteLength; i++) {
        const c = dv.getUint8(wa + i);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s;
    };
    const findDllLoadAddr = (name) => {
      if (!ex.get_dll_count || !ex.get_dll_table) return 0;
      const target = String(name || '').toLowerCase();
      const table = ex.get_dll_table() >>> 0;
      const count = ex.get_dll_count() | 0;
      for (let i = 0; i < count; i++) {
        const entry = table + i * 32;
        if (entry + 12 > dv.byteLength) break;
        const loadAddr = dv.getUint32(entry, true) >>> 0;
        const exportRva = dv.getUint32(entry + 8, true) >>> 0;
        if (!loadAddr || !exportRva) continue;
        const exportDir = g2w((loadAddr + exportRva) >>> 0);
        if (exportDir + 16 > dv.byteLength) continue;
        const nameRva = dv.getUint32(exportDir + 12, true) >>> 0;
        if (!nameRva) continue;
        const dllName = readLinearStr(g2w((loadAddr + nameRva) >>> 0), 96).toLowerCase();
        if (dllName === target) return loadAddr;
      }
      return 0;
    };
    const resetWvisDllWindowCache = () => {
      const loadAddr = findDllLoadAddr('vis_w.dll');
      if (!loadAddr) return false;
      const resetOffsets = [
        0xc060, 0xc064,       // current surface size
        0xca48, 0xca4c,       // last allocated surface size
        0xde60, 0xde64, 0xde68, 0xde70,
        0xde78, 0xde7c, 0xde80, 0xde84, // cached parent window rect
      ];
      for (const off of resetOffsets) write32((loadAddr + off) >>> 0, 0);
      return true;
    };

    const handle = (info && info.handle) >>> 0;
    if (((info && info.param) >>> 0) === 0x458060 && read32(0x458060) === 1) {
      if (read32(0x45805c) === handle) write32(0x45805c, 0);
      write32(0x458060, 0);
      console.log(`[host] reset Winamp visualizer data helper stop flag after thread 0x${handle.toString(16)} exited`);
      return;
    }
    if (!handle || read32(0x4595ac) !== handle) return;
    const pluginPath = readStr(0x4595b8, 260).toLowerCase();
    if (!pluginPath.includes('vis_w.dll') && !pluginPath.includes('plugins\\vis_')) return;
    if (!read32(0x459584) && !read32(0x459810)) return;
    if (read32(0x458c78) !== 0) return;

    write32(0x4595a4, 0);
    write32(0x4595ac, 0);
    write32(0x459584, 0);
    write32(0x459810, 0);
    write32(0x458060, 1);
    const resetDll = resetWvisDllWindowCache();
    console.log(`[host] cleared stale Winamp visualizer thread handle 0x${handle.toString(16)}`);
    if (resetDll) console.log('[host] reset wVis DLL cached window geometry');
  }

  primeAudio() {
    const AC = (typeof AudioContext !== 'undefined') ? AudioContext :
               (typeof webkitAudioContext !== 'undefined') ? webkitAudioContext : null;
    if (!AC) return null;
    if (this._audioCtx && this._audioCtx.state === 'closed') this._audioCtx = null;
    if (!this._audioCtx) {
      try { this._audioCtx = new AC({ sampleRate: 44100 }); }
      catch (_) {
        try { this._audioCtx = new AC(); } catch (_) { this._audioCtx = null; }
      }
    }
    if (this._audioCtx && this._audioCtx.state === 'suspended') {
      try { this._audioCtx.resume(); } catch (_) {}
    }
    return this._audioCtx;
  }

  getImports(options) {
    const self = this;
    const opts = options || {};
    const sharedAudio = opts.sharedAudio || self._sharedAudio || (self._sharedAudio = {});
    const sharedMixer = opts.sharedMixer || self._sharedMixer || null;
    self._guestTickState(sharedAudio);
    const ctx = {
      getMemory: () => self.memory.buffer,
      apiTable: self.apiTable,
      get renderer() { return self.renderer; },
      get resourceJson() { return self.resourceJson; },
      get dllResources() { return self.dllResources; },
      get instance() {
        if (typeof opts.instance === 'function') return opts.instance();
        return opts.instance || self.instance || null;
      },
      get exports() {
        if (typeof opts.exports === 'function') return opts.exports();
        if (opts.exports) return opts.exports;
        const instance = this.instance;
        return instance ? instance.exports : null;
      },
      get processId() { return self.processId; },
      traceHost: opts.traceHost || (typeof window !== 'undefined' ? window.__waTraceHostNames : null),
      threadId: opts.threadId | 0,
      vfs: opts.vfs || null,
      // The virtual LAN segment this page is joined to, or null when it is
      // alone in its own room. A worker thread is part of the same process,
      // so it is handed the same wire rather than opening one of its own.
      vlanWire: opts.vlanWire || self.vlanWire || null,
      get availableDllFiles() { return opts.availableDllFiles || self._availableDllFiles || null; },
      // Live guest thread count, for HKEY_DYN_DATA\PerfStats KERNEL\Threads.
      get threadManager() { return self.threadManager; },
      sharedGdi: opts.sharedGdi || null,
      sharedAudio,
      sharedMixer,
      audioClockMs: () => self._guestAudioClockMs(sharedAudio),
      onAudioCaptureError: (message) => {
        self._lastAudioCaptureError = String(message || 'microphone unavailable');
        if (typeof document !== 'undefined') {
          const status = document.getElementById('status');
          if (status) status.textContent = 'Microphone unavailable: ' + self._lastAudioCaptureError;
        }
      },
      get _audioCtx() { return self._audioCtx; },
      set _audioCtx(v) { self._audioCtx = v; },
      readFile: (name) => {
        const baseName = name.replace(/^.*[\\\/]/, '');
        const lowerName = name.toLowerCase().replace(/\//g, '\\');
        const lowerBase = baseName.toLowerCase();
        const vfs = ctx.vfs || (self._helpCtx && self._helpCtx.vfs);
        if (vfs && vfs.files) {
          const candidates = [
            lowerName,
            'c:\\' + lowerName.replace(/^\\+/, ''),
            'c:\\' + lowerBase,
          ];
          for (const p of candidates) {
            const entry = vfs.files.get(p);
            if (entry && entry.data) return entry.data;
          }
          for (const [p, entry] of vfs.files) {
            if (String(p).split('\\').pop() === lowerBase && entry && entry.data) return entry.data;
          }
        }
        // Last resort: a synchronous fetch on the main thread, which blocks the
        // UI for a network round trip and is invisible to the perf HUD's phase
        // marks. It stays synchronous because the caller is a WAT host import
        // that must return bytes now; making it yield-and-resume the way DLL
        // loading does is the real fix and a larger change.
        //
        // What is fixed here is the repeat: an app that probes the same missing
        // file in a loop used to pay a full round trip every time. Both hits
        // and misses are remembered, so each name costs at most one stall.
        if (!self._syncFetchCache) self._syncFetchCache = new Map();
        const exeDir = self._exeUrl ? self._exeUrl.replace(/[^\/\\]*$/, '') : '';
        const url = exeDir ? exeDir + baseName : 'binaries/' + baseName;
        if (self._syncFetchCache.has(url)) return self._syncFetchCache.get(url);
        let result = null;
        try {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url, false);
          xhr.responseType = 'arraybuffer';
          xhr.send();
          if (xhr.status === 200) result = new Uint8Array(xhr.response);
        } catch (_) {}
        self._syncFetchCache.set(url, result);
        return result;
      },
      onTopLevelWindowDestroyed: (hwnd, destroyed) => {
        if (!self._multiApp || !self.renderer || !self._hwndBase) return;
        const lo = self._hwndBase;
        const hi = lo + 0x10000;
        if (hwnd < lo || hwnd >= hi) return;
        const remainingTopLevel = Object.values(self.renderer.windows).filter(w =>
          w && !w.isChild && w.hwnd >= lo && w.hwnd < hi
        );
        const stillHasTopLevel = WineAssembly.hasRemainingAppWindow(
          destroyed, remainingTopLevel
        );
        // "No windows left" is a guess that the app is finished, not proof:
        // a Win32 app ends when its message loop ends, not when its window
        // count reaches zero. Funtris opens on a modal splash and only builds
        // its game window once that is dismissed, so stopping the instant the
        // splash closed killed it in between. Give the guest a short grace
        // period to put another top-level window up; _checkLastWindowStop
        // finishes the teardown if it does not.
        if (!stillHasTopLevel) self._lastWindowStopAt = Date.now() + 750;
        else self._lastWindowStopAt = 0;
      },
      onExit: (code) => {
        self.stop({ repaint: false });
        if (self.renderer) {
          if (self._multiApp) {
            self._removeAppWindows();
          } else {
            self.renderer._exited = true;
            self.renderer.windows = {};
          }
          self.renderer.repaint();
        }
      },
    };
    if (!opts.detached) {
      self._helpCtx = ctx;
      self.hostCtx = ctx;
    }
    const base = createHostImports(ctx);
    ctx.sharedGdi = base.gdi;
    const h = base.host;
    const traceApiNames = (typeof window !== 'undefined' && window.__waTraceApiNames)
      ? window.__waTraceApiNames
      : null;
    let lastTraceApi = false;

    // --- Browser-specific overrides ---
    h.log = (ptr, len) => {
      let text = '';
      if (self.verbose || (traceApiNames && traceApiNames.size)) {
        const view = new Uint8Array(self.memory.buffer, ptr, Math.min(len, 256));
        text = new TextDecoder().decode(new Uint8Array(view));
      }
      lastTraceApi = false;
      if (traceApiNames && traceApiNames.size) {
        const apiName = text.replace(/\0.*$/, '');
        if (traceApiNames.has(apiName)) {
          lastTraceApi = true;
          console.log(`[API] ${apiName}`);
        }
      }
      if (self.verbose) {
        console.log('[wine-asm]', text);
        self.logToUI('[wine-asm] ' + text);
      }
    };
    h.log_i32 = (val) => {
      if (lastTraceApi) console.log(`  => 0x${(val >>> 0).toString(16)}`);
      if (self.verbose) {
        console.log('[wine-asm] i32:', '0x' + (val >>> 0).toString(16));
        self.logToUI('[wine-asm] i32: 0x' + (val >>> 0).toString(16));
      }
    };
    h.log_eip = (eip) => {
      if (typeof window !== 'undefined' && typeof window.__waProfileEipHit === 'function') {
        window.__waProfileEipHit(eip >>> 0, 0);
      }
    };
    h.get_ticks = () => self._guestTickMs(sharedAudio);
    // Browser-only Open/Save common-dialog hooks. has_dom returns 1 so
    // $create_open_dialog renders the Upload / Download button.
    h.has_dom = () => 1;
    h.pick_file_upload = (dlgHwnd, destDirWa) => {
      // Native <input type="file"> picker. On selection, write the file
      // bytes into the VFS at "<destDir>\<picked.name>", then call the
      // opendlg_refresh_listbox export so WAT repopulates the listbox.
      const destDir = self.readString(destDirWa) || 'C:\\';
      const input = document.createElement('input');
      input.type = 'file';
      input.style.display = 'none';
      input.onchange = async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const buf = new Uint8Array(await file.arrayBuffer());
        const vfs = self._helpCtx && self._helpCtx.vfs;
        if (vfs) {
          const fullPath = destDir.replace(/\\$/, '') + '\\' + file.name;
          vfs.files.set(fullPath.toLowerCase(), { data: buf, attrs: 0x20 });
          console.log(`[upload] wrote ${fullPath} (${buf.length} bytes)`);
        }
        if (self.instance.exports.opendlg_refresh_listbox) {
          self.instance.exports.opendlg_refresh_listbox(dlgHwnd);
          if (self.renderer) self.renderer.invalidate(dlgHwnd);
        }
        document.body.removeChild(input);
      };
      document.body.appendChild(input);
      input.click();
    };
    h.file_download = (pathWa) => {
      const path = self.readString(pathWa);
      if (!path) return;
      const vfs = self._helpCtx && self._helpCtx.vfs;
      if (!vfs) return;
      const entry = vfs.files.get(path.toLowerCase());
      if (!entry) {
        console.log(`[download] no file at ${path}`);
        return;
      }
      const blob = new Blob([entry.data], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = path.replace(/^.*\\/, '');
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
      console.log(`[download] ${path} (${entry.data.length} bytes)`);
    };
    // The About dialog is built entirely in WAT by $create_about_dialog
    // (see src/09a-handlers.wat:$handle_ShellAboutA). This host import
    // only logs; matches lib/host-imports.js signature.
    h.shell_about = (dlgHwnd, ownerHwnd, appPtr) => {
      const appName = self.readString(appPtr);
      console.log(`[ShellAbout] dlg=0x${dlgHwnd.toString(16)} owner=0x${ownerHwnd.toString(16)} "${appName}"`);
      self.logToUI(`[ShellAbout] ${appName}`);
      return 1;
    };
    h.message_box = (hWnd, textPtr, captionPtr, uType) => {
      const text = self.readString(textPtr);
      const caption = self.readString(captionPtr);
      console.log(`[MessageBox] "${caption}": "${text}"`);
      self.logToUI(`[MessageBox] ${caption}: ${text}`);
      return 1;
    };
    h.exit = (code) => {
      console.log('[ExitProcess] code:', code);
      if (!self._inDllInit) {
        self.logToUI('[ExitProcess] code: ' + code);
        self.logToUI('--- Program exited ---');
        self.stop({ repaint: false });
        if (self.renderer) {
          if (self._multiApp) {
            self._removeAppWindows();
          } else {
            self.renderer._exited = true;
            self.renderer.windows = {};
          }
          self.renderer.repaint();
        }
      }
    };
    h.create_window = (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
      const title = self.readString(titlePtr);
      ctx.recordWindowText(hwnd, title);
      if (self.verbose) console.log(`[CreateWindow] hwnd=0x${hwnd.toString(16)} title="${title}" menu=${menuId} pos=${x},${y} size=${cx}x${cy}`);
      self.logToUI(`[CreateWindow] "${title}"`);
      const ownerInstance = ctx.instance || self.instance;
      if (self.renderer) {
        self.renderer.createWindow(hwnd, style, x, y, cx, cy, title, menuId, ownerInstance, self.memory);
        const win = self.renderer.windows && self.renderer.windows[hwnd];
        if (win) win.processId = self.processId;
      }
      return hwnd;
    };
    h.dialog_loaded = (hwnd, parentHwnd) => {
      if (self.verbose) console.log(`[CreateDialog] hwnd=0x${hwnd.toString(16)} parent=0x${parentHwnd.toString(16)}`);
      const ownerInstance = ctx.instance || self.instance;
      if (self.renderer) {
        self.renderer.createDialog(hwnd, parentHwnd, ownerInstance, self.memory);
        const win = self.renderer.windows && self.renderer.windows[hwnd];
        if (win) win.processId = self.processId;
      }
    };

    h.set_window_text = (hwnd, textPtr) => {
      const text = self.readString(textPtr);
      ctx.recordWindowText(hwnd, text);
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
      const clearInactiveInput = () => {
        self._lastInputEvent = null;
        self.renderer._activeInputEvent = null;
      };
      // In multi-app mode, only dequeue events for this app's hwnd range
      let evt;
      if (self._hwndBase && self._multiApp) {
        const lo = self._hwndBase;
        const hi = lo + 0x10000;
        const q = self.renderer.inputQueue;
        const idx = q.findIndex(e => !e.hwnd || (e.hwnd >= lo && e.hwnd < hi));
        if (idx < 0) {
          if (q.length === 0) clearInactiveInput();
          return 0;
        }
        evt = q.splice(idx, 1)[0];
      } else {
        const q = self.renderer.inputQueue;
        const ownerInstance = ctx.instance || self.instance;
        const ownsEvent = (e) => {
          if (!ownerInstance || !e || !e.hwnd) return true;
          const win = self.renderer.windows && self.renderer.windows[e.hwnd];
          return !win || !win.wasm || win.wasm === ownerInstance;
        };
        const idx = q.findIndex(ownsEvent);
        if (idx < 0) {
          if (q.length === 0) clearInactiveInput();
          return 0;
        }
        evt = q.splice(idx, 1)[0];
        if (evt && (evt.msg === 0x0100 || evt.msg === 0x0102 || evt.msg === 0x0104)) {
          self.renderer._profileMark && self.renderer._profileMark('input-queue-dispatch', { msg: evt.msg, wParam: evt.wParam });
        }
        if (evt && evt.msg === 0x000F) self.renderer.scheduleRepaint();
        if (evt && (evt.msg === 0x0100 || evt.msg === 0x0104)) {
          if (!self.renderer._asyncKeys) self.renderer._asyncKeys = Object.create(null);
          self.renderer._asyncKeys[evt.wParam & 0xFF] = true;
        } else if (evt && (evt.msg === 0x0101 || evt.msg === 0x0105)) {
          if (self.renderer._asyncKeys) self.renderer._asyncKeys[evt.wParam & 0xFF] = false;
        }
      }
      if (!evt) {
        clearInactiveInput();
        return 0;
      }
      self._lastInputEvent = evt;
      self.renderer._activeInputEvent = evt;
      if (evt.msg !== 0x200) {
        self.logToUI('[input] hwnd=0x' + (evt.hwnd >>> 0).toString(16) + ' msg=0x' + evt.msg.toString(16) + ' wParam=0x' + evt.wParam.toString(16));
      }
      return (evt.wParam << 16) | (evt.msg & 0xFFFF);
    };
    h.check_input_lparam = () => {
      return self._lastInputEvent ? (self._lastInputEvent.lParam | 0) : 0;
    };
    h.check_input_hwnd = () => {
      const evt = self._lastInputEvent;
      if (!evt) return 0;
      if (evt.hwnd) return evt.hwnd | 0;
      // Browser key events are queued without a target HWND. Route them to
      // the guest focus owner just like the CLI harness; otherwise GetMessage
      // substitutes main_hwnd and native child controls such as WordPad's
      // RichEdit20A never receive WM_KEYDOWN/WM_CHAR.
      if (evt.msg >= 0x0100 && evt.msg <= 0x0108) {
        const exports = self.instance && self.instance.exports;
        if (exports && exports.get_focus_hwnd) {
          const focus = exports.get_focus_hwnd() | 0;
          if (focus) return focus;
        }
      }
      return 0;
    };

    // Wire thread/event imports to ThreadManager
    h.create_thread = (s, p, sz, flags) => self.threadManager ? self.threadManager.createThread(s, p, sz, flags) : 0;
    h.suspend_thread = (handle) => self.threadManager ? self.threadManager.suspendThread(handle) : 0xFFFFFFFF;
    h.resume_thread = (handle) => self.threadManager ? self.threadManager.resumeThread(handle) : 0xFFFFFFFF;
    h.exit_thread = (c) => self.threadManager && self.threadManager.exitThread(c);
    h.get_exit_code_thread = (handle) => self.threadManager ? self.threadManager.getExitCodeThread(handle) : 0x103;
    h.create_event = (m, i) => self.threadManager ? self.threadManager.createEvent(m, i) : 0;
    h.set_event = (handle) => self.threadManager ? self.threadManager.setEvent(handle) : 1;
    h.reset_event = (handle) => self.threadManager ? self.threadManager.resetEvent(handle) : 1;
    h.wait_single = (handle, t) => {
      if (!self.threadManager) return 0;
      const e = ctx.exports;
      const nestedSyncMessage = !!(e && e.get_sync_msg_depth && (e.get_sync_msg_depth() | 0));
      return nestedSyncMessage
        ? self.threadManager.waitSingleCooperative(handle, t)
        : self.threadManager.waitSingle(handle, t);
    };
    h.wait_multiple = (n, ha, wa, t) => self.threadManager ? self.threadManager.waitMultiple(n, ha, wa, t) : 0;
    h.create_semaphore = (initial, max) => self.threadManager ? self.threadManager.createSemaphore(initial, max) : 0;
    h.release_semaphore = (handle, count, prev) => self.threadManager ? self.threadManager.releaseSemaphore(handle, count, prev) : 0;

    // Memory is set later in init()
    h.memory = null;

    return { host: h, gdi: base.gdi };
  }

  // Every non-mousemove input event, every CreateWindow/SetWindowText and the
  // per-slice heartbeat come through here. `el.textContent += msg` re-serializes
  // the entire accumulated log and forces a layout on each call, so a long
  // session got steadily slower at exactly the moments the user was interacting.
  // Appending a text node is O(1), and the ring keeps the DOM bounded.
  logToUI(msg) {
    console.log(msg);
    const el = document.getElementById('log');
    if (!el) return;
    el.appendChild(document.createTextNode(msg + '\n'));
    const MAX_LOG_NODES = 2000;
    while (el.childNodes.length > MAX_LOG_NODES) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
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

  async ensureUiFontsReady() {
    if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return;
    const loads = [
      document.fonts.load('11px "W95FA"'),
      document.fonts.load('bold 11px "W95FA"'),
      document.fonts.load('12px "W95FA"'),
    ];
    if (document.fonts.ready) loads.push(document.fonts.ready);
    try {
      await Promise.race([
        Promise.all(loads),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
    } catch (_) {}
  }

  async init(canvas) {
    const compileEl = typeof document !== 'undefined' && document.getElementById('compile-status');
    let showTimeout = null;
    const cacheWarm = !!WineAssembly._wasmModulePromise;
    if (compileEl && !cacheWarm) {
      showTimeout = setTimeout(() => {
        compileEl.style.display = 'block';
      }, 100);
    }
    const fontsReady = this.ensureUiFontsReady();
    const wasmReady = WineAssembly.getWasmModule();
    const apiTableReady = !this.apiTable ? (async () => {
      try {
        const r = await fetch(`src/api_table.json?v=${WineAssembly.SOURCE_VERSION}`);
        this.apiTable = await r.json();
      } catch (e) {
        console.warn('[host] failed to load api_table.json:', e);
        this.apiTable = [];
      }
    })() : Promise.resolve();
    const [, wasmModule] = await Promise.all([fontsReady, wasmReady, apiTableReady]);
    if (showTimeout) clearTimeout(showTimeout);
    if (compileEl) compileEl.style.display = 'none';
    // Load api_table.json so resolve_ordinal can map ordinal imports (e.g.
    // COMCTL32#17 -> InitCommonControls) to real handler IDs. Without this
    // every ordinal call crashes as "<ord> unimplemented".
    const imports = this.getImports();

    // Make deterministic Wine/ANAKRON bitmap stock fonts available before
    // guest code can issue its first GDI text call. WAT installs each FON lazily.
    await this.loadFiles([
      {
        url: 'fonts/System.fon',
        vfsPath: 'c:\\windows\\fonts\\system.fon',
      },
      {
        url: 'fonts/MSSansSerif.fon',
        vfsPath: 'c:\\windows\\fonts\\mssansserif.fon',
      },
      {
        url: 'fonts/Fixedsys.fon',
        vfsPath: 'c:\\windows\\fonts\\fixedsys.fon',
      },
      {
        url: 'fonts/Courier.fon',
        vfsPath: 'c:\\windows\\fonts\\courier.fon',
      },
      {
        url: 'fonts/Terminal.fon',
        vfsPath: 'c:\\windows\\fonts\\terminal.fon',
      },
    ], { required: true });

    // Scalable faces mount under the filenames a real C:\WINDOWS\FONTS had, so
    // WAT opens ARIAL.TTF the way Win98 GDI did and never learns that
    // Liberation Sans is what answers. Without these the WAT TrueType
    // rasterizer has nothing to rasterize and every scalable face silently
    // falls back to Canvas - which still draws text, in whatever the host
    // machine happens to have, at whatever metrics it happens to use.
    await this.loadSubstituteFonts();

    // Create shared memory externally
    this.memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
    imports.host.memory = this.memory;

    this.instance = await WebAssembly.instantiate(wasmModule, imports);
    if (this.instance.exports.set_process_id) {
      this.instance.exports.set_process_id(this.processId);
    }
    this._wasmModule = wasmModule;
    if (this.renderer) {
      this.renderer.wasm = this.instance;
      this.renderer.wasmMemory = this.memory;
      this.renderer.mainWasm = this.instance;
      this.renderer.mainWasmMemory = this.memory;
    }

    // Create ThreadManager
    const self = this;
    const makeWorkerImports = (tid) => {
      const mainCtx = self.hostCtx || self._helpCtx || {};
      const traceApiNames = (typeof window !== 'undefined' && window.__waTraceApiNames)
        ? window.__waTraceApiNames
        : null;
      let lastTraceApi = false;
      let workerInstance = null;
      const wi = self.getImports({
        detached: true,
        instance: () => workerInstance || self.instance,
        exports: () => workerInstance ? workerInstance.exports : self.instance.exports,
        vfs: mainCtx.vfs,
        sharedGdi: mainCtx.sharedGdi,
        sharedAudio: mainCtx.sharedAudio,
        sharedMixer: mainCtx.sharedMixer,
        vlanWire: mainCtx.vlanWire,  // one wire per process, shared by every thread
        threadId: tid,
      });
      wi.__setInstance = (instance) => { workerInstance = instance; };
      wi.host.memory = self.memory;
      const markAudioThread = () => {
        if (self.threadManager && self.threadManager.markAudioThread) {
          self.threadManager.markAudioThread(tid, 1500);
        }
      };
      for (const name of [
        'wave_out_open', 'wave_out_write', 'wave_out_schedule_done',
        'wave_out_reset', 'wave_out_close',
        'voice_open', 'voice_write_stream', 'voice_play_ring',
        'voice_stop', 'voice_close',
      ]) {
        const orig = wi.host[name];
        if (typeof orig !== 'function') continue;
        wi.host[name] = (...args) => {
          markAudioThread();
          return orig(...args);
        };
      }
      wi.host.log = (ptr, len) => {
        lastTraceApi = false;
        if (!traceApiNames || !traceApiNames.size) return;
        const bytes = new Uint8Array(self.memory.buffer, ptr, Math.min(len, 256));
        let text = '';
        for (let i = 0; i < bytes.length && bytes[i]; i++) text += String.fromCharCode(bytes[i]);
        if (traceApiNames.has(text)) {
          lastTraceApi = true;
          console.log(`[API T${tid}] ${text}`);
        }
      };
      wi.host.log_i32 = (val) => {
        if (lastTraceApi) console.log(`  => 0x${(val >>> 0).toString(16)}`);
      };
      wi.host.log_eip = (eip) => {
        if (typeof window !== 'undefined' && typeof window.__waProfileEipHit === 'function') {
          window.__waProfileEipHit(eip >>> 0, tid | 0);
        }
      };
      wi.host.exit = () => {};
      return wi;
    };
    this.threadManager = new ThreadManager(this._wasmModule, this.memory, this.instance, makeWorkerImports, {
      // Opt-in from the debug toolbar. It does not switch schedulers yet —
      // ThreadManager reports which backend it really used.
      threadsRequested: !!(typeof window !== 'undefined' && window.WINE_THREADS),
      hasMessage: () => !!(self.renderer && self.renderer.inputQueue && self.renderer.inputQueue.length),
      now: () => self.renderer && self.renderer._profileNow ? self.renderer._profileNow() : Date.now(),
      onThreadExit: (info) => self._cleanupWinampVisualizerThread(info),
      profileThreadRun: (info) => {
        if (typeof window !== 'undefined' && typeof window.__waProfileThreadRun === 'function') {
          window.__waProfileThreadRun(info);
        }
      },
    });

    // A room address is a property of this whole process, and the guest reads
    // it the moment it opens a socket, so it has to be in place before the
    // program runs rather than when a connection is attempted.
    if (this.vlanLocalIp && this.instance.exports.set_vlan_local_ip) {
      this.instance.exports.set_vlan_local_ip(this.vlanLocalIp | 0);
    }

    if (canvas && !this.renderer) {
      this.renderer = new Win98Renderer(canvas);
    }
  }

  // Join a virtual LAN room before the guest starts. `wire` is any
  // lib/vlan-wire.js endpoint — a LoopbackWire for two instances in one page,
  // an RtcWire for two people in two browsers. `ip` is this process's address
  // inside the room, as a dotted string.
  //
  // Both have to be set before init(): the wire because host imports capture
  // ctx at instantiate time, the address because the guest may bind a socket
  // on its first slice.
  joinVlan(wire, ip) {
    this.vlanWire = wire || null;
    this.vlanLocalIp = WineAssembly.parseRoomAddress(ip);
    if (this.hostCtx) this.hostCtx.vlanWire = this.vlanWire;
    if (this.instance && this.instance.exports.set_vlan_local_ip) {
      this.instance.exports.set_vlan_local_ip(this.vlanLocalIp | 0);
    }
    return this;
  }

  static parseRoomAddress(ip) {
    const octets = String(ip || '').split('.').map(Number);
    if (octets.length !== 4 || octets.some(o => !(o >= 0 && o <= 255))) {
      throw new Error(`joinVlan: not an IPv4 address: ${ip}`);
    }
    return octets.reduce((a, o) => ((a << 8) | o) >>> 0, 0) | 0;
  }

  static getWasmModule() {
    if (!WineAssembly._wasmModulePromise) {
      const attempt = (WineAssembly._wasmCompileAttempt || 0) + 1;
      WineAssembly._wasmCompileAttempt = attempt;
      const modulePromise = (async () => {
        const tailCalls = WineAssembly.supportsWasmTailCalls();
        console.log(`[host] wasm tail calls ${tailCalls ? 'enabled' : 'not available; using compatibility dispatch'}`);
        const forceSourceCompile = typeof location !== 'undefined' &&
          new URLSearchParams(location.search).has('compile-wat');
        if (!forceSourceCompile) {
          const artifact = tailCalls
            ? 'build/wine-assembly.wasm'
            : 'build/wine-assembly.compat.wasm';
          try {
            const response = await fetch(`${artifact}?v=${WineAssembly.SOURCE_VERSION}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await WebAssembly.compile(await response.arrayBuffer());
          } catch (error) {
            console.warn(`[host] unable to load ${artifact}; compiling WAT sources`, error);
          }
        }
        const bytes = await compileWatSnapshot(
          async file => {
            const response = await fetch(`src/${file}?v=${WineAssembly.SOURCE_VERSION}`);
            if (!response.ok) throw new Error(`Unable to load ${file}: HTTP ${response.status}`);
            return response.text();
          },
          { tailCalls, cacheKey: `${WineAssembly.SOURCE_VERSION}:browser:${attempt}` }
        );
        return WebAssembly.compile(bytes);
      })();
      WineAssembly._wasmModulePromise = modulePromise;
      modulePromise.catch(() => {
        // A transient source update must not poison every later Launch click.
        if (WineAssembly._wasmModulePromise === modulePromise) {
          WineAssembly._wasmModulePromise = null;
        }
      });
    }
    return WineAssembly._wasmModulePromise;
  }

  static supportsWasmTailCalls() {
    if (WineAssembly._supportsWasmTailCalls !== undefined) {
      return WineAssembly._supportsWasmTailCalls;
    }
    // Minimal module:
    // (module (type (func)) (func (type 0) (return_call 1)) (func (type 0)))
    const probe = new Uint8Array([
      0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      0x03, 0x03, 0x02, 0x00, 0x00,
      0x0A, 0x09, 0x02, 0x04, 0x00, 0x12, 0x01, 0x0B, 0x02, 0x00, 0x0B,
    ]);
    let ok = false;
    try {
      ok = typeof WebAssembly !== 'undefined' &&
        typeof WebAssembly.validate === 'function' &&
        WebAssembly.validate(probe);
    } catch (_) {
      ok = false;
    }
    WineAssembly._supportsWasmTailCalls = ok;
    return ok;
  }

  _guestToWasmAddress(addr) {
    const ex = this.instance && this.instance.exports;
    if (!ex || !this.memory || !this.memory.buffer || !ex.get_image_base) return -1;
    const imageBase = ex.get_image_base() >>> 0;
    const guestBase = ex.get_guest_base ? (ex.get_guest_base() >>> 0) : 0x12000;
    return (((addr >>> 0) - imageBase + guestBase) >>> 0);
  }

  // The patch table is lib/app-profiles.js, shared with the CLI harness — it
  // used to be a second hand-copy here, so a patch added on one side never
  // reached the other.
  _applyExeCompatibilityPatches(exeName) {
    const profiles = (typeof window !== 'undefined' && window.appProfiles) ||
      (typeof appProfiles !== 'undefined' ? appProfiles : null);
    if (!profiles || !this.instance) return;
    profiles.applyExeCompatibilityPatches(
      exeName, this.instance.exports, this.memory && this.memory.buffer);
  }

  async loadExe(url) {
    if (!this.instance) await this.init();

    const resp = await fetch(url);
    const exeBytes = new Uint8Array(await resp.arrayBuffer());
    this._exeBytes = exeBytes;

    // Resource parsing lives in WAT ($find_resource, $dlg_load,
    // $menu_load, $string_load_a, $rsrc_find_data_wa). The JS side no
    // longer pre-parses anything from the EXE bytes.

    // Stage the EXE and load it. The staging clamp and its reasoning live in
    // lib/process-boot.js, shared with the CLI harness.
    const { entry } = ProcessBoot.stageAndLoadPe(
      this.instance.exports, this.memory.buffer, exeBytes);

    const exeName = url.replace(/^.*[\\\/]/, '');
    this._applyExeCompatibilityPatches(exeName);

    // A 16-bit task's DLLs go into the same selector arena its own segments
    // just went into, so this has to follow load_pe and precede its first call
    // into one.
    await this._loadWin16Dlls(url, exeBytes);

    // Initialize DirectX COM vtable thunks (must be after load_pe sets image_base).
    if (this.instance.exports.init_dx_com_thunks) {
      this.instance.exports.init_dx_com_thunks();
    }

    // Set EXE name from URL
    this._exeName = exeName;
    this._exeUrl = url;
    if (this._helpCtx && this._helpCtx.vfs && this._helpCtx.vfs.files) {
      const exeData = new Uint8Array(exeBytes);
      this._helpCtx.vfs.files.set('c:\\app.exe', { data: exeData, attrs: 0x20 });
      this._helpCtx.vfs.files.set('c:\\' + exeName.toLowerCase(), { data: exeData, attrs: 0x20 });
    }
    ProcessBoot.setExeName(this.instance.exports, this.memory.buffer, exeName);

    return entry;
  }

  // Fetch and load the NE DLLs a 16-bit task can ask for. loadWin16Dlls reads
  // files synchronously, so every candidate is fetched first and answered out
  // of a map; a name that 404s is simply absent, exactly as a missing file is
  // for the CLI. Hearts loads CARDS through LoadLibrary rather than importing
  // it, so this cannot be driven by the module-reference table.
  async _loadWin16Dlls(url, exeBytes) {
    const _loadWin16Dlls = (typeof DllLoader !== 'undefined' && DllLoader.loadWin16Dlls) || null;
    const _stageable = (typeof DllLoader !== 'undefined' && DllLoader.win16StageableModules) || null;
    if (!_loadWin16Dlls || !_stageable) return;
    const exports = this.instance.exports;
    if (!exports.load_ne_dll || !exports.is_win16 || !exports.is_win16()) return;

    const dir = url.replace(/[^\\\/]*$/, '');
    const files = new Map();
    await Promise.all(_stageable().flatMap(name =>
      [`${name}.DLL`, `${name}.dll`, `${name}.EXE`].map(async file => {
        if (files.has(name)) return;
        try {
          const resp = await fetch(dir + file);
          if (!resp.ok) return;
          const bytes = new Uint8Array(await resp.arrayBuffer());
          if (!files.has(name)) files.set(name, bytes);
        } catch (_) { /* absent is a valid answer */ }
      })));

    _loadWin16Dlls(exports, this.memory, exeBytes, dir,
      (_dir, name) => files.get(name) || null, (m) => console.log(m));
  }

  // Mount every vendored open font at the Win98 filename it substitutes.
  // fonts/substitutions.json is the same map the CLI harness and the WAT face
  // table read, so the browser cannot end up offering a different set of faces
  // than the tests cover.
  //
  // Deliberately not `required`: a font that fails to fetch costs that one
  // face its exact metrics and drops it to the Canvas fallback, which is a
  // much better outcome than refusing to launch the app.
  async loadSubstituteFonts() {
    if (this._substituteFontsLoaded) return;
    this._substituteFontsLoaded = true;
    const fontMounts = (typeof window !== 'undefined' && window.fontMounts) || null;
    if (!fontMounts) return;
    let manifest;
    try {
      const response = await fetch('fonts/substitutions.json?v=1');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      manifest = await response.json();
    } catch (err) {
      console.warn('font substitutions unavailable, scalable text falls back ' +
        'to Canvas:', err);
      return;
    }
    await this.loadFiles(fontMounts(manifest, { subset: true }).map(mount => ({
      url: 'fonts/' + mount.file,
      vfsPath: mount.vfsPath,
    })), { required: false });
  }

  async loadFiles(urls, options = {}) {
    const vfs = this._helpCtx && this._helpCtx.vfs;
    if (!vfs) return;
    const concurrency = Math.max(1, options.concurrency || 6);
    let loaded = 0, failed = 0, next = 0;
    const total = urls.length;
    const loadOne = async (item) => {
      // Accept plain string (flat -> c:\basename), {url, vfsPath}, or
      // {url, vfsPaths} when one fetched file needs multiple Win32 aliases.
      const url = (typeof item === 'string') ? item : item.url;
      const explicit = (typeof item === 'object') ? item.vfsPath : null;
      const explicitPaths = (typeof item === 'object' && Array.isArray(item.vfsPaths)) ? item.vfsPaths : null;
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          failed++;
          return;
        }
        const data = new Uint8Array(await resp.arrayBuffer());
        const addFile = (rawPath) => {
          let vfsPath = String(rawPath).toLowerCase().replace(/\//g, '\\');
          if (!/^[a-z]:/.test(vfsPath)) vfsPath = 'c:\\' + vfsPath.replace(/^\\+/, '');
          // Also register every parent directory so GetFileAttributes(dir) returns FILE_ATTRIBUTE_DIRECTORY.
          let p = vfsPath;
          while (true) {
            const idx = p.lastIndexOf('\\');
            if (idx <= 2) break;
            p = p.slice(0, idx);
            vfs.dirs.add(p);
          }
          vfs.files.set(vfsPath, { data, attrs: 0x20 });
        };
        if (explicitPaths && explicitPaths.length) {
          for (const p of explicitPaths) addFile(p);
        } else if (explicit) {
          addFile(explicit);
        } else {
          addFile('c:\\' + url.replace(/^.*[\\\/]/, '').toLowerCase());
        }
        loaded++;
      } catch (_) {
        failed++;
      } finally {
        if (options.onProgress) options.onProgress({ loaded, failed, total, url });
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (next < total) {
        const item = urls[next++];
        await loadOne(item);
      }
    });
    await Promise.all(workers);
    if (failed && options.required) {
      throw new Error(`failed to load ${failed} of ${total} data files`);
    }
  }

  async loadDlls(dllPaths) {
    if (!this.instance) return;
    const _loadDlls = (typeof DllLoader !== 'undefined' && DllLoader.loadDlls) || (typeof loadDlls === 'function' && loadDlls);
    if (!_loadDlls) return;
    // dllPaths can be strings (URLs) or {name, bytes} objects
    const rememberDllBytes = (name, bytes) => {
      if (!name || !bytes) return;
      const key = String(name).toLowerCase();
      this._loadedDllBytesByName = this._loadedDllBytesByName || {};
      this._loadedDllBytesByName[key] = bytes;
      const vfs = this._helpCtx && this._helpCtx.vfs;
      if (vfs && vfs.files) {
        vfs.files.set('c:\\' + key, { data: bytes, attrs: 0x20 });
      }
    };
    const configs = await Promise.all(dllPaths.map(async item => {
      if (typeof item === 'string') {
        const resp = await fetch(item);
        if (!resp.ok) { console.error('Failed to fetch DLL:', item); return null; }
        const bytes = new Uint8Array(await resp.arrayBuffer());
        const name = item.split('/').pop();
        rememberDllBytes(name, bytes);
        return { name, bytes };
      }
      if (item && item.name && item.bytes) {
        rememberDllBytes(item.name, item.bytes);
      }
      return item;
    }));
    const readyConfigs = configs.filter(Boolean);
    const exeBytes = this._exeBytes;
    this._inDllInit = true;
    const opts = {};
    if (this._exeName) opts.exeName = this._exeName;
    if (this._extraArgs) opts.extraArgs = this._extraArgs;
    opts.registerDllResources = (dllConfigs, dllResults) => {
      for (let i = 0; i < dllConfigs.length && i < dllResults.length; i++) {
        this._registerDllBitmapResources(dllConfigs[i].name, dllConfigs[i].bytes, dllResults[i].loadAddr);
      }
    };
    const results = _loadDlls(this.instance.exports, this.memory.buffer, exeBytes, readyConfigs, console.log, opts);
    this._inDllInit = false;
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
      const paths = [`binaries/dlls/${fileName}`, `binaries/plugins/${fileName}`, `dlls/${fileName}`];
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
      // Fallback: check VFS for the DLL bytes
      if (!dllBytes && this._helpCtx && this._helpCtx.vfs) {
        const vfs = this._helpCtx.vfs;
        for (const vp of [dllName.toLowerCase(), 'c:\\' + fileName, 'c:\\plugins\\' + fileName]) {
          const entry = vfs.files.get(vp);
          if (entry && entry.data) {
            dllBytes = entry.data;
            console.log(`[COM] Found ${fileName} in VFS (${dllBytes.length} bytes)`);
            break;
          }
        }
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

  _registerDllBitmapResources(name, bytes, loadAddr) {
    const _extractBitmapBytes = (typeof extractBitmapBytes === 'function')
      ? extractBitmapBytes
      : (typeof dibLib !== 'undefined' && dibLib.extractBitmapBytes);
    if (!_extractBitmapBytes) return;
    try {
      const bitmapBytes = _extractBitmapBytes(bytes);
      const count = Object.keys(bitmapBytes).length;
      if (count > 0) {
        this.dllResources = this.dllResources || {};
        this.dllResources[loadAddr] = { bitmapBytes };
        console.log(`DLL resources: ${name} has ${count} bitmaps`);
      }
    } catch (_) {}
  }

  async handleLoadLibrary() {
    const exports = this.instance.exports;
    const _resumeAfterLoadLibraryYield = (typeof DllLoader !== 'undefined' && DllLoader.resumeAfterLoadLibraryYield) || null;
    const nameWA = exports.get_loadlib_name ? exports.get_loadlib_name() : 0;
    if (!nameWA) {
      exports.set_eax && exports.set_eax(0);
      if (_resumeAfterLoadLibraryYield) _resumeAfterLoadLibraryYield(exports, this.memory.buffer);
      exports.clear_yield && exports.clear_yield();
      return;
    }
    const mem = new Uint8Array(this.memory.buffer);
    let dllName = '';
    for (let i = 0; i < 260 && mem[nameWA + i]; i++) {
      dllName += String.fromCharCode(mem[nameWA + i]);
    }
    const fileName = dllName.split('\\').pop().toLowerCase();
    const ctx = this._helpCtx;
    let dllBytes = ctx && ctx.readFile ? ctx.readFile(dllName) : null;
    if (!dllBytes && this._loadedDllBytesByName) {
      dllBytes = this._loadedDllBytesByName[fileName] || null;
    }

    if (!dllBytes) {
      const exeDir = this._exeUrl ? this._exeUrl.replace(/[^\/\\]*$/, '') : '';
      const paths = [
        exeDir ? exeDir + fileName : '',
        `binaries/dlls/${fileName}`,
        `binaries/plugins/${fileName}`,
        `dlls/${fileName}`,
      ].filter(Boolean);
      for (const p of paths) {
        try {
          const resp = await fetch(p);
          if (resp.ok) {
            dllBytes = new Uint8Array(await resp.arrayBuffer());
            break;
          }
        } catch (_) {}
      }
    }

    if (!dllBytes) {
      console.error(`[LoadLibrary] DLL not found: ${fileName}`);
      exports.set_eax && exports.set_eax(0);
      if (_resumeAfterLoadLibraryYield) _resumeAfterLoadLibraryYield(exports, this.memory.buffer);
      exports.clear_yield && exports.clear_yield();
      return;
    }

    const _loadDll = (typeof DllLoader !== 'undefined' && DllLoader.loadDll) || null;
    const _patchDllImports = (typeof DllLoader !== 'undefined' && DllLoader.patchDllImports) || null;
    const _callDllMain = (typeof DllLoader !== 'undefined' && DllLoader.callDllMain) || null;
    if (!_loadDll) {
      exports.set_eax && exports.set_eax(0);
      if (_resumeAfterLoadLibraryYield) _resumeAfterLoadLibraryYield(exports, this.memory.buffer);
      exports.clear_yield && exports.clear_yield();
      return;
    }

    try {
      const result = _loadDll(exports, this.memory.buffer, dllBytes);
      console.log(`[LoadLibrary] ${fileName} loaded at 0x${result.loadAddr.toString(16)}`);
      this._registerDllBitmapResources(fileName, dllBytes, result.loadAddr);
      if (_patchDllImports) {
        _patchDllImports(exports, this.memory.buffer, [{ name: fileName, bytes: dllBytes }], [result], console.log);
      }
      exports.clear_yield && exports.clear_yield();
      if (result.dllMain && _callDllMain) {
        _callDllMain(exports, result.loadAddr, result.dllMain, console.log);
      }
      exports.set_eax && exports.set_eax(result.loadAddr);
      if (_resumeAfterLoadLibraryYield) _resumeAfterLoadLibraryYield(exports, this.memory.buffer);
    } catch (e) {
      console.error('[LoadLibrary] load error:', e);
      exports.set_eax && exports.set_eax(0);
      if (_resumeAfterLoadLibraryYield) _resumeAfterLoadLibraryYield(exports, this.memory.buffer);
    }
    exports.clear_yield && exports.clear_yield();
  }

  // Finish (or cancel) a deferred last-window teardown. Called once per run
  // slice: a replacement top-level window cancels it, and the deadline
  // passing without one completes the stop.
  _checkLastWindowStop() {
    if (!this._lastWindowStopAt) return;
    if (!this.renderer || !this._hwndBase) { this._lastWindowStopAt = 0; return; }
    const lo = this._hwndBase;
    const hi = lo + 0x10000;
    const hasTopLevel = Object.values(this.renderer.windows).some(w =>
      w && !w.isChild && w.hwnd >= lo && w.hwnd < hi
    );
    if (hasTopLevel) { this._lastWindowStopAt = 0; return; }
    if (Date.now() < this._lastWindowStopAt) return;
    this._lastWindowStopAt = 0;
    this.stop({ repaint: false });
  }

  _removeAppWindows() {
    if (!this.renderer || !this._hwndBase) return;
    const lo = this._hwndBase;
    const hi = lo + 0x10000;
    for (const hwnd of Object.keys(this.renderer.windows)) {
      const h = Number(hwnd);
      if (h >= lo && h < hi) {
        delete this.renderer.windows[hwnd];
      }
    }
  }

  _cleanupAudio() {
    if (this.hostCtx && typeof this.hostCtx.stopAudio === 'function') {
      try { this.hostCtx.stopAudio(); } catch (_) {}
    } else if (this._audioCtx) {
      try {
        if (this._audioCtx.close) this._audioCtx.close();
        else if (this._audioCtx.suspend) this._audioCtx.suspend();
      } catch (_) {}
      this._audioCtx = null;
    }
  }

  stop(options = {}) {
    const wasRunning = this.running;
    this.running = false;
    this._cleanupAudio();
    if (this.renderer) {
      if (this._multiApp) {
        this._removeAppWindows();
      } else {
        this.renderer._exited = true;
        this.renderer.windows = {};
      }
      if (options.repaint !== false && this.renderer.repaint) {
        this.renderer.repaint();
      }
    }
    if (wasRunning && typeof this.onStopped === 'function') {
      try { this.onStopped(this); } catch (_) {}
    }
  }

  _audioSchedulerNow() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  _isAudioHot() {
    const shared = this._sharedAudio || (this.hostCtx && this.hostCtx.sharedAudio);
    if (!shared) return false;
    const hotUntil = Number(shared.waveOutHotUntilMs) || 0;
    return hotUntil > this._audioSchedulerNow();
  }

  // Called once per step from the worker-budget calculation, so it used to
  // build a Set and an array and call a WASM export for every instance, on
  // every step, for the whole session. The instance list only changes when a
  // window is created or destroyed, so cache it and rebuild on a window-count
  // change; the exported call itself is cheap and stays exact.
  _hasOpenMenu() {
    const renderer = this.renderer;
    if (!renderer) return false;
    const windows = renderer.windows || {};
    const count = Object.keys(windows).length;
    if (this._menuWasms === undefined || this._menuWasmsWindowCount !== count ||
        this._menuWasmsInstance !== this.instance) {
      const seen = new Set();
      const wasms = [];
      const add = (wasm) => {
        if (wasm && !seen.has(wasm) && wasm.exports && wasm.exports.menu_open_hwnd) {
          seen.add(wasm);
          wasms.push(wasm);
        }
      };
      add(this.instance);
      add(renderer.wasm);
      add(renderer.mainWasm);
      for (const win of Object.values(windows)) add(win && win.wasm);
      this._menuWasms = wasms;
      this._menuWasmsWindowCount = count;
      this._menuWasmsInstance = this.instance;
    }
    for (const wasm of this._menuWasms) {
      try {
        if ((wasm.exports.menu_open_hwnd() >>> 0) !== 0) return true;
      } catch (_) {}
    }
    return false;
  }

  // Schedule the next guest slice.
  //
  // This used to be setTimeout(step, 0). Browsers clamp a *nested* timer to
  // >=4ms once the chain is five deep, and this chain never ends — so the
  // drive loop was capped near 250 slices/s no matter how fast a slice ran.
  // With a p50 step of ~2.3ms that left the main thread idle more than half
  // of every cycle. A MessageChannel port posts an unclamped macrotask: it
  // still yields to input and rAF between slices, it just doesn't wait 4ms to
  // do it. setTimeout stays as the fallback for anything without MessageChannel.
  _scheduleStep(step) {
    if (this._stepPort === undefined) {
      this._stepPort = null;
      if (typeof MessageChannel === 'function') {
        const chan = new MessageChannel();
        chan.port1.onmessage = () => {
          const fn = this._pendingStep;
          this._pendingStep = null;
          if (fn) fn();
        };
        this._stepPort = chan.port2;
      }
    }
    if (this._stepPort) {
      this._pendingStep = step;
      this._stepPort.postMessage(0);
    } else {
      setTimeout(step, 0);
    }
  }

  run(stepsPerSlice = 100000) {
    this.stepsPerSlice = stepsPerSlice;
    this.running = true;
    const self = this;
    const step = async () => {
      if (!self.running) return;
      // Debug-mode HUD seam (lib/perf-hud.js). Null unless the HUD is on, so
      // a normal run pays one property read per step. Phases are timed here
      // rather than sampled from outside because the whole point is knowing
      // *which* part of a long step held the main thread.
      const perf = (typeof window !== 'undefined' && window.WinePerf && window.WinePerf.enabled)
        ? window.WinePerf : null;
      if (perf) perf.stepBegin();
      try {
        const activeStepsPerSlice = Math.max(1000, (self.stepsPerSlice | 0) || stepsPerSlice);
        self._beginGuestTickBatch();
        // Check if main thread is waiting
        const mainThreadWaiting = self.threadManager && self.threadManager.checkMainYield();
        if (mainThreadWaiting) {
          // Main still waiting — just run worker threads
        } else {
          if (self.renderer) {
            self.renderer.wasm = self.instance;
            self.renderer.wasmMemory = self.memory;
            self.renderer.mainWasm = self.instance;
            self.renderer.mainWasmMemory = self.memory;
          }
          const runStart = self.renderer && self.renderer._profileNow ? self.renderer._profileNow() : 0;
          const pageProfile = (typeof window !== 'undefined' && window.__aoeProfile) || null;
          const pageProfileStart = pageProfile && typeof performance !== 'undefined' ? performance.now() : 0;
          if (perf) perf.countSteps(activeStepsPerSlice);
          const perfMainStart = perf ? performance.now() : 0;
          self.instance.exports.run(activeStepsPerSlice);
          if (perf) perf.mark('main', performance.now() - perfMainStart);
          self._checkLastWindowStop();
          // ExitProcess/last-window teardown can stop the app from inside a
          // host callback while the current guest slice still unwinds. Run a
          // final ownership cleanup at the slice boundary so those trailing
          // instructions cannot leave a recreated dialog/frame behind.
          if (!self.running) {
            if (self.renderer && self._multiApp) {
              self._removeAppWindows();
              self.renderer.repaint();
            }
            return;
          }
          if (pageProfileStart && pageProfile && pageProfile.add) {
            const dt = performance.now() - pageProfileStart;
            pageProfile.add('main.runSlice', dt, { steps: activeStepsPerSlice });
            if (pageProfile.frame) pageProfile.frame('main.runSlice', { dtMs: dt, steps: activeStepsPerSlice });
          }
          if (runStart && self.renderer && self.renderer._profileMark) {
            self.renderer._profileMark('wasm-run-slice', {
              steps: activeStepsPerSlice,
              ms: self.renderer._profileNow() - runStart,
            });
          }
          const perfPresentStart = perf ? performance.now() : 0;
          self._dxPresentTick = ((self._dxPresentTick || 0) + 1) & 15;
          if (self._dxPresentTick === 0 && self.hostCtx && self.hostCtx.sharedGdi && self.hostCtx.sharedGdi.presentBestDxOffscreen) {
            self.hostCtx.sharedGdi.presentBestDxOffscreen();
          }
          if (self.renderer && self.renderer.flushRepaint) {
            self.renderer.flushRepaint(true);
          }
          if (perf) perf.mark('present', performance.now() - perfPresentStart);
          self._runSliceCount = (self._runSliceCount || 0) + 1;
          self._runHeartbeat = ((self._runHeartbeat || 0) + 1) & 31;
          if (self.instance && self.instance.exports) {
            const ex = self.instance.exports;
            const windows = self.renderer && self.renderer.windows ? Object.keys(self.renderer.windows).length : 0;
            const shouldLog = windows === 0
              ? (self._runSliceCount <= 64 || (self._runSliceCount & 7) === 0)
              : (self._runSliceCount <= 8 || self._runHeartbeat === 0);
            if (shouldLog) {
              const hex32 = v => (v >>> 0).toString(16).padStart(8, '0');
              const eip = ex.get_eip ? ex.get_eip() >>> 0 : 0;
              const ecx = ex.get_ecx ? ex.get_ecx() >>> 0 : 0;
              const esi = ex.get_esi ? ex.get_esi() >>> 0 : 0;
              const yr = ex.get_yield_reason ? ex.get_yield_reason() >>> 0 : 0;
              self.logToUI(`[run] slice=${self._runSliceCount} eip=0x${hex32(eip)} ecx=0x${hex32(ecx)} esi=0x${hex32(esi)} yield=${yr} windows=${windows}`);
            }
          }
        }
        if (!self.instance.exports.get_eip() && !self.instance.exports.get_yield_reason()) {
          self.logToUI('--- Program exited ---');
          self.stop({ repaint: false });
          if (self.renderer && self._multiApp) {
            self._removeAppWindows();
            self.renderer.repaint();
          }
          return;
        }
        // Handle yield reasons
        const yieldReason = self.instance.exports.get_yield_reason();
        if (yieldReason === 3) {
          await self.handleComDllLoad();
          if (self.running) { self._scheduleStep(step); }
          return;
        }
        if (yieldReason === 8) {
          // net_wait: a blocking socket call parked itself. EIP is still on
          // the thunk, so clearing the yield re-enters the same handler with
          // the same arguments. Rescheduling rather than looping is the whole
          // point — inbound frames arrive on the event loop, so a spin here
          // would starve the delivery this call is waiting for.
          self.instance.exports.clear_yield();
          if (self.instance.exports.vlan_pump) self.instance.exports.vlan_pump();
          if (self.running) { self._scheduleStep(step); }
          return;
        }
        if (yieldReason === 5) {
          await self.handleLoadLibrary();
          if (self.running) { self._scheduleStep(step); }
          return;
        }
        // Spawn and run worker threads
        if (self.threadManager) {
          if (self.threadManager._pendingThreads.length) {
            await self.threadManager.spawnPending();
          }
          if (self.threadManager.hasActiveThreads()) {
            const windowCount = self.renderer && self.renderer.windows ? Object.keys(self.renderer.windows).length : 0;
            const now = self.renderer && self.renderer._profileNow ? self.renderer._profileNow() : Date.now();
            const recentInputWake = self.renderer && self.renderer._recentMessageWakeAt &&
              (now - self.renderer._recentMessageWakeAt) < 120;
            // Visible-window apps can still have compute-heavy UI worker threads.
            // Winamp's About/Credits animation is one of them: too-small worker
            // quanta starve the credits renderer behind the message/present loop.
            // Keep a wall-clock cap for browser responsiveness, but give
            // active workers enough total steps to use that budget.
            const audioHot = self._isAudioHot();
            const menuOpen = self._hasOpenMenu();
            // Recent input used to zero the worker budget outright, so the
            // main thread could deliver the message without competition.
            // That is fine for a click, and catastrophic for a game played
            // with the mouse: pointer moves arrive faster than the 120ms
            // window expires, so the budget never comes back and the thread
            // running the game stops entirely. Blobby measured 0fps while
            // the mouse moved and 36-41fps with this line neutralized.
            // Reserve most of the slice for input instead of all of it.
            const threadBudget = windowCount
              ? (recentInputWake ? Math.max(10000, activeStepsPerSlice >> 2) : activeStepsPerSlice)
              : activeStepsPerSlice;
            const perfThreadStart = perf ? performance.now() : 0;
            if (threadBudget > 0) {
              if (windowCount && self.threadManager.runBudgeted) {
                const quantumSteps = audioHot ? (menuOpen ? 20000 : 10000) : 50000;
                const maxWallMs = audioHot
                  ? (menuOpen ? (mainThreadWaiting ? 8 : 6) : 4)
                  // While input is arriving, workers get a short quantum so
                  // the pointer still feels attached to the cursor — but a
                  // short one, not none.
                  : (recentInputWake ? 6 : (mainThreadWaiting ? 16 : 12));
                const threadStats = self.threadManager.runBudgeted({
                  // Non-audio UI workers should be limited by the wall-clock
                  // budget, not by one nominal interpreter slice. Credits
                  // needs several quanta before it can present its first frame.
                  maxTotalSteps: audioHot ? threadBudget : threadBudget * 4,
                  quantumSteps,
                  maxWallMs,
                  prioritizeAudioThreads: audioHot && !menuOpen,
                  stopIfMessagePending: false,
                });
                // hitDeadline means the worker was cut off by maxWallMs with
                // work still to do — the guest is being throttled by us, not
                // by its own idle loop. That distinction is invisible from
                // the page's frame rate, which stays a perfect 60 either way.
                if (perf && threadStats) {
                  perf.countSteps(threadStats.steps | 0);
                  perf.markThrottled(!!threadStats.hitDeadline);
                }
              } else {
                const sliceStats = self.threadManager.runSlice(threadBudget);
                if (perf && sliceStats) perf.countSteps(sliceStats.steps | 0);
              }
            }
            if (perf) perf.mark('workers', performance.now() - perfThreadStart);
            const perfPresentStart2 = perf ? performance.now() : 0;
            self._dxPresentTick = ((self._dxPresentTick || 0) + 1) & 15;
            if (self._dxPresentTick === 0 && self.hostCtx && self.hostCtx.sharedGdi && self.hostCtx.sharedGdi.presentBestDxOffscreen) {
              self.hostCtx.sharedGdi.presentBestDxOffscreen();
            }
            if (self.renderer && self.renderer.flushRepaint) {
              self.renderer.flushRepaint(true);
            }
            if (perf) perf.mark('present', performance.now() - perfPresentStart2);
          }
        }
      } catch (e) {
        let eip = 0, esp = 0, ebp = 0, yr = 0;
        try { eip = self.instance.exports.get_eip(); } catch {}
        try { esp = self.instance.exports.get_esp(); } catch {}
        try { ebp = self.instance.exports.get_ebp(); } catch {}
        try { yr = self.instance.exports.get_yield_reason(); } catch {}
        const eipHex = '0x' + (eip >>> 0).toString(16).padStart(8, '0');
        const espHex = '0x' + (esp >>> 0).toString(16).padStart(8, '0');
        const ebpHex = '0x' + (ebp >>> 0).toString(16).padStart(8, '0');
        const unimpl = self.hostCtx && self.hostCtx.lastUnimplemented;
        const tag = unimpl ? ` [unimplemented: ${unimpl}]` : '';
        console.error('WASM crash:', e, 'EIP=' + eipHex, 'ESP=' + espHex, 'EBP=' + ebpHex, 'yield=' + yr, tag);
        self.logToUI('ERROR: ' + e.message + ' @ EIP=' + eipHex + ' ESP=' + espHex + ' EBP=' + ebpHex + ' yield=' + yr + tag);
        self.stop({ repaint: false });
        return;
      } finally {
        // Every yield reason returns early from inside the try, so closing
        // the step anywhere else would silently drop those slices — exactly
        // the ones worth seeing, since a DLL load or a net_wait is a step
        // that did something unusual with the main thread.
        if (perf) perf.stepEnd();
      }
      if (self.running) {
        self._scheduleStep(step);
      }
    };
    step();
  }
}
