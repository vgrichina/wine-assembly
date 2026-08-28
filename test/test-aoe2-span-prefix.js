#!/usr/bin/env node
'use strict';

// State-equivalence coverage for the shared AoE I/II span-builder prefix
// handler. Allocation and list mutation deliberately remain on the ordinary
// decoder at one of three semantic continuation boundaries.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');
const { readPE } = require('../lib/pe');

const AOE2_ENTRY = 0x00517750;
const PREFIX_LEN = 0x6a;
const AOE1_ENTRY = 0x0049dd20;
const AOE1_PREFIX_LEN = 0x6b;
const EXTRA_WAT = `
  (func (export "test_aoe_span_cf") (result i32) (call $get_cf))
  (func (export "test_aoe_span_zf") (result i32) (call $get_zf))
  (func (export "test_aoe_span_sf") (result i32) (call $get_sf))
  (func (export "test_aoe_span_of") (result i32) (call $get_of))
`;

function pePrefix(file, entry, length) {
  if (!fs.existsSync(file)) return null;
  const pe = readPE(file);
  const off = pe.va2off(entry);
  return Uint8Array.from(pe.buf.subarray(off, off + length));
}

(async () => {
  const prefix = pePrefix(
    path.join(__dirname, 'binaries', 'shareware', 'aoe2', 'aoe2_ex', 'EMPIRES2.EXE'),
    AOE2_ENTRY, PREFIX_LEN);
  if (!prefix) {
    console.log('SKIP  EMPIRES2.EXE not found');
    return;
  }
  const { exports: e, memory } = await bootRenderHarness({ extraWat: EXTRA_WAT, fonts: 'none' });
  const fixture = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  let bytes = new Uint8Array(memory.buffer);
  bytes.set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE loads');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = ga => e.test_g2w ? e.test_g2w(ga) >>> 0 : (ga - imageBase + guestBase) >>> 0;
  const code = (imageBase + 0x2800) >>> 0;
  const arena = e.guest_alloc(0x10000) >>> 0;
  bytes = new Uint8Array(memory.buffer);
  bytes.set(prefix, wa(code));
  for (const [off, expected] of [
    [0, 0x8b565553], [4, 0x7c8b57f1], [0x20, 0x18246c8b],
    [0x50, 0x14244489], [0x60, 0x8b3c468b],
  ]) {
    assert.strictEqual(e.guest_read32(code + off) >>> 0, expected >>> 0,
      `authentic matcher word +0x${off.toString(16)}`);
  }
  assert.strictEqual(e.guest_read32(code + 0x67) & 0xffff, 0x75c0,
    'authentic matcher tail +0x67');

  const stack = (arena + 0x1000) >>> 0;
  const object = (arena + 0x2000) >>> 0;
  const rowTable = (arena + 0x4000) >>> 0;
  const old = {
    eax: 0xaaaaaaaa, ebx: 0xbbbbbbbb, edx: 0xdddddddd,
    ebp: 0xeeeeeeee, esi: 0x51515151, edi: 0x71717171,
  };

  function prepare({ row = 3, x0 = 20, x1 = 40, rowHead = 0,
    minRow = 0, maxRow = 10, minX = 10, maxX = 100 } = {}) {
    e.set_eip(code); e.set_esp(stack); e.set_ecx(object);
    e.set_eax(old.eax); e.set_ebx(old.ebx); e.set_edx(old.edx);
    e.set_ebp(old.ebp); e.set_esi(old.esi); e.set_edi(old.edi);
    e.guest_write32(stack, 0x12345678);
    e.guest_write32(stack + 4, x0);
    e.guest_write32(stack + 8, x1);
    e.guest_write32(stack + 12, row);
    e.guest_write32(object + 0x3c, rowTable);
    e.guest_write32(object + 0x58, minX);
    e.guest_write32(object + 0x5c, maxX);
    e.guest_write32(object + 0x60, minRow);
    e.guest_write32(object + 0x64, maxRow);
    e.guest_write32(rowTable + row * 4, rowHead);
    return { row, rowHead };
  }

  function assertPrologue(name) {
    assert.strictEqual(e.get_esp() >>> 0, stack - 16, `${name}: esp`);
    assert.strictEqual(e.guest_read32(stack - 4) >>> 0, old.ebx, `${name}: pushed ebx`);
    assert.strictEqual(e.guest_read32(stack - 8) >>> 0, old.ebp, `${name}: pushed ebp`);
    assert.strictEqual(e.guest_read32(stack - 12) >>> 0, old.esi, `${name}: pushed esi`);
    assert.strictEqual(e.guest_read32(stack - 16) >>> 0, old.edi, `${name}: pushed edi`);
    assert.strictEqual(e.get_esi() >>> 0, object, `${name}: esi=this`);
  }

  function snapshot() {
    return {
      eip: e.get_eip() >>> 0, esp: e.get_esp() >>> 0,
      eax: e.get_eax() >>> 0, ebx: e.get_ebx() >>> 0,
      ecx: e.get_ecx() >>> 0, edx: e.get_edx() >>> 0,
      ebp: e.get_ebp() >>> 0, esi: e.get_esi() >>> 0, edi: e.get_edi() >>> 0,
      flagOp: e.get_flag_op() >>> 0, flagRes: e.get_flag_res() >>> 0,
      cf: e.test_aoe_span_cf(), zf: e.test_aoe_span_zf(),
      sf: e.test_aoe_span_sf(), of: e.test_aoe_span_of(),
      stack: Array.from({ length: 8 }, (_, i) => e.guest_read32(stack - 16 + i * 4) >>> 0),
    };
  }

  function assertOrdinaryEquivalent(name, config, optimized, at = code) {
    prepare(config);
    e.set_eip(at);
    e.set_loop_aoe_span_emit(0);
    for (let blocks = 0; blocks < 32 && (e.get_eip() >>> 0) !== optimized.eip; blocks++) {
      e.run(1);
    }
    assert.deepStrictEqual(snapshot(), optimized,
      `${name}: shared handler and ordinary x86 leave identical state`);
    e.set_loop_aoe_span_emit(1);
  }

  e.set_loop_aoe_span_emit(1);
  let matches = e.get_loop_aoe_span_matches();

  const emptyConfig = { x0: 120, x1: 4, rowHead: 0 };
  const empty = prepare(emptyConfig);
  e.run(1);
  assert.strictEqual(e.get_eip() >>> 0, code + 0x6a, 'empty row continuation');
  assertPrologue('empty');
  assert.strictEqual(e.guest_read32(stack + 4) >>> 0, 10, 'empty: clipped x0 argument');
  assert.strictEqual(e.guest_read32(stack + 8) >>> 0, 100, 'empty: clipped x1 argument');
  assert.strictEqual(e.get_eax() >>> 0, 0, 'empty: eax=row head');
  assert.strictEqual(e.get_ebx() >>> 0, 10, 'empty: ebx=x0');
  assert.strictEqual(e.get_ebp() >>> 0, 100, 'empty: ebp=x1');
  assert.strictEqual(e.get_ecx() >>> 0, 100, 'empty: ecx=max x');
  assert.strictEqual(e.get_edi() >>> 0, empty.row, 'empty: edi remains row number');
  assert.strictEqual(e.get_flag_op() >>> 0, 3, 'empty: final flags are TEST');
  assert.strictEqual(e.get_flag_res() >>> 0, 0, 'empty: TEST is zero');
  assert.strictEqual(e.get_loop_aoe_span_matches(), matches + 1, 'authentic prefix matched');
  matches++;
  assertOrdinaryEquivalent('empty', emptyConfig, snapshot());

  const nonemptyConfig = { rowHead: 0x6000 };
  const nonempty = prepare(nonemptyConfig);
  e.run(1);
  assert.strictEqual(e.get_eip() >>> 0, code + 0xaf, 'non-empty row continuation');
  assertPrologue('nonempty');
  assert.strictEqual(e.get_eax() >>> 0, nonempty.rowHead, 'nonempty: eax=row head');
  assert.strictEqual(e.get_ebx() >>> 0, 20, 'nonempty: ebx=x0');
  assert.strictEqual(e.get_ebp() >>> 0, 40, 'nonempty: ebp=x1');
  assert.strictEqual(e.get_edi() >>> 0, nonempty.row, 'nonempty: edi=row number');
  assert.strictEqual(e.get_flag_res() >>> 0, nonempty.rowHead, 'nonempty: TEST result');
  assertOrdinaryEquivalent('nonempty', nonemptyConfig, snapshot());

  const rejectConfig = { row: 20, minRow: 0, maxRow: 10 };
  prepare(rejectConfig);
  e.run(1);
  assert.strictEqual(e.get_eip() >>> 0, code + 0x3b4, 'reject continuation');
  assertPrologue('reject');
  assert.strictEqual(e.get_eax() >>> 0, old.eax, 'reject: eax not reached');
  assert.strictEqual(e.get_ebx() >>> 0, old.ebx, 'reject: ebx not reached');
  assert.strictEqual(e.get_edx() >>> 0, old.edx, 'reject: edx unchanged');
  assert.strictEqual(e.get_edi() >>> 0, 20, 'reject: edi=row');
  assert.strictEqual(e.get_flag_op() >>> 0, 2, 'reject: final flags are CMP');
  assert.strictEqual(e.get_flag_a() >>> 0, 20, 'reject: CMP lhs');
  assert.strictEqual(e.get_flag_b() >>> 0, 10, 'reject: CMP rhs');
  assertOrdinaryEquivalent('reject', rejectConfig, snapshot());
  assert(e.get_loop_aoe_span_runs() >= 3, 'all three packet continuations executed');

  // A patched prefix must remain ordinary x86.
  const nearCode = code + 0x500;
  const near = Uint8Array.from(prefix);
  near[0x60] ^= 1;
  bytes.set(near, wa(nearCode));
  e.set_eip(nearCode); e.set_esp(stack); e.set_ecx(object);
  const nearMatches = e.get_loop_aoe_span_matches();
  e.run(1);
  assert.strictEqual(e.get_loop_aoe_span_matches(), nearMatches,
    'byte-signature near miss remains ordinary x86');

  // The same H438 algorithm must also accept AoE I's register allocation.
  const aoe1Prefix = pePrefix(
    path.join(__dirname, 'binaries', 'shareware', 'aoe', 'aoe_ex', 'Empires.exe'),
    AOE1_ENTRY, AOE1_PREFIX_LEN);
  if (aoe1Prefix) {
    const aoe1Code = code + 0x800;
    bytes.set(aoe1Prefix, wa(aoe1Code));
    const aoe1Config = { x0: 120, x1: 4, rowHead: 0 };
    prepare(aoe1Config);
    e.set_eip(aoe1Code);
    const aoe1Matches = e.get_loop_aoe_span_matches();
    e.run(1);
    assert.strictEqual(e.get_loop_aoe_span_matches(), aoe1Matches + 1,
      'AoE I authentic prefix selects the shared handler');
    assert.strictEqual(e.get_eip() >>> 0, aoe1Code + 0x6b,
      'AoE I empty-row continuation');
    assertPrologue('aoe1 empty');
    assert.strictEqual(e.guest_read32(stack + 4) >>> 0, 10,
      'AoE I: clipped x0 argument');
    assert.strictEqual(e.guest_read32(stack + 8) >>> 0, 100,
      'AoE I: clipped x1 argument');
    assert.strictEqual(e.get_eax() >>> 0, rowTable, 'AoE I: eax=row table');
    assert.strictEqual(e.get_ebx() >>> 0, 0, 'AoE I: ebx=row head');
    assert.strictEqual(e.get_ebp() >>> 0, 100, 'AoE I: ebp=x1');
    assert.strictEqual(e.get_ecx() >>> 0, 10, 'AoE I: ecx=min x');
    assert.strictEqual(e.get_edx() >>> 0, 100, 'AoE I: edx=max x');
    assert.strictEqual(e.get_edi() >>> 0, 12, 'AoE I: edi=row*4');
    assert.strictEqual(e.get_flag_res() >>> 0, 0, 'AoE I: TEST is zero');
    assertOrdinaryEquivalent('AoE I empty', aoe1Config, snapshot(), aoe1Code);
  }

  if (process.argv.includes('--bench')) {
    const iterations = 200000;
    const stub = [];
    const push = (...values) => stub.push(...values);
    const u32 = value => push(value & 255, (value >>> 8) & 255,
      (value >>> 16) & 255, (value >>> 24) & 255);
    push(0x5f, 0x5e, 0x5d, 0x5b);       // pop edi,esi,ebp,ebx
    push(0x4a);                          // dec edx
    push(0x74, 0x1a);                   // jz ret
    push(0xc7, 0x44, 0x24, 0x04); u32(120);
    push(0xc7, 0x44, 0x24, 0x08); u32(4);
    push(0xb9); u32(object);             // mov ecx,this
    push(0xe9);
    const jumpFrom = (code + PREFIX_LEN + stub.length + 4) >>> 0;
    u32((code - jumpFrom) >>> 0);
    push(0xc3);
    bytes.set(stub, wa(code + PREFIX_LEN));

    const bench = enabled => {
      prepare(emptyConfig);
      e.guest_write32(stack, 0);
      e.set_edx(iterations);
      e.set_loop_aoe_span_emit(enabled ? 1 : 0);
      const started = process.hrtime.bigint();
      try {
        e.run(iterations * 32);
      } catch (error) {
        error.message += ` at guest eip=0x${(e.get_eip() >>> 0).toString(16)}`;
        throw error;
      }
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      assert.strictEqual(e.get_eip() >>> 0, 0, 'benchmark loop returns');
      assert.strictEqual(e.get_edx() >>> 0, 0, 'benchmark loop count');
      return elapsed;
    };
    bench(false); bench(true); // warm both decoder paths and the JS/Wasm tier-up
    const ordinaryMs = bench(false);
    const sharedMs = bench(true);
    console.log(`BENCH AoE II span prefix ${iterations}x: ordinary=${ordinaryMs.toFixed(1)}ms `
      + `shared=${sharedMs.toFixed(1)}ms speedup=${(ordinaryMs / sharedMs).toFixed(2)}x`);
  }

  console.log('PASS  shared AoE I/II span prefix preserves register-layout state');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
