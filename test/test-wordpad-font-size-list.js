#!/usr/bin/env node
//
// WordPad's toolbar size dropdown, driven through several real faces at sizes
// no picker offers.
//
// WordPad fills that dropdown from EnumFontFamiliesA(<the face the toolbar is
// showing>) each time the list drops. The font enumerator used to treat the
// strike cached by drawing that same face as a prior sighting of the family,
// which removed the family from enumeration entirely -- so as soon as the
// document had been drawn in Times New Roman, the callback never fired and the
// dropdown was empty. Applying a face at 13pt/17pt/23pt/31pt caches strikes at
// sizes nothing else would produce, which is exactly the state that broke it.
//
// A TrueType face gets WordPad's standard scalable size list. (A bitmap face
// is a different contract -- its real, short strike list -- and
// test/test-font-enum-sizes.js holds that one, since WordPad's own callback
// discards RASTER_FONTTYPE before it reaches the list.)
//
//   node test/test-wordpad-font-size-list.js

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RUN_JS = path.join(ROOT, 'test', 'run.js');
const WORDPAD = path.join(ROOT, 'test', 'binaries', 'win98-apps', 'wordpad.exe');

// Four TrueType faces WordPad mounts, each applied at a size its own dropdown
// does not list, so the strike cached by the redraw cannot be one the stock
// bootstrap already made.
const FACES = [
  { face: 'Georgia', points: 13 },
  { face: 'Arial Narrow', points: 17 },
  { face: 'Copperplate Gothic Bold', points: 23 },
  { face: 'Times New Roman', points: 31 },
];

const SIZE_COMBO = 166;   // the formatting toolbar's size combobox
const NAME_COMBO = 165;   // ... and its face combobox
const SIZE_COMBO_HIT = { x: 160, y: 80 };  // its drop button
const EXPECTED_SIZES = ['8', '9', '10', '11', '12', '14', '16', '18', '20',
  '22', '24', '26', '28', '36', '48', '72'];

function buildInput() {
  const events = [
    '380:click:300:300',   // focus the document
    '400:keypress:65',     // ... and put a character in it, so it gets drawn
  ];
  FACES.forEach(({ face, points }, index) => {
    const base = 420 + index * 260;
    events.push(`${base}:set-focus-charformat-face:${face}:${points * 20}:${face}`);
    events.push(`${base + 40}:click:${SIZE_COMBO_HIT.x}:${SIZE_COMBO_HIT.y}`);
    events.push(`${base + 60}:dump-combobox:${SIZE_COMBO}:${face}`);
    events.push(`${base + 80}:keydown:27`);          // close the dropped list
    events.push(`${base + 140}:click:200:200`);      // and take focus back
  });
  const end = 420 + FACES.length * 260;
  events.push(`${end}:dump-combobox:${NAME_COMBO}:faces`);
  events.push(`${end + 20}:stop`);
  return events.join(',');
}

function parseDump(lines, prefix, label) {
  const line = lines.find(l => l.startsWith(`[input] ${prefix} ${label}:`));
  if (!line) return null;
  if (!/count=\d+/.test(line)) return { line, count: -1, items: [] };
  const count = parseInt(line.match(/count=(-?\d+)/)[1], 10);
  const items = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]);
  return { line, count, items };
}

function main() {
  const out = execFileSync('node', [
    RUN_JS, '--exe=' + WORDPAD, '--no-close', '--quiet-blocks', '--quiet-api',
    '--batch-size=50000', '--max-batches=1700',
    '--input=' + buildInput(),
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  const lines = out.split('\n');

  const failures = [];
  for (const { face, points } of FACES) {
    const applied = lines.find(l =>
      l.startsWith(`[input] set-focus-charformat-face ${face}:`));
    if (!applied || !/ret=0x1\b/.test(applied)) {
      failures.push(`${face} ${points}pt was never applied to the document ` +
        `(${applied ? applied.trim() : 'no set-focus-charformat-face line'})`);
      continue;
    }
    const dump = parseDump(lines, 'dump-combobox', face);
    if (!dump) {
      failures.push(`no size-combo dump for ${face} — did the dropdown open?`);
      continue;
    }
    console.log(`${face.padEnd(24)} ${String(points).padStart(2)}pt  ` +
      `sizes=${dump.count} ${dump.items.join(',') || '(empty)'}`);
    if (dump.count <= 0) {
      failures.push(`the size dropdown is empty after applying ${face} at ${points}pt`);
      continue;
    }
    const missing = EXPECTED_SIZES.filter(size => !dump.items.includes(size));
    if (missing.length) {
      failures.push(`the ${face} size list is missing ${missing.join(',')}`);
    }
  }

  // The face list is built the same way, from an unfiltered enumeration, and
  // must not erode as faces get used either.
  const faces = parseDump(lines, 'dump-combobox', 'faces');
  if (!faces || faces.count < 1) {
    failures.push('the toolbar face list came back empty');
  } else {
    console.log(`face list                  ${faces.count} faces`);
    for (const { face } of FACES) {
      if (!faces.items.includes(face)) {
        failures.push(`${face} is gone from the face list after being used`);
      }
    }
  }

  if (failures.length) {
    for (const failure of failures) console.log(`FAIL  ${failure}`);
    process.exit(1);
  }
  console.log('PASS  every face keeps a populated size dropdown after use');
}

main();
