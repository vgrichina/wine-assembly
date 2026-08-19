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
      `(buffer is ${cap}); the tail is appended data, read via the VFS`);
  }
  new Uint8Array(memoryBuffer).set(exeBytes.subarray(0, staged), staging);
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

// Named uniquely: the browser loads this as a classic script beside
// lib/dll-registry.js, and two top-level `const api` would be a SyntaxError.
const processBootApi = { resolveDllGraph, stageAndLoadPe, setExeName, setExtraCmdline };

if (typeof module !== 'undefined' && module.exports) module.exports = processBootApi;
if (typeof window !== 'undefined') window.processBoot = processBootApi;
