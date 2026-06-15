#!/usr/bin/env node
// Unicode API regression tests for command line, module lookup, and class table paths.

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
  const dv = new DataView(memory.buffer);
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
    for (let i = 0; i < s.length; i++) u8[p + i] = s.charCodeAt(i) & 0xFF;
    u8[p + s.length] = 0;
    return g;
  }

  function writeWide(s) {
    const g = e.guest_alloc((s.length + 1) * 2);
    const p = wa(g);
    for (let i = 0; i < s.length; i++) dv.setUint16(p + i * 2, s.charCodeAt(i), true);
    dv.setUint16(p + s.length * 2, 0, true);
    return g;
  }

  function readWide(g, max = 256) {
    const p = wa(g);
    let out = '';
    for (let i = 0; i < max; i++) {
      const ch = dv.getUint16(p + i * 2, true);
      if (!ch) break;
      out += String.fromCharCode(ch);
    }
    return out;
  }

  const exe = writeAscii('demo.exe');
  e.set_exe_name(wa(exe), 'demo.exe'.length);
  const cmd = e.test_call_GetCommandLineW();
  check('GetCommandLineW returns full UTF-16 fake path', readWide(cmd) === 'C:\\demo.exe', readWide(cmd));

  const expDir = e.guest_alloc(32);
  const dllNameA = writeAscii('KERNEL32.dll');
  const queryA = writeAscii('C:\\Windows\\System\\kernel32.dll');
  const queryW = writeWide('kernel32.dll');
  const loadAddr = expDir - 0x1000;
  e.guest_write32(expDir + 12, dllNameA - loadAddr);
  dv.setUint32(e.get_dll_table(), loadAddr >>> 0, true);
  dv.setUint32(e.get_dll_table() + 8, 0x1000, true);
  e.test_set_dll_count(1);
  check('GetModuleHandleA finds DLL table entry by basename',
    (e.test_call_GetModuleHandleA(queryA) >>> 0) === (loadAddr >>> 0));
  check('GetModuleHandleW returns NULL module as image base',
    (e.test_call_GetModuleHandleW(0) >>> 0) === (e.get_image_base() >>> 0));
  check('GetModuleHandleW finds DLL table entry case-insensitively',
    (e.test_call_GetModuleHandleW(queryW) >>> 0) === (loadAddr >>> 0));

  const className = writeWide('WideMainWindow');
  const wc = e.guest_alloc(40);
  const wndproc = 0x12345678;
  e.guest_write32(wc + 0, 0x20);
  e.guest_write32(wc + 4, wndproc);
  e.guest_write32(wc + 28, 5);
  e.guest_write32(wc + 36, className);
  check('RegisterClassW returns atom', e.test_call_RegisterClassW(wc) !== 0);
  const out = e.guest_alloc(40);
  check('GetClassInfoW finds RegisterClassW record', e.test_call_GetClassInfoW(className, out) === 1);
  check('GetClassInfoW preserves WNDCLASSW wndproc', e.guest_read32(out + 4) === wndproc);
  check('GetClassInfoW preserves WNDCLASSW class pointer', e.guest_read32(out + 36) === className);

  const classNameEx = writeWide('WideExWindow');
  const wcx = e.guest_alloc(48);
  const wndprocEx = 0x22334455;
  e.guest_write32(wcx + 0, 48);
  e.guest_write32(wcx + 4, 0x11);
  e.guest_write32(wcx + 8, wndprocEx);
  e.guest_write32(wcx + 32, 7);
  e.guest_write32(wcx + 40, classNameEx);
  check('RegisterClassExW returns atom', e.test_call_RegisterClassExW(wcx) !== 0);
  const outEx = e.guest_alloc(40);
  check('GetClassInfoW finds RegisterClassExW record', e.test_call_GetClassInfoW(classNameEx, outEx) === 1);
  check('GetClassInfoW maps WNDCLASSEXW wndproc into WNDCLASS slot',
    e.guest_read32(outEx + 4) === wndprocEx);

  console.log(`--- wide-api: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
