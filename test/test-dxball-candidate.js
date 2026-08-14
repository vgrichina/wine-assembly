#!/usr/bin/env node

// End-to-end gate for the original DX-Ball 1.09 Wise package. The package is
// still a local, gitignored corpus fixture, so the canonical matrix reports an
// explicit SKIP when it has not been fetched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const { compileWatSnapshot } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const INSTALLER = path.join(__dirname, 'binaries', 'candidates', 'dxball', 'dxball19.exe');
const DEBUG_WEB_DIR = path.join(__dirname, 'binaries', 'candidates', 'dxball', 'installed');

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

function pixelDiff(filenameA, filenameB, region = null) {
  const a = PNG.sync.read(fs.readFileSync(filenameA));
  const b = PNG.sync.read(fs.readFileSync(filenameB));
  assert(a.width === b.width && a.height === b.height, 'cannot compare differently sized frames');
  const box = region || { x: 0, y: 0, width: a.width, height: a.height };
  let changed = 0;
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) {
      const i = (y * a.width + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
          a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) {
        changed++;
      }
    }
  }
  return changed;
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
  const menuPng = path.join(temp, 'dxball-menu.png');
  const readyPng = path.join(temp, 'dxball-level-ready.png');
  const ballPngA = path.join(temp, 'dxball-ball-a.png');
  const ballPngB = path.join(temp, 'dxball-ball-b.png');
  const ballPngC = path.join(temp, 'dxball-ball-c.png');
  const paddleLeftPng = path.join(temp, 'dxball-paddle-left.png');
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

    if (process.env.PREPARE_DXBALL_DEBUG_WEB === '1') {
      fs.mkdirSync(DEBUG_WEB_DIR, { recursive: true });
      fs.cpSync(installDir, DEBUG_WEB_DIR, { recursive: true, force: true });
      console.log(`prepared debug web payload: ${path.relative(ROOT, DEBUG_WEB_DIR)}`);
    }

    console.log('DX-Ball candidate stage 2/2: launching installed game...');
    const gameOutput = runCli([
      `--exe=${gameExe}`,
      ...common,
      '--batch-size=50000',
      '--max-batches=340',
      '--stuck-after=500',
      '--trace-api=midiStreamOpen,midiStreamOut,midiStreamRestart,midiStreamPause,IDirectSound_CreateSoundBuffer,IDirectSound_Release',
      '--trace-host=voice_play_ring',
      `--input=62:keydown:27,63:keyup:27,120:png-pixels:${menuPng},123:dump-focus:before-gameplay,` +
        `124:mousedown:320:240,140:mouseup:320:240,180:dump-focus:gameplay,220:png-pixels:${readyPng},` +
        `235:mousedown:320:430,245:mouseup:320:430,255:png-pixels:${ballPngA},` +
        `275:png-pixels:${ballPngB},295:png-pixels:${ballPngC},` +
        `305:mousemove:120:430,325:png-pixels:${paddleLeftPng}`,
    ], 60000);
    assert(/title="DX-Ball"/i.test(gameOutput), 'installed game did not create its DX-Ball window');
    for (const frame of [menuPng, readyPng, ballPngA, ballPngB, ballPngC, paddleLeftPng]) {
      assert(fs.existsSync(frame), `installed game omitted scheduled frame ${path.basename(frame)}`);
    }
    const menuStats = imageStats(menuPng);
    const gameStats = imageStats(ballPngC);
    assert(gameStats.width === 640 && gameStats.height === 480,
      `installed game used an unexpected frame size: ${gameStats.width}x${gameStats.height}`);
    assert(menuStats.nonBlack > 50000 && menuStats.colors > 40,
      `installed game menu stayed blank: ${JSON.stringify(menuStats)}`);
    assert(gameStats.nonBlack > 50000 && gameStats.colors > 100,
      `installed game level stayed blank: ${JSON.stringify(gameStats)}`);

    const playfield = { x: 0, y: 270, width: 640, height: 170 };
    const ballDeltaAB = pixelDiff(ballPngA, ballPngB, playfield);
    const ballDeltaBC = pixelDiff(ballPngB, ballPngC, playfield);
    assert(ballDeltaAB > 300 && ballDeltaBC > 300,
      `ball did not animate across successive gameplay frames: ${ballDeltaAB}, ${ballDeltaBC}`);
    const paddleDelta = pixelDiff(readyPng, paddleLeftPng,
      { x: 0, y: 420, width: 640, height: 60 });
    assert(paddleDelta > 1000, `paddle did not follow mouse movement: ${paddleDelta} changed pixels`);

    assert(/midiStreamOpen\(/.test(gameOutput) && /midiStreamOut\(/.test(gameOutput) &&
      /midiStreamRestart\(/.test(gameOutput), 'DX-Ball did not initialize and start its MIDI soundtrack');
    const gameplayStart = gameOutput.indexOf('[input] dump-focus before-gameplay:');
    const gameplayReady = gameOutput.indexOf('[input] dump-focus gameplay:');
    assert(gameplayStart >= 0 && gameplayReady > gameplayStart,
      'DX-Ball run did not emit its gameplay audio phase markers');
    const afterStart = gameOutput.slice(gameplayStart);
    const duringGameplay = gameOutput.slice(gameplayReady);
    assert(!/midiStreamPause\(/.test(afterStart),
      'starting gameplay incorrectly paused the MIDI soundtrack');
    assert(!/IDirectSound_Release\(/.test(afterStart),
      'starting gameplay incorrectly released the DirectSound device');
    assert(/IDirectSound_CreateSoundBuffer\(/.test(duringGameplay),
      'DX-Ball did not create its DirectSound effect buffers during gameplay loading');
    assert(/\[host\] voice_play_ring\(/.test(duringGameplay),
      'DX-Ball did not submit a DirectSound PCM effect after gameplay started');
    console.log(`PASS game: playable ${gameStats.width}x${gameStats.height} level, ball deltas ${ballDeltaAB}/${ballDeltaBC}, paddle delta ${paddleDelta}`);
    console.log('PASS audio: MIDI stayed active and gameplay created/submitted DirectSound PCM');
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
