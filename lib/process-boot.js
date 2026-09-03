// Shared process boot steps for both hosts (CLI test/run.js and browser index.html).
//
// The DLL set an app needs was worked out twice, and the two answers differed:
// the CLI walked the whole dependency graph (Kodak Imaging's IMGCMN imports
// OIFIL400, which imports its siblings), while the browser resolved only the
// EXE's own import directory. An app therefore booted headless and trapped in
// the browser on the first cross-DLL ordinal, with neither host saying why.
//
// Both hosts now call resolveDllGraph() and supply only a `loadSpec` callback
// that turns a name (or a host-specific spec such as a URL or file path) into
// { name, bytes } — fs.readFileSync over the search dirs for the CLI, fetch()
// over lib/dll-registry.js's URL map for the browser.

'use strict';

const dllReg = (typeof require === 'function')
  ? require('./dll-registry')
  : (typeof window !== 'undefined' ? window.dllRegistry : null);

// seeds       — host-specific specs to load first, in order, whatever the
//               EXE's imports say (the browser's per-app `dlls` list, which
//               carries app-local DLLs the registry cannot name).
// loadSpec    — async (spec) => { name, bytes } | null. Returning null means
//               "not shipped here", and the walk simply skips it.
// isLoadable  — (name) => bool; defaults to the shared registry's list, which
//               is what separates "load this as a real PE" from "let the WAT
//               stub handlers answer for it".
async function resolveDllGraph(opts) {
  const {
    exeBytes = null,
    seeds = [],
    loadSpec,
    detectRequiredDlls,
    isLoadable = (dllReg && dllReg.isLoadableDll) || (() => true),
    onLog = null,
  } = opts || {};

  const configs = [];
  const queued = new Set();
  const queue = [];

  const depsOf = (bytes) => {
    if (!detectRequiredDlls || !bytes) return [];
    try { return detectRequiredDlls(bytes) || []; } catch (_) {
      // A DLL we cannot parse simply contributes no dependencies.
      return [];
    }
  };

  const take = async (spec, { checkLoadable }) => {
    const nameHint = String(spec).split(/[\\/]/).pop();
    if (queued.has(nameHint.toLowerCase())) return;
    if (checkLoadable && !isLoadable(nameHint)) return;
    let cfg = null;
    try { cfg = await loadSpec(spec); } catch (e) {
      if (onLog) onLog(`DLL ${nameHint}: ${e && e.message ? e.message : e}`);
      return;
    }
    if (!cfg || !cfg.bytes) return;
    const key = String(cfg.name || nameHint).toLowerCase();
    if (queued.has(key)) return;
    queued.add(key);
    queued.add(nameHint.toLowerCase());
    configs.push(cfg);
    for (const dep of depsOf(cfg.bytes)) {
      if (!queued.has(String(dep).toLowerCase())) queue.push(dep);
    }
  };

  for (const seed of seeds) await take(seed, { checkLoadable: false });

  const required = depsOf(exeBytes);
  if (required.length && onLog) onLog(`Detected DLLs: ${required.join(', ')}`);
  // Old MFC builds import their matching CRT during DllMain, so msvcrt20 has
  // to come first even when the import directory lists MFC first.
  const ordered = dllReg && dllReg.orderDlls ? dllReg.orderDlls(required) : [...required];
  queue.push(...ordered);

  while (queue.length) await take(queue.shift(), { checkLoadable: true });

  return configs;
}

// A loaded module is also a file in an installed Windows tree. Keep the
// authentic bytes visible at both the app-directory compatibility alias and
// the Win9x system directory so SearchPath/CreateFile/resource extraction can
// reopen the module after the PE loader has mapped it.
function mountLoadedDllFiles(vfs, configs) {
  if (!vfs || !vfs.files) return 0;
  let mounted = 0;
  for (const config of configs || []) {
    if (!config || !config.name || !config.bytes) continue;
    const name = String(config.name).split(/[\\/]/).pop().toLowerCase();
    const entry = { data: config.bytes, attrs: 0x20 };
    vfs.files.set('c:\\' + name, entry);
    vfs.files.set('c:\\windows\\system\\' + name, entry);
    mounted++;
  }
  return mounted;
}

// Copy the EXE into the staging buffer and hand it to the WAT loader.
//
// Self-extracting installers append their archive after the PE image, so the
// file can be far larger than the loader needs. The staging buffer sits below
// emulator-private tables — the API hash table among them — and an unbounded
// copy walks straight through them, after which every import resolves to
// api_id 0xFFFF and the app dies on its first call. Both hosts had their own
// transcription of that clamp.
function stageAndLoadPe(exports, memoryBuffer, exeBytes, log) {
  const say = log || ((m) => console.log(m));
  const staging = exports.get_staging();
  const cap = exports.get_staging_size();
  const staged = Math.min(exeBytes.length, cap);
  if (staged < exeBytes.length) {
    say(`[pe] staging ${staged} of ${exeBytes.length} bytes ` +
      `(buffer is ${cap}); mapping PE section tails directly`);
  }
  new Uint8Array(memoryBuffer).set(exeBytes.subarray(0, staged), staging);
  if (staged < exeBytes.length) {
    const pe = (typeof require === 'function')
      ? require('./pe')
      : (typeof window !== 'undefined' ? window.peLib : null);
    if (!pe || typeof pe.readPE !== 'function') {
      throw new Error('PE section reader is unavailable for an oversized executable');
    }
    const image = pe.readPE(exeBytes);
    const guestBase = exports.get_guest_base() >>> 0;
    const memory = new Uint8Array(memoryBuffer);
    let hydrated = 0;
    for (const section of image.sections) {
      // PointerToRawData=0 is BSS. Do not use the UDATA characteristic alone:
      // packers commonly combine CODE/IDATA/UDATA on one section that still
      // has real raw bytes, and the WAT loader maps those bytes as initialized.
      if (!section.rawOff || !section.rawSize) continue;
      const start = Math.max(staged, section.rawOff);
      const end = Math.min(exeBytes.length, section.rawOff + section.rawSize);
      if (end <= start) continue;
      const destination = guestBase + section.rva + (start - section.rawOff);
      if (destination < 0 || destination + (end - start) > memory.length) {
        throw new Error(`PE section ${section.name || '?'} exceeds guest image memory`);
      }
      memory.set(exeBytes.subarray(start, end), destination);
      hydrated += end - start;
    }
    say(`[pe] prehydrated ${hydrated} mapped section-tail bytes`);
  }
  const entry = exports.load_pe(staged) >>> 0;
  say('PE loaded. Entry: 0x' + entry.toString(16).padStart(8, '0'));
  return { entry, staged };
}

// The staging buffer doubles as scratch for these two: load_pe has already
// consumed it by the time either is called.
function writeToStaging(exports, memoryBuffer, text) {
  const bytes = new TextEncoder().encode(text);
  const staging = exports.get_staging();
  new Uint8Array(memoryBuffer).set(bytes, staging);
  return { off: staging, len: bytes.length };
}

function setExeName(exports, memoryBuffer, name) {
  if (!exports.set_exe_name) return;
  const { off, len } = writeToStaging(exports, memoryBuffer, name);
  exports.set_exe_name(off, len);
}

function setExtraCmdline(exports, memoryBuffer, args) {
  if (!exports.set_extra_cmdline || !args) return;
  const { off, len } = writeToStaging(exports, memoryBuffer, args);
  exports.set_extra_cmdline(off, len);
}

function setEnvironmentVariable(exports, memoryBuffer, name, value) {
  if (!exports.set_process_environment_a || !exports.get_staging) return false;
  name = String(name);
  if (!name || name.includes('\0') || name.includes('=')) {
    throw new Error(`invalid process environment name: ${JSON.stringify(name)}`);
  }
  if (value !== null && value !== undefined && String(value).includes('\0')) {
    throw new Error(`process environment value for ${name} contains NUL`);
  }
  const mem = new Uint8Array(memoryBuffer);
  const nameBytes = new TextEncoder().encode(name);
  const valueBytes = value === null || value === undefined
    ? null : new TextEncoder().encode(String(value));
  const nameGuest = exports.get_staging() >>> 0;
  const valueGuest = valueBytes ? nameGuest + nameBytes.length + 1 : 0;
  mem.set(nameBytes, nameGuest);
  mem[nameGuest + nameBytes.length] = 0;
  if (valueBytes) {
    mem.set(valueBytes, valueGuest);
    mem[valueGuest + valueBytes.length] = 0;
  }
  return !!exports.set_process_environment_a(nameGuest, valueGuest);
}

// Resolved on use, not at load: the browser loads these as classic scripts and
// the order of the <script> tags is not this file's business.
function dllLoader() {
  if (typeof require === 'function') return require('./dll-loader');
  return (typeof window !== 'undefined' && window.DllLoader) || null;
}

function dibLoader() {
  if (typeof require === 'function') return require('./dib');
  if (typeof window === 'undefined') return null;
  if (typeof window.extractBitmapBytes === 'function') return window;
  return window.dibLib || null;
}

function readGuestCString(memoryBuffer, wasmAddr, max) {
  const mem = new Uint8Array(memoryBuffer);
  const limit = max || 260;
  let out = '';
  for (let i = 0; i < limit; i++) {
    const ch = mem[wasmAddr + i];
    if (!ch) break;
    out += String.fromCharCode(ch);
  }
  return out;
}

// A DLL's bitmap resources are drawn by the host, not the guest, so both hosts
// keep a loadAddr -> { bitmapBytes } map on whatever object they call a context.
function registerDllBitmaps(host, fileName, bytes, loadAddr, say) {
  const dib = dibLoader();
  if (!host || !dib || typeof dib.extractBitmapBytes !== 'function') return;
  try {
    const bitmapBytes = dib.extractBitmapBytes(bytes);
    const count = Object.keys(bitmapBytes).length;
    if (!count) return;
    host.dllResources = host.dllResources || {};
    host.dllResources[loadAddr] = { bitmapBytes };
    say(`DLL resources: ${fileName} has ${count} bitmaps`);
  } catch (_) {}
}

// The LoadLibraryA yield (yield_reason=5). The WAT handler has already parked
// EIP/ESP; everything below is the same in both hosts except where the bytes
// come from, so that — and only that — is the callback.
//
// findDll(fileName, fullName) -> bytes | null | Promise of either.
// onLoaded({ result, fileName, bytes }) runs after the image is in memory and
// before its imports are patched: the CLI records the module base there so
// `module+0xVA` probes resolve, the browser remembers the bytes for a later
// LoadLibrary of the same name.
async function handleLoadLibraryYield(opts) {
  const { exports, memoryBuffer, findDll, resourceHost = null, onLoaded = null,
    advanceGuestTime = null, log = null, trace = null } = opts || {};
  const say = log || (() => {});
  const loader = dllLoader();
  const finish = (eax) => {
    if (exports.set_eax) exports.set_eax(eax);
    if (loader && loader.resumeAfterLoadLibraryYield) {
      loader.resumeAfterLoadLibraryYield(exports, memoryBuffer, trace);
    }
    if (exports.clear_yield) exports.clear_yield();
  };

  const nameWA = exports.get_loadlib_name ? exports.get_loadlib_name() >>> 0 : 0;
  const dllName = nameWA ? readGuestCString(memoryBuffer, nameWA) : '';
  const fileName = dllName.split('\\').pop().toLowerCase();
  if (!dllName) { finish(0); return null; }

  let bytes = null;
  try { bytes = await findDll(fileName, dllName); } catch (e) {
    say(`[LoadLibrary] ${fileName}: ${e && e.message ? e.message : e}`);
  }
  if (!bytes || !loader || !loader.loadDll) {
    say(`[LoadLibrary] DLL not found: ${fileName}`);
    finish(0);
    return null;
  }

  const image = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let result;
  try {
    result = loader.loadDll(exports, memoryBuffer, image, dllName);
  } catch (e) {
    say(`[LoadLibrary] load error: ${e && e.message ? e.message : e}`);
    finish(0);
    return null;
  }
  say(`[LoadLibrary] ${fileName} loaded at 0x${result.loadAddr.toString(16)}, ` +
    `dllMain=0x${(result.dllMain >>> 0).toString(16)}`);
  registerDllBitmaps(resourceHost, fileName, image, result.loadAddr, say);
  if (onLoaded) onLoaded({ result, fileName, bytes: image });
  if (loader.patchDllImports) {
    loader.patchDllImports(exports, memoryBuffer, [{ name: fileName, bytes: image }], [result], say);
  }
  // Clear the yield before DllMain: some DLLs (d3dxof's template registry) do
  // real work there, and callDllMain saves/restores EIP/ESP around it.
  if (exports.clear_yield) exports.clear_yield();
  if (result.dllMain && loader.callDllMain) {
    loader.callDllMain(exports, result.loadAddr, result.dllMain, say, { advanceGuestTime });
  }
  finish(result.loadAddr);
  return result;
}

// The COM DLL yield (yield_reason=3), raised when CoCreateInstance needs an
// in-proc server. Unlike LoadLibrary this does not resume the caller: clearing
// the yield re-enters the CoCreateInstance handler, which retries and now finds
// the class registered. Only the failure paths touch EAX/ESP.
async function handleComDllYield(opts) {
  const { exports, memoryBuffer, findDll, exeBytes = null, resourceHost = null,
    advanceGuestTime = null, log = null } = opts || {};
  const say = log || (() => {});
  const loader = dllLoader();
  const REGDB_E_CLASSNOTREG = 0x80040154;
  const E_FAIL = 0x80004005;
  // CoCreateInstance is a 5-argument stdcall; the handler yielded before its
  // own epilogue, so a failure has to drop the return address and the args.
  const failWith = (hr) => {
    if (exports.clear_yield) exports.clear_yield();
    exports.set_eax(hr);
    exports.set_esp(exports.get_esp() + 24);
  };

  const nameWA = exports.get_com_dll_name ? exports.get_com_dll_name() >>> 0 : 0;
  if (!nameWA) {
    say('[COM] yield but no pending DLL name');
    if (exports.clear_yield) exports.clear_yield();
    return null;
  }
  const dllName = readGuestCString(memoryBuffer, nameWA);
  const fileName = dllName.split('\\').pop().toLowerCase();
  say(`[COM] Loading DLL: ${fileName}`);

  let bytes = null;
  try { bytes = await findDll(fileName, dllName); } catch (e) {
    say(`[COM] ${fileName}: ${e && e.message ? e.message : e}`);
  }
  if (!bytes || !loader || !loader.loadDll) {
    say(`[COM] DLL not found: ${fileName}`);
    failWith(REGDB_E_CLASSNOTREG);
    return null;
  }

  const image = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    const result = loader.loadDll(exports, memoryBuffer, image, dllName);
    say(`[COM] DLL loaded at 0x${result.loadAddr.toString(16)}`);
    registerDllBitmaps(resourceHost, fileName, image, result.loadAddr, say);
    if (exeBytes && loader.patchExeImports) {
      loader.patchExeImports(exports, memoryBuffer, exeBytes, [{ name: fileName, bytes: image }], say);
    }
    if (result.dllMain && loader.callDllMain) {
      loader.callDllMain(exports, result.loadAddr, result.dllMain, say, { advanceGuestTime });
    }
    if (exports.clear_yield) exports.clear_yield();
    return result;
  } catch (e) {
    say(`[COM] DLL load error: ${e && e.message ? e.message : e}`);
    failWith(E_FAIL);
    return null;
  }
}

// Named uniquely: the browser loads this as a classic script beside
// lib/dll-registry.js, and two top-level `const api` would be a SyntaxError.
const processBootApi = {
  resolveDllGraph, mountLoadedDllFiles, stageAndLoadPe, setExeName, setExtraCmdline,
  setEnvironmentVariable,
  readGuestCString, registerDllBitmaps, handleLoadLibraryYield, handleComDllYield,
};

if (typeof module !== 'undefined' && module.exports) module.exports = processBootApi;
if (typeof window !== 'undefined') window.processBoot = processBootApi;
