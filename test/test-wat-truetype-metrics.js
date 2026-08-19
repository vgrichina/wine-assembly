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
  const { exports: wat, memory, hostCtx } = await bootRenderHarness();
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

  // ---- flattening -------------------------------------------------------
  //
  // Contours become straight edges in 26.6 fixed point. Horizontal edges are
  // dropped: scan conversion crosses edges against horizontal sample lines,
  // and an edge parallel to those lines has no crossing to contribute.

  assert.strictEqual(wat.test_tt_fu_to_26_6(2048, 16, 2048), 1024,
    'one em at 16ppem is 16 pixels, which is 1024 in 26.6');
  assert.strictEqual(wat.test_tt_fu_to_26_6(1024, 16, 2048), 512);
  assert.strictEqual(wat.test_tt_fu_to_26_6(-434, 16, 2048), -217,
    'negative coordinates keep signed rounding');
  assert.strictEqual(wat.test_tt_fu_to_26_6(100, 16, 0), 0);

  const EDGES = wat.guest_alloc(512 * 16) >>> 0;
  const readEdges = (font, character, ppem, capacity = 512) => {
    const count = wat.test_tt_glyph_edges(font.at, font.size,
      gid(font, character), ppem, wa(POINTS), 64, wa(EDGES), capacity);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      out.push([0, 1, 2, 3].map(field =>
        wat.test_tt_edge_field(wa(EDGES), i, field)));
    }
    return out;
  };

  // A rectangle has four sides and exactly two of them can be crossed.
  assert.deepStrictEqual(readEdges(sans, '.', 16), [
    [94, 0, 94, 110],
    [191, 110, 191, 0],
  ], 'the two horizontal sides of the period contribute no crossings');

  assert.strictEqual(readEdges(sans, 'i', 16).length, 4,
    'two rectangles give two crossable sides each');

  for (const edge of readEdges(sans, 'o', 16)) {
    assert.notStrictEqual(edge[1], edge[3], 'no horizontal edge may survive');
  }

  // The flattened outline must reach exactly the glyph's own bounding box.
  // Curves stay inside the hull of their control points, so falling short
  // means subdivision dropped an extreme and overshooting means a control
  // point leaked into the output as if it were on the curve.
  const oEdges = readEdges(sans, 'o', 16);
  assert.ok(oEdges.length > 20, 'a curved glyph flattens to many edges');
  const oBox = glyf(sans, 'o');
  const xs = oEdges.flatMap(edge => [edge[0], edge[2]]);
  const ys = oEdges.flatMap(edge => [edge[1], edge[3]]);
  const to266 = value => wat.test_tt_fu_to_26_6(value, 16, 2048);
  assert.strictEqual(Math.min(...xs), to266(oBox.xMin));
  assert.strictEqual(Math.max(...xs), to266(oBox.xMax));
  assert.strictEqual(Math.min(...ys), to266(oBox.yMin));
  assert.strictEqual(Math.max(...ys), to266(oBox.yMax));

  // Larger text gets more segments per curve, which is the whole point of
  // sizing subdivision from the control polygon.
  assert.ok(readEdges(sans, 'o', 64).length > oEdges.length,
    'a bigger ppem must subdivide more finely');

  // Composites flatten through the same path, so accented glyphs are not a
  // separate case for anything downstream.
  assert.ok(readEdges(sans, 'Á', 16).length > 0);

  assert.strictEqual(
    wat.test_tt_glyph_edges(sans.at, sans.size, gid(sans, ' '), 16,
      wa(POINTS), 64, wa(EDGES), 512), 0, 'an empty glyph has no edges');
  assert.strictEqual(readEdges(sans, 'o', 16, 4).length, 0,
    'a truncated edge list must report nothing rather than a partial outline');

  // ---- scan conversion --------------------------------------------------
  //
  // The bitmap uses the same column-major addressing the FNT accessor reads:
  // byte (x >> 3) * height + y, bit 0x80 >> (x & 7). Matching that is what
  // makes a rasterized glyph indistinguishable from a strike glyph to
  // everything above, so the layout is asserted directly against the raw
  // bytes rather than only through the reader.

  const BITMAP = wat.guest_alloc(4096) >>> 0;
  const SCRATCH_BYTES = wat.test_tt_raster_scratch_bytes(64) >>> 0;
  const SCRATCH = wat.guest_alloc(SCRATCH_BYTES) >>> 0;

  const raster = (font, character, ppem) => {
    const g = gid(font, character);
    const width = wat.test_tt_glyph_box_width(font.at, font.size, g, ppem);
    const height = wat.test_tt_glyph_box_height(font.at, font.size, g, ppem);
    const ok = wat.test_tt_rasterize_glyph(font.at, font.size, g, ppem,
      wa(BITMAP), width, height,
      wat.test_tt_glyph_box_left(font.at, font.size, g, ppem) * 64,
      wat.test_tt_glyph_box_top(font.at, font.size, g, ppem) * 64,
      wa(SCRATCH), SCRATCH_BYTES);
    assert.strictEqual(ok, 1, `rasterizing "${character}" at ${ppem} must succeed`);
    const rows = [];
    for (let y = 0; y < height; y += 1) {
      let row = '';
      for (let x = 0; x < width; x += 1) {
        row += wat.test_tt_bitmap_pixel(wa(BITMAP), height, x, y) ? '#' : '.';
      }
      rows.push(row);
    }
    return { width, height, rows };
  };

  // The period is a rectangle from x 1.46 to 2.98 and y 0 to 1.71 pixels at
  // 16ppem, so it lands in a 2x2 cell. Its top-left pixel is only 54% covered
  // horizontally and 75% vertically — 40% of the pixel, under the threshold —
  // while the other three clear it. Every one of those numbers moves if the
  // box, the sampling, or the threshold is wrong, which is why the exact
  // pattern is asserted rather than just the ink count.
  assert.deepStrictEqual(raster(sans, '.', 16), {
    width: 2, height: 2, rows: ['.#', '##'],
  });

  // A golden bitmap. Nonzero winding is tested here where it actually
  // differs from even-odd: the counter is hollow because the inner contour
  // runs the other way, not because it is the second contour. The bottom row
  // is blank because the overshoot below the baseline is 0.23 of a pixel and
  // does not reach the threshold, and the box is cut from the outline's own
  // bounds rather than from what happens to be inked.
  //
  // Changing the fill rule, the sub-row count, or the threshold is expected
  // to change this picture; it should be updated deliberately and looked at,
  // which is the point of keeping it readable.
  const o24 = raster(sans, 'o', 24);
  assert.deepStrictEqual(o24, {
    width: 12,
    height: 14,
    rows: [
      '...#####....',
      '..########..',
      '.##.....##..',
      '.##......##.',
      '##.......##.',
      '##.......##.',
      '##.......##.',
      '##.......##.',
      '##.......##.',
      '###......##.',
      '.##.....###.',
      '.####.####..',
      '...######...',
      '............',
    ],
  });
  const middleRow = o24.rows[Math.floor(o24.height / 2)];
  assert.strictEqual(middleRow[Math.floor(o24.width / 2)], '.',
    'the counter of an o must be empty');
  assert.strictEqual(middleRow[0], '#', 'the left stem of an o must be ink');

  // 'i' is a dot and a stem with a gap between them, so some row must be
  // completely empty. A rasterizer that filled between contours would lose
  // that gap and the letter would read as an 'l'.
  const i16 = raster(sans, 'i', 16);
  const inked = i16.rows.map(row => row.includes('#'));
  assert.ok(inked.indexOf(true) < inked.lastIndexOf(true),
    'the i must have ink at both ends');
  assert.ok(inked.slice(inked.indexOf(true), inked.lastIndexOf(true)).includes(false),
    'and a blank row between the dot and the stem');
  assert.strictEqual(i16.rows[i16.height - 1].includes('#'), true,
    'the stem reaches the baseline');

  // Composites rasterize through the same path; the acute must sit above the
  // 'A' with clear space between them.
  const aAcute16 = raster(sans, 'Á', 16);
  const accentInked = aAcute16.rows.map(row => row.includes('#'));
  assert.ok(
    accentInked.slice(accentInked.indexOf(true),
      accentInked.lastIndexOf(true)).includes(false),
    'the accent must not fuse into the letter');
  assert.ok(aAcute16.height > raster(sans, 'A', 16).height,
    'the accent must make the box taller than the bare letter');

  // Raw layout check, independent of the reader.
  const rawBytes = new Uint8Array(memory.buffer, wa(BITMAP), 64);
  const period = raster(sans, '.', 16);
  assert.strictEqual(period.height, 2);
  assert.strictEqual(rawBytes[0] & 0x80, 0, 'pixel (0,0) is the top bit of byte 0');
  assert.strictEqual(rawBytes[0] & 0x40, 0x40, 'pixel (1,0) is the next bit down');
  assert.strictEqual(rawBytes[1] & 0xC0, 0xC0, 'row 1 lives in byte 1');

  // Ink must grow with size rather than merely scaling in place, and a large
  // glyph must still fit the box its own bounds predict.
  const countInk = image => image.rows.join('').split('#').length - 1;
  assert.ok(countInk(raster(sans, 'o', 48)) > 4 * countInk(raster(sans, 'o', 24)),
    'four times the area must carry more than four times the ink pixels');

  // An empty glyph is a legal blank bitmap, not a failure: the caller still
  // needs the cell cleared before compositing.
  assert.strictEqual(
    wat.test_tt_rasterize_glyph(sans.at, sans.size, gid(sans, ' '), 16,
      wa(BITMAP), 4, 4, 0, 256, wa(SCRATCH), SCRATCH_BYTES), 1);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      assert.strictEqual(wat.test_tt_bitmap_pixel(wa(BITMAP), 4, x, y), 0,
        'a blank glyph must leave no stale ink behind');
    }
  }

  assert.strictEqual(
    wat.test_tt_rasterize_glyph(sans.at, sans.size, gid(sans, 'o'), 16,
      wa(BITMAP), 8, 8, 0, 512, wa(SCRATCH), 16), 0,
    'too little scratch must refuse rather than write past it');
  assert.strictEqual(
    wat.test_tt_rasterize_glyph(sans.at, sans.size, gid(sans, 'o'), 16,
      wa(BITMAP), 0, 8, 0, 512, wa(SCRATCH), SCRATCH_BYTES), 0,
    'a zero-width box is refused');

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

  // ---- face registry ----------------------------------------------------
  //
  // Everything above is a pure function of a buffer. This is the part that
  // owns state: which font files are resident and which glyphs are already
  // rasterized. Faces come from the same virtual filesystem the .FON strikes
  // load through, so there is one filesystem rather than a second font path.

  const mount = (vfsPath, relative) => {
    hostCtx.vfs.files.set(vfsPath, {
      data: new Uint8Array(fs.readFileSync(path.join(REPO, relative))),
      attrs: 0x20,
    });
  };
  hostCtx.vfs.dirs.add('c:\\windows');
  hostCtx.vfs.dirs.add('c:\\windows\\fonts');
  mount('c:\\windows\\fonts\\arial.ttf', 'fonts/liberation/LiberationSans-Regular.ttf');
  mount('c:\\windows\\fonts\\cour.ttf', 'fonts/liberation/LiberationMono-Regular.ttf');
  mount('c:\\windows\\fonts\\broken.ttf', 'fonts/w95fa.woff2');

  const guestPath = text => {
    const guest = wat.guest_alloc(text.length + 1) >>> 0;
    bytes.set(Buffer.from(text, 'latin1'), wa(guest));
    bytes[wa(guest) + text.length] = 0;
    return guest;
  };

  const arial = wat.test_tt_face_open(guestPath('C:\\WINDOWS\\FONTS\\ARIAL.TTF'));
  assert.ok(arial >= 0, 'the substituted Arial must open from the VFS');
  assert.strictEqual(wat.test_tt_face_size(arial) >>> 0, sans.size,
    'the whole file must be resident');

  // Opening the same file again must not load a second 400KB copy. The path
  // is spelled differently on purpose: Win98 paths are case-insensitive.
  assert.strictEqual(
    wat.test_tt_face_open(guestPath('c:\\windows\\fonts\\arial.ttf')), arial,
    'the same file by a differently-cased path is one face');

  const courier = wat.test_tt_face_open(guestPath('C:\\WINDOWS\\FONTS\\COUR.TTF'));
  assert.ok(courier >= 0 && courier !== arial, 'a second face gets its own slot');

  assert.strictEqual(wat.test_tt_face_open(guestPath('C:\\WINDOWS\\FONTS\\NOPE.TTF')), -1,
    'a missing file fails rather than trapping');
  // A WOFF2 is not an sfnt this layer can read. Refusing it at open is what
  // keeps every accessor below from rediscovering it one zero at a time.
  assert.strictEqual(wat.test_tt_face_open(guestPath('C:\\WINDOWS\\FONTS\\BROKEN.TTF')), -1,
    'a non-TrueType file is refused at open');
  assert.strictEqual(wat.test_tt_face_open(0), -1);

  // The face API must agree with the buffer API it wraps: same font, same
  // answers, reached without the caller ever holding a pointer.
  const measured = 'Hello, World!';
  const measuredGuest = guestPath(measured);
  assert.strictEqual(
    wat.test_tt_face_text_width(arial, wa(measuredGuest), measured.length, 16),
    wat.test_tt_text_width_px(sans.at, sans.size, wa(measuredGuest),
      measured.length, 16));
  assert.strictEqual(wat.test_tt_face_char_width(arial, 0x41, 16),
    wat.test_tt_char_advance_px(sans.at, sans.size, 0x41, 16));
  assert.strictEqual(wat.test_tt_face_ppem(arial, -16), 16);
  assert.strictEqual(wat.test_tt_face_ppem(arial, 16), 14);

  // TEXTMETRIC by field index, so the GDI layer fills its struct from one
  // call site rather than a dozen exports.
  const metric = (face, field) => wat.test_tt_face_metric(face, 16, field);
  assert.strictEqual(metric(arial, 0), 17, 'tmHeight');
  assert.strictEqual(metric(arial, 1), 14, 'tmAscent');
  assert.strictEqual(metric(arial, 2), 3, 'tmDescent');
  assert.strictEqual(metric(arial, 5), 9, 'tmAveCharWidth');
  assert.strictEqual(metric(arial, 7), 400, 'tmWeight');
  assert.strictEqual(metric(arial, 9), 0x27, 'tmPitchAndFamily');
  assert.strictEqual(metric(courier, 9), 0x36,
    'the monospaced face reports fixed pitch through the same call');
  assert.strictEqual(metric(arial, 99), 0, 'an unknown field is zero, not garbage');
  assert.strictEqual(wat.test_tt_face_metric(-1, 16, 0), 0,
    'metrics on an unopened face are zero rather than a wild read');

  // ---- glyph cache ------------------------------------------------------
  //
  // Rasterization must happen once per glyph, face and size — not once per
  // TextOut. Without this the scan converter would re-flatten and re-fill
  // every character of every repaint.

  wat.test_tt_cache_flush();
  assert.strictEqual(wat.test_tt_cache_used(), 0);

  const glyphA = wat.test_tt_face_glyph(arial, 0x41, 16);
  assert.ok(glyphA, 'A must produce a cached glyph');
  assert.strictEqual(wat.test_tt_cache_used(), 1);
  assert.strictEqual(wat.test_tt_face_glyph(arial, 0x41, 16), glyphA,
    'the second request must hit the same entry');
  assert.strictEqual(wat.test_tt_cache_used(), 1, 'and must not rasterize again');

  // Same glyph, different size, and same size, different face are distinct
  // cache keys — collapsing either renders text at the wrong size or in the
  // wrong face, which is much harder to spot than a blank.
  assert.notStrictEqual(wat.test_tt_face_glyph(arial, 0x41, 24), glyphA);
  assert.notStrictEqual(wat.test_tt_face_glyph(courier, 0x41, 16), glyphA);
  assert.strictEqual(wat.test_tt_cache_used(), 3);

  // The cached bitmap must be the same picture the direct rasterizer makes.
  const direct = raster(sans, 'A', 16);
  assert.strictEqual(wat.test_tt_entry_width(glyphA), direct.width);
  assert.strictEqual(wat.test_tt_entry_height(glyphA), direct.height);
  for (let y = 0; y < direct.height; y += 1) {
    let row = '';
    for (let x = 0; x < direct.width; x += 1) {
      row += wat.test_tt_entry_pixel(glyphA, x, y) ? '#' : '.';
    }
    assert.strictEqual(row, direct.rows[y],
      `cached row ${y} must match the direct rasterization`);
  }
  assert.strictEqual(wat.test_tt_entry_left(glyphA),
    wat.test_tt_glyph_box_left(sans.at, sans.size, gid(sans, 'A'), 16),
    'the bearing travels with the cached glyph');
  assert.strictEqual(wat.test_tt_entry_top(glyphA),
    wat.test_tt_glyph_box_top(sans.at, sans.size, gid(sans, 'A'), 16));

  // Space caches as a real entry with no bitmap. Caching the absence is the
  // point: otherwise the commonest character in any string is the one glyph
  // that retries the whole box computation on every draw.
  const glyphSpace = wat.test_tt_face_glyph(arial, 0x20, 16);
  assert.ok(glyphSpace, 'space must occupy a cache entry');
  assert.strictEqual(wat.test_tt_entry_width(glyphSpace), 0);
  assert.strictEqual(wat.test_tt_entry_pixel(glyphSpace, 0, 0), 0);
  const usedAfterSpace = wat.test_tt_cache_used();
  wat.test_tt_face_glyph(arial, 0x20, 16);
  assert.strictEqual(wat.test_tt_cache_used(), usedAfterSpace,
    'a blank glyph must not be re-attempted');

  // CP1252 reaches the cache too: the ANSI byte 0x80 must land on the same
  // entry as the euro codepoint, not on .notdef.
  const glyphEuro = wat.test_tt_face_glyph(arial, 0x80, 16);
  assert.strictEqual(wat.test_tt_entry_width(glyphEuro),
    wat.test_tt_glyph_box_width(sans.at, sans.size, euroGid, 16),
    'the ANSI byte 0x80 must reach the euro through CP1252, not .notdef');
  assert.ok(wat.test_tt_entry_width(glyphEuro) > 0);

  assert.strictEqual(wat.test_tt_face_glyph(-1, 0x41, 16), 0,
    'an unopened face yields no glyph');
  assert.strictEqual(wat.test_tt_face_glyph(arial, 0x41, 0), 0,
    'a zero ppem is refused rather than dividing by it');
  assert.strictEqual(wat.test_tt_face_glyph(arial, 0x41, 4096), 0,
    'an absurd ppem is refused rather than allocating for it');

  // Flushing must free the bitmaps and leave the registry usable.
  wat.test_tt_cache_flush();
  assert.strictEqual(wat.test_tt_cache_used(), 0);
  const reborn = wat.test_tt_face_glyph(arial, 0x41, 16);
  assert.ok(reborn && wat.test_tt_entry_width(reborn) === direct.width,
    'the cache must still work after a flush');

  // ---- composing a run --------------------------------------------------
  //
  // Per-glyph tests cannot catch a bearing or advance applied with the wrong
  // sign: each glyph is right and the line is wrong. This walks a string the
  // way a TextOut loop would — pen starts at the origin, each glyph draws at
  // pen + left, baseline - top, then the pen moves by the advance — and
  // checks the result reads as text.

  const drawRun = (face, text, ppem) => {
    const ascent = wat.test_tt_face_metric(face, ppem, 1);
    const height = wat.test_tt_face_metric(face, ppem, 0);
    const width = wat.test_tt_face_text_width(face,
      wa(guestPath(text)), text.length, ppem);
    const rows = Array.from({ length: height }, () => new Array(width).fill('.'));
    let pen = 0;
    for (const character of text) {
      const byte = character.charCodeAt(0);
      const entry = wat.test_tt_face_glyph(face, byte, ppem);
      const glyphWidth = wat.test_tt_entry_width(entry);
      const glyphHeight = wat.test_tt_entry_height(entry);
      const left = wat.test_tt_entry_left(entry);
      const top = wat.test_tt_entry_top(entry);
      for (let y = 0; y < glyphHeight; y += 1) {
        for (let x = 0; x < glyphWidth; x += 1) {
          if (!wat.test_tt_entry_pixel(entry, x, y)) continue;
          const px = pen + left + x;
          const py = ascent - top + y;
          if (px >= 0 && px < width && py >= 0 && py < height) rows[py][px] = '#';
        }
      }
      pen += wat.test_tt_face_char_width(face, byte, ppem);
    }
    return rows.map(row => row.join(''));
  };

  const run = drawRun(arial, 'Hi!', 16);
  assert.strictEqual(run.length, 17, 'the run is one tmHeight tall');
  const ink = run.join('');
  assert.ok(ink.includes('#'), 'the run must have ink');

  // Descender space must stay empty for a string with no descenders, which is
  // what proves the baseline is where tmAscent says it is rather than at the
  // top of the box.
  assert.strictEqual(run[16].includes('#'), false,
    'nothing may reach the descender line for "Hi!"');
  assert.strictEqual(run[0].includes('#'), false,
    'nothing may reach the internal-leading line either');

  // Glyphs must not overlap or collide: a column of blank separates them.
  const columns = run[0].length;
  let blankColumns = 0;
  for (let x = 0; x < columns; x += 1) {
    if (run.every(row => row[x] === '.')) blankColumns += 1;
  }
  assert.ok(blankColumns >= 2,
    'advances must leave the glyphs separated rather than run together');

  // The pen must land exactly where the measured width says. If the advance
  // loop and GetTextExtentPoint32 disagree, carets and selection highlights
  // drift a pixel per character.
  const penEnd = [...'Hi!'].reduce((total, character) =>
    total + wat.test_tt_face_char_width(arial, character.charCodeAt(0), 16), 0);
  const measuredRun = wat.test_tt_face_text_width(arial,
    wa(guestPath('Hi!')), 3, 16);
  assert.ok(Math.abs(penEnd - measuredRun) <= 1,
    `per-character advances (${penEnd}) must agree with the measured run ` +
    `(${measuredRun}) to within the rounding of one pixel`);

  console.log('PASS  WAT reads TrueType metrics from Liberation Sans and Wine Marlett');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
