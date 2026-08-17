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
// Getting a game running still needs NetDDE, which is a separate open item —
// this stops where Hearts asks for the dealer's computer name.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'output', 'win16-hearts');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'MSHEARTS.EXE');

// The OK button of the startup dialog, from its own geometry: the dialog's
// client origin plus the button's position in the template.
const OK_CLICK = '319:92';

let pass = 0;
function check(name, cond, detail) {
  assert(cond, detail ? `${name} -- ${detail}` : name);
  console.log(`PASS  ${name}`);
  pass++;
}

function run(inputs, batches) {
  return execFileSync('node', [
    path.join(ROOT, 'test', 'run.js'), `--exe=${EXE}`,
    `--max-batches=${batches}`, `--input=${inputs}`,
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

  // OK: MFC's message map has no handler for it, so it goes down the subclass
  // chain, and what is behind our window is what has to end the dialog.
  const log2 = run(`4000:click:${OK_CLICK},20000:png:${after}`, 25000);
  check('clicking OK did not crash', !/CRASH|UNIMPLEMENTED API/.test(log2));
  const dialogs2 = log2.match(/^\[CreateDialog\].*$/gm) || [];
  check('OK closed it and Hearts moved on to the next dialog',
    dialogs2.length === 2, dialogs2.join(' / '));
  // 213x78dlu is "Locate dealer", the next step of the same flow.
  check('the next dialog is Locate dealer', /size=213x78dlu/.test(dialogs2[1]),
    dialogs2[1] || '(none)');

  console.log(`\n${pass} passed, 0 failed`);
  console.log(`Snapshots: ${OUT}`);
}

main();
