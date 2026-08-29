#!/usr/bin/env node
'use strict';

// Local gameplay acceptance for the MechWarrior 3 demo. This is the complete
// deterministic route through its main menu, instant-action configuration,
// operation map and the bottom-right deployment control into a live cockpit.
// It guards the failure where gameplay was reachable but Direct3D exposed no
// usable texture device: the HUD rendered over a handful of flat white/tan
// polygons while every scenery texture and its diffuse lighting was absent.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'binaries/shareware/mw3/ex/Program_Files/mech3demo.exe');
const OUT = path.join(ROOT, 'build/mw3-gameplay');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  MechWarrior 3 demo missing');
  process.exit(0);
}

const digest = crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex');
assert.strictEqual(digest,
  'df457ee6973f6f9d557c57aa3fc14258303486ec8b8742fd37b4369c1f37dbdc',
  'mech3demo.exe does not match the pinned demo');

fs.mkdirSync(OUT, { recursive: true });

const route = [
  '200:relmousemove:-199:0', '203:relmousemove:0:-23',
  '210:mousedown:65:210', '225:mouseup:65:210',
  '270:keydown:65', '280:keyup:65',
  '300:keydown:67', '310:keyup:67',
  '330:keydown:69', '340:keyup:69',
  '370:relmousemove:282:0', '373:relmousemove:0:84',
  '385:mousedown:423:320', '405:mouseup:423:320',
  '450:relmousemove:-282:0', '453:relmousemove:0:-84',
  '465:mousedown:65:210', '485:mouseup:65:210',
  '550:relmousemove:67:0', '553:relmousemove:0:-58',
  '565:mousedown:150:135', '585:mouseup:150:135',
  '620:relmousemove:215:0', '623:relmousemove:0:145',
  '635:mousedown:423:320', '655:mouseup:423:320',
  '770:relmousemove:115:0', '773:relmousemove:0:88',
  '790:mousedown:576:432', '820:mouseup:576:432',
  // Worker scheduling can finish the operation-map transition after the first
  // deployment click. Retry the same idempotent control once the map is fully
  // live; in cooperative mode this lands harmlessly after cockpit entry.
  '900:mousedown:576:432', '930:mouseup:576:432',
  '1040:mousedown:576:432', '1070:mouseup:576:432',
  '1150:mousedown:576:432', '1180:mouseup:576:432',
  '1260:mousedown:576:432', '1290:mouseup:576:432',
  '1320:keydown:13', '1330:keyup:13',
];

function analyze(filename, mode) {
  assert(fs.existsSync(filename), `${mode} did not capture a gameplay PNG`);
  const png = PNG.sync.read(fs.readFileSync(filename));
  assert.strictEqual(`${png.width}x${png.height}`, '640x480');
  const colors = new Set();
  const quantized = new Set();
  const terrain = new Set();
  let orangeSky = 0;
  let darkCockpit = 0;
  let greenHud = 0;
  let neonCyan = 0;
  let neonMagenta = 0;
  let electricBlue = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      colors.add(`${r},${g},${b}`);
      quantized.add(`${r >> 4},${g >> 4},${b >> 4}`);
      if (y >= 270 && y < 360 && x >= 100 && x < 540) {
        terrain.add(`${r >> 3},${g >> 3},${b >> 3}`);
      }
      if (y > 60 && y < 260 && x > 100 && x < 540
          && r > g * 1.15 && g > b * 1.1) orangeSky++;
      if (y > 350 && r + g + b < 180) darkCockpit++;
      if (g > 120 && g > r * 1.7 && g > b * 1.25) greenHud++;
      if (g > 160 && b > 160 && r < 80) neonCyan++;
      if (r > 160 && b > 160 && g < 80) neonMagenta++;
      if (b > 160 && r < 80 && g < 140) electricBlue++;
    }
  }
  const measured = {
    colors: colors.size,
    quantized: quantized.size,
    terrainColors: terrain.size,
    orangeSky,
    darkCockpit,
    greenHud,
    neonCyan,
    neonMagenta,
    electricBlue,
  };
  console.log(`  ${mode}: ${JSON.stringify(measured)} ${filename}`);
  // Flat repro measured 135 exact / 89 quantized colors and only five terrain
  // colors. The explicit primary-surface capture measures ~2050 / 405 and
  // ~160 respectively while retaining the detailed sky and cockpit textures.
  assert(colors.size > 1500 && quantized.size > 400 && terrain.size > 120,
    `${mode} reached the flat/no-texture gameplay repro: ${JSON.stringify(measured)}`);
  assert(orangeSky > 40000 && darkCockpit > 30000 && greenHud > 1000,
    `${mode} is missing the lit sky, textured cockpit, or readable HUD: ${JSON.stringify(measured)}`);
  assert(neonCyan < 100 && neonMagenta < 100 && electricBlue < 500,
    `${mode} contains misdecoded neon texture data: ${JSON.stringify(measured)}`);
}

const requested = process.argv[2] || 'both';
assert(['both', 'no-threads', 'threads'].includes(requested),
  'usage: node test/test-mw3-gameplay.js [both|no-threads|threads]');
const modes = requested === 'both' ? ['no-threads', 'threads'] : [requested];

for (let index = 0; index < modes.length; index++) {
  const mode = modes[index];
  const png = path.join(OUT, `${mode}.png`);
  if (fs.existsSync(png)) fs.unlinkSync(png);
  const input = [...route, `1450:png:${png}`].join(',');
  const args = [
    path.join(__dirname, 'run.js'), '--app=mw3', `--${mode}`,
    '--quiet-api', '--quiet-blocks', '--batch-size=200000',
    '--max-batches=1470', '--no-close', '--dx-slot=5',
    ...(index ? ['--no-build'] : []),
    `--input=${input}`,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0) console.error(output.split('\n').slice(-80).join('\n'));
  assert.strictEqual(result.status, 0,
    `${mode} MW3 route failed (${result.signal || result.status})`);
  assert(!/ERROR:|UNHANDLED EXCEPTION|UNIMPLEMENTED API/.test(output),
    `${mode} MW3 route reported a runtime failure`);
  if (mode === 'threads') {
    assert(/guest-worker 1|spawned worker T1|guest thread tid=1/.test(output),
      'threads route never instantiated the guest worker');
  }
  analyze(png, mode);
}

console.log(`PASS MechWarrior 3 reaches textured, lit gameplay (${modes.join(' + ')})`);
