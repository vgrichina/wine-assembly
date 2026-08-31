#!/usr/bin/env node

'use strict';

// Do multi-op self-loops exist in the corpus, and do they carry any work?
//
//   node tools/toyvm/spin-census.js scratch/demos/DTM2.EXE --dispatches=8m
//   node tools/toyvm/spin-census.js $(grep -v '^#' tools/toyvm/bench-set-core10.txt)
//   node tools/toyvm/spin-census.js --dir=scratch/demos --shapes=20
//
// The spin collapse in compile.js accepts a block of EXACTLY ONE op, because
// one op is the only body it can prove pure without a purity analysis
// (docs/toyvm-spin-loops.md). Widening it to "several provably pure ops" needs
// that analysis -- a per-handler property derived from emitted WAT the way
// FLAG_EFFECTS is -- and that is real work. This tool exists to decide whether
// it is work worth doing, BEFORE any of it is done.
//
// It answers one question: for each block whose last op is a branch back to the
// block's own head, how many ops is the block, and how hot is it?
//
// Two things it is careful about.
//
// **Hotness is measured, not counted.** The CONTAGIO row in the spin write-up
// is 27 collapsed loops and zero dispatches saved -- the same handful of `jmp $`
// parking loops recompiled 7,000 times and never entered. A count of SITES is
// not a count of WORK. So every row is weighted by $ip samples, and a shape
// with many sites and no samples is printed as exactly that.
//
// **Purity here is a heuristic and is labelled as one.** A real purity property
// is the thing this tool exists to avoid building speculatively, so the `pure?`
// column is an allow-list over the handler body: no store, no global write
// outside the lazy-flag record, and no call to anything but a known reader.
// It is conservative in the direction that matters (it can call a pure op
// impure, never the reverse) but it is not a proof and nothing may be built on
// it -- it is here so the shapes table can be read at a glance.

const fs = require('fs');
const path = require('path');
const { runDos } = require('./run-dos');
const { HANDLERS, ARITY, TAKEN_AT, SPIN, prepareTables } = require('./emit');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function count(s, d) {
  if (s === undefined) return d;
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`not a count: ${s}`);
  return Math.round(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2].toLowerCase()]);
}

// --- the heuristic purity column --------------------------------------------
//
// Everything an op could do that would make the next turn of the loop read
// something different. A `cmp` records into the lazy-flag globals and touches
// nothing else, which is why it is the shape the one-op rule already accepts.
// $ip is in here because EVERY handler writes it: ops(n) loads the operands and
// then advances the thread pointer past them. It is the dispatch mechanism, not
// guest state, and counting it would make the pure column empty by construction.
const FLAG_GLOBALS = new Set(['$fop', '$fa', '$fb', '$fu', '$fr', '$fw', '$fcf', '$ip']);
// An ALLOW-list, not a deny-list, and the difference was a bug: a deny-list
// spelled `$out` does not match `$port_out`, so `out_8 -> loop` came back pure
// -- a loop writing the VGA palette, reported as a loop over nothing. Anything
// not named here is impure, so a helper nobody thought of fails closed.
const PURE_CALL = /^(rget(8|16|32)|sget|rd(8|16|32)|ea_|lin|seg_|flag|cond|get_)/;

function purityOf(body) {
  const why = [];
  if (/\bi32\.store/.test(body)) why.push('store');
  for (const m of body.matchAll(/\(call \$([a-z0-9_]+)/gi)) {
    if (!PURE_CALL.test(m[1])) why.push(`call $${m[1]}`);
  }
  for (const m of body.matchAll(/\(global\.set (\$[a-z0-9_]+)/gi)) {
    if (!FLAG_GLOBALS.has(m[1])) why.push(`writes ${m[1]}`);
  }
  return { pure: why.length === 0, why: [...new Set(why)] };
}

// --- the census -------------------------------------------------------------

// One block: walk its ops by ARITY, and say whether its last op branches to the
// block's own guest ip. ARITY is the only thing that knows where an op ends, so
// a range the arity table cannot walk exactly is refused rather than guessed at
// -- the same refusal compile.js's opsOf() makes, for the same reason.
function walkOps(words, start, end) {
  const at = [];
  let i = start;
  for (; i < end;) { at.push(i); i += 1 + ARITY[words[i]]; }
  return (i === end && at.length) ? { at } : null;
}

// Is this loop body a memory STREAM -- the shape a superinstruction folds?
//
// This is the toy VM's version of the question tools/match-loops.js asks of a
// PE for the production interpreter (docs/loop-idiom-superops-design.md). It is
// deliberately coarser: it says whether the ops are the right KIND, not whether
// the induction variables and the address expressions line up, because at this
// stage the question is only "does this population exist and is it hot".
//
// A shape is disqualified outright by anything that leaves the loop's own
// control: a call, an interrupt, a port, a return. Those are not folds, they
// are exits.
const MEM_WRITE = /^(stos|movs|mov_m|add_m|sub_m|adc_m|sbb_m|and_m|or_m|xor_m|inc_m|dec_m|rep_)/;
const MEM_READ = /^(lods|mov_rm|add_rm|sub_rm|cmp_rm|and_rm|or_rm|xor_rm|movs|scas|cmps|movzx|movsx|xlat)/;
const INDUCTION = /^(inc_r|dec_r|add_ri|sub_ri|add_rr|lea)/;
const NOT_A_FOLD = /^(call|ret|int|in_|out_|iret|hlt|jmp_far|loopne|end)/;

function streamShape(body) {
  const names = body.map(o => o.name);
  const ops = names.slice(0, -1);   // the closer is the trip count, not the body
  const bad = ops.filter(n => NOT_A_FOLD.test(n));
  return {
    writes: ops.some(n => MEM_WRITE.test(n)),
    reads: ops.some(n => MEM_READ.test(n)),
    induction: ops.some(n => INDUCTION.test(n)),
    escapes: bad,
    stream: bad.length === 0 && ops.some(n => MEM_WRITE.test(n))
      && ops.some(n => INDUCTION.test(n) || MEM_READ.test(n)),
  };
}

function blockShape(words, start, end, gip) {
  const w = walkOps(words, start, end);
  if (!w) return null;
  const at = w.at;
  const last = at[at.length - 1];
  const takenAt = TAKEN_AT.get(words[last]);
  if (takenAt === undefined) return null;                 // does not end in a branch
  if (words[last + 1 + takenAt] !== gip) return null;     // ...and not back here
  return { at, ops: at.map(p => HANDLERS[words[p]]) };
}

async function censusOne(exe, { budget, slice, cpu, maxBlocks = 8, maxOps = 64 }) {
  const r = await runDos({
    exe, budget, slice, cpu, sample: true, autoKey: true, log: () => {},
  });

  // Block head word index -> its guest ip, per compiled region. `blocks` is
  // ip -> byte address, so invert it; trace-jit.js resolves the same way.
  const heads = [];
  for (const progs of r.regions.values()) {
    for (const p of progs) {
      const mine = [];
      for (const [bip, addr] of p.blocks) mine.push({ bip, w: (addr - p.arenaBase) >> 2 });
      mine.sort((a, b) => a.w - b.w);
      for (let k = 0; k < mine.length; k++) {
        const end = k + 1 < mine.length ? mine[k + 1].w : p.words.length;
        heads.push({ prog: p, bip: mine[k].bip, w: mine[k].w, end, addr: p.arenaBase + mine[k].w * 4 });
      }
    }
  }

  // $ip samples land anywhere inside a block, so attribute each to the block
  // whose head is the greatest one below it.
  const byAddr = [...heads].sort((a, b) => a.addr - b.addr);
  const owner = (at) => {
    let lo = 0, hi = byAddr.length - 1, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (byAddr[mid].addr <= at) { best = byAddr[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  };
  const perBlock = new Map();
  let sampled = 0;
  for (const [at, n] of r.ipSamples) {
    const o = owner(at);
    if (!o) continue;
    perBlock.set(o.addr, (perBlock.get(o.addr) || 0) + n);
    sampled += n;
  }

  // --- loops that are more than one block ----------------------------------
  //
  // A self-loop is the special case where the backward edge lands on the block
  // it left. The general one lands on an EARLIER block head, and the loop is
  // every block in between. That population is invisible to the self-loop pass
  // above and it is where the stream loops live -- a blitter is a bounds check,
  // a body and a counter, which is two or three blocks, not one.
  //
  // The target has to be a head in the same region and at or before this block
  // in emission order; blocks are emitted in the order they were discovered, so
  // that is the natural-loop approximation for straight-line layout. It is an
  // approximation and is labelled as one: a loop whose head was compiled into a
  // different region is missed, which makes every number here a FLOOR.
  const perProg = new Map();
  for (const h of heads) {
    if (!perProg.has(h.prog)) perProg.set(h.prog, []);
    perProg.get(h.prog).push(h);
  }
  const multiBlock = new Map();
  for (const [prog, mine] of perProg) {
    const ipAt = new Map();
    mine.forEach((h, i) => ipAt.set(h.bip, i));
    for (let b = 0; b < mine.length; b++) {
      const h = mine[b];
      const s = walkOps(prog.words, h.w, h.end);
      if (!s) continue;
      const last = s.at[s.at.length - 1];
      const takenAt = TAKEN_AT.get(prog.words[last]);
      if (takenAt === undefined) continue;
      const t = ipAt.get(prog.words[last + 1 + takenAt]);
      if (t === undefined || t >= b) continue;   // not a backward edge
      // INNER loops only. Without a bound, a backward edge to a distant head
      // captures every block in between and reports the enclosing function as a
      // 72-block "loop" -- measured on BRW, 206 ops, six of them the top rows.
      // A fold works on an inner loop, so that is what is counted.
      if (b - t + 1 > maxBlocks) continue;
      // Every block from the head down to this one, walked the same way.
      const body = [];
      let ok = true;
      for (let k = t; k <= b && ok; k++) {
        const w = walkOps(prog.words, mine[k].w, mine[k].end);
        if (!w) { ok = false; break; }
        for (const p of w.at) body.push(HANDLERS[prog.words[p]]);
      }
      if (!ok || body.length > maxOps) continue;
      const key = body.map(o => o.name).join(' ');
      if (!multiBlock.has(key)) {
        multiBlock.set(key, {
          names: body.map(o => o.name), blocks: b - t + 1, n: body.length,
          sites: 0, samples: 0, ...streamShape(body),
        });
      }
      const e = multiBlock.get(key);
      e.sites++;
      for (let k = t; k <= b; k++) e.samples += perBlock.get(mine[k].addr) || 0;
    }
  }

  // A block compiles many times over a run (CONTAGIO recompiles 7,000 times),
  // so collapse identical shapes and count sites and samples separately.
  const shapes = new Map();
  let loops = 0;
  for (const h of heads) {
    const s = blockShape(h.prog.words, h.w, h.end, h.bip);
    if (!s) continue;
    loops++;
    const names = s.ops.map(o => o.name);
    const key = names.join(' ');
    if (!shapes.has(key)) {
      const body = s.ops.slice(0, -1);
      const closer = s.ops[s.ops.length - 1];
      const pur = body.map(o => purityOf(o.body));
      const bodyPure = pur.every(p => p.pure);
      // The CLOSER's own purity decides which fold this shape belongs to, and
      // conflating the two classes was this tool's first wrong answer: it
      // scored `nop -> nop -> loop32` as a pure loop over nothing, when
      // `loop32` decrements ECX and the loop therefore ENDS. A closer in SPIN
      // changes nothing but the flag record, which is what makes "once it is
      // taken it is taken forever" true. A `loop`/`dec+jnz` closer is a counted
      // loop -- a real candidate for a different fold, not for this one.
      const counted = /^loop(32)?$/.test(closer.name);
      shapes.set(key, {
        names, n: names.length, sites: 0, samples: 0,
        collapsed: /_spin$/.test(closer.name),
        counted,
        // A spin candidate: pure body AND a closer that only reads flags.
        pure: bodyPure && SPIN.has(closer.index),
        // A delay-loop candidate: pure body, closer counts down. Different
        // arithmetic (the trip count is in CX), so it is counted separately.
        delay: bodyPure && counted,
        why: [...new Set(pur.flatMap(p => p.why))].concat(
          bodyPure && !SPIN.has(closer.index) ? [`closer ${closer.name}`] : []),
      });
    }
    const e = shapes.get(key);
    e.sites++;
    e.samples += perBlock.get(h.addr) || 0;
  }

  return {
    exe: path.basename(exe), dispatched: r.dispatched, sampled,
    blocks: heads.length, loops, shapes: [...shapes.values()],
    multiBlock: [...multiBlock.values()],
  };
}

// --- report -----------------------------------------------------------------

function main() {
  const exes = process.argv.slice(2).filter(a => !a.startsWith('--'));
  // Recursive, because the demo corpus is one directory per release --
  // /tmp/demos/1995-b-bc_dtm2/DTM2.EXE. Same walk equiv-dos.js does.
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(exe|com)$/i.test(e.name)) exes.push(p);
    }
  };
  const dir = arg('dir');
  if (dir) walk(dir);
  if (!exes.length) {
    console.log('usage: node tools/toyvm/spin-census.js <exe...> [--dir=D] '
      + '[--dispatches=8m] [--slice=N] [--shapes=N] [--json]');
    process.exit(2);
  }
  prepareTables();

  const budget = count(arg('dispatches'), 8e6);
  // A sample is taken per slice, so a short slice buys resolution. 2000 gives
  // ~4000 samples over an 8M-dispatch run, which is enough to rank blocks and
  // nowhere near enough to read a single one's share to a decimal place.
  const slice = Number(arg('slice', 2000));
  const cpu = Number(arg('cpu', 386));
  const topShapes = Number(arg('shapes', 12));
  const json = process.argv.slice(2).includes('--json');

  const all = [];
  (async () => {
    for (const exe of exes) {
      let c;
      try {
        c = await censusOne(exe, {
          budget, slice, cpu,
          maxBlocks: Number(arg('max-blocks', 8)), maxOps: Number(arg('max-ops', 64)),
        });
      } catch (e) {
        console.log(`\n${path.basename(exe)}  SKIPPED -- ${(e.message || String(e)).split('\n')[0]}`);
        continue;
      }
      all.push(c);

      // Per program: the ops-count histogram is the whole question. n=1 is what
      // the current rule already handles; n>=2 is the candidate population, and
      // its SAMPLE share is what says whether widening the rule is worth a
      // purity analysis.
      const byN = new Map();
      for (const s of c.shapes) {
        if (!byN.has(s.n)) byN.set(s.n, { sites: 0, samples: 0, pure: 0, pureSamples: 0, delaySamples: 0 });
        const b = byN.get(s.n);
        b.sites += s.sites; b.samples += s.samples;
        if (s.pure) { b.pure += s.sites; b.pureSamples += s.samples; }
        if (s.delay) b.delaySamples += s.samples;
      }
      const pct = (x) => c.sampled ? `${(100 * x / c.sampled).toFixed(1)}%` : '--';
      console.log(`\n${c.exe}  ${(c.dispatched / 1e6).toFixed(1)}M dispatches, `
        + `${c.blocks} blocks compiled, ${c.loops} self-loop, ${c.sampled} ip samples`);
      console.log('   ops  sites  samples   share  spin sites  spin share  delay share');
      for (const n of [...byN.keys()].sort((a, b) => a - b)) {
        const b = byN.get(n);
        console.log(`  ${String(n).padStart(4)}  ${String(b.sites).padStart(5)}  `
          + `${String(b.samples).padStart(7)}  ${pct(b.samples).padStart(6)}  `
          + `${String(b.pure).padStart(10)}  ${pct(b.pureSamples).padStart(10)}  `
          + `${pct(b.delaySamples).padStart(11)}`);
      }

      // The multi-block population, which the self-loop table above cannot see
      // and which is where a blitter actually lives.
      const mb = c.multiBlock.filter(s => s.blocks > 1)
        .sort((a, b) => b.samples - a.samples || b.sites - a.sites);
      if (mb.length) {
        const sSam = mb.filter(s => s.stream).reduce((a, s) => a + s.samples, 0);
        console.log(`  ${mb.length} multi-block loop shapes, `
          + `${mb.reduce((a, s) => a + s.samples, 0)} samples ${pct(mb.reduce((a, s) => a + s.samples, 0))}, `
          + `stream-shaped ${sSam} ${pct(sSam)}:`);
        for (const s of mb.slice(0, topShapes)) {
          console.log(`    ${String(s.samples).padStart(6)} samples ${pct(s.samples).padStart(6)}  `
            + `${String(s.sites).padStart(4)} sites  ${s.blocks}blk ${String(s.n).padStart(3)}op  `
            + `${s.stream ? 'STREAM' : s.escapes.length ? `exits:${s.escapes[0]}` : '-     '}  `
            + `${s.names.slice(0, 10).join(' ')}${s.names.length > 10 ? ' ...' : ''}`);
        }
      }

      const cand = c.shapes.filter(s => s.n >= 2).sort((a, b) => b.samples - a.samples || b.sites - a.sites);
      if (cand.length) {
        console.log(`  multi-op self-loop shapes (${cand.length} distinct), hottest first:`);
        for (const s of cand.slice(0, topShapes)) {
          const tag = s.pure ? 'SPIN ' : s.delay ? 'DELAY' : 'no   ';
          console.log(`    ${String(s.samples).padStart(6)} samples ${pct(s.samples).padStart(6)}  `
            + `${String(s.sites).padStart(4)} sites  ${tag}  ${s.names.join(' -> ')}`
            + (s.pure || s.delay ? '' : `   [${s.why.slice(0, 3).join(', ')}]`));
        }
      }
    }

    if (all.length > 1) {
      const sum = (f) => all.reduce((a, c) => a + f(c), 0);
      const multi = (c) => c.shapes.filter(s => s.n >= 2);
      const tot = sum(c => c.sampled);
      const ms = sum(c => multi(c).reduce((a, s) => a + s.samples, 0));
      const mp = sum(c => multi(c).filter(s => s.pure).reduce((a, s) => a + s.samples, 0));
      const md = sum(c => multi(c).filter(s => s.delay).reduce((a, s) => a + s.samples, 0));
      const one = sum(c => c.shapes.filter(s => s.n === 1).reduce((a, s) => a + s.samples, 0));
      const row = (label, n) => console.log(`  ${label.padEnd(36)}${String(n).padStart(7)} samples  ${(100 * n / tot).toFixed(1)}%`);
      console.log(`\nacross ${all.length} programs, ${tot} ip samples:`);
      row("one-op self-loops (today's rule)", one);
      row('multi-op self-loops, any shape', ms);
      row('...body pure, flag-only closer', mp);
      row('...body pure, counting closer', md);
      const mbAll = (f) => sum(c => c.multiBlock.filter(s => s.blocks > 1 && f(s))
        .reduce((a, s) => a + s.samples, 0));
      row('multi-block loops (backward edge)', mbAll(() => true));
      row('...stream-shaped (superop family)', mbAll(s => s.stream));
      // A self-loop that writes memory is the same family; it just fits in one
      // block. Counting it here keeps the two rows from splitting one answer.
      const selfStream = sum(c => c.shapes.filter(s => s.n >= 2
        && streamShape(s.names.map(n => ({ name: n }))).stream)
        .reduce((a, s) => a + s.samples, 0));
      row('...plus stream-shaped self-loops', selfStream);
      console.log('  The third row is the ceiling on WIDENING the spin rule, and it is a');
      console.log('  ceiling: a real purity property will accept fewer, never more. The');
      console.log('  fourth is a different fold entirely -- the trip count is in CX, so');
      console.log('  the arithmetic is min(cx*S, budget) rather than (v % S) - S.');
    }
    if (json) console.log(JSON.stringify(all, null, 2));
  })().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
}

if (require.main === module) main();
module.exports = { censusOne, purityOf, blockShape };
