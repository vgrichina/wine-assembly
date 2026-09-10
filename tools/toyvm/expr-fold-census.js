#!/usr/bin/env node

'use strict';

// How much of a run is an EXPRESSION, and could therefore be one dispatch.
//
//   node tools/toyvm/expr-fold-census.js /tmp/demos/1995-b-bc_dtm2/DTM2.EXE
//   node tools/toyvm/expr-fold-census.js $(grep -v '^#' tools/toyvm/bench-set-core10.txt) \
//     --dispatches=20m --pit-clock --auto-key --sound-pref=sb \
//     --env=ULTRASND=220,1,1,11,7 --json=/tmp/fold.json
//
// THE QUESTION. A block of threaded code pays a dispatch per op and moves every
// intermediate through the guest register file in linear memory. A decode-time
// integer expression fold would lower a block's straight-line interior into ONE
// wasm expression tree -- intermediates in wasm locals, only the registers that
// are live out of the block stored back, one dispatch for the whole run. This
// measures the CEILING on that: the share of RETIRED guest ops that sit inside
// such a run, under a barrier list chosen so the fold is exact rather than
// nearly right.
//
// It is a ceiling and not a prediction, for the reason this repo keeps
// re-learning (docs/toyvm-trace-blocks.md, §"what it is actually worth"):
// removing a cost on paper is not the same as the run getting faster. What is
// here is the population; what a fold is worth to it is a measurement nobody
// has taken.
//
// WHERE THE WEIGHTS COME FROM, AND WHY IT IS NOT --handler-hist. The handler
// histogram is indexed by handler NUMBER: it says the run retired 4.1M
// `mov_rr16` dispatches and cannot say which block they were in, so it can
// weight an OPCODE census and never a BLOCK one. The region-jit profiler is a
// SAMPLING profiler ($ip at slice expiry, one sample per ~20000 dispatches) and
// its resolution is three orders of magnitude short of per-block counts on a
// corpus where blocks average ~3 ops.
//
// So this run turns on `--block-hits` (isa.IPHIST_BASE, emitted by
// emit.js:ipHistBump): one u32 per ARENA WORD, bumped in $next while $ip still
// points at the opcode word. The counter at a block head is the block's ENTRY
// count and the counters across its words are its retired-op profile, exact and
// independent of box load. A block that is left through the middle -- a
// handback, an expired slice, a taken branch out of a traced tail -- is
// therefore counted at the ops it actually ran, not at the ops it contains.
//
// THE OPS ARE THE ARENA'S, NOT A DISASSEMBLY'S. Classification walks the
// compiled words, so it sees exactly what the interpreter dispatched, fusions
// and all. A fused `cmp_ri8_jz` is decomposed back into its two constituent ops
// (emit.js FUSE/TRACE/SPIN/PSPIN/NOFLAG, inverted) and counted as two, so the
// denominator is guest ops and not dispatches -- otherwise every fusion already
// shipped would read as work that disappeared.
//
// WHAT AN OP DOES comes from tools/toyvm/handler-effects.js rather than from a
// name table here: which registers it writes (resolved to a concrete number
// against this arena's operand words), whether it touches memory and at what
// width, whether it escapes the analysis at all. A second name table would be
// a second policy that could drift from the interpreter.

const fs = require('fs');
const path = require('path');
const isa = require('./isa');
const {
  HANDLERS, ARITY, prepareTables, FUSE, TRACE, SPIN, PSPIN, NOFLAG,
} = require('./emit');
const effects = require('./handler-effects');

// --- CLI ---------------------------------------------------------------------

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(`--${n}`);
function arg(name, d) {
  const hit = ARGV.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? d : hit.slice(name.length + 3);
}
function count(s, d) {
  if (s === undefined) return d;
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`not a count: ${s}`);
  return Math.round(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2].toLowerCase()]);
}

// --- decomposing a compiled op back into guest ops ---------------------------

// Every handler the compiler can SWAP IN is a rewrite of one or two others:
// FUSE joins an ALU op to a branch, TRACE inlines a branch's not-taken edge,
// SPIN collapses a self-loop, PSPIN swallows the `in al,dx` in front of a
// polling pair, NOFLAG drops a dead flag write. Inverting all five gives the
// guest ops a compiled word stands for, which is the only denominator that
// means anything across builds: count dispatches instead and the fusions
// already shipped read as work that vanished.
let DECOMP = null;
function decompTable() {
  if (DECOMP) return DECOMP;
  prepareTables();
  const H = new Map(HANDLERS.map(h => [h.name, h.index]));
  const inv = new Map();
  const put = (to, from) => { if (!inv.has(to)) inv.set(to, from); };
  for (const [key, v] of FUSE) put(v, [Math.floor(key / 65536), key % 65536]);
  for (const [a, b] of TRACE) put(b, [a]);
  for (const [a, b] of SPIN) put(b, [a]);
  for (const [a, b] of PSPIN) put(b, [H.get('in_8'), a]);
  for (const [a, b] of NOFLAG) put(b, [a]);

  DECOMP = HANDLERS.map((h, i) => {
    let cur = [i];
    for (let depth = 0; depth < 8; depth++) {
      const next = [];
      let changed = false;
      for (const x of cur) {
        const e = inv.get(x);
        if (e && !e.includes(x)) { next.push(...e); changed = true; } else next.push(x);
      }
      cur = next;
      if (!changed) break;
    }
    return cur;
  });
  return DECOMP;
}

// --- the classifier ----------------------------------------------------------

// A base handler name -> its opcode stem and the width it operates at.
// `add_mi16` is (add, 16); `sh4_r32` is (sh4, 32); `lea` is (lea, 16).
function stemOf(name) {
  let m = /^([a-z0-9]+(?:[0-9]+)?)_(rr|mr|rm|ri|mi|r|m)(8|16|32)$/.exec(name);
  if (m) return { stem: m[1], form: m[2], width: Number(m[3]) };
  m = /^(movzx|movsx)(8|16)_(rr|rm)(16|32)$/.exec(name);
  if (m) return { stem: `${m[1]}${m[2]}`, form: m[3], width: Number(m[4]) };
  m = /^(imul2|imul3)_(rr|rm)(16|32)$/.exec(name);
  if (m) return { stem: m[1], form: m[2], width: Number(m[3]) };
  if (name === 'lea') return { stem: 'lea', form: 'rm', width: 16 };
  if (name === 'lea32') return { stem: 'lea', form: 'rm', width: 32 };
  // `mov ax,[imm16]` and its store twin: a plain full-width move whose operand
  // is an absolute address rather than a ModRM. It is spelled unlike every
  // other mov and reading it as an opaque name cost ACCIDENT's hottest fixed
  // point loop three splits in a thirteen-op run before this line existed.
  m = /^mov_(acc_moffs|moffs_acc)(8|16|32)$/.exec(name);
  if (m) return { stem: 'mov', form: m[1] === 'acc_moffs' ? 'rm' : 'mr', width: Number(m[2]) };
  return { stem: name, form: null, width: 0 };
}

const ALU_FOLD = new Set(['add', 'sub', 'and', 'or', 'xor', 'mov']);
const UNARY_FOLD = new Set(['neg', 'not', 'inc', 'dec']);
// The shift group is indexed by the ModRM /reg field, which is what the handler
// name carries: 0 rol, 1 ror, 2 rcl, 3 rcr, 4 shl, 5 shr, 6 sal, 7 sar.
const SHIFT_FOLD = new Set(['sh4', 'sh5', 'sh6', 'sh7']);
const SHIFT_CARRY = new Set(['sh2', 'sh3']);          // rcl/rcr: read CF
const SHIFT_ROT = new Set(['sh0', 'sh1']);            // rol/ror: not in the fold set

const STRING_RE = /^(rep_|repne_)?(movs|stos|lods|scas|cmps|ins|outs)[bwd](32)?$/;
const STACK_RE = /^(push|pop)(_|f|a)|^(pusha|popa|enter|leave)/;
const SETCC_RE = /^set_[a-z]+_(r8|m8)$/;
const JCC_RE = /^j(o|no|b|ae|z|nz|be|a|s|ns|p|np|l|ge|le|g)$/;
const FPU_RE = /^f[a-z0-9]/;
const MULDIV_RE = /^(mul|imul|div|idiv)_(r|m)(8|16|32)$/;

// Which barrier class an op falls in, and whether it is foldable at `width`.
// `args` are the op's own operand words -- needed for exactly two questions,
// "is this shift by CL" and "does this memory form carry a segment override" --
// and are only consulted for an op that decomposes to itself.
function classify(name, width, args, eff) {
  const { stem, form, width: w } = stemOf(name);

  if (name === 'end' || name === 'end_smc') return { cls: 'terminator', fold: false };
  if (FPU_RE.test(name) && !/^flag/.test(name)) return { cls: 'fpu', fold: false };
  if (STRING_RE.test(name)) return { cls: 'string', fold: false };
  if (STACK_RE.test(name)) return { cls: 'stack', fold: false };
  if (MULDIV_RE.test(name)) return { cls: 'muldiv', fold: false };
  if (/^(mov_r_sr|mov_sr_r|mov_m_sr|mov_sr_m|push_seg|pop_seg|push_seg32|pop_seg32|les|lds|lfs|lgs)$/.test(name)) {
    return { cls: 'segment', fold: false };
  }
  if (/^(in|out)_(8|16)$/.test(name)) return { cls: 'io', fold: false };
  if (/^(call|ret|retf|iret|jmp)/.test(name)) {
    return { cls: /^call/.test(name) ? 'call' : /^(ret|retf|iret)/.test(name) ? 'ret' : 'branch', fold: false };
  }
  if (/^int_imm$/.test(name) || name === 'into') return { cls: 'int', fold: false };
  if (JCC_RE.test(name) || /^(loop|loop32|loopz|loopnz|loopz32|loopnz32|jcxz|jcxz32)$/.test(name)) {
    return { cls: 'branch', fold: false };
  }
  if (SETCC_RE.test(name)) return { cls: 'flags', fold: false };
  if (/^(lahf|sahf|pushf|popf|pushf32|popf32|clc|stc|cmc|cld|std|cli|sti|salc|daa|das|aaa|aas|aam|aad)$/.test(name)) {
    return { cls: 'flags', fold: false };
  }
  if (stem === 'adc' || stem === 'sbb') return { cls: 'adc-sbb', fold: false };
  if (stem === 'cmp' || stem === 'test') return { cls: 'cmp-test', fold: false };
  if (SHIFT_CARRY.has(stem)) return { cls: 'flags', fold: false };

  // Anything the effect table cannot read is not foldable whatever its name
  // says: a port, a fault, the x87 stack, an index that would not resolve.
  const unreadable = eff && !eff.readable;

  // Narrow work. The fold is defined full-width -- 16-bit in real mode, 32-bit
  // under a 32-bit code segment -- so an 8-bit op in a 16-bit block, or a
  // 16-bit one in a 32-bit block, ends the run. That is a real constraint and
  // not a modelling shortcut: AL and AH are subfields of AX in the register
  // file, so keeping an expression's intermediates in wasm locals across one
  // means modelling the overlap.
  const narrow = w > 0 && w < width;

  let foldable = false;
  if (ALU_FOLD.has(stem) && form) foldable = w === width;
  else if (UNARY_FOLD.has(stem) && (form === 'r' || form === 'm')) foldable = w === width;
  else if (stem === 'lea') foldable = w === width;
  else if (stem === 'imul2' || stem === 'imul3') foldable = w === width;
  else if (/^(movzx|movsx)(8|16)$/.test(stem)) {
    // The source width is in the stem, not in `src`: `movzx16_rr32` matches the
    // generic name regex first, so the widening pair has to re-read it here.
    // Getting that wrong filed every 16->32 widening under `other`.
    const from = Number(/(8|16)$/.exec(stem)[1]);
    foldable = w === width && from < width;
  }
  else if (SHIFT_FOLD.has(stem)) {
    // decode.js passes -1 as the operand sentinel for "read the count from CL".
    const byCl = args && args.length && args[args.length - 1] === -1;
    if (byCl) return { cls: 'shift-cl', fold: false };
    foldable = w === width;
  } else if (SHIFT_ROT.has(stem)) return { cls: 'other', fold: false };

  if (foldable && narrow) return { cls: 'partial-reg', fold: false };
  if (foldable && unreadable) return { cls: 'other', fold: false };
  if (foldable) return { cls: 'fold', fold: true, stem };
  if (narrow) return { cls: 'partial-reg', fold: false };
  return { cls: 'other', fold: false };
}

// --- walking one program's live blocks ---------------------------------------

// Every block the run left compiled, with its arena extent. Same rule
// rankSamples() uses: a block ends where the next one begins, because a
// self-modifying program frees arena underneath its own code and a walk that
// ran past the end would decode freed words as ops.
function liveBlocks(r) {
  const heads = [];
  for (const [cs, progs] of r.regions) {
    for (const p of progs) {
      for (const [bip, addr] of p.blocks) heads.push({ cs, bip, addr, prog: p });
    }
  }
  heads.sort((a, b) => a.addr - b.addr);
  for (let i = 0; i < heads.length; i++) {
    const nat = i + 1 < heads.length ? heads[i + 1].addr : Infinity;
    const own = heads[i].prog.arenaBase + heads[i].prog.words.length * 4;
    heads[i].end = Math.min(nat, own);
  }
  return heads;
}

// A block's 32-bitness. The arena carries it in the op names themselves: a
// block compiled under a 32-bit code segment decodes its default-size ops to
// the `_32` handlers. Taking the widest op present rather than a per-program
// flag keeps a 16-bit block inside a 32-bit program classified as what it is.
function blockWidth(ops) {
  for (const o of ops) if (stemOf(o.base[0]).width === 32) return 32;
  return 16;
}

function walkBlock(blk, hits) {
  const words = blk.prog.words;
  const base = blk.prog.arenaBase;
  let w = (blk.addr - base) >> 2;
  const endW = Math.min((blk.end - base) >> 2, words.length);
  const D = decompTable();
  const ops = [];
  while (w < endW) {
    const fn = words[w];
    const h = HANDLERS[fn];
    if (!h) break;
    const args = [];
    for (let i = 0; i < h.args; i++) args.push(words[w + 1 + i]);
    ops.push({
      fn, name: h.name, args, word: w,
      addr: base + w * 4,
      base: D[fn].map(x => HANDLERS[x].name),
      baseIdx: D[fn],
      hits: hits[(base + w * 4 - isa.THREAD_BASE) >> 2] || 0,
    });
    w += 1 + h.args;
  }
  return ops;
}

// --- per-program census ------------------------------------------------------

async function census(exe, opts) {
  const { runDos } = require('./run-dos');
  const r = await runDos({
    exe,
    budget: opts.budget,
    blockHits: true,
    pitClock: opts.pitClock,
    autoKey: opts.autoKey,
    soundPref: opts.soundPref,
    env: opts.env,
    log: () => {},
  });
  const hits = r.blockHits;
  const T = effects.table();

  let arenaTotal = 0;
  for (let i = 0; i < hits.length; i++) arenaTotal += hits[i];

  const blocks = [];
  let retired = 0, foldable = 0, foldIncDec = 0, loadsTot = 0, storesTot = 0;
  let attributed = 0;
  const barrier = new Map();
  // The same histogram one level finer: class -> handler name -> ops blocked.
  // This is the classifier's own work list. Every gap found while building it
  // showed up here first as a fat row under `other`.
  const barrierByName = new Map();
  const foldByStem = new Map();
  const bump = (m, k, n) => m.set(k, (m.get(k) || 0) + n);

  for (const blk of liveBlocks(r)) {
    const ops = walkBlock(blk, hits);
    if (!ops.length) continue;
    const width = blockWidth(ops);
    const entries = ops[0].hits;

    let bRetired = 0, bFold = 0, bFoldOps = 0, bLoads = 0, bStores = 0;
    let run = 0, best = 0, sawStore = false, aliasSplits = 0;
    const liveOut = new Set();

    // THE UNIT IS A GUEST OP, NOT A COMPILED WORD. A fused word stands for two
    // guest ops and is flattened back into them here, so an `add_ri16_jz` puts
    // a foldable `add` and a barrier `jz` into the census rather than one
    // ambiguous entry -- and the `add` is genuinely foldable, since the branch
    // it was fused with ends the block anyway.
    const flat = [];
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      attributed += o.hits;
      const eff0 = T[o.fn];
      const nLoad = eff0 ? eff0.memRead.length : 0;
      const nStore = eff0 ? eff0.memWrite.length : 0;
      bLoads += o.hits * nLoad;
      bStores += o.hits * nStore;
      // Live-outs, conservatively: every register any op in the block writes.
      if (eff0) {
        for (const e of eff0.regWrite) {
          try { liveOut.add(effects.at(e, blk.prog.words, o.word)); } catch { liveOut.add(-1); }
        }
      }
      const n = o.base.length;
      bRetired += o.hits * n;
      o.classes = [];
      o.width = width;
      for (let k = 0; k < n; k++) {
        const nm = o.base[k];
        let c = classify(nm, width, n === 1 ? o.args : null, T[o.baseIdx[k]]);
        if (c.cls === 'cmp-test') {
          // A compare that feeds the block's terminator is the normal shape,
          // reported as its own class rather than as a failure. One anywhere
          // else in the block is an ordinary flag write and a real barrier.
          const feedsEnd = (k < n - 1) || (i === ops.length - 1);
          c = { cls: feedsEnd ? 'terminator-flags' : 'flags', fold: false };
        }
        o.classes.push(c);
        // Memory effects belong to the compiled word; attribute them to the
        // constituent that is not the branch, which is the one that has them.
        flat.push({ c, hits: o.hits, name: nm, load: k === 0 ? nLoad : 0, store: k === 0 ? nStore : 0 });
      }
    }

    for (const f of flat) {
      if (f.c.fold) {
        // A store, then a load this classifier cannot prove does not alias it,
        // ends the run. It proves nothing about addresses, so every load after
        // a store inside one run splits it.
        if (sawStore && f.load) { best = Math.max(best, run); run = 0; aliasSplits++; sawStore = false; }
        bFold += f.hits; bFoldOps++;
        foldable += f.hits;
        bump(foldByStem, f.c.stem || f.name, f.hits);
        if (/^(inc|dec)/.test(f.name)) foldIncDec += f.hits;
        if (f.store) sawStore = true;
        run++;
      } else {
        best = Math.max(best, run);
        run = 0; sawStore = false;
        bump(barrier, f.c.cls, f.hits);
        if (!barrierByName.has(f.c.cls)) barrierByName.set(f.c.cls, new Map());
        bump(barrierByName.get(f.c.cls), f.name, f.hits);
      }
    }
    best = Math.max(best, run);

    retired += bRetired;
    loadsTot += bLoads;
    storesTot += bStores;
    blocks.push({
      cs: blk.cs, bip: blk.bip, addr: blk.addr, width,
      entries, ops: flat.length, retired: bRetired,
      foldOps: bFoldOps,
      foldRetired: bFold,
      longest: best, aliasSplits,
      liveOut: liveOut.size,
      loads: bLoads, stores: bStores,
      _ops: ops, _prog: blk.prog,
    });
  }

  blocks.sort((a, b) => b.retired - a.retired);

  // Hit-weighted percentiles of the longest run, weighted by block ENTRIES:
  // "how long is the run the machine walks into", not "how long is the longest
  // run in the arena".
  const runs = blocks.map(b => [b.longest, b.entries]).filter(x => x[1] > 0)
    .sort((a, b) => a[0] - b[0]);
  const wTot = runs.reduce((a, b) => a + b[1], 0);
  const pct = (p) => {
    let acc = 0;
    for (const [v, w] of runs) { acc += w; if (acc >= wTot * p) return v; }
    return runs.length ? runs[runs.length - 1][0] : 0;
  };

  const ge4 = blocks.filter(b => b.foldOps >= 4).reduce((a, b) => a + b.retired, 0);

  return {
    exe: path.basename(exe),
    dispatched: r.dispatched,
    compiles: r.compiles, arenaResets: r.arenaResets, handbacks: r.handbacks,
    blocks32: blocks.filter(b => b.width === 32).length,
    liveBlocks: blocks.length,
    arenaDispatches: arenaTotal,
    attributedDispatches: attributed,
    attributedShare: arenaTotal ? attributed / arenaTotal : 0,
    retired,
    foldable,
    foldShare: retired ? foldable / retired : 0,
    foldIncDec,
    incDecShare: retired ? foldIncDec / retired : 0,
    ge4Share: retired ? ge4 / retired : 0,
    runP50: pct(0.5), runP90: pct(0.9),
    runMax: blocks.reduce((a, b) => Math.max(a, b.longest), 0),
    loads: loadsTot, stores: storesTot,
    barrier: [...barrier.entries()].sort((a, b) => b[1] - a[1]),
    barrierByName: Object.fromEntries([...barrierByName.entries()].map(
      ([k, m]) => [k, [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)])),
    foldByStem: [...foldByStem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    top: blocks.slice(0, Math.max(opts.top, opts.show)),
  };
}

// --- reporting ---------------------------------------------------------------

const pc = (x) => `${(100 * x).toFixed(1)}%`;

function report(c, opts) {
  const L = [];
  L.push(`\n=== ${c.exe} -- ${(c.dispatched / 1e6).toFixed(1)}M dispatches, `
    + `${c.liveBlocks} live blocks (${c.blocks32} 32-bit), ${c.compiles} compiles, `
    + `${c.arenaResets} arena reset(s)`);
  L.push(`  retired guest ops in live blocks: ${c.retired.toLocaleString()}`
    + `  (${pc(c.attributedShare)} of arena dispatches attributed)`);
  L.push(`  FOLDABLE       ${String(c.foldable.toLocaleString()).padStart(14)}   ${pc(c.foldShare)}`
    + `   (of which inc/dec ${pc(c.incDecShare)})`);
  L.push(`  in blocks with >=4 foldable ops:  ${pc(c.ge4Share)} of retired ops`);
  L.push(`  longest foldable run, weighted by block entries: `
    + `p50 ${c.runP50}  p90 ${c.runP90}  max ${c.runMax}`);
  L.push(`  memory: ${c.loads.toLocaleString()} loads, ${c.stores.toLocaleString()} stores`);
  L.push('  barriers, by retired ops blocked:');
  for (const [k, n] of c.barrier) {
    L.push(`    ${k.padEnd(18)}${String(n.toLocaleString()).padStart(14)}   ${pc(n / c.retired)}`);
  }
  if (opts.why) {
    L.push('  what each barrier class is made of:');
    for (const [k] of c.barrier) {
      const rows = c.barrierByName[k] || [];
      L.push(`    ${k.padEnd(18)}${rows.map(([n, v]) => `${n} ${pc(v / c.retired)}`).join('  ')}`);
    }
  }
  L.push('  foldable ops by opcode:');
  L.push(`    ${c.foldByStem.map(([k, n]) => `${k} ${pc(n / c.retired)}`).join('  ')}`);

  L.push(`  top ${opts.top} blocks by retired ops:`);
  L.push('       cs:ip      w   entries       ops   fold  longest  liveout  loads  stores   retired');
  for (const b of c.top.slice(0, opts.top)) {
    L.push(`    ${`${b.cs.toString(16)}:${b.bip.toString(16)}`.padEnd(12)}`
      + `${String(b.width).padStart(2)}  ${String(b.entries).padStart(9)} `
      + `${String(b.ops).padStart(9)} ${String(b.foldOps).padStart(6)} `
      + `${String(b.longest).padStart(8)} ${String(b.liveOut).padStart(8)} `
      + `${String(b.loads).padStart(6)} ${String(b.stores).padStart(7)} `
      + `${String(b.retired).padStart(11)}`);
  }

  for (const b of c.top.slice(0, opts.show)) {
    L.push(`\n  --- ${c.exe} block ${b.cs.toString(16)}:${b.bip.toString(16)} `
      + `(${b.width}-bit, ${b.entries} entries, ${b.retired} retired ops, `
      + `longest run ${b.longest}, ${b.liveOut} live-out reg(s))`);
    for (const o of b._ops) {
      const cls = o.classes.map(x => x.cls).join('+');
      L.push(`      0x${o.addr.toString(16)}  ${String(o.hits).padStart(9)}  `
        + `${o.name.padEnd(24)} ${o.args.map(a => (a < 0 ? String(a) : `0x${(a >>> 0).toString(16)}`)).join(' ').padEnd(28)} `
        + `[${cls}]${o.base.length > 1 ? `  = ${o.base.join(' + ')}` : ''}`);
    }
  }
  return L.join('\n');
}

async function main() {
  const exes = ARGV.filter(a => !a.startsWith('--'));
  if (!exes.length) {
    console.log('usage: node tools/toyvm/expr-fold-census.js <exe> [...] '
      + '[--dispatches=20m] [--top=20] [--show=5] [--json=FILE]');
    process.exit(2);
  }
  const opts = {
    budget: count(arg('dispatches'), 20e6),
    top: Number(arg('top', 20)),
    show: Number(arg('show', 5)),
    why: flag('why'),
    pitClock: flag('pit-clock'),
    autoKey: flag('auto-key'),
    soundPref: arg('sound-pref', 'silent'),
    env: arg('env', '').split(';').filter(Boolean),
  };
  const out = [];
  for (const exe of exes) {
    if (!fs.existsSync(exe)) { console.log(`missing: ${exe}`); continue; }
    const c = await census(exe, opts);
    console.log(report(c, opts));
    out.push(c);
  }

  console.log('\n=== summary');
  console.log('  program        retired ops   foldable   >=4-fold   run p50/p90/max   top barrier');
  for (const c of out) {
    const b0 = c.barrier[0] || ['-', 0];
    console.log(`  ${c.exe.padEnd(14)} ${String(c.retired.toLocaleString()).padStart(11)}   `
      + `${pc(c.foldShare).padStart(6)}     ${pc(c.ge4Share).padStart(6)}   `
      + `${`${c.runP50}/${c.runP90}/${c.runMax}`.padStart(12)}   `
      + `${b0[0]} ${pc(b0[1] / c.retired)}`);
  }

  const jf = arg('json');
  if (jf) {
    const strip = (c) => ({ ...c, top: c.top.map(b => {
      const { _ops, _prog, ...rest } = b;
      return { ...rest, opStream: _ops.map(o => ({
        addr: o.addr, hits: o.hits, name: o.name, base: o.base,
        cls: o.classes.map(x => x.cls),
      })) };
    }) });
    fs.writeFileSync(jf, `${JSON.stringify(out.map(strip), null, 1)}\n`);
    console.log(`\nwrote ${jf}`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { census, classify, decompTable, stemOf };
