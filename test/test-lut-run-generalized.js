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

  // Jazz Jackrabbit 2's hot in-place palette remap at 0x463b49 uses a simple
  // base+absolute table read rather than the SIB form above. The accumulator
  // itself is the index: mov dl,[edx+table]. It must lower to the same H418
  // executor instead of retiring seven handlers once per pixel.
  const jazzPixels = (rowArena + 0x600) >>> 0;
  const jazzInput = Array.from({ length: 97 }, (_, i) => (i * 29 + 5) & 0xff);
  put(jazzPixels, jazzInput);
  const jazz = Uint8Array.from([
    0x33, 0xd2,                         // xor edx,edx
    0x8a, 0x10,                         // mov dl,[eax]
    0x40,                               // inc eax
    0x49,                               // dec ecx
    0x8a, 0x92, ...le32(table),         // mov dl,[edx+absolute table]
    0x88, 0x50, 0xff,                   // mov [eax-1],dl
    0x75, 0xef,                         // jnz loop
    0xc3,
  ]);
  const jazzRuns = e.get_loop_lut_runs();
  runAt(jazz, () => {
    e.set_eax(jazzPixels); e.set_ecx(jazzInput.length); e.set_edx(0xfeedface);
  });
  assert.deepStrictEqual(get(jazzPixels, jazzInput.length), jazzInput.map(v => lut[v]),
    'Jazz absolute-table remap output');
  assert.strictEqual(e.get_eax() >>> 0, (jazzPixels + jazzInput.length) >>> 0,
    'Jazz in-place cursor');
  assert.strictEqual(e.get_ecx() >>> 0, 0, 'Jazz counter');
  assert.strictEqual(e.get_edx() >>> 0, lut[jazzInput.at(-1)],
    'Jazz accumulator publishes final table byte');
  assert.strictEqual(e.test_lut_cf(), 0, 'Jazz final DEC preserves cleared carry');
  assert.strictEqual(e.test_lut_zf(), 1, 'Jazz final DEC sets zero');
  assert.strictEqual(e.get_loop_lut_runs(), jazzRuns + 1,
    'Jazz absolute-table loop uses one H418 run');

  // Heroes III's exact RGB565 form has an 8-bit source and a 16-bit table and
  // destination. Exercise both destination directions across page boundaries;
  // the table itself also straddles a page so the affine-span proof is used.
  const h3Forward = Uint8Array.from([
    0x31, 0xc9,                         // xor ecx,ecx
    0x8a, 0x0a,                         // mov cl,[edx]
    0x83, 0xc0, 0x02,                   // add eax,2
    0x42,                               // inc edx
    0x4d,                               // dec ebp
    0x66, 0x8b, 0x4c, 0x4f, 0x1c,       // mov cx,[edi+ecx*2+0x1c]
    0x66, 0x89, 0x48, 0xfe,             // mov [eax-2],cx
    0x75, 0xec,                         // jnz loop
    0xc3,
  ]);
  const h3Backward = Uint8Array.from([
    0x31, 0xc9,                         // xor ecx,ecx
    0x8a, 0x0a,                         // mov cl,[edx]
    0x83, 0xe8, 0x02,                   // sub eax,2
    0x42,                               // inc edx
    0x4d,                               // dec ebp
    0x66, 0x8b, 0x4c, 0x4f, 0x1c,       // mov cx,[edi+ecx*2+0x1c]
    0x66, 0x89, 0x08,                   // mov [eax],cx
    0x75, 0xed,                         // jnz loop
    0xc3,
  ]);
  const h3Arena = e.guest_alloc(0x9000) >>> 0;
  const h3Src = alignPageEnd(h3Arena + 0x100, 5) >>> 0;
  const h3Dst = alignPageEnd(h3Arena + 0x3100, 6) >>> 0;
  const h3BackDst = (h3Arena + 0x5000) >>> 0;
  const h3TableBase = alignPageEnd(h3Arena + 0x7100, 0x100) >>> 0;
  const h3Input = Array.from({ length: 301 }, (_, i) => (i * 43 + 11) & 0xff);
  const h3Color = i => ((((i * 17) & 0xf800) | ((i * 29) & 0x07e0) |
    ((i * 7) & 0x001f)) ^ 0x39e7) & 0xffff;
  put(h3Src, h3Input);
  for (let i = 0; i < 256; i++) dv.setUint16(wa(h3TableBase + 0x1c) + i * 2, h3Color(i), true);
  const readWords = (ga, n) => Array.from({ length: n }, (_, i) => dv.getUint16(wa(ga) + i * 2, true));
  const h3Expected = h3Input.map(h3Color);
  const h3Matches = e.get_loop_lut16_matches();
  const h3Runs = e.get_loop_lut16_runs();
  const h3Pixels = e.get_loop_lut16_bytes();
  runAt(h3Forward, () => {
    e.set_eax(h3Dst); e.set_ecx(0xcccccccc); e.set_edx(h3Src);
    e.set_ebp(h3Input.length); e.set_edi(h3TableBase);
  });
  assert.deepStrictEqual(readWords(h3Dst, h3Input.length), h3Expected,
    'Heroes III forward RGB565 output');
  assert.strictEqual(e.get_eax() >>> 0, (h3Dst + h3Input.length * 2) >>> 0,
    'Heroes III forward destination cursor');
  assert.strictEqual(e.get_edx() >>> 0, (h3Src + h3Input.length) >>> 0,
    'Heroes III source cursor');
  assert.strictEqual(e.get_ebp() >>> 0, 0, 'Heroes III counter');
  assert.strictEqual(e.get_ecx() & 0xffff, h3Expected.at(-1),
    'Heroes III final 16-bit accumulator');
  assert.strictEqual(e.get_loop_lut16_matches(), h3Matches + 1,
    'Heroes III wide recognizer matched');
  assert(e.get_loop_lut16_runs() >= h3Runs + 3,
    'Heroes III H418 resumes across step quanta');
  assert.strictEqual(Number(e.get_loop_lut16_bytes() - h3Pixels), h3Input.length,
    'Heroes III H418 charges every pixel');

  runAt(h3Backward, () => {
    e.set_eax(h3BackDst + h3Input.length * 2); e.set_ecx(0); e.set_edx(h3Src);
    e.set_ebp(h3Input.length); e.set_edi(h3TableBase);
  });
  assert.deepStrictEqual(readWords(h3BackDst, h3Input.length), h3Expected.slice().reverse(),
    'Heroes III backward RGB565 output');
  assert.strictEqual(e.get_eax() >>> 0, h3BackDst, 'Heroes III backward destination cursor');

  const h3Baseline = (h3BackDst + 0x800) >>> 0;
  e.set_loop_lut_emit(0);
  const h3BaselineRuns = e.get_loop_lut16_runs();
  runAt(h3Forward, () => {
    e.set_eax(h3Baseline); e.set_ecx(0); e.set_edx(h3Src);
    e.set_ebp(h3Input.length); e.set_edi(h3TableBase);
  });
  assert.deepStrictEqual(readWords(h3Baseline, h3Input.length), h3Expected,
    'lowered and ordinary Heroes III loops agree');
  assert.strictEqual(e.get_loop_lut16_runs(), h3BaselineRuns,
    'LUT-only gate suppresses wide H418');
  e.set_loop_lut_emit(1);

  // The dominant H3 map loop prefixes the same RGB565 body with an invariant
  // `mov table,[esp+0x40]`. H418 loads that slot once per page/budget chunk
  // and publishes the architectural table register at exit.
  const h3StackTable = Uint8Array.from([
    0x8b, 0x4c, 0x24, 0x40,             // mov ecx,[esp+0x40]
    0x31, 0xc0,                         // xor eax,eax
    0x8a, 0x02,                         // mov al,[edx]
    0x83, 0xc5, 0x02,                   // add ebp,2
    0x42,                               // inc edx
    0x4e,                               // dec esi
    0x66, 0x8b, 0x44, 0x41, 0x1c,       // mov ax,[ecx+eax*2+0x1c]
    0x66, 0x89, 0x45, 0xfe,             // mov [ebp-2],ax
    0x75, 0xe8,                         // jnz loop
    0xc3,
  ]);
  const h3StackDst = (h3BackDst + 0x1000) >>> 0;
  const h3StackMatches = e.get_loop_lut16_matches();
  const h3StackRuns = e.get_loop_lut16_runs();
  runAt(h3StackTable, () => {
    dv.setUint32(wa(stack + 0x40), h3TableBase, true);
    e.set_eax(0xaaaaaaaa); e.set_ecx(0xcccccccc); e.set_edx(h3Src);
    e.set_ebp(h3StackDst); e.set_esi(h3Input.length);
  });
  assert.deepStrictEqual(readWords(h3StackDst, h3Input.length), h3Expected,
    'Heroes III stack-table RGB565 output');
  assert.strictEqual(e.get_ecx() >>> 0, h3TableBase,
    'Heroes III stack-loaded table register published');
  assert.strictEqual(e.get_loop_lut16_matches(), h3StackMatches + 1,
    'Heroes III stack-table recognizer matched');
  assert(e.get_loop_lut16_runs() >= h3StackRuns + 3,
    'Heroes III stack-table H418 resumes across step quanta');

  e.set_loop_lut16_stack_emit(0);
  const h3StackBaseline = (h3StackDst + 0x800) >>> 0;
  const h3StackBaselineRuns = e.get_loop_lut16_runs();
  runAt(h3StackTable, () => {
    dv.setUint32(wa(stack + 0x40), h3TableBase, true);
    e.set_eax(0); e.set_ecx(0); e.set_edx(h3Src);
    e.set_ebp(h3StackBaseline); e.set_esi(h3Input.length);
  });
  assert.deepStrictEqual(readWords(h3StackBaseline, h3Input.length), h3Expected,
    'lowered and ordinary Heroes III stack-table loops agree');
  assert.strictEqual(e.get_loop_lut16_runs(), h3StackBaselineRuns,
    'stack-only gate suppresses stack-table H418');
  e.set_loop_lut16_stack_emit(1);

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

  console.log('PASS universal LUT_RUN: Heroes byte/RGB565 + Jazz counted, Diablo one/two-source bounded and row-table semantics, page splits, gate, and near miss');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

function le32(v) {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}
