#!/usr/bin/env node

'use strict';

// Compare the toy VM's dispatch shells on real DOS programs.
//
//   node tools/toyvm/bench-dos.js scratch/mars/mars.exe
//   node tools/toyvm/bench-dos.js a.exe b.exe --variants=tailcall,switch --reps=5
//   node tools/toyvm/bench-dos.js --dir=scratch/demos --dispatches=20m --json
//
// Every arm runs in ONE process, alternating rep by rep with the starting arm
// rotated, and the reported number is the MINIMUM over reps. That is not
// fussiness: this box regularly sits at load 10-40, and a sequential
// arm-then-arm layout there measures the machine. Same discipline as
// tools/bench-loops.js.
//
// What is timed is only the wall clock inside `vm.exports.run` -- decode, trace
// compilation, PNG writing and DOS service calls are host work that every arm
// pays identically and that would otherwise swamp the signal.
//
// The frame hash and the dispatch count are checked across arms first. If two
// shells did not execute the same instructions, their times are not comparable
// and the run says so instead of printing a ratio.

const fs = require('fs');
const path = require('path');
const { runDos } = require('./run-dos');
const { VARIANTS } = require('./emit');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

function count(s, d) {
  if (s === undefined) return d;
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`not a count: ${s}`);
  return Math.round(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2].toLowerCase()]);
}

async function main() {
  const exes = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const dir = arg('dir');
  if (dir) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (/\.(exe|com)$/i.test(f)) exes.push(path.join(dir, f));
    }
  }
  if (!exes.length) {
    console.log('usage: node tools/toyvm/bench-dos.js <exe...> [--dir=D] [--variants=] [--reps=] [--dispatches=]');
    process.exit(2);
  }

  const variants = arg('variants', VARIANTS.join(',')).split(',').filter(Boolean);
  const reps = Number(arg('reps', 5));
  const budget = count(arg('dispatches'), 20e6);
  const cpu = Number(arg('cpu', 386));
  const quiet = () => {};

  // Printed either side of the run for the same reason profile-web-frames.js
  // does it: at load 10+ these numbers describe the box, not the VM.
  console.log(`load average ${require('os').loadavg()[0].toFixed(2)} at start`);
  const rows = [];

  for (const exe of exes) {
    // best[v] is the fastest observed guest-time for that arm; the first rep
    // also records what the program actually produced, for the agreement check.
    const best = new Map(), seen = new Map();
    let failed = null;

    for (let rep = 0; rep < reps && !failed; rep++) {
      // Rotate which arm goes first. A fixed order lets a cache that warms on
      // the first arm, or a thermal ramp that hits the last, masquerade as a
      // dispatch effect.
      const order = variants.map((_, i) => variants[(i + rep) % variants.length]);
      for (const v of order) {
        let r;
        try {
          r = await runDos({ exe, variant: v, budget, cpu, log: quiet });
        } catch (e) {
          failed = `${v}: ${(e.message || String(e)).split('\n')[0]}`;
          break;
        }
        const sig = `${r.dispatched}/${r.frame}`;
        if (!seen.has(v)) seen.set(v, { sig, r });
        else if (seen.get(v).sig !== sig) failed = `${v} is not deterministic across reps`;
        const nsPer = r.guestSecs * 1e9 / r.dispatched;
        if (!best.has(v) || nsPer < best.get(v)) best.set(v, nsPer);
      }
    }

    const name = path.basename(exe);
    if (failed) { console.log(`\n${name}  SKIPPED -- ${failed}`); continue; }

    const sigs = new Set([...seen.values()].map(s => s.sig));
    const any = [...seen.values()][0].r;
    console.log(`\n${name}  ${(any.dispatched / 1e6).toFixed(1)}M dispatches, `
      + `${any.handbacks} handbacks, ${any.pixels} px lit, frame=${any.frame}`);
    if (sigs.size > 1) {
      console.log('  ARMS DISAGREE -- not comparable:');
      for (const [v, s] of seen) console.log(`    ${v.padEnd(10)} ${s.sig}`);
      continue;
    }

    const base = best.get(variants[0]);
    for (const v of variants) {
      const ns = best.get(v);
      const rel = base / ns;
      console.log(`  ${v.padEnd(10)} ${ns.toFixed(2)} ns/dispatch  `
        + `${(1 / ns * 1000).toFixed(1)}M/s  ${v === variants[0] ? '(baseline)'
          : `${rel >= 1 ? '+' : ''}${((rel - 1) * 100).toFixed(1)}%`}`);
      rows.push({ exe: name, variant: v, nsPerDispatch: Number(ns.toFixed(3)), rel: Number(rel.toFixed(4)) });
    }
  }

  console.log(`\nload average ${require('os').loadavg()[0].toFixed(2)} at end`
    + `  (reps=${reps}, minimum of ${reps} interleaved runs per arm)`);
  if (flag('json')) console.log(JSON.stringify(rows, null, 2));
}

main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
