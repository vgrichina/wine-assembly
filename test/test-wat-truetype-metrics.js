#!/usr/bin/env node

'use strict';

// Milestone 1 of docs/scalable-font-design.md: WAT reads scalable font metrics
// out of the font file. Ground truth is the vendored font binaries themselves,
// cross-checked against fontTools when these expectations were written, so a
// parser regression cannot be papered over by adjusting the emulator.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const REPO = path.join(__dirname, '..');
const tag = text => ((text.charCodeAt(0) << 24) | (text.charCodeAt(1) << 16) |
  (text.charCodeAt(2) << 8) | text.charCodeAt(3)) >>> 0;

(async () => {
  const { exports: wat, memory } = await bootRenderHarness();
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;

  // The parser takes WASM linear-memory pointers, so the test places whole
  // font files in guest heap and passes their translated addresses.
  const loadFont = relative => {
    const file = fs.readFileSync(path.join(REPO, relative));
    const guest = wat.guest_alloc(file.length) >>> 0;
    assert.ok(guest, `guest_alloc failed for ${relative} (${file.length} bytes)`);
    const at = wa(guest);
    bytes.set(file, at);
    return { at, size: file.length };
  };

  const sans = loadFont('fonts/liberation/LiberationSans-Regular.ttf');
  const marlett = loadFont('fonts/wine/marlett.ttf');

  // ---- format gate ------------------------------------------------------

  assert.strictEqual(wat.test_tt_is_truetype(sans.at, sans.size), 1,
    'Liberation Sans must be recognized as TrueType');
  assert.strictEqual(wat.test_tt_is_truetype(marlett.at, marlett.size), 1,
    'Wine Marlett must be recognized as TrueType');

  // A CFF/OTTO sfnt is refused on purpose: Win98 GDI had no CFF rasterizer,
  // so accepting one here would be less faithful, not more.
  const otto = wat.guest_alloc(16) >>> 0;
  bytes.set([0x4F, 0x54, 0x54, 0x4F, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], wa(otto));
  assert.strictEqual(wat.test_tt_is_truetype(wa(otto), 16), 0,
    'OTTO (CFF) must be refused');

  // Truncation must degrade, never trap.
  assert.strictEqual(wat.test_tt_is_truetype(sans.at, 4), 0);
  assert.strictEqual(wat.test_tt_units_per_em(sans.at, 8), 0);
  assert.strictEqual(wat.test_tt_glyph_index(sans.at, 64, 0x41), 0);
  assert.strictEqual(wat.test_tt_advance_fu(sans.at, 64, 1), 0);

  // ---- table directory --------------------------------------------------

  for (const name of ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'glyf', 'loca']) {
    const offset = wat.test_tt_table_off(sans.at, sans.size, tag(name)) >>> 0;
    const length = wat.test_tt_table_len(sans.at, sans.size, tag(name)) >>> 0;
    assert.ok(offset > 0, `${name} table must be found`);
    assert.ok(length > 0, `${name} table must have a length`);
    assert.ok(offset + length <= sans.size,
      `${name} table must lie inside the file`);
  }
  assert.strictEqual(wat.test_tt_table_off(sans.at, sans.size, tag('CFF ')), 0,
    'a glyf font must not report a CFF table');

  // ---- head / hhea / maxp / OS-2 ---------------------------------------

  assert.strictEqual(wat.test_tt_units_per_em(sans.at, sans.size), 2048);
  assert.strictEqual(wat.test_tt_index_to_loc_format(sans.at, sans.size), 1);
  assert.strictEqual(wat.test_tt_num_glyphs(sans.at, sans.size), 2620);
  assert.strictEqual(wat.test_tt_ascender(sans.at, sans.size), 1854);
  assert.strictEqual(wat.test_tt_descender(sans.at, sans.size), -434,
    'descender is negative and must survive sign extension');
  assert.strictEqual(wat.test_tt_line_gap(sans.at, sans.size), 67);
  assert.strictEqual(wat.test_tt_num_h_metrics(sans.at, sans.size), 2620);
  assert.strictEqual(wat.test_tt_weight_class(sans.at, sans.size), 400);
  assert.strictEqual(wat.test_tt_win_ascent(sans.at, sans.size), 1854);
  assert.strictEqual(wat.test_tt_win_descent(sans.at, sans.size), 434);
  assert.strictEqual(wat.test_tt_x_height(sans.at, sans.size), 1082);
  assert.strictEqual(wat.test_tt_cap_height(sans.at, sans.size), 1409);
  assert.strictEqual(wat.test_tt_is_italic(sans.at, sans.size), 0);

  // ---- cmap + hmtx ------------------------------------------------------
  //
  // Asserting advance-by-character exercises cmap and hmtx together, which is
  // the pairing every text measurement actually depends on. Glyph ids are
  // deliberately not hardcoded: they are an implementation detail of the font.

  const advance = character =>
    wat.test_tt_advance_fu(sans.at, sans.size,
      wat.test_tt_glyph_index(sans.at, sans.size, character.charCodeAt(0)));

  assert.strictEqual(advance('A'), 1366);
  assert.strictEqual(advance('W'), 1933);
  assert.strictEqual(advance('i'), 455);
  assert.strictEqual(advance(' '), 569);
  assert.strictEqual(advance('.'), 569);

  const lsb = character =>
    wat.test_tt_lsb_fu(sans.at, sans.size,
      wat.test_tt_glyph_index(sans.at, sans.size, character.charCodeAt(0)));

  assert.strictEqual(lsb('A'), 4);
  assert.strictEqual(lsb('i'), 137);
  assert.strictEqual(lsb(' '), 0);

  assert.strictEqual(wat.test_tt_glyph_index(sans.at, sans.size, 0x41) > 0, true);
  assert.strictEqual(wat.test_tt_glyph_index(sans.at, sans.size, 0xFFFD), 0,
    'an unmapped codepoint resolves to .notdef');
  assert.strictEqual(wat.test_tt_cmap_is_symbol(sans.at, sans.size), 0);

  // ---- symbol faces -----------------------------------------------------
  //
  // Marlett offers Microsoft Symbol (3,0) and no Unicode BMP subtable, so byte
  // values must resolve through the 0xF000 private-use block.

  assert.strictEqual(wat.test_tt_cmap_is_symbol(marlett.at, marlett.size), 1);
  const marlettA = wat.test_tt_glyph_index(marlett.at, marlett.size, 0x61);
  assert.ok(marlettA > 0, 'Marlett 0x61 must resolve through 0xF061');
  assert.strictEqual(
    wat.test_tt_glyph_index(marlett.at, marlett.size, 0xF061), marlettA,
    'the biased and raw forms must reach the same glyph');

  // ---- scaling ----------------------------------------------------------

  assert.strictEqual(wat.test_tt_scale(2048, 16, 2048), 16, 'one em at 16ppem');
  assert.strictEqual(wat.test_tt_scale(1024, 16, 2048), 8);
  assert.strictEqual(wat.test_tt_scale(0, 16, 2048), 0);
  assert.strictEqual(wat.test_tt_scale(1366, 11, 2048), 7,
    'round-half-up: 1366*11/2048 = 7.34');
  assert.strictEqual(wat.test_tt_scale(-434, 16, 2048), -3,
    'negative font units must scale with signed rounding');
  assert.strictEqual(wat.test_tt_scale(1000, 16, 0), 0,
    'a zero upem must not divide by zero');

  assert.strictEqual(wat.test_tt_char_advance_px(sans.at, sans.size, 0x41, 11), 7);
  assert.strictEqual(wat.test_tt_char_advance_px(sans.at, sans.size, 0x41, 16), 11);

  // ---- string width -----------------------------------------------------
  //
  // Advances accumulate in font units and scale once. Scaling per character
  // would round each advance independently and drift across a long run, which
  // is exactly the class of error that mis-lays-out dialogs.

  const text = 'AWi.';
  const textGuest = wat.guest_alloc(text.length + 1) >>> 0;
  bytes.set(Buffer.from(text, 'latin1'), wa(textGuest));
  bytes[wa(textGuest) + text.length] = 0;

  const units = 1366 + 1933 + 455 + 569;
  for (const ppem of [8, 11, 16, 24, 72]) {
    assert.strictEqual(
      wat.test_tt_text_width_px(sans.at, sans.size, wa(textGuest), text.length, ppem),
      wat.test_tt_scale(units, ppem, 2048),
      `"${text}" at ${ppem}ppem must equal the scaled font-unit sum`);
  }

  const perCharacter = [...text].reduce((total, character) =>
    total + wat.test_tt_char_advance_px(sans.at, sans.size,
      character.charCodeAt(0), 11), 0);
  const once = wat.test_tt_text_width_px(
    sans.at, sans.size, wa(textGuest), text.length, 11);
  assert.notStrictEqual(perCharacter, once,
    'this string is chosen so per-character rounding visibly differs; if this ' +
    'ever matches, pick a string where it does not, or the drift guard is inert');
  // 4323 units at 11ppem is 23.2px scaled once, against 7+10+2+3 = 22px when
  // each advance rounds on its own: a whole pixel lost over four characters.
  assert.strictEqual(once, 23);
  assert.strictEqual(perCharacter, 22);

  assert.strictEqual(
    wat.test_tt_text_width_px(sans.at, sans.size, wa(textGuest), 0, 11), 0,
    'an empty run has zero width');

  console.log('PASS  WAT reads TrueType metrics from Liberation Sans and Wine Marlett');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
