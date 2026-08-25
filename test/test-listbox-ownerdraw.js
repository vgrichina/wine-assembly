#!/usr/bin/env node
// An LBS_OWNERDRAW* listbox belongs to its owner: USER asks how tall a row is
// (WM_MEASUREITEM) and then hands each visible row to the owner to paint
// (WM_DRAWITEM). We used to do neither -- every listbox drew its item strings
// itself at a fixed 16px row -- and HyperTerminal's "choose an icon" list came
// up as the string "Hilgraeve is Great !!!" repeated down the list, because for
// an owner-draw listbox the item string is scratch storage, not a label.
//
// HyperTerminal is the case that found it, and it is a good witness: its
// dlgproc paints a row by calling DrawIcon on the DC we hand it, so a DrawIcon
// on the listbox's own child DC is proof the whole path ran. The y coordinate
// is the second half of the check -- the owner centres a 32px icon in the row
// it was told about, so against our old 16px row it drew at y=-6, eight pixels
// above the item. A non-negative y means WM_MEASUREITEM was asked and answered.
//
// (The icons themselves stay blank here: they live in hticons.dll, which we do
// not ship. That is an asset gap, and it is exactly why this test reads the
// call rather than the pixels.)
//
//   node test/test-listbox-ownerdraw.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-apps', 'hypertrm.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  hypertrm.exe not found');
  process.exit(0);
}

// "Install a modem?" -> No, which is what puts Connection Description (and its
// icon list) on screen.
const log = execFileSync('node', [
  path.join(ROOT, 'test', 'run.js'), '--app=hypertrm', '--no-build', '--no-close',
  '--stuck-after=1000000', '--max-batches=9000',
  '--input=3000:mousedown:355:277,3050:mouseup:355:277',
  '--trace-api=DrawIcon',
], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });

assert(!/CRASH|UNIMPLEMENTED API/.test(log), 'HyperTerminal reached the dialog without crashing');

// DrawIcon(hdc, x, y, hIcon) -- y is printed as a hex dword, so a row drawn
// above its item shows up as 0xffff_fffa rather than a negative number.
const calls = [];
for (const line of log.split('\n')) {
  const m = /DrawIcon\(0x([0-9a-f]+), 0x([0-9a-f]+), 0x([0-9a-f]+),/.exec(line);
  if (m) calls.push({ hdc: parseInt(m[1], 16), x: parseInt(m[2], 16), y: parseInt(m[3], 16) | 0 });
}

assert(calls.length > 0, 'the owner painted at least one item (WM_DRAWITEM dispatched)');

// A child control's DC is hwnd + 0x40000 -- see the listbox WM_PAINT path.
const onChildDc = calls.filter(c => (c.hdc & 0x40000) !== 0);
assert(onChildDc.length > 0,
  `the owner drew onto the listbox's own DC -- ${calls.map(c => '0x' + c.hdc.toString(16)).join(', ')}`);

const above = onChildDc.filter(c => c.y < 0);
assert(above.length === 0,
  `every row was painted inside its item rect -- ${above.length} of ${onChildDc.length} landed above it`);

console.log(`PASS  an owner-draw listbox is measured and drawn by its owner ` +
  `(${onChildDc.length} WM_DRAWITEM paint(s), lowest y=${Math.min(...onChildDc.map(c => c.y))})`);
