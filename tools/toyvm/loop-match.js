#!/usr/bin/env node

'use strict';

// What would a stream fold actually accept, and what stops the rest?
//
//   node tools/toyvm/loop-match.js --dir=/tmp/demos --dispatches=2m --why
//   node tools/toyvm/loop-match.js /tmp/demos/1995-c-cma_brw/BRW.EXE --list
//
// docs/toyvm-stream-loops.md measured that memory-stream inner loops carry
// 24.8% of the corpus, using a coarse "the ops are the right kind" test. That
// number is an upper bound and was always meant to be: it says the population
// exists, not that a fold can take it.
//
// This applies the real predicate. Each loop is summarized from
// tools/toyvm/handler-effects.js -- which registers are induction variables,
// which memory streams exist and what addresses them, what the trip count is,
// and what side effects are left over -- and then the fold's conditions are
// checked one at a time. Every decline is a NAMED reason, and `--why` prints
// the histogram of them, because that histogram is the work list: it says which
// single restriction, lifted, would buy the most.
//
// This is the toy VM's analogue of tools/match-loops.js for the production
// interpreter, and it exists for the same reason -- a match rate from a regex
// over op names over-counts badly (find-loops.js reads stack-counter loops as
// `lut`), so the predicate has to be applied properly before anything is built.
//
// NOTHING IS FOLDED HERE. This tool reports; the compiler is untouched.

const fs = require('fs');
const path = require('path');
const { runDos } = require('./run-dos');
const { HANDLERS, ARITY, TAKEN_AT, prepareTables } = require('./emit');
const EFFECTS = require('./handler-effects');

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

// --- summarize one loop body ------------------------------------------------
//
// `ops` is [{ eff, p }] in body order: the effect record, and the arena word
// index of the handler word so a register index can be materialized.
//
// The summary is deliberately shaped like the production design's: roles, then
// induction variables, then memory streams, then whatever side effects are left
// that nothing accounted for.
function summarize(ops, words) {
  const s = {
    regRead: new Map(), regWrite: new Map(),   // reg -> [width...]
    memRead: [], memWrite: [], addresses: [],
    stack: 0, segWrite: 0, countDown: false, unreadable: null,
  };
  for (const { eff, p } of ops) {
    if (!eff.readable) { s.unreadable = eff; return s; }
    const put = (m, r, w) => { if (!m.has(r)) m.set(r, []); m.get(r).push(w); };
    for (const a of eff.regRead) put(s.regRead, EFFECTS.at(a, words, p), a.width);
    for (const a of eff.regWrite) put(s.regWrite, EFFECTS.at(a, words, p), a.width);
    for (const a of eff.memRead) s.memRead.push({ width: a.width, op: eff.name });
    for (const a of eff.memWrite) s.memWrite.push({ width: a.width, op: eff.name });
    for (const a of eff.address) {
      s.addresses.push({
        mode: EFFECTS.at({ ...a.mode }, words, p),
        disp: EFFECTS.at({ ...a.disp }, words, p),
        op: eff.name,
      });
    }
    s.stack += eff.stack.length;
    s.segWrite += eff.segWrite.length;
    if (eff.countDown) s.countDown = true;
  }
  // An induction variable is a register the loop both reads and writes. That is
  // necessary, not sufficient -- the fold also needs a CONSTANT stride, which
  // this summary cannot see yet and which is the first thing to add.
  s.induction = [...s.regWrite.keys()].filter(r => s.regRead.has(r));
  // A register written but never read is a scratch value (`al` in a copy);
  // read but never written is loop-invariant.
  s.scratch = [...s.regWrite.keys()].filter(r => !s.regRead.has(r));
  s.invariant = [...s.regRead.keys()].filter(r => !s.regWrite.has(r));
  return s;
}

// --- the predicate ----------------------------------------------------------
//
// Each condition names itself when it fails. Order matters only for which
// reason gets reported first, and the order is cheapest-and-most-fundamental
// first so the histogram is dominated by real structure rather than by
// whichever check happened to run early.
function classify(sum, names) {
  if (sum.unreadable) return { verdict: null, why: `unreadable:${sum.unreadable.name}` };
  if (sum.stack) return { verdict: null, why: 'touches the stack' };
  if (sum.segWrite) return { verdict: null, why: 'writes a segment register' };
  if (!sum.memWrite.length && !sum.memRead.length) return { verdict: null, why: 'no memory stream' };
  if (!sum.induction.length && !sum.countDown) return { verdict: null, why: 'no induction variable' };

  // A fold has to write the final register state directly, so every induction
  // variable has to be affine in the trip count. With no stride analysis yet,
  // anything past a couple of them is out of scope rather than proven bad.
  if (sum.induction.length > 3) return { verdict: null, why: `${sum.induction.length} induction variables` };

  const widths = new Set([...sum.memRead, ...sum.memWrite].map(x => x.width));
  if (widths.size > 1) return { verdict: null, why: 'mixed access widths' };

  if (!sum.memWrite.length) return { verdict: 'SCAN_RUN', why: null };
  if (!sum.memRead.length) return { verdict: 'FILL_RUN', why: null };
  // Read and write both present: a copy, or a copy through a transform.
  return { verdict: sum.scratch.length || sum.invariant.length ? 'LUT_RUN' : 'COPY_RUN', why: null };
}

// --- walk the program's loops -----------------------------------------------

function walkOps(words, start, end) {
  const at = [];
  let i = start;
  for (; i < end;) { at.push(i); i += 1 + ARITY[words[i]]; }
  return (i === end && at.length) ? at : null;
}

async function matchOne(exe, { budget, slice, cpu, maxBlocks, maxOps }) {
  const eff = EFFECTS.table();
  const r = await runDos({
    exe, budget, slice, cpu, sample: true, autoKey: true, log: () => {},
  });

  const heads = [];
  for (const progs of r.regions.values()) {
    for (const p of progs) {
      const mine = [];
      for (const [bip, addr] of p.blocks) mine.push({ bip, w: (addr - p.arenaBase) >> 2 });
      mine.sort((a, b) => a.w - b.w);
      for (let k = 0; k < mine.length; k++) {
        mine[k].end = k + 1 < mine.length ? mine[k + 1].w : p.words.length;
        mine[k].addr = p.arenaBase + mine[k].w * 4;
        mine[k].prog = p;
      }
      heads.push(mine);
    }
  }

  const byAddr = heads.flat().sort((a, b) => a.addr - b.addr);
  const owner = (x) => {
    let lo = 0, hi = byAddr.length - 1, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (byAddr[mid].addr <= x) { best = byAddr[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  };
  const perBlock = new Map();
  let sampled = 0;
  for (const [x, n] of r.ipSamples) {
    const o = owner(x);
    if (!o) continue;
    perBlock.set(o.addr, (perBlock.get(o.addr) || 0) + n);
    sampled += n;
  }

  const shapes = new Map();
  for (const mine of heads) {
    const ipAt = new Map();
    mine.forEach((h, i) => ipAt.set(h.bip, i));
    const words = mine[0].prog.words;
    for (let b = 0; b < mine.length; b++) {
      const at = walkOps(words, mine[b].w, mine[b].end);
      if (!at) continue;
      const last = at[at.length - 1];
      const takenAt = TAKEN_AT.get(words[last]);
      if (takenAt === undefined) continue;
      const t = ipAt.get(words[last + 1 + takenAt]);
      if (t === undefined || t > b) continue;
      if (b - t + 1 > maxBlocks) continue;

      const ops = [];
      let ok = true;
      for (let k = t; k <= b && ok; k++) {
        const w = walkOps(words, mine[k].w, mine[k].end);
        if (!w) { ok = false; break; }
        for (const p of w) ops.push({ eff: eff[words[p]], p });
      }
      if (!ok || ops.length > maxOps) continue;

      // The closer is the trip count, not the body.
      const body = ops.slice(0, -1);
      const closer = ops[ops.length - 1];
      const names = ops.map(o => o.eff.name);
      const key = names.join(' ');
      if (!shapes.has(key)) {
        const sum = summarize(body, words);
        if (closer.eff.countDown) sum.countDown = true;
        const c = classify(sum, names);
        shapes.set(key, {
          names, blocks: b - t + 1, n: ops.length, sites: 0, samples: 0,
          verdict: c.verdict, why: c.why, sum,
        });
      }
      const e = shapes.get(key);
      e.sites++;
      for (let k = t; k <= b; k++) e.samples += perBlock.get(mine[k].addr) || 0;
    }
  }
  return { exe: path.basename(exe), dispatched: r.dispatched, sampled, shapes: [...shapes.values()] };
}

// --- CLI --------------------------------------------------------------------

async function main() {
  const exes = process.argv.slice(2).filter(a => !a.startsWith('--'));
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
    console.log('usage: node tools/toyvm/loop-match.js <exe...> [--dir=D] [--dispatches=2m] [--why] [--list[=VERDICT]]');
    process.exit(2);
  }
  prepareTables();

  const opts = {
    budget: count(arg('dispatches'), 2e6),
    slice: Number(arg('slice', 2000)),
    cpu: Number(arg('cpu', 386)),
    maxBlocks: Number(arg('max-blocks', 8)),
    maxOps: Number(arg('max-ops', 64)),
  };
  const list = process.argv.slice(2).find(a => a.startsWith('--list'));
  const listWhich = list && list.includes('=') ? list.split('=')[1] : (list ? '*' : null);

  const verdicts = new Map(), whys = new Map();
  let tot = 0, matchedSamples = 0, matchedSites = 0, allSites = 0;
  const hits = [];

  for (const exe of exes) {
    let c;
    try { c = await matchOne(exe, opts); } catch (e) {
      console.log(`${path.basename(exe)}  SKIPPED -- ${(e.message || String(e)).split('\n')[0]}`);
      continue;
    }
    tot += c.sampled;
    for (const s of c.shapes) {
      allSites += s.sites;
      if (s.verdict) {
        verdicts.set(s.verdict, (verdicts.get(s.verdict) || 0) + s.samples);
        matchedSamples += s.samples;
        matchedSites += s.sites;
        if (listWhich && (listWhich === '*' || listWhich === s.verdict)) hits.push({ ...s, exe: c.exe });
      } else {
        whys.set(s.why, (whys.get(s.why) || 0) + s.sites);
      }
    }
  }

  console.log(`\n${exes.length} programs, ${tot} ip samples, ${allSites} inner-loop sites`);
  console.log(`matched: ${matchedSites} sites, ${matchedSamples} samples `
    + `${tot ? (100 * matchedSamples / tot).toFixed(1) : '--'}% of the run`);
  for (const [v, n] of [...verdicts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.padEnd(10)} ${String(n).padStart(7)} samples  ${(100 * n / tot).toFixed(1)}%`);
  }
  if (flag('why')) {
    console.log('\ndeclines, by sites -- this histogram is the work list:');
    for (const [w, n] of [...whys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${String(n).padStart(6)}  ${w}`);
    }
  }
  if (hits.length) {
    console.log('\nmatched shapes, hottest first:');
    for (const s of hits.sort((a, b) => b.samples - a.samples).slice(0, Number(arg('top', 15)))) {
      console.log(`  ${String(s.samples).padStart(6)} samples  ${String(s.sites).padStart(4)} sites  `
        + `${s.verdict.padEnd(9)} ${s.exe.padEnd(14)} ${s.blocks}blk ${String(s.n).padStart(2)}op`);
      console.log(`      ${s.names.join(' ')}`);
      console.log(`      induction=[${s.sum.induction}] scratch=[${s.sum.scratch}] `
        + `invariant=[${s.sum.invariant}] rd=${s.sum.memRead.length} wr=${s.sum.memWrite.length}`
        + `${s.sum.countDown ? ' countDown' : ''}`);
    }
  }
}

main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
