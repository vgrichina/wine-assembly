#!/usr/bin/env node
'use strict';

// tools/int-expr-region-bench.js — the integer twin of
// tools/x87-realistic-region-bench.js.
//
// QUESTION
// --------
// For an x86 INTEGER basic block with an expression-shaped interior, how much
// does lowering it at decode time to one dataflow expression tree — one
// dispatch per block, intermediates in wasm locals, only live-out registers
// materialized at exit, flags computed only where consumed — save over today's
// per-op handlers, and over pair-fused superinstructions?
//
// METHOD (copied from the x87 bench)
// ----------------------------------
// Standalone generated WAT modules, one per arm. Every arm executes the SAME
// guest program over the SAME architectural state and returns a checksum of
// all of it (eight registers, a memory window, the lazy flag words, the branch
// accumulator, the block budget). The driver asserts every arm agrees and
// throws otherwise — an arm that "wins" by not doing the work fails loudly.
//
// Arms are interleaved with the order rotated every round and the median of
// several warm rounds is taken, because this box sits at load 10-40 and the
// only defensible output is a RATIO between arms measured in one process.
//
// ARMS
//   1 handlers   one call_indirect per guest op. Production-shaped: br_table
//                register file over globals ($get_reg/$set_reg copied from
//                src/03-registers.wat), four flag-global stores per ALU op
//                ($set_flags_add), operands read from a thread-word stream,
//                loads/stores through a g2w-style base add.
//   2 pair-fused adjacent ops greedily fused into two-op handlers, one dispatch
//                per pair, register file still written per op.
//   3 tree       one dispatch selects the whole block. Straight-line in locals;
//                registers loaded at entry, live-out registers written once at
//                exit; flags materialized only where a later op consumes them
//                or for the block's last flag producer.
//   4 tree+      arm 3 over a better-lowered op list: one-operand imul + shrd
//                becomes a single i64 multiply-and-shift, multiply by constant
//                becomes shifts and adds, and four independent lanes become
//                i32x4. Exactness is enforced by the checksum, not asserted.
//   5 direct-mem arm 3 with every local replaced by a scratch GLOBAL. Same
//                dispatch elimination, same flag laziness, same write-back
//                discipline — only the storage class differs, which is what
//                isolates the value of locals from the value of losing
//                dispatch.
//
// The synthetic arm-1 handler shape is CALIBRATED against the real emulator:
// the fixed-point dot shape is injected as x86 into a live wine-assembly
// instance the way tools/bench-loops.js does, and the report states what
// fraction of the real per-op cost the synthetic baseline reproduces.
//
// WHAT THIS DOES NOT MEASURE
// --------------------------
// Like bench-loops.js, a short periodic program lets the BTB predict every
// call_indirect target, so the handler arms are FLATTERED relative to a real
// app's cold dispatch. Every number here is therefore a LOWER BOUND on what
// fusion buys. And nothing here says whether a shape occurs in real code —
// tools/find-loops.js and --handler-hist answer that.
//
// USAGE
//   node tools/int-expr-region-bench.js
//   node tools/int-expr-region-bench.js --no-jsc --no-calibrate
//   INT_EXPR_JSON=/tmp/out.json node tools/int-expr-region-bench.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const ARMS = ['handlers', 'pairfused', 'tree', 'tree_lowered', 'directmem'];
const TRIPS = [1, 4, 64, 256];
const REGS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

// Guest memory map. membase models the g2w fast-path add and is a MUTABLE
// global set at init so no engine can constant-fold it away.
const MEMBASE = 0x1000;
const DATA_A = 0x0000;      // input vector A
const DATA_B = 0x1000;      // input vector B
const DATA_OUT = 0x2000;    // store target, covered by the memory checksum
const PROG_BASE = 0x18000;  // thread-word streams (wasm addresses, not guest)
const CHECK_WORDS = 64;

const med = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// ---------------------------------------------------------------------------
// Guest op vocabulary
// ---------------------------------------------------------------------------
// Each op names its register roles, whether it reads an inline immediate from
// the thread-word stream, and which lazy-flag kind it produces / consumes.
// analyze() and both emitters read this one table, so the arms cannot drift in
// what state they touch (only in how they touch it).

const OPMETA = {
  //                        reads          writes   flags     consumes
  load:         { roles: ['d', 'b'], rd: ['b'],        wr: ['d'],      flags: null,    needs: [] },
  store:        { roles: ['d', 'b'], rd: ['d', 'b'],   wr: [],         flags: null,    needs: [] },
  imul_m:       { roles: ['d', 'b'], rd: ['d', 'b'],   wr: ['d'],      flags: 'mul',   needs: [] },
  imul_i:       { roles: ['d'],      rd: ['d'],        wr: ['d'],      flags: 'mul',   needs: [] },
  imul_i_shift: { roles: ['d'],      rd: ['d'],        wr: ['d'],      flags: 'mul',   needs: [] },
  imul1:        { roles: ['s'],      rd: ['s', 0],     wr: [0, 2],     flags: 'mul',   needs: [] },
  shrd_i:       { roles: [],         rd: [0, 2],       wr: [0],        flags: 'shift', needs: [] },
  imul1_shrd:   { roles: ['s'],      rd: ['s', 0],     wr: [0, 2],     flags: 'shift', needs: [] },
  add_r:        { roles: ['d', 's'], rd: ['d', 's'],   wr: ['d'],      flags: 'add',   needs: [] },
  add_i:        { roles: ['d'],      rd: ['d'],        wr: ['d'],      flags: 'add',   needs: [] },
  sub_r:        { roles: ['d', 's'], rd: ['d', 's'],   wr: ['d'],      flags: 'sub',   needs: [] },
  xor_r:        { roles: ['d', 's'], rd: ['d', 's'],   wr: ['d'],      flags: 'logic', needs: [] },
  and_r:        { roles: ['d', 's'], rd: ['d', 's'],   wr: ['d'],      flags: 'logic', needs: [] },
  or_r:         { roles: ['d', 's'], rd: ['d', 's'],   wr: ['d'],      flags: 'logic', needs: [] },
  sar_i:        { roles: ['d'],      rd: ['d'],        wr: ['d'],      flags: 'shift', needs: [] },
  dec:          { roles: ['d'],      rd: ['d'],        wr: ['d'],      flags: 'dec',   needs: ['cf'] },
  cmp_r:        { roles: ['d', 's'], rd: ['d', 's'],   wr: [],         flags: 'sub',   needs: [] },
  cmp_i:        { roles: ['d'],      rd: ['d'],        wr: [],         flags: 'sub',   needs: [] },
  adc_r:        { roles: ['d', 's'], rd: ['d', 's'],   wr: ['d'],      flags: 'adc',   needs: ['cf'] },
  mov_r:        { roles: ['d', 's'], rd: ['s'],        wr: ['d'],      flags: null,    needs: [] },
  jcc:          { roles: [],         rd: [],           wr: [],         flags: null,    needs: null }, // cc-dependent
  vec_mac:      { roles: [],         rd: [6, 7],       wr: [0],        flags: 'add',   needs: [] },
};

const jccNeeds = cc => (cc === 'nz' ? ['zf'] : ['sf', 'of']);

function opNeeds(op) {
  if (op.kind === 'jcc') return jccNeeds(op.cc);
  return OPMETA[op.kind].needs;
}
function opReads(op) {
  return OPMETA[op.kind].rd.map(r => (typeof r === 'number' ? r : op[r]));
}
function opWrites(op) {
  return OPMETA[op.kind].wr.map(r => (typeof r === 'number' ? r : op[r]));
}

// A handler-table key. jcc gets one entry per condition; everything else takes
// its immediates from the stream, so one entry per kind is enough.
const hkey = op => op.kind + (op.cc ? ':' + op.cc : '');

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------
const o = (kind, f = {}) => ({ kind, ...f });

function chain(n) {
  const kinds = ['add_r', 'xor_r', 'sub_r', 'and_r', 'or_r'];
  return Array.from({ length: n }, (_, i) =>
    o(kinds[i % kinds.length], { d: i % 8, s: (i * 3 + 1) % 8 }));
}

const SHAPES = {
  // EVERY shape must carry a dependency from one trip to the next. A body whose
  // inputs and outputs are identical on each trip is loop-invariant, and an
  // engine is free to hoist the whole thing out of the trip loop in the
  // straight-line arms while the dispatched arms still execute it — which would
  // report a fusion win that is really just dead-code elimination. The pointer
  // steps at the end of `dot` and `vec4` exist for that reason, not for realism.
  dot: {
    describe: 'fixed-point 3-vector dot: 3x (load, imul mem), 2x add, sar 16, store, both pointers stepped',
    ptrs: { 6: DATA_A, 7: DATA_B, 2: DATA_OUT },
    ops: [
      o('load',   { d: 0, b: 6, disp: 0 }),   // mov  eax,[esi]
      o('imul_m', { d: 0, b: 7, disp: 0 }),   // imul eax,[edi]
      o('load',   { d: 3, b: 6, disp: 4 }),   // mov  ebx,[esi+4]
      o('imul_m', { d: 3, b: 7, disp: 4 }),   // imul ebx,[edi+4]
      o('add_r',  { d: 0, s: 3 }),            // add  eax,ebx
      o('load',   { d: 1, b: 6, disp: 8 }),   // mov  ecx,[esi+8]
      o('imul_m', { d: 1, b: 7, disp: 8 }),   // imul ecx,[edi+8]
      o('add_r',  { d: 0, s: 1 }),            // add  eax,ecx
      o('sar_i',  { d: 0, imm: 16 }),         // sar  eax,16
      o('store',  { d: 0, b: 2, disp: 0 }),   // mov  [edx],eax
      o('add_i',  { d: 6, imm: 12 }),         // add  esi,12
      o('add_i',  { d: 7, imm: 12 }),         // add  edi,12
    ],
  },
  addr_loop: {
    describe: 'mixed address loop body: out[i] = in[i]*100 + bias, both pointers stepped, dec/jnz',
    ptrs: { 6: DATA_A, 7: DATA_OUT },
    ops: [
      o('load',   { d: 0, b: 6, disp: 0 }),
      o('imul_i', { d: 0, imm: 100 }),
      o('add_i',  { d: 0, imm: 12345 }),
      o('store',  { d: 0, b: 7, disp: 0 }),
      o('add_i',  { d: 6, imm: 4 }),
      o('add_i',  { d: 7, imm: 4 }),
      o('dec',    { d: 1 }),
      o('jcc',    { cc: 'nz' }),
    ],
    lowered: ops => ops.map(x => (x.kind === 'imul_i'
      // 100 = 64 + 32 + 4. Exact for wrapping i32 multiply by a constant.
      ? o('imul_i_shift', { d: x.d, imm: x.imm, shifts: [6, 5, 2] }) : x)),
  },
  flag_chain: {
    describe: 'three ALU ops then cmp + jl (earlier flags dead, the cmp flags must be right)',
    ptrs: {},
    ops: [
      o('add_r', { d: 0, s: 3 }),
      o('xor_r', { d: 1, s: 2 }),
      o('sub_r', { d: 3, s: 1 }),
      o('cmp_i', { d: 0, imm: 1000 }),
      o('jcc',   { cc: 'l' }),
    ],
  },
  adc_chain: {
    describe: 'add/adc/adc carry chain — the BARRIER control, expected to show little or no gain',
    ptrs: {},
    ops: [
      o('add_r', { d: 0, s: 3 }),
      o('adc_r', { d: 2, s: 1 }),
      o('adc_r', { d: 5, s: 4 }),
    ],
  },
  fixmul64: {
    describe: 'full-width fixed point: one-operand imul (edx:eax) + shrd eax,edx,16, pointer step, dec',
    ptrs: { 6: DATA_A },
    ops: [
      o('imul1',  { s: 3 }),            // imul ebx  -> edx:eax
      o('shrd_i', { imm: 16 }),         // shrd eax,edx,16
      o('add_i',  { d: 6, imm: 4 }),
      o('dec',    { d: 1 }),
    ],
    lowered: ops => [
      o('imul1_shrd', { s: 3, imm: 16 }),
      ops[2], ops[3],
    ],
  },
  vec4: {
    describe: 'four independent lanes: out[i] = in[i]*3 + 7 for i in 0..3, then both pointers stepped (18 ops)',
    ptrs: { 6: DATA_A, 7: DATA_OUT },
    ops: [...[0, 1, 2, 3].flatMap(i => [
      o('load',   { d: 0, b: 6, disp: i * 4 }),
      o('imul_i', { d: 0, imm: 3 }),
      o('add_i',  { d: 0, imm: 7 }),
      o('store',  { d: 0, b: 7, disp: i * 4 }),
    ]), o('add_i', { d: 6, imm: 16 }), o('add_i', { d: 7, imm: 16 })],
    lowered: ops => [o('vec_mac', { n: 4, bin: 6, bout: 7, mul: 3, add: 7, d: 0 }),
      ops[16], ops[17]],
  },
  chain16: { describe: '16 foldable ALU ops, no barrier, no flag consumer', ptrs: {}, ops: chain(16) },
  chain32: { describe: '32 foldable ALU ops, no barrier, no flag consumer', ptrs: {}, ops: chain(32) },
};

// ---------------------------------------------------------------------------
// Decode-time flag analysis (what arms 3/4/5 are allowed to skip)
// ---------------------------------------------------------------------------
// For each flag-producing op, which flags does a later op actually observe?
// A consumer whose nearest preceding producer is outside the block reads the
// loop-carried value, i.e. the previous trip's last producer — so that
// requirement lands both on entry materialization and on the last producer.
// Which of the lazy-flag GLOBALS each flag kind actually writes. This is the
// detail that makes exactness hard and that a naive "materialize the last
// producer" region gets wrong: $set_flags_logic writes only flag_op/flag_res,
// so after `add; ...; xor` the architectural flag_a still belongs to the ADD.
// The region therefore has to know the last writer of each FIELD, not the last
// flag-producing op. (This is what the checksum caught on the `dot` shape.)
const FLAG_FIELDS = {
  add:   ['fop', 'fa', 'fb', 'fres'],
  adc:   ['fop', 'fa', 'fb', 'fres'],
  sub:   ['fop', 'fa', 'fb', 'fres'],
  logic: ['fop', 'fres'],
  shift: ['fop', 'fb', 'fres'],
  mul:   ['fop', 'fb', 'fres'],
  dec:   ['fscf', 'fop', 'fa', 'fb', 'fres'],
};

function analyze(ops) {
  const producers = ops.map((op, i) => (OPMETA[op.kind].flags ? i : -1)).filter(i => i >= 0);
  const last = producers.length ? producers[producers.length - 1] : -1;
  const lastWriter = {};
  ops.forEach((op, i) => {
    const k = OPMETA[op.kind].flags;
    if (k) for (const f of FLAG_FIELDS[k]) lastWriter[f] = i;
  });
  const consumedFrom = new Map();
  const entryFlags = new Set();
  const want = (idx, f) => {
    if (!consumedFrom.has(idx)) consumedFrom.set(idx, new Set());
    consumedFrom.get(idx).add(f);
  };
  ops.forEach((op, c) => {
    for (const f of opNeeds(op)) {
      let p = -1;
      for (const q of producers) if (q < c) p = q;
      if (p >= 0) want(p, f);
      else { entryFlags.add(f); if (last >= 0) want(last, f); }
    }
  });
  const rd = new Set(), wr = new Set();
  for (const op of ops) {
    for (const r of opReads(op)) rd.add(r);
    for (const r of opWrites(op)) wr.add(r);
  }
  const hasJcc = ops.some(x => x.kind === 'jcc');
  return { producers, last, lastWriter, consumedFrom, entryFlags, rd, wr, hasJcc };
}

// ---------------------------------------------------------------------------
// The one op emitter. `C` supplies the storage discipline; the semantics live
// here exactly once so an arm cannot quietly execute a different program.
// ---------------------------------------------------------------------------
function emitOp(op, C) {
  const L = [];
  const t = n => C.t(n), ts = (n, e) => C.tset(n, e);
  const mem = a => `(i32.add (global.get $membase) ${a})`;

  switch (op.kind) {
    case 'load':
      L.push(ts(0, C.rd('b')), ts(1, C.imm()));
      L.push(C.wr('d', `(i32.load ${mem(`(i32.add ${t(0)} ${t(1)})`)})`));
      break;
    case 'store':
      L.push(ts(0, C.rd('b')), ts(1, C.imm()), ts(2, C.rd('d')));
      L.push(`(i32.store ${mem(`(i32.add ${t(0)} ${t(1)})`)} ${t(2)})`);
      break;
    case 'imul_m':
    case 'imul_i': {
      L.push(ts(0, C.rd('d')));
      if (op.kind === 'imul_m') {
        L.push(ts(3, C.imm()), ts(1, `(i32.load ${mem(`(i32.add ${C.rd('b')} ${t(3)})`)})`));
      } else L.push(ts(1, C.imm()));
      L.push(C.p64set(`(i64.mul (i64.extend_i32_s ${t(0)}) (i64.extend_i32_s ${t(1)}))`));
      L.push(ts(2, `(i32.wrap_i64 ${C.p64()})`));
      L.push(C.wr('d', t(2)));
      L.push(C.flags('mul', { a: t(0), b: t(1), res: t(2),
        ovf: `(i64.ne (i64.extend_i32_s ${t(2)}) ${C.p64()})` }));
      break;
    }
    case 'imul_i_shift': {
      // Exact wrapping multiply by a constant, as shifts and adds. The i64
      // product is still formed for CF/OF, but only when something reads them.
      L.push(ts(0, C.rd('d')), ts(1, C.imm()));
      const sum = op.shifts.map(k => `(i32.shl ${t(0)} (i32.const ${k}))`)
        .reduce((a, b) => `(i32.add ${a} ${b})`);
      L.push(ts(2, sum));
      L.push(C.wr('d', t(2)));
      L.push(C.flags('mul', { a: t(0), b: t(1), res: t(2),
        ovf: `(i64.ne (i64.extend_i32_s ${t(2)}) (i64.mul (i64.extend_i32_s ${t(0)}) (i64.extend_i32_s ${t(1)})))` }));
      break;
    }
    case 'imul1': {
      L.push(ts(0, C.rdReg(0)), ts(1, C.rd('s')));
      L.push(C.p64set(`(i64.mul (i64.extend_i32_s ${t(0)}) (i64.extend_i32_s ${t(1)}))`));
      L.push(ts(2, `(i32.wrap_i64 ${C.p64()})`));
      L.push(ts(3, `(i32.wrap_i64 (i64.shr_u ${C.p64()} (i64.const 32)))`));
      L.push(C.wrReg(0, t(2)), C.wrReg(2, t(3)));
      L.push(C.flags('mul', { a: t(0), b: t(1), res: t(2),
        ovf: `(i64.ne (i64.extend_i32_s ${t(2)}) ${C.p64()})` }));
      break;
    }
    case 'shrd_i': {
      L.push(ts(0, C.rdReg(0)), ts(1, C.rdReg(2)), ts(2, C.imm()));
      L.push(ts(3, `(i32.or (i32.shr_u ${t(0)} ${t(2)})
        (i32.shl ${t(1)} (i32.sub (i32.const 32) ${t(2)})))`));
      L.push(C.wrReg(0, t(3)));
      L.push(C.flags('shift', { res: t(3),
        cf: `(i32.and (i32.shr_u ${t(0)} (i32.sub ${t(2)} (i32.const 1))) (i32.const 1))` }));
      break;
    }
    case 'imul1_shrd': {
      // imul r32 followed by shrd eax,edx,n is exactly bits n..n+31 of the
      // 64-bit product — one i64 multiply and one shift, no recombination.
      L.push(ts(0, C.rdReg(0)), ts(1, C.rd('s')), ts(2, C.imm()));
      L.push(C.p64set(`(i64.mul (i64.extend_i32_s ${t(0)}) (i64.extend_i32_s ${t(1)}))`));
      L.push(ts(3, `(i32.wrap_i64 (i64.shr_u ${C.p64()} (i64.extend_i32_u ${t(2)})))`));
      L.push(ts(4, `(i32.wrap_i64 (i64.shr_u ${C.p64()} (i64.const 32)))`));
      L.push(C.wrReg(0, t(3)), C.wrReg(2, t(4)));
      L.push(C.flags('shift', { res: t(3),
        cf: `(i32.and (i32.shr_u (i32.wrap_i64 ${C.p64()}) (i32.sub ${t(2)} (i32.const 1))) (i32.const 1))` }));
      break;
    }
    case 'add_r': case 'add_i': case 'sub_r':
    case 'xor_r': case 'and_r': case 'or_r': {
      const wasm = { add_r: 'i32.add', add_i: 'i32.add', sub_r: 'i32.sub',
        xor_r: 'i32.xor', and_r: 'i32.and', or_r: 'i32.or' }[op.kind];
      L.push(ts(0, C.rd('d')), ts(1, op.kind === 'add_i' ? C.imm() : C.rd('s')));
      L.push(ts(2, `(${wasm} ${t(0)} ${t(1)})`));
      L.push(C.wr('d', t(2)));
      L.push(C.flags(OPMETA[op.kind].flags, { a: t(0), b: t(1), res: t(2) }));
      break;
    }
    case 'sar_i':
      L.push(ts(0, C.rd('d')), ts(1, C.imm()));
      L.push(ts(2, `(i32.shr_s ${t(0)} ${t(1)})`));
      L.push(C.wr('d', t(2)));
      L.push(C.flags('shift', { res: t(2),
        cf: `(i32.and (i32.shr_s ${t(0)} (i32.sub ${t(1)} (i32.const 1))) (i32.const 1))` }));
      break;
    case 'dec':
      L.push(ts(0, C.rd('d')), ts(2, `(i32.sub ${t(0)} (i32.const 1))`));
      L.push(C.wr('d', t(2)));
      L.push(C.flags('dec', { a: t(0), b: '(i32.const 1)', res: t(2) }));
      break;
    case 'cmp_r': case 'cmp_i':
      L.push(ts(0, C.rd('d')), ts(1, op.kind === 'cmp_i' ? C.imm() : C.rd('s')));
      L.push(ts(2, `(i32.sub ${t(0)} ${t(1)})`));
      L.push(C.flags('sub', { a: t(0), b: t(1), res: t(2) }));
      break;
    case 'adc_r':
      // b_eff = b + CF, then add — and production's raw-mode CF fixup when
      // b_eff wrapped. This is the barrier the brief asks us to keep honest.
      L.push(ts(0, C.rd('d')), ts(1, C.rd('s')));
      L.push(ts(3, `(i32.add ${t(1)} ${C.cf()})`));
      L.push(ts(2, `(i32.add ${t(0)} ${t(3)})`));
      L.push(C.wr('d', t(2)));
      L.push(C.flags('adc', { a: t(0), b: t(3), res: t(2), braw: t(1) }));
      break;
    case 'mov_r':
      L.push(C.wr('d', C.rd('s')));
      break;
    case 'jcc': {
      const cond = op.cc === 'nz'
        ? `(i32.eqz ${C.zf()})`
        : `(i32.ne ${C.sf()} ${C.of()})`;
      L.push(C.bacc(cond));
      break;
    }
    case 'vec_mac': {
      // Four independent lanes in one i32x4 multiply-add. i32x4.mul wraps per
      // lane exactly like four 32-bit imuls, so this is exact, not relaxed.
      L.push(ts(0, C.rdReg(op.bin)), ts(1, C.rdReg(op.bout)));
      L.push(C.vset(0, `(v128.load ${mem(t(0))})`));
      L.push(C.vset(1, `(i32x4.mul ${C.v(0)} (i32x4.splat (i32.const ${op.mul})))`));
      L.push(C.vset(2, `(i32x4.add ${C.v(1)} (i32x4.splat (i32.const ${op.add})))`));
      L.push(`(v128.store ${mem(t(1))} ${C.v(2)})`);
      L.push(ts(2, `(i32x4.extract_lane 3 ${C.v(2)})`));
      L.push(ts(3, `(i32x4.extract_lane 3 ${C.v(1)})`));
      L.push(C.wrReg(op.d, t(2)));
      L.push(C.flags('add', { a: t(3), b: `(i32.const ${op.add})`, res: t(2) }));
      break;
    }
    default: throw new Error(`emitOp: ${op.kind}`);
  }
  return L.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Shared module preamble: architectural state and the production-shaped
// register file / lazy flag helpers, copied in shape from src/03-registers.wat.
// ---------------------------------------------------------------------------
function preamble() {
  const regGlobals = REGS.map(r => `(global $${r} (mut i32) (i32.const 0))`).join(' ');
  return `
  ${regGlobals}
  (global $flag_op (mut i32) (i32.const 0)) (global $flag_a (mut i32) (i32.const 0))
  (global $flag_b (mut i32) (i32.const 0)) (global $flag_res (mut i32) (i32.const 0))
  (global $flag_ss (mut i32) (i32.const 31)) (global $saved_cf (mut i32) (i32.const 0))
  (global $membase (mut i32) (i32.const 0))
  (global $budget (mut i32) (i32.const 0)) (global $bacc (mut i32) (i32.const 0))
  (global $pc (mut i32) (i32.const 0))

  ;; br_table register file, not a compare chain — same shape as production.
  (func $get_reg (param $r i32) (result i32)
    (block $edi (block $esi (block $ebp (block $esp
      (block $ebx (block $edx (block $ecx (block $eax
        (br_table $eax $ecx $edx $ebx $esp $ebp $esi $edi (local.get $r)))
        (return (global.get $eax))) (return (global.get $ecx)))
        (return (global.get $edx))) (return (global.get $ebx)))
        (return (global.get $esp))) (return (global.get $ebp)))
        (return (global.get $esi)))
    (global.get $edi))
  (func $set_reg (param $r i32) (param $v i32)
    (block $edi (block $esi (block $ebp (block $esp
      (block $ebx (block $edx (block $ecx (block $eax
        (br_table $eax $ecx $edx $ebx $esp $ebp $esi $edi (local.get $r)))
        (global.set $eax (local.get $v)) (return))
        (global.set $ecx (local.get $v)) (return))
        (global.set $edx (local.get $v)) (return))
        (global.set $ebx (local.get $v)) (return))
        (global.set $esp (local.get $v)) (return))
        (global.set $ebp (local.get $v)) (return))
        (global.set $esi (local.get $v)) (return))
    (global.set $edi (local.get $v)))

  (func $set_flags_add (param $a i32) (param $b i32) (param $r i32)
    (global.set $flag_op (i32.const 1)) (global.set $flag_ss (i32.const 31))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (local.get $b))
    (global.set $flag_res (local.get $r)))
  (func $set_flags_sub (param $a i32) (param $b i32) (param $r i32)
    (global.set $flag_op (i32.const 2)) (global.set $flag_ss (i32.const 31))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (local.get $b))
    (global.set $flag_res (local.get $r)))
  (func $set_flags_logic (param $r i32)
    (global.set $flag_op (i32.const 3)) (global.set $flag_ss (i32.const 31))
    (global.set $flag_res (local.get $r)))
  (func $set_flags_shift (param $r i32) (param $cf i32)
    (global.set $flag_op (i32.const 7)) (global.set $flag_ss (i32.const 31))
    (global.set $flag_res (local.get $r)) (global.set $flag_b (local.get $cf)))
  (func $set_flags_mul (param $r i32) (param $ovf i32)
    (global.set $flag_op (i32.const 6)) (global.set $flag_ss (i32.const 31))
    (global.set $flag_res (local.get $r)) (global.set $flag_b (local.get $ovf)))
  (func $set_flags_dec (param $a i32) (param $r i32)
    (global.set $saved_cf (call $get_cf))
    (global.set $flag_op (i32.const 5)) (global.set $flag_ss (i32.const 31))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (i32.const 1))
    (global.set $flag_res (local.get $r)))

  (func $get_zf (result i32) (i32.eqz (global.get $flag_res)))
  (func $get_sf (result i32) (i32.and (i32.shr_u (global.get $flag_res) (global.get $flag_ss)) (i32.const 1)))
  (func $get_cf (result i32)
    (if (result i32) (i32.eq (global.get $flag_op) (i32.const 1))
      (then (i32.lt_u (global.get $flag_res) (global.get $flag_a)))
    (else (if (result i32) (i32.eq (global.get $flag_op) (i32.const 2))
      (then (i32.lt_u (global.get $flag_a) (global.get $flag_b)))
    (else (if (result i32) (i32.eq (global.get $flag_op) (i32.const 5))
      (then (global.get $saved_cf))
    (else (if (result i32) (i32.eq (global.get $flag_op) (i32.const 6))
      (then (global.get $flag_b))
    (else (if (result i32) (i32.eq (global.get $flag_op) (i32.const 7))
      (then (global.get $flag_b))
    (else (if (result i32) (i32.eq (global.get $flag_op) (i32.const 8))
      (then (global.get $flag_a))
    (else (i32.const 0))))))))))))))
  (func $get_of (result i32)
    (local $sa i32) (local $sb i32) (local $sr i32)
    (if (i32.eq (global.get $flag_op) (i32.const 8)) (then (return (global.get $flag_b))))
    (if (i32.eq (global.get $flag_op) (i32.const 6)) (then (return (global.get $flag_b))))
    (local.set $sa (i32.and (i32.shr_u (global.get $flag_a) (global.get $flag_ss)) (i32.const 1)))
    (local.set $sb (i32.and (i32.shr_u (global.get $flag_b) (global.get $flag_ss)) (i32.const 1)))
    (local.set $sr (i32.and (i32.shr_u (global.get $flag_res) (global.get $flag_ss)) (i32.const 1)))
    (if (result i32) (i32.eq (global.get $flag_op) (i32.const 1))
      (then (i32.and (i32.eq (local.get $sa) (local.get $sb)) (i32.ne (local.get $sa) (local.get $sr))))
    (else (if (result i32) (i32.or (i32.eq (global.get $flag_op) (i32.const 2))
                                   (i32.eq (global.get $flag_op) (i32.const 5)))
      (then (i32.and (i32.ne (local.get $sa) (local.get $sb)) (i32.eq (local.get $sb) (local.get $sr))))
    (else (i32.const 0))))))

  (func $read_word (result i32) (local $p i32)
    (local.set $p (global.get $pc))
    (global.set $pc (i32.add (local.get $p) (i32.const 4)))
    (i32.load (local.get $p)))

  ;; Seeded architectural state. Identical in every arm, so it is common-mode.
  (func $seed_state (param $seed i32)
    (global.set $eax (local.get $seed))
    (global.set $ecx (i32.add (i32.const 1000000) (i32.and (local.get $seed) (i32.const 7))))
    (global.set $edx (i32.const 0x243f6a88))
    (global.set $ebx (i32.const 0x9e3779b9))
    (global.set $esp (i32.const 0x3f00))
    (global.set $ebp (i32.const 0xb7e15162))
    (global.set $esi (i32.xor (local.get $seed) (i32.const 0x85a308d3)))
    (global.set $edi (i32.const 0x13198a2e))
    (global.set $flag_op (i32.const 1)) (global.set $flag_ss (i32.const 31))
    (global.set $flag_a (local.get $seed)) (global.set $flag_b (i32.const 3))
    (global.set $flag_res (i32.add (local.get $seed) (i32.const 3)))
    (global.set $saved_cf (i32.and (local.get $seed) (i32.const 1)))
    (global.set $bacc (i32.const 1))
    (global.set $budget (i32.const 1000000)))

  ;; Every observable point: eight registers, the lazy flag words, the branch
  ;; accumulator, the budget and a window of guest memory.
  (func $checksum (result i64)
    (local $s i64) (local $i i32)
    ${REGS.map(r => `(local.set $s (i64.add (i64.mul (local.get $s) (i64.const 31)) (i64.extend_i32_u (global.get $${r}))))`).join('\n')}
    ${['flag_op', 'flag_a', 'flag_b', 'flag_res', 'flag_ss', 'saved_cf', 'bacc', 'budget']
      .map(g => `(local.set $s (i64.add (i64.mul (local.get $s) (i64.const 31)) (i64.extend_i32_u (global.get $${g}))))`).join('\n')}
    (block $d (loop $l (br_if $d (i32.ge_u (local.get $i) (i32.const ${CHECK_WORDS})))
      (local.set $s (i64.add (i64.mul (local.get $s) (i64.const 31))
        (i64.extend_i32_u (i32.load (i32.add (i32.const ${MEMBASE + DATA_OUT}) (i32.shl (local.get $i) (i32.const 2)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (local.get $s))

  (func (export "init")
    (local $i i32)
    (global.set $membase (i32.const ${MEMBASE}))
    (block $d (loop $l (br_if $d (i32.ge_u (local.get $i) (i32.const 1024)))
      (i32.store (i32.add (i32.const ${MEMBASE + DATA_A}) (i32.shl (local.get $i) (i32.const 2)))
        (i32.add (i32.mul (local.get $i) (i32.const 2654435761)) (i32.const 12345)))
      (i32.store (i32.add (i32.const ${MEMBASE + DATA_B}) (i32.shl (local.get $i) (i32.const 2)))
        (i32.add (i32.mul (local.get $i) (i32.const 40503)) (i32.const 7)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l))))
  (func (export "checksum") (result i64) (call $checksum))`;
}

// Per-trip pressure that every arm pays identically: a block budget decremented
// once per block entry, with a periodic check. A block that costs nothing still
// costs this.
const budgetStep = `
    (global.set $budget (i32.sub (global.get $budget) (i32.const 1)))
    (if (i32.le_s (global.get $budget) (i32.const 0))
      (then (global.set $budget (i32.const 1000000))))`;

function ptrInit(shape) {
  return Object.entries(shape.ptrs).map(([r, addr]) =>
    `(global.set $${REGS[+r]} (i32.const ${addr}))`).join(' ');
}

function measureWrapper(name) {
  return `(func (export "${name}_measure") (param $reps i32) (param $trips i32) (param $seed i32) (result i64)
    (local $n i32) (local $s i64)
    (block $d (loop $l (br_if $d (i32.ge_u (local.get $n) (local.get $reps)))
      ;; Order-sensitive mix, not xor: an xor fold cancels to 0 for some
      ;; rep counts, and a zero checksum makes the cross-arm assert vacuous.
      (local.set $s (i64.add (i64.mul (local.get $s) (i64.const 1000003))
        (call $${name} (local.get $trips) (i32.add (local.get $seed) (local.get $n)))))
      (local.set $n (i32.add (local.get $n) (i32.const 1))) (br $l)))
    (local.get $s))`;
}

// ---------------------------------------------------------------------------
// Arms 1 and 2: dispatched handlers
// ---------------------------------------------------------------------------
// The handler context. Register roles come out of the operand word at runtime
// (so every access really is a br_table), immediates come out of the thread
// stream, and flags are stored eagerly through the production helpers.
function handlerCtx() {
  const idx = { d: 0, s: 3, b: 6 };
  return {
    role: 'op',
    rd: r => `(call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const ${idx[r]})) (i32.const 7)))`,
    wr: (r, e) => `(call $set_reg (i32.and (i32.shr_u (local.get $op) (i32.const ${idx[r]})) (i32.const 7)) ${e})`,
    rdReg: n => `(call $get_reg (i32.const ${n}))`,
    wrReg: (n, e) => `(call $set_reg (i32.const ${n}) ${e})`,
    imm: () => '(call $read_word)',
    t: n => `(local.get $t${n})`,
    tset: (n, e) => `(local.set $t${n} ${e})`,
    p64: () => '(local.get $p)',
    p64set: e => `(local.set $p ${e})`,
    v: n => `(local.get $v${n})`,
    vset: (n, e) => `(local.set $v${n} ${e})`,
    cf: () => '(call $get_cf)',
    zf: () => '(call $get_zf)',
    sf: () => '(call $get_sf)',
    of: () => '(call $get_of)',
    bacc: c => `(global.set $bacc (i32.xor (i32.mul (global.get $bacc) (i32.const 3)) ${c}))`,
    flags: (kind, v) => {
      switch (kind) {
        case 'add': return `(call $set_flags_add ${v.a} ${v.b} ${v.res})`;
        case 'sub': return `(call $set_flags_sub ${v.a} ${v.b} ${v.res})`;
        case 'logic': return `(call $set_flags_logic ${v.res})`;
        case 'shift': return `(call $set_flags_shift ${v.res} ${v.cf})`;
        case 'mul': return `(call $set_flags_mul ${v.res} ${v.ovf})`;
        case 'dec': return `(call $set_flags_dec ${v.a} ${v.res})`;
        case 'adc': return `(call $set_flags_add ${v.a} ${v.b} ${v.res})
          (if (i32.lt_u ${v.b} ${v.braw}) (then
            (global.set $flag_op (i32.const 8)) (global.set $flag_a (i32.const 1))
            (global.set $flag_b (i32.const 0))))`;
        default: return '';
      }
    },
  };
}

const HANDLER_LOCALS = '(local $t0 i32) (local $t1 i32) (local $t2 i32) (local $t3 i32) (local $t4 i32) (local $p i64)';

function buildHandlerTable(shapeOpLists, fused) {
  const single = new Map();   // hkey -> index
  const pairs = new Map();    // key  -> index
  const bodies = [];
  const addSingle = op => {
    const k = hkey(op);
    if (!single.has(k)) {
      single.set(k, bodies.length);
      bodies.push({ name: `h_${bodies.length}`, body: emitOp(op, handlerCtx()), comment: k });
    }
    return single.get(k);
  };
  const addPair = (a, b) => {
    const k = `${hkey(a)}|${hkey(b)}`;
    if (!pairs.has(k)) {
      const C = handlerCtx();
      const second = emitOp(b, {
        ...C,
        rd: r => C.rd(r).replace('local.get $op', 'local.get $op2'),
        wr: (r, e) => C.wr(r, e).replace('local.get $op', 'local.get $op2'),
      });
      pairs.set(k, bodies.length);
      bodies.push({
        name: `h_${bodies.length}`,
        body: `${emitOp(a, C)}\n(local.set $op2 (call $read_word))\n${second}`,
        comment: k,
      });
    }
    return pairs.get(k);
  };
  // Every op / pair that occurs anywhere gets exactly one table slot.
  const encode = ops => {
    const words = [];
    if (!fused) {
      for (const op of ops) {
        words.push({ w: (addSingle(op) << 16) | operandWord(op) });
        for (const im of immWords(op)) words.push({ w: im });
      }
    } else {
      for (let i = 0; i < ops.length;) {
        if (i + 1 < ops.length) {
          const a = ops[i], b = ops[i + 1];
          words.push({ w: (addPair(a, b) << 16) | operandWord(a) });
          for (const im of immWords(a)) words.push({ w: im });
          words.push({ w: operandWord(b) });
          for (const im of immWords(b)) words.push({ w: im });
          i += 2;
        } else {
          const op = ops[i];
          words.push({ w: (addSingle(op) << 16) | operandWord(op) });
          for (const im of immWords(op)) words.push({ w: im });
          i += 1;
        }
      }
    }
    return words.map(x => x.w);
  };
  const programs = new Map();
  for (const [name, ops] of shapeOpLists) programs.set(name, encode(ops));
  return { bodies, programs };
}

function operandWord(op) {
  return ((op.d || 0) & 7) | (((op.s || 0) & 7) << 3) | (((op.b || 0) & 7) << 6);
}
// The immediates an op pulls out of the thread stream, in the order emitOp
// reads them. `imul_m` reads its displacement AFTER the destination register.
function immWords(op) {
  switch (op.kind) {
    case 'load': case 'store': case 'imul_m': return [op.disp | 0];
    case 'imul_i': case 'imul_i_shift': case 'add_i': case 'cmp_i':
    case 'sar_i': case 'shrd_i': case 'imul1_shrd': return [op.imm | 0];
    default: return [];
  }
}

function emitDispatchArm(fused) {
  const lists = Object.entries(SHAPES).map(([n, s]) => [n, s.ops]);
  const { bodies, programs } = buildHandlerTable(lists, fused);
  const handlerWat = bodies.map(b =>
    `(func $${b.name} (param $op i32) ${HANDLER_LOCALS} ${fused ? '(local $op2 i32)' : ''}\n;; ${b.comment}\n${b.body})`).join('\n');
  const table = `(type $ht (func (param i32)))
  (table ${bodies.length} funcref)
  (elem (i32.const 0) ${bodies.map(b => `$${b.name}`).join(' ')})`;

  const data = [], funcs = [];
  let off = PROG_BASE;
  for (const [name, words] of programs) {
    const start = off, end = off + words.length * 4;
    off = end + 16;
    data.push(`(data (i32.const ${start}) "${words.map(w =>
      [w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255]
        .map(b => `\\${b.toString(16).padStart(2, '0')}`).join('')).join('')}")`);
    funcs.push(`(func $${name} (param $trips i32) (param $seed i32) (result i64)
      (local $i i32) (local $w i32)
      (call $seed_state (local.get $seed)) ${ptrInit(SHAPES[name])}
      (block $done (loop $trip (br_if $done (i32.ge_u (local.get $i) (local.get $trips)))
        ${budgetStep}
        (global.set $pc (i32.const ${start}))
        (block $obs (loop $ops
          (br_if $obs (i32.ge_u (global.get $pc) (i32.const ${end})))
          (local.set $w (i32.load (global.get $pc)))
          (global.set $pc (i32.add (global.get $pc) (i32.const 4)))
          (call_indirect (type $ht) (i32.and (local.get $w) (i32.const 0xFFFF))
            (i32.shr_u (local.get $w) (i32.const 16)))
          (br $ops)))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $trip)))
      (call $checksum))
    ${measureWrapper(name)}`);
  }
  return `(module (memory 8) ${preamble()} ${table} ${data.join('\n')} ${handlerWat}\n${funcs.join('\n')})`;
}

// ---------------------------------------------------------------------------
// Arms 3, 4, 5: straight-line regions
// ---------------------------------------------------------------------------
// `storage` picks locals or scratch globals for every intermediate. That is
// the ONLY difference between the tree arm and the direct-memory control.
function straightCtx(ops, info, storage, prefix) {
  const g = storage === 'global';
  const ref = n => (g ? `(global.get $${prefix}${n})` : `(local.get $${prefix}${n})`);
  const set = (n, e) => (g ? `(global.set $${prefix}${n} ${e})` : `(local.set $${prefix}${n} ${e})`);
  const C = {
    idx: 0, immSeen: 0,
    ref, set,
    // Register roles and immediates are resolved at DECODE time — that, plus
    // the flag analysis, is the whole difference from the handler arms.
    rd: r => ref(REGS[roleReg(ops[C.idx], r)]),
    wr: (r, e) => set(REGS[roleReg(ops[C.idx], r)], e),
    imm: () => `(i32.const ${immWords(ops[C.idx])[C.immSeen++] | 0})`,
    rdReg: n => ref(REGS[n]),
    wrReg: (n, e) => set(REGS[n], e),
    t: n => ref(`t${n}`),
    tset: (n, e) => set(`t${n}`, e),
    p64: () => ref('p'),
    p64set: e => set('p', e),
    v: n => `(local.get $${prefix}v${n})`,
    vset: (n, e) => `(local.set $${prefix}v${n} ${e})`,
    cf: () => ref('cf'),
    zf: () => ref('zf'),
    sf: () => ref('sf'),
    of: () => ref('of'),
    bacc: c => set('bacc', `(i32.xor (i32.mul ${ref('bacc')} (i32.const 3)) ${c})`),
    flags: (kind, v) => flagsStatic(kind, v, C, info, set, ref),
  };
  return C;
}
function roleReg(op, r) {
  const v = op[r];
  if (typeof v !== 'number') throw new Error(`role ${r} missing on ${op.kind}`);
  return v;
}

// The lazy-flag decision, made at decode time. Nothing is written unless a
// later op in the block reads it, or this is the block's last flag producer
// (whose state has to survive to the exported checksum).
function flagsStatic(kind, v, C, info, set, ref) {
  if (!kind) return '';
  const i = C.idx;
  const needs = info.consumedFrom.get(i) || new Set();
  const owns = f => info.lastWriter[f] === i;
  const L = [];
  const sign = e => `(i32.and (i32.shr_u ${e} (i32.const 31)) (i32.const 1))`;
  let cfExpr = null, ofExpr = null;
  if (kind === 'add' || kind === 'adc') {
    cfExpr = `(i32.lt_u ${v.res} ${v.a})`;
    ofExpr = `(i32.and (i32.eq ${sign(v.a)} ${sign(v.b)}) (i32.ne ${sign(v.a)} ${sign(v.res)}))`;
    if (kind === 'adc') cfExpr = `(if (result i32) (i32.lt_u ${v.b} ${v.braw}) (then (i32.const 1)) (else ${cfExpr}))`;
  } else if (kind === 'sub' || kind === 'dec') {
    cfExpr = kind === 'dec' ? ref('cf') : `(i32.lt_u ${v.a} ${v.b})`;
    ofExpr = `(i32.and (i32.ne ${sign(v.a)} ${sign(v.b)}) (i32.eq ${sign(v.b)} ${sign(v.res)}))`;
  } else if (kind === 'logic') { cfExpr = '(i32.const 0)'; ofExpr = '(i32.const 0)'; }
  else if (kind === 'shift') { cfExpr = v.cf; ofExpr = '(i32.const 0)'; }
  else if (kind === 'mul') { cfExpr = v.ovf; ofExpr = v.ovf; }

  // dec reads CF before it clobbers the flag word, so read it into saved_cf
  // FIRST; the fixed order matters and is why this is not a set of independent
  // assignments.
  if (kind === 'dec' && owns('fscf')) L.push(set('fscf', ref('cf')));
  if (needs.has('cf')) L.push(set('cf', cfExpr));
  if (needs.has('of')) L.push(set('of', ofExpr));
  if (needs.has('zf')) L.push(set('zf', `(i32.eqz ${v.res})`));
  if (needs.has('sf')) L.push(set('sf', sign(v.res)));

  const opcode = { add: 1, sub: 2, logic: 3, dec: 5, mul: 6, shift: 7 }[kind];
  if (kind === 'adc') {
    // The raw-mode fixup production applies when b+CF wrapped. Each field takes
    // its post-fixup value, so a later op owning a different field still wins.
    const wrapped = `(i32.lt_u ${v.b} ${v.braw})`;
    if (owns('fop')) L.push(set('fop', `(if (result i32) ${wrapped} (then (i32.const 8)) (else (i32.const 1)))`));
    if (owns('fa')) L.push(set('fa', `(if (result i32) ${wrapped} (then (i32.const 1)) (else ${v.a}))`));
    if (owns('fb')) L.push(set('fb', `(if (result i32) ${wrapped} (then (i32.const 0)) (else ${v.b}))`));
    if (owns('fres')) L.push(set('fres', v.res));
  } else {
    if (owns('fop')) L.push(set('fop', `(i32.const ${opcode})`));
    if (owns('fres')) L.push(set('fres', v.res));
    if (kind === 'add' || kind === 'sub') {
      if (owns('fa')) L.push(set('fa', v.a));
      if (owns('fb')) L.push(set('fb', v.b));
    } else if (kind === 'dec') {
      if (owns('fa')) L.push(set('fa', v.a));
      if (owns('fb')) L.push(set('fb', '(i32.const 1)'));
    } else if (kind === 'shift' || kind === 'mul') {
      if (owns('fb')) L.push(set('fb', kind === 'mul' ? v.ovf : v.cf));
    }
  }
  return L.join('\n');
}

function emitStraightArm(storage, lowered) {
  const prefix = storage === 'global' ? 'sg_' : 'sl_';
  const scratch = [];
  const names = ['t0', 't1', 't2', 't3', 't4', 'cf', 'zf', 'sf', 'of',
    'fop', 'fa', 'fb', 'fres', 'fscf', 'bacc', ...REGS];
  if (storage === 'global') {
    for (const n of names) scratch.push(`(global $${prefix}${n} (mut i32) (i32.const 0))`);
    scratch.push(`(global $${prefix}p (mut i64) (i64.const 0))`);
  }
  const funcs = [];
  for (const [name, shape] of Object.entries(SHAPES)) {
    const ops = lowered && shape.lowered ? shape.lowered(shape.ops) : shape.ops;
    const info = analyze(ops);
    const C = straightCtx(ops, info, storage, prefix);
    const live = new Set([...info.rd, ...info.wr]);
    const usesV = ops.some(x => x.kind === 'vec_mac');

    const body = ops.map((op, i) => { C.idx = i; C.immSeen = 0; return emitOp(op, C); }).join('\n');
    // Only fields some op in the block actually writes are carried; a field no
    // op touches keeps whatever the architectural global already held.
    const FGLOBAL = { fop: 'flag_op', fa: 'flag_a', fb: 'flag_b', fres: 'flag_res', fscf: 'saved_cf' };
    const carried = Object.keys(FGLOBAL).filter(f => info.lastWriter[f] !== undefined);
    const entry = [
      ...[...live].map(r => C.set(REGS[r], `(global.get $${REGS[r]})`)),
      ...(info.hasJcc ? [C.set('bacc', '(global.get $bacc)')] : []),
      // Loaded so a zero-trip call still writes back what it read.
      ...carried.map(f => C.set(f, `(global.get $${FGLOBAL[f]})`)),
      ...(info.entryFlags.size ? [...info.entryFlags].map(f =>
        C.set(f, `(call $get_${f})`)) : []),
    ].join('\n');
    const exit = [
      ...[...info.wr].map(r => `(global.set $${REGS[r]} ${C.ref(REGS[r])})`),
      ...(info.hasJcc ? [`(global.set $bacc ${C.ref('bacc')})`] : []),
      ...carried.map(f => `(global.set $${FGLOBAL[f]} ${C.ref(f)})`),
      ...(info.last >= 0 ? ['(global.set $flag_ss (i32.const 31))'] : []),
    ].join('\n');

    const locals = storage === 'local'
      ? `${names.map(n => `(local $${prefix}${n} i32)`).join(' ')} (local $${prefix}p i64) ` +
        (usesV ? `(local $${prefix}v0 v128) (local $${prefix}v1 v128) (local $${prefix}v2 v128)` : '')
      : (usesV ? `(local $${prefix}v0 v128) (local $${prefix}v1 v128) (local $${prefix}v2 v128)` : '');

    funcs.push(`(func $${name} (param $trips i32) (param $seed i32) (result i64)
      (local $i i32) ${locals}
      (call $seed_state (local.get $seed)) ${ptrInit(shape)}
      ${entry}
      (block $done (loop $trip (br_if $done (i32.ge_u (local.get $i) (local.get $trips)))
        ${budgetStep}
${body}
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $trip)))
      ${exit}
      (call $checksum))
    ${measureWrapper(name)}`);
  }
  return `(module (memory 8) ${preamble()} ${scratch.join('\n')} ${funcs.join('\n')})`;
}

function emitModule(arm) {
  if (arm === 'handlers') return emitDispatchArm(false);
  if (arm === 'pairfused') return emitDispatchArm(true);
  if (arm === 'tree') return emitStraightArm('local', false);
  if (arm === 'tree_lowered') return emitStraightArm('local', true);
  if (arm === 'directmem') return emitStraightArm('global', false);
  throw new Error(arm);
}

// ---------------------------------------------------------------------------
// Build / measure
// ---------------------------------------------------------------------------
// A guard for the trap above: a shape with no register that is both read and
// written cannot carry anything from one trip to the next, so its straight-line
// arms are hoistable and its ratios would be fiction.
function assertLoopCarried() {
  for (const [name, s] of Object.entries(SHAPES)) {
    const info = analyze(s.ops);
    if (![...info.wr].some(r => info.rd.has(r))) {
      throw new Error(`shape ${name}: no loop-carried register dependency — the trip ` +
        `loop body is invariant and an engine may hoist it out of the straight-line arms`);
    }
  }
}

async function buildAll() {
  assertLoopCarried();
  const rows = [];
  for (const arm of ARMS) {
    const wat = emitModule(arm);
    const t0 = performance.now();
    const bytes = await compileWat(f => {
      if (f !== `${arm}.wat`) throw new Error(f);
      return wat;
    }, { files: [`${arm}.wat`], cacheKey: `int-expr-v1-${arm}` });
    const projectMs = performance.now() - t0;
    const t1 = performance.now();
    const module = await WebAssembly.compile(bytes);
    const compileMs = performance.now() - t1;
    const t2 = performance.now();
    const instance = await WebAssembly.instantiate(module);
    const instMs = performance.now() - t2;
    instance.exports.init();
    rows.push({ arm, wat, bytes, instance, watBytes: Buffer.byteLength(wat),
      wasmBytes: bytes.length, projectMs, compileMs, instMs });
  }
  return rows;
}

const TARGET_OPS = 400000;
function repsFor(shape, trips) {
  return Math.max(1, Math.ceil(TARGET_OPS / (SHAPES[shape].ops.length * trips)));
}

function benchNode(rows, rounds) {
  const out = {};
  for (const shape of Object.keys(SHAPES)) {
    for (const trips of TRIPS) {
      const key = `${shape}/${trips}`;
      const reps = repsFor(shape, trips);
      const samples = {}, checks = {};
      for (const r of rows) { samples[r.arm] = []; r.instance.exports[`${shape}_measure`](Math.min(reps, 200), 2, 0x12345678); }
      for (let q = 0; q < rounds; q++) {
        for (let j = 0; j < rows.length; j++) {
          const r = rows[(j + q) % rows.length];
          const fn = r.instance.exports[`${shape}_measure`];
          const t0 = performance.now();
          const c = fn(reps, trips, 0x12345678);
          samples[r.arm].push((performance.now() - t0) / reps);
          checks[r.arm] = c.toString(16);
        }
      }
      assertChecksums(key, checks);
      out[key] = Object.fromEntries(rows.map(r => [r.arm, {
        usPerCall: med(samples[r.arm]) * 1000,
        nsPerOp: med(samples[r.arm]) * 1e6 / (SHAPES[shape].ops.length * trips),
        checksum: checks[r.arm],
      }]));
      out[key].reps = reps;
    }
  }
  return out;
}

function assertChecksums(key, checks) {
  const ref = checks[ARMS[0]];
  const bad = Object.entries(checks).filter(([, v]) => v !== ref);
  if (bad.length) {
    throw new Error(`CHECKSUM MISMATCH at ${key}: expected ${ref} from ${ARMS[0]}, got ` +
      bad.map(([a, v]) => `${a}=${v}`).join(', ') +
      ' — an arm is not executing the same program. Refusing to report timings.');
  }
}

// ---------------------------------------------------------------------------
// JSC shell (jsvu). Labelled JSC, never Safari.
// ---------------------------------------------------------------------------
function jscBench(rows, rounds) {
  const candidates = [
    path.join(os.homedir(), '.jsvu', 'bin', 'jsc'),
    path.join(os.homedir(), '.jsvu', 'bin', 'javascriptcore'),
    '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc',
  ];
  const jsc = candidates.find(p => fs.existsSync(p));
  if (!jsc) return null;
  const dir = process.env.INT_EXPR_SCRATCH || os.tmpdir();
  const specs = rows.map(r => {
    const f = path.join(dir, `int-expr-${r.arm}-${process.pid}.wasm`);
    fs.writeFileSync(f, Buffer.from(r.bytes));
    return { arm: r.arm, file: f };
  });
  const shapeOps = Object.fromEntries(Object.entries(SHAPES).map(([n, s]) => [n, s.ops.length]));
  const script = path.join(dir, `int-expr-jsc-${process.pid}.js`);
  const js = `
(async () => {
  const specs = ${JSON.stringify(specs)}, rounds = ${rounds};
  const ARMS = ${JSON.stringify(ARMS)}, TRIPS = ${JSON.stringify(TRIPS)};
  const shapeOps = ${JSON.stringify(shapeOps)}, TARGET_OPS = ${TARGET_OPS};
  const rows = [];
  for (const s of specs) {
    const buf = read(s.file, 'binary');
    const x = await WebAssembly.instantiate(new Uint8Array(buf));
    const instance = x.instance || x;
    instance.exports.init();
    rows.push({ arm: s.arm, instance });
  }
  const now = () => preciseTime() * 1000;
  const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const out = {};
  for (const shape of Object.keys(shapeOps)) for (const trips of TRIPS) {
    const key = shape + '/' + trips;
    const reps = Math.max(1, Math.ceil(TARGET_OPS / (shapeOps[shape] * trips)));
    const ss = {}, ck = {};
    for (const r of rows) { ss[r.arm] = []; r.instance.exports[shape + '_measure'](Math.min(reps, 200), 2, 0x12345678); }
    for (let q = 0; q < rounds; q++) for (let j = 0; j < rows.length; j++) {
      const r = rows[(j + q) % rows.length];
      const fn = r.instance.exports[shape + '_measure'];
      const t0 = now(); const c = fn(reps, trips, 0x12345678);
      ss[r.arm].push((now() - t0) / reps); ck[r.arm] = c.toString(16);
    }
    const ref = ck[ARMS[0]];
    for (const a of ARMS) if (ck[a] !== ref) throw new Error('CHECKSUM MISMATCH ' + key + ' ' + a + '=' + ck[a] + ' vs ' + ref);
    out[key] = {};
    for (const r of rows) out[key][r.arm] = {
      usPerCall: med(ss[r.arm]) * 1000,
      nsPerOp: med(ss[r.arm]) * 1e6 / (shapeOps[shape] * trips),
      checksum: ck[r.arm],
    };
    out[key].reps = reps;
  }
  print(JSON.stringify(out));
})().catch(e => { print('ERROR ' + (e.stack || e)); quit(1); });`;
  fs.writeFileSync(script, js);
  try {
    const raw = execFileSync(jsc, [script], { encoding: 'utf8', maxBuffer: 200e6, timeout: 300000 });
    const line = raw.trim().split('\n').pop();
    if (line.startsWith('ERROR')) throw new Error(raw);
    return { engine: jsc, results: JSON.parse(line) };
  } finally {
    fs.unlinkSync(script);
    for (const s of specs) fs.unlinkSync(s.file);
  }
}

// ---------------------------------------------------------------------------
// Calibration against the REAL emulator
// ---------------------------------------------------------------------------
// The same fixed-point dot body, injected as x86 into a live wine-assembly
// instance and run through the production decoder, $next and the real
// handlers. This is what tells us whether the synthetic "handlers" arm is a
// fair stand-in for today's per-op cost.
const le32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

const DOT_X86 = [
  0x8B, 0x06,                   // mov  eax,[esi]
  0x0F, 0xAF, 0x07,             // imul eax,[edi]
  0x8B, 0x5E, 0x04,             // mov  ebx,[esi+4]
  0x0F, 0xAF, 0x5F, 0x04,       // imul ebx,[edi+4]
  0x01, 0xD8,                   // add  eax,ebx
  0x8B, 0x4E, 0x08,             // mov  ecx,[esi+8]
  0x0F, 0xAF, 0x4F, 0x08,       // imul ecx,[edi+8]
  0x01, 0xC8,                   // add  eax,ecx
  0xC1, 0xF8, 0x10,             // sar  eax,16
  0x89, 0x02,                   // mov  [edx],eax
];

async function calibrate(rounds) {
  const wasmPath = path.join(ROOT, 'build', 'wine-assembly.wasm');
  const exePath = process.env.INT_EXPR_FIXTURE ||
    path.join(ROOT, 'test', 'binaries', 'notepad.exe');
  if (!fs.existsSync(wasmPath)) return { skipped: `missing ${wasmPath} — run bash tools/build.sh` };
  if (!fs.existsSync(exePath)) return { skipped: `missing ${exePath}` };
  const { createHostImports } = require(path.join(ROOT, 'lib/host-imports'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { exports: null, getMemory: () => memory.buffer };
  const h = createHostImports(ctx).host;
  h.memory = memory;
  h.exit = () => {}; h.log = () => {}; h.log_i32 = () => {};
  h.crash_unimplemented = () => {}; h.wait_multiple = () => 0; h.shell_execute = () => 33;
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(wasmPath), { host: h });
  ctx.exports = instance.exports;
  const e = instance.exports;
  const mem = new Uint8Array(e.memory.buffer);
  const dv = new DataView(e.memory.buffer);
  const exe = fs.readFileSync(exePath);
  mem.set(exe, e.get_staging());
  if (!e.load_pe(exe.length)) return { skipped: 'PE load failed' };
  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const w = ga => (ga - imageBase + guestBase) >>> 0;

  const codeGuest = (imageBase + 0x040000) >>> 0;
  const aGuest = (imageBase + 0x100000) >>> 0;
  const bGuest = (imageBase + 0x101000) >>> 0;
  const outGuest = (imageBase + 0x102000) >>> 0;
  const stackTop = (imageBase + 0x200000) >>> 0;
  for (let i = 0; i < 256; i++) {
    dv.setInt32(w(aGuest + i * 4), Math.imul(i, 2654435761) + 12345, true);
    dv.setInt32(w(bGuest + i * 4), Math.imul(i, 40503) + 7, true);
  }

  // body ++ dec ebp ++ jnz back to the top of the body.
  const body = DOT_X86.concat([0x4D]);
  const code = body.concat([0x75], [(-(body.length + 2)) & 0xFF], [0xC3]);
  mem.set(code, w(codeGuest));

  const ITERS = 20000;
  const runOnce = () => {
    e.set_eax(0); e.set_ebx(0); e.set_ecx(0);
    e.set_edx(outGuest); e.set_esi(aGuest); e.set_edi(bGuest);
    e.set_ebp(ITERS); e.set_esp(stackTop);
    dv.setUint32(w(stackTop), 0, true);
    e.set_eip(codeGuest);
    for (let i = 0; i < 100000; i++) { e.run(0x7FFFFFFF); if ((e.get_eip() >>> 0) === 0) return true; }
    return false;
  };
  if (!runOnce()) return { skipped: 'injected loop did not return' };
  const settled = dv.getInt32(w(outGuest), true);
  if (settled === 0) return { skipped: 'injected loop produced no output' };

  const samples = [];
  for (let q = 0; q < rounds; q++) {
    const t0 = performance.now();
    if (!runOnce()) return { skipped: 'injected loop did not return' };
    samples.push(performance.now() - t0);
  }
  const ms = med(samples);
  // 12 dispatched guest ops per iteration: the 10-op body plus dec/jnz.
  return {
    iters: ITERS, opsPerIter: 12, medianMs: ms,
    nsPerOp: ms * 1e6 / (ITERS * 12),
    out: settled >>> 0,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function ratios(results) {
  const out = {};
  for (const key of Object.keys(results)) {
    const r = results[key];
    out[key] = Object.fromEntries(ARMS.map(a => [a, +(r[a].nsPerOp / r.handlers.nsPerOp).toFixed(3)]));
    out[key].handlers_ns_per_op = +r.handlers.nsPerOp.toFixed(2);
  }
  return out;
}
function breakEven(results) {
  const out = {};
  for (const shape of Object.keys(SHAPES)) {
    let be = `>${TRIPS[TRIPS.length - 1]}`;
    for (const trips of TRIPS) {
      const r = results[`${shape}/${trips}`];
      if (r.tree.nsPerOp < r.directmem.nsPerOp) { be = trips; break; }
    }
    out[shape] = be;
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const rounds = +(process.env.INT_EXPR_ROUNDS || 5);
  const rows = await buildAll();
  const node = benchNode(rows, rounds);
  const jsc = argv.includes('--no-jsc') ? null : jscBench(rows, rounds);
  const calibration = argv.includes('--no-calibrate') ? null : await calibrate(Math.min(rounds, 3));

  const dotHandlerNs = node['dot/64'].handlers.nsPerOp;
  const calib = calibration && !calibration.skipped ? {
    real_ns_per_op: +calibration.nsPerOp.toFixed(2),
    synthetic_ns_per_op: +dotHandlerNs.toFixed(2),
    synthetic_share_of_real: +(dotHandlerNs / calibration.nsPerOp).toFixed(3),
  } : calibration;

  const out = {
    schema: 1,
    config: { arms: ARMS, trips: TRIPS, rounds, targetOps: TARGET_OPS },
    shapes: Object.fromEntries(Object.entries(SHAPES).map(([n, s]) =>
      [n, { describe: s.describe, ops: s.ops.length, lowered: !!s.lowered }])),
    sizes: rows.map(({ arm, watBytes, wasmBytes, projectMs, compileMs, instMs }) =>
      ({ arm, watBytes, wasmBytes, projectMs: +projectMs.toFixed(1),
        compileMs: +compileMs.toFixed(2), instMs: +instMs.toFixed(2) })),
    checksums_equal: true,
    node: { results: node, ratios: ratios(node), breakEven_tree_vs_directmem: breakEven(node) },
    jsc: jsc ? { engine: jsc.engine, results: jsc.results, ratios: ratios(jsc.results),
      breakEven_tree_vs_directmem: breakEven(jsc.results) } : null,
    calibration: calib,
    chrome: { attempted: false, reason: 'skipped: tools/profile-web-frames.js drives the app page, not a bare wasm module' },
  };
  const dest = process.env.INT_EXPR_JSON || '/tmp/int-expr-fusion.json';
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    sizes: out.sizes,
    node_ratios_at_64: Object.fromEntries(Object.keys(SHAPES).map(s =>
      [s, out.node.ratios[`${s}/64`]])),
    jsc_ratios_at_64: jsc ? Object.fromEntries(Object.keys(SHAPES).map(s =>
      [s, out.jsc.ratios[`${s}/64`]])) : null,
    breakEven_node: out.node.breakEven_tree_vs_directmem,
    calibration: out.calibration,
  }, null, 2));
  console.log(`full results: ${dest}`);
}

if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { emitModule, buildAll, benchNode, SHAPES, ARMS, TRIPS };
