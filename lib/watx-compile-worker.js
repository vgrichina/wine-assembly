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
// PROTOCOL
//   in : { type: 'compile',
//          compiler: [{ name, text }, ...]   // ordered, the 4 vendored stages
//          entry:    <text of src/main.watx>
//          sources:  { '01-header.wat': text, ... }   // include closure
//          mode:     { tailCalls: true|false }
//          validate: true (default)
//        }
//   out: { type: 'result', ok, bytes?, byteLength, sha256?, valid,
//          timing: { evalMs, compileMs, validateMs, totalMs },
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
      return { compile: ctx.compile, logs };
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
      logs,
    };
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
  function compileClosure(compile, msg) {
    const vfs = new Map();
    const sources = msg.sources || {};
    for (const name of Object.keys(sources)) {
      const text = sources[name];
      // src/main.watx writes (include "01-header.wat"); accept the three
      // spellings a host might key by so a caller cannot miss by a prefix.
      vfs.set(name, text);
      vfs.set('src/' + name, text);
      vfs.set('./' + name, text);
    }
    return compile(msg.entry, vfs, {
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
    let evalMs = 0, compileMs = 0, validateMs = 0;
    try {
      const t1 = now();
      const { compile, logs } = loadCompiler(msg.compiler || []);
      evalMs = now() - t1;
      bumpPeak();

      const t2 = now();
      const result = compileClosure(compile, msg);
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
          timing: { evalMs, compileMs, validateMs: 0, totalMs: now() - t0 },
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
        timing: { evalMs, compileMs, validateMs, totalMs: now() - t0 },
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
        timing: { evalMs, compileMs, validateMs, totalMs: now() - t0 },
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
