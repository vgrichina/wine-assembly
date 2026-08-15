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

  // ---- CP1252 -----------------------------------------------------------
  //
  // Guest bytes are not codepoints. CP1252 is Latin-1 except for 0x80-0x9F,
  // where Windows puts typographic punctuation, so a byte string measured
  // without the codepage hop silently loses every smart quote and em dash to
  // .notdef — and .notdef's advance is not the quote's advance, so the whole
  // line lays out wrong rather than merely looking wrong.

  assert.strictEqual(wat.test_tt_cp1252_to_unicode(0x41), 0x41, 'ASCII is identity');
  assert.strictEqual(wat.test_tt_cp1252_to_unicode(0xE9), 0xE9, 'Latin-1 is identity');
  assert.strictEqual(wat.test_tt_cp1252_to_unicode(0xFF), 0xFF);
  assert.strictEqual(wat.test_tt_cp1252_to_unicode(0x80), 0x20AC, 'euro');
  assert.strictEqual(wat.test_tt_cp1252_to_unicode(0x91), 0x2018, 'left single quote');
  assert.strictEqual(wat.test_tt_cp1252_to_unicode(0x93), 0x201C, 'left double quote');
  assert.strictEqual(wat.test_tt_cp1252_to_unicode(0x96), 0x2013, 'en dash');
  assert.strictEqual(wat.test_tt_cp1252_to_unicode(0x9F), 0x0178, 'Y diaeresis');
  // Undefined in CP1252; Windows maps them to the C1 control of the same
  // value rather than failing the conversion.
  for (const undefinedByte of [0x81, 0x8D, 0x8F, 0x90, 0x9D]) {
    assert.strictEqual(wat.test_tt_cp1252_to_unicode(undefinedByte), undefinedByte,
      `0x${undefinedByte.toString(16)} is undefined in CP1252 and stays itself`);
  }

  const euroGid = wat.test_tt_glyph_index(sans.at, sans.size, 0x20AC);
  assert.ok(euroGid > 0, 'Liberation Sans has a euro glyph');
  assert.strictEqual(wat.test_tt_glyph_index(sans.at, sans.size, 0x80), 0,
    'U+0080 is a C1 control and is not in the cmap: the raw byte finds nothing');
  assert.strictEqual(wat.test_tt_ansi_glyph_index(sans.at, sans.size, 0x80), euroGid,
    'the ANSI byte 0x80 must reach the euro through CP1252');
  assert.strictEqual(wat.test_tt_advance_fu(sans.at, sans.size, euroGid), 1139);
  assert.strictEqual(
    wat.test_tt_ansi_glyph_index(sans.at, sans.size, 0xE9),
    wat.test_tt_glyph_index(sans.at, sans.size, 0xE9),
    'Latin-1 bytes take the same path either way');

  // A symbol face must not take the codepage hop: 0x93 is a Marlett glyph
  // address, not a left double quote.
  assert.strictEqual(
    wat.test_tt_ansi_glyph_index(marlett.at, marlett.size, 0x61), marlettA,
    'symbol faces address glyphs by raw byte through 0xF000');

  // String width goes through the same mapping, so punctuation measures as
  // itself rather than as .notdef.
  const quoted = '\x93hi\x94';
  const quotedGuest = wat.guest_alloc(quoted.length) >>> 0;
  bytes.set(Buffer.from(quoted, 'latin1'), wa(quotedGuest));
  const quotedUnits = 682 + 1139 + 455 + 682;  // ldquo + h + i + rdquo
  assert.strictEqual(
    wat.test_tt_text_width_px(sans.at, sans.size, wa(quotedGuest), quoted.length, 16),
    wat.test_tt_scale(quotedUnits, 16, 2048),
    'smart quotes must measure as quotes');
  assert.strictEqual(wat.test_tt_ansi_advance_px(sans.at, sans.size, 0x80, 16),
    wat.test_tt_scale(1139, 16, 2048));

  // ---- TEXTMETRIC -------------------------------------------------------
  //
  // Every expectation below is arithmetic over table values this test already
  // asserted, so a change to the parser cannot move both sides at once.

  const mono = loadFont('fonts/liberation/LiberationMono-Regular.ttf');
  const serif = loadFont('fonts/liberation/LiberationSerif-Regular.ttf');

  // lfHeight is signed with two meanings and this is the distinction most
  // often collapsed: negative is the em size (ppem directly), positive is the
  // cell height, which is taller, so it maps to a *smaller* ppem.
  assert.strictEqual(wat.test_tt_ppem_from_lfheight(sans.at, sans.size, -16), 16,
    'a negative lfHeight is the em size in pixels');
  assert.strictEqual(wat.test_tt_ppem_from_lfheight(sans.at, sans.size, 16), 14,
    'a positive lfHeight is the cell height: 16*2048/(1854+434) = 14.32');
  assert.strictEqual(wat.test_tt_ppem_from_lfheight(sans.at, sans.size, 0), 12,
    'lfHeight 0 means "any", and the Win98 shell default is 12');
  assert.ok(wat.test_tt_ppem_from_lfheight(sans.at, sans.size, 1) >= 1,
    'a tiny cell height must never round down to a zero ppem');

  assert.strictEqual(wat.test_tt_tm_ascent(sans.at, sans.size, 16), 14,
    'usWinAscent 1854 at 16ppem');
  assert.strictEqual(wat.test_tt_tm_descent(sans.at, sans.size, 16), 3);
  assert.strictEqual(wat.test_tt_tm_height(sans.at, sans.size, 16), 17);
  assert.strictEqual(wat.test_tt_tm_internal_leading(sans.at, sans.size, 16), 1,
    'internal leading is cell height less em size');
  // lineGap 67 survives because Liberation Sans sizes its usWin cell exactly
  // to the hhea one, so the gap is not already spent.
  assert.strictEqual(wat.test_tt_tm_external_leading(sans.at, sans.size, 16), 1);
  assert.strictEqual(wat.test_tt_tm_external_leading(mono.at, mono.size, 16), 0,
    'Liberation Mono has lineGap 0 and must not invent leading');
  assert.strictEqual(wat.test_tt_tm_ave_char_width(sans.at, sans.size, 16), 9,
    'OS/2 xAvgCharWidth 1187 at 16ppem');
  assert.strictEqual(wat.test_tt_tm_max_char_width(sans.at, sans.size, 16), 21,
    'hhea advanceWidthMax 2740 at 16ppem');
  assert.strictEqual(wat.test_tt_tm_weight(sans.at, sans.size), 400);
  assert.strictEqual(wat.test_tt_tm_first_char(sans.at, sans.size), 0x20);
  assert.strictEqual(wat.test_tt_tm_last_char(sans.at, sans.size), 0xFFFC);
  assert.strictEqual(wat.test_tt_tm_first_char(marlett.at, marlett.size), 0xF020,
    'a symbol face reports its private-use range');

  // Pitch and family. Bit 0 set means VARIABLE pitch, which reads backwards
  // from its TMPF_FIXED_PITCH name; a monospaced face therefore clears it.
  assert.strictEqual(wat.test_tt_is_fixed_pitch(mono.at, mono.size), 1);
  assert.strictEqual(wat.test_tt_is_fixed_pitch(sans.at, sans.size), 0);
  assert.strictEqual(wat.test_tt_tm_pitch_and_family(sans.at, sans.size), 0x27,
    'variable pitch | vector | truetype | FF_SWISS');
  assert.strictEqual(wat.test_tt_tm_pitch_and_family(serif.at, serif.size), 0x17,
    'PANOSE serif style 2 makes Liberation Serif FF_ROMAN');
  assert.strictEqual(wat.test_tt_tm_pitch_and_family(mono.at, mono.size), 0x36,
    'fixed pitch clears bit 0 and forces FF_MODERN');

  // Metrics must degrade rather than trap on a truncated file, the same way
  // the table readers do.
  assert.strictEqual(wat.test_tt_tm_height(sans.at, 64, 16), 0);
  assert.strictEqual(wat.test_tt_tm_ave_char_width(sans.at, 64, 16), 0);
  assert.strictEqual(wat.test_tt_tm_weight(sans.at, 64), 400,
    'an unreadable weight falls back to NORMAL rather than to zero');
  assert.strictEqual(wat.test_tt_ppem_from_lfheight(sans.at, 64, 16), 16,
    'with no OS/2 cell to invert, a positive lfHeight passes through');

  console.log('PASS  WAT reads TrueType metrics from Liberation Sans and Wine Marlett');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
