#!/usr/bin/env node

'use strict';

// AddFontResourceA with a font the substitution table has never heard of.
//
// The static table answers for the faces Win98 shipped. A guest may also
// install a font of its own by path, and the family name that makes it
// selectable exists only inside the file - fontview.exe does exactly this to
// display whatever file it was launched on. It also tests the return value and
// destroys its own window without painting when it is zero, which is why a
// scalable file rejected by the bitmap loader had to stop returning zero.
//
// Ground truth for the family name is a name-table reader written here, in JS,
// from the sfnt spec. Asking the WAT reader what the name is and then checking
// the WAT registry stored that name would pass with both halves wrong.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');
const { fontMounts } = require('../lib/font-substitutions');

const REPO = path.join(__dirname, '..');

// ---- independent name-table reader --------------------------------------

const familyNameOf = buffer => {
  const numTables = buffer.readUInt16BE(4);
  let nameOff = 0;
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    if (buffer.toString('latin1', record, record + 4) === 'name') {
      nameOff = buffer.readUInt32BE(record + 8);
    }
  }
  assert.ok(nameOff, 'font has no name table');

  const count = buffer.readUInt16BE(nameOff + 2);
  const strings = nameOff + buffer.readUInt16BE(nameOff + 4);
  let best = null;
  let bestRank = 0;
  for (let i = 0; i < count; i += 1) {
    const record = nameOff + 6 + i * 12;
    if (buffer.readUInt16BE(record + 6) !== 1) continue; // name ID 1 = family
    const platform = buffer.readUInt16BE(record);
    const encoding = buffer.readUInt16BE(record + 2);
    const language = buffer.readUInt16BE(record + 4);
    let rank = 0;
    if (platform === 3 && encoding <= 1) rank = language === 0x409 ? 4 : 3;
    else if (platform === 1 && encoding === 0) rank = language === 0 ? 2 : 1;
    if (rank > bestRank) { bestRank = rank; best = { record, platform }; }
  }
  assert.ok(best, 'font declares no usable family name');

  const length = buffer.readUInt16BE(best.record + 8);
  const offset = strings + buffer.readUInt16BE(best.record + 10);
  // Copied before swapping: subarray shares storage with the file buffer and
  // swap16 is in place, so swapping the view would corrupt the font every
  // caller after the first one reads.
  const raw = Buffer.from(buffer.subarray(offset, offset + length));
  return best.platform === 3
    ? raw.swap16().toString('utf16le')
    : raw.toString('latin1');
};

(async () => {
  const canvas = { mask: 0 };
  const { exports: wat, memory, hostCtx } = await bootRenderHarness({
    extraHostOverrides: {
      gdi_text_mask: () => { canvas.mask++; return 0; },
      measure_text: (_hdc, _text, count) => count * 8,
      get_text_metrics: () => 8 | (8 << 16),
    },
  });
  // Guest allocation can grow the WASM memory and detach any view taken
  // before it, and a stale view reads as zeroes rather than throwing.
  const mem = () => new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;

  const readStr = at => {
    const bytes = mem();
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    return Buffer.from(bytes.subarray(at, end)).toString('latin1');
  };
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    mem().fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  // Returns the GUEST pointer: test_call_* wrappers are the guest-facing
  // handlers, while the raw test_tt_* helpers take translated WASM addresses.
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

  const add = p => wat.test_call_AddFontResourceA(allocStr(p));
  const remove = p => wat.test_call_RemoveFontResourceA(allocStr(p));
  const registered = (name, weight = 400, italic = 0) => {
    const found = wat.test_tt_reg_path(wa(allocStr(name)), weight, italic) >>> 0;
    return found ? readStr(found) : null;
  };

  // ---- mount the fonts --------------------------------------------------

  const manifest = JSON.parse(fs.readFileSync(
    path.join(REPO, 'fonts', 'substitutions.json'), 'utf8'));
  hostCtx.vfs.dirs.add('c:\\windows');
  hostCtx.vfs.dirs.add('c:\\windows\\fonts');
  const mounts = fontMounts(manifest, { subset: true });
  const fileFor = new Map();
  for (const mount of mounts) {
    const data = fs.readFileSync(path.join(REPO, 'fonts', mount.file));
    hostCtx.vfs.files.set(mount.vfsPath, {
      data: new Uint8Array(data), attrs: 0x20,
    });
    fileFor.set(mount.vfsPath, data);
  }
  for (const name of ['System.fon', 'MSSansSerif.fon']) {
    hostCtx.vfs.files.set(`c:\\windows\\fonts\\${name.toLowerCase()}`, {
      data: new Uint8Array(fs.readFileSync(path.join(REPO, 'fonts', name))),
      attrs: 0x20,
    });
  }
  hostCtx.vfs.files.set('c:\\windows\\notafont.txt', {
    data: new Uint8Array(Buffer.from('this is not a font', 'latin1')),
    attrs: 0x20,
  });

  const ARIAL = 'C:\\WINDOWS\\FONTS\\ARIAL.TTF';
  const ARIALBD = 'C:\\WINDOWS\\FONTS\\ARIALBD.TTF';
  const ARIALI = 'C:\\WINDOWS\\FONTS\\ARIALI.TTF';
  const family = familyNameOf(fileFor.get('c:\\windows\\fonts\\arial.ttf'));
  const boldFamily = familyNameOf(fileFor.get('c:\\windows\\fonts\\arialbd.ttf'));
  // Every style of one family shares a family name; that is what lets a guest
  // install four files and then ask for one face in four weights.
  assert.strictEqual(boldFamily, family,
    'the bold file must declare the same family name as the regular one');

  // ---- the WAT name reader agrees with the spec -------------------------

  const out = allocZero(64);
  assert.strictEqual(wat.test_tt_family_name(wa(allocStr('')), 0, wa(out), 64), 0,
    'a font with no bytes must yield no family name rather than an empty one');

  // One install per vendored font, not per mount. Faces with no look-alike of
  // their own are mounted from a font another face already uses, so installing
  // every mount would register those bytes under several filenames — and the
  // removal test below would then be measuring a duplicate rather than the
  // style fallback it means to measure.
  const installed = new Set();
  for (const mount of mounts) {
    const buffer = fileFor.get(mount.vfsPath);
    if (installed.has(mount.file)) continue;
    installed.add(mount.file);
    assert.strictEqual(add(mount.vfsPath), 1,
      `AddFontResourceA must install ${mount.file}`);
    assert.ok(registered(familyNameOf(buffer)),
      `${mount.file} must be reachable under its own family name ` +
      `"${familyNameOf(buffer)}"`);
  }

  // ---- style routing ----------------------------------------------------
  //
  // Registered files arrive one at a time in whatever order the guest picked,
  // so the style is scored across the family rather than indexed by slot.

  assert.strictEqual(registered(family, 400, 0).toLowerCase(),
    ARIAL.toLowerCase(), 'regular must resolve to the regular file');
  assert.strictEqual(registered(family, 700, 0).toLowerCase(),
    ARIALBD.toLowerCase(), 'bold must resolve to the bold file');
  assert.strictEqual(registered(family, 400, 1).toLowerCase(),
    ARIALI.toLowerCase(), 'italic must resolve to the italic file');

  // Case-insensitive, the way GDI matched face names.
  assert.ok(registered(family.toUpperCase()), 'face names match case-insensitively');
  assert.strictEqual(registered('No Such Family'), null,
    'an unregistered family resolves to nothing');
  assert.strictEqual(registered(''), null, 'an empty name resolves to nothing');

  // ---- installing the same file twice is not two entries ----------------
  //
  // The table is bounded. A guest that re-installs its font on every window
  // it opens would exhaust it, and the last real font would be the one that
  // failed.

  assert.strictEqual(add(ARIAL), 1, 're-installing a font must still report success');
  assert.strictEqual(add('c:\\windows\\fonts\\arial.ttf'), 1,
    'a differently-spelled path to the same file is the same entry');
  assert.strictEqual(registered(family, 400, 0).toLowerCase(), ARIAL.toLowerCase(),
    're-installing must not disturb the entry');

  // ---- what must not register -------------------------------------------

  assert.strictEqual(wat.test_call_AddFontResourceA(0), 0, 'a null path adds nothing');
  assert.strictEqual(add('C:\\WINDOWS\\FONTS\\NOSUCH.TTF'), 0,
    'a missing file adds nothing');
  assert.strictEqual(add('C:\\WINDOWS\\NOTAFONT.TXT'), 0,
    'a file that is not a font adds nothing');

  // A .FON still goes to the bitmap loader, which is the path that owns it.
  assert.ok(add('C:\\WINDOWS\\FONTS\\SYSTEM.FON') > 0,
    'a bitmap font resource must still install through the bitmap loader');
  assert.strictEqual(registered('System'), null,
    'a bitmap font must not land in the scalable registry');

  // ---- the substitution table still answers for Win98 faces -------------
  //
  // Nothing registered here is named "Arial" - the vendored substitutes carry
  // their own family names - so the static table must still be reached.

  const arialPath = wat.test_tt_subst_path(wa(allocStr('Arial')), 400, 0) >>> 0;
  assert.strictEqual(readStr(arialPath), ARIAL,
    'a Win98 face name must still resolve through the substitution table');

  // ---- removal ----------------------------------------------------------

  const ARIALBI = 'C:\\WINDOWS\\FONTS\\ARIALBI.TTF';
  assert.strictEqual(remove(ARIALBD), 1, 'RemoveFontResourceA must uninstall');
  // Weight outranks slant, the way the Windows font mapper scored it: a
  // weight mismatch cost |requested - actual| / 5, which is 60 points from
  // bold to regular, against a flat 4 for the wrong slant. So a bold request
  // with no upright bold file left takes the bold italic over the regular.
  assert.strictEqual(registered(family, 700, 0).toLowerCase(), ARIALBI.toLowerCase(),
    'with the upright bold file gone, bold keeps its weight and loses its slant');
  assert.strictEqual(remove(ARIALBI), 1, 'RemoveFontResourceA must uninstall');
  assert.strictEqual(registered(family, 700, 0).toLowerCase(), ARIAL.toLowerCase(),
    'with no bold file at all, bold falls back to the regular one it has');
  assert.strictEqual(remove('C:\\WINDOWS\\FONTS\\NOSUCH.TTF'), 0,
    'removing a font that was never installed reports nothing removed');
  assert.strictEqual(wat.test_call_RemoveFontResourceA(0), 0,
    'a null path removes nothing');

  // ---- a registered face draws ------------------------------------------
  //
  // The payoff: a family that appears in no table is selectable and its
  // glyphs come out of WAT rather than the Canvas fallback.

  const WIDTH = 200;
  const HEIGHT = 40;
  const bmi = allocZero(40);
  wat.guest_write32(bmi, 40);
  wat.guest_write32(bmi + 4, WIDTH);
  wat.guest_write32(bmi + 8, -HEIGHT);
  wat.guest_write16(bmi + 12, 1);
  wat.guest_write16(bmi + 14, 32);
  const bits = allocZero(4);
  const bitmap = wat.test_call_CreateDIBSection(0, bmi, bits) >>> 0;
  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert.ok(bitmap && hdc, 'the test needs a memory DC');
  wat.test_call_SelectObject(hdc, bitmap);
  wat.test_call_PatBlt(hdc, 0, 0, WIDTH, HEIGHT, 0x00FF0062); // WHITENESS

  const font = wat.test_call_CreateFontW(-16, 400, 0, allocFaceW(family)) >>> 0;
  assert.ok(font, 'CreateFont must produce a WAT font object');
  wat.test_call_SelectObject(hdc, font);
  assert.ok(wat.test_gdi_bitmap_font_selected(hdc) >>> 0,
    `"${family}" is registered, so it must resolve to a strike`);

  const before = canvas.mask;
  const text = 'Hamburgefonstiv';
  assert.strictEqual(
    wat.test_call_TextOutA(hdc, 4, 4, allocStr(text), text.length), 1,
    'TextOut must succeed');
  assert.strictEqual(canvas.mask, before,
    'a registered face must not be handed to Canvas');

  let ink = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if ((wat.test_call_GetPixel(hdc, x, y) >>> 0) !== 0xFFFFFF) ink += 1;
    }
  }
  assert.ok(ink > 40, `registered text must actually land: ${ink} pixels drawn`);

  console.log(
    `PASS  font resources: ${installed.size} scalable fonts across ` +
    `${mounts.length} mounts install by path and ` +
    `answer to their own family names ("${family}" draws ${ink} pixels in WAT), ` +
    `bitmap resources still take the bitmap path`);
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
