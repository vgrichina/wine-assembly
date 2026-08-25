#!/usr/bin/env node

'use strict';

// Is this DOS program compute-bound, or is it waiting for time to pass?
//
//   node tools/toyvm/clock-probe.js DEMO.EXE
//   node tools/toyvm/clock-probe.js --dir=demos --dispatches=15m
//
// The question matters because the toy VM's guest clock advances ONE tick per
// handback, and handbacks vary by five orders of magnitude across the corpus
// (31 dispatches for CORE-ADD, 1.4M for COPPER). So guest time runs at a wildly
// different speed relative to guest work depending on the program -- the same
// trap documented for the main emulator's `batch * TICK_MS_PER_BATCH`, where an
// intro that paced itself off timeGetTime looked like a broken decoder.
//
// Method: run the identical program three times at the identical dispatch
// budget with the clock stopped, normal, and 16x, and compare what it drew.
//
//   all three frames identical   -> never reads a clock. Compute-bound. A
//                                   bigger dispatch budget is the only thing
//                                   that gets it further.
//   frames differ                -> it reads a clock, so where it gets to
//                                   depends on the clock rate, and any "it
//                                   renders nothing" claim about it is a claim
//                                   about the harness until this is pinned.
//
// The counters printed beside the verdict name WHICH clock: retrace polls on
// port 0x3DA, PIT reads on 0x40-0x42, and INT 1Ah/15h/16h calls. A program
// polling the BIOS tick word in memory shows up in none of them -- that one is
// only visible in the frame comparison, which is why the comparison is the
// verdict and the counters are only the explanation.

const fs = require('fs');
const path = require('path');
const { runDos } = require('./run-dos');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function count(s, d) {
  if (s === undefined) return d;
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`not a count: ${s}`);
  return Math.round(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2].toLowerCase()]);
}

const SCALES = [0, 1, 16];

async function main() {
  const exes = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const dir = arg('dir');
  if (dir) {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(exe|com)$/i.test(e.name)) exes.push(p);
      }
    };
    walk(dir);
  }
  if (!exes.length) {
    console.log('usage: node tools/toyvm/clock-probe.js <exe...> [--dir=D] [--dispatches=] [--cpu=]');
    process.exit(2);
  }

  const budget = count(arg('dispatches'), 15e6);
  const cpu = Number(arg('cpu', 386));
  const quiet = () => {};
  const rows = [];

  console.log(`clock A/B at ${(budget / 1e6).toFixed(0)}M dispatches -- tick rate x${SCALES.join(', x')}\n`);
  const head = 'program'.padEnd(15) + 'verdict'.padEnd(16)
    + SCALES.map(s => `x${s}`.padEnd(11)).join('')
    + 'px x0/x1/x16'.padEnd(24) + 'clock source';
  console.log(head);
  console.log('-'.repeat(head.length));

  for (const exe of exes) {
    const name = path.basename(exe);
    let runs;
    try {
      runs = [];
      for (const tickScale of SCALES) {
        runs.push(await runDos({ exe, budget, cpu, tickScale, log: quiet, autoKey: true }));
      }
    } catch (e) {
      console.log(`${name.padEnd(15)}FAILED  ${(e.message || String(e)).split('\n')[0]}`);
      continue;
    }

    const frames = runs.map(r => r.frame);
    const same = new Set(frames).size === 1;
    // A program can read the clock and still not be WAITING on it -- a palette
    // cycler reads the tick every frame and renders regardless. What separates
    // waiting from reading is whether more guest time buys more drawn pixels.
    const px = runs.map(r => r.pixels);
    const gained = px[2] - px[1];
    const verdict = same ? 'compute-bound'
      : gained > Math.max(200, px[1] * 0.05) ? 'TIME-STARVED'
        : 'clock-sensitive';

    const c = runs[1].machine.clock;
    const ic = runs[1].machine.intCount;
    const src = [
      c.retrace ? `retrace ${c.retrace}` : null,
      c.pit ? `pit ${c.pit}` : null,
      ic.get(0x1A) ? `int1a ${ic.get(0x1A)}` : null,
      ic.get(0x15) ? `int15 ${ic.get(0x15)}` : null,
      ic.get(0x16) ? `int16 ${ic.get(0x16)}` : null,
    ].filter(Boolean).join(', ') || 'none polled';

    console.log(name.padEnd(15) + verdict.padEnd(16)
      + frames.map(f => f.padEnd(11)).join('')
      + `${px[0]}/${px[1]}/${px[2]}`.padEnd(24) + src);
    rows.push({ exe: name, verdict, frames, px, clock: c, ticksAtEnd: runs[1].machine.ticks });
  }

  const n = (v) => rows.filter(r => r.verdict === v).length;
  console.log(`\n${n('compute-bound')} compute-bound, ${n('clock-sensitive')} clock-sensitive, `
    + `${n('TIME-STARVED')} time-starved of ${rows.length}`);
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
}

main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
