const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createHostImports } = require('../lib/host-imports');
const { loadDlls, detectRequiredDlls, shouldReportNtForDlls, loadWin16Dlls } = require('../lib/dll-loader');
const { compileWat } = require('../lib/compile-wat');
const { decodeMfcCString, g2w: translateGuest } = require('../lib/mem-utils');
const { formatCall: fmtApiCall, formatRet: fmtApiRet, formatOutParams: fmtApiOutParams, walkFrames } = require('../lib/api-format');
const { fontMounts, BUNDLED_BITMAP_FONTS } = require('../lib/font-substitutions');
let PNG;
try { ({ PNG } = require('pngjs')); } catch (_) {}
let createCanvas, Win98Renderer;
try {
  // A pure-JS raster surface, not a native canvas -- see lib/raster-canvas.js.
  // No font registration: WAT measures and rasterizes all text from its own
  // bitmap FON strikes, and the legacy draw_text/draw_rect host imports are
  // dead (0 calls for notepad, calc and mspaint).
  createCanvas = require('../lib/canvas-compat').createCanvas;
  Win98Renderer = require('../lib/renderer').Win98Renderer;
} catch (_) {}

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

// Encode a canvas to PNG bytes.
//
// skia-canvas types toBuffer() as Promise<Buffer> and toBufferSync() as the
// synchronous one. Most call sites here used toBuffer() and wrote the result
// straight to disk, which happens to produce correct files today but is
// relying on undocumented behaviour from an API declared async. One call site
// (dlg-png) already guarded for this; now they all share one helper.
//
// This is hygiene, not a fix for anything measured: it made no difference to
// memory or runtime. The snapshot memory problem was GPU surfaces -- see the
// note in renderer.js _createOffscreen.
function canvasToPng(canvas) {
  return typeof canvas.toBufferSync === 'function'
    ? canvas.toBufferSync('png')
    : canvas.toBuffer('image/png');
}
// Parse args (need these before autoBuild)
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const prefix = `--${name}=`;
  const arg = args.find(value => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : def;
};
const hasFlag = name => args.includes(`--${name}`);

const NO_BUILD = hasFlag('no-build');      // --no-build: skip auto-build
const NO_CLOSE = hasFlag('no-close');      // --no-close: don't inject WM_CLOSE
const NO_RENDERER = hasFlag('no-renderer'); // --no-renderer: skip CLI canvas/renderer (guest-state diagnostics)
const DUMP_GDI = getArg('dump-gdi', null); // --dump-gdi=DIR: dump GDI bitmaps as PNGs
const DUMP_DDRAW = getArg('dump-ddraw-surfaces', null); // --dump-ddraw-surfaces=DIR: dump DirectDraw surface DIBs as PNGs
const DUMP_SDB = getArg('dump-sdb', null); // --dump-sdb=DIR: dump StretchDIBits source DIBs + per-call log
const DUMP_VIRTUAL_MAPS = hasFlag('dump-virtual-maps'); // --dump-virtual-maps: print raw sparse guest-map records
const MAX_BATCHES = parseInt(getArg('max-batches', '200'));
// Composite the screen only every Nth batch. Nobody watches a headless run, so
// intermediate frames exist only to be overwritten -- and they are not free:
// skia-canvas 3.0.8 leaks roughly 320 bytes of unreclaimable native memory per
// draw call (reproduced standalone; identical on GPU and CPU, and unaffected
// by exports, forced GC, or recreating the Canvas). At one composite per batch
// a long run pays that leak millions of times over. Snapshot actions call
// repaint() themselves, so raising this does not affect captured pixels.
const REPAINT_EVERY = Math.max(1, parseInt(getArg('repaint-every', '1')) || 1);
// When multiple --break addrs are passed, the WASM `set_bp` only holds one,
// so the JS fallback (eipBefore check) must see every block entry. Force
// batch-size=1 so each block run hits the check loop.
let BATCH_SIZE = parseInt(getArg('batch-size', '1000'));
const VERBOSE = hasFlag('verbose');
const QUIET_BLOCKS = hasFlag('quiet-blocks'); // --quiet-blocks: suppress per-block EIP progress logs
const TRACE = hasFlag('trace');           // --trace: log every block's EIP
// --trace-api[=Name1,Name2]: log API calls with args + return values; with =NAMES, only those APIs
const TRACE_API_RAW = args.find(a => a === '--trace-api' || a.startsWith('--trace-api='));
const TRACE_API = !!TRACE_API_RAW;
const TRACE_API_FILTER = (TRACE_API_RAW && TRACE_API_RAW.includes('='))
  ? new Set(TRACE_API_RAW.split('=')[1].split(',').map(s => s.trim()).filter(Boolean))
  : null;
const TRACE_API_DEDUP = hasFlag('trace-api-dedup'); // --trace-api-dedup: collapse N consecutive identical lines into "(xN)"
const TRACE_API_COUNTS = hasFlag('trace-api-counts'); // --trace-api-counts: print histogram of API call names at end
const TRACE_MOUSE_STATE = hasFlag('trace-mouse-state'); // --trace-mouse-state: log renderer mouse state changes seen by host imports
const TRACE_INPUT_DISPATCH = hasFlag('trace-input-dispatch'); // --trace-input-dispatch: log mouse/key MSGs entering DispatchMessage
// --trace-stack[=N|=Name1,Name2|=Name:N,...]: walk EBP chain on matched API calls
const TRACE_STACK_RAW = args.find(a => a === '--trace-stack' || a.startsWith('--trace-stack='));
const TRACE_STACK = !!TRACE_STACK_RAW;
let TRACE_STACK_DEFAULT_DEPTH = 12;
const TRACE_STACK_FILTER = (() => {
  if (!TRACE_STACK_RAW || !TRACE_STACK_RAW.includes('=')) return null;
  const spec = TRACE_STACK_RAW.split('=')[1];
  // pure number → just override default depth
  if (/^\d+$/.test(spec)) { TRACE_STACK_DEFAULT_DEPTH = parseInt(spec); return null; }
  const filter = new Map();
  for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const [name, depth] = part.split(':');
    filter.set(name, depth ? parseInt(depth) : TRACE_STACK_DEFAULT_DEPTH);
  }
  return filter;
})();
const QUIET_API = hasFlag('quiet-api');               // --quiet-api: suppress [API] one-line log spam
const API_COUNTS_TOP = parseInt(getArg('api-counts-top', '40'));
const ESP_DELTA = hasFlag('esp-delta');   // --esp-delta: log ESP before/after each API call (for stdcall pop audit)
const TRACE_ESP = getArg('trace-esp', null); // --trace-esp=LO-HI: per-block (eip, esp) + Δ from prev block (hex; HI optional)
const TRACE_EIP_RANGE = getArg('trace-eip-range', null); // --trace-eip-range=LO-HI: log every block-entry EIP inside [LO,HI] (module+0xVA OK)
const TRACE_EIP_DETAIL = hasFlag('trace-eip-detail'); // --trace-eip-detail: include regs/flags/memory with --trace-eip-range
const TRACE_EIP_DUMP = getArg('trace-eip-dump', null); // --trace-eip-dump=0xADDR:LEN[,..]: compact dump on each detailed EIP hit
const TRACE_GDI = hasFlag('trace-gdi');   // --trace-gdi: log GDI calls (CreateBitmap, BitBlt, etc.)
const GDI_STATS = hasFlag('gdi-stats');   // --gdi-stats: print software-raster span/pixel totals at exit
const LATENCY_STATS = hasFlag('latency-stats'); // --latency-stats: measure injected input -> next surface blit
const TRACE_CTRL = hasFlag('trace-ctrl'); // --trace-ctrl: log every WAT-native control paint + its screen rect
const TRACE_RGN = hasFlag('trace-rgn');   // --trace-rgn: log HRGN create/combine/select + branch counts
const TRACE_DC = hasFlag('trace-dc');     // --trace-dc: log DC→canvas target resolution (hwnd, ox/oy, canvas size)
const TRACE_CLIP = hasFlag('trace-clip'); // --trace-clip: log _excludeChildrenClip kid/cousin rects + cover size per draw
const TRACE_DX = hasFlag('trace-dx');     // --trace-dx: log DirectX COM methods with decoded rects/surface metadata
const TRACE_DX_RAW = hasFlag('trace-dx-raw'); // --trace-dx-raw: on each Execute, walk+hexdump the full instruction stream
const TRACE_FS = hasFlag('trace-fs');     // --trace-fs: log filesystem CreateFile hits/misses
const TRACE_INI = hasFlag('trace-ini');   // --trace-ini: log GetPrivateProfileString resolutions
const TRACE_REG = hasFlag('trace-reg');   // --trace-reg: log registry RegOpen/Query/Create/Set/Enum/Close
const TRACE_SEH = hasFlag('trace-seh');   // --trace-seh: log SEH chain operations
const TRACE_WIN16 = hasFlag('trace-win16'); // --trace-win16: log every Win16 (NE) API call and its result
const TRACE_NET = hasFlag('trace-net');   // --trace-net: log every vln/1 frame on the virtual LAN wire
// --vlan-ip=10.77.0.2: this process's room address (host of the room keeps
// 10.77.0.1). --vlan-wire joins the segment offered by the parent process
// over child IPC, which is how two emulators share one room switch.
const VLAN_IP = getArg('vlan-ip', null);
const VLAN_WIRE = hasFlag('vlan-wire');
// A blocking socket call parks the guest; if it never wakes, stop instead of
// spinning forever. Each wait is one macrotask, so this is a real bound.
const VLAN_MAX_WAITS = parseInt(getArg('vlan-max-waits', '20000'), 10);
const TIME_SCALE = parseFloat(getArg('time-scale', '1')) || 1;  // --time-scale=10: guest clock runs 10x
const CLOCK_ORIGIN = Date.now();
// --trace-sched[=N]: one compact line whenever what the threads are doing
// changes, plus a heartbeat every N batches (default 5000) so a stall shows up
// as a repeated line rather than as silence.
// hasFlag is an exact match, so the =N form has to be accepted separately or
// `--trace-sched=500` silently does nothing.
const TRACE_SCHED = hasFlag('trace-sched') || getArg('trace-sched', null) !== null;
const TRACE_SCHED_EVERY = parseInt(getArg('trace-sched', '5000'), 10) || 5000;
const TRACE_HOST = getArg('trace-host', null); // --trace-host=fn1,fn2: wrap arbitrary host fns to log args+return
// --host-census[=N]: count every host import, print a histogram every N calls
// straight to stdout. For batches that never return, where buffered logs never
// get drained. Default 1M keeps a healthy run nearly silent.
const HOST_CENSUS = (hasFlag('host-census') || getArg('host-census', null) !== null)
  ? Number(getArg('host-census', 0)) || 1000000 : 0;
const PROFILE_HOST = getArg('profile-host', null); // --profile-host=fn1,fn2: print count + total time for host imports
const TRACE_WAVE = hasFlag('trace-wave');     // --trace-wave: log wave_out_* calls + cumulative totals
const TRACE_THREAD = hasFlag('trace-thread'); // --trace-thread: log per-thread state transitions
const TRACE_YIELD = hasFlag('trace-yield');   // --trace-yield: log yield_reason transitions per thread
const TRACE_BATCH_TIMING = hasFlag('trace-batch-timing'); // --trace-batch-timing: log run/repaint wall time per batch
const AUDIO_STATS_RAW = args.find(a => a === '--audio-stats' || a.startsWith('--audio-stats=')); // --audio-stats[=N]: heartbeat every N waveOutWrites
const AUDIO_STATS = !!AUDIO_STATS_RAW;
const AUDIO_STATS_STRIDE = (AUDIO_STATS_RAW && AUDIO_STATS_RAW.includes('=')) ? parseInt(AUDIO_STATS_RAW.split('=')[1]) || 50 : 50;
const BREAK_THREAD = getArg('break-thread', null); // --break-thread=Tn: only halt when bp/trace-at hits in given thread (T0=main)
const TRACE_CALLSTACK_RAW = args.find(a => a === '--trace-callstack' || a.startsWith('--trace-callstack='));
const TRACE_CALLSTACK = !!TRACE_CALLSTACK_RAW;
const TRACE_CALLSTACK_DEPTH = TRACE_CALLSTACK_RAW && TRACE_CALLSTACK_RAW.includes('=')
  ? Math.min(64, parseInt(TRACE_CALLSTACK_RAW.split('=')[1]) || 16) : 16;
const BREAKPOINT = getArg('break', null); // --break=0xADDR[,0xADDR,...]: break at address(es)
const BREAK_ONCE = hasFlag('break-once'); // --break-once: do NOT re-arm bp after first hit (so prev_eip stays the true caller)
const TRACE_AT = getArg('trace-at', null); // --trace-at=0xADDR: log regs each time EIP hits addr (non-interactive)
const TRACE_AT_DUMP = getArg('trace-at-dump', null); // --trace-at-dump=0xADDR:LEN[,0xADDR:LEN,...]: hexdump these regions on each --trace-at hit
const TRACE_AT_MEM = getArg('trace-at-mem', null); // --trace-at-mem=REG+OFF:LEN[,ADDR:LEN]: log memory at each --trace-at hit
const TRACE_AT_START_BATCH = parseInt(getArg('trace-at-start-batch', '0'), 10) || 0; // delay --trace-at logging until batch N
const TRACE_AT_LIMIT = parseInt(getArg('trace-at-limit', '0'), 10) || 0; // stop logging after N --trace-at hits (0 = unlimited)
const BREAK_API = getArg('break-api', null); // --break-api=Name[,Name,...]: break on API call
const WATCH_SPEC = getArg('watch', null);    // --watch=0xADDR: break on memory change (dword)
const WATCH_BYTE = getArg('watch-byte', null);   // --watch-byte=0xADDR: byte-granularity watch
const WATCH_WORD = getArg('watch-word', null);   // --watch-word=0xADDR: 16-bit watch
const WATCH_VALUE = getArg('watch-value', null); // --watch-value=0xVAL: only break when watch becomes this value
const WATCH_LOG = hasFlag('watch-log');          // --watch-log: log each change and keep running (no debug prompt)
const WATCH_START_BATCH = parseInt(getArg('watch-start-batch', '0'), 10) || 0; // delay arming --watch until batch N
const WATCH_JS_ONLY = hasFlag('watch-js-only');  // --watch-js-only: sample in JS only; do not arm WAT watchpoint
const TRACE_AT_WATCH = hasFlag('trace-at-watch'); // --trace-at-watch: diff --trace-at-dump regions vs previous hit, show changed bytes
const SHOW_CSTRING = getArg('show-cstring', null); // --show-cstring=0xADDR[,0xADDR...]: decode MFC CString at these addrs in trace-at and debug prompt
const SKIP_SPEC = getArg('skip', null);          // --skip=0xADDR[,0xADDR,...]: auto-return (simulate ret) when EIP hits
const COUNT_SPEC = getArg('count', null);        // --count=0xADDR[,0xADDR,...]: passive hit counter per block dispatch (up to 16 slots)
const DUMP_SPEC = getArg('dump', null);   // --dump=0xADDR:LEN: hexdump memory region
const DUMP_SEH = hasFlag('dump-seh');     // --dump-seh: detailed SEH chain dump at end
const DUMP_VMAP = hasFlag('dump-vmap');   // --dump-vmap: sparse VirtualAlloc map + which probes are mapped
const DUMP_BACKCANVAS = hasFlag('dump-backcanvas'); // --dump-backcanvas: save back canvases alongside PNG snapshots
const DUMP_VFS = hasFlag('dump-vfs');     // --dump-vfs: list all VFS files at end
const SAVE_VFS = getArg('save-vfs', null); // --save-vfs=DIR: extract VFS files to directory
const SAVE_VFS_SUFFIX = getArg('save-vfs-suffix', null); // --save-vfs-suffix=.gid: restrict extraction
const VFS_DRIVE = getArg('vfs-drive', null); // --vfs-drive=D: also preload the EXE directory on D:\
const STUCK_AFTER = parseInt(getArg('stuck-after', '10'));  // --stuck-after=N: stuck detection after N same-EIP batches
const WINVER = getArg('winver', null); // --winver=nt4|win2k|win98 or hex like 0x05650004
const EXE_PATH = getArg('exe', 'test/binaries/notepad.exe');
const WASM_PATH = getArg('wasm', path.join(ROOT, 'build', 'wine-assembly.wasm')); // --wasm=FILE: isolated prebuilt used with --no-build
const PNG_OUT = getArg('png', null);     // --png=out.png: render to PNG via node-canvas
const INPUT_SPEC = getArg('input', null); // --input=batch:msg:wParam[:lParam],...  e.g. --input=50:0x111:11
const SEED_WINDOW = getArg('seed-window', null); // --seed-window=TITLE[|TITLE...]: add foreign top-level windows for shell tests
const EXTRA_ARGS = getArg('args', null); // --args="-quick -fullscreen": extra cmdline args appended after exe name
const AUDIO_OUT = getArg('audio-out', null); // --audio-out=file.pcm: write raw PCM to file
const AUDIO_EXIT_BYTES = parseInt(getArg('audio-exit-bytes', '0'), 10) || 0; // --audio-exit-bytes=N: stop once captured PCM reaches N bytes
const THREAD_SLICES = parseInt(getArg('thread-slices', '4')); // --thread-slices=N: worker slices per main batch (default 4; raise for compute-heavy audio decode)
const WORKER_THREADS = hasFlag('threads'); // --threads: run each guest thread in a real OS thread (node worker_threads) instead of the cooperative scheduler
const THREAD_BATCH_SIZE_ARG = parseInt(getArg('thread-batch-size', '0'), 10) || 0; // --thread-batch-size=N: steps per worker-thread slice with --threads (default: BATCH_SIZE * --thread-slices, min 20000)
const THREADS_SERIAL = hasFlag('threads-serial'); // --threads-serial: with --threads, never run two guest threads at once (splits "race" from "wrong per-thread state")
// Module scope so every exit path can terminate the threads: a live worker keeps
// node alive, so a run that ends — cleanly or by throwing — would otherwise hang
// instead of reporting.
let workerThreadHost = null;

// NO_BUILD kept for compat but ignored — always compiles from WAT

const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');

// Win16 module ids, as assigned by $win16_module_id in src/08c-ne-loader.wat.
// Index 0 is "the loader could not identify the module", which is a real state
// worth naming rather than a gap.
const WIN16_MODULES = [
  '<unresolved>', 'KERNEL', 'USER', 'GDI', 'KEYBOARD',
  'SOUND', 'SHELL', 'MMSYSTEM', 'COMMDLG', 'CARDS', 'DDEML',
];
let win16Ordinals;
// "KERNEL.91 INITTASK" from (1, 91). The map is generated from the real
// modules' export tables by tools/gen_win16_ordinals.js; a missing entry means
// the ordinal is genuinely not exported under a name, so say so rather than
// leave the caller guessing whether the lookup or the export was absent.
function win16ApiName(moduleId, ordinal) {
  const mod = WIN16_MODULES[moduleId] || `<module ${moduleId}>`;
  if (win16Ordinals === undefined) {
    try {
      win16Ordinals = require(path.join(__dirname, '..', 'src', 'win16-ordinals.generated.json'));
    } catch (_) { win16Ordinals = null; }
  }
  const name = win16Ordinals?.modules?.[mod]?.ordinals?.[String(ordinal)];
  return `${mod}.${ordinal}${name ? ' ' + name : ' (no exported name)'}`;
}

function applyExeCompatibilityPatches(exeName, exports, memoryBuffer) {
  if (process.env.WA_SKIP_EXE_COMPAT_PATCHES === '1') return;
  const enabledKeys = process.env.WA_EXE_COMPAT_PATCHES
    ? new Set(process.env.WA_EXE_COMPAT_PATCHES.split(',').map(s => s.trim()).filter(Boolean))
    : null;
  const name = String(exeName || '').toLowerCase();
  if (name !== 'quickblackjack.exe') return;
  if (!exports || !exports.get_image_base || !memoryBuffer) return;
  const imageBase = exports.get_image_base() >>> 0;
  const guestBase = exports.get_guest_base ? (exports.get_guest_base() >>> 0) : 0x12000;
  const mem = new Uint8Array(memoryBuffer);
  const patches = [
    {
      key: 'qbj-delay',
      addr: 0x004222d0,
      expected: [0x55, 0x89, 0xe5],
      replacement: [0xc3, 0x90, 0x90],
      label: 'QuickBlackjack synchronous animation delay',
    },
    {
      key: 'qbj-hand-x',
      addr: 0x0041a80c,
      expected: [0x75, 0x05],
      replacement: [0x90, 0x90],
      label: 'QuickBlackjack hand painter x-animation branch',
    },
    {
      key: 'qbj-hand-y',
      addr: 0x0041a890,
      expected: [0x75, 0x05],
      replacement: [0x90, 0x90],
      label: 'QuickBlackjack hand painter y-animation branch',
    },
  ];
  for (const patch of patches) {
    if (enabledKeys && !enabledKeys.has(patch.key)) continue;
    const wa = (((patch.addr >>> 0) - imageBase + guestBase) >>> 0);
    if (wa + patch.expected.length > mem.length) {
      console.warn(`[compat] cannot patch ${patch.label}: address out of range`);
      continue;
    }
    let ok = true;
    for (let i = 0; i < patch.expected.length; i++) {
      if (mem[wa + i] !== patch.expected[i]) {
        console.warn(`[compat] cannot patch ${patch.label}: unexpected byte at ${hex(patch.addr + i)}`);
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    mem.set(patch.replacement, wa);
    console.log(`[compat] patched ${patch.label} at ${hex(patch.addr)}`);
  }
}

// Module-relative address syntax: `module.dll+0xVA` or `module.exe+0xVA` resolves
// to runtime VA (loadAddr - origBase + VA) after DLLs load. Plain `0xVA` stays as-is.
// `moduleBases` is populated after loadDlls(); resolveAddr() called via deferred
// re-parse below.
const moduleBases = {}; // name(lowercase, no .dll/.exe) → { loadAddr, origBase }
function resolveAddr(spec) {
  const s = String(spec).trim();
  const m = s.match(/^([A-Za-z0-9_.]+?)(?:\.(?:dll|exe))?\s*\+\s*(0x[0-9a-fA-F]+)$/);
  if (!m) return parseInt(s, 16) >>> 0;
  const key = m[1].toLowerCase();
  const va = parseInt(m[2], 16) >>> 0;
  const mod = moduleBases[key];
  if (!mod) {
    console.error(`[resolveAddr] unknown module '${m[1]}' in spec '${spec}'. Known: ${Object.keys(moduleBases).join(',') || '(none yet)'}`);
    return 0;
  }
  return ((va - mod.origBase + mod.loadAddr) >>> 0);
}
function resolveAddrList(spec) {
  return spec ? spec.split(',').map(resolveAddr).filter(v => v !== 0) : [];
}

const breakAddrs = BREAKPOINT ? BREAKPOINT.split(',').map(s => parseInt(s, 16)) : []; // re-resolved post-DLL-load if any spec is module-relative
if (breakAddrs.length > 1) {
  BATCH_SIZE = 1; // WASM set_bp holds only one addr; JS check must see every block
}
const traceAtAddrs = TRACE_AT ? TRACE_AT.split(',').map(s => parseInt(s, 16) >>> 0) : [];
let traceAtAddr = traceAtAddrs[0] || 0; // re-set after deferred resolve
if (traceAtAddrs.length > 1) {
  BATCH_SIZE = 1;
}
// --watch / --watch-byte / --watch-word can be comma-separated (multi-addr fan-out via JS)
const parseWatchSpec = (spec) => spec ? spec.split(',').map(s => parseInt(s.split(':')[0], 16) >>> 0) : [];
const watchAddrsArg = parseWatchSpec(WATCH_SPEC).concat(parseWatchSpec(WATCH_BYTE)).concat(parseWatchSpec(WATCH_WORD));
if (watchAddrsArg.length > 1) {
  BATCH_SIZE = 1;
}
function deferredResolveAddrs() {
  // Re-parse all addr specs that may contain `module+0xVA`. Call after loadDlls.
  if (BREAKPOINT && /\+/.test(BREAKPOINT)) {
    const r = resolveAddrList(BREAKPOINT);
    breakAddrs.length = 0; r.forEach(v => breakAddrs.push(v));
  }
  if (TRACE_AT && /\+/.test(TRACE_AT)) {
    const r = resolveAddrList(TRACE_AT);
    traceAtAddrs.length = 0; r.forEach(v => traceAtAddrs.push(v));
    traceAtAddr = traceAtAddrs[0] || 0;
  }
  if (COUNT_SPEC && /\+/.test(COUNT_SPEC)) {
    const r = resolveAddrList(COUNT_SPEC);
    countAddrs.length = 0; r.forEach(v => countAddrs.push(v));
  }
  if (TRACE_AT_DUMP && /\+/.test(TRACE_AT_DUMP)) {
    for (const d of traceAtDumps) {
      if (d.spec && /\+/.test(d.spec)) d.addr = resolveAddr(d.spec) >>> 0;
    }
  }
  if (TRACE_EIP_RANGE && /\+/.test(TRACE_EIP_RANGE)) {
    parseTraceEipRange(TRACE_EIP_RANGE);
  }
}
const breakThreadFilter = BREAK_THREAD ? parseInt(BREAK_THREAD.replace(/^T/i, ''), 10) : null;
let traceAtHits = 0;
const traceAtDumps = TRACE_AT_DUMP ? TRACE_AT_DUMP.split(',').map(s => {
  const [a, l] = s.split(':');
  const addr = /\+/.test(a) ? 0 : (parseInt(a, 16) >>> 0); // resolved later if module-relative
  return { addr, spec: a, len: parseInt(l) || 64, prev: null };
}) : [];
const traceAtMem = TRACE_AT_MEM ? TRACE_AT_MEM.split(',').map(s => {
  const [expr, l] = s.split(':');
  return { expr: (expr || '').trim(), len: parseInt(l) || 4 };
}).filter(d => d.expr) : [];
const traceEipDumps = TRACE_EIP_DUMP ? TRACE_EIP_DUMP.split(',').map(s => {
  const [a, l] = s.split(':');
  return { addr: parseInt(a, 16) >>> 0, len: parseInt(l) || 32 };
}) : [];
const showCStringAddrs = SHOW_CSTRING ? SHOW_CSTRING.split(',').map(s => parseInt(s, 16) >>> 0) : [];
const breakApis = BREAK_API ? BREAK_API.split(',') : [];
const skipAddrs = SKIP_SPEC ? SKIP_SPEC.split(',').map(s => parseInt(s, 16)) : [];
const countAddrs = COUNT_SPEC ? COUNT_SPEC.split(',').map(s => parseInt(s, 16)) : [];
if (countAddrs.length > 16) { console.error('--count supports max 16 addresses'); process.exit(1); }

// --trace-esp=LO[-HI]: parse hex range. Empty string ("--trace-esp") = whole address space.
let traceEspLo = 0, traceEspHi = 0, traceEspOn = false;
if (TRACE_ESP !== null) {
  traceEspOn = true;
  if (TRACE_ESP) {
    const parts = TRACE_ESP.split('-');
    traceEspLo = parseInt(parts[0], 16) >>> 0;
    traceEspHi = parts[1] ? (parseInt(parts[1], 16) >>> 0) : 0;
  }
}

// --trace-eip-range=LO-HI: split on the LAST `-` so module+0xVA-module+0xVA parses
// (each side may itself contain no dash). Empty "--trace-eip-range" = whole space.
// Module-relative specs are gated until deferredResolveAddrs() succeeds — otherwise
// pre-DLL-load batches would fire against an unresolved 0,0 range (= match-all).
let traceEipLo = 0, traceEipHi = 0, traceEipOn = false, traceEipArmed = false;
const traceEipModuleRel = TRACE_EIP_RANGE && /\+/.test(TRACE_EIP_RANGE);
function parseTraceEipRange(spec) {
  if (!spec) return;
  const dash = spec.lastIndexOf('-');
  const loSpec = dash > 0 ? spec.slice(0, dash) : spec;
  const hiSpec = dash > 0 ? spec.slice(dash + 1) : '';
  traceEipLo = resolveAddr(loSpec) >>> 0;
  traceEipHi = hiSpec ? (resolveAddr(hiSpec) >>> 0) : 0;
  // Resolution succeeded if either bound is non-zero, OR no module prefix at all
  // (caller passed bare hex / empty for match-all).
  if (!/\+/.test(spec) || traceEipLo !== 0 || traceEipHi !== 0) traceEipArmed = true;
}
if (TRACE_EIP_RANGE !== null) {
  traceEipOn = true;
  parseTraceEipRange(TRACE_EIP_RANGE);
}

// One line describing what every thread is doing right now. Deliberately
// terse: the value is in watching the pattern change — or fail to. A stalled
// system prints the same short line, a healthy one churns.
//
//   [sched] b=48 M:run@0x4dd2af  T1:run@0x4465ed  T2:wait(0xe0005)@0x44b3f8
//
// The change signature omits addresses, so an EIP moving within the same state
// does not print a line every batch.
function describeSchedule(instance, threadManager) {
  const hex = v => '0x' + ((v >>> 0).toString(16));
  const stateOf = (e, thread) => {
    if (thread && thread.state !== 'active') return thread.state;
    if (thread && thread.suspendCount > 0) return 'susp';
    const yr = e.get_yield_reason ? (e.get_yield_reason() | 0) : 0;
    if (yr === 1) return `wait(${hex(e.get_wait_handle ? e.get_wait_handle() : 0)})`;
    if (yr === 2) return 'exited';
    if (yr === 7) return 'msgwait';
    if (yr === 8) return 'netwait';
    if (thread && thread.sleepUntil && Date.now() < thread.sleepUntil) return 'sleep';
    return 'run';
  };
  const parts = [];
  const sig = [];
  const mainState = stateOf(instance.exports, null);
  parts.push(`M:${mainState}@${hex(instance.exports.get_eip())}`);
  sig.push(`M:${mainState}`);
  if (threadManager && threadManager.threads) {
    for (const [, t] of threadManager.threads) {
      const e = t.instance ? t.instance.exports : null;
      if (!e) {
        // Worker-backed (--threads): the registers are in another OS thread, so
        // the state comes from what its last slice reported. Skipping these would
        // make a threaded hang look like a system with no threads in it.
        if (!t.link) continue;
        const yr = t.lastYield | 0;
        const st = t.state !== 'active' ? t.state
          : t.suspendCount > 0 ? 'susp'
          : yr === 1 ? 'wait'
          : yr === 2 ? 'exited'
          : yr === 7 ? 'msgwait'
          : yr === 8 ? 'netwait'
          : (t.sleepUntil && Date.now() < t.sleepUntil) ? 'sleep'
          : t.inFlight ? 'run' : 'idle';
        parts.push(`T${t.tid}:${st}@${hex(t.lastEip || 0)}`);
        sig.push(`T${t.tid}:${st}`);
        continue;
      }
      const st = stateOf(e, t);
      parts.push(`T${t.tid}:${st}@${hex(e.get_eip())}`);
      sig.push(`T${t.tid}:${st}`);
    }
  }
  return { text: parts.join('  '), sig: sig.join('|') };
}

async function main() {
  let wasmBytes;
  if (NO_BUILD && fs.existsSync(WASM_PATH)) {
    wasmBytes = fs.readFileSync(WASM_PATH);
  } else {
    wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC_DIR, f), 'utf-8'));
  }
  const exeBytes = fs.readFileSync(EXE_PATH);

  const logs = [];
  let stopped = false;
  let netWaits = 0;   // consecutive net_wait yields, reset by any progress
  let apiCount = 0;
  const apiCounts = TRACE_API_COUNTS ? new Map() : null;
  let lastApiName = null;  // track last API name for return value correlation
  let lastApiEntry = null; // typed metadata for last API (for return formatting)
  let lastApiArgs = null;  // raw dword args captured at entry, used for out-param dump on return
  let lastTreeItemTrace = null;
  let lastApiEsp = 0;      // ESP at API entry, for --esp-delta audit
  let pendingComApiId = -1; // COM api_id from 0xC0DE0000 marker emitted just BEFORE the '<ord>' name log
  let pendingWin16 = null;  // words following the 0xCA16A9F1 Win16 dispatch marker
  let dedupLast = null;    // {line, count} for --trace-api-dedup
  const flushDedup = () => {
    if (dedupLast && dedupLast.count > 1) logs.push(`  (x${dedupLast.count})`);
    dedupLast = null;
  };
  const pushApi = line => {
    if (!TRACE_API_DEDUP) { logs.push(line); return; }
    if (dedupLast && dedupLast.line === line) { dedupLast.count++; return; }
    flushDedup();
    logs.push(line);
    dedupLast = { line, count: 1 };
  };
  let inputEvent = null;   // pending input event to inject via check_input
  let inputQueue = null;   // button ID sequence to inject
  let crossThreadMsgs = []; // messages from worker threads to deliver via check_input

  // Parse --input=batch:msg:wParam[:lParam],... into scheduled events.
  // Also supports UI-level events that go through renderer handlers:
  //   B:focus-find          — set focus on find dialog edit ctrl
  //   B:keypress:CODE       — call renderer.handleKeyPress(CODE)
  //   B:ime-start / ime-update:TEXT / ime-commit:TEXT — composition bridge
  //   B:keydown:VK          — call renderer.handleKeyDown(VK)
  //   B:di-keydown:VK       — set DirectInput/GetAsyncKeyState key-down state without WM_KEYDOWN
  //   B:di-keyup:VK         — clear DirectInput/GetAsyncKeyState key-down state without WM_KEYUP
  //   B:click:X:Y           — handleMouseDown+Up at canvas (X,Y)
  //   B:mousedown:X:Y       — handleMouseDown at canvas (X,Y)
  //   B:mouseup:X:Y         — handleMouseUp at canvas (X,Y)
  //   B:mousemove:X:Y       — handleMouseMove at canvas (X,Y)
  //   B:wheel:X:Y:DELTA     — handleWheel at canvas (X,Y)
  //   B:dump-find           — log current find dialog edit state
  //   B:dump-main-edit      — log main edit text
  //   B:focus-main-window   — set WAT focus to the top-level main window
  //   B:dump-main-edit-state[:LABEL] — log main edit text/cursor/selection/scroll
  //   B:dump-focus-text[:LABEL] — log focused hwnd text via WAT EditState or WM_GETTEXT
  //   B:dump-focus-state[:LABEL] — log focused hwnd text, selection, and scroll state
  //   B:dump-focus-unicode[:LABEL] — log focused RichEdit text via EM_GETTEXTEX/UTF-16
  //   B:dump-print-state[:LABEL] — log printer lifecycle and message-loop state
  //   B:formatrange-probe:WIDTH_TWIPS:HEIGHT_TWIPS[:LABEL] — paginate focused RichEdit
  //   B:main-resize:WIDTH:HEIGHT — resize the top-level main window and deliver WM_SIZE
  //   B:set-focus-text-b64:BASE64[:LABEL] — WM_SETTEXT decoded Latin-1 on the focused control
  //   B:set-focus-selection:START:END[:LABEL] — set focused edit/RichEdit selection through EM_SETSEL
  //   B:send-focus-message:MSG:WPARAM:LPARAM[:LABEL] — synchronously send a message to focus
  //   B:dump-control-state:ID[:LABEL] — log a visible control's state without changing focus
  //   B:dump-clipboard[:LABEL] — log supported clipboard format count and RTF snippet
  //   B:seed-cf-dib[:LABEL] — publish a 32x24 checker CF_DIB and paste it into focus
  //   B:dump-focus-charformat[:LABEL] — log focused hwnd EM_GETCHARFORMAT state
  //   B:set-focus-charformat-color:COLOR[:LABEL] — EM_SETCHARFORMAT color on focused hwnd
  //   B:set-focus-charformat-size:TWIPS[:LABEL] — EM_SETCHARFORMAT size on focused hwnd
  //   B:dump-focus-paraformat[:LABEL] — log focused hwnd EM_GETPARAFORMAT state
  //   B:set-focus-paraformat-align:ALIGN[:LABEL] — EM_SETPARAFORMAT alignment on focused hwnd
  //   B:set-focus-paraformat-basic:NUMBERING:START:RIGHT:OFFSET:TAB[:LABEL]
  //       — EM_SETPARAFORMAT basic paragraph fields on focused hwnd
  //   B:menu-edit-command:ID[:LABEL] — invoke exported WAT menu edit-command bridge
  //   B:wheel-main-edit:DELTA — send WM_MOUSEWHEEL to the main edit
  //   B:drag-main-edit:X1:Y1:X2:Y2 — mouse-drag inside the main edit
  //   B:dlg-cmd:CMD — send WM_COMMAND wParam=CMD to the topmost visible dialog
  //   B:dlg-click:CTRL_ID — click a control by id in the topmost visible dialog
  //   B:dlg-send:CTRL_ID:MSG:WPARAM:LPARAM — send a message to a dialog control by id
  //   B:dlg-set-edit:CTRL_ID:TEXT — set an Edit control by id in the topmost visible dialog
  //   B:dlg-dump[:LABEL] — log controls in the topmost visible dialog
  //   B:dump-children:HWND[:LABEL] — log WAT child table entries for HWND
  //   B:dump-tree[:LABEL] — log WAT TreeView item handles, hierarchy, state, and text
  //   B:dump-listbox[:LABEL] — log WAT ListBox rows and selection
  //   B:listbox-setsel:INDEX:SELECTED — set a row through LB_SETSEL
  //   B:dump-listview[:LABEL] — log WAT ListView columns and cell text
  //   B:dump-toolbar[:LABEL] — log ToolbarWindow32 TBBUTTON records/rects
  //   B:toolbar-click:CMD[:LABEL] — click the toolbar button with command id
  //     CMD at its current TB_GETITEMRECT centre. Prefer this over a literal
  //     click:X:Y on a toolbar; a stale coordinate still lands on some other
  //     control, so the button is never pressed and the run looks fine.
  //   B:menu-dump[:LABEL] — log the currently-open WAT menu children
  //   B:wave-in-feed:FRAMES[:RATE:AMPLITUDE] — feed synthetic sine PCM to waveIn
  //   B:mixer-peak:BUS:VALUE[:HOLD_MS] — inject a 0..32767 mixer peak for visual tests
  //   B:help-macro:HLP_FILE:MACRO — WinHelpA(HELP_COMMAND) a macro on a help file
  //   B:vfs-export:FILENAME:PATH — write one virtual file to the host filesystem
  //   B:vfs-import:FILENAME:PATH — load one host file into the virtual filesystem
  //   B:assert-standard-scroll:AXIS:MIN_POS[:LABEL] — fail unless a visible standard bar reaches MIN_POS ("N%" = percent of page)
  //   B:scroll-click:AXIS:PART[:HWND] — click a live scrollbar part (lo|hi|page-lo|page-hi|thumb)
  //   B:scroll-drag:AXIS:DELTA[:HWND] — drag the live thumb DELTA px along the axis
  //   B:dump-scrollbar:AXIS[:LABEL] — log a live scrollbar's screen strip rect and pos/page/range
  //   B:wait-dlg-control:CTRL_ID[:LIMIT] — delay following events until a visible dialog has CTRL_ID
  //   B:wait-focus-length:MIN_LENGTH[:LIMIT] — delay until focused text reaches MIN_LENGTH
  //   B:sleep-ms:MS — wait real wall-clock time before continuing scheduled actions
  //   B:call-func:ADDR[:A0:A1:A2:A3] — call a guest function through the WASM helper
  //   B:read-dword:ADDR[:LABEL] — log a guest dword value
  const scheduledInput = [];
  if (INPUT_SPEC) {
    for (const spec of INPUT_SPEC.split(',')) {
      const parts = spec.split(':');
      const batch = parseInt(parts[0]);
      const kind = parts[1];
      if (kind === 'focus-find' || kind === 'dump-find' || kind === 'dump-main-edit') {
        scheduledInput.push({ batch, action: kind });
      } else if (kind === 'focus-main-window') {
        scheduledInput.push({ batch, action: kind });
      } else if (kind === 'dump-main-edit-state') {
        scheduledInput.push({ batch, action: kind, label: parts[2] || '' });
      } else if (kind === 'wheel-main-edit') {
        scheduledInput.push({ batch, action: kind, delta: parseInt(parts[2]) || 0 });
      } else if (kind === 'drag-main-edit') {
        scheduledInput.push({ batch, action: kind,
          x1: parseInt(parts[2]), y1: parseInt(parts[3]),
          x2: parseInt(parts[4]), y2: parseInt(parts[5]) });
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
      } else if (kind === 'dump-focus') {
        // B:dump-focus[:LABEL] — log get_focus_hwnd + ctrl class/id.
        scheduledInput.push({ batch, action: 'dump-focus', label: parts[2] || '' });
      } else if (kind === 'dump-focus-text') {
        scheduledInput.push({ batch, action: 'dump-focus-text', label: parts[2] || '' });
      } else if (kind === 'dump-focus-state') {
        scheduledInput.push({ batch, action: 'dump-focus-state', label: parts[2] || '' });
      } else if (kind === 'dump-focus-unicode') {
        scheduledInput.push({ batch, action: 'dump-focus-unicode', label: parts[2] || '' });
      } else if (kind === 'set-focus-text-b64') {
        scheduledInput.push({ batch, action: 'set-focus-text-b64',
          text: Buffer.from(parts[2] || '', 'base64').toString('latin1'),
          label: parts[3] || '' });
      } else if (kind === 'dump-print-state') {
        scheduledInput.push({ batch, action: 'dump-print-state', label: parts[2] || '' });
      } else if (kind === 'formatrange-probe') {
        scheduledInput.push({ batch, action: 'formatrange-probe',
          width: parseInt(parts[2]) || 7200,
          height: parseInt(parts[3]) || 14400,
          label: parts[4] || '' });
      } else if (kind === 'dump-control-state') {
        scheduledInput.push({ batch, action: 'dump-control-state', ctrlId: parseInt(parts[2]), label: parts[3] || '' });
      } else if (kind === 'dump-clipboard') {
        scheduledInput.push({ batch, action: 'dump-clipboard', label: parts[2] || '' });
      } else if (kind === 'seed-cf-dib') {
        scheduledInput.push({ batch, action: 'seed-cf-dib', label: parts[2] || '' });
      } else if (kind === 'dump-focus-charformat') {
        scheduledInput.push({ batch, action: 'dump-focus-charformat', label: parts[2] || '' });
      } else if (kind === 'set-focus-selection') {
        scheduledInput.push({
          batch,
          action: 'set-focus-selection',
          start: parseInt(parts[2]) || 0,
          end: parseInt(parts[3]) || 0,
          label: parts[4] || '',
        });
      } else if (kind === 'send-focus-message') {
        scheduledInput.push({
          batch,
          action: 'send-focus-message',
          msg: parseInt(parts[2]) || 0,
          wParam: parseInt(parts[3]) || 0,
          lParam: parseInt(parts[4]) || 0,
          label: parts[5] || '',
        });
      } else if (kind === 'set-focus-charformat-color') {
        scheduledInput.push({ batch, action: 'set-focus-charformat-color',
          color: parseInt(parts[2]), label: parts[3] || '' });
      } else if (kind === 'set-focus-charformat-size') {
        scheduledInput.push({ batch, action: 'set-focus-charformat-size',
          twips: parseInt(parts[2]), label: parts[3] || '' });
      } else if (kind === 'dump-focus-paraformat') {
        scheduledInput.push({ batch, action: 'dump-focus-paraformat', label: parts[2] || '' });
      } else if (kind === 'set-focus-paraformat-align') {
        scheduledInput.push({ batch, action: 'set-focus-paraformat-align',
          align: parseInt(parts[2]), label: parts[3] || '' });
      } else if (kind === 'set-focus-paraformat-basic') {
        scheduledInput.push({ batch, action: 'set-focus-paraformat-basic',
          numbering: parseInt(parts[2] || '0', 10),
          start: parseInt(parts[3] || '0', 10),
          right: parseInt(parts[4] || '0', 10),
          offset: parseInt(parts[5] || '0', 10),
          tab: parseInt(parts[6] || '0', 10),
          label: parts[7] || '' });
      } else if (kind === 'menu-edit-command') {
        scheduledInput.push({ batch, action: 'menu-edit-command',
          id: parseInt(parts[2]), label: parts[3] || '' });
      } else if (kind === 'class-cmd') {
        // B:class-cmd:CLASS:CMD — find first slot whose ctrl class == CLASS,
        // then send WM_COMMAND wParam=CMD lParam=0. Used by dialog regression
        // tests to drive OK/Cancel without a per-class hwnd export.
        scheduledInput.push({ batch, action: 'class-cmd',
          ctrlClass: parseInt(parts[2]), cmdId: parseInt(parts[3]) });
      } else if (kind === 'dlg-cmd') {
        scheduledInput.push({ batch, action: 'dlg-cmd', cmdId: parseInt(parts[2]) });
      } else if (kind === 'dlg-click') {
        scheduledInput.push({ batch, action: 'dlg-click', ctrlId: parseInt(parts[2]) });
      } else if (kind === 'ctrl-click') {
        // B:ctrl-click:ID — find a control by ID anywhere and send a button click.
        scheduledInput.push({ batch, action: 'ctrl-click', ctrlId: parseInt(parts[2]) });
      } else if (kind === 'ctrl-cmd') {
        // B:ctrl-cmd:ID — find a control by ID and send WM_COMMAND to its parent.
        scheduledInput.push({ batch, action: 'ctrl-cmd', ctrlId: parseInt(parts[2]) });
      } else if (kind === 'dlg-send') {
        scheduledInput.push({ batch, action: 'dlg-send',
          ctrlId: parseInt(parts[2]), msg: parseInt(parts[3]),
          wParam: parseInt(parts[4]) || 0, lParam: parseInt(parts[5]) || 0 });
      } else if (kind === 'dlg-set-edit') {
        scheduledInput.push({ batch, action: 'dlg-set-edit',
          ctrlId: parseInt(parts[2]), text: parts.slice(3).join(':') });
      } else if (kind === 'dlg-dump') {
        scheduledInput.push({ batch, action: 'dlg-dump', label: parts[2] || '' });
      } else if (kind === 'dump-children') {
        scheduledInput.push({ batch, action: 'dump-children', hwnd: parseInt(parts[2]), label: parts[3] || '' });
      } else if (kind === 'dump-windows') {
        scheduledInput.push({ batch, action: 'dump-windows', label: parts[2] || '' });
      } else if (kind === 'dump-msgq') {
        scheduledInput.push({ batch, action: 'dump-msgq', label: parts[2] || '' });
      } else if (kind === 'dump-tree') {
        scheduledInput.push({ batch, action: 'dump-tree', label: parts[2] || '' });
      } else if (kind === 'dump-listbox') {
        scheduledInput.push({ batch, action: 'dump-listbox', label: parts[2] || '' });
      } else if (kind === 'listbox-setsel') {
        scheduledInput.push({ batch, action: 'listbox-setsel', index: parseInt(parts[2]), selected: parseInt(parts[3]) !== 0 });
      } else if (kind === 'dump-listview') {
        scheduledInput.push({ batch, action: 'dump-listview', label: parts[2] || '' });
      } else if (kind === 'dump-toolbar') {
        scheduledInput.push({ batch, action: 'dump-toolbar', label: parts[2] || '' });
      } else if (kind === 'toolbar-click') {
        scheduledInput.push({ batch, action: 'toolbar-click', cmd: parseInt(parts[2]), label: parts[3] || '' });
      } else if (kind === 'menu-dump') {
        scheduledInput.push({ batch, action: 'menu-dump', label: parts[2] || '' });
      } else if (kind === 'dlg-paint') {
        scheduledInput.push({ batch, action: 'dlg-paint' });
      } else if (kind === 'dlg-png') {
        scheduledInput.push({ batch, action: 'dlg-png', path: parts.slice(2).join(':') });
      } else if (kind === 'hwnd-png-pixels') {
        scheduledInput.push({ batch, action: 'hwnd-png-pixels', hwnd: parseInt(parts[2]), path: parts.slice(3).join(':') });
      } else if (kind === 'wait-title') {
        scheduledInput.push({
          batch,
          action: 'wait-title',
          title: (parts[2] || '').replace(/_/g, ' '),
          limit: parseInt(parts[3]) || 2000,
          dumpStop: parts[4] === 'dump-stop',
          label: parts[5] || '',
          path: parts.slice(6).join(':'),
          startBatch: batch,
        });
      } else if (kind === 'wait-title-menu-open') {
        // B:wait-title-menu-open:TITLE:LIMIT:VK[:LABEL]
        // Wait for a visible window title, then synchronously open a menubar
        // dropdown via Alt+VK before later same-batch menu actions run.
        scheduledInput.push({
          batch,
          action: 'wait-title-menu-open',
          title: (parts[2] || '').replace(/_/g, ' '),
          limit: parseInt(parts[3]) || 2000,
          vk: parseInt(parts[4]) || 0,
          label: parts[5] || '',
          startBatch: batch,
        });
      } else if (kind === 'wait-title-command') {
        // B:wait-title-command:TITLE:LIMIT:COMMAND[:LABEL]
        // Resolve the target HWND by its visible title before delivering
        // WM_COMMAND. This avoids tests accidentally posting to HWND 0 while
        // an application is still creating its main window.
        scheduledInput.push({
          batch,
          action: 'wait-title-command',
          title: (parts[2] || '').replace(/_/g, ' '),
          limit: parseInt(parts[3]) || 2000,
          command: parseInt(parts[4]) || 0,
          label: parts[5] || '',
          startBatch: batch,
        });
      } else if (kind === 'wait-title-snapshot') {
        // B:wait-title-snapshot:TITLE:LIMIT:LABEL:PNG_PATH
        // Wait for a window title, then dump the top dialog, write a raw
        // canvas PNG, and stop before the next guest batch runs.
        scheduledInput.push({
          batch,
          action: 'wait-title-snapshot',
          title: (parts[2] || '').replace(/_/g, ' '),
          limit: parseInt(parts[3]) || 2000,
          label: parts[4] || '',
          path: parts.slice(5).join(':'),
          startBatch: batch,
        });
      } else if (kind === 'wait-title-windows-snapshot') {
        // B:wait-title-windows-snapshot:TITLE:LIMIT:LABEL:PNG_PATH
        // Wait for a visible window title, dump renderer window rows, write
        // each back-canvas as PNG via pngjs pixels, then stop.
        scheduledInput.push({
          batch,
          action: 'wait-title-windows-snapshot',
          title: (parts[2] || '').replace(/_/g, ' '),
          limit: parseInt(parts[3]) || 2000,
          label: parts[4] || '',
          path: parts.slice(5).join(':'),
          startBatch: batch,
        });
      } else if (kind === 'wait-title-dump-stop') {
        // B:wait-title-dump-stop:TITLE:LIMIT:LABEL
        // Wait for a window title, then dump the top dialog and stop before
        // another guest batch can run.
        scheduledInput.push({
          batch,
          action: 'wait-title',
          title: (parts[2] || '').replace(/_/g, ' '),
          limit: parseInt(parts[3]) || 2000,
          label: parts[4] || '',
          dumpStop: true,
          startBatch: batch,
        });
      } else if (kind === 'wait-dlg-control') {
        scheduledInput.push({
          batch,
          action: 'wait-dlg-control',
          ctrlId: parseInt(parts[2]),
          limit: parseInt(parts[3]) || 2000,
          startBatch: batch,
        });
      } else if (kind === 'wait-focus-length') {
        scheduledInput.push({
          batch,
          action: 'wait-focus-length',
          minLength: parseInt(parts[2]) || 1,
          limit: parseInt(parts[3]) || 2000,
          startBatch: batch,
        });
      } else if (kind === 'open-dlg-pick') {
        // B:open-dlg-pick:FILENAME — find the open-dialog parent (class 12),
        // set its filename edit (id 0x442) text to FILENAME, then fire IDOK.
        scheduledInput.push({ batch, action: 'open-dlg-pick', filename: parts.slice(2).join(':') });
      } else if (kind === 'open-dlg-filter') {
        // B:open-dlg-filter:INDEX — find the open/save dialog filter ComboBox
        // (id 0x445) and set its 1-based selection index.
        scheduledInput.push({ batch, action: 'open-dlg-filter', index: parseInt(parts[2]) });
      } else if (kind === 'edit-ok') {
        // B:edit-ok:CTRL_ID:TEXT — find an Edit control (class 2) with
        // matching ctrl id, WM_SETTEXT with TEXT, then fire IDOK on its
        // parent dialog. Generic helper for simple modal prompt dialogs.
        scheduledInput.push({ batch, action: 'edit-ok',
          ctrlId: parseInt(parts[2]), text: parts.slice(3).join(':') });
      } else if (kind === 'keypress' || kind === 'keydown' || kind === 'keyup' ||
                 kind === 'di-keydown' || kind === 'di-keyup') {
        scheduledInput.push({ batch, action: kind, code: parseInt(parts[2]) });
      } else if (kind === 'ime-start') {
        scheduledInput.push({ batch, action: 'ime-start' });
      } else if (kind === 'ime-update' || kind === 'ime-commit') {
        scheduledInput.push({ batch, action: kind, text: parts.slice(2).join(':') });
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
      } else if (kind === 'call-func') {
        scheduledInput.push({ batch, action: 'call-func',
          addr: parseInt(parts[2]),
          args: [0, 1, 2, 3].map(i => parseInt(parts[3 + i]) || 0) });
      } else if (kind === 'read-dword') {
        scheduledInput.push({ batch, action: 'read-dword', addr: parseInt(parts[2]), label: parts[3] || '' });
      } else if (kind === 'wave-in-feed') {
        scheduledInput.push({
          batch,
          action: 'wave-in-feed',
          frames: Math.max(1, parseInt(parts[2]) || 24000),
          rate: Math.max(1, parseInt(parts[3]) || 48000),
          amplitude: Math.max(0, Math.min(1, parseFloat(parts[4]) || 0.6)),
        });
      } else if (kind === 'mixer-peak') {
        scheduledInput.push({
          batch,
          action: 'mixer-peak',
          bus: Math.max(0, Math.min(2, parseInt(parts[2]) || 0)),
          value: Math.max(0, Math.min(32767, parseInt(parts[3]) || 0)),
          holdMs: Math.max(50, parseInt(parts[4]) || 500),
        });
      } else if (kind === 'help-macro') {
        scheduledInput.push({
          batch,
          action: 'help-macro',
          filename: parts[2],
          macro: parts.slice(3).join(':'),
        });
      } else if (kind === 'vfs-export') {
        scheduledInput.push({
          batch,
          action: 'vfs-export',
          filename: parts[2],
          path: parts.slice(3).join(':'),
        });
      } else if (kind === 'vfs-import') {
        scheduledInput.push({
          batch,
          action: 'vfs-import',
          filename: parts[2],
          path: parts.slice(3).join(':'),
        });
      } else if (kind === 'assert-standard-scroll') {
        // MIN_POS is scroll units, or "N%" of the bar's own page size (the
        // visible client extent along that axis). Prefer the percentage: how
        // far one arrow or page click moves is proportional to the view, so a
        // pixel constant silently rots the moment window chrome changes size.
        scheduledInput.push({
          batch,
          action: 'assert-standard-scroll',
          axis: parts[2] === 'v' ? 'v' : 'h',
          minPos: parseFloat(parts[3]) || 0,
          minPct: /%\s*$/.test(parts[3] || ''),
          label: parts[4] || '',
        });
      } else if (kind === 'scroll-click') {
        // B:scroll-click:AXIS:PART[:HWND] — real mouse click on a live standard
        // scrollbar. PART is lo|hi (the arrow buttons) or page-lo|page-hi (the
        // track either side of the thumb). The point comes from the window's
        // current client rect, so the click keeps landing on the arrow when
        // frame metrics or default placement move.
        scheduledInput.push({ batch, action: 'scroll-click',
          axis: parts[2] === 'v' ? 'v' : 'h', part: parts[3] || 'hi',
          target: parts[4] || '' });
      } else if (kind === 'scroll-drag') {
        // B:scroll-drag:AXIS:DELTA[:HWND] — press the live thumb, move DELTA px
        // along the axis in three steps, release.
        scheduledInput.push({ batch, action: 'scroll-drag',
          axis: parts[2] === 'v' ? 'v' : 'h', delta: parseInt(parts[3]) || 0,
          target: parts[4] || '' });
      } else if (kind === 'dump-scrollbar') {
        // B:dump-scrollbar:AXIS[:LABEL] — log a live standard scrollbar's strip
        // rect in screen coords plus its page/range/pos, so pixel tests can
        // sample the strip where it actually is.
        scheduledInput.push({ batch, action: 'dump-scrollbar',
          axis: parts[2] === 'v' ? 'v' : 'h', label: parts[3] || '',
          target: parts[4] || '' });
      } else if (kind === 'png') {
        // B:png:PATH — write a PNG snapshot of renderer.canvas at this batch.
        scheduledInput.push({ batch, action: 'png', path: parts.slice(2).join(':') });
      } else if (kind === 'pixel') {
        // B:pixel:X:Y[:LABEL] — repaint and log one canvas pixel.
        scheduledInput.push({ batch, action: 'pixel',
          x: parseInt(parts[2]), y: parseInt(parts[3]), label: parts[4] || '' });
      } else if (kind === 'png-raw') {
        // B:png-raw:PATH — write the already-composited canvas without forcing repaint.
        scheduledInput.push({ batch, action: 'png-raw', path: parts.slice(2).join(':') });
      } else if (kind === 'png-pixels') {
        // B:png-pixels:PATH — encode getImageData pixels through pngjs.
        scheduledInput.push({ batch, action: 'png-pixels', path: parts.slice(2).join(':') });
      } else if (kind === 'stop') {
        // B:stop — end the harness after earlier same-batch actions complete.
        scheduledInput.push({ batch, action: 'stop' });
      } else if (kind === 'sleep-ms') {
        scheduledInput.push({ batch, action: 'sleep-ms', ms: parseInt(parts[2]) || 0 });
      } else if (kind === 'canvas-resize') {
        // B:canvas-resize:WIDTH:HEIGHT — emulate browser backing-canvas resize.
        scheduledInput.push({ batch, action: 'canvas-resize', w: parseInt(parts[2]), h: parseInt(parts[3]) });
      } else if (kind === 'main-resize') {
        scheduledInput.push({ batch, action: 'main-resize', w: parseInt(parts[2]), h: parseInt(parts[3]) });
      } else if (kind === 'corner-drag') {
        // B:corner-drag:HWND:DX:DY — grab a window's live bottom-right corner
        // and drag it by (DX,DY) in four steps. Like close-click, the grab
        // point comes from the current rect, so the test does not silently
        // stop grabbing anything when default placement or size moves.
        scheduledInput.push({ batch, action: 'corner-drag',
          target: parts[2], dx: parseInt(parts[3]), dy: parseInt(parts[4]) });
      } else if (kind === 'close-click') {
        // B:close-click:TARGET — real mouse click on a window's titlebar X,
        // with the coordinates derived from the window's live rect instead of
        // hardcoded in the test (which rots the moment placement changes).
        // TARGET is 'find' (the Find/Replace dialog) or a hex hwnd.
        scheduledInput.push({ batch, action: 'close-click', target: parts[2] || 'find' });
      } else if (kind === 'caption-click') {
        // B:caption-click:HWND:PART — click a caption button (min|max|close)
        // derived from the window's live rect, the same way close-click does.
        scheduledInput.push({ batch, action: 'caption-click',
          target: parts[2] || '', part: parts[3] || 'close' });
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
      } else if (kind === 'wheel') {
        scheduledInput.push({ batch, action: 'wheel',
          x: parseInt(parts[2]), y: parseInt(parts[3]), delta: parseInt(parts[4]) || 0 });
      } else {
        const msg = parseInt(parts[1]);
        const wParam = parseInt(parts[2]) || 0;
        const lParam = parseInt(parts[3]) || 0;
        scheduledInput.push({ batch, msg, wParam, lParam });
      }
    }
    scheduledInput.sort((a, b) => a.batch - b.batch);
  }
  const sortScheduledInput = (current) => {
    scheduledInput.sort((a, b) =>
      (a.batch - b.batch) || (current ? (a === current ? -1 : (b === current ? 1 : 0)) : 0));
  };
  const deferScheduledWait = (ev, batch, preferCurrent = false) => {
    ev.batch = batch + 1;
    for (const pending of scheduledInput) {
      pending.batch++;
      if (typeof pending.startBatch === 'number') pending.startBatch++;
    }
    scheduledInput.push(ev);
    sortScheduledInput(preferCurrent ? ev : null);
  };

  // Resource parsing lives in WAT — nothing to pre-parse here.

  // Set up renderer if node-canvas is available
  let renderer = null;
  if (!NO_RENDERER && createCanvas && Win98Renderer) {
    const screenArg = args.find(a => a.startsWith('--screen='));
    const [screenW, screenH] = screenArg ? screenArg.split('=')[1].split('x').map(Number) : [640, 480];
    const canvas = createCanvas(screenW, screenH);
    renderer = new Win98Renderer(canvas);
  }

  // String APIs where we want to log content
  const STRING_APIS = [
    'lstrlenA', 'lstrcpyA', 'lstrcpynA', 'LoadStringA', 'GetWindowTextA',
    'SetWindowTextA', 'SetDlgItemTextA',
    // File I/O — first arg is the path/pattern
    'CreateFileA', 'OpenFile', 'DeleteFileA', 'FindFirstFileA', 'GetFileAttributesA',
    'SetFileAttributesA', 'MoveFileA', 'CopyFileA', 'CreateDirectoryA', 'RemoveDirectoryA',
    '_lopen', '_lcreat', 'LoadLibraryA', 'LoadLibraryExA', 'GetModuleHandleA',
    'GetModuleFileNameA',
    // Registry — first arg is hkey, but name arg is #2; separate handling below
    // INI — first arg is section name string
    'GetPrivateProfileStringA', 'WritePrivateProfileStringA', 'GetProfileStringA',
    // Misc
    'OutputDebugStringA', 'MessageBoxA',
  ];

  // DX_OBJECTS lives in high WASM memory on this branch.
  // Matches src/09a8-handlers-directx.wat ($DX_OBJECTS = 0x07FF0000).
  const DX_TYPE_NAMES = { 1:'DDraw', 2:'DDSurface', 3:'DDPalette', 4:'DSound', 5:'DSBuffer',
    6:'DInput', 7:'DIDev', 8:'D3D', 9:'D3D3', 20:'D3DDev3', 23:'D3DVp3', 24:'D3DLight', 25:'D3DMat3',
    26:'DPlay3', 27:'DPlayLobby2' };
  function dxLookupThis(thisGuest, dv, g2w) {
    if (!thisGuest) return null;
    let wa, slot;
    try {
      wa = g2w(thisGuest);
      slot = dv.getUint32(wa + 4, true);
    } catch (_) { return null; }
    if (slot >= 256) return null;
    const entry = 0x07FF0000 + slot * 32;
    const type = dv.getUint32(entry, true);
    if (!type) return null;
    const rc = dv.getUint32(entry + 4, true);
    const dims = dv.getUint32(entry + 12, true);
    const fmt = dv.getUint32(entry + 16, true);
    const flags = dv.getUint32(entry + 28, true);
    const w = dims & 0xFFFF, h = (dims >>> 16) & 0xFFFF;
    const bpp = fmt & 0xFFFF, pitch = (fmt >>> 16) & 0xFFFF;
    return { slot, type, typeName: DX_TYPE_NAMES[type] || `T${type}`, rc, w, h, bpp, pitch, flags };
  }
  function dxDescThis(thisGuest, dv, g2w) {
    const o = dxLookupThis(thisGuest, dv, g2w);
    if (!o) return `this=${hex(thisGuest)}`;
    let s = `this=#${o.slot}/${o.typeName}`;
    if (o.type === 2) {
      const sf = []; if (o.flags & 1) sf.push('PRI'); if (o.flags & 2) sf.push('BACK'); if (o.flags & 4) sf.push('OFF');
      if (o.flags & 0x100) sf.push('CK');
      s += `[${o.w}x${o.h} ${o.bpp}bpp pitch=${o.pitch}${sf.length?' '+sf.join('|'):''}]`;
    }
    return s;
  }
  function dxReadRect(ptr, dv, g2w) {
    if (!ptr) return 'null';
    try {
      const wa = g2w(ptr);
      return `(${dv.getInt32(wa, true)},${dv.getInt32(wa+4, true)},${dv.getInt32(wa+8, true)},${dv.getInt32(wa+12, true)})`;
    } catch (_) { return hex(ptr); }
  }
  function dxSurfaceRef(guestPtr, dv, g2w) {
    if (!guestPtr) return 'null';
    const o = dxLookupThis(guestPtr, dv, g2w);
    return o ? `#${o.slot}/${o.typeName}` : hex(guestPtr);
  }
  function decodeDx(name, esp, dv, g2w, memory) {
    const a = [];
    for (let i = 0; i < 6; i++) a.push(dv.getUint32(g2w(esp + 4 + i * 4), true));
    // a[0]=this (for methods), a[0]=arg0 (for creators)
    const desc = () => dxDescThis(a[0], dv, g2w);
    // For ordinal-dispatched COM calls, name is "<ord>". Guess method from
    // `this` type + arg shape. Not authoritative, but makes the trace readable.
    if (name === '<ord>') {
      const o = dxLookupThis(a[0], dv, g2w);
      if (!o) return `[this=${hex(a[0])}]`;
      try { const vtbl = dv.getUint32(g2w(a[0]), true); console.error(`  DBG: this=${hex(a[0])} vtbl=${hex(vtbl)} slot=${o.slot} type=${o.type}`); } catch(_) {}
      // Type 2 = IDirectDrawSurface. Disambiguate common methods by arg shape.
      if (o.type === 2) {
        // BltFast: a[1],a[2] are small x,y coords, a[3] is another DDSurface
        if (a[1] < 0x2000 && a[2] < 0x2000 && dxLookupThis(a[3], dv, g2w)) {
          return `[~BltFast ${desc()} dst=(${a[1]},${a[2]}) src=${dxSurfaceRef(a[3], dv, g2w)} srcRect=${dxReadRect(a[4], dv, g2w)} trans=${hex(a[5])}]`;
        }
        // Blt: a[2] is a DDSurface* (or 0 for color-fill), a[4] is DDBLT_* flag bits
        const bltFlagsLook = (a[4] & 0xFF000000) === 0 && a[4] !== 0;
        const srcLooksLikeSurface = a[2] === 0 || dxLookupThis(a[2], dv, g2w);
        if (srcLooksLikeSurface && bltFlagsLook) {
          return `[~Blt ${desc()} dst=${dxReadRect(a[1], dv, g2w)} src=${dxSurfaceRef(a[2], dv, g2w)} srcRect=${a[3]?dxReadRect(a[3], dv, g2w):'null'} fl=${hex(a[4])}]`;
        }
      }
      return `[${desc()} args=${a.slice(1,5).map(hex).join(',')}]`;
    }
    if (name === 'DirectDrawCreate' || name === 'DirectSoundCreate') {
      return `[guid=${hex(a[0])} pp=${hex(a[1])}]`;
    }
    if (name === 'DirectInputCreateA') return `[hInst=${hex(a[0])} ver=${hex(a[1])} pp=${hex(a[2])}]`;
    if (name === 'IDirectDraw_SetDisplayMode') return `[${desc()} ${a[1]}x${a[2]}x${a[3]}bpp]`;
    if (name === 'IDirectDraw_SetCooperativeLevel') return `[${desc()} hwnd=${hex(a[1])} flags=${hex(a[2])}]`;
    if (name === 'IDirectDraw_CreateSurface' || name === 'IDirectDraw2_CreateSurface') {
      try {
        const wa = g2w(a[1]);
        const sz = dv.getUint32(wa, true);
        const flags = dv.getUint32(wa + 4, true);
        const h2 = dv.getUint32(wa + 8, true);
        const w2 = dv.getUint32(wa + 12, true);
        const caps = dv.getUint32(wa + 104, true);
        const backbuf = dv.getUint32(wa + 24, true);
        const cc = [];
        if (caps & 0x200) cc.push('PRIMARY'); if (caps & 0x4) cc.push('BACKBUF'); if (caps & 0x800) cc.push('OFFSCREEN');
        if (caps & 0x8) cc.push('FLIP'); if (caps & 0x40) cc.push('COMPLEX');
        return `[${desc()} DDSD{sz=${sz} fl=${hex(flags)} ${w2}x${h2} caps=${cc.join('|')||hex(caps)} back=${backbuf}} pp=${hex(a[2])}]`;
      } catch (_) { return `[${desc()} pDDSD=${hex(a[1])}]`; }
    }
    if (name === 'IDirectDrawSurface_Blt') {
      return `[${desc()} dst=${dxReadRect(a[1], dv, g2w)} src=${dxSurfaceRef(a[2], dv, g2w)}${dxReadRect(a[3], dv, g2w)} fl=${hex(a[4])}]`;
    }
    if (name === 'IDirectDrawSurface_BltFast') {
      return `[${desc()} dst=(${a[1]},${a[2]}) src=${dxSurfaceRef(a[3], dv, g2w)}${dxReadRect(a[4], dv, g2w)} trans=${hex(a[5])}]`;
    }
    if (name === 'IDirectDrawSurface_Flip') return `[${desc()} override=${hex(a[1])} flags=${hex(a[2])}]`;
    if (name === 'IDirectDrawSurface_Lock') {
      return `[${desc()} rect=${dxReadRect(a[1], dv, g2w)} pDDSD=${hex(a[2])} flags=${hex(a[3])}]`;
    }
    if (name === 'IDirectDrawSurface_Unlock') return `[${desc()} rect_or_ptr=${hex(a[1])}]`;
    if (name === 'IDirectDrawSurface_SetColorKey') {
      let low = 0, hi = 0;
      try { const wa = g2w(a[2]); low = dv.getUint32(wa, true); hi = dv.getUint32(wa + 4, true); } catch (_) {}
      return `[${desc()} flags=${hex(a[1])} key=${hex(low)}..${hex(hi)}]`;
    }
    if (name === 'IDirectDrawSurface_GetAttachedSurface') return `[${desc()} caps=${hex(a[1])} pp=${hex(a[2])}]`;
    if (name === 'IDirectDrawSurface_SetPalette') return `[${desc()} pPal=${hex(a[1])}]`;
    if (name === 'IDirectDrawPalette_SetEntries') return `[${desc()} flags=${hex(a[1])} start=${a[2]} count=${a[3]} pE=${hex(a[4])}]`;
    // Default: just describe `this` if it resolves to a DX object
    return `[${desc()}]`;
  }

  const traceCategories = new Set();
  if (TRACE_GDI) traceCategories.add('gdi');
  if (TRACE_CTRL) traceCategories.add('ctrl');
  if (TRACE_RGN) traceCategories.add('rgn');
  if (TRACE_DC) traceCategories.add('dc');
  if (TRACE_CLIP) traceCategories.add('clip');
  if (TRACE_DX) traceCategories.add('dx');
  if (TRACE_DX_RAW) { traceCategories.add('dx'); traceCategories.add('dx-raw'); }
  if (TRACE_FS) traceCategories.add('fs');
  if (TRACE_INI) traceCategories.add('ini');
  if (TRACE_REG) traceCategories.add('reg');
  if (TRACE_WAVE) traceCategories.add('wave');
  if (AUDIO_STATS) traceCategories.add('audio-stats');
  if (TRACE_NET) traceCategories.add('net');
  const traceHostNames = TRACE_HOST ? new Set(TRACE_HOST.split(',').map(s => s.trim()).filter(Boolean)) : null;

  const apiTable = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'api_table.json'), 'utf8'));
  const apiByName = new Map(apiTable.map(e => [e.name, e]));
  const ctx = {
    getMemory: () => ctx._memory ? ctx._memory.buffer : null,
    renderer,
    processId: 1000,
    apiTable,
    // Live guest thread count, for HKEY_DYN_DATA\PerfStats KERNEL\Threads.
    // A getter because the manager is built long after ctx is.
    get threadManager() { return threadManager; },
    verbose: VERBOSE,
    _debugReadFile: TRACE_API,
    _debugFindFile: TRACE_API,
    onExit: (code) => { stopped = true; },
    trace: traceCategories,
    traceHost: traceHostNames,
    hostCensus: HOST_CENSUS,
    // The guest clock. --time-scale runs it faster than the wall clock, which
    // separates "waiting for time to pass" from "doing work" in a slow run.
    guestNowMs: () => CLOCK_ORIGIN + (Date.now() - CLOCK_ORIGIN) * TIME_SCALE,
    // The room segment, when this process was launched into one. Without it
    // the guest's sockets still work; the room is just this process alone.
    vlanWire: VLAN_WIRE ? new (require('../lib/vlan-wire').ProcessWire)(process) : null,
    audioStatsStride: AUDIO_STATS ? AUDIO_STATS_STRIDE : 0,
    dumpSdb: DUMP_SDB ? { images: new Map(), log: [] } : null,
    _audioOutFd: AUDIO_OUT ? fs.openSync(AUDIO_OUT, 'w') : undefined,
    _audioOutPath: AUDIO_OUT || null,
    _audioOutWav: AUDIO_OUT ? AUDIO_OUT.toLowerCase().endsWith('.wav') : false,
    sharedAudio: {},  // shared waveOut state across threads
    g2w: (addr) => ctx.exports ? translateGuest(addr, ctx.exports.get_image_base(), ctx.getMemory()) : addr,
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
  if (ctx.vfs) {
    ctx.vfs.dirs.add('c:\\windows');
    ctx.vfs.dirs.add('c:\\windows\\fonts');
    for (const name of BUNDLED_BITMAP_FONTS) {
      const bundledFon = path.join(ROOT, 'fonts', name);
      if (!fs.existsSync(bundledFon)) {
        throw new Error(`missing bundled bitmap font: ${bundledFon}`);
      }
      ctx.vfs.files.set(`c:\\windows\\fonts\\${name.toLowerCase()}`, {
        data: new Uint8Array(fs.readFileSync(bundledFon)), attrs: 0x20,
      });
    }
    // Scalable faces mount under their Win98 filenames so the WAT TrueType
    // rasterizer resolves ARIAL.TTF the way real GDI did, without knowing
    // Liberation Sans is what it opens.
    const substitutions = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'fonts', 'substitutions.json'), 'utf8'));
    for (const mount of fontMounts(substitutions, { subset: true })) {
      const file = path.join(ROOT, 'fonts', mount.file);
      if (!fs.existsSync(file)) {
        throw new Error(`missing substitute for ${mount.face} ${mount.style}: ${file}`);
      }
      ctx.vfs.files.set(mount.vfsPath, {
        data: new Uint8Array(fs.readFileSync(file)), attrs: 0x20,
      });
    }
  }
  const { readStr } = base;
  // NE name tables store Pascal strings, and the address the Win16 dispatcher
  // reports is a linear one into the staged file rather than a guest address.
  const readPascalStr = addr => {
    const b = new Uint8Array(memory.buffer);
    const len = b[addr];
    if (!len || len > 64) return `<bad name at ${hex(addr)}>`;
    return Buffer.from(b.subarray(addr + 1, addr + 1 + len)).toString('latin1');
  };
  // A far pointer into the Win16 selector arena. Selector index N is at
  // WIN16_ARENA + (N-1)*64K (see $win16_seg_base in 08c-ne-loader.wat), and
  // the arena is a direct WASM offset, so this needs no guest translation.
  const win16Linear = (sel, off) =>
    0x100000 + (((sel >> 3) - 1) * 0x10000) + (off & 0xFFFF);
  const WIN16_MSG_NAMES = {
    0x0000: 'WM_NULL', 0x0001: 'WM_CREATE', 0x0002: 'WM_DESTROY',
    0x0003: 'WM_MOVE', 0x0005: 'WM_SIZE', 0x0006: 'WM_ACTIVATE',
    0x0007: 'WM_SETFOCUS', 0x0008: 'WM_KILLFOCUS', 0x000A: 'WM_ENABLE',
    0x000B: 'WM_SETREDRAW', 0x000C: 'WM_SETTEXT', 0x000D: 'WM_GETTEXT',
    0x000F: 'WM_PAINT', 0x0010: 'WM_CLOSE', 0x0011: 'WM_QUERYENDSESSION',
    0x0012: 'WM_QUIT', 0x0014: 'WM_ERASEBKGND', 0x0018: 'WM_SHOWWINDOW',
    0x001C: 'WM_ACTIVATEAPP', 0x001F: 'WM_CANCELMODE', 0x0020: 'WM_SETCURSOR',
    0x0021: 'WM_MOUSEACTIVATE', 0x0024: 'WM_GETMINMAXINFO',
    0x0046: 'WM_WINDOWPOSCHANGING', 0x0047: 'WM_WINDOWPOSCHANGED',
    0x0081: 'WM_NCCREATE', 0x0082: 'WM_NCDESTROY', 0x0083: 'WM_NCCALCSIZE',
    0x0084: 'WM_NCHITTEST', 0x0085: 'WM_NCPAINT', 0x0086: 'WM_NCACTIVATE',
    0x00A0: 'WM_NCMOUSEMOVE', 0x00A1: 'WM_NCLBUTTONDOWN',
    0x0100: 'WM_KEYDOWN', 0x0101: 'WM_KEYUP', 0x0102: 'WM_CHAR',
    0x0104: 'WM_SYSKEYDOWN', 0x0105: 'WM_SYSKEYUP', 0x0106: 'WM_SYSCHAR',
    0x0110: 'WM_INITDIALOG', 0x0111: 'WM_COMMAND', 0x0112: 'WM_SYSCOMMAND',
    0x0113: 'WM_TIMER', 0x0114: 'WM_HSCROLL', 0x0115: 'WM_VSCROLL',
    0x0116: 'WM_INITMENU', 0x0117: 'WM_INITMENUPOPUP', 0x011F: 'WM_MENUSELECT',
    0x0200: 'WM_MOUSEMOVE', 0x0201: 'WM_LBUTTONDOWN', 0x0202: 'WM_LBUTTONUP',
    0x0203: 'WM_LBUTTONDBLCLK', 0x0204: 'WM_RBUTTONDOWN',
    0x0205: 'WM_RBUTTONUP', 0x0206: 'WM_RBUTTONDBLCLK',
  };
  // The 16-bit MSG is not the 32-bit one narrowed in place:
  //   +0 hwnd(W) +2 message(W) +4 wParam(W) +6 lParam(D) +10 time(D) +14 pt(D)
  const readWin16Msg = (sel, off) => {
    try {
      const dv = new DataView(memory.buffer);
      const p = ctx.g2w(win16Linear(sel, off));
      const message = dv.getUint16(p + 2, true);
      return `hwnd=${hex(dv.getUint16(p, true))} ` +
        `${WIN16_MSG_NAMES[message] || hex(message)} ` +
        `wP=${hex(dv.getUint16(p + 4, true))} lP=${hex(dv.getUint32(p + 6, true))}`;
    } catch (_) { return null; }
  };
  const h = base.host;
  // --latency-stats: how long an injected event takes to reach pixels. The
  // blit is the moment GDI hands a dirty rect to the presentation surface,
  // so wrap that import and close out whatever input is still outstanding.
  // Batches are the deterministic half of the answer (one batch is one
  // message-loop turn, and one browser step); the wall clock is reported but
  // never asserted on, because this box runs at load 4-40 and that noise is
  // larger than the thing being measured.
  const latency = { pending: null, samples: [] };
  if (LATENCY_STATS && typeof h.ctrl_paint_trace === 'function') {
    // Wait for the control to actually repaint before accepting a blit as
    // this event's blit — otherwise any of the ~20 unrelated uploads a batch
    // already makes would stop the clock immediately and measure nothing.
    const rawPaint = h.ctrl_paint_trace;
    h.ctrl_paint_trace = (...args) => {
      if (latency.pending) latency.pending.painted = true;
      return rawPaint(...args);
    };
  }
  if (LATENCY_STATS && typeof h.gdi_surface_upload === 'function') {
    const rawUpload = h.gdi_surface_upload;
    h.gdi_surface_upload = (...args) => {
      const result = rawUpload(...args);
      if (latency.pending && latency.pending.painted) {
        latency.samples.push({
          kind: latency.pending.kind,
          batches: tickStateRef.batch - latency.pending.batch,
          ms: Number(process.hrtime.bigint() - latency.pending.at) / 1e6,
        });
        latency.pending = null;
      }
      return result;
    };
  }
  const tickStateRef = { batch: 0 };
  // Keep the CLI harness instantiable while optional host-side font resource
  // loading is unavailable; browser/full hosts can provide the real loader.
  if (!h.add_font_resource) h.add_font_resource = () => 0;
  if (SEED_WINDOW && renderer) {
    const originalGetWindowRelated = h.get_window_related;
    const originalActivateWindow = h.activate_window;
    let seeded = false;
    h.get_window_related = (hwnd, command) => {
      if (!seeded && (hwnd >>> 0) === 0x10000 && command === 5) {
        seeded = true;
        const titles = SEED_WINDOW.split('|').map(title => title.trim()).filter(Boolean);
        const foreignWasm = { exports: {
          post_message_q(target, msg, wParam, lParam) {
            logs.push(`[seed-window] post hwnd=${hex(target)} msg=${hex(msg)} wParam=${hex(wParam)} lParam=${hex(lParam)}`);
            if ((msg >>> 0) === 0x0010 && renderer.windows[target >>> 0]) {
              delete renderer.windows[target >>> 0];
              if (renderer.notifyShellWindow) renderer.notifyShellWindow(2, target);
              renderer.scheduleRepaint();
              logs.push(`[seed-window] closed hwnd=${hex(target)}`);
            }
            return 1;
          },
        } };
        titles.forEach((title, index) => {
          const foreignHwnd = 0x70001 + index;
          renderer.windows[foreignHwnd] = {
            hwnd: foreignHwnd,
            title,
            className: index ? 'Notepad' : 'CalcFrame',
            style: 0x10cf0000,
            visible: true,
            enabled: true,
            isChild: false,
            hasCaption: true,
            x: 30 + index * 48,
            y: 30 + index * 36,
            w: 320,
            h: 240,
            zOrder: renderer._nextZ++,
            wasm: foreignWasm,
          };
          if (renderer._computeClientRect) renderer._computeClientRect(renderer.windows[foreignHwnd]);
        });
      }
      return originalGetWindowRelated(hwnd, command);
    };
    h.activate_window = hwnd => {
      const result = originalActivateWindow(hwnd);
      logs.push(`[seed-window] activate hwnd=${hex(hwnd)} result=${result}`);
      return result;
    };
  }
  const profileHostNames = PROFILE_HOST ? PROFILE_HOST.split(',').map(s => s.trim()).filter(Boolean) : [];
  const profileHostStats = new Map();
  const wrapProfileHost = (hostObj, name) => {
    if (!hostObj || typeof hostObj[name] !== 'function') return;
    const orig = hostObj[name];
    hostObj[name] = (...fnArgs) => {
      const t0 = process.hrtime.bigint();
      try {
        return orig(...fnArgs);
      } finally {
        const dt = process.hrtime.bigint() - t0;
        const s = profileHostStats.get(name) || { count: 0, ns: 0n };
        s.count++;
        s.ns += dt;
        profileHostStats.set(name, s);
      }
    };
  };
  for (const name of profileHostNames) wrapProfileHost(h, name);

  // --- Override logging ---
  h.log = (ptr, len) => {
    const b = new Uint8Array(memory.buffer, ptr, Math.min(len, 256));
    let t = '';
    for (let i = 0; i < b.length && b[i]; i++) t += String.fromCharCode(b[i]);
    // COM ordinal dispatch: 09b-dispatch.wat emits the api_id marker via
    // host_log_i32 IMMEDIATELY before this log of the '<ord>' placeholder.
    // Resolve the real method name now so all downstream tracing
    // (--trace-api filter, --trace-stack, breakpoints, decodeDx, typed
    // formatting via api_table.json) works against the real name.
    let comOrdRaw = false;
    if (t === '<ord>' && pendingComApiId >= 0) {
      const entry = apiTable.find(e => e.id === pendingComApiId);
      if (entry) t = entry.name;
      comOrdRaw = true;
      pendingComApiId = -1;
    }
    apiCount++;
    if (apiCounts) apiCounts.set(t, (apiCounts.get(t) || 0) + 1);

    if (TRACE_INPUT_DISPATCH && (t === 'DispatchMessageA' || t === 'DispatchMessageW')) {
      try {
        const e = instance.exports;
        const esp = e.get_esp();
        const imageBase = e.get_image_base();
        const dv = new DataView(memory.buffer);
        const g2w = addr => addr - imageBase + 0x12000;
        const msgPtr = dv.getUint32(g2w(esp + 4), true);
        const msgHwnd = dv.getUint32(g2w(msgPtr), true);
        const msgMsg = dv.getUint32(g2w(msgPtr + 4), true);
        const msgWP = dv.getUint32(g2w(msgPtr + 8), true);
        const msgLP = dv.getUint32(g2w(msgPtr + 12), true);
        if ((msgMsg >= 0x0100 && msgMsg <= 0x0108) ||
            (msgMsg >= 0x0200 && msgMsg <= 0x020D) ||
            (msgMsg >= 0x00A0 && msgMsg <= 0x00AD)) {
          logs.push(`[dispatch-input] ${t} hwnd=0x${msgHwnd.toString(16)} msg=0x${msgMsg.toString(16)} wParam=0x${msgWP.toString(16)} lParam=0x${(msgLP >>> 0).toString(16)}`);
        }
      } catch (_) {}
    }

    // Check API breakpoints
    if (breakApis.length && breakApis.some(name => t.includes(name))) {
      apiBreakHit = t;
      // Dump entry-time stack + EBP chain BEFORE handler runs, so we see
      // the real return address and caller chain (not post-handler state).
      try {
        const e = instance.exports;
        const esp = e.get_esp();
        const imageBase = e.get_image_base();
        const dv = new DataView(memory.buffer);
        const g2w = addr => addr - imageBase + 0x12000;
        const ret = dv.getUint32(g2w(esp), true);
        const stackVals = [];
        for (let i = 0; i < 8; i++) {
          stackVals.push(hex(dv.getUint32(g2w(esp + i * 4), true)));
        }
        let ebp = e.get_ebp();
        const chain = [];
        for (let depth = 0; depth < 12 && ebp; depth++) {
          try {
            const callerRet = dv.getUint32(g2w(ebp + 4), true);
            const prevEbp = dv.getUint32(g2w(ebp), true);
            chain.push(hex(callerRet));
            if (prevEbp <= ebp) break;
            ebp = prevEbp;
          } catch (_) { break; }
        }
        console.log(`\n*** API BREAK ENTRY for ${t}:`);
        console.log(`  esp=${hex(esp)}  ret=${hex(ret)}`);
        console.log(`  stack: ${stackVals.join(' ')}`);
        console.log(`  ebp chain: ${chain.join(' -> ')}`);
        if (TRACE_CALLSTACK && ctx.exports && ctx.exports.get_callstack_depth) {
          const e = ctx.exports;
          const d = e.get_callstack_depth() | 0;
          const n = Math.min(d, TRACE_CALLSTACK_DEPTH);
          console.log(`  [stack T0 depth=${d}]`);
          for (let i = 0; i < n; i++) console.log(`    #${i} ret=${hex(e.get_callstack_entry(i))}`);
        }
      } catch (_) {}
    }

    if (ESP_DELTA) {
      lastApiName = t;
      lastApiEsp = instance.exports.get_esp();
    }

    if (TRACE_API && (!TRACE_API_FILTER || TRACE_API_FILTER.has(t))) {
      const e = instance.exports;
      const esp = e.get_esp();
      const imageBase = e.get_image_base();
      const dv = new DataView(memory.buffer);
      const g2w = addr => addr - imageBase + 0x12000;
      const fmtCtx = { dv, g2w, memory: memory.buffer, readStr, hex };

      const entry = apiByName.get(t);
      lastApiName = t;
      lastApiEntry = entry || null;
      // Snapshot arg dwords at entry so out-param decoding survives stack churn
      if (entry && Array.isArray(entry.args) && entry.args.some(a => a.out)) {
        lastApiArgs = [];
        try {
          for (let i = 0; i < entry.args.length; i++) {
            lastApiArgs.push(dv.getUint32(g2w(esp + 4 + i * 4), true));
          }
        } catch (_) { lastApiArgs = null; }
      } else {
        lastApiArgs = null;
      }

      // Typed formatter path
      let header = fmtApiCall(entry, esp, fmtCtx);
      // Legacy path: nargs raw dwords (fallback to 6 if unknown) + ad-hoc decoders
      let strInfo = '';
      if (!header) {
        const n = (entry && typeof entry.nargs === 'number') ? entry.nargs : 6;
        let argStr = '';
        try {
          for (let i = 0; i < n; i++) {
            const a = dv.getUint32(g2w(esp + 4 + i * 4), true);
            argStr += (i ? ', ' : '') + hex(a);
          }
        } catch (_) {}
        const matchedApi = STRING_APIS.find(api => t.includes(api));
        if (matchedApi) {
          try {
            const strPtr = dv.getUint32(g2w(esp + 4), true);
            const strVal = readStr(g2w(strPtr), 200);
            if (strVal) strInfo = ` str="${strVal}"`;
          } catch (_) {}
        }
        if ((t === 'lstrcmpiA' || t === 'lstrcmpA') && !strInfo) {
          try {
            const s1 = dv.getUint32(g2w(esp + 4), true);
            const s2 = dv.getUint32(g2w(esp + 8), true);
            strInfo = ` "${readStr(g2w(s1), 32)}" vs "${readStr(g2w(s2), 32)}"`;
          } catch (_) {}
        }
        header = `${t}(${argStr})`;
      }
      if (t === 'SendMessageA') {
        try {
          const msg = dv.getUint32(g2w(esp + 8), true);
          const itemGuest = dv.getUint32(g2w(esp + 16), true);
          if (msg === 0x110C && itemGuest) {
            const item = g2w(itemGuest);
            const mask = dv.getUint32(item, true);
            const hItem = dv.getUint32(item + 4, true);
            const textGuest = dv.getUint32(item + 16, true);
            const textMax = dv.getUint32(item + 20, true);
            strInfo += ` TVITEMA{mask=${hex(mask)},hItem=${hex(hItem)},pszText=${hex(textGuest)},cch=${textMax}}`;
            lastTreeItemTrace = { textGuest, textMax };
          }
        } catch (_) {}
      }
      if (t === 'SendMessageW') {
        try {
          const msg = dv.getUint32(g2w(esp + 8), true);
          const itemGuest = dv.getUint32(g2w(esp + 16), true);
          if (msg === 0x0443 && itemGuest) { // TB_INSERTBUTTONW
            const item = g2w(itemGuest);
            const image = dv.getInt32(item, true);
            const command = dv.getInt32(item + 4, true);
            const state = dv.getUint8(item + 8);
            const style = dv.getUint8(item + 9);
            strInfo += ` button={image=${image},command=${command},state=0x${state.toString(16)},style=0x${style.toString(16)}}`;
          }
        } catch (_) {}
      }

      let dxInfo = '';
      if (TRACE_DX) {
        const isNamedDx = t.startsWith('IDirectDraw') || t.startsWith('IDirectSound') ||
                          t.startsWith('IDirectInput') || t.startsWith('IDirect3D') ||
                          t === 'DirectDrawCreate' || t === 'DirectSoundCreate' ||
                          t === 'DirectInputCreateA' || t === 'Direct3DRMCreate';
        let isOrdDx = false;
        if (!isNamedDx && t === '<ord>') {
          try {
            const thisPtr = dv.getUint32(g2w(esp + 4), true);
            if (dxLookupThis(thisPtr, dv, g2w)) isOrdDx = true;
          } catch (_) {}
        }
        if (isNamedDx || isOrdDx) {
          try { dxInfo = ' ' + decodeDx(t, esp, dv, g2w, memory); } catch (_) {}
        }
      }
      let callerInfo = '';
      try {
        const callerRet = dv.getUint32(g2w(esp), true);
        callerInfo = ` [esp=${hex(esp)} ret=${hex(callerRet)}]`;
      } catch (_) {}
      pushApi(`[API #${apiCount}] ${header}${strInfo}${dxInfo}${callerInfo}`);

      // --trace-stack: walk EBP chain on matched calls
      if (TRACE_STACK && (!TRACE_STACK_FILTER || TRACE_STACK_FILTER.has(t))) {
        const depth = TRACE_STACK_FILTER ? TRACE_STACK_FILTER.get(t) : TRACE_STACK_DEFAULT_DEPTH;
        const chain = walkFrames(() => e.get_ebp(), dv, g2w, depth);
        flushDedup();
        logs.push(`  frames=[${chain.map(hex).join(' <- ')}]`);
      }

      // Legacy struct dumps only fire when API isn't typed (formatter already covers them)
      if (!entry || !entry.args) {
        if (t.includes('DispatchMessage') && apiCount <= 100) {
          try {
            const msgPtr = dv.getUint32(g2w(esp + 4), true);
            const msgHwnd = dv.getUint32(g2w(msgPtr), true);
            const msgMsg = dv.getUint32(g2w(msgPtr + 4), true);
            const msgWP = dv.getUint32(g2w(msgPtr + 8), true);
            const msgLP = dv.getUint32(g2w(msgPtr + 12), true);
            flushDedup();
            logs.push(`  MSG: hwnd=0x${msgHwnd.toString(16)} msg=0x${msgMsg.toString(16)} wP=0x${msgWP.toString(16)} lP=0x${msgLP.toString(16)}`);
          } catch (_) {}
        }
        if (t === 'RegisterClassA' || t === 'RegisterClassW') {
          try {
            const wcPtr = dv.getUint32(g2w(esp + 4), true);
            const wcWa = g2w(wcPtr);
            const style = dv.getUint32(wcWa, true);
            const wndProc = dv.getUint32(wcWa + 4, true);
            const menuName = dv.getUint32(wcWa + 32, true);
            const className = dv.getUint32(wcWa + 36, true);
            const menuStr = (menuName > 0 && menuName < 0x10000)
              ? `MAKEINTRESOURCE(${menuName})`
              : (menuName ? `"${readStr(g2w(menuName), 32)}" (${hex(menuName)})` : '0');
            const classStr = (className > 0 && className < 0x10000)
              ? `MAKEINTATOM(${className})`
              : (className ? `"${readStr(g2w(className), 32)}" (${hex(className)})` : '0');
            flushDedup();
            logs.push(`  WNDCLASS: style=${hex(style)} wndProc=${hex(wndProc)} class=${classStr} menu=${menuStr}`);
          } catch (_) {}
        }
      }

      // SEH tracing for _EH_prolog and _CxxThrowException
      if (TRACE_SEH && (t.includes('_EH_prolog') || t.includes('_CxxThrowException'))) {
        const fsBase = e.get_fs_base();
        try {
          const sehHead = dv.getUint32(g2w(fsBase), true);
          flushDedup();
          logs.push(`  [SEH] fs:[0]=${hex(sehHead)} EBP=${hex(e.get_ebp())}`);
        } catch (_) {}
      }

      // Decode MSVC C++ throw payload on RaiseException(0xE06D7363)
      if (t === 'RaiseException' || t === '_CxxThrowException') {
        try {
          const code = dv.getUint32(g2w(esp + 4), true);
          const nArgs = dv.getUint32(g2w(esp + 12), true);
          const argsPtr = dv.getUint32(g2w(esp + 16), true);
          if (code === 0xe06d7363 && nArgs >= 3 && argsPtr) {
            const magic = dv.getUint32(g2w(argsPtr), true);
            const objPtr = dv.getUint32(g2w(argsPtr + 4), true);
            const throwInfo = dv.getUint32(g2w(argsPtr + 8), true);
            const pCTA = dv.getUint32(g2w(throwInfo + 12), true);
            const nCT = dv.getUint32(g2w(pCTA), true);
            const names = [];
            for (let i = 0; i < nCT && i < 4; i++) {
              const pCT = dv.getUint32(g2w(pCTA + 4 + i * 4), true);
              const pType = dv.getUint32(g2w(pCT + 4), true);
              const name = readStr(g2w(pType + 8), 80);
              names.push(name);
            }
            logs.push(`  [C++ throw] magic=${hex(magic)} obj=${hex(objPtr)} throwInfo=${hex(throwInfo)} types=[${names.join(', ')}]`);
            try {
              const words = [];
              for (let k = 0; k < 8; k++) words.push(hex(dv.getUint32(g2w(objPtr + k * 4), true)));
              logs.push(`  [C++ throw] obj bytes: ${words.join(' ')}`);
              const maybeStr = readStr(g2w(dv.getUint32(g2w(objPtr + 4), true)), 100);
              if (maybeStr) logs.push(`  [C++ throw] obj+4 as str: "${maybeStr}"`);
            } catch (_) {}
          }
        } catch (ex) { logs.push(`  [C++ throw] decode error: ${ex.message}`); }
      }
    } else if (!QUIET_API) {
      logs.push('[API] ' + t);
    }
  };

  h.log_i32 = val => {
    // COM-dispatch marker (emitted by 09b-dispatch.wat BEFORE the '<ord>'
    // name log). Stash api_id so h.log can substitute the real method
    // name on the immediately-following entry log.
    if (((val >>> 0) >>> 16) === 0xC0DE) {
      pendingComApiId = (val >>> 0) & 0xFFFF;
      return;
    }
    // Win16 API dispatch marker (09e-win16-api.wat), followed by the packed
    // module<<16|ordinal and the linear return address. Every Win16 import is
    // by ordinal, so "module 1 ordinal 91" is unreadable without the map the
    // real modules' export tables provide — say KERNEL.91 INITTASK instead.
    // 0xCA16A9F1 is an ordinal import and carries two words; 0xCA16A9F2 is a
    // name import and carries a third, the address of the Pascal-string name.
    // 0xCA16A9F0 / 0xCA16A9EF are the two halves of --trace-win16: the call
    // with the four stack words nearest the top, then AX and DX once it has
    // run. Only the F1/F2 markers mean the task stopped.
    if ((val >>> 0) === 0xCA16A9F1) { pendingWin16 = { want: 2, words: [] }; return; }
    if ((val >>> 0) === 0xCA16A9F2) { pendingWin16 = { want: 3, words: [] }; return; }
    // A by-name call into a loaded DLL that resolved: same three words as the
    // unresolved marker, but it is a call rather than a stop.
    if ((val >>> 0) === 0xCA16A9EE) { pendingWin16 = { want: 3, words: [], resolved: true }; return; }
    // The Win16 modal dialog pump handing one message on: hwnd, message,
    // wParam, lParam, and the dialog the pump belongs to.
    if ((val >>> 0) === 0xCA16A9EB) { pendingWin16 = { want: 6, words: [], route: true }; return; }
    if ((val >>> 0) === 0xCA16A9EC) { pendingWin16 = { want: 5, words: [], posted: true }; return; }
    if ((val >>> 0) === 0xCA16A9F0) { pendingWin16 = { want: 15, words: [], call: true }; return; }
    if ((val >>> 0) === 0xCA16A9EF) { pendingWin16 = { want: 4, words: [], ret: true }; return; }
    if (pendingWin16) {
      pendingWin16.words.push(val >>> 0);
      if (pendingWin16.words.length < pendingWin16.want) return;
      const { call: isCall, ret: isRet, route: isRoute, posted: isPosted, resolved, words } = pendingWin16;
      pendingWin16 = null;
      if (isPosted) {
        const [hwnd, msg, wp, lp, depth] = words;
        logs.push(`[win16] post -> hwnd=${hex(hwnd)} msg=${hex(msg)}` +
          `${WIN16_MSG_NAMES[msg] ? ` (${WIN16_MSG_NAMES[msg]})` : ''}` +
          ` wp=${hex(wp)} lp=${hex(lp)} depth=${depth}`);
        return;
      }
      if (isRoute) {
        const [hwnd, msg, wp, lp, dlg, queued] = words;
        logs.push(`[win16] ${dlg ? `dlg-pump ${hex(dlg)}` : 'task-loop'} -> hwnd=${hex(hwnd)} msg=${hex(msg)}` +
          `${WIN16_MSG_NAMES[msg] ? ` (${WIN16_MSG_NAMES[msg]})` : ''}` +
          ` wp=${hex(wp)} lp=${hex(lp)} queued=${queued}`);
        return;
      }
      if (isRet) {
        logs.push(`[win16]   -> AX=${hex(words[0])} DX=${hex(words[1])} eip=${hex(words[2])} esp=${hex(words[3])}`);
        return;
      }
      const [key, ret, nameAddr] = words;
      const mod = WIN16_MODULES[key >>> 16] || `<module ${key >>> 16}>`;
      // On a call the last word is the by-name flag; the ordinal field then
      // holds a name-table offset and there is nothing to look up.
      const what = isCall
        ? (words[14] ? `${mod}.<name+${key & 0xFFFF}> (by name)`
                    : win16ApiName(key >>> 16, key & 0xFFFF))
        : (nameAddr === undefined
            ? win16ApiName(key >>> 16, key & 0xFFFF)
            : `${mod}.${readPascalStr(nameAddr)} (by name${resolved ? ', resolved' : ''})`);
      if (isCall) {
        // The message pump's four entry points all take an lpMsg, and an
        // argument dump of a far pointer says nothing about which message is
        // in flight. Decode the MSG itself — this is how you see whether a
        // posted command ever reached the window procedure.
        const msgArg = /USER\.(108|109|113|114) /.test(what)
          ? readWin16Msg(words[3], words[2]) : null;
        logs.push(`[win16] ${what}(${words.slice(2, 14).map(hex).join(', ')})  ret=${hex(ret)}` +
          (msgArg ? `  {${msgArg}}` : ''));
      } else {
        logs.push(`[win16] ${what}  ret=${hex(ret)}`);
      }
      return;
    }
    if (ESP_DELTA && lastApiName) {
      const espAfter = instance.exports.get_esp();
      const delta = (espAfter - lastApiEsp) | 0;
      logs.push(`[ESP] ${lastApiName}: ${hex(lastApiEsp)} -> ${hex(espAfter)} delta=${delta >= 0 ? '+' : ''}${delta}`);
    }
    if (TRACE_API && lastApiName) {
      if (!lastApiEntry || !lastApiEntry.ret) {
        // Legacy untyped path. Typed entries are formatted in log_api_exit
        // using EAX, which is authoritative — skip here to avoid duplicate lines.
        flushDedup();
        logs.push(`  => ${hex(val)}`);
        lastApiName = null;
        lastApiEntry = null;
        lastApiArgs = null;
      }
    } else {
      logs.push('[i32] ' + hex(val));
    }
  };

  let prevBlockEsp = null, prevBlockEip = 0, traceEspCount = 0;
  if (traceEspOn) {
    h.log_block = (eip, esp) => {
      const delta = prevBlockEsp === null ? 0 : ((esp - prevBlockEsp) | 0);
      const tag = prevBlockEsp === null
        ? '(start)'
        : `Δ=${delta >= 0 ? '+' : ''}${delta} from ${hex(prevBlockEip)}`;
      logs.push(`[ESP-BLK] eip=${hex(eip >>> 0)} esp=${hex(esp >>> 0)} ${tag}`);
      prevBlockEsp = esp;
      prevBlockEip = eip;
      traceEspCount++;
    };
  }

  if (traceEipOn) {
    h.log_eip = (eip) => {
      let line = `[EIP] ${hex(eip >>> 0)}`;
      if (TRACE_EIP_DETAIL && instance && instance.exports) {
        line += ` ${regs()}`;
        const e = instance.exports;
        if (e.get_flag_res && e.get_flag_op && e.get_flag_a && e.get_flag_b && e.get_flag_sign_shift) {
          line += ` flags{op=${e.get_flag_op()} a=${hex(e.get_flag_a())} b=${hex(e.get_flag_b())} res=${hex(e.get_flag_res())} sh=${e.get_flag_sign_shift()}}`;
        }
        if (traceEipDumps.length) {
          const dv = new DataView(memory.buffer);
          for (const d of traceEipDumps) {
            const bytes = [];
            for (let off = 0; off < d.len; off++) {
              bytes.push(dv.getUint8(g2w((d.addr + off) >>> 0)).toString(16).padStart(2, '0'));
            }
            line += ` mem[${hex(d.addr)}:${d.len}]=${bytes.join(' ')}`;
          }
        }
      }
      logs.push(line);
    };
  }

  if (ESP_DELTA || TRACE_API) {
    h.log_api_exit = () => {
      if (!lastApiName) return;
      if (ESP_DELTA) {
        const espAfter = instance.exports.get_esp();
        const delta = (espAfter - lastApiEsp) | 0;
        logs.push(`[ESP] ${lastApiName}: ${hex(lastApiEsp)} -> ${hex(espAfter)} delta=${delta >= 0 ? '+' : ''}${delta}`);
      }
      if (TRACE_API && lastApiEntry) {
        const dv = new DataView(memory.buffer);
        const imageBase = instance.exports.get_image_base();
        const fmtCtx = { dv, g2w: addr => addr - imageBase + 0x12000, memory: memory.buffer, readStr, hex };
        const eax = instance.exports.get_eax();
        const typedRet = fmtApiRet(lastApiEntry, eax, fmtCtx);
        const outInfo = lastApiArgs ? fmtApiOutParams(lastApiEntry, lastApiArgs, fmtCtx) : '';
        if (typedRet || outInfo) flushDedup();
        if (typedRet) logs.push(`  ${typedRet.trim()}`);
        if (outInfo) logs.push(outInfo);
      }
      if (TRACE_API && lastApiName === 'SendMessageA' && lastTreeItemTrace) {
        try {
          const imageBase = instance.exports.get_image_base();
          const textValue = readStr(lastTreeItemTrace.textGuest - imageBase + 0x12000,
            Math.min(lastTreeItemTrace.textMax, 1024));
          logs.push(`  TVITEMA.text=${JSON.stringify(textValue)}`);
        } catch (_) {}
        lastTreeItemTrace = null;
      }
      lastApiName = null;
      lastApiEntry = null;
      lastApiArgs = null;
    };
  }

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
    if (!ctx._controlText) ctx._controlText = new Map();
    ctx._controlText.set(`${hwnd}:${ctrlId}`, text);
    if (renderer) renderer.invalidate(hwnd);
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
    if (!ctx._windowText) ctx._windowText = new Map();
    ctx._windowText.set(hwnd, title);
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
    // Report the same facts as [CreateWindow]. A dialog's style comes from its
    // template, not from a CreateWindowEx argument, so without this the only
    // record of "what style did this window end up with" is the chrome that
    // does or doesn't appear on screen. wnd_style is what $defwndproc_ncpaint
    // reads; dlg_style is what the template asked for. They should agree.
    const ex = ctx.exports;
    const hex = v => `0x${(v >>> 0).toString(16)}`;
    let detail = '';
    if (ex && ex.dlg_get_style) {
      detail = ` dlg_style=${hex(ex.dlg_get_style(hwnd))}` +
        ` wnd_style=${hex(ex.wnd_get_style_export ? ex.wnd_get_style_export(hwnd) : 0)}` +
        ` size=${ex.dlg_get_cx(hwnd)}x${ex.dlg_get_cy(hwnd)}dlu` +
        ` menu=${hex(ex.dlg_get_menu(hwnd))}`;
    }
    logs.push(`[CreateDialog] hwnd=0x${hwnd.toString(16)} parent=0x${parentHwnd.toString(16)}${detail}`);
    if (renderer) renderer.createDialog(hwnd, parentHwnd);
  };

  let installingFiles = false;
  h.set_window_text = (hwnd, textPtr) => {
    const text = readStr(textPtr);
    logs.push(`[SetWindowText] "${text}"`);
    if (!ctx._windowText) ctx._windowText = new Map();
    ctx._windowText.set(hwnd, text);
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
  // when they differ). Tests may raise TICK_CALL_STEP_MS for apps with
  // synchronous GetTickCount-driven animations that would otherwise crawl in
  // headless slices. Batch transitions add a larger jump (~200ms) to keep
  // the overall simulated pace realistic.
  const tickCallStepMs = Math.max(1, parseInt(process.env.TICK_CALL_STEP_MS || '1', 10) || 1);
  const tickState = { batch: 0, callsInBatch: 0 };
  ctx.sharedAudio.audioClockMs = () => tickState.batch * 200;
  h.get_ticks = () => (((tickState.batch * 200 + (tickState.callsInBatch++ * tickCallStepMs)) & 0x7FFFFFFF));

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
    logs.push(`[check_input] msg=0x${evt.msg.toString(16)} wParam=0x${evt.wParam.toString(16)} lParam=0x${(evt.lParam >>> 0).toString(16)} packed=0x${packed.toString(16)}`);
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
    // Keyboard: prefer the WAT focus owner (e.g. edit child), else fall back to
    // main_hwnd (0). Hard-coding 0x10002 was a notepad hack that broke any app
    // (e.g. SDL) whose focus owner isn't a notepad-shaped edit ctrl.
    if (m >= 0x100 && m <= 0x108) {
      const we = instance && instance.exports;
      const focus = (we && we.get_focus_hwnd) ? (we.get_focus_hwnd() | 0) : 0;
      if (focus) { logs.push(`[check_input_hwnd] keyboard → focus 0x${focus.toString(16)}`); return focus; }
      logs.push(`[check_input_hwnd] keyboard → 0 (main_hwnd)`);
      return 0;
    }
    logs.push(`[check_input_hwnd] msg=0x${m.toString(16)} → 0 (main_hwnd)`);
    return 0;
  };
  h.check_input_lparam = () => (lastInputEvent ? (lastInputEvent.lParam || 0) : 0);
  let lastMouseTracePos = -1;
  let lastMouseTraceButtons = -1;
  const lastAsyncMouseTrace = Object.create(null);
  const traceMouseSnapshot = (reason, force) => {
    if (!TRACE_MOUSE_STATE || !renderer) return;
    const pos = renderer.getMousePosition ? (renderer.getMousePosition() >>> 0) : 0;
    const buttons = renderer.getMouseButtons ? (renderer.getMouseButtons() >>> 0) : 0;
    if (!force && pos === lastMouseTracePos && buttons === lastMouseTraceButtons) return;
    lastMouseTracePos = pos;
    lastMouseTraceButtons = buttons;
    const x = pos & 0xFFFF;
    const y = (pos >>> 16) & 0xFFFF;
    logs.push(`[mouse-state] ${reason} x=${x} y=${y} buttons=${hex(buttons)}`);
  };
  const baseGetWindowRect = h.get_window_rect;
  let lastWindowRectTrace = '';
  h.get_window_rect = (hwnd, rectPtr) => {
    baseGetWindowRect(hwnd, rectPtr);
    if (TRACE_MOUSE_STATE) {
      const mem = new DataView(ctx.getMemory());
      const l = mem.getInt32(rectPtr, true);
      const t = mem.getInt32(rectPtr + 4, true);
      const r = mem.getInt32(rectPtr + 8, true);
      const b = mem.getInt32(rectPtr + 12, true);
      const line = `hwnd=0x${(hwnd >>> 0).toString(16)} rect=${l},${t},${r},${b}`;
      if (line !== lastWindowRectTrace) {
        lastWindowRectTrace = line;
        logs.push(`[mouse-state] GetWindowRect ${line}`);
      }
    }
  };
  h.get_mouse_position = () => {
    traceMouseSnapshot('get_mouse_position', false);
    return renderer && renderer.getMousePosition ? renderer.getMousePosition() : 0;
  };
  h.set_mouse_position = (x, y) => {
    if (renderer && renderer.setMousePosition) renderer.setMousePosition(x, y);
    traceMouseSnapshot(`set_mouse_position ${x | 0},${y | 0}`, true);
  };
  h.get_mouse_buttons = () => {
    traceMouseSnapshot('get_mouse_buttons', false);
    return renderer && renderer.getMouseButtons ? renderer.getMouseButtons() : 0;
  };
  // GetAsyncKeyState backing — delegate to renderer's stateful key map
  h.get_async_key_state = (vKey) => {
    const value = renderer ? renderer.getAsyncKeyState(vKey) : 0;
    const key = vKey & 0xFF;
    if (TRACE_MOUSE_STATE && (key === 0x01 || key === 0x02) && lastAsyncMouseTrace[key] !== value) {
      lastAsyncMouseTrace[key] = value;
      traceMouseSnapshot(`GetAsyncKeyState(${hex(key)})=${hex(value)}`, true);
    }
    return value;
  };
  const lastKeyDownMouseTrace = Object.create(null);
  h.get_key_down_state = (vKey) => {
    const value = renderer && renderer.peekAsyncKeyState ? renderer.peekAsyncKeyState(vKey) : 0;
    const key = vKey & 0xFF;
    if (TRACE_MOUSE_STATE && (key === 0x01 || key === 0x02) && lastKeyDownMouseTrace[key] !== value) {
      lastKeyDownMouseTrace[key] = value;
      traceMouseSnapshot(`GetKeyDownState(${hex(key)})=${hex(value)}`, true);
    }
    return value;
  };

  // Create shared memory externally (WASM module imports it)
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  ctx._memory = memory;
  h.memory = memory;

  // ThreadManager setup (lazy — created after instance)
  const { ThreadManager } = require('../lib/thread-manager');
  let threadManager = null;

  // Wire thread/event imports to ThreadManager
  h.create_thread = (startAddr, param, stackSize, creationFlags) =>
    threadManager.createThread(startAddr, param, stackSize, creationFlags);
  h.suspend_thread = (handle) => threadManager.suspendThread(handle);
  h.resume_thread = (handle) => threadManager.resumeThread(handle);
  h.exit_thread = (exitCode) => threadManager.exitThread(exitCode);
  h.get_exit_code_thread = (handle) => threadManager.getExitCodeThread(handle);
  h.create_event = (manualReset, initialState) => threadManager.createEvent(manualReset, initialState);
  h.set_event = (handle) => threadManager.setEvent(handle);
  h.reset_event = (handle) => threadManager.resetEvent(handle);
  h.wait_single = (handle, timeout) => threadManager.waitSingle(handle, timeout);
  h.wait_multiple = (nCount, handlesWA, bWaitAll, timeout) => threadManager.waitMultiple(nCount, handlesWA, bWaitAll, timeout);
  h.create_semaphore = (initialCount, maxCount) => threadManager.createSemaphore(initialCount, maxCount);
  h.release_semaphore = (handle, releaseCount, lpPrevCountWA) => threadManager.releaseSemaphore(handle, releaseCount, lpPrevCountWA);
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
      path.join(path.dirname(EXE_PATH), 'dlls', fileName),
      path.join(path.dirname(EXE_PATH), 'plugins', fileName),
      path.join(__dirname, 'binaries/dlls', fileName),
    ];
    for (const sp of searchPaths) {
      if (fs.existsSync(sp)) return 1;
    }
    return 0;
  };

  // --host-census wraps the FINAL import table, after run.js has overridden
  // host-imports' versions with its own logging ones. Wrapping earlier misses
  // exactly the noisy functions the flag exists to find.
  if (HOST_CENSUS) {
    // Published so the run can print a final census at exit. Printing only on
    // exact multiples of N means a run that makes fewer than N host calls
    // reports NOTHING, which reads as "no host calls happened" — the opposite
    // of the truth, and it cost a design decision once.
    const counts = globalThis.__hostCensusCounts = new Map();
    const argCounts = globalThis.__hostCensusArgs = new Map();
    let total = 0;
    globalThis.__hostCensusTotal = () => total;
    for (const name of Object.keys(h)) {
      if (typeof h[name] !== 'function') continue;
      const orig = h[name];
      h[name] = (...a) => {
        counts.set(name, (counts.get(name) || 0) + 1);
        // For single-int imports (log_i32 and friends) the argument IS the
        // diagnostic: it says WHICH marker is spinning, not just that one is.
        if (a.length === 1 && typeof a[0] === 'number') {
          const key = `${name}(${(a[0] >>> 0).toString(16)})`;
          argCounts.set(key, (argCounts.get(key) || 0) + 1);
        }
        if (++total % HOST_CENSUS === 0) {
          const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12);
          console.log(`[host-census] ${total} calls: `
            + top.map(([n, c]) => `${n}=${c}`).join(' '));
          const topArgs = [...argCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6);
          if (topArgs.length) {
            console.log('[host-census]   args: '
              + topArgs.map(([n, c]) => `${n}=${c}`).join(' '));
          }
        }
        return orig(...a);
      };
    }
  }

  const imports = { host: h };

  const wasmModule = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(wasmModule, imports);
  ctx.exports = instance.exports;
  if (instance.exports.set_process_id) instance.exports.set_process_id(ctx.processId);
  if (VLAN_IP && instance.exports.set_vlan_local_ip) {
    const octets = VLAN_IP.split('.').map(Number);
    if (octets.length !== 4 || octets.some(o => !(o >= 0 && o <= 255))) {
      console.error(`--vlan-ip: not an IPv4 address: ${VLAN_IP}`);
      process.exit(2);
    }
    instance.exports.set_vlan_local_ip(octets.reduce((a, o) => ((a << 8) | o) >>> 0, 0) | 0);
    if (TRACE_NET) console.log(`[net] room address ${VLAN_IP}`);
  }
  // A frame that reaches this process but that no guest ever peeks is
  // indistinguishable, in the send/peek trace alone, from one that was never
  // sent. Log the arrival itself so the two failures read differently.
  if (TRACE_NET && ctx.vlanWire) {
    const { describeFrame } = require('../lib/vlan-wire');
    ctx.vlanWire.onDeliver = bytes => console.log(`[net] .. arrived ${describeFrame(bytes)}`);
  }
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
      traceHost: traceHostNames,
      hostCensus: HOST_CENSUS,
      vfs: ctx.vfs,  // share filesystem with main thread
      vlanWire: ctx.vlanWire,  // one wire per process, shared by every thread
      guestNowMs: ctx.guestNowMs,  // one clock per process, not per thread
      exports: instance.exports,  // share main instance exports for g2w
      _audioOutFd: ctx._audioOutFd,  // share audio output fd
      sharedAudio: ctx.sharedAudio,  // share waveOut state across threads
      _waveStats: ctx._waveStats,  // share audio-stats counters so T4 writes show in main-thread summary
      audioStatsStride: ctx.audioStatsStride,
      _debugReadFile: TRACE_API,
      sharedGdi: base.gdi,  // share GDI handles so worker BitBlt can see main-thread bitmaps
      g2w: (addr) => translateGuest(addr, instance.exports.get_image_base(), memory.buffer),
    };
    const workerBase = createHostImports(workerCtx);
    const wh = workerBase.host;
    wh.memory = memory;
    // Wire thread/event to same ThreadManager
    wh.create_thread = h.create_thread;
    wh.suspend_thread = h.suspend_thread;
    wh.resume_thread = h.resume_thread;
    wh.exit_thread = h.exit_thread;
    wh.get_exit_code_thread = h.get_exit_code_thread;
    wh.create_event = h.create_event;
    wh.set_event = h.set_event;
    wh.reset_event = h.reset_event;
    wh.wait_single = h.wait_single;
    wh.wait_multiple = h.wait_multiple;
    wh.create_semaphore = h.create_semaphore;
    wh.release_semaphore = h.release_semaphore;
    for (const name of profileHostNames) wrapProfileHost(wh, name);
    // Worker logging. The return value belongs to the call that was just
    // logged, so it is shown only when that call was.
    let workerLogVisible = false;
    wh.log = (ptr, len) => {
      const b = new Uint8Array(memory.buffer, ptr, Math.min(len, 256));
      let t = '';
      for (let i = 0; i < b.length && b[i]; i++) t += String.fromCharCode(b[i]);
      if (apiCounts) apiCounts.set(t, (apiCounts.get(t) || 0) + 1);
      // Honour --quiet-api and --trace-api=NAMES here exactly as the main
      // thread does. Without this a worker's idle poll (MsgWaitForMultiple-
      // Objects, Sleep, QueryPerformanceCounter) logs unfiltered: a long
      // two-process run emitted 2.3M such lines and died of heap exhaustion
      // inside console.log, with the filter the caller asked for ignored.
      if (TRACE_API && !QUIET_API && (!TRACE_API_FILTER || TRACE_API_FILTER.has(t))) {
        workerLogVisible = true;
        logs.push(`[API T${tid}] ${t}`);
      } else {
        workerLogVisible = false;
      }
    };
    wh.log_i32 = (val) => {
      if (workerLogVisible) logs.push(`  => ${hex(val)}`);
    };
    if (TRACE_MOUSE_STATE) {
      const workerGetMousePosition = wh.get_mouse_position;
      const workerGetMouseButtons = wh.get_mouse_buttons;
      wh.get_mouse_position = () => {
        const value = workerGetMousePosition ? workerGetMousePosition() : 0;
        const x = value & 0xFFFF;
        const y = (value >>> 16) & 0xFFFF;
        const buttons = workerGetMouseButtons ? (workerGetMouseButtons() >>> 0) : 0;
        logs.push(`[mouse-state T${tid}] get_mouse_position x=${x} y=${y} buttons=${hex(buttons)}`);
        return value;
      };
      wh.get_mouse_buttons = () => {
        const value = workerGetMouseButtons ? (workerGetMouseButtons() >>> 0) : 0;
        logs.push(`[mouse-state T${tid}] get_mouse_buttons buttons=${hex(value)}`);
        return value;
      };
    }
    if (traceEipOn) {
      wh.log_eip = (eip) => {
        logs.push(`[EIP T${tid}] ${hex(eip >>> 0)}`);
      };
    }
    wh.exit = () => {};
    wh.has_dll_file = h.has_dll_file;
    return { host: wh };
  };

  // --threads: each guest thread gets a real OS thread (node worker_threads over
  // this same shared memory) instead of a slice of this one. The guest's main
  // thread stays in-process — 237 sites here call instance.exports directly, and
  // moving them behind an async proxy is a different change — so this is not the
  // browser's shape, where slot 0 is a Worker too. What it does cover, headlessly
  // and on every run: the WAT's shared-memory locks and publish ordering under
  // genuine parallelism, the per-thread RPC blocks, the worker scheduler in
  // lib/thread-manager.js, and the wait-completion path whose absence made worker
  // mode quietly wrong for a whole phase with every test still green.
  let guestThreadHost = null;
  // Computed here, not at parse time: the debug flags above rewrite BATCH_SIZE.
  const THREAD_BATCH_SIZE = THREAD_BATCH_SIZE_ARG || Math.max(BATCH_SIZE * THREAD_SLICES, 20000);
  if (WORKER_THREADS) {
    const { GuestThreadHost } = require('../lib/guest-thread-host');
    const sigs = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'lib', 'host-import-sigs.generated.json'), 'utf8')).sigs;
    guestThreadHost = new GuestThreadHost({
      memory,
      module: wasmModule,
      sigs,
      // One import table per thread, built by the same factory the cooperative
      // backend uses — so a worker's API trace still says which tid it came from.
      hostImportsForSlot: (slot, tid) => makeWorkerImports(tid).host,
      workerUrl: path.join(ROOT, 'lib', 'guest-worker.js'),
      localMainExports: () => instance.exports,
      clockIntervalMs: 0,          // the CLI clock is the batch counter, published by hand
      tickMs: () => tickState.batch * 200,
      log: msg => console.log(msg),
    });
    await guestThreadHost.start();
    workerThreadHost = guestThreadHost;
    console.log('[threads] guest threads will run in node worker_threads (--threads)');
  }

  threadManager = new ThreadManager(wasmModule, memory, instance, makeWorkerImports, {
    workerBackend: guestThreadHost,
    serialSlices: THREADS_SERIAL,
    traceThread: TRACE_THREAD,
    traceYield: TRACE_YIELD,
    breakThreadFilter: breakThreadFilter,
    traceCallstack: TRACE_CALLSTACK,
    traceCallstackDepth: TRACE_CALLSTACK_DEPTH,
    traceEipRange: (traceEipOn && traceEipArmed) ? { lo: traceEipLo, hi: traceEipHi } : null,
    now: () => tickState.batch * 200,
    hasMessage: () => !!(
      inputEvent ||
      (crossThreadMsgs && crossThreadMsgs.length) ||
      (inputQueue && inputQueue.length) ||
      (renderer && renderer.inputQueue && renderer.inputQueue.length)
    ),
  });

  const mem = new Uint8Array(memory.buffer);
  // Self-extracting installers append their archive after the PE image, so the
  // file can be far larger than anything the loader needs. The staging buffer
  // sits below emulator-private tables — the API hash table among them — and an
  // unbounded copy walks straight through them, after which every import
  // resolves to api_id 0xFFFF and the app dies on its first call.
  const stagingCap = instance.exports.get_staging_size();
  const staged = Math.min(exeBytes.length, stagingCap);
  if (staged < exeBytes.length) {
    console.log(`[pe] staging ${staged} of ${exeBytes.length} bytes ` +
      `(buffer is ${stagingCap}); the tail is appended data, read via the VFS`);
  }
  mem.set(exeBytes.subarray(0, staged), instance.exports.get_staging());
  const entry = instance.exports.load_pe(staged);
  console.log('PE loaded. Entry: ' + hex(entry));
  applyExeCompatibilityPatches(path.basename(EXE_PATH), instance.exports, memory.buffer);
  // A 16-bit task's DLLs load into the same selector arena its own segments
  // went into, so this has to follow load_pe.
  loadWin16Dlls(instance.exports, memory, exeBytes, path.dirname(EXE_PATH),
    (dir, name) => {
      for (const f of [`${name}.DLL`, `${name}.dll`, `${name}.EXE`]) {
        const p = path.join(dir, f);
        if (fs.existsSync(p)) return fs.readFileSync(p);
      }
      return null;
    }, (m) => console.log(m));
  const requiredDlls = detectRequiredDlls(exeBytes);

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
  } else if (shouldReportNtForDlls(requiredDlls) && instance.exports.set_winver) {
    const v = 0x05650004;
    instance.exports.set_winver(v);
    console.log('Windows version: ' + hex(v) + ' (auto NT for MFC42U)');
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
    const required = requiredDlls;
    // Only load DLLs that work as real PE DLLs; others are handled by WAT stub handlers
    const LOADABLE_DLLS = new Set(['msvcrt20.dll', 'mfc30.dll', 'msvcrt.dll', 'mfc42.dll', 'mfc42u.dll', 'comctl32.dll',
      'msvcp60.dll', 'msvcp50.dll', 'riched20.dll', 'cabinet.dll', 'usp10.dll', 'cards.dll',
      'd3drm.dll', 'kvdd.dll', 'sdl.dll',
      // Win98 accessories that ship their engine beside the .exe rather than
      // linking it: HyperTerminal's protocol engine and the Kodak Imaging
      // common/display/admin libraries. Without these the apps die on their
      // first import from one — InitInstance, ?UpdateVersion@@YGJH@Z, and a
      // pile of ordinals respectively.
      'hypertrm.dll', 'imgcmn.dll', 'sti.dll', 'shell32.dll', 'shlwapi.dll',
      // Explorer is the Win98 shell: its window, desktop and taskbar all live
      // in SHELL32 (entered through ordinal 244) and SHDOCVW.
      'shdocvw.dll',
      // The Kodak Imaging suite splits itself across ten OI*400 libraries and
      // they import each other, so the whole set has to be loadable or the
      // first cross-DLL ordinal fails.
      'oiadm400.dll', 'oicom400.dll', 'oidis400.dll', 'oifil400.dll',
      'oigfs400.dll', 'oiprt400.dll', 'oislb400.dll', 'oissq400.dll',
      'oitwa400.dll', 'oiui400.dll']);
    const exeDir = path.dirname(EXE_PATH);
    const dllSearchDirs = [
      dllDir,
      exeDir,
      path.join(exeDir, '..', 'Shared_DLLs'),  // MW3-style extracted layout
      path.join(exeDir, '..', 'shared_dlls'),
      path.join(__dirname, 'binaries', 'dlls'),
    ];
    dlls = [];
    // Old MFC builds import their matching CRT during DllMain. Preserve a
    // dependency-safe order even when the EXE import directory lists MFC first.
    const orderedRequired = [...required].sort((a, b) => {
      const rank = name => name.toLowerCase() === 'msvcrt20.dll' ? 0 : 1;
      return rank(a) - rank(b);
    });
    // A DLL's own imports have to be satisfied too. Kodak Imaging pulls in
    // IMGCMN, which imports OIFIL400, which imports its siblings — leave any
    // of them unloaded and the first cross-DLL ordinal resolves to a system
    // thunk and traps. Walk the dependency graph, not just the EXE's row of it.
    const findDllFile = name => {
      for (const dir of dllSearchDirs) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
      }
      return null;
    };
    const queued = new Set();
    const queue = [...orderedRequired];
    while (queue.length) {
      const name = queue.shift();
      const key = name.toLowerCase();
      if (queued.has(key) || !LOADABLE_DLLS.has(key)) continue;
      const p = findDllFile(name);
      if (!p) continue;
      queued.add(key);
      const bytes = fs.readFileSync(p);
      dlls.push({ name, bytes });
      try {
        for (const dep of detectRequiredDlls(bytes)) {
          if (!queued.has(dep.toLowerCase())) queue.push(dep);
        }
      } catch (_) { /* a DLL we cannot parse simply contributes no deps */ }
    }
  }
  // Register exe in moduleBases so `exe+0xVA` and basename-relative specs work.
  {
    const peOff = exeBytes[0x3C] | (exeBytes[0x3D] << 8) | (exeBytes[0x3E] << 16) | (exeBytes[0x3F] << 24);
    const exeOrig = exeBytes[peOff + 52] | (exeBytes[peOff + 53] << 8) | (exeBytes[peOff + 54] << 16) | (exeBytes[peOff + 55] << 24);
    const exeLoad = instance.exports.get_image_base();
    const exeBase = path.basename(EXE_PATH).toLowerCase().replace(/\.[^.]+$/, '');
    moduleBases['exe'] = { loadAddr: exeLoad, origBase: exeOrig };
    moduleBases[exeBase] = { loadAddr: exeLoad, origBase: exeOrig };
  }
  if (dlls.length > 0) {
    const dllResults = loadDlls(instance.exports, memory.buffer, exeBytes, dlls, console.log, {
      exeName: path.basename(EXE_PATH),
      extraArgs: EXTRA_ARGS || '',
      registerDllResources: (dllConfigs, results) => {
        const { extractBitmapBytes } = require('../lib/dib');
        ctx.dllResources = ctx.dllResources || {};
        for (let i = 0; i < dllConfigs.length && i < results.length; i++) {
          try {
            const bitmapBytes = extractBitmapBytes(dllConfigs[i].bytes);
            const count = Object.keys(bitmapBytes).length;
            if (count > 0) {
              ctx.dllResources[results[i].loadAddr] = { bitmapBytes };
              console.log(`DLL resources: ${dllConfigs[i].name} has ${count} bitmaps`);
            }
          } catch (_) {}
        }
      },
    });
    if (dllResults) {
      for (const r of dllResults) {
        const key = r.name.toLowerCase().replace(/\.[^.]+$/, '');
        moduleBases[key] = { loadAddr: r.loadAddr, origBase: r.origBase };
      }
    }
    stopped = false;
  }

  // Resolve any module-relative address specs now that all module bases are known.
  deferredResolveAddrs();

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
            ctx.vfs.dirs.add(subDir.replace(/\\$/, ''));
            loadDir(fpath, subDir);
          }
        } catch (_) {}
      }
    };
    loadDir(exeDir, 'c:\\');
    if (VFS_DRIVE) {
      const drive = VFS_DRIVE.replace(/:$/, '').toLowerCase();
      if (!/^[a-z]$/.test(drive)) throw new Error(`invalid --vfs-drive: ${VFS_DRIVE}`);
      const driveRoot = `${drive}:\\`;
      ctx.vfs.dirs.add(`${drive}:`);
      ctx.vfs.dirs.add(driveRoot);
      loadDir(exeDir, driveRoot);
      ctx.vfs.setDriveReadOnly(drive, true);
    }

    // Plus!98 Organic Art theme SCRs: each theme ships a sibling .SCN with
    // Active=0 (the real installer flips it to 1 when the user picks the
    // theme). All SCRs read HKCU\...\Plus\DefaultScene from the same path,
    // so without per-SCR override every theme falls back to CA_2001.
    // Detect SCR + matching .SCN by basename, patch Active=1, and set
    // DefaultScene to the SCN's [Description] Name= value.
    const exeStem = exeName.replace(/\.scr$/i, '');
    if (exeName.endsWith('.scr')) {
      const targetScnKey = 'c:\\' + exeStem + '.scn';
      const targetScn = ctx.vfs.files.get(targetScnKey);
      if (targetScn) {
        // The Plus!98 picker enumerates *.scn, builds a play-list of Active=1
        // scenes, then rotates through them. To force a single theme SCR to
        // play its own scene, we (a) flip the matching SCN to Active=1 and
        // (b) flip every other SCN to Active=0 in the VFS only.
        const patchScn = (key, makeActive) => {
          const f = ctx.vfs.files.get(key);
          if (!f) return null;
          let t = Buffer.from(f.data).toString('latin1');
          const want = makeActive ? '1' : '0';
          if (/^Active=[01]\s*$/m.test(t)) {
            t = t.replace(/^Active=[01]\s*$/m, 'Active=' + want);
          } else if (/^\[Description\]\s*\r?\n/m.test(t)) {
            t = t.replace(/^\[Description\]\s*\r?\n/m, (m) => m + 'Active=' + want + '\r\n');
          }
          ctx.vfs.files.set(key, { data: new Uint8Array(Buffer.from(t, 'latin1')), attrs: 0x20 });
          return t;
        };
        let patched = 0, deactivated = 0;
        for (const k of ctx.vfs.files.keys()) {
          if (!/\.scn$/i.test(k)) continue;
          if (k === targetScnKey) { patchScn(k, true); patched++; }
          else { patchScn(k, false); deactivated++; }
        }
        const text = Buffer.from(ctx.vfs.files.get(targetScnKey).data).toString('latin1');
        const nameMatch = text.match(/^Name=(.*)$/m);
        const sceneName = nameMatch ? nameMatch[1].trim() : exeStem.toUpperCase();
        try {
          const { setRegValue } = require('../lib/storage');
          setRegValue('HKCU\\Software\\Computer Artworks\\Organic Art\\Plus', 'DefaultScene', 1, sceneName);
          if (VERBOSE) console.log(`[plus98] ${exeName} → DefaultScene="${sceneName}", Active=1 on ${exeStem}.scn, Active=0 on ${deactivated} others`);
        } catch (_) {}
      }
    }

    // Funpack community remakes default to showing a modeless "Get Started"
    // walkthrough. Smoke tests need to exercise the game surface, not stop at
    // first-run instructional dialogs.
    const funpackApps = {
      'funtris.exe': 'Funtris',
      'peaks.exe': 'Peaks',
      'pyramid.exe': 'Pyramid',
      'fourstones.exe': 'Four Stones',
    };
    if (funpackApps[exeName]) {
      try {
        const { setRegValue, setIniValue } = require('../lib/storage');
        setRegValue(`HKCU\\Software\\Funpack Software\\${funpackApps[exeName]}\\Options`, 'GetStarted', 4, 0);
        if (exeName === 'pyramid.exe') {
          setIniValue('win.ini', 'intl', 'iCDateCount', -1);
        }
      } catch (_) {}
    }
    if (exeName === 'quickblackjack.exe' && process.env.QBLACKJACK_SKIP_SEED !== '1') {
      try {
        const { setRegValue } = require('../lib/storage');
        const purse = Number.isFinite(Number(process.env.QBLACKJACK_PURSE))
          ? Number(process.env.QBLACKJACK_PURSE)
          : 500;
        const change = Number.isFinite(Number(process.env.QBLACKJACK_CHANGE))
          ? Number(process.env.QBLACKJACK_CHANGE)
          : 0;
        setRegValue('HKCU\\Software\\Wesley Steiner\\Quick Blackjack\\Player', 'Purse', 4, purse);
        setRegValue('HKCU\\Software\\Wesley Steiner\\Quick Blackjack\\Player', 'Change', 4, change);
        const animation = Number.isFinite(Number(process.env.QBLACKJACK_ANIMATION))
          ? Number(process.env.QBLACKJACK_ANIMATION)
          : 0;
        setRegValue('HKCU\\Software\\Wesley Steiner\\Quick Blackjack\\Tabletop', 'Animation', 4, animation);
      } catch (_) {}
    }

    // Also load sibling directories from parent — games like RCT have the exe
    // in a subdirectory (English/) but data in a sibling (Data/).
    const parentDir = path.dirname(exeDir);
    if (parentDir !== exeDir) {
      try {
        for (const f of fs.readdirSync(parentDir)) {
          const fpath = path.join(parentDir, f);
          try {
            const stat = fs.statSync(fpath);
            if (stat.isDirectory() && f !== '.' && f !== '..' && fpath !== exeDir) {
              const vfsDir = 'c:\\' + f.toLowerCase() + '\\';
              if (!ctx.vfs.dirs.has(vfsDir)) {
                ctx.vfs.dirs.add(vfsDir);
                ctx.vfs.dirs.add(vfsDir.replace(/\\$/, ''));
                loadDir(fpath, vfsDir);
              }
            }
          } catch (_) {}
        }
      } catch (_) {}
      // Some extracted InstallShield-era games put the EXE under Program_Files
      // but expect the sibling Database_Files/zbd directory to also be visible
      // as a CWD-relative "zbd\" search root.
      try {
        const zbdDir = path.join(parentDir, 'Database_Files', 'zbd');
        const zbdStat = fs.statSync(zbdDir);
        if (zbdStat.isDirectory() && !ctx.vfs.dirs.has('c:\\zbd\\')) {
          ctx.vfs.dirs.add('c:\\zbd\\');
          ctx.vfs.dirs.add('c:\\zbd');
          loadDir(zbdDir, 'c:\\zbd\\');
        }
      } catch (_) {}
    }
  }

  const regs = () => {
    const e = instance.exports;
    return `EIP=${hex(e.get_eip())} EAX=${hex(e.get_eax())} ECX=${hex(e.get_ecx())} EDX=${hex(e.get_edx())} EBX=${hex(e.get_ebx())} ESP=${hex(e.get_esp())} EBP=${hex(e.get_ebp())} ESI=${hex(e.get_esi())} EDI=${hex(e.get_edi())}`;
  };

  const g2w = addr => {
    return translateGuest(addr, instance.exports.get_image_base(), memory.buffer);
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

  // Grab a snapshot of a guest region as Uint8Array (for diff tracking)
  const readBytes = (guestAddr, len) => {
    const out = new Uint8Array(len);
    const bytes = new Uint8Array(memory.buffer);
    for (let i = 0; i < len; i++) out[i] = bytes[g2w(guestAddr + i)];
    return out;
  };

  // Diff-hexdump: like hexdump but brackets bytes that differ from `prev`
  const hexdumpDiff = (guestAddr, len, prev) => {
    const cur = readBytes(guestAddr, len);
    let changedRanges = [];
    for (let i = 0; i < len; i++) {
      if (prev[i] !== cur[i]) {
        if (changedRanges.length && changedRanges[changedRanges.length-1][1] === i-1) {
          changedRanges[changedRanges.length-1][1] = i;
        } else {
          changedRanges.push([i, i]);
        }
      }
    }
    console.log(`Hexdump ${hex(guestAddr)} (${len} bytes)${changedRanges.length ? ' [changed: ' + changedRanges.map(r => r[0] === r[1] ? `+${r[0]}` : `+${r[0]}..${r[1]}`).join(',') + ']' : ' [no changes]'}:`);
    for (let off = 0; off < len; off += 16) {
      let hexPart = '', ascPart = '';
      for (let i = 0; i < 16 && off + i < len; i++) {
        const b = cur[off + i];
        const marker = prev[off + i] !== b ? '*' : ' ';
        hexPart += b.toString(16).padStart(2, '0') + marker;
        ascPart += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.';
      }
      console.log(`  ${hex(guestAddr + off)}  ${hexPart.padEnd(49)}${ascPart}`);
    }
    return cur;
  };

  // Pretty-print MFC CStrings at --show-cstring= addrs (returns multi-line string or '')
  const showCStrings = () => {
    if (!showCStringAddrs.length || !decodeMfcCString) return '';
    const mem = new Uint8Array(memory.buffer);
    const imageBase = instance.exports.get_image_base();
    const lines = [];
    for (const addr of showCStringAddrs) {
      const d = decodeMfcCString(mem, addr, imageBase);
      if (d) lines.push(`  [CString@${hex(addr)}] rc=${d.refcount} len=${d.len} "${d.text}"`);
      else lines.push(`  [CString@${hex(addr)}] (not a CString)`);
    }
    return lines.join('\n');
  };

  let prevEip = 0, stuckCount = 0, prevApiCount = 0, prevRegFp = 0;
  let stepping = false;  // single-step mode after breakpoint
  let apiBreakHit = null; // set when an API breakpoint triggers

  // Watchpoint: WASM-level per-block memory watch (1/2/4 byte granularity)
  let watchAddr = 0, watchPrevVal = 0, watchSize = 4;
  let extraWatchAddrs = []; // additional addrs beyond watchAddr (JS-side fan-out)
  let extraWatchPrev = []; // prev values for extras
  if (WATCH_BYTE) {
    const all = WATCH_BYTE.split(',').map(s => parseInt(s.split(':')[0], 16) >>> 0);
    watchAddr = all[0]; extraWatchAddrs = all.slice(1);
    watchSize = 1;
  } else if (WATCH_WORD) {
    const all = WATCH_WORD.split(',').map(s => parseInt(s.split(':')[0], 16) >>> 0);
    watchAddr = all[0]; extraWatchAddrs = all.slice(1);
    watchSize = 2;
  } else if (WATCH_SPEC) {
    const all = WATCH_SPEC.split(',').map(s => parseInt(s.split(':')[0], 16) >>> 0);
    watchAddr = all[0]; extraWatchAddrs = all.slice(1);
    watchSize = 4;
  }
  if (watchAddr) {
    const sizeName = { 1: 'byte', 2: 'word', 4: 'dword' }[watchSize];
    const extra = extraWatchAddrs.length ? ` +${extraWatchAddrs.length} more (JS fan-out)` : '';
    const delayed = WATCH_START_BATCH > 0 ? `, delayed until batch ${WATCH_START_BATCH}` : '';
    const mode = WATCH_JS_ONLY ? 'JS-sampled' : 'checked every block';
    console.log(`Watchpoint set: ${hex(watchAddr)} (${sizeName}, ${mode}${delayed})${extra}`);
  }
  const readGuestSized = (addr) => {
    const wa = g2w(addr);
    const u8 = new Uint8Array(memory.buffer);
    if (watchSize === 1) return u8[wa];
    if (watchSize === 2) return u8[wa] | (u8[wa+1] << 8);
    return new DataView(memory.buffer).getUint32(wa, true);
  };
  if (extraWatchAddrs.length) {
    extraWatchPrev = extraWatchAddrs.map(a => readGuestSized(a) >>> 0);
  }

  let watchActive = false;
  const activateWatchpoint = () => {
    if (!watchAddr) return;
    if (!WATCH_JS_ONLY) {
      if (instance.exports.set_watchpoint_size) instance.exports.set_watchpoint_size(watchSize);
      instance.exports.set_watchpoint(watchAddr);
      watchPrevVal = instance.exports.get_watch_val();
    } else {
      watchPrevVal = readGuestSized(watchAddr) >>> 0;
    }
    watchActive = true;
  };
  if (!WATCH_START_BATCH) activateWatchpoint();

  // Arm shadow call-stack (--trace-callstack). Gated WAT-side so off-runs pay
  // zero cost in the hot path.
  if (TRACE_CALLSTACK && instance.exports.set_callstack_enabled) {
    instance.exports.set_callstack_enabled(1);
  }
  if (TRACE_WIN16 && instance.exports.set_win16_trace) {
    instance.exports.set_win16_trace(1);
  }
  const dumpCallstack = (label, e) => {
    if (!TRACE_CALLSTACK || !e || !e.get_callstack_depth) return;
    const depth = e.get_callstack_depth() | 0;
    const n = Math.min(depth, TRACE_CALLSTACK_DEPTH);
    if (!n) { console.log(`  [stack ${label}] (empty)`); return; }
    console.log(`  [stack ${label} depth=${depth}]`);
    for (let i = 0; i < n; i++) {
      const ra = e.get_callstack_entry(i) >>> 0;
      console.log(`    #${i} ret=${hex(ra)}`);
    }
  };

  const watchFilterVal = WATCH_VALUE !== null ? parseInt(WATCH_VALUE, 16) : null;

  const checkWatchpoint = (batch) => {
    if (!watchAddr) return false;
    if (!watchActive) {
      if (batch < WATCH_START_BATCH) return false;
      activateWatchpoint();
      console.log(`Watchpoint armed at batch ${batch}: ${hex(watchAddr)} = ${hex(watchPrevVal)}`);
      if (extraWatchAddrs.length) extraWatchPrev = extraWatchAddrs.map(a => readGuestSized(a) >>> 0);
      return false;
    }
    let hit = false;
    const newVal = WATCH_JS_ONLY ? (readGuestSized(watchAddr) >>> 0) : instance.exports.get_watch_val();
    if (newVal !== watchPrevVal) {
      const filtered = watchFilterVal !== null && (newVal >>> 0) !== (watchFilterVal >>> 0);
      if (!filtered) {
        console.log(`\n*** WATCHPOINT hit at batch ${batch}: [${hex(watchAddr)}] changed`);
        console.log(`  Old: ${hex(watchPrevVal)}  New: ${hex(newVal)}  EIP: ${hex(instance.exports.get_eip())}  prev_eip: ${hex(instance.exports.get_dbg_prev_eip())}`);
        hit = true;
      }
      watchPrevVal = newVal;
    }
    // JS-side fan-out for additional watch addresses
    for (let i = 0; i < extraWatchAddrs.length; i++) {
      const a = extraWatchAddrs[i];
      const v = readGuestSized(a) >>> 0;
      if (v !== extraWatchPrev[i]) {
        if (watchFilterVal === null || v === (watchFilterVal >>> 0)) {
          console.log(`\n*** WATCHPOINT hit at batch ${batch}: [${hex(a)}] changed`);
          console.log(`  Old: ${hex(extraWatchPrev[i])}  New: ${hex(v)}  EIP: ${hex(instance.exports.get_eip())}  prev_eip: ${hex(instance.exports.get_dbg_prev_eip())}`);
          hit = true;
        }
        extraWatchPrev[i] = v;
      }
    }
    return hit;
  };

  const debugPrompt = async (reason) => {
    console.log('  ' + regs());
    console.log('  prev_eip: ' + hex(instance.exports.get_dbg_prev_eip()));
    dumpStack(reason);
    disasmAt(instance.exports.get_eip());
    if (TRACE_SEH) dumpSEH();
    const cs = showCStrings();
    if (cs) console.log(cs);
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

  // Live standard-scrollbar geometry. Non-client scrollbars are 16px strips
  // laid just outside the client rect (see $defwndproc_do_ncpaint), so the
  // strip follows the window's client rect and nothing about it is a constant
  // a test can safely hardcode: frame metrics, default placement and the app's
  // own control-bar layout all move it.
  const SCROLL_STRIP = 16;
  const findStandardScrollBar = (axis, target) => {
    const e = instance.exports;
    if (!renderer || !e.standard_scroll_pos) return null;
    const bit = axis === 'v' ? 0x00200000 : 0x00100000;
    const bar = axis === 'v' ? 1 : 0;
    const wanted = target ? (parseInt(target, 16) | 0) : 0;
    let match = null;
    for (const win of Object.values(renderer.windows || {})) {
      if (!win || !win.visible || !win.hwnd) continue;
      if (wanted && (win.hwnd | 0) !== wanted) continue;
      const style = e.wnd_get_style_export ? e.wnd_get_style_export(win.hwnd) >>> 0 : win.style >>> 0;
      if (!(style & bit)) continue;
      const pos = e.standard_scroll_pos(win.hwnd, bar) | 0;
      if (!match || pos > match.pos) {
        const cr = win.clientRect || { x: win.x, y: win.y, w: win.w, h: win.h };
        match = {
          hwnd: win.hwnd | 0, win, pos,
          min: e.standard_scroll_min ? e.standard_scroll_min(win.hwnd, bar) | 0 : 0,
          max: e.standard_scroll_max ? e.standard_scroll_max(win.hwnd, bar) | 0 : 0,
          page: e.standard_scroll_page
            ? (e.standard_scroll_page(win.hwnd, bar) | 0) || (axis === 'v' ? cr.h : cr.w)
            : (axis === 'v' ? cr.h : cr.w),
          strip: axis === 'v'
            ? { x0: cr.x + cr.w, y0: cr.y, x1: cr.x + cr.w + SCROLL_STRIP, y1: cr.y + cr.h }
            : { x0: cr.x, y0: cr.y + cr.h, x1: cr.x + cr.w, y1: cr.y + cr.h + SCROLL_STRIP },
          axis,
        };
      }
    }
    return match;
  };
  // A point inside one part of a live scrollbar. 'lo'/'hi' are the arrow
  // buttons at each end, 'page-lo'/'page-hi' the track just inside them, and
  // 'thumb' the thumb at its current position.
  const scrollBarPoint = (bar, part) => {
    const s = bar.strip;
    const vert = bar.axis === 'v';
    const across = vert ? Math.floor((s.x0 + s.x1) / 2) : Math.floor((s.y0 + s.y1) / 2);
    const lo = vert ? s.y0 : s.x0;
    const hi = vert ? s.y1 : s.x1;
    const long = hi - lo;
    const track = Math.max(0, long - 2 * SCROLL_STRIP);
    let along;
    if (part === 'lo') along = lo + Math.floor(SCROLL_STRIP / 2);
    else if (part === 'hi') along = hi - 1 - Math.floor(SCROLL_STRIP / 2);
    else if (part === 'page-lo') along = lo + SCROLL_STRIP + 2;
    else if (part === 'page-hi') along = hi - SCROLL_STRIP - 3;
    else {
      // Thumb: same arithmetic $defwndproc_paint_standard_scrollbar uses —
      // size proportional to page/range, offset proportional to pos.
      const range = Math.max(1, bar.max - bar.min + 1);
      const thumb = Math.min(track, Math.max(SCROLL_STRIP,
        Math.floor((track * Math.max(1, bar.page)) / range)));
      const travel = Math.max(0, track - thumb);
      const span = Math.max(1, (bar.max - bar.page + 1) - bar.min);
      const off = Math.min(travel, Math.floor((travel * (bar.pos - bar.min)) / span));
      along = lo + SCROLL_STRIP + off + Math.floor(thumb / 2);
    }
    return vert ? { x: across, y: along } : { x: along, y: across };
  };

  let lastSchedSig = null;
  let lastSchedAt = 0;
  for (let batch = 0; batch < MAX_BATCHES && !stopped; batch++) {
    if (TRACE_SCHED) {
      const sched = describeSchedule(instance, threadManager);
      if (sched.sig !== lastSchedSig || (batch - lastSchedAt) >= TRACE_SCHED_EVERY) {
        const held = sched.sig === lastSchedSig ? ` (unchanged for ${batch - lastSchedAt} batches)` : '';
        console.log(`[sched] b=${batch} ${sched.text}${held}`);
        lastSchedSig = sched.sig;
        lastSchedAt = batch;
      }
    }
    tickState.batch = batch;
    tickStateRef.batch = batch;
    tickState.callsInBatch = 0;
    if (ctx.pumpAudioCompletions) ctx.pumpAudioCompletions();
    let injectedInputThisBatch = false;
    // Inject scheduled input events at the right batch
    while (scheduledInput.length && scheduledInput[0].batch <= batch) {
      const ev = scheduledInput.shift();
      injectedInputThisBatch = true;
      // Start the input->blit clock on events a user would perform. The
      // wrapped gdi_surface_upload stops it at the first blit that follows.
      if (LATENCY_STATS && /^(keypress|keydown|keyup|click|dblclick)$/.test(ev.action)) {
        latency.pending = { kind: ev.action, batch, at: process.hrtime.bigint(), painted: false };
      }
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
      } else if (ev.action === 'dump-main-edit' && renderer) {
        // Find the first WAT EditState (class==2) attached to main_hwnd or
        // its descendants and dump its text. Notepad's main edit is its
        // sole child class-2 control, so first match is enough.
        const we = instance.exports;
        let found = 0;
        if (we.ctrl_get_class && we.get_edit_text && we.guest_alloc) {
          // Walk WND_RECORDS via renderer.windows; cheaper than exporting an iterator.
          for (const w of Object.values(renderer.windows || {})) {
            if (we.ctrl_get_class(w.hwnd) === 2 && w.visible) { found = w.hwnd; break; }
          }
        }
        if (found) {
          const scratchG = we.guest_alloc(4096);
          const n = we.get_edit_text(found, scratchG, 4095);
          const dv = new DataView(memory.buffer);
          let txt = '';
          for (let i = 0; i < n; i++) txt += String.fromCharCode(dv.getUint8(g2w(scratchG) + i));
          logs.push(`[input] dump-main-edit: hwnd=0x${found.toString(16)} text=${JSON.stringify(txt)} at batch ${batch}`);
        } else {
          logs.push(`[input] dump-main-edit: NO EDIT at batch ${batch}`);
        }
      } else if (ev.action === 'focus-main-window') {
        const we = instance.exports;
        const hwnd = we.get_main_hwnd ? (we.get_main_hwnd() | 0) : 0;
        if (hwnd && we.set_focus_hwnd) {
          we.set_focus_hwnd(hwnd);
          logs.push(`[input] focus-main-window: hwnd=0x${hwnd.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] focus-main-window: NO MAIN HWND at batch ${batch}`);
        }
      } else if (ev.action === 'dump-main-edit-state' && renderer) {
        const we = instance.exports;
        let found = 0;
        if (we.ctrl_get_class && we.get_edit_text && we.guest_alloc) {
          for (const w of Object.values(renderer.windows || {})) {
            if (we.ctrl_get_class(w.hwnd) === 2 && w.visible) { found = w.hwnd; break; }
          }
        }
        if (found) {
          const scratchG = we.guest_alloc(8192);
          const n = we.get_edit_text(found, scratchG, 8191);
          const dv = new DataView(memory.buffer);
          let txt = '';
          for (let i = 0; i < n; i++) txt += String.fromCharCode(dv.getUint8(g2w(scratchG) + i));
          const cursor = we.get_edit_cursor ? we.get_edit_cursor(found) : 0;
          const sel = we.get_edit_sel_start ? we.get_edit_sel_start(found) : cursor;
          const flags = we.get_edit_flags ? we.get_edit_flags(found) : 0;
          const len = we.get_edit_text_len ? we.get_edit_text_len(found) : n;
          const lineCount = we.send_message ? we.send_message(found, 0x00BA, 0, 0) : 1; // EM_GETLINECOUNT
          const firstVisible = we.send_message ? we.send_message(found, 0x00CE, 0, 0) : 0; // EM_GETFIRSTVISIBLELINE
          const label = ev.label ? ` ${ev.label}` : '';
          logs.push(`[input] dump-main-edit-state${label}: hwnd=0x${found.toString(16)} len=${len} cursor=${cursor} sel=${sel} flags=0x${flags.toString(16)} firstVisible=${firstVisible} lineCount=${lineCount} text=${JSON.stringify(txt)} at batch ${batch}`);
        } else {
          const label = ev.label ? ` ${ev.label}` : '';
          logs.push(`[input] dump-main-edit-state${label}: NO EDIT at batch ${batch}`);
        }
      } else if (ev.action === 'wheel-main-edit' && renderer) {
        const we = instance.exports;
        let found = 0;
        if (we.ctrl_get_class && we.send_message) {
          for (const w of Object.values(renderer.windows || {})) {
            if (we.ctrl_get_class(w.hwnd) === 2 && w.visible) { found = w.hwnd; break; }
          }
        }
        if (found) {
          we.send_message(found, 0x020A, (ev.delta << 16), 0); // WM_MOUSEWHEEL
          logs.push(`[input] wheel-main-edit: hwnd=0x${found.toString(16)} delta=${ev.delta} at batch ${batch}`);
        } else {
          logs.push(`[input] wheel-main-edit: NO EDIT at batch ${batch}`);
        }
      } else if (ev.action === 'drag-main-edit' && renderer) {
        const we = instance.exports;
        let found = null;
        if (we.ctrl_get_class) {
          for (const w of Object.values(renderer.windows || {})) {
            if (we.ctrl_get_class(w.hwnd) === 2 && w.visible) { found = w; break; }
          }
        }
        if (found) {
          let ox = found.x || 0;
          let oy = found.y || 0;
          const parent = found.parentHwnd ? renderer.windows[found.parentHwnd] : null;
          if (parent) {
            ox += parent.isPopup ? parent.x : parent.x + 3;
            oy += parent.isPopup ? parent.y : parent.y + 3 + 18 + (renderer._hasMenuBar && renderer._hasMenuBar(parent) ? 18 : 0) + 1;
          }
          const sx1 = ox + ev.x1, sy1 = oy + ev.y1;
          const sx2 = ox + ev.x2, sy2 = oy + ev.y2;
          renderer.handleMouseDown(sx1, sy1, 1);
          renderer.handleMouseMove(sx2, sy2);
          renderer.handleMouseUp(sx2, sy2, 1);
          logs.push(`[input] drag-main-edit: hwnd=0x${found.hwnd.toString(16)} ${sx1},${sy1}->${sx2},${sy2} at batch ${batch}`);
        } else {
          logs.push(`[input] drag-main-edit: NO EDIT at batch ${batch}`);
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
      } else if (ev.action === 'dump-focus') {
        const we = instance.exports;
        const h = we.get_focus_hwnd ? (we.get_focus_hwnd() | 0) : 0;
        const cls = (h && we.ctrl_get_class) ? we.ctrl_get_class(h) : -1;
        const id  = (h && we.ctrl_get_id)    ? we.ctrl_get_id(h)    : -1;
        const parent = (h && we.wnd_get_parent) ? (we.wnd_get_parent(h) | 0) : 0;
        let extra = '';
        if (h && cls === 2 && we.get_edit_text && we.guest_alloc) {
          const scratchG = we.guest_alloc(512);
          const n = we.get_edit_text(h, scratchG, 511);
          const wa = g2w(scratchG);
          const bytes = new Uint8Array(memory.buffer, wa, Math.max(0, n));
          extra = ` parent=0x${parent.toString(16)} text=${JSON.stringify(Buffer.from(bytes).toString('latin1'))}`;
        } else if (parent) {
          extra = ` parent=0x${parent.toString(16)}`;
        }
        const tag = ev.label ? ` ${ev.label}` : '';
        logs.push(`[input] dump-focus${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id}${extra} at batch ${batch}`);
      } else if (ev.action === 'dump-focus-text') {
        const we = instance.exports;
        const h = we.get_focus_hwnd ? (we.get_focus_hwnd() | 0) : 0;
        const cls = (h && we.ctrl_get_class) ? we.ctrl_get_class(h) : -1;
        const id  = (h && we.ctrl_get_id)    ? we.ctrl_get_id(h)    : -1;
        const parent = (h && we.wnd_get_parent) ? (we.wnd_get_parent(h) | 0) : 0;
        const tag = ev.label ? ` ${ev.label}` : '';
        let txt = '';
        let n = 0;
        if (!h) {
          logs.push(`[input] dump-focus-text${tag}: NO FOCUS at batch ${batch}`);
        } else if (cls === 2 && we.get_edit_text && we.guest_alloc) {
          const scratchG = we.guest_alloc(8192);
          n = we.get_edit_text(h, scratchG, 8191) | 0;
          const wa = g2w(scratchG);
          const bytes = new Uint8Array(memory.buffer, wa, Math.max(0, n));
          txt = Buffer.from(bytes).toString('latin1');
          logs.push(`[input] dump-focus-text${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} len=${n} text=${JSON.stringify(txt)} at batch ${batch}`);
        } else if (we.send_message && we.guest_alloc) {
          const cap = 8192;
          const scratchG = we.guest_alloc(cap);
          n = we.send_message(h, 0x000D, cap, scratchG) | 0; // WM_GETTEXT
          const wa = g2w(scratchG);
          const viewLen = Math.max(0, Math.min(n, cap - 1));
          const bytes = new Uint8Array(memory.buffer, wa, viewLen);
          txt = Buffer.from(bytes).toString('latin1');
          logs.push(`[input] dump-focus-text${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} len=${n} text=${JSON.stringify(txt)} at batch ${batch}`);
        } else {
          logs.push(`[input] dump-focus-text${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} NO TEXT API at batch ${batch}`);
        }
      } else if (ev.action === 'dump-focus-state') {
        const we = instance.exports;
        const h = we.get_focus_hwnd ? (we.get_focus_hwnd() | 0) : 0;
        const cls = (h && we.ctrl_get_class) ? we.ctrl_get_class(h) : -1;
        const id  = (h && we.ctrl_get_id)    ? we.ctrl_get_id(h)    : -1;
        const parent = (h && we.wnd_get_parent) ? (we.wnd_get_parent(h) | 0) : 0;
        const style = (h && we.wnd_get_style_export) ? (we.wnd_get_style_export(h) >>> 0) : 0;
        const editFlags = (h && we.get_edit_flags) ? (we.get_edit_flags(h) >>> 0) : 0;
        const tag = ev.label ? ` ${ev.label}` : '';
        if (!h) {
          logs.push(`[input] dump-focus-state${tag}: NO FOCUS at batch ${batch}`);
        } else if (we.send_message && we.guest_alloc) {
          const reportedLen = Math.max(0, we.send_message(h, 0x000E, 0, 0) | 0); // WM_GETTEXTLENGTH
          const cap = Math.min(reportedLen + 1, 64 * 1024);
          const textG = we.guest_alloc(cap);
          const n = we.send_message(h, 0x000D, cap, textG) | 0; // WM_GETTEXT
          const wa = g2w(textG);
          const viewLen = Math.max(0, Math.min(n, cap - 1));
          const bytes = new Uint8Array(memory.buffer, wa, viewLen);
          const txt = Buffer.from(bytes).toString('latin1');
          const startG = we.guest_alloc(4);
          const endG = we.guest_alloc(4);
          const dv = new DataView(memory.buffer);
          dv.setUint32(g2w(startG), 0, true);
          dv.setUint32(g2w(endG), 0, true);
          const selRet = we.send_message(h, 0x00B0, startG, endG) >>> 0; // EM_GETSEL
          const selStart = dv.getUint32(g2w(startG), true) >>> 0;
          const selEnd = dv.getUint32(g2w(endG), true) >>> 0;
          const lineCount = we.send_message(h, 0x00BA, 0, 0) | 0; // EM_GETLINECOUNT
          const firstVisible = we.send_message(h, 0x00CE, 0, 0) | 0; // EM_GETFIRSTVISIBLELINE
          logs.push(`[input] dump-focus-state${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} style=0x${style.toString(16)} flags=0x${editFlags.toString(16)} len=${n} sel=${selStart}..${selEnd} selRet=0x${selRet.toString(16)} firstVisible=${firstVisible} lineCount=${lineCount} text=${JSON.stringify(txt)} at batch ${batch}`);
        } else {
          logs.push(`[input] dump-focus-state${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} NO STATE API at batch ${batch}`);
        }
      } else if (ev.action === 'dump-print-state') {
        const tag = ev.label ? `:${ev.label}` : '';
        const state = instance.exports.get_printer_doc_state ? instance.exports.get_printer_doc_state() | 0 : -1;
        const pages = instance.exports.get_printer_page_count ? instance.exports.get_printer_page_count() | 0 : -1;
        const quit = instance.exports.get_quit_flag ? instance.exports.get_quit_flag() | 0 : -1;
        const reason = instance.exports.get_yield_reason ? instance.exports.get_yield_reason() | 0 : -1;
        logs.push(`[input] dump-print-state${tag}: state=${state} pages=${pages} quit=${quit} yield=${reason} eip=0x${(instance.exports.get_eip() >>> 0).toString(16)} at batch ${batch}`);
      } else if (ev.action === 'formatrange-probe') {
        const we = instance.exports;
        const h = we.get_focus_hwnd ? we.get_focus_hwnd() >>> 0 : 0;
        const tag = ev.label ? `:${ev.label}` : '';
        if (!h || !we.send_message || !we.guest_alloc || !we.guest_write32) {
          logs.push(`[input] formatrange-probe${tag}: unavailable at batch ${batch}`);
        } else {
          const len = Math.max(0, we.send_message(h, 0x000E, 0, 0) | 0);
          const fr = we.guest_alloc(48) >>> 0;
          const put = (off, value) => we.guest_write32((fr + off) >>> 0, value | 0);
          put(0, 1); put(4, 1); // deterministic non-null display/target DCs
          put(8, 0); put(12, 0); put(16, ev.width); put(20, ev.height);
          put(24, 0); put(28, 0); put(32, ev.width); put(36, ev.height);
          const bounds = [0];
          let cp = 0;
          for (let page = 0; page < 256 && cp < len; page++) {
            put(40, cp); put(44, len);
            const next = we.richedit_formatrange_next
              ? we.richedit_formatrange_next(fr) | 0
              : we.send_message(h, 0x0439, 0, fr) | 0;
            if (next <= cp || next > len) break;
            cp = next;
            bounds.push(cp);
          }
          we.send_message(h, 0x0439, 0, 0); // release RichEdit format cache
          logs.push(`[input] formatrange-probe${tag}: hwnd=0x${h.toString(16)} len=${len} pages=${Math.max(0, bounds.length - 1)} bounds=${bounds.join(',')} complete=${cp === len ? 1 : 0} at batch ${batch}`);
        }
      } else if (ev.action === 'dump-focus-unicode') {
        const we = instance.exports;
        const h = we.get_focus_hwnd ? (we.get_focus_hwnd() | 0) : 0;
        const tag = ev.label ? ` ${ev.label}` : '';
        if (!h || !we.send_message || !we.guest_alloc) {
          logs.push(`[input] dump-focus-unicode${tag}: NO FOCUS/API at batch ${batch}`);
        } else {
          const gtG = we.guest_alloc(24);
          const textG = we.guest_alloc(32768);
          const gtWA = g2w(gtG);
          const textWA = g2w(textG);
          const dv = new DataView(memory.buffer);
          new Uint8Array(memory.buffer, gtWA, 24).fill(0);
          new Uint8Array(memory.buffer, textWA, 32768).fill(0);
          dv.setUint32(gtWA, 32768, true); // GETTEXTEX.cb, bytes
          dv.setUint32(gtWA + 4, 0, true); // flags
          dv.setUint32(gtWA + 8, 1200, true); // UTF-16LE
          const n = we.send_message(h, 0x045E, gtG, textG) | 0; // EM_GETTEXTEX
          let units = 0;
          while (units < 16383 && dv.getUint16(textWA + units * 2, true)) units++;
          const bytes = Buffer.from(new Uint8Array(memory.buffer, textWA, units * 2));
          const txt = bytes.toString('utf16le');
          const cps = Array.from(txt, ch => `U+${ch.codePointAt(0).toString(16).toUpperCase()}`).join(',');
          logs.push(`[input] dump-focus-unicode${tag}: hwnd=0x${h.toString(16)} ret=${n} units=${units} codepoints=${cps} text=${JSON.stringify(txt)} at batch ${batch}`);
        }
      } else if (ev.action === 'dump-control-state') {
        const we = instance.exports;
        let h = 0;
        for (const w of Object.values((renderer && renderer.windows) || {})) {
          if (w.visible && we.ctrl_get_id && we.ctrl_get_id(w.hwnd) === ev.ctrlId) {
            h = w.hwnd;
            break;
          }
        }
        const tag = ev.label ? ` ${ev.label}` : '';
        if (!h) {
          logs.push(`[input] dump-control-state${tag}: id=${ev.ctrlId} NOT FOUND at batch ${batch}`);
        } else if (we.send_message && we.guest_alloc) {
          const cls = we.ctrl_get_class ? we.ctrl_get_class(h) : -1;
          const parent = we.wnd_get_parent ? (we.wnd_get_parent(h) | 0) : 0;
          const reportedLen = Math.max(0, we.send_message(h, 0x000E, 0, 0) | 0); // WM_GETTEXTLENGTH
          const cap = Math.min(reportedLen + 1, 1024 * 1024);
          const textG = we.guest_alloc(cap);
          const n = we.send_message(h, 0x000D, cap, textG) | 0; // WM_GETTEXT
          const wa = g2w(textG);
          const viewLen = Math.max(0, Math.min(n, cap - 1));
          const txt = Buffer.from(new Uint8Array(memory.buffer, wa, viewLen)).toString('latin1');
          const startG = we.guest_alloc(4);
          const endG = we.guest_alloc(4);
          const dv = new DataView(memory.buffer);
          dv.setUint32(g2w(startG), 0, true);
          dv.setUint32(g2w(endG), 0, true);
          const selRet = we.send_message(h, 0x00B0, startG, endG) >>> 0; // EM_GETSEL
          const selStart = dv.getUint32(g2w(startG), true) >>> 0;
          const selEnd = dv.getUint32(g2w(endG), true) >>> 0;
          const lineCount = we.send_message(h, 0x00BA, 0, 0) | 0;
          const firstVisible = we.send_message(h, 0x00CE, 0, 0) | 0;
          logs.push(`[input] dump-control-state${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${ev.ctrlId} parent=0x${parent.toString(16)} len=${n} sel=${selStart}..${selEnd} selRet=0x${selRet.toString(16)} firstVisible=${firstVisible} lineCount=${lineCount} text=${JSON.stringify(txt)} at batch ${batch}`);
        } else {
          logs.push(`[input] dump-control-state${tag}: hwnd=0x${h.toString(16)} id=${ev.ctrlId} NO STATE API at batch ${batch}`);
        }
      } else if (ev.action === 'dump-clipboard') {
        const we = instance.exports;
        const tag = ev.label ? ` ${ev.label}` : '';
        if (we.clipboard_get_rtf_format_id && we.clipboard_rtf_len &&
            we.clipboard_rtf_ptr && we.clipboard_count_formats &&
            we.clipboard_is_format_available && we.clipboard_get_data_handle) {
          const fmt = we.clipboard_get_rtf_format_id() >>> 0;
          const textLen = we.clipboard_text_len ? (we.clipboard_text_len() >>> 0) : 0;
          const rtfLen = we.clipboard_rtf_len() >>> 0;
          const count = we.clipboard_count_formats() >>> 0;
          const oleObject = we.clipboard_ole_data_object ? (we.clipboard_ole_data_object() >>> 0) : 0;
          const availText = we.clipboard_is_format_available(1) >>> 0;
          const availRtf = we.clipboard_is_format_available(fmt) >>> 0;
          const availDib = we.clipboard_is_format_available(8) >>> 0;
          const textHandle = we.clipboard_get_data_handle(1) >>> 0;
          const rtfHandle = we.clipboard_get_data_handle(fmt) >>> 0;
          const dibHandle = we.clipboard_get_data_handle(8) >>> 0;
          let rtf = '';
          const ptr = we.clipboard_rtf_ptr() >>> 0;
          const wa = ptr ? g2w(ptr) : 0;
          if (wa && rtfLen) {
            const n = Math.min(rtfLen, 96, memory.buffer.byteLength - wa);
            const bytes = new Uint8Array(memory.buffer, wa, Math.max(0, n));
            rtf = Buffer.from(bytes).toString('latin1');
          }
          logs.push(`[input] dump-clipboard${tag}: count=${count} oleObject=0x${oleObject.toString(16)} textLen=${textLen} rtfFmt=0x${fmt.toString(16)} rtfLen=${rtfLen} availText=${availText} availRtf=${availRtf} availDib=${availDib} textHandle=0x${textHandle.toString(16)} rtfHandle=0x${rtfHandle.toString(16)} dibHandle=0x${dibHandle.toString(16)} rtf=${JSON.stringify(rtf)} at batch ${batch}`);
        } else {
          logs.push(`[input] dump-clipboard${tag}: NO CLIPBOARD API at batch ${batch}`);
        }
      } else if (ev.action === 'seed-cf-dib') {
        const we = instance.exports;
        const tag = ev.label ? ` ${ev.label}` : '';
        const h = we.get_focus_hwnd ? (we.get_focus_hwnd() >>> 0) : 0;
        if (!h || !we.guest_alloc || !we.clipboard_store_binary_data || !we.post_message_q) {
          logs.push(`[input] seed-cf-dib${tag}: unavailable focus=0x${h.toString(16)} at batch ${batch}`);
        } else {
          const width = 32, height = 24, stride = 96;
          const dibSize = 40 + stride * height;
          const dibG = we.guest_alloc(dibSize) >>> 0;
          const dibWA = g2w(dibG);
          const bytes = new Uint8Array(memory.buffer);
          const dv = new DataView(memory.buffer);
          bytes.fill(0, dibWA, dibWA + dibSize);
          dv.setUint32(dibWA, 40, true);
          dv.setInt32(dibWA + 4, width, true);
          dv.setInt32(dibWA + 8, height, true);
          dv.setUint16(dibWA + 12, 1, true);
          dv.setUint16(dibWA + 14, 24, true);
          dv.setUint32(dibWA + 20, stride * height, true);
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const p = dibWA + 40 + y * stride + x * 3;
              const red = ((x >> 3) + (y >> 3)) % 2 === 0;
              bytes[p] = red ? 0 : 255;
              bytes[p + 1] = 0;
              bytes[p + 2] = red ? 255 : 0;
            }
          }
          if (we.clipboard_clear_all_data) we.clipboard_clear_all_data();
          const owned = we.clipboard_store_binary_data(8, dibG) >>> 0;
          if (we.guest_free) we.guest_free(dibG);
          const queued = we.post_message_q(h, 0x0302, 0, 0) | 0;
          logs.push(`[input] seed-cf-dib${tag}: hwnd=0x${h.toString(16)} owned=0x${owned.toString(16)} queued=${queued} at batch ${batch}`);
        }
      } else if (ev.action === 'set-focus-text-b64') {
        const e = instance.exports;
        const h = e.get_focus_hwnd ? (e.get_focus_hwnd() >>> 0) : 0;
        const tag = ev.label ? ` ${ev.label}` : '';
        if (!h) {
          logs.push(`[input] set-focus-text-b64${tag}: NO FOCUS at batch ${batch}`);
        } else if (e.send_message && e.guest_alloc) {
          const g = e.guest_alloc(ev.text.length + 1) >>> 0;
          const wa = g2w(g);
          const u8 = new Uint8Array(memory.buffer);
          for (let i = 0; i < ev.text.length; i++) u8[wa + i] = ev.text.charCodeAt(i) & 0xff;
          u8[wa + ev.text.length] = 0;
          const ret = e.send_message(h, 0x000C, 0, g) >>> 0; // WM_SETTEXT
          if (e.guest_free) e.guest_free(g);
          logs.push(`[input] set-focus-text-b64${tag}: hwnd=0x${h.toString(16)} len=${ev.text.length} ret=${ret} at batch ${batch}`);
        } else {
          logs.push(`[input] set-focus-text-b64${tag}: hwnd=0x${h.toString(16)} NO TEXT API at batch ${batch}`);
        }
      } else if (ev.action === 'set-focus-selection') {
        const e = instance.exports;
        const h = e.get_focus_hwnd ? (e.get_focus_hwnd() >>> 0) : 0;
        const tag = ev.label ? ` ${ev.label}` : '';
        if (!h) {
          logs.push(`[input] set-focus-selection${tag}: NO FOCUS at batch ${batch}`);
        } else if (e.send_message) {
          const ret = e.send_message(h, 0x00B1, ev.start | 0, ev.end | 0) >>> 0; // EM_SETSEL
          logs.push(`[input] set-focus-selection${tag}: hwnd=0x${h.toString(16)} range=${ev.start}..${ev.end} ret=0x${ret.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] set-focus-selection${tag}: hwnd=0x${h.toString(16)} NO SEND API at batch ${batch}`);
        }
      } else if (ev.action === 'send-focus-message') {
        const e = instance.exports;
        const h = e.get_focus_hwnd ? (e.get_focus_hwnd() >>> 0) : 0;
        const tag = ev.label ? ` ${ev.label}` : '';
        if (!h) {
          logs.push(`[input] send-focus-message${tag}: NO FOCUS at batch ${batch}`);
        } else if (e.send_message) {
          const ret = e.send_message(h, ev.msg | 0, ev.wParam | 0, ev.lParam | 0) >>> 0;
          logs.push(`[input] send-focus-message${tag}: hwnd=0x${h.toString(16)} msg=0x${(ev.msg >>> 0).toString(16)} wParam=0x${(ev.wParam >>> 0).toString(16)} lParam=0x${(ev.lParam >>> 0).toString(16)} ret=0x${ret.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] send-focus-message${tag}: hwnd=0x${h.toString(16)} NO SEND API at batch ${batch}`);
        }
      } else if (ev.action === 'dump-focus-charformat') {
        const we = instance.exports;
        const h = we.get_focus_hwnd ? (we.get_focus_hwnd() | 0) : 0;
        const cls = (h && we.ctrl_get_class) ? we.ctrl_get_class(h) : -1;
        const id  = (h && we.ctrl_get_id)    ? we.ctrl_get_id(h)    : -1;
        const parent = (h && we.wnd_get_parent) ? (we.wnd_get_parent(h) | 0) : 0;
        const tag = ev.label ? ` ${ev.label}` : '';
        if (!h) {
          logs.push(`[input] dump-focus-charformat${tag}: NO FOCUS at batch ${batch}`);
        } else if (we.send_message && we.guest_alloc) {
          const cfSize = 60; // CHARFORMATA; RichEdit accepts this prefix for CHARFORMAT2A too.
          const cfG = we.guest_alloc(128);
          const cfWA = g2w(cfG);
          new Uint8Array(memory.buffer, cfWA, 128).fill(0);
          const dv = new DataView(memory.buffer);
          dv.setUint32(cfWA, cfSize, true); // cbSize
          const ret = we.send_message(h, 0x043A, 1, cfG) >>> 0; // EM_GETCHARFORMAT, SCF_SELECTION
          const cb = dv.getUint32(cfWA, true) >>> 0;
          const mask = dv.getUint32(cfWA + 4, true) >>> 0;
          const effects = dv.getUint32(cfWA + 8, true) >>> 0;
          const yHeight = dv.getInt32(cfWA + 12, true) | 0;
          const yOffset = dv.getInt32(cfWA + 16, true) | 0;
          const color = dv.getUint32(cfWA + 20, true) >>> 0;
          const charset = dv.getUint8(cfWA + 24);
          const pitch = dv.getUint8(cfWA + 25);
          let face = '';
          for (let i = 0; i < 32; i++) {
            const ch = dv.getUint8(cfWA + 26 + i);
            if (!ch) break;
            face += String.fromCharCode(ch);
          }
          const bold = !!(effects & 0x1);
          const italic = !!(effects & 0x2);
          const underline = !!(effects & 0x4);
          logs.push(`[input] dump-focus-charformat${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} ret=0x${ret.toString(16)} cb=${cb} mask=0x${mask.toString(16)} effects=0x${effects.toString(16)} bold=${bold ? 1 : 0} italic=${italic ? 1 : 0} underline=${underline ? 1 : 0} yHeight=${yHeight} yOffset=${yOffset} color=0x${color.toString(16)} charset=${charset} pitch=${pitch} face=${JSON.stringify(face)} at batch ${batch}`);
        } else {
          logs.push(`[input] dump-focus-charformat${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} NO CHARFORMAT API at batch ${batch}`);
        }
      } else if (ev.action === 'set-focus-charformat-color') {
        const we = instance.exports;
        const h = we.get_focus_hwnd ? (we.get_focus_hwnd() | 0) : 0;
        const cls = (h && we.ctrl_get_class) ? we.ctrl_get_class(h) : -1;
        const id  = (h && we.ctrl_get_id)    ? we.ctrl_get_id(h)    : -1;
        const parent = (h && we.wnd_get_parent) ? (we.wnd_get_parent(h) | 0) : 0;
        const tag = ev.label ? ` ${ev.label}` : '';
        if (!h) {
          logs.push(`[input] set-focus-charformat-color${tag}: NO FOCUS at batch ${batch}`);
        } else if (we.send_message && we.guest_alloc) {
          const cfG = we.guest_alloc(128);
          const cfWA = g2w(cfG);
          const dv = new DataView(memory.buffer);
          new Uint8Array(memory.buffer, cfWA, 128).fill(0);
          dv.setUint32(cfWA, 60, true); // CHARFORMATA cbSize
          dv.setUint32(cfWA + 4, 0x40000000, true); // CFM_COLOR
          dv.setUint32(cfWA + 8, 0, true); // clear CFE_AUTOCOLOR
          dv.setUint32(cfWA + 20, ev.color >>> 0, true); // crTextColor
          const ret = we.send_message(h, 0x0444, 1, cfG) >>> 0; // EM_SETCHARFORMAT, SCF_SELECTION
          logs.push(`[input] set-focus-charformat-color${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} color=0x${(ev.color >>> 0).toString(16)} ret=0x${ret.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] set-focus-charformat-color${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} NO CHARFORMAT API at batch ${batch}`);
        }
      } else if (ev.action === 'set-focus-charformat-size') {
        const we = instance.exports;
        const h = we.get_focus_hwnd ? (we.get_focus_hwnd() | 0) : 0;
        const cls = (h && we.ctrl_get_class) ? we.ctrl_get_class(h) : -1;
        const id  = (h && we.ctrl_get_id)    ? we.ctrl_get_id(h)    : -1;
        const parent = (h && we.wnd_get_parent) ? (we.wnd_get_parent(h) | 0) : 0;
        const tag = ev.label ? ` ${ev.label}` : '';
        if (!h) {
          logs.push(`[input] set-focus-charformat-size${tag}: NO FOCUS at batch ${batch}`);
        } else if (we.send_message && we.guest_alloc) {
          const cfG = we.guest_alloc(128);
          const cfWA = g2w(cfG);
          const dv = new DataView(memory.buffer);
          new Uint8Array(memory.buffer, cfWA, 128).fill(0);
          dv.setUint32(cfWA, 60, true); // CHARFORMATA cbSize
          dv.setUint32(cfWA + 4, 0x80000000, true); // CFM_SIZE
          dv.setInt32(cfWA + 12, ev.twips | 0, true); // yHeight
          const ret = we.send_message(h, 0x0444, 1, cfG) >>> 0; // EM_SETCHARFORMAT, SCF_SELECTION
          logs.push(`[input] set-focus-charformat-size${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} twips=${ev.twips | 0} ret=0x${ret.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] set-focus-charformat-size${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} NO CHARFORMAT API at batch ${batch}`);
        }
      } else if (ev.action === 'dump-focus-paraformat') {
        const we = instance.exports;
        const h = we.get_focus_hwnd ? (we.get_focus_hwnd() | 0) : 0;
        const cls = (h && we.ctrl_get_class) ? we.ctrl_get_class(h) : -1;
        const id  = (h && we.ctrl_get_id)    ? we.ctrl_get_id(h)    : -1;
        const parent = (h && we.wnd_get_parent) ? (we.wnd_get_parent(h) | 0) : 0;
        const tag = ev.label ? ` ${ev.label}` : '';
        if (!h) {
          logs.push(`[input] dump-focus-paraformat${tag}: NO FOCUS at batch ${batch}`);
        } else if (we.send_message && we.guest_alloc) {
          const pfSize = 188; // PARAFORMAT2A; the first 156 bytes are PARAFORMAT.
          const pfG = we.guest_alloc(256);
          const pfWA = g2w(pfG);
          new Uint8Array(memory.buffer, pfWA, 256).fill(0);
          const dv = new DataView(memory.buffer);
          dv.setUint32(pfWA, pfSize, true); // cbSize
          const ret = we.send_message(h, 0x043D, 0, pfG) >>> 0; // EM_GETPARAFORMAT
          const cb = dv.getUint32(pfWA, true) >>> 0;
          const mask = dv.getUint32(pfWA + 4, true) >>> 0;
          const numbering = dv.getUint16(pfWA + 8, true) >>> 0;
          const effects = dv.getUint16(pfWA + 10, true) >>> 0;
          const dxStartIndent = dv.getInt32(pfWA + 12, true) | 0;
          const dxRightIndent = dv.getInt32(pfWA + 16, true) | 0;
          const dxOffset = dv.getInt32(pfWA + 20, true) | 0;
          const alignment = dv.getUint16(pfWA + 24, true) >>> 0;
          const tabCount = dv.getInt16(pfWA + 26, true) | 0;
          const tab0 = tabCount > 0 ? (dv.getInt32(pfWA + 28, true) | 0) : 0;
          logs.push(`[input] dump-focus-paraformat${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} ret=0x${ret.toString(16)} cb=${cb} mask=0x${mask.toString(16)} numbering=${numbering} effects=0x${effects.toString(16)} dxStartIndent=${dxStartIndent} dxRightIndent=${dxRightIndent} dxOffset=${dxOffset} alignment=${alignment} tabCount=${tabCount} tab0=${tab0} at batch ${batch}`);
        } else {
          logs.push(`[input] dump-focus-paraformat${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} NO PARAFORMAT API at batch ${batch}`);
        }
      } else if (ev.action === 'set-focus-paraformat-align') {
        const we = instance.exports;
        const h = we.get_focus_hwnd ? (we.get_focus_hwnd() | 0) : 0;
        const cls = (h && we.ctrl_get_class) ? we.ctrl_get_class(h) : -1;
        const id  = (h && we.ctrl_get_id)    ? we.ctrl_get_id(h)    : -1;
        const parent = (h && we.wnd_get_parent) ? (we.wnd_get_parent(h) | 0) : 0;
        const tag = ev.label ? ` ${ev.label}` : '';
        if (!h) {
          logs.push(`[input] set-focus-paraformat-align${tag}: NO FOCUS at batch ${batch}`);
        } else if (we.send_message && we.guest_alloc) {
          const pfG = we.guest_alloc(256);
          const pfWA = g2w(pfG);
          const dv = new DataView(memory.buffer);
          new Uint8Array(memory.buffer, pfWA, 256).fill(0);
          dv.setUint32(pfWA, 188, true); // PARAFORMAT2A cbSize
          dv.setUint32(pfWA + 4, 0x00000008, true); // PFM_ALIGNMENT
          dv.setUint16(pfWA + 24, ev.align >>> 0, true); // wAlignment
          const ret = we.send_message(h, 0x0447, 0, pfG) >>> 0; // EM_SETPARAFORMAT
          logs.push(`[input] set-focus-paraformat-align${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} alignment=${ev.align >>> 0} ret=0x${ret.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] set-focus-paraformat-align${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} NO PARAFORMAT API at batch ${batch}`);
        }
      } else if (ev.action === 'set-focus-paraformat-basic') {
        const we = instance.exports;
        const h = we.get_focus_hwnd ? (we.get_focus_hwnd() | 0) : 0;
        const cls = (h && we.ctrl_get_class) ? we.ctrl_get_class(h) : -1;
        const id  = (h && we.ctrl_get_id)    ? we.ctrl_get_id(h)    : -1;
        const parent = (h && we.wnd_get_parent) ? (we.wnd_get_parent(h) | 0) : 0;
        const tag = ev.label ? ` ${ev.label}` : '';
        if (!h) {
          logs.push(`[input] set-focus-paraformat-basic${tag}: NO FOCUS at batch ${batch}`);
        } else if (we.send_message && we.guest_alloc) {
          const pfG = we.guest_alloc(256);
          const pfWA = g2w(pfG);
          const dv = new DataView(memory.buffer);
          new Uint8Array(memory.buffer, pfWA, 256).fill(0);
          dv.setUint32(pfWA, 188, true); // PARAFORMAT2A cbSize
          dv.setUint32(pfWA + 4, 0x00000037, true); // PFM_STARTINDENT|RIGHTINDENT|OFFSET|TABSTOPS|NUMBERING
          dv.setUint16(pfWA + 8, ev.numbering >>> 0, true); // wNumbering
          dv.setInt32(pfWA + 12, ev.start | 0, true); // dxStartIndent
          dv.setInt32(pfWA + 16, ev.right | 0, true); // dxRightIndent
          dv.setInt32(pfWA + 20, ev.offset | 0, true); // dxOffset
          dv.setInt16(pfWA + 26, ev.tab ? 1 : 0, true); // cTabCount
          if (ev.tab) dv.setInt32(pfWA + 28, ev.tab | 0, true); // rgxTabs[0]
          const ret = we.send_message(h, 0x0447, 0, pfG) >>> 0; // EM_SETPARAFORMAT
          logs.push(`[input] set-focus-paraformat-basic${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} numbering=${ev.numbering | 0} dxStartIndent=${ev.start | 0} dxRightIndent=${ev.right | 0} dxOffset=${ev.offset | 0} tab=${ev.tab | 0} ret=0x${ret.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] set-focus-paraformat-basic${tag}: hwnd=0x${h.toString(16)} class=${cls} id=${id} parent=0x${parent.toString(16)} NO PARAFORMAT API at batch ${batch}`);
        }
      } else if (ev.action === 'menu-edit-command') {
        const we = instance.exports;
        const tag = ev.label ? ` ${ev.label}` : '';
        if (we.menu_try_edit_command) {
          const ret = we.menu_try_edit_command(ev.id >>> 0) >>> 0;
          logs.push(`[input] menu-edit-command${tag}: id=${ev.id >>> 0} ret=${ret} at batch ${batch}`);
        } else {
          logs.push(`[input] menu-edit-command${tag}: id=${ev.id >>> 0} NO MENU API at batch ${batch}`);
        }
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
      } else if (ev.action === 'open-dlg-filter') {
        const we = instance.exports;
        let dlg = 0;
        for (let s = 0; s < 256; s++) {
          const h = we.wnd_slot_hwnd(s);
          if (h && we.ctrl_get_class(h) === 12) { dlg = h; break; }
        }
        if (!dlg) {
          logs.push(`[input] open-dlg-filter: no class-12 dialog at batch ${batch}`);
        } else {
          let combo = 0;
          let s = 0;
          while ((s = we.wnd_next_child_slot(dlg, s)) !== -1) {
            const h = we.wnd_slot_hwnd(s);
            if (we.ctrl_get_class(h) === 5 && we.ctrl_get_id(h) === 0x445) { combo = h; break; }
            s++;
          }
          if (!combo) {
            logs.push(`[input] open-dlg-filter: no filter combo at batch ${batch}`);
          } else {
            const oneBased = ev.index | 0;
            const zeroBased = Math.max(0, oneBased - 1);
            const ret = we.send_message(combo, 0x014E, zeroBased, 0); // CB_SETCURSEL
            const cur = we.send_message(combo, 0x0147, 0, 0) | 0; // CB_GETCURSEL
            let text = '';
            if (we.combobox_get_text && we.guest_alloc) {
              const buf = we.guest_alloc(256);
              const len = we.combobox_get_text(combo, buf, 256);
              const wa = g2w(buf);
              const bytes = new Uint8Array(memory.buffer, wa, Math.max(0, len));
              text = Buffer.from(bytes).toString('latin1');
            }
            logs.push(`[input] open-dlg-filter: requested=${oneBased} ret=${ret} selected=${cur + 1} text=${JSON.stringify(text)} at batch ${batch}`);
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
      } else if (ev.action === 'dlg-cmd') {
        const we = instance.exports;
        let dlg = 0;
        if (renderer) {
          const wins = Object.values(renderer.windows || {})
            .filter(w => w && w.visible && w.isDialog)
            .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
          if (wins.length) dlg = wins[0].hwnd | 0;
        }
        if (!dlg && we.wnd_slot_hwnd && we.dlg_get_style) {
          for (let s = 255; s >= 0; s--) {
            const hwnd = we.wnd_slot_hwnd(s);
            if (hwnd && we.dlg_get_style(hwnd)) { dlg = hwnd; break; }
          }
        }
        // A property sheet's active page is itself a visible dialog and may
        // have a higher z-order than the sheet frame. WM_COMMAND IDOK/IDCANCEL
        // belongs to the outer dialog, so climb through dialog parents before
        // injecting the command.
        if (dlg && we.wnd_get_parent) {
          for (let guard = 0; guard < 16; guard++) {
            const parent = we.wnd_get_parent(dlg) | 0;
            const parentWin = parent && renderer && renderer.windows
              ? renderer.windows[parent]
              : null;
            if (!parent || !parentWin || !parentWin.isDialog) break;
            dlg = parent;
          }
        }
        if (dlg) {
          we.send_message(dlg, 0x0111, ev.cmdId, 0);
          logs.push(`[input] dlg-cmd: cmd=${ev.cmdId} hwnd=0x${dlg.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] dlg-cmd: cmd=${ev.cmdId} NO DIALOG at batch ${batch}`);
        }
      } else if (ev.action === 'dlg-click') {
        const we = instance.exports;
        let dlg = 0;
        if (renderer) {
          const wins = Object.values(renderer.windows || {})
            .filter(w => w && w.visible && w.isDialog)
            .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
          if (wins.length) dlg = wins[0].hwnd | 0;
        }
        if (!dlg && we.wnd_slot_hwnd && we.dlg_get_style) {
          for (let s = 255; s >= 0; s--) {
            const hwnd = we.wnd_slot_hwnd(s);
            if (hwnd && we.dlg_get_style(hwnd)) { dlg = hwnd; break; }
          }
        }
        let found = 0;
        if (dlg && we.wnd_next_child_slot && we.wnd_slot_hwnd && we.ctrl_get_id) {
          const seen = new Set();
          const findChildById = (parent) => {
            if (!parent || seen.has(parent)) return 0;
            seen.add(parent);
            let s = 0;
            while ((s = we.wnd_next_child_slot(parent, s)) !== -1) {
              const ch = we.wnd_slot_hwnd(s);
              if (ch && we.ctrl_get_id(ch) === ev.ctrlId) return ch;
              const nested = findChildById(ch);
              if (nested) return nested;
              s++;
            }
            return 0;
          };
          found = findChildById(dlg);
          if (!found && renderer) {
            const wins = Object.values(renderer.windows || {})
              .filter(w => w && w.visible && w.isDialog)
              .sort((a, b) => {
                const area = (a.w * a.h) - (b.w * b.h);
                return area || ((b.zOrder || 0) - (a.zOrder || 0));
              });
            for (const w of wins) {
              found = findChildById(w.hwnd | 0);
              if (found) break;
            }
          }
        }
        if (found) {
          we.send_message(found, 0x0201, 0, 0);
          const watModalHwnd = renderer && renderer._modalDialogHwnd
            ? (renderer._modalDialogHwnd(renderer.wasm || instance) | 0)
            : 0;
          if (renderer && !watModalHwnd) {
            renderer.inputQueue.push({ type: 'mouse', hwnd: found, msg: 0x0202, wParam: 0, lParam: 0 });
            if (renderer._wakeMessageWait) renderer._wakeMessageWait();
          } else {
            we.send_message(found, 0x0202, 0, 0);
          }
          logs.push(`[input] dlg-click: id=${ev.ctrlId} hwnd=0x${found.toString(16)} dlg=0x${dlg.toString(16)} at batch ${batch}`);
        } else if (dlg) {
          logs.push(`[input] dlg-click: id=${ev.ctrlId} NOT FOUND dlg=0x${dlg.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] dlg-click: id=${ev.ctrlId} NO DIALOG at batch ${batch}`);
        }
      } else if (ev.action === 'ctrl-click') {
        const we = instance.exports;
        const seen = new Set();
        const findChildById = (parent) => {
          if (!parent || seen.has(parent) || !we.wnd_next_child_slot || !we.wnd_slot_hwnd || !we.ctrl_get_id) return 0;
          seen.add(parent);
          let s = 0;
          while ((s = we.wnd_next_child_slot(parent, s)) !== -1) {
            const ch = we.wnd_slot_hwnd(s);
            if (ch && we.ctrl_get_id(ch) === ev.ctrlId) return ch;
            const nested = findChildById(ch);
            if (nested) return nested;
            s++;
          }
          return 0;
        };
        let found = 0;
        if (renderer) {
          const wins = Object.values(renderer.windows || {})
            .filter(w => w && w.visible)
            .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
          for (const w of wins) {
            found = findChildById(w.hwnd | 0);
            if (found) break;
          }
        }
        if (!found && we.wnd_slot_hwnd) {
          for (let s = 255; s >= 0; s--) {
            const hwnd = we.wnd_slot_hwnd(s);
            if (!hwnd) continue;
            if (we.ctrl_get_id && we.ctrl_get_id(hwnd) === ev.ctrlId) {
              found = hwnd;
              break;
            }
          }
        }
        if (found) {
          const parent = we.wnd_get_parent ? (we.wnd_get_parent(found) >>> 0) : 0;
          const wh = we.ctrl_get_wh ? (we.ctrl_get_wh(found) >>> 0) : 0;
          let routeNote = '';
          if (parent && we.dialog_route_mouse_screen &&
              we.wnd_mouse_msg_origin_x && we.wnd_mouse_msg_origin_y) {
            const sx = (we.wnd_mouse_msg_origin_x(found) | 0) + ((wh & 0xffff) >> 1);
            const sy = (we.wnd_mouse_msg_origin_y(found) | 0) + ((wh >>> 16) >> 1);
            let down = we.dialog_route_mouse_screen(parent, 0x0201, 1, sx, sy) | 0;
            const routedDown = down !== 0;
            if (!routedDown) {
              // Some legacy controls are visible while their private layout
              // parent remains WS_VISIBLE-clear (WinHelp's MS_WINICON strip).
              // Route those through the control's real subclass procedure.
              we.send_message(found, 0x0201, 1, 0);
              down = 1;
            }
            // Finish through the same router so its captured-button state is
            // consumed and subclassed common-control buttons chain correctly.
            let up;
            if (routedDown) {
              up = we.dialog_route_mouse_screen(parent, 0x0202, 0, sx, sy) | 0;
            } else {
              we.send_message(found, 0x0202, 0, 0);
              up = 1;
            }
            routeNote = ` route=${down}/${up}@${sx},${sy}`;
          } else {
            // WM_LBUTTONDOWN carries MK_LBUTTON while the button is held.
            we.send_message(found, 0x0201, 1, 0);
            we.send_message(found, 0x0202, 0, 0);
          }
          logs.push(`[input] ctrl-click: id=${ev.ctrlId} hwnd=0x${found.toString(16)}${routeNote} at batch ${batch}`);
        } else {
          logs.push(`[input] ctrl-click: id=${ev.ctrlId} NOT FOUND at batch ${batch}`);
        }
      } else if (ev.action === 'ctrl-cmd') {
        const we = instance.exports;
        const seen = new Set();
        const findChildById = (parent) => {
          if (!parent || seen.has(parent) || !we.wnd_next_child_slot || !we.wnd_slot_hwnd || !we.ctrl_get_id) return 0;
          seen.add(parent);
          let s = 0;
          while ((s = we.wnd_next_child_slot(parent, s)) !== -1) {
            const ch = we.wnd_slot_hwnd(s);
            if (ch && we.ctrl_get_id(ch) === ev.ctrlId) return ch;
            const nested = findChildById(ch);
            if (nested) return nested;
            s++;
          }
          return 0;
        };
        let found = 0;
        if (renderer) {
          const wins = Object.values(renderer.windows || {})
            .filter(w => w && w.visible)
            .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
          for (const w of wins) {
            found = findChildById(w.hwnd | 0);
            if (found) break;
          }
        }
        if (!found && we.wnd_slot_hwnd) {
          for (let s = 255; s >= 0; s--) {
            const hwnd = we.wnd_slot_hwnd(s);
            if (!hwnd) continue;
            if (we.ctrl_get_id && we.ctrl_get_id(hwnd) === ev.ctrlId) {
              found = hwnd;
              break;
            }
          }
        }
        if (found) {
          const parent = we.wnd_get_parent ? (we.wnd_get_parent(found) >>> 0) : 0;
          const target = parent || found;
          we.send_message(target, 0x0111, ev.ctrlId & 0xffff, found);
          let top = 0;
          try { top = we.wnd_top_level ? (we.wnd_top_level(found) >>> 0) : 0; } catch (_) { top = 0; }
          if (top && top !== target) we.send_message(top, 0x0111, ev.ctrlId & 0xffff, found);
          logs.push(`[input] ctrl-cmd: id=${ev.ctrlId} hwnd=0x${found.toString(16)} target=0x${target.toString(16)} top=0x${top.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] ctrl-cmd: id=${ev.ctrlId} NOT FOUND at batch ${batch}`);
        }
      } else if (ev.action === 'dlg-send') {
        const we = instance.exports;
        let dlg = 0;
        if (renderer) {
          const wins = Object.values(renderer.windows || {})
            .filter(w => w && w.visible && w.isDialog)
            .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
          if (wins.length) dlg = wins[0].hwnd | 0;
        }
        if (!dlg && we.wnd_slot_hwnd && we.dlg_get_style) {
          for (let s = 255; s >= 0; s--) {
            const hwnd = we.wnd_slot_hwnd(s);
            if (hwnd && we.dlg_get_style(hwnd)) { dlg = hwnd; break; }
          }
        }
        let found = 0;
        if (dlg && we.wnd_next_child_slot && we.wnd_slot_hwnd && we.ctrl_get_id) {
          const seen = new Set();
          const findChildById = (parent) => {
            if (!parent || seen.has(parent)) return 0;
            seen.add(parent);
            let s = 0;
            while ((s = we.wnd_next_child_slot(parent, s)) !== -1) {
              const ch = we.wnd_slot_hwnd(s);
              if (ch && we.ctrl_get_id(ch) === ev.ctrlId) return ch;
              const nested = findChildById(ch);
              if (nested) return nested;
              s++;
            }
            return 0;
          };
          found = findChildById(dlg);
          if (!found && renderer) {
            const wins = Object.values(renderer.windows || {})
              .filter(w => w && w.visible && w.isDialog)
              .sort((a, b) => {
                const area = (a.w * a.h) - (b.w * b.h);
                return area || ((b.zOrder || 0) - (a.zOrder || 0));
              });
            for (const w of wins) {
              found = findChildById(w.hwnd | 0);
              if (found) break;
            }
          }
        }
        if (found) {
          const ret = we.send_message(found, ev.msg, ev.wParam, ev.lParam) | 0;
          const firstVisible = we.send_message(found, 0x00CE, 0, 0) | 0; // EM_GETFIRSTVISIBLELINE
          logs.push(`[input] dlg-send: id=${ev.ctrlId} hwnd=0x${found.toString(16)} msg=0x${ev.msg.toString(16)} ret=${ret} firstVisible=${firstVisible} at batch ${batch}`);
        } else if (dlg) {
          logs.push(`[input] dlg-send: id=${ev.ctrlId} NOT FOUND dlg=0x${dlg.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] dlg-send: id=${ev.ctrlId} NO DIALOG at batch ${batch}`);
        }
      } else if (ev.action === 'dlg-set-edit') {
        const we = instance.exports;
        let dlg = 0;
        if (renderer) {
          const wins = Object.values(renderer.windows || {})
            .filter(w => w && w.visible && w.isDialog)
            .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
          if (wins.length) dlg = wins[0].hwnd | 0;
        }
        if (!dlg && we.wnd_slot_hwnd && we.dlg_get_style) {
          for (let s = 255; s >= 0; s--) {
            const hwnd = we.wnd_slot_hwnd(s);
            if (hwnd && we.dlg_get_style(hwnd)) { dlg = hwnd; break; }
          }
        }
        let edit = 0;
        if (dlg && we.wnd_next_child_slot && we.wnd_slot_hwnd && we.ctrl_get_id && we.ctrl_get_class) {
          let s = 0;
          while ((s = we.wnd_next_child_slot(dlg, s)) !== -1) {
            const ch = we.wnd_slot_hwnd(s);
            if (ch && we.ctrl_get_id(ch) === ev.ctrlId && we.ctrl_get_class(ch) === 2) { edit = ch; break; }
            s++;
          }
        }
        if (edit) {
          const text = String(ev.text);
          const g = we.guest_alloc(text.length + 1);
          const wa = g2w(g);
          const u8 = new Uint8Array(memory.buffer);
          for (let i = 0; i < text.length; i++) u8[wa + i] = text.charCodeAt(i);
          u8[wa + text.length] = 0;
          we.send_message(edit, 0x000C, 0, g); // WM_SETTEXT
          logs.push(`[input] dlg-set-edit: id=${ev.ctrlId} text="${text}" edit=0x${edit.toString(16)} dlg=0x${dlg.toString(16)} at batch ${batch}`);
        } else if (dlg) {
          logs.push(`[input] dlg-set-edit: id=${ev.ctrlId} NOT FOUND dlg=0x${dlg.toString(16)} at batch ${batch}`);
        } else {
          logs.push(`[input] dlg-set-edit: id=${ev.ctrlId} NO DIALOG at batch ${batch}`);
        }
      } else if (ev.action === 'dlg-dump') {
        const we = instance.exports;
        let dlg = 0;
        if (renderer) {
          const wins = Object.values(renderer.windows || {})
            .filter(w => w && w.visible && w.isDialog)
            .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
          if (wins.length) dlg = wins[0].hwnd | 0;
        }
        if (!dlg && we.wnd_slot_hwnd && we.dlg_get_style) {
          for (let s = 255; s >= 0; s--) {
            const hwnd = we.wnd_slot_hwnd(s);
            if (hwnd && we.dlg_get_style(hwnd)) { dlg = hwnd; break; }
          }
        }
        const dumpDialog = (targetDlg) => {
          const controls = [];
          if (!targetDlg || !we.wnd_next_child_slot || !we.wnd_slot_hwnd) return controls;
          let s = 0;
          while ((s = we.wnd_next_child_slot(targetDlg, s)) !== -1) {
            const ch = we.wnd_slot_hwnd(s);
            const cls = we.ctrl_get_class ? we.ctrl_get_class(ch) : -1;
            const id = we.ctrl_get_id ? we.ctrl_get_id(ch) : -1;
            const xy = we.ctrl_get_xy ? we.ctrl_get_xy(ch) : 0;
            const wh = we.ctrl_get_wh ? we.ctrl_get_wh(ch) : 0;
            const style = we.wnd_get_style_export ? we.wnd_get_style_export(ch) >>> 0 : 0;
            const sx = we.wnd_window_screen_x ? we.wnd_window_screen_x(ch) | 0 : 0;
            const sy = we.wnd_window_screen_y ? we.wnd_window_screen_y(ch) | 0 : 0;
            let text = '';
            if (cls === 1 && we.button_get_text && we.guest_alloc) {
              const buf = we.guest_alloc(256);
              const len = we.button_get_text(ch, buf, 256);
              const wa = g2w(buf);
              const bytes = new Uint8Array(memory.buffer, wa, Math.max(0, len));
              text = ' text="' + Buffer.from(bytes).toString('latin1') + '"';
            } else if (cls === 3 && we.static_get_text && we.guest_alloc) {
              const buf = we.guest_alloc(256);
              const len = we.static_get_text(ch, buf, 256);
              const wa = g2w(buf);
              const bytes = new Uint8Array(memory.buffer, wa, Math.max(0, len));
              text = ' text="' + Buffer.from(bytes).toString('latin1') + '"';
              if (we.static_get_image_ordinal) {
                const ordinal = we.static_get_image_ordinal(ch) | 0;
                if (ordinal) text += ` imageOrd=${ordinal}`;
              }
            } else if (cls === 5 && we.combobox_get_text && we.guest_alloc) {
              const buf = we.guest_alloc(256);
              const len = we.combobox_get_text(ch, buf, 256);
              const wa = g2w(buf);
              const bytes = new Uint8Array(memory.buffer, wa, Math.max(0, len));
              const cur = we.combobox_get_cur_sel ? we.combobox_get_cur_sel(ch) : -1;
              text = ' sel=' + cur + ' text="' + Buffer.from(bytes).toString('latin1') + '"';
            } else if (cls === 4 && we.listbox_get_count &&
                       we.listbox_get_item_text && we.guest_alloc) {
              const count = Math.max(0, Math.min(we.listbox_get_count(ch) | 0, 64));
              const buf = we.guest_alloc(256);
              const rows = [];
              for (let row = 0; row < count; row++) {
                const len = Math.max(0, Math.min(
                  we.listbox_get_item_text(ch, row, buf, 256) | 0, 255));
                rows.push(Buffer.from(new Uint8Array(memory.buffer, g2w(buf), len)).toString('latin1'));
              }
              const cur = we.listbox_get_cur_sel ? we.listbox_get_cur_sel(ch) : -1;
              text = ' sel=' + cur + ' rows="' + rows.join(' || ') + '"';
            }
            let checked = '';
            if (cls === 1 && we.send_message) {
              checked = ` checked=${we.send_message(ch, 0x00F0, 0, 0) | 0}`;
            }
            controls.push(`hwnd=0x${ch.toString(16)} id=${id} cls=${cls} style=0x${style.toString(16)} xy=${xy & 0xffff},${xy >>> 16} wh=${wh & 0xffff},${wh >>> 16} screen=${sx},${sy}${text}${checked}`);
            s++;
          }
          return controls;
        };
        if (ev.label === 'all' && renderer) {
          const wins = Object.values(renderer.windows || {})
            .filter(w => w && w.visible && w.isDialog)
            .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
          for (const w of wins) {
            const controls = dumpDialog(w.hwnd | 0);
            logs.push(`[input] dlg-dump:all dlg=0x${(w.hwnd | 0).toString(16)} ${controls.length ? controls.join(' | ') : '(no controls)'}`);
          }
        } else {
          const controls = dumpDialog(dlg);
          const modal = we.modal_dialog_hwnd ? (we.modal_dialog_hwnd() >>> 0) : 0;
          logs.push(`[input] dlg-dump${ev.label ? ':' + ev.label : ''}: dlg=${dlg ? '0x' + dlg.toString(16) : 'none'} modal=${modal ? '0x' + modal.toString(16) : 'none'} ${controls.length ? controls.join(' | ') : '(no controls)'}`);
        }
      } else if (ev.action === 'dump-children') {
        const we = instance.exports;
        const parent = ev.hwnd >>> 0;
        const children = [];
        if (we.wnd_next_child_slot && we.wnd_slot_hwnd) {
          let slot = 0;
          for (let guard = 0; guard < 256; guard++) {
            slot = we.wnd_next_child_slot(parent, slot) | 0;
            if (slot < 0) break;
            const hwnd = we.wnd_slot_hwnd(slot) >>> 0;
            const cls = we.ctrl_get_class ? (we.ctrl_get_class(hwnd) | 0) : 0;
            const id = we.ctrl_get_id ? (we.ctrl_get_id(hwnd) | 0) : 0;
            const par = we.wnd_get_parent ? (we.wnd_get_parent(hwnd) >>> 0) : 0;
            const proc = we.wnd_get_proc_export ? (we.wnd_get_proc_export(hwnd) >>> 0) : 0;
            const style = we.wnd_get_style_export ? (we.wnd_get_style_export(hwnd) >>> 0) : 0;
            const xy = we.ctrl_get_xy ? (we.ctrl_get_xy(hwnd) >>> 0) : 0;
            const wh = we.ctrl_get_wh ? (we.ctrl_get_wh(hwnd) >>> 0) : 0;
            const buttonFlags = cls === 1 && we.button_get_flags ? (we.button_get_flags(hwnd) >>> 0) : 0;
            // A control that never appears is nearly always still owed a paint
            // it is not allowed to take: `dirty` says it is queued, and the
            // parent's `nc` bit 1 (erase) or its own `dirty` bit is what holds
            // the queue up.
            const dirty = we.paint_flag_test ? (we.paint_flag_test(hwnd) | 0) : -1;
            children.push(`slot=${slot} hwnd=0x${hwnd.toString(16)} parent=0x${par.toString(16)} proc=0x${proc.toString(16)} cls=${cls} id=${id} style=0x${style.toString(16)} buttonFlags=0x${buttonFlags.toString(16)} xy=${xy & 0xffff},${xy >>> 16} wh=${wh & 0xffff}x${wh >>> 16} dirty=${dirty}`);
            slot++;
          }
        }
        const parentNc = we.nc_flags_test ? (we.nc_flags_test(parent) >>> 0) : 0;
        const parentDirty = we.paint_flag_test ? (we.paint_flag_test(parent) | 0) : -1;
        logs.push(`[input] dump-children${ev.label ? ':' + ev.label : ''}: parent=0x${parent.toString(16)} nc=0x${parentNc.toString(16)} dirty=${parentDirty} ${children.length ? children.join(' | ') : '(none)'}`);
      } else if (ev.action === 'menu-dump') {
        const we = instance.exports;
        const hwnd = we.menu_open_hwnd ? (we.menu_open_hwnd() >>> 0) : 0;
        const top = we.menu_open_top ? (we.menu_open_top() | 0) : -1;
        const hover = we.menu_open_hover ? (we.menu_open_hover() | 0) : -1;
        const subHover = we.menu_open_sub_hover ? (we.menu_open_sub_hover() | 0) : -1;
        const x = we.menu_open_x ? (we.menu_open_x() | 0) : -1;
        const y = we.menu_open_y ? (we.menu_open_y() | 0) : -1;
        const count = hwnd && we.menu_child_count ? (we.menu_child_count(hwnd, top) | 0) : 0;
        const items = [];
        for (let i = 0; i < count; i++) {
          const id = we.menu_child_id ? (we.menu_child_id(hwnd, top, i) | 0) : 0;
          const flags = we.menu_child_flags ? (we.menu_child_flags(hwnd, top, i) | 0) : 0;
          const subCount = we.menu_child_sub_count ? (we.menu_child_sub_count(hwnd, top, i) | 0) : 0;
          const ptr = we.menu_child_label_ptr ? (we.menu_child_label_ptr(hwnd, top, i) >>> 0) : 0;
          const len = we.menu_child_label_len ? (we.menu_child_label_len(hwnd, top, i) | 0) : 0;
          let label = '';
          if (ptr && len > 0) {
            const bytes = new Uint8Array(memory.buffer, ptr, len);
            label = Buffer.from(bytes).toString('latin1');
          }
          let sub = '';
          if (subCount > 0 && we.menu_subchild_id && we.menu_subchild_label_ptr && we.menu_subchild_label_len) {
            const subItems = [];
            for (let j = 0; j < subCount; j++) {
              const sid = we.menu_subchild_id(hwnd, top, i, j) | 0;
              const sflags = we.menu_subchild_flags ? (we.menu_subchild_flags(hwnd, top, i, j) | 0) : 0;
              const sptr = we.menu_subchild_label_ptr(hwnd, top, i, j) >>> 0;
              const slen = we.menu_subchild_label_len(hwnd, top, i, j) | 0;
              let slabel = '';
              if (sptr && slen > 0) {
                const bytes = new Uint8Array(memory.buffer, sptr, slen);
                slabel = Buffer.from(bytes).toString('latin1');
              }
              subItems.push(`${j}:${sid}:"${slabel}"${sflags ? `:flags=0x${sflags.toString(16)}` : ''}`);
            }
            sub = ` sub=[${subItems.join(',')}]`;
          }
          items.push(`#${i} id=${id} flags=0x${flags.toString(16)} "${label}"${sub}`);
        }
        logs.push(`[input] menu-dump${ev.label ? ':' + ev.label : ''}: hwnd=${hwnd ? '0x' + hwnd.toString(16) : 'none'} top=${top} hover=${hover} subhover=${subHover} xy=${x},${y} count=${count} ${items.join(' | ') || '(no items)'}`);
      } else if (ev.action === 'dlg-paint') {
        const we = instance.exports;
        let dlg = 0;
        if (renderer) {
          const wins = Object.values(renderer.windows || {})
            .filter(w => w && w.visible && w.isDialog)
            .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
          if (wins.length) dlg = wins[0].hwnd | 0;
        }
        let painted = 0;
        if (dlg && we.send_message) {
          we.send_message(dlg, 0x000F, 0, 0);
          painted++;
          if (we.wnd_next_child_slot && we.wnd_slot_hwnd) {
            let s = 0;
            while ((s = we.wnd_next_child_slot(dlg, s)) !== -1) {
              const ch = we.wnd_slot_hwnd(s);
              we.send_message(ch, 0x000F, 0, 0);
              painted++;
              s++;
            }
          }
        }
        if (renderer && renderer.flushRepaint) renderer.flushRepaint(true);
        logs.push(`[input] dlg-paint painted=${painted} dlg=${dlg ? '0x' + dlg.toString(16) : 'none'} at batch ${batch}`);
      } else if (ev.action === 'dlg-png' && renderer) {
        try {
          const wins = Object.values(renderer.windows || {})
            .filter(w => w && w.visible && w.isDialog)
            .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
          const dlgWin = wins[0] || null;
          const canvas = dlgWin && dlgWin._backCanvas;
          if (!canvas) throw new Error('no dialog back-canvas');
          const buf = canvasToPng(canvas);
          fs.writeFileSync(ev.path, buf);
          logs.push(`[input] dlg-png ${ev.path} (${buf.length} bytes) hwnd=0x${(dlgWin.hwnd | 0).toString(16)} at batch ${batch}`);
        } catch (e) {
          logs.push(`[input] dlg-png FAILED ${ev.path}: ${e.message} at batch ${batch}`);
        }
      } else if (ev.action === 'dump-msgq') {
        // What is actually waiting in the posted-message queue. The queue is
        // WAT-private memory below GUEST_BASE, so --dump cannot show it.
        const we = instance.exports;
        const label = ev.label ? ':' + ev.label : '';
        const depth = we.post_queue_depth ? (we.post_queue_depth() | 0) : -1;
        const rows = [];
        for (let i = 0; i < depth; i++) {
          const f = n => (we.post_queue_peek(i, n) >>> 0);
          rows.push(`[${i}] hwnd=0x${f(0).toString(16)} msg=0x${f(1).toString(16)}` +
            ` wp=0x${f(2).toString(16)} lp=0x${f(3).toString(16)}`);
        }
        logs.push(`[input] dump-msgq${label}: depth=${depth} ${rows.join(' | ')} at batch ${batch}`);
      } else if (ev.action === 'dump-windows' && renderer) {
        const label = ev.label ? ':' + ev.label : '';
        const we = instance.exports;
        const entries = Object.entries(renderer.windows || {})
          .sort((a, b) => (parseInt(a[0], 10) || 0) - (parseInt(b[0], 10) || 0));
        if (!entries.length) {
          logs.push(`[input] dump-windows${label}: (none) at batch ${batch}`);
        }
        for (const [hwndStr, win] of entries) {
          if (!win) continue;
          const hwnd = parseInt(hwndStr, 10) || 0;
          let ctrlClass = -1;
          let ctrlId = -1;
          let style = 0;
          let owner = 0;
          let wndProc = 0;
          let dialogProc = 0;
          try {
            if (we && we.ctrl_get_class) ctrlClass = we.ctrl_get_class(hwnd) | 0;
            if (we && we.ctrl_get_id) ctrlId = we.ctrl_get_id(hwnd) | 0;
            if (we && we.wnd_get_style_export) style = we.wnd_get_style_export(hwnd) >>> 0;
            if (we && we.wnd_get_owner) owner = we.wnd_get_owner(hwnd) >>> 0;
            if (we && we.wnd_get_proc_export) wndProc = we.wnd_get_proc_export(hwnd) >>> 0;
            if (we && we.dialog_get_proc_export) dialogProc = we.dialog_get_proc_export(hwnd) >>> 0;
          } catch (_) {}
          if (!style) style = win.style >>> 0;
          const parent = win.parentHwnd ? `0x${(win.parentHwnd >>> 0).toString(16)}` : '0x0';
          const enabled = (style & 0x08000000) === 0;
          // Whether this window shows a menu bar. Anything driving an app
          // through WM_COMMAND needs it: a window with no menu has no menu
          // commands, so "I posted a command and nothing happened" says
          // nothing about the app. The renderer already decides this to lay
          // the window out, so ask it rather than guessing from the style.
          let menuBar = false;
          try { if (renderer._hasMenuBar) menuBar = !!renderer._hasMenuBar(win); } catch (_) {}
          logs.push(`[input] window${label} hwnd=${hwndStr} class=${JSON.stringify(win.className || '')} ctrlClass=${ctrlClass} ctrlId=${ctrlId} parent=${parent} owner=0x${owner.toString(16)} wndProc=0x${wndProc.toString(16)} dialogProc=0x${dialogProc.toString(16)} z=${win.zOrder || 0} pos=${win.x},${win.y} size=${win.w}x${win.h} client=${JSON.stringify(win.clientRect)} visible=${win.visible} minimized=${!!win._minimized} enabled=${enabled} style=0x${style.toString(16)} dialog=${!!win.isDialog} menuBar=${menuBar} hasBack=${!!win._backCanvas} title=${JSON.stringify(win.title)} at batch ${batch}`);
        }
      } else if (ev.action === 'dump-tree') {
        const label = ev.label ? ':' + ev.label : '';
        const we = instance.exports;
        const dv = new DataView(memory.buffer);
        const u8 = new Uint8Array(memory.buffer);
        const items = [];
        const table = 0x07F00000;
        for (let i = 0; i < 32; i++) {
          const p = table + i * 32;
          const handle = dv.getUint32(p, true);
          if (!handle) continue;
          const parent = dv.getUint32(p + 4, true);
          const child = dv.getUint32(p + 8, true);
          const next = dv.getUint32(p + 12, true);
          const state = dv.getUint32(p + 20, true);
          const itemParam = dv.getUint32(p + 24, true);
          const textG = dv.getUint32(p + 28, true);
          let itemText = '';
          if (textG) {
            let q = g2w(textG);
            const bytes = [];
            while (q < u8.length && bytes.length < 255 && u8[q]) bytes.push(u8[q++]);
            itemText = Buffer.from(bytes).toString('latin1');
          }
          items.push(`#${i} h=0x${handle.toString(16)} parent=0x${parent.toString(16)} child=0x${child.toString(16)} next=0x${next.toString(16)} state=0x${state.toString(16)} lParam=0x${itemParam.toString(16)} text=${JSON.stringify(itemText)}`);
        }
        const visible = we.treeview_get_visible_count ? (we.treeview_get_visible_count() | 0) : -1;
        const firstRow = we.treeview_get_first_visible_row ? (we.treeview_get_first_visible_row() | 0) : -1;
        const paintVisible = we.treeview_get_debug_paint_visible ? (we.treeview_get_debug_paint_visible() | 0) : -1;
        const paintText = we.treeview_get_debug_paint_text ? (we.treeview_get_debug_paint_text() | 0) : -1;
        const paintIterations = we.treeview_get_debug_paint_iterations ? (we.treeview_get_debug_paint_iterations() | 0) : -1;
        const paintLastY = we.treeview_get_debug_paint_last_y ? (we.treeview_get_debug_paint_last_y() | 0) : -1;
        const paintRows = we.treeview_get_debug_paint_rows ? (we.treeview_get_debug_paint_rows() | 0) : -1;
        logs.push(`[input] dump-tree${label}: visible=${visible} firstRow=${firstRow} paintIterations=${paintIterations} paintVisible=${paintVisible} paintText=${paintText} paintRows=${paintRows} paintLastY=${paintLastY} ${items.join(' | ') || '(empty)'} at batch ${batch}`);
      } else if (ev.action === 'dump-listbox' && renderer) {
        const label = ev.label ? ':' + ev.label : '';
        const we = instance.exports;
        const entries = Object.entries(renderer.windows || {})
          .sort((a, b) => (parseInt(a[0], 10) || 0) - (parseInt(b[0], 10) || 0));
        let found = 0;
        for (const [hwndStr, win] of entries) {
          if (!win) continue;
          const hwnd = parseInt(hwndStr, 10) || 0;
          const ctrlClass = we.ctrl_get_class ? (we.ctrl_get_class(hwnd) | 0) : -1;
          if (ctrlClass !== 4 || !we.listbox_get_count || !we.listbox_get_item_text || !we.guest_alloc) continue;
          found++;
          const count = Math.max(0, Math.min(we.listbox_get_count(hwnd) | 0, 128));
          const selection = we.listbox_get_cur_sel ? (we.listbox_get_cur_sel(hwnd) | 0) : -1;
          const selected = [];
          if (we.listbox_get_sel) {
            for (let row = 0; row < count; row++) {
              if (we.listbox_get_sel(hwnd, row) | 0) selected.push(row);
            }
          }
          const buffer = we.guest_alloc(512);
          const rows = [];
          for (let row = 0; row < count; row++) {
            const length = Math.max(0, Math.min(we.listbox_get_item_text(hwnd, row, buffer, 512) | 0, 511));
            rows.push(`#${row} ${JSON.stringify(readStr(g2w(buffer), length))}`);
          }
          logs.push(`[input] dump-listbox${label}: hwnd=${hwndStr} count=${count} selection=${selection} selected=${selected.join(',')} ${rows.join(' ; ') || '(empty)'} at batch ${batch}`);
        }
        if (!found) logs.push(`[input] dump-listbox${label}: (none) at batch ${batch}`);
      } else if (ev.action === 'listbox-setsel' && renderer) {
        const we = instance.exports;
        let found = 0;
        for (const hwndStr of Object.keys(renderer.windows || {})) {
          const hwnd = parseInt(hwndStr, 10) || 0;
          if (we.ctrl_get_class && (we.ctrl_get_class(hwnd) | 0) === 4) {
            found = hwnd;
            break;
          }
        }
        const result = found && we.send_message
          ? (we.send_message(found, 0x0185, ev.selected ? 1 : 0, ev.index) | 0)
          : -1;
        logs.push(`[input] listbox-setsel index=${ev.index} selected=${ev.selected} hwnd=0x${found.toString(16)} result=${result} at batch ${batch}`);
      } else if (ev.action === 'dump-listview' && renderer) {
        const label = ev.label ? ':' + ev.label : '';
        const we = instance.exports;
        const entries = Object.entries(renderer.windows || {})
          .sort((a, b) => (parseInt(a[0], 10) || 0) - (parseInt(b[0], 10) || 0));
        let found = 0;
        for (const [hwndStr, win] of entries) {
          if (!win) continue;
          const hwnd = parseInt(hwndStr, 10) || 0;
          const ctrlClass = we.ctrl_get_class ? (we.ctrl_get_class(hwnd) | 0) : -1;
          if (ctrlClass !== 18 || !we.listview_get_count || !we.listview_get_item_text || !we.guest_alloc) continue;
          found++;
          const count = Math.max(0, Math.min(we.listview_get_count(hwnd) | 0, 64));
          const columns = Math.max(1, Math.min(we.listview_get_column_count ? (we.listview_get_column_count(hwnd) | 0) : 1, 8));
          const buffer = we.guest_alloc(512);
          const cells = [];
          for (let row = 0; row < count; row++) {
            const values = [];
            for (let column = 0; column < columns; column++) {
              const length = Math.max(0, Math.min(we.listview_get_item_text(hwnd, row, column, buffer, 512) | 0, 511));
              values.push(readStr(g2w(buffer), length));
            }
            cells.push(`#${row} ${values.map(value => JSON.stringify(value)).join(' | ')}`);
          }
          logs.push(`[input] dump-listview${label}: hwnd=${hwndStr} count=${count} columns=${columns} ${cells.join(' ; ') || '(empty)'} at batch ${batch}`);
        }
        if (!found) logs.push(`[input] dump-listview${label}: (none) at batch ${batch}`);
      } else if (ev.action === 'dump-toolbar' && renderer) {
        const label = ev.label ? ':' + ev.label : '';
        const we = instance.exports;
        const entries = Object.entries(renderer.windows || {})
          .sort((a, b) => (parseInt(a[0], 10) || 0) - (parseInt(b[0], 10) || 0));
        const dv = new DataView(memory.buffer);
        const u8 = new Uint8Array(memory.buffer);
        let found = 0;
        for (const [hwndStr, win] of entries) {
          if (!win) continue;
          const hwnd = parseInt(hwndStr, 10) || 0;
          let ctrlClass = -1;
          let ctrlId = -1;
          try {
            if (we && we.ctrl_get_class) ctrlClass = we.ctrl_get_class(hwnd) | 0;
            if (we && we.ctrl_get_id) ctrlId = we.ctrl_get_id(hwnd) | 0;
          } catch (_) {}
          if (ctrlClass !== 21 || !we || !we.send_message || !we.guest_alloc) continue;
          found++;
          const count = we.send_message(hwnd, 0x0418, 0, 0) | 0; // TB_BUTTONCOUNT
          const recG = we.guest_alloc(20);
          const rectG = we.guest_alloc(16);
          const recP = g2w(recG);
          const rectP = g2w(rectG);
          const max = Math.max(0, Math.min(count, 64));
          const items = [];
          for (let i = 0; i < max; i++) {
            u8.fill(0, recP, recP + 20);
            u8.fill(0, rectP, rectP + 16);
            const okBtn = we.send_message(hwnd, 0x0417, i, recG) | 0; // TB_GETBUTTON
            const okRect = we.send_message(hwnd, 0x041D, i, rectG) | 0; // TB_GETITEMRECT
            const img = dv.getInt32(recP + 0, true);
            const cmd = dv.getInt32(recP + 4, true);
            const state = u8[recP + 8] | 0;
            const style = u8[recP + 9] | 0;
            const left = dv.getInt32(rectP + 0, true);
            const top = dv.getInt32(rectP + 4, true);
            const right = dv.getInt32(rectP + 8, true);
            const bottom = dv.getInt32(rectP + 12, true);
            items.push(`#${i} ok=${okBtn}/${okRect} img=${img} cmd=${cmd} state=0x${state.toString(16)} style=0x${style.toString(16)} rect=${left},${top},${right},${bottom}`);
          }
          const extra = count > max ? ` ... +${count - max} more` : '';
          logs.push(`[input] toolbar${label}: hwnd=0x${hwnd.toString(16)} ctrlId=${ctrlId} title=${JSON.stringify(win.title || '')} count=${count} ${items.join(' | ')}${extra} at batch ${batch}`);
        }
        if (!found) {
          logs.push(`[input] toolbar${label}: (none) at batch ${batch}`);
        }
      } else if (ev.action === 'toolbar-click' && renderer && renderer.handleMouseDown) {
        // Click a toolbar button by its command id, wherever it currently sits.
        // Hardcoded pixel coordinates for toolbar buttons go stale silently the
        // moment a control's layout moves: the click still lands on *something*,
        // so the run stays green-looking while the button was never pressed.
        // TB_GETITEMRECT is the same source dump-toolbar reads, and clientRect
        // is already screen-space, so this stays correct across relayouts.
        const label = ev.label ? ':' + ev.label : '';
        const we = instance.exports;
        const dv = new DataView(memory.buffer);
        const u8 = new Uint8Array(memory.buffer);
        let hit = null;
        for (const [hwndStr, win] of Object.entries(renderer.windows || {})) {
          if (!win || !win.visible || hit) continue;
          const hwnd = parseInt(hwndStr, 10) || 0;
          let ctrlClass = -1;
          try { if (we && we.ctrl_get_class) ctrlClass = we.ctrl_get_class(hwnd) | 0; } catch (_) {}
          // ctrlClass 21 is a WAT-owned toolbar; when a real comctl32.dll is
          // loaded the same window is class ToolbarWindow32 with ctrlClass 0
          // and a guest wndproc. TB_GETITEMRECT answers in both cases, so match
          // on either and let send_message route it.
          const isToolbar = ctrlClass === 21 || win.className === 'ToolbarWindow32';
          if (!isToolbar || !we || !we.send_message || !we.guest_alloc) continue;
          if (typeof renderer._computeClientRect === 'function') renderer._computeClientRect(win);
          const client = win.clientRect;
          if (!client) continue;
          const count = we.send_message(hwnd, 0x0418, 0, 0) | 0; // TB_BUTTONCOUNT
          const recG = we.guest_alloc(20);
          const rectG = we.guest_alloc(16);
          const recP = g2w(recG);
          const rectP = g2w(rectG);
          for (let i = 0; i < Math.min(count, 64) && !hit; i++) {
            u8.fill(0, recP, recP + 20);
            u8.fill(0, rectP, rectP + 16);
            we.send_message(hwnd, 0x0417, i, recG); // TB_GETBUTTON
            if (dv.getInt32(recP + 4, true) !== (ev.cmd | 0)) continue;
            we.send_message(hwnd, 0x041D, i, rectG); // TB_GETITEMRECT
            hit = {
              hwnd,
              x: client.x + ((dv.getInt32(rectP + 0, true) + dv.getInt32(rectP + 8, true)) >> 1),
              y: client.y + ((dv.getInt32(rectP + 4, true) + dv.getInt32(rectP + 12, true)) >> 1),
            };
          }
        }
        if (hit) {
          renderer.handleMouseDown(hit.x, hit.y, 1);
          if (renderer.handleMouseUp) renderer.handleMouseUp(hit.x, hit.y, 1);
          logs.push(`[input] toolbar-click${label} cmd=${ev.cmd} hwnd=0x${hit.hwnd.toString(16)} at ${hit.x},${hit.y} batch ${batch}`);
        } else {
          logs.push(`[input] toolbar-click${label} cmd=${ev.cmd} NOT FOUND at batch ${batch}`);
        }
      } else if (ev.action === 'hwnd-png-pixels' && renderer && PNG) {
        try {
          const win = renderer.windows && renderer.windows[ev.hwnd];
          const canvas = win && win._backCanvas;
          if (!canvas) throw new Error(`no back-canvas for hwnd=0x${(ev.hwnd | 0).toString(16)}`);
          const w = canvas.width | 0;
          const h = canvas.height | 0;
          const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
          const png = new PNG({ width: w, height: h });
          png.data.set(data);
          const buf = PNG.sync.write(png);
          fs.writeFileSync(ev.path, buf);
          logs.push(`[input] hwnd-png-pixels ${ev.path} (${buf.length} bytes) hwnd=0x${(ev.hwnd | 0).toString(16)} at batch ${batch}`);
        } catch (e) {
          logs.push(`[input] hwnd-png-pixels FAILED ${ev.path}: ${e.message} at batch ${batch}`);
        }
      } else if (ev.action === 'wait-title-menu-open') {
        const title = ev.title || '';
        const wins = renderer ? Object.values(renderer.windows || {}) : [];
        const found = wins.find(w => w && w.visible && String(w.title || '').includes(title));
        if (found) {
          logs.push(`[input] wait-title-menu-open${ev.label ? ':' + ev.label : ''}: matched "${title}" hwnd=0x${(found.hwnd | 0).toString(16)} at batch ${batch}`);
          if (renderer && renderer.handleKeyDown && ev.vk) {
            renderer.wasm = found.wasm || renderer.wasm;
            renderer.wasmMemory = found.wasmMemory || renderer.wasmMemory;
            if (typeof renderer._ensureWatMenu === 'function') renderer._ensureWatMenu(found);
            renderer.handleKeyDown(18);
            renderer.handleKeyDown(ev.vk);
            logs.push(`[input] wait-title-menu-open${ev.label ? ':' + ev.label : ''}: Alt+${ev.vk} at batch ${batch}`);
          } else {
            logs.push(`[input] wait-title-menu-open${ev.label ? ':' + ev.label : ''}: unable to open menu at batch ${batch}`);
          }
        } else if (batch - (ev.startBatch || batch) < (ev.limit || 2000)) {
          deferScheduledWait(ev, batch, true);
        } else {
          logs.push(`[input] wait-title-menu-open${ev.label ? ':' + ev.label : ''}: TIMEOUT "${title}" at batch ${batch}`);
        }
      } else if (ev.action === 'wait-title-command') {
        const title = ev.title || '';
        const wins = renderer ? Object.values(renderer.windows || {}) : [];
        const found = wins.find(w => w && w.visible && String(w.title || '').includes(title));
        const we = found && instance && instance.exports;
        if (found && we && typeof we.post_message_q === 'function') {
          const queued = we.post_message_q(found.hwnd | 0, 0x0111, ev.command | 0, 0) | 0;
          const count = we.get_post_queue_count ? (we.get_post_queue_count() | 0) : -1;
          logs.push(`[input] wait-title-command${ev.label ? ':' + ev.label : ''}: hwnd=0x${(found.hwnd | 0).toString(16)} command=${ev.command | 0} queued=${queued} count=${count} at batch ${batch}`);
        } else if (batch - (ev.startBatch || batch) < (ev.limit || 2000)) {
          deferScheduledWait(ev, batch, true);
        } else {
          logs.push(`[input] wait-title-command${ev.label ? ':' + ev.label : ''}: TIMEOUT "${title}" at batch ${batch}`);
        }
      } else if (ev.action === 'wait-title') {
        const title = ev.title || '';
        const wins = renderer ? Object.values(renderer.windows || {}) : [];
        const found = wins.find(w => w && w.visible && String(w.title || '').includes(title));
        if (found) {
          logs.push(`[input] wait-title: matched "${title}" hwnd=0x${(found.hwnd | 0).toString(16)} at batch ${batch}`);
          if (ev.dumpStop) {
            scheduledInput.unshift({ batch, action: 'stop' });
            if (ev.path) scheduledInput.unshift({ batch, action: 'dlg-png', path: ev.path });
            scheduledInput.unshift({ batch, action: 'dlg-paint' });
            scheduledInput.unshift({ batch, action: 'dlg-dump', label: ev.label || '' });
          }
        } else if (batch - (ev.startBatch || batch) < (ev.limit || 2000)) {
          deferScheduledWait(ev, batch);
        } else {
          logs.push(`[input] wait-title: TIMEOUT "${title}" at batch ${batch}`);
        }
      } else if (ev.action === 'wait-title-windows-snapshot') {
        const title = ev.title || '';
        const wins = renderer ? Object.values(renderer.windows || {}) : [];
        const found = wins.find(w => w && w.visible && String(w.title || '').includes(title));
        if (found) {
          logs.push(`[input] wait-title: matched "${title}" hwnd=0x${(found.hwnd | 0).toString(16)} at batch ${batch}`);
          const label = ev.label ? ':' + ev.label : '';
          const entries = Object.entries(renderer.windows || {})
            .sort((a, b) => (parseInt(a[0], 10) || 0) - (parseInt(b[0], 10) || 0));
          for (const [hwndStr, win] of entries) {
            if (!win) continue;
            logs.push(`[input] window${label} hwnd=${hwndStr} pos=${win.x},${win.y} size=${win.w}x${win.h} client=${JSON.stringify(win.clientRect)} visible=${win.visible} dialog=${!!win.isDialog} hasBack=${!!win._backCanvas} title=${JSON.stringify(win.title)} at batch ${batch}`);
            if (win._backCanvas && PNG && ev.path) {
              try {
                const w = win._backCanvas.width | 0;
                const h = win._backCanvas.height | 0;
                const data = win._backCanvas.getContext('2d').getImageData(0, 0, w, h).data;
                const png = new PNG({ width: w, height: h });
                png.data.set(data);
                const buf = PNG.sync.write(png);
                const out = ev.path.replace(/\.png$/, `_back_${hwndStr}.png`);
                fs.writeFileSync(out, buf);
                logs.push(`[input] back-canvas-pixels ${out} (${buf.length} bytes, ${w}x${h}) hwnd=${hwndStr} at batch ${batch}`);
              } catch (e) {
                logs.push(`[input] back-canvas-pixels FAILED hwnd=${hwndStr}: ${e.message} at batch ${batch}`);
              }
            }
          }
          stopped = true;
          logs.push(`[input] stop at batch ${batch}`);
        } else if (batch - (ev.startBatch || batch) < (ev.limit || 2000)) {
          deferScheduledWait(ev, batch);
        } else {
          logs.push(`[input] wait-title: TIMEOUT "${title}" at batch ${batch}`);
        }
      } else if (ev.action === 'wait-title-snapshot' || ev.action === 'wait-title-dump-stop') {
        const title = ev.title || '';
        const wins = renderer ? Object.values(renderer.windows || {}) : [];
        const found = wins.find(w => w && w.visible && String(w.title || '').includes(title));
        if (found) {
          logs.push(`[input] wait-title: matched "${title}" hwnd=0x${(found.hwnd | 0).toString(16)} at batch ${batch}`);

          const we = instance.exports;
          let dlg = 0;
          if (renderer) {
            const dialogs = Object.values(renderer.windows || {})
              .filter(w => w && w.visible && w.isDialog)
              .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
            if (dialogs.length) dlg = dialogs[0].hwnd | 0;
          }
          if (!dlg && we.wnd_slot_hwnd && we.dlg_get_style) {
            for (let s = 255; s >= 0; s--) {
              const hwnd = we.wnd_slot_hwnd(s);
              if (hwnd && we.dlg_get_style(hwnd)) { dlg = hwnd; break; }
            }
          }

          const controls = [];
          if (dlg && we.wnd_next_child_slot && we.wnd_slot_hwnd) {
            let s = 0;
            while ((s = we.wnd_next_child_slot(dlg, s)) !== -1) {
              const ch = we.wnd_slot_hwnd(s);
              const cls = we.ctrl_get_class ? we.ctrl_get_class(ch) : -1;
              const id = we.ctrl_get_id ? we.ctrl_get_id(ch) : -1;
              const xy = we.ctrl_get_xy ? we.ctrl_get_xy(ch) : 0;
              const wh = we.ctrl_get_wh ? we.ctrl_get_wh(ch) : 0;
              const style = we.wnd_get_style_export ? we.wnd_get_style_export(ch) >>> 0 : 0;
              const sx = we.wnd_window_screen_x ? we.wnd_window_screen_x(ch) | 0 : 0;
              const sy = we.wnd_window_screen_y ? we.wnd_window_screen_y(ch) | 0 : 0;
              let text = '';
              if (cls === 1 && we.button_get_text && we.guest_alloc) {
                const buf = we.guest_alloc(256);
                const len = we.button_get_text(ch, buf, 256);
                const wa = g2w(buf);
                const bytes = new Uint8Array(memory.buffer, wa, Math.max(0, len));
                text = ' text="' + Buffer.from(bytes).toString('latin1') + '"';
              } else if (cls === 3 && we.static_get_text && we.guest_alloc) {
                const buf = we.guest_alloc(256);
                const len = we.static_get_text(ch, buf, 256);
                const wa = g2w(buf);
                const bytes = new Uint8Array(memory.buffer, wa, Math.max(0, len));
                text = ' text="' + Buffer.from(bytes).toString('latin1') + '"';
              } else if (cls === 5 && we.combobox_get_text && we.guest_alloc) {
                const buf = we.guest_alloc(256);
                const len = we.combobox_get_text(ch, buf, 256);
                const wa = g2w(buf);
                const bytes = new Uint8Array(memory.buffer, wa, Math.max(0, len));
                const cur = we.combobox_get_cur_sel ? we.combobox_get_cur_sel(ch) : -1;
                text = ' sel=' + cur + ' text="' + Buffer.from(bytes).toString('latin1') + '"';
              } else if (cls === 4 && we.listbox_get_count &&
                         we.listbox_get_item_text && we.guest_alloc) {
                const count = Math.max(0, Math.min(we.listbox_get_count(ch) | 0, 64));
                const buf = we.guest_alloc(256);
                const rows = [];
                for (let row = 0; row < count; row++) {
                  const len = Math.max(0, Math.min(
                    we.listbox_get_item_text(ch, row, buf, 256) | 0, 255));
                  rows.push(Buffer.from(new Uint8Array(memory.buffer, g2w(buf), len)).toString('latin1'));
                }
                const cur = we.listbox_get_cur_sel ? we.listbox_get_cur_sel(ch) : -1;
                text = ' sel=' + cur + ' rows="' + rows.join(' || ') + '"';
              }
              let checked = '';
              if (cls === 1 && we.send_message) {
                checked = ` checked=${we.send_message(ch, 0x00F0, 0, 0) | 0}`;
              }
              controls.push(`hwnd=0x${ch.toString(16)} id=${id} cls=${cls} style=0x${style.toString(16)} xy=${xy & 0xffff},${xy >>> 16} wh=${wh & 0xffff},${wh >>> 16} screen=${sx},${sy}${text}${checked}`);
              s++;
            }
          }
          const modal = we.modal_dialog_hwnd ? (we.modal_dialog_hwnd() >>> 0) : 0;
          logs.push(`[input] dlg-dump${ev.label ? ':' + ev.label : ''}: dlg=${dlg ? '0x' + dlg.toString(16) : 'none'} modal=${modal ? '0x' + modal.toString(16) : 'none'} ${controls.length ? controls.join(' | ') : '(no controls)'}`);

          if (ev.action === 'wait-title-snapshot' && renderer && renderer.canvas && PNG && ev.path) {
            try {
              const w = renderer.canvas.width | 0;
              const h = renderer.canvas.height | 0;
              const data = renderer.canvas.getContext('2d').getImageData(0, 0, w, h).data;
              const png = new PNG({ width: w, height: h });
              png.data.set(data);
              const buf = PNG.sync.write(png);
              fs.writeFileSync(ev.path, buf);
              logs.push(`[input] png-pixels ${ev.path} (${buf.length} bytes) at batch ${batch}`);
            } catch (e) {
              logs.push(`[input] png-pixels FAILED ${ev.path}: ${e.message} at batch ${batch}`);
            }
          } else if (ev.action === 'wait-title-snapshot') {
            logs.push(`[input] png-pixels FAILED ${ev.path || ''}: unavailable at batch ${batch}`);
          }

          stopped = true;
          logs.push(`[input] stop at batch ${batch}`);
        } else if (batch - (ev.startBatch || batch) < (ev.limit || 2000)) {
          deferScheduledWait(ev, batch);
        } else {
          logs.push(`[input] wait-title: TIMEOUT "${title}" at batch ${batch}`);
        }
      } else if (ev.action === 'wait-dlg-control') {
        const we = instance.exports;
        let found = 0;
        const seen = new Set();
        const findChildById = (parent) => {
          if (!parent || seen.has(parent) || !we.wnd_next_child_slot || !we.wnd_slot_hwnd || !we.ctrl_get_id) return 0;
          seen.add(parent);
          let s = 0;
          while ((s = we.wnd_next_child_slot(parent, s)) !== -1) {
            const ch = we.wnd_slot_hwnd(s);
            if (ch && we.ctrl_get_id(ch) === ev.ctrlId) return ch;
            const nested = findChildById(ch);
            if (nested) return nested;
            s++;
          }
          return 0;
        };
        if (renderer) {
          const wins = Object.values(renderer.windows || {})
            .filter(w => w && w.visible && w.isDialog)
            .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
          for (const w of wins) {
            found = findChildById(w.hwnd | 0);
            if (found) break;
          }
        }
        if (!found && we.wnd_slot_hwnd && we.dlg_get_style) {
          for (let s = 255; s >= 0; s--) {
            const hwnd = we.wnd_slot_hwnd(s);
            if (hwnd && we.dlg_get_style(hwnd)) {
              found = findChildById(hwnd);
              if (found) break;
            }
          }
        }
        if (found) {
          logs.push(`[input] wait-dlg-control: matched id=${ev.ctrlId} hwnd=0x${found.toString(16)} at batch ${batch}`);
        } else if (batch - (ev.startBatch || batch) < (ev.limit || 2000)) {
          deferScheduledWait(ev, batch);
        } else {
          logs.push(`[input] wait-dlg-control: TIMEOUT id=${ev.ctrlId} at batch ${batch}`);
        }
      } else if (ev.action === 'wait-focus-length') {
        const we = instance.exports;
        const h = we.get_focus_hwnd ? we.get_focus_hwnd() >>> 0 : 0;
        const len = h && we.send_message ? Math.max(0, we.send_message(h, 0x000E, 0, 0) | 0) : 0;
        if (len >= ev.minLength) {
          logs.push(`[input] wait-focus-length: matched len=${len} min=${ev.minLength} hwnd=0x${h.toString(16)} at batch ${batch}`);
        } else if (batch - (ev.startBatch || batch) < (ev.limit || 2000)) {
          deferScheduledWait(ev, batch);
        } else {
          logs.push(`[input] wait-focus-length: TIMEOUT len=${len} min=${ev.minLength} at batch ${batch}`);
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
            const replaceBufG = dv.getUint32(wa + 0x14, true);
            const replaceBufLen = dv.getUint16(wa + 0x1A, true);
            const findBufWa = g2w(findBufG);
            const m8 = new Uint8Array(memory.buffer);
            let txt = '';
            for (let i = 0; i < findBufLen && m8[findBufWa + i]; i++) {
              txt += String.fromCharCode(m8[findBufWa + i]);
            }
            let replacement = '';
            if (replaceBufG) {
              const replaceBufWa = g2w(replaceBufG);
              for (let i = 0; i < replaceBufLen && m8[replaceBufWa + i]; i++) {
                replacement += String.fromCharCode(m8[replaceBufWa + i]);
              }
            }
            if (!replacement && we.get_findreplace_replace_edit && we.get_edit_text && we.guest_alloc) {
              const replaceEdit = we.get_findreplace_replace_edit() | 0;
              if (replaceEdit) {
                const scratchG = we.guest_alloc(512);
                const n = we.get_edit_text(replaceEdit, scratchG, 511) | 0;
                replacement = Buffer.from(new Uint8Array(memory.buffer, g2w(scratchG), Math.max(0, n))).toString('latin1');
              }
            }
            logs.push(`[input] dump-fr: flags=0x${flags.toString(16)} findWhat=${JSON.stringify(txt)} replaceWith=${JSON.stringify(replacement)} at batch ${batch}`);
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
      } else if (ev.action === 'ime-start' && renderer && renderer.handleCompositionStart) {
        renderer.handleCompositionStart();
        logs.push(`[input] ime-start at batch ${batch}`);
      } else if (ev.action === 'ime-update' && renderer && renderer.handleCompositionUpdate) {
        renderer.handleCompositionUpdate(ev.text);
        logs.push(`[input] ime-update text=${JSON.stringify(ev.text)} at batch ${batch}`);
      } else if (ev.action === 'ime-commit' && renderer && renderer.handleCompositionEnd) {
        renderer.handleCompositionEnd(ev.text);
        logs.push(`[input] ime-commit text=${JSON.stringify(ev.text)} at batch ${batch}`);
      } else if (ev.action === 'keydown' && renderer && renderer.handleKeyDown) {
        renderer.handleKeyDown(ev.code);
        logs.push(`[input] keydown vk=${ev.code} at batch ${batch}`);
      } else if (ev.action === 'keyup' && renderer && renderer.handleKeyUp) {
        renderer.handleKeyUp(ev.code);
        logs.push(`[input] keyup vk=${ev.code} at batch ${batch}`);
      } else if ((ev.action === 'di-keydown' || ev.action === 'di-keyup') && renderer) {
        if (!renderer._asyncKeys) renderer._asyncKeys = Object.create(null);
        if (!renderer._asyncPressedKeys) renderer._asyncPressedKeys = Object.create(null);
        const key = ev.code & 0xFF;
        const down = ev.action === 'di-keydown';
        renderer._asyncKeys[key] = down;
        if (down) renderer._asyncPressedKeys[key] = true;
        logs.push(`[input] ${ev.action} vk=${ev.code} at batch ${batch}`);
      } else if (ev.action === 'sleep-ms') {
        if (ev.ms > 0) await new Promise(resolve => setTimeout(resolve, ev.ms));
        logs.push(`[input] sleep-ms ${ev.ms} at batch ${batch}`);
      } else if (ev.action === 'wave-in-feed') {
        const samples = new Float32Array(ev.frames);
        for (let i = 0; i < samples.length; i++) {
          samples[i] = Math.sin((i * Math.PI * 2 * 440) / ev.rate) * ev.amplitude;
        }
        const written = h.wave_in_feed_pcm ? h.wave_in_feed_pcm(0, [samples], ev.rate) : 0;
        logs.push(`[input] wave-in-feed frames=${ev.frames} rate=${ev.rate} written=${written} at batch ${batch}`);
      } else if (ev.action === 'mixer-peak') {
        if (h.audio_mixer_mark_peak) h.audio_mixer_mark_peak(ev.bus, ev.value, ev.holdMs);
        logs.push(`[input] mixer-peak bus=${ev.bus} value=${ev.value} hold=${ev.holdMs} at batch ${batch}`);
      } else if (ev.action === 'vfs-export') {
        try {
          const key = ctx.vfs._resolvePath(ev.filename);
          const entry = ctx.vfs.files.get(key);
          if (!entry) throw new Error(`virtual file not found: ${key}`);
          fs.mkdirSync(path.dirname(ev.path), { recursive: true });
          fs.writeFileSync(ev.path, Buffer.from(entry.data));
          logs.push(`[input] vfs-export ${key} -> ${ev.path} (${entry.data.length} bytes) at batch ${batch}`);
        } catch (e) {
          logs.push(`[input] vfs-export FAILED ${ev.filename}: ${e.message} at batch ${batch}`);
        }
      } else if (ev.action === 'help-macro') {
        // WinHelpA(hwnd, file, HELP_COMMAND, "Macro(...)") - how an
        // application runs a help macro, including one bound to a routine the
        // help file registered from its own DLL.
        const we = instance.exports;
        if (!we.test_invoke_WinHelpA || !we.guest_alloc) {
          logs.push(`[input] help-macro: build has no WinHelp entry at batch ${batch}`);
        } else {
          const writeAnsi = text => {
            const buf = Buffer.from(text, 'latin1');
            const ga = we.guest_alloc(buf.length + 1);
            new Uint8Array(memory.buffer, g2w(ga), buf.length).set(buf);
            new Uint8Array(memory.buffer, g2w(ga) + buf.length, 1)[0] = 0;
            return ga;
          };
          const status = we.test_invoke_WinHelpA(0x8888,
            writeAnsi(ev.filename), 0x0102, writeAnsi(ev.macro));
          logs.push(`[input] help-macro ${ev.filename} ${JSON.stringify(ev.macro)}` +
            ` -> accepted=${status}` +
            ` dispatch=${we.get_help_dispatch_status ? we.get_help_dispatch_status() : '?'}` +
            ` routines=${we.get_help_routine_count ? we.get_help_routine_count() : '?'}` +
            ` at batch ${batch}`);
        }
      } else if (ev.action === 'vfs-import') {
        try {
          const key = ctx.vfs._resolvePath(ev.filename);
          const data = new Uint8Array(fs.readFileSync(ev.path));
          ctx.vfs.files.set(key, { data, attrs: 0x20 });
          logs.push(`[input] vfs-import ${ev.path} -> ${key} (${data.length} bytes) at batch ${batch}`);
        } catch (e) {
          logs.push(`[input] vfs-import FAILED ${ev.path}: ${e.message} at batch ${batch}`);
        }
      } else if (ev.action === 'assert-standard-scroll') {
        const match = findStandardScrollBar(ev.axis, '');
        const floor = match && ev.minPct
          ? Math.round((ev.minPos / 100) * match.page)
          : ev.minPos;
        const pass = !!match && match.pos >= floor;
        const want = ev.minPct ? `${ev.minPos}% of page ${match ? match.page : '?'} = ${floor}` : `${floor}`;
        logs.push(`[assert] ${pass ? 'PASS' : 'FAIL'} standard-scroll${ev.label ? ':' + ev.label : ''} axis=${ev.axis} min=${want} actual=${match ? match.pos : 'none'} hwnd=${match ? '0x' + match.hwnd.toString(16) : 'none'} at batch ${batch}`);
        if (!pass) process.exitCode = 1;
      } else if (ev.action === 'dump-scrollbar') {
        const bar = findStandardScrollBar(ev.axis, ev.target);
        if (!bar) {
          logs.push(`[scrollbar]${ev.label ? ':' + ev.label : ''} axis=${ev.axis} none at batch ${batch}`);
        } else {
          const s = bar.strip;
          logs.push(`[scrollbar]${ev.label ? ':' + ev.label : ''} axis=${ev.axis} hwnd=0x${bar.hwnd.toString(16)} strip=${s.x0},${s.y0},${s.x1},${s.y1} pos=${bar.pos} page=${bar.page} min=${bar.min} max=${bar.max} at batch ${batch}`);
        }
      } else if (ev.action === 'scroll-click' && renderer && renderer.handleMouseDown) {
        const bar = findStandardScrollBar(ev.axis, ev.target);
        if (!bar) {
          logs.push(`[input] scroll-click: no ${ev.axis} scrollbar at batch ${batch}`);
        } else {
          const p = scrollBarPoint(bar, ev.part);
          renderer.handleMouseDown(p.x, p.y, 1);
          if (renderer.handleMouseUp) renderer.handleMouseUp(p.x, p.y, 1);
          logs.push(`[input] scroll-click ${ev.axis}:${ev.part} hwnd=0x${bar.hwnd.toString(16)} at ${p.x},${p.y} at batch ${batch}`);
        }
      } else if (ev.action === 'scroll-drag' && renderer && renderer.handleMouseDown) {
        const bar = findStandardScrollBar(ev.axis, ev.target);
        if (!bar) {
          logs.push(`[input] scroll-drag: no ${ev.axis} scrollbar at batch ${batch}`);
        } else {
          const p = scrollBarPoint(bar, 'thumb');
          const x1 = ev.axis === 'v' ? p.x : p.x + ev.delta;
          const y1 = ev.axis === 'v' ? p.y + ev.delta : p.y;
          renderer.handleMouseDown(p.x, p.y, 1);
          if (renderer.handleMouseMove) {
            for (const t of [0.34, 0.67, 1]) {
              renderer.handleMouseMove(
                Math.round(p.x + (x1 - p.x) * t), Math.round(p.y + (y1 - p.y) * t));
            }
          }
          if (renderer.handleMouseUp) renderer.handleMouseUp(x1, y1, 1);
          logs.push(`[input] scroll-drag ${ev.axis} hwnd=0x${bar.hwnd.toString(16)} ${p.x},${p.y} -> ${x1},${y1} at batch ${batch}`);
        }
      } else if (ev.action === 'png' && renderer && renderer.canvas) {
        try {
          if (typeof renderer.repaint === 'function') renderer.repaint();
          const buf = canvasToPng(renderer.canvas);
          fs.writeFileSync(ev.path, buf);
          logs.push(`[input] png ${ev.path} (${buf.length} bytes) at batch ${batch}`);
          if (DUMP_BACKCANVAS) {
            for (const [hwndStr, win] of Object.entries(renderer.windows)) {
              if (!win) continue;
              logs.push(`[input] window hwnd=${hwndStr} pos=${win.x},${win.y} size=${win.w}x${win.h} visible=${win.visible} dialog=${!!win.isDialog} hasBack=${!!win._backCanvas}`);
              if (win._backCanvas && win._backCanvas.toBuffer) {
                const bcPath = ev.path.replace('.png', `_back_${hwndStr}.png`);
                fs.writeFileSync(bcPath, canvasToPng(win._backCanvas));
                logs.push(`[input] back-canvas ${bcPath}`);
              }
            }
          }
        } catch (e) {
          logs.push(`[input] png FAILED ${ev.path}: ${e.message} at batch ${batch}`);
        }
      } else if (ev.action === 'png-raw' && renderer && renderer.canvas) {
        try {
          const buf = canvasToPng(renderer.canvas);
          fs.writeFileSync(ev.path, buf);
          logs.push(`[input] png-raw ${ev.path} (${buf.length} bytes) at batch ${batch}`);
        } catch (e) {
          logs.push(`[input] png-raw FAILED ${ev.path}: ${e.message} at batch ${batch}`);
        }
      } else if (ev.action === 'pixel' && renderer && renderer.canvas) {
        try {
          if (typeof renderer.repaint === 'function') renderer.repaint();
          const data = renderer.canvas.getContext('2d').getImageData(ev.x, ev.y, 1, 1).data;
          logs.push(`[input] pixel${ev.label ? ':' + ev.label : ''}: ${ev.x},${ev.y} rgba=${data[0]},${data[1]},${data[2]},${data[3]} at batch ${batch}`);
        } catch (e) {
          logs.push(`[input] pixel FAILED ${ev.x},${ev.y}: ${e.message} at batch ${batch}`);
        }
      } else if (ev.action === 'png-pixels' && renderer && renderer.canvas && PNG) {
        try {
          const w = renderer.canvas.width | 0;
          const h = renderer.canvas.height | 0;
          const data = renderer.canvas.getContext('2d').getImageData(0, 0, w, h).data;
          const png = new PNG({ width: w, height: h });
          png.data.set(data);
          const buf = PNG.sync.write(png);
          fs.writeFileSync(ev.path, buf);
          logs.push(`[input] png-pixels ${ev.path} (${buf.length} bytes) at batch ${batch}`);
        } catch (e) {
          logs.push(`[input] png-pixels FAILED ${ev.path}: ${e.message} at batch ${batch}`);
        }
      } else if (ev.action === 'stop') {
        stopped = true;
        logs.push(`[input] stop at batch ${batch}`);
      } else if (ev.action === 'canvas-resize' && renderer && renderer.canvas) {
        const oldW = renderer.canvas.width | 0;
        const oldH = renderer.canvas.height | 0;
        renderer.canvas.width = ev.w | 0;
        renderer.canvas.height = ev.h | 0;
        if (typeof renderer.handleScreenResize === 'function') {
          renderer.handleScreenResize(oldW, oldH, ev.w | 0, ev.h | 0);
        }
        if (typeof renderer.repaint === 'function') renderer.repaint();
        logs.push(`[input] canvas-resize ${oldW}x${oldH} -> ${ev.w}x${ev.h} at batch ${batch}`);
      } else if (ev.action === 'main-resize' && renderer) {
        const we = instance.exports;
        const hwnd = we.get_main_hwnd ? (we.get_main_hwnd() | 0) : 0;
        const win = hwnd ? renderer.windows[hwnd] : null;
        if (!win) {
          logs.push(`[input] main-resize FAILED: no main window at batch ${batch}`);
        } else {
          win.w = Math.max(1, ev.w | 0);
          win.h = Math.max(1, ev.h | 0);
          win._maximized = false;
          if (we.host_resize_commit) we.host_resize_commit(hwnd, win.x | 0, win.y | 0, win.w, win.h);
          if (typeof renderer._computeClientRect === 'function') renderer._computeClientRect(win);
          if (typeof renderer.invalidate === 'function') renderer.invalidate(hwnd);
          logs.push(`[input] main-resize hwnd=0x${hwnd.toString(16)} -> ${win.w}x${win.h} at batch ${batch}`);
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
        // A menu command belongs to the window showing the menu, which is not
        // always get_main_hwnd(). Pinball's menu bar is on its second
        // top-level window (0x10002); posting to the first sent every command
        // to a window whose wndproc had never heard of it, and the sweep read
        // that as two broken dialogs. Prefer a visible window with a menu bar,
        // and fall back to the main hwnd when nothing has one.
        let mainHwnd = we.get_main_hwnd();
        if (renderer && renderer.windows && renderer._hasMenuBar) {
          for (const [hs, win] of Object.entries(renderer.windows)) {
            if (!win || !win.visible || win.isChild) continue;
            let hasMenu = false;
            try { hasMenu = !!renderer._hasMenuBar(win); } catch (_) {}
            if (hasMenu) { mainHwnd = parseInt(hs, 10) || mainHwnd; break; }
          }
        }
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
      } else if (ev.action === 'call-func') {
        const we = instance.exports;
        if (we.call_func) {
          const a = ev.args || [];
          we.call_func(ev.addr >>> 0, a[0] >>> 0, a[1] >>> 0, a[2] >>> 0, a[3] >>> 0);
          logs.push(`[input] call-func 0x${(ev.addr >>> 0).toString(16)}(${a.map(v => '0x' + (v >>> 0).toString(16)).join(',')}) at batch ${batch}`);
        } else {
          logs.push(`[input] call-func unavailable addr=0x${(ev.addr >>> 0).toString(16)} at batch ${batch}`);
        }
      } else if (ev.action === 'read-dword') {
        const wa = g2w(ev.addr);
        const dv = new DataView(memory.buffer);
        const value = dv.getUint32(wa, true) >>> 0;
        logs.push(`[input] read-dword${ev.label ? ':' + ev.label : ''} [0x${(ev.addr >>> 0).toString(16)}] = 0x${value.toString(16)} (${value}) at batch ${batch}`);
      } else if (ev.action === 'corner-drag' && renderer && renderer.handleMouseDown) {
        const hwnd = parseInt(ev.target, 16) | 0;
        const win = hwnd && renderer.windows ? renderer.windows[hwnd] : null;
        if (!win) {
          logs.push(`[input] corner-drag: no window for hwnd ${ev.target} at batch ${batch}`);
        } else {
          const r = renderer._windowRectScreen(win);
          const x0 = r.x + r.w - 1, y0 = r.y + r.h - 1;
          const x1 = x0 + ev.dx, y1 = y0 + ev.dy;
          renderer.handleMouseDown(x0, y0, 1);
          if (renderer.handleMouseMove) {
            for (const t of [0.25, 0.5, 1]) {
              renderer.handleMouseMove(
                Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t));
            }
          }
          if (renderer.handleMouseUp) renderer.handleMouseUp(x1, y1, 1);
          logs.push(`[input] corner-drag hwnd=0x${hwnd.toString(16)} ${x0},${y0} -> ${x1},${y1} at batch ${batch}`);
        }
      } else if (ev.action === 'close-click' && renderer && renderer.handleMouseDown) {
        const we = instance.exports;
        let hwnd = 0;
        if (ev.target === 'find') {
          hwnd = (we.get_findreplace_dlg && we.get_findreplace_dlg()) | 0;
        } else {
          hwnd = parseInt(ev.target, 16) | 0;
        }
        const win = hwnd && renderer.windows ? renderer.windows[hwnd] : null;
        if (!win) {
          logs.push(`[input] close-click: no window for target ${ev.target} at batch ${batch}`);
        } else {
          // Same close box renderer-input.js hit-tests: 21px wide, inset 3px
          // from the right edge, spanning the caption below the 3px border.
          const r = renderer._windowRectScreen(win);
          const x = r.x + r.w - 14;
          const y = r.y + 13;
          renderer.handleMouseDown(x, y, 1);
          if (renderer.handleMouseUp) renderer.handleMouseUp(x, y, 1);
          logs.push(`[input] close-click ${ev.target} hwnd=0x${hwnd.toString(16)} at ${x},${y} at batch ${batch}`);
        }
      } else if (ev.action === 'caption-click' && renderer && renderer.handleMouseDown) {
        const hwnd = parseInt(ev.target, 16) | 0;
        const win = hwnd && renderer.windows ? renderer.windows[hwnd] : null;
        if (!win) {
          logs.push(`[input] caption-click: no window for hwnd ${ev.target} at batch ${batch}`);
        } else {
          // Win98 caption buttons are 16px wide in a row at the right end:
          // close outermost, then max, then min (same boxes close-click uses).
          const r = renderer._windowRectScreen(win);
          const slot = ev.part === 'min' ? 2 : ev.part === 'max' ? 1 : 0;
          const x = r.x + r.w - 14 - slot * 16;
          const y = r.y + 13;
          renderer.handleMouseDown(x, y, 1);
          if (renderer.handleMouseUp) renderer.handleMouseUp(x, y, 1);
          logs.push(`[input] caption-click ${ev.part} hwnd=0x${hwnd.toString(16)} at ${x},${y} at batch ${batch}`);
        }
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
        // Two consecutive clicks at the same spot. handleMouseDown's
        // built-in timing check folds the second DOWN into WM_LBUTTONDBLCLK
        // so it reaches WAT-native dialog children via dialog_route_mouse.
        renderer.handleMouseDown(ev.x, ev.y, 1);
        renderer.handleMouseUp(ev.x, ev.y, 1);
        renderer.handleMouseDown(ev.x, ev.y, 1, { doubleClick: true });
        renderer.handleMouseUp(ev.x, ev.y, 1);
        logs.push(`[input] dblclick ${ev.x},${ev.y} at batch ${batch}`);
      } else if (ev.action === 'mouseup' && renderer && renderer.handleMouseUp) {
        renderer.handleMouseUp(ev.x, ev.y, 1);
        logs.push(`[input] mouseup ${ev.x},${ev.y} at batch ${batch}`);
      } else if (ev.action === 'mousemove' && renderer && renderer.handleMouseMove) {
        if (renderer.handleMenuHover) renderer.handleMenuHover(ev.x, ev.y);
        renderer.handleMouseMove(ev.x, ev.y);
        logs.push(`[input] mousemove ${ev.x},${ev.y} at batch ${batch}`);
      } else if (ev.action === 'wheel' && renderer && renderer.handleWheel) {
        renderer.handleWheel(ev.x, ev.y, ev.delta);
        logs.push(`[input] wheel ${ev.x},${ev.y} delta=${ev.delta} at batch ${batch}`);
      } else if (renderer) {
        renderer.inputQueue.push({ type: 'key', hwnd: 0, msg: ev.msg, wParam: ev.wParam, lParam: ev.lParam });
        logs.push(`[input] injected msg=0x${ev.msg.toString(16)} wParam=0x${ev.wParam.toString(16)} at batch ${batch}`);
      } else {
        inputEvent = { msg: ev.msg, wParam: ev.wParam, lParam: ev.lParam, hwnd: 0 };
        logs.push(`[input] injected msg=0x${ev.msg.toString(16)} wParam=0x${ev.wParam.toString(16)} at batch ${batch}`);
      }
    }
    if (stopped) {
      while (logs.length) console.log(logs.shift());
      break;
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
    // --trace-at: arm set_bp once (mutually exclusive with --break; --break wins).
    // If --trace-at-start-batch is set, delay arming too; otherwise early
    // breakpoints can perturb hot generated-code paths before we need data.
    if (traceAtAddr && !breakAddrs.length && batch === TRACE_AT_START_BATCH && instance.exports.set_bp) {
      instance.exports.set_bp(traceAtAddr);
    }
    // --trace-esp: arm range once
    if (traceEspOn && batch === 0 && instance.exports.set_trace_esp) {
      instance.exports.set_trace_esp(1, traceEspLo, traceEspHi);
    }
    // --trace-eip-range: arm only when resolution succeeded (skip at batch=0 if
    // module-relative range hasn't resolved yet — late LoadLibrary path re-arms).
    if (traceEipOn && traceEipArmed && batch === 0 && instance.exports.set_trace_eip_range) {
      instance.exports.set_trace_eip_range(1, traceEipLo, traceEipHi);
    }
    // Hit counters: register once
    if (countAddrs.length && batch === 0 && instance.exports.set_count) {
      for (let i = 0; i < countAddrs.length; i++) {
        instance.exports.set_count(i, countAddrs[i]);
      }
    }
    // Breakpoint check (EIP before run)
    if (breakAddrs.length && breakAddrs.includes(eipBefore)) {
      if (breakThreadFilter !== null && breakThreadFilter !== 0) {
        // --break-thread filter excludes main; skip silently
      } else {
        console.log(`\n*** BREAKPOINT hit at ${hex(eipBefore)} (batch ${batch})`);
        dumpCallstack('T0', instance.exports);
        stepping = true;
        await debugPrompt('Break');
      }
    }

    // Single-step mode
    if (stepping) {
      console.log(`[${batch}] EIP=${hex(eipBefore)}`);
      await debugPrompt('Step');
    }

    if (TRACE) {
      console.log(`[${batch}] >> ${hex(eipBefore)} ESP=${hex(instance.exports.get_esp())}`);
    }

    // Default to message-loop delivery for multimedia timers. The guest already
    // synthesizes MM_TIMER (0x7FF0) in PeekMessageA/GetMessageA, which matches
    // how our Win32-facing code expects timeSetEvent callbacks to arrive.
    // Injecting the callback asynchronously here as well causes duplicate
    // dispatch for apps that pump messages, including RCT and Abe.
    //
    // `--async-mm-timer` keeps the old path available for experiments on
    // binaries that truly need out-of-band timer delivery.
    if (instance.exports.fire_mm_timer && hasFlag('async-mm-timer') && !hasFlag('no-timer')) {
      const comBefore = instance.exports.guest_read32(0x003fea90);
      const fired = instance.exports.fire_mm_timer();
      const comAfter = instance.exports.guest_read32(0x003fea90);
      if (comBefore !== comAfter) {
        console.log(`[TIMER-CORRUPT] batch=${batch} before=${hex(comBefore)} after=${hex(comAfter)} fired=${fired} EIP=${hex(instance.exports.get_eip())}`);
      }
      if (fired && TRACE_API) {
        const mem32 = new Uint32Array(memory.buffer);
        const g2wOff = 0x12000 - instance.exports.get_image_base();
        const trampVal = mem32[(0xa5a058 + g2wOff) >> 2];
        console.log(`[mm_timer] fired at batch ${batch}, EIP=${hex(instance.exports.get_eip())}, [0xa5a058]=${hex(trampVal)}`);
      }
    }

    // DEBUG: check COM wrapper for DDraw offscreen surface corruption
    if (TRACE_API && instance.exports.guest_read32) {
      const comSlot2 = 0x003fea90;
      const vtbl = instance.exports.guest_read32(comSlot2);
      if (vtbl !== 0 && vtbl < 0x02200000) {
        console.log(`[CORRUPT-PRE] batch=${batch} COM slot2 vtable=${hex(vtbl)} EIP=${hex(instance.exports.get_eip())}`);
        break;
      }
    }

    const batchStartMs = TRACE_BATCH_TIMING ? Date.now() : 0;
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

    // DEBUG: check COM wrapper after run
    if (TRACE_API && instance.exports.guest_read32) {
      const comSlot2 = 0x003fea90;
      const vtbl = instance.exports.guest_read32(comSlot2);
      if (vtbl !== 0 && vtbl < 0x02200000) {
        console.log(`[CORRUPT-POST] batch=${batch} COM slot2 vtable=${hex(vtbl)} EIP=${hex(instance.exports.get_eip())}`);
      }
    }

    const afterRunMs = TRACE_BATCH_TIMING ? Date.now() : 0;
    if ((batch & 0x7f) === 0 && base.gdi && base.gdi.presentBestDxOffscreen) {
      base.gdi.presentBestDxOffscreen();
    }

    // Flush deferred repaint so back canvas composites after all GDI writes.
    // The scheduled-repaint flag survives a skipped flush, so coalescing here
    // delays a composite, never drops one.
    if (renderer && renderer.flushRepaint
        && (REPAINT_EVERY === 1 || batch % REPAINT_EVERY === 0)) {
      renderer.flushRepaint();
    }
    if (TRACE_BATCH_TIMING) {
      const afterPaintMs = Date.now();
      console.log(`[batch-timing] batch=${batch} run=${afterRunMs - batchStartMs}ms paint=${afterPaintMs - afterRunMs}ms eip=${hex(instance.exports.get_eip())}`);
    }

    // WASM-level breakpoint check (after run returns)
    {
      const eipNow = instance.exports.get_eip();
      if (breakAddrs.length && breakAddrs.includes(eipNow) && eipNow !== eipBefore) {
        if (breakThreadFilter !== null && breakThreadFilter !== 0) {
          // --break-thread filter excludes main; just re-arm and continue
          if (instance.exports.set_bp && !BREAK_ONCE) instance.exports.set_bp(breakAddrs[0]);
        } else {
          console.log(`\n*** BREAKPOINT hit at ${hex(eipNow)} (batch ${batch}, WASM bp)`);
          if (instance.exports.get_dbg_prev_eip) console.log('  dbg_prev_eip=' + hex(instance.exports.get_dbg_prev_eip()));
          if (instance.exports.get_bp_first_caller) console.log('  bp_first_caller=' + hex(instance.exports.get_bp_first_caller()));
          console.log('  ' + regs());
          dumpStack();
          dumpCallstack('T0', instance.exports);
          // Re-arm WASM bp so subsequent hits also fire (skip if --break-once)
          if (instance.exports.set_bp && !BREAK_ONCE) instance.exports.set_bp(breakAddrs[0]);
        }
      }
      // --trace-at: one-line register dump per hit, no stop (matches any addr in traceAtAddrs)
      if (traceAtAddrs.length && traceAtAddrs.includes(eipNow >>> 0)) {
        const shouldLog =
          batch >= TRACE_AT_START_BATCH &&
          (!TRACE_AT_LIMIT || traceAtHits < TRACE_AT_LIMIT);
        if (shouldLog) {
          traceAtHits++;
          const e = instance.exports;
          const esp = e.get_esp() >>> 0;
          const dv = new DataView(memory.buffer);
          let stk = '';
          for (let i = 0; i < 6; i++) {
            const addr = (esp + i * 4) >>> 0;
            stk += `[esp+${i * 4}]=${hex(dv.getUint32(g2w(addr), true))} `;
          }
          let prevInfo = '';
          if (e.get_dbg_prev_eip) prevInfo += ` prev_eip=${hex(e.get_dbg_prev_eip())}`;
          if (e.get_bp_first_caller) prevInfo += ` bp_first_caller=${hex(e.get_bp_first_caller())}`;
          let flagInfo = '';
          if (e.get_flag_res && e.get_flag_op && e.get_flag_a && e.get_flag_b && e.get_flag_sign_shift) {
            flagInfo = ` flags{op=${e.get_flag_op()} a=${hex(e.get_flag_a())} b=${hex(e.get_flag_b())} res=${hex(e.get_flag_res())} sh=${e.get_flag_sign_shift()}}`;
          }
          let memInfo = '';
          if (traceAtMem.length) {
            const regValue = (name) => {
              switch (String(name || '').toLowerCase()) {
                case 'eax': return e.get_eax() >>> 0;
                case 'ecx': return e.get_ecx() >>> 0;
                case 'edx': return e.get_edx() >>> 0;
                case 'ebx': return e.get_ebx() >>> 0;
                case 'esp': return e.get_esp() >>> 0;
                case 'ebp': return e.get_ebp() >>> 0;
                case 'esi': return e.get_esi() >>> 0;
                case 'edi': return e.get_edi() >>> 0;
                case 'eip': return e.get_eip() >>> 0;
                default: return null;
              }
            };
            const parseAddrExpr = (expr) => {
              const s = String(expr || '').replace(/^\[/, '').replace(/\]$/, '').trim();
              const m = s.match(/^(e(?:ax|bx|cx|dx|sp|bp|si|di|ip))\s*([+-])?\s*(0x[0-9a-fA-F]+|\d+)?$/i);
              if (m) {
                const base = regValue(m[1]);
                if (base === null) return null;
                const off = m[3] ? parseInt(m[3]) : 0;
                return ((m[2] === '-') ? (base - off) : (base + off)) >>> 0;
              }
              const addr = parseInt(s, 16);
              return Number.isFinite(addr) ? (addr >>> 0) : null;
            };
            const parts = [];
            for (const d of traceAtMem) {
              const addr = parseAddrExpr(d.expr);
              if (addr === null) {
                parts.push(`${d.expr}=<?>`);
                continue;
              }
              try {
                const wa = g2w(addr);
                let val;
                if (d.len === 1) val = dv.getUint8(wa);
                else if (d.len === 2) val = dv.getUint16(wa, true);
                else if (d.len === 4) val = dv.getUint32(wa, true) >>> 0;
                else {
                  const bytes = new Uint8Array(memory.buffer, wa, Math.max(0, d.len));
                  val = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
                  parts.push(`${d.expr}@${hex(addr)}=${val}`);
                  continue;
                }
                parts.push(`${d.expr}@${hex(addr)}=${hex(val)}`);
              } catch (ex) {
                parts.push(`${d.expr}@${hex(addr)}=<${ex.message}>`);
              }
            }
            memInfo = ` mem{${parts.join(' ')}}`;
          }
          console.log(`[TRACE-AT #${traceAtHits}] batch=${batch} ${regs()}${prevInfo}${flagInfo}${memInfo} ${stk}`);
          dumpCallstack('T0', e);
          for (const d of traceAtDumps) {
            if (TRACE_AT_WATCH && d.prev) {
              d.prev = hexdumpDiff(d.addr, d.len, d.prev);
            } else {
              hexdump(d.addr, d.len);
              if (TRACE_AT_WATCH) d.prev = readBytes(d.addr, d.len);
            }
          }
          const cs = showCStrings();
          if (cs) console.log(cs);
        }
        if (instance.exports.set_bp && (!TRACE_AT_LIMIT || traceAtHits < TRACE_AT_LIMIT)) {
          instance.exports.set_bp(traceAtAddr);
        }
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
          path.join(path.dirname(EXE_PATH), 'dlls', fileName),
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

    // Handle the virtual LAN net_wait yield (yield_reason=8). The guest is
    // parked inside a blocking socket call with EIP still on the thunk, so
    // clearing the yield re-enters the same handler with the same
    // arguments. Yielding to the event loop first is what lets inbound
    // frames actually arrive: on a ProcessWire they come in over IPC, and
    // nothing is delivered while this synchronous loop holds the thread.
    if (instance.exports.get_yield_reason() === 8) {
      netWaits++;
      if (netWaits > VLAN_MAX_WAITS) {
        console.log(`[net] no progress after ${VLAN_MAX_WAITS} blocking waits; stopping`);
        stopped = true;
        break;
      }
      if (TRACE_YIELD) {
        console.log(`[yield] T0 reason=8 (net_wait) eip=${hex(instance.exports.get_eip())} ` +
          `esp=${hex(instance.exports.get_esp())}`);
      }
      instance.exports.clear_yield();
      await new Promise(resolve => setImmediate(resolve));
      if (instance.exports.vlan_pump) instance.exports.vlan_pump();
    } else {
      netWaits = 0;
    }

    // Handle LoadLibraryA yield (yield_reason=5)
    if (instance.exports.get_yield_reason() === 5) {
      if (TRACE_YIELD) {
        console.log(`[yield] T0 reason=5 (load_library) eip=${hex(instance.exports.get_eip())} ` +
          `esp=${hex(instance.exports.get_esp())} syncDepth=${instance.exports.get_sync_msg_depth ? instance.exports.get_sync_msg_depth() : 0}`);
      }
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
          path.join(path.dirname(EXE_PATH), 'dlls', fileName),
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
        const { loadDll: ld, patchDllImports: pdi, callDllMain: cdm, resumeAfterLoadLibraryYield: rly } = require('../lib/dll-loader');
        const result = ld(instance.exports, memory.buffer, dllBytesArr);
        console.log(`[LoadLibrary] ${fileName} loaded at 0x${result.loadAddr.toString(16)}, dllMain=0x${(result.dllMain>>>0).toString(16)}`);
        try {
          const { extractBitmapBytes } = require('../lib/dib');
          const bitmapBytes = extractBitmapBytes(dllBytesArr);
          const count = Object.keys(bitmapBytes).length;
          if (count > 0) {
            ctx.dllResources = ctx.dllResources || {};
            ctx.dllResources[result.loadAddr] = { bitmapBytes };
            console.log(`DLL resources: ${fileName} has ${count} bitmaps`);
          }
        } catch (_) {}
        {
          const key = fileName.toLowerCase().replace(/\.[^.]+$/, '');
          const peOff2 = dllBytesArr[0x3C] | (dllBytesArr[0x3D] << 8) | (dllBytesArr[0x3E] << 16) | (dllBytesArr[0x3F] << 24);
          const dllOrigBase = dllBytesArr[peOff2 + 52] | (dllBytesArr[peOff2 + 53] << 8) | (dllBytesArr[peOff2 + 54] << 16) | (dllBytesArr[peOff2 + 55] << 24);
          moduleBases[key] = { loadAddr: result.loadAddr, origBase: dllOrigBase };
          deferredResolveAddrs();
          if (instance.exports.set_bp) {
            if (breakAddrs.length) instance.exports.set_bp(breakAddrs[0]);
            else if (traceAtAddr) instance.exports.set_bp(traceAtAddr);
          }
          if (countAddrs.length && instance.exports.set_count) {
            for (let i = 0; i < countAddrs.length; i++) {
              instance.exports.set_count(i, countAddrs[i]);
            }
          }
          if (traceEipOn && traceEipArmed && instance.exports.set_trace_eip_range) {
            instance.exports.set_trace_eip_range(1, traceEipLo, traceEipHi);
          }
        }
        // Patch the new DLL's imports against all previously loaded DLLs
        pdi(instance.exports, memory.buffer,
          [{ name: fileName, bytes: dllBytesArr }],
          [result], console.log);
        // Call DllMain(DLL_PROCESS_ATTACH). Some DLLs (e.g. d3dxof) initialize
        // critical state here — the template registry. callDllMain saves/restores
        // EIP/ESP so it's safe to invoke from the LoadLibrary yield handler.
        instance.exports.clear_yield();
        if (result.dllMain && cdm) cdm(instance.exports, result.loadAddr, result.dllMain, console.log);
        instance.exports.set_eax(result.loadAddr);
        if (rly) rly(instance.exports, memory.buffer, TRACE_YIELD ? console.log : null);
      } else {
        console.log(`[LoadLibrary] DLL not found: ${fileName}`);
        instance.exports.set_eax(0);
        try {
          const { resumeAfterLoadLibraryYield: rly } = require('../lib/dll-loader');
          if (rly) rly(instance.exports, memory.buffer, TRACE_YIELD ? console.log : null);
        } catch (_) {}
      }
      // ESP and EIP already adjusted by WAT handler before yield
      instance.exports.clear_yield();
    }

    // Thread management: spawn pending threads, run worker slices
    if (threadManager._pendingThreads.length) {
      await threadManager.spawnPending();
    }
    if (WORKER_THREADS && threadManager.hasActiveThreads()) {
      // Real threads: every runnable one gets a slice at the same time, and they
      // run on other CPUs while this thread carries on. There is no quantum to
      // hand out and no round-robin to be fair about — those exist because one JS
      // thread has to be shared, which is the constraint this backend removes.
      //
      // The clock and the input-queue depth are published, not asked for: a
      // worker reads them out of its control block without a round trip, and this
      // is the only thread that knows them.
      guestThreadHost.broker.publish({
        tickMs: tickState.batch * 200,
        inputPending: (inputQueue ? inputQueue.length : 0)
          + (renderer && renderer.inputQueue ? renderer.inputQueue.length : 0),
      });
      const workerStartMs = TRACE_BATCH_TIMING ? Date.now() : 0;
      // Same THREAD_SLICES structure as the cooperative branch below, and for a
      // reason that is not cosmetic: what a producer thread gets out of a batch is
      // counted in WAKEUPS, not in steps. Winamp's decoder does one buffer's worth
      // of work and parks on its event again, so its slice ends on the yield no
      // matter how large the slice was. One round of slices per batch gave it a
      // quarter of the wakeups the cooperative backend gives it, and the captured
      // PCM came out 4x behind — real samples, arriving too late to be the audio
      // the run was measuring. Main runs between rounds for the same reason it does
      // below, which is what keeps --max-batches meaning the same thing on both
      // backends.
      //
      // Slice size is NOT BATCH_SIZE, though. A worker's slice size is only the
      // granularity of its round trip back to this thread — nothing here is blocked
      // while it runs — whereas BATCH_SIZE is tuned for the opposite constraint and
      // apps run it as low as 100 steps.
      let ran = 0;
      for (let s = 0; s < THREAD_SLICES; s++) {
        const workerSlices = threadManager.runWorkerSlices(THREAD_BATCH_SIZE);
        // --threads-serial means nothing runs beside a guest thread, main
        // included, or the switch would not answer the question it exists for.
        if (THREADS_SERIAL) await workerSlices;
        else if (s < THREAD_SLICES - 1 && !stopped) {
          // Main keeps running WHILE they do — the CLI's version of host.js
          // awaiting the main slice and the thread slices together.
          try { instance.exports.run(BATCH_SIZE); } catch (e) { /* reported below */ }
        }
        ran = await workerSlices;
        if (!ran || stopped || !threadManager.hasActiveThreads()) break;
      }
      if (TRACE_BATCH_TIMING) {
        console.log(`[batch-timing] batch=${batch} threads=${ran} worker=${Date.now() - workerStartMs}ms`);
      }
      if (threadManager.netWaitPending) {
        threadManager.netWaitPending = false;
        await new Promise(resolve => setImmediate(resolve));
      }
    } else if (threadManager.hasActiveThreads()) {
      // Give worker threads extra runtime when main thread is idle (e.g., waiting for extraction)
      const slices = installingFiles ? 1000 : THREAD_SLICES;
      // The run=/paint= line above covers only the main instance. In a threaded
      // app the game itself lives on a worker, so without this the profile
      // reads as "nothing is running" while the box is pinned.
      const workerStartMs = TRACE_BATCH_TIMING ? Date.now() : 0;
      for (let s = 0; s < slices; s++) {
        threadManager.runSlice(BATCH_SIZE);
        // Re-run main between live worker slices so producer/consumer pairs
        // progress together. Once the last worker exits, return to the outer
        // loop; repeatedly re-entering the main message pump here can drain
        // creation-time paints before an app has finished its first layout.
        if (s < slices - 1 && !stopped && threadManager.hasActiveThreads()) {
          try { instance.exports.run(BATCH_SIZE); } catch (e) { break; }
        }
      }
      if (TRACE_BATCH_TIMING) {
        console.log(`[batch-timing] batch=${batch} worker=${Date.now() - workerStartMs}ms slices=${slices}`);
      }
      // A worker parked in a blocking socket call is waiting on a frame that
      // only the event loop can deliver. runSlice cannot await, so the turn
      // has to be given here or the wait never ends.
      if (threadManager.netWaitPending) {
        threadManager.netWaitPending = false;
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    // A parked socket call is not the only way to be waiting on the wire. An
    // app using WSAAsyncSelect never blocks in winsock at all: it sits in its
    // message pump expecting to be told, so nothing above would ever yield and
    // the IPC frames carrying that news would not be read until the run ended.
    // The wire belongs to the process, not to a worker, so this turn is owed
    // whenever one is attached -- not only while threads happen to be alive.
    if (ctx.vlanWire && (batch & 63) === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
    if (AUDIO_EXIT_BYTES > 0 && ctx._audioOutFd !== undefined) {
      let audioBytes = 0;
      try { audioBytes = fs.fstatSync(ctx._audioOutFd).size; } catch (_) {}
      if (audioBytes >= AUDIO_EXIT_BYTES) {
        console.log(`[audio] captured ${audioBytes} bytes; stopping at --audio-exit-bytes=${AUDIO_EXIT_BYTES}`);
        stopped = true;
        break;
      }
    }
    {
      const eipPostThreads = instance.exports.get_eip();
      if (breakAddrs.length && breakAddrs.includes(eipPostThreads) && !breakAddrs.includes(eipBefore)) {
        console.log(`\n*** BREAKPOINT (POST-THREADS) hit at ${hex(eipPostThreads)} (batch ${batch}, eipBefore=${hex(eipBefore)})`);
        if (instance.exports.get_dbg_prev_eip) console.log('  dbg_prev_eip=' + hex(instance.exports.get_dbg_prev_eip()));
        if (instance.exports.get_bp_first_caller) console.log('  bp_first_caller=' + hex(instance.exports.get_bp_first_caller()));
      }
    }
    // Check if main thread is waiting on an event
    if (threadManager.checkMainYield()) {
      // Main thread still waiting — don't advance EIP check
    }

// Watchpoint check
    if (checkWatchpoint(batch)) {
      if (!WATCH_LOG) {
        stepping = true;
        await debugPrompt('Watch');
      }
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
    } else {
      const ex = instance.exports;
      const regFp = ((ex.get_eax() ^ ex.get_ecx() ^ ex.get_edx() ^ ex.get_ebx() ^ ex.get_esi() ^ ex.get_edi() ^ ex.get_ebp() ^ ex.get_esp()) | 0);
      if (injectedInputThisBatch || eip !== prevEip || apiCount !== prevApiCount || regFp !== prevRegFp) {
        if (!QUIET_BLOCKS && eip !== prevEip) console.log(`[${batch}] ${regs()}`);
        prevEip = eip;
        prevApiCount = apiCount;
        prevRegFp = regFp;
        stuckCount = 0;
      } else if (ex.win16_pump_parked && ex.win16_pump_parked()) {
        // A 16-bit modal dialog or message box with no message to handle waits
        // on a continuation slot with every register unchanged. That is the
        // defined behaviour of those addresses, not a hang.
        stuckCount = 0;
      } else if (scheduledInput.length) {
        // Scripted UI tests often wait inside a stable message-loop thunk
        // until the next scheduled click/capture. Do not let that idle time
        // accumulate and instantly trip after the last event is consumed.
        stuckCount = 0;
      } else {
        stuckCount++;
        if (stuckCount > STUCK_AFTER) {
          console.log(`STUCK at EIP=${hex(eip)} after ${stuckCount} batches`);
          if (instance.exports.get_dbg_prev_eip) console.log(`  dbg_prev_eip=${hex(instance.exports.get_dbg_prev_eip())}`);
          dumpStack();
          break;
        }
      }
    }
  }

  if (!stopped) {
    console.log('\n--- Final state ---');
    console.log(regs());
    if (instance.exports.get_wndproc) console.log('wndproc:', hex(instance.exports.get_wndproc()));
    if (instance.exports.get_thunk_base) console.log('thunk_base:', hex(instance.exports.get_thunk_base()), 'thunk_end:', hex(instance.exports.get_thunk_end()), 'num_thunks:', instance.exports.get_num_thunks());
    if (instance.exports.get_heap_ptr) console.log('heap_ptr:', hex(instance.exports.get_heap_ptr()));
    if (instance.exports.get_heap_sparse_ptr) console.log('heap_sparse_ptr:', hex(instance.exports.get_heap_sparse_ptr()));
    if (instance.exports.get_heap_sparse_end) console.log('heap_sparse_end:', hex(instance.exports.get_heap_sparse_end()));
    if (instance.exports.get_virtual_alloc_top) console.log('virtual_alloc_top:', hex(instance.exports.get_virtual_alloc_top()));
    if (instance.exports.get_heap_base) console.log('heap_base:', hex(instance.exports.get_heap_base()));
  }

  if (DUMP_VIRTUAL_MAPS) {
    const dv = new DataView(memory.buffer);
    const state = 0x07F02400;
    const table = 0x07F02410;
    const count = dv.getUint32(state, true);
    const backingTop = dv.getUint32(state + 4, true);
    const reservationTop = dv.getUint32(state + 8, true);
    console.log(`virtual_maps: count=${count} backing_top=${hex(backingTop)} reservation_top=${hex(reservationTop)}`);
    for (let i = 0; i < count; i++) {
      const rec = table + i * 16;
      const guest = dv.getUint32(rec, true);
      const size = dv.getUint32(rec + 4, true);
      const backing = dv.getUint32(rec + 8, true);
      console.log(`  [${i}] guest=${hex(guest)}..${hex((guest + size) >>> 0)} size=${hex(size)} backing=${hex(backing)}`);
    }
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

  if (ctx._finalizeWaveTrace) ctx._finalizeWaveTrace();

  // If --audio-out=*.wav, prepend a 44-byte RIFF/WAVE header now that we know
  // the captured format and total bytes. Plain .pcm output is left raw.
  if (ctx._audioOutFd !== undefined && ctx._audioOutWav) {
    // Format may have been captured by a worker thread's ctx; fall back to
    // the renderer's last-seen format if the main ctx didn't observe it.
    const fmt = ctx._audioOutFormat
      || (ctx._waveStats && ctx._waveStats.lastFmt)
      || { rate: 22050, ch: 2, bits: 16 };
    // PCM byte counter is per-thread; trust the file size on disk instead.
    const dataLen = fs.fstatSync(ctx._audioOutFd).size;
    const bytesPerSec = fmt.rate * fmt.ch * (fmt.bits / 8);
    const blockAlign = fmt.ch * (fmt.bits / 8);
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0);
    hdr.writeUInt32LE(36 + dataLen, 4);
    hdr.write('WAVE', 8);
    hdr.write('fmt ', 12);
    hdr.writeUInt32LE(16, 16);              // PCM fmt chunk size
    hdr.writeUInt16LE(1, 20);               // PCM format
    hdr.writeUInt16LE(fmt.ch, 22);
    hdr.writeUInt32LE(fmt.rate, 24);
    hdr.writeUInt32LE(bytesPerSec, 28);
    hdr.writeUInt16LE(blockAlign, 32);
    hdr.writeUInt16LE(fmt.bits, 34);
    hdr.write('data', 36);
    hdr.writeUInt32LE(dataLen, 40);
    // Read the raw PCM we wrote, then rewrite header + data in one go.
    fs.closeSync(ctx._audioOutFd);
    ctx._audioOutFd = undefined;
    const pcm = fs.readFileSync(ctx._audioOutPath);
    const fd = fs.openSync(ctx._audioOutPath, 'w');
    fs.writeSync(fd, hdr);
    fs.writeSync(fd, pcm);
    fs.closeSync(fd);
    console.log(`[wav] wrote ${ctx._audioOutPath}: ${fmt.rate}Hz ${fmt.ch}ch ${fmt.bits}bit ${dataLen} B PCM (+44 B header)`);
  }

  console.log(`\nStats: ${apiCount} API calls, ${MAX_BATCHES} batches`);

  if (HOST_CENSUS && globalThis.__hostCensusCounts) {
    const total = globalThis.__hostCensusTotal ? globalThis.__hostCensusTotal() : 0;
    const top = [...globalThis.__hostCensusCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    console.log(`\n[host-census] final: ${total} host calls total`);
    for (const [n, c] of top) {
      console.log(`  ${String(c).padStart(9)}  ${n}`);
    }
  }

  // --gdi-stats: how much software rasterization the run actually did. Span
  // counts and pixel counts answer different questions — a repaint storm shows
  // up as pixels per batch, a clip/ROP fallback as slow-path share.
  if (GDI_STATS && instance.exports.test_gdi_fast_count) {
    const c = i => instance.exports.test_gdi_fast_count(i) >>> 0;
    const fastPx = c(4), slowPx = c(5);
    const px = fastPx + slowPx;
    console.log(`\nGDI raster: ${c(0)} fast spans (${fastPx} px), ${c(3)} slow spans (${slowPx} px)`);
    console.log(`            ${c(1)} fast bitblts, ${c(2)} fast stretches`);
    console.log(`            ${(px / MAX_BATCHES).toFixed(0)} px/batch, slow-path share ${px ? (100 * slowPx / px).toFixed(1) : '0.0'}%`);
    console.log(`            ${c(8)} band-walked spans (multi-rect clip, still fast)`);
    console.log(`            slow spans by cause: ${c(6)} clip/bounds, ${c(7)} surface-or-ROP`);
  }

  if (LATENCY_STATS) {
    const s = latency.samples;
    if (!s.length) {
      console.log('\nInput->blit: no samples (no input injected, or nothing ever blitted)');
    } else {
      const pick = (key, q) => {
        const v = s.map(x => x[key]).sort((a, b) => a - b);
        return v[Math.min(v.length - 1, Math.floor(q * v.length))];
      };
      console.log(`\nInput->blit: ${s.length} events` +
        (latency.pending ? ` (1 never blitted)` : ''));
      console.log(`             batches p50 ${pick('batches', 0.5)}, p95 ${pick('batches', 0.95)}, max ${pick('batches', 1)}`);
      console.log(`             ms      p50 ${pick('ms', 0.5).toFixed(2)}, p95 ${pick('ms', 0.95).toFixed(2)}, max ${pick('ms', 1).toFixed(2)}`);
    }
  }

  if (threadManager && threadManager.threads && threadManager.threads.size) {
    console.log('\nThreads (final state):');
    for (const [handle, t] of threadManager.threads) {
      // A worker-backed thread's registers live in another OS thread's instance,
      // and reading them would mean a round trip to a worker that may already be
      // gone. Report what the scheduler itself knows instead of a dump error.
      if (!t.instance && t.link) {
        console.log(`  T${t.tid} h=0x${handle.toString(16)} state=${t.state} slot=${t.link.slot} `
          + `slices=${t.link.sliceStats.slices} guestMs=${t.link.sliceStats.guestMs.toFixed(1)} `
          + `rpc=${t.link.sliceStats.rpcSync}sync/${t.link.sliceStats.rpcAsync}async/${t.link.sliceStats.rpcLocal}local `
          + `sleepCount=${t.sleepCount || 0} waitPolls=${t.waitPolls || 0}`);
        continue;
      }
      try {
        const e = t.instance.exports;
        const eip = e.get_eip ? e.get_eip() : 0;
        const esp = e.get_esp ? e.get_esp() : 0;
        const ebp = e.get_ebp ? e.get_ebp() : 0;
        const yr = e.get_yield_reason ? e.get_yield_reason() : -1;
        const wh = e.get_wait_handle ? e.get_wait_handle() : 0;
        console.log(`  T${t.tid} h=0x${handle.toString(16)} state=${t.state} eip=0x${eip.toString(16)} esp=0x${esp.toString(16)} ebp=0x${ebp.toString(16)} yield=${yr} waitH=0x${wh.toString(16)} sleepCount=${t.sleepCount||0}`);
      } catch (ex) { console.log(`  T${t.tid} dump error: ${ex.message}`); }
    }
  }

  if (apiCounts) {
    const sorted = [...apiCounts.entries()].sort((a, b) => b[1] - a[1]);
    const shown = sorted.slice(0, API_COUNTS_TOP);
    const rest = sorted.slice(API_COUNTS_TOP).reduce((s, [, n]) => s + n, 0);
    console.log(`\nAPI call counts (top ${shown.length} of ${sorted.length} unique):`);
    const pad = String(shown[0]?.[1] ?? 0).length;
    for (const [name, n] of shown) console.log(`  ${String(n).padStart(pad)}  ${name}`);
    if (rest) console.log(`  ${String(rest).padStart(pad)}  (${sorted.length - API_COUNTS_TOP} others)`);
  }
  if (profileHostStats.size) {
    console.log('\nHost import profile:');
    for (const [name, s] of profileHostStats) {
      const ms = Number(s.ns) / 1e6;
      const avgUs = s.count ? (ms * 1000 / s.count) : 0;
      console.log(`  ${name}: count=${s.count} total=${ms.toFixed(3)}ms avg=${avgUs.toFixed(3)}us`);
    }
  }

  if (countAddrs.length && instance.exports.get_count) {
    console.log('Hit counts:');
    for (let i = 0; i < countAddrs.length; i++) {
      console.log(`  ${hex(countAddrs[i])} = ${instance.exports.get_count(i)}`);
    }
  }

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
      if (SAVE_VFS_SUFFIX && !k.toLowerCase().endsWith(SAVE_VFS_SUFFIX.toLowerCase())) continue;
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

  // --dump-vmap: list the sparse VirtualAlloc mappings, and say for each
  // --dump address whether it actually lands in one. Guest memory outside
  // every mapping translates to the shared NULL sentinel, where writes are
  // discarded and reads come back zero — so a hexdump of unmapped memory is
  // an innocent-looking page of zeros rather than an error. That is worth one
  // line of output whenever you are chasing memory that "should" hold data.
  if (DUMP_VMAP) {
    const dv2 = new DataView(memory.buffer);
    const count = dv2.getUint32(0x07F02400, true) >>> 0;
    console.log(`Virtual map: ${count} mapping(s)`);
    const maps = [];
    for (let i = 0; i < count; i++) {
      const rec = 0x07F02410 + i * 16;
      const b = dv2.getUint32(rec, true) >>> 0;
      const sz = dv2.getUint32(rec + 4, true) >>> 0;
      const back = dv2.getUint32(rec + 8, true) >>> 0;
      maps.push({ b, sz });
      console.log(`  [${i}] guest ${hex(b)}..${hex(b + sz)}  size ${hex(sz)}  backing ${hex(back)}`);
    }
    if (DUMP_SPEC) {
      for (const spec of DUMP_SPEC.split(',')) {
        const a = parseInt(spec.split(':')[0], 16) >>> 0;
        const hit = maps.findIndex(m => a >= m.b && a < m.b + m.sz);
        console.log(`  probe ${hex(a)}: ${hit >= 0
          ? `mapped in [${hit}]`
          : 'NOT MAPPED — reads return 0 and writes are discarded'}`);
      }
    }
  }

  // Dump sprite list if requested
  if (args.includes('--dump-sprites')) {
    const { dumpSprites } = require('../tools/dump_sprites');
    dumpSprites(new Uint8Array(memory.buffer));
  }

  if (DUMP_SEH || TRACE_SEH) {
    dumpSEH(true);
  }

  const getDxSurfaceManifest = () => {
    const mem = new Uint8Array(memory.buffer);
    const dv = new DataView(memory.buffer);
    const DX_BASE = 0x07FF0000;
    const DX_SLOTS = 256;
    let paletteWa = 0;
    for (let slot = 0; slot < DX_SLOTS; slot++) {
      const entry = DX_BASE + slot * 32;
      const type = dv.getUint32(entry, true);
      const ptr = dv.getUint32(entry + 20, true);
      if (type === 3 && ptr) { paletteWa = ptr; break; }
    }
    const surfaces = [];
    for (let slot = 0; slot < DX_SLOTS; slot++) {
      const entry = DX_BASE + slot * 32;
      const type = dv.getUint32(entry, true);
      const flags = dv.getUint32(entry + 28, true);
      if (type !== 2 || !flags) continue;
      const w = dv.getUint16(entry + 12, true);
      const h = dv.getUint16(entry + 14, true);
      const bpp = dv.getUint16(entry + 16, true);
      const pitch = dv.getUint16(entry + 18, true) || Math.ceil(w * bpp / 32) * 4;
      const dib = dv.getUint32(entry + 20, true);
      if (!w || !h || !dib) continue;
      let firstNonZero = -1;
      let checksum = 0;
      const sampleBytes = Math.min(pitch * Math.min(h, 16), 0x4000);
      for (let i = 0; i < sampleBytes; i++) {
        const v = mem[dib + i];
        if (firstNonZero < 0 && v !== 0) firstNonZero = i;
        checksum = (checksum + v) >>> 0;
      }
      surfaces.push({ slot, flags, w, h, bpp, pitch, dib, firstNonZero, checksum, paletteWa });
    }
    return { mem, surfaces };
  };

  const dxSurfaceToRgba = (surface, mem) => {
    const data = Buffer.alloc(surface.w * surface.h * 4);
    for (let y = 0; y < surface.h; y++) {
      const srcRow = surface.dib + y * surface.pitch;
      for (let x = 0; x < surface.w; x++) {
        const di = (y * surface.w + x) * 4;
        let r = 0, g = 0, b = 0;
        if (surface.bpp === 8) {
          if (surface.paletteWa) {
            const pi = mem[srcRow + x];
            r = mem[surface.paletteWa + pi * 4];
            g = mem[surface.paletteWa + pi * 4 + 1];
            b = mem[surface.paletteWa + pi * 4 + 2];
          } else {
            r = g = b = mem[srcRow + x];
          }
        } else if (surface.bpp === 16) {
          const px = mem[srcRow + x * 2] | (mem[srcRow + x * 2 + 1] << 8);
          r = (px >> 11) << 3; g = ((px >> 5) & 0x3F) << 2; b = (px & 0x1F) << 3;
        } else if (surface.bpp === 24) {
          b = mem[srcRow + x * 3]; g = mem[srcRow + x * 3 + 1]; r = mem[srcRow + x * 3 + 2];
        } else if (surface.bpp === 32) {
          b = mem[srcRow + x * 4]; g = mem[srcRow + x * 4 + 1]; r = mem[srcRow + x * 4 + 2];
        }
        data[di] = r; data[di + 1] = g; data[di + 2] = b; data[di + 3] = 255;
      }
    }
    return data;
  };

  const dxSurfaceContentScore = (surface, mem) => {
    if (!surface || !surface.dib || !surface.w || !surface.h || !surface.pitch) {
      return { colors: 0, nonZero: 0, total: 0 };
    }
    const colors = new Set();
    let nonZero = 0;
    let total = 0;
    try {
      const step = Math.max(1, Math.ceil(Math.sqrt((surface.w * surface.h) / 2048)));
      for (let y = 0; y < surface.h; y += step) {
        const srcRow = surface.dib + y * surface.pitch;
        for (let x = 0; x < surface.w; x += step) {
          let key = 0;
          if (surface.bpp === 8) {
            const idx = mem[srcRow + x] || 0;
            if (surface.paletteWa) {
              const pi = surface.paletteWa + idx * 4;
              key = ((mem[pi] || 0) << 16) | ((mem[pi + 1] || 0) << 8) | (mem[pi + 2] || 0);
            } else {
              key = idx;
            }
          } else if (surface.bpp === 16) {
            key = (mem[srcRow + x * 2] || 0) | ((mem[srcRow + x * 2 + 1] || 0) << 8);
          } else if (surface.bpp === 24) {
            const pi = srcRow + x * 3;
            key = ((mem[pi + 2] || 0) << 16) | ((mem[pi + 1] || 0) << 8) | (mem[pi] || 0);
          } else if (surface.bpp === 32) {
            const pi = srcRow + x * 4;
            key = ((mem[pi + 2] || 0) << 16) | ((mem[pi + 1] || 0) << 8) | (mem[pi] || 0);
          }
          colors.add(key >>> 0);
          if (key !== 0) nonZero++;
          total++;
        }
      }
    } catch (_) {}
    return { colors: colors.size, nonZero, total };
  };

  const chooseDxPresentationSurface = (surfaces, mem) => {
    const primary = surfaces.filter(s => (s.flags & 1));
    const offscreen = surfaces.filter(s => (s.flags & 4));
    const scored = (surface) => ({ surface, score: dxSurfaceContentScore(surface, mem) });
    const useful = (item) => item && item.score.nonZero > 0;
    const bestByDiversity = (items) => items
      .filter(useful)
      .sort((a, b) =>
        (b.score.colors - a.score.colors) ||
        (b.score.nonZero - a.score.nonZero))[0] || null;

    const primaryCandidates = primary.map(scored);
    const offscreenCandidates = offscreen
      .filter(s => s.w >= 320 && s.h >= 200)
      .map(scored);
    const bestPrimary = bestByDiversity(primaryCandidates);
    const bestOffscreen = bestByDiversity(offscreenCandidates);

    if (!bestPrimary) {
      for (const p of primary) {
        const matching = bestByDiversity(offscreenCandidates.filter(item =>
          item.surface.w === p.w &&
          item.surface.h === p.h &&
          item.surface.bpp === p.bpp));
        if (matching) return matching.surface;
      }
      return bestOffscreen ? bestOffscreen.surface : null;
    }

    if (bestOffscreen &&
        bestOffscreen.score.colors >= 16 &&
        bestOffscreen.score.colors >= Math.max(bestPrimary.score.colors + 8, bestPrimary.score.colors * 4)) {
      return bestOffscreen.surface;
    }

    return bestPrimary.surface;
  };

  const writeRgbaPng = (outPath, width, height, data) => {
    if (!PNG) throw new Error('pngjs is required for direct PNG capture');
    const png = new PNG({ width, height });
    png.data.set(data);
    const pngBuf = PNG.sync.write(png);
    fs.writeFileSync(outPath, pngBuf);
    return pngBuf.length;
  };

  if (PNG_OUT && renderer) {
    const { mem, surfaces } = getDxSurfaceManifest();
    const surface = chooseDxPresentationSurface(surfaces, mem);
    if (surface) {
      const bytes = writeRgbaPng(PNG_OUT, surface.w, surface.h, dxSurfaceToRgba(surface, mem));
      console.log(`Wrote ${PNG_OUT} (${bytes} bytes, dx slot ${surface.slot} ${surface.w}x${surface.h})`);
    } else {
      renderer.repaint();
      const w = renderer.canvas.width | 0;
      const h = renderer.canvas.height | 0;
      const img = renderer.canvas.getContext('2d').getImageData(0, 0, w, h);
      const bytes = writeRgbaPng(PNG_OUT, w, h, img.data);
      console.log(`Wrote ${PNG_OUT} (${bytes} bytes, canvas ${w}x${h})`);
    }
    if (DUMP_BACKCANVAS) {
      for (const [hwnd, win] of Object.entries(renderer.windows)) {
        if (win) {
          console.log(`  hwnd=${hwnd} pos=${win.x},${win.y} size=${win.w}x${win.h} client=${JSON.stringify(win.clientRect)} visible=${win.visible} title=${JSON.stringify(win.title)}`);
        }
        if (win && win._backCanvas) {
          const back = canvasToPng(win._backCanvas);
          const out = PNG_OUT.replace(/\.png$/, `_back_${hwnd}.png`);
          fs.writeFileSync(out, back);
          console.log(`  Wrote ${out} (${back.length} bytes, ${win._backW}x${win._backH})`);
        }
      }
    }
  }

  // Dump the derived presentation of every canonical GDI surface as PNG.
  if (DUMP_GDI && createCanvas) {
    fs.mkdirSync(DUMP_GDI, { recursive: true });
    let count = 0;
    for (const [handle, presentation] of base.gdi.surfacePresentations.entries()) {
      if (!presentation || !presentation.surface || !presentation.width || !presentation.height) continue;
      const { width, height, surface } = presentation;
      const c = createCanvas(width, height);
      const dstCtx = c.getContext('2d');
      const img = dstCtx.createImageData(width, height);
      img.data.set(surface.rgbaRect(0, 0, width, height));
      dstCtx.putImageData(img, 0, 0);
      const outFile = path.join(DUMP_GDI, `gdi_${handle}_${width}x${height}.png`);
      fs.writeFileSync(outFile, canvasToPng(c));
      count++;
    }
    console.log(`Dumped ${count} GDI bitmaps to ${DUMP_GDI}/`);
  }

  // Dump all DirectDraw surfaces' current DIB contents as PNGs. Use the same
  // low-memory DX_OBJECTS table that dxLookupThis() uses for live tracing so
  // the diagnostic dump stays in sync with the current branch layout. When
  // canvas is unavailable, fall back to PPM + a metadata manifest.
  if (DUMP_DDRAW) {
    fs.mkdirSync(DUMP_DDRAW, { recursive: true });
    const mem = new Uint8Array(memory.buffer);
    const dv = new DataView(memory.buffer);
    const DX_BASE = 0x07FF0000;
    const DX_SLOTS = 256;
    const manifest = [];
    // Read the primary palette WASM addr by scanning palette-type entries in
    // the live DX table. Palette slots have type=3 and store their palette
    // bytes at +20.
    let paletteWa = 0;
    for (let slot = 0; slot < DX_SLOTS; slot++) {
      const entry = DX_BASE + slot * 32;
      const type = dv.getUint32(entry, true);
      const ptr = dv.getUint32(entry + 20, true);
      if (type === 3 && ptr) { paletteWa = ptr; break; }
    }
    let count = 0;
    for (let slot = 0; slot < DX_SLOTS; slot++) {
      const entry = DX_BASE + slot * 32;
      const type = dv.getUint32(entry, true);
      const flags = dv.getUint32(entry + 28, true);
      if (type !== 2 || !flags) continue;
      const w = dv.getUint16(entry + 12, true);
      const h = dv.getUint16(entry + 14, true);
      const bpp = dv.getUint16(entry + 16, true);
      const pitch = dv.getUint16(entry + 18, true) || Math.ceil(w * bpp / 32) * 4;
      const dib = dv.getUint32(entry + 20, true);
      if (!w || !h || !dib) continue;
      let firstNonZero = -1;
      let checksum = 0;
      const sampleBytes = Math.min(pitch * Math.min(h, 16), 0x4000);
      for (let i = 0; i < sampleBytes; i++) {
        const v = mem[dib + i];
        if (firstNonZero < 0 && v !== 0) firstNonZero = i;
        checksum = (checksum + v) >>> 0;
      }
      const rgba = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        const srcRow = dib + y * pitch;
        for (let x = 0; x < w; x++) {
          const di = (y * w + x) * 4;
          let r = 0, g = 0, b = 0;
          if (bpp === 8) {
            if (paletteWa) {
              const pi = mem[srcRow + x];
              // PALETTEENTRY: R, G, B, flags
              r = mem[paletteWa + pi * 4];
              g = mem[paletteWa + pi * 4 + 1];
              b = mem[paletteWa + pi * 4 + 2];
            } else {
              r = g = b = mem[srcRow + x];
            }
          } else if (bpp === 16) {
            const px = mem[srcRow + x * 2] | (mem[srcRow + x * 2 + 1] << 8);
            r = (px >> 11) << 3; g = ((px >> 5) & 0x3F) << 2; b = (px & 0x1F) << 3;
          } else if (bpp === 24) {
            b = mem[srcRow + x * 3]; g = mem[srcRow + x * 3 + 1]; r = mem[srcRow + x * 3 + 2];
          } else if (bpp === 32) {
            b = mem[srcRow + x * 4]; g = mem[srcRow + x * 4 + 1]; r = mem[srcRow + x * 4 + 2];
          }
          rgba[di] = r; rgba[di + 1] = g; rgba[di + 2] = b; rgba[di + 3] = 255;
        }
      }
      const kind = (flags & 1) ? 'primary' : (flags & 2) ? 'backbuf' : (flags & 4) ? 'offscreen' : 'other';
      manifest.push({ slot, kind, w, h, bpp, pitch, dib, flags, firstNonZero, checksum, sampleBytes });
      const base = path.join(DUMP_DDRAW, `dx_${slot.toString().padStart(2, '0')}_${kind}_${w}x${h}_${bpp}bpp`);
      if (createCanvas) {
        const c = createCanvas(w, h);
        const cctx = c.getContext('2d');
        const img = cctx.createImageData(w, h);
        img.data.set(rgba);
        cctx.putImageData(img, 0, 0);
        fs.writeFileSync(base + '.png', canvasToPng(c));
      } else {
        // Canvas isn't available in some sandboxes; emit a simple binary PPM
        // so surface inspection still works without native deps.
        const header = Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii');
        const rgb = Buffer.allocUnsafe(w * h * 3);
        for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
          rgb[j] = rgba[i];
          rgb[j + 1] = rgba[i + 1];
          rgb[j + 2] = rgba[i + 2];
        }
        fs.writeFileSync(base + '.ppm', Buffer.concat([header, rgb]));
      }
      count++;
    }
    fs.writeFileSync(path.join(DUMP_DDRAW, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`Dumped ${count} DirectDraw surfaces to ${DUMP_DDRAW}/ (paletteWA=0x${(paletteWa>>>0).toString(16)})`);
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
      fs.writeFileSync(outFile, canvasToPng(c));
      imgCount++;
    }
    fs.writeFileSync(path.join(DUMP_SDB, 'calls.log'), ctx.dumpSdb.log.join('\n') + '\n');
    console.log(`Dumped ${imgCount} StretchDIBits source DIBs and ${ctx.dumpSdb.log.length} call records to ${DUMP_SDB}/`);
  }

  if (workerThreadHost) workerThreadHost.stop();
}

main().catch(e => {
  console.error(e);
  // Exit code deliberately unchanged; the threads have to be stopped either way
  // or node waits on them forever and the error above never gets read.
  if (workerThreadHost) workerThreadHost.stop();
});
