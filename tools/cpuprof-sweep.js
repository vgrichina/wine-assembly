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
//
// A PROFILE IS ONLY REPORTED IF THE RUN THAT PRODUCED IT ACTUALLY RAN.
//
// The first version of this tool profiled whatever app ids looked plausible in
// the registry and reported whatever came back. An app that dies partway still
// writes a .cpuprofile, and its ranks then describe the dying, not the
// interpreter: aoe2 came back "7.8% $gdi_bitmap_font_best" off 143ms of total
// wasm — noise wearing a finding's clothes.
//
// There are two checks, because there are two ways to not-run.
//
// DIED: `Stats: N API calls, M batches`, which run.js prints on a clean exit.
// M short of what was asked means the guest stopped on its own (finished,
// crashed, or trapped).
//
// IDLED: the sneakier one. aoe2 completes every one of 2500 batches and exits
// cleanly, and is still not running anything — it yields immediately each
// batch, so the whole profile holds 0.4s of samples and its "hottest function"
// is a 4ms entry. Ranking that produces confident-looking findings out of a
// dozen samples. So an app must also produce at least --min-wasm-ms of sampled
// WASM time; dxball, doing real work over the same budget, produces 1.8s.
//
// It is taken from the profiled run itself, not from a cheaper preflight. A
// short preflight was tried and thrown away: at 300 batches all 19 candidate
// apps passed in ~6s each, because none of them has started doing work yet that
// early — including aoe2, which dies before batch 2500. A gate has to watch the
// run you are actually going to report. `--quiet-api` is what makes that free:
// without it the [API] log flood costs about half the run to print, which is
// why stdout used to be thrown away here.
//
// This is a different question from test/test-all-exes.js, which asks "is there
// a non-blank frame by batch 80". A profile needs sustained work thousands of
// batches later; a smoke frame does not imply it.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// CANDIDATES, not a vetted set - the gates above decide which of these are
// benchmark material, and some of these are not. This list was originally
// assembled from app ids that looked plausible in the registry, with nothing
// checking that they run; aoe2 was in it for a whole sweep before anything
// noticed it executes nothing. Treat a name here as "worth trying", and read
// the UNFIT section of the output for what it turned out to be.
//
// Deliberately not the whole registry: ~160 apps at ~1min each is a night, and
// the 16-bit and screensaver families are dominated by their loaders, not their
// runtimes. diablo_shareware is deliberately absent: it is known-broken as of
// 2026-08-23 and profiling a broken run profiles the breakage. worms2_demo is
// the slow one at 450s; drop it with --apps if you want a quick pass.
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
// Least sampled wasm time an app must produce before its ranks mean anything.
// aoe2 over 2500 batches: 64ms, top entry 4ms. dxball over the same: 1800ms.
// The gap is two orders of magnitude, so the exact cutoff is not delicate.
const MIN_WASM_MS = parseFloat(flag('min-wasm-ms', '750'));

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
    `--repaint-every=${repaintEvery}`, '--no-build', '--quiet-blocks', '--quiet-api',
  ], { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
       // stdout IS piped, but only because --quiet-blocks and --quiet-api
       // together reduce it to a few dozen lines. Measured before they were
       // both on: `while (logs.length) console.log(...)` at test/run.js:6502
       // took 2502 of main()'s 2649 ticks — about half the entire run, inside
       // the harness, printing. With both flags there is nothing to print, and
       // piping buys the `Stats:` line that says whether the run was real.
       stdio: ['ignore', 'pipe', 'pipe'] });
  const wallMs = Date.now() - t0;

  if (r.error && r.error.code === 'ETIMEDOUT') {
    return { app, error: `timed out after ${timeoutMs / 1000}s`, wallMs };
  }
  // Did the guest actually run the whole budget? A profile of a run that
  // stopped early ranks the stopping, so refuse to report its ranks at all.
  const stats = ((r.stdout || '') + (r.stderr || '')).match(/^Stats: (\d+) API calls, (\d+) batches/m);
  if (!stats) {
    const tail = ((r.stderr || '') + '\n' + (r.stdout || '')).trim().split('\n').filter(Boolean).slice(-1)[0] || '';
    return { app, unfit: true, wallMs,
      error: `no clean exit (status ${r.status}) — ${tail.slice(0, 120)}` };
  }
  const done = parseInt(stats[2], 10);
  if (done < Number(maxBatches)) {
    return { app, unfit: true, wallMs,
      error: `stopped on its own at batch ${done}/${maxBatches} — not a sustained run` };
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
  const total = totalM ? parseFloat(totalM[1]) : NaN;
  const wasmPct = wasmM ? parseFloat(wasmM[1]) : NaN;
  const wasmMs = total * wasmPct / 100;
  if (!(wasmMs >= MIN_WASM_MS)) {
    return { app, unfit: true, wallMs,
      error: `idle: only ${wasmMs.toFixed(0)}ms of sampled wasm over ${maxBatches} batches ` +
        `(need ${MIN_WASM_MS}) — runs, but is not executing anything to measure` };
  }
  return {
    app, wallMs, apiCalls: parseInt(stats[1], 10), wasmMs,
    total, wasmPct, rows,
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
    console.log(`${res.unfit ? 'UNFIT' : 'SKIP '}  ${res.error}${res.detail ? ` — ${res.detail}` : ''}`);
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
  if (r.error || !r.rows) continue;
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
    if (r.error || !r.rows) continue;
    console.log(`  ${r.app}  (${(r.total / 1000).toFixed(1)}s total, wasm ${r.wasmPct.toFixed(0)}%)`);
    for (const row of r.rows) {
      console.log(`      ${row.pct.toFixed(1).padStart(5)}%  ${row.ms.toFixed(0).padStart(7)}ms  ${row.name}`);
    }
  }
}

const unfit = results.filter(r => r.unfit);
const skipped = results.filter(r => r.error && !r.unfit);
if (unfit.length) {
  console.log('');
  console.log(`${unfit.length} app(s) never reached a profilable state — not benchmark material:`);
  for (const r of unfit) console.log(`  ${r.app.padEnd(26)} ${r.error}`);
}
if (skipped.length) {
  console.log('');
  console.log(`${skipped.length} app(s) passed preflight but produced no profile — these are NOT "clean", they are unmeasured:`);
  for (const r of skipped) console.log(`  ${r.app.padEnd(26)} ${r.error}`);
}
