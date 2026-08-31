#!/usr/bin/env node
'use strict';

// Age of Empires II Trial web/app acceptance. The browser used to mount only
// the 25 core data files, so the dynamically loaded first-run EULA DLL was
// absent and EMPIRES2.EXE exited cleanly before creating its main window. Even
// a local run that found the sibling DLL had no campaign/scenario files after
// player creation. Drive the registered app through first run and a trial
// coastal-map game, then require a real terrain-and-HUD gameplay frame.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createCanvas, loadImage } = require('../lib/canvas-compat');
const { APPS } = require('../lib/apps');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'shareware', 'aoe2', 'aoe2_ex', 'EMPIRES2.EXE');
const OUT = path.join(ROOT, 'scratch');
const NAME_PNG = path.join(OUT, 'aoe2_player_name.png');
const GAMEPLAY_PNG = path.join(OUT, 'aoe2_gameplay.png');
const PAN_PNG = path.join(OUT, 'aoe2_gameplay_pan_left.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  EMPIRES2.EXE not found');
  process.exit(0);
}
if (!createCanvas || !loadImage) {
  console.log('SKIP  canvas backend not available');
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
try { fs.unlinkSync(GAMEPLAY_PNG); } catch (_) {}
try { fs.unlinkSync(NAME_PNG); } catch (_) {}
try { fs.unlinkSync(PAN_PNG); } catch (_) {}

const fileUrls = (APPS.aoe2.files || []).map(file =>
  String(typeof file === 'string' ? file : file.url).replace(/\\/g, '/').toLowerCase());
const manifestChecks = [
  ['web manifest includes the dynamic EULA DLL', '/ebueula.dll'],
  ['web manifest includes the EULA document', '/eula.rtf'],
  ['web manifest includes the trial campaign', '/campaign/cam8.cpn'],
  ['web manifest includes the coastal scenario', '/scenario/trial coastal map.scn'],
].map(([name, suffix]) => ({ name, pass: fileUrls.some(url => url.endsWith(suffix)) }));

const inputSpec = [
  // Full EULA Accept, then the 800x600 DirectDraw menu through the renderer's
  // 640x480 exclusive transform.
  '10:click:104:415',
  '120:click:290:25',                 // Single Player
  '145:click:335:240',                // player-name input child
  '150:keypress:67', '152:keypress:111', '154:keypress:100',
  '156:keypress:101', '158:keypress:120',
  `170:png:${NAME_PNG}`,
  '180:click:259:284',                // player dialog OK
  '220:click:486:136',                // Random Map
  '280:click:95:455',                 // Start Game
  '360:click:240:454',                // select Trial Coastal Map
  `1600:png:${GAMEPLAY_PNG}`,
  // Hold left long enough to pan the camera into black fog. AoE's 24x32
  // software-cursor background used to be restored after each redraw, leaving
  // a horizontal trail of terrain rectangles in this otherwise black band.
  '1602:keydown:37',
  '1640:keyup:37',
  `1650:png:${PAN_PNG}`,
  '1651:stop',
].join(',');

const args = [
  RUN,
  '--app=aoe2',
  '--no-build',
  '--no-close',
  '--quiet-api',
  '--quiet-blocks',
  '--max-batches=1652',
  '--batch-size=50000',
  '--tick-ms-per-batch=100',
  '--repaint-every=100',
  '--stuck-after=50000',
  `--input=${inputSpec}`,
];

console.log('$ node', args.map(arg => arg.replace(ROOT, '.')).join(' '));

let output = '';
let exitCode = 0;
try {
  output = execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (error) {
  output = String(error.stdout || '') + String(error.stderr || '');
  exitCode = error.status == null ? 1 : error.status;
}

async function analyzeGameplay(file) {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
  let green = 0;
  let detailed = 0;
  let worldTotal = 0;
  let darkHud = 0;
  let hudTotal = 0;
  const worldBottom = Math.min(360, image.height);
  for (let y = 0; y < worldBottom; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (g > r * 1.08 && g > b * 1.18 && g > 45) green++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 35) detailed++;
      worldTotal++;
    }
  }
  for (let y = Math.min(375, image.height); y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (pixels[i] < 80 && pixels[i + 1] < 80 && pixels[i + 2] < 80) darkHud++;
      hudTotal++;
    }
  }
  return {
    width: image.width,
    height: image.height,
    greenRatio: green / worldTotal,
    detailRatio: detailed / worldTotal,
    darkHudRatio: darkHud / hudTotal,
  };
}

async function analyzePlayerName(file) {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  // The 800x600 child EDIT is presented at 0.8x in the 640x480 test canvas.
  // A covered field is uniformly black here; a painted native EDIT has its
  // white client background and the dark "Codex" glyphs.
  const pixels = ctx.getImageData(275, 230, 126, 18).data;
  let light = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 120) light++;
  }
  return { light };
}

async function analyzeFogArtifacts(file) {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
  let colored = 0;
  // Exclude the top status strip, lower HUD, and screen edges. After the held
  // pan this rectangle is unexplored fog; stale cursor restores contributed
  // 1,800 colored pixels in repeated 24x32 islands, while a clean frame is 0.
  for (let y = 60; y < Math.min(340, image.height); y++) {
    for (let x = 20; x < Math.min(620, image.width); x++) {
      const i = (y * image.width + x) * 4;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (Math.max(r, g, b) > 30 && Math.max(r, g, b) - Math.min(r, g, b) > 8) colored++;
    }
  }
  return { colored };
}

(async () => {
  const checks = [...manifestChecks];
  const nameWritten = fs.existsSync(NAME_PNG) && fs.statSync(NAME_PNG).size > 100000;
  checks.push({ name: 'live player-name screenshot was written', pass: nameWritten });
  if (nameWritten) {
    const name = await analyzePlayerName(NAME_PNG);
    console.log(`  player-name field light pixels=${name.light}`);
    checks.push({ name: 'typed player name is visibly painted before OK', pass: name.light > 1000 });
  } else {
    checks.push({ name: 'typed player name is visibly painted before OK', pass: false });
  }

  const panWritten = fs.existsSync(PAN_PNG) && fs.statSync(PAN_PNG).size > 100000;
  checks.push({ name: 'held camera-pan screenshot was written', pass: panWritten });
  if (panWritten) {
    const fog = await analyzeFogArtifacts(PAN_PNG);
    console.log(`  panned fog colored pixels=${fog.colored}`);
    checks.push({ name: 'camera pan leaves no stale cursor-background terrain rectangles',
      pass: fog.colored < 100 });
  } else {
    checks.push({ name: 'camera pan leaves no stale cursor-background terrain rectangles', pass: false });
  }
  const screenshotWritten = fs.existsSync(GAMEPLAY_PNG) && fs.statSync(GAMEPLAY_PNG).size > 100000;
  checks.push({ name: 'AoE II gameplay screenshot was written', pass: screenshotWritten });

  if (screenshotWritten) {
    const frame = await analyzeGameplay(GAMEPLAY_PNG);
    console.log(`  frame ${frame.width}x${frame.height} green=${frame.greenRatio.toFixed(3)} detail=${frame.detailRatio.toFixed(3)} darkHud=${frame.darkHudRatio.toFixed(3)}`);
    checks.push({ name: 'gameplay frame has a rendered terrain world',
      pass: frame.width === 640 && frame.height === 480 &&
        frame.greenRatio > 0.25 && frame.detailRatio > 0.55 });
    checks.push({ name: 'gameplay frame has the lower command/minimap HUD',
      pass: frame.darkHudRatio > 0.25 });
  } else {
    checks.push({ name: 'gameplay frame has a rendered terrain world', pass: false });
    checks.push({ name: 'gameplay frame has the lower command/minimap HUD', pass: false });
  }

  checks.push({ name: 'trial scenario launch inputs were delivered',
    pass: /\[input\] click 95,455 at batch 280/.test(output) &&
      /\[input\] click 240,454 at batch 360/.test(output) &&
      /\[input\] keydown vk=37 at batch 1602/.test(output) &&
      /\[input\] keyup vk=37 at batch 1640/.test(output) });
  checks.push({ name: 'run reached gameplay without a crash or clean early exit',
    pass: exitCode === 0 && !/\[Exit(?:Process)?\]|STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/.test(output) });

  let failed = 0;
  for (const check of checks) {
    console.log((check.pass ? 'PASS  ' : 'FAIL  ') + check.name);
    if (!check.pass) failed++;
  }
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  console.log(`Screenshot: ${GAMEPLAY_PNG}`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
