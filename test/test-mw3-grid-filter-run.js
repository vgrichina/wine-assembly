#!/usr/bin/env node
'use strict';

// H441 is an exact lowering of MW3's hot in-place 16-bit terrain/grid filter.
// Compare authentic ordinary x86 and fused execution byte-for-byte, including
// registers and the ADD-then-DEC flag ordering at the loop exit.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readPE } = require('../lib/pe');
const { bootRenderHarness } = require('./render-helper');

const EXTRA_WAT = `
  (func (export "test_grid_matches") (result i32)
    (global.get $loop_mw3_grid_filter_matches))
  (func (export "test_grid_runs") (result i32)
    (global.get $loop_mw3_grid_filter_runs))
  (func (export "test_grid_cells") (result i64)
    (global.get $loop_mw3_grid_filter_cells))
  (func (export "test_grid_cf") (result i32) (call $get_cf))
  (func (export "test_grid_zf") (result i32) (call $get_zf))
  (func (export "test_grid_sf") (result i32) (call $get_sf))
  (func (export "test_grid_of") (result i32) (call $get_of))
`;

const LOOP_EIP = 0x00518f02;
const EXIT_EIP = 0x00518f67;
const RELOCATED_EIP = 0x0052b000;
const mw3Exe = path.join(__dirname, '..', 'binaries', 'shareware', 'mw3', 'ex',
  'Program_Files', 'mech3demo.exe');

const pe = readPE(mw3Exe);
const loopOff = pe.va2off(LOOP_EIP);
assert(loopOff >= 0, 'authentic grid-filter loop is file-backed');
const authenticLoop = Uint8Array.from(
  pe.buf.subarray(loopOff, loopOff + EXIT_EIP - LOOP_EIP));
assert.strictEqual(authenticLoop.length, 101, 'authentic loop remains 101 bytes');
assert.deepStrictEqual(Array.from(authenticLoop.subarray(0, 4)),
  [0x8b, 0x54, 0x24, 0x20], 'authentic loop head remains pinned');
assert.deepStrictEqual(Array.from(authenticLoop.subarray(95)),
  [0x8b, 0x4c, 0x24, 0x14, 0x75, 0x9b],
  'authentic width reload/backedge remains pinned');

async function makeRuntime({ enabled, nearMiss = false, location = LOOP_EIP }) {
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
  if (nearMiss) loop[22] ^= 1; // movsx edx,[eax+3], still a valid memory form.
  const exit = (location + loop.length) >>> 0;
  bytes.set(loop, wa(location));
  bytes[wa(exit)] = 0xc3;
  e.set_loop_copy_emit(enabled ? 1 : 0);

  const arena = e.guest_alloc(0xc000) >>> 0;
  const stack = (arena + 0x1000) >>> 0;
  const row = (arena + 0x5000) >>> 0;
  const lower = (arena + 0x7000) >>> 0;

  function run({ count, width, stride, salt }) {
    bytes = new Uint8Array(memory.buffer);
    const dv = new DataView(memory.buffer);
    const arenaWa = wa(arena);
    for (let i = 0; i < 0xb000; i++) {
      bytes[arenaWa + i] = (i * 37 + salt * 53 + (i >>> 3)) & 0xff;
    }
    dv.setUint32(wa(stack), 0, true); // RET target after the loop falls through.
    dv.setUint32(wa(stack + 0x10), count >>> 0, true);
    dv.setUint32(wa(stack + 0x14), width >>> 0, true);
    dv.setUint32(wa(stack + 0x20), stride >>> 0, true);

    e.set_eax(row);
    e.set_ecx(width);
    e.set_edx(0x2468ace0);
    e.set_ebx(0x13579bdf);
    e.set_esp(stack);
    e.set_ebp(0x1234abcd);
    e.set_esi(lower);
    e.set_edi(0x89abcdef);
    e.reset_handler_hist();
    e.set_handler_hist_enabled(1);
    e.set_eip(location);
    e.run(1000000);
    e.set_handler_hist_enabled(0);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'isolated grid row returns');

    const hist = new Uint32Array(memory.buffer, e.get_handler_hist_base(),
      e.get_handler_hist_slots());
    const dispatches = hist.reduce((sum, value) => sum + value, 0);

    return {
      dispatches,
      memory: Array.from(bytes.subarray(arenaWa, arenaWa + 0xb000)),
      state: {
        eax: e.get_eax() >>> 0,
        ecx: e.get_ecx() >>> 0,
        edx: e.get_edx() >>> 0,
        ebx: e.get_ebx() >>> 0,
        esp: e.get_esp() >>> 0,
        ebp: e.get_ebp() >>> 0,
        esi: e.get_esi() >>> 0,
        edi: e.get_edi() >>> 0,
        cf: e.test_grid_cf(),
        zf: e.test_grid_zf(),
        sf: e.test_grid_sf(),
        of: e.test_grid_of(),
      },
    };
  }
  return { e, run };
}

(async () => {
  const ordinary = await makeRuntime({ enabled: false });
  const fused = await makeRuntime({ enabled: true });
  const scenarios = [
    { count: 1, width: 7, stride: 0x40, salt: 1 },
    { count: 8, width: 9, stride: 0x60, salt: 2 },
    { count: 37, width: 13, stride: 0x80, salt: 3 },
  ];
  let ordinaryDispatches = 0;
  let fusedDispatches = 0;
  for (const scenario of scenarios) {
    const expected = ordinary.run(scenario);
    const actual = fused.run(scenario);
    ordinaryDispatches += expected.dispatches;
    fusedDispatches += actual.dispatches;
    assert.deepStrictEqual(actual.memory, expected.memory,
      `H441 memory matches ordinary x86 for ${JSON.stringify(scenario)}`);
    assert.deepStrictEqual(actual.state, expected.state,
      `H441 registers/flags match ordinary x86 for ${JSON.stringify(scenario)}`);
    assert(actual.dispatches < expected.dispatches,
      `H441 lowers dispatch for ${JSON.stringify(scenario)}`);
  }
  assert.strictEqual(ordinaryDispatches, 1705,
    'ordinary authentic rows retire 37 handlers per cell plus RET');
  assert.strictEqual(fusedDispatches, 7,
    'H441 retires one handler per safety chunk plus RET');
  assert.strictEqual(ordinary.e.test_grid_matches(), 0,
    'disabled opt-in leaves the authentic grid filter ordinary');
  assert.strictEqual(fused.e.test_grid_matches(), 1,
    'enabled authentic grid filter is recognized once and cached');
  assert.strictEqual(fused.e.test_grid_runs(), 4,
    'the 37-cell row resumes once at the 1000-handler safety quantum');
  assert.strictEqual(fused.e.test_grid_cells(), 46n,
    'H441 processes the exact sum of guest loop counts');

  const relocated = await makeRuntime({ enabled: true, location: RELOCATED_EIP });
  const relocatedScenario = { count: 8, width: 11, stride: 0x70, salt: 4 };
  const relocatedExpected = ordinary.run(relocatedScenario);
  const relocatedActual = relocated.run(relocatedScenario);
  assert.deepStrictEqual(relocatedActual.memory, relocatedExpected.memory,
    'relocated authentic grid filter remains byte-identical');
  assert.deepStrictEqual(relocatedActual.state, relocatedExpected.state,
    'matcher-derived back/fall VAs preserve relocated grid-filter state');
  assert.strictEqual(relocated.e.test_grid_matches(), 1,
    'authentic grid-filter bytes match at an arbitrary VA');
  assert.strictEqual(relocated.e.test_grid_runs(), 1,
    'relocated stream reaches H441 once');
  assert.strictEqual(relocated.e.test_grid_cells(), 8n,
    'relocated H441 consumes the supplied counter');

  const near = await makeRuntime({ enabled: true, nearMiss: true });
  near.run({ count: 8, width: 9, stride: 0x60, salt: 5 });
  assert.strictEqual(near.e.test_grid_matches(), 0,
    'one-byte valid near miss remains ordinary x86');
  assert.strictEqual(near.e.test_grid_runs(), 0,
    'near miss never reaches H441');

  console.log('PASS  MW3 H441 grid filter is exact, scalar-ordered, and address-independent');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
