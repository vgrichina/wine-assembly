#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const { _test: { initMsvcrtGlobals } } = require('../lib/dll-loader');
const { GUEST_BASE } = require('../lib/region-map.generated');

function guestRead16(exports, addr) {
  return (exports.guest_read8(addr) | (exports.guest_read8(addr + 1) << 8)) >>> 0;
}

// Exercise the authentic-DLL path without an external msvcrt.dll fixture. Its
// four accessors are the Win98 x86 shape this loader recognizes —
// `mov eax,&global; ret` — and each returns a distinct global slot. The values
// of the current/initial pair agree, while narrow and wide arrays must not.
function testMsvcrtEnvironmentPatches() {
  const memory = new ArrayBuffer(0x40000);
  const dv = new DataView(memory);
  const mem = new Uint8Array(memory);
  const imageBase = 0x00400000;
  const dllBase = 0x00410000;
  const dllTable = 0x1000;
  const exportRva = 0x200;
  const namesRva = 0x300;
  const ordinalsRva = 0x340;
  const funcsRva = 0x380;
  const g2w = guest => guest - imageBase + GUEST_BASE;
  const names = ['__p__wenviron', '__p__environ', '__p___winitenv', '__p___initenv'];
  const slots = new Map();

  dv.setUint32(dllTable, dllBase, true);
  dv.setUint32(dllTable + 8, exportRva, true);
  const exportWa = g2w(dllBase + exportRva);
  dv.setUint32(exportWa + 24, names.length, true);
  dv.setUint32(exportWa + 28, funcsRva, true);
  dv.setUint32(exportWa + 32, namesRva, true);
  dv.setUint32(exportWa + 36, ordinalsRva, true);

  for (let i = 0; i < names.length; i++) {
    const nameRva = 0x400 + i * 0x30;
    const funcRva = 0x600 + i * 0x10;
    const slot = dllBase + 0x900 + i * 4;
    slots.set(names[i], slot);
    dv.setUint32(g2w(dllBase + namesRva + i * 4), nameRva, true);
    dv.setUint16(g2w(dllBase + ordinalsRva + i * 2), i, true);
    dv.setUint32(g2w(dllBase + funcsRva + i * 4), funcRva, true);
    const encoded = Buffer.from(`${names[i]}\0`, 'ascii');
    mem.set(encoded, g2w(dllBase + nameRva));
    const funcWa = g2w(dllBase + funcRva);
    mem[funcWa] = 0xB8;
    dv.setUint32(funcWa + 1, slot, true);
    mem[funcWa + 5] = 0xC3;
  }

  let nextAlloc = imageBase + 0x24000;
  const mock = {
    get_image_base: () => imageBase,
    get_dll_count: () => 1,
    get_dll_table: () => dllTable,
    guest_alloc(size) {
      const result = nextAlloc;
      nextAlloc += size;
      return result;
    },
    guest_write16(addr, value) { dv.setUint16(g2w(addr), value, true); },
    guest_write32(addr, value) { dv.setUint32(g2w(addr), value, true); },
  };

  initMsvcrtGlobals(mock, memory, dllBase);
  const valueOf = name => dv.getUint32(g2w(slots.get(name)), true);
  const wide = valueOf('__p__wenviron');
  const wideInitial = valueOf('__p___winitenv');
  const narrow = valueOf('__p__environ');
  const narrowInitial = valueOf('__p___initenv');
  assert.strictEqual(wideInitial, wide, '__winitenv begins at the wide environment array');
  assert.strictEqual(narrowInitial, narrow, '__initenv begins at the narrow environment array');
  assert.notStrictEqual(wide, narrow, 'wide and narrow environment arrays are distinct');
  const wideBlock = dv.getUint32(g2w(wide), true);
  assert.deepStrictEqual([
    dv.getUint16(g2w(wideBlock), true),
    dv.getUint16(g2w(wideBlock + 2), true),
    dv.getUint16(g2w(wideBlock + 4), true),
  ], [0x41, 0x3D, 0x42], 'wide environment contains UTF-16 A=B');
  const narrowBlock = dv.getUint32(g2w(narrow), true);
  assert.deepStrictEqual([...mem.slice(g2w(narrowBlock), g2w(narrowBlock) + 3)],
    [0x41, 0x3D, 0x42], 'narrow environment contains ANSI A=B');
}

const extraWat = String.raw`
  (global $test_eax (mut i32) (i32.const 0))
  (global $test_esp_delta (mut i32) (i32.const 0))
  (global $test_f64 (mut f64) (f64.const 0))

  (func (export "call_mb_cur_max")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle___mb_cur_max
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "last_eax") (result i32) (global.get $test_eax))
  (func (export "last_esp_delta") (result i32) (global.get $test_esp_delta))
  (func (export "last_f64") (result f64) (global.get $test_f64))

  (func (export "call_p_environ")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle___p__environ
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_p_initenv")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle___p___initenv
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_cexit")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (global.set $eax (i32.const 0x12345678))
    (call $handle__cexit
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_getdrive")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle__getdrive
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_iob")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle__iob
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_isctype") (param $ch i32) (param $mask i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle__isctype
      (local.get $ch) (local.get $mask) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_pctype")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle__pctype
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_setmode")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle__setmode
      (i32.const 1) (i32.const 0x8000) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_atof") (param $str i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_atof
      (local.get $str) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_f64 (call $fpu_pop))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_strtod") (param $str i32) (param $endptr i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_strtod
      (local.get $str) (local.get $endptr) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_f64 (call $fpu_pop))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_clock")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_clock
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_memchr") (param $buf i32) (param $ch i32) (param $len i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_memchr
      (local.get $buf) (local.get $ch) (local.get $len)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_strerror") (param $err i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_strerror
      (local.get $err) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_tmpnam") (param $buf i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_tmpnam
      (local.get $buf) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_dup") (param $fd i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle__dup
      (local.get $fd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "call_strncat") (param $dst i32) (param $src i32) (param $count i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_strncat
      (local.get $dst) (local.get $src) (local.get $count)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))
`;

(async () => {
  testMsvcrtEnvironmentPatches();
  const { exports } = await bootRenderHarness({ extraWat, fonts: 'none' });
  function guestCString(text, capacity = text.length + 1) {
    assert(capacity >= text.length + 1, 'guestCString capacity holds text and NUL');
    const ptr = exports.guest_alloc(capacity) >>> 0;
    for (let i = 0; i < text.length; i++) exports.guest_write8(ptr + i, text.charCodeAt(i));
    exports.guest_write8(ptr + text.length, 0);
    return ptr;
  }
  function guestReadCString(ptr, limit = 64) {
    let out = '';
    for (let i = 0; i < limit; i++) {
      const ch = exports.guest_read8(ptr + i);
      if (!ch) return out;
      out += String.fromCharCode(ch);
    }
    return out;
  }

  exports.call_mb_cur_max();
  assert.strictEqual(exports.last_eax(), 1, '__mb_cur_max reports single-byte ANSI');
  assert.strictEqual(exports.last_esp_delta(), 4, '__mb_cur_max preserves cdecl cleanup');

  exports.call_p_environ();
  const environSlot = exports.last_eax() >>> 0;
  assert(environSlot, '__p__environ returns a stable slot');
  assert.strictEqual(exports.last_esp_delta(), 4, '__p__environ preserves cdecl cleanup');
  const envp = exports.guest_read32(environSlot) >>> 0;
  assert(envp, '__p__environ slot points at the envp vector');
  assert.strictEqual(exports.guest_read32(envp) >>> 0, 0, 'envp is a valid empty vector');
  const replacementEnvp = exports.guest_alloc(4) >>> 0;
  exports.guest_write32(replacementEnvp, 0);
  exports.guest_write32(environSlot, replacementEnvp);

  exports.call_p_initenv();
  const initenvSlot = exports.last_eax() >>> 0;
  assert(initenvSlot && initenvSlot !== environSlot,
    '__p___initenv returns its own slot, not &_environ');
  assert.strictEqual(exports.guest_read32(initenvSlot) >>> 0, envp,
    '__initenv preserves the startup vector after _environ is reassigned');
  assert.strictEqual(exports.last_esp_delta(), 4, '__p___initenv preserves cdecl cleanup');
  assert.strictEqual(exports.guest_read32(environSlot) >>> 0, replacementEnvp,
    '_environ retains its reassigned current vector');
  exports.call_p_initenv();
  assert.strictEqual(exports.last_eax() >>> 0, initenvSlot, '__p___initenv slot is stable');

  exports.call_cexit();
  assert.strictEqual(exports.last_eax() >>> 0, 0x12345678, '_cexit has no return value');
  assert.strictEqual(exports.last_esp_delta(), 4, '_cexit preserves cdecl cleanup');

  exports.call_getdrive();
  assert.strictEqual(exports.last_eax(), 3, '_getdrive reports C:');
  assert.strictEqual(exports.last_esp_delta(), 4, '_getdrive preserves cdecl cleanup');

  exports.call_iob();
  const iob = exports.last_eax() >>> 0;
  assert(iob, '_iob returns a stable FILE table');
  assert.strictEqual(exports.last_esp_delta(), 4, '_iob preserves cdecl cleanup');
  assert.strictEqual(exports.guest_read32(iob) >>> 0, 0, '_iob table starts zeroed');

  exports.call_isctype(0x41, 0x0101);
  assert.strictEqual(exports.last_eax(), 0x0101, '_isctype reports uppercase alpha');
  assert.strictEqual(exports.last_esp_delta(), 4, '_isctype preserves cdecl cleanup');
  exports.call_isctype(0x39, 0x0084);
  assert.strictEqual(exports.last_eax(), 0x0084, '_isctype reports digit and hex digit');
  exports.call_isctype(0x20, 0x0048);
  assert.strictEqual(exports.last_eax(), 0x0048, '_isctype reports blank and space');

  exports.call_pctype();
  const pctype = exports.last_eax() >>> 0;
  assert(pctype, '_pctype returns a stable table');
  assert.strictEqual(exports.last_esp_delta(), 4, '_pctype preserves cdecl cleanup');
  assert.strictEqual(guestRead16(exports, pctype + ((0x41 + 1) * 2)) & 0x0101, 0x0101,
    '_pctype table marks A as uppercase alpha');
  assert.strictEqual(guestRead16(exports, pctype + ((0x20 + 1) * 2)) & 0x0048, 0x0048,
    '_pctype table marks space as blank and space');

  exports.call_setmode();
  assert.strictEqual(exports.last_eax(), 0x4000, '_setmode returns previous text mode');
  assert.strictEqual(exports.last_esp_delta(), 4, '_setmode preserves cdecl cleanup');

  exports.call_atof(guestCString('  -12.75e1x'));
  assert(Math.abs(exports.last_f64() + 127.5) < 0.000001, 'atof parses signed decimal exponents');
  assert.strictEqual(exports.last_esp_delta(), 4, 'atof preserves cdecl cleanup');

  const strtodInput = guestCString('2.5e2');
  const endptr = exports.guest_alloc(4) >>> 0;
  exports.call_strtod(strtodInput, endptr);
  assert(Math.abs(exports.last_f64() - 250) < 0.000001, 'strtod parses decimal exponents');
  assert.strictEqual(exports.guest_read32(endptr) >>> 0, strtodInput, 'strtod writes a conservative endptr');
  assert.strictEqual(exports.last_esp_delta(), 4, 'strtod preserves cdecl cleanup');

  exports.call_clock();
  assert(exports.last_eax() >= 0, 'clock returns a non-negative tick count');
  assert.strictEqual(exports.last_esp_delta(), 4, 'clock preserves cdecl cleanup');

  const memchrBuf = guestCString('abcabc');
  exports.call_memchr(memchrBuf, 0x62, 6);
  assert.strictEqual(exports.last_eax() >>> 0, (memchrBuf + 1) >>> 0, 'memchr returns first matching byte');
  assert.strictEqual(exports.last_esp_delta(), 4, 'memchr preserves cdecl cleanup');
  exports.call_memchr(memchrBuf, 0x7a, 6);
  assert.strictEqual(exports.last_eax(), 0, 'memchr returns NULL when not found');

  const strncatDst = guestCString('ab', 16);
  exports.call_strncat(strncatDst, guestCString('cdef'), 2);
  assert.strictEqual(exports.last_eax() >>> 0, strncatDst, 'strncat returns dest');
  assert.strictEqual(exports.last_esp_delta(), 4, 'strncat preserves cdecl cleanup');
  assert.strictEqual(guestReadCString(strncatDst), 'abcd', 'strncat appends at most count bytes');
  assert.strictEqual(exports.guest_read8(strncatDst + 4), 0, 'strncat terminates after a partial append');

  exports.call_strncat(strncatDst, guestCString('zz'), 0);
  assert.strictEqual(guestReadCString(strncatDst), 'abcd', 'strncat count zero leaves dest unchanged');

  const shortDst = guestCString('x', 16);
  exports.call_strncat(shortDst, guestCString('y'), 8);
  assert.strictEqual(guestReadCString(shortDst), 'xy', 'strncat stops at source NUL before count');

  exports.call_strerror(2);
  const strerrorPtr = exports.last_eax() >>> 0;
  assert(strerrorPtr, 'strerror returns a static string');
  assert.strictEqual(exports.guest_read8(strerrorPtr), 0x55, 'strerror string is readable');
  assert.strictEqual(exports.last_esp_delta(), 4, 'strerror preserves cdecl cleanup');

  const tmpnamBuf = exports.guest_alloc(32) >>> 0;
  exports.call_tmpnam(tmpnamBuf);
  assert.strictEqual(exports.last_eax() >>> 0, tmpnamBuf, 'tmpnam returns caller buffer');
  assert.strictEqual(exports.guest_read8(tmpnamBuf), 0x43, 'tmpnam writes a DOS path');
  assert.strictEqual(exports.guest_read8(tmpnamBuf + 1), 0x3a, 'tmpnam writes a drive prefix');
  assert.strictEqual(exports.last_esp_delta(), 4, 'tmpnam preserves cdecl cleanup');

  exports.call_dup(7);
  assert.strictEqual(exports.last_eax(), 7, '_dup aliases a non-negative CRT file handle');
  assert.strictEqual(exports.last_esp_delta(), 4, '_dup preserves cdecl cleanup');
  exports.call_dup(-1);
  assert.strictEqual(exports.last_eax(), -1, '_dup rejects a negative CRT file handle');

  const abortApi = require('../src/api_table.json').find(entry => entry.name === 'abort');
  assert(abortApi && abortApi.convention === 'cdecl', 'abort resolves as a cdecl CRT export');
  const apiTable = require('../src/api_table.json');
  for (const name of ['_chdir', '_dup', '_unlink', '_write', 'atof', 'clock', 'fgets', 'memchr', 'strerror', 'strtod', 'tmpnam', 'vfprintf', 'vsprintf', 'acos', 'asin', 'atan', 'atan2', 'cos', 'exp', 'fabs', 'floor', 'fmod', 'frexp', 'ldexp', 'log', 'tan']) {
    const api = apiTable.find(entry => entry.name === name);
    assert(api && api.convention === 'cdecl', `${name} resolves as a cdecl CRT math export`);
  }

  console.log('PASS  old MSVCRT startup helpers preserve narrow/wide initial environment state');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
