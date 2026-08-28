#!/usr/bin/env node
'use strict';

// Semantic regression for AoE I/II's exact six-op pathfinding-grid row fill.
// Compare ordinary x86 with H437 across a run longer than one 1000-step
// quantum, then prove that a valid immediate-value near miss stays ordinary.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const EXTRA_WAT = `
  (func (export "test_aoe_fill_cf") (result i32) (call $get_cf))
  (func (export "test_aoe_fill_zf") (result i32) (call $get_zf))
  (func (export "test_aoe_fill_sf") (result i32) (call $get_sf))
  (func (export "test_aoe_fill_of") (result i32) (call $get_of))
`;

const LOOP = Uint8Array.from([
  0x8b, 0xbe, 0x08, 0x04, 0x00, 0x00, // mov edi,[esi+0x408]
  0x40,                               // inc eax
  0x3b, 0xc2,                         // cmp eax,edx
  0x8b, 0x3c, 0x8f,                   // mov edi,[edi+ecx*4]
  0xc6, 0x44, 0x07, 0xff, 0xff,       // mov byte [edi+eax-1],0xff
  0x7c, 0xed,                         // jl loop
  0xc3,
]);

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat: EXTRA_WAT, fonts: 'none' });
  const fixture = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  let bytes = new Uint8Array(memory.buffer);
  bytes.set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE loads');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = ga => e.test_g2w ? e.test_g2w(ga) >>> 0 : (ga - imageBase + guestBase) >>> 0;
  const codeBase = (imageBase + 0x2600) >>> 0;
  const arena = e.guest_alloc(0x80000) >>> 0;
  bytes = new Uint8Array(memory.buffer);
  const object = (arena + 0x1000) >>> 0;
  const table = (arena + 0x2000) >>> 0;
  const row = (arena + 0x4000) >>> 0;
  const stack = (arena + 0x70000) >>> 0;
  const rowIndex = 3;
  const end = 384;

  function install(offset, code = LOOP) {
    const ga = (codeBase + offset) >>> 0;
    bytes.set(code, wa(ga));
    return ga;
  }

  function run(code, enabled) {
    bytes.fill(0x31, wa(row), wa(row) + end + 8);
    e.guest_write32(object + 0x408, table);
    e.guest_write32(table + rowIndex * 4, row);
    e.guest_write32(stack, 0);
    e.set_loop_aoe_fill_emit(enabled ? 1 : 0);
    e.set_eax(0xffffffff); e.set_ecx(rowIndex); e.set_edx(end); e.set_ebx(0x33445566);
    e.set_esp(stack); e.set_ebp(0x778899aa); e.set_esi(object); e.set_edi(0xabcdef01);
    e.set_eip(code);
    e.run(100000);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'isolated fill returns');
    return {
      bytes: Array.from(bytes.subarray(wa(row), wa(row) + end + 8)),
      state: {
        eax: e.get_eax() >>> 0, ecx: e.get_ecx() >>> 0,
        edx: e.get_edx() >>> 0, ebx: e.get_ebx() >>> 0,
        esp: e.get_esp() >>> 0, ebp: e.get_ebp() >>> 0,
        esi: e.get_esi() >>> 0, edi: e.get_edi() >>> 0,
        cf: e.test_aoe_fill_cf(), zf: e.test_aoe_fill_zf(),
        sf: e.test_aoe_fill_sf(), of: e.test_aoe_fill_of(),
      },
    };
  }

  const ordinaryCode = install(0);
  const fusedCode = install(0x100);
  const ordinary = run(ordinaryCode, false);
  const matchesBefore = e.get_loop_aoe_fill_matches();
  assert.strictEqual(matchesBefore, 1,
    'disabled lowering still recognizes the exact loop for diagnostics');
  const fused = run(fusedCode, true);
  assert.deepStrictEqual(fused, ordinary,
    'H437 preserves the filled bytes, registers, and final CMP flags');
  assert.strictEqual(e.get_loop_aoe_fill_matches(), matchesBefore + 1,
    'enabled fresh block is recognized once');
  assert(e.get_loop_aoe_fill_runs() >= 1, 'H437 executes');
  assert(e.get_loop_aoe_fill_bytes() >= BigInt(end),
    'H437 accounts for every filled byte across budgeted entries');
  assert.deepStrictEqual(fused.bytes.slice(0, end), Array(end).fill(0xff),
    'requested row extent is filled');
  assert.deepStrictEqual(fused.bytes.slice(end), Array(8).fill(0x31),
    'fill does not overwrite the byte after the bound');

  const near = Uint8Array.from(LOOP);
  near[16] = 0xfe;
  const nearCode = install(0x200, near);
  const nearMatches = e.get_loop_aoe_fill_matches();
  e.guest_write32(stack, 0);
  e.set_eax(0xffffffff); e.set_ecx(rowIndex); e.set_edx(1);
  e.set_esp(stack); e.set_esi(object); e.set_eip(nearCode);
  e.run(1000);
  assert.strictEqual(e.get_loop_aoe_fill_matches(), nearMatches,
    'different fill immediate remains ordinary x86');
  assert.strictEqual(bytes[wa(row)], 0xfe, 'near miss executes its original immediate');

  if (process.argv.includes('--bench')) {
    const benchEnd = 300000;
    const bench = enabled => {
      bytes.fill(0x31, wa(row), wa(row) + benchEnd + 8);
      e.guest_write32(object + 0x408, table);
      e.guest_write32(table + rowIndex * 4, row);
      e.guest_write32(stack, 0);
      e.set_loop_aoe_fill_emit(enabled ? 1 : 0);
      e.set_eax(0xffffffff); e.set_ecx(rowIndex); e.set_edx(benchEnd);
      e.set_esp(stack); e.set_esi(object); e.set_eip(enabled ? fusedCode : ordinaryCode);
      const started = process.hrtime.bigint();
      try {
        e.run(10000000);
      } catch (error) {
        error.message += ` at guest eip=0x${(e.get_eip() >>> 0).toString(16)}`;
        throw error;
      }
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      assert.strictEqual(e.get_eip() >>> 0, 0, 'benchmark fill returns');
      return elapsed;
    };
    bench(false); bench(true);
    const ordinaryMs = bench(false);
    const fusedMs = bench(true);
    console.log(`BENCH AoE grid fill ${benchEnd} bytes: ordinary=${ordinaryMs.toFixed(1)}ms `
      + `fused=${fusedMs.toFixed(1)}ms speedup=${(ordinaryMs / fusedMs).toFixed(2)}x`);
  }

  console.log('PASS  AoE grid FILL_RUN is exact, budgeted, and state-equivalent');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
