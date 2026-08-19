#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'sndrec32.exe');
const OUT = path.join(ROOT, 'scratch', 'sound-recorder-audio');
const beforePng = path.join(OUT, 'before.png');
const stoppedPng = path.join(OUT, 'recorded-stopped.png');
const playbackPcm = path.join(OUT, 'playback.pcm');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  sndrec32.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of [beforePng, stoppedPng, playbackPcm]) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const input = [
  `60:png:${beforePng}`,
  '70:click:279:138',
  '80:wave-in-feed:4800:48000:0.7',
  '90:wave-in-feed:4800:48000:0.7',
  '100:wave-in-feed:4800:48000:0.7',
  '110:wave-in-feed:4800:48000:0.7',
  '120:wave-in-feed:4800:48000:0.7',
  '130:click:227:138',
  // The endpoint is intentionally a flat line. Seek into the captured data
  // so this artifact exercises the native waveform renderer as well.
  '140:mousedown:296:106',
  '141:mousemove:175:106',
  '142:mouseup:175:106',
  `155:png:${stoppedPng}`,
  // Rewind after capturing the visual so playback still covers the complete
  // recorded buffer and keeps the audio-path assertions independent.
  '160:mousedown:175:106',
  '161:mousemove:55:106',
  '162:mouseup:55:106',
  '175:click:177:138',
  '230:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--audio-out=${playbackPcm}`,
    `--input=${input}`,
    '--max-batches=260',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
    '--trace-wave',
    '--trace-api=SetDlgItemTextA',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  runFailed = true;
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

async function inspectScreenshot(file) {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  const countIn = (x0, y0, x1, y1, predicate) => {
    let count = 0;
    for (let y = y0; y < Math.min(y1, image.height); y++) {
      for (let x = x0; x < Math.min(x1, image.width); x++) {
        const i = (y * image.width + x) * 4;
        if (predicate(pixels[i], pixels[i + 1], pixels[i + 2])) count++;
      }
    }
    return count;
  };
  return {
    titleInk: countIn(40, 0, 320, 40, (r, g, b) => r < 80 && g < 100 && b < 160),
    displayBlack: countIn(120, 48, 235, 89, (r, g, b) => r < 25 && g < 25 && b < 25),
    displayGreen: countIn(120, 48, 235, 89, (r, g, b) => r < 40 && g > 90 && b < 40),
    waveformRows: (() => {
      const rows = new Set();
      for (let y = 48; y < Math.min(89, image.height); y++) {
        for (let x = 120; x < Math.min(235, image.width); x++) {
          const i = (y * image.width + x) * 4;
          if (pixels[i] < 40 && pixels[i + 1] > 90 && pixels[i + 2] < 40) rows.add(y);
        }
      }
      return rows.size;
    })(),
    readoutInk: countIn(51, 48, 305, 89, (r, g, b) => r < 100 && g < 100 && b < 100),
    transportBottomInk: countIn(50, 145, 304, 153, (r, g, b) => r < 100 && g < 100 && b < 100),
    lowerChromePixels: countIn(40, 154, 318, 165,
      (r, g, b) => r > 80 || g < 80 || b < 80),
  };
}

(async () => {
  const screenshots = [beforePng, stoppedPng].every(file =>
    fs.existsSync(file) && fs.statSync(file).size > 4000);
  const visual = screenshots ? await inspectScreenshot(stoppedPng) : null;
  const pcm = fs.existsSync(playbackPcm) ? fs.readFileSync(playbackPcm) : Buffer.alloc(0);
  let nonzero = 0;
  let min = 32767;
  let max = -32768;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const value = pcm.readInt16LE(i);
    if (value) nonzero++;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const feedCount = (output.match(/wave-in-feed[^\n]*written=2205/g) || []).length;
  const checks = [
    ['emulator run completed', !runFailed],
    [`five microphone-like chunks captured (${feedCount})`, feedCount === 5],
    ['native waveIn device opened and closed', /\[waveIn\] open: 22050Hz 1ch 16bit/.test(output) && /\[waveIn\] close/.test(output)],
    [`captured playback contains PCM (${pcm.length} bytes)`, pcm.length >= 20000],
    [`captured playback is non-silent (${nonzero} samples)`, nonzero >= 10000],
    [`captured waveform preserves amplitude (${min}..${max})`, min < -20000 && max > 20000],
    ['Sound Recorder submitted captured data to waveOut', /\[wave\] totals: open=1 write=3 \(22050 B\)/.test(output)],
    ['position and length readouts reach the captured duration',
      /SetDlgItemTextA\([^\n]*text="0\.50 sec\."/.test(output)],
    ['before and stopped screenshots are complete', screenshots && visual && visual.titleInk >= 100],
    ['captured waveform and numeric readouts are visible', visual &&
      visual.displayBlack >= 2500 && visual.displayGreen >= 500 &&
      visual.waveformRows >= 15 && visual.readoutInk >= 150],
    ['transport buttons and lower window chrome are not clipped', visual &&
      visual.transportBottomInk >= 200 && visual.lowerChromePixels >= 2000],
    ['no unimplemented API or runtime crash', !/UNIMPLEMENTED API:|RuntimeError|LinkError|\*\*\* CRASH/.test(output)],
  ];

  if (runFailed) console.error(output.slice(-6000));
  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) failed++;
  }
  console.log(`Artifacts: ${OUT}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
