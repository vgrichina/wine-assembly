#!/usr/bin/env node
'use strict';

// H440 is an exact, opt-in lowering of MW3's counted RGB565 color-key row.
// Compare it with ordinary x86, including destination/source overlap: batching
// source loads before stores would be observably wrong for that case.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readPE } = require('../lib/pe');
const { bootRenderHarness } = require('./render-helper');

const EXTRA_WAT = `
  (func (export "test_colorkey_matches") (result i32)
    (global.get $loop_rgb565_colorkey_matches))
  (func (export "test_colorkey_runs") (result i32)
    (global.get $loop_rgb565_colorkey_runs))
  (func (export "test_colorkey_pixels") (result i64)
    (global.get $loop_rgb565_colorkey_pixels))
  (func (export "test_colorkey_seed_cf")
    (call $set_flags_sub (i32.const 0) (i32.const 1) (i32.const -1)))
  (func (export "test_colorkey_cf") (result i32) (call $get_cf))
  (func (export "test_colorkey_zf") (result i32) (call $get_zf))
  (func (export "test_colorkey_sf") (result i32) (call $get_sf))
  (func (export "test_colorkey_of") (result i32) (call $get_of))
`;

const LOOP_EIP = 0x00528268;
const EXIT_EIP = 0x0052827b;
const KEY = 0x7bef;
const mw3Exe = path.join(__dirname, '..', 'binaries', 'shareware', 'mw3', 'ex',
  'Program_Files', 'mech3demo.exe');

const pe = readPE(mw3Exe);
const loopOff = pe.va2off(LOOP_EIP);
assert(loopOff >= 0, 'authentic color-key row is file-backed');
const authenticLoop = Uint8Array.from(
  pe.buf.subarray(loopOff, loopOff + EXIT_EIP - LOOP_EIP));
assert.deepStrictEqual(Array.from(authenticLoop), [
  0x66, 0x8b, 0x08, 0x66, 0x3b, 0x4d, 0x0c, 0x74, 0x04,
  0x66, 0x89, 0x0c, 0x18, 0x83, 0xc0, 0x02, 0x4e, 0x75, 0xed,
], 'test remains pinned to the verified MW3 instruction sequence');

async function makeRuntime({ enabled, nearMiss = false }) {
  const { exports: e, memory } = await bootRenderHarness({
    extraWat: EXTRA_WAT,
    fonts: 'none',
  });
  const fixture = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  let bytes = new Uint8Array(memory.buffer);
  bytes.set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE loads');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => e.guest_to_wasm
    ? e.guest_to_wasm(guest) >>> 0
    : (guest - imageBase + guestBase) >>> 0;
  const loop = Uint8Array.from(authenticLoop);
  if (nearMiss) loop[6] = 0x10; // cmp cx,[ebp+0x10]: valid, equivalent test setup.
  bytes.set(loop, wa(LOOP_EIP));
  bytes[wa(EXIT_EIP)] = 0xc3;
  e.set_loop_copy_emit(enabled ? 1 : 0);

  const arena = e.guest_alloc(0x8000) >>> 0;
  const frame = (arena + 0x200) >>> 0;
  const stack = (arena + 0x400) >>> 0;
  const srcBase = (arena + 0x2000) >>> 0;
  const disjointDst = (arena + 0x4000) >>> 0;

  function run({ count, offset, salt }) {
    bytes = new Uint8Array(memory.buffer);
    const dv = new DataView(memory.buffer);
    const arenaWa = wa(arena);
    for (let i = 0; i < 0x7000; i++) bytes[arenaWa + i] = (i * 29 + salt * 17) & 0xff;

    for (let i = 0; i < count; i++) {
      const word = ((i + salt) % 3 === 0)
        ? KEY
        : ((0x1234 + i * 0x421 + salt * 0x111) & 0xffff);
      dv.setUint16(wa(srcBase + i * 2), word, true);
    }
    const dst = offset === null ? disjointDst : (srcBase + offset) >>> 0;
    const ebx = (dst - srcBase) >>> 0;
    dv.setUint16(wa(frame + 12), KEY, true);
    dv.setUint16(wa(frame + 16), KEY, true);
    dv.setUint32(wa(stack), 0, true);

    e.test_colorkey_seed_cf();
    e.set_eax(srcBase);
    e.set_ecx(0xa5a50000);
    e.set_edx(0x2468ace0);
    e.set_ebx(ebx);
    e.set_esp(stack);
    e.set_ebp(frame);
    e.set_esi(count);
    e.set_edi(0x13579bdf);
    e.set_eip(LOOP_EIP);
    e.run(1000000);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'isolated row returns');

    return {
      memory: Array.from(bytes.subarray(wa(arena + 0x1800), wa(arena + 0x5100))),
      state: {
        eax: e.get_eax() >>> 0,
        ecx: e.get_ecx() >>> 0,
        edx: e.get_edx() >>> 0,
        ebx: e.get_ebx() >>> 0,
        esp: e.get_esp() >>> 0,
        ebp: e.get_ebp() >>> 0,
        esi: e.get_esi() >>> 0,
        edi: e.get_edi() >>> 0,
        cf: e.test_colorkey_cf(),
        zf: e.test_colorkey_zf(),
        sf: e.test_colorkey_sf(),
        of: e.test_colorkey_of(),
      },
    };
  }
  return { e, run };
}

(async () => {
  const ordinary = await makeRuntime({ enabled: false });
  const fused = await makeRuntime({ enabled: true });
  const scenarios = [
    { count: 1, offset: null, salt: 0 },
    { count: 8, offset: null, salt: 1 },
    { count: 37, offset: null, salt: 2 },
    { count: 8, offset: 2, salt: 3 },   // store overwrites the next source word
    { count: 8, offset: -2, salt: 4 },  // destination trails the source cursor
  ];
  for (const scenario of scenarios) {
    const expected = ordinary.run(scenario);
    const actual = fused.run(scenario);
    assert.deepStrictEqual(actual.memory, expected.memory,
      `H440 memory matches ordinary x86 for ${JSON.stringify(scenario)}`);
    assert.deepStrictEqual(actual.state, expected.state,
      `H440 registers/flags match ordinary x86 for ${JSON.stringify(scenario)}`);
  }
  assert.strictEqual(ordinary.e.test_colorkey_matches(), 0,
    'disabled opt-in leaves the authentic row ordinary');
  assert.strictEqual(fused.e.test_colorkey_matches(), 1,
    'enabled authentic row is recognized once and cached');
  assert.strictEqual(fused.e.test_colorkey_runs(), scenarios.length,
    'each complete row enters H440 once');
  assert.strictEqual(fused.e.test_colorkey_pixels(), 62n,
    'H440 processed the exact sum of the guest ESI counts');

  const near = await makeRuntime({ enabled: true, nearMiss: true });
  near.run({ count: 8, offset: null, salt: 5 });
  assert.strictEqual(near.e.test_colorkey_matches(), 0,
    'valid addressing near miss remains ordinary x86');
  assert.strictEqual(near.e.test_colorkey_runs(), 0,
    'near miss never reaches H440');

  console.log('PASS  MW3 RGB565 H440 is exact, opt-in, overlap-safe, and x86-equivalent');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
