// ═══════════════════════════════════════════════════════════════
// lib/watx-compile-worker.js — Milestone 4 compiler Worker.
//
// One disposable Worker that turns the src/main.watx include closure into a
// validated .wasm and then dies. It runs in BOTH:
//
//   - a browser Worker           `new Worker('lib/watx-compile-worker.js')`
//   - node worker_threads        `new Worker('lib/watx-compile-worker.js')`
//
// so the browser path is exercised by a headless node test with no DOM.
//
// DESIGN RULES (docs/watx-migration-plan.md §"Milestone 4"):
//
//   1. NO FETCH / NO FILE I/O IN HERE. The caller (lib/watx-launcher.js)
//      reads every compiler file and every source file EXACTLY ONCE and
//      passes the text in. Two passes of the compiler therefore cannot
//      observe two different revisions of one file, and the launcher — not
//      this worker — owns the cache key that hashes what was read.
//   2. Pure compute, one message in, one message out, then the worker is
//      terminated by the caller in a `finally`.
//   3. The bytes are posted back as a TRANSFERABLE ArrayBuffer, so the
//      compiled module is moved rather than copied and this worker's heap is
//      fully released when it terminates — before the host allocates Wine's
//      8192-page (512 MB) shared memory.
//
//   4. The sources arrive as UTF-8 BYTES in transferable ArrayBuffers, one per
//      file, and become JS strings here — one at a time, with the buffer slot
//      dropped as soon as it is decoded. A structured-cloned string snapshot
//      used to be resident on both sides at once at ~2x its byte size; this
//      way the parent's copy is moved, not duplicated. The compiler's own
//      interface is unchanged: it still gets compile(entryText, vfsOfStrings).
//
//      The compiler bundle is evaluated BEFORE the sources are decoded, because
//      the WATX sources go through the compiler's own byte→text boundary
//      (`watxSourceTextFromBytes`). A plain TextDecoder gives strings that V8
//      stores two bytes per character — the banner comments alone are enough to
//      force it — and that is 9.7 MB of live heap held for the whole compile.
//
// PROTOCOL
//   in : { type: 'compile',
//          compilerNames: ['tools/watx-src/compiler-parser.js', ...]  // load order
//          entryName:     'src/main.watx'
//          sourceNames:   ['01-header.wat', ...]   // include closure, in order
//          buffers:       [ArrayBuffer, ...]       // UTF-8, compiler ++ entry ++ sources
//          mode:     { tailCalls: true|false }
//          validate: true (default)
//        }
//        The pre-transfer text form — { compiler: [{name,text}], entry,
//        sources: {name: text} } — is still accepted, so a caller that builds
//        a message by hand keeps working.
//   out: { type: 'result', ok, bytes?, byteLength, sha256?, valid,
//          timing: { decodeMs, evalMs, compileMs, validateMs, totalMs },
//          memory: { ... best-effort, see readMemory() },
//          warnings, error?, stage?, line?, col?, file? }
//   out: { type: 'ready' }  once, at startup (so a caller can time spawn cost)
//
// The worker never calls close() on itself: termination is the caller's job,
// and a self-close would race the postMessage of the bytes.
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const isNodeWorker = typeof process !== 'undefined' &&
    process.versions && process.versions.node &&
    typeof require === 'function';

  // ---------------------------------------------------------------
  // Environment shim: one send()/onMessage() pair for both worlds.
  // ---------------------------------------------------------------
  let send, listen;
  let nodeParentPort = null;
  if (isNodeWorker) {
    const { parentPort } = require('worker_threads');
    nodeParentPort = parentPort;
    send = (msg, transfer) => parentPort.postMessage(msg, transfer || []);
    listen = fn => parentPort.on('message', fn);
  } else {
    send = (msg, transfer) => self.postMessage(msg, transfer || []);
    listen = fn => { self.onmessage = e => fn(e.data); };
  }

  // ---------------------------------------------------------------
  // Memory readings. Every source here is optional and engine-specific;
  // a missing one is reported as null rather than faked.
  //
  //   node    process.memoryUsage()          rss / heapUsed, bytes
  //   Chrome  performance.memory             usedJSHeapSize, bytes (non-standard)
  //   Chrome  performance.measureUserAgentSpecificMemory()  — async, needs
  //           crossOriginIsolated; the launcher can ask for it separately, we
  //           only take the cheap synchronous readings so the compile is not
  //           serialised behind a GC.
  //   Safari  nothing. Reported as null, which is the honest answer and is
  //           exactly why the plan keeps the iOS memory gate open.
  // ---------------------------------------------------------------
  function readMemory() {
    const out = { rss: null, heapUsed: null, jsHeap: null, jsHeapLimit: null };
    try {
      if (isNodeWorker) {
        const m = process.memoryUsage();
        out.rss = m.rss;
        out.heapUsed = m.heapUsed;
      }
    } catch (_) { /* ignore */ }
    try {
      const pm = typeof performance !== 'undefined' && performance.memory;
      if (pm) {
        out.jsHeap = pm.usedJSHeapSize;
        out.jsHeapLimit = pm.jsHeapSizeLimit;
      }
    } catch (_) { /* ignore */ }
    return out;
  }

  const now = () => (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();

  // ---------------------------------------------------------------
  // Load the vendored compiler from TEXT the caller supplied.
  //
  // The four tools/watx-src/*.js files are browser-global scripts: each
  // declares top-level `function`s that the next one uses. They are evaluated
  // in order into one shared scope.
  //
  // node    a vm context, identical in shape to tools/watx.js (which cannot be
  //         required here because that would be file I/O in the worker)
  // browser indirect eval, which runs in global scope in sloppy mode, so the
  //         function declarations land on `self`. importScripts() is NOT used:
  //         it would be a second fetch of files the launcher already read, and
  //         would break the fetch-once rule and the cache key with it.
  // ---------------------------------------------------------------
  function loadCompiler(files) {
    const logs = [];
    const quietConsole = {
      log: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' ')),
      error: (...a) => logs.push(a.join(' ')),
    };
    if (isNodeWorker) {
      const vm = require('vm');
      const ctx = {
        console: quietConsole,
        TextEncoder, TextDecoder,
        Float32Array, Float64Array, Uint8Array, ArrayBuffer,
        Map, Set, RegExp, Array, Object, String, Number, Math,
        parseInt, parseFloat, isNaN,
      };
      vm.createContext(ctx);
      for (const f of files) {
        vm.runInContext(f.text, ctx, { filename: f.name });
      }
      if (typeof ctx.compile !== 'function') {
        throw new Error('watx compiler bundle defined no compile()');
      }
      return { compile: ctx.compile, sourceTextFromBytes: ctx.watxSourceTextFromBytes, logs };
    }
    // Browser Worker. Keep the compiler's chatter off the console but
    // retrievable: it is the only diagnostic channel a failed browser build has.
    const realConsole = self.console;
    self.console = quietConsole;
    try {
      const indirectEval = eval;
      for (const f of files) indirectEval(f.text + '\n//# sourceURL=' + f.name);
    } finally {
      self.console = realConsole;
    }
    if (typeof self.compile !== 'function') {
      throw new Error('watx compiler bundle defined no compile()');
    }
    // The compiler keeps logging during compile(); keep the quiet console in
    // place for the duration by wrapping.
    const compileFn = self.compile;
    return {
      compile: (...args) => {
        const saved = self.console;
        self.console = quietConsole;
        try { return compileFn(...args); } finally { self.console = saved; }
      },
      sourceTextFromBytes: self.watxSourceTextFromBytes,
      logs,
    };
  }

  // ---------------------------------------------------------------
  // decodeInputs(msg) — the transferred bytes become the compiler bundle, the
  // entry text and the vfs Map the compiler expects.
  //
  // Each buffer slot is nulled the moment its text exists, so the UTF-8 copy
  // of a file is releasable as soon as its UTF-16 one is built: the worker
  // never holds the whole closure in both encodings at once. `msg` is the only
  // reference to those buffers (they were transferred in, not shared).
  // ---------------------------------------------------------------
  // The compiler bundle comes off the front of `buffers`; the entry and the
  // sources follow. They are split because the WATX sources must be decoded by
  // the compiler's own `watxSourceTextFromBytes` — which only exists once the
  // bundle has been evaluated — and decoding them with a plain TextDecoder
  // instead costs two bytes of heap per source character for the whole compile.
  // `cursor` carries the position between the two halves.
  function decodeCompiler(msg) {
    if (!msg.buffers) return { compiler: msg.compiler || [], cursor: 0 };
    const decoder = new TextDecoder('utf-8');
    const names = msg.compilerNames || [];
    const compiler = names.map((name, i) => {
      const buf = msg.buffers[i];
      msg.buffers[i] = null;
      return { name, text: decoder.decode(new Uint8Array(buf)) };
    });
    return { compiler, cursor: names.length };
  }

  function decodeSources(msg, cursor, sourceTextFromBytes) {
    const vfs = new Map();
    // src/main.watx writes (include "01-header.wat"); accept the three
    // spellings a host might key by so a caller cannot miss by a prefix.
    const addSource = (name, text) => {
      vfs.set(name, text);
      vfs.set('src/' + name, text);
      vfs.set('./' + name, text);
    };

    if (!msg.buffers) {
      // Legacy text form (see header).
      const sources = msg.sources || {};
      for (const name of Object.keys(sources)) addSource(name, sources[name]);
      return { entry: msg.entry, vfs };
    }

    // A compiler too old to export the boundary still has to work; it just pays
    // the two-byte representation, exactly as this worker used to.
    const decoder = new TextDecoder('utf-8');
    const toText = typeof sourceTextFromBytes === 'function'
      ? sourceTextFromBytes
      : (u8 => decoder.decode(u8));
    let i = cursor;
    const take = () => {
      const buf = msg.buffers[i];
      msg.buffers[i] = null;
      i++;
      return toText(new Uint8Array(buf));
    };
    const entry = take();
    for (const name of (msg.sourceNames || [])) addSource(name, take());
    return { entry, vfs };
  }

  // ---------------------------------------------------------------
  // The compile itself.
  //
  // The compiler options here are load-bearing and match tools/watx-matrix.js
  // exactly, so the Worker cannot silently build a different module than the
  // differential matrix validated:
  //
  //   mode: 'production'    streaming two-pass, no debug artifacts (the
  //                         wasmText/expanded/lowered strings are several
  //                         times the size of the binary — never in a browser)
  //   standardWat: true     Wine's source is standard WAT, not WATX sugar
  //   runtimeBuiltins:false the plan's invariant: no automatic static-region
  //                         allocator, no runtime builtins
  //   tailCalls             the ONLY axis the caller varies
  // ---------------------------------------------------------------
  function compileClosure(compile, input, msg) {
    return compile(input.entry, input.vfs, {
      mode: 'production',
      standardWat: true,
      runtimeBuiltins: false,
      tailCalls: msg.mode ? msg.mode.tailCalls !== false : true,
    });
  }

  function handle(msg) {
    if (!msg || msg.type !== 'compile') return;
    const t0 = now();
    const memBefore = readMemory();
    let memPeak = memBefore;
    const bumpPeak = () => {
      const m = readMemory();
      if ((m.rss || 0) > (memPeak.rss || 0) || (m.jsHeap || 0) > (memPeak.jsHeap || 0)) memPeak = m;
      return m;
    };
    let decodeMs = 0, evalMs = 0, compileMs = 0, validateMs = 0;
    try {
      const t05 = now();
      const bundle = decodeCompiler(msg);
      decodeMs = now() - t05;

      const t1 = now();
      const { compile, sourceTextFromBytes, logs } = loadCompiler(bundle.compiler);
      bundle.compiler = null;
      evalMs = now() - t1;

      const t06 = now();
      const input = decodeSources(msg, bundle.cursor, sourceTextFromBytes);
      decodeMs += now() - t06;
      bumpPeak();

      const t2 = now();
      const result = compileClosure(compile, input, msg);
      compileMs = now() - t2;
      const memAfterCompile = bumpPeak();

      if (!result || !result.success || !result.wasmBinary) {
        const lastOk = ((result && result.stages) || [])
          .filter(s => s.success).map(s => s.name).pop() || '?';
        send({
          type: 'result',
          ok: false,
          valid: false,
          byteLength: 0,
          stage: 'after ' + lastOk,
          error: String((result && (result.error || result.message)) || 'compile() returned no binary'),
          line: (result && result.errorLine) || 0,
          col: (result && result.errorCol) || 0,
          warnings: (result && result.diagnostics) || [],
          logs,
          timing: { decodeMs, evalMs, compileMs, validateMs: 0, totalMs: now() - t0 },
          memory: { before: memBefore, afterCompile: memAfterCompile, peak: memPeak, afterTransfer: null },
        });
        return;
      }

      // Bytes: normalise to a standalone ArrayBuffer we can transfer. The
      // compiler hands back a Uint8Array which may be a view into a larger
      // buffer, and transferring that would move more than the module.
      let bytes = result.wasmBinary;
      if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      bytes = null;

      let valid = null;
      if (msg.validate !== false) {
        const t3 = now();
        try {
          valid = WebAssembly.validate(copy.buffer);
        } catch (e) {
          valid = false;
        }
        validateMs = now() - t3;
      }
      const memAfterValidate = bumpPeak();

      send({
        type: 'result',
        ok: valid !== false,
        valid,
        bytes: copy,
        byteLength: copy.byteLength,
        warnings: result.diagnostics || [],
        logs,
        error: valid === false ? 'WebAssembly.validate rejected the compiled module' : undefined,
        timing: { decodeMs, evalMs, compileMs, validateMs, totalMs: now() - t0 },
        memory: {
          before: memBefore,
          afterCompile: memAfterCompile,
          afterValidate: memAfterValidate,
          peak: memPeak,
        },
      }, [copy.buffer]);
    } catch (e) {
      send({
        type: 'result',
        ok: false,
        valid: false,
        byteLength: 0,
        stage: 'THROW',
        error: String((e && e.message) || e),
        stack: e && e.stack ? String(e.stack) : undefined,
        warnings: [],
        timing: { decodeMs, evalMs, compileMs, validateMs, totalMs: now() - t0 },
        memory: { before: memBefore, peak: memPeak },
      });
    }
  }

  listen(handle);
  send({ type: 'ready' });
  // Node keeps the worker alive on the parentPort listener; a browser Worker
  // stays alive until terminate(). Neither self-closes — see header.
  void nodeParentPort;
})();
