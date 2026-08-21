// What a worker thread inherits from the process that spawned it.
//
// A guest thread runs in its own WASM instance, so every host import it calls
// is a fresh closure over a fresh context object. That makes "what is shared"
// an explicit decision at exactly two places -- test/run.js and host.js -- and
// they drifted: each host had its own literal list, neither list was written
// down as a rule, and the only way to compare them was to read both.
//
// The rule, in one sentence: a worker shares everything that belongs to the
// PROCESS, and nothing that belongs to a thread. A file handle opened by the
// main thread is visible to a worker; a LAN socket is the process's, not the
// caller's; there is one clock, not one per thread; a bitmap created on the
// main thread must still be there when a worker blits it. Anything that is
// genuinely per-thread -- the instance, the thread id, the logger's own
// "was the last call traced" latch -- is built per worker instead.

// Keys copied from the main context into a worker's, with the reason each one
// is process-scoped. A key absent from the main context stays absent from the
// worker's: this list is what MAY be shared, not what must exist. That is what
// lets the two hosts have legitimately different sets -- the browser has a
// `sharedMixer` because several apps can play audio in one page, the CLI has
// `_waveStats` because a test asserts on them -- without either being drift.
const PROCESS_SHARED_KEYS = [
  'vfs',                // one filesystem: a worker must see main-thread writes
  'vlanWire',           // one wire per process, not per thread
  'guestNowMs',         // one clock, so threads cannot disagree about "now"
  'sharedGdi',          // GDI handles, so a worker's BitBlt finds main's bitmap
  'sharedAudio',        // waveOut device state is the process's single output
  'sharedMixer',        // mixer state, when the host shares one across apps
  '_audioOutFd',        // the CLI's audio capture file
  '_waveStats',         // audio counters, so a worker's writes reach the summary
  'audioStatsStride',
];

// Copy the process-scoped half of a context. Callers add the per-thread half
// (instance, exports, threadId, memory) themselves, since only they know it.
function processSharedCtx(mainCtx) {
  const out = {};
  if (!mainCtx) return out;
  for (const key of PROCESS_SHARED_KEYS) {
    if (mainCtx[key] !== undefined) out[key] = mainCtx[key];
  }
  return out;
}

// The thread and synchronization imports. lib/host-imports.js declares these as
// return-0 stubs so the WASM import shape is always complete; a host that has a
// ThreadManager must replace all thirteen. Miss one and the guest gets silent
// success from a wait that never waited -- which is why the list lives here
// rather than being retyped.
//
// The browser satisfies this implicitly: its worker imports come from the same
// getImports() method that installs the overrides, closed over the same
// ThreadManager. The CLI builds worker imports from a free function, so it
// adopts them from the main thread's table explicitly.
const THREAD_PRIMITIVE_IMPORTS = [
  'create_thread', 'suspend_thread', 'resume_thread', 'exit_thread',
  'get_exit_code_thread',
  'create_event', 'open_event', 'set_event', 'reset_event',
  'wait_single', 'wait_multiple',
  'create_semaphore', 'release_semaphore',
];

// Point a worker's thread/event imports at the main thread's, so every thread
// in the process schedules against one ThreadManager. Throws on a name the main
// table does not implement: a missing primitive here is a guest that waits on
// nothing and continues, and that failure is far cheaper to find now.
function adoptThreadPrimitives(workerHost, mainHost) {
  for (const name of THREAD_PRIMITIVE_IMPORTS) {
    if (typeof mainHost[name] !== 'function') {
      throw new Error(`worker-imports: main host has no ${name}() to adopt — ` +
        `a worker would get the return-0 stub and wait on nothing`);
    }
    workerHost[name] = mainHost[name];
  }
  return workerHost;
}

// The API trace pair. WAT calls log(name) before a handler and log_i32(value)
// after it, so the return belongs to the call just logged and is shown only
// when that call was -- the latch is why these two cannot be written
// independently, and both hosts had rediscovered it.
//
// Filtering is the caller's business (--trace-api=NAMES and --quiet-api in the
// CLI, the toolbar's name set in the browser) and so is where the text goes,
// but the decode, the 256-byte clamp and the latch are the same everywhere. The
// filter is not a nicety: without it a two-process run emitted 2.3M lines from
// worker idle polls alone and died of heap exhaustion inside console.log.
// `formatCall(name)` / `formatReturn(name, value)` are optional: supply them and
// the worker trace carries typed arguments and a decoded return exactly like the
// main thread's, instead of a bare name. They need the *worker* instance's esp,
// which does not exist yet when the import table is built, so they are called
// lazily here and may return null (before the instance exists, or for an API
// with no args:[] typing in api_table.json) to fall back to the bare form.
function makeWorkerApiLogger(opts) {
  const getBuffer = opts.getBuffer;
  const shouldLog = opts.shouldLog || (() => false);
  const emit = opts.emit;
  const onCall = opts.onCall || null;
  const formatValue = opts.formatValue || ((v) => `0x${(v >>> 0).toString(16)}`);
  const formatCall = opts.formatCall || null;
  const formatReturn = opts.formatReturn || null;
  const tid = opts.threadId | 0;
  let visible = false;
  let pending = '';

  return {
    log: (ptr, len) => {
      const bytes = new Uint8Array(getBuffer(), ptr, Math.min(len, 256));
      let name = '';
      for (let i = 0; i < bytes.length && bytes[i]; i++) name += String.fromCharCode(bytes[i]);
      if (onCall) onCall(name);
      visible = !!shouldLog(name);
      if (!visible) { pending = ''; return; }
      pending = name;
      let header = null;
      if (formatCall) { try { header = formatCall(name); } catch (_) { header = null; } }
      emit(`[API T${tid}] ${header || name}`);
    },
    log_i32: (val) => {
      if (!visible) return;
      let decoded = null;
      if (formatReturn) { try { decoded = formatReturn(pending, val); } catch (_) { decoded = null; } }
      emit(`  => ${decoded || formatValue(val)}`);
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    PROCESS_SHARED_KEYS,
    processSharedCtx,
    THREAD_PRIMITIVE_IMPORTS,
    adoptThreadPrimitives,
    makeWorkerApiLogger,
  };
}
