#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const exe = path.join(root,
  'test/binaries/candidates/heroes-3-demo-installer/installed-extracted/Program_Files/h3demo.exe');
if (!fs.existsSync(exe)) {
  console.log('SKIP Heroes III local candidate payload is not present');
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'heroes3-demo-launch-'));
const screenshot = path.join(temp, 'startup.png');
const run = spawnSync(process.execPath, [
  'test/run.js',
  '--app=heroes3_demo',
  '--screen=800x600',
  '--max-batches=3000',
  '--batch-size=20000',
  '--stuck-after=1000000',
  '--quiet-api',
  '--quiet-blocks',
  '--repaint-every=10',
  '--no-close',
  '--dx-surfaces',
  '--count=0x4c9480,0x52f200,0x4c9492,0x4c9652',
  `--png=${screenshot}`,
], {
  cwd: root,
  encoding: 'utf8',
  timeout: 45000,
  maxBuffer: 16 * 1024 * 1024,
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
assert.strictEqual(run.error, undefined, run.error && run.error.message);
assert.strictEqual(run.status, 0, output.slice(-4000));
for (const marker of [
  'DLL: BINKW32.DLL',
  'DLL: MSS32.DLL',
  'DLL: SMACKW32.DLL',
  'Patching EXE imports: mss32.dll',
  'title="Heroes of Might and Magic III"',
  '[LoadLibrary] mp3dec.asi loaded',
]) {
  assert(output.includes(marker), `missing launch marker ${marker}\n${output.slice(-4000)}`);
}
assert(!/unimplemented:/i.test(output), `launch reached an unimplemented API\n${output.slice(-4000)}`);
assert(!output.includes('[Exit] code=6978243'),
  `Heroes III returned through its top-level startup exception path\n${output.slice(-4000)}`);
for (const address of ['0x004c9480', '0x0052f200', '0x004c9492', '0x004c9652']) {
  assert(output.includes(`  ${address} = 1`),
    `startup did not pass ${address}\n${output.slice(-4000)}`);
}
const primary = output.match(/slot=1 800x600 bpp=16 .*colors=(\d+).*nonZero=(\d+)\//);
assert(primary && Number(primary[1]) > 20 && Number(primary[2]) > 100,
  `the primary DirectDraw surface remained blank\n${output.slice(-4000)}`);

const png = PNG.sync.read(fs.readFileSync(screenshot));
assert.strictEqual(png.width, 800);
assert.strictEqual(png.height, 600);
let nonBlack = 0;
const colors = new Set();
for (let i = 0; i < png.data.length; i += 4) {
  const r = png.data[i];
  const g = png.data[i + 1];
  const b = png.data[i + 2];
  const a = png.data[i + 3];
  if (a && (r || g || b)) nonBlack++;
  colors.add(`${r},${g},${b},${a}`);
}
assert(nonBlack > 50000,
  `Heroes III startup frame is effectively black (${nonBlack} lit pixels)`);
assert(colors.size > 20,
  `Heroes III startup frame lacks rendered detail (${colors.size} colors)`);

console.log('PASS Heroes III mounts the complete local payload and loads native middleware');
console.log(`PASS Heroes III clears sound init and renders its 3DO startup frame (${nonBlack} lit pixels, ${colors.size} colors)`);
