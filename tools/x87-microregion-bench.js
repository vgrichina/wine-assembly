#!/usr/bin/env node
'use strict';

// Compare ways of representing a bounded x87 stack inside a compiled region.
// This is deliberately standalone: it generates tiny WAT modules and never
// changes the emulator.  Every arm executes the same mutable-input programs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { compileWat } = require('../lib/compile-wat');

const OP = { PUSH: 0, NAN: 1, DUP: 2, MUL: 3, ADD: 4, FXCH: 5,
  ADDTO: 6, SUBP: 7, POP: 8, CMP2: 9, IMIX: 10 };
const I = (kind, arg = 0) => ({ kind, arg });
const workloads = {
  alpha: [I('PUSH', 1), I('PUSH', 2), I('DUP'), I('MUL', 2), I('FXCH', 2),
    I('ADDTO', 1), I('MUL', 3), I('FXCH', 1), I('MUL', 4), I('ADDTO', 1),
    I('SUBP', 2), I('ADD', 5), I('FXCH', 1), I('ADD', 5), I('POP'), I('POP')],
  mixed: [I('PUSH', 1), I('PUSH', 2), I('IMIX', 5), I('MUL', 2), I('FXCH', 1),
    I('IMIX', 7), I('ADDTO', 1), I('POP'), I('ADD', 5), I('IMIX', 9), I('POP')],
  deep: [...Array.from({ length: 8 }, (_, n) => I('PUSH', n + 1)), I('FXCH', 7),
    I('FXCH', 3), I('MUL', 2), I('ADDTO', 5), ...Array.from({ length: 8 }, () => I('POP'))],
  status: [I('PUSH', 1), I('PUSH', 2), I('CMP2'), I('PUSH', 1), I('PUSH', 1),
    I('CMP2'), I('PUSH', 2), I('PUSH', 1), I('CMP2'), I('PUSH', 1), I('NAN'), I('CMP2')],
};
const variants = ['arch', 'fixed', 'hot4', 'renamed', 'tuple', 'scratch', 'fused'];
const guestOps = Object.fromEntries(Object.entries(workloads).map(([k, v]) => [k, v.length]));
function validateProgram(name, ops) {
  let depth = 0;
  for (const [pc, op] of ops.entries()) {
    const need = op.kind === 'CMP2' ? 2 : ['DUP','FXCH','ADDTO','SUBP','POP','MUL','ADD'].includes(op.kind) ? 1 : 0;
    if (depth < need || (['DUP','FXCH','ADDTO','SUBP'].includes(op.kind) && op.arg >= depth))
      throw new Error(`${name}: invalid x87 stack use at pc ${pc}`);
    if (op.kind === 'PUSH' || op.kind === 'NAN' || op.kind === 'DUP') depth++;
    if (op.kind === 'POP' || op.kind === 'SUBP') depth--;
    if (op.kind === 'CMP2') depth -= 2;
    if (depth > 8) throw new Error(`${name}: x87 stack overflow at pc ${pc}`);
  }
  if (depth !== 0) throw new Error(`${name}: unbalanced loop backedge (${depth})`);
}
for (const [name, ops] of Object.entries(workloads)) validateProgram(name, ops);
const ind = (s, n = 4) => s.split('\n').map(x => x ? ' '.repeat(n) + x : x).join('\n');
const baseExpr = '(f64.add (local.get $seed) (f64.convert_i32_s (local.get $i)))';
const valExpr = n => `(f64.add ${baseExpr} (f64.const ${n}))`;
const mixStmt = n => `(local.set $ix (i32.xor (i32.add (i32.mul (local.get $ix) (i32.const 1664525)) (i32.const 1013904223)) (i32.const ${n})))`;
const checkStmt = e => `(local.set $sum (i64.add (local.get $sum) (i64.reinterpret_f64 ${e})))`;
const cmpExpr = (a, b) => `(if (result i32) (i32.or (f64.ne ${a} ${a}) (f64.ne ${b} ${b}))
  (then (i32.const 17664))
  (else (if (result i32) (f64.lt ${a} ${b}) (then (i32.const 256))
    (else (if (result i32) (f64.eq ${a} ${b}) (then (i32.const 16384)) (else (i32.const 0)))))))`;

function directBody(kind, ops) {
  const decl = [], pre = [], out = [];
  let depth = 0, serial = 0;
  const locals = Array.from({ length: 8 }, (_, i) => `$s${i}`);
  if (kind === 'hot4') decl.push(...locals.slice(0, 4).map(x => `(local ${x} f64)`));
  else if (kind !== 'scratch' && kind !== 'fused') decl.push(...locals.map(x => `(local ${x} f64)`));
  let map = locals.slice();
  const scratchAddr = logical => `(i32.const ${2048 + logical * 8})`;
  const hotGet = logical => logical < 4 ? `(local.get $s${logical})` : `(f64.load ${scratchAddr(logical)})`;
  const hotSet = (logical, e) => logical < 4 ? `(local.set $s${logical} ${e})` : `(f64.store ${scratchAddr(logical)} ${e})`;
  const get = logical => kind === 'scratch' ? `(f64.load ${scratchAddr(logical)})`
    : kind === 'hot4' ? hotGet(logical) : `(local.get ${map[logical]})`;
  const set = (logical, e) => kind === 'scratch' ? `(f64.store ${scratchAddr(logical)} ${e})`
    : kind === 'hot4' ? hotSet(logical, e) : `(local.set ${map[logical]} ${e})`;
  const push = e => {
    if (kind === 'hot4') { for (let j = Math.min(depth, 7); j > 0; --j) out.push(hotSet(j, hotGet(j - 1))); out.push(hotSet(0, e)); }
    else if (kind === 'scratch') out.push(set(depth, e));
    else { const free = map[depth]; for (let j = depth; j > 0; --j) map[j] = map[j - 1]; map[0] = free; out.push(set(0, e)); }
    depth++;
  };
  const pop = (record = true) => {
    const e = kind === 'scratch' ? `(f64.load ${scratchAddr(depth - 1)})` : get(0); if (record) out.push(checkStmt(e));
    if (kind === 'hot4') for (let j = 0; j < depth - 1; ++j) out.push(hotSet(j, hotGet(j + 1)));
    else if (kind === 'scratch') { /* depth selects the next physical slot */ }
    else { const used = map[0]; for (let j = 0; j < depth - 1; ++j) map[j] = map[j + 1]; map[depth - 1] = used; }
    depth--;
  };
  // Scratch stores bottom-to-top, unlike the other arms.
  const sg = logical => kind === 'scratch' ? `(f64.load ${scratchAddr(depth - 1 - logical)})` : get(logical);
  const ss = (logical, e) => kind === 'scratch' ? `(f64.store ${scratchAddr(depth - 1 - logical)} ${e})` : set(logical, e);
  for (const op of ops) {
    if (op.kind === 'PUSH') push(valExpr(op.arg));
    else if (op.kind === 'NAN') push('(f64.const nan)');
    else if (op.kind === 'DUP') push(sg(op.arg));
    else if (op.kind === 'MUL') out.push(ss(0, `(f64.mul ${sg(0)} (f64.const ${op.arg}))`));
    else if (op.kind === 'ADD') out.push(ss(0, `(f64.add ${sg(0)} (f64.const ${op.arg}))`));
    else if (op.kind === 'FXCH') {
      const t = `$t${serial++}`; decl.push(`(local ${t} f64)`); out.push(`(local.set ${t} ${sg(0)})`, ss(0, sg(op.arg)), ss(op.arg, `(local.get ${t})`));
      if (kind === 'renamed') { // The decoder can make FXCH purely a name swap.
        out.splice(out.length - 3, 3); const x = map[0]; map[0] = map[op.arg]; map[op.arg] = x;
      }
    } else if (op.kind === 'ADDTO') out.push(ss(op.arg, `(f64.add ${sg(op.arg)} ${sg(0)})`));
    else if (op.kind === 'SUBP') { out.push(ss(op.arg, `(f64.sub ${sg(op.arg)} ${sg(0)})`)); pop(false); }
    else if (op.kind === 'POP') pop(true);
    else if (op.kind === 'CMP2') { out.push(`(local.set $sw ${cmpExpr(sg(0), sg(1))})`, `(local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $sw))))`); pop(false); pop(false); }
    else if (op.kind === 'IMIX') out.push(mixStmt(op.arg));
  }
  if (depth !== 0) throw new Error(`${kind}: workload leaves depth ${depth}`);
  return { decl, pre, code: out.join('\n') };
}

function fixedBody(ops) {
  const decl = Array.from({ length: 8 }, (_, i) => `(local $p${i} f64)`);
  decl.push('(local $top i32)', '(local $tmp f64)', '(local $swap f64)');
  const getAt = i => Array.from({ length: 8 }, (_, n) => n).reverse().reduce((e, n) =>
    `(select (local.get $p${n}) ${e} (i32.eq (i32.and (i32.add (local.get $top) (i32.const ${i})) (i32.const 7)) (i32.const ${n})))`, '(f64.const 0)');
  const setAt = (i, e) => `(local.set $tmp ${e})\n` + Array.from({ length: 8 }, (_, n) =>
    `(if (i32.eq (i32.and (i32.add (local.get $top) (i32.const ${i})) (i32.const 7)) (i32.const ${n})) (then (local.set $p${n} (local.get $tmp))))`).join('\n');
  const out = []; let depth = 0;
  const push = e => { out.push(`(local.set $swap ${e})`, '(local.set $top (i32.and (i32.sub (local.get $top) (i32.const 1)) (i32.const 7)))', setAt(0, '(local.get $swap)')); depth++; };
  const pop = rec => { if (rec) out.push(checkStmt(getAt(0))); out.push('(local.set $top (i32.and (i32.add (local.get $top) (i32.const 1)) (i32.const 7)))'); depth--; };
  for (const op of ops) {
    if (op.kind === 'PUSH') push(valExpr(op.arg)); else if (op.kind === 'NAN') push('(f64.const nan)');
    else if (op.kind === 'DUP') push(getAt(op.arg));
    else if (op.kind === 'MUL') out.push(setAt(0, `(f64.mul ${getAt(0)} (f64.const ${op.arg}))`));
    else if (op.kind === 'ADD') out.push(setAt(0, `(f64.add ${getAt(0)} (f64.const ${op.arg}))`));
    else if (op.kind === 'FXCH') out.push('(local.set $swap ' + getAt(0) + ')', setAt(0, getAt(op.arg)), setAt(op.arg, '(local.get $swap)'));
    else if (op.kind === 'ADDTO') out.push(setAt(op.arg, `(f64.add ${getAt(op.arg)} ${getAt(0)})`));
    else if (op.kind === 'SUBP') { out.push(setAt(op.arg, `(f64.sub ${getAt(op.arg)} ${getAt(0)})`)); pop(false); }
    else if (op.kind === 'POP') pop(true);
    else if (op.kind === 'CMP2') { out.push(`(local.set $sw ${cmpExpr(getAt(0), getAt(1))})`, '(local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $sw))))'); pop(false); pop(false); }
    else out.push(mixStmt(op.arg));
  }
  return { decl, pre: ['(local.set $top (i32.and (local.get $seed32) (i32.const 7)))'], code: out.join('\n') };
}

function archHelpers() {
  return `
  (global $top (mut i32) (i32.const 0))
  (func $aget (param $n i32) (result f64) (local $p i32)
    (local.set $p (i32.and (i32.add (global.get $top) (local.get $n)) (i32.const 7)))
    (if (i32.ne (i32.load8_u offset=128 (local.get $p)) (i32.const 1)) (then unreachable))
    (f64.load offset=64 (i32.shl (local.get $p) (i32.const 3))))
  (func $aset (param $n i32) (param $v f64) (local $p i32)
    (local.set $p (i32.and (i32.add (global.get $top) (local.get $n)) (i32.const 7)))
    (if (i32.ne (i32.load8_u offset=128 (local.get $p)) (i32.const 1)) (then unreachable))
    (f64.store offset=64 (i32.shl (local.get $p) (i32.const 3)) (local.get $v)))
  (func $apush (param $v f64) (local $p i32)
    (global.set $top (i32.and (i32.sub (global.get $top) (i32.const 1)) (i32.const 7)))
    (local.set $p (global.get $top)) (f64.store offset=64 (i32.shl (local.get $p) (i32.const 3)) (local.get $v))
    (i32.store8 offset=128 (local.get $p) (i32.const 1)))
  (func $apop (result f64) (local $v f64) (local $p i32)
    (local.set $p (global.get $top))
    (if (i32.ne (i32.load8_u offset=128 (local.get $p)) (i32.const 1)) (then unreachable))
    (local.set $v (f64.load offset=64 (i32.shl (local.get $p) (i32.const 3))))
    (i32.store8 offset=128 (local.get $p) (i32.const 0))
    (global.set $top (i32.and (i32.add (global.get $top) (i32.const 1)) (i32.const 7))) (local.get $v))`;
}

function archBody(ops) {
  const out = []; let depth = 0, t = 0; const decl = [];
  const g = n => `(call $aget (i32.const ${n}))`; const s = (n, e) => `(call $aset (i32.const ${n}) ${e})`;
  const push = e => { out.push(`(call $apush ${e})`); depth++; };
  const pop = rec => { if (rec) out.push(checkStmt('(call $apop)')); else out.push('(drop (call $apop))'); depth--; };
  for (const op of ops) {
    if (op.kind === 'PUSH') push(valExpr(op.arg)); else if (op.kind === 'NAN') push('(f64.const nan)'); else if (op.kind === 'DUP') push(g(op.arg));
    else if (op.kind === 'MUL') out.push(s(0, `(f64.mul ${g(0)} (f64.const ${op.arg}))`));
    else if (op.kind === 'ADD') out.push(s(0, `(f64.add ${g(0)} (f64.const ${op.arg}))`));
    else if (op.kind === 'FXCH') { const x = `$at${t++}`; decl.push(`(local ${x} f64)`); out.push(`(local.set ${x} ${g(0)})`, s(0, g(op.arg)), s(op.arg, `(local.get ${x})`)); }
    else if (op.kind === 'ADDTO') out.push(s(op.arg, `(f64.add ${g(op.arg)} ${g(0)})`));
    else if (op.kind === 'SUBP') { out.push(s(op.arg, `(f64.sub ${g(op.arg)} ${g(0)})`)); pop(false); }
    else if (op.kind === 'POP') pop(true);
    else if (op.kind === 'CMP2') { out.push(`(local.set $sw ${cmpExpr(g(0), g(1))})`, '(local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $sw))))'); pop(false); pop(false); }
    else out.push(mixStmt(op.arg));
  }
  return { decl, pre: ['(global.set $top (i32.and (local.get $seed32) (i32.const 7)))', '(memory.fill (i32.const 128) (i32.const 0) (i32.const 8))'], code: out.join('\n') };
}

// A compact br_table micro-op VM whose eight f64 values are a multi-value
// tuple.  It deliberately has no hidden stack pointer: shifts are explicit.
function tupleHelpers() {
  const ret = a => a.map(x => `(local.get $${x})`).join(' ');
  return `
  (global $tout (mut f64) (f64.const 0)) (global $tsw (mut i32) (i32.const 0))
  (func $tstep (param $op i32) (param $arg i32) (param $base f64)
    (param $s0 f64) (param $s1 f64) (param $s2 f64) (param $s3 f64)
    (param $s4 f64) (param $s5 f64) (param $s6 f64) (param $s7 f64)
    (result f64 f64 f64 f64 f64 f64 f64 f64) (local $t f64)
    (block $done
      (block $bad (block $c10 (block $c9 (block $c8 (block $c7 (block $c6
        (block $c5 (block $c4 (block $c3 (block $c2 (block $c1 (block $c0
          (br_table $c0 $c1 $c2 $c3 $c4 $c5 $c6 $c7 $c8 $c9 $c10 $bad (local.get $op)))
        (local.set $s7 (local.get $s6)) (local.set $s6 (local.get $s5)) (local.set $s5 (local.get $s4))
        (local.set $s4 (local.get $s3)) (local.set $s3 (local.get $s2)) (local.set $s2 (local.get $s1))
        (local.set $s1 (local.get $s0)) (local.set $s0 (f64.add (local.get $base) (f64.convert_i32_s (local.get $arg)))) (br $done))
        (local.set $s7 (local.get $s6)) (local.set $s6 (local.get $s5)) (local.set $s5 (local.get $s4))
        (local.set $s4 (local.get $s3)) (local.set $s3 (local.get $s2)) (local.set $s2 (local.get $s1))
        (local.set $s1 (local.get $s0)) (local.set $s0 (f64.const nan)) (br $done))
        (local.set $s7 (local.get $s6)) (local.set $s6 (local.get $s5)) (local.set $s5 (local.get $s4))
        (local.set $s4 (local.get $s3)) (local.set $s3 (local.get $s2)) (local.set $s2 (local.get $s1))
        (local.set $s1 (local.get $s0)) (br $done))
        (local.set $s0 (f64.mul (local.get $s0) (f64.convert_i32_s (local.get $arg)))) (br $done))
        (local.set $s0 (f64.add (local.get $s0) (f64.convert_i32_s (local.get $arg)))) (br $done))
        (local.set $t (local.get $s0))
        (if (i32.eq (local.get $arg) (i32.const 1)) (then (local.set $s0 (local.get $s1)) (local.set $s1 (local.get $t))))
        (if (i32.eq (local.get $arg) (i32.const 2)) (then (local.set $s0 (local.get $s2)) (local.set $s2 (local.get $t))))
        (if (i32.eq (local.get $arg) (i32.const 3)) (then (local.set $s0 (local.get $s3)) (local.set $s3 (local.get $t))))
        (if (i32.eq (local.get $arg) (i32.const 7)) (then (local.set $s0 (local.get $s7)) (local.set $s7 (local.get $t)))) (br $done))
        (if (i32.eq (local.get $arg) (i32.const 1)) (then (local.set $s1 (f64.add (local.get $s1) (local.get $s0)))))
        (if (i32.eq (local.get $arg) (i32.const 5)) (then (local.set $s5 (f64.add (local.get $s5) (local.get $s0))))) (br $done))
        (local.set $s2 (f64.sub (local.get $s2) (local.get $s0)))
        (local.set $s0 (local.get $s1)) (local.set $s1 (local.get $s2)) (local.set $s2 (local.get $s3))
        (local.set $s3 (local.get $s4)) (local.set $s4 (local.get $s5)) (local.set $s5 (local.get $s6))
        (local.set $s6 (local.get $s7)) (br $done))
        (global.set $tout (local.get $s0)) (local.set $s0 (local.get $s1)) (local.set $s1 (local.get $s2))
        (local.set $s2 (local.get $s3)) (local.set $s3 (local.get $s4)) (local.set $s4 (local.get $s5))
        (local.set $s5 (local.get $s6)) (local.set $s6 (local.get $s7)) (br $done))
        (global.set $tsw ${cmpExpr('(local.get $s0)', '(local.get $s1)')})
        (local.set $s0 (local.get $s2)) (local.set $s1 (local.get $s3)) (local.set $s2 (local.get $s4))
        (local.set $s3 (local.get $s5)) (local.set $s4 (local.get $s6)) (local.set $s5 (local.get $s7)) (br $done))
        (br $done)) unreachable)
    ${ret(['s0','s1','s2','s3','s4','s5','s6','s7'])})`;
}

function tupleBody(ops) {
  const decl = Array.from({ length: 8 }, (_, i) => `(local $s${i} f64)`);
  const code = [];
  for (const op of ops) {
    code.push(`(call $tstep (i32.const ${OP[op.kind]}) (i32.const ${op.arg}) ${baseExpr} ${Array.from({length:8},(_,i)=>`(local.get $s${i})`).join(' ')})`);
    for (let i = 7; i >= 0; --i) code.push(`(local.set $s${i})`);
    if (op.kind === 'POP') code.push(checkStmt('(global.get $tout)'));
    if (op.kind === 'CMP2') code.push('(local.set $sw (global.get $tsw))', '(local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $sw))))');
    if (op.kind === 'IMIX') code.push(mixStmt(op.arg));
  }
  return { decl, pre: [], code: code.join('\n') };
}

// Symbolic stackification is the upper bound: intermediate x87 values remain
// Wasm expressions until an observable pop/compare boundary.
function fusedBody(ops) {
  const stack = [], code = [];
  for (const op of ops) {
    if (op.kind === 'PUSH') stack.unshift(valExpr(op.arg)); else if (op.kind === 'NAN') stack.unshift('(f64.const nan)');
    else if (op.kind === 'DUP') stack.unshift(stack[op.arg]);
    else if (op.kind === 'MUL') stack[0] = `(f64.mul ${stack[0]} (f64.const ${op.arg}))`;
    else if (op.kind === 'ADD') stack[0] = `(f64.add ${stack[0]} (f64.const ${op.arg}))`;
    else if (op.kind === 'FXCH') [stack[0], stack[op.arg]] = [stack[op.arg], stack[0]];
    else if (op.kind === 'ADDTO') stack[op.arg] = `(f64.add ${stack[op.arg]} ${stack[0]})`;
    else if (op.kind === 'SUBP') { stack[op.arg] = `(f64.sub ${stack[op.arg]} ${stack[0]})`; stack.shift(); }
    else if (op.kind === 'POP') code.push(checkStmt(stack.shift()));
    else if (op.kind === 'CMP2') { code.push(`(local.set $sw ${cmpExpr(stack[0], stack[1])})`, '(local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $sw))))'); stack.shift(); stack.shift(); }
    else code.push(mixStmt(op.arg));
  }
  return { decl: [], pre: [], code: code.join('\n') };
}

function exportFunc(name, body) {
  return `(func $${name} (export "${name}") (param $count i32) (param $seed f64) (param $seed32 i32) (result i64)
    (local $i i32) (local $sum i64) (local $ix i32) (local $sw i32)
    ${body.decl.join('\n    ')}
    (local.set $ix (local.get $seed32))
    ${body.pre.join('\n    ')}
    (block $exit (loop $loop
      (br_if $exit (i32.ge_u (local.get $i) (local.get $count)))
${ind(body.code, 6)}
      (local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $ix))))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $loop)))
    (local.get $sum))`;
}

function emitModule(variant) {
  const helpers = variant === 'arch' ? archHelpers() : variant === 'tuple' ? tupleHelpers() : '';
  const funcs = Object.entries(workloads).map(([name, ops]) => {
    const body = variant === 'arch' ? archBody(ops) : variant === 'fixed' ? fixedBody(ops)
      : variant === 'tuple' ? tupleBody(ops) : variant === 'fused' ? fusedBody(ops)
        : directBody(variant, ops);
    return exportFunc(name, body);
  }).join('\n');
  return `(module (memory 1) (export "memory" (memory 0)) ${helpers}\n${funcs})`;
}

function median(xs) { const a = [...xs].sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; }
async function buildAll() {
  const rows = [];
  for (const name of variants) {
    const wat = emitModule(name), t0 = performance.now();
    const bytes = await compileWat(f => { if (f !== `${name}.wat`) throw new Error(f); return wat; },
      { files: [`${name}.wat`], cacheKey: `x87-repr-v3-${name}` });
    const compileWatMs = performance.now() - t0, t1 = performance.now();
    const module = await WebAssembly.compile(bytes), wasmCompileMs = performance.now() - t1, t2 = performance.now();
    const instance = await WebAssembly.instantiate(module), instantiateMs = performance.now() - t2;
    rows.push({ name, wat, bytes, module, instance, compileWatMs, wasmCompileMs, instantiateMs });
  }
  return rows;
}
function runBench(rows, now, iterations, rounds) {
  const samples = {}, checks = {};
  for (const w of Object.keys(workloads)) { samples[w] = {}; checks[w] = {};
    for (const r of rows) { samples[w][r.name] = []; r.instance.exports[w](20, 1.25, 0x12345678); }
  }
  for (let round = 0; round < rounds; round++) for (const w of Object.keys(workloads)) {
    const order = rows.map((_, i) => rows[(i + round) % rows.length]);
    for (const r of order) { const t0 = now(); const c = r.instance.exports[w](iterations, 1.25, 0x12345678); const ms = now() - t0;
      samples[w][r.name].push(ms); checks[w][r.name] = c.toString(16); }
  }
  const result = {};
  for (const w of Object.keys(workloads)) { result[w] = {}; const ref = checks[w].fused;
    for (const r of rows) { if (checks[w][r.name] !== ref) throw new Error(`checksum ${w}: ${r.name}=${checks[w][r.name]} fused=${ref}`);
      const ms = median(samples[w][r.name]); result[w][r.name] = { ms, nsPerOp: ms * 1e6 / (iterations * guestOps[w]), ratio: 0, checksum: checks[w][r.name] }; }
    for (const r of rows) result[w][r.name].ratio = result[w][r.name].nsPerOp / result[w].arch.nsPerOp;
  }
  return result;
}

async function chromeBench(rows, iterations, rounds) {
  if (process.env.X87_NO_CHROME) return null;
  let puppeteer; try { puppeteer = require('puppeteer'); } catch { try { puppeteer = require('/private/tmp/wa-smac-bench-oracle/node_modules/puppeteer'); } catch { return null; } }
  const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  try { const page = await browser.newPage(); const mods = rows.map(r => ({name:r.name, b64:Buffer.from(r.bytes).toString('base64')}));
    return await page.evaluate(async ({mods,iterations,rounds,ops}) => {
      const rows=[]; for (const m of mods) { const u=Uint8Array.from(atob(m.b64),c=>c.charCodeAt(0)); const mod=await WebAssembly.compile(u); rows.push({name:m.name,instance:await WebAssembly.instantiate(mod)}); }
      const med=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)], out={};
      for (const w of Object.keys(ops)) { const ss={}; for(const r of rows){ss[r.name]=[];r.instance.exports[w](20,1.25,0x12345678)}
        let checks={}; for(let q=0;q<rounds;q++)for(let k=0;k<rows.length;k++){const r=rows[(k+q)%rows.length],t=performance.now();checks[r.name]=r.instance.exports[w](iterations,1.25,0x12345678).toString(16);ss[r.name].push(performance.now()-t)}
        if(Object.values(checks).some(x=>x!==checks.fused))throw Error('checksum '+w+JSON.stringify(checks));out[w]={};for(const r of rows){const ms=med(ss[r.name]);out[w][r.name]={ms,nsPerOp:ms*1e6/(iterations*ops[w]),checksum:checks[r.name]}}for(const r of rows)out[w][r.name].ratio=out[w][r.name].nsPerOp/out[w].arch.nsPerOp;
      } return out;
    }, {mods,iterations,rounds,ops:guestOps});
  } finally { await browser.close(); }
}

function jscBench(rows, iterations, rounds) {
  const jsc='/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc'; if(!fs.existsSync(jsc)||process.env.X87_NO_JSC)return null;
  const payload=rows.map(r=>({name:r.name,bytes:[...r.bytes]})); const file=path.join(os.tmpdir(),`x87-jsc-${process.pid}.js`);
  const js=`(async()=>{const specs=${JSON.stringify(payload)},ops=${JSON.stringify(guestOps)},iterations=${iterations},rounds=${rounds};const rows=[];for(const s of specs){const made=await WebAssembly.instantiate(new Uint8Array(s.bytes));rows.push({name:s.name,instance:made.instance||made})}const med=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)],out={};for(const w of Object.keys(ops)){const ss={};for(const r of rows){ss[r.name]=[];r.instance.exports[w](20,1.25,0x12345678)}let checks={};for(let q=0;q<rounds;q++)for(let k=0;k<rows.length;k++){const r=rows[(k+q)%rows.length],t=preciseTime();checks[r.name]=r.instance.exports[w](iterations,1.25,0x12345678).toString(16);ss[r.name].push((preciseTime()-t)*1000)}if(Object.values(checks).some(x=>x!==checks.fused))throw Error('checksum '+w+JSON.stringify(checks));out[w]={};for(const r of rows){const ms=med(ss[r.name]);out[w][r.name]={ms,nsPerOp:ms*1e6/(iterations*ops[w]),checksum:checks[r.name]}}for(const r of rows)out[w][r.name].ratio=out[w][r.name].nsPerOp/out[w].arch.nsPerOp}print(JSON.stringify(out))})().catch(e=>{print(e.stack);quit(1)})`;
  fs.writeFileSync(file,js); try{return JSON.parse(execFileSync(jsc,[file],{encoding:'utf8',maxBuffer:20e6}));}finally{fs.unlinkSync(file)}
}

function printEngine(name, r) { if(!r)return; console.log(`\n${name}`); for(const [w,row] of Object.entries(r)){console.log(`  ${w} (${guestOps[w]} guest ops/iteration)`);for(const v of variants){const x=row[v];console.log(`    ${v.padEnd(8)} ${x.nsPerOp.toFixed(2).padStart(9)} ns/op  ${x.ratio.toFixed(3)}x  ${x.checksum}`)}} }
async function main(){const iterations=+(process.env.X87_ITERS||200000),rounds=+(process.env.X87_ROUNDS||7);const rows=await buildAll();console.log('module size / compile cost');for(const r of rows)console.log(`  ${r.name.padEnd(8)} wat=${String(Buffer.byteLength(r.wat)).padStart(7)} wasm=${String(r.bytes.length).padStart(6)} project=${r.compileWatMs.toFixed(2)}ms engine=${r.wasmCompileMs.toFixed(2)}ms instantiate=${r.instantiateMs.toFixed(2)}ms`);const node=runBench(rows,()=>performance.now(),iterations,rounds);printEngine(`Node ${process.version}`,node);const chrome=await chromeBench(rows,iterations,rounds);printEngine('Chrome',chrome);const jsc=jscBench(rows,iterations,rounds);printEngine('JavaScriptCore',jsc);if(process.env.X87_JSON)fs.writeFileSync(process.env.X87_JSON,JSON.stringify({iterations,rounds,sizes:Object.fromEntries(rows.map(r=>[r.name,{wat:Buffer.byteLength(r.wat),wasm:r.bytes.length,compileWatMs:r.compileWatMs,wasmCompileMs:r.wasmCompileMs,instantiateMs:r.instantiateMs}])),node,chrome,jsc},null,2));}
if (require.main === module) main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
module.exports = { emitModule, workloads, guestOps, buildAll };
