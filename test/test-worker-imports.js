// What a worker thread inherits from its process, and what it must not.
//
// The two hosts build worker imports differently — the CLI from a free
// function, the browser from a method that closes over the page — so the only
// thing that can keep them agreeing is the shared list they both read. These
// checks are about that list: that process-scoped state crosses, that
// thread-scoped state does not, and that a missing thread primitive is loud
// rather than a wait that silently succeeds.

const assert = require('assert');
const {
  PROCESS_SHARED_KEYS,
  processSharedCtx,
  THREAD_PRIMITIVE_IMPORTS,
  adoptThreadPrimitives,
  makeWorkerApiLogger,
} = require('../lib/worker-imports');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

console.log('=== worker-imports ===');

check('the process-scoped half crosses into a worker', () => {
  const vfs = { files: new Map() };
  const wire = { id: 'wire' };
  const clock = () => 42;
  const worker = processSharedCtx({
    vfs, vlanWire: wire, guestNowMs: clock,
    sharedGdi: { bitmaps: 1 }, sharedAudio: { open: 0 },
  });
  assert.strictEqual(worker.vfs, vfs, 'a worker must see main-thread file writes');
  assert.strictEqual(worker.vlanWire, wire, 'one wire per process, not per thread');
  assert.strictEqual(worker.guestNowMs, clock, 'threads cannot disagree about now');
  assert.strictEqual(worker.sharedAudio.open, 0);
});

check('the thread-scoped half does not', () => {
  // instance/exports/threadId/memory are rebuilt per worker; copying them
  // would point every thread at the main instance.
  const worker = processSharedCtx({
    vfs: {}, instance: 'MAIN', exports: 'MAIN', threadId: 0, getMemory: () => null,
  });
  for (const key of ['instance', 'exports', 'threadId', 'getMemory']) {
    assert.ok(!(key in worker), `${key} is per-thread and must not be copied`);
  }
});

check('a key the host does not have stays absent', () => {
  // The two hosts legitimately share different sets — the browser has a
  // sharedMixer because several apps play audio in one page, the CLI has
  // _waveStats because a test asserts on them. The list is what MAY cross.
  const cli = processSharedCtx({ vfs: {}, _waveStats: { open: 1 } });
  assert.ok(!('sharedMixer' in cli), 'absent stays absent, not undefined-valued');
  assert.strictEqual(cli._waveStats.open, 1);
  assert.deepStrictEqual(processSharedCtx(null), {}, 'no main context is empty, not a throw');
});

check('every documented key is one the list actually names', () => {
  assert.ok(PROCESS_SHARED_KEYS.includes('vfs'));
  assert.ok(PROCESS_SHARED_KEYS.includes('vlanWire'));
  assert.strictEqual(new Set(PROCESS_SHARED_KEYS).size, PROCESS_SHARED_KEYS.length,
    'a duplicated key means two people added it without reading');
});

check('all twelve thread primitives are adopted', () => {
  const main = {};
  for (const name of THREAD_PRIMITIVE_IMPORTS) main[name] = () => name;
  const worker = { wait_single: () => 0 };  // the stub host-imports installs
  adoptThreadPrimitives(worker, main);
  for (const name of THREAD_PRIMITIVE_IMPORTS) {
    assert.strictEqual(worker[name], main[name], `${name} still points at the stub`);
  }
  assert.strictEqual(worker.wait_single(), 'wait_single', 'the stub survived adoption');
});

check('a missing primitive throws instead of leaving a silent stub', () => {
  const main = {};
  for (const name of THREAD_PRIMITIVE_IMPORTS) main[name] = () => 0;
  delete main.wait_multiple;
  assert.throws(() => adoptThreadPrimitives({}, main), /wait_multiple/,
    'a guest that waits on nothing and continues is the failure this prevents');
});

check('the api logger shows a return only for a call it showed', () => {
  const mem = new WebAssembly.Memory({ initial: 1 });
  const bytes = new Uint8Array(mem.buffer);
  const write = (ptr, s) => {
    for (let i = 0; i < s.length; i++) bytes[ptr + i] = s.charCodeAt(i);
    bytes[ptr + s.length] = 0;
    return ptr;
  };
  write(0x100, 'CreateWindowExA');
  write(0x200, 'Sleep');

  const lines = [];
  const counted = [];
  const logger = makeWorkerApiLogger({
    getBuffer: () => mem.buffer,
    threadId: 3,
    onCall: (name) => counted.push(name),
    shouldLog: (name) => name === 'CreateWindowExA',
    emit: (line) => lines.push(line),
  });

  logger.log(0x100, 32);
  logger.log_i32(0x10004);
  logger.log(0x200, 32);
  logger.log_i32(0);

  assert.deepStrictEqual(lines, ['[API T3] CreateWindowExA', '  => 0x10004'],
    'the filtered call must take its return line with it');
  assert.deepStrictEqual(counted, ['CreateWindowExA', 'Sleep'],
    'every call is counted even when none is printed — the summary needs them');
});

check('the logger clamps a name to 256 bytes', () => {
  // len comes from the guest. A bad one must not read past the clamp.
  const mem = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(mem.buffer).fill(0x41, 0x100, 0x100 + 600);
  const lines = [];
  const logger = makeWorkerApiLogger({
    getBuffer: () => mem.buffer,
    threadId: 1,
    shouldLog: () => true,
    emit: (line) => lines.push(line),
  });
  logger.log(0x100, 600);
  assert.strictEqual(lines[0].length, '[API T1] '.length + 256);
});

console.log(failures === 0 ? '\nAll worker-imports checks passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
