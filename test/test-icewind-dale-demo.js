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
const AFTER = path.join(OUT, 'modal.png');

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
const input = [
  `340:png:${BEFORE}`,
  '350:mousemove:480:175',
  '370:mousedown:480:175',
  '390:mouseup:480:175',
  `520:png:${AFTER}`,
].join(',');
const result = spawnSync(process.execPath, [
  path.join(__dirname, 'run.js'),
  `--exe=${EXE}`,
  '--vfs-include=**/*',
  '--vfs-drive=D',
  '--max-batches=560',
  '--batch-size=50000',
  '--repaint-every=20',
  '--max-seconds=60',
  '--quiet-api',
  '--quiet-blocks',
  '--no-close',
  `--input=${input}`,
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 180000,
  maxBuffer: 32 * 1024 * 1024,
});
const output = `${result.stdout || ''}\n${result.stderr || ''}`;
if (result.status !== 0) console.error(output.split('\n').slice(-80).join('\n'));
assert.strictEqual(result.status, 0, `Icewind Dale demo run failed (${result.signal || result.status})`);
assert(output.includes('title="JigSawedME"'), 'the real game window was not created');
assert(!/UNIMPLEMENTED API|UNHANDLED EXCEPTION|Critical Error/.test(output),
  'the demo reported a runtime failure');

const before = PNG.sync.read(fs.readFileSync(BEFORE));
const after = PNG.sync.read(fs.readFileSync(AFTER));
assert.strictEqual(`${before.width}x${before.height}`, '640x480');
assert.strictEqual(`${after.width}x${after.height}`, '640x480');

let changed = 0;
let colorful = 0;
const colors = new Set();
for (let i = 0; i < before.data.length; i += 4) {
  const r = before.data[i], g = before.data[i + 1], b = before.data[i + 2];
  if (Math.max(r, g, b) - Math.min(r, g, b) > 30) colorful++;
  colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
  const delta = Math.abs(r - after.data[i])
    + Math.abs(g - after.data[i + 1]) + Math.abs(b - after.data[i + 2]);
  if (delta > 36) changed++;
}
const pixels = before.width * before.height;
assert(colorful / pixels > 0.25 && colors.size > 250,
  'the Icewind Dale menu did not render as a detailed color frame');
assert(changed / pixels > 0.12,
  'the click did not open the centered menu dialog');

console.log(`PASS  Icewind Dale demo: rendered menu, click opened modal (${(changed / pixels * 100).toFixed(1)}% frame change)`);

