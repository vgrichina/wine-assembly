// Wine-Assembly: JS host for the WASM x86 interpreter
// Win98Renderer is loaded from lib/renderer.js (included via <script> in index.html)

// The boot steps this host shares with the CLI harness: staging the EXE,
// load_pe, the exe-name/cmdline pokes, and the DLL dependency walk.
// lib/process-boot.js is a classic script loaded ahead of this one.
const ProcessBoot = (typeof window !== 'undefined' && window.processBoot) || null;

class WineAssembly {
  static SOURCE_VERSION = '209';
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
    // [{ name, base }], every image this process has loaded. A guest thread that
    // traps reports a raw EIP, and a raw EIP in a DLL is unreadable — the load
    // address depends on what loaded before it, so the same crash prints a
    // different number every run and matches nothing in any disassembly. With
    // this, the trap says `in_mp3.dll+0x14564`, which tools/disasm_fn.js can be
    // pointed at directly.
    this.moduleMap = [];
    this._wasmModule = null;
    this.stepsPerSlice = 100000;
    this.verbose = false;
    // Some WinMM clients intentionally wait for a timeSetEvent callback while
    // they are not pumping messages. This remains opt-in per app: the normal
    // path still delivers the callback through the guest message loop.
    this.asyncMultimediaTimer = false;
  }

  _pumpMultimediaTimer() {
    const ex = this.instance && this.instance.exports;
    if (!this.asyncMultimediaTimer || !ex || !ex.fire_mm_timer) return 0;
    if (ex.get_eip && !(ex.get_eip() >>> 0)) return 0;
    return ex.fire_mm_timer() | 0;
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

  // The mounted view of a guest path: whatever the launch already put in the
  // VFS, matched by full path, by c:\-rooted path, and finally by basename,
  // because a guest names a file however its own code spelled it.
  _vfsLookup(name, instanceVfs) {
    const baseName = String(name).replace(/^.*[\\\/]/, '');
    const lowerName = String(name).toLowerCase().replace(/\//g, '\\');
    const lowerBase = baseName.toLowerCase();
    const vfs = instanceVfs || (this._helpCtx && this._helpCtx.vfs);
    if (!vfs || !vfs.files) return null;
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
    return null;
  }

  // Fetch a file the launch did not mount, off the main thread, and mount it
  // so every later read is a plain VFS hit. Both outcomes are remembered:
  // an app that probes the same missing name in a loop costs one request, not
  // one per probe, and a 404 is remembered as a 404.
  _fetchMissingFile(name, instanceVfs) {
    const baseName = String(name).replace(/^.*[\\\/]/, '');
    if (!this._missingFetches) this._missingFetches = new Map();
    const exeDir = this._exeUrl ? this._exeUrl.replace(/[^\/\\]*$/, '') : '';
    const url = exeDir ? exeDir + baseName : 'binaries/' + baseName;
    const pending = this._missingFetches.get(url);
    if (pending) return pending;
    const p = fetch(url)
      .then(r => (r.ok ? r.arrayBuffer() : null))
      .then(buf => {
        if (!buf) return null;
        const data = new Uint8Array(buf);
        const vfs = instanceVfs || (this._helpCtx && this._helpCtx.vfs);
        if (vfs && vfs.files) {
          vfs.files.set('c:\\' + baseName.toLowerCase(), { data, attrs: 0x20 });
        }
        return data;
      })
      .catch(() => null);
    this._missingFetches.set(url, p);
    return p;
  }

  // Per-app thread-exit fixups (Winamp's visualizer bookkeeping) live in
  // lib/app-profiles.js, so the CLI harness runs the same ones.
  _onThreadExit(info) {
    const profiles = (typeof window !== 'undefined' && window.appProfiles) || null;
    if (!profiles || !this.instance || !this.memory) return;
    profiles.onThreadExit(
      this._exeName, info, this.instance.exports, this.memory.buffer);
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
      // A 16-bit LoadLibrary for a module nothing imports statically: the
      // Entertainment Pack's WEPUTIL, or the per-level DLL Stones ships one of
      // per screen. WAT has already given the name a module id and wants the
      // bytes in that id's staging slot before it returns, and the page cannot
      // fetch anything synchronously — so the app's registry entry names these
      // and loadExe has them in hand before the guest runs.
      win16StageModule: (name, id) => self._stageWin16Module(name, id),
      readFile: (name) => self._vfsLookup(name, ctx.vfs),
      // A miss is a file the app's registry entry never listed, so the page
      // never mounted it. It used to be read with a *synchronous*
      // XMLHttpRequest, which froze the tab for a whole network round trip
      // and was invisible to the perf HUD's phase marks. Nothing that reads
      // through here needs the bytes in the same turn: the two callers are a
      // wallpaper set and an MCI open, and MCI is allowed to still be
      // spinning a device up when open returns. So the miss now starts an
      // async fetch and the caller applies the bytes when they land.
      readFileAsync: (name) => {
        const have = self._vfsLookup(name, ctx.vfs);
        if (have) return Promise.resolve(have);
        return self._fetchMissingFile(name, ctx.vfs);
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
      // Which queued events are this instance's to take. In multi-app mode
      // that is its own hwnd range; otherwise it is any window this WASM
      // instance owns. An event with no hwnd belongs to whoever asks first.
      // The dequeue itself, and the async-key/repaint bookkeeping that has to
      // follow it, live in the renderer (renderer-input.js takeInput) -- this
      // used to be a second transcription of them that had already lost the
      // GetAsyncKeyState press bit.
      const ownerInstance = ctx.instance || self.instance;
      const owns = (self._hwndBase && self._multiApp)
        ? (e) => !e.hwnd || (e.hwnd >= self._hwndBase && e.hwnd < self._hwndBase + 0x10000)
        : (e) => {
          if (!ownerInstance || !e || !e.hwnd) return true;
          const win = self.renderer.windows && self.renderer.windows[e.hwnd];
          return !win || !win.wasm || win.wasm === ownerInstance;
        };
      const evt = self.renderer.takeInput(owns);
      if (!evt) {
        if (self.renderer.inputQueue.length === 0) clearInactiveInput();
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
      // The routing rule itself is shared with the CLI (lib/host-window.js).
      return inputEventHwnd(evt, self.instance && self.instance.exports);
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
      // The cooperative variant exists to run OTHER guest threads from inside a
      // nested synchronous callback, on this thread. With the worker backend
      // there is nothing to run here — the other threads are already running,
      // somewhere else — and its runSlice would walk thread records that have a
      // Worker where it expects an instance.
      const nestedSyncMessage = self.threadManager.backend !== 'worker'
        && !!(e && e.get_sync_msg_depth && (e.get_sync_msg_depth() | 0));
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
    // Kept so an experimental guest worker can be handed the SAME host import
    // table this instance uses — the point of the broker is that there is one
    // implementation of every host call, not two.
    this._mainImports = imports;
    await this._maybeStartGuestWorker(wasmModule);
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
      let workerInstance = null;
      // The filesystem, the LAN wire, the GDI table and the audio device all
      // belong to the process rather than to a thread, and which ones those
      // are is stated once in lib/worker-imports.js so this host and the CLI
      // cannot quietly disagree. The rest of the options are per-thread by
      // nature: this worker's own instance, and its id.
      const wi = self.getImports(Object.assign(processSharedCtx(mainCtx), {
        detached: true,
        instance: () => workerInstance || self.instance,
        exports: () => workerInstance ? workerInstance.exports : self.instance.exports,
        threadId: tid,
      }));
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
      // Shared decode and the "the return belongs to the call just logged"
      // latch; what stays here is this host's own policy — trace only the
      // names the debug toolbar asked for, and print nothing when it asked for
      // none.
      const workerApiLog = makeWorkerApiLogger({
        getBuffer: () => self.memory.buffer,
        threadId: tid,
        shouldLog: (name) => !!(traceApiNames && traceApiNames.size && traceApiNames.has(name)),
        emit: (line) => console.log(line),
      });
      wi.host.log = workerApiLog.log;
      wi.host.log_i32 = workerApiLog.log_i32;
      wi.host.log_eip = (eip) => {
        if (typeof window !== 'undefined' && typeof window.__waProfileEipHit === 'function') {
          window.__waProfileEipHit(eip >>> 0, tid | 0);
        }
      };
      wi.host.exit = () => {};
      return wi;
    };
    this.threadManager = new ThreadManager(this._wasmModule, this.memory, this.instance, makeWorkerImports, {
      // Opt-in from the debug toolbar. Passing the guest-worker host is what
      // actually switches schedulers: with it, each CreateThread becomes a real
      // Worker; without it (no isolation, CLI, Safari private) ThreadManager runs
      // the cooperative one and says so.
      workerBackend: this.guestWorker || null,
      threadsRequested: !!(typeof window !== 'undefined' && window.WINE_THREADS),
      // So a trapped thread's EIP prints as a module and an offset. In worker
      // mode a DLL's load address depends on load order, so the raw number is
      // different every run and matches nothing in a disassembly.
      describeAddr: (addr) => self.describeAddr(addr),
      hasMessage: () => !!(self.renderer && self.renderer.inputQueue && self.renderer.inputQueue.length),
      now: () => self.renderer && self.renderer._profileNow ? self.renderer._profileNow() : Date.now(),
      resolveThreadSendExternalYield: async (link, r) => {
        if (r.yield === 3) await self._handleComDllLoadThreaded(link);
        else if (r.yield === 5) await self._handleLoadLibraryThreaded(link);
        else return false;
        return true;
      },
      onThreadExit: (info) => self._onThreadExit(info),
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

  // EXPERIMENTAL: run the guest's main thread in a Worker.
  //
  // Only when the page asked for it AND the document is cross-origin isolated,
  // because a shared WebAssembly.Memory cannot reach a Worker otherwise. Any
  // failure here falls back to the normal single-threaded path rather than
  // taking the launch down with it — single-threaded is a supported mode, not a
  // degraded one (docs/design-real-threads.md §3.6).
  async _maybeStartGuestWorker(wasmModule) {
    if (typeof window === 'undefined') return;
    if (!window.WINE_THREADS) return;
    if (!(typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated)) {
      this.logToUI('[threads] not cross-origin isolated — running single-threaded');
      return;
    }
    if (typeof GuestThreadHost !== 'function') {
      this.logToUI('[threads] lib/guest-thread-host.js not loaded — running single-threaded');
      return;
    }
    try {
      const res = await fetch('lib/host-import-sigs.generated.json');
      if (!res.ok) throw new Error(`sigs HTTP ${res.status}`);
      const sigs = (await res.json()).sigs;
      const self = this;
      const worker = new GuestThreadHost({
        memory: this.memory,
        module: wasmModule,
        sigs,
        hostImports: this._mainImports.host,
        workerUrl: 'lib/guest-worker.js?v=4',
        log: msg => { console.log(msg); self.logToUI(msg); },
        tickMs: () => self._guestTickMs(self.hostCtx && self.hostCtx.sharedAudio),
      });
      await worker.start();
      this.guestWorker = worker;
      this.logToUI('[threads] guest main thread is running in a Worker (experimental)');
    } catch (err) {
      this.guestWorker = null;
      this.logToUI(`[threads] worker start failed (${err.message}) — running single-threaded`);
    }
  }

  // `opts.win16Modules` names NE DLLs the task loads by name at runtime rather
  // than importing — see the win16StageModule host import.
  async loadExe(url, opts = {}) {
    if (!this.instance) await this.init();
    this._win16ExtraModules = opts.win16Modules || [];

    const resp = await fetch(url);
    const exeBytes = new Uint8Array(await resp.arrayBuffer());
    this._exeBytes = exeBytes;

    // Resource parsing lives in WAT ($find_resource, $dlg_load,
    // $menu_load, $string_load_a, $rsrc_find_data_wa). The JS side no
    // longer pre-parses anything from the EXE bytes.

    // Load PE. In worker mode the guest instance lives in the Worker, so the
    // loader runs there — the bytes are already in shared memory, only the call
    // is marshalled. The idle main-thread instance is then brought up with the
    // same PE metadata via init_thread, because a handful of host-import paths
    // read image_base off it (SEH and callstack formatting) and would otherwise
    // translate every guest address against zero.
    let entry;
    if (this.guestWorker) {
      entry = await this.guestWorker.loadPe(exeBytes, url.replace(/^.*[\\\/]/, ''), this.processId);
      const meta = await this.guestWorker.readExports([
        'get_image_base', 'get_code_start', 'get_code_end',
        'get_thunk_base', 'get_thunk_end', 'get_num_thunks',
      ]);
      if (this.instance.exports.init_thread && meta.get_image_base) {
        // tid 7 is the last worker slot; this instance never executes guest
        // code, so its decoded-cache partition is irrelevant — only its globals
        // matter.
        this.instance.exports.init_thread(7, meta.get_image_base, meta.get_code_start,
          meta.get_code_end, meta.get_thunk_base, meta.get_thunk_end, meta.get_num_thunks);
      }
    } else {
      // The staging clamp and its reasoning live in lib/process-boot.js,
      // shared with the CLI harness.
      ({ entry } = ProcessBoot.stageAndLoadPe(
        this.instance.exports, this.memory.buffer, exeBytes));
    }

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
    if (this._helpCtx && this._helpCtx.vfs) {
      VfsSeed.seedExeImage(this._helpCtx.vfs, exeBytes, exeName);
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
    const candidates = [...new Set([...(_stageable(exeBytes) || []),
                                    ...(this._win16ExtraModules || [])])];
    await Promise.all(candidates.flatMap(name =>
      VfsSeed.win16FileCandidates(name).map(async file => {
        if (files.has(name)) return;
        try {
          const resp = await fetch(dir + file);
          if (!resp.ok) return;
          const bytes = new Uint8Array(await resp.arrayBuffer());
          if (!files.has(name)) files.set(name, bytes);
        } catch (_) { /* absent is a valid answer */ }
      })));
    // Keyed uppercase, because the name a LoadLibrary arrives with is whatever
    // the app typed and the name fetched here is whatever the registry says.
    this._win16Modules = new Map(
      [...files].map(([name, bytes]) => [name.toUpperCase(), bytes]));

    _loadWin16Dlls(exports, this.memory, exeBytes, dir,
      (_dir, name) => files.get(name) || null, (m) => console.log(m));
  }

  // Answer a 16-bit LoadLibrary for a module nothing imported, out of what
  // _loadWin16Dlls fetched. False is a LoadLibrary failure, not an error.
  _stageWin16Module(name, id) {
    const bytes = this._win16Modules && this._win16Modules.get(String(name).toUpperCase());
    const exports = this.instance && this.instance.exports;
    if (!bytes || !exports || !exports.win16_dll_staging) return false;
    new Uint8Array(this.memory.buffer).set(bytes, exports.win16_dll_staging(id));
    return true;
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
        // A font an app ships was put in the Windows font directory by its
        // installer on a real machine, and that is the only reason an app
        // like Age of Empires can name "Copperplate Gothic Light" without
        // ever calling AddFontResource. Mount it there too, and let it win
        // over a vendored substitute already at that name: the app ships the
        // real face its artwork was laid out against, so its ARIAL.TTF beats
        // Liberation Sans standing in for one. Text stays identical on every
        // machine either way - the bytes come from the app, not the host.
        const base = url.replace(/^.*[\\\/]/, '').toLowerCase();
        if (/\.(ttf|ttc|fon)$/.test(base)) {
          addFile('c:\\windows\\fonts\\' + base);
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
    let results;
    if (this.guestWorker) {
      // Guest execution (DllMain runs) must happen on the thread that owns the
      // instance. registerDllResources stays here: it is host bookkeeping over
      // bytes this thread already has.
      const register = opts.registerDllResources;
      delete opts.registerDllResources;
      results = await this.guestWorker.loadDlls(readyConfigs, exeBytes, opts);
      if (register) register(readyConfigs, results);
    } else {
      results = _loadDlls(this.instance.exports, this.memory.buffer, exeBytes, readyConfigs, console.log, opts);
    }
    this._inDllInit = false;
    this.running = true;
  }

  // Where a DLL the guest asks for at runtime comes from in the browser: the
  // VFS the app mounted, whatever was already fetched for it, then the served
  // directories. The CLI answers the same question against the filesystem —
  // the yield pumps themselves are shared (lib/process-boot.js).
  async _findDllBytes(fileName, fullName, { exeDir = false, vfsPaths = null } = {}) {
    const ctx = this._helpCtx;
    if (ctx && ctx.readFile) {
      const fromVfs = ctx.readFile(fullName);
      if (fromVfs) return fromVfs;
    }
    if (ctx && ctx.vfs && vfsPaths) {
      for (const vp of vfsPaths) {
        const entry = ctx.vfs.files.get(vp);
        if (entry && entry.data) return entry.data;
      }
    }
    if (this._loadedDllBytesByName && this._loadedDllBytesByName[fileName]) {
      return this._loadedDllBytesByName[fileName];
    }
    const dir = exeDir && this._exeUrl ? this._exeUrl.replace(/[^\/\\]*$/, '') : '';
    const paths = [
      dir ? dir + fileName : '',
      `binaries/dlls/${fileName}`,
      `binaries/plugins/${fileName}`,
      `dlls/${fileName}`,
    ].filter(Boolean);
    for (const p of paths) {
      try {
        const resp = await fetch(p);
        if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
      } catch (_) {}
    }
    return null;
  }

  async handleComDllLoad() {
    await ProcessBoot.handleComDllYield({
      exports: this.instance.exports,
      memoryBuffer: this.memory.buffer,
      exeBytes: this._exeBytes || null,
      resourceHost: this,
      log: console.log,
      findDll: (fileName, fullName) => this._findDllBytes(fileName, fullName, {
        vfsPaths: [fullName.toLowerCase(), 'c:\\' + fileName, 'c:\\plugins\\' + fileName],
      }),
    });
  }

  _registerDllBitmapResources(name, bytes, loadAddr) {
    ProcessBoot.registerDllBitmaps(this, name, bytes, loadAddr, console.log);
  }

  // Call a guest export wherever the guest actually is.
  //
  // Launch-time configuration (set_winver, set_hwnd_base, set_extra_cmdline) is
  // main-side code writing per-instance globals, so in worker mode it has to
  // reach the worker's instance — writing them on the idle main instance looks
  // like it worked and does nothing. That is what made MFC42U refuse to load:
  // set_winver never reached the running guest, so GetVersion still answered
  // Win98 and MFC put up "cannot be loaded on Windows 95".
  //
  // Returns a promise in worker mode and the value directly otherwise; callers
  // at launch time can ignore the difference, since nothing reads the result.
  callGuest(name, ...args) {
    if (this.guestWorker) return this.guestWorker.callExport(name, ...args);
    const fn = this.instance && this.instance.exports[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
  }

  hasGuestExport(name) {
    // Both modes instantiate the same module, so the main instance is a valid
    // oracle for whether an export exists even when the guest runs elsewhere.
    return !!(this.instance && typeof this.instance.exports[name] === 'function');
  }

  // Where a DLL's bytes come from: the VFS, the ones already loaded, or a
  // fetch. Pure host work — no instance involved — so both the single-threaded
  // handler and the worker-mode one use it rather than keeping two copies of a
  // four-candidate path search.
  async _resolveDllBytes(dllName) {
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
          if (resp.ok) { dllBytes = new Uint8Array(await resp.arrayBuffer()); break; }
        } catch (_) {}
      }
    }
    return { fileName, dllBytes };
  }

  // Worker-mode LoadLibrary. The split is the same one the design predicted:
  // resolving bytes is host work and happens here; loading the image, patching
  // its imports, running DllMain and resuming the guest are guest work and
  // happen in the worker, because they set EIP/ESP and execute code.
  async _handleLoadLibraryThreaded(targetLink) {
    const gw = this.guestWorker;
    const link = targetLink || gw.link;
    const nameWA = (await link.callExport('get_loadlib_name')) >>> 0;
    let dllName = '';
    if (nameWA) {
      const mem = new Uint8Array(this.memory.buffer);
      for (let i = 0; i < 260 && mem[nameWA + i]; i++) dllName += String.fromCharCode(mem[nameWA + i]);
    }
    const { fileName, dllBytes } = dllName ? await this._resolveDllBytes(dllName) : { fileName: '', dllBytes: null };
    if (!dllBytes) {
      if (fileName) console.error(`[LoadLibrary] DLL not found: ${fileName}`);
      await gw.loadLibrary(null, fileName, link);
      return;
    }
    const res = await gw.loadLibrary(dllBytes, fileName, link);
    if (res && res.loadAddr) {
      console.log(`[LoadLibrary] ${fileName} loaded at 0x${(res.loadAddr >>> 0).toString(16)} (worker)`);
      this.registerModule(fileName, res.loadAddr);
      this._registerDllBitmapResources(fileName, dllBytes, res.loadAddr);
    }
  }

  // Remember where an image landed, and resolve an address back to it.
  // Nearest base at or below the address wins: the table has no sizes, and an
  // address inside a module is always above its base and below the next one's.
  // Answering with the wrong module is still better than answering with a bare
  // number, and being explicit about that is the point of the name it prints.
  registerModule(name, base) {
    if (!name || !base) return;
    this.moduleMap.push({ name, base: base >>> 0 });
    this.moduleMap.sort((a, b) => a.base - b.base);
  }

  describeAddr(addr) {
    const a = addr >>> 0;
    const hex = `0x${a.toString(16)}`;
    let best = null;
    for (const m of this.moduleMap) {
      if (m.base <= a && (!best || m.base > best.base)) best = m;
    }
    return best ? `${hex} (${best.name}+0x${(a - best.base).toString(16)})` : hex;
  }

  // Worker-mode COM server load (yield reason 3). Same split as LoadLibrary:
  // the name and bytes are resolved here, the image load, DllMain and the guest
  // resume happen in the worker.
  //
  // The COM search order is not LoadLibrary's — a class's server is looked up by
  // bare filename in the DLL and plugin directories — so this resolves its own
  // candidates rather than sharing _resolveDllBytes.
  async _handleComDllLoadThreaded(targetLink) {
    const gw = this.guestWorker;
    const link = targetLink || gw.link;
    const nameWA = (await link.callExport('get_com_dll_name')) >>> 0;
    if (!nameWA) {
      console.error('COM yield but no pending DLL name');
      await link.callExport('clear_yield');
      return;
    }
    const mem = new Uint8Array(this.memory.buffer);
    let dllName = '';
    for (let i = 0; i < 260 && mem[nameWA + i]; i++) dllName += String.fromCharCode(mem[nameWA + i]);
    const fileName = dllName.split('\\').pop().toLowerCase();
    console.log(`[COM] Loading DLL: ${fileName} (worker)`);

    let dllBytes = null;
    for (const p of [`binaries/dlls/${fileName}`, `binaries/plugins/${fileName}`, `dlls/${fileName}`]) {
      try {
        const resp = await fetch(p);
        if (resp.ok) { dllBytes = new Uint8Array(await resp.arrayBuffer()); break; }
      } catch (_) {}
    }
    if (!dllBytes && this._helpCtx && this._helpCtx.vfs) {
      const vfs = this._helpCtx.vfs;
      for (const vp of [dllName.toLowerCase(), 'c:\\' + fileName, 'c:\\plugins\\' + fileName]) {
        const entry = vfs.files.get(vp);
        if (entry && entry.data) { dllBytes = entry.data; break; }
      }
    }
    if (!dllBytes) {
      console.error(`[COM] Failed to fetch DLL: ${fileName}`);
      await gw.comLoadDll(null, fileName, null, link);
      return;
    }
    const res = await gw.comLoadDll(dllBytes, fileName, this._exeBytes || null, link);
    if (res && res.error) console.error('[COM] DLL load error:', res.error);
    else if (res) console.log(`[COM] DLL loaded at 0x${(res.loadAddr >>> 0).toString(16)} (worker)`);
  }

  async handleLoadLibrary() {
    await ProcessBoot.handleLoadLibraryYield({
      exports: this.instance.exports,
      memoryBuffer: this.memory.buffer,
      resourceHost: this,
      log: console.log,
      findDll: (fileName, fullName) => this._findDllBytes(fileName, fullName, { exeDir: true }),
    });
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

  // Worker-mode run loop. The guest executes inside the Worker, so this loop
  // does nothing but hand out slices and composite — which is the whole claim
  // of the design: the UI thread is no longer in the guest's critical path, so
  // there is no wall-clock budget, no quantum, and no input-wake heuristic here.
  _runThreaded(stepsPerSlice) {
    this.running = true;
    const self = this;
    let unsupportedYield = 0;
    const step = async () => {
      if (!self.running) return;
      const perf = (typeof window !== 'undefined' && window.WinePerf && window.WinePerf.enabled)
        ? window.WinePerf : null;
      if (perf) perf.stepBegin();
      try {
        self._beginGuestTickBatch();
        if (self.guestWorker.broker) {
          // The guest's message-wait resume runs inside the worker and needs to
          // know whether the renderer has input queued — that queue is here, so
          // its depth is published rather than asked for.
          const q = self.renderer && self.renderer.inputQueue ? self.renderer.inputQueue.length : 0;
          self.guestWorker.broker.publish({
            tickMs: self._guestTickMs(self.hostCtx && self.hostCtx.sharedAudio),
            inputPending: q,
          });
        }
        const steps = Math.max(1000, (self.stepsPerSlice | 0) || stepsPerSlice);
        // The guest's main thread and every thread it created run AT THE SAME
        // TIME — that is the whole of phase 2. Awaiting them together rather
        // than in sequence is what makes it true: each slice() is a message to a
        // different Worker, and none of them needs this thread except to be
        // served a host import.
        const runThreads = () => (self.threadManager && self.threadManager.backend === 'worker'
          ? self.threadManager.runWorkerSlices(steps)
          : 0);
        // The guest's main thread takes part in the same rendezvous its threads
        // do: in worker mode it is not the main INSTANCE, so its thunk
        // allocations are invisible to everyone else unless they are published.
        const sync = self.threadManager ? self.threadManager.workerSyncState() : null;
        let r, threadsRun;
        if (typeof window !== 'undefined' && window.WINE_THREADS_SERIAL) {
          // Diagnostic only: the same slices, one at a time. A bug that appears
          // in parallel and not here is a race in shared emulator state, which is
          // a different investigation from a bug in the worker plumbing.
          r = await self.guestWorker.slice(steps, sync);
          threadsRun = await runThreads();
        } else {
          [r, threadsRun] = await Promise.all([self.guestWorker.slice(steps, sync), runThreads()]);
        }
        if (self.threadManager) self.threadManager.publishWorkerThunkState(r);
        if (!self.running) return;
        if (self.threadManager && self.threadManager.netWaitPending) {
          // A thread parked in a blocking socket call. Frames arrive on this
          // thread's event loop, so it has to get a turn before the next slice.
          self.threadManager.netWaitPending = false;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        // How many guest threads got a slice this step. Nothing consumes it yet;
        // it is here because "the threads are live but none of them ran" and "no
        // threads exist" look identical from the outside, and that is the first
        // thing worth knowing when a threaded app goes quiet.
        self.workerThreadsRun = threadsRun | 0;
        if (perf) {
          perf.countSteps(stepsPerSlice);
          // Off-thread time is reported as thread time, not main time: it did
          // not block this thread, and calling it 'guest' here would make the
          // HUD's phase shares mean something different than in the other mode.
          perf.mark('workers', r.ms || 0);
        }
        if (r.trapped) {
          const g = r.regs || {};
          const hex = v => '0x' + ((v || 0) >>> 0).toString(16);
          self.logToUI(`[threads] guest trapped in worker: ${r.trapped} @ EIP=${hex(r.eip)} `
            + `prev_eip=${hex(g.prevEip)} esp=${hex(g.esp)} eax=${hex(g.eax)} ebx=${hex(g.ebx)} `
            + `ecx=${hex(g.ecx)} edx=${hex(g.edx)} esi=${hex(g.esi)} edi=${hex(g.edi)} ebp=${hex(g.ebp)}`);
          self.stop({ repaint: false });
          return;
        }
        const presentStart = perf ? performance.now() : 0;
        if (self.renderer && self.renderer.flushRepaint) self.renderer.flushRepaint(true);
        if (perf) perf.mark('present', performance.now() - presentStart);

        if (!r.eip && !r.yield) {
          self.logToUI('--- Program exited (worker) ---');
          self.stop({ repaint: false });
          return;
        }
        // Every yield the WAT actually raises is handled here: 1 wait, 2 exit
        // (caught above as eip=0), 3 com_load_dll, 5 load_library, 6
        // modal_dialog, 7 message_wait, 8 net_wait. Reason 4 (help_load) is
        // named in thread-manager.js's map but is never set by any WAT or JS
        // path, so there is nothing to port for it. The fallback below stays as
        // a guard for anything added later.
        if (r.yield === 1) {
          // A parked WaitForSingleObject/WaitForMultipleObjects. This used to
          // just clear the yield and let the guest re-poll, which is wrong in a
          // way that only shows up once a wait can actually be satisfied: $run
          // has already popped the return address, so the guest is past the call
          // with its stdcall arguments still on the stack. Only completing the
          // wait drops them. Clearing instead leaked 12 bytes of guest stack per
          // wait, and Winamp died minutes later at EIP=0xffffffff — which is why
          // nothing caught it before guest threads ran in this mode.
          const done = self.threadManager ? self.threadManager.resolveMainWorkerWait(r) : null;
          if (done) await self.guestWorker.link.completeWait(done.result, done.waitStackBytes);
          // Unsatisfied: leave the yield set. The next slice re-polls, and the
          // worker's run() returns immediately while parked.
        } else if (r.yield === 7) {
          // The message-wait resume runs inside the worker at the top of each
          // slice, where the instance is. Nothing to do here — and specifically
          // not clear_yield, for the same reason as above.
        } else if (r.yield === 3) {
          await self._handleComDllLoadThreaded();
        } else if (r.yield === 5) {
          await self._handleLoadLibraryThreaded();
        } else if (r.yield === 9) {
          // cs_wait: EnterCriticalSection found the section held by another guest
          // thread. Clearing re-enters the same call, and the holder gets its
          // slice in this same round — which is why the WAT must not spin there:
          // the holder may be parked in Atomics.wait for an import only this
          // thread serves.
          //
          // The guest's MAIN thread does not currently park (see
          // $handle_EnterCriticalSection — it nests interpreter runs that cannot
          // be unwound), so this is a safety net rather than a live path. It is
          // kept because the alternative is the catch-all below, which stops the
          // app outright, and that is how this was found.
          await self.guestWorker.callExport('clear_yield');
        } else if (r.yield === 10) {
          await self.guestWorker.resolveThreadSend(self.guestWorker.link, {
            targetTid: r.sendTargetTid | 0,
            hwnd: r.sendHwnd | 0, msg: r.sendMsg | 0,
            wparam: r.sendWparam | 0, lparam: r.sendLparam | 0,
            postKind: r.sendPostKind | 0,
          });
        } else if (r.yield === 8) {
          await self.guestWorker.callExport('clear_yield');
          try { await self.guestWorker.callExport('vlan_pump'); } catch (_) {}
        } else if (r.yield === 6) {
          // modal_dialog: the single-threaded loop does nothing special here
          // either — the WAT side drives the dialog — so neither does this.
        } else if (r.yield) {
          if (++unsupportedYield === 1) {
            self.logToUI(`[threads] yield ${r.yield} is not supported in worker mode yet `
              + `(needs its host sequence ported into the worker); stopping.`);
            self.stop({ repaint: false });
            return;
          }
        }
      } catch (err) {
        self.logToUI(`[threads] worker loop failed: ${err.message}`);
        self.stop({ repaint: false });
        return;
      } finally {
        if (perf) perf.stepEnd();
      }
      // Same unclamped scheduling the single-threaded loop uses: a nested
      // setTimeout chain is capped at 4ms once it is five deep, which would
      // hold worker mode to ~250 slices a second no matter how fast a slice is.
      if (self.running) self._scheduleStep(step);
    };
    step();
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
    if (this.guestWorker) return this._runThreaded(stepsPerSlice);
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
        if (self.threadManager) await self.threadManager.resolveMainThreadSend();
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
          // timeSetEvent is asynchronous on Windows. Most emulated apps pump
          // often enough for the existing MM_TIMER message path; opted-in
          // clients such as Diablo also need a callback between slices while
          // their main thread is deliberately busy-waiting. fire_mm_timer is
          // cooperative: it refuses to interrupt a parked wait or an active
          // callback and resumes the interrupted EIP through its return thunk.
          self._pumpMultimediaTimer();
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
        if (yieldReason === 9) {
          // cs_wait: EnterCriticalSection found the section held by another guest
          // thread. Same shape as net_wait — EIP is still on the thunk, so
          // clearing re-enters the same call — and rescheduling rather than
          // spinning is again the point: the holder only runs when this returns.
          self.instance.exports.clear_yield();
          if (self.running) { setTimeout(step, 0); }
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
