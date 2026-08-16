#!/usr/bin/env node

'use strict';

// The deployed subsets must lay out exactly like the fonts they came from.
//
// Subsetting is a payload optimization - 4.7 MB of vendored TTFs become 278 KB
// the browser actually fetches - and a payload optimization that quietly moves
// an advance width by one unit is not an optimization, it is a layout bug that
// only appears in the deployed build. Metric compatibility is the entire point
// of choosing Liberation, so it is checked rather than assumed.
//
// Ground truth is the full font, read by the same WAT parser that will read the
// subset. That makes this self-hosted: it cannot pass because the subsetter and
// the checker share an assumption about what fontTools does, because the
// checker never asks fontTools anything.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');
const { fontMounts, subsetPath } = require('../lib/font-substitutions');

const REPO = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(
  path.join(REPO, 'fonts', 'substitutions.json'), 'utf8'));

// The sizes a Win98 UI actually asks for, plus a couple of display sizes.
const PPEMS = [8, 11, 12, 16, 24, 48];
// TEXTMETRIC fields that describe layout. tmWeight/tmItalic/tmPitchAndFamily
// are identity rather than layout, and are checked separately below.
const METRICS = [
  [0, 'tmHeight'], [1, 'tmAscent'], [2, 'tmDescent'],
  [3, 'tmInternalLeading'], [4, 'tmExternalLeading'],
  [5, 'tmAveCharWidth'], [6, 'tmMaxCharWidth'],
];

(async () => {
  const { exports: wat, memory } = await bootRenderHarness();
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;

  const loadFont = relative => {
    const file = fs.readFileSync(path.join(REPO, 'fonts', relative));
    const guest = wat.guest_alloc(file.length) >>> 0;
    assert.ok(guest, `guest_alloc failed for ${relative}`);
    const at = wa(guest);
    new Uint8Array(memory.buffer).set(file, at);
    return { at, size: file.length, bytes: file.length };
  };

  let pairs = 0;
  let advances = 0;
  let fullBytes = 0;
  let subsetBytes = 0;

  // Several Win98 faces are mounted from the same vendored file — a face with
  // no look-alike of its own still gets its own filename so a user can install
  // the real font there. The pair being checked here is the font, not the
  // mount, so each vendored file is checked once however many faces it serves.
  const seenSource = new Set();
  for (const mount of fontMounts(manifest)) {
    if (seenSource.has(mount.file)) continue;
    seenSource.add(mount.file);
    const subset = subsetPath(mount.file);
    const subsetFile = path.join(REPO, 'fonts', subset);
    assert.ok(fs.existsSync(subsetFile),
      `${mount.face} ${mount.style} has no subset: fonts/${subset}. ` +
      `Run bash tools/gen-font-subsets.sh`);

    const full = loadFont(mount.file);
    const cut = loadFont(subset);
    pairs += 1;
    fullBytes += full.bytes;
    subsetBytes += cut.bytes;

    const where = `${mount.face} ${mount.style}`;
    assert.strictEqual(wat.test_tt_is_truetype(cut.at, cut.size), 1,
      `${where} subset must still be glyf TrueType`);

    // Advance widths in font units, for every byte the emulator can ask for.
    // Font units rather than pixels because a pixel comparison would hide a
    // small unit drift behind rounding at every size that happens to agree.
    const symbol = wat.test_tt_cmap_is_symbol(full.at, full.size);
    assert.strictEqual(wat.test_tt_cmap_is_symbol(cut.at, cut.size), symbol,
      `${where} subset must keep the same cmap encoding`);
    assert.strictEqual(
      wat.test_tt_units_per_em(cut.at, cut.size),
      wat.test_tt_units_per_em(full.at, full.size),
      `${where} subset must keep the same em square`);

    let mapped = 0;
    for (let byte = 0x20; byte <= 0xFF; byte += 1) {
      const fullGlyph = wat.test_tt_ansi_glyph_index(full.at, full.size, byte);
      const cutGlyph = wat.test_tt_ansi_glyph_index(cut.at, cut.size, byte);
      // Glyph *ids* are renumbered by subsetting; only presence and metrics
      // have to survive.
      assert.strictEqual(cutGlyph !== 0, fullGlyph !== 0,
        `${where} byte 0x${byte.toString(16)} is present in one and not the other`);
      if (!fullGlyph) continue;
      mapped += 1;
      assert.strictEqual(
        wat.test_tt_advance_fu(cut.at, cut.size, cutGlyph),
        wat.test_tt_advance_fu(full.at, full.size, fullGlyph),
        `${where} advance changed for byte 0x${byte.toString(16)}`);
      assert.strictEqual(
        wat.test_tt_lsb_fu(cut.at, cut.size, cutGlyph),
        wat.test_tt_lsb_fu(full.at, full.size, fullGlyph),
        `${where} left bearing changed for byte 0x${byte.toString(16)}`);
      advances += 1;
    }
    // An ANSI face must keep the whole CP1252 repertoire; a symbol face has
    // whatever its (3,0) cmap happens to carry, and Wine's Webdings carries
    // ten glyphs on purpose. Presence parity is asserted per byte above - this
    // only catches a subset that came out broadly empty.
    const floor = mount.charset === 'SYMBOL' ? 1 : 180;
    assert.ok(mapped >= floor,
      `${where} kept only ${mapped} mapped codes, expected at least ${floor}`);

    for (const ppem of PPEMS) {
      for (const [field, name] of METRICS) {
        assert.strictEqual(
          watMetric(cut, ppem, field), watMetric(full, ppem, field),
          `${where} ${name} changed at ${ppem}ppem`);
      }
    }

    // Identity, not layout: a subset that lost its weight or italic bit would
    // still lay out correctly and pick the wrong file for every bold run.
    assert.strictEqual(
      wat.test_tt_weight_class(cut.at, cut.size),
      wat.test_tt_weight_class(full.at, full.size), `${where} usWeightClass`);
    assert.strictEqual(
      wat.test_tt_is_italic(cut.at, cut.size),
      wat.test_tt_is_italic(full.at, full.size), `${where} italic flag`);
  }

  function watMetric(font, ppem, field) {
    // The face-level metric API needs a registered face; these are raw
    // buffers, so go through the buffer-level derivation the face API wraps.
    switch (field) {
      case 0: return wat.test_tt_tm_height(font.at, font.size, ppem);
      case 1: return wat.test_tt_tm_ascent(font.at, font.size, ppem);
      case 2: return wat.test_tt_tm_descent(font.at, font.size, ppem);
      case 3: return wat.test_tt_tm_internal_leading(font.at, font.size, ppem);
      case 4: return wat.test_tt_tm_external_leading(font.at, font.size, ppem);
      case 5: return wat.test_tt_tm_ave_char_width(font.at, font.size, ppem);
      case 6: return wat.test_tt_tm_max_char_width(font.at, font.size, ppem);
      default: throw new Error(`unknown metric field ${field}`);
    }
  }

  // The deploy must actually ship them. fonts/ was previously neither a text
  // dir nor a binary dir in tools/deploy-berrry.js, so none of it reached the
  // live site - and a missing font does not fail, it silently falls back to
  // whatever the visitor's machine has. Checked as text because the deploy
  // script exits on a missing API key and cannot be required here.
  const deploy = fs.readFileSync(
    path.join(REPO, 'tools', 'deploy-berrry.js'), 'utf8');
  assert.ok(/binFiles\s*=\s*collectBinaries\(\)\.concat\(collectFonts\(\)\)/.test(deploy),
    'tools/deploy-berrry.js must ship fonts/, or the live site has none');
  assert.ok(deploy.includes("'fonts/subset/'"),
    'the deploy must ship the subsets, not just the bitmap strikes');
  // Comments stripped first: the collector explains in prose why it skips the
  // vendored sources, and that explanation is not a code path that ships them.
  const deployCode = deploy.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/fonts\/(liberation|wine)/.test(deployCode),
    'the vendored sources are 6.5 MB nothing fetches at runtime; ship subsets');

  assert.strictEqual(pairs, 18, 'every vendored font must have a subset');
  assert.ok(subsetBytes * 4 < fullBytes,
    `subsetting must actually pay: ${subsetBytes} vs ${fullBytes} bytes`);

  console.log(
    `PASS  font subsets: ${pairs} faces, ${advances} advances and ` +
    `${PPEMS.length * METRICS.length * pairs} metrics identical to the full ` +
    `fonts; ${(subsetBytes / 1024).toFixed(0)} KB deployed instead of ` +
    `${(fullBytes / 1024).toFixed(0)} KB`);
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
