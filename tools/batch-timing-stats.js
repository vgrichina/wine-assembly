#!/usr/bin/env node
// Aggregate --trace-batch-timing output into a frame-time profile.
//
//   node test/run.js --exe=... --trace-batch-timing > run.log
//   node tools/batch-timing-stats.js run.log [--slow=33] [--top=10]
//
// --trace-batch-timing emits two raw lines per batch and no aggregation:
//   [batch-timing] batch=N run=Xms paint=Yms eip=0xADDR
//   [batch-timing] batch=N worker=Zms slices=S
// A "batch" is one emulator step plus its presentation, so total = run + paint
// + worker is the closest thing the CLI has to a frame time.
//
// WHY THIS EXISTS RATHER THAN A MEAN: the report that motivated it was "runs
// smooth for a while, then slows to a crawl, then is fine again". That is a
// question about CLUSTERING, and an average is exactly the statistic that
// hides it -- a run whose slow frames are spread evenly and a run whose slow
// frames arrive in one long stall have the same mean. So this prints the
// distribution, the worst individual batches, and a burst analysis that asks
// whether slow batches are ISOLATED or CONSECUTIVE.

const fs = require('fs');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const num = (name, dflt) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? Number(a.slice(name.length + 3)) : dflt;
};
// 33ms is one frame at 30fps -- past it the guest is visibly missing frames.
const SLOW = num('slow', 33);
const TOP = num('top', 10);

if (!file) {
  console.error('usage: batch-timing-stats.js <run.log> [--slow=33] [--top=10]');
  process.exit(2);
}

const batches = new Map();
function slot(n) {
  if (!batches.has(n)) batches.set(n, { batch: n, run: 0, paint: 0, worker: 0, slices: 0, eip: '' });
  return batches.get(n);
}

for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.startsWith('[batch-timing]')) continue;
  const m = /batch=(\d+)/.exec(line);
  if (!m) continue;
  const s = slot(Number(m[1]));
  const run = /run=(\d+)ms/.exec(line);
  const paint = /paint=(\d+)ms/.exec(line);
  const worker = /worker=(\d+)ms/.exec(line);
  const slices = /slices=(\d+)/.exec(line);
  const eip = /eip=(0x[0-9a-fA-F]+)/.exec(line);
  if (run) s.run = Number(run[1]);
  if (paint) s.paint = Number(paint[1]);
  if (worker) s.worker = Number(worker[1]);
  if (slices) s.slices = Number(slices[1]);
  if (eip) s.eip = eip[1];
}

const rows = [...batches.values()].sort((a, b) => a.batch - b.batch);
if (!rows.length) {
  console.error(`no [batch-timing] lines in ${file} -- was --trace-batch-timing passed?`);
  process.exit(1);
}
for (const r of rows) r.total = r.run + r.paint + r.worker;

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
function summarize(key) {
  const vals = rows.map(r => r[key]);
  const sorted = [...vals].sort((a, b) => a - b);
  const sum = vals.reduce((a, b) => a + b, 0);
  return {
    key, sum, mean: sum / vals.length,
    p50: pct(sorted, 0.5), p90: pct(sorted, 0.9),
    p99: pct(sorted, 0.99), max: sorted[sorted.length - 1],
  };
}

const wall = rows.reduce((a, r) => a + r.total, 0);
console.log(`batches=${rows.length}  wall=${(wall / 1000).toFixed(1)}s in timed sections`);
console.log('');
console.log('component      total     mean     p50     p90     p99     max');
for (const k of ['run', 'paint', 'worker', 'total']) {
  const s = summarize(k);
  const share = wall ? ` ${(100 * s.sum / wall).toFixed(0).padStart(3)}%` : '';
  console.log(
    `${k.padEnd(10)} ${String(s.sum + 'ms').padStart(8)}${share}` +
    ` ${s.mean.toFixed(1).padStart(7)} ${String(s.p50).padStart(6)} ${String(s.p90).padStart(6)}` +
    ` ${String(s.p99).padStart(6)} ${String(s.max).padStart(6)}`);
}

// Slow-batch distribution. Isolated slow batches read as ordinary jitter; a
// long consecutive run is the stall a user actually notices.
const slow = rows.filter(r => r.total > SLOW);
console.log('');
console.log(`slow batches (>${SLOW}ms): ${slow.length} of ${rows.length} (${(100 * slow.length / rows.length).toFixed(1)}%)`);

const bursts = [];
for (const r of slow) {
  const last = bursts[bursts.length - 1];
  if (last && r.batch === last.end + 1) { last.end = r.batch; last.ms += r.total; last.n++; }
  else bursts.push({ start: r.batch, end: r.batch, ms: r.total, n: 1 });
}
if (bursts.length) {
  const multi = bursts.filter(b => b.n > 1);
  console.log(`  in ${bursts.length} burst(s); ${multi.length} span more than one batch`);
  console.log('  longest bursts (consecutive slow batches):');
  for (const b of [...bursts].sort((a, c) => c.n - a.n).slice(0, 5)) {
    console.log(`    batches ${b.start}..${b.end}  n=${b.n}  ${b.ms}ms total`);
  }
}

console.log('');
console.log(`slowest ${TOP} batches:`);
console.log('  batch    total     run   paint  worker  eip');
for (const r of [...rows].sort((a, b) => b.total - a.total).slice(0, TOP)) {
  console.log(`  ${String(r.batch).padStart(6)} ${String(r.total + 'ms').padStart(8)}` +
    ` ${String(r.run).padStart(7)} ${String(r.paint).padStart(7)} ${String(r.worker).padStart(7)}  ${r.eip}`);
}

// Timeline: mean total per bucket, so a stall shows up as a spike in place
// rather than being averaged into the run.
const BUCKETS = 60;
const per = Math.max(1, Math.ceil(rows.length / BUCKETS));
const buckets = [];
for (let i = 0; i < rows.length; i += per) {
  const chunk = rows.slice(i, i + per);
  buckets.push(chunk.reduce((a, r) => a + r.total, 0) / chunk.length);
}
const peak = Math.max(...buckets, 1);
const RAMP = ' .:-=+*#%@';
console.log('');
console.log(`timeline (${per} batch(es)/cell, peak ${peak.toFixed(0)}ms):`);
console.log('  ' + buckets.map(v => RAMP[Math.min(RAMP.length - 1, Math.floor(v / peak * (RAMP.length - 1)))]).join(''));
console.log(`  first batch ${rows[0].batch} -> last batch ${rows[rows.length - 1].batch}`);
