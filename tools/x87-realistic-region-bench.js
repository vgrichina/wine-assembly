#!/usr/bin/env node
'use strict';

// Finite-trip x87 region benchmark. Unlike x87-microregion-bench.js, this
// includes architectural entry/exit, pressure locals and safepoint checks.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { compileWat } = require('../lib/compile-wat');

const LENGTHS = [4, 8, 16, 32];
const TRIPS = [1, 2, 4, 8, 16, 64, 256];
const SAFE_K = [1, 4, 8, 16, 32, 64];
const ARMS = ['handler', 'dispatch', 'fused', 'region', 'memory'];

// These are normalized, balanced four-op excerpts from real PE code. Addresses
// name the source sequence; absolute/base-relative addressing is retained as
// H188/H190 and register operations as H189.
const TRACES = {
  alpha: {
    source: 'terran.exe 0x413f55/0x41ff5c and measured TQI algebra island',
    cycle: [['PUSH_R', 0], ['PUSH_A', 1], ['ADDP', 1], ['POP_A', 2]],
  },
  jazz2: {
    source: 'jazz2.exe 0x414506 and 0x44b49e',
    cycle: [['FILD_R', 0], ['SQRT', 0], ['MUL_A', 1], ['POP_R', 2]],
  },
  halflife: {
    source: 'hldemo.exe 0x406bf6 and 0x412d74',
    cycle: [['PUSH_R', 0], ['MUL_A', 1], ['ADD_A', 2], ['POP_R', 3]],
  },
};

const HANDLER = { PUSH_A: 188, MUL_A: 188, ADD_A: 188, POP_A: 188,
  ADDP: 189, SQRT: 189, PUSH_R: 190, FILD_R: 190, POP_R: 190 };
const med = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const indent = (s, n = 4) => s.split('\n').map(x => x ? ' '.repeat(n) + x : x).join('\n');
const watBytes = bytes => bytes.map(x => `\\${x.toString(16).padStart(2, '0')}`).join('');

function program(trace, length) {
  const cycle = TRACES[trace].cycle;
  return Array.from({ length }, (_, i) => cycle[i % cycle.length]);
}

function pressure(k, increments = 1) {
  const lines = [];
  for (let q = 0; q < increments; q++) lines.push(
    '(local.set $g0 (i32.add (local.get $g0) (local.get $g1)))',
    '(local.set $g2 (i32.xor (local.get $g2) (local.get $g0)))',
    '(local.set $g3 (i32.rotl (local.get $g3) (i32.const 5)))',
    '(local.set $addr (i32.add (i32.const 1024) (i32.and (i32.add (local.get $g4) (local.get $micro_pc)) (i32.const 24))))',
    '(local.set $flags (i32.sub (local.get $g0) (local.get $g2)))',
    '(local.set $micro_pc (i32.add (local.get $micro_pc) (i32.const 1)))',
    `(if (i32.eqz (i32.and (local.get $micro_pc) (i32.const ${k - 1}))) (then
      (local.set $budget (i32.sub (local.get $budget) (i32.const ${k})))
      (if (i32.le_s (local.get $budget) (i32.const 0)) (then
        (local.set $safes (i32.add (local.get $safes) (i32.const 1)))
        (local.set $budget (i32.const 2147483647))))))`,
  );
  return lines.join('\n');
}

const commonLocals = `
    (local $i i32) (local $micro_pc i32) (local $budget i32) (local $safes i32)
    (local $g0 i32) (local $g1 i32) (local $g2 i32) (local $g3 i32)
    (local $g4 i32) (local $g5 i32) (local $g6 i32) (local $g7 i32)
    (local $flags i32) (local $tags i32) (local $top i32) (local $addr i32)
    (local $sum i64) (local $tmp f64)`;

const commonInit = `
    (local.set $budget (i32.const 2147483647))
    (local.set $g0 (local.get $seed32)) (local.set $g1 (i32.const 0x9e3779b9))
    (local.set $g2 (i32.const 0x243f6a88)) (local.set $g3 (i32.const 0xb7e15162))
    (local.set $g4 (i32.xor (local.get $seed32) (i32.const 0xa5a5a5a5)))
    (local.set $g5 (i32.const 0x13198a2e)) (local.set $g6 (i32.const 0x03707344))
    (local.set $g7 (i32.const 0x85a308d3))
    (local.set $top (i32.and (local.get $seed32) (i32.const 7)))
    (local.set $tags (i32.const 0))`;

const inputF = n => `(f64.load (i32.add (i32.const ${1024 + n * 8}) (i32.and (local.get $addr) (i32.const 24))))`;
const inputI = n => `(f64.convert_i32_s (i32.load (i32.add (i32.const ${1104 + n * 4}) (i32.and (local.get $addr) (i32.const 12)))))`;
const addOut = e => `(local.set $sum (i64.add (local.get $sum) (i64.reinterpret_f64 ${e})))`;
const tagSet = `(local.set $tags (i32.or (local.get $tags) (i32.shl (i32.const 1) (local.get $top))))`;
const tagClear = `(local.set $tags (i32.and (local.get $tags) (i32.xor (i32.const 255) (i32.shl (i32.const 1) (local.get $top)))))`;

function footer(extra = '') {
  return `${extra}
    (local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $g0))))
    (local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $g2))))
    (local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $g3))))
    (local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $flags))))
    (local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $tags))))
    (local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $top))))
    (local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $micro_pc))))
    (local.set $sum (i64.add (local.get $sum) (i64.extend_i32_u (local.get $safes))))
    (local.get $sum)`;
}

function measureWrapper(name) {
  return `(func (export "${name}_measure") (param $reps i32) (param $trips i32) (param $seed i32) (result i64)
    (local $n i32) (local $sum i64)
    (block $done (loop $loop (br_if $done (i32.ge_u (local.get $n) (local.get $reps)))
      (local.set $sum (i64.xor (local.get $sum)
        (call $${name} (local.get $trips) (i32.add (local.get $seed) (local.get $n)))))
      (local.set $n (i32.add (local.get $n) (i32.const 1))) (br $loop)))
    (local.get $sum))`;
}

function logicalEntry() {
  return Array.from({ length: 8 }, (_, n) => `(local.set $s${n} (f64.load (i32.add (i32.const 512)
      (i32.shl (i32.and (i32.add (local.get $top) (i32.const ${n})) (i32.const 7)) (i32.const 3)))))`).join('\n');
}
function logicalExit() {
  return Array.from({ length: 8 }, (_, n) => `(f64.store (i32.add (i32.const 512)
      (i32.shl (i32.and (i32.add (local.get $top) (i32.const ${n})) (i32.const 7)) (i32.const 3))) (local.get $s${n}))`).join('\n');
}

function renamedOps(ops, k) {
  let map = Array.from({ length: 8 }, (_, n) => n);
  const lines = [];
  const push = value => {
    const free = map[7]; for (let n = 7; n > 0; n--) map[n] = map[n - 1]; map[0] = free;
    lines.push('(local.set $top (i32.and (i32.sub (local.get $top) (i32.const 1)) (i32.const 7)))', tagSet,
      `(local.set $s${free} ${value})`);
  };
  const pop = store => {
    const free = map[0]; if (store) lines.push(addOut(`(local.get $s${free})`)); lines.push(tagClear,
      '(local.set $top (i32.and (i32.add (local.get $top) (i32.const 1)) (i32.const 7)))');
    for (let n = 0; n < 7; n++) map[n] = map[n + 1]; map[7] = free;
  };
  for (const [op, arg] of ops) {
    if (op === 'PUSH_R') push(inputF(arg));
    else if (op === 'FILD_R') push(inputI(arg));
    else if (op === 'PUSH_A') push(inputF(arg));
    else if (op === 'MUL_A') lines.push(`(local.set $s${map[0]} (f64.mul (local.get $s${map[0]}) ${inputF(arg)}))`);
    else if (op === 'ADD_A') lines.push(`(local.set $s${map[0]} (f64.add (local.get $s${map[0]}) ${inputF(arg)}))`);
    else if (op === 'SQRT') lines.push(`(local.set $s${map[0]} (f64.sqrt (f64.abs (local.get $s${map[0]}))))`);
    else if (op === 'ADDP') { lines.push(`(local.set $s${map[1]} (f64.add (local.get $s${map[1]}) (local.get $s${map[0]})))`); pop(false); }
    else if (op === 'POP_A' || op === 'POP_R') pop(true);
    lines.push(pressure(k));
  }
  if (map.some((v, i) => v !== i)) throw new Error('unbalanced renamed map');
  return lines.join('\n');
}

function memoryOps(ops, k, helperCalls) {
  const lines = [];
  const addr = n => `(i32.add (i32.const 512) (i32.shl (i32.and (i32.add (local.get $top) (i32.const ${n})) (i32.const 7)) (i32.const 3)))`;
  const get = n => helperCalls ? `(call $fget (i32.const ${n}) (local.get $top))` : `(f64.load ${addr(n)})`;
  const set = (n, e) => helperCalls ? `(call $fset (i32.const ${n}) (local.get $top) ${e})` : `(f64.store ${addr(n)} ${e})`;
  const push = value => lines.push('(local.set $top (i32.and (i32.sub (local.get $top) (i32.const 1)) (i32.const 7)))', tagSet, set(0, value));
  const pop = store => { if (store) lines.push(addOut(get(0))); lines.push(tagClear, '(local.set $top (i32.and (i32.add (local.get $top) (i32.const 1)) (i32.const 7)))'); };
  for (const [op, arg] of ops) {
    if (op === 'PUSH_R' || op === 'PUSH_A') push(inputF(arg));
    else if (op === 'FILD_R') push(inputI(arg));
    else if (op === 'MUL_A') lines.push(set(0, `(f64.mul ${get(0)} ${inputF(arg)})`));
    else if (op === 'ADD_A') lines.push(set(0, `(f64.add ${get(0)} ${inputF(arg)})`));
    else if (op === 'SQRT') lines.push(set(0, `(f64.sqrt (f64.abs ${get(0)}))`));
    else if (op === 'ADDP') { lines.push(set(1, `(f64.add ${get(1)} ${get(0)})`)); pop(false); }
    else pop(true);
    lines.push(pressure(k));
  }
  return lines.join('\n');
}

function straightExport(arm, trace, length, k) {
  const ops = program(trace, length);
  const locals = arm === 'region' ? Array.from({ length: 8 }, (_, n) => `(local $s${n} f64)`).join(' ') : '';
  const body = arm === 'region' ? renamedOps(ops, k) : memoryOps(ops, k, arm === 'handler');
  const entry = arm === 'region' ? logicalEntry() : '';
  const exit = arm === 'region' ? logicalExit() : '';
  const name = `${trace}_${length}`;
  return `(func $${name} (export "${name}") (param $trips i32) (param $seed32 i32) (result i64)
    ${commonLocals} ${locals}
    ${commonInit}
    ${entry}
    (block $done (loop $trip
      (br_if $done (i32.ge_u (local.get $i) (local.get $trips)))
${indent(body, 6)}
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $trip)))
    ${footer(exit)})
  ${measureWrapper(name)}`;
}

const dispatcherOpcodes = {
  PUSH_R_s7: 0, PUSH_A_s7: 1, FILD_R_s7: 2, PUSH_A_s6: 3,
  MUL_s7: 4, MUL_s6: 5, ADD_s7: 6, ADD_s6: 7, SQRT_s7: 8,
  ADDP_s7_s6: 9, POP_s7: 10,
};

function encodedProgram(ops) {
  let map = Array.from({ length: 8 }, (_, n) => n); const bytes = [];
  const push = (op, arg) => { const free = map[7]; for (let n = 7; n > 0; n--) map[n] = map[n - 1]; map[0] = free;
    const key = `${op}_s${free}`; if (!(key in dispatcherOpcodes)) throw new Error(key); bytes.push(dispatcherOpcodes[key], arg); };
  const pop = () => { const free = map[0]; for (let n = 0; n < 7; n++) map[n] = map[n + 1]; map[7] = free; };
  for (const [op, arg] of ops) {
    if (op === 'PUSH_R' || op === 'PUSH_A' || op === 'FILD_R') push(op, arg);
    else if (op === 'MUL_A') bytes.push(dispatcherOpcodes[`MUL_s${map[0]}`], arg);
    else if (op === 'ADD_A') bytes.push(dispatcherOpcodes[`ADD_s${map[0]}`], arg);
    else if (op === 'SQRT') bytes.push(dispatcherOpcodes[`SQRT_s${map[0]}`], arg);
    else if (op === 'ADDP') { bytes.push(dispatcherOpcodes.ADDP_s7_s6, arg); pop(); }
    else { bytes.push(dispatcherOpcodes.POP_s7, arg); pop(); }
  }
  if (map.some((v, i) => v !== i)) throw new Error('unbalanced encoded map');
  return bytes;
}

function switchBody(cases, selector) {
  const labels = cases.map((_, i) => `$c${i}`);
  let s = '(block $bad ' + labels.slice().reverse().map(l => `(block ${l} `).join('') +
    `(br_table ${labels.join(' ')} $bad ${selector})` + ')'.repeat(labels.length ? 1 : 0);
  // c0 was closed above. Bodies 0..N-2 close c1..cN-1; the final body is
  // already directly inside $bad and must not close it before `unreachable`.
  for (let i = 0; i < cases.length; i++)
    s += `\n${cases[i]} (br $case_done)${i + 1 < cases.length ? ')' : ''}`;
  s += '\nunreachable)';
  return `(block $case_done ${s})`;
}

function dispatchCases(k) {
  const p = pressure(k), push = (slot, value) => `(local.set $top (i32.and (i32.sub (local.get $top) (i32.const 1)) (i32.const 7))) ${tagSet} (local.set $s${slot} ${value})`;
  const pop = slot => `${addOut(`(local.get $s${slot})`)} ${tagClear} (local.set $top (i32.and (i32.add (local.get $top) (i32.const 1)) (i32.const 7)))`;
  return [
    `${push(7, inputF(0))} ${p}`, `${push(7, inputF(1))} ${p}`, `${push(7, inputI(0))} ${p}`, `${push(6, inputF(1))} ${p}`,
    `(local.set $s7 (f64.mul (local.get $s7) ${inputF(1)})) ${p}`,
    `(local.set $s6 (f64.mul (local.get $s6) ${inputF(1)})) ${p}`,
    `(local.set $s7 (f64.add (local.get $s7) ${inputF(2)})) ${p}`,
    `(local.set $s6 (f64.add (local.get $s6) ${inputF(2)})) ${p}`,
    `(local.set $s7 (f64.sqrt (f64.abs (local.get $s7)))) ${p}`,
    `(local.set $s7 (f64.add (local.get $s7) (local.get $s6))) ${tagClear}
      (local.set $top (i32.and (i32.add (local.get $top) (i32.const 1)) (i32.const 7))) ${p}`,
    `${pop(7)} ${p}`,
  ];
}

function dispatchExport(trace, length, k, fused) {
  const ops = program(trace, length), encoded = encodedProgram(ops);
  const dataOffset = 2048 + Object.keys(TRACES).indexOf(trace) * 512 + LENGTHS.indexOf(length) * 64;
  let inner;
  if (!fused) {
    inner = `(block $micro_done (loop $micro
      (br_if $micro_done (i32.ge_u (local.get $pc) (i32.const ${length})))
      (local.set $opcode (i32.load8_u (i32.add (i32.const ${dataOffset}) (i32.shl (local.get $pc) (i32.const 1)))))
      (local.set $arg (i32.load8_u offset=1 (i32.add (i32.const ${dataOffset}) (i32.shl (local.get $pc) (i32.const 1)))))
      ${switchBody(dispatchCases(k), '(local.get $opcode)')}
      (local.set $pc (i32.add (local.get $pc) (i32.const 1))) (br $micro)))`;
  } else {
    const cycleCases = {};
    for (let off = 0; off < length; off += 4) cycleCases[off / 4] = renamedOps(ops.slice(off, off + 4), k);
    inner = `(block $micro_done (loop $micro
      (br_if $micro_done (i32.ge_u (local.get $pc) (i32.const ${length / 4})))
      ${switchBody(Object.values(cycleCases), '(local.get $pc)')}
      (local.set $pc (i32.add (local.get $pc) (i32.const 1))) (br $micro)))`;
  }
  const data = fused ? '' : `(data (i32.const ${dataOffset}) "${watBytes(encoded)}")`;
  const name = `${trace}_${length}`;
  const fn = `(func $${name} (export "${name}") (param $trips i32) (param $seed32 i32) (result i64)
    ${commonLocals} (local $pc i32) (local $opcode i32) (local $arg i32)
    ${Array.from({ length: 8 }, (_, n) => `(local $s${n} f64)`).join(' ')}
    ${commonInit} ${logicalEntry()}
    (block $done (loop $trip (br_if $done (i32.ge_u (local.get $i) (local.get $trips)))
      (local.set $pc (i32.const 0)) ${inner}
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $trip)))
    ${footer(logicalExit())})
  ${measureWrapper(name)}`;
  return { data, fn };
}

function handlerExport(trace, length, k) {
  const ops = program(trace, length);
  const names = Object.keys(HANDLER), encoded = [];
  for (const [op, arg] of ops) encoded.push(names.indexOf(op), arg);
  const dataOffset = 4096 + Object.keys(TRACES).indexOf(trace) * 512 + LENGTHS.indexOf(length) * 64;
  const argDefaults = { PUSH_A: 1, MUL_A: 1, ADD_A: 2 };
  const cases = names.map(op => memoryOps([[op, argDefaults[op] || 0]], k, true));
  const inner = `(block $micro_done (loop $micro
      (br_if $micro_done (i32.ge_u (local.get $pc) (i32.const ${length})))
      (local.set $opcode (i32.load8_u (i32.add (i32.const ${dataOffset}) (i32.shl (local.get $pc) (i32.const 1)))))
      (local.set $arg (i32.load8_u offset=1 (i32.add (i32.const ${dataOffset}) (i32.shl (local.get $pc) (i32.const 1)))))
      ${switchBody(cases, '(local.get $opcode)')}
      (local.set $pc (i32.add (local.get $pc) (i32.const 1))) (br $micro)))`;
  return {
    data: `(data (i32.const ${dataOffset}) "${watBytes(encoded)}")`,
    fn: `(func $${trace}_${length} (export "${trace}_${length}") (param $trips i32) (param $seed32 i32) (result i64)
      ${commonLocals} (local $pc i32) (local $opcode i32) (local $arg i32)
      ${commonInit}
      (block $done (loop $trip (br_if $done (i32.ge_u (local.get $i) (local.get $trips)))
        (local.set $pc (i32.const 0)) ${inner}
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $trip)))
      ${footer()})
    ${measureWrapper(`${trace}_${length}`)}`,
  };
}

function helpers() {
  return `(func $fget (param $n i32) (param $top i32) (result f64)
    (f64.load (i32.add (i32.const 512) (i32.shl (i32.and (i32.add (local.get $top) (local.get $n)) (i32.const 7)) (i32.const 3)))))
  (func $fset (param $n i32) (param $top i32) (param $v f64)
    (f64.store (i32.add (i32.const 512) (i32.shl (i32.and (i32.add (local.get $top) (local.get $n)) (i32.const 7)) (i32.const 3))) (local.get $v)))`;
}

function emitModule(arm, k) {
  const parts = [], data = [];
  for (const trace of Object.keys(TRACES)) for (const length of LENGTHS) {
    if (arm === 'handler') { const x = handlerExport(trace, length, k); parts.push(x.fn); data.push(x.data); }
    else if (arm === 'dispatch' || arm === 'fused') { const x = dispatchExport(trace, length, k, arm === 'fused'); parts.push(x.fn); if (x.data) data.push(x.data); }
    else parts.push(straightExport(arm, trace, length, k));
  }
  return `(module (memory 1) ${arm === 'handler' ? helpers() : ''}
  (func (export "init")
    (f64.store (i32.const 1024) (f64.const 1.25)) (f64.store (i32.const 1032) (f64.const 2.5))
    (f64.store (i32.const 1040) (f64.const 3.75)) (f64.store (i32.const 1048) (f64.const 5.0))
    (i32.store (i32.const 1104) (i32.const 7)) (i32.store (i32.const 1108) (i32.const 11))
    (i32.store (i32.const 1112) (i32.const 13)) (i32.store (i32.const 1116) (i32.const 17)))
  ${data.join('\n')} ${parts.join('\n')})`;
}

async function buildAll() {
  const rows = [];
  for (const arm of ARMS) for (const k of SAFE_K) {
    const wat = emitModule(arm, k), t0 = performance.now();
    const bytes = await compileWat(f => { if (f !== `${arm}-${k}.wat`) throw new Error(f); return wat; },
      { files: [`${arm}-${k}.wat`], cacheKey: `x87-real-v2-${arm}-${k}` });
    const projectMs = performance.now() - t0, t1 = performance.now(), module = await WebAssembly.compile(bytes), engineMs = performance.now() - t1;
    const instance = await WebAssembly.instantiate(module); instance.exports.init();
    rows.push({ arm, k, watBytes: Buffer.byteLength(wat), bytes, module, instance, projectMs, engineMs });
  }
  return rows;
}

function benchInstances(rows, now, rounds) {
  const core = {}, safety = {};
  const coreRows = rows.filter(r => r.k === 16);
  for (const trace of Object.keys(TRACES)) for (const length of LENGTHS) for (const trips of TRIPS) {
    const key = `${trace}/${length}/${trips}`, samples = {}, checks = {};
    for (const r of coreRows) { samples[r.arm] = []; r.instance.exports[`${trace}_${length}_measure`](10, 2, 0x12345678); }
    for (let q = 0; q < rounds; q++) for (let j = 0; j < coreRows.length; j++) {
      const r = coreRows[(j + q) % coreRows.length], reps = Math.max(1, Math.ceil(500000 / (length * trips))), fn = r.instance.exports[`${trace}_${length}_measure`];
      const t0 = now(), c = fn(reps, trips, 0x12345678), ms = now() - t0;
      samples[r.arm].push(ms / reps); checks[r.arm] = c.toString(16);
    }
    if (Object.values(checks).some(x => x !== checks.region)) throw new Error(`checksum ${key} ${JSON.stringify(checks)}`);
    core[key] = Object.fromEntries(coreRows.map(r => [r.arm, { us: med(samples[r.arm]) * 1000, checksum: checks[r.arm] }]));
  }
  for (const k of SAFE_K) {
    const rs = rows.filter(r => r.k === k), samples = {}, checks = {};
    for (const r of rs) {
      samples[r.arm] = [];
      r.instance.exports.alpha_16_measure(20, 64, 0x24681357);
    }
    for (let q = 0; q < rounds; q++) for (let j = 0; j < rs.length; j++) { const r = rs[(j + q) % rs.length], fn = r.instance.exports.alpha_16_measure, t0 = now(), c = fn(1000, 64, 0x24681357);
      samples[r.arm].push((now() - t0) / 1000); checks[r.arm] = c.toString(16); }
    if (Object.values(checks).some(x => x !== checks.region)) throw new Error(`safe checksum K=${k}`);
    safety[k] = Object.fromEntries(rs.map(r => [r.arm, { us: med(samples[r.arm]) * 1000, checksum: checks[r.arm] }]));
  }
  return { core, safety };
}

async function chromeBench(rows, rounds) {
  let puppeteer; try { puppeteer = require('puppeteer'); } catch { try { puppeteer = require('/private/tmp/wa-smac-bench-oracle/node_modules/puppeteer'); } catch { return null; } }
  const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] });
  try { const page = await browser.newPage(), specs = rows.map(r => ({ arm:r.arm,k:r.k,b64:Buffer.from(r.bytes).toString('base64') }));
    return await page.evaluate(async ({specs,rounds}) => {
      const rows=[];for(const s of specs){const u=Uint8Array.from(atob(s.b64),c=>c.charCodeAt(0)),m=await WebAssembly.compile(u),instance=await WebAssembly.instantiate(m);instance.exports.init();rows.push({...s,instance})}
      const med=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)],arms=['handler','dispatch','fused','region','memory'],lengths=[4,8,16,32],tripsList=[1,2,4,8,16,64,256],traces=['alpha','jazz2','halflife'],core={},safety={};const cr=rows.filter(r=>r.k===16);
      for(const trace of traces)for(const length of lengths)for(const trips of tripsList){const key=`${trace}/${length}/${trips}`,ss={},ck={};for(const a of arms)ss[a]=[];for(const r of cr)r.instance.exports[`${trace}_${length}_measure`](10,2,0x12345678);for(let q=0;q<rounds;q++)for(let j=0;j<cr.length;j++){const r=cr[(j+q)%cr.length],reps=Math.max(1,Math.ceil(500000/(length*trips))),fn=r.instance.exports[`${trace}_${length}_measure`],t=performance.now(),c=fn(reps,trips,0x12345678);ss[r.arm].push((performance.now()-t)/reps);ck[r.arm]=c.toString(16)}if(Object.values(ck).some(x=>x!==ck.region))throw Error('checksum '+key);core[key]=Object.fromEntries(arms.map(a=>[a,{us:med(ss[a])*1000,checksum:ck[a]}]))}
      for(const k of [1,4,8,16,32,64]){const rs=rows.filter(r=>r.k===k),ss={},ck={};for(const a of arms)ss[a]=[];for(const r of rs)r.instance.exports.alpha_16_measure(20,64,0x24681357);for(let q=0;q<rounds;q++)for(let j=0;j<rs.length;j++){const r=rs[(j+q)%rs.length],fn=r.instance.exports.alpha_16_measure,t=performance.now(),c=fn(1000,64,0x24681357);ss[r.arm].push((performance.now()-t)/1000);ck[r.arm]=c.toString(16)}if(Object.values(ck).some(x=>x!==ck.region))throw Error('safe '+k);safety[k]=Object.fromEntries(arms.map(a=>[a,{us:med(ss[a])*1000,checksum:ck[a]}]))}return{core,safety};
    }, {specs,rounds});
  } finally { await browser.close(); }
}

function jscBench(rows, rounds) {
  const jsc='/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc'; if(!fs.existsSync(jsc))return null;
  const specs=rows.map(r=>({arm:r.arm,k:r.k,bytes:[...r.bytes]})), file=path.join(os.tmpdir(),`x87-real-jsc-${process.pid}.js`);
  // Reuse the Node algorithm in a compact JSC script; preciseTime is seconds.
  const js=`(async()=>{const specs=${JSON.stringify(specs)},rounds=${rounds},rows=[];for(const s of specs){const x=await WebAssembly.instantiate(new Uint8Array(s.bytes)),instance=x.instance||x;instance.exports.init();rows.push({...s,instance})}const now=()=>preciseTime()*1000,med=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)],arms=${JSON.stringify(ARMS)},lengths=${JSON.stringify(LENGTHS)},tripsList=${JSON.stringify(TRIPS)},traces=${JSON.stringify(Object.keys(TRACES))},core={},safety={},cr=rows.filter(r=>r.k===16);for(const trace of traces)for(const length of lengths)for(const trips of tripsList){const key=trace+'/'+length+'/'+trips,ss={},ck={};for(const a of arms)ss[a]=[];for(const r of cr)r.instance.exports[trace+'_'+length+'_measure'](10,2,0x12345678);for(let q=0;q<rounds;q++)for(let j=0;j<cr.length;j++){const r=cr[(j+q)%cr.length],reps=Math.max(1,Math.ceil(500000/(length*trips))),fn=r.instance.exports[trace+'_'+length+'_measure'],t=now(),c=fn(reps,trips,0x12345678);ss[r.arm].push((now()-t)/reps);ck[r.arm]=c.toString(16)}if(Object.values(ck).some(x=>x!==ck.region))throw Error('checksum '+key+JSON.stringify(ck));core[key]=Object.fromEntries(arms.map(a=>[a,{us:med(ss[a])*1000,checksum:ck[a]}]))}for(const k of ${JSON.stringify(SAFE_K)}){const rs=rows.filter(r=>r.k===k),ss={},ck={};for(const a of arms)ss[a]=[];for(let q=0;q<rounds;q++)for(let j=0;j<rs.length;j++){const r=rs[(j+q)%rs.length],fn=r.instance.exports.alpha_16_measure,t=now(),c=fn(1000,64,0x24681357);ss[r.arm].push((now()-t)/1000);ck[r.arm]=c.toString(16)}if(Object.values(ck).some(x=>x!==ck.region))throw Error('safe '+k);safety[k]=Object.fromEntries(arms.map(a=>[a,{us:med(ss[a])*1000,checksum:ck[a]}]))}print(JSON.stringify({core,safety}))})().catch(e=>{print(e.stack);quit(1)})`;
  fs.writeFileSync(file,js);try{return JSON.parse(execFileSync(jsc,[file],{encoding:'utf8',maxBuffer:50e6}))}finally{fs.unlinkSync(file)}
}

function u32le(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
function prodInstruction(op, arg, dataGuest) {
  if (op === 'PUSH_R') return [0xd9, 0x46, 0x00];                 // H190 fld [esi]
  if (op === 'FILD_R') return [0xdb, 0x46, 0x00];                 // H190 fild [esi]
  if (op === 'PUSH_A') return [0xd9, 0x05, ...u32le(dataGuest + arg * 8)];
  if (op === 'MUL_A') return [0xd8, 0x0d, ...u32le(dataGuest + arg * 8)];
  if (op === 'ADD_A') return [0xd8, 0x05, ...u32le(dataGuest + arg * 8)];
  if (op === 'SQRT') return [0xd9, 0xfa];                         // H189
  if (op === 'ADDP') return [0xde, 0xc1];                         // H189 faddp st1,st0
  if (op === 'POP_A') return [0xd9, 0x1d, ...u32le(dataGuest + arg * 8)];
  if (op === 'POP_R') return [0xd9, 0x5e, (arg * 4) & 255];       // H190 fstp [esi+disp8]
  throw new Error(op);
}

// Execute the real production decoder, $next and H188/H189/H190 handlers in
// the full emulator. This is Node-only and deliberately reported separately
// from the small cross-engine representation modules.
async function productionBench(rounds) {
  if (process.env.X87_REAL_NO_PRODUCTION) return null;
  const { bootRenderHarness } = require('../test/render-helper');
  const extraWat = `
    (func (export "x87_bench_reset") (param $seed i32)
      (global.set $fpu_top (i32.and (local.get $seed) (i32.const 7)))
      (global.set $fpu_sw (i32.const 0))
      (call $fpu_set (i32.const 0) (f64.const 0))
      (call $fpu_set (i32.const 1) (f64.const 0))
      (call $fpu_set (i32.const 2) (f64.const 0))
      (call $fpu_set (i32.const 3) (f64.const 0))
      (call $fpu_set (i32.const 4) (f64.const 0))
      (call $fpu_set (i32.const 5) (f64.const 0))
      (call $fpu_set (i32.const 6) (f64.const 0))
      (call $fpu_set (i32.const 7) (f64.const 0))
      (global.set $fpu_tag (i32.const 0))
      (global.set $fpu_raw_tag (i32.const 0)))
    (func (export "x87_bench_meta") (result i32)
      (i32.xor (global.get $fpu_tag) (i32.xor (i32.shl (global.get $fpu_top) (i32.const 8)) (i32.shl (global.get $fpu_sw) (i32.const 16)))))`;
  const h = await bootRenderHarness({ extraWat, fonts: 'none' }), e = h.exports;
  const fixturePath = process.env.X87_REAL_FIXTURE || path.join(__dirname, '..', 'test', 'binaries', 'notepad.exe');
  if (!fs.existsSync(fixturePath)) throw new Error(`production fixture missing: ${fixturePath} (set X87_REAL_FIXTURE)`);
  const fixture = fs.readFileSync(fixturePath);
  let mem = new Uint8Array(h.memory.buffer), dv = new DataView(h.memory.buffer);
  mem.set(fixture, e.get_staging()); if (!e.load_pe(fixture.length)) throw new Error('production fixture PE load failed');
  const imageBase=e.get_image_base()>>>0, guestBase=e.get_guest_base()>>>0, wa=ga=>(ga-imageBase+guestBase)>>>0;
  const codeBaseGuest=(imageBase+0x30000)>>>0, dataGuest=(imageBase+0x50000)>>>0, stackGuest=(imageBase+0xd00000)>>>0;
  for(let n=0;n<8;n++)dv.setFloat64(wa(dataGuest+n*8),1.25+n*0.75,true);
  const result={}; let configIndex=0;
  for(const trace of Object.keys(TRACES))for(const length of LENGTHS)for(const trips of TRIPS){
    const codeGuest=(codeBaseGuest+(configIndex++)*0x400)>>>0;
    const body=[];for(const op of program(trace,length))body.push(...prodInstruction(op[0],op[1],dataGuest),0x01,0xd8,0x31,0xc2,0xc1,0xc7,0x05);
    const code=[0xbe,...u32le(dataGuest),0xb9,...u32le(trips)], loopOff=10;code.push(...body,0x49,0x0f,0x85);
    const afterDisp=code.length+4, rel=(loopOff-afterDisp)|0;code.push(...u32le(rel),0xc3);mem.set(code,wa(codeGuest));
    const runOnce=seed=>{dv.setUint32(wa(stackGuest),0,true);e.x87_bench_reset(seed);e.set_eax(seed);e.set_ebx(0x9e3779b9);e.set_edx(0x243f6a88);e.set_edi(0xb7e15162);e.set_esi(dataGuest);e.set_esp(stackGuest);e.set_eip(codeGuest);e.run(1000000);if((e.get_eip()>>>0)!==0)throw new Error('production probe did not return');return BigInt((e.get_eax()^e.get_edx()^e.get_edi()^e.x87_bench_meta())>>>0)};
    runOnce(0x12345678);const samples=[];let checksum='';const reps=Math.max(1,Math.ceil(100000/(length*trips)));
    for(let q=0;q<rounds;q++){let c=0n,t=performance.now();for(let n=0;n<reps;n++)c^=runOnce((0x12345678+n)|0);samples.push((performance.now()-t)/reps);checksum=c.toString(16)}
    e.reset_handler_hist();e.set_handler_hist_enabled(1);runOnce(0x13572468);e.set_handler_hist_enabled(0);const hist=new Uint32Array(h.memory.buffer,e.get_handler_hist_base()>>>0,e.get_handler_hist_count());
    result[`${trace}/${length}/${trips}`]={us:med(samples)*1000,checksum,h188:hist[188]>>>0,h189:hist[189]>>>0,h190:hist[190]>>>0,ecx:e.get_ecx()>>>0};
  }
  return result;
}

function summary(engine) {
  const rows=[]; for(const trace of Object.keys(TRACES))for(const length of LENGTHS){let be={};for(const arm of ['dispatch','fused','region']){be[arm]='>256';for(const trips of TRIPS){const r=engine.core[`${trace}/${length}/${trips}`];if(r[arm].us<r.handler.us){be[arm]=trips;break}}}const r=engine.core[`${trace}/${length}/64`];rows.push({trace,length,breakEven:be,at64:Object.fromEntries(ARMS.map(a=>[a,+(r[a].us/r.handler.us).toFixed(3)]))})}return rows;
}

async function main(){const rounds=+(process.env.X87_REAL_ROUNDS||5),rows=await buildAll();const node=benchInstances(rows,()=>performance.now(),rounds);let chrome=null,jsc=null;if(!process.env.X87_REAL_NO_CHROME)chrome=await chromeBench(rows,rounds);if(!process.env.X87_REAL_NO_JSC)jsc=jscBench(rows,rounds);const production=await productionBench(Math.min(rounds,3));const out={schema:1,config:{lengths:LENGTHS,trips:TRIPS,safeK:SAFE_K,rounds},traces:TRACES,sizes:rows.map(({arm,k,watBytes,bytes,projectMs,engineMs})=>({arm,k,watBytes,wasmBytes:bytes.length,projectMs,engineMs})),node,chrome,jsc,production,summaries:{node:summary(node),chrome:chrome&&summary(chrome),jsc:jsc&&summary(jsc)},safari:{attempted:true,reason:'safaridriver --diagnose did not return a session and was terminated; JSC shell is reported separately and is not labelled Safari.'}};const dest=process.env.X87_REAL_JSON||'/tmp/x87-realistic.json';fs.writeFileSync(dest,JSON.stringify(out,null,2));console.log(JSON.stringify(out.summaries,null,2));console.log(`full results: ${dest}`)}
if(require.main===module)main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
module.exports={emitModule,buildAll,benchInstances,TRACES,LENGTHS,TRIPS,SAFE_K,ARMS};
