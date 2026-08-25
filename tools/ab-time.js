#!/usr/bin/env node
// Interleaved A/B/C timing across several built worktrees.
//
//   node tools/ab-time.js --rounds=8 main=/tmp/wa-perf-main fuse=/tmp/wa-perf-x \
//     -- test/run.js --app=caesar3_demo --screen=800x600 --max-batches=3400 --no-build
//
// Every variant runs once per round, in the same order, and the round repeats.
// That ordering is the whole point. Background load on this box drifts on the
// scale of minutes, so running all of A and then all of B measures the drift
// and attributes it to the change: the classic way to "prove" a speedup that
// is really just the other agents finishing. Interleaving puts every variant
// under the same drift.
//
// The headline number is the MINIMUM, not the mean. Contention is one-sided —
// it can only ever make a run slower — so the fastest sample of a variant is
// the one least polluted by whatever else the machine was doing. A mean over
// noisy samples mostly reports how busy the box was.
//
// loadavg is captured per sample and printed with the results, because a
// timing number without it is not a measurement. Anything over ~4 on this box
// means the numbers describe the machine, not the build.
//
// Correctness is NOT checked here. Use --handler-hist-thread=0 and
// tools/png-diff.js separately to prove the builds do the same work; this
// tool only answers "how long did it take".

'use strict';

const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0) {
  console.error('usage: ab-time.js [--rounds=N] [--warmup] name=dir [name=dir ...] -- <node args>');
  console.error('  the args after -- are passed to node, run with cwd set to each variant dir');
  process.exit(2);
}
const head = argv.slice(0, sep);
const cmdArgs = argv.slice(sep + 1);
if (cmdArgs.length === 0) {
  console.error('ab-time: nothing to run after --');
  process.exit(2);
}

let rounds = 5;
let warmup = false;
// --metric=<regex>: pull a number out of the run's stdout and make THAT the
// headline instead of elapsed time. Needed for fixed-duration benchmarks --
// under `--max-seconds=30` every variant takes 30 seconds by construction, so
// wall clock and CPU time carry no signal at all and the answer is entirely in
// how far each build got ("Stats: N batches"). The regex must have exactly one
// capture group holding the number. Higher is better, so the comparison is
// inverted relative to the timing columns.
let metric = null;
const variants = [];
for (const a of head) {
  if (a.startsWith('--rounds=')) { rounds = parseInt(a.slice(9), 10); continue; }
  if (a.startsWith('--metric=')) { metric = new RegExp(a.slice(9), 'm'); continue; }
  if (a === '--warmup') { warmup = true; continue; }
  const eq = a.indexOf('=');
  if (eq < 0) { console.error(`ab-time: expected name=dir, got ${a}`); process.exit(2); }
  variants.push({ name: a.slice(0, eq), dir: path.resolve(a.slice(eq + 1)), samples: [] });
}
if (variants.length === 0) { console.error('ab-time: no variants'); process.exit(2); }

function load1() { return os.loadavg()[0]; }

// Wall clock on a shared box measures the box. CPU time (user+sys charged to
// this process) is what the other tenants cannot inflate nearly as much: they
// steal wall-clock seconds while we are descheduled, but those seconds are not
// billed to us. Measured here: on an identical binary, elapsed spanned 8970 to
// 23953ms across ten rounds while CPU time stayed inside a few percent. So CPU
// time is the headline and elapsed is kept only as a contention indicator.
// It is not immune — SMT contention and frequency scaling still show up in it —
// which is why minima still matter and loadavg is still printed.
function runOnce(v) {
  const before = load1();
  const t0 = process.hrtime.bigint();
  const r = spawnSync('/usr/bin/time', ['-p', process.execPath, ...cmdArgs],
    // maxBuffer: spawnSync's 1MB default does not fail the read, it SIGTERMs
    // the child -- which looks exactly like a crashing variant. run.js prints
    // well past 1MB on a 30s run, so any --metric use would hit this.
    { cwd: v.dir, stdio: ['ignore', metric ? 'pipe' : 'ignore', 'pipe'],
      encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) {
    // A variant that fails is not a fast variant. Say so loudly rather than
    // recording a suspiciously good sample.
    console.error(`ab-time: ${v.name} exited ${r.status} (signal ${r.signal}) — rerun it by hand`);
    console.error((r.stderr || '').split('\n').slice(-8).join('\n'));
    process.exit(1);
  }
  // /usr/bin/time -p writes `real N`, `user N`, `sys N` to stderr.
  const num = (key) => {
    const m = (r.stderr || '').match(new RegExp(`^${key}\\s+([0-9.]+)`, 'm'));
    return m ? parseFloat(m[1]) * 1000 : NaN;
  };
  const cpu = num('user') + num('sys');
  if (!isFinite(cpu)) {
    console.error(`ab-time: could not parse /usr/bin/time output for ${v.name}`);
    process.exit(1);
  }
  let value = NaN;
  if (metric) {
    const m = (r.stdout || '').match(metric);
    if (!m || m[1] === undefined) {
      console.error(`ab-time: --metric did not match ${v.name}'s stdout (needs one capture group)`);
      process.exit(1);
    }
    value = parseFloat(m[1]);
  }
  return { ms, cpu, value, load: (before + load1()) / 2 };
}

console.log(`ab-time: ${variants.length} variant(s), ${rounds} round(s), interleaved`);
console.log(`  cmd: node ${cmdArgs.join(' ')}`);
console.log(`  loadavg at start: ${os.loadavg().map(n => n.toFixed(2)).join(' ')}`);

if (warmup) {
  process.stdout.write('  warmup ');
  for (const v of variants) { runOnce(v); process.stdout.write('.'); }
  console.log(' done (discarded)');
}

// Interleaving alone is not enough: a FIXED order inside the round gives every
// variant a fixed position, and position is not neutral. Measured here — with
// main always first, all four experiments "beat" it by 6-11%, including one
// with a ~0% dispatch reduction, which is not a result, it is slot 1 being
// systematically penalised (it lands right after the previous round's tail).
// Rotating the order by one each round moves every variant through every slot.
for (let r = 1; r <= rounds; r++) {
  const cells = [];
  const order = variants.slice(r - 1).concat(variants.slice(0, r - 1));
  for (const v of order) {
    const s = runOnce(v);
    v.samples.push(s);
    cells.push(metric ? `${v.name} ${s.value}` : `${v.name} ${s.cpu.toFixed(0)}c/${s.ms.toFixed(0)}w`);
  }
  console.log(`  round ${String(r).padStart(2)}  load ${load1().toFixed(1).padStart(5)}  ${cells.join('  ')}`);
}

function stats(samples, key) {
  const ms = samples.map(s => s[key]).sort((a, b) => a - b);
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  return { min: ms[0], median: ms[(ms.length - 1) >> 1], max: ms[ms.length - 1], mean };
}

const base = variants[0];
const baseCpu = stats(base.samples, 'cpu');
console.log('');

if (metric) {
  // Throughput mode: bigger is better, and the headline is the MAX for the
  // same reason the timing headline is the min -- contention is one-sided, so
  // the best sample is the one least polluted by the rest of the box.
  const baseVal = stats(base.samples, 'value');
  console.log(`results (n=${rounds}, headline = max metric; baseline = ${base.name})`);
  console.log('  variant             metric max    median      spread    vs base');
  for (const v of variants) {
    const s = stats(v.samples, 'value');
    const d = v === base ? '' : `${((s.max / baseVal.max - 1) * 100).toFixed(2)}%`;
    const spread = `${((s.max / s.min - 1) * 100).toFixed(0)}%`;
    console.log(`  ${v.name.padEnd(18)} ${s.max.toFixed(0).padStart(10)} ` +
      `${s.median.toFixed(0).padStart(9)} ${spread.padStart(11)} ${d.padStart(10)}`);
  }
  const mFloor = Math.max(...variants.map(v => {
    const s = stats(v.samples, 'value');
    return (s.max / s.median - 1) * 100;
  }));
  console.log('');
  console.log(`  noise floor (worst median->max spread): ${mFloor.toFixed(1)}% — ` +
    `a difference smaller than this is not resolved by this run.`);
  const ld = variants.flatMap(v => v.samples.map(s => s.load));
  console.log(`  loadavg over the run: ${Math.min(...ld).toFixed(1)} .. ${Math.max(...ld).toFixed(1)}`);
  if (Math.max(...ld) > 4) {
    console.log('  WARNING: load went above 4 — these numbers describe the machine as much as the build.');
  }
  process.exit(0);
}

console.log(`results (n=${rounds}, headline = min CPU time; baseline = ${base.name})`);
console.log('  variant             cpu min   cpu median      cpu spread    vs base   wall min');
for (const v of variants) {
  const c = stats(v.samples, 'cpu');
  const w = stats(v.samples, 'ms');
  const d = v === base ? '' : `${((c.min / baseCpu.min - 1) * 100).toFixed(2)}%`;
  const spread = `${((c.max / c.min - 1) * 100).toFixed(0)}%`;
  console.log(`  ${v.name.padEnd(18)} ${c.min.toFixed(0).padStart(7)}ms ` +
    `${c.median.toFixed(0).padStart(9)}ms ${spread.padStart(14)} ` +
    `${d.padStart(9)} ${w.min.toFixed(0).padStart(8)}ms`);
}
// The change being hunted has to clear the measurement's own noise floor.
// Quote it rather than leaving the reader to eyeball the spread column.
const floor = Math.max(...variants.map(v => {
  const c = stats(v.samples, 'cpu');
  return (c.median / c.min - 1) * 100;
}));
console.log('');
console.log(`  noise floor (worst min->median spread): ${floor.toFixed(1)}% — ` +
  `a difference smaller than this is not resolved by this run.`);
const loads = variants.flatMap(v => v.samples.map(s => s.load));
const maxLoad = Math.max(...loads);
console.log('');
console.log(`  loadavg over the run: ${Math.min(...loads).toFixed(1)} .. ${maxLoad.toFixed(1)}`);
if (maxLoad > 4) {
  console.log('  WARNING: load went above 4 — these numbers describe the machine as much as the build.');
}
