#!/usr/bin/env node
// Profile many apps in one pass and rank each one's hottest self-time function.
//
//   node tools/cpuprof-sweep.js                        the default app set
//   node tools/cpuprof-sweep.js --apps=rct,caesar3_demo --max-batches=4000
//   node tools/cpuprof-sweep.js --outliers                 only the findings
//
// WHY THIS EXISTS
//
// The one large interpreter win found during the dispatch-perf investigation
// was $invalidate_page: 64.5% of total CPU on RollerCoaster Tycoon, an
// O(CACHE_SIZE) sweep on the guest store path. Nobody was looking for it. One
// app happened to get profiled and it dominated that app's entire run.
//
// That suggests the class is ambient rather than special, and it is invisible
// to the metric the perf work had been using: a handler histogram counts
// handlers, and this cost was not in a handler. So: profile broadly, and let
// self time say what is expensive instead of assuming it is dispatch.
//
// A self-time reading is also the only perf number this box can produce
// honestly. It is a SINGLE-profile measurement — "$invalidate_page is 51,348ms
// of a 79,571ms run" needs no comparison run at all, so background load, slot
// position and drift, which defeated four separate interleaved A/B passes
// (docs/interpreter-dispatch-perf.md), cannot touch it. Load still stretches
// the absolute milliseconds; it does not change which function dominates.
//
// PICK THE BATCH COUNT FROM THE PHASE YOU MEAN TO MEASURE. RCT runs at 36M
// ops/s for its first ~2500 batches and 2.9M after; caesar3 idles on its title
// screen for 31x fewer ops than its gameplay run. A sweep that stops early
// profiles startup and loading in every app and finds nothing. The default
// here is deliberately past those cliffs, which is why it is slow.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Apps that actually reach a running state and do sustained work. Deliberately
// not the whole registry: ~160 apps at ~1min each is a night, and the 16-bit
// and screensaver families are dominated by their loaders, not their runtimes.
// diablo_shareware is deliberately absent: it is known-broken as of 2026-08-23
// and profiling a broken run profiles the breakage. It also timed out at 600s
// in the first sweep. worms2_demo is the slow one at 450s; drop it with --apps
// if you want a quick pass.
const DEFAULT_APPS = [
  'rct', 'caesar3_demo', 'starcraft_shareware',
  'fallout_demo', 'heroes2_demo', 'worms2_demo', 'total_annihilation_demo',
  'captain_claw_demo', 'aoe2', 'mw3', 'marbles', 'pinball', 'blobby_volley',
  'dxball', 'tworld', 'mspaint98', 'wordpad', 'explorer98', 'winamp',
];

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const a = argv.find(x => x.startsWith(`--${name}=`));
  return a === undefined ? dflt : a.slice(name.length + 3);
};
const apps = flag('apps', '').split(',').filter(Boolean);
const APPS = apps.length ? apps : DEFAULT_APPS;
const maxBatches = flag('max-batches', '4000');
const batchSize = flag('batch-size', '50000');
const repaintEvery = flag('repaint-every', '500');
const top = parseInt(flag('top', '6'), 10);
// A function that is a large share of one app's entire run is the finding.
// $invalidate_page was 64.5%; nothing legitimate in a well-spread interpreter
// should be near this, so anything over it is worth a human looking.
const OUTLIER_PCT = parseFloat(flag('outlier-pct', '15'));
const outliersOnly = argv.includes('--outliers');
const keep = argv.includes('--keep-profiles');
// A run that dies still wrote a profile of its dying, which is not a finding
// about the interpreter. Bound it, and say so rather than reporting the ranks.
const timeoutMs = parseInt(flag('timeout', '600'), 10) * 1000;

const outDir = flag('out', path.join(os.tmpdir(), 'cpuprof-sweep'));
fs.mkdirSync(outDir, { recursive: true });

function profileOne(app) {
  const dir = path.join(outDir, app);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [
    '--cpu-prof', `--cpu-prof-dir=${dir}`,
    'test/run.js', `--app=${app}`,
    `--batch-size=${batchSize}`, `--max-batches=${maxBatches}`,
    `--repaint-every=${repaintEvery}`, '--no-build', '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs,
       // stdout to /dev/null, NOT to a pipe. Measured: with stdout piped and
       // per-batch progress logging on, `while (logs.length) console.log(...)`
       // at test/run.js:6502 took 2502 of main()'s 2649 ticks — about half the
       // entire run, inside the harness, printing. --quiet-blocks kills the
       // per-batch lines; ignoring stdout kills the rest. Profile the emulator,
       // not the terminal.
       stdio: ['ignore', 'ignore', 'pipe'] });
  const wallMs = Date.now() - t0;

  if (r.error && r.error.code === 'ETIMEDOUT') {
    return { app, error: `timed out after ${timeoutMs / 1000}s`, wallMs };
  }
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.cpuprofile')) : [];
  if (!files.length) {
    // No profile means the process did not exit cleanly; V8 writes it on exit.
    const tail = ((r.stderr || '') + (r.stdout || '')).trim().split('\n').slice(-3).join(' | ');
    return { app, error: `no .cpuprofile written (exit ${r.status})`, detail: tail, wallMs };
  }
  // Several profiles appear when the run spawns worker threads. The main
  // thread's is the largest and is the one the interpreter's main loop is on.
  const biggest = files
    .map(f => ({ f, size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.size - a.size)[0].f;

  const t = spawnSync(process.execPath,
    [path.join(__dirname, 'cpuprof-top.js'), path.join(dir, biggest), String(top),
     '--names', '--wasm-only'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (t.status !== 0) return { app, error: `cpuprof-top failed: ${(t.stderr || '').trim()}`, wallMs };

  const out = t.stdout || '';
  const totalM = out.match(/^total sampled: ([\d.]+) ms/m);
  const wasmM = out.match(/^wasm: [\d.]+ ms \(([\d.]+)%\)/m);
  // Only the "self time, wasm only" section. The JS half of a --cpu-prof
  // reading is not trustworthy here: profiling more than DOUBLES the run
  // (2.6-3.0s unprofiled vs 6.3s sampled on caesar3 @1500 batches — V8 pays a
  // lot to unwind wasm frames), and that inflation lands on a single line of
  // the async main(), which then reads as "57% of CPU in run.js:6502". It is
  // not: suppressing that line's work entirely (--quiet-api, stdout to
  // /dev/null) changes the unprofiled wall clock by nothing. Wasm leaf frames
  // do not have that problem, and are what found $invalidate_page.
  const wasmOnly = out.split('--- self time, wasm only ---')[1] || '';
  const rows = [];
  for (const line of wasmOnly.split('\n')) {
    const m = line.match(/^\s*([\d.]+) ms\s+([\d.]+)% of wasm\s+(.+)$/);
    if (m) rows.push({ ms: parseFloat(m[1]), pct: parseFloat(m[2]), name: m[3].trim() });
  }
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  return {
    app, wallMs,
    total: totalM ? parseFloat(totalM[1]) : NaN,
    wasmPct: wasmM ? parseFloat(wasmM[1]) : NaN,
    rows,
  };
}

console.log(`cpuprof-sweep: ${APPS.length} app(s), --max-batches=${maxBatches} ` +
  `--batch-size=${batchSize} --repaint-every=${repaintEvery}`);
console.log(`  loadavg: ${os.loadavg().map(n => n.toFixed(2)).join(' ')}  ` +
  `(self-time shares are load-independent; the ms are not)`);
console.log('');

const results = [];
for (const app of APPS) {
  process.stdout.write(`  ${app.padEnd(26)}`);
  const res = profileOne(app);
  results.push(res);
  if (res.error) {
    console.log(`SKIP  ${res.error}${res.detail ? ` — ${res.detail}` : ''}`);
    continue;
  }
  const hot = res.rows[0];
  console.log(`${(res.total / 1000).toFixed(1).padStart(6)}s  wasm ${res.wasmPct.toFixed(0).padStart(3)}%  ` +
    `hot: ${hot ? `${hot.pct.toFixed(1)}% ${hot.name}` : '(none)'}`);
}

console.log('');
console.log(`=== functions over ${OUTLIER_PCT}% of their app's WASM time ===`);
console.log(`    ($invalidate_page was 85% of wasm on RCT — that is the shape being hunted)`);
let found = 0;
for (const r of results) {
  if (r.error) continue;
  for (const row of r.rows) {
    if (row.pct < OUTLIER_PCT) continue;
    found++;
    console.log(`  ${r.app.padEnd(26)} ${row.pct.toFixed(1).padStart(5)}%  ` +
      `${row.ms.toFixed(0).padStart(7)}ms  ${row.name}`);
  }
}
if (!found) console.log('  (none — no single function dominates any app in this set)');

if (!outliersOnly) {
  console.log('');
  console.log('=== per-app top self time ===');
  for (const r of results) {
    if (r.error) continue;
    console.log(`  ${r.app}  (${(r.total / 1000).toFixed(1)}s total, wasm ${r.wasmPct.toFixed(0)}%)`);
    for (const row of r.rows) {
      console.log(`      ${row.pct.toFixed(1).padStart(5)}%  ${row.ms.toFixed(0).padStart(7)}ms  ${row.name}`);
    }
  }
}

const skipped = results.filter(r => r.error);
if (skipped.length) {
  console.log('');
  console.log(`${skipped.length} app(s) produced no profile — these are NOT "clean", they are unmeasured:`);
  for (const r of skipped) console.log(`  ${r.app.padEnd(26)} ${r.error}`);
}
