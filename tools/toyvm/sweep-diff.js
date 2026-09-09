#!/usr/bin/env node

'use strict';

// What one change to the VM did to the whole corpus, from two sweep-dos.js
// JSONs.
//
//   node tools/toyvm/sweep-dos.js --dir=/tmp/demos --reps=1 --variants=tailcall --out=/tmp/a.json
//   ...change something...
//   node tools/toyvm/sweep-dos.js --dir=/tmp/demos --reps=1 --variants=tailcall --out=/tmp/b.json
//   node tools/toyvm/sweep-diff.js /tmp/a.json /tmp/b.json
//
// WHY A TOOL, and why not equiv-dos.js. equiv-dos.js runs ONE build under two
// sets of flags and demands the two arms be indistinguishable -- which is the
// right check for a compiler switch, and the wrong one for a change that is
// SUPPOSED to move the picture. A retiming of the emulated clock changes the
// frame hash of every time-paced program in the corpus on purpose, so the
// question is not "did anything change" but "did anything BREAK", and those
// are different columns:
//
//   regression   a program that started failing, timing out or getting stuck.
//                These block a change outright.
//   went blank   drew pixels before, draws none now. Reported separately and
//                it also blocks, because it is the shape a real rendering bug
//                takes -- but on a change to the CLOCK it is usually not one:
//                the sweep photographs a fixed number of DISPATCHES, so
//                slowing the emulated frame rate down moves the photograph
//                earlier in the same show, and a demo that opens on a fade
//                from black is legitimately still black there. Discharge it
//                by re-running those programs at a budget that buys the same
//                GUEST time as before, and say so; do not just widen the
//                filter.
//   changed      a different frame hash or dispatch count, picture still
//                non-empty. Expected for the paced programs; the reason is
//                the author's to give, one line each.
//   recovered    failing before, fine now. Worth naming, not worth trusting.
//   bucket       what demo-status.js makes of the row moved: demo/art/error/
//                prompt/blank/failed. The column the corpus is counted in, and
//                the one a reader of docs/dos-corpus-blockers.md is looking
//                for. Only a picture sweep (shot-sweep.js) carries the screen
//                text a bucket needs; a sweep-dos.js pair simply prints none.
//
// The "went blank" discharge above now has a tool: budget in GUEST SECONDS
// (`--guest-seconds=`, the default for both sweeps) and a retiming of the
// emulated clock stops moving the photograph at all. See sweep-budget.js.
//
// The two JSONs must come from the same corpus; a program in one and not the
// other is reported rather than silently dropped.

const fs = require('fs');
const { classify } = require('./demo-status');

function load(p) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const m = new Map();
  for (const r of j.rows) m.set(r.name, r);
  return m;
}

// What a row says happened, in the two words that decide a verdict.
//
// Two kinds of row reach this. A sweep-dos.js row carries `shells`, whose
// `reason` is the run's verdict (crash / timeout / arms-disagree / ...). A
// shot-sweep.js row has no shells at all -- it is one run, for a picture --
// and says the same thing with `failed`. Reading only the first shape made
// every picture-sweep row `no-data`, which silently disabled the REGRESSIONS
// and `recovered` columns on exactly the sweep the site is built from.
function status(r) {
  if (r.failed) return String(r.failed);             // shot-sweep: timeout / no png / ...
  if (r.shells && !r.shells.ok) return r.shells.reason;
  if (r.stuckAt) return 'stuck';
  return 'ok';
}

// A program "draws" if it left non-black pixels on a graphics surface.
//
// The frame hash cannot stand in for this: a blank 320x200 screen hashes to a
// perfectly ordinary non-zero value (38c165c5 on this corpus), so "hash is not
// zero" calls every black screen a picture. `pixels` is the honest count, and
// it is 0 for a text-mode program by construction (run-dos.js) -- so a text
// program can never enter this comparison in the first place, which is why the
// before-side test is on the BEFORE row's pixel count.
const draws = (r) => (r.pixels || 0) > 0;

function main() {
  const [a, b] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  if (!a || !b) {
    console.log('usage: node tools/toyvm/sweep-diff.js BEFORE.json AFTER.json');
    process.exit(2);
  }
  const A = load(a), B = load(b);
  const names = [...new Set([...A.keys(), ...B.keys()])].sort();

  const missing = [], regressions = [], blank = [], changed = [], recovered = [], same = [];
  const buckets = [];
  for (const n of names) {
    const x = A.get(n), y = B.get(n);
    if (!x || !y) { missing.push(`${n}: only in ${x ? 'BEFORE' : 'AFTER'}`); continue; }
    const sx = status(x), sy = status(y);

    // What the row is counted as. Reported for every program whose bucket
    // moved, whatever else the row did -- a program can keep its status and
    // its picture and still stop being counted as a pass, which is the whole
    // point of the bucket.
    const bx = classify(x), by = classify(y);
    if (bx !== by) {
      const px = x.pixels || 0, py = y.pixels || 0;
      const cx = x.cells || 0, cy = y.cells || 0;
      const why = py > px ? 'drew more' : py < px ? 'drew less'
        : cy !== cx ? `cells ${cx} -> ${cy}` : 'same picture, reclassified';
      buckets.push(`${n}: ${bx} -> ${by} (${why}; px ${px} -> ${py}`
        + `${y.stuckAt ? `, stuck at ${y.stuckAt}` : ''}`
        + `${y.failed ? `, ${y.failed}` : ''})`);
    }

    if (sx === 'ok' && sy !== 'ok') {
      regressions.push(`${n}: ${sx} -> ${sy}`);
    } else if (draws(x) && !draws(y)) {
      blank.push(`${n}: drew ${x.pixels} px (frame ${x.frame}), now 0 px (frame ${y.frame})`);
    } else if (sx !== 'ok' && sy === 'ok') {
      recovered.push(`${n}: ${sx} -> ok`);
    } else if (x.frame !== y.frame || x.dispatched !== y.dispatched) {
      const d = y.dispatched / (x.dispatched || 1);
      changed.push(`${n}: frame ${x.frame} -> ${y.frame},`
        + ` ${(x.dispatched / 1e6).toFixed(1)}M -> ${(y.dispatched / 1e6).toFixed(1)}M`
        + ` dispatches (x${d.toFixed(2)}), px ${x.pixels} -> ${y.pixels}`);
    } else {
      same.push(n);
    }
  }

  const section = (title, rows) => {
    console.log(`\n${title}: ${rows.length}`);
    for (const r of rows) console.log(`  ${r}`);
  };
  console.log(`${names.length} programs`);
  section('REGRESSIONS: run status got worse (block the change)', regressions);
  section('WENT BLANK: drew pixels before, none now (explain or block)', blank);
  section('changed (frame hash and/or dispatches moved, still drawing)', changed);
  section('recovered', recovered);
  section('bucket moved (demo-status.js)', buckets);
  if (missing.length) section('only in one sweep', missing);
  console.log(`\nunchanged: ${same.length}`);
  process.exit(regressions.length || blank.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { status, draws };
