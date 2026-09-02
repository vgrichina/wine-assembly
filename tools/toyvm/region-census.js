#!/usr/bin/env node

'use strict';

// Every DOS binary in the corpus, run twice -- as shipped, and with its hottest
// loop replaced by a compiled region -- and one row per program saying whether
// the two drew the same frame.
//
//   node tools/toyvm/region-census.js --dir=/tmp/demos --md=/tmp/regions.md
//   node tools/toyvm/region-census.js --dir=/tmp/demos --out=/tmp/regions.json
//   node tools/toyvm/region-census.js --only=ACCIDENT.EXE,CONTACT.EXE --args='--no-lower'
//
// WHY THIS IS NOT sweep-dos.js. That file prices the tiers on a memory
// SNAPSHOT: it lifts one block into a standalone module and times it. Nothing
// it reports has ever run inside a program, so it cannot answer the only
// question that matters about a JIT -- does the demo still draw the same
// picture. equiv-dos.js can compare two whole runs, but only two runs that
// differ by a run-dos.js FLAG, and a region needs its own profiling pass and a
// handler-table install that no flag expresses. region-jit.js does exactly the
// right comparison and does it for one program, in prose.
//
// So this is a corpus driver around region-jit.js, and it reads that child's
// EXIT CODE rather than its prose:
//
//   0  frame identical -- the region is a drop-in replacement
//   2  no region: no samples in a live block, or no self-loop found
//   3  declined: a region was found and the builder refused it
//   4  frame DIFFERS -- a bug, and the row carries both hashes
//
// A child per program is the load-bearing part, for the same reason
// sweep-dos.js forks: a demo that wedges or traps has to become a row that says
// so, not take the census with it. Each child is killed with SIGKILL, never
// SIGTERM -- a guest stuck inside one long wasm slice never yields, so a
// handler-deliverable signal is queued and the run sails past its deadline.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

function findExes(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(exe|com)$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

module.exports = { findExes };

const RE = {
  // `region at guest ip 0x2d41: 1 block(s), 34 ops, 9.4% of samples`
  pick: /region at guest ip 0x([0-9a-f]+): (\d+) block\(s\), (\d+) ops, ([\d.]+)% of samples/,
  declined: /^declined: (.*)$/m,
  // `frame IDENTICAL  ints 1567/1567  smc 1/1  (baseline HASH 18447px stop a11:399 / region HASH 18447px stop a11:399)`
  frame: /frame (IDENTICAL|\*\*\* DIFFERS \*\*\*)\s+ints (\d+)\/(\d+)\s+smc (\d+)\/(\d+)\s+\(baseline (\S+) (\d+)px[^/]*\/ region (\S+) (\d+)px/,
  // the `region` row of the timing table: `wall ms  cpu ms   +3.1% cpu  (-2.0% wall)`.
  // Only printed at --reps>=2; a one-rep run prints `n/a` there on purpose.
  speed: /^\s*region\s+\d+\s+\d+\s+[\d.]+\s+[\d.]+\s+(-?[\d.]+)% cpu/m,
  // `expected    share 9.4% x (1 - 1/2.10x) = +4.9% ceiling, handbacks +12 vs baseline`
  expected: /^\s*expected\s+share ([\d.]+)% x \(1 - 1\/([\d.]+)x\) = ([-+][\d.]+)% ceiling, handbacks ([-+]\d+) vs baseline/m,
};

function classify(code, out) {
  if (code === 0) return 'identical';
  if (code === 4) return 'differs';
  // exit 6: the frame differed, and region-jit's own phase check found the
  // difference inside the noise floor the baseline shows over the same gap.
  if (code === 6) return 'phase';
  if (code === 2) return /no samples/.test(out) ? 'no-samples' : 'no-loop';
  if (code === 3) return 'declined';
  // exit 5 is the speed gate: a region WAS built, it just did not beat the
  // interpreter, so it is a coverage/perf row and never a correctness one.
  if (code === 5) return 'gated';
  // exit 7: the frame differed AND the arms disagreed on self-modify breaks, so
  // they did not run with the same notion of what is code. Still an open defect
  // -- it is broken out only because it is not a lowering bug, which is what a
  // `differs` row means everywhere else.
  if (code === 7) return 'smc-drift';
  if (code === null) return 'timeout';
  return 'crash';
}

// A DIFFERING FRAME IS NOT AUTOMATICALLY A BUG, AND THIS IS THE TRAP.
//
// Most of the corpus never terminates: a demo runs its effect until somebody
// presses a key, so the run stops when the dispatch budget does and the frame
// is a SNAPSHOT OF AN ANIMATION IN PROGRESS. region-jit.js charges $steps in
// one lump per straight line rather than one per op, so the two arms stop a few
// instructions apart having done the same work -- and a few instructions apart
// in a plasma loop is a different picture.
//
// Measured on CONTACT.EXE, whose region is correct under --no-lower: identical
// at 8M dispatches, identical at 11M, DIFFERS at 12M with the same pixel count.
// Reading that one budget on its own said "the region protocol is broken" and
// cost an afternoon. The lowered arm, which really is broken, differs at every
// budget and freezes on one byte-identical frame from 3M dispatches on.
//
// So a `differs` is confirmed at a SECOND budget before it is reported. Agreeing
// at either one means the region is a faithful replacement and the run was
// caught mid-frame; that is `phase`, and it is not a defect.
// THREE of them, not one, and it has to be three. A single retry is a coin
// toss: CONTACT.EXE under --no-lower is a faithful region that happens to
// disagree at 12M dispatches AND at 11.04M, and agrees at 11M and 8M. One
// confirmation would still have called it a bug. A region that is actually
// wrong disagrees at every budget, so any agreement at all clears it.
function confirmBudgets(n) {
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(n).trim());
  if (!m) return [];
  const mul = { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
  const base = Number(m[1]) * mul;
  // Far enough apart to land the animation somewhere else, near enough that the
  // run still reaches the same part of the program.
  return [0.92, 0.83, 0.67].map(f => `${Math.round(base * f)}`);
}

function runOne(exe, o, dispatches = o.dispatches) {
  return new Promise((resolve) => {
    const args = [path.join(__dirname, 'region-jit.js'), exe,
      `--dispatches=${dispatches}`, `--reps=${o.reps}`, ...o.extra];
    const ch = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { out += d; });
    // SIGKILL, not SIGTERM: see the header.
    const timer = setTimeout(() => ch.kill('SIGKILL'), o.timeout * 1000);
    ch.on('close', (code, signal) => {
      clearTimeout(timer);
      const killed = signal === 'SIGKILL';
      const row = { name: path.basename(exe), exe, verdict: classify(killed ? null : code, out) };
      const p = RE.pick.exec(out);
      if (p) row.region = { headIp: parseInt(p[1], 16), blocks: +p[2], ops: +p[3], share: +p[4] };
      const d = RE.declined.exec(out);
      if (d) row.declined = d[1];
      const f = RE.frame.exec(out);
      if (f) {
        row.frame = { same: f[1] === 'IDENTICAL',
          ints: [+f[2], +f[3]], smc: [+f[4], +f[5]],
          base: { hash: f[6], px: +f[7] }, jit: { hash: f[8], px: +f[9] } };
      }
      const s = RE.speed.exec(out);
      if (s) row.speedup = +s[1];
      const x = RE.expected.exec(out);
      if (x) row.expected = { share: +x[1], ratio: +x[2], ceiling: +x[3], handbacks: +x[4] };
      // Only kept for a row that went wrong: a passing row's prose is noise, and
      // 199 of them is a file nobody opens.
      if (row.verdict === 'differs' || row.verdict === 'crash' || row.verdict === 'timeout') {
        row.log = out.split('\n').filter(Boolean).slice(-12).join('\n');
      }
      resolve(row);
    });
  });
}

function markdown(rows, o) {
  const L = [];
  L.push(`# Region JIT: whole-program frame equivalence over ${rows.length} programs`);
  L.push('');
  L.push(`\`--dispatches=${o.dispatches}\`, \`--reps=${o.reps}\``
    + (o.extra.length ? `, extra \`${o.extra.join(' ')}\`` : '')
    + `, ${o.timeout}s SIGKILL per program.`);
  L.push('');
  // The census runs `jobs` programs at once by design -- a correctness verdict
  // does not care about the neighbours -- and that makes every `speed` cell a
  // measurement of a loaded box. It is here to spot a region that is
  // catastrophically slower, not to be quoted.
  L.push('`speed` is the region against the interpreter in the same child, by'
    + ' CPU time (min of interleaved, order-rotated reps). It is blank at'
    + ' `--reps=1`, where the arms never rotate and the number would describe'
    + ` the order, not the JIT. This census ran ${o.jobs} programs concurrently;`
    + ' CPU time is far less sensitive to that than the wall clock, but re-time'
    + ' anything interesting on a quiet box with `region-jit.js` alone.');
  L.push('');
  L.push('`ceiling` is the load-free view: `share x (1 - 1/gate ratio)`, the most'
    + ' the region can win whole-program given how much of the run it covers and'
    + ' how much faster its body is in isolation. `+hb` is the handbacks the'
    + ' region adds over the interpreter, each a JS round trip; a `speed` well'
    + ' under its `ceiling` is nearly always that column.');
  L.push('');
  L.push('A region is a drop-in replacement only if the demo draws the SAME frame'
    + ' with it installed. `no-loop`, `no-samples` and `declined` mean no region'
    + ' was installed, so they are coverage gaps rather than defects.');
  L.push('');
  L.push('- `identical` — same frame. The region is a faithful replacement.');
  L.push('- `phase` — differed at the first budget and agreed at the second.'
    + ' Most of the corpus never terminates, so the frame is a snapshot of a'
    + ' running animation and the arms stop a few instructions apart. **Not a'
    + ' defect.**');
  L.push('- `differs` — differed at both budgets. A bug in the region.');
  L.push('- `frozen` — differed at both budgets **and drew the identical frame at'
    + ' each** while the interpreter moved on. The guest stopped making'
    + ' progress: the worst kind of `differs`, and the one to fix first.');
  L.push('');
  const tally = {};
  for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  L.push('outcomes: ' + Object.entries(tally).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `**${k}** ${n}`).join(', '));

  const RANK = { frozen: 0, differs: 1, phase: 2, identical: 3 };
  const shown = rows.filter(r => RANK[r.verdict] !== undefined);
  L.push('');
  L.push('| program | head | ops | share | gate | ceiling | +hb | speed | frame | baseline | region | ints | smc |');
  L.push('|---|---|---:|---:|---:|---:|---:|---:|---|---|---|---|---|');
  const signed = (n) => (n >= 0 ? '+' : '') + n;
  for (const r of shown.sort((a, b) => RANK[a.verdict] - RANK[b.verdict])) {
    const g = r.region || {};
    const f = r.frame;
    const x = r.expected;
    L.push(`| ${r.name} | ${g.headIp === undefined ? '' : '0x' + g.headIp.toString(16)}`
      + ` | ${g.ops || ''} | ${g.share === undefined ? '' : g.share.toFixed(1) + '%'}`
      + ` | ${x ? x.ratio.toFixed(2) + 'x' : ''}`
      + ` | ${x ? signed(x.ceiling) + '%' : ''}`
      + ` | ${x ? signed(x.handbacks) : ''}`
      + ` | ${r.speedup === undefined ? '' : signed(r.speedup) + '%'}`
      + ` | ${r.verdict === 'identical' || r.verdict === 'phase' ? r.verdict : `**${r.verdict}**`}`
      + ` | ${f ? `${f.base.hash} ${f.base.px}px` : ''}`
      + ` | ${f ? `${f.jit.hash} ${f.jit.px}px` : ''}`
      + ` | ${f ? f.ints.join('/') : ''} | ${f ? f.smc.join('/') : ''} |`);
  }

  const gaps = rows.filter(r => !shown.includes(r));
  if (gaps.length) {
    L.push('');
    L.push('**no region installed**, by reason:');
    const by = {};
    for (const r of gaps) (by[r.verdict] = by[r.verdict] || []).push(r.name);
    for (const [k, names] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) {
      L.push(`- \`${k}\` — ${names.length}: ${names.slice(0, 20).join(', ')}`
        + (names.length > 20 ? ', …' : ''));
    }
    // The builder's own refusals are the work list for making regions cover
    // more of the corpus, so they are worth naming individually.
    const why = {};
    for (const r of gaps) if (r.declined) why[r.declined] = (why[r.declined] || 0) + 1;
    const ranked = Object.entries(why).sort((a, b) => b[1] - a[1]);
    if (ranked.length) {
      L.push('');
      L.push('**why the builder declined**:');
      for (const [k, n] of ranked.slice(0, 15)) L.push(`- ${n}× ${k}`);
    }
  }
  return L.join('\n') + '\n';
}

async function main() {
  const dir = arg('dir', '/tmp/demos');
  const only = arg('only') ? new Set(arg('only').split(',')) : null;
  const o = {
    dispatches: arg('dispatches', '6m'),
    reps: Number(arg('reps', 1)),
    timeout: Number(arg('timeout', 180)),
    // Anything after `--args=` is handed to every child, so one census can be
    // taken with a bisector switch on (`--args=--no-lower`) and diffed against
    // the default one. That is the corpus form of the ladders in
    // docs/toyvm-trace-jit.md, which until now were run a program at a time.
    extra: arg('args') ? arg('args').split(' ').filter(Boolean) : [],
    jobs: Number(arg('jobs', Math.max(1, Math.min(4, os.cpus().length - 2)))),
    confirmAt: flag('no-confirm') ? []
      : (arg('confirm-at') ? arg('confirm-at').split(',') : confirmBudgets(arg('dispatches', '6m'))),
  };
  let exes = findExes(dir);
  if (only) exes = exes.filter(e => only.has(path.basename(e)));
  console.log(`${exes.length} program(s), ${o.jobs} at a time, `
    + `--dispatches=${o.dispatches}, ${o.timeout}s cap each`);

  const rows = [];
  let next = 0;
  const worker = async () => {
    while (next < exes.length) {
      const i = next++;
      let r = await runOne(exes[i], o);
      // See secondBudget: a differing frame is confirmed at a second budget
      // before it counts as a defect. `--no-confirm` skips it, which is only
      // right when every program in the set is known to terminate.
      if (r.verdict === 'differs' && o.confirmAt.length) {
        r.confirm = [];
        for (const d of o.confirmAt) {
          const again = await runOne(exes[i], o, d);
          // AN AGREEMENT ON A BLANK SCREEN IS NOT AN AGREEMENT. A shorter budget
          // can stop before the demo has drawn anything, and two black frames
          // match trivially -- which cleared ACCIDENT.EXE, whose region really
          // does leave the guest stuck (18447px against 0px at the full budget).
          // A confirmation only counts when the interpreter had drawn something
          // by then.
          const informative = !again.frame || again.frame.base.px > 0
            || !r.frame || r.frame.base.px === 0;
          r.confirm.push({ dispatches: d, verdict: again.verdict, frame: again.frame,
            informative });
          if (again.verdict === 'identical' && informative) { r.verdict = 'phase'; break; }
          if (again.verdict === 'identical') continue;
          // A region that lands on the SAME frame at every budget while the
          // interpreter moves on is not merely different, it is stuck -- the
          // strongest signal in the census, and worth its own word.
          if (again.frame && r.frame && again.frame.jit.hash === r.frame.jit.hash
            && again.frame.base.hash !== r.frame.base.hash) r.verdict = 'frozen';
        }
      }
      rows[i] = r;
      const f = r.frame;
      console.log(`  [${String(i + 1).padStart(3)}/${exes.length}] ${r.name.padEnd(14)} ${r.verdict}`
        + (f && !f.same ? `  ${f.base.px}px vs ${f.jit.px}px` : '')
        + (r.speedup !== undefined && r.verdict === 'identical' ? `  ${r.speedup >= 0 ? '+' : ''}${r.speedup}%` : ''));
    }
  };
  await Promise.all(Array.from({ length: o.jobs }, worker));

  const out = rows.filter(Boolean);
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify({ o, rows: out }, null, 1));
  if (arg('md')) fs.writeFileSync(arg('md'), markdown(out, o));
  const tally = {};
  for (const r of out) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  console.log('\noutcomes: ' + Object.entries(tally).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`).join(', '));
  // `smc-drift` is listed here too: it is a real unresolved divergence, just one
  // with a named cause that is not the lowering.
  const bad = out.filter(r => r.verdict === 'differs' || r.verdict === 'frozen'
    || r.verdict === 'smc-drift');
  if (bad.length) {
    console.log(`bugs: ${bad.map(r => `${r.name} (${r.verdict})`).join(', ')}`);
  }
}

// Only when run directly: region-why.js requires this file for `findExes`, and
// an unguarded call here started a whole second corpus census inside it.
if (require.main === module) main();
