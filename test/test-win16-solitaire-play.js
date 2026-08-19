#!/usr/bin/env node
// 16-bit Solitaire: a table you can see, and a card you can move.
//
//   node test/test-win16-solitaire-play.js
//
// Two things a player notices immediately, both of which were broken in ways no
// existing test could see, because every test posted a menu command first and
// that hid both.
//
// The table has to be dealt *and drawn* on launch. Solitaire deals from
// WM_CREATE and draws each card as it deals rather than from WM_PAINT, so the
// deferred initial WM_ERASEBKGND arrived after the deal and painted the whole
// client area green again. Nothing then asked for a repaint, so the cards only
// appeared once something else invalidated the window — opening a menu was the
// obvious way, and that is exactly how it was reported.
//
// And a card has to be draggable. Solitaire hit-tests the button-down with
// PtInRect, whose POINT is one argument passed by value: its two words are the
// other way round from the separate x and y of InflateRect beside it. Read the
// wrong way the test asks whether (y, x) is inside the rectangle, which is
// false for every card on the table, so the game found nothing under the cursor
// and never picked anything up.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'output', 'win16-solitaire');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'SOL.EXE');

// The tableau as this deal lays it out. Column 1 holds a single face-up card at
// the top left of the row; column 3's card sits three columns over.
const COL1 = { x: 65, y: 200 };
const COL3 = { x: 238, y: 212 };

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

// Cards are white; the baize is green. Counting white pixels per column strip
// says which columns hold a face-up card without pinning which card it is.
function columns(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  const white = (x0, x1, y0, y1) => {
    let n = 0;
    for (let y = y0; y < y1 && y < png.height; y++) {
      for (let x = x0; x < x1 && x < png.width; x++) {
        const i = (y * png.width + x) * 4;
        if (png.data[i] > 230 && png.data[i + 1] > 230 && png.data[i + 2] > 230) n++;
      }
    }
    return n;
  };
  return {
    // The seven tableau columns start at x=28 and are 68 apart.
    col: n => white(28 + (n - 1) * 68, 28 + (n - 1) * 68 + 60, 170, 290),
    all: white(20, 610, 60, 300),
  };
}

function main() {
  if (!fs.existsSync(EXE)) { console.log('SKIP  SOL.EXE not found'); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const dealt = path.join(OUT, 'dealt.png');
  const moved = path.join(OUT, 'moved.png');
  const dbl = path.join(OUT, 'double-clicked.png');

  // No input at all: the table has to be there on its own.
  const log = run(`6000:png:${dealt}`, 9000);
  check('Solitaire launched cleanly', !/CRASH|UNIMPLEMENTED API/.test(log));
  const before = columns(dealt);
  check(`the deal is on screen without touching anything (${before.all} white px)`,
    before.all > 20000);
  check('all seven columns hold a card',
    [1, 2, 3, 4, 5, 6, 7].every(n => before.col(n) > 500),
    [1, 2, 3, 4, 5, 6, 7].map(n => `${n}:${before.col(n)}`).join(' '));

  // Drag column 1's card onto column 3's. Whether that particular move is legal
  // is the game's business; what this checks is that the game picked the card
  // up at all, which it shows by emptying the column it came from.
  // The double-click at the end is the one that used to kill the game. It asks
  // for the card to fly to a foundation, and the flight is drawn by the app
  // itself through GDI.100 LineDDA — a callback per point of the line. That
  // ordinal was unimplemented, so a double-click anywhere on the table trapped,
  // which is what "it crashes after a while of playing" turned out to mean. It
  // is checked here rather than in a run of its own because the card need not
  // have anywhere to go for LineDDA to be called.
  const log2 = run(`7000:mousedown:${COL1.x}:${COL1.y},` +
    `7200:mousemove:120:205,7400:mousemove:180:210,` +
    `7600:mousemove:${COL3.x}:${COL3.y},7800:mouseup:${COL3.x}:${COL3.y},` +
    `11000:png:${moved},11500:dblclick:${COL3.x}:${COL3.y},` +
    `13500:png:${dbl}`, 14000);
  check('the drag did not crash', !/CRASH|UNIMPLEMENTED API/.test(log2));
  const after = columns(moved);
  check(`the card left column 1 (${before.col(1)} -> ${after.col(1)} white px)`,
    after.col(1) < before.col(1) / 2);
  check('the rest of the table is still drawn', after.all > 20000);
  check('the double-click did not crash', !/CRASH|UNIMPLEMENTED API/.test(log2));
  const ddaed = columns(dbl);
  check(`the table survived the double-click (${ddaed.all} white px)`,
    ddaed.all > 20000);

  console.log(`\n${pass} passed, 0 failed`);
  console.log(`Snapshots: ${OUT}`);
}

main();
