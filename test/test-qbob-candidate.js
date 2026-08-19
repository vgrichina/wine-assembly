#!/usr/bin/env node

// End-to-end gate for the original QBob 1.3 shareware game. The corpus
// payload is local/gitignored, so this candidate-only test explicitly skips
// when it has not been fetched and is intentionally absent from run-all.sh.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const { compileWatSnapshot } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const CANDIDATE_ROOT = path.join(__dirname, 'binaries', 'candidates', 'qbob');
const EXE = path.join(CANDIDATE_ROOT, 'QBob.exe');

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  return { png, width: png.width, height: png.height, nonBlack, colors: colors.size };
}

function pixelDiff(a, b) {
  assert(a.width === b.width && a.height === b.height,
    'cannot compare differently sized QBob frames');
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) {
      changed++;
    }
  }
  return changed;
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.log('SKIP QBob candidate: fetch with node tools/fetch-candidate-corpus.js --id=qbob');
    return;
  }

  for (const dependency of ['qbob.dll', 'highscore.dll']) {
    assert(fs.existsSync(path.join(CANDIDATE_ROOT, dependency)),
      `QBob candidate is missing ${dependency}`);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-qbob-candidate-'));
  const wasmPath = path.join(temp, 'candidate.wasm');
  const frameA = path.join(temp, 'qbob-game-a.png');
  const frameB = path.join(temp, 'qbob-game-b.png');

  try {
    const wasm = await compileWatSnapshot(file =>
      fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8'));
    await WebAssembly.compile(wasm);
    fs.writeFileSync(wasmPath, wasm);

    const result = spawnSync('node', [
      RUN,
      `--exe=${EXE}`,
      `--wasm=${wasmPath}`,
      '--no-build',
      '--no-close',
      '--quiet-api',
      '--quiet-blocks',
      '--screen=800x600',
      '--batch-size=25000',
      '--max-batches=285',
      '--thread-slices=16',
      '--stuck-after=600',
      '--input=120:mousedown:315:507,125:mouseup:315:507,' +
        '180:click:27:30,200:click:32:51,220:click:230:52,' +
        `240:png:${frameA},280:png:${frameB}`,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.error) throw result.error;
    assert(result.status === 0,
      `QBob CLI exited ${result.status}${result.signal ? ` (${result.signal})` : ''}\n${output.slice(-8000)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(output),
      `QBob hit a compatibility failure\n${output.slice(-8000)}`);
    assert(/title="QBob"/i.test(output), 'QBob did not create its main window');
    assert(/qbob\.dll loaded/i.test(output) && /highscore\.dll loaded/i.test(output),
      'QBob did not load both bundled DLLs');
    assert(/\[MCI\] play sequencer/i.test(output) && /\[waveOut\] open/i.test(output),
      'QBob did not initialize its MIDI and sampled-audio paths');
    assert(fs.existsSync(frameA) && fs.existsSync(frameB),
      'QBob did not produce both scheduled gameplay frames');

    const a = imageStats(frameA);
    const b = imageStats(frameB);
    for (const [label, stats] of [['first', a], ['second', b]]) {
      assert(stats.width === 800 && stats.height === 600,
        `QBob ${label} frame used ${stats.width}x${stats.height}`);
      assert(stats.nonBlack > 180000 && stats.colors > 200,
        `QBob ${label} gameplay frame stayed blank: ${JSON.stringify({
          nonBlack: stats.nonBlack, colors: stats.colors,
        })}`);
    }
    assert(Math.max(a.nonBlack, b.nonBlack) > 250000,
      'QBob never completed a full gameplay frame');
    const changed = pixelDiff(a.png, b.png);
    assert(changed > 1000,
      `QBob gameplay did not advance between frames: ${changed} changed pixels`);

    console.log(`PASS QBob gameplay: 800x600, ${a.colors}/${b.colors} colors, ${changed} changed pixels`);
    console.log('PASS QBob audio: MIDI playback and wave output initialized');
  } finally {
    if (process.env.KEEP_QBOB_CANDIDATE_TMP === '1') {
      console.log(`kept candidate artifacts: ${temp}`);
    } else {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(`FAIL QBob candidate: ${error.stack || error.message}`);
  process.exit(1);
});
