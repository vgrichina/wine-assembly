#!/usr/bin/env node
// Drive several registered apps under --trace-loopmatch and report, per app
// and then corpus-wide, what the loop-idiom matcher saw at RUNTIME: how many
// self-loop block shapes actually executed, how many matched, and which gate
// the rest died at.
//
//   node tools/loopmatch-sweep.js [--apps=a,b,c] [--batches=3000] [--timeout=200]
//                                 [--out=DIR] [--keep-logs] [--json]
//
// This is the runtime companion to tools/match-loops.js, which answers the
// same question from a linear disassembly of the PE. The two disagree for a
// reason worth keeping in view: the static scan sees every loop in the binary,
// the sweep sees only the ones a headless run reaches, and most of these apps
// sit in a menu unless driven. A zero here is therefore "not executed in this
// window", never "not present" -- read it next to the static table in
// docs/loop-idiom-superops-design.md section 10.4.
//
// The gates themselves are not reimplemented: declineReason comes from
// tools/loopmatch-decode.js, so the sweep cannot drift from the single-log
// tool, and neither can drift from $loop_try_lut without both being wrong the
// same way.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseBlocks, uniqueShapes, declineReason, handlerNames } = require('./loopmatch-decode');

const ROOT = path.join(__dirname, '..');

// Apps whose PE statically contains LUT_RUN matches (section 10.4's table),
// plus the ones already known to reach real work headlessly. Registry ids
// from lib/apps.js; anything unknown is reported and skipped rather than
// failing the sweep.
const DEFAULT_APPS = [
  'heroes2_demo',            // the only app A1 has ever fired on
  'starcraft_shareware',     // 17 static LUT matches
  'diablo_shareware',        // 9
  'total_annihilation_demo', // 3
  'fallout_demo',            // 2
  'liquid_war',              // strongest negative, reaches a real frame
  'caesar3_demo',            // sprite remap through a table
  'worms2_demo',
  'marbles',
  'pinball',
];

function parseArgs(argv) {
  const opt = (n, d) => {
    const a = argv.find(x => x.startsWith(`--${n}=`));
    return a === undefined ? d : a.slice(n.length + 3);
  };
  return {
    apps: opt('apps', DEFAULT_APPS.join(',')).split(',').filter(Boolean),
    batches: parseInt(opt('batches', '3000'), 10),
    timeout: parseInt(opt('timeout', '200'), 10),
    out: opt('out', path.join(ROOT, 'scratch', 'loopmatch-sweep')),
    keepLogs: argv.includes('--keep-logs'),
    json: argv.includes('--json'),
  };
}

// One app, one run. Returns null when the app could not be run at all, so a
// missing binary reads differently from a run that found nothing.
function runApp(app, cfg) {
  const log = path.join(cfg.out, `${app}.log`);
  const args = [
    path.join(ROOT, 'test', 'run.js'),
    `--app=${app}`, '--no-close', '--quiet-api', '--quiet-blocks',
    `--max-batches=${cfg.batches}`, '--trace-loopmatch', '--loopmatch-stats',
    // Shape counts say what a super-op COULD lower; the hot-block histogram
    // says whether lowering it would be worth anything. A predicate that fires
    // on a loop nobody enters is a rounding error, and section 10 of the
    // design doc is explicit that match rate alone is the wrong metric.
    '--handler-hist-thread=0',
  ];
  let status = 'ok';
  let out = '';
  try {
    out = execFileSync('node', args, {
      cwd: ROOT, timeout: cfg.timeout * 1000, maxBuffer: 1 << 30, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    status = e.killed ? 'timeout' : `exit ${e.status}`;
    if (/unknown --app=/.test(out)) return { app, status: 'unknown app' };
  }
  fs.writeFileSync(log, out);

  // The WAT counters are authoritative for decoded/matched (they count every
  // record, across instances); the trace is what carries the op shapes.
  let decoded = 0, matched = 0;
  for (const m of out.matchAll(/^loopmatch: (\S+)\s+self-loop blocks decoded (\d+) matched (\d+)/gm)) {
    decoded += parseInt(m[2], 10);
    matched += parseInt(m[3], 10);
  }
  // `    0x0043acae 12933757 (9.00%)` under "top blocks". Only the top 20 are
  // printed, so this is a floor on the self-loop share, never an overestimate.
  const hot = new Map();
  for (const m of out.matchAll(/^\s+(0x[0-9a-f]{8}) (\d+) \(([\d.]+)%\)/gm)) {
    hot.set(parseInt(m[1], 16) >>> 0, parseFloat(m[3]));
  }

  const blocks = uniqueShapes(parseBlocks(log));
  let hotShare = 0;
  for (const b of blocks) hotShare += hot.get(b.eip) || 0;
  if (!cfg.keepLogs) fs.unlinkSync(log);
  return { app, status, decoded, matched, blocks, hotShare };
}

function main() {
  const cfg = parseArgs(process.argv.slice(2));
  fs.mkdirSync(cfg.out, { recursive: true });
  const names = handlerNames();

  const rows = [];
  const corpus = new Map();
  for (const app of cfg.apps) {
    process.stderr.write(`  ${app} ... `);
    const r = runApp(app, cfg);
    if (!r.blocks) { process.stderr.write(`${r.status}\n`); rows.push(r); continue; }
    const why = new Map();
    for (const b of r.blocks) {
      const reason = declineReason(b.ops, names) || 'MATCH';
      why.set(reason, (why.get(reason) || 0) + 1);
      corpus.set(reason, (corpus.get(reason) || 0) + 1);
    }
    r.why = [...why.entries()].sort((a, b) => b[1] - a[1]);
    r.shapes = r.blocks.length;
    delete r.blocks;
    rows.push(r);
    process.stderr.write(`${r.shapes} shapes, ${r.matched} matched\n`);
  }

  if (cfg.json) {
    console.log(JSON.stringify({ rows, corpus: [...corpus.entries()] }, null, 2));
    return;
  }

  console.log(`\napp                       decoded  shapes  matched  hot%  top declines`);
  for (const r of rows) {
    if (!r.why) { console.log(`${r.app.padEnd(24)}  ${r.status}`); continue; }
    const top = r.why.filter(([w]) => w !== 'MATCH').slice(0, 3)
      .map(([w, n]) => `${w} x${n}`).join(', ');
    console.log(`${r.app.padEnd(24)} ${String(r.decoded).padStart(8)} ${String(r.shapes).padStart(7)} ` +
      `${String(r.matched).padStart(8)} ${r.hotShare.toFixed(1).padStart(5)}  ${top}`);
  }
  console.log('\nhot% = share of the top-20 hottest blocks\' entries that are self-loop blocks' +
    '\n       (a floor: only 20 blocks are printed to read it from)');

  const total = [...corpus.values()].reduce((a, b) => a + b, 0);
  console.log(`\ncorpus-wide, ${total} unique executed self-loop shapes:`);
  for (const [why, n] of [...corpus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(n).padStart(5)}  ${(n * 100 / total).toFixed(1).padStart(5)}%  ${why}`);
  }
}

main();
