#!/usr/bin/env node
'use strict';

// Semantic regression for the cursor/bound COPY_RUN shape used by Abe's hot
// row copier. H419 moves a private, rounded byte span; the final dword scratch
// load and CMP/JB remain ordinary handlers after it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const EXTRA_WAT = `
  (func (export "test_copy32_matches") (result i32)
    (global.get $loop_copy32_matches))
  (func (export "test_copy32_runs") (result i32)
    (global.get $loop_copy32_runs))
  (func (export "test_copy32_bytes") (result i64)
    (global.get $loop_copy32_bytes))
  (func (export "test_copy32_cf") (result i32) (call $get_cf))
  (func (export "test_copy32_zf") (result i32) (call $get_zf))
  (func (export "test_copy32_sf") (result i32) (call $get_sf))
  (func (export "test_copy32_of") (result i32) (call $get_of))
`;

const LOOP = Uint8Array.from([
  0x8b, 0x2f,             // mov ebp,[edi]
  0x83, 0xc7, 0x04,       // add edi,4
  0x89, 0x28,             // mov [eax],ebp
  0x83, 0xc0, 0x04,       // add eax,4
  0x3b, 0xc1,             // cmp eax,ecx
  0x72, 0xf2,             // jb loop
  0xc3,
]);

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat: EXTRA_WAT, fonts: 'none' });
  const fixture = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  let bytes = new Uint8Array(memory.buffer);
  let dv = new DataView(memory.buffer);
  bytes.set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE loads');

  // load_pe/guest_alloc can grow memory, so refresh host views afterwards.
  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const imageWa = ga => (ga - imageBase + guestBase) >>> 0;
  const wa = ga => e.test_g2w ? e.test_g2w(ga) >>> 0 : imageWa(ga);
  const codeBase = (imageBase + 0x2400) >>> 0;
  const stack = (imageBase + 0xd00000) >>> 0;
  let codeSlot = 0;

  function install(code = LOOP) {
    const ga = (codeBase + codeSlot++ * 0x100) >>> 0;
    bytes.set(code, imageWa(ga));
    return ga;
  }

  function state() {
    return {
      eax: e.get_eax() >>> 0, ecx: e.get_ecx() >>> 0,
      edx: e.get_edx() >>> 0, ebx: e.get_ebx() >>> 0,
      esp: e.get_esp() >>> 0, ebp: e.get_ebp() >>> 0,
      esi: e.get_esi() >>> 0, edi: e.get_edi() >>> 0,
      cf: e.test_copy32_cf(), zf: e.test_copy32_zf(),
      sf: e.test_copy32_sf(), of: e.test_copy32_of(),
    };
  }

  function runAt(code, { src, dst, bound }) {
    e.set_eax(dst); e.set_ecx(bound); e.set_edx(0x22334455); e.set_ebx(0x66778899);
    e.set_esp(stack); e.set_ebp(0xa5a5a5a5); e.set_esi(0x13579bdf); e.set_edi(src);
    dv.setUint32(imageWa(stack), 0, true);
    e.set_eip(code);
    e.run(100000);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'probe returns to sentinel');
    return state();
  }

  const arena = e.guest_alloc(0xc000) >>> 0;
  bytes = new Uint8Array(memory.buffer);
  dv = new DataView(memory.buffer);
  const baselineCode = install();
  const fusedCode = install();

  // Use a non-multiple bound and cross page boundaries. The original do-while
  // executes 257 dwords for a 1025-byte cursor distance, so H419 must round to
  // 1028 bytes and may return through its ordinary suffix more than once when
  // the execution budget expires.
  const page = (arena + 0x2000) & ~0xfff;
  const baselineSrc = (page - 2) >>> 0;
  const fusedSrc = (page + 0x2ffe) >>> 0;
  const baselineDst = (page + 0x1002) >>> 0;
  const fusedDst = (page + 0x7002) >>> 0;
  const distance = 1025;
  const copiedBytes = 1028;
  const input = Uint8Array.from({ length: copiedBytes }, (_, i) => (i * 73 + 19) & 0xff);
  bytes.set(input, wa(baselineSrc));
  bytes.set(input, wa(fusedSrc));
  bytes.fill(0xcc, wa(baselineDst), wa(baselineDst) + copiedBytes + 8);
  bytes.fill(0xcc, wa(fusedDst), wa(fusedDst) + copiedBytes + 8);

  e.set_loop_copy_emit(0);
  const baseline = runAt(baselineCode, {
    src: baselineSrc, dst: baselineDst, bound: (baselineDst + distance) >>> 0,
  });
  const matchesAfterBaseline = e.test_copy32_matches();
  assert.strictEqual(matchesAfterBaseline, 1,
    'disabled lowering still recognizes the exact loop for diagnostics');

  e.set_loop_copy_emit(1);
  const fused = runAt(fusedCode, {
    src: fusedSrc, dst: fusedDst, bound: (fusedDst + distance) >>> 0,
  });
  assert.strictEqual(e.test_copy32_matches(), matchesAfterBaseline + 1,
    'enabled fresh block lowers once');
  assert(e.test_copy32_runs() >= 1, 'lowered COPY_RUN executes');
  assert.strictEqual(e.test_copy32_bytes(), BigInt(copiedBytes),
    'private byte count includes rounded cursor/bound distance');
  assert.deepStrictEqual(
    Array.from(bytes.subarray(wa(fusedDst), wa(fusedDst) + copiedBytes + 8)),
    Array.from(bytes.subarray(wa(baselineDst), wa(baselineDst) + copiedBytes + 8)),
    'page-crossing rounded copy is byte-identical');

  // Normalize the intentionally different pointer bases before comparing the
  // complete architectural state left by the retained final load/CMP/JB.
  assert.deepStrictEqual({
    ...fused,
    eax: (fused.eax - fusedDst) >>> 0,
    ecx: (fused.ecx - fusedDst) >>> 0,
    edi: (fused.edi - fusedSrc) >>> 0,
  }, {
    ...baseline,
    eax: (baseline.eax - baselineDst) >>> 0,
    ecx: (baseline.ecx - baselineDst) >>> 0,
    edi: (baseline.edi - baselineSrc) >>> 0,
  }, 'fusion preserves GPR and comparison-flag state');
  assert.strictEqual(fused.ebp, new DataView(input.buffer).getUint32(copiedBytes - 4, true),
    'ordinary suffix reloads the final full-width scratch value');
  assert.strictEqual(fused.cf, 0, 'final unsigned comparison exits');

  // Sub-dword overlap is the one place byte-forward and dword-forward order
  // differ. The runtime fallback must execute the original load/store width.
  const overlapBaselineCode = install();
  const overlapFusedCode = install();
  const overlapBaseline = (arena + 0x9000) >>> 0;
  const overlapFused = (arena + 0xa000) >>> 0;
  const overlapInput = Uint8Array.from({ length: 48 }, (_, i) => (i * 11 + 7) & 0xff);
  bytes.set(overlapInput, wa(overlapBaseline));
  bytes.set(overlapInput, wa(overlapFused));
  e.set_loop_copy_emit(0);
  const overlapBaselineState = runAt(overlapBaselineCode, {
    src: overlapBaseline, dst: overlapBaseline + 1, bound: overlapBaseline + 21,
  });
  e.set_loop_copy_emit(1);
  const bytesBeforeOverlap = e.test_copy32_bytes();
  const overlapFusedState = runAt(overlapFusedCode, {
    src: overlapFused, dst: overlapFused + 1, bound: overlapFused + 21,
  });
  assert.strictEqual(e.test_copy32_bytes() - bytesBeforeOverlap, 20n,
    'overlap fallback still charges its private byte span');
  assert.deepStrictEqual(
    Array.from(bytes.subarray(wa(overlapFused), wa(overlapFused) + 48)),
    Array.from(bytes.subarray(wa(overlapBaseline), wa(overlapBaseline) + 48)),
    'sub-dword overlap preserves dword load-before-store ordering');
  assert.strictEqual(overlapFusedState.ebp, overlapBaselineState.ebp,
    'overlap preserves the final scratch dword');

  // A different source bump is valid x86, but is not this proved shape.
  const near = Uint8Array.from(LOOP);
  near[4] = 8;
  const nearCode = install(near);
  const matchesBeforeNear = e.test_copy32_matches();
  runAt(nearCode, { src: fusedSrc, dst: fusedDst, bound: fusedDst + 8 });
  assert.strictEqual(e.test_copy32_matches(), matchesBeforeNear,
    'near miss remains ordinary x86');

  if (process.argv.includes('--bench')) {
    const iterations = Number(process.env.COPY32_BENCH_ITERS || 5000);
    function time(code, src, dst) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) {
        runAt(code, { src, dst, bound: dst + 1024 });
      }
      return Number(process.hrtime.bigint() - t0) / 1e6;
    }
    const ordinaryMs = time(baselineCode, baselineSrc, baselineDst);
    const fusedMs = time(fusedCode, fusedSrc, fusedDst);
    console.log(`bench ${iterations}x1024B ordinary=${ordinaryMs.toFixed(1)}ms fused=${fusedMs.toFixed(1)}ms speedup=${(ordinaryMs / fusedMs).toFixed(2)}x`);
  }

  console.log('copy32 bounded COPY_RUN tests passed');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exitCode = 1;
});
