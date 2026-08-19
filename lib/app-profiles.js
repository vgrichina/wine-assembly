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
const appProfilesApi = { EXE_PATCHES, applyExeCompatibilityPatches };

if (typeof module !== 'undefined' && module.exports) module.exports = appProfilesApi;
if (typeof window !== 'undefined') window.appProfiles = appProfilesApi;
