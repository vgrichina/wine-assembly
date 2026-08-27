#!/usr/bin/env node
'use strict';

// Semantic regression for Jazz Jackrabbit 2's masked 32-byte MMX row copy.
// The fused H419 form must agree with the ordinary decoder under both store
// strategies, including the observable mm0..mm3 values left without EMMS.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const EXTRA_WAT = `
  (func (export "test_mmx_mask_set_enabled") (param $v i32)
    (global.set $mmx_mask_copy_enabled (local.get $v)))
  (func (export "test_mmx_mask_set_bulk") (param $v i32)
    (global.set $mmx_mask_copy_use_bulk (local.get $v)))
  (func (export "test_mmx_mask_matches") (result i32)
    (global.get $mmx_mask_copy_matches))
  (func (export "test_mmx_mask_runs") (result i32)
    (global.get $mmx_mask_copy_runs))
  (func (export "test_mmx_mask_rows") (result i64)
    (global.get $mmx_mask_copy_rows))
  (func (export "test_mmx_mask_bytes") (result i64)
    (global.get $mmx_mask_copy_bytes))
  (func (export "test_mmx_set") (param $i i32) (param $v i64)
    (call $mmx_set (local.get $i) (local.get $v)))
  (func (export "test_mmx_get") (param $i i32) (result i64)
    (call $mmx_get (local.get $i)))
  (func (export "test_mmx_mask_cf") (result i32) (call $get_cf))
  (func (export "test_mmx_mask_zf") (result i32) (call $get_zf))
`;

const LOOP = Uint8Array.from([
  0x03, 0xdb,                         // add ebx,ebx
  0x73, 0x1e,                         // jae tail
  0x0f, 0x6f, 0x06,                   // movq mm0,[esi]
  0x0f, 0x6f, 0x4e, 0x08,             // movq mm1,[esi+8]
  0x0f, 0x6f, 0x56, 0x10,             // movq mm2,[esi+16]
  0x0f, 0x6f, 0x5e, 0x18,             // movq mm3,[esi+24]
  0x0f, 0x7f, 0x07,                   // movq [edi],mm0
  0x0f, 0x7f, 0x4f, 0x08,             // movq [edi+8],mm1
  0x0f, 0x7f, 0x57, 0x10,             // movq [edi+16],mm2
  0x0f, 0x7f, 0x5f, 0x18,             // movq [edi+24],mm3
  0x03, 0xf8,                         // add edi,eax
  0x83, 0xc6, 0x20,                   // add esi,32
  0x4a,                               // dec edx
  0x75, 0xd6,                         // jnz loop
  0xc3,
]);

// Authentic Jazz entry at 0x46888f: setup and loop head share one straight-
// line x86 block. The production bug was invisible while the regression only
// entered at LOOP[0], because the recognizer used to run only at start_eip.
const PREFIXED_LOOP = Uint8Array.from([
  0x8b, 0x5d, 0x10,                  // mov ebx,[ebp+0x10]
  ...LOOP,
]);

function i64le(a, off) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(a[off + i]);
  return BigInt.asIntN(64, v);
}

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat: EXTRA_WAT, fonts: 'none' });
  const fixture = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  bytes.set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE loads');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const imageWa = ga => (ga - imageBase + guestBase) >>> 0;
  const wa = ga => e.test_g2w ? e.test_g2w(ga) >>> 0 : imageWa(ga);
  const codeBase = (imageBase + 0x2200) >>> 0;
  const stack = (imageBase + 0xd00000) >>> 0;
  let codeSlot = 0;

  function install(code = LOOP) {
    const ga = (codeBase + codeSlot++ * 0x100) >>> 0;
    bytes.set(code, imageWa(ga));
    return ga;
  }

  function runAt(code, { src, dst, pitch, count, mask, bulk = 1, ebp }) {
    e.test_mmx_mask_set_bulk(bulk);
    e.set_eax(pitch); e.set_ebx(mask); e.set_esi(src); e.set_edi(dst); e.set_edx(count);
    e.set_esp(stack);
    if (ebp !== undefined) e.set_ebp(ebp);
    dv.setUint32(imageWa(stack), 0, true);
    e.set_eip(code);
    e.run(100000);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'probe returns to sentinel');
    return {
      eax: e.get_eax() >>> 0, ebx: e.get_ebx() >>> 0,
      esi: e.get_esi() >>> 0, edi: e.get_edi() >>> 0, edx: e.get_edx() >>> 0,
      cf: e.test_mmx_mask_cf(), zf: e.test_mmx_mask_zf(),
      mm: [0, 1, 2, 3].map(i => e.test_mmx_get(i)),
    };
  }

  function seedMmx() {
    for (let i = 0; i < 4; i++) e.test_mmx_set(i, BigInt.asIntN(64, 0x1122334455667700n + BigInt(i)));
  }

  const bulkCode = install();
  const vectorCode = install();
  const baselineCode = install();
  e.test_mmx_mask_set_enabled(0);

  const arena = e.guest_alloc(0x9000) >>> 0;
  const src = (arena + 0x100) >>> 0;
  const pitch = 48;
  const count = 5;
  const mask = 0xa8000000;
  const source = Uint8Array.from({ length: count * 32 }, (_, i) => (i * 37 + 13) & 0xff);
  bytes.set(source, wa(src));

  function exercise(code, dst, bulk) {
    bytes.fill(0xcc, wa(dst), wa(dst) + count * pitch);
    seedMmx();
    return runAt(code, { src, dst, pitch, count, mask, bulk });
  }

  // Decode the ordinary arm while the exact recognizer is off.
  const baselineDst = (arena + 0x1200) >>> 0;
  const baseline = exercise(baselineCode, baselineDst, 1);
  assert.strictEqual(e.test_mmx_mask_matches(), 0, 'disabled recognizer emits ordinary handlers');

  e.test_mmx_mask_set_enabled(1);
  const vectorDst = (arena + 0x2200) >>> 0;
  const vector = exercise(vectorCode, vectorDst, 0);
  const bulkDst = (arena + 0x3200) >>> 0;
  const bulk = exercise(bulkCode, bulkDst, 1);
  assert.strictEqual(e.test_mmx_mask_matches(), 2, 'both enabled copies lower once');
  assert.strictEqual(e.test_mmx_mask_runs(), 2, 'both lowered copies execute once');
  assert.strictEqual(e.test_mmx_mask_rows(), 10n, 'all selected and skipped rows charged');
  assert.strictEqual(e.test_mmx_mask_bytes(), 6n * 32n, 'three selected rows per fused arm');

  for (let row = 0; row < count; row++) {
    const selected = row === 0 || row === 2 || row === 4;
    const expected = selected
      ? Array.from(source.subarray(row * 32, row * 32 + 32))
      : new Array(32).fill(0xcc);
    for (const dst of [baselineDst, vectorDst, bulkDst]) {
      assert.deepStrictEqual(Array.from(bytes.subarray(wa(dst + row * pitch), wa(dst + row * pitch) + 32)), expected,
        `row ${row} ${selected ? 'copied' : 'skipped'}`);
    }
  }
  const comparable = ({ edi, ...state }) => state;
  assert.deepStrictEqual(comparable(vector), comparable(baseline),
    'v128-store fusion preserves all GPR/MMX/flag state');
  assert.deepStrictEqual(comparable(bulk), comparable(baseline),
    'memory.copy fusion preserves all GPR/MMX/flag state');
  assert.deepStrictEqual(bulk.mm, [0, 8, 16, 24].map(off => i64le(source, 4 * 32 + off)),
    'mm0..mm3 retain the final selected source row');
  assert.strictEqual(bulk.ebx, (mask << count) >>> 0, 'mask register shifted once per row');
  assert.strictEqual(bulk.esi, (src + count * 32) >>> 0, 'source advances 32 bytes per row');
  assert.strictEqual(bulk.edi, (bulkDst + count * pitch) >>> 0, 'destination advances by pitch');
  assert.strictEqual(bulk.edx, 0, 'counter reaches zero');
  assert.strictEqual(bulk.zf, 1, 'final DEC sets zero');

  // Decode the production-shaped entry twice at fresh addresses: once as
  // ordinary x86, then with H419 enabled. Both execute the predecessor MOV;
  // only the second must recognize the loop when d_pc reaches its head inside
  // the already-started translated block.
  const prefixedBaselineCode = install(PREFIXED_LOOP);
  const prefixedFusedCode = install(PREFIXED_LOOP);
  const prefixedEbp = (stack + 0x100) >>> 0;
  dv.setUint32(imageWa(prefixedEbp + 0x10), mask, true);
  const prefixedBaselineDst = (arena + 0x4000) >>> 0;
  const prefixedFusedDst = (arena + 0x4200) >>> 0;
  bytes.fill(0xcc, wa(prefixedBaselineDst), wa(prefixedBaselineDst) + count * pitch);
  bytes.fill(0xcc, wa(prefixedFusedDst), wa(prefixedFusedDst) + count * pitch);
  e.test_mmx_mask_set_enabled(0);
  seedMmx();
  const prefixedBaseline = runAt(prefixedBaselineCode, {
    src, dst: prefixedBaselineDst, pitch, count, mask, bulk: 0, ebp: prefixedEbp,
  });
  e.test_mmx_mask_set_enabled(1);
  const matchesBeforePrefixed = e.test_mmx_mask_matches();
  const runsBeforePrefixed = e.test_mmx_mask_runs();
  seedMmx();
  const prefixedFused = runAt(prefixedFusedCode, {
    src, dst: prefixedFusedDst, pitch, count, mask, bulk: 0, ebp: prefixedEbp,
  });
  assert.strictEqual(e.test_mmx_mask_matches(), matchesBeforePrefixed + 1,
    'authentic predecessor entry recognizes H419 at an interior instruction boundary');
  assert.strictEqual(e.test_mmx_mask_runs(), runsBeforePrefixed + 1,
    'interior-boundary H419 executes once');
  assert.deepStrictEqual(comparable(prefixedFused), comparable(prefixedBaseline),
    'interior-boundary fusion preserves the production-shaped entry state');
  for (let row = 0; row < count; row++) {
    assert.deepStrictEqual(
      Array.from(bytes.subarray(wa(prefixedFusedDst + row * pitch),
        wa(prefixedFusedDst + row * pitch) + 32)),
      Array.from(bytes.subarray(wa(prefixedBaselineDst + row * pitch),
        wa(prefixedBaselineDst + row * pitch) + 32)),
      `interior-boundary row ${row} agrees with ordinary decoding`);
  }

  // All four MOVQ loads precede all four stores, so an overlapping row has
  // memmove semantics and still publishes the original source in MMX state.
  const overlapCode = install();
  const overlap = (arena + 0x5000) >>> 0;
  const overlapInput = Uint8Array.from({ length: 48 }, (_, i) => (i * 11 + 7) & 0xff);
  bytes.set(overlapInput, wa(overlap));
  seedMmx();
  runAt(overlapCode, { src: overlap, dst: overlap + 8, pitch: 0, count: 1, mask: 0x80000000, bulk: 1 });
  assert.deepStrictEqual(Array.from(bytes.subarray(wa(overlap + 8), wa(overlap + 40))), Array.from(overlapInput.subarray(0, 32)),
    'overlapping bulk row behaves like the original preload-then-store sequence');
  assert.deepStrictEqual([0, 1, 2, 3].map(i => e.test_mmx_get(i)), [0, 8, 16, 24].map(off => i64le(overlapInput, off)),
    'overlap retains pre-store source values in MMX registers');

  // Crossing a guest page selects the four-helper fallback; it must remain
  // byte-identical to the fast path.
  const splitCode = install();
  const splitSrc = (((arena + 0x6100 + 0xfff) & ~0xfff) - 16) >>> 0;
  const splitDst = (((arena + 0x7100 + 0xfff) & ~0xfff) - 8) >>> 0;
  const splitInput = Uint8Array.from({ length: 32 }, (_, i) => (255 - i * 9) & 0xff);
  bytes.set(splitInput, wa(splitSrc));
  bytes.fill(0, wa(splitDst), wa(splitDst) + 32);
  runAt(splitCode, { src: splitSrc, dst: splitDst, pitch: 0, count: 1, mask: 0x80000000, bulk: 1 });
  assert.deepStrictEqual(Array.from(bytes.subarray(wa(splitDst), wa(splitDst) + 32)), Array.from(splitInput),
    'page-crossing fallback copies all 32 bytes');

  // One displacement changed is valid x86 but not the proved idiom.
  const near = Uint8Array.from(LOOP);
  near[10] = 9; // movq mm1,[esi+9]
  const nearCode = install(near);
  const matchesBeforeNear = e.test_mmx_mask_matches();
  runAt(nearCode, { src, dst: arena + 0x8000, pitch: 32, count: 1, mask: 0x80000000, bulk: 1 });
  assert.strictEqual(e.test_mmx_mask_matches(), matchesBeforeNear, 'near miss stays on ordinary handlers');

  if (process.argv.includes('--bench')) {
    const benchArena = e.guest_alloc(0x5000) >>> 0;
    const benchSrc = (benchArena + 0x100) >>> 0;
    const benchDst = (benchArena + 0x1100) >>> 0;
    const benchRows = 32;
    const iterations = Number(process.env.MMX_COPY_BENCH_ITERS || 5000);
    const reps = Number(process.env.MMX_COPY_BENCH_REPS || 9);
    bytes.set(Uint8Array.from({ length: benchRows * 32 }, (_, i) => (i * 73 + 19) & 0xff), wa(benchSrc));

    const arms = {
      bulk: { code: bulkCode, bulk: 1 },
      vector: { code: vectorCode, bulk: 0 },
      baseline: { code: baselineCode, bulk: 1 },
    };
    function timeArm({ code, bulk }, loops = iterations) {
      e.test_mmx_mask_set_bulk(bulk);
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < loops; i++) {
        e.set_eax(32); e.set_ebx(0xffffffff); e.set_esi(benchSrc);
        e.set_edi(benchDst); e.set_edx(benchRows); e.set_esp(stack);
        dv.setUint32(imageWa(stack), 0, true);
        e.set_eip(code); e.run(100000);
      }
      return Number(process.hrtime.bigint() - t0) / 1e6;
    }
    for (const arm of Object.values(arms)) timeArm(arm, 100);
    const samples = { bulk: [], vector: [], baseline: [] };
    const names = Object.keys(arms);
    for (let rep = 0; rep < reps; rep++) {
      const order = names.slice(rep % names.length).concat(names.slice(0, rep % names.length));
      for (const name of order) samples[name].push(timeArm(arms[name]));
    }
    const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
    const med = Object.fromEntries(names.map(name => [name, median(samples[name])]));
    const mib = iterations * benchRows * 32 / 1048576;
    const rate = ms => mib / (ms / 1000);
    console.log(`BENCH masked MMX copy: ${iterations} calls x ${benchRows} rows, ${reps} alternating reps`);
    for (const name of names) {
      console.log(`  ${name.padEnd(8)} median ${med[name].toFixed(2).padStart(8)} ms  ${rate(med[name]).toFixed(1).padStart(8)} MiB/s`);
    }
    const winner = med.bulk < med.vector ? 'memory.copy' : 'v128 stores';
    const winnerGain = (Math.max(med.bulk, med.vector) / Math.min(med.bulk, med.vector) - 1) * 100;
    console.log(`  store winner: ${winner} by ${winnerGain.toFixed(1)}%`);
    console.log(`  memory.copy fusion vs ordinary MMX: ${(med.baseline / med.bulk).toFixed(2)}x`);
  }

  console.log('PASS Jazz masked MMX row COPY_RUN: exact/interior entry, baseline/vector/bulk state, overlap, page split, gate, near miss');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
