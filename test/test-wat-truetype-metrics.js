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

  // ---- loca / glyf ------------------------------------------------------
  //
  // Liberation Sans uses long loca and Wine Tahoma uses short, so both
  // formats are exercised; short loca stores half the real offset, and
  // forgetting the doubling reads every glyph from the wrong place.

  const tahoma = loadFont('fonts/wine/tahoma.ttf');
  assert.strictEqual(wat.test_tt_index_to_loc_format(tahoma.at, tahoma.size), 0,
    'Wine Tahoma is the short-loca case this test exists to cover');

  const gid = (font, character) =>
    wat.test_tt_glyph_index(font.at, font.size, character.charCodeAt(0));
  const glyf = (font, character) => ({
    contours: wat.test_tt_glyph_num_contours(font.at, font.size, gid(font, character)),
    composite: wat.test_tt_glyph_is_composite(font.at, font.size, gid(font, character)),
    xMin: wat.test_tt_glyph_x_min(font.at, font.size, gid(font, character)),
    yMin: wat.test_tt_glyph_y_min(font.at, font.size, gid(font, character)),
    xMax: wat.test_tt_glyph_x_max(font.at, font.size, gid(font, character)),
    yMax: wat.test_tt_glyph_y_max(font.at, font.size, gid(font, character)),
  });

  assert.deepStrictEqual(glyf(sans, 'A'),
    { contours: 2, composite: 0, xMin: 4, yMin: 0, xMax: 1362, yMax: 1409 });
  assert.deepStrictEqual(glyf(sans, 'j'),
    { contours: 2, composite: 0, xMin: -50, yMin: -425, xMax: 317, yMax: 1484 });
  assert.deepStrictEqual(glyf(tahoma, 'A'),
    { contours: 2, composite: 0, xMin: -10, yMin: 0, xMax: 1238, yMax: 1493 },
    'short loca must resolve to the same glyph a long one would');

  // A composite glyph still carries its own bounding box, so nothing above
  // has to recurse into the components to size or place it.
  assert.deepStrictEqual(glyf(sans, 'Á'),
    { contours: -1, composite: 1, xMin: 4, yMin: 0, xMax: 1362, yMax: 1776 },
    'A-acute is a composite and reports a negative contour count');

  // An empty glyph is normal data, not a damaged file: space has no outline
  // and still has an advance.
  assert.strictEqual(wat.test_tt_glyph_offset(sans.at, sans.size, gid(sans, ' ')), 0,
    'space has no glyf record');
  assert.strictEqual(wat.test_tt_glyph_length(sans.at, sans.size, gid(sans, ' ')), 0);
  assert.strictEqual(wat.test_tt_glyph_num_contours(sans.at, sans.size, gid(sans, ' ')), 0);
  assert.ok(wat.test_tt_glyph_length(sans.at, sans.size, gid(sans, 'A')) > 0,
    'a drawn glyph must have a non-empty record');
  assert.strictEqual(wat.test_tt_glyph_offset(sans.at, sans.size, 0xFFFF), 0,
    'a glyph id past numGlyphs must not read out of the table');
  assert.strictEqual(wat.test_tt_glyph_offset(sans.at, 64, 1), 0,
    'a truncated file has no glyph records');

  // ---- outline points ---------------------------------------------------
  //
  // Points are stored as flags with a repeat byte, then all x deltas, then
  // all y deltas, and the arrays can only be located in that order. The
  // fixtures below came from fontTools reading the same files.

  const POINTS = wat.guest_alloc(64 * 6) >>> 0;
  const readPoints = (font, character) => {
    const count = wat.test_tt_glyph_load_points(
      font.at, font.size, gid(font, character), wa(POINTS), 64);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      out.push([
        wat.test_tt_point_x(wa(POINTS), i),
        wat.test_tt_point_y(wa(POINTS), i),
        wat.test_tt_point_on_curve(wa(POINTS), i),
        wat.test_tt_point_ends_contour(wa(POINTS), i),
      ]);
    }
    return out;
  };

  // A box: four on-curve points, one contour, and every delta short.
  assert.deepStrictEqual(readPoints(sans, '.'), [
    [187, 0, 1, 0], [187, 219, 1, 0], [382, 219, 1, 0], [382, 0, 1, 1],
  ]);

  // Two contours: the end marker must land on the last point of each, not
  // only on the last point of the glyph.
  assert.deepStrictEqual(readPoints(sans, 'i'), [
    [137, 1312, 1, 0], [137, 1484, 1, 0], [317, 1484, 1, 0], [317, 1312, 1, 1],
    [137, 0, 1, 0], [137, 1082, 1, 0], [317, 1082, 1, 0], [317, 0, 1, 1],
  ]);

  // A curved glyph, where most points are off-curve control points. A decoder
  // that ignores the on-curve bit still produces plausible coordinates and a
  // completely wrong shape, so the bit is asserted per point.
  assert.deepStrictEqual(readPoints(sans, 'o'), [
    [1053, 542, 1, 0], [1053, 258, 0, 0], [803, -20, 0, 0], [565, -20, 1, 0],
    [328, -20, 0, 0], [86, 269, 0, 0], [86, 542, 1, 0], [86, 1102, 0, 0],
    [571, 1102, 1, 0], [819, 1102, 0, 0], [1053, 829, 0, 1],
    [864, 542, 1, 0], [864, 766, 0, 0], [731, 969, 0, 0], [574, 969, 1, 0],
    [416, 969, 0, 0], [275, 762, 0, 0], [275, 542, 1, 0], [275, 328, 0, 0],
    [414, 113, 0, 0], [563, 113, 1, 0], [725, 113, 0, 0], [864, 321, 0, 1],
  ]);

  // The decoded points must span exactly the bounding box the glyph header
  // declares. This is the check that catches a delta accumulated with the
  // wrong sign or an x array measured wrong: the coordinates stay plausible
  // and the extents stop matching.
  for (const character of ['.', 'i', 'o', 'A', 'j']) {
    const points = readPoints(sans, character);
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    assert.strictEqual(Math.min(...xs), glyf(sans, character).xMin,
      `"${character}" xMin from points must match the glyph header`);
    assert.strictEqual(Math.max(...xs), glyf(sans, character).xMax);
    assert.strictEqual(Math.min(...ys), glyf(sans, character).yMin);
    assert.strictEqual(Math.max(...ys), glyf(sans, character).yMax);
    assert.strictEqual(points.filter(point => point[3]).length,
      glyf(sans, character).contours,
      `"${character}" must end exactly as many contours as it has`);
  }

  assert.strictEqual(
    wat.test_tt_glyph_point_count(sans.at, sans.size, gid(sans, 'o')), 23);
  assert.strictEqual(readPoints(tahoma, 'A').length,
    wat.test_tt_glyph_point_count(tahoma.at, tahoma.size, gid(tahoma, 'A')),
    'short-loca glyphs decode through the same path');

  // Composites hold components, not points; the caller has to recurse, and a
  // silent empty result would look like a blank glyph instead.
  assert.strictEqual(
    wat.test_tt_glyph_load_points(sans.at, sans.size, gid(sans, 'Á'),
      wa(POINTS), 64), 0, 'a composite yields no points of its own');
  assert.strictEqual(
    wat.test_tt_glyph_load_points(sans.at, sans.size, gid(sans, ' '),
      wa(POINTS), 64), 0, 'an empty glyph yields no points');
  assert.strictEqual(
    wat.test_tt_glyph_load_points(sans.at, sans.size, gid(sans, 'o'),
      wa(POINTS), 22), 0,
    'a buffer one point short must refuse, not overrun');
  assert.strictEqual(
    wat.test_tt_glyph_load_points(sans.at, 64, 1, wa(POINTS), 64), 0,
    'a truncated file yields no points');

  // ---- composite glyphs -------------------------------------------------
  //
  // 'Á' is 'A' at the origin plus an acute shifted 475 units right. Treating
  // a composite as an empty glyph renders every accented character as a
  // blank, so this is not an exotic path for a Western corpus.

  const readOutline = (font, character) => {
    const count = wat.test_tt_glyph_load_outline(
      font.at, font.size, gid(font, character), wa(POINTS), 64);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      out.push([
        wat.test_tt_point_x(wa(POINTS), i),
        wat.test_tt_point_y(wa(POINTS), i),
        wat.test_tt_point_on_curve(wa(POINTS), i),
        wat.test_tt_point_ends_contour(wa(POINTS), i),
      ]);
    }
    return out;
  };

  // A simple glyph must come back identically through the outline entry
  // point, or callers would need to know which kind they hold.
  assert.deepStrictEqual(readOutline(sans, 'o'), readPoints(sans, 'o'));

  const aAcute = readOutline(sans, 'Á');
  assert.strictEqual(aAcute.length, 23);
  assert.deepStrictEqual(aAcute.map(point => point[3]), [
    0, 0, 0, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 1,
  ], 'each component keeps its own contour ends after placement');
  assert.deepStrictEqual(aAcute, [
    [1167, 0, 1, 0], [1006, 412, 1, 0], [364, 412, 1, 0], [202, 0, 1, 0],
    [4, 0, 1, 0], [579, 1409, 1, 0], [796, 1409, 1, 0], [1362, 0, 1, 1],
    [685, 1265, 1, 0], [676, 1237, 1, 0], [651, 1154, 0, 0], [602, 1024, 1, 0],
    [422, 561, 1, 0], [949, 561, 1, 0], [768, 1026, 1, 0], [740, 1095, 0, 0],
    [712, 1182, 1, 1],
    [547, 1530, 1, 0], [547, 1550, 1, 0], [764, 1776, 1, 0], [971, 1776, 1, 0],
    [971, 1747, 1, 0], [661, 1530, 1, 1],
  ], 'the acute must land 475 units right of its own origin');

  // The composite's assembled extents must match the bounding box its header
  // declares, which is the check that catches an offset applied in the wrong
  // direction or dropped entirely.
  const box = glyf(sans, 'Á');
  assert.strictEqual(Math.min(...aAcute.map(point => point[0])), box.xMin);
  assert.strictEqual(Math.max(...aAcute.map(point => point[0])), box.xMax);
  assert.strictEqual(Math.min(...aAcute.map(point => point[1])), box.yMin);
  assert.strictEqual(Math.max(...aAcute.map(point => point[1])), box.yMax);

  for (const character of ['é', 'Ä', 'ü']) {
    const points = readOutline(sans, character);
    const bounds = glyf(sans, character);
    assert.ok(points.length > 0, `"${character}" must decompose to points`);
    assert.strictEqual(Math.min(...points.map(point => point[0])), bounds.xMin,
      `"${character}" assembled extents must match its declared box`);
    assert.strictEqual(Math.max(...points.map(point => point[1])), bounds.yMax);
  }

  // Half a composite is worse than none: with room for the acute but not the
  // 'A', a partial result is indistinguishable from a real glyph, so the
  // whole thing is refused.
  assert.strictEqual(
    wat.test_tt_glyph_load_outline(sans.at, sans.size, gid(sans, 'Á'),
      wa(POINTS), 16), 0);
  assert.strictEqual(
    wat.test_tt_glyph_load_outline(sans.at, sans.size, gid(sans, 'Á'),
      wa(POINTS), 23), 23, 'exactly enough room still succeeds');
  assert.strictEqual(
    wat.test_tt_glyph_load_outline(sans.at, 64, 1, wa(POINTS), 64), 0);

  // ---- ABC widths -------------------------------------------------------
  //
  // A and C are signed and routinely negative: 'j' overhangs to its left and
  // Tahoma's 'A' overhangs on both sides. Clamping either to zero is what
  // clips the overhanging edge of a glyph, so the negatives are the point.

  const abc = (font, character) => [
    wat.test_tt_abc_a_fu(font.at, font.size, gid(font, character)),
    wat.test_tt_abc_b_fu(font.at, font.size, gid(font, character)),
    wat.test_tt_abc_c_fu(font.at, font.size, gid(font, character)),
  ];

  assert.deepStrictEqual(abc(sans, 'A'), [4, 1358, 4]);
  assert.deepStrictEqual(abc(sans, 'j'), [-50, 367, 138],
    'j hangs left of its origin, so A is negative');
  assert.deepStrictEqual(abc(tahoma, 'A'), [-10, 1248, -9],
    'Tahoma A overhangs on both sides, so A and C are both negative');
  assert.deepStrictEqual(abc(sans, ' '), [0, 0, 569],
    'an empty glyph has no black box, so the advance is all bearing');

  for (const character of ['A', 'j', ' ', 'Á']) {
    const [a, b, c] = abc(sans, character);
    assert.strictEqual(a + b + c,
      wat.test_tt_advance_fu(sans.at, sans.size, gid(sans, character)),
      `ABC must sum to the advance for "${character}"`);
  }

  // ---- kern -------------------------------------------------------------
  //
  // GetKerningPairs reads the legacy `kern` table, not GPOS: Win98 GDI had no
  // OpenType layout engine, so a face that kerns only through GPOS kerns
  // nothing on Win98, and reading GPOS here would render text the guest could
  // never have produced.

  const kern = (font, left, right, ppem) => ppem === undefined
    ? wat.test_tt_kern_pair_fu(font.at, font.size, gid(font, left), gid(font, right))
    : wat.test_tt_kern_pair_px(font.at, font.size,
        gid(font, left), gid(font, right), ppem);

  assert.strictEqual(kern(sans, 'A', 'V'), -152);
  assert.strictEqual(kern(sans, 'T', 'o'), -227);
  assert.strictEqual(kern(sans, ' ', 'A'), -113);
  assert.strictEqual(kern(sans, 'A', 'A'), 0, 'an absent pair kerns zero');
  assert.strictEqual(kern(sans, 'A', 'V', 16), wat.test_tt_scale(-152, 16, 2048));
  assert.strictEqual(kern(sans, 'A', 'V', 16), -1);

  // Tahoma's kerning lives in GPOS only, which is precisely the case that
  // must report nothing rather than quietly reaching for the modern table.
  assert.strictEqual(wat.test_tt_table_off(tahoma.at, tahoma.size, tag('kern')), 0);
  assert.strictEqual(kern(tahoma, 'A', 'V'), 0);
  assert.strictEqual(wat.test_tt_kern_pair_fu(sans.at, 64, 1, 2), 0,
    'a truncated file kerns nothing instead of trapping');

  console.log('PASS  WAT reads TrueType metrics from Liberation Sans and Wine Marlett');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
