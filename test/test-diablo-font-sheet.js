#!/usr/bin/env node
// Storm's monochrome font sheet, replayed without Diablo.
//
//   node test/test-diablo-font-sheet.js
//
// `SGdiTextOut` builds its glyph atlas once, at the top of the first credits
// frame, and every line of scrolling text is composed out of it. When the
// atlas is wrong every string comes out as a solid bar, which is what Diablo's
// Show Credits screen renders today.
//
// Reaching that screen in the emulator costs about 140 seconds -- the menu is
// ~39,400 batches of real interpretation in and the boot is work-bound, so no
// clock flag shortens it. But the atlas is only eight GDI calls, traced out of
// a real run:
//
//   CreateCompatibleDC
//   CreateDIBitmap(320x320, planes=1, bpp=1, fdwInit=0)   <- MONOCHROME
//   SelectObject(dc, bitmap)
//   SelectObject WHITE_BRUSH + Rectangle(0,0,320,320)     <- paints the paper
//   SetTextColor(BLACK) / SetBkColor(WHITE) / SetBkMode(OPAQUE)
//   256 x ExtTextOutA(col*20+1, row*20+1, ETO_OPAQUE, cell)
//   GetDIBits(dc, bitmap, 0, 320, buf, bmi, DIB_RGB_COLORS)
//
// so they can be replayed directly against the raster harness in about a
// second. That is the loop this file exists to provide.
//
// The polarity is the thing to hold on to: the paper is WHITE and the ink is
// BLACK, and Storm treats "not the paper value" as ink. An atlas that comes
// back all zeros is therefore not a blank atlas -- it is a *fully inked* one,
// and it prints as exactly the solid bars we see. So "is the buffer empty" is
// not the question; "is the paper set" is.

'use strict';

const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const RAW = path.join(__dirname, 'output', 'diablo-font-sheet.bin');
const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];

// The handlers these need have no test_call_ wrapper in 13-exports.wat, and
// they are only interesting together with the rest of this sequence, so they
// are injected for this test rather than added to the shipped export list.
const EXTRA_WAT = `
  (func (export "t_GetStockObject") (param i32) (result i32)
    (call $handle_GetStockObject (local.get 0)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "t_SetTextColor") (param i32 i32) (result i32)
    (call $handle_SetTextColor (local.get 0) (local.get 1)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "t_SetBkColor") (param i32 i32) (result i32)
    (call $handle_SetBkColor (local.get 0) (local.get 1)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "t_g2w") (param i32) (result i32) (call $g2w (local.get 0)))
  (func (export "t_object_type") (param i32) (result i32)
    (call $gdi_object_type (local.get 0)))
  (func (export "t_bitmap_field") (param i32 i32) (result i32)
    (local $r i32)
    (local.set $r (call $gdi_object_record (local.get 0)))
    (if (i32.eqz (local.get $r)) (then (return (i32.const -1))))
    (i32.load (i32.add (local.get $r) (local.get 1))))
  (func (export "t_SetBkMode") (param i32 i32) (result i32)
    (call $handle_SetBkMode (local.get 0) (local.get 1)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

const SHEET = 320;          // the atlas is 320x320, a 16x16 grid of 20x20 cells
const CELL = 20;
const STRIDE = SHEET / 8;   // 1bpp, 40 bytes, already DWORD-aligned
const WHITE_BRUSH = 0;      // stock object index
const ETO_OPAQUE = 2;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`PASS  ${name}`); passed++; return; }
  console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  failed++;
}

// `table` says what the caller leaves after its BITMAPINFOHEADER:
//   'proper'  a real {black, white} pair
//   'absent'  nothing -- zeros, which is what a caller that passed only a
//             header gets, and the case Storm is really in (its stack there
//             holds junk, and junk includes zeros)
// Both must produce the same atlas, because without CBM_INIT the colour table
// is not an input at all: the bitmap is an uninitialised DDB and takes the
// device palette. That equivalence IS the regression this file guards.
async function buildAtlas(table) {
  const { exports: wat, memory } = await bootRenderHarness({ extraWat: EXTRA_WAT });
  // test_gdi_get_dibits is the raw internal, so unlike the test_call_* wrappers
  // it takes WASM pointers -- the API handler is what normally does the g2w.
  const bytes = () => new Uint8Array(memory.buffer);

  // --- build the atlas exactly as Storm does ---------------------------------
  const bmi = wat.guest_alloc(40 + 8) >>> 0;   // header + the 2-entry mono table
  for (let o = 0; o < 48; o += 4) wat.guest_write32(bmi + o, 0);
  wat.guest_write32(bmi, 40);
  wat.guest_write32(bmi + 4, SHEET);
  wat.guest_write32(bmi + 8, SHEET);           // positive: bottom-up, as traced
  wat.guest_write16(bmi + 12, 1);              // planes
  wat.guest_write16(bmi + 14, 1);              // bpp -- monochrome
  if (table === 'proper') {
    wat.guest_write32(bmi + 40, 0x00000000);   // 0 = black
    wat.guest_write32(bmi + 44, 0x00FFFFFF);   // 1 = white
  }

  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  check(`CreateCompatibleDC gave a memory DC [${table}]`, hdc !== 0);

  const hbmp = wat.test_call_CreateDIBitmap(hdc, bmi, 0, 0, bmi, 0) >>> 0;
  check(`CreateDIBitmap accepted a 320x320 1bpp header [${table}]`, hbmp !== 0,
    'a monochrome DIB is what SGdiTextOut asks for; returning 0 here is the ' +
    'whole bug, because Storm does not check and draws into nothing');
  if (!hbmp) return null;

  const prevBmp = wat.test_call_SelectObject(hdc, hbmp) >>> 0;
  check(`the atlas selected into the DC [${table}]`, prevBmp !== 0);

  console.log(`      [${table}] hbmp=0x${hbmp.toString(16)} type=${wat.t_object_type(hbmp)} ` +
    `w=${wat.t_bitmap_field(hbmp, 8)} h=${wat.t_bitmap_field(hbmp, 12)} ` +
    `bpp=${wat.t_bitmap_field(hbmp, 16)} bits=0x${(wat.t_bitmap_field(hbmp, 24) >>> 0).toString(16)} ` +
    `stride=${wat.t_bitmap_field(hbmp, 28)}`);

  // Format query first (lpvBits = NULL). This asks GetDIBits to describe the
  // bitmap rather than copy it, so it separates "the source bitmap is not what
  // we think" from "the copy failed" -- two very different bugs that both show
  // up as a zero return from the real call.
  {
    const q = wat.guest_alloc(40 + 8) >>> 0;
    for (let o = 0; o < 48; o += 4) wat.guest_write32(q + o, 0);
    wat.guest_write32(q, 40);
    const qh = wat.test_gdi_get_dibits(hdc, hbmp, 0, 0, 0, wat.t_g2w(q), 0) | 0;
    const qw = wat.guest_read32(q + 4) | 0;
    const qbpp = wat.guest_read32(q + 12) >>> 16;
    check(`the bitmap describes itself as ${SHEET}x${SHEET} 1bpp ` +
      `(got ${qw}x${qh} ${qbpp}bpp) [${table}]`,
      qh === SHEET && qw === SHEET && qbpp === 1,
      'CreateDIBitmap did not make a monochrome bitmap from a bpp=1 header');
  }

  // Paper. Storm paints it with the white stock brush before any glyph.
  const white = wat.t_GetStockObject(WHITE_BRUSH) >>> 0;
  check(`WHITE_BRUSH is a real stock object [${table}]`, white !== 0);
  wat.test_call_SelectObject(hdc, white);
  wat.test_call_Rectangle(hdc, 0, 0, SHEET, SHEET);

  wat.t_SetTextColor(hdc, 0x000000);
  wat.t_SetBkColor(hdc, 0xFFFFFF);
  wat.t_SetBkMode(hdc, 2);                     // OPAQUE

  const rc = wat.guest_alloc(16) >>> 0;
  const ch = wat.guest_alloc(2) >>> 0;
  for (let code = 0; code < 256; code++) {
    const col = code & 15, row = code >> 4;
    wat.guest_write32(rc, col * CELL);
    wat.guest_write32(rc + 4, row * CELL);
    wat.guest_write32(rc + 8, col * CELL + CELL);
    wat.guest_write32(rc + 12, row * CELL + CELL);
    wat.guest_write16(ch, code);               // one char, NUL-terminated
    wat.test_call_ExtTextOutA(hdc, col * CELL + 1, row * CELL + 1,
      ETO_OPAQUE, rc, ch, 1);
  }

  // Before the readback: what is actually in the bitmap's own pixels? This
  // separates "nothing was ever drawn" from "GetDIBits inverted the polarity",
  // which look identical in the output buffer and have opposite fixes.
  {
    const raw = wat.t_bitmap_field(hbmp, 24) >>> 0;
    const surf = bytes().subarray(raw, raw + STRIDE * SHEET);
    let set = 0;
    for (const b of surf) set += POPCOUNT[b];
    console.log(`      [${table}] source surface: ${set}/${SHEET * SHEET} bits set ` +
      `(${(set / (SHEET * SHEET) * 100).toFixed(1)}%)`);
  }

  // --- read it back ----------------------------------------------------------
  const size = STRIDE * SHEET;
  const bits = wat.guest_alloc(size) >>> 0;
  for (let o = 0; o < size; o += 4) wat.guest_write32(bits + o, 0);
  const lines = wat.test_gdi_get_dibits(
    hdc, hbmp, 0, SHEET, wat.t_g2w(bits), wat.t_g2w(bmi), 0) | 0;
  check(`GetDIBits returned all ${SHEET} scanlines (${lines}) [${table}]`, lines === SHEET);

  const sheet = Buffer.from(bytes().subarray(wat.t_g2w(bits), wat.t_g2w(bits) + size));
  fs.writeFileSync(RAW.replace('.bin', `-${table}.bin`), sheet);

  // A bit-set count, not a byte count: the polarity is the finding.
  let set = 0;
  for (const b of sheet) set += POPCOUNT[b];
  const total = SHEET * SHEET;
  const pct = (set / total * 100).toFixed(1);

  // The paper is white and white is 1 in a monochrome DIB whose colour table
  // is the default {black, white}. Glyph ink at this size covers a few percent
  // of a 20x20 cell, so a correct atlas is overwhelmingly set bits. All-zero
  // is the failure, and it is not "nothing was drawn" -- Storm reads a zero as
  // ink, so an empty atlas prints every string as a filled rectangle.
  check(`the atlas is mostly paper, not ink (${pct}% bits set) [${table}]`, set > total * 0.5,
    set === 0
      ? 'every bit is zero. Storm reads "not paper = ink", so this atlas draws '
        + 'every glyph as a solid 20x20 block -- exactly the credits symptom. '
        + 'Look at Rectangle/WHITE_BRUSH on a 1bpp DIB first, then GetDIBits.'
      : `only ${set}/${total} bits set; the paper fill did not cover the sheet`);

  // Ink has to exist too, or the atlas is a blank page and text vanishes.
  check(`glyphs were rasterized into it (${total - set} ink pixels) [${table}]`,
    set > 0 && set < total,
    set === total ? 'the sheet is uniformly paper — no glyph reached it' : '');

  // Per-cell: a real atlas has ink in the printable range and (mostly) none in
  // the control range. This is what catches a sheet that drew one giant glyph
  // instead of 256 small ones, which a whole-sheet count cannot see.
  const inkInCell = (code) => {
    const cx = (code & 15) * CELL, cy = (code >> 4) * CELL;
    let n = 0;
    for (let y = cy; y < cy + CELL; y++) {
      for (let x = cx; x < cx + CELL; x++) {
        // Bottom-up DIB: row 0 of the buffer is the bottom of the image.
        const srcY = SHEET - 1 - y;
        if (!((sheet[srcY * STRIDE + (x >> 3)] >> (7 - (x & 7))) & 1)) n++;
      }
    }
    return n;
  };
  const inked = [];
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') inked.push(inkInCell(c.charCodeAt(0)));
  const drawn = inked.filter(n => n > 0).length;
  check(`each printable glyph got its own cell (${drawn}/${inked.length} inked) [${table}]`,
    drawn >= inked.length - 2,
    `cell ink counts: ${inked.join(',')}`);
  const overflowing = inked.filter(n => n >= CELL * CELL).length;
  check(`no cell is filled solid (${overflowing} solid of ${inked.length}) [${table}]`,
    overflowing === 0,
    'a completely inked cell is the bar Storm prints');

  return sheet;
}

(async () => {
  fs.mkdirSync(path.dirname(RAW), { recursive: true });
  const withTable = await buildAtlas('proper');
  const without = await buildAtlas('absent');

  // The whole defect in one assertion. Without CBM_INIT the caller's colour
  // table is not an input, so supplying one and omitting one have to give the
  // same bitmap. They did not: omitting it made us adopt the bytes past the
  // header as the palette, which is how Storm's atlas came back inverted.
  check('the colour table does not change an uninitialised DDB',
    withTable && without && withTable.equals(without),
    'CreateDIBitmap(fdwInit=0) is reading bmiColors it must ignore');

  console.log(`\nAtlases written next to ${RAW} — look at one with:`);
  console.log(`  node tools/dump2png.js ${RAW.replace('.bin', '-absent.bin')} ` +
    `--binary --width=320 --bpp=1 --flip --mode=mask --scale=2 --grid=20 --out=/tmp/atlas.png`);
  report();
})().catch(err => { console.error(err); process.exit(1); });

function report() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
