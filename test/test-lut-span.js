#!/usr/bin/env node
'use strict';

// Decoder-time regression for H431, the nonterminal fixed-span sibling of
// LUT_RUN. It covers the one-source Duff suffix and the scheduled two-source
// 64KB blend form used by d2gfx, including register/flag publication.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const EXTRA_WAT = `
  (func (export "test_span_g2w") (param $ga i32) (result i32)
    (call $g2w (local.get $ga)))
  (func (export "test_span_matches") (result i32)
    (global.get $lut_span_matches))
  (func (export "test_span_runs") (result i32)
    (global.get $lut_span_runs))
  (func (export "test_span_bytes") (result i64)
    (global.get $lut_span_bytes))
  (func (export "test_span_cf") (result i32) (call $get_cf))
  (func (export "test_span_zf") (result i32) (call $get_zf))
`;

function put32(out, value) {
  out.push(value & 0xff, (value >>> 8) & 0xff,
    (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function oneSourceSpan(start, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = start - i;
    out.push(
      0x33, 0xdb,       // xor ebx,ebx
      0x8a, 0x5a, d,    // mov bl,[edx+d]
      0x8a, 0x1c, 0x33, // mov bl,[ebx+esi]
      0x88, 0x58, d     // mov [eax+d],bl
    );
  }
  out.push(0xc3);
  return Uint8Array.from(out);
}

function blend4(table) {
  const out = [];
  const lut = () => {
    out.push(0x8a, 0x8c, 0x19); // mov cl,[ecx+ebx+disp32]
    put32(out, table);
  };
  // This is the compiler-scheduled four-pixel group at d2gfx 0x100013fd.
  // Source-2 loads and XORs deliberately move across neighbouring stores.
  out.push(0x33, 0xc9, 0x33, 0xdb);       // xor ecx,ecx / xor ebx,ebx
  out.push(0x8a, 0x4e, 0x1b, 0x8a, 0x58, 0x1b, 0xc1, 0xe1, 0x08); lut();
  out.push(0x33, 0xdb, 0x88, 0x4c, 0x3a, 0x1b);
  out.push(0x8a, 0x58, 0x1a, 0x33, 0xc9, 0x8a, 0x4e, 0x1a, 0xc1, 0xe1, 0x08); lut();
  out.push(0x33, 0xdb, 0x88, 0x4c, 0x3a, 0x1a);
  out.push(0x8a, 0x58, 0x19, 0x33, 0xc9, 0x8a, 0x4e, 0x19, 0xc1, 0xe1, 0x08); lut();
  out.push(0x88, 0x4c, 0x3a, 0x19);
  out.push(0x33, 0xc9, 0x8a, 0x4e, 0x18, 0xc1, 0xe1, 0x08);
  out.push(0x33, 0xdb, 0x8a, 0x58, 0x18); lut();
  out.push(0x88, 0x4c, 0x3a, 0x18, 0xc3);
  return Uint8Array.from(out);
}

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat: EXTRA_WAT, fonts: 'none' });
  const fixture = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE loads');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const imageWa = ga => (ga - imageBase + guestBase) >>> 0;
  const wa = ga => e.test_span_g2w(ga) >>> 0;
  const stack = (imageBase + 0xd00000) >>> 0;
  const codeBase = (imageBase + 0x1800) >>> 0;
  const dv = new DataView(memory.buffer);
  let codeSlot = 0;

  function install(code) {
    const ga = (codeBase + codeSlot * 0x200) >>> 0;
    codeSlot++;
    bytes.set(code, imageWa(ga));
    return ga;
  }
  function run(code, setup) {
    const ga = install(code);
    e.set_esp(stack);
    dv.setUint32(imageWa(stack), 0, true);
    setup();
    e.set_eip(ga);
    e.run(100000);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'probe returns to sentinel');
  }
  const put = (ga, data) => bytes.set(data, wa(ga));
  const get = (ga, n) => Array.from(bytes.subarray(wa(ga), wa(ga) + n));

  const arena = e.guest_alloc(0x18000) >>> 0;
  const pageEnd = ga => (((ga + 0x1000) & ~0xfff) - 1) >>> 0;
  // Both descending streams cross a page seam: the fast translated path must
  // decline while the semantic result remains identical.
  const src = (pageEnd(arena + 0x100) - 3) >>> 0;
  const dst = (pageEnd(arena + 0x4100) - 3) >>> 0;
  const table = (arena + 0x8000) >>> 0;
  const input = [11, 29, 47, 65, 83, 101, 119, 137];
  const lut = Array.from({ length: 256 }, (_, i) => (i * 13 + 7) & 0xff);
  put(src, input);
  put(dst, new Uint8Array(input.length).fill(0xcc));
  put(table, lut);

  const matches0 = e.test_span_matches();
  const runs0 = e.test_span_runs();
  const bytes0 = e.test_span_bytes();
  const srcReg = src;
  const dstReg = dst;
  run(oneSourceSpan(7, 8), () => {
    e.set_eax(dstReg); e.set_edx(srcReg); e.set_esi(table); e.set_ebx(0xdeadbeef);
  });
  assert.deepStrictEqual(get(dst, input.length), input.map(v => lut[v]),
    'one-source descending LUT output');
  assert.strictEqual(e.get_eax() >>> 0, dstReg, 'destination base unchanged');
  assert.strictEqual(e.get_edx() >>> 0, srcReg, 'source base unchanged');
  assert.strictEqual(e.get_esi() >>> 0, table, 'table base unchanged');
  assert.strictEqual(e.get_ebx() >>> 0, lut[input[0]], 'final zero/load/LUT accumulator');
  assert.strictEqual(e.test_span_cf(), 0, 'last XOR clears carry');
  assert.strictEqual(e.test_span_zf(), 1, 'last XOR sets zero');
  assert.strictEqual(e.test_span_matches(), matches0 + 1, 'one-source span recognized');
  assert.strictEqual(e.test_span_runs(), runs0 + 1, 'H431 executed once');
  assert.strictEqual(Number(e.test_span_bytes() - bytes0), 8, 'one-source pixels charged');

  // The LUT-only gate must suppress decoder-time spans as well as H418.
  const baselineDst = (dst + 0x100) >>> 0;
  put(baselineDst, new Uint8Array(input.length).fill(0x55));
  e.set_loop_lut_emit(0);
  const disabledMatches = e.test_span_matches();
  const disabledRuns = e.test_span_runs();
  run(oneSourceSpan(7, 8), () => {
    e.set_eax(baselineDst); e.set_edx(srcReg); e.set_esi(table); e.set_ebx(0);
  });
  assert.deepStrictEqual(get(baselineDst, input.length), get(dst, input.length),
    'ordinary and lowered one-source forms agree');
  assert.strictEqual(e.test_span_matches(), disabledMatches, 'LUT gate suppresses recognition');
  assert.strictEqual(e.test_span_runs(), disabledRuns, 'LUT gate suppresses H431');
  e.set_loop_lut_emit(1);

  const blendTable = (arena + 0x9000) >>> 0;
  for (let i = 0; i < 0x10000; i++) bytes[wa(blendTable + i)] = ((i >>> 8) * 3 + i * 5) & 0xff;
  const src1 = (arena + 0x12000) >>> 0;
  const src2 = (arena + 0x12100) >>> 0;
  const blendDst = (arena + 0x12200) >>> 0;
  const dstIndex = 9;
  const a = Array.from({ length: 32 }, (_, i) => (i * 17 + 3) & 0xff);
  const b = Array.from({ length: 32 }, (_, i) => (i * 29 + 5) & 0xff);
  put(src1, a); put(src2, b); put(blendDst, new Uint8Array(48).fill(0xa5));
  const blendMatches = e.test_span_matches();
  const blendRuns = e.test_span_runs();
  run(blend4(blendTable), () => {
    e.set_esi(src1); e.set_eax(src2);
    e.set_edx((blendDst - dstIndex) >>> 0); e.set_edi(dstIndex);
    e.set_ecx(0xcccccccc); e.set_ebx(0xbbbbbbbb);
  });
  for (let d = 0x18; d <= 0x1b; d++) {
    const expected = bytes[wa(blendTable + (a[d] << 8) + b[d])];
    assert.strictEqual(bytes[wa(blendDst + d)], expected, `blend output displacement ${d}`);
  }
  assert.strictEqual(e.get_esi() >>> 0, src1, 'blend source1 base unchanged');
  assert.strictEqual(e.get_eax() >>> 0, src2, 'blend source2 base unchanged');
  assert.strictEqual(e.get_edx() >>> 0, (blendDst - dstIndex) >>> 0, 'blend destination base unchanged');
  assert.strictEqual(e.get_edi() >>> 0, dstIndex, 'blend destination index unchanged');
  const lastOut = bytes[wa(blendDst + 0x18)];
  assert.strictEqual(e.get_ecx() >>> 0, ((a[0x18] << 8) | lastOut) >>> 0,
    'blend accumulator retains shifted source byte and result byte');
  assert.strictEqual(e.get_ebx() >>> 0, b[0x18], 'blend auxiliary final byte');
  assert.strictEqual(e.test_span_cf(), 0, 'scheduled blend final XOR clears carry');
  assert.strictEqual(e.test_span_zf(), 1, 'scheduled blend final XOR sets zero');
  assert.strictEqual(e.test_span_matches(), blendMatches + 1, 'scheduled blend recognized');
  assert.strictEqual(e.test_span_runs(), blendRuns + 1, 'scheduled blend executes H431');

  // A displacement gap is not a descending span. It must execute ordinarily.
  const miss = oneSourceSpan(7, 4);
  miss[21] = 4; // second store says +4 while its source says +6
  const missMatches = e.test_span_matches();
  run(miss, () => {
    e.set_eax(baselineDst + 0x100); e.set_edx(srcReg); e.set_esi(table); e.set_ebx(0);
  });
  assert.strictEqual(e.test_span_matches(), missMatches, 'displacement-gap near miss rejected');

  console.log('PASS LUT span: one-source Duff suffix + scheduled two-source blend, flags, bases, gate, page seam, near miss');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
