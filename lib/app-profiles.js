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

// The fixed memory map, generated from the `region.declare-fixed` forms in
// src/00-regions.wat (docs/watx-region-safety-design.md §6). Both g2w helpers
// below prefer the instance's own get_guest_base(); the fallback for an
// instance that predates that export now reads $GUEST_BASE instead of retyping
// it. `var _regionMap`, not a top-level `const`: in the browser these lib/
// files are classic scripts sharing one global lexical scope (the same reason
// the export object at the bottom of this file is not called `api`).
var _regionMap = typeof require !== 'undefined' ? require('./region-map.generated')
  : (typeof self !== 'undefined' ? self.RegionMap : globalThis.RegionMap);

'use strict';

// exe name (lowercase) -> patches applied right after load_pe.
const EXE_PATCHES = {
  // War Wind 1.0 (Strategic Simulations, ww.exe SHA-256
  // f2b291551d943035d2cdd5dc6115dc15edd0f17b3eed70b82bb5101a91b743b7).
  //
  // Its streaming thread locks the current DirectSound buffer, fills it, then
  // reloads the shared buffer pointer before Unlock. Teardown clears that
  // pointer after the Lock has succeeded, so a preemption during the fill can
  // resume at an indirect call through NULL. Use the still-live `this` value
  // left by the matching Lock call in this function's stack frame. This keeps
  // the original synchronization and changes only which copy of the same COM
  // pointer supplies Unlock.
  'ww.exe': [
    {
      key: 'warwind-audio-unlock-locked-buffer',
      addr: 0x00410a9d,
      expected: [0xa1, 0x74, 0x2d, 0x4b, 0x00],
      replacement: [0x8b, 0x44, 0x24, 0xec, 0x90],
      label: 'War Wind audio worker unlocks its successfully locked buffer',
    },
  ],
  // Caesar III demo (Sierra/Impressions, c3.exe SHA-256
  // d7c73f21d3837b1fc465a6035f4fea6ab5a7eddf62907c72c4dd076a5193d236).
  //
  // The new-career screen copies "The new governor" into its 32-byte player
  // name buffer, then starts keyboard capture with cursor position zero and
  // overwrite mode enabled. A short name therefore retains the untouched
  // suffix (typing "Codex" produces "Codexew governor"). Skip only that one
  // default-name copy and clear that 32-byte buffer so the real game's input
  // routine receives empty, terminated storage; the original installer-
  // produced executable remains unchanged on disk and every later name/save
  // input path keeps its native behavior.
  'c3.exe': [
    {
      key: 'caesar3-empty-new-governor-name',
      addr: 0x0041607d,
      expected: [
        0xa1, 0xf0, 0xf3, 0x6b, 0x00, 0x50, 0x68, 0x3c, 0xeb, 0x57,
        0x00, 0xe8, 0x63, 0xf6, 0x0d, 0x00, 0x83, 0xc4, 0x08,
      ],
      replacement: [
        0x57, 0xbf, 0x3c, 0xeb, 0x57, 0x00, 0x31, 0xc0, 0xb9, 0x08,
        0x00, 0x00, 0x00, 0xf3, 0xab, 0x5f, 0x90, 0x90, 0x90,
      ],
      label: 'Caesar III new-career name buffer starts empty',
    },
  ],
  // Both official playable Baldur's Gate previews run their Infinity Engine state
  // transition handlers synchronously.  The handlers set a request flag and
  // then wait for the outer game loop to clear it, but that outer loop cannot
  // run while a cooperative guest is still inside the handler.  Jumping over
  // only the two verified wait loops returns control to the outer loop, which
  // then performs the requested character-generation / area transition.
  'bgdemo.exe': [
    {
      key: 'bgdemo-new-game-transition',
      addr: 0x0058c6d6,
      expected: [0xa1, 0xf0, 0xcb, 0x89, 0x00],
      replacement: [0xe9, 0x33, 0x00, 0x00, 0x00],
      label: 'Baldur interactive demo New Game transition wait',
    },
    {
      key: 'bgdemo-area-transition',
      addr: 0x005876d3,
      expected: [0x8b, 0x15, 0xf0, 0xcb, 0x89, 0x00],
      replacement: [0xe9, 0x33, 0x00, 0x00, 0x00, 0x90],
      label: 'Baldur interactive demo area transition wait',
    },
  ],
  'bgmain.exe': [
    {
      key: 'bgmain-new-game-transition',
      addr: 0x00599576,
      expected: [0x8b, 0x15, 0xe0, 0xb6, 0x8c],
      replacement: [0xe9, 0x33, 0x00, 0x00, 0x00],
      label: 'Baldur Chapters I & II New Game transition wait',
    },
    {
      key: 'bgmain-area-transition',
      addr: 0x00593bd4,
      expected: [0x8b, 0x15, 0xe0, 0xb6, 0x8c],
      replacement: [0xe9, 0x33, 0x00, 0x00, 0x00],
      label: 'Baldur Chapters I & II area transition wait',
    },
  ],
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
  // Roller Coaster Tycoon (shareware demo, English/RCT.exe).
  //
  // Changing the video mode from inside the game leaves most of the screen
  // black, with only the blocks whose content changes ever redrawing.
  //
  // RCT's mode-change callers do:
  //     call 0x9024b4      ; video_init ladder -- REALLOCATES the screen buffer
  //     mov dword [0x560184], 0
  //     call 0x9029f5      ; "did the geometry change?"
  // and 0x9029f5 only reaches the resize-and-invalidate-everything block at
  // 0x902acb (which ends in `rep stosb 0xff` over the dirty grid at 0x8e1da3)
  // when the new width/height differ from the cached ones at 0x8b8f1a..0x8b8f20,
  // or when the "cached geometry is valid" byte at 0x8b8f30 is not 1.
  //
  // On this host the geometry very often does NOT change: the fullscreen mode
  // equals the host screen by construction (see LAUNCH_PREFS below), the
  // windowed buffer is desktop-sized too, and an unavailable mode (1024x768 on
  // an 800x600 host) walks back down the ladder and re-achieves the size it
  // already had. So every one of those transitions reallocates the buffer and
  // then decides nothing needs redrawing -- the new buffer is never painted,
  // and the old, fully-drawn one is simply dropped.
  //
  // Clearing 0x8b8f30 instead of the (write-only-here) mode-change request
  // word makes the very next call unconditionally take the 0x902acb path.
  // 0x560184's only reader is the frame path at 0x902a18, where a stale 1
  // merely repeats the mode change -- which invalidates everything as well.
  'rct.exe': [
    {
      key: 'rct-modechange-invalidate-options',
      addr: 0x0045268d,
      expected: [0xc7, 0x05, 0x84, 0x01, 0x56, 0x00, 0x00, 0x00, 0x00, 0x00],
      replacement: [0xc6, 0x05, 0x30, 0x8f, 0x8b, 0x00, 0x00, 0x90, 0x90, 0x90],
      label: 'RCT Options video-mode change invalidates cached geometry',
    },
    {
      key: 'rct-modechange-invalidate-hotkey',
      addr: 0x0042d2d3,
      expected: [0xc7, 0x05, 0x84, 0x01, 0x56, 0x00, 0x00, 0x00, 0x00, 0x00],
      replacement: [0xc6, 0x05, 0x30, 0x8f, 0x8b, 0x00, 0x00, 0x90, 0x90, 0x90],
      label: 'RCT in-game video-mode change invalidates cached geometry',
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
  const guestBase = exports.get_guest_base ? (exports.get_guest_base() >>> 0) : _regionMap.GUEST_BASE;
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

// The verify-then-write loop both tables share. A patch whose `expected`
// bytes are not there is reported and skipped, so a differently-built binary
// of the same name is left intact instead of silently corrupted.
function applyBytePatches(patches, exports, memoryBuffer, opts) {
  const {
    tag = 'compat',
    verb = 'patched',
    enabledKeys = null,
    log = (m) => console.log(m),
    warn = (m) => console.warn(m),
  } = opts || {};
  if (!patches || !patches.length) return 0;
  if (!exports || !exports.get_image_base || !memoryBuffer) return 0;

  const imageBase = exports.get_image_base() >>> 0;
  const guestBase = exports.get_guest_base ? (exports.get_guest_base() >>> 0) : _regionMap.GUEST_BASE;
  const mem = new Uint8Array(memoryBuffer);
  const hex = (n) => '0x' + (n >>> 0).toString(16).padStart(8, '0');
  let applied = 0;

  for (const patch of patches) {
    if (enabledKeys && !enabledKeys.has(patch.key)) continue;
    const wa = (((patch.addr >>> 0) - imageBase + guestBase) >>> 0);
    if (wa + patch.expected.length > mem.length ||
        patch.expected.length !== patch.replacement.length) {
      warn(`[${tag}] cannot ${verb} ${patch.label}: address out of range`);
      continue;
    }
    let ok = true;
    for (let i = 0; i < patch.expected.length; i++) {
      if (mem[wa + i] !== patch.expected[i]) {
        warn(`[${tag}] cannot ${verb} ${patch.label}: unexpected byte at ${hex(patch.addr + i)}`);
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    mem.set(patch.replacement, wa);
    log(`[${tag}] ${verb} ${patch.label} at ${hex(patch.addr)}`);
    applied++;
  }
  return applied;
}

// opts.enabledKeys — Set of patch keys to apply (null = all), from the CLI's
//                    WA_EXE_COMPAT_PATCHES; opts.skip disables the lot.
function applyExeCompatibilityPatches(exeName, exports, memoryBuffer, opts) {
  const { skip = false } = opts || {};
  if (skip) return 0;
  return applyBytePatches(
    EXE_PATCHES[String(exeName || '').toLowerCase()], exports, memoryBuffer,
    Object.assign({ tag: 'compat', verb: 'patched' }, opts || {}));
}

// exe name (lowercase) -> a function of the host screen size returning the
// pokes that pre-set the app's *own* stored preferences before it reads them.
//
// This is not a compatibility patch: nothing is being worked around, we are
// choosing the default the user would have chosen in the app's own options
// dialog if they had opened it. A DOS-era game stores that choice wherever it
// likes, so the hook is per-app JS rather than a setting we could name
// generically — but it is still declarative (verified byte pokes), so a
// differently-built binary of the same name is detected and left alone.
//
// Each entry is `(env) => [patch, ...]` with env = { screenW, screenH }, and
// each patch is the same {addr, expected, replacement, label} shape the compat
// table uses. Addresses are specific to the exact binary in lib/apps.js — say
// which one in the comment.
// Empty on purpose. RollerCoaster Tycoon used to have an entry here that
// pre-set its startup video mode (one byte at 0x56fd6b: 0 = windowed 640x480,
// 1 = fullscreen 640x480, 2 = 800x600, 3 = 1024x768, 0xFF = never chosen) from
// the size of the canvas it was about to run on. It was removed 2026-08-26
// because it broke the app in every ordinary browser window.
//
// Measured with test/run.js --batch-size=200000, one variable per run:
//
//     --screen 640x480   -> mode 1   runs, renders
//     --screen 800x600   -> mode 2   runs, renders
//     --screen 1280x872  -> mode 3   CRASH at batch 4436
//     --screen 1280x872, WA_SKIP_LAUNCH_PREFS=1   5200 batches, renders
//
// The last line is what convicts the poke rather than the desktop size: same
// 1280x872 canvas, RCT's own default mode, no crash. Since the pick was driven
// by canvas size, every window at least 1024x768 -- most of them -- selected
// mode 3, so RCT died at startup behind its own "GSK Error Trapper" dialog for
// essentially every visitor, while the CLI's 640x480 default desktop picked
// mode 1 and looked perfectly healthy. That is why it survived review.
//
// The crash itself is ours and is still open: marker 0xCA002E20 ("execution
// entered zeros"), the guest RETs at 0x407165 into string data, and ESP by then
// points into the emulator's own threaded-code region -- the stack pointer is
// gone, not just one return address. Choosing 1024x768 from RCT's own Display
// Mode dropdown still reaches it. Fix that before pre-selecting any mode again.
//
// The reasoning that justified the poke is worth keeping precisely because it
// sounds right: RCT's mode ladder at 0x9024b4 walks *down* on failure, so an
// optimistic value looked free -- worst case the 640x480 we would have got
// anyway. It is not free when the mode does not fail cleanly but corrupts the
// guest instead.
const LAUNCH_PREFS = {};

// screen = { width, height } of the surface the guest will draw on (the
// renderer canvas), which is what decides the resolution an app should default
// to. Called right after load_pe, alongside the compatibility patches.
//
// opts.hook overrides the table: a `launchPrefs` function on the lib/apps.js
// entry, so an app can carry its own preferences in the manifest beside its
// file list. The table above is the fallback, keyed by exe name so it still
// applies to a bare `--exe=` run with no registry entry.
function applyLaunchPreferences(exeName, exports, memoryBuffer, opts) {
  const { screen = null, skip = false, hook = null } = opts || {};
  if (skip) return 0;
  const pick = typeof hook === 'function'
    ? hook : LAUNCH_PREFS[String(exeName || '').toLowerCase()];
  if (!pick) return 0;
  const screenW = (screen && screen.width) | 0 || 640;
  const screenH = (screen && screen.height) | 0 || 480;
  let patches;
  try {
    patches = pick({ screenW, screenH });
  } catch (e) {
    ((opts && opts.warn) || ((m) => console.warn(m)))(
      `[prefs] ${exeName} launch preferences threw: ${e && e.message}`);
    return 0;
  }
  return applyBytePatches(patches, exports, memoryBuffer,
    Object.assign({ tag: 'prefs', verb: 'set' }, opts || {}));
}

// Named uniquely: the browser loads this as a classic script beside the other
// lib/ files, and two top-level `const api` would be a SyntaxError.
const appProfilesApi = {
  EXE_PATCHES, applyExeCompatibilityPatches, THREAD_EXIT_HOOKS, onThreadExit,
  LAUNCH_PREFS, applyLaunchPreferences,
};

if (typeof module !== 'undefined' && module.exports) module.exports = appProfilesApi;
if (typeof window !== 'undefined') window.appProfiles = appProfilesApi;
