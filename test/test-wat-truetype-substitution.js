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
const TT_SUBST_TABLE = 0x07F0AC00;
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
  const mounts = fontMounts(manifest);
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

  console.log(
    `PASS  face substitution: ${watTable.size} faces and ${mounts.length} ` +
    `Win98 font files, WAT table and fonts/substitutions.json agree, ` +
    `every named file opens from the VFS`);
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
