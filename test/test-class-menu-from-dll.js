#!/usr/bin/env node
// A window's menu can come from its class, and the class can come from a DLL.
//
// HyperTerminal is the case that found this: hypertrm.exe is a 24KB shell that
// loads hypertrm.dll, and the DLL registers SESSION_WINDOW with
// lpszMenuName="MainMenu". It never calls LoadMenu, and CreateWindowEx passes
// hMenu=0, so the only way to the menu is USER's class fallback -- which we had,
// but which resolved the resource against the EXE. The EXE has no RT_MENU at
// all (the four menus live in the DLL), so the lookup missed and HyperTerminal
// came up with a bare grey strip where File/Edit/View/Call/Transfer/Help
// belong. The fix is to run the lookup in WNDCLASS.hInstance's module.
//
// The check is pixels, not an internal count: the menu bar is drawn by the
// renderer from the parsed blob, so ink on that strip is the only evidence that
// the whole path -- find the class, read its hInstance, resolve RT_MENU in that
// module, parse it, hand it to the bar -- actually ran.
//
//   node test/test-class-menu-from-dll.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-apps', 'hypertrm.exe');
const DLL = path.join(ROOT, 'test', 'binaries', 'win98-apps', 'hypertrm.dll');

if (!fs.existsSync(EXE) || !fs.existsSync(DLL)) {
  console.log('SKIP  hypertrm.exe/hypertrm.dll not found');
  process.exit(0);
}

const shot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-classmenu-')),
  'hypertrm.png');

// No input at all: the menu belongs to the window, so it is there as soon as
// SESSION_WINDOW is up -- long before the "install a modem?" box is answered.
const log = execFileSync('node', [
  path.join(ROOT, 'test', 'run.js'), '--app=hypertrm', '--no-build', '--no-close',
  '--stuck-after=1000000', '--max-batches=6000', `--png=${shot}`,
], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });

assert(!/CRASH|UNIMPLEMENTED API/.test(log), 'HyperTerminal booted without crashing');

// The menu-bar strip, under the caption and left of where the longest label
// ends. Menu text is near-black on the 192-grey face; count anything that is
// neither the face nor its edge shades.
const png = PNG.sync.read(fs.readFileSync(shot));
let ink = 0;
for (let y = 44; y < 58 && y < png.height; y++) {
  for (let x = 8; x < 240 && x < png.width; x++) {
    const i = (y * png.width + x) * 4;
    const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
    if (r === g && g === b && (r === 192 || r === 255 || r === 128)) continue;
    ink++;
  }
}

// Six labels of dark 8pt text land well over a hundred pixels here; an empty
// strip lands on zero. Anything in between would be a partial parse.
assert(ink > 100, `menu bar has label ink -- ${ink} px`);
console.log(`PASS  a class menu named by a DLL-registered class renders (${ink} px of label ink)`);
