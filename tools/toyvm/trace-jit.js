#!/usr/bin/env node

'use strict';

// What is left on the table after the dispatch shells? Three tiers of the same
// hot trace, measured against each other.
//
//   node tools/toyvm/trace-jit.js DEMO.EXE            # find + show the hot trace
//   node tools/toyvm/trace-jit.js DEMO.EXE --bench    # tier 0 vs 1 vs 2
//
//   tier 0  the threaded interpreter, exactly as shipped
//   tier 1  the trace's handler bodies stitched into one wasm function, with
//           operands folded to constants. Removes dispatch, the operand load
//           and the thread-pointer advance -- and nothing else. This is the
//           cheap one: the bodies are the SAME strings emitSwitch already
//           inlines, so there is no new backend.
//   tier 2  three optimization passes over tier 1's output, each needing the
//           whole trace in view: constant propagation of the folded operands,
//           register-file folding ($rget16's br_table -> one global access),
//           and dead flag elimination. This is a REAL optimizer, not a
//           hand-cut ceiling -- but a partial one, so its number is a floor on
//           what an optimizer is worth, not the ceiling. It has no register
//           allocation: guest registers still live in globals rather than in
//           wasm locals across the trace, which is the single biggest thing
//           left on the table.
//
// The gap that matters is 1->2. If it is small, a stitcher is the whole
// project. If it is large, the project is an IR with liveness and register
// allocation, and it is much better to learn that here than after writing the
// stitcher.
//
// Correctness is not optional and not assumed: all three arms run from one
// captured guest state and must land on identical registers AND an identical
// hash of guest RAM before any ratio is printed.

const fs = require('fs');
const path = require('path');
const isa = require('./isa');
const { HANDLERS, EA_ARMS, TAKEN_AT } = require('./emit');
const { runDos } = require('./run-dos');

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

// --- find the hot trace ------------------------------------------------------
// $ip is sampled whenever a slice's budget expires, which is a true arena
// program counter. Map each sample back to the block that contains it.
async function findHotTrace(exe, { budget, slice, cpu, sampleAfter = 0, sampleFrom = 0 }) {
  const r = await runDos({
    exe, budget, slice, cpu, sample: true, sampleAfter, autoKey: true, log: () => {},
  });

  // `sampleFrom` is a fraction of the run this program ACTUALLY did, applied
  // after the fact. sampleFrom=0.5 profiles the second half, which is what it
  // takes to see past a startup depacker in a corpus where programs differ in
  // length by three orders of magnitude.
  let samples = r.ipSamples;
  if (sampleFrom > 0 && r.ipSampleLog.length) {
    const cut = r.dispatched * sampleFrom;
    samples = new Map();
    for (let i = 0; i < r.ipSampleLog.length; i += 2) {
      if (r.ipSampleLog[i] < cut) continue;
      const at = r.ipSampleLog[i + 1];
      samples.set(at, (samples.get(at) || 0) + 1);
    }
    // A program short enough that the tail holds nothing keeps its whole
    // profile rather than reporting no samples at all.
    if (samples.size === 0) samples = r.ipSamples;
  }

  // arena address -> owning block, over every region compiled during the run.
  const heads = [];
  for (const [cs, progs] of r.regions) {
    for (const p of progs) {
      for (const [bip, addr] of p.blocks) heads.push({ cs, bip, addr, prog: p });
    }
  }
  heads.sort((a, b) => a.addr - b.addr);
  // Each block's extent ends where the next one begins. Without that bound the
  // search is a plain lower bound and charges a sample landing in FREED arena
  // space to whichever live block happens to precede it -- which is not a rare
  // corner: a self-modifying program recycles regions constantly, and DHADREN
  // takes 77808 self-modify breaks in 15M dispatches. A misattributed sample is
  // worse than a dropped one, because it produces a plausible hot block.
  const owner = (at) => {
    let lo = 0, hi = heads.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (heads[mid].addr <= at) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0) return null;
    const end = best + 1 < heads.length ? heads[best + 1].addr : Infinity;
    return at < end ? heads[best] : null;
  };

  const perBlock = new Map();
  let total = 0;
  for (const [at, n] of samples) {
    const o = owner(at);
    if (!o) continue;
    const k = `${o.cs.toString(16)}:${o.bip.toString(16)}`;
    if (!perBlock.has(k)) perBlock.set(k, { ...o, samples: 0 });
    perBlock.get(k).samples += n;
    total += n;
  }
  const ranked = [...perBlock.values()].sort((a, b) => b.samples - a.samples);
  // Kept so a decline can say WHICH of the two very different things happened:
  // a program that barely dispatched, or one whose compiled code was thrown
  // away underneath the samples. `heads` is built from the regions that still
  // exist when the run stops, so a self-modifying program can retire millions
  // of dispatches and leave nothing for a sample to land in.
  const why = { samples: [...samples.values()].reduce((a, b) => a + b, 0), heads: heads.length };
  return { r, ranked, total, why };
}

// Walk arena words from a block head into (handler, operands) pairs. Stops at
// the first op that leaves the block, which is what makes it a trace.
function readTrace(mem32, addrWordIdx, maxOps = 512) {
  const ops = [];
  let w = addrWordIdx;
  for (let n = 0; n < maxOps; n++) {
    const fn = mem32[w];
    const h = HANDLERS[fn];
    if (!h) return { ops, end: 'bad-handler' };
    const args = [];
    for (let i = 0; i < h.args; i++) args.push(mem32[w + 1 + i]);
    ops.push({ fn, name: h.name, args, at: w });
    w += 1 + h.args;
    if (/^(end|jmp|jcc|call|ret|int)/.test(h.name)) return { ops, end: h.name, nextWord: w };
  }
  return { ops, end: 'too-long', nextWord: w };
}

// Profile one program, pick its hottest real trace and (optionally) price the
// three tiers on it. Returns structure rather than prose so a corpus sweep can
// call it; `log` is where the prose goes when a human is driving.
//
// Every way this can decline is a named `reason`, never a throw and never a
// silent zero: `no-samples`, `padding`, `unfoldable` (a handler body whose
// operand preamble does not match the shape tier 1 rewrites), `mismatch` (the
// arms disagreed on registers or memory). A declined program is a fact about
// the corpus, and the sweep reports it as one.
async function jitTiers(exe, {
  budget = 15e6, slice = 20000, cpu = 386, top = 6, sampleAfter = 0, sampleFrom = 0,
  bench = false, iters = 20000, reps = 7, cx = 8, log = () => {}, dumpWat = null, opsPrefix = 0,
  minOps: optMinOps, coverage = 0,
  passes = { constprop: true, regfold: true, deadflags: true },
} = {}) {
  log(`profiling ${path.basename(exe)} -- ${(budget / 1e6).toFixed(0)}M dispatches, `
    + `${slice} per sample`
    + (sampleAfter ? `, first ${(sampleAfter / 1e6).toFixed(1)}M not sampled` : '')
    + (sampleFrom ? `, last ${((1 - sampleFrom) * 100).toFixed(0)}% of the run profiled` : '') + '\n');
  const { r: rr, ranked, total, why } = await findHotTrace(exe,
    { budget, slice, cpu, sampleAfter, sampleFrom });
  if (!ranked.length) {
    log(`no samples landed in a known block -- ${why.samples} sample(s) taken over `
      + `${rr.dispatched} dispatches, ${why.heads} compiled block(s) still live at exit`
      + `, ${rr.smcBreaks || 0} self-modify break(s)`);
    if (why.samples && !why.heads) {
      log('  the program ran and its compiled code was thrown away underneath the');
      log('  samples -- self-modifying or overlaid code, not an idle program.');
    }
    return { ok: false, reason: 'no-samples', why };
  }

  log(`${total} samples over ${ranked.length} blocks\n`);
  log('  share  cs:ip        arena      ops  ends with');
  for (const b of ranked.slice(0, top)) {
    const t = readTrace(b.prog.words, (b.addr - b.prog.arenaBase) >> 2);
    log(`  ${(100 * b.samples / total).toFixed(1).padStart(5)}%  `
      + `${b.cs.toString(16)}:${b.bip.toString(16)}`.padEnd(12)
      + `0x${b.addr.toString(16)}`.padEnd(11)
      + `${String(t.ops.length).padStart(4)}  ${t.end}`);
  }

  // A trace compiled out of zeroed memory looks exactly like a hot loop from
  // the arena side: hundreds of ops, sampled constantly. The guest bytes are
  // the only thing that tells them apart, so check them before believing any
  // of this. 0x00 0x00 decodes as `add [bx+si],al`, which is why a run of
  // add_mr8 with IDENTICAL operands is the signature of padding, not code.
  const guestBytes = (r, cs, ip, n) => {
    const lin = ((cs << 4) + ip) & 0xFFFFF;
    return Array.from(r.vm.mem.slice(lin, lin + n));
  };

  // The hottest BLOCK is often one or two ops -- a `jmp` parking loop, a lone
  // `ret`, a two-op poll -- and a two-op trace prices the harness rather than
  // the code. `--min-ops=N` takes the hottest block with at least N ops
  // instead, which is how a LOOP BODY gets benchmarked: the micro-op passes
  // have nothing to work on until there is an address computation and a
  // register stream in view. Falls back to the hottest block rather than
  // refusing, so the padding check still gets its say.
  // Three signatures of a trace compiled out of unwritten memory, because one
  // was not enough. The first version only caught a run of identical
  // (handler, operands) pairs, and cchop.exe walked straight past it with an
  // 11.5x "speedup": its bytes are 13/16 zero, but the zeros decode to
  // `add [bx+si],al` at *advancing* addresses, so the operands differ even
  // though the handler never does. Zero bytes and a run of one handler are
  // each sufficient on their own.
  const inspect = (b) => {
    const t = readTrace(b.prog.words, (b.addr - b.prog.arenaBase) >> 2);
    const bytes = guestBytes(rr, b.cs, b.bip, 16);
    const zeros = bytes.filter(x => x === 0).length;
    const distinctOps = new Set(t.ops.map(o => o.fn)).size;
    const uniform = t.ops.length > 8
      && (new Set(t.ops.map(o => `${o.fn}:${o.args.join()}`)).size <= 2
        // hit the readTrace cap without ever reaching a terminator, and did it
        // with one or two handlers: a straight run, not a loop body.
        || (t.end === 'too-long' && distinctOps <= 2)
        || zeros >= 12);
    // All-zero bytes are NOT on their own enough, and treating them as enough
    // cost two of the core ten. `guestBytes` reads memory as it stands at the
    // END of the profiling run, while the block was compiled from whatever was
    // there when the compiler reached it -- so an overlay that has since been
    // swapped out, or a buffer since cleared, reads back as zeroes under real
    // code. CYCLE's 92.5% block is two ops ending in `ret` and was being
    // discarded on exactly that evidence.
    //
    // What actually distinguishes an unwritten region is that it has no
    // terminator: the decoder runs through it until readTrace's cap. A short
    // block that ends in a real ret/jmp came from real instructions whatever
    // the bytes say now.
    const zeroed = bytes.every(x => x === 0);
    return { t, bytes, uniform, padding: uniform || (zeroed && t.end === 'too-long') };
  };

  // The hottest BLOCK is often one or two ops -- a `jmp` parking loop, a lone
  // `ret`, a two-op poll -- and a two-op trace prices the harness rather than
  // the code. `--min-ops=N` takes the hottest block with at least N ops
  // instead, which is how a LOOP BODY gets benchmarked: the micro-op passes
  // have nothing to work on until there is an address computation and a
  // register stream in view.
  //
  // It MUST skip padding while it does so, and that is not a refinement. An
  // unwritten region decodes into a very long straight run, so "at least N ops"
  // selects FOR padding: raising the floor to 8 turned 10 of 14 programs in a
  // scan into `padding` declines that the default selection would not have hit.
  // Falls back to the hottest block, which then gets the padding verdict
  // printed against it as before.
  //
  // Padding is skipped whether or not a floor was asked for. Declining a whole
  // program because its HOTTEST block is an unwritten region throws away the
  // real code underneath it: RUNDEMO's top block is 26 ops of zeroes and its
  // third is a 5-op loop with 29.9% of the samples, and reporting `padding`
  // for that program said nothing true about it.
  //
  // Both relaxations are announced. A floor that quietly fell back reads in the
  // output exactly like a measurement that met it -- `--min-ops=6` picking a
  // 1-op trace is a different experiment from the one that was asked for.
  // An option first, argv only as the fallback: there is a second caller now
  // (report-core10.js) and reaching into process.argv from inside a library
  // function makes it silently un-configurable from anywhere else.
  const minOps = optMinOps !== undefined ? Number(optMinOps) : Number(arg('min-ops', 0));
  const real = ranked.filter(b => !inspect(b).padding);

  // COVERAGE. Every tier ratio this file prints is a ratio on ONE block, and a
  // ratio on one block is worth `share` of a program -- DRAGON's hottest block
  // runs 7.78x faster and is 2% of its samples, which is 1.02x. So the question
  // that decides whether the tier work can matter at all is not how fast one
  // block gets: it is how much of a program the top N compilable blocks add up
  // to, and how fast that curve saturates. That is a pure profiling question --
  // no module is built, nothing is timed -- so it is answered here, off the
  // ranking that already exists, rather than by compiling N blocks to find out.
  //
  // `compilable` applies the same two filters selection does (not padding, and
  // at least minOps ops), because coverage over blocks the pipeline would
  // decline is not coverage.
  let coverageOut = null;
  let coverageLoops = null;
  if (coverage) {
    const compilable = real.filter(b => inspect(b).t.ops.length >= (minOps || 1));
    const marks = [1, 2, 5, 10, 25, 50, 100].filter(n => n <= Math.max(coverage, 1));
    let cum = 0, i = 0;
    const curve = [];
    for (const n of marks) {
      while (i < n && i < compilable.length) { cum += compilable[i].samples; i++; }
      curve.push({ n, blocks: i, share: 100 * cum / total });
    }
    const allShare = 100 * compilable.reduce((s, b) => s + b.samples, 0) / total;
    log(`\ncoverage -- ${compilable.length} compilable block(s) of ${ranked.length} `
      + `(padding and <${minOps || 1}-op blocks excluded)`);
    for (const c of curve) {
      const bar = '#'.repeat(Math.round(c.share / 2));
      log(`  top ${String(c.n).padStart(3)}  ${c.share.toFixed(1).padStart(5)}%  ${bar}`);
    }
    log(`  ALL     ${allShare.toFixed(1).padStart(5)}%   <- ceiling for any per-block JIT here`);
    // WHERE the coverage lives, by block size, because the tiers do not all
    // want the same thing. Tier 1 stitching pays off per OP -- it removes a
    // dispatch, an operand load and an $ip advance from each -- so it takes a
    // 2-op block happily. Tier 2/3 micro-ops need something to fold: an address
    // computation, a register stream, a segment base used more than once. A
    // program whose samples sit in 1-3 op blocks is reachable by stitching and
    // largely out of reach of micro-ops, and that is a fact about the program,
    // not about the compiler. This histogram is what says which one we have.
    // ...and WHETHER IT IS A LOOP, which is the axis that actually decides what
    // the micro-op passes are worth. Their value is not proportional to block
    // size: it is that a computation done per-op, per-iteration -- the segment
    // base, the effective address, a register round-tripping through the
    // register-file globals -- becomes one that is done once and then carried.
    // A 3-op block executed a million times as a loop body is a better micro-op
    // target than a 12-op block executed once, and a size histogram cannot tell
    // those apart. Classified off the terminator's arena target: `self` branches
    // back to its own head, `back` to an earlier address (a loop back edge that
    // spans blocks), `fwd` forward, and everything else exits.
    // The back edge is NOT necessarily the terminator, and looking only at the
    // terminator gets this badly wrong. This VM compiles *through* a
    // conditional branch: for `dec cx; jnz top` the fall-through (the loop
    // EXIT) is stitched in behind the branch and the block keeps going, so the
    // back edge is a side exit sitting in the MIDDLE of the block while the
    // block terminates on whatever ends the exit path -- a `ret`, a `jmp`, or
    // nothing at all. A terminator-only classifier scored 90% of B-STEEL and
    // 100% of DTM2 as straight-line `exit` for exactly this reason.
    //
    // So scan every op: any branch whose arena target lands at or before this
    // block's own head is a back edge, wherever it sits.
    // Arena address -> owning block, over every region compiled during the run.
    // Built before the classifier because that is what finds a branch target:
    // NAMES cannot. A fused pair is called `cmp_mi16_jnz` and does not start
    // with `j`, and its arena target is not `args[0]` either -- the compare's
    // operands come first. Both facts cost a wrong answer before this line
    // existed: DRAGON's 64.6% loop reported ZERO exits because the only way out
    // of it is a fused `cmp_mi16_jnz`. So the test is structural instead: an
    // operand that is the address of a known block head IS a branch target.
    // Guest ip operands cannot collide with it -- they are 16-bit, the arena
    // sits above 0x1000000.
    const headByAddr = new Map();
    for (const [, progs] of rr.regions) {
      for (const p of progs) for (const [, addr] of p.blocks) headByAddr.set(addr, { addr, prog: p });
    }
    const targetsOf = (t) => {
      const out = new Set();
      for (const op of t.ops) for (const a of op.args) if (headByAddr.has(a)) out.add(a);
      return out;
    };
    // An edge whose target this compile did not emit is written as arena
    // address ZERO, which the branch handlers read as "hand back to the host".
    // That is a real exit and the membership test above cannot see it -- it is
    // how a loop leaves for code that was never hot enough to compile, which is
    // to say it is how most loops leave. `TAKEN_AT` gives the exact operand
    // slot per handler, so this does not have to guess which zero is an edge.
    //
    // `TAKEN_AT` indexes the GUEST ip of the taken edge (that is what
    // loop-match.js matches block ips against); the arena word sits one slot in
    // front of it. A branch's tail is `arenaTaken guestTaken [arenaFall]
    // guestFall`, four words for a plain conditional and three for a traced
    // twin whose fall-through is stitched in behind it -- so the length of the
    // tail says whether there is a second arena slot to check.
    const handbacksOf = (t) => {
      let n = 0;
      for (const op of t.ops) {
        const at = TAKEN_AT.get(op.fn);
        if (at === undefined) continue;
        if (op.args[at - 1] === 0) n++;
        if (op.args.length - (at - 1) === 4 && op.args[at + 1] === 0) n++;
      }
      return n;
    };
    const cls = (b) => {
      const t = inspect(b).t;
      let self = false, back = false;
      for (const to of targetsOf(t)) {
        if (to === b.addr) self = true;
        else if (to < b.addr) back = true;
      }
      return self ? 'self' : back ? 'back' : 'straight';
    };
    const byCls = new Map();
    for (const b of real) {
      const k = cls(b);
      byCls.set(k, (byCls.get(k) || 0) + b.samples);
    }
    log('  share by terminator:');
    for (const k of ['self', 'back', 'straight']) {
      const pct = 100 * (byCls.get(k) || 0) / total;
      if (!pct) continue;
      log(`    ${k.padStart(8)}  ${pct.toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(pct / 2))}`
        + (k === 'self' ? '   <- self loop: micro-ops carry across iterations'
          : k === 'back' ? '   <- has a back edge' : ''));
    }
    // LOOP REGIONS, and what each one would cost to compile as a unit.
    //
    // Entry is not the problem people expect it to be: a region is installed at
    // its HEAD only and every block it covers stays in the arena untouched, so
    // anything jumping into the middle dispatches the ordinary blocks and never
    // sees the compiled version. No entry guard is needed at all.
    //
    // EXITS are the cost, and they scale with the number of edges leaving the
    // region rather than with its size. Each one has to spill promoted
    // registers back to the globals, materialise elided flag records, and set
    // $ip/$gip to where control is going. A counted `dec cx / jnz` loop has one
    // and is nearly free; a loop containing a call has one per call site. So
    // this counts exits, not blocks -- that distribution is what says whether a
    // loop-region compiler is a small build or a large one.
    const succCache = new Map();
    const succOf = (blk) => {
      if (succCache.has(blk.addr)) return succCache.get(blk.addr);
      const t = readTrace(blk.prog.words, (blk.addr - blk.prog.arenaBase) >> 2);
      const out = targetsOf(t);
      // A block ends at jmp/ret/call/int/end. `jmp`'s target is already in the
      // scan above; the rest leave for somewhere this pass cannot name, which
      // is an exit whether or not it is a loop exit.
      const opaque = !/^jmp/.test(t.end);
      const calls = t.ops.filter(o => /^(call|int)/.test(o.name)).length;
      // The extent matters as much as the successors. A traced conditional
      // stitches its fall-through in behind it, so ONE readTrace here covers
      // arena words that the profiler attributes to several block heads --
      // charging the region only the samples landing exactly on its head would
      // credit a 64.6% loop with 0.0% of its own program.
      const end = blk.addr + ((t.nextWord - ((blk.addr - blk.prog.arenaBase) >> 2)) << 2);
      const v = { out, opaque, calls, ops: t.ops.length, end, handbacks: handbacksOf(t) };
      succCache.set(blk.addr, v);
      return v;
    };
    const reachCache = new Map();
    const reach = (from) => {                 // forward reachability, bounded
      if (reachCache.has(from)) return reachCache.get(from);
      const seen = new Set([from]), work = [from];
      while (work.length && seen.size < 64) {
        const a = work.pop();
        const blk = headByAddr.get(a);
        if (!blk) continue;
        for (const s of succOf(blk).out) {
          if (seen.has(s) || !headByAddr.has(s)) continue;
          seen.add(s); work.push(s);
        }
      }
      reachCache.set(from, seen);
      return seen;
    };
    // The natural loop of a back edge: blocks reachable from the head that can
    // also reach the head again. Anything else hanging off the head is code the
    // loop leaves to, not code it runs every iteration.
    // Only the blocks that carry the program: the regions below are quadratic
    // in region size and there is no question a cold loop answers.
    const loops = [];
    for (const b of real.slice(0, 40)) {
      const t = inspect(b).t;
      const edges = [...targetsOf(t)].filter(a => a <= b.addr);
      if (!edges.length) continue;
      const head = Math.min(...edges);
      if (loops.some(l => l.head === head)) continue;
      const fwd = reach(head);
      const region = [...fwd].filter(a => a === head || reach(a).has(head)).sort((x, y) => x - y);
      const set = new Set(region);
      // Every block of a cycle is a back-edge target of some other block in it,
      // so one loop is discovered once per member and lands here as several
      // rows with identical bodies and identical shares. Key on the REGION.
      const sig = region.join(',');
      if (loops.some(l => l.sig === sig)) continue;
      let exits = 0, calls = 0, ops = 0, samples = 0;
      const counted = new Set();
      for (const a of region) {
        const blk = headByAddr.get(a);
        if (!blk) continue;
        const s = succOf(blk);
        ops += s.ops; calls += s.calls; exits += s.handbacks;
        if (s.opaque) exits++;
        for (const to of s.out) if (!set.has(to)) exits++;
        for (const x of ranked) {
          if (x.addr < a || x.addr >= s.end || counted.has(x)) continue;
          counted.add(x); samples += x.samples;
        }
      }
      loops.push({ head, sig, blocks: region.length, exits, calls, ops,
        share: 100 * samples / total,
        // Every op the region can leave through, so a zero-exit row can be
        // checked rather than believed: a loop with no exit at all is either a
        // slice-bounded spin or a bug in the region walk.
        outs: [...new Set(region.flatMap(a => {
          const blk = headByAddr.get(a);
          return blk ? [...succOf(blk).out].filter(x => !set.has(x)) : [];
        }))] });
    }
    loops.sort((a, b) => b.share - a.share);
    if (loops.length) {
      log('  loop regions (installed at the head; mid-loop entries take the');
      log('  ordinary blocks, so no entry guard -- exits are the cost):');
      log('    share  head        blocks  ops  exits  call/int');
      for (const l of loops.slice(0, 8)) {
        log(`    ${l.share.toFixed(1).padStart(5)}%  `
          + `0x${l.head.toString(16).padEnd(9)} ${String(l.blocks).padStart(6)}  `
          + `${String(l.ops).padStart(3)}  ${String(l.exits).padStart(5)}  `
          + `${String(l.calls).padStart(8)}`);
      }
      const t0 = loops[0], b0 = headByAddr.get(t0.head);
      if (b0) {
        const t = readTrace(b0.prog.words, (b0.addr - b0.prog.arenaBase) >> 2);
        log(`    top loop body: ${t.ops.map(o => (TAKEN_AT.has(o.fn)
          ? `${o.name}[${o.args.slice(TAKEN_AT.get(o.fn) - 1)
            .map(a => (a >>> 0).toString(16)).join(',')}]`
          : o.name)).join(' ')}`);
      }
      coverageLoops = loops;
    }

    const buckets = [[1, 1], [2, 3], [4, 7], [8, 15], [16, 1e9]];
    const sized = real.map(b => ({ ops: inspect(b).t.ops.length, samples: b.samples }));
    log('  share by block size:');
    for (const [lo, hi] of buckets) {
      const s = sized.filter(x => x.ops >= lo && x.ops <= hi)
        .reduce((a, x) => a + x.samples, 0);
      const pct = 100 * s / total;
      if (!pct) continue;
      log(`    ${(hi === 1e9 ? `${lo}+` : `${lo}-${hi}`).padStart(5)} ops  `
        + `${pct.toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(pct / 2))}`);
    }
    coverageOut = { compilable: compilable.length, blocks: ranked.length, curve, allShare,
      loops: coverageLoops ? coverageLoops.slice(0, 8) : [] };
  }
  const wanted = minOps ? real.find(b => inspect(b).t.ops.length >= minOps) : real[0];
  const hot = wanted || real[0] || ranked[0];
  if (minOps && !wanted && real[0]) {
    log(`  (no block reaches --min-ops=${minOps}; falling back to the hottest `
      + `real block, ${inspect(real[0]).t.ops.length} ops)`);
  }
  if (hot !== ranked[0] && hot !== undefined) {
    const skipped = ranked.indexOf(hot);
    if (skipped > 0 && inspect(ranked[0]).padding) {
      log(`  (skipped ${skipped} block${skipped > 1 ? 's' : ''} of decoded padding)`);
    }
  }
  const { t, bytes, padding } = inspect(hot);
  const share = 100 * hot.samples / total;
  const trace = {
    cs: hot.cs, ip: hot.bip, ops: t.ops.length, end: t.end,
    share, samples: total,
    bytes: bytes.map(b => b.toString(16).padStart(2, '0')).join(' '),
    coverage: coverageOut,
  };
  // The trace's IDENTITY, for asking whether two programs are really running
  // the same loop. It must not be `bytes`: those are read out of guest memory
  // when profiling ENDS, so for a program that has since overwritten or swapped
  // out that region they come back all zero. Group by them and every such
  // program lands in one bucket -- a 20-program sweep reported eleven programs
  // "sharing" a hot trace whose op counts were 2, 5, 6, 6, 6, 6, 6, 7, 8, 8 and
  // 8, which cannot be one trace. The decoded ops are the trace itself and are
  // in hand at this point, so they answer the question directly.
  trace.sig = t.ops.map(o => `${o.name}(${o.args.map(a => (a >>> 0).toString(16)).join(',')})`)
    .join(';');
  log(`\nhottest trace ${hot.cs.toString(16)}:${hot.bip.toString(16)} `
    + `-- ${t.ops.length} ops, ${share.toFixed(1)}% of samples`);
  log(`  guest bytes: ${trace.bytes}`);
  if (padding) {
    log('  *** this is decoded PADDING, not code -- the compiler walked into an');
    log('  *** unwritten region. Not a JIT benchmark. Pick another program.');
    return { ok: false, reason: 'padding', trace };
  }
  log('');
  for (const [i, op] of t.ops.entries()) {
    log(`  ${String(i).padStart(3)}  ${op.name.padEnd(18)} `
      + op.args.map(a => (a >>> 0).toString(16)).join(' '));
  }
  // What a stitcher can fold away, counted before anything is built.
  trace.flagOps = t.ops.filter(o => /flags_|_flags/.test(HANDLERS[o.fn].body)).length;
  trace.regCalls = t.ops.reduce((n, o) =>
    n + (HANDLERS[o.fn].body.match(/call \$rget|call \$rset/g) || []).length, 0);
  log(`\n  ${t.ops.length} dispatches, ${t.ops.length} operand loads, `
    + `${t.ops.length} $ip advances   <- tier 1 removes these`);
  log(`  ${trace.flagOps} flag computations, ${trace.regCalls} register-file calls`
    + `   <- only tier 2 removes these`);

  if (!bench) return { ok: true, reason: 'profiled', trace };

  // Real guest memory and a real register set, so the string ops address live
  // data rather than zeroes. CX is clamped because a trace ending in rep movsb
  // with an inherited 65535 would make that one op swamp the other seventy --
  // identically in every arm, but it would measure memcpy, not dispatch.
  hot.memSnapshot = rr.vm.mem.slice();
  hot.regSnapshot = {};
  for (const g of STATE) if (rr.vm.exports[`get_${g}`]) hot.regSnapshot[g] = rr.vm.raw(g);
  hot.regSnapshot.cx = cx;
  // The machine the trace ran ON, not just the state it ran with. Without this
  // the generated arms sit at every default: 8086 reserved flag bits, a
  // real-mode address mask, empty descriptor tables. See MACHINE_STATE.
  hot.machineSnapshot = {};
  for (const g of MACHINE_STATE) {
    const get = rr.vm.exports[`mget_${g}`];
    if (get) hot.machineSnapshot[g] = get();
  }

  let bres;
  try {
    // One trim, applied before the arms diverge, so all four run the identical
    // op sequence -- which is the only reason their fingerprints can be
    // compared at all.
    const trimmed = trimExit(t.ops);
    if (trimmed.dropped) {
      log(`  (trace exits by ${trimmed.dropped}, which cannot be made to fall `
        + `through -- benching the ${trimmed.ops.length} ops before it)`);
      trace.exit = trimmed.dropped;
      trace.ops = trimmed.ops.length;
    }
    // `--ops-prefix=N` runs only the first N ops of the trace. A mismatch names
    // a whole trace, which is not a lead; rerunning it at N=1,2,3... turns it
    // into the first op whose arms disagree, which is. It is a debugging knob
    // and not a measurement: a prefix is not the hot loop and its timings mean
    // nothing.
    let ops = trimmed.ops;
    if (opsPrefix && opsPrefix < ops.length) {
      ops = ops.slice(0, opsPrefix);
      log(`  (--ops-prefix=${opsPrefix}: benching a PREFIX, not the trace -- timings are meaningless)`);
    }
    bres = await benchTiers(exe, hot, ops, { iters, reps, log, passes, dumpWat });
  } catch (e) {
    // Two very different failures used to share this label. `unfoldable` is a
    // handler body whose operand preamble drifted from ops()'s shape, which
    // tier 1 refuses to guess at. `trap` is one of the arms actually faulting
    // while running -- a guest address the straight-line arm reaches that the
    // real control flow never would. Reporting the second as the first sent
    // one program's row to the wrong column.
    const fold = /cannot fold operands/.test(e.message || '');
    log(`\ncannot build the tiers: ${e.message}`);
    return { ok: false, reason: fold ? 'unfoldable' : 'trap', detail: e.message, trace };
  }
  if (!bres.agree) return { ok: false, reason: 'mismatch', trace, fingerprints: bres.fingerprints };
  return { ok: true, reason: 'benched', trace, ...bres };
}

async function main() {
  const exe = process.argv[2];
  if (!exe || exe.startsWith('--')) {
    console.log('usage: node tools/toyvm/trace-jit.js <file.exe> [--bench] [--json] [--dispatches=] [--top=]'
      + '\n       [--passes=constprop,regfold,deadflags]  which of tier 2\'s passes to run');
    process.exit(2);
  }
  const json = flag('json');
  const res = await jitTiers(exe, {
    budget: count(arg('dispatches'), 15e6),
    slice: count(arg('slice'), 20000),
    cpu: Number(arg('cpu', 386)),
    top: Number(arg('top', 6)),
    sampleAfter: count(arg('sample-after'), 0),
    sampleFrom: Number(arg('sample-from', 0)),
    bench: flag('bench'),
    iters: count(arg('iters'), 20000),
    reps: Number(arg('reps', 7)),
    dumpWat: arg('dump-wat', null),
    opsPrefix: Number(arg('ops-prefix', 0)),
    coverage: Number(arg('coverage', 0)),
    cx: Number(arg('cx', 8)),
    passes: (() => {
      const spec = arg('passes', 'constprop,regfold,deadflags').split(',').filter(Boolean);
      const known = ['constprop', 'regfold', 'deadflags'];
      for (const p of spec) {
        if (!known.includes(p)) { console.error(`unknown pass ${p}; known: ${known.join(', ')}`); process.exit(2); }
      }
      // regfold cannot run without constprop -- see emitTier2.
      const on = Object.fromEntries(known.map(k => [k, spec.includes(k)]));
      if (on.regfold) on.constprop = true;
      return on;
    })(),
    log: json ? () => {} : console.log,
  });
  if (json) console.log(JSON.stringify({ exe, ...res }));
}

// --- tier 1: stitch the bodies ----------------------------------------------
// The operand preamble every handler carries is generated by ops(n) in emit.js
// and therefore has an exact, uniform shape. Folding it is a text substitution,
// which is the whole reason tier 1 is cheap: no per-handler work, no new
// backend, the same body strings emitSwitch already inlines.
// A handler does NOT necessarily have one flat preamble. A FUSED handler is two
// bodies concatenated -- `cmp_rm8_jz` is `cmp_rm8` then `jz` -- and each half
// carries its own ops(n): the second half loads `$t0` from `offset=0` again,
// correctly, because the first half already advanced `$ip` past its own
// operands. `$t` names restart too.
//
// Assuming one flat preamble therefore refused every fused handler in the
// corpus, which is the hottest shape there is: `cmp_rm8_jz` following itself is
// 57.7% of RUNDEMO's dispatches. It cost DTM2 and ACCIDENT their whole
// measurement, reported as `unfoldable`.
//
// So walk the body in order, carrying the cumulative advance the way the
// interpreter does: an operand load at `offset=D` after N words of advance is
// argument `N + D/4`, whichever half it is in. The single-segment case is the
// same walk with one segment. Advances are dropped -- a trace has no next op to
// find -- and control-flow writes to `$ip` (`(global.set $ip (local.get $t1))`,
// how a branch is taken) do not match the advance shape and are left alone.
const IP_USE = new RegExp(
  '\\(local\\.set \\$t(\\d+) \\(i32\\.load offset=(\\d+) \\(global\\.get \\$ip\\)\\)\\)'
  + '|\\(global\\.set \\$ip \\(i32\\.add \\(global\\.get \\$ip\\) \\(i32\\.const (\\d+)\\)\\)\\)', 'g');

function foldOperands(body, args) {
  let out = '', last = 0, base = 0, folded = 0, m;
  IP_USE.lastIndex = 0;
  while ((m = IP_USE.exec(body)) !== null) {
    out += body.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[3] !== undefined) { base += Number(m[3]) / 4; continue; }
    const idx = base + Number(m[2]) / 4;
    // Out of range means the walk has lost track of where $ip is, not that the
    // program is odd. Refuse rather than bake a neighbouring op's operand in.
    if (!Number.isInteger(idx) || idx < 0 || idx >= args.length) return null;
    out += `(local.set $t${m[1]} (i32.const ${args[idx] | 0}))`;
    folded++;
  }
  if (args.length && !folded) return null;         // shape drifted -- refuse rather than guess
  return out + body.slice(last);
}

// Straight-line by construction: see the note in benchTiers about why every
// branch in this trace is made to fall through in ALL tiers.
function emitTier1(ops, { helpers, LOCALS, memPages }) {
  const bodies = [];
  for (const op of ops) {
    const b = foldOperands(HANDLERS[op.fn].body, op.args);
    if (b === null) throw new Error(`cannot fold operands for ${op.name}`);
    bodies.push(`;; ${op.name}\n${b}`);
  }
  return { wat: bodies.join('\n'), folded: ops.length };
}

// --- tier 2: optimize what tier 1 stitched ----------------------------------
// Two passes, both of which need the whole trace in view and neither of which a
// stitcher can do:
//
//   register-file folding -- $rget16/$rset16 are a br_table over 8 globals
//     (03-registers.wat's shape, and lever 5 in the perf summary). Once the
//     operand is a constant the index is too, so the br_table becomes one
//     global access.
//   dead flag elimination -- flags here are EAGER: $flags_sub writes the whole
//     word and jz reads bit 6 back out. A flag word that the next flag-writing
//     op overwrites before anything reads it is pure waste.
//
// Both are verified by running tier 1 and tier 2 from identical state and
// comparing every register plus a memory hash. An optimization that changes
// the answer is not an optimization.

// Find `(call $name ...)` spans with balanced parens, so an argument that is
// itself a nested call is extracted whole rather than truncated at the first ')'.
function findCalls(src, name) {
  const out = [];
  const needle = `(call $${name} `;
  let i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) {
    let depth = 0, j = i;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')' && --depth === 0) { j++; break; }
    }
    const whole = src.slice(i, j);
    // split the argument list at depth 1
    const inner = whole.slice(needle.length, -1);
    const args = [];
    let d = 0, start = 0;
    for (let k = 0; k < inner.length; k++) {
      if (inner[k] === '(') { if (d++ === 0) start = k; }
      else if (inner[k] === ')' && --d === 0) args.push(inner.slice(start, k + 1));
    }
    out.push({ start: i, end: j, whole, args });
    i = j;
  }
  return out;
}

const CONST = /^\(i32\.const (-?\d+)\)$/;

// Folding the operand LOAD is not the same as folding the operand. Bodies read
// it back as `(local.get $t0)`, so without this the register index stays opaque
// and $rget16 keeps its br_table. Propagation stops at the first reassignment
// of that local -- handlers reuse $t1..$t7 as scratch.
function propagateConsts(body, nargs) {
  let out = body, n = 0;
  for (let i = 0; i < nargs; i++) {
    const set = new RegExp(`\\(local\\.set \\$t${i} \\(i32\\.const (-?\\d+)\\)\\)`);
    const m = set.exec(out);
    if (!m) continue;
    const k = m[1];
    const after = m.index + m[0].length;
    const reassign = out.indexOf(`(local.set $t${i} `, after);
    const end = reassign === -1 ? out.length : reassign;
    const head = out.slice(0, after);
    const mid = out.slice(after, end).split(`(local.get $t${i})`);
    n += mid.length - 1;
    out = head + mid.join(`(i32.const ${k})`) + out.slice(end);
  }
  return { out, n };
}

function foldRegisterFile(body) {
  let out = body, changed = 0;
  for (const kind of ['rget16', 'rget8', 'rset16']) {
    for (;;) {
      const hit = findCalls(out, kind).find(c => CONST.test(c.args[0].trim()));
      if (!hit) break;
      const idx = Number(CONST.exec(hit.args[0].trim())[1]);
      let repl;
      if (kind === 'rget16') {
        repl = `(i32.and (global.get $${isa.REG16[idx]}) (i32.const 0xFFFF))`;
      } else if (kind === 'rget8') {
        // 0-3 are the low bytes AL/CL/DL/BL, 4-7 the high bytes AH/CH/DH/BH.
        repl = idx < 4
          ? `(i32.and (global.get $${isa.REG16[idx]}) (i32.const 0xFF))`
          : `(i32.and (i32.shr_u (global.get $${isa.REG16[idx - 4]}) (i32.const 8)) (i32.const 0xFF))`;
      } else {
        const r = isa.REG16[idx];
        // 16-bit writes leave the upper half of the 32-bit register alone.
        repl = `(global.set $${r} (i32.or (i32.and (global.get $${r}) (i32.const 0xFFFF0000))`
          + ` (i32.and ${hit.args[1]} (i32.const 0xFFFF))))`;
      }
      out = out.slice(0, hit.start) + repl + out.slice(hit.end);
      changed++;
    }
  }
  return { out, changed };
}

// --- micro-ops: the level below the x86-shaped op ---------------------------
//
// A threaded word is one x86-ish operation. That shape is convenient for the
// decoder and wrong for an optimizer: it hides an addressing-mode br_table, a
// register-file br_table and a flag word inside a handler body, and an
// optimizer cannot see through any of them. Lowering to micro-ops that DO NOT
// match x86 -- an address is an add, a register is a value, a flag write is a
// statement that may not be needed -- is what makes those visible.
//
// These two passes are the first two lowerings, and they compose in one
// direction only: $ea's arms are what read $bx/$si/$bp/$di raw, so a register
// cannot be promoted to a local until the address computation stops going
// through the br_table that reads it behind the optimizer's back.

// `(call $ea (i32.const K) D)` -> arm K's expression, with $d substituted.
// Declines arm 9 (32-bit addressing), which is a call to $ea32 rather than an
// expression, and declines a non-constant index rather than guessing: a wrong
// addressing form is not a slow fold, it is a store to the wrong address.
// $ea32's body, with the packed operand known. Mirrors the helper in emit.js
// field for field; the field layout itself comes from isa.EA_A32 rather than
// being restated, so a change to the encoding cannot leave this behind.
function ea32Expr(i, disp) {
  const A = isa.EA_A32;
  let a = disp;
  if (!(i & A.NO_BASE)) {
    a = `(i32.add ${a} (global.get $${isa.REG16[(i >>> A.BASE_SHIFT) & 7]}))`;
  }
  if (!(i & A.NO_INDEX)) {
    const scale = (i >>> A.SCALE_SHIFT) & 3;
    const idx = `(global.get $${isa.REG16[(i >>> A.INDEX_SHIFT) & 7]})`;
    a = `(i32.add ${a} ${scale ? `(i32.shl ${idx} (i32.const ${scale}))` : idx})`;
  }
  return a;
}

// The register-file calls tier 2's fold does not cover. Kept separate from
// foldRegisterFile so tier 2's published numbers keep meaning what they meant:
// these only become reachable once $ea has stopped hiding the 32-bit accesses
// behind it, so they belong to the micro-op tier and not to tier 2.
function foldRegisterFileWide(body) {
  let out = body, changed = 0;
  for (const kind of ['rget32', 'rset32', 'rset8']) {
    for (;;) {
      const hit = findCalls(out, kind).find(c => CONST.test(c.args[0].trim()));
      if (!hit) break;
      const idx = Number(CONST.exec(hit.args[0].trim())[1]);
      let repl;
      if (kind === 'rget32') repl = `(global.get $${isa.REG16[idx]})`;
      else if (kind === 'rset32') repl = `(global.set $${isa.REG16[idx]} ${hit.args[1]})`;
      else {
        // 8-bit writes leave the rest of the register alone, and 4-7 are the
        // high bytes AH/CH/DH/BH rather than four more registers.
        const r = isa.REG16[idx < 4 ? idx : idx - 4];
        repl = idx < 4
          ? `(global.set $${r} (i32.or (i32.and (global.get $${r}) (i32.const 0xFFFFFF00))`
            + ` (i32.and ${hit.args[1]} (i32.const 0xFF))))`
          : `(global.set $${r} (i32.or (i32.and (global.get $${r}) (i32.const 0xFFFF00FF))`
            + ` (i32.shl (i32.and ${hit.args[1]} (i32.const 0xFF)) (i32.const 8))))`;
      }
      out = out.slice(0, hit.start) + repl + out.slice(hit.end);
      changed++;
    }
  }
  return { out, changed };
}

function foldEa(body) {
  let out = body, changed = 0, a32 = 0, dynamic = 0;
  // Left to right, keeping a cursor past what has already been handled: a call
  // this pass declines must not stop the ones after it in the same body, and a
  // 32-bit addressing form sitting in front of three foldable 16-bit ones is
  // the common case in a 386 demo.
  for (let from = 0; ;) {
    const hit = findCalls(out, 'ea').find(c => c.start >= from);
    if (!hit) break;
    const lit = CONST.exec(hit.args[0].trim());
    if (!lit) { dynamic++; from = hit.end; continue; }
    const packed = Number(lit[1]);
    const arm = EA_ARMS[packed & 15];
    if (arm === undefined) { dynamic++; from = hit.end; continue; }
    let repl;
    if (/\$ea32/.test(arm)) {
      // 386 addressing is foldable too, and in this corpus it is the case that
      // matters: BRW's 17 address computations are ALL this form. The arm is a
      // call rather than an expression only because base/index/scale do not fit
      // in a br_table -- but they are packed into the same constant operand, so
      // with the operand known the whole thing is base + index*scale + disp
      // with the registers named. Unlike the 16-bit arms it is deliberately not
      // wrapped to 64K, which is the entire point of the encoding.
      repl = ea32Expr(packed, hit.args[1]);
      a32++;
    } else {
      // The arms are written as statements for the br_table (`(return X)`);
      // here the call sits in expression position, so the wrapper comes off.
      const expr = arm.trim().replace(/^\(return\s+/, '').replace(/\)$/, '');
      repl = expr.split('(local.get $d)').join(hit.args[1]);
    }
    out = out.slice(0, hit.start) + repl + out.slice(hit.end);
    changed++;
    from = hit.start + repl.length;
  }
  return { out, changed, a32, dynamic };
}

// Constant arithmetic, evaluated.
//
// Propagating an operand is not the same as folding it. A handler that pulls
// its segment index out of a packed word emits
// `(i32.and (i32.shr_u (i32.const 3299129) (i32.const 4)) (i32.const 7))` once
// the operand is known -- entirely constant, and still an expression. Every
// later pass here asks "is this argument a literal", so an unevaluated constant
// reads as dynamic and declines the fold: BRW's 17 memory accesses all had a
// known segment and all 17 were reported as having a dynamic one.
//
// V8 folds these itself, so this buys no instructions directly. It exists to
// make the constants VISIBLE to the passes below, which is where the win is.
//
// i32 semantics exactly: wrap to 32 bits, shift counts mod 32, and the two
// shift-rights are different operators. Printed unsigned, which is the form the
// rest of the emitted text uses.
const CONST_OPS = {
  add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => Math.imul(a, b),
  and: (a, b) => a & b, or: (a, b) => a | b, xor: (a, b) => a ^ b,
  shl: (a, b) => a << (b & 31),
  shr_u: (a, b) => a >>> (b & 31),
  shr_s: (a, b) => a >> (b & 31),
};
const CONST_PAIR = new RegExp(
  '\\(i32\\.(' + Object.keys(CONST_OPS).join('|') + ') '
  + '\\(i32\\.const (0x[0-9a-fA-F]+|-?\\d+)\\) \\(i32\\.const (0x[0-9a-fA-F]+|-?\\d+)\\)\\)');

function foldConstArith(body) {
  let out = body, changed = 0;
  // Innermost-first falls out of repeated replacement: a pair whose arguments
  // are still expressions does not match, and collapsing the inside makes the
  // outside match on the next round.
  for (;;) {
    const m = CONST_PAIR.exec(out);
    if (!m) break;
    const v = CONST_OPS[m[1]](Number(m[2]) | 0, Number(m[3]) | 0) >>> 0;
    out = out.slice(0, m.index) + `(i32.const ${v})` + out.slice(m.index + m[0].length);
    changed++;
  }
  return { out, changed };
}

// A body-local temporary that is only ever a constant, propagated to its uses.
//
// Evaluating the arithmetic is not enough on its own: a handler unpacks its
// segment index into a scratch local and then passes `(local.get $t5)` to
// $rd32, so the constant is in the ASSIGNMENT and every pass below looks at the
// argument. This closes that gap.
//
// Two conditions, both required, and both cheap to check because a body is one
// op's worth of statements:
//   * exactly one `(local.set $tN ...)` in the body -- so there is no second
//     definition a use could be seeing instead, on any path;
//   * that set is at paren depth 0 -- a top-level statement, not the inside of
//     an `if` arm, so it is not conditional on anything.
// Uses BEFORE the set are left alone: those read the local's zero-initialized
// value, and substituting the constant there would invent a definition.
function propagateLocalConsts(body) {
  let out = body, changed = 0;
  for (const name of new Set([...body.matchAll(/\(local\.set (\$t\d+) /g)].map(m => m[1]))) {
    const setNeedle = `(local.set ${name} `;
    if (out.indexOf(setNeedle) !== out.lastIndexOf(setNeedle)) continue;
    const at = out.indexOf(setNeedle);
    let depth = 0;
    for (let i = 0; i < at; i++) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')') depth--;
    }
    if (depth !== 0) continue;
    const lit = /^\(i32\.const (0x[0-9a-fA-F]+|-?\d+)\)\)/.exec(out.slice(at + setNeedle.length));
    if (!lit) continue;
    const head = out.slice(0, at);
    const tail = out.slice(at);
    const uses = tail.split(`(local.get ${name})`).length - 1;
    if (!uses) continue;
    out = head + tail.split(`(local.get ${name})`).join(`(i32.const ${lit[1]})`);
    changed += uses;
  }
  return { out, changed };
}

// The segment index out of the memory accessors.
//
// A handler asks for memory as `(call $rd16 (i32.const 3) off)` -- segment by
// INDEX -- and $rd16 resolves it through $sbase's br_table on the way in. That
// resolution happens inside a helper, so a constant index buys nothing on its
// own: the base never becomes an expression anything outside $rd16 can see.
//
// emit.js therefore emits a base-taking twin of all six accessors from the same
// source (memAccessors()), and this pass swaps to it. Two things come out of
// that. The br_table and its call go, per access. And the segment base becomes
// an ordinary `(global.get $dsb)` in the body -- which is what lets the register
// promoter hoist it out of the loop, since nothing short of a segment load can
// change it and a segment load already declines the whole promotion.
function foldSeg(body) {
  let out = body, changed = 0, dynamic = 0;
  for (const kind of ['rd8', 'rd16', 'rd32', 'wr8', 'wr16', 'wr32']) {
    for (let from = 0; ;) {
      const hit = findCalls(out, kind).find(c => c.start >= from);
      if (!hit) break;
      const lit = CONST.exec(hit.args[0].trim());
      const seg = lit ? isa.SEG[Number(lit[1])] : null;
      if (!seg) { dynamic++; from = hit.end; continue; }
      const repl = `(call $${kind}b (global.get $${seg}b) ${hit.args.slice(1).join(' ')})`;
      out = out.slice(0, hit.start) + repl + out.slice(hit.end);
      changed++;
      // Rescan from the SAME offset, not past the replacement: a store whose
      // value is itself a load nests one accessor inside another, and the outer
      // rewrite has just made the outer call stop matching the needle. Skipping
      // past it would leave the inner one on the br_table path.
      from = hit.start;
    }
  }
  return { out, changed, dynamic };
}

// Guest registers into wasm locals. Every access has to be visible first: one
// surviving $rget/$rset/$ea/$push/$pop/$cx16 reaches the globals behind this
// pass's back, and a promoted register would then be read stale. So the pass
// FAILS CLOSED on any of them -- an unpromoted loop is slow, a half-promoted
// one computes something else.
// An ALLOW-list, not a deny-list, and for a reason this project has already
// paid for once: a deny-list spelled `$out` does not match `$port_out`, and the
// spin census scored a VGA palette write as a loop over nothing until it was
// inverted. The same trap is worse here. A helper that touches SI or DI behind
// this pass's back does not make the loop slow, it makes it wrong -- and the
// string ops are exactly that shape, which is what BRW's `lodsb32 ... stosb32`
// body is made of. So: a call is safe only if it is named here as touching no
// general register, and anything unrecognised declines the whole promotion.
const REG_SAFE = new RegExp('^(' + [
  'rd(8|16|32)b?', 'wr(8|16|32)b?',      // memory, addressed by a value we pass in
  'lin', 'sget', 'sbase', 'segbase', 'segd32',  // segmentation: segment globals only
  // The flag record. rec_* takes its inputs as parameters and writes only
  // $fa/$fb/$fu/$fw/$fr/$fcf/$fop, which are not general registers.
  'flags_\\w+', 'rec_\\w+', 'get_\\w+', 'cond\\w*',
  'sh_\\w+', 'off_add', 'pow2',          // pure arithmetic kernels
  'slice_exit', 'jlook',                 // ip/halt only
  'port_in', 'port_out',                 // leave to the host, take no register
].join('|') + ')$');

function promoteRegs(bodies, regs) {
  const joined = bodies.join('\n');
  for (const m of joined.matchAll(/\(call \$([a-z0-9_]+)/gi)) {
    if (!REG_SAFE.test(m[1])) return { declined: `$${m[1]} may touch a register` };
  }
  const used = regs.filter(r => joined.includes(`$${r}`));
  if (!used.length) return { declined: 'no register in the body' };
  const rw = (s) => {
    let out = s;
    for (const r of used) {
      out = out.split(`(global.get $${r})`).join(`(local.get $L${r})`);
      out = out.split(`(global.set $${r} `).join(`(local.set $L${r} `);
    }
    return out;
  };
  return {
    used,
    bodies: bodies.map(rw),
    locals: used.map(r => `(local $L${r} i32)`).join(' '),
    // Loaded once before the loop and stored once after it, so the cost is paid
    // per ENTRY rather than per iteration -- which is the whole reason a loop is
    // a better subject for this than a straight-line trace.
    pro: used.map(r => `(local.set $L${r} (global.get $${r}))`).join('\n'),
    epi: used.map(r => `(global.set $${r} (local.get $L${r}))`).join('\n'),
  };
}

const WRITES_FLAGS = /\(call \$(flags_\w+|sh_\w+)\b/;
const READS_FLAGS = /\(global\.get \$flags\)/;

function killDeadFlags(ops) {
  // Walk backwards: a flag write is dead if nothing reads flags between it and
  // the next flag write. Only whole `(call $flags_*)` statements are removed --
  // the shift helpers compute a value as well as flags and cannot be dropped.
  const live = new Array(ops.length).fill(true);
  let readerSeen = false;
  for (let i = ops.length - 1; i >= 0; i--) {
    const body = HANDLERS[ops[i].fn].body;
    if (READS_FLAGS.test(body)) { readerSeen = true; continue; }
    if (WRITES_FLAGS.test(body)) {
      if (!readerSeen && /\(call \$flags_/.test(body)) live[i] = false;
      readerSeen = false;
    }
  }
  return live;
}

// `passes` selects which of tier 2's three optimizations actually run, so each
// can be priced on its own against tier 1. `regfold` implies `constprop`: the
// register-file br_table only folds once the index it is given is a constant,
// which is what const propagation makes it.
//
// This exists because the interpreter can have ONE of these passes without
// being a trace JIT at all. A handler whose register index is pinned to a
// constant is just another entry in the handler table, swapped in by the
// compiler the way a fused or traced twin is -- so `--passes=regfold` is the
// ceiling for that idea, measured on real traces instead of guessed at.
function emitTier2(ops, passes = { constprop: true, regfold: true, deadflags: true }) {
  const live = passes.deadflags ? killDeadFlags(ops) : ops.map(() => true);
  const bodies = [];
  let killed = 0, folded = 0, propagated = 0;
  for (const [i, op] of ops.entries()) {
    let b = foldOperands(HANDLERS[op.fn].body, op.args);
    if (b === null) throw new Error(`cannot fold operands for ${op.name}`);
    if (!live[i]) {
      for (const c of findCalls(b, 'flags_add').concat(
        findCalls(b, 'flags_sub'), findCalls(b, 'flags_inc'),
        findCalls(b, 'flags_dec'), findCalls(b, 'flags_logic'))) {
        b = b.replace(c.whole, '');
        killed++;
      }
    }
    if (passes.constprop || passes.regfold) {
      const p = propagateConsts(b, op.args.length);
      b = p.out; propagated += p.n;
    }
    if (passes.regfold) {
      const r = foldRegisterFile(b);
      b = r.out; folded += r.changed;
    }
    bodies.push(`;; ${op.name}${live[i] ? '' : '  [flags dead]'}\n${b}`);
  }
  return { wat: bodies.join('\n'), bodies, killed, folded, propagated };
}

// Tier 3: the same trace lowered past its x86 shape. Two more passes, in the
// only order they compose in -- fold the addressing-mode br_table, which makes
// every register access visible, then move the registers into wasm locals for
// the length of the loop.
function emitTier3(ops, passes) {
  const t2 = emitTier2(ops, passes);
  let eaFolded = 0, eaA32 = 0, eaDynamic = 0, segFolded = 0, segDynamic = 0, arith = 0;
  let bodies = t2.bodies.map((b) => {
    const r = foldEa(b);
    eaFolded += r.changed; eaA32 += r.a32; eaDynamic += r.dynamic;
    // Before foldSeg, not after: a segment index that is still an unevaluated
    // constant expression is indistinguishable from a dynamic one, and that is
    // exactly what declined all of BRW's accesses.
    const c = foldConstArith(r.out);
    arith += c.changed;
    const l = propagateLocalConsts(c.out);
    arith += l.changed;
    const s = foldSeg(l.out);
    segFolded += s.changed; segDynamic += s.dynamic;
    return s.out;
  });
  // Register-file calls that only became foldable once $ea stopped hiding them.
  let folded = t2.folded;
  bodies = bodies.map((b) => {
    const r = foldRegisterFile(b); folded += r.changed;
    const w = foldRegisterFileWide(r.out); folded += w.changed;
    // Again after the register-file folds, which unpack their own index the
    // same packed-word way and leave the same shape behind.
    const c = foldConstArith(w.out); arith += c.changed;
    return c.out;
  });
  // Segment bases join the registers as promotion candidates. They are
  // loop-INVARIANT rather than merely register-like: only a segment load writes
  // one, and $sset is not on the allow-list, so a body that could change a base
  // has already declined. Hoisting them is what makes a promoted address
  // computation entirely locals.
  const p = promoteRegs(bodies, isa.REG16.concat(isa.SEG.map(s => `${s}b`)));
  return {
    ...t2, eaFolded, eaA32, eaDynamic, segFolded, segDynamic, arith, folded,
    promoted: p.declined ? null : p.used,
    declined: p.declined || null,
    wat: (p.declined ? bodies : p.bodies).join('\n'),
    locals: p.declined ? '' : p.locals,
    pro: p.declined ? '' : p.pro,
    epi: p.declined ? '' : p.epi,
  };
}

// --- the three arms ---------------------------------------------------------
// Every arm executes the SAME 71 ops with the SAME operands, straight through.
// The trace's conditional branches are made to fall through in all three: in
// tier 0 by pointing each branch's taken-target at its own fall-through word,
// in tiers 1 and 2 by stitching bodies in order (a jcc body then just computes
// its condition and writes $ip/$gip, which nothing reads).
//
// So this prices dispatch and code quality over a real op mix, and it does NOT
// price side exits. That is the honest limit of the measurement: a trace JIT
// also has to pay for leaving the trace, and this says nothing about it.
const { helpers, LOCALS, STATE, EXTRA_GLOBALS, MACHINE_STATE, machineAccessors,
  stateAccessors } = require('./emit');

function moduleWat(body, extra = {}) {
  const { locals = '', pro = '', epi = '' } = extra;
  const globals = STATE.map(g => `(global $${g} (mut i32) (i32.const 0))`).join('\n');
  // Shared with the interpreter's own preamble. Writing a second, simpler set
  // here is what made every segmented access in a compiled trace read from
  // linear address `0 + off`; see the note on stateAccessors() in emit.js.
  const accessors = stateAccessors();
  return `(module
(import "host" "memory" (memory ${isa.MEM_PAGES} ${isa.MEM_PAGES}))
(import "host" "port_in" (func $port_in (param i32) (param i32) (result i32)))
(import "host" "port_out" (func $port_out (param i32) (param i32) (param i32)))
(import "host" "fmath" (func $fmath (param i32) (param f64) (param f64) (result f64)))
${globals}
${EXTRA_GLOBALS}
(type $void (func))
${accessors}
${machineAccessors()}
${helpers()}
(func (export "spin") (param $k i32) ${LOCALS} ${locals}
${pro}
  (block $done (loop $l
    (br_if $done (i32.eqz (local.get $k)))
${body}
    (local.set $k (i32.sub (local.get $k) (i32.const 1)))
    (br $l)))
${epi})
)`;
}

// Guest RAM only -- the first megabyte. Hashing the whole linear memory would
// include the thread arena, and tier 0 has a compiled program there that the
// generated arms have no reason to contain.
// Every byte, not every 97th. The sampled version was cheap and wrong in the
// one situation the fingerprint exists for: B-STEEL's arms disagreed about a
// byte at 0x1180, which 97 does not land on, so the table reported identical
// memory beside a register that had just been loaded from it -- and the whole
// investigation went looking for a bug in the addressing instead.
function memHash(mem) {
  let h = 0x811c9dc5;
  for (let i = 0; i < 0x100000; i++) h = Math.imul(h ^ mem[i], 0x01000193);
  return (h >>> 0).toString(16);
}

// A differing hash says only "somewhere". This says where, which for a trace of
// half a dozen ops is usually the whole answer.
function firstMemDiff(a, b) {
  for (let i = 0; i < 0x100000; i++) if (a[i] !== b[i]) return i;
  return -1;
}

// Lay the trace down as a straight-line arena program: every branch's taken
// target is repointed at its own fall-through, and the trailing jmp closes the
// loop. This is the tier-0 arm and it is what the other two are generated from,
// so all three run one identical op sequence.
// The trace's last op, when it leaves the trace by a route that cannot be made
// to fall through.
//
// A Jcc is repointed at its own fall-through and a bare `jmp` becomes an `end`,
// so both stay. A `ret`, a `call_far`, a `jmp_m16` cannot: tier 0 FOLLOWS them
// and goes on executing other blocks, while tiers 1-3 have nothing to follow
// and simply re-run the body. The two arms are then running different code and
// the comparison is meaningless -- which is exactly what it reported, as five
// of the core ten `mismatch`ing with tier 0's SP 20000 pops away from the rest.
//
// So drop it, in every arm at once, and say so. What is priced is the trace
// BODY, which is what this page has always claimed to price: "this does not
// price side exits" was already true of the branches that stayed.
const CANNOT_FALL_THROUGH = /^(ret|call|int|iret|hlt|jmp_far|jmp_m)/;

function trimExit(ops) {
  if (ops.length < 2) return { ops, dropped: null };
  const name = HANDLERS[ops[ops.length - 1].fn].name;
  if (!CANNOT_FALL_THROUGH.test(name)) return { ops, dropped: null };
  return { ops: ops.slice(0, -1), dropped: name };
}

function straightLineProgram(ops, base) {
  const words = [];
  const starts = [];
  for (const op of ops) { starts.push(words.length); words.push(op.fn, ...op.args); }
  // Lay the terminator down BEFORE repointing anything, so a branch that is
  // itself the last op has somewhere to fall through TO. Sending it to `base`
  // instead -- which is what "the next op, or offset 0" did -- turns the arena
  // into a self-loop that runs until the step budget is gone, and tier 0 then
  // does thousands of times the work of the other arms. It read as an 18.5x
  // speedup on daretro, which is how it was caught.
  const endFn = HANDLERS.findIndex(x => x.name === 'end');
  const endAt = words.length;
  words.push(endFn, 0);
  ops.forEach((op, i) => {
    const w = starts[i];
    const h = HANDLERS[op.fn];
    const nextArena = base + (starts[i + 1] === undefined ? endAt : starts[i + 1]) * 4;
    const nextGuest = 0;
    if (h.name === 'jmp') {
      // Terminate rather than loop. Budgeting the interpreter by dispatch count
      // cannot express "k iterations": any op costing more than one dispatch
      // (a rep prefix, a bail) cuts the last iteration short, and a partial
      // iteration is a different computation. Ending the trace makes one run()
      // exactly one iteration, and every arm is then driven one iteration per
      // call so they all pay the same host-call overhead.
      //
      // This has to be tested BEFORE TAKEN_AT: a bare `jmp` has an entry there
      // too (it is a spin candidate), and letting that win reintroduces exactly
      // the self-loop described above.
      words[w] = endFn;
      words[w + 1] = 0;
      words.length = w + 2;
      return;
    }
    // Which operand holds the taken edge is emit.js's own bookkeeping, and it
    // publishes it: TAKEN_AT covers a plain Jcc, a FUSED one (`cmp_rm8_jz`,
    // whose taken edge sits after the ALU's operands), the traced twins and the
    // spin twins, in one map that cannot drift from the handler table.
    //
    // Matching on `args === 4` and a list of Jcc names instead missed every one
    // of those twins -- `cmp_rm8_jz_t` has five operands and a name no entry in
    // the list is a prefix of -- so tier 0 took the branch out of the trace
    // while the other arms fell through it. That is DTM2's whole mismatch, on
    // the single op its hot trace consists of.
    const takenAt = TAKEN_AT.get(op.fn);
    if (takenAt !== undefined) {
      words[w + takenAt] = nextArena; words[w + takenAt + 1] = nextGuest;
      // A plain (untraced) branch also carries its not-taken edge explicitly;
      // a traced twin does not, because the fall-through is the next word.
      if (h.args >= takenAt + 3) { words[w + takenAt + 2] = nextArena; words[w + takenAt + 3] = nextGuest; }
    }
  });
  return words;
}

async function benchTiers(exe, hot, ops, { iters, reps, log = console.log, dumpWat = null,
  passes = { constprop: true, regfold: true, deadflags: true } }) {
  const opts = { dumpWat };
  const { makeVm } = require('./vm');
  const { compileWat } = require(path.join(__dirname, '..', '..', 'lib', 'compile-wat.js'));

  const t1 = emitTier1(ops, {});
  const t2 = emitTier2(ops, passes);
  const t3 = emitTier3(ops, passes);
  // Every decline this file reports is a fact about ONE expression -- a segment
  // index that stayed dynamic, a call that is not on the allow-list -- and the
  // count alone never says which. Writing the tier's own body out is the
  // shortest path from "17 had a dynamic segment" to the line that made them so.
  if (opts.dumpWat) {
    fs.writeFileSync(opts.dumpWat, [t3.locals, t3.pro, t3.wat, t3.epi].join('\n\n'));
    log(`tier 3 body written to ${opts.dumpWat}`);
  }
  log(`\ntier 1: ${ops.length} bodies stitched, operands folded`);
  const passName = ['constprop', 'regfold', 'deadflags'].filter(p => passes[p]).join('+') || 'none';
  log(`tier 2 passes: ${passName}`);
  log(`tier 2: + ${t2.propagated} operand constants propagated, `
    + `${t2.folded} register-file calls folded to direct globals, `
    + `${t2.killed} dead flag computations removed`);
  log(`tier 3: + ${t3.eaFolded} address br_tables folded `
    + `(${t3.eaA32} were 32-bit addressing, ${t3.eaDynamic} had a dynamic index), `
    + `${t3.folded - t2.folded} further register-file calls folded, `
    + `${t3.arith} constant expressions evaluated, `
    + `${t3.segFolded} segment br_tables folded `
    + `(${t3.segDynamic} had a dynamic segment), `
    + (t3.promoted ? `${t3.promoted.length} values in locals: ${t3.promoted.join(' ')}`
      : `NO register promotion -- ${t3.declined}`));

  const arms = [];
  // tier 0 -- the shipped interpreter over the same ops
  const vm0 = await makeVm('tailcall', {});
  const base = isa.THREAD_BASE;
  const words = straightLineProgram(ops, base);
  new Int32Array(vm0.mem.buffer, base, words.length).set(words);
  arms.push({
    name: 'tier 0  interpreter', vm: vm0,
    // The arena lives inside the same linear memory the snapshot overwrites, so
    // the program has to be laid down AFTER each seed or the interpreter runs
    // whatever the profiling run happened to leave at THREAD_BASE.
    afterSeed: () => new Int32Array(vm0.mem.buffer, base, words.length).set(words),
    go: (k) => { for (let i = 0; i < k; i++) vm0.exports.run(base, ops.length * 8); },
  });

  for (const [name, src, extra] of [
    ['tier 1  stitched', t1.wat, {}],
    ['tier 2  optimized', t2.wat, {}],
    ['tier 3  micro-ops', t3.wat, { locals: t3.locals, pro: t3.pro, epi: t3.epi }],
  ]) {
    const file = `trace-${name.split(' ')[1]}.wat`;
    // Everything from here to the end of instantiate is what a REAL jit would
    // have to pay before the first fast op runs, and none of it is inside the
    // timing loop below. Measured here so the report can say what the tiers
    // cost as well as what they save -- a speedup with no compile cost beside
    // it is a throughput number wearing a JIT's name.
    const buildStart = process.hrtime.bigint();
    const bytes = await compileWat(() => moduleWat(src, extra),
      // The pass set is part of the key: two `--passes=` runs produce different
      // tier-2 modules for the same trace, and a cache hit across them would
      // silently benchmark the previous one.
      { files: [file], cacheKey: `trace-jit:${name}:${hot.bip}:${passName}:v3` });
    const memory = new WebAssembly.Memory({ initial: isa.MEM_PAGES, maximum: isa.MEM_PAGES });
    // These MUST match makeVm's defaults exactly. They did not: the shipped
    // interpreter answers a 16-bit port read with 0xFFFF and this answered
    // 0xFF, so any trace touching a word-wide port landed on different
    // registers in tier 0 than in tiers 1 and 2 -- and the agreement check
    // correctly refused to compare them. The bug was in the harness, not in
    // the optimizer it was accusing.
    const inst = await WebAssembly.instantiate(new WebAssembly.Module(bytes), {
      host: {
        memory,
        port_in: (_port, w) => (w === 16 ? 0xFFFF : 0xFF),
        port_out: () => {},
        // No trace this tool has ever picked contains a transcendental, and a
        // stub returning 0 would make one look like it agreed across tiers.
        fmath: (op) => { throw new Error(`fmath(${op}) in a JIT trace: teach this tool the FPU`); },
      },
    });
    const buildNs = Number(process.hrtime.bigint() - buildStart);
    const ex = inst.exports;
    arms.push({
      name, mem: new Uint8Array(memory.buffer), exports: ex, buildNs,
      go: (k) => { for (let i = 0; i < k; i++) ex.spin(1); },
    });
  }

  // Identical starting state for every arm: the guest memory and registers as
  // they actually were when the interpreter entered this block.
  const snapshotMem = hot.memSnapshot;
  const snapshotRegs = hot.regSnapshot;
  const seed = (arm) => {
    const mem = arm.vm ? arm.vm.mem : arm.mem;
    mem.set(snapshotMem);
    const ex = arm.vm ? arm.vm.exports : arm.exports;
    // Machine settings BEFORE the guest state: a segment setter recomputes its
    // shadow base through $sbase, and in protected mode that reads the
    // descriptor tables. Seeding `ds` against an empty GDT resolves to the
    // wrong base and every later memory access in the arm addresses somewhere
    // else.
    for (const [g, v] of Object.entries(hot.machineSnapshot || {})) {
      if (ex[`mset_${g}`]) ex[`mset_${g}`](v);
    }
    for (const [g, v] of Object.entries(snapshotRegs)) if (ex[`set_${g}`]) ex[`set_${g}`](v);
    if (arm.afterSeed) arm.afterSeed();
  };

  // Correctness before speed: same ops from the same state must land on the
  // same registers and the same memory, or the timings compare nothing.
  const fingerprints = [];
  for (const arm of arms) {
    seed(arm);
    arm.go(iters);
    const ex = arm.vm ? arm.vm.exports : arm.exports;
    // $gip is excluded: it is where the trace *would* have branched, written by
    // every jcc body, and in a straight-line arm nothing consumes it.
    // $halt joins them for the same reason: it says how the SLICE ended, which
    // is harness state, and a straight-line arm ends its slice differently from
    // one that branches.
    // The segment BASES join the selectors -- but only when EVERY arm can
    // report them, because a column one arm omits makes every comparison fail
    // on formatting rather than on state. (It did: B-STEEL's arms were declared
    // to disagree while every register in the row was equal.) They are derived
    // state, set only by `$sset` via `set_<seg>`, so an arm can carry the right
    // selector and the wrong base and address somewhere else entirely.
    const bases = arms.every(a => (a.vm ? a.vm.exports : a.exports)[`get_${isa.SEG[0]}b`])
      ? isa.SEG : [];
    const regs = STATE.filter(g => !['ip', 'steps', 'left', 'intno', 'gip', 'halt'].includes(g))
      .map(g => `${g}=${ex[`get_${g}`]() >>> 0}`)
      .concat(bases.map(r => `${r}b=${ex[`get_${r}b`]() >>> 0}`))
      .join(' ');
    const mem = arm.vm ? arm.vm.mem : arm.mem;
    fingerprints.push({ name: arm.name, regs, mem: memHash(mem), bytes: mem });
  }
  const agree = new Set(fingerprints.map(f => `${f.regs}|${f.mem}`)).size === 1;
  log(`\nagreement after ${iters} iterations: ${agree ? 'ALL THREE MATCH' : 'MISMATCH'}`);
  if (!agree) {
    for (const f of fingerprints) {
      let where = '';
      if (f.mem !== fingerprints[0].mem) {
        const at = firstMemDiff(fingerprints[0].bytes, f.bytes);
        where = ` (first byte differing from ${fingerprints[0].name.split(' ')[1]}: `
          + `0x${at.toString(16)} -- ${fingerprints[0].bytes[at]} here ${f.bytes[at]})`;
      }
      log(`  ${f.name}\n    ${f.regs}\n    mem=${f.mem}${where}`);
    }
    log('\nnot comparable -- an arm that computes something else is not faster.');
    return { agree: false, fingerprints: fingerprints.map(({ bytes, ...f }) => f) };
  }

  const best = new Map(arms.map(a => [a.name, Infinity]));
  for (let rep = 0; rep < reps; rep++) {
    for (let j = 0; j < arms.length; j++) {
      const arm = arms[(j + rep) % arms.length];
      seed(arm);
      const t = process.hrtime.bigint();
      arm.go(iters);
      const ns = Number(process.hrtime.bigint() - t) / (iters * ops.length);
      if (ns < best.get(arm.name)) best.set(arm.name, ns);
    }
  }

  const b0 = best.get('tier 0  interpreter');
  log(`\nns per guest op (min of ${reps} interleaved reps, ${iters} iterations each):`);
  for (const a of arms) {
    const ns = best.get(a.name);
    log(`  ${a.name.padEnd(22)} ${ns.toFixed(2)} ns`
      + (a.name.startsWith('tier 0') ? '   (baseline)'
        : `   ${(b0 / ns).toFixed(2)}x`));
  }
  const t1ns = best.get('tier 1  stitched'), t2ns = best.get('tier 2  optimized');
  log(`\n  tier 0 -> 1  ${(b0 / t1ns).toFixed(2)}x   (dispatch, operand load, ip advance)`);
  log(`  tier 1 -> 2  ${(t1ns / t2ns).toFixed(2)}x   (register folding + dead flags)`);
  const t3ns = best.get('tier 3  micro-ops');
  log(`  tier 0 -> 2  ${(b0 / t2ns).toFixed(2)}x   total`);
  log(`  tier 2 -> 3  ${(t2ns / t3ns).toFixed(2)}x   (address folding, wide register file, registers in locals)`);
  log(`  tier 0 -> 3  ${(b0 / t3ns).toFixed(2)}x   total`);

  // What the speedup COSTS. Every ratio above is steady state: the timing loop
  // starts after the module is built, so on its own the table describes
  // compiled-code throughput and not a JIT, which has to earn its compile back
  // before the first saved nanosecond counts for anything.
  //
  // Break-even is in ITERATIONS OF THIS TRACE, which is the unit a compile
  // policy is actually written in ("compile after N hits"). Note the build
  // measured here is this harness's -- emit the WAT, run it through the
  // project's own compiler, hand it to the engine -- and a real in-VM
  // implementation would not do it this way; read it as an order of magnitude
  // and an upper bound, not as the cost of the design.
  const t3arm = arms.find(a => a.name.startsWith('tier 3'));
  const perIter = ops.length;
  const savedPerIter = (b0 - t3ns) * perIter;
  const breakEven = savedPerIter > 0 ? t3arm.buildNs / savedPerIter : Infinity;
  log(`\n  tier 3 build ${(t3arm.buildNs / 1e6).toFixed(1)} ms`
    + `  (NOT in the timings above -- they start after it)`);
  log(`  break-even   ${Number.isFinite(breakEven)
    ? `${Math.ceil(breakEven).toLocaleString()} iterations of this trace `
      + `(~${Math.ceil(breakEven * perIter).toLocaleString()} guest ops)`
    : 'never -- tier 3 is not faster here'}`);
  return {
    build: { tier3Ns: t3arm.buildNs, breakEvenIters: breakEven },
    // `bytes` is a live view of a 128MB guest memory and must not escape: it
    // is here only so a mismatch can name the first differing address, and
    // JSON.stringify on it fails with `Invalid string length`.
    agree: true, fingerprints: fingerprints.map(({ bytes, ...f }) => f),
    ns: { tier0: b0, tier1: t1ns, tier2: t2ns, tier3: t3ns },
    speedup: {
      t01: b0 / t1ns, t12: t1ns / t2ns, t02: b0 / t2ns,
      t23: t2ns / t3ns, t03: b0 / t3ns,
    },
    micro: {
      eaFolded: t3.eaFolded, eaA32: t3.eaA32, eaDynamic: t3.eaDynamic,
      segFolded: t3.segFolded, segDynamic: t3.segDynamic, arith: t3.arith,
      promoted: t3.promoted, declined: t3.declined,
    },
    opt: { propagated: t2.propagated, folded: t2.folded, killed: t2.killed },
    iters, reps,
  };
}

module.exports = {
  jitTiers, benchTiers,
  findHotTrace, readTrace, foldOperands, emitTier1, emitTier2,
  foldRegisterFile, killDeadFlags, moduleWat, memHash, straightLineProgram,
  emitTier3, foldEa, promoteRegs,
};

if (require.main === module) main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
