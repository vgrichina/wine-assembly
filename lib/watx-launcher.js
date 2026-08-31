// ═══════════════════════════════════════════════════════════════
// lib/watx-launcher.js — host side of the Milestone 4 compiler Worker.
//
// Reads the compiler and the src/main.watx include closure EXACTLY ONCE,
// hands the text to a disposable lib/watx-compile-worker.js, and always
// terminates that worker before returning. Nothing here touches Wine's
// memory, its instantiation or the renderer: the whole module is
// "source text in, validated wasm bytes out".
//
// It is deliberately NOT wired into host.js yet (host.js is peer-dirty at the
// time of writing). The wiring is one branch and is spelled out below.
//
// ───────────────────────────────────────────────────────────────
// EXACT host.js INTEGRATION DIFF (do this in a later, separate commit)
// ───────────────────────────────────────────────────────────────
//
// 1) index.html — load the launcher next to the other lib/ scripts, BEFORE
//    host.js (host.js reads `window.watxLauncher` at call time, so ordering
//    only has to be "before first Launch", but keep it with its peers):
//
//        <script src="lib/compile-wat.js"></script>
//      + <script src="lib/watx-launcher.js"></script>
//        <script src="host.js"></script>
//
// 2) host.js — inside `static getWasmModule()`, the ONLY branch that changes
//    is the source-compile fallback. Today (host.js ~line 1213):
//
//        const bytes = await compileWatSnapshot(
//          async file => {
//            const response = await fetch(`src/${file}?v=${WineAssembly.SOURCE_VERSION}`, fetchOptions);
//            if (!response.ok) throw new Error(`Unable to load ${file}: HTTP ${response.status}`);
//            return response.text();
//          },
//          { tailCalls, cacheKey: `${WineAssembly.SOURCE_VERSION}:browser:${attempt}` }
//        );
//        return WebAssembly.compile(bytes);
//
//    becomes:
//
//        // Legacy A/B switch stays for the whole migration: ?compile-wat
//        // still forces a source build, and ?legacy-compiler picks the old
//        // in-page compiler instead of the WATX Worker.
//        const useLegacyCompiler = typeof location !== 'undefined' &&
//          new URLSearchParams(location.search).has('legacy-compiler');
//        if (!useLegacyCompiler && typeof window !== 'undefined' && window.watxLauncher) {
//          const bytes = await window.watxLauncher.compile({
//            tailCalls,
//            version: WineAssembly.SOURCE_VERSION,
//            noStore: debugFetch,
//          });
//          // The Worker is already terminated here (compile() does it in a
//          // finally), so its heap is gone BEFORE init() allocates the
//          // 8192-page shared memory. Do not move this call later.
//          return WebAssembly.compile(bytes);
//        }
//        const bytes = await compileWatSnapshot(  // ...unchanged legacy path
//          ...
//        );
//        return WebAssembly.compile(bytes);
//
//    NOTHING ELSE in host.js changes. In particular:
//      - the artifact-first branch above it is untouched (default launch still
//        fetches build/wine-assembly[.compat].wasm and never compiles);
//      - `?compile-wat` keeps its current meaning (force a source build);
//      - the existing failed-promise reset at the bottom of getWasmModule()
//        (`WineAssembly._wasmModulePromise = null` in the .catch) still covers
//        a failed WATX build, and this module keeps its OWN parallel reset so
//        a caller other than host.js gets the same guarantee;
//      - `_wasmCompileAttempt` no longer needs to feed a cache key — the key
//        here is content-addressed (see cacheKey() below), so a changed source
//        invalidates it by construction rather than by an attempt counter.
//
// 3) Nothing to add to lib/apps.js. Nothing to add to tools/build.sh: this
//    path only runs in a browser that was asked to compile from source.
//
// ───────────────────────────────────────────────────────────────
// CACHE KEY
// ───────────────────────────────────────────────────────────────
// The plan requires a key that is not just SOURCE_VERSION:
//
//     key = 'watx1:' + sha256(compiler files, in load order, name+text)
//                    + ':' + sha256(manifest + every source, name+text)
//                    + ':' + (tailCalls ? 'tail' : 'compat')
//
// so a vendored-compiler bump, a source edit, a manifest reorder or a
// different dispatch mode each produce a different key. `cacheKey()` is pure
// and exported for tests; this module does not itself persist anything to
// CacheStorage/IndexedDB — that is Milestone 5's decision — it only supplies
// the key any such store must use.
//
// ───────────────────────────────────────────────────────────────
// FAILED-PROMISE RESET
// ───────────────────────────────────────────────────────────────
// `compile()` memoises the in-flight promise per cache key so two Launch
// clicks share one Worker. If that promise rejects, the entry is deleted in a
// .catch, exactly like host.js does for _wasmModulePromise: one transient
// fetch failure or one bad intermediate source save must not poison every
// later Launch for the lifetime of the page.
// ═══════════════════════════════════════════════════════════════

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.watxLauncher = api;
  else if (typeof self !== 'undefined' && typeof window === 'undefined' && !root) self.watxLauncher = api;
})(typeof module !== 'undefined' && module.exports, function () {
  'use strict';

  const isNode = typeof process !== 'undefined' && process.versions &&
    process.versions.node && typeof require === 'function';

  // The four vendored compiler stages, in load order. This list is the same
  // one tools/watx.js uses; keep them in sync (tools/check-watx-provenance.js
  // is the gate that notices if the file set changes at all).
  const COMPILER_FILES = [
    'tools/watx-src/compiler-parser.js',
    'tools/watx-src/compiler-stages.js',
    'tools/watx-src/compiler-codegen.js',
    'tools/watx-src/compiler.js',
  ];

  const ENTRY = 'src/main.watx';
  const WORKER_PATH = 'lib/watx-compile-worker.js';
  const SEP = String.fromCharCode(32); // one space, in the hashed "name <sha>" line

  // ---------------------------------------------------------------
  // sha256 → lowercase hex. Browser: crypto.subtle (async, needs a secure
  // context — which host.js already requires for SharedArrayBuffer anyway).
  // Node: require('crypto').
  // ---------------------------------------------------------------
  async function sha256Hex(text) {
    if (isNode) {
      return require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');
    }
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ---------------------------------------------------------------
  // The include manifest. Derived from src/main.watx itself so this module
  // cannot drift from the one authoritative source order (Milestone 2.1).
  // A comment line is ignored; `(include "name")` is the only form.
  // ---------------------------------------------------------------
  function parseIncludes(mainWatxText) {
    const names = [];
    for (const rawLine of String(mainWatxText).split('\n')) {
      const line = rawLine.replace(/;;.*$/, '');
      const m = /\(\s*include\s+"([^"]+)"\s*\)/.exec(line);
      if (m) names.push(m[1]);
    }
    if (!names.length) throw new Error('watx-launcher: src/main.watx declared no (include ...) forms');
    return names;
  }

  // ---------------------------------------------------------------
  // fetchSources() — reads everything, once.
  //
  // Returns { compiler: [{name,text}], entry: text, sources: {name:text},
  //           manifest: [name], bytes: <total source bytes> }
  //
  // Browser: fetch, with the same `?v=` + no-store treatment host.js gives
  // the artifact. Node: fs, relative to the repo root.
  //
  // "Exactly once" is the plan's fetch-once rule: the compiler's two passes
  // read from this snapshot, never from the network, so they cannot observe
  // two revisions of one file.
  // ---------------------------------------------------------------
  async function fetchSources(options = {}) {
    const read = options.read || defaultReader(options);
    const compiler = [];
    for (const name of COMPILER_FILES) compiler.push({ name, text: await read(name) });
    const entry = await read(ENTRY);
    const manifest = parseIncludes(entry);
    const sources = {};
    // Sequential on purpose in node (fs is cheap and this keeps peak RSS
    // attributable); parallel in the browser where each is a network trip.
    if (isNode) {
      for (const name of manifest) sources[name] = await read('src/' + name);
    } else {
      const texts = await Promise.all(manifest.map(name => read('src/' + name)));
      manifest.forEach((name, i) => { sources[name] = texts[i]; });
    }
    let bytes = entry.length;
    for (const name of manifest) bytes += sources[name].length;
    return { compiler, entry, sources, manifest, bytes };
  }

  function defaultReader(options) {
    if (isNode) {
      const fs = require('fs');
      const path = require('path');
      const rootDir = options.root || path.join(__dirname, '..');
      return async name => fs.readFileSync(path.join(rootDir, name), 'utf8');
    }
    const version = options.version != null ? String(options.version) : null;
    const fetchOptions = options.noStore ? { cache: 'no-store' } : undefined;
    const base = options.base || '';
    return async name => {
      const url = base + name + (version ? `?v=${encodeURIComponent(version)}` : '');
      const response = await fetch(url, fetchOptions);
      if (!response.ok) throw new Error(`Unable to load ${name}: HTTP ${response.status}`);
      return response.text();
    };
  }

  // ---------------------------------------------------------------
  // cacheKey(snapshot, mode) — see header. Pure; safe to call in a test.
  // ---------------------------------------------------------------
  // ---------------------------------------------------------------
  // cacheKey(snapshot, mode) — see header. Pure; safe to call in a test.
  //
  // Deliberately a digest-of-digests rather than one hash over a concatenated
  // blob: concatenating the closure builds an 11 MB temporary string (22 MB as
  // UTF-16), and a phase probe measured that at ~35 MB of extra RSS on the one
  // path whose peak memory is the plan's open cutover gate. Hashing each file
  // and then hashing the list of digests is the same content-addressing with a
  // bounded temporary. Names are in the digest, so a rename is a key change.
  // ---------------------------------------------------------------
  async function hashFileList(files) {
    const lines = [];
    for (const f of files) lines.push(f.name + SEP + (await sha256Hex(f.text)));
    return sha256Hex(lines.join('\n'));
  }

  async function cacheKey(snapshot, mode = {}) {
    const compilerHash = await hashFileList(snapshot.compiler);
    const sourceHash = await hashFileList(
      [{ name: ENTRY, text: snapshot.entry }].concat(
        snapshot.manifest.map(n => ({ name: n, text: snapshot.sources[n] }))));
    const modeTag = mode.tailCalls === false ? 'compat' : 'tail';
    return `watx1:${compilerHash}:${sourceHash}:${modeTag}`;
  }

  // ---------------------------------------------------------------
  // spawn + drive + ALWAYS terminate.
  // ---------------------------------------------------------------
  function runWorker(snapshot, mode, options) {
    const message = {
      type: 'compile',
      compiler: snapshot.compiler,
      entry: snapshot.entry,
      sources: snapshot.sources,
      mode: { tailCalls: mode.tailCalls !== false },
      validate: options.validate !== false,
    };
    return isNode ? runNodeWorker(message, options) : runBrowserWorker(message, options);
  }

  function runNodeWorker(message, options) {
    const path = require('path');
    const { Worker } = require('worker_threads');
    const rootDir = options.root || path.join(__dirname, '..');
    const worker = new Worker(path.join(rootDir, WORKER_PATH), {
      resourceLimits: options.resourceLimits || undefined,
    });
    let exited = false;
    const exitPromise = new Promise(resolve => worker.once('exit', code => {
      exited = true; resolve(code);
    }));
    const result = new Promise((resolve, reject) => {
      const timer = options.timeoutMs
        ? setTimeout(() => reject(new Error(`watx compile worker timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
        : null;
      worker.on('message', msg => {
        if (!msg || msg.type === 'ready') return;
        if (timer) clearTimeout(timer);
        resolve(msg);
      });
      worker.on('error', err => { if (timer) clearTimeout(timer); reject(err); });
      worker.on('exit', code => {
        if (timer) clearTimeout(timer);
        reject(new Error(`watx compile worker exited early with code ${code}`));
      });
      worker.postMessage(message);
    });
    return { worker, result, exitPromise, hasExited: () => exited, terminate: () => worker.terminate() };
  }

  function runBrowserWorker(message, options) {
    const worker = new Worker(options.workerUrl || WORKER_PATH);
    const result = new Promise((resolve, reject) => {
      const timer = options.timeoutMs
        ? setTimeout(() => reject(new Error(`watx compile worker timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
        : null;
      worker.onmessage = e => {
        const msg = e.data;
        if (!msg || msg.type === 'ready') return;
        if (timer) clearTimeout(timer);
        resolve(msg);
      };
      worker.onerror = err => {
        if (timer) clearTimeout(timer);
        reject(new Error(`watx compile worker error: ${err.message || err}`));
      };
      worker.postMessage(message);
    });
    return {
      worker, result,
      exitPromise: Promise.resolve(0),
      hasExited: () => true,
      terminate: () => { worker.terminate(); return Promise.resolve(); },
    };
  }

  // ---------------------------------------------------------------
  // compile(mode) — the one call host.js makes.
  //
  // Resolves with a Uint8Array of validated wasm. The Worker is terminated in
  // a `finally` on every path, so by the time this promise settles the
  // compiler's heap is releasable and Wine's 512 MB shared memory can be
  // allocated next.
  //
  // `compileDetailed()` is the same thing but resolves with the full worker
  // report (timings, memory readings, warnings) — that is what the M4
  // measurement harness and the test use.
  // ---------------------------------------------------------------
  const inFlight = new Map();

  async function compileDetailed(mode = {}, options = {}) {
    const snapshot = options.snapshot || await fetchSources(options);
    const key = await cacheKey(snapshot, mode);
    if (!options.noMemo && inFlight.has(key)) return inFlight.get(key);

    const started = Date.now();
    const promise = (async () => {
      const handle = runWorker(snapshot, mode, options);
      // Test hook: lets a caller observe the worker's lifetime (and prove it
      // really exited) without reaching into this module's internals.
      if (options.onWorker) options.onWorker(handle);
      try {
        const report = await handle.result;
        if (!report.ok) {
          const e = new Error(report.error || 'watx compile failed');
          e.stage = report.stage;
          e.line = report.line;
          e.col = report.col;
          e.logs = report.logs;
          throw e;
        }
        return {
          bytes: report.bytes instanceof Uint8Array ? report.bytes : new Uint8Array(report.bytes),
          byteLength: report.byteLength,
          valid: report.valid,
          warnings: report.warnings || [],
          logs: report.logs || [],
          timing: report.timing,
          memory: report.memory,
          cacheKey: key,
          sourceBytes: snapshot.bytes,
          wallMs: Date.now() - started,
        };
      } finally {
        // Unconditional. A rejected compile leaks a live Worker otherwise, and
        // in the browser that Worker still holds the whole 10 MB source
        // snapshot plus the compiler heap while Wine tries to take 512 MB.
        try { await handle.terminate(); } catch (_) { /* already gone */ }
      }
    })();

    if (!options.noMemo) {
      inFlight.set(key, promise);
      // FAILED-PROMISE RESET (see header): drop the memo on rejection so a
      // transient failure does not poison every later Launch.
      promise.catch(() => { if (inFlight.get(key) === promise) inFlight.delete(key); });
    }
    return promise;
  }

  async function compile(mode = {}, options = {}) {
    const result = await compileDetailed(mode, options);
    return result.bytes;
  }

  return {
    COMPILER_FILES, ENTRY, WORKER_PATH,
    fetchSources, parseIncludes, cacheKey, sha256Hex,
    compile, compileDetailed,
    // Test hooks.
    _inFlight: inFlight,
    _reset: () => inFlight.clear(),
  };
});
