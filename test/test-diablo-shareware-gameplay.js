#!/usr/bin/env node
// Diablo Shareware: the single-player chain, from the main menu to a character
// walking around Tristram with its panels open.
//
// test-diablo-shareware-art.js stops at Choose Class and scores art against
// spawn.mpq. This test carries on past it, and its subject is *input*: every
// step here is a click or a keystroke that has to reach the right window.
// That is the part that broke -- until 3fe247f2 the Enter Name field ignored
// every keystroke, because nothing gave the dialog the focus, so Diablo
// validated an empty string and answered "Invalid name". Nothing caught that,
// because no test ever typed into the game.
//
// The five captures, from one ~4100-batch run (~90s):
//
//   name  the Enter Name field with "GAL" typed into it. The assertion is that
//         the field has ink in it at all -- lit pixels inside the empty box
//         that were not there before a key was pressed.
//   town  Tristram after OK. Anchored on the two HUD orbs, which are the most
//         unmistakable thing on the screen: a saturated red disc at (148,400)
//         and a saturated blue one at (492,400). A menu, a dialog or a black
//         frame has neither.
//   walk  after clicking the ground. Scored as "the view changed" against
//         town, which is what walking looks like -- the camera scrolls.
//   char  the Character panel over the left half. Scored as a luminance jump
//         in that half: the stone panel is far brighter than night-time
//         Tristram behind it.
//   inv   the Inventory panel over the right half, same measurement mirrored,
//         and the Character panel still up (Diablo shows both at once).
//
// Why not compare against golden PNGs: the art test can use spawn.mpq as an
// oracle because it scores static sprites, but a gameplay frame depends on
// where the character walked and what the day/night palette is doing. These
// assertions are deliberately about *structure* -- orbs present, panel
// brighter than the ground behind it, view moved -- so they survive a
// different-looking frame but fail on a blank one, a stuck one, or a menu.
//
// The command line is pinned. Runs are deterministic for a fixed command line,
// but changing the flags changes the execution (see the re-notes), so the
// batch numbers are only meaningful with exactly these flags.
//
// `node test/test-diablo-shareware-gameplay.js <dir>` skips the run and
// re-scores an existing capture directory. That is how the thresholds below
// were separated from real captures rather than guessed.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const assert = require('assert');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const INSTALLED = path.join(ROOT, 'test/binaries/candidates/diablo-shareware/installed');
const MPQ = path.join(INSTALLED, 'spawn.mpq');
const OUTDIR = path.join(ROOT, 'build/diablo-shareware-gameplay');
const LOG = path.join(ROOT, 'build/diablo-shareware-gameplay.log');

const ANALYZE_ONLY = process.argv[2];
const DIR = ANALYZE_ONLY || OUTDIR;

if (!fs.existsSync(MPQ)) {
  console.log('SKIP  Diablo Shareware install missing');
  process.exit(0);
}

// ---------------------------------------------------------------- the one run

// Menu item y coordinates, 640x480: Single Player 213, Multi Player 256.
const SINGLE_PLAYER = [320, 213];
const WARRIOR = [420, 298];
const OK = [348, 446];
const GROUND = [450, 230];      // somewhere walkable, right of the start point
const CHAR_BUTTON = [40, 368];
const INV_BUTTON = [590, 373];

const shot = name => path.join(DIR, `${name}.png`);

// A click is three events: run.js's `click` action is invisible to a game that
// samples the button once per frame, so press and release are separated.
function click([x, y], at) {
  return [`${at}:mousemove:${x}:${y}`, `${at + 40}:mousedown:${x}:${y}`,
    `${at + 80}:mouseup:${x}:${y}`];
}

// TranslateMessage does not synthesize WM_CHAR for us, so a typed character is
// a keydown (VK, uppercase) plus a keypress (the character itself), which is
// the pair the browser host posts.
function type(vk, ch, at) {
  return [`${at}:keydown:${vk}`, `${at + 10}:keypress:${ch}`];
}

if (!ANALYZE_ONLY) {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const input = [
    ...click(SINGLE_PLAYER, 1000),
    ...click(WARRIOR, 1300),
    ...click(OK, 1600),
    ...type(71, 103, 1900),       // G
    ...type(65, 97, 1950),        // A
    ...type(76, 108, 2000),       // L
    `2100:png:${shot('name')}`,
    ...click(OK, 2200),
    `2900:png:${shot('town')}`,
    ...click(GROUND, 3000),
    `3300:png:${shot('walk')}`,
    ...click(CHAR_BUTTON, 3400),
    `3600:png:${shot('char')}`,
    ...click(INV_BUTTON, 3700),
    `3950:png:${shot('inv')}`,
  ];

  // --batch-size=200000 is what makes this cheap: Diablo paces its intro off
  // timeGetTime, so at the default budget the Blizzard North logo alone eats
  // tens of thousands of batches. --no-close is required for any PNG to be
  // written at all.
  const cmd = `node "${RUN}" --app=diablo_shareware --batch-size=200000`
    + ` --tick-ms-per-batch=50 --max-batches=4100 --no-close --repaint-every=20`
    + ` --input='${input.join(',')}' > "${LOG}" 2>&1`;
  console.log('$', cmd);
  try {
    // ~90s on an idle box. This machine routinely sits at load 20+ with other
    // agents sweeping, where the same run takes several times that, so the cap
    // is generous on purpose: a tight one turns a busy box into a "Diablo
    // regressed" report, which is a far more alarming claim than the truth.
    execSync(cmd, { encoding: 'utf-8', timeout: 600000, cwd: ROOT });
  } catch (e) {
    const tail = fs.existsSync(LOG)
      ? fs.readFileSync(LOG, 'utf-8').split('\n').slice(-40).join('\n') : '';
    console.error(tail);
    // A killed run and a crashed one look identical from here and need
    // opposite responses: one is "check the box load", the other is a defect.
    const timedOut = e.killed || e.signal === 'SIGTERM';
    const finished = /Stats: \d+ API calls/.test(tail);
    throw new Error(timedOut && !finished
      ? 'the Diablo Shareware run was killed by the harness timeout before it '
        + 'finished — check the box load (uptime) and re-run before reading '
        + 'this as a regression'
      : 'the Diablo Shareware run did not finish');
  }
}

// ------------------------------------------------------------------ measuring

function readPng(name) {
  const p = shot(name);
  assert(fs.existsSync(p), `${name}.png was not captured — the run did not `
    + 'reach that step; read ' + LOG);
  return PNG.sync.read(fs.readFileSync(p));
}

// Mean Rec.601 luminance over a rectangle.
function meanLum(png, x0, y0, x1, y1) {
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (png.width * y + x) << 2;
      sum += (png.data[i] * 299 + png.data[i + 1] * 587 + png.data[i + 2] * 114) / 1000;
      n++;
    }
  }
  return n ? sum / n : 0;
}

// Pixels brighter than a threshold — the Enter Name field is a black box, so
// its own text is simply everything lit inside it.
function lit(png, x0, y0, x1, y1, threshold) {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (png.width * y + x) << 2;
      const l = (png.data[i] * 299 + png.data[i + 1] * 587
        + png.data[i + 2] * 114) / 1000;
      if (l > threshold) n++;
    }
  }
  return n;
}

// Pixels where one channel dominates both others — the orbs are saturated in a
// way nothing else on the HUD is, so this separates them from the stonework.
function dominant(png, x0, y0, x1, y1, channel) {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (png.width * y + x) << 2;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (channel === 'r' && r > 40 && r > g * 2 && r > b * 2) n++;
      if (channel === 'b' && b > 40 && b > r * 1.5 && b > g * 1.2) n++;
    }
  }
  return n;
}

// Share of pixels that differ by more than a small tolerance.
function changedShare(a, b, x0, y0, x1, y1) {
  let n = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (a.width * y + x) << 2;
      const d = Math.abs(a.data[i] - b.data[i])
        + Math.abs(a.data[i + 1] - b.data[i + 1])
        + Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (d > 24) n++;
      total++;
    }
  }
  return total ? n / total : 0;
}

const name = readPng('name');
const town = readPng('town');
const walk = readPng('walk');
const chr = readPng('char');
const inv = readPng('inv');

// The Enter Name box interior, inside its border and clear of the two red
// pentagram cursors that flank the text.
const FIELD = [300, 305, 545, 345];
// The two HUD orbs.
const LIFE_ORB = [110, 365, 186, 436];
const MANA_ORB = [455, 365, 531, 436];
// The halves the two panels cover, above the HUD.
const LEFT_PANEL = [8, 8, 320, 340];
const RIGHT_PANEL = [330, 8, 632, 340];

const fieldLit = lit(name, ...FIELD, 60);

const measured = {
  'name field lit px': fieldLit,
  'town life-orb red px': dominant(town, ...LIFE_ORB, 'r'),
  'town mana-orb blue px': dominant(town, ...MANA_ORB, 'b'),
  'town left-half lum': meanLum(town, ...LEFT_PANEL).toFixed(1),
  'char left-half lum': meanLum(chr, ...LEFT_PANEL).toFixed(1),
  'town right-half lum': meanLum(town, ...RIGHT_PANEL).toFixed(1),
  'inv right-half lum': meanLum(inv, ...RIGHT_PANEL).toFixed(1),
  'inv left-half lum': meanLum(inv, ...LEFT_PANEL).toFixed(1),
  'walk vs town changed': changedShare(walk, town, 0, 0, 640, 340).toFixed(3),
};
for (const [k, v] of Object.entries(measured)) console.log(`  ${k}: ${v}`);

// ---------------------------------------------------------------- assertions

// Measured: 108 lit px with "GAL" typed, 31 with the field empty (the box's
// own border and the two pentagram cursors). 60 sits between them.
assert(fieldLit > 60,
  `the Enter Name field is empty (${fieldLit} lit px) — the keystrokes did `
  + 'not reach it, which is the "Invalid name" defect (see the focus rules in '
  + '$handle_DefDlgProcA and $handle_ShowWindow)');

const life = dominant(town, ...LIFE_ORB, 'r');
const mana = dominant(town, ...MANA_ORB, 'b');
// Measured: 2507 red / 1038 blue on a Tristram frame, and 0 / 0 on the Choose
// Class menu — nothing else in this app puts a saturated disc there.
assert(life > 800 && mana > 400,
  `Tristram's HUD orbs are missing (life ${life}px, mana ${mana}px) — the run `
  + 'did not reach gameplay after OK on the name dialog');

const moved = changedShare(walk, town, 0, 0, 640, 340);
assert(moved > 0.05,
  `the view did not change after clicking the ground (${(moved * 100).toFixed(1)}% `
  + 'of the play area differs) — the character is not walking');

const townLeft = meanLum(town, ...LEFT_PANEL);
const charLeft = meanLum(chr, ...LEFT_PANEL);
assert(charLeft > townLeft * 1.8,
  `the Character panel did not open (left half ${charLeft.toFixed(1)} vs `
  + `${townLeft.toFixed(1)} without it)`);

const townRight = meanLum(town, ...RIGHT_PANEL);
const invRight = meanLum(inv, ...RIGHT_PANEL);
assert(invRight > townRight * 1.5,
  `the Inventory panel did not open (right half ${invRight.toFixed(1)} vs `
  + `${townRight.toFixed(1)} without it)`);

// Diablo keeps both panels up at once; if opening Inventory closed Character,
// the routing sent the click to the wrong place.
assert(meanLum(inv, ...LEFT_PANEL) > townLeft * 1.8,
  'opening the Inventory closed the Character panel');

if (!ANALYZE_ONLY) {
  const log = fs.readFileSync(LOG, 'utf-8');
  const bad = log.match(/UNIMPLEMENTED API: \S+/);
  assert(!bad, `the run hit ${bad && bad[0]}`);
  assert(!/RuntimeError|unreachable/.test(log),
    'the run trapped — read ' + LOG);
}

console.log('PASS  Diablo Shareware types a hero name and plays: Tristram, '
  + 'walking, Character and Inventory panels');
