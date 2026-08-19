#!/usr/bin/env node
// Regression tests for kernel32 last-error preservation paths.

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

async function main() {
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC, f), 'utf-8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread = () => 0;
  base.host.create_event = () => 0;
  base.host.set_event = () => 0;
  base.host.reset_event = () => 0;
  base.host.wait_single = () => 0;
  base.host.wait_multiple = () => 0;
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

  console.log(`--- kernel32-last-error: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
