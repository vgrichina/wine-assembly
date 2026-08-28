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
const FIXTURE = path.join(ROOT, 'test/binaries/candidates/deus-ex-demo');
const SYSTEM = path.join(FIXTURE, 'System');
const EXE = path.join(SYSTEM, 'DeusEx.exe');
const CORE = path.join(SYSTEM, 'Core.dll');
const ENTRY = path.join(FIXTURE, 'Maps/Entry.dx');
const OUT = path.join(ROOT, 'build/local-candidate-smoke/deus-ex-demo');
const SCREEN = path.join(OUT, 'training-prompt.png');
const RUNTIME_INI = path.join(OUT, 'DeusEx.ini');

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
let ini = fs.readFileSync(path.join(SYSTEM, 'DeusEx.ini'), 'utf8');
ini = ini.replace(/^FirstRun=.*$/m, 'FirstRun=1002')
  .replace(/^GameRenderDevice=.*$/m, 'GameRenderDevice=SoftDrv.SoftwareRenderDevice')
  .replace(/^RenderDevice=.*$/gm, 'RenderDevice=SoftDrv.SoftwareRenderDevice')
  .replace(/^StartupFullscreen=.*$/m, 'StartupFullscreen=False');
fs.writeFileSync(RUNTIME_INI, ini);

const dlls = [
  'Window.dll', 'Core.dll', 'Engine.dll', 'WinDrv.dll', 'SoftDrv.dll',
  'Render.dll', 'Fire.dll', 'IpDrv.dll', 'Extension.dll', 'ConSys.dll',
  'DeusEx.dll', 'DeusExText.dll', 'Galaxy.dll',
].map(name => path.join(SYSTEM, name));
for (const dll of dlls) assert(fs.existsSync(dll), `missing seeded DLL ${path.basename(dll)}`);

const input = [
  '330:keydown:27', '340:keyup:27',
  '450:keydown:13', '460:keyup:13',
  `550:png:${SCREEN}`,
].join(',');
const result = spawnSync(process.execPath, [
  path.join(__dirname, 'run.js'),
  `--exe=${EXE}`,
  '--args=-windowed',
  `--dll-seed=${dlls.join(',')}`,
  '--vfs-include=*',
  '--vfs-include=../**/*',
  `--vfs-mount=${RUNTIME_INI}=c:\\DeusEx.ini`,
  '--max-batches=575',
  '--batch-size=200000',
  '--tick-ms-per-batch=50',
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
assert(output.includes('DLL: DeusEx.dll'), 'the native DeusEx module was not loaded');
assert(output.includes('[waveOut] open:'), 'the engine did not reach its live audio/render viewport');
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
assert(bright > 2500 && saturatedBlue > 1000 && colors.size > 100,
  `expected the interactive Deus Ex menu/dialog, got bright=${bright} blue=${saturatedBlue} colors=${colors.size}`);

console.log(`PASS  Deus Ex demo: native modules, audio, rendered New Game/training prompt, and keyboard input`);

