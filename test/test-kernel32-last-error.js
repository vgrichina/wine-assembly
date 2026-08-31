#!/usr/bin/env node
// Regression tests for kernel32 last-error preservation paths.

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

async function main() {
  const wasmBytes = compileSrcWasm();
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  // The thread and synchronization imports come from lib/host-imports.js: its
  // defaults are a real process-local kernel-object table, so CreateMutexA/
  // OpenMutexA below exercise the same create/open/name contract the
  // ThreadManager-backed hosts implement.
  base.host.com_create_instance = () => 0x80004002;

  const { instance } = await WebAssembly.instantiate(wasmBytes, base);
  const e = instance.exports;
  const u8 = new Uint8Array(memory.buffer);
  const wa = gp => gp - e.get_image_base() + e.get_guest_base();

  let pass = 0;
  let fail = 0;
  function check(name, ok, detail = '') {
    if (ok) {
      pass++;
      console.log('PASS  ' + name);
    } else {
      fail++;
      console.log('FAIL  ' + name + (detail ? '  ' + detail : ''));
    }
  }

  function writeAscii(s) {
    const g = e.guest_alloc(s.length + 1);
    const p = wa(g);
    for (let i = 0; i < s.length; i++) u8[p + i] = s.charCodeAt(i) & 0xff;
    u8[p + s.length] = 0;
    return g;
  }

  check('GetLastError starts at ERROR_SUCCESS', e.test_call_GetLastError() === 0);

  e.test_call_SetLastError(1234);
  check('SetLastError value is returned by GetLastError',
    e.test_call_GetLastError() === 1234,
    String(e.test_call_GetLastError()));

  const mutexName = writeAscii('WineAssemblyLastErrorSmoke');
  check('OpenMutexA reports a missing named mutex', e.test_call_OpenMutexA(mutexName) === 0);
  check('OpenMutexA sets ERROR_FILE_NOT_FOUND',
    e.test_call_GetLastError() === 2,
    String(e.test_call_GetLastError()));

  check('CreateMutexA returns a fresh handle', e.test_call_CreateMutexA(mutexName) !== 0);
  check('CreateMutexA clears last error for a new mutex',
    e.test_call_GetLastError() === 0,
    String(e.test_call_GetLastError()));

  // The default synchronization imports are the host side of
  // CreateSemaphore/ReleaseSemaphore, which $handle_CreateSemaphoreA/W and
  // $handle_ReleaseSemaphore return verbatim as EAX. Win32 rejects the
  // out-of-range counts rather than repairing them, and a rejected release
  // must leave the count exactly as it was.
  const h = base.host;
  check('CreateSemaphore rejects a non-positive maximum', h.create_semaphore(0, 0) === 0);
  check('CreateSemaphore rejects a negative initial count', h.create_semaphore(-1, 4) === 0);
  check('CreateSemaphore rejects an initial count above the maximum',
    h.create_semaphore(5, 4) === 0);

  const sem = h.create_semaphore(1, 2);
  check('CreateSemaphore accepts counts inside the documented range', sem !== 0);
  check('a signaled semaphore satisfies a wait', h.wait_single(sem, 0) === 0);
  check('the wait consumed the only count', h.wait_single(sem, 0) === 0x102);
  check('ReleaseSemaphore rejects a non-positive release count',
    h.release_semaphore(sem, 0, 0) === 0 && h.release_semaphore(sem, -1, 0) === 0);
  check('a rejected release leaves the count unchanged', h.wait_single(sem, 0) === 0x102);
  check('ReleaseSemaphore rejects a release past the maximum',
    h.release_semaphore(sem, 3, 0) === 0);
  check('ReleaseSemaphore signals the semaphore again', h.release_semaphore(sem, 1, 0) === 1);
  check('the released count satisfies the next wait', h.wait_single(sem, 0) === 0);

  console.log(`--- kernel32-last-error: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
