#!/usr/bin/env node

'use strict';

// WHY 111 OF 199 PROGRAMS GET NO REGION AT ALL.
//
//   node tools/toyvm/region-why.js [--dir=/tmp/demos] [--jobs=4] [--top=20]
//   node tools/toyvm/region-why.js --only=DRAGON.EXE,CARRIE.EXE --list
//
// `region-census.js` reports coverage as two verdicts -- `no-loop` and
// `no-samples` -- and neither says anything actionable. "No self-loop region
// found" is a summary of a search that rejected every candidate it looked at,
// one rule at a time, and `region-jit.js --why` already prints each of those
// rejections. What has never existed is the aggregate: which RULE, across the
// whole corpus, stands between us and the most programs.
//
// So this runs the pick with `--why` on every program, keeps the rejections
// from the ones that ended with no region, normalizes each line down to its
// rule (the addresses and counts differ per program; the rule does not), and
// histograms by PROGRAMS BLOCKED rather than by occurrences -- a single program
// can reject two thousand candidates for one reason and would otherwise drown
// out a rule that quietly blocks forty.
//
// It deliberately does NOT run the region. Nothing here compares a frame or
// times anything; the question is only which shapes the picker can reach. That
// makes it cheap enough to run over the corpus while a census is going.
//
// `no-samples` is kept as its own bucket and never mixed in. It is a different
// failure: the profiler's samples landed in blocks that no longer exist, which
// is what a self-decrypting program does to its own arena, and no amount of
// loosening the pick rules reaches it.

const path = require('path');
const { spawn } = require('child_process');
const { findExes } = require('./region-census');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

// One rejection line -> the rule that produced it. Everything program-specific
// goes: hex addresses, the op counts in `N ops < M`, the handler NAME in
// `contains foo` (that name is itself the interesting axis, so it gets its own
// histogram rather than being folded away here).
// How far the candidate got before it died, from the `[depth N]` region-jit.js
// prints. See depthOf's caller for why only the deepest line per program is
// counted.
function depthOf(line) {
  const m = /\[depth (\d+)\]/.exec(line);
  return m ? Number(m[1]) : -1;
}

function ruleOf(line) {
  const s = line.replace(/^\s*reject\s+/, '').replace(/\s*\[depth \d+\]/, '')
    .replace(/0x[0-9a-f]+/g, 'ADDR');
  const contains = /contains (\S+)$/.exec(s);
  if (contains) return { rule: 'block contains an op the walk will not cross', op: contains[1] };
  return { rule: s.replace(/\d+/g, 'N').replace(/^ADDR: /, ''), op: null };
}

function run(exe, o) {
  return new Promise((resolve) => {
    const args = [path.join(__dirname, 'region-jit.js'), exe, '--why',
      `--dispatches=${o.dispatches}`, '--reps=1', '--pick-only', ...o.pass];
    const ch = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { out += d; });
    const kill = setTimeout(() => ch.kill('SIGKILL'), o.timeout * 1000);
    ch.on('close', (code) => { clearTimeout(kill); resolve({ out, code }); });
  });
}

async function main() {
  const o = {
    dir: arg('dir', '/tmp/demos'),
    jobs: Number(arg('jobs', 4)),
    dispatches: arg('dispatches', '6m'),
    timeout: Number(arg('timeout', 180)),
    top: Number(arg('top', 20)),
    // Extra region-jit.js flags, comma-separated and passed through verbatim:
    // `--pass=--no-revisit-roots,--no-caller-roots` re-measures coverage as an
    // older pick behaved, which is the only way to attribute a change in the
    // share distribution to the thing that changed.
    pass: String(arg('pass', '')).split(',').filter(Boolean),
  };
  const only = arg('only') ? new Set(arg('only').split(',')) : null;
  const exes = findExes(o.dir).filter(e => !only || only.has(path.basename(e)));
  console.log(`${exes.length} program(s), ${o.jobs} at a time, --dispatches=${o.dispatches}`);

  const rows = [];
  let next = 0;
  const worker = async () => {
    while (next < exes.length) {
      const i = next++;
      const exe = exes[i];
      const name = path.basename(exe);
      const { out, code } = await run(exe, o);
      let verdict = 'region';
      if (code === null) verdict = 'timeout';
      else if (/no samples landed/.test(out)) verdict = 'no-samples';
      else if (/no self-loop region found/.test(out)) verdict = 'no-loop';
      else if (!/region at guest ip/.test(out)) verdict = 'crash';
      const rejects = out.split('\n').filter(l => /^\s*reject /.test(l));
      // The share the picked region carries. A region's whole-program win is
      // capped by its share (Amdahl), so a region at 0.0% cannot help by
      // construction and can only add risk -- printing it here is what makes a
      // sample floor a measured choice rather than a guessed constant.
      const share = /, ([\d.]+)% of samples/.exec(out);
      rows.push({ name, verdict, rejects, share: share ? Number(share[1]) : null });
      console.log(`  [${String(i + 1).padStart(3)}/${exes.length}] ${name.padEnd(14)} `
        + `${verdict}${verdict === 'no-loop' ? `  ${rejects.length} candidate(s) rejected` : ''}`
        + (share ? `  ${share[1]}%` : ''));
      if (flag('list') && rejects.length) for (const r of rejects) console.log(`      ${r.trim()}`);
    }
  };
  await Promise.all(Array.from({ length: o.jobs }, worker));

  const tally = {};
  for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  console.log('\nverdicts: ' + Object.entries(tally).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`).join(', '));

  // ONE BLOCKER PER PROGRAM: the rule that killed the candidate which came
  // closest to closing. Unioning the rules of every rejected candidate -- what
  // this did first -- answers a different and much weaker question ("did any
  // candidate in this program meet rule X"), and it inflates: the first census
  // read 36 programs on `ret with no inlined call`, rooting candidates at their
  // call sites to fix exactly that shape moved coverage by ONE program, and the
  // 36 barely moved either, because most of those programs were never blocked
  // by it. A per-program-blocker histogram sums to the program count and cannot
  // tell that story wrong.
  const byRule = new Map(), byOp = new Map();
  for (const r of rows.filter(x => x.verdict === 'no-loop')) {
    let best = null, bestDepth = -2;
    for (const line of r.rejects) {
      const d = depthOf(line);
      if (d > bestDepth) { bestDepth = d; best = line; }
    }
    if (!best) continue;
    const { rule, op } = ruleOf(best);
    byRule.set(rule, (byRule.get(rule) || new Set()).add(r.name));
    if (op) byOp.set(op, (byOp.get(op) || new Set()).add(r.name));
  }
  const show = (title, m) => {
    console.log(`\n${title}`);
    for (const [k, set] of [...m].sort((a, b) => b[1].size - a[1].size).slice(0, o.top)) {
      console.log(`  ${String(set.size).padStart(3)}  ${k}`);
    }
  };
  const shares = rows.filter(r => r.share !== null).map(r => r.share).sort((a, b) => a - b);
  if (shares.length) {
    const at = (p) => shares[Math.min(shares.length - 1, Math.floor(shares.length * p))];
    console.log(`\nregion sample share: min ${at(0)}%  p10 ${at(0.1)}%  p50 ${at(0.5)}%`
      + `  p90 ${at(0.9)}%  max ${shares[shares.length - 1]}%`
      + `   (${shares.filter(s => s < 1).length} under 1%,`
      + ` ${shares.filter(s => s === 0).length} at 0.0%)`);
  }
  show(`rules that blocked a program (of ${tally['no-loop'] || 0} no-loop programs)`, byRule);
  show('ops the walk refused to cross, by programs blocked', byOp);
}

main();
