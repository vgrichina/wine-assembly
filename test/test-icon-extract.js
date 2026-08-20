#!/usr/bin/env node

// The desktop icon extractor, over both executable formats.
//
//   node test/test-icon-extract.js
//
// lib/resources-icon.js reads an icon straight out of an executable so the
// desktop can show the app's own picture. It only ever understood the PE
// resource tree, so every 16-bit NE on the desktop silently fell back to its
// emoji -- silently because a missing icon is indistinguishable from an app
// that simply has none. This checks a known icon out of each container, and
// that a real image comes back rather than an empty one.

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { extractIconRgba } = require('../lib/resources-icon');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'output', 'icon-extract');
const NE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'MSHEARTS.EXE');
const PE = path.join(ROOT, 'test', 'binaries', 'win98-apps', 'notepad98.exe');

let passed = 0;
let failed = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail && !ok ? ` -- ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

// An icon that decoded but drew nothing is the failure worth catching: a wrong
// palette or a misplaced AND mask gives a full-size, fully transparent image
// that every downstream check would call success.
function opaquePixels(icon) {
  let n = 0;
  for (let i = 3; i < icon.pixels.length; i += 4) if (icon.pixels[i] > 128) n++;
  return n;
}

function distinctColors(icon) {
  const seen = new Set();
  for (let i = 0; i < icon.pixels.length; i += 4) {
    if (icon.pixels[i + 3] <= 128) continue;
    seen.add((icon.pixels[i] << 16) | (icon.pixels[i + 1] << 8) | icon.pixels[i + 2]);
  }
  return seen.size;
}

for (const [label, file, expect] of [['NE (16-bit)', NE, 32], ['PE (32-bit)', PE, 32]]) {
  if (!fs.existsSync(file)) {
    console.log(`SKIP  ${label}: ${path.relative(ROOT, file)} not present`);
    continue;
  }
  const icon = extractIconRgba(fs.readFileSync(file));
  check(`${label}: an icon came out of ${path.basename(file)}`, !!icon, 'null');
  if (!icon) continue;
  check(`${label}: ${icon.w}x${icon.h}`, icon.w === expect && icon.h === expect,
    `${icon.w}x${icon.h}`);
  check(`${label}: the pixel buffer matches the dimensions`,
    icon.pixels.length === icon.w * icon.h * 4, String(icon.pixels.length));
  const opaque = opaquePixels(icon);
  check(`${label}: it has something drawn on it (${opaque} opaque pixels)`,
    opaque > icon.w * icon.h / 8, String(opaque));
  const colors = distinctColors(icon);
  check(`${label}: it is a picture, not a silhouette (${colors} colours)`,
    colors >= 3, String(colors));

  // Numbers cannot tell a correct icon from a scrambled one of the right size.
  // Write it out so a person can look.
  fs.mkdirSync(OUT, { recursive: true });
  const png = new PNG({ width: icon.w, height: icon.h });
  png.data.set(icon.pixels);
  fs.writeFileSync(path.join(OUT, `${path.basename(file, path.extname(file))}.png`),
    PNG.sync.write(png));
}

// Not every executable has an icon, and the caller distinguishes "no icon"
// from a thrown error only by getting null back.
check('a buffer that is not an executable returns null',
  extractIconRgba(Buffer.from('not an exe at all, not even close')) === null);
check('a truncated MZ returns null instead of throwing',
  extractIconRgba(Buffer.from('MZ')) === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
