#!/usr/bin/env node
'use strict';

// Semantic regression for the universal H418 LUT_RUN descriptor. The two
// recognizers remain intentionally narrow, but Heroes' counted loop and both
// Diablo II bounded forms must execute through the same handler.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const EXTRA_WAT = `
  (func (export "test_lut_g2w") (param $ga i32) (result i32)
    (call $g2w (local.get $ga)))
  (func (export "test_lut_cf") (result i32) (call $get_cf))
  (func (export "test_lut_zf") (result i32) (call $get_zf))
`;

function alignPageEnd(p, room) {
  return ((p + 0x1000) & ~0xfff) - room;
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
  const wa = ga => e.test_lut_g2w(ga) >>> 0;
  const stack = (imageBase + 0xd00000) >>> 0;
  const dv = new DataView(memory.buffer);
  const codeBase = (imageBase + 0x1800) >>> 0;
  let codeSlot = 0;

  function install(code) {
    const ga = (codeBase + codeSlot * 0x100) >>> 0;
    codeSlot++;
    bytes.set(code, imageWa(ga));
    return ga;
  }

  function runAt(code, setup) {
    const ga = install(code);
    e.set_esp(stack);
    dv.setUint32(imageWa(stack), 0, true);
    setup();
    e.set_eip(ga);
    e.run(100000);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'probe returns to sentinel');
  }

  function put(ga, data) { bytes.set(data, wa(ga)); }
  function get(ga, n) { return Array.from(bytes.subarray(wa(ga), wa(ga) + n)); }

  // Exact hot d2gfx shape. Source and destination deliberately cross page
  // boundaries so the handler has to split and retranslate both streams.
  const d2gfx = Uint8Array.from([
    0x31, 0xd2,             // xor edx,edx
    0x41,                   // inc ecx
    0x8a, 0x10,             // mov dl,[eax]
    0x40,                   // inc eax
    0x39, 0xf0,             // cmp eax,esi
    0x8a, 0x14, 0x3a,       // mov dl,[edx+edi]
    0x88, 0x51, 0xff,       // mov [ecx-1],dl
    0x72, 0xf0,             // jb loop
    0xc3,
  ]);
  const arena = e.guest_alloc(0x7000) >>> 0;
  const src = alignPageEnd(arena + 0x100, 5) >>> 0;
  const dst = alignPageEnd(arena + 0x3100, 7) >>> 0;
  const table = (arena + 0x5000) >>> 0;
  // 301 bytes also exceed one 1000-step handler quantum (8 ops/iteration),
  // proving that budget exhaustion republishes the loop entry and resumes.
  const input = Array.from({ length: 301 }, (_, i) => (i * 37 + 11) & 0xff);
  const lut = Array.from({ length: 256 }, (_, i) => (255 - i * 3) & 0xff);
  put(table, lut);
  put(src, input);
  put(dst, new Uint8Array(input.length).fill(0xcc));
  const boundedBefore = e.get_loop_lut_bounded_matches();
  const runsBefore = e.get_loop_lut_runs();
  const bytesBefore = e.get_loop_lut_bytes();
  runAt(d2gfx, () => {
    e.set_eax(src); e.set_ecx(dst); e.set_edx(0xfeedface);
    e.set_esi(src + input.length); e.set_edi(table);
  });
  assert.deepStrictEqual(get(dst, input.length), input.map(v => lut[v]),
    'd2gfx table remap output');
  assert.strictEqual(e.get_eax() >>> 0, (src + input.length) >>> 0, 'source cursor');
  assert.strictEqual(e.get_ecx() >>> 0, (dst + input.length) >>> 0, 'destination cursor');
  assert.strictEqual(e.get_edx() & 0xff, lut[input[input.length - 1]], 'last accumulator byte');
  assert.strictEqual(e.test_lut_cf(), 0, 'final CMP at equality clears carry/JB');
  assert.strictEqual(e.test_lut_zf(), 1, 'final CMP at equality sets zero');
  assert.strictEqual(e.get_loop_lut_bounded_matches(), boundedBefore + 1, 'bounded recognizer matched');
  assert(e.get_loop_lut_runs() >= runsBefore + 3, 'universal handler resumes across step quanta');
  assert.strictEqual(Number(e.get_loop_lut_bytes() - bytesBefore), input.length, 'all bytes charged');

  // Disable only LUT_RUN and decode an otherwise identical block. Its ordinary
  // handlers must produce exactly the same result while H418 stays untouched.
  const baselineDst = (dst + 0x400) >>> 0;
  put(baselineDst, new Uint8Array(input.length).fill(0x99));
  e.set_loop_lut_emit(0);
  const baselineRuns = e.get_loop_lut_runs();
  runAt(d2gfx, () => {
    e.set_eax(src); e.set_ecx(baselineDst); e.set_edx(0xa5a5a500);
    e.set_esi(src + input.length); e.set_edi(table);
  });
  assert.deepStrictEqual(get(baselineDst, input.length), get(dst, input.length),
    'lowered and ordinary d2gfx loops agree');
  assert.strictEqual(e.get_loop_lut_runs(), baselineRuns, 'LUT-only gate suppresses H418');
  e.set_loop_lut_emit(1);

  // d2cmp row-table form: in-place cursor, (byte << 8) + row, 64KB table.
  const d2cmp = Uint8Array.from([
    0x31, 0xc9,             // xor ecx,ecx
    0x8a, 0x0a,             // mov cl,[edx]
    0xc1, 0xe1, 0x08,       // shl ecx,8
    0x01, 0xc1,             // add ecx,eax
    0x42,                   // inc edx
    0x39, 0xfa,             // cmp edx,edi
    0x8a, 0x0c, 0x19,       // mov cl,[ecx+ebx]
    0x88, 0x4a, 0xff,       // mov [edx-1],cl
    0x72, 0xec,             // jb loop
    0xc3,
  ]);
  const rowArena = e.guest_alloc(0x12000) >>> 0;
  const pixels = (rowArena + 0x100) >>> 0;
  const rowTable = (rowArena + 0x1000) >>> 0;
  const row = 7;
  const rowInput = [0, 1, 2, 17, 63, 127, 128, 201, 255];
  put(pixels, rowInput);
  for (let i = 0; i < 256; i++) bytes[wa(rowTable + (i << 8) + row)] = (i ^ 0x6d) & 0xff;
  const rowRuns = e.get_loop_lut_runs();
  runAt(d2cmp, () => {
    e.set_eax(row); e.set_ecx(0xdeadbeef); e.set_edx(pixels);
    e.set_ebx(rowTable); e.set_edi(pixels + rowInput.length);
  });
  assert.deepStrictEqual(get(pixels, rowInput.length), rowInput.map(v => (v ^ 0x6d) & 0xff),
    'd2cmp shifted row-table output');
  assert.strictEqual(e.get_edx() >>> 0, (pixels + rowInput.length) >>> 0, 'in-place cursor advanced once');
  assert.strictEqual(e.get_loop_lut_runs(), rowRuns + 1, 'row-table form uses H418');

  // Heroes-style count-to-zero form. It has a different recognizer and
  // terminator, but must emit the same descriptor and execute the same H418.
  const heroes = Uint8Array.from([
    0x31, 0xc0,             // xor eax,eax
    0x46,                   // inc esi
    0x8a, 0x46, 0xff,       // mov al,[esi-1]
    0x8a, 0x04, 0x08,       // mov al,[eax+ecx]
    0x88, 0x46, 0xff,       // mov [esi-1],al
    0x4a,                   // dec edx
    0x75, 0xf1,             // jnz loop
    0xc3,
  ]);
  const heroPixels = (rowArena + 0x40) >>> 0;
  const heroInput = [3, 5, 8, 13, 21, 34, 55];
  put(heroPixels, heroInput);
  const heroRuns = e.get_loop_lut_runs();
  runAt(heroes, () => {
    e.set_eax(0x77777777); e.set_ecx(table); e.set_edx(heroInput.length);
    e.set_esi(heroPixels);
  });
  assert.deepStrictEqual(get(heroPixels, heroInput.length), heroInput.map(v => lut[v]),
    'Heroes counted remap output');
  assert.strictEqual(e.get_esi() >>> 0, (heroPixels + heroInput.length) >>> 0, 'Heroes cursor');
  assert.strictEqual(e.get_edx() >>> 0, 0, 'Heroes counter');
  assert.strictEqual(e.get_loop_lut_runs(), heroRuns + 1, 'Heroes uses universal H418');

  // d2gfx two-moving-source blend form. The table is absolute in the guest
  // instruction, source2 is also the bounded cursor, and all three streams
  // cross pages so every translated pointer has to be split safely.
  const blendArena = e.guest_alloc(0x18000) >>> 0;
  const blendSrc1 = alignPageEnd(blendArena + 0x100, 5) >>> 0;
  const blendSrc2 = alignPageEnd(blendArena + 0x3100, 9) >>> 0;
  const blendDst = alignPageEnd(blendArena + 0x5100, 7) >>> 0;
  const blendTable = (blendArena + 0x7000) >>> 0;
  const blendInput1 = Array.from({ length: 301 }, (_, i) => (i * 19 + 7) & 0xff);
  const blendInput2 = Array.from({ length: 301 }, (_, i) => (i * 43 + 3) & 0xff);
  const blendLut = new Uint8Array(0x10000);
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) blendLut[(a << 8) | b] = (a * 5 + b * 3 + 17) & 0xff;
  }
  put(blendSrc1, blendInput1);
  put(blendSrc2, blendInput2);
  put(blendDst, new Uint8Array(blendInput1.length).fill(0x77));
  put(blendTable, blendLut);
  const blendCode = Uint8Array.from([
    0x31, 0xd2,                                             // xor edx,edx
    0x31, 0xdb,                                             // xor ebx,ebx
    0x8a, 0x11,                                             // mov dl,[ecx]
    0x8a, 0x18,                                             // mov bl,[eax]
    0xc1, 0xe2, 0x08,                                       // shl edx,8
    0x45,                                                   // inc ebp
    0x40,                                                   // inc eax
    0x8a, 0x94, 0x1a, ...le32(blendTable),                  // mov dl,[edx+ebx+table]
    0x41,                                                   // inc ecx
    0x88, 0x55, 0xff,                                       // mov [ebp-1],dl
    0x39, 0xf8,                                             // cmp eax,edi
    0x72, 0xe4,                                             // jb loop
    0xc3,
  ]);
  const blendMatches = e.get_loop_lut_bounded_matches();
  const blendRuns = e.get_loop_lut_runs();
  const blendBytes = e.get_loop_lut_bytes();
  runAt(blendCode, () => {
    e.set_eax(blendSrc2); e.set_ecx(blendSrc1); e.set_edx(0xdddddddd);
    e.set_ebx(0xbbbbbbbb); e.set_ebp(blendDst);
    e.set_edi(blendSrc2 + blendInput2.length);
  });
  const blendExpected = blendInput1.map((a, i) => blendLut[(a << 8) | blendInput2[i]]);
  assert.deepStrictEqual(get(blendDst, blendExpected.length), blendExpected,
    'two-source absolute blend-table output');
  assert.strictEqual(e.get_ecx() >>> 0, (blendSrc1 + blendInput1.length) >>> 0,
    'blend source1 cursor');
  assert.strictEqual(e.get_eax() >>> 0, (blendSrc2 + blendInput2.length) >>> 0,
    'blend source2/terminator cursor');
  assert.strictEqual(e.get_ebp() >>> 0, (blendDst + blendExpected.length) >>> 0,
    'blend destination cursor');
  assert.strictEqual(e.get_edx() >>> 0,
    ((blendInput1.at(-1) << 8) | blendExpected.at(-1)) >>> 0,
    'blend accumulator preserves shifted source and result byte');
  assert.strictEqual(e.get_ebx() >>> 0, blendInput2.at(-1), 'blend auxiliary byte');
  assert.strictEqual(e.test_lut_cf(), 0, 'blend final CMP at equality clears carry/JB');
  assert.strictEqual(e.test_lut_zf(), 1, 'blend final CMP at equality sets zero');
  assert.strictEqual(e.get_loop_lut_bounded_matches(), blendMatches + 1,
    'two-source bounded recognizer matched');
  assert(e.get_loop_lut_runs() >= blendRuns + 4,
    'two-source H418 resumes across step quanta');
  assert.strictEqual(Number(e.get_loop_lut_bytes() - blendBytes), blendInput1.length,
    'two-source H418 charges every pixel');

  const blendNear = Uint8Array.from(blendCode);
  blendNear[blendNear.length - 3] = 0x76; // JBE, not the proved JB terminator
  const blendNearMatches = e.get_loop_lut_bounded_matches();
  const blendNearRuns = e.get_loop_lut_runs();
  runAt(blendNear, () => {
    e.set_eax(blendSrc2); e.set_ecx(blendSrc1); e.set_edx(0);
    e.set_ebx(0); e.set_ebp(blendDst + 0x400); e.set_edi(blendSrc2 + 3);
  });
  assert.strictEqual(e.get_loop_lut_bounded_matches(), blendNearMatches,
    'two-source JBE near miss rejected');
  assert.strictEqual(e.get_loop_lut_runs(), blendNearRuns,
    'two-source near miss never enters H418');

  // JBE is not JB: even though this particular input reaches the same output,
  // the bounded recognizer must reject the different condition code.
  const nearMiss = Uint8Array.from(d2gfx);
  nearMiss[14] = 0x76;
  const nearMatches = e.get_loop_lut_bounded_matches();
  const nearRuns = e.get_loop_lut_runs();
  const nearDst = (dst + 0x800) >>> 0;
  put(nearDst, new Uint8Array(input.length).fill(0));
  runAt(nearMiss, () => {
    e.set_eax(src); e.set_ecx(nearDst); e.set_edx(0);
    e.set_esi(src + input.length - 1); e.set_edi(table);
  });
  assert.strictEqual(e.get_loop_lut_bounded_matches(), nearMatches, 'JBE near miss rejected');
  assert.strictEqual(e.get_loop_lut_runs(), nearRuns, 'near miss never enters H418');

  console.log('PASS universal LUT_RUN: Heroes counted + Diablo one/two-source bounded and row-table semantics, page splits, gate, and near miss');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

function le32(v) {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}
