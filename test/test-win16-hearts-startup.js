#!/usr/bin/env node
// Hearts getting as far as asking who it is playing with.
//
//   node test/test-win16-hearts-startup.js
//
// Hearts is the only one of the four 16-bit games that is an MFC app, and it
// spent a long time never reaching its own UI: it went straight to "Unable to
// connect with dealer. Hearts will end." because it believed it had been told
// to join somebody else's game. What it should do first is put up the dialog
// that asks for your name and whether you want to be the dealer.
//
// Five separate things had to be right for that dialog to appear, work, and
// close, and every one of them is a different layer, so this is worth pinning
// down as a sequence rather than as a screenshot:
//
//   1. The task's command line has to be an empty *string*. It is the same
//      pointer WinMain gets as lpCmdLine, so it is null-terminated, not
//      carriage-return-terminated the way DOS leaves it.
//   2. The command that opens the dialog is posted, and must arrive once.
//   3. The dialog's controls have to be findable by id, which means Win16
//      GetDlgItem has to be handed the id the task passed.
//   4. MFC attaches its C++ object to the window from inside the
//      WH_CALLWNDPROC filter, so creating the dialog has to run that filter.
//   5. MFC then subclasses the window, so the OK button's command has to reach
//      the *window* procedure, and the procedure behind that has to end the
//      dialog the way DefDlgProc does.
//
// Then two more, to get a game on the table rather than a dialog:
//
//   6. Hearts will not let you choose how to play until NDDEAPI.DLL loads and
//      NDdeGetWindow answers with a window, so both radio buttons are greyed
//      and neither path is open to it.
//   7. Control messages are numbered per class from WM_USER in Win16 and in
//      distinct ranges in Win32, so BM_GETCHECK has to be translated or the
//      radio buttons all answer "not me".

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'output', 'win16-hearts');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'MSHEARTS.EXE');

// Points on the startup dialog, each the dialog's client origin (18,69) plus
// the control's position in its own template.
const OK_CLICK = '319:92';        // OK, at client 264,12 size 75x24
const NAME_CLICK = '200:122';     // the name edit, id 201
const DEALER_CLICK = '55:210';    // "I want to be dealer", id 203

let pass = 0;
function check(name, cond, detail) {
  assert(cond, detail ? `${name} -- ${detail}` : name);
  console.log(`PASS  ${name}`);
  pass++;
}

// --repaint-every is not a detail: the harness composites the whole 640x480
// canvas after every batch by default, which costs about forty times what
// running the guest does, and the longest run here is sixty thousand batches.
// The `png` input action forces its own repaint, so the screenshots this test
// reads are unaffected.
function run(inputs, batches) {
  return execFileSync('node', [
    path.join(ROOT, 'test', 'run.js'), `--exe=${EXE}`,
    `--max-batches=${batches}`, '--repaint-every=200', `--input=${inputs}`,
  ], { encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
}

function inkFraction(file, x0, y0, x1, y1) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let ink = 0, total = 0;
  for (let y = y0; y < y1 && y < png.height; y++) {
    for (let x = x0; x < x1 && x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      total++;
      if (!(png.data[i] === 192 && png.data[i + 1] === 192 && png.data[i + 2] === 192)) ink++;
    }
  }
  return total ? ink / total : 0;
}

function main() {
  if (!fs.existsSync(EXE)) { console.log('SKIP  MSHEARTS.EXE not found'); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const shot = path.join(OUT, 'startup.png');
  const after = path.join(OUT, 'after-ok.png');

  const log = run(`8000:png:${shot}`, 12000);
  check('Hearts survived its startup', !/CRASH|UNIMPLEMENTED API/.test(log));
  // The message box is what it used to show instead, and it is fatal: the app
  // ends after it.
  check('Hearts does not give up on finding a dealer at startup',
    !/Unable to connect with dealer/.test(log));

  const dialogs = log.match(/^\[CreateDialog\].*$/gm) || [];
  check('the startup dialog opened', dialogs.length >= 1,
    `${dialogs.length} dialogs`);
  // Twice is the failure this pins: one posted command delivered twice put two
  // of these up, the second on top of a modal loop still waiting for the first.
  check('it opened exactly once', dialogs.length === 1,
    dialogs.join(' / '));
  check('it is the 235x105dlu welcome dialog', /size=235x105dlu/.test(dialogs[0]),
    dialogs[0]);
  // Rendered, not merely created: the caption bar and the dialog body.
  check('the dialog is drawn', inkFraction(shot, 20, 50, 370, 250) > 0.05);

  // OK with nothing typed must NOT close it: MFC's CDialog::OnOK validates
  // first, and the name is required. That it declines is the evidence OnOK ran
  // at all — before WM_COMMAND was packed the Win16 way, MFC saw a notification
  // code of 1 where BN_CLICKED is 0, matched no handler, and let the command
  // fall past it to be swallowed.
  const logEmpty = run(`4000:click:${OK_CLICK},9000:png:${after}`, 12000);
  check('clicking OK did not crash', !/CRASH|UNIMPLEMENTED API/.test(logEmpty));
  check('OK with no name keeps the dialog up',
    (logEmpty.match(/^\[CreateDialog\].*$/gm) || []).length === 1);

  // The whole flow: a name, "I want to be dealer", OK, then New Game.
  const table = path.join(OUT, 'table.png');
  const log2 = run(`3000:click:${NAME_CLICK},3500:keypress:65,` +
    `4500:click:${DEALER_CLICK},6000:click:${OK_CLICK},` +
    `30000:post-cmd:102,52000:png:${table}`, 60000);
  check('the dealer path did not crash', !/CRASH|UNIMPLEMENTED API/.test(log2));
  check('the dealer path put up no further dialog',
    (log2.match(/^\[CreateDialog\].*$/gm) || []).length === 1,
    'a "Locate dealer" box here means the play-mode choice was not read');

  // A dealt hand: the table is green baize, and the three computer players'
  // face-down hands plus the thirteen cards of your own are white.
  const png = PNG.sync.read(fs.readFileSync(table));
  let green = 0, white = 0, total = 0;
  for (let y = 30; y < 440; y++) {
    for (let x = 60; x < 580; x++) {
      const i = (y * png.width + x) * 4;
      const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      total++;
      if (g > 90 && r < 60 && b < 60) green++;
      else if (r > 230 && g > 230 && b > 230) white++;
    }
  }
  check(`the table is green baize (${(green / total * 100).toFixed(0)}%)`,
    green / total > 0.4);
  check(`cards are on it (${(white / total * 100).toFixed(0)}% white)`,
    white / total > 0.1);

  // The same deal, reached the way a person reaches it. The status bar says
  // "Press F2 to begin with current players", and F2 is an accelerator: a
  // 16-bit accelerator table is five bytes an entry (BYTE fFlags, WORD key,
  // WORD id) where the 32-bit one is eight, so walking it the wide way matched
  // nothing and every accelerator in the game was dead. Posting the command
  // directly, as the check above does, goes around exactly the part that broke.
  const f2 = path.join(OUT, 'table-f2.png');
  const log3 = run(`3000:click:${NAME_CLICK},3500:keypress:65,` +
    `4500:click:${DEALER_CLICK},6000:click:${OK_CLICK},` +
    `13000:keydown:113,13100:keyup:113,35000:png:${f2}`, 40000);
  check('the F2 path did not crash', !/CRASH|UNIMPLEMENTED API/.test(log3));
  const f2png = PNG.sync.read(fs.readFileSync(f2));
  let f2white = 0, f2total = 0;
  for (let y = 30; y < 440; y++) {
    for (let x = 60; x < 580; x++) {
      const i = (y * f2png.width + x) * 4;
      const [r, g, b] = [f2png.data[i], f2png.data[i + 1], f2png.data[i + 2]];
      f2total++;
      if (r > 230 && g > 230 && b > 230) f2white++;
    }
  }
  check(`F2 dealt the hand (${(f2white / f2total * 100).toFixed(0)}% cards)`,
    f2white / f2total > 0.1,
    'the accelerator did not reach New Game -- the table is still empty');

  console.log(`\n${pass} passed, 0 failed`);
  console.log(`Snapshots: ${OUT}`);
}

main();
