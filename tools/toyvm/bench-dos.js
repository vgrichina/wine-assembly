#!/usr/bin/env node

'use strict';

// Compare the toy VM's dispatch shells on real DOS programs.
//
//   node tools/toyvm/bench-dos.js scratch/mars/mars.exe
//   node tools/toyvm/bench-dos.js a.exe b.exe --variants=tailcall,switch --reps=5
//   node tools/toyvm/bench-dos.js --dir=scratch/demos --dispatches=20m --json
//   node tools/toyvm/bench-dos.js a.exe --variants=tailcall,tailcall+nofuse
//
// An arm is a dispatch shell plus optional `+`-suffixed switches (nofuse,
// nowasmdecode, nocache), so a compiler change gets the same interleaved
// treatment a shell change does.
//
// Every arm runs in ONE process, alternating rep by rep with the starting arm
// rotated, and the reported number is the MINIMUM over reps. That is not
// fussiness: this box regularly sits at load 10-40, and a sequential
// arm-then-arm layout there measures the machine. Same discipline as
// tools/bench-loops.js.
//
// What is timed is only the wall clock inside `vm.exports.run` -- decode, trace
// compilation, PNG writing and DOS service calls are host work that every arm
// pays identically and that would otherwise swamp the signal.
//
// The frame hash and the dispatch count are checked across arms first. If two
// shells did not execute the same instructions, their times are not comparable
// and the run says so instead of printing a ratio.

const fs = require('fs');
const path = require('path');
const { runDos } = require('./run-dos');
const { VARIANTS } = require('./emit');

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

async function main() {
  const exes = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const dir = arg('dir');
  if (dir) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (/\.(exe|com)$/i.test(f)) exes.push(path.join(dir, f));
    }
  }
  if (!exes.length) {
    console.log('usage: node tools/toyvm/bench-dos.js <exe...> [--dir=D] [--variants=] [--reps=] [--dispatches=]');
    process.exit(2);
  }

  // An arm is a dispatch shell plus any number of `+`-suffixed switches, so
  // the same interleaved harness can A/B a compiler change and not just a
  // shell: `--variants=tailcall,tailcall+nofuse`. The rotation, the
  // minimum-of-reps and the agreement check all apply unchanged, which matters
  // more for a compiler A/B than for a shell one -- two shells run the same op
  // stream by construction, and two compilers do not.
  const MODS = {
    nofuse: { fuse: false },
    nolazy: { lazyFlags: false },
    nofusecond: { fuseCond: false },
    nodeadflags: { deadFlags: false },
    nocrossflags: { crossFlags: false },
    nowasmdecode: { wasmDecode: false },
    nocache: { noCache: true },
  };
  const armOpts = (label) => {
    const [shell, ...mods] = label.split('+');
    if (!VARIANTS.includes(shell)) throw new Error(`not a dispatch shell: ${shell}`);
    const o = { variant: shell };
    for (const m of mods) {
      if (!(m in MODS)) {
        throw new Error(`unknown arm switch "${m}"; have ${Object.keys(MODS).join(', ')}`);
      }
      Object.assign(o, MODS[m]);
    }
    return o;
  };
  const variants = arg('variants', VARIANTS.join(',')).split(',').filter(Boolean);
  variants.forEach(armOpts);   // fail on a bad arm before any program runs
  const reps = Number(arg('reps', 5));
  const budget = count(arg('dispatches'), 20e6);
  const cpu = Number(arg('cpu', 386));
  // Most intros open on a title card that blocks in INT 16h/21h. Without this
  // the arms all park at the prompt and the benchmark times the prompt.
  const autoKey = !process.argv.slice(2).includes('--no-auto-key');
  const quiet = () => {};
  // `--cpu-time` measures the guest slice's USER+SYS CPU instead of its wall
  // clock. Same fixed work either way -- the arms retire the same dispatches by
  // construction -- but the wall clock also counts every other process on the
  // box, and this one sits at load 10-40. Measured back to back: the same
  // lazy-vs-eager A/B came back with 39-320% per-arm spread on wall clock, which
  // cannot resolve a few percent no matter how many reps are averaged. Reach for
  // it whenever `load average` in the header is not close to zero.
  const cpuTime = flag('cpu-time');

  // Printed either side of the run for the same reason profile-web-frames.js
  // does it: at load 10+ these numbers describe the box, not the VM.
  console.log(`load average ${require('os').loadavg()[0].toFixed(2)} at start`);
  const rows = [];

  for (const exe of exes) {
    // best[v] is the fastest observed guest-time for that arm; the first rep
    // also records what the program actually produced, for the agreement check.
    const samples = new Map(), seen = new Map();
    let failed = null;

    for (let rep = 0; rep < reps && !failed; rep++) {
      // Rotate which arm goes first. A fixed order lets a cache that warms on
      // the first arm, or a thermal ramp that hits the last, masquerade as a
      // dispatch effect.
      const order = variants.map((_, i) => variants[(i + rep) % variants.length]);
      for (const v of order) {
        let r;
        try {
          r = await runDos({ exe, ...armOpts(v), budget, cpu, log: quiet, autoKey });
        } catch (e) {
          failed = `${v}: ${(e.message || String(e)).split('\n')[0]}`;
          break;
        }
        const sig = `${r.dispatched}/${r.frame}`;
        if (!seen.has(v)) seen.set(v, { sig, r });
        else if (seen.get(v).sig !== sig) failed = `${v} is not deterministic across reps`;
        if (!samples.has(v)) samples.set(v, []);
        samples.get(v).push((cpuTime ? r.guestCpuSecs : r.guestSecs) * 1e9 / r.dispatched);
      }
    }

    const name = path.basename(exe);
    if (failed) { console.log(`\n${name}  SKIPPED -- ${failed}`); continue; }

    const sigs = new Set([...seen.values()].map(s => s.sig));
    const any = [...seen.values()][0].r;
    console.log(`\n${name}  ${(any.dispatched / 1e6).toFixed(1)}M dispatches, `
      + `${any.handbacks} handbacks, ${any.pixels} px lit, frame=${any.frame}`);
    if (sigs.size > 1) {
      console.log('  ARMS DISAGREE -- not comparable:');
      for (const [v, s] of seen) console.log(`    ${v.padEnd(10)} ${s.sig}`);
      continue;
    }

    // Minimum is the headline, but the min-to-median spread is printed beside
    // it because on a loaded box that spread is often wider than the difference
    // between two arms -- and a reader who cannot see it will over-read a 5%.
    const stat = (v) => {
      const s = [...samples.get(v)].sort((a, b) => a - b);
      return { min: s[0], med: s[(s.length - 1) >> 1], max: s[s.length - 1] };
    };
    // The min-of-reps ratio compares two arms' BEST moments, which need not be
    // the same moment. Under load that is the whole problem: whichever arm
    // happened to get a quiet rep wins, and the winner changes run to run.
    //
    // The paired ratio compares each arm against the baseline WITHIN one rep,
    // where they ran seconds apart under the same load, and takes the median of
    // those. It is the number to read when the header's load average is not
    // close to zero -- it cannot remove contention, but it stops contention from
    // landing entirely on one arm.
    const pairedRel = (v) => {
      const a = samples.get(variants[0]), b = samples.get(v);
      const rs = a.map((x, i) => x / b[i]).sort((x, y) => x - y);
      return rs[(rs.length - 1) >> 1];
    };
    const base = stat(variants[0]).min;
    for (const v of variants) {
      const { min, med, max } = stat(v);
      const rel = base / min;
      const prel = pairedRel(v);
      console.log(`  ${v.padEnd(14)} ${min.toFixed(2)} ns/dispatch${cpuTime ? ' cpu' : ''}  `
        + `${(1000 / min).toFixed(1)}M/s  `
        + `${v === variants[0] ? '(baseline)'
          : `${rel >= 1 ? '+' : ''}${((rel - 1) * 100).toFixed(1)}%`
            + ` min / ${prel >= 1 ? '+' : ''}${((prel - 1) * 100).toFixed(1)}% paired`}`
        + `   [med ${med.toFixed(2)} max ${max.toFixed(2)}, spread ${((max / min - 1) * 100).toFixed(0)}%]`);
      rows.push({
        exe: name, variant: v, rel: Number(rel.toFixed(4)), pairedRel: Number(prel.toFixed(4)),
        nsMin: Number(min.toFixed(3)), nsMed: Number(med.toFixed(3)), nsMax: Number(max.toFixed(3)),
      });
    }
  }

  // Geometric mean across programs, because a ratio averaged arithmetically
  // over-weights whichever program happened to be slowest.
  if (rows.length) {
    console.log('\ngeomean across programs (baseline = first variant):');
    for (const v of variants) {
      const mine = rows.filter(r => r.variant === v);
      if (!mine.length) continue;
      const geo = (f) => Math.exp(mine.reduce((a, r) => a + Math.log(f(r)), 0) / mine.length);
      const g = geo(r => r.rel), p = geo(r => r.pairedRel);
      console.log(`  ${v.padEnd(14)} ${g >= 1 ? '+' : ''}${((g - 1) * 100).toFixed(1)}% min`
        + `  /  ${p >= 1 ? '+' : ''}${((p - 1) * 100).toFixed(1)}% paired`
        + `   (beat baseline on ${mine.filter(r => r.rel >= 1).length}/${mine.length} min,`
        + ` ${mine.filter(r => r.pairedRel >= 1).length}/${mine.length} paired)`);
    }
  }

  console.log(`\nload average ${require('os').loadavg()[0].toFixed(2)} at end`
    + `  (reps=${reps}, minimum of ${reps} interleaved runs per arm)`);
  if (flag('json')) console.log(JSON.stringify(rows, null, 2));
}

main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
