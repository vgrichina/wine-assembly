// test/watx-compiler-br-table.test.js -- TRACK BULK: WATX compiler emits br_table (0x0E).
//
// See tracks/COMPILER-REQUESTS.md (BULK scoped edit-authority grant, ORCH GO 2026-08-12).
// br_table folded into the BULK arc as the follow-on after memory.copy/fill. SCOPE (per ORCH):
// br_table ONLY accelerates DENSE in-function integer switches -- does NOT touch the main
// threaded-code return_call_indirect dispatch, does NOT help sparse name-hash resolvers.
//
// This test proves four things:
//   (1) EMIT: the raw byte sequence for (br_table (labels $l0 $l1 $l2) $default idx) contains
//       0x0E + ULEB(3) + ULEB(depths...) + ULEB(default_depth). We seed a specific label depth
//       (0 for each) with a synthetic (block $l0 (block $l1 ...)) nest and grep for the bytes.
//   (2) STANDARD WAT: (br_table $l0 $l1 $l2 $default idx) emits byte-identical Wasm without
//       requiring a compiler option.
//   (3) DIFFERENTIAL: a br_table lowering of a 4-way dense switch produces the SAME return
//       values as an equivalent if-chain lowering, for all inputs 0..4 (0..3 are targets,
//       4 falls through to the default). Byte-exact behavior gate per ORCH's spec.
//   (4) DIAGNOSTICS: missing default/index operands fail
//       compile with a br_table-specific error message.
//
// Run: node test/watx-compiler-br-table.test.js
'use strict';
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got !== undefined ? ' (got ' + JSON.stringify(got) + ')' : ''}`); }
}
function findSubseq(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// ── (1) EMIT: br_table bytes present. ──────────────────────────────────────────────────────────
// Build a function that receives an index and jumps to one of three labeled blocks (or default).
// NOTE: WATX blocks are always void (no (result T) typed blocks); the switch result is threaded
// through a local $r, then read out at the end. blockLabels stack at br_table site
// (inside 5 nested blocks): [$exit,$l3,$l2,$l1,$l0], innermost=$l0.
// So depths: $l0=0, $l1=1, $l2=2, $default=$l3=3. Expected byte string:
// 0x0E ULEB(3) ULEB(0) ULEB(1) ULEB(2) ULEB(3) = 0x0E 0x03 0x00 0x01 0x02 0x03.
const emitSrc = `
(func $switch3 (param $i i32) (result i32) (effects heap)
  (local $r i32)
  (block $exit
    (block $l3
      (block $l2
        (block $l1
          (block $l0
            (br_table (labels $l0 $l1 $l2) $l3 (local.get $i)))
          (set! $r (i32.const 100)) (br $exit))
        (set! $r (i32.const 200)) (br $exit))
      (set! $r (i32.const 300)) (br $exit))
    (set! $r (i32.const 999)))
  (local.get $r))
(wasm-export "switch3" $switch3)`;
const r1 = compile(emitSrc, new Map());
ck('br_table-emit: compile succeeded', r1.success === true, r1.error);
if (r1.success && r1.wasmBinary) {
  const bin = Array.from(r1.wasmBinary);
  const needle = [0x0E, 0x03, 0x00, 0x01, 0x02, 0x03];
  const at = findSubseq(bin, needle);
  ck('br_table-emit: bytes 0x0E 0x03 0x00 0x01 0x02 0x03 present (opcode + vec-len + depths)',
     at >= 0, at);
}

// ── (2) STANDARD WAT: the standard folded spelling emits identical bytes. ──────────────────────
const standardEmitSrc = emitSrc.replace(
  '(br_table (labels $l0 $l1 $l2) $l3 (local.get $i))',
  '(br_table $l0 $l1 $l2 $l3 (local.get $i))');
const rStandard = compile(standardEmitSrc, new Map());
ck('br_table-standard: compile succeeded without an option', rStandard.success === true, rStandard.error);
if (r1.success && rStandard.success) {
  ck('br_table-standard: Wasm is byte-identical to (labels ...) form',
     Buffer.from(rStandard.wasmBinary).equals(Buffer.from(r1.wasmBinary)));
}

// ── (3) DIFFERENTIAL: br_table lowering matches an if-chain lowering, all inputs 0..4. ─────
// br_table version: same nested-block/local-thread pattern as switch3 above but returning
// switch result (10/20/30 for cases, 99 default).
const bt = `
(func $bt (param $i i32) (result i32) (effects heap)
  (local $r i32)
  (block $exit
    (block $l3
      (block $l2
        (block $l1
          (block $l0
            (br_table $l0 $l1 $l2 $l3 (local.get $i)))
          (set! $r (i32.const 10)) (br $exit))
        (set! $r (i32.const 20)) (br $exit))
      (set! $r (i32.const 30)) (br $exit))
    (set! $r (i32.const 99)))
  (local.get $r))
(wasm-export "bt" $bt)`;
// if-chain reference: manual dense switch. Same return values for the same inputs.
const ifc = `
(func $ifc (param $i i32) (result i32) (effects heap)
  (if (result i32) (i32.eq (local.get $i) (i32.const 0))
    (then (i32.const 10))
    (else (if (result i32) (i32.eq (local.get $i) (i32.const 1))
      (then (i32.const 20))
      (else (if (result i32) (i32.eq (local.get $i) (i32.const 2))
        (then (i32.const 30))
        (else (i32.const 99))))))))
(wasm-export "ifc" $ifc)`;
function instantiate(src) {
  const r = compile(src, new Map());
  if (!r.success) return { err: r.error };
  const stubs = { log_i32:()=>{}, log_str_ptr:()=>{}, log_bytes_at:()=>{}, native_pc_probe:()=>{},
    js_dispatch:()=>0, native_hostcall:()=>0, js_console_log:()=>{}, browser_touch_event:()=>{},
    browser_key_event:()=>0, browser_scroll_event:()=>0, gl_capture_call:()=>{} };
  const imports = {};
  for (const imp of r.importMeta || []) {
    imports[imp.module] = imports[imp.module] || {};
    imports[imp.module][imp.name] = stubs[imp.name] || (() => 0);
  }
  try {
    const mod = new WebAssembly.Module(r.wasmBinary);
    return { inst: new WebAssembly.Instance(mod, imports) };
  } catch (e) { return { err: e.message }; }
}
const bti = instantiate(bt);
const ifi = instantiate(ifc);
ck('br_table-diff: br_table module instantiates', !!bti.inst, bti.err);
ck('br_table-diff: if-chain reference module instantiates', !!ifi.inst, ifi.err);
if (bti.inst && ifi.inst) {
  // For dense inputs 0,1,2 -> targets (10,20,30). For anything >=3 the WASM spec falls through
  // to the DEFAULT label, whose block-body pushes 99. The if-chain reference matches for 0..2
  // and any-else -> 99. So the equivalence holds for all inputs including 3 and 4.
  for (let i = 0; i <= 4; i++) {
    const a = bti.inst.exports.bt(i);
    const b = ifi.inst.exports.ifc(i);
    ck(`br_table-diff: input ${i} -> br_table ${a} == if-chain ${b}`, a === b, {a, b, i});
  }
}

// ── (4) DIAGNOSTICS: malformed br_table forms fail with clear errors. ─────────────────────
const bad1 = `
(func $b1 (result i32) (effects heap)
  (block $outer (result i32)
    (block $l0
      (br_table))
    (i32.const 0)))
(wasm-export "b1" $b1)`;
const r_bad1 = compile(bad1, new Map());
ck('br_table-diag: missing default/index operands are rejected',
   r_bad1.success === false, r_bad1.success);
if (!r_bad1.success) {
  ck('br_table-diag: error message mentions br_table', /br_table/.test(r_bad1.error || ''), r_bad1.error);
}

const bad2 = `
(func $b2 (result i32) (effects heap)
  (block $outer (result i32)
    (block $l0
      (br_table (labels $l0)))
    (i32.const 0)))
(wasm-export "b2" $b2)`;
const r_bad2 = compile(bad2, new Map());
ck('br_table-diag: missing default label is rejected',
   r_bad2.success === false, r_bad2.success);

console.log(`\nwatx-compiler-br-table: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
