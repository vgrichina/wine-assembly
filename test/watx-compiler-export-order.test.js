// test/watx-compiler-export-order.test.js -- the emitted export section must follow SOURCE
// DECLARATION order, interleaved across kinds.
//
// Why this is a gate and not a cosmetic preference: Milestone 3 of the WATX migration
// (docs/watx-migration-plan.md) compares the vendored compiler's artifact against
// lib/compile-wat.js's artifact section by section with tools/wasm-abi-diff.js, and the
// export section is compared POSITIONALLY — entry [0] against entry [0]. The legacy
// compiler emits one entry per export in the order it was written, so
// src/01-header.wat:870's `(export "memory" (memory 0))` — declared before every function
// in the closure — is export #0 there.
//
// WATX used to collect exports in two phases: every inline `(func $f (export "f") …)`
// clause first, then every top-level `(export …)` / `(wasm-export …)` form. That grouped
// the sections by where the export was WRITTEN rather than by declaration position, which
// on the real closure pushed `memory` from index 0 to index 1430 and made all 1431 entries
// compare misaligned. The fix records the index of the top-level form each export came
// from and stably sorts by it — a general declaration-order rule, NOT a "memory first"
// special case, which is why the cases below interleave in several different arrangements.
//
// WebAssembly.Module.exports() reports the export section in section order, so it is the
// direct read of what was emitted.
//
// Run: node test/watx-compiler-export-order.test.js
'use strict';
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got === undefined ? '' : ` (${got})`}`); }
}
function build(src, options = {}) {
  return compile(src, new Map(), { runtimeBuiltins: false, standardWat: true, tailCalls: false, ...options });
}
// Names in export-section order, straight out of the engine's decoder.
function exportOrder(r) {
  return WebAssembly.Module.exports(new WebAssembly.Module(r.wasmBinary)).map(e => `${e.kind}:${e.name}`);
}

// --- 1. The shape the gate is about: func, memory, func. ---------------------
const interleaved = build(`
(memory 1 1)
(func $first (export "first") (param $a i32) (result i32) (i32.add (local.get $a) (i32.const 1)))
(export "mem" (memory 0))
(func $second (export "second") (param $a i32) (result i32) (i32.add (local.get $a) (i32.const 2)))`);
ck('interleaved func/memory/func compiles', interleaved.success === true, interleaved.error);
if (interleaved.success) {
  const order = exportOrder(interleaved);
  ck('...emits declaration order, not kind-grouped',
    order.join(',') === 'function:first,memory:mem,function:second', order.join(','));
}

// --- 2. Memory declared FIRST lands at index 0 (the real closure's shape). ----
// This is src/main.watx's closure in miniature: the memory export is written in
// src/01-header.wat before any of the ~1430 inline function exports that follow it.
const memoryFirst = build(`
(memory 1 1)
(export "mem" (memory 0))
(func $a (export "a") (result i32) (i32.const 1))
(func $b (export "b") (result i32) (i32.const 2))`);
ck('memory-first module compiles', memoryFirst.success === true, memoryFirst.error);
if (memoryFirst.success) {
  const order = exportOrder(memoryFirst);
  ck('...memory is export #0', order[0] === 'memory:mem', order.join(','));
  ck('...and the funcs follow in written order',
    order.join(',') === 'memory:mem,function:a,function:b', order.join(','));
}

// --- 3. Memory declared LAST stays last (proves it is order, not a rule). -----
const memoryLast = build(`
(memory 1 1)
(func $a (result i32) (i32.const 1))
(export "a" (func $a))
(func $b (result i32) (i32.const 2))
(export "b" (func $b))
(export "mem" (memory 0))`);
ck('memory-last module compiles', memoryLast.success === true, memoryLast.error);
if (memoryLast.success) {
  ck('...memory is the LAST export',
    exportOrder(memoryLast).join(',') === 'function:a,function:b,memory:mem',
    exportOrder(memoryLast).join(','));
}

// --- 4. Inline (func … (export "n")) clauses interleave with top-level forms. -
// The two used to be collected in separate phases; this is the case that caught it.
const inlineMixed = build(`
(memory 1 1)
(func $one (export "one") (result i32) (i32.const 1))
(export "mem" (memory 0))
(func $two (result i32) (i32.const 2))
(wasm-export "two" $two)
(func $three (export "three") (result i32) (i32.const 3))`);
ck('inline + top-level export forms compile', inlineMixed.success === true, inlineMixed.error);
if (inlineMixed.success) {
  ck('...interleave by declaration position',
    exportOrder(inlineMixed).join(',') === 'function:one,memory:mem,function:two,function:three',
    exportOrder(inlineMixed).join(','));
}

// --- 5. Globals interleave too — the rule is across ALL kinds. ----------------
const withGlobal = build(`
(memory 1 1)
(global $g (mut i32) (i32.const 7))
(func $a (export "a") (result i32) (i32.const 1))
(export "g" (global $g))
(export "mem" (memory 0))
(func $b (export "b") (result i32) (i32.const 2))`);
ck('func/global/memory/func module compiles', withGlobal.success === true, withGlobal.error);
if (withGlobal.success) {
  ck('...all four kinds keep declaration order',
    exportOrder(withGlobal).join(',') === 'function:a,global:g,memory:mem,function:b',
    exportOrder(withGlobal).join(','));
}

// --- 6. Several exports on one form keep the order they were written in. ------
// The sort key is the top-level form index, so these tie; the sort must be STABLE.
// This module declares no memory form, so WATX's historical implicit `memory` export is
// still synthesized ahead of everything — that behaviour is deliberately unchanged and is
// asserted here so a future edit cannot drop it silently.
const sameForm = build(`
(func $a (export "a1") (export "a2") (export "a3") (result i32) (i32.const 1))`);
ck('multiple inline exports on one func compile', sameForm.success === true, sameForm.error);
if (sameForm.success) {
  ck('...tie on form index and keep written order (stable sort)',
    exportOrder(sameForm).join(',') === 'memory:memory,function:a1,function:a2,function:a3',
    exportOrder(sameForm).join(','));
}

// --- 7. The reordering must not change WHAT each name resolves to. ------------
const resolves = build(`
(memory 1 1)
(func $add2 (param $a i32) (result i32) (i32.add (local.get $a) (i32.const 2)))
(export "add2" (func $add2))
(export "mem" (memory 0))
(func $add5 (param $a i32) (result i32) (i32.add (local.get $a) (i32.const 5)))
(export "add5" (func $add5))`);
ck('reordered module compiles', resolves.success === true, resolves.error);
if (resolves.success) {
  let X = null, err = null;
  try { X = new WebAssembly.Instance(new WebAssembly.Module(resolves.wasmBinary), {}).exports; }
  catch (e) { err = e.message; }
  ck('...and validates', !err, err);
  if (X) {
    ck('...each export still points at its own function', X.add2(10) === 12 && X.add5(10) === 15,
      `${X.add2(10)} / ${X.add5(10)}`);
    ck('...and the memory export is a real Memory', X.mem instanceof WebAssembly.Memory);
  }
}

// --- The start section (id 8) ------------------------------------------------
// `(start $f)` used to be parsed and DROPPED — the string `start` appeared
// nowhere in the compiler, so the form fell off the end of the top-level scan
// like a comment. The module loaded and validated, and the one function the
// author asked to run before anything else never ran. That is invisible from
// outside: "start ran and its effect was subtle" and "start was never wired"
// look identical unless you check for the effect on an untouched instance.
//
// So the assertion is behavioural, not structural: instantiate and read the
// global WITHOUT calling anything. A structural check on section 8 alone would
// also pass on a section emitted with the wrong function index.
{
  const r = build(`
(memory 1 1)
(global $g (mut i32) (i32.const 0))
(func $init (global.set $g (i32.const 0x5a)))
(start $init)
(func $get (export "get") (result i32) (global.get $g))`);
  ck('a module with (start $f) compiles', r.success === true, r.error);
  if (r.success) {
    // Section ids in emitted order — start must be section 8, between exports (7)
    // and elements (9), or a decoder rejects the module outright.
    const ids = [];
    const b = r.wasmBinary;
    let p = 8;
    while (p < b.length) {
      const id = b[p]; let q = p + 1, size = 0, sh = 0, x;
      do { x = b[q++]; size |= (x & 0x7f) << sh; sh += 7; } while (x & 0x80);
      ids.push(id); p = q + size;
    }
    ck('...and emits a start section (id 8)', ids.includes(8), ids.join(','));
    ck('...in ascending section order', ids.join(',') === ids.slice().sort((a, c) => a - c).join(','), ids.join(','));
    let X = null, err = null;
    try { X = new WebAssembly.Instance(new WebAssembly.Module(b), {}).exports; }
    catch (e) { err = e.message; }
    ck('...and the module instantiates', !err, err);
    // THE check: nothing has been called, so a 0x5a here can only be the start
    // function having run at instantiate.
    if (X) ck('...and the start function RAN before any call', X.get() === 0x5a, '0x' + X.get().toString(16));
  }
}

// A start declaration that cannot be honoured is a compile error naming it,
// never a dropped form and never a problem the engine reports at instantiate.
for (const [name, src] of [
  ['an unknown function', '(func $a (nop))\n(start $nope)'],
  ['two (start …) forms', '(func $a (nop))\n(func $b (nop))\n(start $a)\n(start $b)'],
  ['a start function with a result', '(func $a (result i32) (i32.const 1))\n(start $a)'],
  ['a start function with a parameter', '(func $a (param $x i32) (nop))\n(start $a)'],
]) {
  let r;
  try { r = build(src); } catch (e) { r = { success: false, error: String(e.message || e) }; }
  ck(`(start …) rejects ${name}`, r.success === false, r.success);
}

// --- A memory declaration takes limits, not clauses ---------------------------
// `parseLimits` used to SKIP anything in a memory form it did not recognise, and
// the skip was invisible because the limits then fell back to their defaults.
// `(memory (data "…"))` — the spec's inline-data spelling, which also implies
// the memory's size — matched no branch, contributed no number, and produced a
// silently synthesized 16-page memory containing none of the author's bytes. An
// inline `(export "…")` vanished the same way. Neither form is one this tree
// needs; both now say so, and say what to write instead.
for (const [name, src] of [
  ['(memory (data "…")) — the inline-data spelling', '(memory (data "hello"))\n(func $f (export "f") (result i32) (i32.const 1))'],
  ['(memory 1 (data "…")) — inline data beside real limits', '(memory 1 (data "hello"))\n(func $f (export "f") (result i32) (i32.const 1))'],
  ['an inline (export …) on a memory', '(memory (export "mem") 1 1)\n(func $f (export "f") (result i32) (i32.const 1))'],
  ['an unrecognised token in a memory form', '(memory 1 1 wibble)\n(func $f (export "f") (result i32) (i32.const 1))'],
] ) {
  let r;
  try { r = build(src); } catch (e) { r = { success: false, error: String(e.message || e) }; }
  ck(`memory declaration rejects ${name}`, r.success === false, r.success);
}
// The spellings that ARE the tree's: bare limits, min-only, and $name + shared.
for (const [name, src] of [
  ['(memory 1 1)', '(memory 1 1)\n(func $f (export "f") (result i32) (i32.const 1))'],
  ['(memory 1) with no maximum', '(memory 1)\n(func $f (export "f") (result i32) (i32.const 1))'],
  ['(memory $m 1 2 shared)', '(memory $m 1 2 shared)\n(func $f (export "f") (result i32) (i32.const 1))'],
]) {
  const r = build(src);
  ck(`NO REGRESSION: ${name} still compiles`, r.success === true, r.error);
}

console.log(`\nwatx-compiler-export-order: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
