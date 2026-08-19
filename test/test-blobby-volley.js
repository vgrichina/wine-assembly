#!/usr/bin/env node
// Blobby Volley (2001, Delphi/VCL + DirectDraw) — boot to the menu, click
// SPIEL STARTEN, and check that a match is actually running.
//
// What this pins down:
//   - The VCL startup shape works: TApplication (0x0 hidden) is created first
//     and becomes $main_hwnd, then TForm1 becomes the real 800x600 UI window,
//     then a TThreadWindow. Everything after this depends on messages reaching
//     TForm1 rather than TApplication.
//   - graph.pak (619KB, read in 0x300-byte chunks) decodes into the menu and
//     court backdrops. A flat or single-colour frame means the .pak path broke.
//   - The game pumps with PeekMessageA, never GetMessageA, so injected input
//     has to survive $handle_PeekMessageA's hardware-input path.
//
// Input recipe, and it is not optional: the game tracks the mouse from
// WM_MOUSEMOVE and hit-tests menu entries against *its own* cursor, ignoring
// the click's lParam. A click with no preceding mousemove lands wherever the
// game last thought the pointer was, and does nothing. Move, then click.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'candidates', 'blobby-volley', 'volley.exe');
const OUT = path.join(ROOT, 'scratch', 'blobby-volley');
const MENU_PNG = path.join(OUT, 'menu.png');
const GAME_PNG = path.join(OUT, 'match.png');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  volley.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });

// "SPIEL STARTEN", the first menu entry, sits at roughly (400,222) in the
// 640x480 DirectDraw frame.
const input = [
  '480:png:' + MENU_PNG,
  '500:mousemove:400:222',
  '520:mousemove:401:223',   // second move: the game only redraws its cursor on a delta
  '560:mousedown:401:223',
  '600:mouseup:401:223',
  '699:png:' + GAME_PNG,
].join(',');

const args = [
  RUN,
  `--exe=${EXE}`,
  '--max-batches=700',
  '--batch-size=200000',
  '--no-close',
  '--quiet-api',
  '--quiet-blocks',
  `--input=${input}`,
];
console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

let out = '';
let exitCode = 0;
try {
  out = execFileSync('node', args, {
    cwd: ROOT, encoding: 'utf8', timeout: 180000,
    maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  exitCode = e.status ?? 1;
}

function stats(file) {
  if (!fs.existsSync(file)) return null;
  const img = PNG.sync.read(fs.readFileSync(file));
  const total = img.width * img.height;
  let lum = 0, sky = 0, sand = 0, red = 0, green = 0, logo = 0;
  const seen = new Set();
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    lum += 0.299 * r + 0.587 * g + 0.114 * b;
    seen.add((r << 16) | (g << 8) | b);
    if (b > 180 && r < 120 && g < 160) sky++;              // daylight sky ~ 60,98,235
    if (r > 140 && g > 120 && b > 60 && b < 130) sand++;   // court sand ~ 167,154,83
    if (r > 150 && g < 70 && b < 70) red++;                // player 1 blobby ~ 192,0,0
    if (g > 150 && r < 70 && b < 70) green++;              // player 2 blobby ~ 0,192,0
    if (b > 200 && r < 120 && g < 110) logo++;             // menu logo outline ~ 54,44,247
  }
  return {
    w: img.width, h: img.height, colors: seen.size, lum: lum / total,
    sky: sky / total, sand: sand / total, red, green, logo,
  };
}

const menu = stats(MENU_PNG);
const game = stats(GAME_PNG);

const checks = [
  { name: 'run.js exited cleanly', pass: exitCode === 0 },
  { name: 'no unimplemented API', pass: !/UNIMPLEMENTED API:/.test(out) },
  // VCL creates TApplication first; the real window is TForm1.
  { name: 'VCL created TApplication + TForm1',
    pass: /CreateWindow.*title="volley"/.test(out) && /SetWindowText.*"Blobby Volley"/.test(out) },
  { name: 'menu frame captured 640x480',
    pass: !!menu && menu.w === 640 && menu.h === 480 },
  // graph.pak decoded: the night-beach menu backdrop is dark but richly
  // shaded. A blank fill or a failed .pak read collapses both numbers.
  { name: 'menu is the decoded night-beach art',
    pass: !!menu && menu.lum < 70 && menu.colors > 2000 },
  { name: 'menu shows the Blobby Volley logo', pass: !!menu && menu.logo > 1000 },
  { name: 'match frame captured', pass: !!game && game.w === 640 && game.h === 480 },
  // Clicking SPIEL STARTEN swaps the night menu for the daylight court.
  { name: 'clicking SPIEL STARTEN started a match',
    pass: !!game && game.sky > 0.08 && game.sand > 0.20 },
  { name: 'both blobbies are on court',
    pass: !!game && game.red > 100 && game.green > 100 },
];

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
const fmt = s => s ? `lum=${s.lum.toFixed(1)} colors=${s.colors} sky=${s.sky.toFixed(3)} ` +
  `sand=${s.sand.toFixed(3)} red=${s.red} green=${s.green} logo=${s.logo}` : '(no frame)';
console.log('');
console.log('menu:  ' + fmt(menu));
console.log('match: ' + fmt(game));
console.log('Screenshots: ' + OUT);
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
