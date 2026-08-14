#!/usr/bin/env node

// Short Paint appearance regression. Switching tools repaints both the native
// owner-draw buttons and the options panel; neither may lose its glyphs or
// expose the red bitmap key used to construct the monochrome icon mask.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const OUT = path.join(ROOT, 'scratch', 'mspaint-tool-repaint');
const names = ['start', 'brush', 'airbrush', 'text', 'select'];
const shotNames = [...names, 'text-edit', 'text-committed'];
const shots = Object.fromEntries(shotNames.map(name => [name, path.join(OUT, `${name}.png`)]));

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of Object.values(shots)) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const input = [
  `7:png:${shots.start}`,
  '8:click:63:145', `10:png:${shots.brush}`,
  '11:click:38:170', `13:png:${shots.airbrush}`,
  '14:click:63:170', `16:png:${shots.text}`,
  '17:click:38:71', `19:png:${shots.select}`,
  '20:click:63:170',
  '21:mousedown:105:100', '22:mousemove:210:140', '23:mouseup:210:140',
  // Toggle Arial Bold in the floating palette, then return focus to the edit.
  // Paint installs the new HFONT on control 114 with WM_SETFONT.
  '24:click:307:63', '25:click:120:110',
  '26:send-focus-message:49:0:0:paint-font',
  '27:keydown:65', '27:keypress:65', '27:keyup:65',
  '28:keydown:66', '28:keypress:98', '28:keyup:66',
  '29:keydown:13', '29:keypress:13', '29:keyup:13',
  '30:keydown:67', '30:keypress:99', '30:keyup:67',
  '31:keydown:8', '31:keyup:8',
  '32:keydown:68', '32:keypress:100', '32:keyup:68',
  '33:dump-focus-state:paint-text', '33:dump-windows:text',
  `34:png:${shots['text-edit']}`,
  '35:click:63:145', `37:png:${shots['text-committed']}`,
  '38:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=39',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  runFailed = true;
  output = `${error.stdout || ''}${error.stderr || ''}`;
}
function analyze(file) {
  const image = PNG.sync.read(fs.readFileSync(file));
  let brightRed = 0;
  let buttonFace = 0;
  const iconInk = [];

  for (let y = 62; y < 262; y++) {
    for (let x = 26; x < 78; x++) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      if (r > 240 && g < 24 && b < 24) brightRed++;
      if (Math.abs(r - 192) <= 2 && Math.abs(g - 192) <= 2 && Math.abs(b - 192) <= 2) {
        buttonFace++;
      }
    }
  }

  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 2; column++) {
      let ink = 0;
      for (let y = 64 + row * 25; y < 82 + row * 25; y++) {
        for (let x = 29 + column * 25; x < 48 + column * 25; x++) {
          const i = (y * image.width + x) * 4;
          const r = image.data[i];
          const g = image.data[i + 1];
          const b = image.data[i + 2];
          const face = Math.abs(r - 192) <= 2 && Math.abs(g - 192) <= 2 && Math.abs(b - 192) <= 2;
          const white = r > 245 && g > 245 && b > 245;
          if (!face && !white) ink++;
        }
      }
      iconInk.push(ink);
    }
  }

  let optionsInk = 0;
  for (let y = 264; y < 326; y++) {
    for (let x = 29; x < 70; x++) {
      const i = (y * image.width + x) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      if (!(Math.abs(r - 192) <= 2 && Math.abs(g - 192) <= 2 && Math.abs(b - 192) <= 2)) {
        optionsInk++;
      }
    }
  }
  return { brightRed, buttonFace, iconInk, optionsInk };
}

assert(!runFailed, `Paint repaint run failed:\n${output.slice(-3000)}`);
for (const file of Object.values(shots)) {
  assert(fs.existsSync(file) && fs.statSync(file).size > 0, `missing screenshot: ${file}`);
}

const results = Object.fromEntries(names.map(name => [name, analyze(shots[name])]));
for (const [name, result] of Object.entries(results)) {
  assert(result.brightRed < 20, `${name}: red mask leaked into tools (${result.brightRed} pixels)`);
  assert(result.buttonFace > 5500, `${name}: tool button faces were wiped (${result.buttonFace} pixels)`);
  assert(Math.min(...result.iconInk) >= 15,
    `${name}: one or more tool glyphs disappeared (${result.iconInk.join(',')})`);
}

// A pressed owner-draw button has a dithered interior, making its inner-pixel
// count much larger than an unpressed glyph. These indices follow Paint's
// row-major 2x8 tool layout.
assert(results.brush.iconInk[7] > 150, 'brush button did not repaint pressed');
assert(results.airbrush.iconInk[8] > 150, 'airbrush button did not repaint pressed');
assert(results.text.iconInk[9] > 150, 'text button did not repaint pressed');
assert(results.select.iconInk[0] > 150, 'selection button did not repaint pressed');

assert(results.brush.optionsInk > results.start.optionsInk + 100, 'brush options did not render');
assert(results.airbrush.optionsInk > results.start.optionsInk + 300, 'airbrush options did not render');
assert(results.text.optionsInk > results.start.optionsInk + 700, 'text options did not render');
assert(/Draws using a brush/.test(output) && /Draws using an airbrush/.test(output) &&
  /Inserts text/.test(output) && /Selects a free-form part/.test(output),
'tool clicks did not reach all four native controls');

assert(/dump-focus-state paint-text:.*class=2 id=114 .*len=4 .*lineCount=2 text="Ab\\nd"/.test(output),
  'Paint text entry did not preserve multiline typing and Backspace in its native EDIT control');
assert(/send-focus-message paint-font:.*msg=0x31 .*ret=0x4000[0-9a-f]+/.test(output),
  'Paint text edit did not retain the HFONT installed from its Fonts palette');
assert(/window:text .*parent=0x0 .*visible=true .*title="Fonts"/.test(output),
  'Paint Fonts palette is not a visible top-level floating toolbar');
const paintWindow = output.match(/window:text hwnd=65537 .* z=(\d+) /);
const fontsWindow = output.match(/window:text .*parent=0x0 owner=0x10001 .* z=(\d+) .*title="Fonts"/);
assert(paintWindow && fontsWindow && Number(fontsWindow[1]) > Number(paintWindow[1]),
  'Paint Fonts palette did not remain above its owner after focus returned to the text edit');

const startImage = PNG.sync.read(fs.readFileSync(shots.start));
const textEditImage = PNG.sync.read(fs.readFileSync(shots['text-edit']));
const committedImage = PNG.sync.read(fs.readFileSync(shots['text-committed']));
let antialiasedTextPixels = 0;
for (let y = 99; y < 147; y++) {
  for (let x = 104; x < 217; x++) {
    const i = (y * textEditImage.width + x) * 4;
    const r = textEditImage.data[i];
    const g = textEditImage.data[i + 1];
    const b = textEditImage.data[i + 2];
    if (r === g && g === b && r > 0 && r < 255) antialiasedTextPixels++;
  }
}
assert.strictEqual(antialiasedTextPixels, 0,
  `Paint text edit retained ${antialiasedTextPixels} antialiased gray pixels`);
let committedInk = 0;
for (let y = 97; y < 149; y++) {
  for (let x = 102; x < 219; x++) {
    const i = (y * committedImage.width + x) * 4;
    const before = (y * startImage.width + x) * 4;
    if (committedImage.data[i] !== startImage.data[before] ||
        committedImage.data[i + 1] !== startImage.data[before + 1] ||
        committedImage.data[i + 2] !== startImage.data[before + 2]) committedInk++;
  }
}
assert(committedInk >= 5, `Paint did not commit typed text to the canvas (${committedInk} pixels)`);

console.log('PASS  Paint tool glyphs survive brush/airbrush/text/selection repaints');
console.log('PASS  Paint tool mask remains transparent in all five snapshots');
console.log('PASS  Paint pressed buttons and tool-option glyphs render correctly');
console.log('PASS  Paint text glyph coverage is thresholded to Win98-style binary pixels');
console.log(`PASS  Paint Fonts palette installs its font and commits multiline text (${committedInk} pixels)`);
