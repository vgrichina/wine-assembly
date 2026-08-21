#!/usr/bin/env node
//
// Font enumeration has to keep answering "what sizes can I have" after the
// guest has actually drawn something, and it has to answer differently for a
// scalable face than for a bitmap one.
//
// The bug this pins down: drawing text in a substituted TrueType face caches a
// rasterized strike (record state 2) under that face's name, and the family
// enumerator counted that cache entry as a prior sighting of the family. The
// cache is never itself enumerated, so this did not de-duplicate anything --
// it deleted the family. WordPad drew its document in Times New Roman, then
// asked EnumFontFamiliesA("Times New Roman") for the sizes to put in its
// toolbar, got no callback at all, and left the size dropdown empty.
//
// The second contract here is the size list itself. GDI reports a family once
// when no family is named, and every font *in* the family when one is: a
// scalable face is one entry the app scales freely, a bitmap face is its
// handful of shipped strikes and nothing between them.
//
//   node test/test-font-enum-sizes.js

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

// Deliberately not the sizes any picker offers -- a strike cached at 12px
// would be indistinguishable from one the stock bootstrap made.
// Faces from the substitution subset the harness mounts; an app that mounts
// more of its own (WordPad ships Georgia, Arial Narrow, the Copperplates)
// exercises the same path through test/test-wordpad-font-size-list.js.
const SCALABLE_USE = [
  { face: 'Times New Roman', px: 13 },
  { face: 'Courier New', px: 31 },
  { face: 'Tahoma', px: 9 },
  { face: 'Symbol', px: 23 },
  { face: 'Wingdings', px: 17 },
];

const BITMAP_FACES = ['Courier', 'MS Sans Serif', 'System', 'Terminal', 'Fixedsys'];

(async () => {
  const { exports: wat, memory } = await bootRenderHarness();
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;

  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const writeAnsi = value => {
    const pointer = allocZero(value.length + 1);
    bytes.set(Buffer.from(value, 'latin1'), wa(pointer));
    return pointer;
  };
  const writeWide = value => {
    const pointer = allocZero((value.length + 1) * 2);
    [...value].forEach((ch, i) => wat.guest_write16(pointer + i * 2, ch.charCodeAt(0)));
    return pointer;
  };
  const readAnsi = (pointer, limit = 64) => {
    let value = '';
    for (let i = 0; i < limit; i++) {
      const byte = bytes[pointer + i];
      if (!byte) break;
      value += String.fromCharCode(byte);
    }
    return value;
  };

  // One 64x64 32bpp surface is enough to make every draw below a real draw.
  const bmi = allocZero(40);
  wat.guest_write32(bmi, 40);
  wat.guest_write32(bmi + 4, 64);
  wat.guest_write32(bmi + 8, -64);
  wat.guest_write16(bmi + 12, 1);
  wat.guest_write16(bmi + 14, 32);
  const bitsOut = allocZero(4);
  const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(bitmap && hdc, 'the harness must give us a drawable DC');
  wat.test_call_SelectObject(hdc, bitmap);

  // enumerate(family) -> [{ face, type, height }], through the same candidate
  // walk EnumFontFamilies drives.
  const lf = allocZero(384);
  const tm = allocZero(128);
  const enumerate = family => {
    const filter = family ? wa(writeAnsi(family)) : 0;
    const rows = [];
    for (let candidate = wat.test_gdi_bitmap_font_enum_next(0, filter, 0) >>> 0;
         candidate;
         candidate = wat.test_gdi_bitmap_font_enum_next(candidate, filter, 0) >>> 0) {
      assert.strictEqual(
        wat.test_gdi_bitmap_font_enum_fill(candidate, wa(lf), wa(tm), 0), 1,
        `candidate ${candidate} must fill a LOGFONT`);
      rows.push({
        face: readAnsi(wa(lf) + 28, 32),
        type: wat.test_gdi_bitmap_font_enum_type(candidate) >>> 0,
        height: view.getUint32(wa(tm), true),
      });
      assert(rows.length < 64, 'enumeration must terminate');
    }
    return rows;
  };

  const failures = [];
  const check = (name, fn) => {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      console.log(`FAIL  ${name}: ${error.message}`);
      failures.push(name);
    }
  };

  const families = enumerate(null).map(row => row.face);
  check('the family list names every face a picker can offer', () => {
    for (const { face } of SCALABLE_USE) {
      assert(families.includes(face), `family list is missing ${face}: ${families.join(', ')}`);
    }
    for (const face of BITMAP_FACES) {
      assert(families.includes(face), `family list is missing ${face}: ${families.join(', ')}`);
    }
    assert.strictEqual(new Set(families).size, families.length,
      `family list repeats a face: ${families.join(', ')}`);
  });

  // Draw in each face at its odd size. Each draw rasterizes and caches a
  // strike under the face's own name -- the state the regression needed.
  const text = writeAnsi('Sphinx of black quartz');
  for (const { face, px } of SCALABLE_USE) {
    const font = wat.test_call_CreateFontW(-px, 400, 0, wa(writeWide(face))) >>> 0;
    assert(font, `CreateFontW must give a handle for ${face}`);
    wat.test_call_SelectObject(hdc, font);
    assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 2, text, 22), 1,
      `TextOutA must draw in ${face}`);
  }

  check('a TrueType family survives being drawn at a non-standard size', () => {
    const after = enumerate(null).map(row => row.face);
    for (const { face, px } of SCALABLE_USE) {
      assert(after.includes(face),
        `${face} vanished from the family list after being drawn at ${px}px`);
    }
    assert.deepStrictEqual(after, families,
      'drawing must not change the family list at all');
  });

  for (const { face, px } of SCALABLE_USE) {
    check(`EnumFontFamilies("${face}") answers after a ${px}px draw`, () => {
      const rows = enumerate(face);
      assert.strictEqual(rows.length, 1,
        `a scalable face is one enumerable font, got ${rows.length}`);
      assert.strictEqual(rows[0].face, face);
      assert.strictEqual(rows[0].type, 4, 'TRUETYPE_FONTTYPE');
    });
  }

  check('a named bitmap family reports its shipped strikes, not one entry', () => {
    const report = [];
    let multi = 0;
    for (const face of BITMAP_FACES) {
      const rows = enumerate(face);
      assert(rows.length >= 1, `${face} must enumerate at least one strike`);
      const heights = rows.map(row => row.height);
      report.push(`${face}: ${heights.join(',')}px`);
      assert(rows.every(row => row.face === face),
        `${face} enumeration leaked another face: ${rows.map(r => r.face).join(', ')}`);
      assert(rows.every(row => row.type === 1),
        `${face} strikes must report RASTER_FONTTYPE`);
      assert.strictEqual(new Set(heights).size, heights.length,
        `${face} repeats a strike height: ${heights.join(',')}`);
      // "Limited" is the whole point: a bitmap face offers the sizes it
      // shipped, a short list, never the open-ended one a scalable face gets.
      assert(rows.length <= 8, `${face} reported ${rows.length} strikes`);
      if (rows.length > 1) multi++;
    }
    console.log(`      ${report.join('  |  ')}`);
    assert(multi > 0,
      'at least one bundled bitmap face ships several strikes and must report them all');
  });

  check('the family list still reports each bitmap family once', () => {
    const rows = enumerate(null).filter(row => BITMAP_FACES.includes(row.face));
    assert.strictEqual(rows.length, BITMAP_FACES.length,
      `family enumeration must collapse strikes: ${rows.map(r => r.face).join(', ')}`);
  });

  if (failures.length) {
    console.log(`\n${failures.length} failing check(s): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('\nAll font enumeration size checks passed');
})();
