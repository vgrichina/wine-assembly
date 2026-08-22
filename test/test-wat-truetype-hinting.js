#!/usr/bin/env node

'use strict';

// Runtime TrueType grid fitting. The engine is handwritten WAT and consumes
// bytecode preserved in the font; the test deliberately uses the full source
// font rather than a pre-rendered strike or a host font API.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const REPO = path.join(__dirname, '..');
const tag = text => ((text.charCodeAt(0) << 24) | (text.charCodeAt(1) << 16) |
  (text.charCodeAt(2) << 8) | text.charCodeAt(3)) >>> 0;

(async () => {
  const source = fs.readFileSync(
    path.join(REPO, 'src', '10c1-truetype-hint.wat'), 'utf8');
  assert.match(source, /\bbr_table\b/,
    'the bytecode dispatcher must remain a WAT br_table');
  assert.doesNotMatch(source, /freetype|generated interpreter|\.c\b/i,
    'the runtime engine must not name an external or generated implementation');
  const mdOpcode = source.match(/;; MD\[0\/1\]\.([\s\S]*?)\(call \$tth_fail/);
  assert.ok(mdOpcode, 'the MD opcode implementation must remain present');
  for (const projection of ['original', 'current']) {
    assert.match(mdOpcode[1], new RegExp(
      `\\$tth_project_${projection}\\s+` +
      `\\(global\\.get \\$tth_zp0\\)\\s+\\(local\\.get \\$other\\)\\s+` +
      `\\(global\\.get \\$tth_zp1\\)\\s+\\(local\\.get \\$point_index\\)`),
    `MD ${projection} distance must preserve the p2 minus p1 operand order`);
  }

  const { exports: wat, memory, hostCtx } = await bootRenderHarness();
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const copyToGuest = bytes => {
    const guest = wat.guest_alloc(bytes.length) >>> 0;
    assert.ok(guest, `guest_alloc(${bytes.length}) failed`);
    new Uint8Array(memory.buffer).set(bytes, wa(guest));
    return { at: wa(guest), size: bytes.length };
  };
  const allocZero = size => {
    const guest = wat.guest_alloc(size) >>> 0;
    new Uint8Array(memory.buffer).fill(0, wa(guest), wa(guest) + size);
    return guest;
  };
  const allocFaceW = text => {
    const guest = allocZero(text.length * 2 + 2);
    [...text].forEach((character, index) =>
      wat.guest_write16(guest + index * 2, character.charCodeAt(0)));
    return guest;
  };

  const fontBytes = fs.readFileSync(path.join(
    REPO, 'fonts', 'liberation', 'LiberationSans-Regular.ttf'));
  const font = copyToGuest(fontBytes);
  const compactGuest = wat.guest_alloc(512 * 6) >>> 0;
  const compact = wa(compactGuest);
  const gid = wat.test_tt_glyph_index(font.at, font.size, 'A'.charCodeAt(0));
  const count = wat.test_tt_glyph_load_outline(
    font.at, font.size, gid, compact, 512);
  assert.ok(count > 0, 'A must decode to a compact outline');

  const hinted = wat.test_tth_hint_outline(
    font.at, font.size, gid, 16, compact, count) >>> 0;
  assert.ok(hinted,
    `Liberation Sans A must hint (error=${wat.test_tth_last_error()}, ` +
    `phase=${wat.test_tth_last_phase()}, opcode=0x${wat.test_tth_last_opcode().toString(16)}, ` +
    `steps=${wat.test_tth_last_steps()})`);
  assert.ok(wat.test_tth_last_steps() > 0,
    'fpgm/prep/glyph bytecode must execute at runtime');

  let changed = 0;
  for (let i = 0; i < count; i += 1) {
    const unhintedX = wat.test_tt_fu_to_26_6(
      wat.test_tt_point_x(compact, i), 16, 2048);
    const unhintedY = wat.test_tt_fu_to_26_6(
      wat.test_tt_point_y(compact, i), 16, 2048);
    if (wat.test_tth_point_x(hinted, i) !== unhintedX ||
        wat.test_tth_point_y(hinted, i) !== unhintedY) changed += 1;
  }
  assert.ok(changed > 0, 'the glyph program must grid-fit at least one point');
  assert.ok(wat.test_tth_last_advance() > 0,
    'the two horizontal phantom points must produce a hinted advance');

  const fallbacks = [];
  let exercised = 0;
  for (let code = 0x20; code <= 0xFF; code += 1) {
    const glyph = wat.test_tt_glyph_index(font.at, font.size, code);
    const glyphCount = wat.test_tt_glyph_load_outline(
      font.at, font.size, glyph, compact, 512);
    if (!glyphCount) continue;
    exercised += 1;
    if (!wat.test_tth_hint_outline(
      font.at, font.size, glyph, 16, compact, glyphCount)) {
      fallbacks.push(`U+${code.toString(16).padStart(4, '0')} ` +
        `op=0x${wat.test_tth_last_opcode().toString(16)} ` +
        `error=${wat.test_tth_last_error()}`);
    }
  }
  assert.ok(exercised > 180, `expected a dense ANSI corpus, got ${exercised} glyphs`);
  assert.deepStrictEqual(fallbacks, [],
    'every outlined ANSI glyph in the deployed source face must execute');

  // Corrupt a private copy's fpgm with IDEF, which this Win98-targeted engine
  // deliberately rejects. The interpreter returns zero and the contour path
  // must still emit unhinted edges instead of trapping or losing the glyph.
  const corrupt = copyToGuest(fontBytes);
  const corruptFpgm = wat.test_tt_table_off(
    corrupt.at, corrupt.size, tag('fpgm')) >>> 0;
  assert.ok(corruptFpgm, 'the corruption gate needs an fpgm table');
  new Uint8Array(memory.buffer)[corrupt.at + corruptFpgm] = 0x89;
  const corruptGid = wat.test_tt_glyph_index(
    corrupt.at, corrupt.size, 'A'.charCodeAt(0));
  const corruptCount = wat.test_tt_glyph_load_outline(
    corrupt.at, corrupt.size, corruptGid, compact, 512);
  assert.strictEqual(wat.test_tth_hint_outline(
    corrupt.at, corrupt.size, corruptGid, 16, compact, corruptCount), 0,
  'unsupported/corrupt bytecode must request unhinted fallback');
  const edgeGuest = wat.guest_alloc(1024 * 16) >>> 0;
  assert.ok(wat.test_tt_glyph_edges(corrupt.at, corrupt.size, corruptGid, 16,
    compact, 512, wa(edgeGuest), 1024) > 0,
  'the raster contour path must survive an interpreter refusal');

  let deployedPrograms = 0;
  const deployedFiles = fs.readdirSync(path.join(REPO, 'fonts', 'subset'))
    .filter(name => /^(Liberation|tahoma).*\.ttf$/i.test(name));
  for (const name of deployedFiles) {
    const deployed = copyToGuest(fs.readFileSync(
      path.join(REPO, 'fonts', 'subset', name)));
    const requiredTables = /^Liberation/.test(name)
      ? ['cvt ', 'fpgm', 'prep'] : ['cvt '];
    for (const table of requiredTables) {
      assert.ok(wat.test_tt_table_len(deployed.at, deployed.size, tag(table)) > 0,
        `${name} must preserve ${table} runtime bytecode state`);
    }
    for (const character of ['A', 'g', 'é']) {
      const deployedGid = wat.test_tt_glyph_index(
        deployed.at, deployed.size, character.charCodeAt(0));
      const deployedCount = wat.test_tt_glyph_load_outline(
        deployed.at, deployed.size, deployedGid, compact, 512);
      assert.ok(deployedCount, `${name} must retain ${character}`);
      for (const ppem of [9, 16, 24]) {
        assert.ok(wat.test_tth_hint_outline(deployed.at, deployed.size,
          deployedGid, ppem, compact, deployedCount),
        `${name} ${character} must hint at ${ppem}ppem ` +
          `(error=${wat.test_tth_last_error()}, ` +
          `opcode=0x${wat.test_tth_last_opcode().toString(16)}, ` +
          `arg=0x${(wat.test_tth_last_fault_arg() >>> 0).toString(16)}, ` +
          `phase=${wat.test_tth_last_phase()}, pc=${wat.test_tth_last_pc()})`);
        deployedPrograms += 1;
      }
    }
  }

  // A bad/truncated sfnt is a fallback signal, never a WebAssembly trap.
  assert.strictEqual(
    wat.test_tth_hint_outline(font.at, 64, gid, 16, compact, count), 0,
    'malformed input must refuse hinting cleanly');

  // Local original Win98 fonts are an optional, ignored oracle. Their bytes
  // are never checked in; when present they must execute through this engine.
  const oraclePath = path.join(
    REPO, '.cache', 'v86-reference', 'native-fonts', 'arial.ttf');
  let oracle = 'not installed';
  if (fs.existsSync(oraclePath)) {
    const native = copyToGuest(fs.readFileSync(oraclePath));

    // Windows uses Arial's ANSI, square-pixel VDMX group for TEXTMETRIC so
    // grid-fitted extrema are not clipped by linearly scaled OS/2 metrics.
    // These are the same tmAscent/tmDescent values captured by the Win98
    // comparison probe; 12, 18 and 26ppem each need one more ascent pixel.
    assert.deepStrictEqual([12, 18, 26, 36].map(ppem => [
      wat.test_tt_tm_ascent(native.at, native.size, ppem),
      wat.test_tt_tm_descent(native.at, native.size, ppem),
      wat.test_tt_tm_height(native.at, native.size, ppem),
    ]), [
      [12, 3, 15],
      [17, 4, 21],
      [25, 6, 31],
      [33, 8, 41],
    ], 'Win98 Arial TEXTMETRIC must use its square-pixel ANSI VDMX records');
    let nativePoints = 0;
    for (const character of ['A', 'g', 'é']) {
      const nativeGid = wat.test_tt_glyph_index(
        native.at, native.size, character.charCodeAt(0));
      const nativeCount = wat.test_tt_glyph_load_outline(
        native.at, native.size, nativeGid, compact, 512);
      const nativeProgram = wat.test_tth_glyph_program(
        native.at, native.size, nativeGid) >>> 0;
      assert.ok(nativeProgram && wat.test_tth_last_program_length(),
        `Win98 Arial ${character} must expose glyph instructions ` +
        `(gid=${nativeGid}, count=${nativeCount}, ` +
        `program=0x${nativeProgram.toString(16)}, ` +
        `length=${wat.test_tth_last_program_length()})`);
      const nativeHinted = wat.test_tth_hint_outline(
        native.at, native.size, nativeGid, 24, compact, nativeCount) >>> 0;
      assert.ok(nativeHinted,
        `Win98 Arial ${character} must hint (error=${wat.test_tth_last_error()}, ` +
        `phase=${wat.test_tth_last_phase()}, opcode=0x${wat.test_tth_last_opcode().toString(16)}, ` +
        `arg=${wat.test_tth_last_fault_arg()}, pc=${wat.test_tth_last_pc()}, ` +
        `steps=${wat.test_tth_last_steps()})`);
      nativePoints += nativeCount;
      if (character === 'A') {
        const expectedX = [-14, 394, 566, 974, 847, 714, 246, 112,
          292, 668, 557, 506, 480, 452, 414];
        const expectedY = [0, 1088, 1088, 0, 0, 320, 320, 0,
          448, 448, 750, 889, 960, 886, 782];
        const actualX = Array.from({ length: nativeCount }, (_, index) =>
          wat.test_tth_point_x(nativeHinted, index));
        const actualY = Array.from({ length: nativeCount }, (_, index) =>
          wat.test_tth_point_y(nativeHinted, index));
        assert.ok(actualX.every((value, index) =>
          Math.abs(value - expectedX[index]) <= 1),
        'Win98 Arial A x coordinates must remain within 1/64 pixel of the oracle');
        assert.deepStrictEqual(actualY, expectedY,
          'Win98 Arial A y coordinates must match the oracle exactly');
        assert.strictEqual(wat.test_tth_last_advance(), 960,
          'Win98 Arial A hinted advance must match its 15-pixel device width');
      }
      if (character === 'é') {
        assert.deepStrictEqual(
          [30, 31, 32, 33].map(index => wat.test_tth_point_x(nativeHinted, index)),
          [320, 392, 576, 384],
          'compound child programs must reproduce Win98 Arial acute x points');
        assert.deepStrictEqual(
          [30, 31, 32, 33].map(index => wat.test_tth_point_y(nativeHinted, index)),
          [896, 1088, 1088, 896],
          'compound child programs must reproduce Win98 Arial acute y points');
      }
    }
    assert.strictEqual(nativePoints, 92,
      'the A/g/e-acute raw point topology must stay stable before GGO expansion');

    // A fresh GGO_NATIVE capture from Windows 98 provides the critical points
    // around Arial W's MD-controlled SHPIX branch. The old reversed MD sign
    // displaced these points by several pixels; native rounding differs by at
    // most 2/64 pixel over this four-size oracle.
    const nativeWGid = wat.test_tt_glyph_index(
      native.at, native.size, 'W'.charCodeAt(0));
    const nativeWCount = wat.test_tt_glyph_load_outline(
      native.at, native.size, nativeWGid, compact, 512);
    assert.strictEqual(nativeWCount, 25,
      'Win98 Arial W raw point topology must remain stable');
    const win98WPoints = new Map([
      [12, [[5, 160, 145], [8, 309, 576], [9, 395, 576],
        [12, 544, 145], [21, 352, 506]]],
      [18, [[5, 288, 116], [8, 442, 832], [9, 646, 832],
        [12, 800, 116], [21, 544, 732]]],
      [26, [[5, 416, 170], [8, 709, 1216], [9, 890, 1216],
        [12, 1184, 170], [21, 800, 1069]]],
      [36, [[5, 544, 233], [8, 982, 1664], [9, 1257, 1664],
        [12, 1696, 233], [21, 1120, 1463]]],
    ]);
    for (const [ppem, expectedPoints] of win98WPoints) {
      const nativeWHinted = wat.test_tth_hint_outline(
        native.at, native.size, nativeWGid, ppem, compact, nativeWCount) >>> 0;
      assert.ok(nativeWHinted,
        `Win98 Arial W must hint at ${ppem}ppem ` +
        `(error=${wat.test_tth_last_error()}, ` +
        `opcode=0x${wat.test_tth_last_opcode().toString(16)})`);
      for (const [index, expectedX, expectedY] of expectedPoints) {
        const actualX = wat.test_tth_point_x(nativeWHinted, index);
        const actualY = wat.test_tth_point_y(nativeWHinted, index);
        assert.ok(Math.abs(actualX - expectedX) <= 2 &&
          Math.abs(actualY - expectedY) <= 2,
        `Win98 Arial W point ${index} at ${ppem}ppem must stay within ` +
          `2/64 pixel of the native oracle; got (${actualX}, ${actualY}), ` +
          `expected (${expectedX}, ${expectedY})`);
      }
    }

    // GGO_BITMAP from the same Win98 VM distinguishes scan conversion from
    // the point oracle above. At 12ppem Arial enables SCANCTRL bit 8 with
    // SCANTYPE 1: pixel-centre fill draws the body and dropout control retains
    // the two thin outer strokes on row 3.
    const w12Width = wat.test_tt_glyph_box_width(
      native.at, native.size, nativeWGid, 12);
    const w12Height = wat.test_tt_glyph_box_height(
      native.at, native.size, nativeWGid, 12);
    const w12Left = wat.test_tt_glyph_box_left(
      native.at, native.size, nativeWGid, 12);
    const w12Top = wat.test_tt_glyph_box_top(
      native.at, native.size, nativeWGid, 12);
    assert.deepStrictEqual([w12Width, w12Height, w12Left, w12Top], [11, 9, 0, 9],
      'Win98 Arial W 12ppem monochrome metrics must match');
    const w12BitmapGuest = wat.guest_alloc(32) >>> 0;
    const w12ScratchBytes = wat.test_tt_raster_scratch_bytes(w12Width) >>> 0;
    const w12ScratchGuest = wat.guest_alloc(w12ScratchBytes) >>> 0;
    assert.strictEqual(wat.test_tt_rasterize_glyph(
      native.at, native.size, nativeWGid, 12, wa(w12BitmapGuest),
      w12Width, w12Height, w12Left * 64, w12Top * 64,
      wa(w12ScratchGuest), w12ScratchBytes), 1,
    'Win98 Arial W 12ppem must scan-convert');
    const w12Rows = Array.from({ length: w12Height }, (_, y) =>
      Array.from({ length: w12Width }, (_unused, x) =>
        wat.test_tt_bitmap_pixel(wa(w12BitmapGuest), w12Height, x, y)
          ? '#' : '.').join(''));
    assert.deepStrictEqual(w12Rows, [
      '#....#....#',
      '#...#.#...#',
      '#...#.#..#.',
      '.#..#.#..#.',
      '.#.#...#.#.',
      '.#.#...#.#.',
      '.#.#...#.#.',
      '..#.....#..',
      '..#.....#..',
    ], 'Win98 Arial W 12ppem monochrome bitmap must match exactly');

    // The native 12ppem GGO_NATIVE capture also exposes Win98's initial
    // horizontal phantom placement. Arial's digit advance scales to 427/64,
    // but Win98 supplies point n+1 to the glyph program at 448/64. The white
    // MIRP that references it therefore places the outer stem at 384/64.
    // Pin both that causal outline and the corner pixels it controls.
    const digitOracles = new Map([
      ['0', {
        points: [[8, 384, 372], [9, 384, 288], [10, 384, 189],
          [22, 320, 122], [23, 320, 288], [24, 320, 423]],
        rows: ['.###.', '#...#', '#...#', '#...#', '#...#',
          '#...#', '#...#', '#...#', '.###.'],
      }],
      ['9', {
        points: [[8, 320, 209], [9, 320, 251], [10, 320, 256],
          [23, 384, 407], [24, 384, 303], [25, 384, 195]],
        rows: ['.###.', '#...#', '#...#', '#...#', '#..##',
          '.##.#', '....#', '#...#', '.###.'],
      }],
    ]);
    for (const [character, expected] of digitOracles) {
      const digitGid = wat.test_tt_glyph_index(
        native.at, native.size, character.charCodeAt(0));
      const digitCount = wat.test_tt_glyph_load_outline(
        native.at, native.size, digitGid, compact, 512);
      const digitHinted = wat.test_tth_hint_outline(
        native.at, native.size, digitGid, 12, compact, digitCount) >>> 0;
      assert.ok(digitHinted, `Win98 Arial ${character} must hint at 12ppem`);
      assert.strictEqual(wat.test_tth_last_advance(), 448,
        `Win98 Arial ${character} must expose its seven-pixel phantom advance`);
      for (const [index, expectedX, expectedY] of expected.points) {
        const actualX = wat.test_tth_point_x(digitHinted, index);
        const actualY = wat.test_tth_point_y(digitHinted, index);
        assert.ok(actualX === expectedX && Math.abs(actualY - expectedY) <= 1,
          `Win98 Arial ${character} point ${index} must match the native ` +
          `oracle; got (${actualX}, ${actualY}), expected ` +
          `(${expectedX}, ${expectedY})`);
      }
      const width = wat.test_tt_glyph_box_width(
        native.at, native.size, digitGid, 12);
      const height = wat.test_tt_glyph_box_height(
        native.at, native.size, digitGid, 12);
      const left = wat.test_tt_glyph_box_left(
        native.at, native.size, digitGid, 12);
      const top = wat.test_tt_glyph_box_top(
        native.at, native.size, digitGid, 12);
      assert.deepStrictEqual([width, height, left, top], [5, 9, 1, 9],
        `Win98 Arial ${character} monochrome metrics must match`);
      const bitmapGuest = wat.guest_alloc(32) >>> 0;
      const scratchBytes = wat.test_tt_raster_scratch_bytes(width) >>> 0;
      const scratchGuest = wat.guest_alloc(scratchBytes) >>> 0;
      assert.strictEqual(wat.test_tt_rasterize_glyph(
        native.at, native.size, digitGid, 12, wa(bitmapGuest), width, height,
        left * 64, top * 64, wa(scratchGuest), scratchBytes), 1,
      `Win98 Arial ${character} must scan-convert at 12ppem`);
      const rows = Array.from({ length: height }, (_, y) =>
        Array.from({ length: width }, (_unused, x) =>
          wat.test_tt_bitmap_pixel(wa(bitmapGuest), height, x, y)
            ? '#' : '.').join(''));
      assert.deepStrictEqual(rows, expected.rows,
        `Win98 Arial ${character} 12ppem monochrome bitmap must match exactly`);
    }

    // Arial's prep program creates twilight points with MIAP, interpolates
    // them, and writes the resulting x-height back to CVT 6.  Win98 rounds
    // that anchor to seven pixels at 12ppem; losing the twilight point's
    // original coordinate instead collapses the CVT and erases this top row.
    const nativeMGid = wat.test_tt_glyph_index(
      native.at, native.size, 'm'.charCodeAt(0));
    const m12Width = wat.test_tt_glyph_box_width(
      native.at, native.size, nativeMGid, 12);
    const m12Height = wat.test_tt_glyph_box_height(
      native.at, native.size, nativeMGid, 12);
    const m12Left = wat.test_tt_glyph_box_left(
      native.at, native.size, nativeMGid, 12);
    const m12Top = wat.test_tt_glyph_box_top(
      native.at, native.size, nativeMGid, 12);
    assert.deepStrictEqual([m12Width, m12Height, m12Left, m12Top,
      wat.test_tth_last_advance()], [9, 7, 1, 7, 704],
    'Win98 Arial m 12ppem metrics and 11-pixel advance must match');
    const m12BitmapGuest = wat.guest_alloc(32) >>> 0;
    const m12ScratchBytes = wat.test_tt_raster_scratch_bytes(m12Width) >>> 0;
    const m12ScratchGuest = wat.guest_alloc(m12ScratchBytes) >>> 0;
    assert.strictEqual(wat.test_tt_rasterize_glyph(
      native.at, native.size, nativeMGid, 12, wa(m12BitmapGuest),
      m12Width, m12Height, m12Left * 64, m12Top * 64,
      wa(m12ScratchGuest), m12ScratchBytes), 1,
    'Win98 Arial m 12ppem must scan-convert');
    const m12Rows = Array.from({ length: m12Height }, (_, y) =>
      Array.from({ length: m12Width }, (_unused, x) =>
        wat.test_tt_bitmap_pixel(wa(m12BitmapGuest), m12Height, x, y)
          ? '#' : '.').join(''));
    assert.deepStrictEqual(m12Rows, [
      '#.##..##.',
      '##..##..#',
      '#...#...#',
      '#...#...#',
      '#...#...#',
      '#...#...#',
      '#...#...#',
    ], 'Win98 Arial m 12ppem monochrome bitmap must match exactly');

    // Drive the public GDI seam with the original local file and compare the
    // resulting quadratic streams to bytes captured from real Windows 98.
    const win98Fixture = require('./fixtures/gdi-font-outline-win98.json');
    hostCtx.vfs.dirs.add('c:\\windows');
    hostCtx.vfs.dirs.add('c:\\windows\\fonts');
    hostCtx.vfs.files.set('c:\\windows\\fonts\\arial.ttf', {
      data: new Uint8Array(fs.readFileSync(oraclePath)), attrs: 0x20,
    });
    const fontHandle = wat.test_call_CreateFontW(
      -24, 400, 0, allocFaceW('Arial')) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert.ok(fontHandle && hdc, 'the local Win98 GDI oracle needs a font and DC');
    wat.test_call_SelectObject(hdc, fontHandle);
    const identity = allocZero(16);
    wat.guest_write32(identity, 0x00010000);
    wat.guest_write32(identity + 12, 0x00010000);
    const metrics = allocZero(20);
    let metricCases = 0;
    for (const character of ['A', 'g', 'é']) {
      const code = character.charCodeAt(0);
      const expected = win98Fixture.cases.find(entry =>
        entry.character === code && entry.format === 2 && entry.matrix === 'identity');
      assert.ok(expected, `missing Win98 GGO_NATIVE fixture for ${character}`);
      const needed = wat.test_call_GetGlyphOutlineA(
        hdc, code, 2, metrics, 0, 0, identity) >>> 0;
      const cell = wat.guest_read32(metrics + 16) >>> 0;
      const signed16 = value => (value << 16) >> 16;
      const actualMetrics = [
        wat.guest_read32(metrics) >>> 0,
        wat.guest_read32(metrics + 4) >>> 0,
        wat.guest_read32(metrics + 8) | 0,
        wat.guest_read32(metrics + 12) | 0,
        signed16(cell & 0xFFFF), signed16(cell >>> 16),
      ];
      const buffer = allocZero(needed);
      assert.strictEqual(wat.test_call_GetGlyphOutlineA(
        hdc, code, 2, metrics, needed, buffer, identity) >>> 0, needed);
      assert.deepStrictEqual(actualMetrics, expected.metrics,
        `Win98 GGO_NATIVE metrics must match for ${character}`);
      assert.ok(needed > 0, `${character} must return a native quadratic stream`);
      metricCases += 1;
    }
    let controlPrograms = 0;
    for (const filename of ['times.ttf', 'cour.ttf']) {
      const controlPath = path.join(path.dirname(oraclePath), filename);
      if (!fs.existsSync(controlPath)) continue;
      const control = copyToGuest(fs.readFileSync(controlPath));
      for (const character of ['A', 'g', 'é']) {
        const controlGid = wat.test_tt_glyph_index(
          control.at, control.size, character.charCodeAt(0));
        const controlCount = wat.test_tt_glyph_load_outline(
          control.at, control.size, controlGid, compact, 512);
        assert.ok(wat.test_tth_hint_outline(control.at, control.size,
          controlGid, 24, compact, controlCount),
        `Win98 ${filename} ${character} must hint ` +
          `(error=${wat.test_tth_last_error()}, ` +
          `opcode=0x${wat.test_tth_last_opcode().toString(16)})`);
        controlPrograms += 1;
      }
    }
    oracle = `${nativePoints} Arial raw points, ` +
      `${win98WPoints.size * 5} Arial W point cases, ` +
      `${digitOracles.size} exact Arial digit bitmaps, ` +
      `${metricCases}/3 exact GGO metric cases, ` +
      `${controlPrograms} Times/Courier programs`;
  }

  console.log(`PASS  runtime TrueType hinting moves ${changed}/${count} ` +
    `A points and executes ${exercised} ANSI glyphs; ` +
    `${deployedPrograms} deployed face/glyph/size programs; ` +
    `local Win98 Arial oracle: ${oracle}`);
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
