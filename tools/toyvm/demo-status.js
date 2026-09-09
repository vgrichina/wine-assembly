#!/usr/bin/env node

'use strict';

// Did the demo actually run? One bucket per program, from a shot-sweep JSON.
//
//   node tools/toyvm/demo-status.js /tmp/shots.json
//   node tools/toyvm/demo-status.js /tmp/shots.json --bucket=error --screens
//   node tools/toyvm/demo-status.js a.json b.json      # before/after, as a diff
//
// `shot-sweep.js` reports pixels and cells, and neither one answers the
// question this does. A program sitting on "ERROR: VGA Adapter required !" has
// 36 non-blank cells and a perfectly good screenshot; a program showing a BBS
// advertisement drawn in block graphics has 1,580 and is doing exactly what it
// was written to do. Both are "text with content" to the sweep, and they are
// opposite outcomes.
//
//   demo     a graphics frame with something on it
//   art      a text screen that IS the program's output -- a note file, a BBS
//            ad, an ANSI logo. Big, and says nothing about a missing anything.
//   error    a text screen whose words are a complaint. These are the work
//            list, and the message is the specification.
//   prompt   asking rather than showing: a blocking key read, a sound-card
//            menu, a setup screen. Also any text screen belonging to a run
//            that has been in a GRAPHICS mode -- see sawGraphics.
//   blank    nothing on either surface
//   failed   no picture at all: a trap, a timeout, a dead child, or a run that
//            wedged behind the screen that was photographed
//
// The classifier is deliberately conservative about `error`: a screen only
// counts as one if it matches a complaint pattern, so a demo whose text
// happens to contain the word "memory" is art, not a failure.
//
// It is NOT conservative about `art`, and the difference is the point. `art`
// counts as a pass -- it is added to `demo` in the "showing something they
// meant to" line -- so calling a setup menu art hides a work item behind a
// number that says the corpus is fine. A cell count cannot tell those apart at
// all (a BBS ad is 1580 cells, DINO's device grid several hundred), so the
// rules below use the RUN's own evidence instead: which video modes it passed
// through, and whether it was still running when the picture was taken.

const fs = require('fs');

// What a program says when it is refusing to run. Every one of these is on a
// screen in this corpus.
const COMPLAINT = [
  [/\b(need|needs|needed|required|requires)\b/i, 'wants something'],
  [/\bnot\s+(found|detected|enough|present)\b/i, 'missing something'],
  [/\b(error|fatal|failure|failed|sorry|cannot|can not|can't|unable)\b/i, 'error'],
  [/\binsufficient\b|\bout of memory\b|\bcorrupt\b/i, 'resources'],
  [/\bruntime error\b|\bdivide\b.*\bzero\b|\bstack overflow\b/i, 'runtime fault'],
  [/\brequires?\s+(a\s+)?(vga|386|486|ems|xms|himem|gus|sound)/i, 'hardware'],
];

// A prompt is not an error, but a screen that is ONLY a prompt is not the demo
// either. Kept separate so "waiting" never hides inside "art".
const PROMPT_ONLY = /press\s+(any\s+)?(key|enter|space)|select\s+an?\s+|\[y\/n\]|choose|which\s+(sound|card)/i;

// Where a complaint lives on the screen is what makes it a complaint.
//
// A refusal is the LAST thing a program prints -- it says it and it stops. A
// demo's note file says "Sorry about using MOD-OBJ" in the middle of twenty
// lines of credits and then keeps going. Scanning the whole screen for the
// word cannot tell those apart, and it put a-note.exe's full-screen ANSI
// credits in the error bucket on the strength of one apology.
function complaint(screen) {
  const lines = screen.split('\n').map(s => s.trim()).filter(Boolean);
  const tail = lines.slice(-4).join('\n');
  for (const [re, what] of COMPLAINT) if (re.test(tail)) return what;
  // A short screen is all tail: two lines that complain are a refusal wherever
  // the words sit.
  if (lines.length <= 6) {
    for (const [re, what] of COMPLAINT) if (re.test(screen)) return what;
  }
  return '';
}

// A screen this full is the program's output, not its furniture. 80x25 is 2000
// cells; a refusal is under a hundred and a title screen is several hundred.
const FULL_SCREEN = 400;

// The BIOS text modes. A run that was only ever in these never put the adapter
// in a graphics mode, whatever it did with the console.
const TEXT_MODES = new Set([0, 1, 2, 3, 7]);

// Did this run ever put the adapter in a graphics mode?
//
// This is the question a cell count cannot answer and the one that decides
// `art`. A .NFO viewer and a demo sitting on its sound-card setup menu are
// both "a text screen with a few hundred cells", and they are opposite
// outcomes: the first is the whole program, the second is the furniture in
// front of one that has already asked for mode 13h and drawn nothing there.
// STHINTRO.EXE was counted as text art for a version on exactly that
// confusion, with its run already over behind the menu.
//
// `modes` is the run's own mode history (run-dos.js, `video.modes`), starting
// with the power-on 3 -- so the head is a fact about the BIOS, not about the
// program, and only the rest is evidence. A row from a sweep too old to carry
// the field says nothing either way and the cell-count rules stand.
function sawGraphics(r) {
  const modes = r.modes;
  if (!Array.isArray(modes)) return false;
  return modes.slice(1).some((m) => !TEXT_MODES.has(m));
}

function classify(r) {
  if (r.failed) return 'failed';
  const px = r.pixels || 0, cells = r.cells || 0;
  // A graphics frame with real content is the answer whatever else is true.
  if (px > 64) return 'demo';
  const screen = r.screen || '';
  if (!cells && !px) return r.blockedOnKey ? 'prompt' : 'blank';
  if (cells) {
    if (complaint(screen)) return 'error';
    // A text screen the program is no longer running behind is not its output.
    // The run walked into a wall after printing it -- STHINTRO's menu was
    // photographed with the loader spinning at 0000:0000 -- and that is a work
    // item however full the screen is.
    //
    // Scoped to a screen WITH something on it on purpose. A blank row already
    // claims nothing, so a stuck one hides no work item and stays `blank`,
    // where the corpus notes have been calling it that for versions; it is
    // only the screen that looks like a result that has to be told apart.
    if (r.stuckAt) return 'failed';
    // ...and neither is a text screen belonging to a program that has been in
    // a graphics mode. Whatever is on the console there, the program's own
    // output is the frame it has not finished drawing yet: a menu, a warning,
    // a loader's progress line. Ranked as `prompt` -- asking, not showing --
    // because that is what the bucket is for and because the ones that are
    // genuinely waiting for a key are the same rows.
    if (sawGraphics(r)) return 'prompt';
    // Waiting is not the finding when the program has already drawn its
    // screen. manhatan.exe is a full-page ANSI advertisement that ends on
    // "press a key" -- the key it is waiting for is the last thing about it
    // worth reporting.
    if (cells >= FULL_SCREEN) return 'art';
    if (r.blockedOnKey) return 'prompt';
    if (PROMPT_ONLY.test(screen) && cells < 200) return 'prompt';
    return cells >= 40 ? 'art' : 'blank';
  }
  return r.blockedOnKey ? 'prompt' : 'blank';
}

// Why a row is in the bucket it is in, in a few words. A stuck address is a
// reason in its own right: it is the difference between "this program printed
// a menu" and "this program printed a menu and then died".
const reason = (r) => complaint(r.screen || '')
  || (r.stuckAt ? `stuck at ${r.stuckAt}` : '');

const ORDER = ['demo', 'art', 'error', 'prompt', 'blank', 'failed'];

function read(file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')).rows || [];
  return rows.map(r => ({ ...r, bucket: classify(r) }));
}

function main() {
  const args = process.argv.slice(2);
  const files = args.filter(a => !a.startsWith('--'));
  const only = (args.find(a => a.startsWith('--bucket=')) || '').slice(9);
  const screens = args.includes('--screens');
  if (!files.length) {
    console.log('usage: node tools/toyvm/demo-status.js <sweep.json> [before.json] '
      + '[--bucket=demo|art|error|prompt|blank|failed] [--screens]');
    process.exit(2);
  }

  const rows = read(files[0]);
  const counts = Object.fromEntries(ORDER.map(b => [b, 0]));
  for (const r of rows) counts[r.bucket]++;

  // Two files means a before/after: the interesting number is what moved, not
  // what the totals are.
  let prev = null;
  if (files[1]) {
    prev = new Map(read(files[1]).map(r => [r.exe, r.bucket]));
  }

  const running = counts.demo + counts.art;
  console.log(`${rows.length} program(s): ${running} showing something they meant to `
    + `(${counts.demo} graphics, ${counts.art} text art)`);
  for (const b of ORDER) {
    const bar = '#'.repeat(Math.round(counts[b] / Math.max(1, rows.length) * 40));
    const delta = prev
      ? (() => {
        const before = rows.filter(r => prev.get(r.exe) === b).length;
        const d = counts[b] - before;
        return d === 0 ? '' : `  ${d > 0 ? '+' : ''}${d}`;
      })()
      : '';
    console.log(`  ${b.padEnd(7)} ${String(counts[b]).padStart(3)}  ${bar}${delta}`);
  }

  if (prev) {
    const moved = rows.filter(r => prev.has(r.exe) && prev.get(r.exe) !== r.bucket);
    if (moved.length) {
      console.log(`\nmoved (${moved.length}):`);
      for (const r of moved.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        console.log(`  ${r.name.padEnd(16)} ${prev.get(r.exe).padEnd(7)} -> ${r.bucket}`);
      }
    }
  }

  const list = only ? rows.filter(r => r.bucket === only) : [];
  if (list.length) {
    console.log(`\n${only} (${list.length}):`);
    for (const r of list) {
      const first = (r.screen || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
      console.log(`  ${r.name.padEnd(16)} ${(r.failed || reason(r)).padEnd(16)} ${first.slice(0, 70)}`);
      if (screens && r.screen) {
        console.log(r.screen.split('\n').map(s => `      | ${s}`).join('\n'));
      }
    }
  }
}

if (require.main === module) main();
// A screen that is asking rather than showing. Exported for the frame chooser
// in run-dos.js, which has to rank a program's setup menu below the thing the
// program does after it.
const asking = (screen) => PROMPT_ONLY.test(screen || '') || !!complaint(screen || '');

module.exports = { classify, complaint, asking, sawGraphics, read, ORDER };
