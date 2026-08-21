#!/usr/bin/env node
// Every command on 16-bit Hearts' two menus.
//
//   node test/test-win16-hearts-menus.js
//
// The menu sweep never covered these. It drives a freshly launched app, and
// Hearts at that moment is still inside its modal startup dialog asking who is
// playing — so the sweep's commands went to a window that was not yet taking
// them, and Hearts' menus were reported as untested rather than as working.
// Here the dialog is answered first, which is what makes the menu reachable.
//
// Two of the commands found real bugs, and neither is Hearts-specific:
//
//   1. Game > Score opens a dialog, and MFC centres a dialog on its parent
//      with GetParent/GetClientRect/ClientToScreen. USER.28 ClientToScreen and
//      USER.29 ScreenToClient did not exist, so the app died on the way to its
//      own scoreboard.
//   2. Dialog template 502 holds ONE control — the OK button — and the whole
//      score grid is drawn by the task from WM_PAINT. Creating a dialog seeded
//      a first paint for every control and never for the dialog itself, which
//      no dialog made only of controls can notice. The sheet came up as an
//      empty grey box. Painting it then wanted GDI.56 CreateFont, which was
//      also missing.
//
// Sound is a toggle and About is drawn by ShellAbout rather than from a
// template, so neither should produce a dialog; asserting that is what keeps a
// "put a dialog up for everything" regression honest.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'output', 'win16-hearts-menus');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'MSHEARTS.EXE');

// The startup dialog: the name field, "I want to be dealer", and OK.
const ANSWER_STARTUP =
  '3000:click:200:122,3500:keypress:65,4500:click:55:210,6000:click:319:92';

let pass = 0;
function check(name, cond, detail) {
  assert(cond, detail ? `${name} -- ${detail}` : name);
  console.log(`PASS  ${name}`);
  pass++;
}

// Post a WM_COMMAND for one menu id and screenshot the result.
function menu(id, shot, batches = 26000) {
  const log = execFileSync('node', [
    path.join(ROOT, 'test', 'run.js'), `--exe=${EXE}`,
    `--max-batches=${batches}`,
    `--input=${ANSWER_STARTUP},12000:post-cmd:${id},${batches - 4000}:png:${shot}`,
  ], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  return {
    log,
    clean: !/CRASH|UNIMPLEMENTED API|STUCK/.test(log),
    // The startup dialog is the first one; anything past it is the menu's.
    dialogs: (log.match(/^\[CreateDialog\].*$/gm) || []).length - 1,
  };
}

// Ink that is neither the dialog face nor its shadow/highlight edges, counted
// inside a rectangle: the test for "something was actually drawn here".
function inkIn(file, x0, y0, x1, y1) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let ink = 0;
  for (let y = y0; y < y1 && y < png.height; y++) {
    for (let x = x0; x < x1 && x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      if (!(r === 192 && g === 192 && b === 192) &&
          !(r === 255 && g === 255 && b === 255) &&
          !(r === 128 && g === 128 && b === 128)) ink++;
    }
  }
  return ink;
}

function main() {
  if (!fs.existsSync(EXE)) { console.log('SKIP  MSHEARTS.EXE not found'); return; }
  fs.mkdirSync(OUT, { recursive: true });

  // --- Game > Options (128): three radio buttons and three player names.
  const options = menu(128, path.join(OUT, 'options.png'));
  check('Options did not crash', options.clean);
  check('Options opened its dialog', options.dialogs === 1, `${options.dialogs}`);
  check('the Options dialog has content drawn in it',
    inkIn(path.join(OUT, 'options.png'), 35, 60, 310, 330) > 400);

  // --- Game > Score (125): the sheet is painted by the task, not built from
  // controls, so an empty body is the bug this pins.
  const score = menu(125, path.join(OUT, 'score.png'));
  check('Score did not crash', score.clean);
  check('Score opened its dialog', score.dialogs === 1, `${score.dialogs}`);
  // The player-name header row, well clear of the OK button on the right.
  check('the Score Sheet painted its own client area',
    inkIn(path.join(OUT, 'score.png'), 145, 150, 400, 170) > 20,
    'an empty grey box here means the dialog never got WM_PAINT');

  // --- Game > Sound (124): a toggle. No dialog, and it must survive.
  const sound = menu(124, path.join(OUT, 'sound.png'));
  check('Sound did not crash', sound.clean);
  check('Sound put up no dialog', sound.dialogs === 0, `${sound.dialogs}`);

  // --- Help > Quote (127).
  const quote = menu(127, path.join(OUT, 'quote.png'));
  check('Quote did not crash', quote.clean);
  check('Quote opened its dialog', quote.dialogs === 1, `${quote.dialogs}`);
  check('the Quote dialog has its text drawn',
    inkIn(path.join(OUT, 'quote.png'), 45, 110, 285, 180) > 200);

  // --- Help > About Hearts (101): ShellAbout, not a template.
  const about = menu(101, path.join(OUT, 'about.png'));
  check('About did not crash', about.clean);
  check('About put up no template dialog', about.dialogs === 0, `${about.dialogs}`);
  check('the About box drew its text',
    inkIn(path.join(OUT, 'about.png'), 100, 70, 340, 130) > 200);

  // --- Help > Help Topics (106). There is no MSHEARTS.HLP in the tree, so the
  // right behaviour is to ask WinHelp for the index and carry on; the check is
  // that it asks, and that a missing help file is not fatal.
  const help = execFileSync('node', [
    path.join(ROOT, 'test', 'run.js'), `--exe=${EXE}`, '--max-batches=26000',
    '--trace-win16', `--input=${ANSWER_STARTUP},12000:post-cmd:106`,
  ], { encoding: 'utf8', timeout: 600000, maxBuffer: 256 * 1024 * 1024 });
  check('Help Topics did not crash', !/CRASH|UNIMPLEMENTED API|STUCK/.test(help));
  check('Help Topics asked WinHelp for the index',
    /USER\.171 WINHELP\(0x00000000, 0x00000000, 0x00000003/.test(help));

  // --- Game > New Game (102) with the menu, then Score again: the sheet now
  // has the three computer players in it, which is the evidence the paint is
  // reading real game state rather than drawing a fixed header.
  const table = path.join(OUT, 'score-in-game.png');
  const played = execFileSync('node', [
    path.join(ROOT, 'test', 'run.js'), `--exe=${EXE}`, '--max-batches=80000',
    `--input=${ANSWER_STARTUP},30000:post-cmd:102,60000:post-cmd:125,` +
      `72000:png:${table}`,
  ], { encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  check('New Game then Score did not crash',
    !/CRASH|UNIMPLEMENTED API|STUCK/.test(played));
  check('the in-game Score Sheet lists the computer players too',
    inkIn(table, 145, 150, 430, 170) > 120,
    'one name only means the sheet is drawing a header, not the table');

  console.log(`\n${pass} passed, 0 failed`);
  console.log(`Snapshots: ${OUT}`);
}

main();
