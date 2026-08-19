#!/usr/bin/env node
// A 16-bit task putting up one of its own dialogs.
//
//   node test/test-win16-dialog.js
//
// DialogBox is the API a Win16 app is least able to survive being bridged to
// its 32-bit namesake: DialogBoxParamA runs the loop by pointing EIP at the
// dialog procedure with a 32-bit frame beneath it, and a 16-bit task cannot be
// resumed on one. So the Win16 side has its own template rewriter and its own
// modal pump, and this is what checks both.
//
// Solitaire's Game > Options is the case: thirteen controls, a group box, radio
// buttons, check boxes and the two push buttons, driven by a DLGPROC that calls
// CheckRadioButton and CheckDlgButton on the way in and EndDialog on the way
// out. The two push buttons are the ones worth naming, because they sit below
// every other control and were the last thing to render — a control that the
// paint queue declines to draw looks exactly like a control that was never
// created, and only a pixel check tells them apart.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'output', 'win16-dialog');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'SOL.EXE');

// Game menu, then the "Options..." item under it. Both derived once from the
// rendered menu rather than from the template, because the menu geometry is
// the renderer's and moves with its metrics.
const GAME_MENU = '47:51';
const OPTIONS_ITEM = '70:152';

function run(inputs, batches) {
  return execFileSync('node', [
    path.join(ROOT, 'test', 'run.js'), `--exe=${EXE}`,
    `--max-batches=${batches}`, `--input=${inputs}`,
  ], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
}

function readPng(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return {
    w: png.width, h: png.height,
    // Fraction of a rect that is not button-face gray — "something was drawn
    // here" without pinning the exact glyphs.
    inked(x0, y0, x1, y1) {
      let ink = 0, total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * png.width + x) * 4;
          total++;
          if (!(png.data[i] === 192 && png.data[i + 1] === 192 && png.data[i + 2] === 192)) ink++;
        }
      }
      return ink / total;
    },
  };
}

let pass = 0;
function check(name, cond) {
  assert(cond, name);
  console.log(`PASS  ${name}`);
  pass++;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const shot = path.join(OUT, 'options.png');
  const closed = path.join(OUT, 'closed.png');

  const log = run(`1500:click:${GAME_MENU},1700:click:${OPTIONS_ITEM},`
    + `4000:dump-children:0x10003:opt,4000:png:${shot}`, 20000);

  check('Solitaire survived opening its Options dialog', !/CRASH|UNIMPLEMENTED API/.test(log));

  // The template is thirteen items and every one is a button-class control.
  // A miscount here means the rewriter lost its place in the 16-bit template,
  // which is the failure the whole file exists to catch.
  const dump = /dump-children:opt: (.*)$/m.exec(log);
  assert(dump, 'no dump-children output — did the dialog window get created?');
  const controls = dump[1].split('|').filter(part => /hwnd=/.test(part));
  check(`Options built all thirteen controls (${controls.length})`, controls.length === 13);
  check('every control came out button-class', controls.every(c => /\bcls=1\b/.test(c)));
  // Ids come straight from the template, so IDOK and IDCANCEL prove the walk
  // stayed in step to the very last item.
  check('the last two are IDOK and IDCANCEL',
    /\bid=1\b/.test(controls[11]) && /\bid=2\b/.test(controls[12]));

  const png = readPng(shot);
  // The dialog opens at 48,56 with its client at 51,79. OK is at client
  // (168,168) and Cancel at (249,168), both 75x24.
  const ok = png.inked(219, 247, 294, 271);
  const cancel = png.inked(300, 247, 375, 271);
  check(`OK button is drawn (${(ok * 100).toFixed(0)}% ink)`, ok > 0.05);
  check(`Cancel button is drawn (${(cancel * 100).toFixed(0)}% ink)`, cancel > 0.05);
  // The caption bar is DefDlgProc's, not the DLGPROC's: a Win16 dialog
  // procedure answers "not mine" to WM_NCPAINT by returning FALSE, and there is
  // no default behind it unless the pump keeps that message to itself.
  check('the dialog has its caption bar', png.inked(50, 60, 390, 76) > 0.5);

  // Cancel ends the dialog: EndDialog sets the result, the procedure returns,
  // and the pump splices the DialogBox call back together at its far return.
  const log2 = run(`1500:click:${GAME_MENU},1700:click:${OPTIONS_ITEM},`
    + `4000:click:320:258,8000:png:${closed}`, 20000);
  check('Cancel closed the dialog without a crash', !/CRASH|UNIMPLEMENTED API/.test(log2));
  const after = readPng(closed);
  // Where the dialog was is green baize again.
  check('the dialog is gone from the table', after.inked(60, 90, 380, 280) > 0.9);

  console.log(`\n${pass} passed, 0 failed`);
  console.log(`Snapshots: ${OUT}`);
}

main();
