const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createHostImports } = require('../lib/host-imports');
const { HlpParser } = require('../lib/hlp-parser');
const { loadDlls, detectRequiredDlls } = require('../lib/dll-loader');
const { compileWat } = require('../lib/compile-wat');
let createCanvas, Win98Renderer;
try {
  createCanvas = require('canvas').createCanvas;
  Win98Renderer = require('../lib/renderer').Win98Renderer;
} catch (_) {}

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
// Parse args (need these before autoBuild)
const args = process.argv.slice(2);
const getArg = (name, def) => { const a = args.find(a => a.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; };
const hasFlag = name => args.includes(`--${name}`);

const NO_BUILD = hasFlag('no-build');      // --no-build: skip auto-build
const NO_CLOSE = hasFlag('no-close');      // --no-close: don't inject WM_CLOSE
const DUMP_GDI = getArg('dump-gdi', null); // --dump-gdi=DIR: dump GDI bitmaps as PNGs
const DUMP_SDB = getArg('dump-sdb', null); // --dump-sdb=DIR: dump StretchDIBits source DIBs + per-call log
const MAX_BATCHES = parseInt(getArg('max-batches', '200'));
const BATCH_SIZE = parseInt(getArg('batch-size', '1000'));
const VERBOSE = hasFlag('verbose');
const TRACE = hasFlag('trace');           // --trace: log every block's EIP
const TRACE_API = hasFlag('trace-api');   // --trace-api: log all API calls with args + return values
const TRACE_GDI = hasFlag('trace-gdi');   // --trace-gdi: log GDI calls (CreateBitmap, BitBlt, etc.)
const TRACE_SEH = hasFlag('trace-seh');   // --trace-seh: log SEH chain operations
const BREAKPOINT = getArg('break', null); // --break=0xADDR[,0xADDR,...]: break at address(es)
const BREAK_API = getArg('break-api', null); // --break-api=Name[,Name,...]: break on API call
const WATCH_SPEC = getArg('watch', null);    // --watch=0xADDR: break on memory change (dword)
const WATCH_VALUE = getArg('watch-value', null); // --watch-value=0xVAL: only break when watch becomes this value
const SKIP_SPEC = getArg('skip', null);          // --skip=0xADDR[,0xADDR,...]: auto-return (simulate ret) when EIP hits
const DUMP_SPEC = getArg('dump', null);   // --dump=0xADDR:LEN: hexdump memory region
const DUMP_SEH = hasFlag('dump-seh');     // --dump-seh: detailed SEH chain dump at end
const DUMP_BACKCANVAS = hasFlag('dump-backcanvas'); // --dump-backcanvas: save back canvases alongside PNG snapshots
const DUMP_VFS = hasFlag('dump-vfs');     // --dump-vfs: list all VFS files at end
const SAVE_VFS = getArg('save-vfs', null); // --save-vfs=DIR: extract VFS files to directory
const STUCK_AFTER = parseInt(getArg('stuck-after', '10'));  // --stuck-after=N: stuck detection after N same-EIP batches
const WINVER = getArg('winver', null); // --winver=nt4|win2k|win98 or hex like 0x05650004
const EXE_PATH = getArg('exe', 'test/binaries/notepad.exe');
const PNG_OUT = getArg('png', null);     // --png=out.png: render to PNG via node-canvas
const INPUT_SPEC = getArg('input', null); // --input=batch:msg:wParam[:lParam],...  e.g. --input=50:0x111:11
const EXTRA_ARGS = getArg('args', null); // --args="-quick -fullscreen": extra cmdline args appended after exe name
const AUDIO_OUT = getArg('audio-out', null); // --audio-out=file.pcm: write raw PCM to file

// NO_BUILD kept for compat but ignored — always compiles from WAT

const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
const breakAddrs = BREAKPOINT ? BREAKPOINT.split(',').map(s => parseInt(s, 16)) : [];
const breakApis = BREAK_API ? BREAK_API.split(',') : [];
const skipAddrs = SKIP_SPEC ? SKIP_SPEC.split(',').map(s => parseInt(s, 16)) : [];

async function main() {
  let wasmBytes;
  const prebuilt = path.join(__dirname, '..', 'build', 'wine-assembly.wasm');
  if (NO_BUILD && fs.existsSync(prebuilt)) {
    wasmBytes = fs.readFileSync(prebuilt);
  } else {
    wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC_DIR, f), 'utf-8'));
  }
  const exeBytes = fs.readFileSync(EXE_PATH);

  const logs = [];
  let stopped = false;
  let apiCount = 0;
  let lastApiName = null;  // track last API name for return value correlation
  let inputEvent = null;   // pending input event to inject via check_input
  let inputQueue = null;   // button ID sequence to inject
  let crossThreadMsgs = []; // messages from worker threads to deliver via check_input

  // Parse --input=batch:msg:wParam[:lParam],... into scheduled events.
  // Also supports UI-level events that go through renderer handlers:
  //   B:focus-find          — set focus on find dialog edit ctrl
  //   B:keypress:CODE       — call renderer.handleKeyPress(CODE)
  //   B:keydown:VK          — call renderer.handleKeyDown(VK)
  //   B:click:X:Y           — handleMouseDown+Up at canvas (X,Y)
  //   B:mousedown:X:Y       — handleMouseDown at canvas (X,Y)
  //   B:mouseup:X:Y         — handleMouseUp at canvas (X,Y)
  //   B:mousemove:X:Y       — handleMouseMove at canvas (X,Y)
  //   B:dump-find           — log current find dialog edit state
  const scheduledInput = [];
  if (INPUT_SPEC) {
    for (const spec of INPUT_SPEC.split(',')) {
      const parts = spec.split(':');
      const batch = parseInt(parts[0]);
      const kind = parts[1];
      if (kind === 'focus-find' || kind === 'dump-find') {
        scheduledInput.push({ batch, action: kind });
      } else if (kind === 'find-click') {
        // B:find-click:CTRL_ID — click a find dialog button by ctrl id
        // (1=Find Next, 2=Cancel, 0x411=Match case, 0x420=Up, 0x421=Down).
        scheduledInput.push({ batch, action: 'find-click', ctrlId: parseInt(parts[2]) });
      } else if (kind === 'dump-fr') {
        // B:dump-fr — log current FINDREPLACE struct (Flags + lpstrFindWhat).
        scheduledInput.push({ batch, action: 'dump-fr' });
      } else if (kind === 'slot-count') {
        // B:slot-count[:LABEL] — log live WND_RECORDS slot count.
        scheduledInput.push({ batch, action: 'slot-count', label: parts[2] || '' });
      } else if (kind === 'class-cmd') {
        // B:class-cmd:CLASS:CMD — find first slot whose ctrl class == CLASS,
        // then send WM_COMMAND wParam=CMD lParam=0. Used by dialog regression
        // tests to drive OK/Cancel without a per-class hwnd export.
        scheduledInput.push({ batch, action: 'class-cmd',
          ctrlClass: parseInt(parts[2]), cmdId: parseInt(parts[3]) });
      } else if (kind === 'open-dlg-pick') {
        // B:open-dlg-pick:FILENAME — find the open-dialog parent (class 12),
        // set its filename edit (id 0x442) text to FILENAME, then fire IDOK.
        scheduledInput.push({ batch, action: 'open-dlg-pick', filename: parts.slice(2).join(':') });
      } else if (kind === 'edit-ok') {
        // B:edit-ok:CTRL_ID:TEXT — find an Edit control (class 2) with
        // matching ctrl id, WM_SETTEXT with TEXT, then fire IDOK on its
        // parent dialog. Generic helper for simple modal prompt dialogs.
        scheduledInput.push({ batch, action: 'edit-ok',
          ctrlId: parseInt(parts[2]), text: parts.slice(3).join(':') });
      } else if (kind === 'keypress' || kind === 'keydown' || kind === 'keyup') {
        scheduledInput.push({ batch, action: kind, code: parseInt(parts[2]) });
      } else if (kind === 'winamp-play') {
        // B:winamp-play:FILENAME — write filename to guest mem, send Winamp IPC
        scheduledInput.push({ batch, action: 'winamp-play', filename: parts.slice(2).join(':') });
      } else if (kind === 'winamp-start') {
        // B:winamp-start — post IPC_STARTPLAY to trigger playback
        scheduledInput.push({ batch, action: 'winamp-start' });
      } else if (kind === 'post-cmd') {
        // B:post-cmd:WPARAM — post WM_COMMAND with given wParam to main_hwnd via post queue
        scheduledInput.push({ batch, action: 'post-cmd', wParam: parseInt(parts[2]) });
      } else if (kind === 'poke') {
        // B:poke:GUEST_ADDR:VALUE — write a dword to guest memory
        scheduledInput.push({ batch, action: 'poke', addr: parseInt(parts[2]), value: parseInt(parts[3]) });
      } else if (kind === 'png') {
        // B:png:PATH — write a PNG snapshot of renderer.canvas at this batch.
        scheduledInput.push({ batch, action: 'png', path: parts.slice(2).join(':') });
      } else if (kind === 'click') {
        scheduledInput.push({ batch, action: 'click', x: parseInt(parts[2]), y: parseInt(parts[3]) });
      } else if (kind === 'mousedown') {
        scheduledInput.push({ batch, action: 'mousedown', x: parseInt(parts[2]), y: parseInt(parts[3]) });
      } else if (kind === 'dblclick') {
        scheduledInput.push({ batch, action: 'dblclick', x: parseInt(parts[2]), y: parseInt(parts[3]) });
      } else if (kind === 'rclick') {
        scheduledInput.push({ batch, action: 'rclick', x: parseInt(parts[2]), y: parseInt(parts[3]) });
      } else if (kind === 'mouseup') {
        scheduledInput.push({ batch, action: 'mouseup', x: parseInt(parts[2]), y: parseInt(parts[3]) });
      } else if (kind === 'mousemove') {
        scheduledInput.push({ batch, action: 'mousemove', x: parseInt(parts[2]), y: parseInt(parts[3]) });
      } else {
        const msg = parseInt(parts[1]);
        const wParam = parseInt(parts[2]) || 0;
        const lParam = parseInt(parts[3]) || 0;
        scheduledInput.push({ batch, msg, wParam, lParam });
      }
    }
    scheduledInput.sort((a, b) => a.batch - b.batch);
  }

  // Resource parsing lives in WAT — nothing to pre-parse here.

  // Set up renderer if node-canvas is available
  let renderer = null;
  if (createCanvas && Win98Renderer) {
    const screenArg = args.find(a => a.startsWith('--screen='));
    const [screenW, screenH] = screenArg ? screenArg.split('=')[1].split('x').map(Number) : [640, 480];
    const canvas = createCanvas(screenW, screenH);
    renderer = new Win98Renderer(canvas);
  }

  // String APIs where we want to log content
  const STRING_APIS = ['lstrlenA', 'lstrcpyA', 'lstrcpynA', 'LoadStringA', 'GetWindowTextA', 'SetWindowTextA', 'SetDlgItemTextA'];

  const traceCategories = new Set();
  if (TRACE_GDI) traceCategories.add('gdi');

  const apiTable = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'api_table.json'), 'utf8'));
  const ctx = {
    getMemory: () => ctx._memory ? ctx._memory.buffer : null,
    renderer,
    apiTable,
    verbose: VERBOSE,
    onExit: (code) => { stopped = true; },
    trace: traceCategories,
    dumpSdb: DUMP_SDB ? { images: new Map(), log: [] } : null,
    _audioOutFd: AUDIO_OUT ? fs.openSync(AUDIO_OUT, 'w') : undefined,
    _sharedAudio: {},  // shared waveOut state across threads
    readFile: (name) => {
      // Try to find file relative to exe directory
      const exeDir = path.dirname(EXE_PATH);
      const candidates = [
        path.join(exeDir, name),
        path.join(exeDir, path.basename(name)),
        path.join(__dirname, 'binaries', 'help', path.basename(name)),
      ];
      for (const p of candidates) {
        try { return new Uint8Array(fs.readFileSync(p)); } catch (_) {}
      }
      return null;
    },
  };
  const base = createHostImports(ctx);
  const { readStr } = base;
  const h = base.host;

  // --- Override logging ---
  h.log = (ptr, len) => {
    const b = new Uint8Array(memory.buffer, ptr, Math.min(len, 256));
    let t = '';
    for (let i = 0; i < b.length && b[i]; i++) t += String.fromCharCode(b[i]);
    apiCount++;

    // Check API breakpoints
    if (breakApis.length && breakApis.some(name => t.includes(name))) {
      apiBreakHit = t;
    }

    if (TRACE_API) {
      const e = instance.exports;
      const esp = e.get_esp();
      const imageBase = e.get_image_base();
      const dv = new DataView(memory.buffer);
      const g2w = addr => addr - imageBase + 0x12000;
      let argStr = '';
      try {
        for (let i = 0; i < 6; i++) {
          const a = dv.getUint32(g2w(esp + 4 + i * 4), true);
          argStr += (i ? ', ' : '') + hex(a);
        }
      } catch (_) {}

      // Log string content for string APIs
      let strInfo = '';
      const matchedApi = STRING_APIS.find(api => t.includes(api));
      if (matchedApi) {
        try {
          const mem = new Uint8Array(memory.buffer);
          const strPtr = dv.getUint32(g2w(esp + 4), true);
          const strVal = readStr(g2w(strPtr), 64);
          if (strVal) strInfo = ` str="${strVal}"`;
        } catch (_) {}
      }
      // Dump both strings for lstrcmp/lstrcmpi
      if ((t === 'lstrcmpiA' || t === 'lstrcmpA') && !strInfo) {
        try {
          const s1 = dv.getUint32(g2w(esp + 4), true);
          const s2 = dv.getUint32(g2w(esp + 8), true);
          const v1 = readStr(g2w(s1), 32);
          const v2 = readStr(g2w(s2), 32);
          strInfo = ` "${v1}" vs "${v2}"`;
        } catch (_) {}
      }

      lastApiName = t;
      let retInfo = '';
      if (t === 'MessageBoxA') {
        try {
          const ret = dv.getUint32(g2w(esp), true);
          retInfo = ` ret=${hex(ret)}`;
          // Walk EBP frame chain to get caller stack
          let ebp = e.get_ebp();
          const chain = [];
          for (let depth = 0; depth < 12 && ebp; depth++) {
            const callerRet = dv.getUint32(g2w(ebp + 4), true);
            const prevEbp = dv.getUint32(g2w(ebp), true);
            chain.push(`${hex(callerRet)}`);
            if (prevEbp <= ebp || prevEbp - ebp > 0x10000) break;
            ebp = prevEbp;
          }
          retInfo += ` frames=[${chain.join(' <- ')}]`;
        } catch (_) {}
      }
      logs.push(`[API #${apiCount}] ${t}(${argStr})${strInfo}${retInfo}`);
      // Dump MSG struct contents for DispatchMessageA
      if (t.includes('DispatchMessage') && apiCount <= 100) {
        try {
          const msgPtr = dv.getUint32(g2w(esp + 4), true);
          const msgHwnd = dv.getUint32(g2w(msgPtr), true);
          const msgMsg = dv.getUint32(g2w(msgPtr + 4), true);
          const msgWP = dv.getUint32(g2w(msgPtr + 8), true);
          const msgLP = dv.getUint32(g2w(msgPtr + 12), true);
          logs.push(`  MSG: hwnd=0x${msgHwnd.toString(16)} msg=0x${msgMsg.toString(16)} wP=0x${msgWP.toString(16)} lP=0x${msgLP.toString(16)}`);
        } catch (_) {}
      }

      // SEH tracing for _EH_prolog and _CxxThrowException
      if (TRACE_SEH && (t.includes('_EH_prolog') || t.includes('_CxxThrowException'))) {
        const fsBase = e.get_fs_base();
        try {
          const sehHead = dv.getUint32(g2w(fsBase), true);
          logs.push(`  [SEH] fs:[0]=${hex(sehHead)} EBP=${hex(e.get_ebp())}`);
        } catch (_) {}
      }
    } else {
      logs.push('[API] ' + t);
    }
  };

  h.log_i32 = val => {
    if (TRACE_API && lastApiName) {
      logs.push(`  => ${hex(val)}`);
      lastApiName = null;
    } else {
      logs.push('[i32] ' + hex(val));
    }
  };

  // --- Override exit to also log ---
  h.exit = code => { logs.push('[Exit] code=' + code); stopped = true; };

  // --- Override shell_about to log; the WAT side ($handle_ShellAboutA →
  // $create_about_dialog → $host_register_dialog_frame) drives all
  // rendering state. JS only sees the [ShellAbout] log line and the
  // subsequent register_dialog_frame callback.
  h.shell_about = (dlgHwnd, ownerHwnd, appPtr) => {
    logs.push(`[ShellAbout] dlg=0x${dlgHwnd.toString(16)} owner=0x${ownerHwnd.toString(16)} "${readStr(appPtr)}"`);
    return 1;
  };

  // --- Override set_dlg_item_text to log ---
  h.set_dlg_item_text = (hwnd, ctrlId, textPtr) => {
    const text = readStr(textPtr);
    logs.push(`[SetDlgItemText] hwnd=0x${hwnd.toString(16)} ctrl=${ctrlId} "${text}"`);
    if (renderer) renderer.setDlgItemText(hwnd, ctrlId, text);
  };

  // --- Override message_box to log ---
  h.message_box = (h2, t, c, u) => {
    logs.push(`[MessageBox] "${readStr(c)}": "${readStr(t)}"`);
    return 1;
  };

  // --- Override window functions to log ---
  h.create_window = (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
    const title = readStr(titlePtr);
    logs.push(`[CreateWindow] hwnd=0x${hwnd.toString(16)} title="${title}" style=0x${style.toString(16)} pos=${x},${y} size=${cx}x${cy} menu=${menuId}`);
    if (renderer) renderer.createWindow(hwnd, style, x, y, cx, cy, title, menuId);
    return hwnd;
  };

  h.show_window = (hwnd, cmd) => {
    logs.push(`[ShowWindow] hwnd=0x${hwnd.toString(16)} cmd=${cmd}`);
    if (renderer) renderer.showWindow(hwnd, cmd);
    const win = renderer && renderer.windows[hwnd];
    if (win && win.clientRect) return (win.clientRect.w & 0xFFFF) | ((win.clientRect.h & 0xFFFF) << 16);
    // Inject button sequence if --buttons provided, else WM_CLOSE.
    // Skip auto-WM_CLOSE when --input is in use — the test is orchestrating
    // its own event timeline and shouldn't be killed prematurely.
    if (!inputEvent && !inputQueue && !INPUT_SPEC) {
      const btnArg = args.find(a => a.startsWith('--buttons='));
      if (btnArg) {
        inputQueue = btnArg.split('=')[1].split(',').map(Number);
        logs.push(`[test] Button queue: ${inputQueue}`);
      } else if (!NO_CLOSE) {
        inputEvent = { msg: 0x0010, wParam: 0, lParam: 0 };
        logs.push('[test] Injecting WM_CLOSE');
      }
    }
  };

  h.dialog_loaded = (hwnd, parentHwnd) => {
    logs.push(`[CreateDialog] hwnd=0x${hwnd.toString(16)} parent=0x${parentHwnd.toString(16)}`);
    if (renderer) renderer.createDialog(hwnd, parentHwnd);
  };

  let installingFiles = false;
  h.set_window_text = (hwnd, textPtr) => {
    const text = readStr(textPtr);
    logs.push(`[SetWindowText] "${text}"`);
    if (renderer) renderer.setWindowText(hwnd, text);
    // Track "Installing Files" page for button delay
    if (text.includes('Installing')) installingFiles = true;
    else if (text.includes('Completed') || text.includes('Finish')) installingFiles = false;
  };

  h.set_menu = (hwnd, menuResId) => {
    logs.push(`[SetMenu] hwnd=0x${hwnd.toString(16)} menu=${menuResId}`);
    if (renderer) renderer.setMenu(hwnd, menuResId);
  };

  // Deterministic tick: drive from the batch counter, not wall clock.
  // Wall-clock ticks make pinball (and any timeGetTime-driven game) flake
  // between runs because batches don't take a fixed wall-time.
  // Each call advances by 1ms so games that compare consecutive timeGetTime
  // calls within the same batch see time progressing (pinball's physics tick
  // requires this — it compares two timeGetTime results and only advances
  // when they differ). Batch transitions add a larger jump (~200ms) to keep
  // the overall simulated pace realistic.
  const tickState = { batch: 0, callsInBatch: 0 };
  h.get_ticks = () => (((tickState.batch * 200 + tickState.callsInBatch++) & 0x7FFFFFFF));

  // --- Override input for test injection ---
  let lastInputEvent = null;
  h.check_input = () => {
    let evt = null;
    if (inputEvent) {
      evt = inputEvent;
      inputEvent = null;
    } else if (crossThreadMsgs.length > 0) {
      evt = crossThreadMsgs.shift();
    } else if (inputQueue && inputQueue.length > 0) {
      // Delay button clicks while on "Installing Files" page (let extraction thread work)
      if (installingFiles) return 0;
      const id = inputQueue.shift();
      if (typeof id === 'object') { evt = id; } // allow full event objects in queue
      // Button-id form: WM_COMMAND from a menu, hwnd=0 → WAT routes to main_hwnd.
      // Previously hard-coded 0x10002 (edit child), which silently swallowed
      // menu commands because the edit child's wndproc is WNDPROC_BUILTIN.
      else evt = { msg: 0x0111, wParam: id, lParam: 0, hwnd: 0 };
    } else if (renderer) {
      evt = renderer.checkInput();
    }
    if (!evt) return 0;
    lastInputEvent = evt;
    const packed = (evt.wParam << 16) | (evt.msg & 0xFFFF);
    logs.push(`[check_input] msg=0x${evt.msg.toString(16)} wParam=0x${evt.wParam.toString(16)} packed=0x${packed.toString(16)}`);
    return packed;
  };
  // Default hwnd routing: keyboard messages (WM_KEYDOWN..WM_SYSCHAR, 0x100-0x108)
  // need to land in the edit child (0x10002) since we don't track focus from
  // outside WAT. Anything else (menu commands, mouse, etc.) returns 0 so the
  // WAT side defaults to main_hwnd.
  h.check_input_hwnd = () => {
    if (!lastInputEvent) return 0;
    if (lastInputEvent.hwnd) { logs.push(`[check_input_hwnd] explicit hwnd=0x${lastInputEvent.hwnd.toString(16)}`); return lastInputEvent.hwnd; }
    const m = lastInputEvent.msg;
    if (m >= 0x100 && m <= 0x108) { logs.push(`[check_input_hwnd] keyboard → 0x10002`); return 0x10002; }
    logs.push(`[check_input_hwnd] msg=0x${m.toString(16)} → 0 (main_hwnd)`);
    return 0;
  };
  h.check_input_lparam = () => (lastInputEvent ? (lastInputEvent.lParam || 0) : 0);
  // GetAsyncKeyState backing — delegate to renderer's stateful key map
  h.get_async_key_state = (vKey) => (renderer ? renderer.getAsyncKeyState(vKey) : 0);

  // Create shared memory externally (WASM module imports it)
  const memory = new WebAssembly.Memory({ initial: 1024 });
  ctx._memory = memory;
  h.memory = memory;

  // ThreadManager setup (lazy — created after instance)
  const { ThreadManager } = require('../lib/thread-manager');
  let threadManager = null;

  // Wire thread/event imports to ThreadManager
  h.create_thread = (startAddr, param, stackSize) => threadManager.createThread(startAddr, param, stackSize);
  h.exit_thread = (exitCode) => threadManager.exitThread(exitCode);
  h.create_event = (manualReset, initialState) => threadManager.createEvent(manualReset, initialState);
  h.set_event = (handle) => threadManager.setEvent(handle);
  h.reset_event = (handle) => threadManager.resetEvent(handle);
  h.wait_single = (handle, timeout) => threadManager.waitSingle(handle, timeout);
  h.com_create_instance = (rclsid, pUnkOuter, dwClsCtx, riid, ppv) => 0x80004002; // E_NOINTERFACE

  // Check if a DLL file exists in VFS or host filesystem
  h.has_dll_file = (nameWA) => {
    const mem8 = new Uint8Array(memory.buffer);
    let name = '';
    for (let i = 0; i < 260; i++) {
      const ch = mem8[nameWA + i];
      if (!ch) break;
      name += String.fromCharCode(ch);
    }
    const fileName = name.split('\\').pop().toLowerCase();
    // Check VFS
    if (ctx.vfs) {
      const tryPaths = [name.toLowerCase(), 'c:\\' + fileName, 'c:\\plugins\\' + fileName];
      for (const p of tryPaths) {
        if (ctx.vfs.files.has(p)) return 1;
      }
    }
    // Check host filesystem
    const searchPaths = [
      path.join(path.dirname(EXE_PATH), fileName),
      path.join(path.dirname(EXE_PATH), 'plugins', fileName),
      path.join(__dirname, 'binaries/dlls', fileName),
    ];
    for (const sp of searchPaths) {
      if (fs.existsSync(sp)) return 1;
    }
    return 0;
  };

  const imports = { host: h };

  const wasmModule = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(wasmModule, imports);
  ctx.exports = instance.exports;
  if (renderer) {
    renderer.wasm = instance;
    renderer.wasmMemory = memory;
  }

  // Create ThreadManager now that we have the main instance
  const makeWorkerImports = (tid) => {
    const workerCtx = {
      getMemory: () => memory.buffer,
      renderer,
      onExit: () => {},
      trace: traceCategories,
      vfs: ctx.vfs,  // share filesystem with main thread
      exports: instance.exports,  // share main instance exports for g2w
      _audioOutFd: ctx._audioOutFd,  // share audio output fd
      _sharedAudio: ctx._sharedAudio,  // share waveOut state across threads
      sharedGdi: base.gdi,  // share GDI handles so worker BitBlt can see main-thread bitmaps
    };
    const workerBase = createHostImports(workerCtx);
    const wh = workerBase.host;
    wh.memory = memory;
    // Wire thread/event to same ThreadManager
    wh.create_thread = h.create_thread;
    wh.exit_thread = h.exit_thread;
    wh.create_event = h.create_event;
    wh.set_event = h.set_event;
    wh.reset_event = h.reset_event;
    wh.wait_single = h.wait_single;
    // Worker logging
    wh.log = (ptr, len) => {
      const b = new Uint8Array(memory.buffer, ptr, Math.min(len, 256));
      let t = '';
      for (let i = 0; i < b.length && b[i]; i++) t += String.fromCharCode(b[i]);
      if (TRACE_API) logs.push(`[API T${tid}] ${t}`);
    };
    wh.log_i32 = (val) => {
      if (TRACE_API) logs.push(`  => ${hex(val)}`);
    };
    wh.exit = () => {};
    wh.has_dll_file = h.has_dll_file;
    return { host: wh };
  };

  threadManager = new ThreadManager(wasmModule, memory, instance, makeWorkerImports);

  const mem = new Uint8Array(memory.buffer);
  mem.set(exeBytes, instance.exports.get_staging());
  const entry = instance.exports.load_pe(exeBytes.length);
  console.log('PE loaded. Entry: ' + hex(entry));

  // Initialize DirectX COM vtable thunks (must be after load_pe sets image_base)
  if (instance.exports.init_dx_com_thunks) {
    instance.exports.init_dx_com_thunks();
  }

  // Set EXE name from path
  if (instance.exports.set_exe_name) {
    const exeName = path.basename(EXE_PATH);
    const nameBytes = Buffer.from(exeName);
    const staging = instance.exports.get_staging();
    mem.set(nameBytes, staging);
    instance.exports.set_exe_name(staging, nameBytes.length);
  }

  // Pass extra command-line arguments via the staging buffer (--args="...")
  if (EXTRA_ARGS && instance.exports.set_extra_cmdline) {
    const argBytes = Buffer.from(EXTRA_ARGS);
    const staging = instance.exports.get_staging();
    mem.set(argBytes, staging);
    instance.exports.set_extra_cmdline(staging, argBytes.length);
    console.log(`Extra cmdline args: ${JSON.stringify(EXTRA_ARGS)}`);
  }

  // Set emulated Windows version
  if (WINVER && instance.exports.set_winver) {
    const versions = { 'win98': 0xC0000A04, 'nt4': 0x05650004, 'win2k': 0x05650005, 'winxp': 0x0A280105 };
    const v = versions[WINVER.toLowerCase()] || parseInt(WINVER);
    if (v) { instance.exports.set_winver(v); console.log('Windows version: ' + hex(v)); }
  }

  // Load DLLs: explicit --dlls=path1,path2,... or auto-detect from EXE imports
  const dllArg = getArg('dlls', null);
  const dllDir = path.join(path.dirname(EXE_PATH), 'dlls');
  let dlls;
  if (dllArg) {
    dlls = dllArg.split(',').map(p => ({
      name: path.basename(p.trim()),
      bytes: fs.readFileSync(p.trim()),
    }));
  } else {
    // Auto-detect: scan EXE imports, load any DLLs found in test/binaries/dlls/
    const required = detectRequiredDlls(exeBytes);
    // Only load DLLs that work as real PE DLLs; others are handled by WAT stub handlers
    const LOADABLE_DLLS = new Set(['msvcrt.dll', 'mfc42.dll', 'mfc42u.dll', 'comctl32.dll',
      'msvcp60.dll', 'riched20.dll', 'cabinet.dll', 'usp10.dll', 'cards.dll']);
    const dllSearchDirs = [dllDir, path.dirname(EXE_PATH), path.join(__dirname, 'binaries', 'dlls')];
    dlls = [];
    for (const name of required) {
      if (!LOADABLE_DLLS.has(name.toLowerCase())) continue;
      for (const dir of dllSearchDirs) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) {
          dlls.push({ name, bytes: fs.readFileSync(p) });
          break;
        }
      }
    }
  }
  if (dlls.length > 0) {
    const dllResults = loadDlls(instance.exports, memory.buffer, exeBytes, dlls, console.log, {
      exeName: path.basename(EXE_PATH),
      extraArgs: EXTRA_ARGS || '',
    });
    stopped = false;
    // gdi_load_bitmap walks the main EXE's RT_BITMAP via WAT's
    // $find_resource. DLL bitmaps (cards.dll for sol/freecell, etc.)
    // still come from a per-module byte index extracted here because
    // WAT's resource walker only knows about $rsrc_rva.
    const { extractBitmapBytes } = require('../lib/dib');
    ctx.dllResources = {};
    if (dllResults) {
      for (let i = 0; i < dlls.length && i < dllResults.length; i++) {
        try {
          const bitmapBytes = extractBitmapBytes(dlls[i].bytes);
          const count = Object.keys(bitmapBytes).length;
          if (count > 0) {
            ctx.dllResources[dllResults[i].loadAddr] = { bitmapBytes };
            console.log(`DLL resources: ${dlls[i].name} has ${count} bitmaps`);
          }
        } catch (_) {}
      }
    }
  }



  // Pre-populate EXE in virtual filesystem so CreateFileA on itself works
  // GetModuleFileNameA returns "C:\app.exe" — inject EXE bytes at that path
  if (ctx.vfs) {
    const exeData = new Uint8Array(exeBytes);
    ctx.vfs.files.set('c:\\app.exe', { data: exeData, attrs: 0x20 });
    // Also register under the real basename in case something uses it differently
    const exeName = path.basename(EXE_PATH).toLowerCase();
    ctx.vfs.files.set('c:\\' + exeName, { data: exeData, attrs: 0x20 });
    // Pre-load companion files from EXE's directory (data files, bitmaps, etc.)
    // Recursively scan subdirectories too (e.g. Plugins/ for Winamp)
    const exeDir = path.dirname(EXE_PATH);
    const loadDir = (hostDir, vfsPrefix) => {
      for (const f of fs.readdirSync(hostDir)) {
        if (vfsPrefix === 'c:\\' && f.toLowerCase() === exeName) continue;
        const fpath = path.join(hostDir, f);
        try {
          const stat = fs.statSync(fpath);
          if (stat.isFile()) {
            ctx.vfs.files.set(vfsPrefix + f.toLowerCase(), {
              data: new Uint8Array(fs.readFileSync(fpath)), attrs: 0x20
            });
          } else if (stat.isDirectory() && f !== '.' && f !== '..') {
            const subDir = vfsPrefix + f.toLowerCase() + '\\';
            ctx.vfs.dirs.add(subDir);
            loadDir(fpath, subDir);
          }
        } catch (_) {}
      }
    };
    loadDir(exeDir, 'c:\\');
  }

  const regs = () => {
    const e = instance.exports;
    return `EIP=${hex(e.get_eip())} EAX=${hex(e.get_eax())} ECX=${hex(e.get_ecx())} EDX=${hex(e.get_edx())} EBX=${hex(e.get_ebx())} ESP=${hex(e.get_esp())} EBP=${hex(e.get_ebp())} ESI=${hex(e.get_esi())} EDI=${hex(e.get_edi())}`;
  };

  const g2w = addr => {
    const imageBase = instance.exports.get_image_base();
    return addr - imageBase + 0x12000;
  };

  const dumpStack = (label, count = 14) => {
    try {
      const esp = instance.exports.get_esp();
      const dv = new DataView(memory.buffer);
      console.log(`  ${label || 'Stack'} around ESP=${hex(esp)}:`);
      for (let i = -2; i < count; i++) {
        const addr = esp + i * 4;
        try {
          const val = dv.getUint32(g2w(addr), true);
          const marker = i === 0 ? ' <-- ESP' : '';
          console.log(`    [${hex(addr)}] = ${hex(val)}${marker}`);
        } catch (_) { break; }
      }
    } catch (_) {}
  };

  const { disasmAt: _disasm } = require('../tools/disasm');
  const disasmAt = (eip, count = 16) => {
    try {
      const wa = g2w(eip);
      const buf = new Uint8Array(memory.buffer, wa, Math.min(count * 15, memory.buffer.byteLength - wa));
      const lines = _disasm(buf, 0, eip, count);
      lines.forEach(l => console.log('  ' + l));
    } catch (_) {
      console.log(`  Cannot disasm at ${hex(eip)}`);
    }
  };

  const dumpSEH = (detailed) => {
    try {
      const fsBase = instance.exports.get_fs_base();
      const imageBase = instance.exports.get_image_base();
      const dv = new DataView(memory.buffer);
      let ptr = dv.getUint32(g2w(fsBase), true);

      if (detailed) {
        console.log(`\n=== SEH Chain ===`);
        console.log(`FS base (TIB): ${hex(fsBase)}`);
        console.log(`FS:[0x00] SEH head:    ${hex(ptr)}`);
        console.log(`FS:[0x04] Stack top:   ${hex(dv.getUint32(g2w(fsBase + 4), true))}`);
        console.log(`FS:[0x08] Stack bottom:${hex(dv.getUint32(g2w(fsBase + 8), true))}`);
        console.log(`FS:[0x18] Self:        ${hex(dv.getUint32(g2w(fsBase + 0x18), true))}`);
        console.log('\nSEH frames:');
      } else {
        console.log(`  SEH chain (fs_base=${hex(fsBase)}, fs:[0]=${hex(ptr)}):`);
      }

      let depth = 0;
      while (ptr !== 0xFFFFFFFF && ptr !== 0 && depth < 32) {
        const next = dv.getUint32(g2w(ptr), true);
        const handler = dv.getUint32(g2w(ptr + 4), true);

        let extra = '';
        if (detailed) {
          try {
            const frameEbp = ptr + 8;
            const trylevel = dv.getInt32(g2w(frameEbp - 4), true);
            const funcInfo = dv.getUint32(g2w(frameEbp - 8), true);
            if (funcInfo >= imageBase && funcInfo < imageBase + 0x20000) {
              const magic = dv.getUint32(g2w(funcInfo), true);
              if ((magic & 0xFFFFFFF0) === 0x19930520) {
                const nUnwind = dv.getUint32(g2w(funcInfo + 4), true);
                const nTry = dv.getUint32(g2w(funcInfo + 12), true);
                extra = ` [EH_prolog] trylevel=${trylevel} funcInfo=${hex(funcInfo)} magic=${hex(magic)} nUnwind=${nUnwind} nTry=${nTry}`;
                if (nTry > 0) {
                  const tryMapRva = dv.getUint32(g2w(funcInfo + 16), true);
                  for (let t = 0; t < Math.min(nTry, 4); t++) {
                    const tryAddr = tryMapRva + t * 20;
                    const tryLow = dv.getInt32(g2w(tryAddr), true);
                    const tryHigh = dv.getInt32(g2w(tryAddr + 4), true);
                    const catchHigh = dv.getInt32(g2w(tryAddr + 8), true);
                    const nCatch = dv.getInt32(g2w(tryAddr + 12), true);
                    const catchArr = dv.getUint32(g2w(tryAddr + 16), true);
                    extra += `\n      try[${t}]: levels ${tryLow}-${tryHigh}, catchHigh=${catchHigh}, nCatch=${nCatch}`;
                    for (let c = 0; c < Math.min(nCatch, 4); c++) {
                      const catchAddr = catchArr + c * 16;
                      const flags = dv.getUint32(g2w(catchAddr), true);
                      const typeInfo = dv.getUint32(g2w(catchAddr + 4), true);
                      const dispObj = dv.getInt32(g2w(catchAddr + 8), true);
                      const handlerAddr = dv.getUint32(g2w(catchAddr + 12), true);
                      extra += `\n        catch[${c}]: flags=${hex(flags)} type=${hex(typeInfo)} dispObj=${dispObj} handler=${hex(handlerAddr)}`;
                    }
                  }
                }
              }
            }
          } catch (_) {}
        }

        const indent = detailed ? '  ' : '    ';
        console.log(`${indent}[${depth}] ${hex(ptr)}: next=${hex(next)} handler=${hex(handler)}${extra}`);
        ptr = next;
        depth++;
      }
      if (depth === 0) console.log(detailed ? '  (empty — head is 0xFFFFFFFF)' : '    (empty - head is 0xFFFFFFFF)');

      // EBP chain in detailed mode
      if (detailed) {
        console.log('\n=== EBP Chain ===');
        let ebp = instance.exports.get_ebp();
        for (let i = 0; i < 20 && ebp > 0 && ebp < 0x01A00000; i++) {
          const savedEbp = dv.getUint32(g2w(ebp), true);
          const retAddr = dv.getUint32(g2w(ebp + 4), true);
          let ehInfo = '';
          try {
            const funcInfo = dv.getUint32(g2w(ebp - 8), true);
            if (funcInfo >= imageBase && funcInfo < imageBase + 0x20000) {
              const magic = dv.getUint32(g2w(funcInfo), true);
              if ((magic & 0xFFFFFFF0) === 0x19930520) {
                const trylevel = dv.getInt32(g2w(ebp - 4), true);
                ehInfo = ` [EH frame] trylevel=${trylevel} funcInfo=${hex(funcInfo)}`;
              }
            }
          } catch (_) {}
          console.log(`  [${i}] EBP=${hex(ebp)} saved=${hex(savedEbp)} ret=${hex(retAddr)}${ehInfo}`);
          ebp = savedEbp;
        }
      }
    } catch (e) {
      console.log(`  SEH dump error: ${e.message}`);
    }
  };

  const hexdump = (guestAddr, len) => {
    const dv = new DataView(memory.buffer);
    console.log(`Hexdump ${hex(guestAddr)} (${len} bytes):`);
    for (let off = 0; off < len; off += 16) {
      let hexPart = '', ascPart = '';
      for (let i = 0; i < 16 && off + i < len; i++) {
        const b = dv.getUint8(g2w(guestAddr + off + i));
        hexPart += b.toString(16).padStart(2, '0') + ' ';
        ascPart += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.';
      }
      console.log(`  ${hex(guestAddr + off)}  ${hexPart.padEnd(49)}${ascPart}`);
    }
  };

  let prevEip = 0, stuckCount = 0, prevApiCount = 0;
  let stepping = false;  // single-step mode after breakpoint
  let apiBreakHit = null; // set when an API breakpoint triggers

  // Watchpoint: WASM-level per-block memory watch (dword granularity)
  let watchAddr = 0, watchPrevVal = 0;
  if (WATCH_SPEC) {
    const addrStr = WATCH_SPEC.split(':')[0];
    watchAddr = parseInt(addrStr, 16);
    console.log(`Watchpoint set: ${hex(watchAddr)} (dword, checked every block)`);
  }

  const activateWatchpoint = () => {
    if (!watchAddr) return;
    instance.exports.set_watchpoint(watchAddr);
    watchPrevVal = instance.exports.get_watch_val();
  };
  activateWatchpoint();

  const watchFilterVal = WATCH_VALUE !== null ? parseInt(WATCH_VALUE, 16) : null;

  const checkWatchpoint = (batch) => {
    if (!watchAddr) return false;
    const newVal = instance.exports.get_watch_val();
    if (newVal === watchPrevVal) return false;
    if (watchFilterVal !== null && (newVal >>> 0) !== (watchFilterVal >>> 0)) {
      watchPrevVal = newVal;
      return false;
    }
    console.log(`\n*** WATCHPOINT hit at batch ${batch}: [${hex(watchAddr)}] changed`);
    console.log(`  Old: ${hex(watchPrevVal)}  New: ${hex(newVal)}  EIP: ${hex(instance.exports.get_eip())}`);
    watchPrevVal = newVal;
    return true;
  };

  const debugPrompt = async (reason) => {
    console.log('  ' + regs());
    dumpStack(reason);
    disasmAt(instance.exports.get_eip());
    if (TRACE_SEH) dumpSEH();
    while (logs.length) console.log(logs.shift());
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve =>
      rl.question('[s]tep/[c]ont/[d]ump ADDR:LEN/[w]atch ADDR/[r]egs/[q]uit > ', resolve)
    );
    rl.close();
    const cmd = answer.trim().toLowerCase();
    if (cmd === 'q') { process.exit(0); }
    if (cmd === 'c') { stepping = false; return; }
    if (cmd === 's' || cmd === '') { stepping = true; return; }
    if (cmd === 'r') { console.log(regs()); return debugPrompt(reason); }
    if (cmd.startsWith('d')) {
      const parts = cmd.slice(1).trim().split(':');
      const addr = parseInt(parts[0], 16);
      const len = parseInt(parts[1]) || 64;
      if (!isNaN(addr)) hexdump(addr, len);
      return debugPrompt(reason);
    }
    if (cmd.startsWith('w')) {
      const addr = parseInt(cmd.slice(1).trim(), 16);
      if (!isNaN(addr) && addr) {
        watchAddr = addr;
        instance.exports.set_watchpoint(addr);
        watchPrevVal = instance.exports.get_watch_val();
        console.log(`  Watchpoint set: ${hex(addr)} (current: ${hex(watchPrevVal)})`);
      } else if (cmd === 'w') {
        if (watchAddr) console.log(`  Watchpoint: ${hex(watchAddr)} = ${hex(instance.exports.get_watch_val())}`);
        else console.log('  No watchpoint. Use: w 0xADDR');
      }
      return debugPrompt(reason);
    }
    stepping = true;
  };

  for (let batch = 0; batch < MAX_BATCHES && !stopped; batch++) {
    tickState.batch = batch;
    tickState.callsInBatch = 0;
    // Inject scheduled input events at the right batch
    while (scheduledInput.length && scheduledInput[0].batch <= batch) {
      const ev = scheduledInput.shift();
      // UI-level events go through renderer handlers (mouse/keyboard pump),
      // raw events go directly into inputQueue.
      if (ev.action === 'focus-find' && renderer) {
        // Find dialog is now driven entirely from WAT — set focus on the
        // WAT-side EditState directly. No JS controls[] mirroring needed.
        const watDlg = instance.exports.get_findreplace_dlg && instance.exports.get_findreplace_dlg();
        const watEdit = instance.exports.get_findreplace_edit && instance.exports.get_findreplace_edit();
        if (watDlg && watEdit) {
          instance.exports.set_focus_hwnd(watEdit);
          const scratchG = instance.exports.guest_alloc(256);
          const n = instance.exports.get_edit_text(watEdit, scratchG, 255);
          const dv = new DataView(memory.buffer);
          let txt = '';
          for (let i = 0; i < n; i++) txt += String.fromCharCode(dv.getUint8(g2w(scratchG) + i));
          logs.push(`[input] focus-find: hwnd=0x${watDlg.toString(16)} editText=${JSON.stringify(txt)} at batch ${batch}`);
        } else {
          logs.push(`[input] focus-find: NO FIND DIALOG at batch ${batch}`);
        }
      } else if (ev.action === 'dump-find' && renderer) {
        // Read EditState text directly from WAT — find dialog has no JS
        // controls[] mirror anymore.
        const watDlg = instance.exports.get_findreplace_dlg && instance.exports.get_findreplace_dlg();
        const watEdit = instance.exports.get_findreplace_edit && instance.exports.get_findreplace_edit();
        if (watDlg && watEdit) {
          const scratchG = instance.exports.guest_alloc(256);
          const n = instance.exports.get_edit_text(watEdit, scratchG, 255);
          const dv = new DataView(memory.buffer);
          let txt = '';
          for (let i = 0; i < n; i++) txt += String.fromCharCode(dv.getUint8(g2w(scratchG) + i));
          const focusedNow = instance.exports.get_focus_hwnd() === watEdit;
          logs.push(`[input] dump-find: hwnd=0x${watDlg.toString(16)} focused=${focusedNow} editText=${JSON.stringify(txt)} text=${JSON.stringify(txt)} at batch ${batch}`);
        } else {
          logs.push(`[input] dump-find: NO FIND DIALOG at batch ${batch}`);
        }
      } else if (ev.action === 'find-click' && renderer) {
        const we = instance.exports;
        const dlg = we.get_findreplace_dlg && we.get_findreplace_dlg();
        if (dlg) {
          // Find the WAT-side child with this ctrl_id and dispatch
          // WM_LBUTTONDOWN/UP through send_message — same path the
          // renderer click handler now uses.
          let s = 0, found = 0;
          while ((s = we.wnd_next_child_slot(dlg, s)) !== -1) {
            const ch = we.wnd_slot_hwnd(s);
            if (we.ctrl_get_id(ch) === ev.ctrlId) { found = ch; break; }
            s++;
          }
          if (found) {
            we.send_message(found, 0x0201, 0, 0);
            we.send_message(found, 0x0202, 0, 0);
            logs.push(`[input] find-click: id=0x${ev.ctrlId.toString(16)} hwnd=0x${found.toString(16)} at batch ${batch}`);
            {
              const dv = new DataView(memory.buffer);
              const entries = [];
              for (let i = 0; i < 8; i++) {
                const h = dv.getUint32(0x400 + i*16, true);
                const m = dv.getUint32(0x400 + i*16 + 4, true);
                if (!h && !m) continue;
                const wp = dv.getUint32(0x400 + i*16 + 8, true);
                const lp = dv.getUint32(0x400 + i*16 + 12, true);
                entries.push(`[${i}] h=0x${h.toString(16)} m=0x${m.toString(16)} wp=0x${wp.toString(16)} lp=0x${lp.toString(16)}`);
              }
              logs.push(`[input] post_queue after find-click: ${entries.length ? entries.join(' | ') : '(empty)'}`);
            }
          } else {
            logs.push(`[input] find-click: id=0x${ev.ctrlId.toString(16)} NOT FOUND at batch ${batch}`);
          }
        } else {
          logs.push(`[input] find-click: no find dialog at batch ${batch}`);
        }
      } else if (ev.action === 'slot-count') {
        const we = instance.exports;
        const dlg = we.get_findreplace_dlg && we.get_findreplace_dlg();
        const used = we.wnd_count_used ? we.wnd_count_used() : -1;
        const tag = ev.label ? ` ${ev.label}` : '';
        logs.push(`[input] slot-count${tag}: used=${used} dlg=0x${(dlg||0).toString(16)} at batch ${batch}`);
      } else if (ev.action === 'open-dlg-pick') {
        // Walk slots for a class-12 (Open/Save) dialog parent, find its
        // filename edit child (ctrl id 0x442), WM_SETTEXT a heap-alloc'd
        // filename, then post WM_COMMAND id=IDOK=1 to the dialog.
        const we = instance.exports;
        let dlg = 0;
        for (let s = 0; s < 256; s++) {
          const h = we.wnd_slot_hwnd(s);
          if (h && we.ctrl_get_class(h) === 12) { dlg = h; break; }
        }
        if (!dlg) {
          logs.push(`[input] open-dlg-pick: no class-12 dialog at batch ${batch}`);
        } else {
          // Find filename edit by walking parent's children
          let edit = 0;
          let s = 0;
          while ((s = we.wnd_next_child_slot(dlg, s)) !== -1) {
            const h = we.wnd_slot_hwnd(s);
            if (we.ctrl_get_class(h) === 2 && we.ctrl_get_id(h) === 0x442) { edit = h; break; }
            s++;
          }
          if (!edit) {
            logs.push(`[input] open-dlg-pick: no filename edit at batch ${batch}`);
          } else {
            // Alloc the filename in guest memory + WM_SETTEXT it
            const name = ev.filename;
            const g = we.guest_alloc(name.length + 1);
            const wa = g2w(g);
            const u8 = new Uint8Array(memory.buffer);
            for (let i = 0; i < name.length; i++) u8[wa + i] = name.charCodeAt(i);
            u8[wa + name.length] = 0;
            we.send_message(edit, 0x000C, 0, g);       // WM_SETTEXT
            we.send_message(dlg, 0x0111, 1, 0);        // WM_COMMAND IDOK
            logs.push(`[input] open-dlg-pick: ${name} at batch ${batch}`);
          }
        }
      } else if (ev.action === 'edit-ok') {
        // Find an Edit (class 2) with ctrl_id == ev.ctrlId, WM_SETTEXT with
        // ev.text, then WM_COMMAND IDOK=1 to its parent dialog. Parent is
        // discovered by walking wnd_next_child_slot on other slots.
        const we = instance.exports;
        let edit = 0;
        for (let s = 0; s < 256; s++) {
          const h = we.wnd_slot_hwnd(s);
          if (!h) continue;
          if (we.ctrl_get_class(h) === 2 && we.ctrl_get_id(h) === ev.ctrlId) {
            edit = h; break;
          }
        }
        if (!edit) {
          logs.push(`[input] edit-ok: no edit id=${ev.ctrlId} at batch ${batch}`);
        } else {
          let dlg = 0;
          for (let s = 0; s < 256; s++) {
            const h = we.wnd_slot_hwnd(s);
            if (!h || h === edit) continue;
            let cs = 0;
            while ((cs = we.wnd_next_child_slot(h, cs)) !== -1) {
              if (we.wnd_slot_hwnd(cs) === edit) { dlg = h; break; }
              cs++;
            }
            if (dlg) break;
          }
          const text = String(ev.text);
          const g = we.guest_alloc(text.length + 1);
          const wa = g2w(g);
          const u8 = new Uint8Array(memory.buffer);
          for (let i = 0; i < text.length; i++) u8[wa + i] = text.charCodeAt(i);
          u8[wa + text.length] = 0;
          we.send_message(edit, 0x000C, 0, g); // WM_SETTEXT
          if (dlg) we.send_message(dlg, 0x0111, 1, 0); // WM_COMMAND IDOK
          logs.push(`[input] edit-ok: id=${ev.ctrlId} text="${text}" edit=0x${edit.toString(16)} dlg=0x${(dlg||0).toString(16)} at batch ${batch}`);
        }
      } else if (ev.action === 'class-cmd') {
        // Walk WND_RECORDS, find first hwnd whose control class matches,
        // then send WM_COMMAND. Used to close About dialog (class 11) etc.
        const we = instance.exports;
        let found = 0;
        for (let s = 0; s < 256; s++) {
          const hwnd = we.wnd_slot_hwnd ? we.wnd_slot_hwnd(s) : 0;
          if (!hwnd) continue;
          const cls = we.ctrl_get_class ? we.ctrl_get_class(hwnd) : 0;
          if (cls === ev.ctrlClass) { found = hwnd; break; }
        }
        if (found) {
          we.send_message(found, 0x0111, ev.cmdId, 0);
          logs.push(`[input] class-cmd: class=${ev.ctrlClass} cmd=${ev.cmdId} hwnd=0x${found.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] class-cmd: class=${ev.ctrlClass} NOT FOUND at batch ${batch}`);
        }
      } else if (ev.action === 'dump-fr' && renderer) {
        // Read the FR struct from the dialog's userdata via the WAT side.
        // For find dialog the userdata holds the guest FR ptr; FR.Flags
        // is at +0x0C, FR.lpstrFindWhat at +0x10.
        const we = instance.exports;
        const dlg = we.get_findreplace_dlg && we.get_findreplace_dlg();
        if (dlg) {
          const frG = we.wnd_get_userdata_export ? we.wnd_get_userdata_export(dlg) : 0;
          if (frG) {
            const dv = new DataView(memory.buffer);
            const wa = g2w(frG);
            const flags = dv.getUint32(wa + 0x0C, true);
            const findBufG = dv.getUint32(wa + 0x10, true);
            const findBufLen = dv.getUint16(wa + 0x18, true);
            const findBufWa = g2w(findBufG);
            const m8 = new Uint8Array(memory.buffer);
            let txt = '';
            for (let i = 0; i < findBufLen && m8[findBufWa + i]; i++) {
              txt += String.fromCharCode(m8[findBufWa + i]);
            }
            logs.push(`[input] dump-fr: flags=0x${flags.toString(16)} findWhat=${JSON.stringify(txt)} at batch ${batch}`);
          } else {
            logs.push(`[input] dump-fr: no FR ptr at batch ${batch}`);
          }
        }
      } else if (ev.action === 'keypress' && renderer && renderer.handleKeyPress) {
        // renderer.handleKeyPress already routes WM_CHAR to WAT when a
        // WAT-managed edit has focus (see renderer-input.js), so don't
        // also call send_char_to_focus here — that double-delivered
        // each character to the find-dialog edit ("ABC" → "AABBCC").
        renderer.handleKeyPress(ev.code);
        logs.push(`[input] keypress code=${ev.code} at batch ${batch}`);
      } else if (ev.action === 'keydown' && renderer && renderer.handleKeyDown) {
        renderer.handleKeyDown(ev.code);
        logs.push(`[input] keydown vk=${ev.code} at batch ${batch}`);
      } else if (ev.action === 'keyup' && renderer && renderer.handleKeyUp) {
        renderer.handleKeyUp(ev.code);
        logs.push(`[input] keyup vk=${ev.code} at batch ${batch}`);
      } else if (ev.action === 'png' && renderer && renderer.canvas) {
        try {
          if (typeof renderer.repaint === 'function') renderer.repaint();
          const buf = renderer.canvas.toBuffer('image/png');
          fs.writeFileSync(ev.path, buf);
          logs.push(`[input] png ${ev.path} (${buf.length} bytes) at batch ${batch}`);
          if (DUMP_BACKCANVAS) {
            for (const [hwndStr, win] of Object.entries(renderer.windows)) {
              if (win._backCanvas && win._backCanvas.toBuffer) {
                const bcPath = ev.path.replace('.png', `_back_${hwndStr}.png`);
                fs.writeFileSync(bcPath, win._backCanvas.toBuffer('image/png'));
                logs.push(`[input] back-canvas ${bcPath}`);
              }
            }
          }
        } catch (e) {
          logs.push(`[input] png FAILED ${ev.path}: ${e.message} at batch ${batch}`);
        }
      } else if (ev.action === 'winamp-play') {
        // Winamp IPC: write filename to guest memory, send WM_USER messages
        const we = instance.exports;
        const nameLen = ev.filename.length;
        // Allocate from heap so the string survives until dispatch
        // IPC_PLAYFILE dereferences wParam: fn = *(char**)wParam
        const nameGA = we.guest_alloc(nameLen + 1);
        const ptrGA = we.guest_alloc(4);
        const mem8 = new Uint8Array(memory.buffer);
        for (let i = 0; i < nameLen; i++) mem8[g2w(nameGA) + i] = ev.filename.charCodeAt(i);
        mem8[g2w(nameGA) + nameLen] = 0;
        we.guest_write32(ptrGA, nameGA);
        // Verify writes
        const verifyStr = Array.from(mem8.slice(g2w(nameGA), g2w(nameGA) + nameLen)).map(c => String.fromCharCode(c)).join('');
        const verifyPtr = we.guest_read32(ptrGA);
        logs.push(`[winamp-play] nameGA=0x${nameGA.toString(16)} ptrGA=0x${ptrGA.toString(16)} str="${verifyStr}" [ptrGA]=0x${verifyPtr.toString(16)}`);
        const dv = new DataView(memory.buffer);
        const mainHwnd = we.get_main_hwnd();
        // Restore original WndProc so IPC reaches Winamp's handler
        const origWndproc = we.get_wndproc();
        if (we.wnd_table_set) {
          we.wnd_table_set(mainHwnd, origWndproc);
        }
        const postCount = we.get_post_queue_count ? we.get_post_queue_count() : 0;
        const ipcMsgs = [
          { hwnd: mainHwnd, msg: 0x400, wParam: 0, lParam: 101 },       // IPC_DELETE
          { hwnd: mainHwnd, msg: 0x400, wParam: ptrGA, lParam: 100 },    // IPC_PLAYFILE (wParam -> ptr -> string)
          // IPC_PLAYFILE auto-plays; don't send IPC_STARTPLAY here — it would Stop() the
          // just-started decode threads and restart, wasting decoded audio.
        ];
        for (let i = 0; i < ipcMsgs.length && postCount + i < 8; i++) {
          const off = 0x400 + (postCount + i) * 16;
          dv.setUint32(off, ipcMsgs[i].hwnd, true);
          dv.setUint32(off + 4, ipcMsgs[i].msg, true);
          dv.setUint32(off + 8, ipcMsgs[i].wParam, true);
          dv.setUint32(off + 12, ipcMsgs[i].lParam, true);
        }
        if (we.set_post_queue_count) {
          we.set_post_queue_count(postCount + Math.min(ipcMsgs.length, 8 - postCount));
        }
        logs.push(`[input] winamp-play: "${ev.filename}" at GA=0x${nameGA.toString(16)} batch ${batch}`);
      } else if (ev.action === 'winamp-start') {
        // Post IPC_STARTPLAY to the main Winamp window
        const we = instance.exports;
        const mainHwnd = we.get_main_hwnd();
        const postCount = we.get_post_queue_count ? we.get_post_queue_count() : 0;
        if (postCount < 8) {
          const dv = new DataView(memory.buffer);
          const off = 0x400 + postCount * 16;
          dv.setUint32(off, mainHwnd, true);
          dv.setUint32(off + 4, 0x400, true);     // WM_USER
          dv.setUint32(off + 8, 0, true);          // wParam=0
          dv.setUint32(off + 12, 102, true);       // lParam=102 (IPC_STARTPLAY)
          we.set_post_queue_count(postCount + 1);
        }
        logs.push(`[input] winamp-start at batch ${batch}`);
      } else if (ev.action === 'post-cmd') {
        const we = instance.exports;
        const mainHwnd = we.get_main_hwnd();
        const postCount = we.get_post_queue_count ? we.get_post_queue_count() : 0;
        if (postCount < 8) {
          const dv = new DataView(memory.buffer);
          const off = 0x400 + postCount * 16;
          dv.setUint32(off, mainHwnd, true);
          dv.setUint32(off + 4, 0x111, true);     // WM_COMMAND
          dv.setUint32(off + 8, ev.wParam, true);
          dv.setUint32(off + 12, 0, true);
          we.set_post_queue_count(postCount + 1);
        }
        logs.push(`[input] post-cmd wParam=0x${ev.wParam.toString(16)} at batch ${batch}`);
      } else if (ev.action === 'poke') {
        const wa = g2w(ev.addr);
        const dv = new DataView(memory.buffer);
        dv.setUint32(wa, ev.value, true);
        logs.push(`[input] poke [0x${ev.addr.toString(16)}] = 0x${ev.value.toString(16)} at batch ${batch}`);
      } else if (ev.action === 'click' && renderer && renderer.handleMouseDown) {
        renderer.handleMouseDown(ev.x, ev.y, 1);
        if (renderer.handleMouseUp) renderer.handleMouseUp(ev.x, ev.y, 1);
        logs.push(`[input] click ${ev.x},${ev.y} at batch ${batch}`);
      } else if (ev.action === 'mousedown' && renderer && renderer.handleMouseDown) {
        renderer.handleMouseDown(ev.x, ev.y, 1);
        logs.push(`[input] mousedown ${ev.x},${ev.y} at batch ${batch}`);
      } else if (ev.action === 'rclick' && renderer && renderer.handleMouseDown) {
        renderer.handleMouseDown(ev.x, ev.y, 2);
        renderer.handleMouseUp(ev.x, ev.y, 2);
        logs.push(`[input] rclick ${ev.x},${ev.y} at batch ${batch}`);
      } else if (ev.action === 'dblclick' && renderer && renderer.handleMouseDown) {
        // First click primes the system; the DBLCLK is injected for the
        // top-level window under the cursor. FreeCell uses it for auto-
        // move-to-home. No CS_DBLCLKS detection exists in the emulator, so
        // we synthesize the DBLCLK message directly.
        renderer.handleMouseDown(ev.x, ev.y, 1);
        renderer.handleMouseUp(ev.x, ev.y, 1);
        let targetWin = null;
        for (const w of Object.values(renderer.windows)) {
          if (!w.visible || w.parentHwnd) continue;
          if (ev.x >= w.x && ev.x < w.x + w.w && ev.y >= w.y && ev.y < w.y + w.h) {
            if (!targetWin || (w.z || 0) >= (targetWin.z || 0)) targetWin = w;
          }
        }
        if (targetWin) {
          const clientX = targetWin.x + 3;
          const hasMenu = renderer._hasMenuBar && renderer._hasMenuBar(targetWin);
          const clientY = targetWin.y + 3 + 18 + (hasMenu ? 18 : 0) + 1;
          const relX = ev.x - clientX;
          const relY = ev.y - clientY;
          renderer.inputQueue.push({
            type: 'mouse',
            hwnd: targetWin.hwnd,
            msg: 0x0203, // WM_LBUTTONDBLCLK
            wParam: 0x0001, // MK_LBUTTON
            lParam: ((relY & 0xFFFF) << 16) | (relX & 0xFFFF),
          });
          renderer.handleMouseUp(ev.x, ev.y, 1);
          logs.push(`[input] dblclick ${ev.x},${ev.y} hwnd=0x${targetWin.hwnd.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] dblclick ${ev.x},${ev.y} — no target window at batch ${batch}`);
        }
      } else if (ev.action === 'mouseup' && renderer && renderer.handleMouseUp) {
        renderer.handleMouseUp(ev.x, ev.y, 1);
        logs.push(`[input] mouseup ${ev.x},${ev.y} at batch ${batch}`);
      } else if (ev.action === 'mousemove' && renderer && renderer.handleMouseMove) {
        renderer.handleMouseMove(ev.x, ev.y);
        logs.push(`[input] mousemove ${ev.x},${ev.y} at batch ${batch}`);
      } else if (renderer) {
        renderer.inputQueue.push({ type: 'key', hwnd: 0, msg: ev.msg, wParam: ev.wParam, lParam: ev.lParam });
        logs.push(`[input] injected msg=0x${ev.msg.toString(16)} wParam=0x${ev.wParam.toString(16)} at batch ${batch}`);
      } else {
        inputEvent = { msg: ev.msg, wParam: ev.wParam, lParam: ev.lParam, hwnd: 0 };
        logs.push(`[input] injected msg=0x${ev.msg.toString(16)} wParam=0x${ev.wParam.toString(16)} at batch ${batch}`);
      }
    }

    const eipBefore = instance.exports.get_eip();

    // Skip check: simulate ret when EIP hits a skip address
    if (skipAddrs.length && skipAddrs.includes(eipBefore)) {
      const dv = new DataView(memory.buffer);
      const retAddr = dv.getUint32(g2w(instance.exports.get_esp()), true);
      console.log(`[skip] ${hex(eipBefore)} -> ret to ${hex(retAddr)}`);
      instance.exports.set_eip(retAddr);
      instance.exports.set_esp(instance.exports.get_esp() + 4);
      continue;
    }

    // WASM-level breakpoint: set once
    if (breakAddrs.length === 1 && batch === 0 && instance.exports.set_bp) {
      instance.exports.set_bp(breakAddrs[0]);
    }
    // Breakpoint check (EIP before run)
    if (breakAddrs.length && breakAddrs.includes(eipBefore)) {
      console.log(`\n*** BREAKPOINT hit at ${hex(eipBefore)} (batch ${batch})`);
      stepping = true;
      await debugPrompt('Break');
    }

    // Single-step mode
    if (stepping) {
      console.log(`[${batch}] EIP=${hex(eipBefore)}`);
      await debugPrompt('Step');
    }

    if (TRACE) {
      console.log(`[${batch}] >> ${hex(eipBefore)} ESP=${hex(instance.exports.get_esp())}`);
    }

    try {
      instance.exports.run(BATCH_SIZE);
    } catch (e) {
      while (logs.length) console.log(logs.shift());
      console.log(`\n*** CRASH at batch ${batch}: ${e.message}`);
      console.log('  Full stack:', e.stack.split('\n').slice(0, 15).join('\n    '));
      console.log('  EIP before batch: ' + hex(eipBefore));
      try { console.log('  thread_alloc: ' + hex(instance.exports.get_thread_alloc())); } catch (_) {}
      console.log('  ' + regs());
      disasmAt(eipBefore);
      disasmAt(instance.exports.get_eip());
      dumpStack();
      if (TRACE_SEH) dumpSEH();
      const frames = e.stack.split('\n').filter(l => l.includes('wasm-function'));
      if (frames.length) {
        console.log('  WASM stack:');
        frames.slice(0, 8).forEach(f => console.log('    ' + f.trim()));
      }
      process.exit(1);
    }

    // Flush deferred repaint so back canvas composites after all GDI writes
    if (renderer && renderer.flushRepaint) renderer.flushRepaint();

    // WASM-level breakpoint check (after run returns)
    {
      const eipNow = instance.exports.get_eip();
      if (breakAddrs.length && breakAddrs.includes(eipNow) && eipNow !== eipBefore) {
        console.log(`\n*** BREAKPOINT hit at ${hex(eipNow)} (batch ${batch}, WASM bp)`);
        if (instance.exports.get_dbg_prev_eip) console.log('  dbg_prev_eip=' + hex(instance.exports.get_dbg_prev_eip()));
        console.log('  ' + regs());
        dumpStack();
        // Re-arm WASM bp so subsequent hits also fire
        if (instance.exports.set_bp) instance.exports.set_bp(breakAddrs[0]);
      }
    }

    // Handle COM DLL loading yield (synchronous in Node.js)
    if (instance.exports.get_yield_reason() === 3) {
      const dllNameWA = instance.exports.get_com_dll_name();
      if (dllNameWA) {
        const mem8 = new Uint8Array(memory.buffer);
        let dllPathStr = '';
        for (let i = 0; i < 260; i++) {
          const ch = mem8[dllNameWA + i];
          if (!ch) break;
          dllPathStr += String.fromCharCode(ch);
        }
        const fileName = dllPathStr.split('\\').pop().toLowerCase();
        console.log(`[COM] Loading DLL: ${fileName}`);
        // Try to find the DLL file
        const searchPaths = [
          path.join(__dirname, 'binaries/dlls', fileName),
          path.join(path.dirname(EXE_PATH), fileName),
        ];
        let loaded = false;
        for (const sp of searchPaths) {
          if (fs.existsSync(sp)) {
            const dllBytes = new Uint8Array(fs.readFileSync(sp));
            const { loadDll: ld, patchExeImports: pe, callDllMain: cdm } = require('../lib/dll-loader');
            const result = ld(instance.exports, memory.buffer, dllBytes);
            console.log(`[COM] DLL loaded at 0x${result.loadAddr.toString(16)}`);
            pe(instance.exports, memory.buffer, new Uint8Array(fs.readFileSync(EXE_PATH)), [{ name: fileName, bytes: dllBytes }], console.log);
            if (result.dllMain && cdm) cdm(instance.exports, result.loadAddr, result.dllMain, console.log);
            loaded = true;
            break;
          }
        }
        if (!loaded) {
          console.log(`[COM] DLL not found: ${fileName}`);
          instance.exports.set_eax(0x80040154); // REGDB_E_CLASSNOTREG
          instance.exports.set_esp(instance.exports.get_esp() + 24);
        }
      }
      instance.exports.clear_yield();
    }

    // Handle LoadLibraryA yield (yield_reason=5)
    if (instance.exports.get_yield_reason() === 5) {
      const nameWA = instance.exports.get_loadlib_name();
      const mem8 = new Uint8Array(memory.buffer);
      let nameStr = '';
      if (nameWA > 0 && nameWA < mem8.length - 260) {
        for (let i = 0; i < 260; i++) {
          const ch = mem8[nameWA + i];
          if (!ch) break;
          nameStr += String.fromCharCode(ch);
        }
      }
      const fileName = nameStr.split('\\').pop().toLowerCase();
      // Search VFS for the DLL file
      let dllData = null;
      if (ctx.vfs) {
        // Try exact path first, then just filename in common locations
        const tryPaths = [
          nameStr.toLowerCase(),
          'c:\\' + fileName,
          'c:\\plugins\\' + fileName,
          'c:\\windows\\system\\' + fileName,
        ];
        for (const p of tryPaths) {
          const entry = ctx.vfs.files.get(p);
          if (entry) { dllData = entry.data; break; }
        }
      }
      // Also try host filesystem
      if (!dllData) {
        const searchPaths = [
          path.join(__dirname, 'binaries/dlls', fileName),
          path.join(path.dirname(EXE_PATH), fileName),
          path.join(path.dirname(EXE_PATH), 'plugins', fileName),
        ];
        for (const sp of searchPaths) {
          if (fs.existsSync(sp)) {
            dllData = new Uint8Array(fs.readFileSync(sp));
            break;
          }
        }
      }
      if (dllData) {
        const dllBytesArr = new Uint8Array(dllData);
        const { loadDll: ld, patchDllImports: pdi, callDllMain: cdm } = require('../lib/dll-loader');
        const result = ld(instance.exports, memory.buffer, dllBytesArr);
        console.log(`[LoadLibrary] ${fileName} loaded at 0x${result.loadAddr.toString(16)}, dllMain=0x${(result.dllMain>>>0).toString(16)}`);
        // Patch the new DLL's imports against all previously loaded DLLs
        pdi(instance.exports, memory.buffer,
          [{ name: fileName, bytes: dllBytesArr }],
          [result], console.log);
        // Call DllMain(DLL_PROCESS_ATTACH) — skip for now as it can trigger yields
        // Plugin DLLs don't need complex init; their real init is via the plugin API
        // if (result.dllMain && cdm) cdm(instance.exports, result.loadAddr, result.dllMain, console.log);
        instance.exports.set_eax(result.loadAddr);
      } else {
        console.log(`[LoadLibrary] DLL not found: ${fileName}`);
        instance.exports.set_eax(0);
      }
      // ESP and EIP already adjusted by WAT handler before yield
      instance.exports.clear_yield();
    }

    // Thread management: spawn pending threads, run worker slices
    if (threadManager._pendingThreads.length) {
      await threadManager.spawnPending();
    }
    if (threadManager.hasActiveThreads()) {
      // Give worker threads extra runtime when main thread is idle (e.g., waiting for extraction)
      const slices = installingFiles ? 1000 : 1;
      for (let s = 0; s < slices; s++) threadManager.runSlice(BATCH_SIZE);
    }
    // Check if main thread is waiting on an event
    if (threadManager.checkMainYield()) {
      // Main thread still waiting — don't advance EIP check
    }

// Watchpoint check
    if (checkWatchpoint(batch)) {
      stepping = true;
      await debugPrompt('Watch');
    }

    // API breakpoint check
    if (apiBreakHit) {
      while (logs.length) console.log(logs.shift());
      console.log(`\n*** API BREAKPOINT: ${apiBreakHit} (batch ${batch})`);
      apiBreakHit = null;
      stepping = true;
      await debugPrompt('API Break');
    }

    // Flush logs
    while (logs.length) console.log(logs.shift());

    const eip = instance.exports.get_eip();
if (VERBOSE) {
      console.log(`[${batch}] ${regs()}`);
    } else if (eip !== prevEip || apiCount !== prevApiCount) {
      if (eip !== prevEip) console.log(`[${batch}] ${regs()}`);
      prevEip = eip;
      prevApiCount = apiCount;
      stuckCount = 0;
    } else {
      stuckCount++;
      if (stuckCount > STUCK_AFTER && !scheduledInput.length) {
        console.log(`STUCK at EIP=${hex(eip)} after ${stuckCount} batches`);
        if (instance.exports.get_dbg_prev_eip) console.log(`  dbg_prev_eip=${hex(instance.exports.get_dbg_prev_eip())}`);
        dumpStack();
        break;
      }
    }
  }

  if (!stopped) {
    console.log('\n--- Final state ---');
    console.log(regs());
    if (instance.exports.get_wndproc) console.log('wndproc:', hex(instance.exports.get_wndproc()));
    if (instance.exports.get_thunk_base) console.log('thunk_base:', hex(instance.exports.get_thunk_base()), 'thunk_end:', hex(instance.exports.get_thunk_end()), 'num_thunks:', instance.exports.get_num_thunks());
    if (instance.exports.get_heap_ptr) console.log('heap_ptr:', hex(instance.exports.get_heap_ptr()));
    if (instance.exports.get_heap_base) console.log('heap_base:', hex(instance.exports.get_heap_base()));
  }

  // --peek=ADDR[:LEN],... — dump memory at end. Addrs >= image_base treated as
  // guest VA (translated via g2w); addrs below GUEST_BASE treated as raw WASM linear.
  const peekArg = args.find(a => a.startsWith('--peek='));
  if (peekArg) {
    const dv = new DataView(memory.buffer);
    const imgBase = instance.exports.get_image_base();
    for (const spec of peekArg.split('=')[1].split(',')) {
      const [a, l] = spec.split(':');
      const addr = parseInt(a, 16);
      const len = parseInt(l) || 4;
      const wa = (addr >= imgBase) ? g2w(addr) : addr;
      let line = `[peek] ${hex(addr)} (wa=${hex(wa)}): `;
      for (let i = 0; i < len; i += 4) {
        line += hex(dv.getUint32(wa + i, true)) + ' ';
      }
      console.log(line.trim());
    }
  }

  console.log(`\nStats: ${apiCount} API calls, ${MAX_BATCHES} batches`);

  if (DUMP_VFS && ctx.vfs) {
    console.log('\n[VFS] Files (' + ctx.vfs.files.size + '):');
    for (const [k, v] of ctx.vfs.files.entries()) {
      console.log(`  ${k} (${v.data.length} bytes)`);
    }
    console.log(`[VFS] Directories:`);
    for (const d of ctx.vfs.dirs) {
      console.log(`  ${d}\\`);
    }
  }

  if (SAVE_VFS && ctx.vfs) {
    for (const [k, v] of ctx.vfs.files.entries()) {
      if (k === 'c:\\app.exe') continue;
      const rel = k.replace(/^c:\\/, '');
      const outPath = path.join(SAVE_VFS, ...rel.split('\\'));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(v.data));
      console.log(`[save-vfs] ${outPath} (${v.data.length} bytes)`);
    }
  }

  if (DUMP_SPEC) {
    const [addrStr, lenStr] = DUMP_SPEC.split(':');
    const dumpAddr = parseInt(addrStr, 16);
    const dumpLen = parseInt(lenStr) || 256;
    hexdump(dumpAddr, dumpLen);
  }

  // Dump sprite list if requested
  if (args.includes('--dump-sprites')) {
    const { dumpSprites } = require('../tools/dump_sprites');
    dumpSprites(new Uint8Array(memory.buffer));
  }

  if (DUMP_SEH || TRACE_SEH) {
    dumpSEH(true);
  }

  if (PNG_OUT && renderer) {
    renderer.repaint();
    const pngBuf = renderer.canvas.toBuffer('image/png');
    fs.writeFileSync(PNG_OUT, pngBuf);
    console.log(`Wrote ${PNG_OUT} (${pngBuf.length} bytes)`);
    // DEBUG: also dump every window's _backCanvas so we can see what's
    // accumulated independent of the compositor.
    for (const [hwnd, win] of Object.entries(renderer.windows)) {
      if (win) {
        console.log(`  hwnd=${hwnd} pos=${win.x},${win.y} size=${win.w}x${win.h} client=${JSON.stringify(win.clientRect)} visible=${win.visible} title=${JSON.stringify(win.title)}`);
      }
      if (win && win._backCanvas) {
        const back = win._backCanvas.toBuffer('image/png');
        const out = PNG_OUT.replace(/\.png$/, `_back_${hwnd}.png`);
        fs.writeFileSync(out, back);
        console.log(`  Wrote ${out} (${back.length} bytes, ${win._backW}x${win._backH})`);
      }
    }
  }

  // Dump all GDI bitmaps as PNGs
  if (DUMP_GDI && createCanvas) {
    fs.mkdirSync(DUMP_GDI, { recursive: true });
    const gdiObjects = base.gdi._gdiObjects;
    let count = 0;
    for (const [handle, obj] of Object.entries(gdiObjects)) {
      if (!obj || obj.type !== 'bitmap' || !obj.w || !obj.h) continue;
      let c;
      if (obj.canvas) {
        // Read from canvas (authoritative after BitBlt operations)
        c = createCanvas(obj.w, obj.h);
        const dstCtx = c.getContext('2d');
        const srcCtx = obj.canvas.getContext('2d');
        const imgData = srcCtx.getImageData(0, 0, obj.w, obj.h);
        dstCtx.putImageData(imgData, 0, 0);
      } else if (obj.pixels) {
        c = createCanvas(obj.w, obj.h);
        const dstCtx = c.getContext('2d');
        const img = dstCtx.createImageData(obj.w, obj.h);
        img.data.set(obj.pixels);
        dstCtx.putImageData(img, 0, 0);
      } else continue;
      const outFile = path.join(DUMP_GDI, `gdi_${handle}_${obj.w}x${obj.h}.png`);
      fs.writeFileSync(outFile, c.toBuffer('image/png'));
      count++;
    }
    console.log(`Dumped ${count} GDI bitmaps to ${DUMP_GDI}/`);
  }

  // Dump StretchDIBits source DIBs and per-call log
  if (DUMP_SDB && createCanvas && ctx.dumpSdb) {
    fs.mkdirSync(DUMP_SDB, { recursive: true });
    let imgCount = 0;
    for (const [key, img] of ctx.dumpSdb.images) {
      const c = createCanvas(img.w, img.h);
      const cc = c.getContext('2d');
      const id = cc.createImageData(img.w, img.h);
      id.data.set(img.pixels);
      cc.putImageData(id, 0, 0);
      const outFile = path.join(DUMP_SDB, `sdb_${key}.png`);
      fs.writeFileSync(outFile, c.toBuffer('image/png'));
      imgCount++;
    }
    fs.writeFileSync(path.join(DUMP_SDB, 'calls.log'), ctx.dumpSdb.log.join('\n') + '\n');
    console.log(`Dumped ${imgCount} StretchDIBits source DIBs and ${ctx.dumpSdb.log.length} call records to ${DUMP_SDB}/`);
  }
}

main().catch(e => console.error(e));
