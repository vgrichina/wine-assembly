#!/usr/bin/env node
'use strict';

// Reproduce Pipe Dream's original WEPUTIL About box from the archived WEP2
// binaries. The Win98 reference is 285x280 px, with a 260x65 logo panel and a
// dynamically assigned 32x32 Pipe icon beside the title/credits.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const WEP2 = path.join(ROOT, 'test', 'binaries', 'wep16', 'WEP2');
const PIPE = path.join(WEP2, 'PIPE.EXE');
const WEPUTIL = path.join(WEP2, 'WEPUTIL.DLL');
const OPTIONAL_WASM = process.env.WINE_ASSEMBLY_WASM || '';

if (!fs.existsSync(PIPE) || !fs.existsSync(WEPUTIL)) {
  console.log('SKIP  Pipe Dream About corpus is not installed');
  process.exit(0);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

assert.strictEqual(sha256(PIPE),
  '877698244e2d9ecad690d9311a04eb40286f8f3cf20cc3b7d457a685c976a597');
assert.strictEqual(sha256(WEPUTIL),
  '7bd426e4d1ca0afea88e5ad22d9add44d4df79432cdc4b5cb165c10c6023e6bd');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win16-pipe-about-'));
try {
  const screenshot = path.join(outDir, 'about.png');
  const args = [path.join(ROOT, 'test', 'run.js'), '--app=wep16_pipe',
    '--no-close', '--batch-size=20000', '--max-batches=110',
    '--quiet-api', '--quiet-blocks', '--trace-ctrl'];
  if (OPTIONAL_WASM) args.push('--no-build', `--wasm=${OPTIONAL_WASM}`);
  args.push('--input=30:mousedown:320:220,31:mouseup:320:220,' +
    '42:mousedown:115:31,43:mouseup:115:31,' +
    '55:mousedown:145:152,56:mouseup:145:152,' +
    `75:dlg-dump:about,90:png:${screenshot},105:stop`);

  const output = execFileSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.doesNotMatch(output, /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError/);
  assert.match(output,
    /skip:no-class hwnd=0x[0-9a-f]+ class0 at \d+,\d+ 285x280 /,
    'Win16 140x128 DLU About template should have the Win98 285x280 frame');
  assert.match(output,
    /CreateWindow.*style=0x5000000b pos=9,10 size=260x65 menu=301/,
    'the WEPUTIL owner-draw logo panel should fit inside the dialog');
  assert.match(output,
    /dlg-dump:about:.*id=701 cls=3.*wh=32,32.*imageOrd=[1-9]\d*/,
    'STM_SETICON should attach and size the archived Pipe icon');
  assert.match(output,
    /dlg-dump:about:[\s\S]*id=702 cls=3[\s\S]*text="Pipe Dream"[\s\S]*id=703 cls=3[\s\S]*by Wes Cherry[\s\S]*id=704 cls=3[\s\S]*Copyright © 1991 Microsoft Corp\./,
    'the original WEPUTIL title and credits should remain visible');
  assert.match(output, /dlg-dump:about:[\s\S]*id=1 cls=1[\s\S]*text="OK"/,
    'the OK button should remain inside the frame');

  assert(fs.existsSync(screenshot) && fs.statSync(screenshot).size > 14000,
    'About should render a non-empty screenshot');
  const png = PNG.sync.read(fs.readFileSync(screenshot));
  let iconPixels = 0;
  for (let y = 177; y < 209; y++) {
    for (let x = 199; x < 231; x++) {
      const p = (y * png.width + x) * 4;
      const r = png.data[p];
      const g = png.data[p + 1];
      const b = png.data[p + 2];
      if (r !== 0xc0 || g !== 0xc0 || b !== 0xc0) iconPixels++;
    }
  }
  assert(iconPixels > 250,
    `the Pipe icon should have visible pixels (found ${iconPixels})`);

  console.log('PASS  Win16 Pipe Dream About matches archived Win98 geometry');
  console.log('PASS  Win16 Pipe Dream About retains and paints its NE icon');
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
