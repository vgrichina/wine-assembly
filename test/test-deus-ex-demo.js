#!/usr/bin/env node

'use strict';

// Local-only acceptance for the official Deus Ex demo. Its bundled license
// does not grant redistribution, so no game files are tracked or deployed.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test/binaries/candidates/deus-ex-demo/installed');
const SYSTEM = path.join(FIXTURE, 'system');
const EXE = path.join(SYSTEM, 'deusex.exe');
const CORE = path.join(SYSTEM, 'core.dll');
const ENTRY = path.join(FIXTURE, 'maps/entry.dx');
const OUT = path.join(ROOT, 'build/local-candidate-smoke/deus-ex-demo');
const SCREEN = path.join(OUT, 'animated-intro.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  Deus Ex demo missing; run node tools/fetch-candidate-corpus.js --id=deus-ex-demo');
  process.exit(0);
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

assert.strictEqual(sha256(EXE),
  '2ed115d9dc93582273830d9ae38f92ab4379842459e24eaec11390f312d5af5f');
assert.strictEqual(sha256(CORE),
  '2de35e0b4cf498e3587c76c0d0d332e5c29e1915986a79fa1521d8124a4c6167');
assert.strictEqual(sha256(ENTRY),
  '3cf7df2a0538e4e177f19c184849a5869499af8c9a3bfb6386483ab22d57a931');

fs.mkdirSync(OUT, { recursive: true });
const ini = fs.readFileSync(path.join(SYSTEM, 'deusex.ini'), 'utf8');
for (const setting of [
  'FirstRun=1002',
  'GameRenderDevice=SoftDrv.SoftwareRenderDevice',
  'RenderDevice=SoftDrv.SoftwareRenderDevice',
  'StartupFullscreen=False',
  'UseSound=True',
]) {
  assert(ini.includes(setting), `prepared DeusEx.ini is missing ${setting}`);
}

const dlls = [
  'Window.dll', 'Core.dll', 'Engine.dll', 'WinDrv.dll', 'SoftDrv.dll',
  'Render.dll', 'Fire.dll', 'IpDrv.dll', 'Extension.dll', 'ConSys.dll',
  'DeusEx.dll', 'DeusExText.dll', 'Galaxy.dll',
].map(name => path.join(SYSTEM, name.toLowerCase()));
for (const dll of dlls) assert(fs.existsSync(dll), `missing seeded DLL ${path.basename(dll)}`);

const input = [
  `550:png:${SCREEN}`,
].join(',');
const result = spawnSync(process.execPath, [
  path.join(__dirname, 'run.js'),
  '--app=deus_ex_demo',
  '--max-batches=575',
  '--batch-size=200000',
  '--tick-ms-per-batch=25',
  '--max-seconds=180',
  '--repaint-every=10',
  '--quiet-api',
  '--quiet-blocks',
  '--no-close',
  `--input=${input}`,
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 300000,
  maxBuffer: 64 * 1024 * 1024,
});
const output = `${result.stdout || ''}\n${result.stderr || ''}`;
if (result.status !== 0) console.error(output.split('\n').slice(-100).join('\n'));
assert.strictEqual(result.status, 0, `Deus Ex demo run failed (${result.signal || result.status})`);
const outputTail = output.split('\n').slice(-120).join('\n');
assert(/DLL: deusex\.dll/i.test(output),
  `the native DeusEx module was not loaded\n${outputTail}`);
assert(output.includes('[waveOut] open:'),
  `the engine did not reach its live audio/render viewport\n${outputTail}`);
assert(!/UNIMPLEMENTED API|UNHANDLED EXCEPTION|Critical Error|Failed to find object/.test(output),
  'the demo reported a runtime failure');

const png = PNG.sync.read(fs.readFileSync(SCREEN));
assert.strictEqual(`${png.width}x${png.height}`, '640x480');
let bright = 0;
let saturatedBlue = 0;
const colors = new Set();
for (let i = 0; i < png.data.length; i += 4) {
  const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
  if (r > 175 && g > 175 && b > 175) bright++;
  if (b > 55 && b > r * 1.35 && b > g * 1.15) saturatedBlue++;
  colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
}
assert(bright > 2500 && saturatedBlue > 1000 && colors.size > 20,
  `expected the rendered Deus Ex intro, got bright=${bright} blue=${saturatedBlue} colors=${colors.size}`);

console.log('PASS  Deus Ex demo: native modules, audio, and rendered animated intro');
