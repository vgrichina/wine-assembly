#!/usr/bin/env node
// Smoke-test every notepad WM_COMMAND that opens a WAT-built dialog
// (About, Find, Open, Font, Page Setup), driven via test/run.js as a
// subprocess.  For each dialog we assert:
//
//   1. test/run.js exits 0
//   2. the per-hwnd back-canvas PNG it writes is present
//   3. the dialog window is registered with the expected title substring
//   4. the PNG is non-trivial (enough distinct pixels to prove both the
//      chrome and the interior painted)
//
// The PNG files land in test/output/dialogs/ so a human can eyeball the
// regression when a check fails.
//
// We deliberately do NOT golden-diff pixels: font rasterization varies
// between host node-canvas builds.  A distinct-color floor catches the
// "frameless / all-btnface" regression without being fragile.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

const ROOT = path.join(__dirname, '..');
const OUT  = path.join(ROOT, 'test', 'output', 'dialogs');
fs.mkdirSync(OUT, { recursive: true });

const NOTEPAD = path.join(ROOT, 'test', 'binaries', 'notepad.exe');
const RUN_JS  = path.join(ROOT, 'test', 'run.js');

// cmdId → notepad WM_COMMAND id (see tools/parse-rsrc.js on notepad.exe)
const CASES = [
  { name: 'about',     cmd: 11, title: 'About Notepad', minColors: 32 },
  { name: 'find',      cmd:  3, title: 'Find',          minColors: 24 },
  { name: 'open',      cmd: 10, title: 'Open',          minColors: 32 },
  { name: 'font',      cmd: 37, title: 'Font',          minColors: 32 },
  { name: 'pagesetup', cmd: 32, title: 'Page Setup',    minColors: 16 },
];

async function countUniqueColors(pngPath) {
  const img = await loadImage(pngPath);
  const c = createCanvas(img.width, img.height);
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  const px = cx.getImageData(0, 0, img.width, img.height).data;
  const seen = new Set();
  for (let i = 0; i < px.length; i += 4) {
    seen.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
  }
  return seen.size;
}

async function runCase({ name, cmd, title, minColors }) {
  const pngBase = path.join(OUT, `${name}.png`);
  const args = [
    RUN_JS,
    '--exe=' + NOTEPAD,
    '--max-batches=8000',
    `--input=3000:post-cmd:${cmd},0`,
    '--png=' + pngBase,
  ];
  let stdout;
  try {
    stdout = execFileSync('node', args, { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    return { name, pass: false, reason: 'run.js crashed: ' + (err.stderr || err.message).slice(-300) };
  }

  // Find the dialog hwnd line in the trailing window summary.
  const dialogLine = stdout.split('\n').reverse().find(l => l.includes(`title="${title}`));
  if (!dialogLine) {
    return { name, pass: false, reason: `no window with title ~="${title}" in summary` };
  }
  const hwndMatch = dialogLine.match(/hwnd=(\d+)/);
  if (!hwndMatch) return { name, pass: false, reason: 'couldn\'t parse hwnd from: ' + dialogLine };
  const hwnd = Number(hwndMatch[1]);

  const backPng = pngBase.replace(/\.png$/, `_back_${hwnd}.png`);
  if (!fs.existsSync(backPng)) {
    return { name, pass: false, reason: 'expected back-canvas PNG missing: ' + backPng };
  }
  const colors = await countUniqueColors(backPng);
  if (colors < minColors) {
    return { name, pass: false, reason: `only ${colors} distinct colors (min ${minColors}) in ${backPng}` };
  }
  return { name, pass: true, info: `hwnd=0x${hwnd.toString(16)} colors=${colors} ${path.basename(backPng)}` };
}

(async () => {
  let failed = 0;
  for (const c of CASES) {
    const r = await runCase(c);
    if (r.pass) {
      console.log(`PASS  ${r.name.padEnd(10)}  ${r.info}`);
    } else {
      failed++;
      console.log(`FAIL  ${r.name.padEnd(10)}  ${r.reason}`);
    }
  }
  console.log('');
  console.log(`${CASES.length - failed}/${CASES.length} dialogs rendered correctly`);
  process.exit(failed ? 1 : 0);
})();
