#!/usr/bin/env node

'use strict';

// fonts/substitutions.json is the single source the browser @font-face block,
// the Node font registration, and the WAT font inventory all read. A manifest
// that names a file which is not there, or a family the host also has, fails
// at runtime as mis-laid-out text on someone else's machine rather than as an
// error here — so it is checked here instead.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FONTS = path.join(__dirname, '..', 'fonts');
const manifest = JSON.parse(
  fs.readFileSync(path.join(FONTS, 'substitutions.json'), 'utf8'));

const STYLES = ['regular', 'bold', 'italic', 'boldItalic'];
const seenWin98 = new Set();
const seenCss = new Set();
let files = 0;

assert.ok(Array.isArray(manifest.faces) && manifest.faces.length > 0,
  'the manifest must list faces');

for (const face of manifest.faces) {
  const where = `face "${face.win98}"`;

  assert.ok(face.win98, 'every face names the Win98 face it substitutes');
  assert.ok(!seenWin98.has(face.win98), `${where} is listed twice`);
  seenWin98.add(face.win98);

  assert.ok([1, 2, 3].includes(face.tier), `${where} needs tier 1, 2 or 3`);
  assert.ok(manifest.tiers[String(face.tier)], `${where} tier must be described`);
  assert.ok(face.substitute, `${where} must name its substitute`);
  assert.ok(face.license, `${where} must record a license`);
  assert.ok(['ANSI', 'SYMBOL'].includes(face.charset),
    `${where} charset must be ANSI or SYMBOL`);

  // The private-name rule is the whole determinism argument. A family
  // registered under its Win98 name would let the host's own copy win the
  // cascade on machines that have it and lose on machines that do not.
  assert.ok(face.cssFamily.startsWith('WA '),
    `${where} cssFamily "${face.cssFamily}" must carry the private WA prefix`);
  assert.notStrictEqual(face.cssFamily, face.win98,
    `${where} must not register under the Win98 name`);
  assert.ok(!manifest.faces.some(other => other.win98 === face.cssFamily),
    `${where} cssFamily must not collide with any Win98 face name`);
  assert.ok(!seenCss.has(face.cssFamily), `${where} cssFamily is used twice`);
  seenCss.add(face.cssFamily);

  assert.ok(face.styles && face.styles.regular,
    `${where} must at least have a regular style`);
  for (const style of Object.keys(face.styles)) {
    assert.ok(STYLES.includes(style), `${where} has unknown style "${style}"`);

    const relative = face.styles[style];
    const file = path.join(FONTS, relative);
    assert.ok(fs.existsSync(file), `${where} ${style} is missing: fonts/${relative}`);
    files += 1;

    // TrueType `glyf` only, matching Win98 GDI, which had no CFF rasterizer.
    // A .ttf extension proves nothing: an OTTO sfnt can wear one.
    const header = Buffer.alloc(4);
    const handle = fs.openSync(file, 'r');
    fs.readSync(handle, header, 0, 4, 0);
    fs.closeSync(handle);
    const version = header.readUInt32BE(0);
    assert.ok(version === 0x00010000 || version === 0x74727565,
      `fonts/${relative} must be a glyf TrueType, not CFF/OTTO ` +
      `(sfnt version 0x${version.toString(16)})`);
  }

  // Tier 1 exists to make layout exact, and layout goes wrong at the first
  // bold or italic run if a style has to be synthesized.
  if (face.tier === 1) {
    for (const style of STYLES) {
      assert.ok(face.styles[style],
        `tier 1 ${where} must ship ${style}: synthesizing it would change metrics`);
    }
  }

  if (face.embeddedStrikes) {
    for (const style of Object.keys(face.embeddedStrikes)) {
      assert.ok(face.styles[style],
        `${where} claims strikes for a style it does not ship: ${style}`);
      const ppems = face.embeddedStrikes[style];
      assert.ok(Array.isArray(ppems) && ppems.length > 0,
        `${where} ${style} strike list must be non-empty`);
      for (const ppem of ppems) {
        assert.ok(Number.isInteger(ppem) && ppem > 0 && ppem < 256,
          `${where} ${style} has an implausible ppem ${ppem}`);
      }
      const sorted = [...ppems].sort((a, b) => a - b);
      assert.deepStrictEqual(ppems, sorted,
        `${where} ${style} strikes must be listed in ascending ppem`);
    }
  }

  // A generated .FON is a claim that this face reaches the pixel-exact path.
  // If the file is not there the claim is worse than absent, because face
  // selection would look for it and fall back silently.
  if (face.generatedFon) {
    for (const style of Object.keys(face.generatedFon)) {
      assert.ok(face.embeddedStrikes && face.embeddedStrikes[style],
        `${where} claims a generated FON for ${style} with no strikes to build it from`);
      const generated = path.join(FONTS, face.generatedFon[style]);
      assert.ok(fs.existsSync(generated),
        `${where} ${style} names a missing FON: fonts/${face.generatedFon[style]}`);
    }
  }
}

// The faces named as deliberately unsubstituted must not also be substituted:
// two answers for one face is how a manifest starts lying.
for (const name of Object.keys(manifest.unsubstituted || {})) {
  if (name === 'comment') continue;
  assert.ok(!seenWin98.has(name),
    `"${name}" is both substituted and listed as unsubstituted`);
}

console.log(
  `PASS  fonts/substitutions.json: ${manifest.faces.length} faces, ` +
  `${files} font files, all present, all glyf TrueType, all privately named`);
