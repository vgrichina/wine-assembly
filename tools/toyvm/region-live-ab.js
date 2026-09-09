#!/usr/bin/env node

'use strict';

// The live region JIT, on against off, over a set of programs.
//
//   node tools/toyvm/region-live-ab.js --set=tools/toyvm/bench-set-20.txt \
//     --dispatches=80m --out=/tmp/ab20.json --md=/tmp/ab20.md
//   node tools/toyvm/region-live-ab.js --exe=/tmp/demos/1994-d-dragon/DRAGON.EXE
//
// TWO QUESTIONS, ONE PAIR OF RUNS. Is the picture the same, and is it faster?
// Both are asked of the same two runs so a row cannot report a speedup for a
// program whose frame moved.
//
//   * SAMENESS is the frame hash, the pixel count, the interrupt tally and a
//     sha256 of the rendered audio. A region that computes something else shows
//     up in the first; one that moves the CLOCK shows up in the last, because
//     every sound this machine makes is timed off the dispatch count. A region
//     charges `$steps` per op exactly so that the count does not move, and this
//     is the check on that claim.
//   * SPEED is dispatches per USER-CPU second, not per wall second. This box
//     sits at load 5-40, and the same guest work has been measured here at
//     identical CPU and three times the wall (docs/toyvm-trace-jit.md). The
//     clock is run-dos's own `guestCpuSecs`, which brackets the guest slices
//     and so bills neither arm for compiling.
//
// INTERLEAVED, ORDER ROTATED. Each program runs both arms back to back and the
// order alternates by row, which is the method every timing tool in this
// directory uses for the reason docs/loop-microbench-harness.md gives. The
// dispatch budget is fixed, so the comparison is fixed WORK at variable time --
// never a fixed time at variable work.
//
// The JIT's own cost is INSIDE the on-arm's wall clock and outside its CPU
// clock: profiling costs a map insert per slice, and the compile happens
// between slices where `guestCpuSecs` is not running. That is the same
// accounting region-jit.js uses, and it is the honest one for a JIT whose
// compile is off the main thread in the only place it ships (the page).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runDos } = require('./run-dos');
const { wavBytes } = require('./audio');

function arg(name, d) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? d : hit.slice(name.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

function count(s, d) {
  if (s === undefined) return d;
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`not a count: ${s}`);
  return Math.round(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2].toLowerCase()]);
}

// The gate's command line, as options. Everything here is a switch a demo can
// hear or see: the PIT clock, the menu answerer, a Sound Blaster preference and
// an Ultrasound in the environment. A quieter machine would hide exactly the
// clock differences this is looking for.
function baseOpts(exe, budget) {
  return {
    exe, budget, pitClock: true, autoKey: true, soundPref: 'sb',
    env: ['ULTRASND=220,1,1,11,7'], audioRate: Number(arg('audio-rate', 22050)),
    // Bisectors, passed to BOTH arms so they stay a comparison. `--no-spin`
    // is the one that matters here: the interpreter folds a self-loop over
    // nothing into a spin op that hands back once per slice, and a region
    // installed over such a loop replaces that fold -- so the handback cadence
    // moves, and with it every clock derived from it.
    spinLoops: !flag('no-spin'),
    // THE SHIPPED CLOCK BY DEFAULT, and `--lattice-clock` (BOTH arms, never
    // one) for the experiment. Anchoring the slice grid to the absolute
    // dispatch count is what would let a region absorb or add a handback
    // without moving every later boundary -- but it is not a free rewrite: it
    // changes the guest's own path on at least one program in this corpus
    // (BLIQ.EXE, see docs/toyvm-region-live.md), so a gate run on it would be
    // grading the JIT against a clock nobody runs. The headline gate is
    // therefore taken on the clock that ships.
    latticeClock: flag('lattice-clock'),
    log: () => {},
  };
}

async function once(exe, budget, jit) {
  // `--slice-log-dir=DIR`: one file per arm holding the cumulative dispatch
  // count at every handback. A frame hash says two runs ended somewhere
  // different; these say WHERE THE CUT MOVED, which is what separates "the
  // region computed something else" from "the region ended its slice one
  // instruction along and the audio was rendered against a different grid".
  const sliceDir = arg('slice-log-dir');
  const r = await runDos({
    ...baseOpts(exe, budget),
    cpuMeter: true,
    sliceLogFile: sliceDir
      ? path.join(sliceDir, `${path.basename(exe)}.${jit ? 'on' : 'off'}.slices`)
      : null,
    regionJit: jit ? {
      sampleAfter: count(arg('region-jit-after'), 6e6),
      profileFor: count(arg('region-jit-window'), 6e6),
      regions: Number(arg('region-jit-regions', 1)),
      // THE RATIO BAR IS A MEASUREMENT, AND A LOADED BOX MOVES IT. The audit's
      // in-isolation ratio for one DRAGON region came back 2.62x and 0.84x on
      // two runs an hour apart at load 5 and load 100 -- the same region, the
      // same ops. That is fine for the shipped default, which only means "do
      // not install something the bench says is slower", but it is wrong for a
      // CORRECTNESS run: a program that declines installs nothing and therefore
      // checks nothing, so a sweep run on a busy machine would quietly grade
      // itself on an empty JIT. `--region-jit-gate=0` keeps the agreement half
      // of the audit (never optional) and drops the speed bar, so every region
      // that is CORRECT gets installed and every frame is compared.
      gateAt: Number(arg('region-jit-gate', 1)),
      log: flag('verbose') ? console.log : (() => {}),
    } : null,
  });
  const wav = r.audioChunks.length
    ? crypto.createHash('sha256').update(Buffer.from(wavBytes(r.audioChunks, r.audioRate))).digest('hex').slice(0, 16)
    : 'none';
  return {
    frame: r.frame, pixels: r.pixels, ints: r.ints, wav,
    dispatched: r.dispatched, cpu: r.guestCpuSecs, wall: r.guestSecs,
    handbacks: r.handbacks, smc: r.smcBreaks,
    jit: r.jit,
  };
}

async function main() {
  const set = arg('set');
  const one = arg('exe');
  const files = one ? [one]
    : fs.readFileSync(set || path.join(__dirname, 'bench-set-20.txt'), 'utf8')
      .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const budget = count(arg('dispatches'), 80e6);
  const rows = [];
  for (const [i, exe] of files.entries()) {
    if (!fs.existsSync(exe)) { console.log(`${path.basename(exe)}: MISSING`); continue; }
    const first = i % 2 === 0;
    const a = await once(exe, budget, !first);
    const b = await once(exe, budget, first);
    const [off, on] = first ? [a, b] : [b, a];
    const same = off.frame === on.frame && off.pixels === on.pixels
      && off.ints === on.ints && off.wav === on.wav;
    const rate = (r) => r.dispatched / Math.max(1e-9, r.cpu);
    const row = {
      name: path.basename(exe), exe, same,
      off: { ...off, jit: undefined }, on,
      speed: 100 * (rate(on) / rate(off) - 1),
    };
    rows.push(row);
    console.log(`${row.name.padEnd(16)} ${same ? 'SAME' : '*** DIFFERS ***'}`
      + `  jit ${on.jit ? on.jit.phase : '-'}`
      + `${on.jit && on.jit.declined ? ` (${on.jit.declined})` : ''}`
      + `  off ${(rate(off) / 1e6).toFixed(2)}M/cpu-s  on ${(rate(on) / 1e6).toFixed(2)}M/cpu-s`
      + `  ${row.speed >= 0 ? '+' : ''}${row.speed.toFixed(1)}%`
      + (same ? '' : `\n    frame ${off.frame}/${on.frame} px ${off.pixels}/${on.pixels}`
        + ` ints ${off.ints}/${on.ints} wav ${off.wav}/${on.wav}`
        + ` dispatched ${off.dispatched}/${on.dispatched} smc ${off.smc}/${on.smc}`));
  }
  const installed = rows.filter(r => r.on.jit && r.on.jit.phase === 'installed');
  console.log(`\n${rows.filter(r => r.same).length}/${rows.length} identical;`
    + ` ${installed.length} program(s) installed a region`);
  if (installed.length) {
    const mean = installed.reduce((n, r) => n + r.speed, 0) / installed.length;
    console.log(`  mean dispatch/cpu-second change over the installed rows: `
      + `${mean >= 0 ? '+' : ''}${mean.toFixed(1)}%`);
  }
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify({ budget, rows }, null, 1));
  if (arg('md')) {
    const md = ['| program | same | jit | share | gate | off M/cpu-s | on M/cpu-s | % |',
      '|---|---|---|---:|---:|---:|---:|---:|'];
    for (const r of rows) {
      const j = r.on.jit || {};
      md.push(`| ${r.name} | ${r.same ? 'yes' : '**NO**'} | ${j.phase || '-'}`
        + ` | ${j.share ? j.share.toFixed(1) + '%' : '-'} | ${j.gate ? j.gate.toFixed(2) + 'x' : '-'}`
        + ` | ${(r.off.dispatched / r.off.cpu / 1e6).toFixed(2)} | ${(r.on.dispatched / r.on.cpu / 1e6).toFixed(2)}`
        + ` | ${r.speed >= 0 ? '+' : ''}${r.speed.toFixed(1)}% |`);
    }
    fs.writeFileSync(arg('md'), md.join('\n') + '\n');
  }
  process.exitCode = rows.every(r => r.same) ? 0 : 1;
}

if (require.main === module) main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
