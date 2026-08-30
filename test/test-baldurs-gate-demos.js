#!/usr/bin/env node

'use strict';

// Local-only visual acceptance for the three official Baldur's Gate previews.
// Their licenses do not allow repository redistribution, so the ignored
// fixtures are fetched on demand by tools/fetch-candidate-corpus.js.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const { compileWatSnapshot } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build/local-candidate-smoke/baldurs-gate-demos');
const WASM = path.join(OUT, 'combined.wasm');
const fixtures = {
  noninteractive: {
    exe: path.join(ROOT, 'test/binaries/candidates/baldurs-gate-noninteractive-demo/BALDUR.EXE'),
    sha256: '0990036bae224526a535d3df9deacc306cb87add6f02b34342934ae43ce25caa',
  },
  interactive: {
    exe: path.join(ROOT, 'test/binaries/candidates/baldurs-gate-interactive-demo/installed-extracted/MinimumData/BGDemo.exe'),
    sha256: 'ed7f1efd9df8d9a62c1a32f2598e8cc19e5dc601689aeebb72a3bc835db343d9',
  },
  chapters: {
    exe: path.join(ROOT, 'test/binaries/candidates/baldurs-gate-chapters-1-2-demo/installed-extracted/MinimumData/BGMain.exe'),
    sha256: 'af46f2dfa8a7637a4f55b9d77024e17e5fa02a1b0ff11838ba7473adb163c10f',
  },
};

const present = Object.entries(fixtures).filter(([, fixture]) => fs.existsSync(fixture.exe));
if (!present.length) {
  console.log('SKIP  Baldur\'s Gate demos missing; fetch their three local candidate-corpus fixtures');
  process.exit(0);
}

function digest(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function run(name, fixture, extra, timeout) {
  assert.strictEqual(digest(fixture.exe), fixture.sha256,
    `${name} executable does not match the pinned official preview`);
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'run.js'),
    `--exe=${fixture.exe}`,
    `--wasm=${WASM}`,
    '--no-build',
    '--no-close',
    '--vfs-include=**/*',
    '--quiet-api',
    '--quiet-blocks',
    '--repaint-every=10',
    ...extra,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0) console.error(output.split('\n').slice(-100).join('\n'));
  assert.strictEqual(result.status, 0,
    `${name} run failed (${result.signal || result.status})`);
  assert(!/UNIMPLEMENTED API|UNHANDLED EXCEPTION|Critical Error|Assertion failed/.test(output),
    `${name} reported a runtime failure`);
  return output;
}

function readFrame(filename, label) {
  assert(fs.existsSync(filename), `${label} screenshot was not produced`);
  const png = PNG.sync.read(fs.readFileSync(filename));
  assert.strictEqual(`${png.width}x${png.height}`, '640x480', `${label} has the wrong dimensions`);
  return png;
}

function detailStats(png) {
  let nonBlack = 0;
  let colorful = 0;
  const colors = new Set();
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (r + g + b > 45) nonBlack++;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 25) colorful++;
    colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
  }
  return { pixels: png.width * png.height, nonBlack, colorful, colors: colors.size };
}

function inWorldStats(png) {
  let selectionGreen = 0;
  for (let y = 50; y < 330; y++) {
    for (let x = 50; x < 575; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (g > 100 && g > r * 1.35 && g > b * 1.2) selectionGreen++;
    }
  }
  return { selectionGreen };
}

function characterCreationInput(gameplayShot) {
  return [
    // Character Generation is ready when its stone UI contributes this
    // stable near-black count. The gate shifts every later action together.
    '300:wait-canvas-dark-pixels:25000:35000:300',
    '301:set-batch-size:2000000',
    '310:click:85:153', '315:click:293:195',
    '320:click:331:341', '325:click:265:432',
    '335:click:85:190', '340:click:320:150', '345:click:252:419',
    '355:click:85:225', '360:click:320:59', '365:click:252:436',
    '375:click:85:260', '385:click:320:95', '390:click:252:436',
    '400:click:85:296', '415:click:260:436',
    '425:click:85:333',
    '435:click:431:65', '440:click:431:65',
    '445:click:431:96', '450:click:431:96', '455:click:265:434',
    '465:click:85:370', '480:click:270:401', '500:click:260:436',
    '510:click:85:406',
    '520:keydown:67', '521:keypress:67', '522:keyup:67',
    '523:keydown:79', '524:keypress:79', '525:keyup:79',
    '526:keydown:68', '527:keypress:68', '528:keyup:68',
    '529:keydown:69', '530:keypress:69', '531:keyup:69',
    '532:keydown:88', '533:keypress:88', '534:keyup:88',
    '535:click:250:278', '550:click:552:422',
    // Dismiss the Prologue panel after the area transition has completed.
    '610:keydown:27', '612:keyup:27', '620:click:400:435',
    `700:png:${gameplayShot}`, '701:stop',
  ];
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const bytes = await compileWatSnapshot(filename =>
    fs.promises.readFile(path.join(ROOT, 'src', filename), 'utf8'));
  fs.writeFileSync(WASM, bytes);

  let checked = 0;
  if (fs.existsSync(fixtures.noninteractive.exe)) {
    const shot = path.join(OUT, 'noninteractive-cinematic.png');
    const output = run('non-interactive demo', fixtures.noninteractive, [
      '--max-batches=300', '--batch-size=2000000', '--max-seconds=100',
      '--time-scale=10',
      `--png=${shot}`,
    ], 140000);
    assert(output.includes('title="Baldur\'s Gate"'), 'the presentation window was not created');
    const frame = readFrame(shot, 'non-interactive cinematic');
    const stats = detailStats(frame);
    assert(stats.nonBlack / stats.pixels > 0.20 &&
      stats.colorful / stats.pixels > 0.10 && stats.colors > 100,
    `the non-interactive demo did not render a detailed cinematic (${JSON.stringify(stats)})`);
    checked++;
  }

  if (fs.existsSync(fixtures.interactive.exe)) {
    const gameplay = path.join(OUT, 'interactive-gameplay.png');
    const input = [
      '60:keydown:27', '62:keyup:27', '90:keydown:27', '92:keyup:27',
      '120:keydown:32', '122:keyup:32', '180:keydown:27', '182:keyup:27',
      '210:click:320:265', '270:click:320:263',
      ...characterCreationInput(gameplay),
    ].join(',');
    const output = run('interactive demo', fixtures.interactive, [
      '--max-batches=760', '--batch-size=200000', '--max-seconds=900',
      '--time-scale=10', `--input=${input}`,
    ], 950000);
    assert(output.includes('title="JigSawedME"'), 'the interactive game window was not created');
    assert(output.includes('Baldur interactive demo area transition wait'),
      'the interactive area-transition compatibility patch was not applied');
    const frame = readFrame(gameplay, 'interactive gameplay');
    const stats = detailStats(frame);
    const world = inWorldStats(frame);
    assert(stats.nonBlack / stats.pixels > 0.70 && stats.colors > 500 &&
      world.selectionGreen > 150,
    `the interactive demo did not reach selected-character gameplay (${JSON.stringify({ ...stats, ...world })})`);
    checked++;
  }

  if (fs.existsSync(fixtures.chapters.exe)) {
    const gameplay = path.join(OUT, 'chapters-gameplay.png');
    const input = [
      '72:keydown:27', '74:keyup:27', '80:keypress:27',
      '82:keydown:32', '84:keyup:32', '90:keydown:27', '92:keyup:27',
      '110:keydown:27', '112:keyup:27', '130:keydown:27', '132:keyup:27',
      '150:keydown:27', '152:keyup:27', '170:keydown:27', '172:keyup:27',
      // Wait until the mostly-black movie/quote frames have cleared. This
      // shifts every following action with the gate, so host load cannot make
      // the menu click land on a cinematic instead.
      '200:wait-canvas-dark-pixels:0:100000:500',
      '205:click:320:265', '250:click:320:263',
      ...characterCreationInput(gameplay),
    ].join(',');
    const output = run('Chapters I & II preview', fixtures.chapters, [
      '--max-batches=760', '--batch-size=200000', '--max-seconds=900',
      '--time-scale=10', `--input=${input}`,
    ], 950000);
    assert(output.includes('title="JigSawedME"'), 'the Chapters I & II game window was not created');
    assert(!/Wrong Version|only available in Canada|United States/i.test(output),
      'the Chapters I & II locale gate rejected the runtime');
    assert(output.includes('Baldur Chapters I & II area transition wait'),
      'the Chapters I & II area-transition compatibility patch was not applied');
    const frame = readFrame(gameplay, 'Chapters I & II gameplay');
    const stats = detailStats(frame);
    const world = inWorldStats(frame);
    assert(stats.nonBlack / stats.pixels > 0.70 && stats.colors > 500 &&
      world.selectionGreen > 150,
    `Chapters I & II did not reach selected-character gameplay (${JSON.stringify({ ...stats, ...world })})`);
    checked++;
  }

  console.log(`PASS  ${checked}/3 Baldur's Gate previews render, and both playable builds reach gameplay`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
