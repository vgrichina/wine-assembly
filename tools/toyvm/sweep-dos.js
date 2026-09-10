#!/usr/bin/env node

'use strict';

// Every DOS binary in the corpus against every version of the VM: the four
// interpreter dispatch shells AND the full JIT tier ladder, one row per program.
//
//   node tools/toyvm/sweep-dos.js --dir=/tmp/demos --out=/tmp/sweep.json
//   node tools/toyvm/sweep-dos.js --dir=/tmp/demos --md=/tmp/sweep.md --reps=3
//   node tools/toyvm/sweep-dos.js --one=DEMO.EXE            # child mode, one JSON line
//
// Why this exists rather than bench-dos.js --dir:
//
//   bench-dos.js   sweep-dos.js
//   -----------    ------------
//   4 shells       4 shells + tier 0/1/2/3 JIT + compile cost, same run
//   one process    one child process per program
//   prose          JSON per program, plus a markdown table
//
// The per-program child process is the load-bearing part. Over ~85 real 1993-95
// demos a good fraction hit an unimplemented opcode, spin forever, or run the
// decoder into unwritten memory, and in a single process the first one that
// traps or wedges takes the whole sweep with it. A child per program turns
// every one of those into a row that says what happened.
//
// Two independent measurements per program, and they answer different
// questions. Do not average them together:
//
//   shells  ns per DISPATCH over the whole program run. This is the number the
//           dispatch shootout reports, and it covers the real op mix including
//           the host calls and the DOS services.
//   tiers   ns per guest OP over the program's HOTTEST TRACE only, straight
//           line, no side exits. It is an upper bound on what a trace JIT buys
//           on the code it would actually compile, not a whole-program number.
//
// Both arms are interleaved rep by rep with the starting arm rotated and
// reported as the minimum, because this box regularly sits at load 10-40 and a
// sequential arm-then-arm layout there measures the machine. Both check that
// their arms computed the same thing before printing any ratio.
//
// The budget is GUEST SECONDS (`--guest-seconds=`, default 4.4), not the 8M
// dispatches it used to be, and `--dispatches=` is the override. The reason is
// in sweep-budget.js: a dispatch count stopped meaning a fixed amount of the
// guest's own time the moment the VGA frame period was requoted against real
// time (aadf7ec4), and 18 programs in this corpus lost their picture to that
// with nothing about them having changed. 4.4 seconds is what 8M dispatches
// used to buy of a paced show. Note what this does NOT change: the four shell
// timings are still ns per dispatch over whatever work the budget covers, and
// the arms are still checked against each other for having done the same work.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { sweepBudget, showSeconds } = require('./sweep-budget');

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

// --- child: one program, all versions ---------------------------------------
async function runOne(exe, o) {
  const { runDos } = require('./run-dos');
  const { VARIANTS } = require('./emit');
  const { jitTiers } = require('./trace-jit');
  const quiet = () => {};
  const row = { exe, name: path.basename(exe) };

  // --- the four interpreter shells ---
  const variants = o.variants;
  const samples = new Map(), seen = new Map();
  let nondet = null;
  try {
    for (let rep = 0; rep < o.reps; rep++) {
      for (let i = 0; i < variants.length; i++) {
        const v = variants[(i + rep) % variants.length];
        const r = await runDos({
          exe, variant: v, budget: o.budget, cpu: o.cpu, log: quiet, autoKey: true,
          // Independent of --region-jit ON PURPOSE: an on/off pair that means
          // anything has to hold the clock still in BOTH arms, so pass
          // --lattice-clock to both runs of the pair. See run-dos.js.
          latticeClock: o.latticeClock,
          regionJit: o.regionJit ? {
            sampleAfter: Math.floor(o.budget / 4), profileFor: Math.floor(o.budget / 4),
            gateAt: 0, log: quiet,
          } : null,
          // `--tree-fold`, corpus-wide, for the same reason: the fold is
          // supposed to be INVISIBLE (it charges the dispatches it removes), so
          // an off/on pair through sweep-diff.js is its correctness gate and
          // not a measurement. See docs/toyvm-tree-fold.md.
          treeFold: o.treeFold ? { log: quiet } : null,
        });
        // Two checks, and they catch different things. ACROSS variants: four
        // shells that did not execute the same instructions cannot be compared,
        // which is what `arms-disagree` reports. ACROSS reps of ONE variant:
        // a program whose output changes run to run is not a fixed workload at
        // all, and its four timings are four different computations no matter
        // how well the variants agree with each other on any single rep.
        const sig = `${r.dispatched}/${r.frame}`;
        if (!seen.has(v)) seen.set(v, { sig, r });
        else if (seen.get(v).sig !== sig) nondet = nondet || `${v} is not deterministic across reps`;
        if (!samples.has(v)) samples.set(v, []);
        samples.get(v).push(r.guestSecs * 1e9 / r.dispatched);
      }
    }
  } catch (e) {
    row.shells = { ok: false, reason: 'crash', detail: (e.message || String(e)).split('\n')[0] };
  }

  if (!row.shells) {
    const any = [...seen.values()][0].r;
    row.dispatched = any.dispatched;
    row.handbacks = any.handbacks;
    row.pixels = any.pixels;
    row.frame = any.frame;
    // What the budget bought in the guest's own time, and every video mode the
    // run passed through. Both are here so that two sweeps taken under
    // different clocks can be told apart from two taken under the same one --
    // a dispatch count alone cannot say which.
    row.guestSeconds = Math.round(any.guestSeconds * 100) / 100;
    row.modes = any.video.modes;
    row.stuckAt = any.stuckAt || null;
    // The byte the decoder refused, at the site it refused it. This is the
    // corpus's own to-do list for the ISA, and it is the difference between
    // "this program does not run" and "this program needs DAA".
    row.gaveUp = [];
    for (const [site] of (any.unimplemented || new Map())) {
      const lin = ((parseInt(site.split(':')[0], 16) << 4)
        + parseInt(site.split(':')[1], 16)) & 0xFFFFF;
      row.gaveUp.push({ site, byte: any.vm.mem[lin].toString(16).padStart(2, '0') });
    }
    const sigs = new Set([...seen.values()].map(s => s.sig));
    if (sigs.size > 1) {
      row.shells = { ok: false, reason: 'arms-disagree', sigs: [...sigs] };
    } else if (nondet) {
      row.shells = { ok: false, reason: 'nondeterministic', detail: nondet };
    } else {
      const ns = {};
      for (const v of variants) {
        const s = [...samples.get(v)].sort((a, b) => a - b);
        ns[v] = { min: s[0], med: s[(s.length - 1) >> 1], max: s[s.length - 1] };
      }
      const base = ns[variants[0]].min;
      row.shells = { ok: true, base: variants[0], ns, rel: Object.fromEntries(
        variants.map(v => [v, base / ns[v].min])) };
    }
  }

  // --- the two JIT tiers, on this program's hottest trace ---
  try {
    row.jit = await jitTiers(exe, {
      budget: o.budget, slice: o.slice, cpu: o.cpu,
      sampleAfter: o.sampleAfter, sampleFrom: o.sampleFrom, minOps: o.minOps,
      bench: true, iters: o.iters, reps: o.reps, log: quiet,
    });
    delete row.jit.fingerprints;    // large, and the boolean is the finding
  } catch (e) {
    row.jit = { ok: false, reason: 'crash', detail: (e.message || String(e)).split('\n')[0] };
  }
  return row;
}

// --- parent -----------------------------------------------------------------
function child(exe, o) {
  return new Promise((resolve) => {
    const args = [__filename, `--one=${exe}`, `--dispatches=${o.budget}`,
      `--reps=${o.reps}`, `--iters=${o.iters}`, `--cpu=${o.cpu}`,
      `--sample-after=${o.sampleAfter}`, `--sample-from=${o.sampleFrom}`,
      `--min-ops=${o.minOps}`, `--variants=${o.variants.join(',')}`,
      ...(o.regionJit ? ['--region-jit'] : []),
      ...(o.treeFold ? ['--tree-fold'] : []),
      ...(o.latticeClock ? ['--lattice-clock'] : [])];
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), o.timeout * 1000);
    p.on('close', (code, sig) => {
      clearTimeout(kill);
      const line = out.trim().split('\n').filter(l => l.startsWith('{')).pop();
      if (line) { try { return resolve(JSON.parse(line)); } catch (e) { /* fall through */ } }
      resolve({
        exe, name: path.basename(exe),
        shells: { ok: false, reason: sig === 'SIGKILL' ? 'timeout' : 'child-died',
          detail: err.trim().split('\n').slice(-1)[0] || `exit ${code}` },
        jit: { ok: false, reason: sig === 'SIGKILL' ? 'timeout' : 'child-died' },
      });
    });
  });
}

function geomean(xs) {
  const v = xs.filter(x => Number.isFinite(x) && x > 0);
  return v.length ? Math.exp(v.reduce((a, b) => a + Math.log(b), 0) / v.length) : NaN;
}

function markdown(rows, variants) {
  const L = [];
  // A program the decoder bailed out of after a few hundred dispatches still
  // produces four timings, and they are meaningless: at that length the number
  // is startup and compilation, not dispatch. CAVEIRA.COM stopped on an
  // unimplemented DAA after 13 guest bytes and reported 154 ns/dispatch, which
  // is 8x the corpus norm and would have dragged the geomean on its own.
  const MIN_DISPATCH = 1e6;
  const all = rows.filter(r => r.shells && r.shells.ok);
  const ok = all.filter(r => r.dispatched >= MIN_DISPATCH);
  const tooShort = all.length - ok.length;
  const jit = rows.filter(r => r.jit && r.jit.ok && r.jit.reason === 'benched');

  L.push('| program | dispatches | px | ' + variants.map(v => `\`${v}\``).join(' | ')
    + ' | hot trace | tier 1 | tier 2 | tier 3 | build |');
  L.push('|---|---:|---:|' + variants.map(() => '---:|').join('') + '---|---:|---:|---:|---:|');
  for (const r of rows) {
    const cells = [];
    if (r.shells && r.shells.ok) {
      for (const v of variants) {
        const rel = r.shells.rel[v];
        cells.push(v === r.shells.base ? `${r.shells.ns[v].min.toFixed(2)} ns`
          : `${rel >= 1 ? '+' : ''}${((rel - 1) * 100).toFixed(1)}%`);
      }
    } else {
      cells.push(`_${(r.shells || {}).reason || 'n/a'}_`, ...variants.slice(1).map(() => ''));
    }
    const j = r.jit || {};
    const trace = j.trace ? `${j.trace.ops} ops, ${j.trace.share.toFixed(0)}%` : '';
    const t1 = j.speedup ? `${j.speedup.t01.toFixed(2)}x` : `_${j.reason || ''}_`;
    const t2 = j.speedup ? `${j.speedup.t02.toFixed(2)}x` : '';
    // tier 3 and the compile cost are the two columns this table used to be
    // missing, and they are the two that decide whether any of the rest is
    // worth anything: t03 is the whole ladder, and `build` is what has to be
    // repaid before a single iteration of it counts.
    const t3 = j.speedup && j.speedup.t03 !== undefined ? `${j.speedup.t03.toFixed(2)}x` : '';
    const build = j.build ? `${(j.build.tier3Ns / 1e6).toFixed(1)} ms` : '';
    L.push(`| ${r.name} | ${r.dispatched ? (r.dispatched / 1e6).toFixed(1) + 'M' : ''} | `
      + `${r.pixels === undefined ? '' : r.pixels} | ${cells.join(' | ')} | ${trace} | ${t1} | ${t2}`
      + ` | ${t3} | ${build} |`);
  }

  L.push('');
  const rel = (rows_, v) => {
    const g = geomean(rows_.map(r => r.shells.rel[v]));
    return v === variants[0] ? 'baseline' : `${g >= 1 ? '+' : ''}${((g - 1) * 100).toFixed(1)}%`;
  };
  L.push(`**geomean over ${ok.length} programs that ran ≥${(MIN_DISPATCH / 1e6).toFixed(0)}M `
    + `dispatches** (baseline \`${variants[0]}\`, ${tooShort} excluded as too short): `
    + variants.map(v => `\`${v}\` ${rel(ok, v)}`).join(', '));

  // Split by whether the program drew anything. A demo that lights no pixels is
  // not necessarily broken -- it may still be unpacking or precomputing -- but
  // it is also where a program stuck in a two-instruction spin ends up, and
  // such a program's ns/dispatch describes that spin rather than a demo. If the
  // two halves agree, the ranking is not an artifact of the stuck ones.
  const drew = ok.filter(r => r.pixels > 0);
  const blank = ok.filter(r => !(r.pixels > 0));
  if (drew.length && blank.length) {
    L.push('');
    L.push(`  ...of which the ${drew.length} that lit pixels: `
      + variants.map(v => `\`${v}\` ${rel(drew, v)}`).join(', '));
    L.push(`  ...and the ${blank.length} that did not: `
      + variants.map(v => `\`${v}\` ${rel(blank, v)}`).join(', '));
  }
  // One place that formats the whole ladder, because there are two callers --
  // all benchable programs, and one row per DISTINCT trace -- and they drifted
  // apart the last time a tier was added.
  const ladder = (rs) => {
    const g = (k) => geomean(rs.map(r => r.jit.speedup[k]).filter(Number.isFinite));
    const parts = [`tier 0->1 ${g('t01').toFixed(2)}x`, `tier 1->2 ${g('t12').toFixed(2)}x`,
      `tier 2->3 ${g('t23').toFixed(2)}x`, `**tier 0->3 ${g('t03').toFixed(2)}x**`];
    return parts.join(', ');
  };
  // What the ladder costs, kept beside what it buys on purpose. A ratio with no
  // compile cost next to it reads as a speedup, and for four of the nine core
  // programs it is not one: the trace never runs enough iterations to repay a
  // single compile. See the break-even table in docs/toyvm-trace-jit.md.
  const cost = (rs) => {
    const built = rs.filter(r => r.jit.build);
    if (!built.length) return '';
    const ms = built.map(r => r.jit.build.tier3Ns / 1e6).sort((a, b) => a - b);
    const be = built.map(r => r.jit.build.breakEvenIters * r.jit.trace.ops)
      .filter(Number.isFinite).sort((a, b) => a - b);
    return `\n\n  ...and what it cost: build ${ms[0].toFixed(1)}-${ms[ms.length - 1].toFixed(1)} ms`
      + (be.length ? `, break-even ${(be[0] / 1e6).toFixed(2)}M-`
        + `${(be[be.length - 1] / 1e6).toFixed(2)}M guest ops` : '')
      + ' (NOT included in any ratio above)';
  };
  if (jit.length) {
    L.push('');
    L.push(`**geomean over ${jit.length} programs with a benchable hot trace**: ${ladder(jit)}`
      + cost(jit));
  }
  // Programs whose hottest trace is byte-identical to another program's. These
  // are not independent measurements: this corpus ships compressed, and the
  // LZEXE/PKLITE depacker is the same code in every one of them, so a profile
  // that starts at dispatch zero can report the same unpacking loop as the hot
  // trace of a dozen unrelated demos. Counting those as a dozen data points
  // would be counting one loop twelve times.
  // Keyed on the decoded ops, NOT on the guest bytes. See the note on
  // trace.sig in trace-jit.js: bytes are read when profiling ends and come back
  // all zero for any program that has overwritten the region since, which
  // collapsed eleven unrelated traces into one bucket. Older sweep JSON has no
  // `sig`, so fall back to bytes and let the op count keep those apart.
  const byBytes = new Map();
  for (const r of jit) {
    const t = r.jit.trace;
    const k = t.sig !== undefined ? t.sig : `${t.ops}:${t.bytes}`;
    if (!byBytes.has(k)) byBytes.set(k, []);
    byBytes.get(k).push(r.name);
  }
  const shared = [...byBytes.entries()].filter(([, ns]) => ns.length > 1)
    .sort((a, b) => b[1].length - a[1].length);
  if (shared.length) {
    L.push('');
    L.push('**shared hot traces** (same decoded ops in more than one program — one loop, not N):');
    for (const [, names] of shared) {
      const r = jit.find(x => x.name === names[0]);
      L.push(`- \`${r.jit.trace.bytes.slice(0, 23)}…\` (${r.jit.trace.ops} ops)`
        + ` × ${names.length}: ${names.join(', ')}`);
    }
    const key = (r) => (r.jit.trace.sig !== undefined
      ? r.jit.trace.sig : `${r.jit.trace.ops}:${r.jit.trace.bytes}`);
    const uniq = jit.filter(r => byBytes.get(key(r))[0] === r.name);
    L.push('');
    L.push(`**geomean counting each distinct trace once** (${uniq.length} traces): `
      + ladder(uniq) + cost(uniq));
  }

  const tally = {};
  for (const r of rows) {
    const k = r.shells && r.shells.ok ? ((r.jit || {}).reason || 'no-jit') : `shells:${(r.shells || {}).reason}`;
    tally[k] = (tally[k] || 0) + 1;
  }
  L.push('');
  L.push('outcomes: ' + Object.entries(tally).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`).join(', '));
  // `branchy` and `mismatch` both mean the tier arms did not agree, and only
  // one of them is a bug. Say which, next to the count, so nobody reads the
  // tally as a defect list again.
  if (tally.branchy || tally.mismatch) {
    L.push('');
    L.push('- `mismatch` — the arms ran the same program and computed different'
      + ' state. A micro-op bug.');
    L.push('- `branchy` — the op list transfers control somewhere other than its'
      + ' own end, so tier 0 takes an edge the straight-line tiers fall through.'
      + ' The arms ran *different programs*; the disagreement says nothing about'
      + ' the tiers. Inconclusive, not a defect.');
  }

  // Which opcodes the corpus is actually blocked on, ranked. This is the ISA
  // to-do list, ordered by how many programs each byte would unblock.
  const opcodes = new Map();
  for (const r of rows) {
    for (const b of new Set((r.gaveUp || []).map(g => g.byte))) {
      if (!opcodes.has(b)) opcodes.set(b, new Set());
      opcodes.get(b).add(r.name);
    }
  }
  const ranked = [...opcodes.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 12);
  if (ranked.length) {
    L.push('');
    L.push('**opcodes the decoder refused**, by how many programs hit them:');
    for (const [b, names] of ranked) {
      L.push(`- \`0x${b}\` — ${names.size} program${names.size > 1 ? 's' : ''}`
        + ` (${[...names].slice(0, 5).join(', ')}${names.size > 5 ? ', …' : ''})`);
    }
  }
  return L.join('\n');
}

async function main() {
  const { VARIANTS } = require('./emit');
  const o = {
    // Guest seconds, not dispatches -- see sweep-budget.js. 4.4 is what this
    // sweep's old 8M-dispatch default bought of a paced show before aadf7ec4
    // retimed the VGA frame period, so a row is photographed at the same point
    // in its program as the rows it is being compared with. `--dispatches=`
    // still wins when it is named, and an A/B of the interpreter against
    // itself should name it: that question wants fixed WORK.
    budget: sweepBudget({
      dispatches: arg('dispatches'),
      guestSeconds: arg('guest-seconds'),
      defaultGuestSeconds: showSeconds(8e6),
    }),
    slice: count(arg('slice'), 20000),
    sampleAfter: count(arg('sample-after'), 0),
    sampleFrom: Number(arg('sample-from', 0.5)),
    iters: count(arg('iters'), 20000),
    // Ask the profiler for a trace of at least this many ops. Without it the
    // hottest *block* is often one op long, and a one-op "trace" is not a
    // trace: it times a single handler, its tier ratios are noise, and ten of
    // twenty programs came back with byte-identical all-zero trace bytes --
    // decoded padding that the padding check passes because it does not end
    // 'too-long'. report-core10.js has always passed minOps: 6; this sweep did
    // not, and that difference alone made the two disagree.
    minOps: count(arg('min-ops'), 6),
    reps: Number(arg('reps', 3)),
    cpu: Number(arg('cpu', 386)),
    timeout: Number(arg('timeout', 180)),
    variants: arg('variants', VARIANTS.join(',')).split(',').filter(Boolean),
    // `--region-jit`: run the four interpreter shells with the LIVE region JIT
    // installed, so a corpus-wide on/off pair can be diffed with sweep-diff.js.
    // The profile window is a fraction of the budget rather than the run-loop
    // default (6M in, 6M wide), which at this sweep's 8M budget would never
    // finish profiling and would grade every program on a JIT that never
    // engaged. The gate's SPEED bar is dropped for the same reason it is
    // dropped in region-live-ab.js -- it is a measurement, and a busy box turns
    // it into "installed nothing, compared nothing". Its agreement half still
    // runs.
    regionJit: flag('region-jit'),
    // `--tree-fold`: run every shell with the expression-tree fold on, so a
    // corpus-wide off/on pair can be diffed. Independent of --region-jit for
    // the same reason as --lattice-clock, except that these two are mutually
    // exclusive at the run level (both append to the handler table).
    treeFold: flag('tree-fold'),
    // `--lattice-clock`: anchor the slice grid and the audio render to the
    // absolute dispatch count (run-dos.js). Independent of --region-jit so an
    // on/off sweep pair can set it on BOTH arms; without that the two arms run
    // different clocks and every time-paced program in the corpus reports a
    // difference the JIT did not cause.
    latticeClock: flag('lattice-clock'),
  };

  const one = arg('one');
  if (one) {
    const row = await runOne(one, o);
    console.log(JSON.stringify(row));
    return;
  }

  const dir = arg('dir');
  const exes = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (dir) exes.push(...findExes(dir));
  if (!exes.length) {
    console.log('usage: node tools/toyvm/sweep-dos.js --dir=D [--out=J] [--md=M] [--reps=] '
      + '[--guest-seconds=] [--dispatches=]');
    process.exit(2);
  }

  console.log(`${exes.length} programs x ${o.variants.length} shells + JIT tiers 0-3`);
  console.log(`load average ${os.loadavg()[0].toFixed(2)} at start\n`);
  const rows = [];
  const t0 = Date.now();
  for (const [i, exe] of exes.entries()) {
    const r = await child(exe, o);
    rows.push(r);
    const sh = r.shells && r.shells.ok ? `${r.shells.ns[o.variants[0]].min.toFixed(1)}ns` : (r.shells || {}).reason;
    const jt = r.jit && r.jit.speedup ? `${r.jit.speedup.t03.toFixed(2)}x` : (r.jit || {}).reason;
    console.log(`  [${String(i + 1).padStart(3)}/${exes.length}] ${r.name.padEnd(14)} `
      + `shells ${String(sh).padEnd(14)} jit ${jt}`);
    if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify({ opts: o, rows }, null, 1));
    if (arg('md')) fs.writeFileSync(arg('md'), markdown(rows, o.variants));
  }
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s, `
    + `load average ${os.loadavg()[0].toFixed(2)} at end\n`);
  console.log(markdown(rows, o.variants));
}

module.exports = { findExes, markdown, geomean };

if (require.main === module) main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
