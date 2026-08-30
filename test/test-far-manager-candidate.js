#!/usr/bin/env node

'use strict';

// Far Manager 1.70 is a compact Win98 console acceptance target. Its original
// trial package may be redistributed only intact and not bundled, so the
// payload stays gitignored and this gate reports an explicit SKIP until fetched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const { compileWatSnapshot } = require('../lib/compile-wat');
const { APPS, DESKTOP_APPS, LOCAL_CANDIDATE_APPS } = require('../lib/apps');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const FAR_ROOT = path.join(__dirname, 'binaries', 'candidates',
  'far-manager-170', 'FarManager170');
const FAR = path.join(FAR_ROOT, 'Far.exe');

const farApp = APPS.far_manager_170;
assert(farApp, 'Far Manager has a browser app registry entry');
assert(LOCAL_CANDIDATE_APPS.some(([id]) => id === 'far_manager_170'),
  'Far Manager is visible on the localhost desktop and dropdown');
assert(!DESKTOP_APPS.some(([id]) => id === 'far_manager_170'),
  'Far Manager is not published as a deployed app');
assert(farApp.exe ===
  'test/binaries/candidates/far-manager-170/FarManager170/Far.exe',
  'Far launches the ignored candidate executable');
assert(farApp.preExtractIcon === false,
  'Far keeps the runtime EXE-icon fallback instead of a separately bundled icon');
assert(JSON.stringify(farApp.files.map(file => path.basename(file)).sort()) ===
  JSON.stringify(['FarEng.hlf', 'FarEng.lng', 'FarRus.hlf', 'FarRus.lng'].sort()),
  'Far mounts both complete language/help pairs beside Far.exe');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
assert(html.includes('<option value="far_manager_170">Far Manager 1.70</option>'),
  'Far has a concrete localhost dropdown option');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function colorCount(png, rgb) {
  let count = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] === rgb[0] && png.data[i + 1] === rgb[1]
        && png.data[i + 2] === rgb[2] && png.data[i + 3]) count++;
  }
  return count;
}

function colorCountBelow(png, rgb, minY) {
  let count = 0;
  for (let y = minY; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] === rgb[0] && png.data[i + 1] === rgb[1]
          && png.data[i + 2] === rgb[2] && png.data[i + 3]) count++;
    }
  }
  return count;
}

function colorCountInRows(png, rgb, minY, maxY) {
  let count = 0;
  for (let y = minY; y < Math.min(maxY, png.height); y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] === rgb[0] && png.data[i + 1] === rgb[1]
          && png.data[i + 2] === rgb[2] && png.data[i + 3]) count++;
    }
  }
  return count;
}

function colorCountInRect(png, rgb, left, top, right, bottom) {
  let count = 0;
  for (let y = top; y < Math.min(bottom, png.height); y++) {
    for (let x = left; x < Math.min(right, png.width); x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] === rgb[0] && png.data[i + 1] === rgb[1]
          && png.data[i + 2] === rgb[2] && png.data[i + 3]) count++;
    }
  }
  return count;
}

(async () => {
  if (!fs.existsSync(FAR)) {
    console.log('SKIP Far Manager candidate: fetch with node tools/fetch-candidate-corpus.js --id=far-manager-170');
    return;
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-far-manager-'));
  const wasmPath = path.join(temp, 'candidate.wasm');
  const framePath = path.join(temp, 'far-manager.png');
  try {
    const wasm = await compileWatSnapshot(file =>
      fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8'));
    fs.writeFileSync(wasmPath, wasm);

    const result = spawnSync('node', [
      RUN,
      `--exe=${FAR}`,
      '--vfs-include=*.lng,*.hlf',
      `--wasm=${wasmPath}`,
      '--no-build',
      '--quiet-api',
      '--trace-fs',
      '--max-batches=400',
      '--batch-size=50000',
      // Select app.exe through a real console MOUSE_EVENT_RECORD, then prove
      // keyboard input still opens Far's F9 top menu.
      '--input=60:mousemove:80:100,62:mousedown:80:100,64:mouseup:80:100,' +
        '90:keydown:0x78,92:keyup:0x78',
      `--png=${framePath}`,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.error) throw result.error;
    assert(result.status === 0,
      `Far Manager exited ${result.status}${result.signal ? ` (${result.signal})` : ''}\n${output.slice(-8000)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(output),
      `Far Manager hit a compatibility failure\n${output.slice(-8000)}`);
    assert(/SetWindowText.*\{C:/.test(output),
      `Far Manager never reached its live panel caption\n${output.slice(-8000)}`);
    assert(output.includes('[fs] FindFirstFile("*.*") → "."') &&
      output.includes('FindNextFile(0x') && output.includes('→ ".."') &&
      output.includes('→ "app.exe"') && output.includes('→ "far.exe"'),
    `Far Manager did not enumerate the mounted C: files\n${output.slice(-8000)}`);
    assert(fs.existsSync(framePath), 'Far Manager did not produce a browser frame');

    const png = PNG.sync.read(fs.readFileSync(framePath));
    assert(png.width === 640 && png.height === 480,
      `unexpected Far frame size ${png.width}x${png.height}`);
    const blue = colorCount(png, [0, 0, 128]);
    const cyan = colorCount(png, [0, 255, 255]);
    const yellow = colorCount(png, [255, 255, 0]);
    const bottomBlack = colorCountBelow(png, [0, 0, 0], 315);
    const bottomGray = colorCountBelow(png, [192, 192, 192], 315);
    const menuYellow = colorCountInRows(png, [255, 255, 0], 30, 45);
    const selectedAppTeal = colorCountInRect(png, [0, 128, 128], 8, 92, 156, 105);
    assert(blue > 100000, `Far panel background missing (${blue} dark-blue pixels)`);
    assert(cyan > 1000, `Far panel borders/status text missing (${cyan} cyan pixels)`);
    assert(yellow > 100, `Far column headings missing (${yellow} yellow pixels)`);
    assert(bottomBlack > 5000 && bottomGray > 1000,
      `Far bottom key bar is clipped (${bottomBlack} black, ${bottomGray} gray pixels below y=315)`);
    assert(menuYellow > 100,
      `Far did not react to browser F9 input (${menuYellow} yellow top-menu pixels)`);
    assert(selectedAppTeal > 1200,
      `Far did not select app.exe through console mouse input (${selectedAppTeal} teal pixels)`);

    console.log(`PASS  Far Manager 1.70 lists files and accepts mouse/F9 (${blue} blue, ${selectedAppTeal} selected, ${menuYellow} menu pixels)`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
