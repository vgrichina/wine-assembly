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
//   prompt   stopped on a blocking key read, still waiting
//   blank    nothing on either surface
//   failed   no picture at all: a trap, a timeout, a dead child
//
// The classifier is deliberately conservative about `error`: a screen only
// counts as one if it matches a complaint pattern, so a demo whose text
// happens to contain the word "memory" is art, not a failure.

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

function classify(r) {
  if (r.failed) return 'failed';
  const px = r.pixels || 0, cells = r.cells || 0;
  // A graphics frame with real content is the answer whatever else is true.
  if (px > 64) return 'demo';
  const screen = r.screen || '';
  if (!cells && !px) return r.blockedOnKey ? 'prompt' : 'blank';
  if (cells) {
    if (complaint(screen)) return 'error';
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

const reason = (r) => complaint(r.screen || '');

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
module.exports = { classify, read, ORDER };
