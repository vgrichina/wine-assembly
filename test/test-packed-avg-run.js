#!/usr/bin/env node
'use strict';

// H435 PACKED_AVG_RUN semantic regression. The fused handler owns only the
// iterations before the final one; the original final body publishes scratch
// registers and flags exactly as ordinary x86 does.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const EXTRA_WAT = `
  (func (export "test_avg_matches") (result i32) (global.get $loop_avg_matches))
  (func (export "test_avg_runs") (result i32) (global.get $loop_avg_runs))
  (func (export "test_avg_pixels") (result i64) (global.get $loop_avg_pixels))
  (func (export "test_avg_cf") (result i32) (call $get_cf))
  (func (export "test_avg_zf") (result i32) (call $get_zf))
  (func (export "test_avg_sf") (result i32) (call $get_sf))
  (func (export "test_avg_of") (result i32) (call $get_of))
`;

const MASK = 0xf7def7df;
const LOOP = Uint8Array.from([
  0x8b, 0x04, 0x8e,                   // mov eax,[esi+ecx*4]
  0x8b, 0x14, 0x8b,                   // mov edx,[ebx+ecx*4]
  0x25, 0xdf, 0xf7, 0xde, 0xf7,       // and eax,0xf7def7df
  0x81, 0xe2, 0xdf, 0xf7, 0xde, 0xf7, // and edx,0xf7def7df
  0x03, 0xc2,                         // add eax,edx
  0xd1, 0xd8,                         // rcr eax,1
  0x89, 0x04, 0x8f,                   // mov [edi+ecx*4],eax
  0x49,                               // dec ecx
  0x7d, 0xe5,                         // jge loop
  0xc3,
]);

const AVS_MASK = 0xff7f7f7f;
const AVS_LOOP = Uint8Array.from([
  0x8b, 0x3e,                         // mov edi,[esi]
  0x8b, 0x18,                         // mov ebx,[eax]
  0xd1, 0xef,                         // shr edi,1
  0xd1, 0xeb,                         // shr ebx,1
  0x81, 0xe7, 0x7f, 0x7f, 0x7f, 0xff, // and edi,0xff7f7f7f
  0x81, 0xe3, 0x7f, 0x7f, 0x7f, 0xff, // and ebx,0xff7f7f7f
  0x03, 0xfb,                         // add edi,ebx
  0x89, 0x7d, 0x00,                   // mov [ebp],edi
  0x83, 0xc6, 0x04,                   // add esi,4
  0x83, 0xc0, 0x04,                   // add eax,4
  0x83, 0xc5, 0x04,                   // add ebp,4
  0x49,                               // dec ecx
  0x75, 0xdb,                         // jnz loop
  0xc3,
]);

const ROUND_MASK = 0x08210821;
const ROUND_LOOP = Uint8Array.from([
  0x8b, 0x06,                         // mov eax,[esi]
  0x8b, 0x17,                         // mov edx,[edi]
  0x8b, 0xe8,                         // mov ebp,eax
  0x23, 0xea,                         // and ebp,edx
  0x81, 0xe5, 0x21, 0x08, 0x21, 0x08, // and ebp,0x08210821
  0xd1, 0xe8,                         // shr eax,1
  0xd1, 0xea,                         // shr edx,1
  0x25, 0xde, 0xf7, 0xde, 0xf7,       // and eax,0xf7def7de
  0x81, 0xe2, 0xde, 0xf7, 0xde, 0xf7, // and edx,0xf7def7de
  0x03, 0xc2,                         // add eax,edx
  0x03, 0xc5,                         // add eax,ebp
  0x89, 0x03,                         // mov [ebx],eax
  0x83, 0xc6, 0x04,                   // add esi,4
  0x83, 0xc7, 0x04,                   // add edi,4
  0x83, 0xc3, 0x04,                   // add ebx,4
  0x49,                               // dec ecx
  0x75, 0xd1,                         // jnz loop
  0xc3,
]);

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat: EXTRA_WAT, fonts: 'none' });
  const fixture = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  let bytes = new Uint8Array(memory.buffer);
  let dv = new DataView(memory.buffer);
  bytes.set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE loads');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const imageWa = ga => (ga - imageBase + guestBase) >>> 0;
  const wa = ga => e.test_g2w ? e.test_g2w(ga) >>> 0 : imageWa(ga);
  const codeBase = (imageBase + 0x2800) >>> 0;
  const stack = (imageBase + 0xd00000) >>> 0;
  let slot = 0;

  function install(code = LOOP) {
    const ga = (codeBase + slot++ * 0x100) >>> 0;
    bytes.set(code, imageWa(ga));
    return ga;
  }

  function runAt(code, { a, b, dst, count }) {
    e.set_eax(0x11111111); e.set_ecx((count - 1) >>> 0); e.set_edx(0x22222222);
    e.set_ebx(b); e.set_esp(stack); e.set_ebp(0x55555555); e.set_esi(a); e.set_edi(dst);
    dv.setUint32(imageWa(stack), 0, true);
    e.set_eip(code); e.run(100000);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'probe returns');
    return {
      eax: e.get_eax() >>> 0, ecx: e.get_ecx() >>> 0, edx: e.get_edx() >>> 0,
      ebx: e.get_ebx() >>> 0, esp: e.get_esp() >>> 0, ebp: e.get_ebp() >>> 0,
      esi: e.get_esi() >>> 0, edi: e.get_edi() >>> 0,
      cf: e.test_avg_cf(), zf: e.test_avg_zf(), sf: e.test_avg_sf(), of: e.test_avg_of(),
    };
  }

  const arena = e.guest_alloc(0xd000) >>> 0;
  bytes = new Uint8Array(memory.buffer);
  dv = new DataView(memory.buffer);
  const baselineCode = install();
  const fusedCode = install();
  const count = 301; // crosses the 1000-step quantum more than once
  const a0 = (arena + 0x100) >>> 0, b0 = (arena + 0x900) >>> 0;
  const d0 = (arena + 0x1100) >>> 0, d1 = (arena + 0x1900) >>> 0;
  const aBytes = Uint8Array.from({ length: count * 4 }, (_, i) => (i * 73 + 19) & 0xff);
  const bBytes = Uint8Array.from({ length: count * 4 }, (_, i) => (255 - i * 37) & 0xff);
  bytes.set(aBytes, wa(a0)); bytes.set(bBytes, wa(b0));
  bytes.fill(0xcc, wa(d0), wa(d0) + count * 4);
  bytes.fill(0xcc, wa(d1), wa(d1) + count * 4);

  e.set_loop_generic_copy_emit(0);
  const baseline = runAt(baselineCode, { a: a0, b: b0, dst: d0, count });
  assert.strictEqual(e.test_avg_matches(), 1, 'disabled gate still records recognition');
  e.set_loop_generic_copy_emit(1);
  const fused = runAt(fusedCode, { a: a0, b: b0, dst: d1, count });
  assert.strictEqual(e.test_avg_matches(), 2, 'fresh enabled block recognizes once');
  assert(e.test_avg_runs() > 1, 'long row re-enters H435 at budget boundaries');
  assert.strictEqual(e.test_avg_pixels() + BigInt(e.test_avg_runs()), BigInt(count),
    'each H435 invocation leaves exactly one ordinary suffix pixel');
  assert.deepStrictEqual(
    Array.from(bytes.subarray(wa(d1), wa(d1) + count * 4)),
    Array.from(bytes.subarray(wa(d0), wa(d0) + count * 4)),
    'fused packed averages are byte-identical');
  assert.deepStrictEqual({ ...fused, edi: d0 }, baseline,
    'ordinary final iteration preserves complete GPR/flag state');

  const aLast = new DataView(aBytes.buffer).getUint32(0, true) & MASK;
  const bLast = new DataView(bBytes.buffer).getUint32(0, true) & MASK;
  const expected = Number((BigInt(aLast >>> 0) + BigInt(bLast >>> 0)) >> 1n) >>> 0;
  assert.strictEqual(fused.eax, expected, 'final EAX is the ordinary ADD/RCR result');
  assert.strictEqual(fused.edx, bLast >>> 0, 'final EDX retains the second masked source');
  assert.strictEqual(fused.ecx, 0xffffffff, 'final DEC leaves signed index -1');

  // Runtime overlap must retain descending load-A/load-B/store order.
  const overlapBaselineCode = install();
  const overlapFusedCode = install();
  const overlap0 = (arena + 0x3000) >>> 0, overlap1 = (arena + 0x4000) >>> 0;
  const overlapInput = Uint8Array.from({ length: 96 }, (_, i) => (i * 29 + 3) & 0xff);
  bytes.set(overlapInput, wa(overlap0)); bytes.set(overlapInput, wa(overlap1));
  e.set_loop_generic_copy_emit(0);
  runAt(overlapBaselineCode, { a: overlap0, b: overlap0 + 32, dst: overlap0 + 1, count: 8 });
  e.set_loop_generic_copy_emit(1);
  runAt(overlapFusedCode, { a: overlap1, b: overlap1 + 32, dst: overlap1 + 1, count: 8 });
  assert.deepStrictEqual(
    Array.from(bytes.subarray(wa(overlap1), wa(overlap1) + 96)),
    Array.from(bytes.subarray(wa(overlap0), wa(overlap0) + 96)),
    'overlap follows original descending per-pixel access order');

  // Winamp AVS's common floor-average ordering shifts before applying the
  // mask and advances three cursor registers through a DEC/JNZ loop.
  const avsBaselineCode = install(AVS_LOOP);
  const avsFusedCode = install(AVS_LOOP);
  const avsCount = 173;
  const avsA = (arena + 0x5000) >>> 0, avsB = (arena + 0x5c00) >>> 0;
  const avsD0 = (arena + 0x6800) >>> 0, avsD1 = (arena + 0x7400) >>> 0;
  bytes.set(aBytes.subarray(0, avsCount * 4), wa(avsA));
  bytes.set(bBytes.subarray(0, avsCount * 4), wa(avsB));
  function runAvs(code, dst) {
    e.set_eax(avsB); e.set_ecx(avsCount); e.set_edx(0x24681357); e.set_ebx(0x11223344);
    e.set_esp(stack); e.set_ebp(dst); e.set_esi(avsA); e.set_edi(0x55667788);
    dv.setUint32(imageWa(stack), 0, true);
    e.set_eip(code); e.run(100000);
    assert.strictEqual(e.get_eip() >>> 0, 0);
    return {
      eax: (e.get_eax() - avsB) >>> 0, ecx: e.get_ecx() >>> 0,
      edx: e.get_edx() >>> 0, ebx: e.get_ebx() >>> 0,
      esp: e.get_esp() >>> 0, ebp: (e.get_ebp() - dst) >>> 0,
      esi: (e.get_esi() - avsA) >>> 0, edi: e.get_edi() >>> 0,
      cf: e.test_avg_cf(), zf: e.test_avg_zf(), sf: e.test_avg_sf(), of: e.test_avg_of(),
    };
  }
  e.set_loop_generic_copy_emit(0);
  const avsBaseline = runAvs(avsBaselineCode, avsD0);
  const avsMatches = e.test_avg_matches();
  e.set_loop_generic_copy_emit(1);
  const avsFused = runAvs(avsFusedCode, avsD1);
  assert.strictEqual(e.test_avg_matches(), avsMatches + 1, 'AVS cursor average recognizes');
  assert.deepStrictEqual(avsFused, avsBaseline, 'AVS fusion preserves final state');
  assert.deepStrictEqual(
    Array.from(bytes.subarray(wa(avsD1), wa(avsD1) + avsCount * 4)),
    Array.from(bytes.subarray(wa(avsD0), wa(avsD0) + avsCount * 4)),
    'shift-mask-add mode is byte-identical');

  // SDL/Smacker-style rounded averages preserve a shared low-bit correction
  // before shifting. The descriptor carries both masks rather than baking in
  // a pixel format.
  const roundBaselineCode = install(ROUND_LOOP);
  const roundFusedCode = install(ROUND_LOOP);
  const roundCount = 151;
  const roundA = (arena + 0x8000) >>> 0, roundB = (arena + 0x8c00) >>> 0;
  const roundD0 = (arena + 0x9800) >>> 0, roundD1 = (arena + 0xa400) >>> 0;
  bytes.set(aBytes.subarray(0, roundCount * 4), wa(roundA));
  bytes.set(bBytes.subarray(0, roundCount * 4), wa(roundB));
  function runRound(code, dst) {
    e.set_eax(0x11111111); e.set_ecx(roundCount); e.set_edx(0x22222222);
    e.set_ebx(dst); e.set_esp(stack); e.set_ebp(0x33333333);
    e.set_esi(roundA); e.set_edi(roundB);
    dv.setUint32(imageWa(stack), 0, true);
    e.set_eip(code); e.run(100000);
    assert.strictEqual(e.get_eip() >>> 0, 0);
    return {
      eax: e.get_eax() >>> 0, ecx: e.get_ecx() >>> 0, edx: e.get_edx() >>> 0,
      ebx: (e.get_ebx() - dst) >>> 0, esp: e.get_esp() >>> 0,
      ebp: e.get_ebp() >>> 0, esi: (e.get_esi() - roundA) >>> 0,
      edi: (e.get_edi() - roundB) >>> 0,
      cf: e.test_avg_cf(), zf: e.test_avg_zf(), sf: e.test_avg_sf(), of: e.test_avg_of(),
    };
  }
  e.set_loop_generic_copy_emit(0);
  const roundBaseline = runRound(roundBaselineCode, roundD0);
  const roundMatches = e.test_avg_matches();
  e.set_loop_generic_copy_emit(1);
  const roundFused = runRound(roundFusedCode, roundD1);
  assert.strictEqual(e.test_avg_matches(), roundMatches + 1, 'rounded cursor average recognizes');
  assert.deepStrictEqual(roundFused, roundBaseline, 'rounded fusion preserves final state');
  assert.deepStrictEqual(
    Array.from(bytes.subarray(wa(roundD1), wa(roundD1) + roundCount * 4)),
    Array.from(bytes.subarray(wa(roundD0), wa(roundD0) + roundCount * 4)),
    'shared-LSB correction mode is byte-identical');
  const last = (roundCount - 1) * 4;
  const lastA = new DataView(aBytes.buffer).getUint32(last, true) >>> 0;
  const lastB = new DataView(bBytes.buffer).getUint32(last, true) >>> 0;
  assert.strictEqual(roundFused.ebp, (lastA & lastB & ROUND_MASK) >>> 0,
    'ordinary suffix publishes the final correction scratch register');

  const near = Uint8Array.from(LOOP);
  near[13] ^= 1; // second mask differs
  const nearCode = install(near);
  const beforeNear = e.test_avg_matches();
  runAt(nearCode, { a: a0, b: b0, dst: d1, count: 3 });
  assert.strictEqual(e.test_avg_matches(), beforeNear, 'unequal-mask near miss stays ordinary');

  console.log('packed average H435 tests passed');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exitCode = 1;
});
