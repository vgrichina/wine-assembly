#!/usr/bin/env node
// Every menu command of every 16-bit app, exercised.
//
//   node test/test-win16-menus.js
//
// "It launches and draws its window" is where a 16-bit app used to be declared
// working, and it is a long way from working: the four games between them have
// twenty-seven menu commands, and each one is a different set of APIs. Four of
// FreeCell's five went through one SetWindowPos it did not have; three Abouts
// went through ShellAbout; the card-back picker went through a DRAWITEMSTRUCT
// nobody had ever narrowed. None of that is visible from a launch.
//
// The work list is the app's own RT_MENU, so nothing here has to be kept in
// step by hand -- tools/menu-sweep.js reads it, sends each command to a freshly
// launched app, and reports what happened. A label ending in "..." that opens
// no window is as much a failure as a crash.
//
// Hearts is not here. It stops at startup waiting for a game to join, long
// before its menus mean anything, and that is its own open problem -- see
// TODOS.md. Adding it would assert the wrong thing.
//
// The second half is the card-back picker specifically, because the bug behind
// it was in the emulator core rather than in the Win16 layer: a 16-bit MOVSD
// (66 A5, which is how a compiler copies a RECT) moved two bytes and advanced
// four, so every other word of every struct copied that way arrived stale. It
// is worth a pixel check that no sweep verdict would catch -- the dialog opened
// perfectly well while drawing twelve unreadable smears.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'test', 'binaries', 'win98-16bit');
const OUT = path.join(ROOT, 'test', 'output', 'win16-menus');

const APPS = ['FREECELL.EXE', 'SOL.EXE', 'WINMINE.EXE'];

let pass = 0;
function check(name, cond, detail) {
  assert(cond, detail ? `${name} -- ${detail}` : name);
  console.log(`PASS  ${name}`);
  pass++;
}

function sweep(exe) {
  const json = path.join(os.tmpdir(), `win16-menus-${process.pid}-${path.basename(exe)}.json`);
  try {
    execFileSync('node', [path.join(ROOT, 'tools', 'menu-sweep.js'), exe, `--json=${json}`],
      { encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // A nonzero exit is how the sweep reports bad verdicts; the JSON is still
    // written, and it says which ones. Only a missing file is fatal here.
    if (!fs.existsSync(json)) throw e;
  }
  const report = JSON.parse(fs.readFileSync(json, 'utf8'));
  fs.unlinkSync(json);
  return report;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });

  for (const app of APPS) {
    const exe = path.join(BIN, app);
    if (!fs.existsSync(exe)) { console.log(`SKIP  ${app} not present`); continue; }
    const report = sweep(exe);
    const live = report.results.filter(r => r.verdict !== 'skipped');
    check(`${app} has menu commands to exercise`, live.length > 0);
    const bad = live.filter(r => r.verdict === 'CRASH' || r.verdict === 'NODLG');
    check(`every ${app} menu command worked`, bad.length === 0,
      bad.map(r => `${r.path}: ${r.verdict} ${r.detail}`).join('; '));
    // A command whose label promises a dialog and delivers one is the only
    // verdict that proves the app got somewhere, so insist on at least one.
    check(`${app} opened at least one dialog`,
      live.some(r => r.verdict === 'dialog'));
  }

  // ---- Solitaire's Deck dialog, in pixels ----
  const sol = path.join(BIN, 'SOL.EXE');
  if (!fs.existsSync(sol)) { console.log('SKIP  SOL.EXE not present'); return done(); }
  const shot = path.join(OUT, 'deck.png');
  execFileSync('node', [
    path.join(ROOT, 'test', 'run.js'), `--exe=${sol}`, '--max-batches=9000',
    `--input=1500:post-cmd:1002,6000:png:${shot}`,
  ], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });

  const png = PNG.sync.read(fs.readFileSync(shot));
  const at = (x, y) => {
    const i = (y * png.width + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  const isFace = (x, y) => { const [r, g, b] = at(x, y); return r === 192 && g === 192 && b === 192; };
  const isWhite = (x, y) => { const [r, g, b] = at(x, y); return r > 230 && g > 230 && b > 230; };

  // The grid of twelve card backs, in the dialog's client area.
  const X0 = 60, X1 = 390, Y0 = 88, Y1 = 280;
  let face = 0, white = 0, total = 0;
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      total++;
      if (isFace(x, y)) face++;
      else if (isWhite(x, y)) white++;
    }
  }
  // Twelve cards laid out with gaps: the dialog face shows between and around
  // them. With the MOVSD bug the cards were drawn from a rect whose height came
  // out negative, and they smeared edge to edge with no gaps at all.
  check(`the card grid has dialog face showing between the cards (${(face / total * 100).toFixed(0)}%)`,
    face / total > 0.10 && face / total < 0.60);
  // Every card back is white-bordered art. Nothing white survived the smear.
  check(`the cards are drawn with their white borders (${(white / total * 100).toFixed(0)}%)`,
    white / total > 0.05);

  done();
}

function done() {
  console.log(`\n${pass} passed, 0 failed`);
  console.log(`Snapshots: ${OUT}`);
}

main();
