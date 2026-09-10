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
  HANDLERS, ARITY, prepareTables, FUSE, TRACE, SPIN, PSPIN, NOFLAG, TAKEN_AT,
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
  // `setcc` is a flag READ with a register destination: under `--relax=flags`,
  // where each flag field has a known last writer inside the block, it is the
  // condition expression assigned to a register and folds like any other value.
  if (SETCC_RE.test(name)) return { cls: 'flags', fold: false, relax: 'flags' };
  // These do not. `lahf`/`pushf` want the whole architectural word including
  // the fields nothing in the block wrote, and the BCD group reads AF, which
  // the lazy-flag record does not carry as a value.
  if (/^(lahf|sahf|pushf|popf|pushf32|popf32|clc|stc|cmc|cld|std|cli|sti|salc|daa|das|aaa|aas|aam|aad)$/.test(name)) {
    return { cls: 'flags', fold: false };
  }
  if (stem === 'adc' || stem === 'sbb') return { cls: 'adc-sbb', fold: false, relax: 'flags' };
  if (stem === 'cmp' || stem === 'test') return { cls: 'cmp-test', fold: false, relax: 'flags' };
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

  // Whether the OPCODE is in the fold set at all, kept apart from whether its
  // width matches the block's. The two questions used to be one expression and
  // that made the partial relaxation unreachable: every narrow op fell out with
  // `foldable === false` and nothing downstream could tell an 8-bit `mov` (an
  // insert/extract, and the whole point of `--relax=partial`) from an 8-bit
  // `rol` (not in the set at any width).
  let inSet = false;
  if (ALU_FOLD.has(stem) && form) inSet = true;
  else if (UNARY_FOLD.has(stem) && (form === 'r' || form === 'm')) inSet = true;
  else if (stem === 'lea') inSet = true;
  else if (stem === 'imul2' || stem === 'imul3') inSet = true;
  else if (/^(movzx|movsx)(8|16)$/.test(stem)) {
    // The source width is in the stem, not in `src`: `movzx16_rr32` matches the
    // generic name regex first, so the widening pair has to re-read it here.
    // Getting that wrong filed every 16->32 widening under `other`.
    // A widening op is never `narrow`: its DESTINATION is the block's width.
    const from = Number(/(8|16)$/.exec(stem)[1]);
    inSet = from < width;
  }
  else if (SHIFT_FOLD.has(stem)) {
    // decode.js passes -1 as the operand sentinel for "read the count from CL".
    const byCl = args && args.length && args[args.length - 1] === -1;
    if (byCl) return { cls: 'shift-cl', fold: false };
    inSet = true;
  } else if (SHIFT_ROT.has(stem)) return { cls: 'other', fold: false };

  const foldable = inSet && w === width;

  // A narrow op is foldable ONLY under `--relax=partial`, where AL/AH/AX are
  // modelled as an insert into and an extract out of the full-width local. It
  // still has to be an op whose dataflow this classifier can read: an 8-bit
  // `sh0` (rol) is narrow and is not in the fold set either way, so it stays a
  // hard `partial-reg` with no relaxation offered.
  if (narrow) {
    return inSet && !unreadable
      ? { cls: 'partial-reg', fold: false, relax: 'partial', stem, narrowWidth: w }
      : { cls: 'partial-reg', fold: false, narrowWidth: w };
  }
  if (foldable && unreadable) return { cls: 'other', fold: false };
  if (foldable) return { cls: 'fold', fold: true, stem };
  return { cls: 'other', fold: false };
}

// --- the relaxations ---------------------------------------------------------

// The exact census declines on three things it could in principle model. Each
// is a real piece of compiler work, and the question this file exists to answer
// is which of them is worth doing. So each is a MODE: the same op stream,
// re-classified, with the runs rebuilt.
//
//   alias    a store followed by a load is not a barrier when the two
//            addresses are provably disjoint (see provablyDisjoint below)
//   partial  AL/AH/AX-style narrow writes and 8-bit loads/stores modelled as
//            an insert into / extract out of the full-width local
//   flags    flags as VALUES with a per-field last writer inside the block:
//            cmp/test, setcc, adc/sbb fold; pushf/popf/lahf/sahf, shifts by
//            CL and rcl/rcr stay barriers because they want the architectural
//            word or a carry this analysis does not carry as a value
//
// `exact` and `all` bracket them, and every mode is computed from ONE run:
// re-classifying is a pure pass over the arena, so a mode sweep costs nothing
// but CPU and cannot drift between arms the way four separate runs would.
const RELAXATIONS = ['alias', 'partial', 'flags'];
const MODES = [
  ['exact', new Set()],
  ['alias', new Set(['alias'])],
  ['partial', new Set(['partial'])],
  ['flags', new Set(['flags'])],
  ['all', new Set(RELAXATIONS)],
];

// The memory operand of one compiled op, in the terms the alias rule needs:
// which segment REGISTER the access goes through, which base/index registers
// feed the offset, the constant displacement, and the width touched.
//
// Two shapes exist. Almost every memory op reaches `$ea(mode, disp)` and
// handler-effects.js already resolved both arguments back to arena words, so
// the packed mode word is readable here and decode.js's packEa layout (kind
// 0-3, segment 4-6, ModRM reg 8-10, and the A32 base/index/scale above that)
// says what is in it. The `moffs` pair is the exception: `mov ax,[imm16]`
// carries (offset, segment index) as its own two operands and never builds an
// EA at all.
function addrOf(name, eff, words, wordIdx) {
  const mo = /^mov_(acc_moffs|moffs_acc)(8|16|32)$/.exec(name);
  if (mo) {
    return {
      seg: words[wordIdx + 2] & 7, regs: '', disp: words[wordIdx + 1] >>> 0,
      width: Number(mo[2]),
    };
  }
  if (!eff || eff.address.length !== 1) return null;
  const width = (eff.memRead[0] || eff.memWrite[0] || {}).width || 0;
  if (!width) return null;
  let mode, disp;
  try {
    mode = effects.at(eff.address[0].mode, words, wordIdx);
    disp = effects.at(eff.address[0].disp, words, wordIdx);
  } catch { return null; }
  const kind = mode & 15;
  const seg = (mode >> 4) & 7;
  // `regs` is the non-constant part of the address as a STRING, so two operands
  // compare equal exactly when the same registers feed both. A 16-bit EA kind
  // names its registers by itself (kind 7 is [bx], kind 0 is [bx+si]); kind 8
  // and a based-and-indexless A32 are pure constants and get the empty string,
  // which is what lets two absolute addresses be compared.
  let regs;
  if (kind === isa.EA.A32) {
    const A = isa.EA_A32;
    const nb = !!(mode & A.NO_BASE);
    const ni = !!(mode & A.NO_INDEX);
    regs = nb && ni ? '' : `b${nb ? '-' : (mode >> A.BASE_SHIFT) & 7}`
      + `i${ni ? '-' : (mode >> A.INDEX_SHIFT) & 7}s${(mode >> A.SCALE_SHIFT) & 3}`;
  } else regs = kind === isa.EA.DISP ? '' : `k${kind}`;
  return { seg, regs, disp: disp >>> 0, width };
}

// Can a fold prove this store and this load do not overlap?
//
// THE ASSUMPTIONS, stated because they are the whole content of the rule:
//
//  * Two accesses through DIFFERENT SEGMENT REGISTERS are assumed to alias.
//    In real mode a segment register holds a paragraph number, DS and ES are
//    routinely aimed at overlapping windows, and neither value is a compile-
//    time constant to the decoder -- so `ds:[1000]` and `es:[2000]` can be the
//    same byte and this rule says nothing about them. (A fold that also
//    watched segment loads could sometimes do better; that is a different,
//    bigger analysis and is not modelled.)
//  * Two accesses through the SAME segment register and the same base/index
//    registers differ by exactly their displacements, whatever the registers
//    hold, so a size-aware comparison of the two constants decides it. That
//    covers both cases in the brief: two different constant offsets, and one
//    base register at two non-overlapping displacements.
//  * Everything else -- different base registers, an unreadable operand, a
//    string op, a stack access -- is assumed to alias.
function provablyDisjoint(a, b) {
  if (!a || !b) return false;
  if (a.seg !== b.seg) return false;
  if (a.regs !== b.regs) return false;
  const aw = a.width >> 3;
  const bw = b.width >> 3;
  return (a.disp + aw <= b.disp) || (b.disp + bw <= a.disp);
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

// --- how a block ENDS --------------------------------------------------------

// Three shapes, because they are three different things to a fold.
//
//   self-loop        the terminator's TAKEN edge goes back to this block's own
//                    head. `loop`, `jcxz`, a `dec`/`jnz` pair and a `cmp`/`jcc`
//                    pair all land here -- what matters is where the edge goes,
//                    not which instruction spelled it. A fold over such a block
//                    whose whole body folds is not one dispatch instead of n:
//                    it is one dispatch instead of n PER TURN, which is the
//                    only shape where the ceiling multiplies.
//   interior-branch  a conditional whose taken edge goes somewhere else. The
//                    fold's saving is the block's straight line, once.
//   plain-exit       everything else: `jmp`, `ret`, `call`, `int`, a block that
//                    simply runs off its end into the next.
//
// The taken edge is read out of `TAKEN_AT`, which emit.js maintains for every
// branch handler INCLUDING the fused, traced and spin-collapsed twins -- so a
// loop the compiler already collapsed is still recognisable as one here. The
// operand it names is the taken edge's GUEST ip (the arena word sits one slot
// in front), which is what compares against the block's own `bip`.
const COUNTER_LOOP = /^(loop|loopz|loopnz)(32)?(_.*)?$|^jcxz(32)?(_.*)?$/;
const COUNTER_DEC = /^(inc|dec)_[rm](8|16|32)(_nf)?_j/;
const COUNTER_CMP = /^(cmp|test)_[a-z0-9]+_j|_(cmp|test)/;

function terminatorOf(blk, ops) {
  const last = ops[ops.length - 1];
  const takenAt = TAKEN_AT.get(last.fn);
  const bodyOps = ops.length - 1;
  if (takenAt === undefined) return { cls: 'plain-exit', style: '-', bodyOps, name: last.name };
  const selfLoop = last.args[takenAt] === blk.bip;
  if (!selfLoop) {
    // A bare `jmp` has a TAKEN_AT entry and exactly one successor: it is an
    // unconditional transfer, not a branch that chose.
    const cls = /^jmp/.test(last.name) ? 'plain-exit' : 'interior-branch';
    return { cls, style: '-', bodyOps, name: last.name };
  }
  let style;
  if (COUNTER_LOOP.test(last.name)) style = 'loop';
  else if (COUNTER_DEC.test(last.name)) style = 'dec/jnz';
  else if (COUNTER_CMP.test(last.name)) style = 'cmp/jcc';
  else {
    // A bare Jcc closing the loop: the counter is whatever wrote the flags,
    // which is an op earlier in this block. Look for it rather than guessing.
    const names = ops.slice(0, -1).map(o => o.base.join(' ')).join(' ');
    if (/\b(cmp|test)_/.test(names)) style = 'cmp/jcc';
    else if (/\b(inc|dec)_/.test(names)) style = 'dec/jnz';
    else style = 'other';
  }
  return { cls: 'self-loop', style, bodyOps, name: last.name };
}

// --- one relaxation mode's run accounting ------------------------------------

// Re-walks every block's flat op stream under one set of relaxations and
// produces the numbers a mode row is made of. Split out of census() so that
// exact/alias/partial/flags/all are demonstrably the SAME pass with the same
// weights, differing only in `relax`.
function foldPass(blocks, retired, relax) {
  const bump = (m, k, n) => m.set(k, (m.get(k) || 0) + n);
  const barrier = new Map();
  const barrierByName = new Map();
  const foldByStem = new Map();
  const perBlock = new Map();
  const fullBody = new Set();
  const runLen = new Map();           // longest-run length -> block entries
  let foldable = 0, foldIncDec = 0, highByte = 0, partialTaken = 0;
  let removed = 0, ge4 = 0;

  const folds = (f) => f.c.fold || (f.c.relax && relax.has(f.c.relax));

  for (const b of blocks) {
    let bFold = 0, bFoldOps = 0, best = 0, run = 0, aliasSplits = 0;
    let runHits = 0, headHits = 0;
    // Stores seen since the last barrier, as address descriptors. In exact
    // mode a single `null` stands for "a store happened", which nothing can be
    // disjoint from; that IS the exact rule.
    let pending = [];
    let bodyAllFold = true;

    const closeRun = () => {
      best = Math.max(best, run);
      // What the fold removes: a run of n ops becomes one dispatch, so every
      // op in it past the first stops being dispatched. Hit-weighted, because
      // ops inside one block do not all retire the same number of times.
      if (run > 1) removed += runHits - headHits;
      run = 0; runHits = 0; headHits = 0; pending = [];
    };

    for (const f of b._flat) {
      if (folds(f)) {
        if (f.load && pending.length) {
          // A load after a store. Exact mode splits unconditionally; the alias
          // relaxation splits only if some pending store might overlap it.
          const mayAlias = relax.has('alias')
            ? pending.some(s => !provablyDisjoint(s, f.addr))
            : true;
          if (mayAlias) { closeRun(); aliasSplits++; }
        }
        bFold += f.hits; bFoldOps++;
        foldable += f.hits;
        bump(foldByStem, f.c.stem || f.name, f.hits);
        if (/^(inc|dec)/.test(f.name)) foldIncDec += f.hits;
        if (f.c.relax === 'partial' && relax.has('partial')) {
          partialTaken += f.hits;
          if (f.highByte) highByte += f.hits;
        }
        if (f.store) pending.push(relax.has('alias') ? f.addr : null);
        if (run === 0) headHits = f.hits;
        run++; runHits += f.hits;
      } else {
        closeRun();
        bump(barrier, f.c.cls, f.hits);
        if (!barrierByName.has(f.c.cls)) barrierByName.set(f.c.cls, new Map());
        bump(barrierByName.get(f.c.cls), f.name, f.hits);
        // A block's BODY is everything but the terminator's own branch. A
        // `cmp` fused into the terminator is body: it computes a value the
        // branch consumes, and a fold that models flags folds it.
        if (!(f.isTerm && f.c.cls === 'branch')) bodyAllFold = false;
      }
    }
    closeRun();

    if (bodyAllFold && b._flat.length > 1) fullBody.add(b);
    if (bFoldOps >= 4) ge4 += b.retired;
    if (b.entries > 0) bump(runLen, best, b.entries);
    perBlock.set(b, {
      foldOps: bFoldOps, foldRetired: bFold, longest: best, aliasSplits,
    });
  }

  // Percentiles of the longest run, weighted by block ENTRIES: "how long is the
  // run the machine walks into", not "how long is the longest run in the arena".
  const runs = [...runLen.entries()].sort((a, b) => a[0] - b[0]);
  const wTot = runs.reduce((a, b) => a + b[1], 0);
  const pct = (p) => {
    let acc = 0;
    for (const [v, w] of runs) { acc += w; if (acc >= wTot * p) return v; }
    return runs.length ? runs[runs.length - 1][0] : 0;
  };

  return {
    foldable, foldShare: retired ? foldable / retired : 0,
    foldIncDec,
    ge4, ge4Share: retired ? ge4 / retired : 0,
    runP50: pct(0.5), runP90: pct(0.9),
    runMax: runs.length ? runs[runs.length - 1][0] : 0,
    // The distribution behind those percentiles, as entry-weighted shares.
    runDist: runs.map(([v, w]) => [v, wTot ? w / wTot : 0]),
    removed,
    partialTaken, highByte,
    highByteShare: partialTaken ? highByte / partialTaken : 0,
    barrier: [...barrier.entries()].sort((a, b) => b[1] - a[1]),
    barrierByName, foldByStem, perBlock, fullBody,
  };
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
  let retired = 0, loadsTot = 0, storesTot = 0;
  let attributed = 0;
  const bump = (m, k, n) => m.set(k, (m.get(k) || 0) + n);

  // PHASE ONE: build every block's flat guest-op stream, once. Nothing here
  // depends on the relaxation mode -- classification carries the mode-neutral
  // `relax` tag and the addresses, and the modes are applied in phase two.
  for (const blk of liveBlocks(r)) {
    const ops = walkBlock(blk, hits);
    if (!ops.length) continue;
    const width = blockWidth(ops);
    const entries = ops[0].hits;

    let bRetired = 0, bLoads = 0, bStores = 0;
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
      // The address this op touches, for the alias relaxation, and whether an
      // 8-bit write lands in a HIGH byte -- AH/CH/DH/BH are register indices
      // 4-7 in the 8-bit file, and a high-byte write is the LUT idiom the
      // partial relaxation exists for.
      const addr = addrOf(o.name, eff0, blk.prog.words, o.word);
      let highByte = false;
      if (eff0) {
        for (const e of eff0.regWrite) {
          if (e.width !== 8) continue;
          try { if (effects.at(e, blk.prog.words, o.word) >= 4) highByte = true; } catch { /* unresolved */ }
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
          c = { cls: feedsEnd ? 'terminator-flags' : 'flags', fold: false, relax: 'flags' };
        }
        o.classes.push(c);
        // Memory effects belong to the compiled word; attribute them to the
        // constituent that is not the branch, which is the one that has them.
        flat.push({
          c, hits: o.hits, name: nm,
          load: k === 0 ? nLoad : 0, store: k === 0 ? nStore : 0,
          addr: k === 0 ? addr : null,
          highByte: k === 0 ? highByte : false,
          isTerm: i === ops.length - 1,
        });
      }
    }

    retired += bRetired;
    loadsTot += bLoads;
    storesTot += bStores;
    blocks.push({
      cs: blk.cs, bip: blk.bip, addr: blk.addr, width,
      entries, ops: flat.length, retired: bRetired,
      liveOut: liveOut.size,
      loads: bLoads, stores: bStores,
      term: terminatorOf(blk, ops),
      _flat: flat, _ops: ops, _prog: blk.prog,
    });
  }

  // PHASE TWO: the run accounting, once per mode. Everything a mode can change
  // is here; the op stream above is the same stream in all five.
  const modes = {};
  for (const [mode, relax] of MODES) modes[mode] = foldPass(blocks, retired, relax);
  // `--relax=` names an arbitrary subset. The five above are the sweep; if the
  // subset asked for is not one of them, compute it too and let it drive the
  // per-block listing, so the eyeball dump shows the mode being argued about.
  const key = opts.relax.length ? opts.relax.join('+') : 'exact';
  if (!modes[key]) modes[key] = foldPass(blocks, retired, new Set(opts.relax));
  const exact = modes.exact;
  const { foldable, foldIncDec, barrier, barrierByName, foldByStem } = exact;

  // Blocks carry their EXACT-mode per-block numbers, which is what the top-N
  // listing and the JSON have always reported.
  for (const b of blocks) Object.assign(b, modes[key].perBlock.get(b));
  blocks.sort((a, b) => b.retired - a.retired);

  // --- terminator census, hit-weighted -------------------------------------
  const termShare = new Map();
  const counterStyle = new Map();
  let selfLoopFullyFoldable = 0;
  const selfLoopFullByMode = {};
  for (const mode of Object.keys(modes)) selfLoopFullByMode[mode] = 0;
  for (const b of blocks) {
    bump(termShare, b.term.cls, b.retired);
    if (b.term.cls !== 'self-loop') continue;
    bump(counterStyle, b.term.style, b.retired);
    for (const mode of Object.keys(modes)) {
      if (modes[mode].fullBody.has(b)) selfLoopFullByMode[mode] += b.retired;
    }
  }
  selfLoopFullyFoldable = selfLoopFullByMode.exact;

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
    ge4Share: exact.ge4Share,
    runP50: exact.runP50, runP90: exact.runP90, runMax: exact.runMax,
    loads: loadsTot, stores: storesTot,
    barrier,
    barrierByName: Object.fromEntries([...barrierByName.entries()].map(
      ([k, m]) => [k, [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)])),
    foldByStem: [...foldByStem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    // The relaxation sweep. Each entry is the same shape as `exact`, minus the
    // per-block map, which only the top-N listing needs.
    modeOrder: Object.keys(modes),
    relaxKey: key,
    relaxSet: opts.relax,
    modes: Object.fromEntries(Object.keys(modes).map((m) => {
      const { perBlock, fullBody, barrierByName: bn, foldByStem: fs, ...rest } = modes[m];
      return [m, {
        ...rest,
        removedShare: retired ? rest.removed / retired : 0,
        selfLoopFullShare: retired ? selfLoopFullByMode[m] / retired : 0,
        foldByStem: [...fs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
      }];
    })),
    // The terminator census: hit-weighted share of retired ops per class, the
    // counter style of the self-loops, and the collapsible-loop mass.
    terminators: {
      byClass: [...termShare.entries()].sort((a, b) => b[1] - a[1])
        .map(([k, n]) => [k, n, retired ? n / retired : 0]),
      counterStyle: [...counterStyle.entries()].sort((a, b) => b[1] - a[1])
        .map(([k, n]) => [k, n, retired ? n / retired : 0]),
      collapsibleShare: retired ? selfLoopFullyFoldable / retired : 0,
      collapsibleByMode: Object.fromEntries(Object.keys(modes).map((m) =>
        [m, retired ? selfLoopFullByMode[m] / retired : 0])),
      // Self-loop blocks by body foldable count, the population a collapsing
      // fold would be built for.
      topSelfLoops: blocks.filter(b => b.term.cls === 'self-loop')
        .slice(0, 8)
        .map(b => ({
          cs: b.cs, bip: b.bip, style: b.term.style, entries: b.entries,
          retired: b.retired, bodyOps: b.term.bodyOps, foldOps: b.foldOps,
          longest: b.longest, full: modes.exact.fullBody.has(b),
          fullAll: modes.all.fullBody.has(b),
        })),
    },
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

  // --- how blocks end -------------------------------------------------------
  L.push('  terminator class, by retired ops (hit-weighted):');
  for (const [k, n, s] of c.terminators.byClass) {
    L.push(`    ${k.padEnd(18)}${String(n.toLocaleString()).padStart(14)}   ${pc(s)}`);
  }
  if (c.terminators.counterStyle.length) {
    L.push(`    self-loop counter style: ${c.terminators.counterStyle
      .map(([k, , s]) => `${k} ${pc(s)}`).join('  ')}`);
  }
  L.push(`    COLLAPSIBLE LOOP MASS (self-loop blocks whose whole body folds): `
    + `${pc(c.terminators.collapsibleShare)} exact, `
    + `${pc(c.terminators.collapsibleByMode.all)} with all three relaxations`);
  if (c.terminators.topSelfLoops.length) {
    L.push('    hottest self-loops:  cs:ip / style / entries / body ops / foldable / longest / full-body');
    for (const s of c.terminators.topSelfLoops) {
      L.push(`      ${`${s.cs.toString(16)}:${s.bip.toString(16)}`.padEnd(14)}`
        + `${s.style.padEnd(9)}${String(s.entries).padStart(9)} `
        + `${String(s.bodyOps).padStart(6)} ${String(s.foldOps).padStart(6)} `
        + `${String(s.longest).padStart(6)}   ${s.full ? 'yes' : s.fullAll ? 'with relax' : 'no'}`);
    }
  }

  // --- the relaxation sweep -------------------------------------------------
  L.push('  relaxation modes (same run, same weights, re-classified):');
  L.push('    mode      foldable   >=4-fold   run p50/p90/max   ops undispatched   top remaining barrier');
  for (const m of c.modeOrder) {
    const v = c.modes[m];
    const b0 = v.barrier[0] || ['-', 0];
    L.push(`    ${m.padEnd(9)}${pc(v.foldShare).padStart(7)}    ${pc(v.ge4Share).padStart(7)}   `
      + `${`${v.runP50}/${v.runP90}/${v.runMax}`.padStart(14)}   `
      + `${pc(v.removedShare).padStart(10)}         ${b0[0]} ${pc(b0[1] / c.retired)}`);
  }
  {
    const p = c.modes.partial;
    if (p.partialTaken) {
      L.push(`    partial detail: ${p.partialTaken.toLocaleString()} narrow ops promoted, `
        + `${pc(p.highByteShare)} of them a HIGH-byte (AH/BH/CH/DH) write`);
    }
    const dist = (m) => c.modes[m].runDist.filter(([, s]) => s >= 0.005)
      .map(([v, s]) => `${v}:${(100 * s).toFixed(0)}`).join(' ');
    L.push(`    run-length distribution (len:% of entries) exact   ${dist('exact')}`);
    L.push(`    run-length distribution (len:% of entries) all     ${dist('all')}`);
    L.push('    barriers remaining under all three:');
    for (const [k, n] of c.modes.all.barrier) {
      L.push(`      ${k.padEnd(18)}${String(n.toLocaleString()).padStart(14)}   ${pc(n / c.retired)}`);
    }
  }

  L.push(`  top ${opts.top} blocks by retired ops (fold/longest under \`${c.relaxKey}\`):`);
  L.push('       cs:ip      w   entries       ops   fold  longest  liveout  loads  stores   retired  terminator');
  for (const b of c.top.slice(0, opts.top)) {
    L.push(`    ${`${b.cs.toString(16)}:${b.bip.toString(16)}`.padEnd(14)}`
      + `${String(b.width).padStart(2)}  ${String(b.entries).padStart(9)} `
      + `${String(b.ops).padStart(9)} ${String(b.foldOps).padStart(6)} `
      + `${String(b.longest).padStart(8)} ${String(b.liveOut).padStart(8)} `
      + `${String(b.loads).padStart(6)} ${String(b.stores).padStart(7)} `
      + `${String(b.retired).padStart(11)}  ${b.term.cls}`
      + `${b.term.cls === 'self-loop' ? ` (${b.term.style})` : ''}`);
  }

  for (const b of c.top.slice(0, opts.show)) {
    L.push(`\n  --- ${c.exe} block ${b.cs.toString(16)}:${b.bip.toString(16)} `
      + `(${b.width}-bit, ${b.entries} entries, ${b.retired} retired ops, `
      + `longest run ${b.longest}, ${b.liveOut} live-out reg(s))`);
    for (const o of b._ops) {
      // Under `--relax=`, an op the mode PROMOTES is shown as `fold*` rather
      // than under the barrier class it has in the exact census, so the dump
      // reads as the mode being argued about.
      const cls = o.classes.map(x => (x.fold ? 'fold'
        : x.relax && c.relaxSet.includes(x.relax) ? `fold*(${x.cls})` : x.cls)).join('+');
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
      + '[--dispatches=20m] [--top=20] [--show=5] [--why] '
      + '[--relax=alias,partial,flags] [--json=FILE]');
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
    // `--relax=alias,partial,flags` -- any subset. The five-mode sweep is
    // printed whatever this says; what it selects is which mode drives the
    // per-block listing and the eyeball op dump, so a claim about one
    // relaxation can be checked against the block it is a claim about.
    relax: RELAXATIONS.filter(x => arg('relax', '').split(',').includes(x)),
  };
  const bogus = arg('relax', '').split(',').filter(x => x && !RELAXATIONS.includes(x));
  if (bogus.length) { console.log(`unknown relaxation(s): ${bogus.join(',')}`); process.exit(2); }
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

  // The two cross-program tables the relaxation sweep exists to produce.
  console.log('\n=== terminator class, hit-weighted share of retired ops');
  console.log('  program        self-loop  interior-br  plain-exit   '
    + 'loop  dec/jnz  cmp/jcc  other   COLLAPSIBLE (exact / all)');
  for (const c of out) {
    const t = Object.fromEntries(c.terminators.byClass.map(([k, , s]) => [k, s]));
    const st = Object.fromEntries(c.terminators.counterStyle.map(([k, , s]) => [k, s]));
    const g = (m, k) => pc(m[k] || 0).padStart(7);
    console.log(`  ${c.exe.padEnd(14)}${g(t, 'self-loop')}      ${g(t, 'interior-branch')}     `
      + `${g(t, 'plain-exit')}${g(st, 'loop')}  ${g(st, 'dec/jnz')}  ${g(st, 'cmp/jcc')}  `
      + `${g(st, 'other')}   ${pc(c.terminators.collapsibleShare).padStart(6)} / `
      + `${pc(c.terminators.collapsibleByMode.all).padStart(6)}`);
  }

  console.log('\n=== relaxation sweep: foldable share / >=4-fold share / run p50 / run p90 / ops undispatched');
  const hdr = MODES.map(([m]) => m.padStart(m === 'exact' ? 24 : 24)).join('');
  console.log(`  program       ${hdr}`);
  for (const c of out) {
    const cell = (m) => {
      const v = c.modes[m];
      return `${pc(v.foldShare)}/${pc(v.ge4Share)}/${v.runP50}/${v.runP90}/${pc(v.removedShare)}`
        .padStart(24);
    };
    console.log(`  ${c.exe.padEnd(13)}${MODES.map(([m]) => cell(m)).join('')}`);
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
