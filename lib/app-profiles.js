// Per-app compatibility patches, in one place for both hosts.
//
// The same three QuickBlackjack byte patches were written twice — once in
// test/run.js and once in host.js — so a fourth patch, or a corrected
// expected-byte sequence, only ever landed in whichever host was being
// debugged that day. The table below is the single copy; each host passes its
// own logger and (for the CLI) the WA_EXE_COMPAT_PATCHES opt-in filter.
//
// A patch is applied only when the bytes at the address are exactly what it
// expects, so a differently-built binary of the same name is left alone and
// says so rather than being silently corrupted.

'use strict';

// exe name (lowercase) -> patches applied right after load_pe.
const EXE_PATCHES = {
  'quickblackjack.exe': [
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
  ],
};

// Winamp's visualizer thread can exit with the plugin's "running" bookkeeping
// still set, after which the next Visualization > Start finds a stale thread
// handle and does nothing. Clearing those words — and the wVis DLL's cached
// window geometry, which otherwise blits at the previous size — is what lets
// the plugin restart. This lived in host.js, so it ran in the browser and
// never headless, and no CLI test could reproduce a browser-only bug.
function cleanupWinampVisualizerThread(info, exports, memoryBuffer, log) {
  const say = log || ((m) => console.log(m));
  const imageBase = exports.get_image_base ? (exports.get_image_base() >>> 0) : 0;
  const guestBase = exports.get_guest_base ? (exports.get_guest_base() >>> 0) : 0x12000;
  if (!imageBase) return;
  const dv = new DataView(memoryBuffer);
  const g2w = (ptr) => ((ptr >>> 0) - imageBase + guestBase) >>> 0;
  const read32 = (ptr) => {
    const wa = g2w(ptr);
    return wa + 4 <= dv.byteLength ? (dv.getUint32(wa, true) >>> 0) : 0;
  };
  const write32 = (ptr, value) => {
    const wa = g2w(ptr);
    if (wa + 4 <= dv.byteLength) dv.setUint32(wa, value >>> 0, true);
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
  const readStr = (ptr, max) => readLinearStr(g2w(ptr), max);
  const findDllLoadAddr = (name) => {
    if (!exports.get_dll_count || !exports.get_dll_table) return 0;
    const target = String(name || '').toLowerCase();
    const table = exports.get_dll_table() >>> 0;
    const count = exports.get_dll_count() | 0;
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
    say(`[host] reset Winamp visualizer data helper stop flag after thread 0x${handle.toString(16)} exited`);
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
  say(`[host] cleared stale Winamp visualizer thread handle 0x${handle.toString(16)}`);
  if (resetDll) say('[host] reset wVis DLL cached window geometry');
}

// exe name (lowercase) -> what to run when one of the process's threads exits.
const THREAD_EXIT_HOOKS = {
  'winamp.exe': cleanupWinampVisualizerThread,
};

function onThreadExit(exeName, info, exports, memoryBuffer, opts) {
  const hook = THREAD_EXIT_HOOKS[String(exeName || '').toLowerCase()];
  if (!hook || !exports || !memoryBuffer) return;
  hook(info, exports, memoryBuffer, (opts && opts.log) || null);
}

// opts.enabledKeys — Set of patch keys to apply (null = all), from the CLI's
//                    WA_EXE_COMPAT_PATCHES; opts.skip disables the lot.
function applyExeCompatibilityPatches(exeName, exports, memoryBuffer, opts) {
  const {
    enabledKeys = null,
    skip = false,
    log = (m) => console.log(m),
    warn = (m) => console.warn(m),
  } = opts || {};
  if (skip) return 0;
  const patches = EXE_PATCHES[String(exeName || '').toLowerCase()];
  if (!patches) return 0;
  if (!exports || !exports.get_image_base || !memoryBuffer) return 0;

  const imageBase = exports.get_image_base() >>> 0;
  const guestBase = exports.get_guest_base ? (exports.get_guest_base() >>> 0) : 0x12000;
  const mem = new Uint8Array(memoryBuffer);
  const hex = (n) => '0x' + (n >>> 0).toString(16).padStart(8, '0');
  let applied = 0;

  for (const patch of patches) {
    if (enabledKeys && !enabledKeys.has(patch.key)) continue;
    const wa = (((patch.addr >>> 0) - imageBase + guestBase) >>> 0);
    if (wa + patch.expected.length > mem.length ||
        patch.expected.length !== patch.replacement.length) {
      warn(`[compat] cannot patch ${patch.label}: address out of range`);
      continue;
    }
    let ok = true;
    for (let i = 0; i < patch.expected.length; i++) {
      if (mem[wa + i] !== patch.expected[i]) {
        warn(`[compat] cannot patch ${patch.label}: unexpected byte at ${hex(patch.addr + i)}`);
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    mem.set(patch.replacement, wa);
    log(`[compat] patched ${patch.label} at ${hex(patch.addr)}`);
    applied++;
  }
  return applied;
}

// Named uniquely: the browser loads this as a classic script beside the other
// lib/ files, and two top-level `const api` would be a SyntaxError.
const appProfilesApi = {
  EXE_PATCHES, applyExeCompatibilityPatches, THREAD_EXIT_HOOKS, onThreadExit,
};

if (typeof module !== 'undefined' && module.exports) module.exports = appProfilesApi;
if (typeof window !== 'undefined') window.appProfiles = appProfilesApi;
