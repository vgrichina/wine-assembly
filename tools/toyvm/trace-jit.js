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
const { HANDLERS } = require('./emit');
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
  const owner = (at) => {
    let lo = 0, hi = heads.length - 1, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (heads[mid].addr <= at) { best = heads[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
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
  return { r, ranked, total };
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
  bench = false, iters = 20000, reps = 7, cx = 8, log = () => {},
  passes = { constprop: true, regfold: true, deadflags: true },
} = {}) {
  log(`profiling ${path.basename(exe)} -- ${(budget / 1e6).toFixed(0)}M dispatches, `
    + `${slice} per sample`
    + (sampleAfter ? `, first ${(sampleAfter / 1e6).toFixed(1)}M not sampled` : '')
    + (sampleFrom ? `, last ${((1 - sampleFrom) * 100).toFixed(0)}% of the run profiled` : '') + '\n');
  const { r: rr, ranked, total } = await findHotTrace(exe,
    { budget, slice, cpu, sampleAfter, sampleFrom });
  if (!ranked.length) { log('no samples landed in a known block'); return { ok: false, reason: 'no-samples' }; }

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

  const hot = ranked[0];
  const t = readTrace(hot.prog.words, (hot.addr - hot.prog.arenaBase) >> 2);
  const bytes = guestBytes(rr, hot.cs, hot.bip, 16);
  // Three signatures of a trace compiled out of unwritten memory, because one
  // was not enough. The first version only caught a run of identical
  // (handler, operands) pairs, and cchop.exe walked straight past it with an
  // 11.5x "speedup": its bytes are 13/16 zero, but the zeros decode to
  // `add [bx+si],al` at *advancing* addresses, so the operands differ even
  // though the handler never does. Zero bytes and a run of one handler are
  // each sufficient on their own.
  const zeros = bytes.filter(b => b === 0).length;
  const distinctOps = new Set(t.ops.map(o => o.fn)).size;
  const uniform = t.ops.length > 8
    && (new Set(t.ops.map(o => `${o.fn}:${o.args.join()}`)).size <= 2
      // hit the readTrace cap without ever reaching a terminator, and did it
      // with one or two handlers: a straight run, not a loop body.
      || (t.end === 'too-long' && distinctOps <= 2)
      || zeros >= 12);
  const share = 100 * hot.samples / total;
  const trace = {
    cs: hot.cs, ip: hot.bip, ops: t.ops.length, end: t.end,
    share, samples: total,
    bytes: bytes.map(b => b.toString(16).padStart(2, '0')).join(' '),
  };
  log(`\nhottest trace ${hot.cs.toString(16)}:${hot.bip.toString(16)} `
    + `-- ${t.ops.length} ops, ${share.toFixed(1)}% of samples`);
  log(`  guest bytes: ${trace.bytes}`);
  if (uniform || bytes.every(b => b === 0)) {
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

  let bres;
  try {
    bres = await benchTiers(exe, hot, t.ops, { iters, reps, log, passes });
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
function foldOperands(body, args) {
  let out = body;
  for (let i = 0; i < args.length; i++) {
    const load = new RegExp(
      `\\(local\\.set \\$t${i} \\(i32\\.load offset=${i * 4} \\(global\\.get \\$ip\\)\\)\\)`);
    if (!load.test(out)) return null;              // shape drifted -- refuse rather than guess
    out = out.replace(load, `(local.set $t${i} (i32.const ${args[i] | 0}))`);
  }
  // The thread pointer only exists to find the next op. A trace has no next op
  // to find, so the advance goes too.
  out = out.replace(
    new RegExp(`\\(global\\.set \\$ip \\(i32\\.add \\(global\\.get \\$ip\\) \\(i32\\.const ${args.length * 4}\\)\\)\\)`),
    '');
  return out;
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
  return { wat: bodies.join('\n'), killed, folded, propagated };
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
const { helpers, LOCALS, STATE, EXTRA_GLOBALS } = require('./emit');

function moduleWat(body) {
  const globals = STATE.map(g => `(global $${g} (mut i32) (i32.const 0))`).join('\n');
  const accessors = STATE.map(g => `
(func (export "get_${g}") (result i32) (global.get $${g}))
(func (export "set_${g}") (param $v i32) (global.set $${g} (local.get $v)))`).join('');
  return `(module
(import "host" "memory" (memory ${isa.MEM_PAGES} ${isa.MEM_PAGES}))
(import "host" "port_in" (func $port_in (param i32) (param i32) (result i32)))
(import "host" "port_out" (func $port_out (param i32) (param i32) (param i32)))
(import "host" "fmath" (func $fmath (param i32) (param f64) (param f64) (result f64)))
${globals}
${EXTRA_GLOBALS}
(type $void (func))
${accessors}
${helpers()}
(func (export "spin") (param $k i32) ${LOCALS}
  (block $done (loop $l
    (br_if $done (i32.eqz (local.get $k)))
${body}
    (local.set $k (i32.sub (local.get $k) (i32.const 1)))
    (br $l))))
)`;
}

// Guest RAM only -- the first megabyte. Hashing the whole linear memory would
// include the thread arena, and tier 0 has a compiled program there that the
// generated arms have no reason to contain.
function memHash(mem) {
  let h = 0x811c9dc5;
  for (let i = 0; i < 0x100000; i += 97) h = Math.imul(h ^ mem[i], 0x01000193);
  return (h >>> 0).toString(16);
}

// Lay the trace down as a straight-line arena program: every branch's taken
// target is repointed at its own fall-through, and the trailing jmp closes the
// loop. This is the tier-0 arm and it is what the other two are generated from,
// so all three run one identical op sequence.
function straightLineProgram(ops, base) {
  const words = [];
  const starts = [];
  for (const op of ops) { starts.push(words.length); words.push(op.fn, ...op.args); }
  ops.forEach((op, i) => {
    const w = starts[i];
    const h = HANDLERS[op.fn];
    const nextArena = base + (starts[i + 1] === undefined ? 0 : starts[i + 1]) * 4;
    const nextGuest = ops[i + 1] ? 0 : 0;
    if (h.args === 4 && /^(jz|jnz|jae|jb|ja|jbe|jl|jg|jle|jge|js|jns|jo|jno|jp|jnp|loop)/.test(h.name)) {
      words[w + 1] = nextArena; words[w + 2] = nextGuest;      // taken -> fall through
      words[w + 3] = nextArena; words[w + 4] = nextGuest;
    } else if (h.name === 'jmp') {
      // Terminate rather than loop. Budgeting the interpreter by dispatch count
      // cannot express "k iterations": any op costing more than one dispatch
      // (a rep prefix, a bail) cuts the last iteration short, and a partial
      // iteration is a different computation. Ending the trace makes one run()
      // exactly one iteration, and every arm is then driven one iteration per
      // call so they all pay the same host-call overhead.
      words[w] = HANDLERS.findIndex(x => x.name === 'end');
      words[w + 1] = 0;
      words.length = w + 2;
    }
  });
  return words;
}

async function benchTiers(exe, hot, ops, { iters, reps, log = console.log,
  passes = { constprop: true, regfold: true, deadflags: true } }) {
  const { makeVm } = require('./vm');
  const { compileWat } = require(path.join(__dirname, '..', '..', 'lib', 'compile-wat.js'));

  const t1 = emitTier1(ops, {});
  const t2 = emitTier2(ops, passes);
  log(`\ntier 1: ${ops.length} bodies stitched, operands folded`);
  const passName = ['constprop', 'regfold', 'deadflags'].filter(p => passes[p]).join('+') || 'none';
  log(`tier 2 passes: ${passName}`);
  log(`tier 2: + ${t2.propagated} operand constants propagated, `
    + `${t2.folded} register-file calls folded to direct globals, `
    + `${t2.killed} dead flag computations removed`);

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

  for (const [name, src] of [['tier 1  stitched', t1.wat], ['tier 2  optimized', t2.wat]]) {
    const file = `trace-${name.split(' ')[1]}.wat`;
    const bytes = await compileWat(() => moduleWat(src),
      // The pass set is part of the key: two `--passes=` runs produce different
      // tier-2 modules for the same trace, and a cache hit across them would
      // silently benchmark the previous one.
      { files: [file], cacheKey: `trace-jit:${name}:${hot.bip}:${passName}` });
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
    const ex = inst.exports;
    arms.push({
      name, mem: new Uint8Array(memory.buffer), exports: ex,
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
    const regs = STATE.filter(g => !['ip', 'steps', 'left', 'intno', 'gip', 'halt'].includes(g))
      .map(g => `${g}=${ex[`get_${g}`]() >>> 0}`).join(' ');
    fingerprints.push({ name: arm.name, regs, mem: memHash(arm.vm ? arm.vm.mem : arm.mem) });
  }
  const agree = new Set(fingerprints.map(f => `${f.regs}|${f.mem}`)).size === 1;
  log(`\nagreement after ${iters} iterations: ${agree ? 'ALL THREE MATCH' : 'MISMATCH'}`);
  if (!agree) {
    for (const f of fingerprints) log(`  ${f.name}\n    ${f.regs}\n    mem=${f.mem}`);
    log('\nnot comparable -- an arm that computes something else is not faster.');
    return { agree: false, fingerprints };
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
  log(`  tier 0 -> 2  ${(b0 / t2ns).toFixed(2)}x   total`);
  return {
    agree: true, fingerprints,
    ns: { tier0: b0, tier1: t1ns, tier2: t2ns },
    speedup: { t01: b0 / t1ns, t12: t1ns / t2ns, t02: b0 / t2ns },
    opt: { propagated: t2.propagated, folded: t2.folded, killed: t2.killed },
    iters, reps,
  };
}

module.exports = {
  jitTiers, benchTiers,
  findHotTrace, readTrace, foldOperands, emitTier1, emitTier2,
  foldRegisterFile, killDeadFlags, moduleWat, memHash, straightLineProgram,
};

if (require.main === module) main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
