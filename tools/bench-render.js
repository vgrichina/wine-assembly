#!/usr/bin/env node
// Benchmark the render path end to end: wall time, peak RSS, and composite
// throughput for a set of real apps.
//
// The GDI microbenchmark (test/test-wat-gdi-benchmark.js) measures WAT's
// rasterizer. This measures what happens after that -- surface uploads and
// screen composites -- which is the half that changes when the presenter
// changes, and the half that made test-aoe-menu reach 6.4GB.
//
// Usage:
//   node tools/bench-render.js                    # default app set
//   node tools/bench-render.js --batches=4000
//   node tools/bench-render.js --apps=notepad,mspaint
//   node tools/bench-render.js --repaint-every=100
//   node tools/bench-render.js --json             # machine-readable
//
// Numbers are medians of --runs (default 3). Compare runs on an idle machine:
// several agents sharing a box moves these by more than most code changes do.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
};
const has = name => process.argv.includes(`--${name}`);

const BATCHES = parseInt(arg('batches', '3000'), 10);
const RUNS = Math.max(1, parseInt(arg('runs', '3'), 10));
const REPAINT_EVERY = arg('repaint-every', '');
const AS_JSON = has('json');

// Apps chosen to cover distinct presenter loads: plain window chrome, heavy
// GDI redraw, a card game that blits many small bitmaps, and a shaped window.
const CANDIDATES = [
  { name: 'notepad', exe: 'test/binaries/notepad.exe' },
  { name: 'mspaint', exe: 'test/binaries/mspaint.exe' },
  { name: 'solitaire', exe: 'test/binaries/entertainment-pack/sol.exe' },
  { name: 'minesweeper', exe: 'test/binaries/entertainment-pack/winmine.exe' },
];

const wanted = arg('apps', '');
const apps = (wanted ? wanted.split(',').map(s => s.trim()) : CANDIDATES.map(a => a.name))
  .map(n => CANDIDATES.find(a => a.name === n))
  .filter(Boolean)
  .filter(a => fs.existsSync(path.join(ROOT, a.exe)));

if (!apps.length) {
  console.error('bench-render: no known apps present');
  process.exit(1);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function measure(app) {
  const times = [];
  const mems = [];
  for (let i = 0; i < RUNS; i++) {
    const args = [
      '-l', process.execPath, RUN, `--exe=${app.exe}`, '--no-build',
      `--max-batches=${BATCHES}`, '--quiet-api', '--quiet-blocks',
    ];
    if (REPAINT_EVERY) args.push(`--repaint-every=${REPAINT_EVERY}`);

    const started = Date.now();
    // spawnSync, not execFileSync: /usr/bin/time -l writes its report to
    // stderr on SUCCESS, and execFileSync only hands back stderr when the
    // child fails. -l reports max RSS across the process and its children,
    // which is the whole render path.
    const r = spawnSync('/usr/bin/time', args, {
      cwd: ROOT, encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024,
    });
    const ms = Date.now() - started;
    if (r.signal) throw new Error(`${app.name}: killed by ${r.signal}`);
    const m = (r.stderr || '').match(/(\d+)\s+maximum resident set size/);
    times.push(ms);
    mems.push(m ? parseInt(m[1], 10) / 1048576 : 0);
  }
  return {
    app: app.name,
    ms: Math.round(median(times)),
    batchesPerSec: Math.round(BATCHES / (median(times) / 1000)),
    peakMb: Math.round(median(mems)),
  };
}

const results = apps.map(measure);

if (AS_JSON) {
  console.log(JSON.stringify({ batches: BATCHES, runs: RUNS, repaintEvery: REPAINT_EVERY || 1, results }, null, 2));
} else {
  console.log(`bench-render  batches=${BATCHES}  runs=${RUNS}  repaint-every=${REPAINT_EVERY || 1}`);
  console.log('');
  console.log('  app            wall(ms)   batches/s   peak(MB)');
  console.log('  ------------   --------   ---------   --------');
  for (const r of results) {
    console.log(`  ${r.app.padEnd(12)}   ${String(r.ms).padStart(8)}   ${String(r.batchesPerSec).padStart(9)}   ${String(r.peakMb || '-').padStart(8)}`);
  }
}
