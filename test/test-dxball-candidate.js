#!/usr/bin/env node

// Candidate-only end-to-end gate for the original DX-Ball 1.09 Wise package.
// This intentionally stays out of test/run-all.sh and the main fixture matrix.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const { compileWatSnapshot } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const INSTALLER = path.join(__dirname, 'binaries', 'candidates', 'dxball', 'dxball19.exe');

function runCli(args, timeout) {
  const result = spawnSync('node', [RUN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`CLI exited ${result.status}${result.signal ? ` (${result.signal})` : ''}\n${output.slice(-8000)}`);
  }
  if (/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(output)) {
    throw new Error(`CLI compatibility failure\n${output.slice(-8000)}`);
  }
  return output;
}

function imageStats(filename) {
  const png = PNG.sync.read(fs.readFileSync(filename));
  let nonBlack = 0;
  const colors = new Set();
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    const a = png.data[i + 3];
    if (a && (r || g || b)) nonBlack++;
    if (a) colors.add((r << 16) | (g << 8) | b);
  }
  return { width: png.width, height: png.height, nonBlack, colors: colors.size };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (!fs.existsSync(INSTALLER)) {
    console.log('SKIP DX-Ball candidate: fetch with node tools/fetch-candidate-corpus.js --id=dxball');
    return;
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-dxball-candidate-'));
  const inputRoot = path.join(temp, 'input', 'root');
  const vfsRoot = path.join(temp, 'installed-vfs');
  const wasmPath = path.join(temp, 'candidate.wasm');
  const installerPng = path.join(temp, 'installer-finished.png');
  const gamePng = path.join(temp, 'dxball-live.png');
  fs.mkdirSync(inputRoot, { recursive: true });
  fs.copyFileSync(INSTALLER, path.join(inputRoot, 'dxball19.exe'));

  try {
    const wasm = await compileWatSnapshot(file => fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8'));
    await WebAssembly.compile(wasm);
    fs.writeFileSync(wasmPath, wasm);

    const common = [
      `--wasm=${wasmPath}`,
      '--no-build',
      '--no-close',
      '--quiet-api',
      '--quiet-blocks',
    ];

    console.log('DX-Ball candidate stage 1/2: running Wise installer...');
    const installerOutput = runCli([
      `--exe=${path.join(inputRoot, 'dxball19.exe')}`,
      ...common,
      '--batch-size=10000',
      '--max-batches=2300',
      '--stuck-after=2500',
      '--input=0:wait-dlg-control:4:400,5:dlg-click:4,20:wait-dlg-control:3:300,25:dlg-click:3,40:wait-dlg-control:3:300,45:dlg-click:3,60:wait-dlg-control:3:300,65:dlg-click:3',
      `--save-vfs=${vfsRoot}`,
      `--png=${installerPng}`,
    ], 180000);

    assert(/Installation Completed!/i.test(installerOutput), 'Wise installer did not reach its completion page');
    assert(/successfully installed/i.test(installerOutput), 'Wise installer did not report success');
    const installDir = path.join(vfsRoot, 'program files', 'dx-ball');
    const gameExe = path.join(installDir, 'dxball.exe');
    for (const [name, minBytes] of [
      ['dxball.exe', 100000],
      ['mainmenu.pcx', 40000],
      ['voltage.wav', 160000],
      ['whine.wav', 130000],
      ['unwise.exe', 80000],
    ]) {
      const filename = path.join(installDir, name);
      assert(fs.existsSync(filename), `installer omitted ${name}`);
      assert(fs.statSync(filename).size >= minBytes, `installer produced a truncated ${name}`);
    }
    const installerStats = imageStats(installerPng);
    assert(installerStats.nonBlack > 100000 && installerStats.colors > 20,
      `installer completion window was not visibly rendered: ${JSON.stringify(installerStats)}`);
    console.log(`PASS installer: completion window ${installerStats.width}x${installerStats.height}, ${installerStats.colors} colors`);

    console.log('DX-Ball candidate stage 2/2: launching installed game...');
    const gameOutput = runCli([
      `--exe=${gameExe}`,
      ...common,
      '--batch-size=10000',
      '--max-batches=330',
      '--stuck-after=1000',
      `--input=300:png-pixels:${gamePng}`,
    ], 60000);
    assert(/title="DX-Ball"/i.test(gameOutput), 'installed game did not create its DX-Ball window');
    assert(fs.existsSync(gamePng), 'installed game did not produce the scheduled live frame');
    const gameStats = imageStats(gamePng);
    assert(gameStats.width === 640 && gameStats.height === 480,
      `installed game used an unexpected frame size: ${gameStats.width}x${gameStats.height}`);
    assert(gameStats.nonBlack > 100000 && gameStats.colors > 40,
      `installed game window stayed blank: ${JSON.stringify(gameStats)}`);
    console.log(`PASS game: live DirectDraw frame ${gameStats.width}x${gameStats.height}, ${gameStats.nonBlack} lit pixels, ${gameStats.colors} colors`);
    console.log('DX-Ball candidate: PASS 2/2');
  } finally {
    if (process.env.KEEP_DXBALL_CANDIDATE_TMP === '1') {
      console.log(`kept candidate artifacts: ${temp}`);
    } else {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(`FAIL DX-Ball candidate: ${error.stack || error.message}`);
  process.exit(1);
});
