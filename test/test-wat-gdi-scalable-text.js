#!/usr/bin/env node

'use strict';

// The seam, end to end: a guest selects a scalable face and draws text, and
// the pixels come out of WAT.
//
// Everything upstream of this was provable in isolation - the parser reads the
// font, the rasterizer produces glyphs, the strike builder installs them. None
// of that mattered while GDI still handed every scalable face to Canvas, and
// nothing failed to say so: text kept appearing, drawn by the host. So the
// load-bearing assertion here is a negative one. gdi_text_mask must not be
// called for a face that has a substitute, and the glyphs must still land.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');
const { fontMounts } = require('../lib/font-substitutions');

const REPO = path.join(__dirname, '..');

(async () => {
  const canvas = { bind: 0, mask: 0, measure: 0, metrics: 0 };
  const { exports: wat, memory, hostCtx } = await bootRenderHarness({
    extraHostOverrides: {
      gdi_text_bind: () => { canvas.bind++; return 1; },
      gdi_text_mask: () => { canvas.mask++; return 0; },
      measure_text: (_hdc, _text, count) => { canvas.measure++; return count * 8; },
      get_text_metrics: () => { canvas.metrics++; return 8 | (8 << 16); },
    },
  });
  // Guest allocation can grow the WASM memory, which detaches any view taken
  // before it. Reading through a stale view returns undefined rather than
  // throwing, so a detached buffer reads as a blank surface - which looks
  // exactly like "the text never drew". Always take a fresh view.
  const mem = () => new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;

  const manifest = JSON.parse(fs.readFileSync(
    path.join(REPO, 'fonts', 'substitutions.json'), 'utf8'));
  hostCtx.vfs.dirs.add('c:\\windows');
  hostCtx.vfs.dirs.add('c:\\windows\\fonts');
  for (const mount of fontMounts(manifest, { subset: true })) {
    hostCtx.vfs.files.set(mount.vfsPath, {
      data: new Uint8Array(fs.readFileSync(path.join(REPO, 'fonts', mount.file))),
      attrs: 0x20,
    });
  }

  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    mem().fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  // Returns the GUEST pointer. The test_call_* wrappers are the guest-facing
  // handlers and take guest pointers; only the raw $tt_* helpers below take
  // translated WASM addresses. Passing one where the other is expected reads
  // unrelated bytes as text, which renders as a row of default characters -
  // convincing-looking output that is not the string you asked for.
  const allocStr = text => {
    const pointer = allocZero(text.length + 1);
    mem().set(Buffer.from(text, 'latin1'), wa(pointer));
    return pointer;
  };
  // CreateFontW takes the face name as UTF-16, the way a guest LOGFONTW does.
  const allocFaceW = text => {
    const pointer = allocZero(text.length * 2 + 2);
    [...text].forEach((ch, i) => wat.guest_write16(pointer + i * 2, ch.charCodeAt(0)));
    return pointer;
  };
  const createFont = (height, weight, italic, face) =>
    wat.test_call_CreateFontW(height, weight, italic, allocFaceW(face)) >>> 0;

  const WIDTH = 160;
  const HEIGHT = 48;
  const createTextDc = () => {
    const bmi = allocZero(40);
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, WIDTH);
    wat.guest_write32(bmi + 8, -HEIGHT);
    wat.guest_write16(bmi + 12, 1);
    wat.guest_write16(bmi + 14, 32);
    const bitsOut = allocZero(4);
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert.ok(bitmap && hdc, 'the test needs a memory DC');
    wat.test_call_SelectObject(hdc, bitmap);
    assert.strictEqual(
      wat.test_call_PatBlt(hdc, 0, 0, WIDTH, HEIGHT, 0x00FF0062), 1,
      'WHITENESS fill must succeed');
    return { hdc, bits: wat.guest_read32(bitsOut) >>> 0 };
  };

  // Pixels are read back with GetPixel rather than by indexing the DIB bits
  // directly: DIB pixels live in the DIB arena, which is outside the g2w
  // window, so a `bits` pointer cannot be translated the way a guest pointer
  // can. Text is drawn in a colour the surface is not pre-filled with, so
  // "inked" is unambiguous.
  // The surface is filled white first and text draws in the default black, so
  // "not white" is unambiguous ink. Black on the zeroed surface a DIB starts
  // with would be invisible, and an invisible glyph is indistinguishable from
  // one that never drew.
  const WHITE = 0xFFFFFF;
  const isInk = (hdc, x, y) => (wat.test_call_GetPixel(hdc, x, y) >>> 0) !== WHITE;

  const inkCount = hdc => {
    let ink = 0;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) if (isInk(hdc, x, y)) ink += 1;
    }
    return ink;
  };

  const inkColumns = hdc => {
    const columns = [];
    for (let x = 0; x < WIDTH; x += 1) {
      for (let y = 0; y < HEIGHT; y += 1) {
        if (isInk(hdc, x, y)) { columns.push(x); break; }
      }
    }
    return columns;
  };

  // ---- a substituted face draws in WAT ----------------------------------

  const { hdc } = createTextDc();
  const font = createFont(-16, 400, 0, 'Arial');
  assert.ok(font, 'CreateFont must produce a WAT font object');
  wat.test_call_SelectObject(hdc, font);

  const strike = wat.test_gdi_bitmap_font_selected(hdc) >>> 0;
  assert.ok(strike,
    'a DC with Arial selected must resolve to a strike, not fall through to Canvas');

  const before = { ...canvas };
  const text = 'Hamburgefonstiv';
  assert.strictEqual(
    wat.test_call_TextOutA(hdc, 4, 4, allocStr(text), text.length), 1,
    'TextOut must succeed');

  assert.strictEqual(canvas.mask, before.mask,
    'Canvas must not be asked for a glyph mask for a face WAT can rasterize');
  assert.strictEqual(canvas.measure, before.measure,
    'Canvas must not be asked to measure a face WAT can measure');

  const ink = inkCount(hdc);
  assert.ok(ink > 40, `text must actually land: only ${ink} pixels drawn`);

  // Legibility, not just presence: distinct letters need gaps between them,
  // and a run that collapsed to one blob would still satisfy an ink count.
  const columns = inkColumns(hdc);
  assert.ok(columns.length > 0, 'no inked columns');
  let gaps = 0;
  for (let i = 1; i < columns.length; i += 1) {
    if (columns[i] - columns[i - 1] > 1) gaps += 1;
  }
  assert.ok(gaps >= 4,
    `letters must be separated: found ${gaps} gaps across ${columns.length} columns`);

  // The drawn run must be about as wide as the face says it is. A strike that
  // laid out at the wrong size still draws legible text - just not the text
  // the guest asked for, which is exactly the bug that survives eyeballing.
  const face = wat.test_tt_face_for_logfont(wa(allocStr('Arial')), 400, 0);
  const ppem = wat.test_tt_face_ppem(face, -16);
  const expected = wat.test_tt_face_text_width(
    face, wa(allocStr(text)), text.length, ppem);
  const drawn = columns[columns.length - 1] - columns[0] + 1;
  assert.ok(Math.abs(drawn - expected) <= 4,
    `drawn run is ${drawn}px but the face measures ${expected}px`);

  // ---- no face falls through to Canvas ----------------------------------
  //
  // Canvas used to be the fallback for faces with no substitute. It is not a
  // fallback any more: a face nothing has a look-alike for still names a file
  // of its own, and a face nobody has ever heard of resolves to the default,
  // so every face a guest can select reaches a strike. That is the property
  // that makes the renderer host-independent — text drawn by the host's own
  // font is text that differs between the browser and this process.

  const other = createTextDc();
  const verdana = createFont(-16, 400, 0, 'Verdana');
  wat.test_call_SelectObject(other.hdc, verdana);
  assert.notStrictEqual(wat.test_gdi_bitmap_font_selected(other.hdc) >>> 0, 0,
    'a face with no look-alike still resolves to a strike');

  const invented = createTextDc();
  wat.test_call_SelectObject(invented.hdc,
    createFont(-16, 400, 0, 'Nonesuch Gothic'));
  assert.notStrictEqual(wat.test_gdi_bitmap_font_selected(invented.hdc) >>> 0, 0,
    'a face nobody has heard of resolves to the default strike');

  const beforeFallback = canvas.mask;
  wat.test_call_TextOutA(other.hdc, 4, 4, allocStr('Verdana'), 7);
  wat.test_call_TextOutA(invented.hdc, 4, 4, allocStr('Nonesuch'), 8);
  assert.strictEqual(canvas.mask, beforeFallback,
    'nothing may reach the Canvas text fallback any more');
  assert.ok(inkCount(other.hdc) > 40, 'the substituted face must still draw');
  assert.ok(inkCount(invented.hdc) > 40, 'the default face must still draw');

  // ---- bold and size are honoured ---------------------------------------

  const boldDc = createTextDc();
  const bold = createFont(-16, 700, 0, 'Arial');
  wat.test_call_SelectObject(boldDc.hdc, bold);
  assert.notStrictEqual(wat.test_gdi_bitmap_font_selected(boldDc.hdc) >>> 0, strike,
    'bold must select a different strike than regular');
  wat.test_call_TextOutA(boldDc.hdc, 4, 4, allocStr(text), text.length);
  assert.ok(inkCount(boldDc.hdc) > ink,
    'bold text must lay down more ink than regular at the same size');

  const bigDc = createTextDc();
  const big = createFont(-28, 400, 0, 'Arial');
  wat.test_call_SelectObject(bigDc.hdc, big);
  wat.test_call_TextOutA(bigDc.hdc, 4, 4, allocStr('Ham'), 3);
  const smallDc = createTextDc();
  const small = createFont(-11, 400, 0, 'Arial');
  wat.test_call_SelectObject(smallDc.hdc, small);
  wat.test_call_TextOutA(smallDc.hdc, 4, 4, allocStr('Ham'), 3);
  assert.ok(inkCount(bigDc.hdc) > inkCount(smallDc.hdc),
    'a larger requested size must draw larger glyphs');

  // ---- GetFontData reads the selected face's sfnt tables -----------------
  //
  // fontview.exe fills the block under its headline — Typeface name, File
  // size, Version, copyright — from the 'name' table, and drops all four
  // lines when the call fails. dwTable carries the tag with its first
  // character in the low byte, the reverse of the file's big-endian order.
  const NAME_TAG = 0x656d616e; // 'n','a','m','e' little-endian
  const nameSize = wat.test_call_GetFontData(hdc, NAME_TAG, 0, 0, 0) >>> 0;
  assert.ok(nameSize > 0 && nameSize !== 0xFFFFFFFF,
    `GetFontData must report the 'name' table size for a scalable face, got ${nameSize}`);

  const nameBuf = allocZero(nameSize);
  assert.strictEqual(wat.test_call_GetFontData(hdc, NAME_TAG, 0, nameBuf, nameSize) >>> 0,
    nameSize, 'GetFontData must copy the whole table when given room for it');
  // A name table opens with format 0 and a record count; the string offset
  // must land inside the table. Checking the shape rather than a byte blob
  // keeps this from breaking when the substitute font is revised.
  const u16 = at => (wat.guest_read32(nameBuf + (at & ~3)) >>> ((at & 2) ? 16 : 0)) & 0xFFFF;
  const be16 = at => ((u16(at) & 0xFF) << 8) | (u16(at) >>> 8);
  assert.strictEqual(be16(0), 0, "'name' table must be format 0");
  const recordCount = be16(2);
  const stringOffset = be16(4);
  assert.ok(recordCount > 0, "'name' table must carry records");
  assert.ok(stringOffset >= 6 + recordCount * 12 && stringOffset < nameSize,
    `'name' string area at ${stringOffset} must sit after ${recordCount} records `
    + `and inside ${nameSize} bytes`);

  // A short buffer truncates rather than overruns, and an absent table is
  // GDI_ERROR — the same contract Win98 offers.
  assert.strictEqual(wat.test_call_GetFontData(hdc, NAME_TAG, 0, nameBuf, 8) >>> 0, 8,
    'GetFontData must copy only what the caller asked for');
  assert.strictEqual(wat.test_call_GetFontData(hdc, 0x5a5a5a5a, 0, 0, 0) >>> 0, 0xFFFFFFFF,
    'a table the font does not have must be GDI_ERROR');
  assert.strictEqual(wat.test_call_GetFontData(hdc, 0, 0, 0, 0) >>> 0 > nameSize, true,
    'dwTable zero must address the whole font file');

  console.log(
    `PASS  scalable text: Arial draws ${ink} pixels of "${text}" in WAT across ` +
    `${drawn}px (face measures ${expected}px), and every face reaches a ` +
    `strike with ${canvas.mask} Canvas mask calls in the whole run`);
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
