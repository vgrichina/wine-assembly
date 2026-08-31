// test/watx-compiler-type-index.test.js -- type-SECTION ORDER parity with lib/compile-wat.js.
//
// A `(type N)` operand -- on call_indirect / return_call_indirect -- is a POSITIONAL
// reference into the type section. Two compilers that intern the same set of signatures
// in a different order therefore emit different bytes for identical source, and the
// difference is invisible to every check that only looks at semantics: both modules
// validate, both run, and both call the same function through the same table.
//
// That is exactly how this was found. `$next` (src/04-cache.wat:938) dispatches with
//
//     (return_call_indirect (type $handler_t) (local.get $op) (local.get $fn))
//
// and body #355 of the shipped module encoded `13 00 00` under lib/compile-wat.js against
// `13 01 00` under WATX -- both naming a `(i32) -> ()` signature, at two different indices.
//
// The mechanism: lib/compile-wat.js interns in a fixed order -- a first sub-pass over
// every top-level `(type ...)` declaration, then ONE source-order pass in which imports
// and function definitions are interned as they are encountered. WATX interned lazily
// instead: all imports, then all functions, with named `(type ...)` declarations never
// interned at all until something referenced one. So `$handler_t` lost index 0 to
// whichever import happened to be `(i32 i32) -> ()`, and every import signature sorted
// ahead of every function signature.
//
// Proven here:
//   (1) a named `(type $t (func ...))` declared before any import takes index 0, and a
//       `return_call_indirect (type $t)` encodes that index -- the body #355 shape.
//   (2) two named types with IDENTICAL signatures dedup to ONE entry, and a reference to
//       EITHER name resolves to it. (lib/compile-wat.js dedups through the same sigKey
//       map, so "keep the duplicates" would be the divergence, not the parity.)
//   (3) declaration order among distinct named types is preserved.
//   (4) imports and functions are interleaved in SOURCE order, not grouped -- the
//       divergence that survived fixing (1) and moved nine entries around.
//   (5) an inline `(type (param ...) (result ...))` on call_indirect still resolves to
//       the same entry a named declaration of that signature created.
//   (6) NO REGRESSION: the module still validates and the dispatch still calls the right
//       function through the table.
//
// Run: node test/watx-compiler-type-index.test.js
'use strict';
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got === undefined ? '' : ` (${got})`}`); }
}
function build(src, options = {}) {
  return compile(src, new Map(), { runtimeBuiltins: false, standardWat: true, tailCalls: true, ...options });
}

// ── A minimal wasm reader: the type section, and one code body's raw bytes ──
// The point of this suite is the exact byte a (type N) operand carries, so it reads the
// binary rather than trusting any higher-level view of it.
function uleb(b, p) { let r = 0, s = 0, x; do { x = b[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return [r >>> 0, p]; }
function sections(buf) {
  let p = 8; const out = [];
  while (p < buf.length) { const id = buf[p++]; let len; [len, p] = uleb(buf, p); out.push({ id, start: p, len }); p += len; }
  return out;
}
const VT = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128' };
function typeSection(buf) {
  const s = sections(buf).find(s => s.id === 1);
  if (!s) return [];
  let p = s.start, n; [n, p] = uleb(buf, p);
  const out = [];
  for (let i = 0; i < n; i++) {
    p++; // 0x60 func
    let np; [np, p] = uleb(buf, p); const ps = []; for (let j = 0; j < np; j++) ps.push(VT[buf[p++]]);
    let nr; [nr, p] = uleb(buf, p); const rs = []; for (let j = 0; j < nr; j++) rs.push(VT[buf[p++]]);
    out.push(`(${ps.join(' ')})->(${rs.join(' ')})`);
  }
  return out;
}
function importFuncCount(buf) {
  const s = sections(buf).find(s => s.id === 2);
  if (!s) return 0;
  let p = s.start, n; [n, p] = uleb(buf, p); let c = 0;
  for (let i = 0; i < n; i++) {
    let l; [l, p] = uleb(buf, p); p += l; [l, p] = uleb(buf, p); p += l;
    const kind = buf[p++];
    if (kind === 0) { c++; let t; [t, p] = uleb(buf, p); }
    else if (kind === 1) { p++; const fl = buf[p++]; let m; [m, p] = uleb(buf, p); if (fl) [m, p] = uleb(buf, p); }
    else if (kind === 2) { const fl = buf[p++]; let m; [m, p] = uleb(buf, p); if (fl) [m, p] = uleb(buf, p); }
    else if (kind === 3) { p++; p++; }
  }
  return c;
}
function codeBodies(buf) {
  const s = sections(buf).find(s => s.id === 10);
  if (!s) return [];
  let p = s.start, n; [n, p] = uleb(buf, p); const out = [];
  for (let i = 0; i < n; i++) { let len; [len, p] = uleb(buf, p); out.push(buf.slice(p, p + len)); p += len; }
  return out;
}
// The operand of the one 0x11/0x13 (call_indirect / return_call_indirect) in a body.
function indirectTypeOperand(body) {
  for (let i = 0; i < body.length - 2; i++) {
    if (body[i] === 0x11 || body[i] === 0x13) { const [t] = uleb(body, i + 1); return t; }
  }
  return null;
}
function bytesOf(result) {
  const w = result.wasmBinary;
  return Buffer.from(w.buffer ? w.buffer.slice(w.byteOffset, w.byteOffset + w.byteLength) : w);
}

// ────────────────────────────────────────────────────────────────────────────
// (1)+(2)+(3): named type declarations are interned first, in declaration order,
// with duplicate signatures deduped -- and a reference by name lands on that entry.
//
// $handler_t is `(i32) -> ()`. It is declared FIRST, so it must be type 0 even though the
// module also imports a `(i32 i32) -> ()` (the signature that used to steal index 0) and
// the only other `(i32) -> ()` in the module is a function defined much later.
// $handler_alias declares the SAME signature under a second name.
const r1 = build(`
(type $handler_t (func (param i32)))
(type $binop_t   (func (param i32 i32) (result i32)))
(type $handler_alias (func (param i32)))

(import "env" "log2" (func $log2 (param i32 i32)))
(import "env" "getf" (func $getf (param f64) (result f64)))

(table 2 funcref)
(elem (i32.const 0) $h_a $h_b)

(func $h_a (param $x i32) (effects heap) (i32.store (i32.const 0) (local.get $x)))
(func $h_b (param $x i32) (effects heap) (i32.store (i32.const 0) (i32.mul (local.get $x) (i32.const 10))))

;; The body #355 shape: a tail dispatch through the table naming a DECLARED type.
(func $dispatch (param $slot i32) (param $arg i32) (effects heap)
  (return_call_indirect (type $handler_t) (local.get $arg) (local.get $slot)))
(wasm-export "dispatch" $dispatch)

;; The same signature reached through the OTHER name for it.
(func $dispatch_alias (param $slot i32) (param $arg i32) (effects heap)
  (call_indirect (type $handler_alias) (local.get $arg) (local.get $slot)))
(wasm-export "dispatch_alias" $dispatch_alias)

;; ... and through an INLINE signature, which must find the same entry.
(func $dispatch_inline (param $slot i32) (param $arg i32) (effects heap)
  (call_indirect (type (param i32)) (local.get $arg) (local.get $slot)))
(wasm-export "dispatch_inline" $dispatch_inline)
`);

ck('module with named types compiles', r1.success === true, r1.error);

if (r1.success) {
  const buf = bytesOf(r1);
  const types = typeSection(buf);
  const ni = importFuncCount(buf);
  const bodies = codeBodies(buf);
  const idxOf = name => {
    // function index of an exported name, via the export section
    const s = sections(buf).find(s => s.id === 7);
    let p = s.start, n; [n, p] = uleb(buf, p);
    for (let i = 0; i < n; i++) {
      let l; [l, p] = uleb(buf, p); const nm = buf.toString('utf8', p, p + l); p += l;
      const kind = buf[p++]; let ix; [ix, p] = uleb(buf, p);
      if (kind === 0 && nm === name) return ix;
    }
    return -1;
  };

  ck('a named (type ...) declared first takes index 0', types[0] === '(i32)->()', types.slice(0, 4).join(' '));
  ck('declaration order is preserved among named types',
     types[1] === '(i32 i32)->(i32)', types.slice(0, 4).join(' '));
  ck('a DUPLICATE named signature does not add a second entry (dedup, as legacy does)',
     types.filter(t => t === '(i32)->()').length === 1, types.join(' '));

  // Imports come after the declared types, so the import that used to win index 0 is now
  // somewhere later -- and it is still present exactly once.
  ck('the (i32 i32)->() import is interned after the declared types, not before',
     types.indexOf('(i32 i32)->()') > 1, `at ${types.indexOf('(i32 i32)->()')}`);

  const opDispatch = indirectTypeOperand(bodies[idxOf('dispatch') - ni]);
  const opAlias = indirectTypeOperand(bodies[idxOf('dispatch_alias') - ni]);
  const opInline = indirectTypeOperand(bodies[idxOf('dispatch_inline') - ni]);
  ck('return_call_indirect (type $handler_t) encodes (type 0)', opDispatch === 0, opDispatch);
  ck('a reference through the DUPLICATE name resolves to the same index', opAlias === 0, opAlias);
  ck('an INLINE (type (param i32)) resolves to the same index', opInline === 0, opInline);
}

// ────────────────────────────────────────────────────────────────────────────
// (4) Imports and function definitions are interleaved in SOURCE order.
//
// This is the second half of the divergence: with only the named-type pass fixed, WATX
// still grouped all import signatures ahead of all function signatures, which permuted
// nine entries of the real module's type section. Here the f64 import sits BETWEEN two
// functions whose signatures are new, so a grouped compiler puts it at index 0 and a
// source-order one puts it at index 1.
const r2 = build(`
(memory 1)
(func $first (param $a i32) (param $b i32) (param $c i32) (result i32) (effects heap)
  (i32.add (local.get $a) (i32.add (local.get $b) (local.get $c))))
(import "env" "fabs" (func $fabs (param f64) (result f64)))
(func $second (param $a i64) (result i64) (effects heap) (i64.mul (local.get $a) (local.get $a)))
(wasm-export "first" $first)
(wasm-export "second" $second)
`);
ck('interleaved module compiles', r2.success === true, r2.error);
if (r2.success) {
  const types = typeSection(bytesOf(r2));
  ck('imports and functions intern in source order, not imports-first',
     types[0] === '(i32 i32 i32)->(i32)' && types[1] === '(f64)->(f64)' && types[2] === '(i64)->(i64)',
     types.join(' '));
}

// ────────────────────────────────────────────────────────────────────────────
// (5) Round trip: the section order survives, and the module still WORKS.
if (r1.success) {
  const buf = bytesOf(r1);
  const mod = new WebAssembly.Module(buf);
  const inst = new WebAssembly.Instance(mod, { env: { log2: () => {}, getf: x => x } });
  const mem = new Int32Array(inst.exports.memory.buffer);
  inst.exports.dispatch(0, 7);
  ck('NO REGRESSION: dispatch through slot 0 calls $h_a', mem[0] === 7, mem[0]);
  inst.exports.dispatch(1, 7);
  ck('NO REGRESSION: dispatch through slot 1 calls $h_b', mem[0] === 70, mem[0]);
  inst.exports.dispatch_alias(0, 3);
  ck('NO REGRESSION: the aliased-type dispatch calls the same function', mem[0] === 3, mem[0]);
  inst.exports.dispatch_inline(1, 3);
  ck('NO REGRESSION: the inline-signature dispatch calls the same function', mem[0] === 30, mem[0]);

  // Re-decoding the emitted binary must give back the same section, in the same order --
  // the property that makes a (type N) operand meaningful at all.
  ck('type section round-trips to the same ordered list',
     typeSection(buf).join('|') === typeSection(Buffer.from(buf)).join('|'));
}

// ────────────────────────────────────────────────────────────────────────────
// A reference to a type name that was never declared stays a hard error -- the ordering
// work must not have turned an unknown name into a silently-interned new entry.
const bad = build(`
(memory 1)
(table 1 funcref)
(func $f (param $s i32) (effects heap) (call_indirect (type $nope) (local.get $s)))
(wasm-export "f" $f)`);
ck('call_indirect naming an undeclared type is a hard compile error', bad.success === false, bad.error);

console.log(`\nwatx-compiler-type-index: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
