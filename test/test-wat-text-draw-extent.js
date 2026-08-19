#!/usr/bin/env node

'use strict';

// What we draw has to be as wide as what we said we would draw.
//
// A guest lays a dialog out by asking GetTextExtentPoint32 how wide a string
// is, and then draws that string. Those are two different code paths through
// our GDI, and until they were tied together they answered differently: the
// extent came from summed whole-pixel advances, while the drawing asked Canvas
// to lay the whole string out, which kerns and accumulates fractions. Text
// that measures wider than it draws leaves a gap; text that draws wider than it
// measures runs into the control beside it, and neither shows up in a test
// that only asks whether the text appeared.
//
// So: draw the string, find the leftmost and rightmost inked pixel, and hold
// that run against the extent the same DC reports. Both kinds of face are
// covered, because they take different paths — a substituted face rasterizes
// in WAT, an unsubstituted one still falls back to Canvas.
//
// The unsubstituted face is the one doing the work here. Fixing the measuring
// side alone passes every other font test in the suite and still leaves this
// failing by 10px, because Canvas would go on drawing a kerned, fractionally
// spaced run underneath the whole-pixel advances WAT now measures.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');
const { fontMounts } = require('../lib/font-substitutions');

const REPO = path.join(__dirname, '..');

// Long enough that a per-character rounding error accumulates into something
// a single-word string would hide.
const TEXT = 'The quick brown fox jumps over the lazy dog';

(async () => {
  const { exports: wat, memory, hostCtx } = await bootRenderHarness();
  const mem = () => new Uint8Array(memory.buffer);
  const view = () => new DataView(memory.buffer);
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
  const allocStr = text => {
    const pointer = allocZero(text.length + 1);
    mem().set(Buffer.from(text, 'latin1'), wa(pointer));
    return pointer;
  };
  const allocFaceW = text => {
    const pointer = allocZero(text.length * 2 + 2);
    [...text].forEach((ch, i) => wat.guest_write16(pointer + i * 2, ch.charCodeAt(0)));
    return pointer;
  };

  // Wide enough that the longest string at the largest size still fits: a run
  // clipped by the surface would read as text drawn too narrow.
  const WIDTH = 720;
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
    return hdc;
  };

  const WHITE = 0xFFFFFF;
  const inkedRun = hdc => {
    let first = -1;
    let last = -1;
    for (let x = 0; x < WIDTH; x += 1) {
      for (let y = 0; y < HEIGHT; y += 1) {
        if ((wat.test_call_GetPixel(hdc, x, y) >>> 0) !== WHITE) {
          if (first < 0) first = x;
          last = x;
          break;
        }
      }
    }
    return { first, last };
  };

  const size = allocZero(8);
  const text = allocStr(TEXT);
  const failures = [];

  for (const face of ['Arial', 'Times New Roman', 'Courier New', 'Verdana']) {
    for (const height of [-11, -16, -24]) {
      const hdc = createTextDc();
      const font = wat.test_call_CreateFontW(height, 400, 0, allocFaceW(face)) >>> 0;
      assert.ok(font, `CreateFontW must produce a font for ${face}`);
      wat.test_call_SelectObject(hdc, font);

      assert.strictEqual(
        wat.test_call_GetTextExtentPoint32A(hdc, text, TEXT.length, size), 1,
        `GetTextExtentPoint32A must succeed for ${face} ${height}`);
      const extent = view().getInt32(wa(size), true);

      const x = 4;
      wat.test_call_TextOutA(hdc, x, 4, text, TEXT.length);
      const { first, last } = inkedRun(hdc);
      assert.ok(first >= 0, `${face} ${height}: nothing was drawn`);

      // The run is measured from the origin the guest gave, not from the first
      // inked column: the leading 'T' may start a pixel in, and that bearing is
      // part of the advance the extent already counted.
      const drawn = last - x + 1;
      // A glyph is allowed to overhang its own advance by a little - italic and
      // script faces do it by design - but the run must not systematically
      // outgrow or fall short of the extent, which is what a per-character
      // rounding disagreement produces.
      if (Math.abs(drawn - extent) > 3) {
        failures.push(`${face} ${height}px: drew ${drawn}px, measured ${extent}px`);
      }
      console.log(`  ${face.padEnd(16)} ${String(height).padStart(3)}px  `
        + `measured ${String(extent).padStart(4)}px  drew ${String(drawn).padStart(4)}px`);
    }
  }

  if (failures.length) {
    console.log('\ndrawn text does not match its own measurement:');
    for (const line of failures) console.log(`  ${line}`);
    console.log('\nFAIL  text is drawn at a width its DC did not report');
    process.exit(1);
  }
  console.log('\nPASS  every string drew within 3px of the extent its own DC reported');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
