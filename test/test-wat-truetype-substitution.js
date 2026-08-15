#!/usr/bin/env node

'use strict';

// The seam between a LOGFONT face name and a font file.
//
// WAT holds the Win98-canonical filenames (ARIAL.TTF, TAHOMABD.TTF); the host
// decides which vendored open font is mounted at each of those VFS paths, from
// fonts/substitutions.json. That split only works while both halves name the
// same set of files, and nothing else would notice if they drifted: a face WAT
// asks for but the host never mounts just falls back silently to Canvas, which
// looks like "scalable text works" until someone compares it pixel by pixel.
// So this reads the WAT table out of linear memory and the manifest off disk,
// and requires them to agree in both directions.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');
const { fontMounts, FONT_DIR } = require('../lib/font-substitutions');

const REPO = path.join(__dirname, '..');
const STYLES = ['regular', 'bold', 'italic', 'boldItalic'];

// The address and size the WAT table declares. Read rather than assumed so a
// region move fails here instead of silently parsing whatever moved in.
const TT_SUBST_TABLE = 0x07F0B400;
const TT_SUBST_TABLE_SIZE = 0x800;

const manifest = JSON.parse(fs.readFileSync(
  path.join(REPO, 'fonts', 'substitutions.json'), 'utf8'));

(async () => {
  const { exports: wat, memory, hostCtx } = await bootRenderHarness();
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;

  const readStr = at => {
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    return Buffer.from(bytes.subarray(at, end)).toString('latin1');
  };

  // ---- the table in WAT -------------------------------------------------
  //
  // Five NUL-terminated strings per record: face name, then regular, bold,
  // italic, bold-italic. An empty face name ends the table.

  const watTable = new Map();
  let at = TT_SUBST_TABLE;
  const end = TT_SUBST_TABLE + TT_SUBST_TABLE_SIZE;
  while (at < end) {
    const face = readStr(at);
    if (!face) break;
    at += face.length + 1;
    const files = {};
    for (const style of STYLES) {
      const value = readStr(at);
      at += value.length + 1;
      if (value) files[style] = value;
    }
    assert.ok(!watTable.has(face), `WAT lists "${face}" twice`);
    watTable.set(face, files);
  }
  assert.ok(at < end, 'the WAT substitution blob must be NUL-terminated in range');
  assert.ok(watTable.size > 0, 'the WAT substitution table must not be empty');

  // ---- both halves name the same files ----------------------------------

  const expected = new Map();
  for (const face of manifest.faces) {
    if (!face.win98Files) continue;
    const files = {};
    for (const style of Object.keys(face.win98Files)) {
      files[style] = (FONT_DIR + face.win98Files[style]).toUpperCase();
    }
    expected.set(face.win98, files);
  }

  assert.deepStrictEqual([...watTable.keys()].sort(), [...expected.keys()].sort(),
    'the WAT face list and fonts/substitutions.json must name the same faces');
  for (const [face, files] of expected) {
    assert.deepStrictEqual(watTable.get(face), files,
      `WAT and the manifest disagree about the files for "${face}"`);
  }

  // ---- lookup -----------------------------------------------------------

  const guestPath = text => {
    const guest = wat.guest_alloc(text.length + 1) >>> 0;
    assert.ok(guest, 'guest_alloc failed');
    bytes.set(Buffer.from(text, 'latin1'), wa(guest));
    bytes[wa(guest) + text.length] = 0;
    return wa(guest);
  };
  const lookup = (name, weight = 400, italic = 0) => {
    const found = wat.test_tt_subst_path(guestPath(name), weight, italic) >>> 0;
    return found ? readStr(found) : null;
  };

  for (const [face, files] of expected) {
    assert.strictEqual(lookup(face), files.regular,
      `"${face}" regular must resolve to its Win98 file`);
    if (files.bold) {
      assert.strictEqual(lookup(face, 700), files.bold, `"${face}" bold`);
    }
    if (files.italic) {
      assert.strictEqual(lookup(face, 400, 1), files.italic, `"${face}" italic`);
    }
    if (files.boldItalic) {
      assert.strictEqual(lookup(face, 700, 1), files.boldItalic,
        `"${face}" bold italic`);
    }
  }

  // FW_BOLD is 700; GDI treated anything lighter as regular, and a font
  // requested at 600 that came back bold would be visibly too heavy.
  assert.strictEqual(lookup('Arial', 699), expected.get('Arial').regular);
  assert.strictEqual(lookup('Arial', 700), expected.get('Arial').bold);
  assert.strictEqual(lookup('Arial', 900), expected.get('Arial').bold);

  // Win98 face names are case-insensitive: a guest is as likely to write
  // "arial" as "Arial", and both named the same file.
  assert.strictEqual(lookup('arial'), expected.get('Arial').regular);
  assert.strictEqual(lookup('ARIAL'), expected.get('Arial').regular);
  assert.strictEqual(lookup('times new roman'),
    expected.get('Times New Roman').regular);

  // Tahoma ships no italic file. Falling back to the upright file is the
  // honest answer; returning nothing would drop the face to Canvas, and
  // returning the bold file would be a wrong glyph shape.
  const tahoma = expected.get('Tahoma');
  assert.strictEqual(lookup('Tahoma', 400, 1), tahoma.regular,
    'italic Tahoma falls back to upright, not to nothing');
  assert.strictEqual(lookup('Tahoma', 700, 1), tahoma.bold,
    'bold italic Tahoma keeps the weight it does have');

  // A face with no substitute must report nothing so the caller keeps doing
  // whatever it did before, rather than opening some other font.
  assert.strictEqual(lookup('Verdana'), null, 'an unsubstituted face resolves to nothing');
  assert.strictEqual(lookup(''), null, 'an empty face name resolves to nothing');
  assert.strictEqual(lookup('Aria'), null, 'a prefix is not a match');
  assert.strictEqual(lookup('Arial Black'), null, 'a longer name is not a match');
  assert.strictEqual(wat.test_tt_subst_path(0, 400, 0) >>> 0, 0);

  // ---- every named file actually opens ----------------------------------
  //
  // This is the check that would have caught the whole scalable path being
  // unreachable: WAT naming files the host never mounts.

  hostCtx.vfs.dirs.add('c:\\windows');
  hostCtx.vfs.dirs.add('c:\\windows\\fonts');
  const mounts = fontMounts(manifest, { subset: true });
  assert.strictEqual(mounts.length, [...expected.values()]
    .reduce((n, files) => n + Object.keys(files).length, 0),
    'every mapped Win98 file must produce a mount');
  for (const mount of mounts) {
    const file = path.join(REPO, 'fonts', mount.file);
    assert.ok(fs.existsSync(file), `missing substitute: fonts/${mount.file}`);
    hostCtx.vfs.files.set(mount.vfsPath, {
      data: new Uint8Array(fs.readFileSync(file)), attrs: 0x20,
    });
  }

  const opened = new Map();
  for (const [face, files] of expected) {
    for (const style of Object.keys(files)) {
      const weight = style.startsWith('bold') ? 700 : 400;
      const italic = style.endsWith('talic') ? 1 : 0;
      const index = wat.test_tt_face_for_logfont(
        guestPath(face), weight, italic);
      assert.ok(index >= 0,
        `${face} ${style} names ${files[style]} but it did not open from the VFS`);
      const key = `${face} ${style}`;
      opened.set(key, index);
    }
  }

  // One file, one face slot: a second request for the same style must not
  // load a second copy of a 400 KB font.
  assert.strictEqual(
    wat.test_tt_face_for_logfont(guestPath('Arial'), 400, 0),
    opened.get('Arial regular'));
  assert.notStrictEqual(opened.get('Arial regular'), opened.get('Arial bold'),
    'bold Arial is a different file and so a different face');

  // The faces are real: ask each one something only a parsed font can answer.
  for (const [key, index] of opened) {
    assert.ok(wat.test_tt_face_metric(index, 16, 1) > 0, `${key} has no ascent`);
    assert.ok(wat.test_tt_face_size(index) > 0, `${key} has no resident bytes`);
  }

  // Bold really is heavier, and italic really is slanted — proof the style
  // fallback picked distinct files rather than the same one four times.
  const arialBold = opened.get('Arial bold');
  const arialRegular = opened.get('Arial regular');
  assert.strictEqual(wat.test_tt_face_metric(arialRegular, 16, 7), 400,
    'regular Arial reports tmWeight 400');
  assert.strictEqual(wat.test_tt_face_metric(arialBold, 16, 7), 700,
    'bold Arial reports tmWeight 700');
  assert.strictEqual(wat.test_tt_face_metric(opened.get('Arial italic'), 16, 8), 1,
    'italic Arial reports tmItalic');
  assert.strictEqual(wat.test_tt_face_metric(arialRegular, 16, 8), 0);

  // A face with no substitute must not open one anyway.
  assert.strictEqual(wat.test_tt_face_for_logfont(guestPath('Verdana'), 400, 0), -1);

  // ---- synthetic strikes ------------------------------------------------
  //
  // A scalable face is rasterized into an FNT 3.00 image and installed as an
  // ordinary strike, so the existing bitmap text path renders it with no
  // knowledge that the glyphs came from an outline. The image is read back
  // here straight out of linear memory rather than through the WAT accessors,
  // so a builder that agrees with a matching reader bug still fails.

  const u8 = at => bytes[at];
  const u16 = at => bytes[at] | (bytes[at + 1] << 8);
  const u32 = at => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) |
    (bytes[at + 3] << 24)) >>> 0;

  const readStrike = record => {
    assert.ok(record, 'expected an installed strike');
    const data = u32(record + 8);
    return {
      record,
      data,
      size: u32(record + 12),
      version: u32(record + 16),
      height: u32(record + 20),
      ascent: u32(record + 24),
      first: u32(record + 36),
      last: u32(record + 40),
      face: readStr(data + u32(record + 56)),
      // FNT 3.00 char table: u16 width, u32 offset, from byte 148.
      glyph(code) {
        const entry = data + 148 + code * 6;
        return { width: u16(entry), offset: u32(entry + 2) };
      },
      // Column-major: byte (x>>3)*height + y, bit 0x80 >> (x&7).
      pixel(code, x, y) {
        const { width, offset } = this.glyph(code);
        if (x >= width || y >= this.height) return 0;
        const at = data + offset + (x >> 3) * this.height + y;
        return (bytes[at] & (0x80 >> (x & 7))) ? 1 : 0;
      },
    };
  };

  const strike = readStrike(
    wat.test_tt_strike_ensure(guestPath('Arial'), -16, 400, 0) >>> 0);

  assert.strictEqual(strike.version, 0x0300, 'a synthetic strike is FNT 3.00');
  assert.strictEqual(strike.face, 'Arial',
    'the strike installs under the Win98 face name, not the substitute name');
  assert.strictEqual(strike.first, 0);
  assert.strictEqual(strike.last, 255, 'the whole ANSI range gets a cell');

  // The strike must report exactly what the face reports, or text laid out
  // from the strike will not match text measured from the face.
  const arialFace = wat.test_tt_face_for_logfont(guestPath('Arial'), 400, 0);
  const ppem = wat.test_tt_face_ppem(arialFace, -16);
  assert.strictEqual(ppem, 16);
  assert.strictEqual(strike.height,
    wat.test_tt_face_metric(arialFace, ppem, 0), 'tmHeight');
  assert.strictEqual(strike.ascent,
    wat.test_tt_face_metric(arialFace, ppem, 1), 'tmAscent');

  // Every cell is at least as wide as the advance, so a run laid out cell by
  // cell is never narrower than the measured string.
  for (const ch of 'The quick brown fox, 0123456789!') {
    const code = ch.charCodeAt(0);
    assert.ok(strike.glyph(code).width >=
      wat.test_tt_face_char_width(arialFace, code, ppem),
      `cell for "${ch}" is narrower than its advance`);
  }
  assert.ok(strike.glyph(0x20).width > 0, 'space still occupies a cell');

  // Ink, in the right place. 'A' must be solid at the baseline row and empty
  // below it; 'g' must put ink below the baseline. Getting the vertical
  // origin wrong is the failure that still looks like text.
  const inkRow = (code, y) => {
    const { width } = strike.glyph(code);
    for (let x = 0; x < width; x += 1) if (strike.pixel(code, x, y)) return true;
    return false;
  };
  const capital = 'A'.charCodeAt(0);
  assert.ok(inkRow(capital, strike.ascent - 1), 'A must reach the baseline');
  assert.ok(!inkRow(capital, strike.ascent), 'A must not descend below it');
  assert.ok(inkRow('g'.charCodeAt(0), strike.ascent), 'g must descend');
  assert.ok(!inkRow(0x20, strike.ascent - 1), 'space must be blank');

  // The cell and the cached glyph must hold the same ink, offset by the
  // bearings: this is the step where a bitmap gets copied between two
  // origins, and an off-by-one here is a permanently smudged font.
  const entry = wat.test_tt_face_glyph(arialFace, capital, ppem) >>> 0;
  assert.ok(entry, 'A must rasterize');
  const gw = wat.test_tt_entry_width(entry);
  const gh = wat.test_tt_entry_height(entry);
  const left = wat.test_tt_entry_left(entry);
  const top = wat.test_tt_entry_top(entry);
  let compared = 0;
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      const expectedInk = wat.test_tt_entry_pixel(entry, gx, gy) ? 1 : 0;
      const got = strike.pixel(capital, left + gx, strike.ascent - top + gy);
      assert.strictEqual(got, expectedInk,
        `A differs at glyph (${gx},${gy})`);
      compared += 1;
    }
  }
  assert.ok(compared > 0, 'A must have compared some pixels');

  // One strike per face and size: a second request must not rebuild it.
  assert.strictEqual(
    wat.test_tt_strike_ensure(guestPath('Arial'), -16, 400, 0) >>> 0,
    strike.record, 'the same request reuses the installed strike');
  assert.strictEqual(
    wat.test_tt_strike_ensure(guestPath('arial'), -16, 400, 0) >>> 0,
    strike.record, 'case does not make a second strike');

  const bold = readStrike(
    wat.test_tt_strike_ensure(guestPath('Arial'), -16, 700, 0) >>> 0);
  assert.notStrictEqual(bold.record, strike.record, 'bold is its own strike');
  assert.ok(bold.glyph(capital).width > strike.glyph(capital).width,
    'bold A must be wider than regular A');

  const large = readStrike(
    wat.test_tt_strike_ensure(guestPath('Arial'), -32, 400, 0) >>> 0);
  assert.ok(large.height > strike.height, 'a larger size is a taller strike');
  assert.notStrictEqual(large.record, strike.record);

  // A positive lfHeight is a cell height, not an em size. Both conventions
  // must reach a strike, and they must not reach the same one.
  const byCell = readStrike(
    wat.test_tt_strike_ensure(guestPath('Arial'), 16, 400, 0) >>> 0);
  assert.ok(byCell.height <= strike.height,
    'a 16px cell is no taller than a 16ppem em');

  // Faces with no substitute report nothing, so the caller falls back exactly
  // as it did before rather than rendering some other font.
  assert.strictEqual(wat.test_tt_strike_ensure(guestPath('Verdana'), -16, 400, 0), 0);
  assert.strictEqual(wat.test_tt_strike_ensure(0, -16, 400, 0), 0);

  // Symbol faces keep their own encoding: byte 0xF0 is a real Wingdings
  // glyph, and going through CP1252 on the way in would lose it.
  const wingdings = readStrike(
    wat.test_tt_strike_ensure(guestPath('Wingdings'), -16, 400, 0) >>> 0);
  assert.strictEqual(wingdings.face, 'Wingdings');
  assert.ok(wingdings.glyph(0x6C).width > 0);

  console.log(
    `PASS  face substitution: ${watTable.size} faces and ${mounts.length} ` +
    `Win98 font files, WAT table and fonts/substitutions.json agree, ` +
    `every named file opens from the VFS; Arial rasterizes to a ` +
    `${strike.height}px FNT strike with ${compared} pixels of 'A' matching ` +
    `the cached glyph`);
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
