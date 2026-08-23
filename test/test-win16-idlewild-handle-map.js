#!/usr/bin/env node
'use strict';

// IdleWild draws its screensaver preview with a brush/pen it creates and
// deletes every frame. GDI.69 DeleteObject sampled "is this a real object"
// *after* the delete, by which time the record is already cleared — so the
// answer was 0 for a freshly deleted brush exactly as it is for a stock one,
// the Win16 handle mapping was never released, and each frame burned one of
// the 4096 slots. The map filled and $win16_h16 trapped at batch 419, which
// is why this run goes well past that.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const IDLEWILD = path.join(ROOT, 'test', 'binaries', 'wep16', 'WEP1', 'IDLEWILD.EXE');
const OPTIONAL_WASM = process.env.WINE_ASSEMBLY_WASM || '';

if (!fs.existsSync(IDLEWILD)) {
  console.log('SKIP  Entertainment Pack 1 corpus is not installed');
  process.exit(0);
}

const args = [path.join(ROOT, 'test', 'run.js'), '--app=wep16_idlewild',
  '--no-close', '--max-batches=600', '--quiet-api', '--quiet-blocks'];
if (OPTIONAL_WASM) args.push('--no-build', `--wasm=${OPTIONAL_WASM}`);

const output = execFileSync(process.execPath, args, {
  cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024,
});

assert.doesNotMatch(output, /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError/,
  'IdleWild must survive past the batch-419 handle-map exhaustion');
// 0xCA16A9F4 is the marker $win16_h16 logs just before trapping on a full map.
assert.doesNotMatch(output, /0xca16a9f4/i,
  'the Win16 handle map must not fill — DeleteObject has to release its slot');
assert.match(output, /\[CreateWindow\] hwnd=0x10001 title="IdleWild"/,
  'the IdleWild frame should still be created');

console.log('PASS test-win16-idlewild-handle-map');
