#!/usr/bin/env node

'use strict';

// Local-only acceptance for the official Icewind Dale demo. The package's
// README prohibits redistribution, so this test skips unless the ignored
// candidate fixture has been fetched and unpacked locally.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const INSTALL = path.join(ROOT, 'test/binaries/candidates/icewind-dale-demo',
  'installed-extracted/Recommended_compressed');
const EXE = path.join(INSTALL, 'IDDemo.exe');
const KEY = path.join(INSTALL, 'CHITIN.KEY');
const DISC_MARKER = path.join(INSTALL, 'Data/IWDCD.2');
const OUT = path.join(ROOT, 'build/local-candidate-smoke/icewind-dale-demo');
const BEFORE = path.join(OUT, 'menu.png');
const PARTY = path.join(OUT, 'party-formation.png');
const CHARACTER = path.join(OUT, 'character-generation.png');
const SOUND = path.join(OUT, 'sound-selection.png');
const PARTY_READY = path.join(OUT, 'party-with-created-character.png');
const GAMEPLAY = path.join(OUT, 'easthaven-gameplay.png');
const SAVE_EXPORT = path.join(OUT, 'saved-vfs');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  Icewind Dale demo missing; run node tools/fetch-candidate-corpus.js --id=icewind-dale-demo');
  process.exit(0);
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

assert.strictEqual(sha256(EXE),
  'b94816d10029cb99c0315f175330c917be2fff298394e853e2764973d8d13af4',
  'IDDemo.exe does not match the pinned official demo');
assert.strictEqual(sha256(KEY),
  'c04920810d6663f6e23779c16dadbed88408b4a0528fd79c686d81fd535f6292',
  'CHITIN.KEY does not match the pinned official demo');
assert(fs.existsSync(DISC_MARKER), 'the CD2 data merge is missing; refetch the candidate fixture');

fs.mkdirSync(OUT, { recursive: true });
for (const filename of [BEFORE, PARTY, CHARACTER, SOUND, PARTY_READY, GAMEPLAY]) {
  if (fs.existsSync(filename)) fs.unlinkSync(filename);
}
fs.rmSync(SAVE_EXPORT, { recursive: true, force: true });
const input = [
  '100:keydown:27', '102:keyup:27',
  '160:keydown:27', '162:keyup:27',
  '220:keydown:27', '222:keyup:27',
  '280:keydown:27', '282:keyup:27',
  `400:png:${BEFORE}`,
  '420:mousemove:480:175',
  '430:mousedown:480:175',
  '440:mouseup:480:175',
  `540:png:${PARTY}`,
  '570:mousemove:145:147',
  '580:mousedown:145:147',
  '590:mouseup:145:147',
  '720:mousemove:320:215',
  '730:mousedown:320:215',
  '740:mouseup:320:215',
  `850:png:${CHARACTER}`,
  '880:click:85:112',
  '1040:click:293:195',
  '1100:click:331:341',
  '1300:click:255:445',
  '1400:click:85:151',
  '1510:click:320:153',
  '1570:click:252:425',
  '1650:click:85:188',
  '1780:click:320:64',
  '1840:click:252:444',
  '1920:click:85:225',
  '2050:click:320:95',
  '2110:click:252:444',
  '2190:click:85:260',
  '2320:click:260:443',
  '2400:click:85:295',
  '2550:click:458:50',
  '2580:click:458:50',
  '2610:click:458:324',
  '2640:click:458:324',
  '2780:click:292:447',
  '2860:click:85:330',
  '3050:click:270:401',
  `3180:png:${SOUND}`,
  '3220:click:260:440',
  '3350:click:85:404',
  '3500:keydown:67', '3501:keypress:67', '3502:keyup:67',
  '3510:keydown:79', '3511:keypress:79', '3512:keyup:79',
  '3520:keydown:68', '3521:keypress:68', '3522:keyup:68',
  '3530:keydown:69', '3531:keypress:69', '3532:keyup:69',
  '3540:keydown:88', '3541:keypress:88', '3542:keyup:88',
  '3630:click:250:278',
  '3760:click:552:447',
  `3860:png:${PARTY_READY}`,
  '4000:click:552:431',
  '4010:set-batch-size:2000000',
  // Require the native loading frame to appear and then disappear. These waits
  // shift every later action, so host load cannot move Quick Save into startup.
  '4020:wait-canvas-dark-pixels:60000:307200:800',
  '4021:wait-canvas-dark-pixels:0:30000:1600',
  '4025:keydown:27', '4027:keyup:27',
  '4040:keydown:81', '4041:keypress:81', '4042:keyup:81',
  '4045:wait-vfs-file:1600:c:\\mpsave\\000000001-quick-save\\icewind.gam',
  `4060:png:${GAMEPLAY}`,
  '4070:stop',
].join(',');
const result = spawnSync(process.execPath, [
  path.join(__dirname, 'run.js'),
  '--app=icewind_dale_demo',
  '--max-batches=5700',
  '--batch-size=200000',
  '--time-scale=10',
  '--repaint-every=10',
  '--max-seconds=600',
  '--quiet-api',
  '--quiet-blocks',
  `--save-vfs=${SAVE_EXPORT}`,
  '--save-vfs-suffix=.gam',
  '--no-close',
  `--input=${input}`,
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 660000,
  maxBuffer: 32 * 1024 * 1024,
});
const output = `${result.stdout || ''}\n${result.stderr || ''}`;
if (result.status !== 0) console.error(output.split('\n').slice(-80).join('\n'));
assert.strictEqual(result.status, 0, `Icewind Dale demo run failed (${result.signal || result.status})`);
assert(output.includes('title="JigSawedME"'), 'the real game window was not created');
if (/UNIMPLEMENTED API|UNHANDLED EXCEPTION|Critical Error|Assertion failed/.test(output)) {
  console.error(output.split('\n').filter(line => /UNIMPLEMENTED API|UNHANDLED EXCEPTION|Critical Error|Assertion failed|MessageBox/.test(line)).slice(-40).join('\n'));
}
assert(!/UNIMPLEMENTED API|UNHANDLED EXCEPTION|Critical Error|Assertion failed/.test(output),
  'the demo reported a runtime failure');
assert(!/NO DISC IN DRIVE|Media Removed From Drive/i.test(output),
  'the demo fell back to its missing-CD path');
assert(fs.existsSync(GAMEPLAY),
  'the first-area loading/save gates did not complete before the local acceptance timeout');

const before = PNG.sync.read(fs.readFileSync(BEFORE));
const party = PNG.sync.read(fs.readFileSync(PARTY));
const character = PNG.sync.read(fs.readFileSync(CHARACTER));
const sound = PNG.sync.read(fs.readFileSync(SOUND));
const partyReady = PNG.sync.read(fs.readFileSync(PARTY_READY));
const gameplay = PNG.sync.read(fs.readFileSync(GAMEPLAY));
assert.strictEqual(`${before.width}x${before.height}`, '640x480');
assert.strictEqual(`${party.width}x${party.height}`, '640x480');
assert.strictEqual(`${character.width}x${character.height}`, '640x480');
assert.strictEqual(`${sound.width}x${sound.height}`, '640x480');
assert.strictEqual(`${partyReady.width}x${partyReady.height}`, '640x480');
assert.strictEqual(`${gameplay.width}x${gameplay.height}`, '640x480');

let partyChanged = 0;
let colorful = 0;
let labelPixels = 0;
const colors = new Set();
for (let i = 0; i < before.data.length; i += 4) {
  const r = before.data[i], g = before.data[i + 1], b = before.data[i + 2];
  if (Math.max(r, g, b) - Math.min(r, g, b) > 30) colorful++;
  colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
  const delta = Math.abs(r - party.data[i])
    + Math.abs(g - party.data[i + 1]) + Math.abs(b - party.data[i + 2]);
  if (delta > 36) partyChanged++;
}
for (const [y0, y1] of [[86, 101], [168, 184], [214, 230], [258, 274], [342, 358], [386, 402]]) {
  for (let y = y0; y < y1; y++) {
    for (let x = 420; x < 548; x++) {
      const i = (y * before.width + x) * 4;
      const r = before.data[i], g = before.data[i + 1], b = before.data[i + 2];
      if (Math.min(r, g, b) > 150 && Math.max(r, g, b) - Math.min(r, g, b) < 60) {
        labelPixels++;
      }
    }
  }
}
const pixels = before.width * before.height;
assert(colorful / pixels > 0.25 && colors.size > 250,
  'the Icewind Dale menu did not render as a detailed color frame');
assert(labelPixels > 500,
  `the Icewind Dale menu button labels are missing (${labelPixels} light glyph pixels)`);
assert(partyChanged / pixels > 0.75,
  `Create Game did not reach party formation (${(partyChanged / pixels * 100).toFixed(1)}% frame change)`);

function lightGlyphPixels(png, x0, y0, x1, y1) {
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (Math.min(r, g, b) > 145 && Math.max(r, g, b) - Math.min(r, g, b) < 70) count++;
    }
  }
  return count;
}

const generationTitle = lightGlyphPixels(character, 100, 20, 540, 75);
const generationInstructions = lightGlyphPixels(character, 205, 125, 430, 420);
const generationSteps = [
  [98, 129], [135, 165], [172, 201], [208, 237], [245, 275],
  [282, 311], [318, 347], [354, 383], [390, 420],
].filter(([y0, y1]) => lightGlyphPixels(character, 15, y0, 162, y1) > 30).length;
assert(generationTitle > 500 && generationInstructions > 1000 && generationSteps >= 8,
  `character generation did not render (${generationTitle} title, ${generationInstructions} instructions, ${generationSteps}/9 steps)`);

const soundSetLabels = lightGlyphPixels(sound, 175, 55, 455, 245);
const soundInstructions = lightGlyphPixels(sound, 175, 305, 460, 385);
let soundChanged = 0;
for (let i = 0; i < sound.data.length; i += 4) {
  const delta = Math.abs(sound.data[i] - character.data[i])
    + Math.abs(sound.data[i + 1] - character.data[i + 1])
    + Math.abs(sound.data[i + 2] - character.data[i + 2]);
  if (delta > 36) soundChanged++;
}
assert(soundSetLabels > 3500 && soundInstructions > 1000 && soundChanged / pixels > 0.18,
  `Appearance Done did not reach populated sound selection (${soundSetLabels} label pixels, ${soundInstructions} instructions, ${(soundChanged / pixels * 100).toFixed(1)}% frame change)`);

let gameplaySaveStatus = 0;
for (let y = 392; y < 435; y++) {
  for (let x = 70; x < 420; x++) {
    const i = (y * gameplay.width + x) * 4;
    const r = gameplay.data[i], g = gameplay.data[i + 1], b = gameplay.data[i + 2];
    if ((g > 80 && g > r + 25 && g > b + 20) ||
        (r > 90 && r > g + 30 && r > b + 30)) gameplaySaveStatus++;
  }
}
const portraitColors = new Set();
for (let y = 0; y < 72; y++) {
  for (let x = 580; x < 636; x++) {
    const i = (y * gameplay.width + x) * 4;
    portraitColors.add(`${gameplay.data[i] >> 4},${gameplay.data[i + 1] >> 4},${gameplay.data[i + 2] >> 4}`);
  }
}
let gameplayChanged = 0;
for (let i = 0; i < gameplay.data.length; i += 4) {
  const delta = Math.abs(gameplay.data[i] - partyReady.data[i])
    + Math.abs(gameplay.data[i + 1] - partyReady.data[i + 1])
    + Math.abs(gameplay.data[i + 2] - partyReady.data[i + 2]);
  if (delta > 36) gameplayChanged++;
}
assert(gameplaySaveStatus > 700 && portraitColors.size > 35 && gameplayChanged / pixels > 0.55,
  `first-area gameplay/save UI did not render (${gameplaySaveStatus} status glyph pixels, ${portraitColors.size} portrait colors, ${(gameplayChanged / pixels * 100).toFixed(1)}% frame change)`);

const quickSave = path.join(SAVE_EXPORT,
  'mpsave/000000001-quick-save/icewind.gam');
assert(fs.existsSync(quickSave), 'Quick Save did not write mpsave/000000001-quick-save/icewind.gam');
const quickSaveBytes = fs.readFileSync(quickSave);
assert(quickSaveBytes.includes(Buffer.from('codex\0', 'ascii')),
  'the Quick Save does not contain the created CODEX party member');

console.log(`PASS  Icewind Dale demo: CODEX reaches the first-area HUD and native Quick Save (${quickSaveBytes.length} byte ICEWIND.GAM)`);
