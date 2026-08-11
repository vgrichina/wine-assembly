#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'sndvol32.exe');
const OUT = path.join(ROOT, 'scratch', 'volume-control-audio');
const initialPng = path.join(OUT, 'initial.png');
const activePng = path.join(OUT, 'active-meters.png');
const mutedPng = path.join(OUT, 'wave-muted.png');
const adjustedPng = path.join(OUT, 'adjusted.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  sndvol32.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of [initialPng, activePng, mutedPng, adjustedPng]) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const input = [
  '50:dlg-dump:volume',
  `55:hwnd-png-pixels:65538:${initialPng}`,
  '60:mixer-peak:1:32767:10000',
  '61:mixer-peak:2:18000:10000',
  '80:sleep-ms:100',
  `90:hwnd-png-pixels:65538:${activePng}`,
  '100:mousedown:35:166',
  '101:mousemove:35:190',
  '102:mouseup:35:190',
  '110:mousedown:121:166',
  '111:mousemove:121:220',
  '112:mouseup:121:220',
  '120:click:109:266',
  '125:sleep-ms:100',
  `130:hwnd-png-pixels:65538:${mutedPng}`,
  '135:click:109:266',
  '145:mousedown:211:166',
  '146:mousemove:211:205',
  '147:mouseup:211:205',
  `155:hwnd-png-pixels:65538:${adjustedPng}`,
  '156:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=190',
    '--batch-size=5000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
    '--stuck-after=5000',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  runFailed = true;
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

async function inspect(file) {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  const darkIn = (x0, y0, x1, y1) => {
    let count = 0;
    for (let y = y0; y < Math.min(y1, image.height); y++) {
      for (let x = x0; x < Math.min(x1, image.width); x++) {
        const i = (y * image.width + x) * 4;
        if (pixels[i] < 110 && pixels[i + 1] < 110 && pixels[i + 2] < 110) count++;
      }
    }
    return count;
  };
  const colorIn = (x0, y0, x1, y1, match) => {
    let count = 0;
    for (let y = y0; y < Math.min(y1, image.height); y++) {
      for (let x = x0; x < Math.min(x1, image.width); x++) {
        const i = (y * image.width + x) * 4;
        if (match(pixels[i], pixels[i + 1], pixels[i + 2])) count++;
      }
    }
    return count;
  };
  const meter = (x0) => ({
    green: colorIn(x0, 166, x0 + 12, 250, (r, g, b) => g >= 100 && r < 20 && b < 20),
    yellow: colorIn(x0, 166, x0 + 12, 250, (r, g, b) => r >= 200 && g >= 200 && b < 40),
    red: colorIn(x0, 166, x0 + 12, 250, (r, g, b) => r >= 200 && g < 40 && b < 40),
  });
  return {
    width: image.width,
    height: image.height,
    masterHeading: darkIn(8, 49, 82, 68),
    waveHeading: darkIn(98, 49, 174, 68),
    midiHeading: darkIn(188, 49, 264, 68),
    bodyInk: darkIn(8, 90, 266, 276),
    speakerInk:
      darkIn(10, 96, 27, 114) + darkIn(66, 96, 83, 114) +
      darkIn(100, 96, 117, 114) + darkIn(156, 96, 173, 114) +
      darkIn(190, 96, 207, 114) + darkIn(246, 96, 263, 114),
    scaleInk:
      darkIn(10, 143, 21, 252) + darkIn(49, 143, 59, 252) +
      darkIn(100, 143, 111, 252) + darkIn(139, 143, 149, 252) +
      darkIn(190, 143, 201, 252) + darkIn(229, 143, 239, 252),
    meters: [meter(64), meter(154), meter(244)],
  };
}

(async () => {
  const filesReady = [initialPng, activePng, mutedPng, adjustedPng].every(file =>
    fs.existsSync(file) && fs.statSync(file).size > 8000);
  const visual = filesReady ? await inspect(initialPng) : null;
  const active = filesReady ? await inspect(activePng) : null;
  const muted = filesReady ? await inspect(mutedPng) : null;
  const adjusted = filesReady ? await inspect(adjustedPng) : null;
  const meterColor = meter => meter.green + meter.yellow + meter.red;
  const checks = [
    ['emulator run completed', !runFailed],
    ['native mixer exposes master, Wave, and MIDI strips',
      /\[SetWindowText\] "Volume Control"/.test(output) &&
      /\[SetWindowText\] "Wave"/.test(output) && /\[SetWindowText\] "MIDI"/.test(output)],
    ['all six native trackbars were created',
      (output.match(/cls=19/g) || []).length === 6],
    ['dialog preserved the two speaker resource ordinals',
      (output.match(/imageOrd=301/g) || []).length === 3 &&
      (output.match(/imageOrd=302/g) || []).length === 3],
    ['master slider writes a non-default gain',
      /\[mixer\] master volume=0x(?!ffffffff)[0-9a-f]{8}/.test(output)],
    ['Wave slider writes its own gain',
      /\[mixer\] wave volume=0x58585858/.test(output)],
    ['MIDI slider writes a distinct gain',
      /\[mixer\] midi volume=0x86868686/.test(output)],
    ['Wave mute round-trips without replacing its volume',
      /\[mixer\] wave mute=1/.test(output) && /\[mixer\] wave mute=0/.test(output) &&
      !/\[mixer\] wave volume=0x0000000[01]/.test(output)],
    ['four complete screenshots were written', filesReady],
    ['initial screenshot has three labeled, populated strips', !!visual &&
      visual.width >= 275 && visual.height >= 300 &&
      visual.masterHeading >= 20 && visual.waveHeading >= 12 && visual.midiHeading >= 10 &&
      visual.bodyInk >= 400],
    ['speaker glyphs and vertical fader scales are visible', !!visual &&
      visual.speakerInk >= 80 && visual.scaleInk >= 30],
    ['idle peak meters start empty', !!visual && visual.meters.every(meter => meterColor(meter) === 0)],
    ['active master and Wave meters reach green, yellow, and red segments', !!active &&
      active.meters.slice(0, 2).every(meter => meter.green >= 200 && meter.yellow >= 40 && meter.red >= 40)],
    ['MIDI meter reports its lower independent activity level', !!active &&
      active.meters[2].green >= 100 && active.meters[2].yellow === 0 && active.meters[2].red === 0],
    ['Wave mute clears only the Wave meter', !!muted &&
      meterColor(muted.meters[1]) === 0 &&
      meterColor(muted.meters[0]) >= 100 && meterColor(muted.meters[2]) >= 100],
    ['adjusted screenshot retains complete mixer layout', !!adjusted &&
      adjusted.width === visual.width && adjusted.height === visual.height && adjusted.bodyInk >= 400],
    ['no unimplemented API or runtime crash',
      !/UNIMPLEMENTED API:|RuntimeError|LinkError|\*\*\* CRASH/.test(output)],
  ];

  if (runFailed) {
    console.error(output.split('\n').filter(line =>
      /UNIMPLEMENTED|Runtime|CRASH|mixer|dlg-dump/.test(line)).slice(-50).join('\n'));
  }
  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) failed++;
  }
  console.log(`Screenshots: ${OUT}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
