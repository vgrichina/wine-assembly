// ═══════════════════════════════════════════════════════════════
// lib/watx-launcher.js — host side of the Milestone 4 compiler Worker.
//
// Reads the compiler and the src/main.watx include closure EXACTLY ONCE,
// hands the text to a disposable lib/watx-compile-worker.js, and always
// terminates that worker before returning. Nothing here touches Wine's
// memory, its instantiation or the renderer: the whole module is
// "source text in, validated wasm bytes out".
//
// ───────────────────────────────────────────────────────────────
// WHERE THIS IS WIRED IN
// ───────────────────────────────────────────────────────────────
// index.html loads this module before host.js, and `static getWasmModule()` in
// host.js uses it for the source-compile branch. That branch is not a fallback
// with a legacy path behind it any more: the in-page compileWatSnapshot route
// and its `?legacy-compiler` switch were RETIRED in a4210b60, because the src
// tree now spells region-symbolic operands that lib/compile-wat.js lowers to
// `unreachable` traps — that compiler would emit a module which fails
// validation, or worse, one that traps mid-app. With the launcher absent
// host.js throws and names the missing script rather than reaching for it.
//
// So the shape today is: default launch fetches build/wine-assembly[.compat]
// .wasm and never compiles; `?compile-wat` forces a source build through this
// module; there is no third option.
//
// host.js calls `compileDetailed()` rather than `compile()`, and the reason is
// not diagnostics. A source build places the regions from whatever
// src/00-regions.wat says right now, while lib/region-map.generated.js is a
// committed file only tools/build.sh regenerates, so the two halves of the
// memory map can disagree — and a disagreement does not fail, it draws a
// plausible wrong picture. `layout` carries the placement back so host.js can
// refuse the pair. See the note in lib/watx-compile-worker.js for why it is the
// placement and not a hash of it.
//
// The Worker is already terminated when either call resolves (both do it in a
// `finally`), so its heap is gone BEFORE init() allocates the 8192-page shared
// memory. Do not move the call later.
//
// Two things that follow from the cache key being content-addressed (see
// cacheKey() below): a changed source invalidates it by construction, so no
// attempt counter feeds it; and this module keeps its own failed-promise reset
// in parallel with host.js's, so a caller other than host.js gets the same
// guarantee that one transient failure does not poison every later compile.
//
// ───────────────────────────────────────────────────────────────
// THE SNAPSHOT IS BYTES, NOT STRINGS
// ───────────────────────────────────────────────────────────────
// Sources are read, held, hashed and handed over as UTF-8 `Uint8Array`s, and
// only become JS strings inside the Worker, one file at a time, at the moment
// the compiler needs them. Two separate costs are avoided by that:
//
//   1. a JS string is UTF-16, so 11.3 MB of ASCII source costs ~29 MB resident
//      in the parent; the same bytes cost 11.3 MB.
//   2. `postMessage` STRUCTURE-CLONES a string, so the whole snapshot used to
//      be resident on both sides for the entire compile. The bytes are posted
//      as transferable `ArrayBuffer`s instead, so the parent's copy is *moved*
//      into the Worker rather than duplicated.
//
// A transferred buffer is DETACHED in the sender, so ownership decides
// whether the parent hands over its own arrays or copies them, and
// `compileDetailed()` knows which case it is in:
//
//   - the caller supplied `options.snapshot`  → the caller owns it and will
//     compile it again in the other dispatch mode (the plumbing test drives
//     six compiles off one read), so `buildTransfer()` sends per-attempt
//     COPIES. The copies are bytes, so the transient still costs about a
//     third of what the clone cost, and the fetch-once rule holds because
//     nothing is ever re-read to recover a detached buffer.
//   - the launcher read the snapshot itself (host.js's path: `compile()` with
//     no snapshot) → nobody else can reach it, so its buffers are transferred
//     as they are and the extra 11 MB is never allocated at all.
//
// Measured on this box, interleaved A/B, whole-process max RSS over one cold
// compile: 253.6 → 226.1 MB with a supplied snapshot, and 250.8 → 214.6 MB on
// the host.js path (8/8 pairings in each). See
// docs/watx-migration-plan-m4-measurements.md §4.
//
// Nothing about the compiler's own interface moves: the Worker still calls
// `compile(entryText, vfsMapOfStrings, options)`.
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
  // Bytes <-> text. Every file in a snapshot is a UTF-8 Uint8Array; a string
  // is accepted anywhere one can appear (a hand-built snapshot in a test) and
  // encoded on the spot, so callers cannot get a silently different digest for
  // the same content.
  // ---------------------------------------------------------------
  function toBytes(value) {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return value;
    if (value && typeof value.byteLength === 'number') return new Uint8Array(value);
    throw new Error('watx-launcher: expected text or bytes, got ' + typeof value);
  }

  function toText(bytes) {
    return typeof bytes === 'string' ? bytes : new TextDecoder('utf-8').decode(bytes);
  }

  // A standalone ArrayBuffer holding a COPY of `value`. Standalone because a
  // transferred buffer is detached in the sender, and the snapshot has to
  // survive a second compile (see header).
  function toTransferable(value) {
    const bytes = toBytes(value);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  // ---------------------------------------------------------------
  // sha256 → lowercase hex, over the UTF-8 bytes. Prefer native crypto,
  // with a pure-JS browser fallback for LAN HTTP origins where SubtleCrypto is
  // unavailable. Compilation itself is useful there even though starting Wine
  // still needs a secure, cross-origin-isolated SharedArrayBuffer context.
  //
  // Hashing the bytes directly is the same digest the string form produced
  // (`update(text, 'utf8')` / `TextEncoder().encode(text)` were doing exactly
  // this encode first), so moving the snapshot to bytes does NOT change any
  // cache key — it only stops materialising a second full copy to hash.
  // ---------------------------------------------------------------
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256PureHex(input) {
    const msg = toBytes(input);
    const bitLen = msg.length * 8;
    const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
    padded.set(msg);
    padded[msg.length] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
    dv.setUint32(padded.length - 4, bitLen >>> 0, false);
    const h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let base = 0; base < padded.length; base += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(base + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + s1 + ch + K256[i] + w[i]) >>> 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    let out = '';
    for (let i = 0; i < h.length; i++) out += h[i].toString(16).padStart(8, '0');
    return out;
  }

  async function sha256Hex(input) {
    const bytes = toBytes(input);
    if (isNode) {
      return require('crypto').createHash('sha256').update(bytes).digest('hex');
    }
    const subtle = typeof crypto !== 'undefined' && crypto && crypto.subtle;
    if (!subtle) {
      const digest = sha256PureHex(bytes);
      // cacheKey hashes one bounded file at a time. Give rendering/I/O a turn
      // between those files; an `await` of the already-resolved async result
      // would only drain microtasks and can still monopolize a LAN-HTTP page.
      await yieldMainThread();
      return digest;
    }
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
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
  // Returns { compiler: [{name,bytes}], entryBytes, sources: {name:bytes},
  //           manifest: [name], bytes: <total source bytes> }
  //
  // Every file is UTF-8 bytes (see header). The entry is decoded once, right
  // here, only to parse its (include ...) manifest — it is ~4 KB and the text
  // is dropped again; the bytes are what is kept, hashed and handed over.
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
    for (const name of COMPILER_FILES) compiler.push({ name, bytes: toBytes(await read(name)) });
    const entryBytes = toBytes(await read(ENTRY));
    const manifest = parseIncludes(toText(entryBytes));
    const sources = {};
    // Sequential on purpose in node (fs is cheap and this keeps peak RSS
    // attributable); parallel in the browser where each is a network trip.
    if (isNode) {
      for (const name of manifest) sources[name] = toBytes(await read('src/' + name));
    } else {
      const blobs = await Promise.all(manifest.map(name => read('src/' + name)));
      manifest.forEach((name, i) => { sources[name] = toBytes(blobs[i]); });
    }
    let bytes = entryBytes.byteLength;
    for (const name of manifest) bytes += sources[name].byteLength;
    return { compiler, entryBytes, sources, manifest, bytes };
  }

  function defaultReader(options) {
    if (isNode) {
      const fs = require('fs');
      const path = require('path');
      const rootDir = options.root || path.join(__dirname, '..');
      // No encoding argument: a Buffer IS a Uint8Array, so this never builds
      // the UTF-16 string the snapshot used to hold.
      return async name => fs.readFileSync(path.join(rootDir, name));
    }
    const version = options.version != null ? String(options.version) : null;
    const fetchOptions = options.noStore ? { cache: 'no-store' } : undefined;
    const base = options.base || '';
    return async name => {
      const url = base + name + (version ? `?v=${encodeURIComponent(version)}` : '');
      const response = await fetch(url, fetchOptions);
      if (!response.ok) throw new Error(`Unable to load ${name}: HTTP ${response.status}`);
      // arrayBuffer(), not text(): the response is already UTF-8 bytes and
      // decoding it here would be the UTF-16 copy this path exists to avoid.
      return new Uint8Array(await response.arrayBuffer());
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
    // f.bytes is the normal case; f.text is accepted for a hand-built snapshot
    // and encoded by sha256Hex — either way the digest is over the same UTF-8.
    for (const f of files) lines.push(f.name + SEP + (await sha256Hex(f.bytes != null ? f.bytes : f.text)));
    return sha256Hex(lines.join('\n'));
  }

  async function cacheKey(snapshot, mode = {}) {
    const compilerHash = await hashFileList(snapshot.compiler);
    const sourceHash = await hashFileList(
      [{ name: ENTRY, bytes: snapshot.entryBytes, text: snapshot.entry }].concat(
        snapshot.manifest.map(n => ({ name: n, bytes: snapshot.sources[n] }))));
    const modeTag = mode.tailCalls === false ? 'compat' : 'tail';
    return `watx1:${compilerHash}:${sourceHash}:${modeTag}`;
  }

  // ---------------------------------------------------------------
  // spawn + drive + ALWAYS terminate.
  // ---------------------------------------------------------------
  // One transferable ArrayBuffer per file, in a fixed order the Worker walks:
  // the compiler stages in load order, then the entry, then the manifest. The
  // names travel as plain (tiny) strings; only the payload is transferred, and
  // the Worker nulls each slot as it decodes it, so the bytes are released
  // there file by file instead of all at the end.
  //
  // `consume` hands over the snapshot's OWN buffers instead of copies, which
  // detaches them here. It is only ever set when this module read the snapshot
  // for this one compile and no caller has a reference to it (see
  // compileDetailed) — the browser's whole-page path, where saving the extra
  // 11 MB transient matters most. A buffer that is not exactly one file's
  // bytes (a pooled node Buffer, a view into something larger) is copied even
  // then: transferring it would detach memory that is not ours.
  function ownBuffer(bytes) {
    return bytes instanceof Uint8Array && bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : null;
  }

  function buildTransfer(snapshot, consume) {
    const buffers = [];
    const push = value => {
      const own = consume ? ownBuffer(value) : null;
      buffers.push(own || toTransferable(value));
    };
    for (const f of snapshot.compiler) push(f.bytes != null ? f.bytes : f.text);
    push(snapshot.entryBytes != null ? snapshot.entryBytes : snapshot.entry);
    for (const name of snapshot.manifest) push(snapshot.sources[name]);
    return {
      compilerNames: snapshot.compiler.map(f => f.name),
      entryName: ENTRY,
      sourceNames: snapshot.manifest.slice(),
      buffers,
    };
  }

  function runWorker(snapshot, mode, options, consume) {
    const message = Object.assign({ type: 'compile' }, buildTransfer(snapshot, consume), {
      mode: { tailCalls: mode.tailCalls !== false },
      validate: options.validate !== false,
    });
    return isNode
      ? runNodeWorker(message, options, message.buffers)
      : runBrowserWorker(message, options, message.buffers);
  }

  function yieldMainThread() {
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
      return scheduler.yield();
    }
    if (typeof setImmediate === 'function') return new Promise(resolve => setImmediate(resolve));
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  // Cooperative fallback for callers that cannot or do not want to dedicate a
  // Worker. In a browser the compiler is evaluated in a disposable same-origin
  // iframe: its code and heap become collectible when terminate() removes that
  // realm, retaining the Worker's important "compiler gone before Wine memory"
  // property. Node uses the normal vendored loader and benefits from the same
  // compileAsync() checkpoints without paying for worker_threads startup.
  function runCooperative(snapshot, mode, options) {
    let frame = null;
    let terminated = false;
    const started = Date.now();
    const result = (async () => {
      let compiler;
      let sourceTextFromBytes;
      let RealmMap = Map;
      if (isNode) {
        const watx = require('../tools/watx.js');
        compiler = watx.compileAsync;
        sourceTextFromBytes = watx.sourceTextFromBytes;
      } else {
        if (typeof document === 'undefined') {
          throw new Error('watx cooperative compile needs a document or a Node environment');
        }
        frame = document.createElement('iframe');
        frame.style.display = 'none';
        frame.setAttribute('aria-hidden', 'true');
        document.documentElement.appendChild(frame);
        const realm = frame.contentWindow;
        const logs = [];
        realm.console = {
          log: (...a) => logs.push(a.join(' ')),
          warn: (...a) => logs.push(a.join(' ')),
          error: (...a) => logs.push(a.join(' ')),
        };
        for (const file of snapshot.compiler) {
          realm.eval(toText(file.bytes != null ? file.bytes : file.text) + '\n//# sourceURL=' + file.name);
        }
        if (typeof realm.compileAsync !== 'function') {
          throw new Error('watx compiler bundle defined no compileAsync()');
        }
        compiler = realm.compileAsync;
        sourceTextFromBytes = realm.watxSourceTextFromBytes;
        RealmMap = realm.Map;
      }

      const vfs = new RealmMap();
      const addSource = (name, text) => {
        vfs.set(name, text);
        vfs.set('src/' + name, text);
        vfs.set('./' + name, text);
      };
      for (const name of snapshot.manifest) addSource(name, sourceTextFromBytes(snapshot.sources[name]));
      const entry = sourceTextFromBytes(snapshot.entryBytes != null ? snapshot.entryBytes : snapshot.entry);
      const compileStarted = Date.now();
      const compiled = await compiler(entry, vfs, {
        mode: 'production',
        standardWat: true,
        runtimeBuiltins: false,
        tailCalls: mode.tailCalls !== false,
        yieldIntervalMs: options.yieldIntervalMs,
        signal: options.signal,
        yieldControl: async checkpoint => {
          if (options.onProgress) options.onProgress(checkpoint);
          await yieldMainThread();
        },
      });
      const compileMs = Date.now() - compileStarted;
      if (!compiled || !compiled.success || !compiled.wasmBinary) {
        return {
          type: 'result', ok: false, valid: false, byteLength: 0,
          stage: ((compiled && compiled.stages) || []).filter(s => s.success).map(s => s.name).pop() || '?',
          error: String((compiled && compiled.error) || 'compileAsync() returned no binary'),
          line: (compiled && compiled.errorLine) || 0,
          col: (compiled && compiled.errorCol) || 0,
          warnings: (compiled && compiled.diagnostics) || [], logs: [],
          timing: { decodeMs: 0, evalMs: 0, compileMs, validateMs: 0, totalMs: Date.now() - started },
          memory: null,
        };
      }
      // Copy out of the disposable iframe realm before it is removed.
      const bytes = new Uint8Array(compiled.wasmBinary.byteLength);
      bytes.set(compiled.wasmBinary);
      // The compiler reports a summary object whose `.regions` member is the
      // placement array. The Worker path already flattens that object; keep
      // the cooperative protocol identical. Copy each record with page-realm
      // arrays/objects while the iframe is still alive: detached iframe realm
      // arrays lose their iterator on Safari 17.6 after frame.remove().
      const reported = compiled.regions && compiled.regions.regions;
      let layout = null;
      if (reported) {
        layout = [];
        for (let i = 0; i < reported.length; i++) {
          const r = reported[i];
          layout.push({ name: r.name, kind: r.kind, base: r.base, size: r.size });
        }
      }
      const validateStarted = Date.now();
      const valid = options.validate === false ? null : WebAssembly.validate(bytes);
      const validateMs = Date.now() - validateStarted;
      return {
        type: 'result', ok: valid !== false, bytes, byteLength: bytes.byteLength,
        layout, valid,
        warnings: (compiled.diagnostics || []).filter(d => d.type === 'warning'), logs: [],
        timing: { decodeMs: 0, evalMs: 0, compileMs, validateMs, totalMs: Date.now() - started },
        memory: null,
        error: valid === false ? 'WebAssembly.validate rejected compiler output' : null,
      };
    })();
    const terminate = () => {
      if (frame) frame.remove();
      frame = null;
      terminated = true;
      return Promise.resolve();
    };
    return {
      worker: null, result,
      exitPromise: Promise.resolve(0),
      hasExited: () => terminated,
      terminate,
    };
  }

  function runNodeWorker(message, options, transfer) {
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
      worker.postMessage(message, transfer);
    });
    return { worker, result, exitPromise, hasExited: () => exited, terminate: () => worker.terminate() };
  }

  function runBrowserWorker(message, options, transfer) {
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
      worker.postMessage(message, transfer);
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
    // A snapshot this call read itself is unreachable from anywhere else, so
    // its buffers can be transferred rather than copied. A snapshot the CALLER
    // supplied belongs to the caller — it will be compiled again in the other
    // dispatch mode — and is copied. Either way the fetch-once rule holds: the
    // sources are read once per attempt and never re-read to recover a
    // detached buffer.
    const ownsSnapshot = !options.snapshot;
    const snapshot = options.snapshot || await fetchSources(options);
    const key = await cacheKey(snapshot, mode);
    if (!options.noMemo && inFlight.has(key)) return inFlight.get(key);

    const started = Date.now();
    const promise = (async () => {
      const useCooperative = options.cooperative === true ||
        (!isNode && typeof Worker === 'undefined');
      const handle = useCooperative
        ? runCooperative(snapshot, mode, options)
        : runWorker(snapshot, mode, options, ownsSnapshot);
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
          // The region placement these bytes were compiled against. The caller
          // holds the other half of the map (lib/region-map.generated.js) and
          // is the only side that can tell whether they agree — see the note in
          // lib/watx-compile-worker.js. `null` from a compiler old enough not
          // to report regions.
          layout: report.layout || null,
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
    fetchSources, parseIncludes, cacheKey, sha256Hex, sha256PureHex,
    toBytes, toText,
    compile, compileDetailed,
    // Test hooks.
    _inFlight: inFlight,
    _reset: () => inFlight.clear(),
  };
});
