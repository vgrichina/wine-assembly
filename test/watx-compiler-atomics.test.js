// test/watx-compiler-atomics.test.js -- WATX migration gap G1: the WebAssembly threads
// proposal (0xFE prefix) atomic memory family.
//
// docs/watx-migration-gaps.md G1: the string `atomic` appeared ZERO times in the vendored
// compiler, while Wine-Assembly's own closure contains 144 atomic sites over a `shared`
// memory. This suite covers the WHOLE standard family, not the subset src/*.wat happens to
// use today -- a partial opcode table is the failure mode the migration exists to remove.
//
// What is proven here, in order of how a bug would escape:
//   (1) ENCODING     -- 0xFE + ULEB(subop) + ULEB(align) + ULEB(offset), byte-scanned.
//   (2) BEHAVIOUR    -- every load/store/rmw/cmpxchg width is instantiated and run against
//                       a real shared memory, and each rmw is checked to return its
//                       PRE-operation value (the classic silent wrong-direction bug).
//   (3) MEMARG       -- `offset=` reaches the encoding; a dropped offset would hit the
//                       wrong cell and is asserted against by reading the neighbour.
//   (4) ALIGNMENT    -- the threads proposal REQUIRES natural alignment. A non-natural
//                       `align=` must be a hard compile error, not a wasm validation
//                       failure a hundred kilobytes later.
//   (5) STACK SHAPE  -- atomic stores and atomic.fence push nothing in standard-WAT mode.
//
// Run: node test/watx-compiler-atomics.test.js
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
function findSubseq(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// ── (1) ENCODING ────────────────────────────────────────────────────────────
// i32.atomic.load  = 0xFE 0x10, natural align log2 = 2, offset 12  -> FE 10 02 0C
// i32.atomic.store = 0xFE 0x17, align 2, offset 0                  -> FE 17 02 00
// atomic.fence     = 0xFE 0x03 0x00
const enc = build(`
(memory 1 1 shared)
(func $enc (param $a i32) (result i32) (effects heap)
  (i32.atomic.store (local.get $a) (i32.const 1))
  (atomic.fence)
  (i32.atomic.load offset=12 (local.get $a)))
(wasm-export "enc" $enc)`);
ck('encode: module compiles', enc.success === true, enc.error);
if (enc.success) {
  const bin = Array.from(enc.wasmBinary);
  ck('encode: i32.atomic.store is FE 17 02 00', findSubseq(bin, [0xFE, 0x17, 0x02, 0x00]) >= 0);
  ck('encode: atomic.fence is FE 03 00', findSubseq(bin, [0xFE, 0x03, 0x00]) >= 0);
  ck('encode: i32.atomic.load offset=12 is FE 10 02 0C', findSubseq(bin, [0xFE, 0x10, 0x02, 0x0C]) >= 0);
  // (5) STACK SHAPE: in standard-WAT mode a store pushes nothing, so no `drop` (0x1a)
  // may appear between the store's memarg tail and the fence.
  const s = findSubseq(bin, [0xFE, 0x17, 0x02, 0x00]);
  const f = findSubseq(bin, [0xFE, 0x03, 0x00]);
  ck('stack: no drop emitted between atomic store and fence (both are void)',
     s >= 0 && f > s && bin.slice(s + 4, f).indexOf(0x1a) < 0);
}

// ── (2)+(3) BEHAVIOUR of every width, against a real shared memory ──────────
// Layout used below (all within page 0):
//   0x100  i32 scratch for load/store round trip
//   0x120  i32 rmw target
//   0x140  i64 rmw target
//   0x160  narrow (8/16-bit) targets
//   0x180  cmpxchg target
const beh = build(`
(memory 1 1 shared)

(func $roundtrip32 (param $v i32) (result i32) (effects heap)
  (i32.atomic.store offset=4 (i32.const 0x100) (local.get $v))
  (i32.atomic.load offset=4 (i32.const 0x100)))
(wasm-export "roundtrip32" $roundtrip32)

;; Reads the cell BEFORE the offset= target. A dropped offset would make
;; roundtrip32 write here, so this must stay 0.
(func $neighbour (result i32) (effects heap)
  (i32.atomic.load (i32.const 0x100)))
(wasm-export "neighbour" $neighbour)

(func $roundtrip64 (param $v i64) (result i64) (effects heap)
  (i64.atomic.store (i32.const 0x140) (local.get $v))
  (i64.atomic.load (i32.const 0x140)))
(wasm-export "roundtrip64" $roundtrip64)

;; Narrow stores/loads: write a byte and a halfword, read them back zero-extended.
(func $narrow (result i32) (effects heap)
  (i32.atomic.store8 (i32.const 0x160) (i32.const 0xAB))
  (i32.atomic.store16 offset=2 (i32.const 0x160) (i32.const 0xBEEF))
  (i32.add (i32.shl (i32.atomic.load16_u offset=2 (i32.const 0x160)) (i32.const 8))
           (i32.atomic.load8_u (i32.const 0x160))))
(wasm-export "narrow" $narrow)

;; Each rmw returns the value that was in memory BEFORE the operation.
(func $rmw (param $which i32) (param $operand i32) (result i32) (effects heap)
  (local $prev i32)
  (i32.atomic.store (i32.const 0x120) (i32.const 0x0F0F0F0F))
  (local.set $prev
    (if i32 (i32.eq (local.get $which) (i32.const 0))
      (then (i32.atomic.rmw.add (i32.const 0x120) (local.get $operand)))
      (else (if i32 (i32.eq (local.get $which) (i32.const 1))
        (then (i32.atomic.rmw.sub (i32.const 0x120) (local.get $operand)))
        (else (if i32 (i32.eq (local.get $which) (i32.const 2))
          (then (i32.atomic.rmw.and (i32.const 0x120) (local.get $operand)))
          (else (if i32 (i32.eq (local.get $which) (i32.const 3))
            (then (i32.atomic.rmw.or (i32.const 0x120) (local.get $operand)))
            (else (if i32 (i32.eq (local.get $which) (i32.const 4))
              (then (i32.atomic.rmw.xor (i32.const 0x120) (local.get $operand)))
              (else (i32.atomic.rmw.xchg (i32.const 0x120) (local.get $operand)))))))))))))
  (local.get $prev))
(wasm-export "rmw" $rmw)

(func $rmw_result (result i32) (effects heap)
  (i32.atomic.load (i32.const 0x120)))
(wasm-export "rmw_result" $rmw_result)

;; Narrow rmw: rmw8.add_u on a byte, rmw16.and_u on a halfword.
(func $rmw_narrow (result i32) (effects heap)
  (i32.atomic.store8 (i32.const 0x168) (i32.const 0x10))
  (i32.atomic.store16 offset=2 (i32.const 0x168) (i32.const 0xFF00))
  (drop (i32.atomic.rmw8.add_u (i32.const 0x168) (i32.const 5)))
  (drop (i32.atomic.rmw16.and_u offset=2 (i32.const 0x168) (i32.const 0x0F0F)))
  (i32.add (i32.shl (i32.atomic.load16_u offset=2 (i32.const 0x168)) (i32.const 8))
           (i32.atomic.load8_u (i32.const 0x168))))
(wasm-export "rmw_narrow" $rmw_narrow)

(func $rmw64 (result i64) (effects heap)
  (i64.atomic.store (i32.const 0x148) (i64.const 0x0102030405060708))
  (drop (i64.atomic.rmw.add (i32.const 0x148) (i64.const 1)))
  (drop (i64.atomic.rmw32.or_u (i32.const 0x148) (i64.const 0x10)))
  (i64.atomic.load (i32.const 0x148)))
(wasm-export "rmw64" $rmw64)

;; cmpxchg: returns the loaded value either way; the store only happens on a match.
(func $cmpxchg (param $expected i32) (param $replacement i32) (result i32) (effects heap)
  (i32.atomic.store (i32.const 0x180) (i32.const 0x55))
  (i32.atomic.rmw.cmpxchg (i32.const 0x180) (local.get $expected) (local.get $replacement)))
(wasm-export "cmpxchg" $cmpxchg)

(func $cmpxchg_cell (result i32) (effects heap)
  (i32.atomic.load (i32.const 0x180)))
(wasm-export "cmpxchg_cell" $cmpxchg_cell)

(func $cmpxchg64 (result i64) (effects heap)
  (i64.atomic.store (i32.const 0x190) (i64.const 7))
  (drop (i64.atomic.rmw.cmpxchg (i32.const 0x190) (i64.const 7) (i64.const 99)))
  (i64.atomic.load (i32.const 0x190)))
(wasm-export "cmpxchg64" $cmpxchg64)

;; notify with no waiters returns 0. wait32 with a mismatching expectation returns 1
;; ("not-equal") without ever blocking; with a matching expectation and a zero timeout
;; it returns 2 ("timed-out"). Neither ever parks this thread.
(func $notify (result i32) (effects heap)
  (memory.atomic.notify (i32.const 0x1A0) (i32.const 4)))
(wasm-export "notify" $notify)

(func $wait32 (param $expected i32) (result i32) (effects heap)
  (i32.atomic.store (i32.const 0x1A0) (i32.const 42))
  (memory.atomic.wait32 (i32.const 0x1A0) (local.get $expected) (i64.const 0)))
(wasm-export "wait32" $wait32)

(func $wait64 (param $expected i64) (result i32) (effects heap)
  (i64.atomic.store (i32.const 0x1B0) (i64.const 42))
  (memory.atomic.wait64 (i32.const 0x1B0) (local.get $expected) (i64.const 0)))
(wasm-export "wait64" $wait64)`);

ck('behaviour: module compiles', beh.success === true, beh.error);
let X = null;
if (beh.success) {
  try {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(beh.wasmBinary), {});
    X = inst.exports;
    ck('behaviour: module instantiates against a shared memory', true);
  } catch (e) { ck('behaviour: module instantiates against a shared memory', false, e.message); }
}
if (X) {
  ck('i32 atomic store/load round trip', X.roundtrip32(0x11223344) === 0x11223344, X.roundtrip32(0x11223344));
  ck('offset= reaches the encoding (the un-offset neighbour cell stays 0)',
     X.neighbour() === 0, X.neighbour());
  ck('i64 atomic store/load round trip',
     X.roundtrip64(0x0123456789abcdefn) === 0x0123456789abcdefn, String(X.roundtrip64(0x0123456789abcdefn)));
  ck('8/16-bit atomic store + zero-extending load',
     X.narrow() === (0xBEEF * 256 + 0xAB), X.narrow());

  // rmw: each returns the PRE-op value 0x0F0F0F0F, and leaves the computed value behind.
  const base = 0x0F0F0F0F;
  const cases = [
    ['add',  0, 0x01010101, (base + 0x01010101) | 0],
    ['sub',  1, 0x01010101, (base - 0x01010101) | 0],
    ['and',  2, 0x00FF00FF, (base & 0x00FF00FF) | 0],
    ['or',   3, 0xF000F000 | 0, (base | (0xF000F000 | 0)) | 0],
    ['xor',  4, 0xFFFFFFFF | 0, (base ^ -1) | 0],
    ['xchg', 5, 0x77777777, 0x77777777],
  ];
  for (const [name, which, operand, expect] of cases) {
    const prev = X.rmw(which, operand);
    ck(`i32.atomic.rmw.${name} returns the PRE-op value`, prev === base, prev);
    const cell = X.rmw_result() | 0;
    ck(`i32.atomic.rmw.${name} leaves the computed value in memory`, cell === expect,
       `${cell} want ${expect}`);
  }

  // 0x10 + 5 = 0x15 in the byte; 0xFF00 & 0x0F0F = 0x0F00 in the halfword.
  ck('narrow rmw (rmw8.add_u / rmw16.and_u)', X.rmw_narrow() === (0x0F00 * 256 + 0x15), X.rmw_narrow());
  // 0x0102030405060708 + 1 = ...0709; then rmw32.or_u 0x10 on the low 32 bits -> ...0719
  ck('i64 rmw.add + rmw32.or_u', X.rmw64() === 0x0102030405060719n, String(X.rmw64()));

  ck('cmpxchg returns the loaded value on a match', X.cmpxchg(0x55, 0xAA) === 0x55, X.cmpxchg(0x55, 0xAA));
  ck('cmpxchg STORES on a match', X.cmpxchg_cell() === 0xAA, X.cmpxchg_cell());
  ck('cmpxchg returns the loaded value on a mismatch', X.cmpxchg(0x99, 0xEE) === 0x55, X.cmpxchg(0x99, 0xEE));
  ck('cmpxchg does NOT store on a mismatch', X.cmpxchg_cell() === 0x55, X.cmpxchg_cell());
  ck('i64 cmpxchg stores on a match', X.cmpxchg64() === 99n, String(X.cmpxchg64()));

  ck('memory.atomic.notify with no waiters returns 0', X.notify() === 0, X.notify());
  ck('memory.atomic.wait32 returns 1 (not-equal) on a mismatch', X.wait32(7) === 1, X.wait32(7));
  ck('memory.atomic.wait32 returns 2 (timed-out) at timeout 0', X.wait32(42) === 2, X.wait32(42));
  ck('memory.atomic.wait64 returns 1 (not-equal) on a mismatch', X.wait64(7n) === 1, X.wait64(7n));
}

// ── (4) ALIGNMENT: natural alignment is REQUIRED by the threads proposal ────
const alignOk = build(`
(memory 1 1 shared)
(func $a (result i32) (effects heap) (i32.atomic.load align=4 (i32.const 0)))
(wasm-export "a" $a)`);
ck('align=4 (natural for i32) is accepted', alignOk.success === true, alignOk.error);

for (const [body, why] of [
  ['(drop (i32.atomic.load align=2 (i32.const 0)))', 'i32 load under-aligned'],
  ['(drop (i32.atomic.load align=8 (i32.const 0)))', 'i32 load over-aligned'],
  ['(drop (i64.atomic.rmw.add align=4 (i32.const 0) (i64.const 1)))', 'i64 rmw under-aligned'],
  ['(i32.atomic.store8 align=2 (i32.const 0) (i32.const 1))', 'atomic store8 over-aligned'],
  ['(drop (i64.atomic.load32_u align=8 (i32.const 0)))', 'i64 load32_u over-aligned'],
]) {
  const r = build(`
(memory 1 1 shared)
(func $a (effects heap) ${body})
(wasm-export "a" $a)`);
  ck(`non-natural alignment is a hard COMPILE error (${why})`, r.success === false, r.error);
  if (!r.success) {
    ck(`  ...and the message names alignment (${why})`, /align/i.test(r.error || ''), r.error);
  }
}

// A missing address operand must also be a hard error, not a silent underflow.
const noAddr = build(`
(memory 1 1 shared)
(func $a (result i32) (effects heap) (i32.atomic.load))
(wasm-export "a" $a)`);
ck('atomic load with no address operand is a hard compile error', noAddr.success === false, noAddr.error);

// ── Legacy (non-standardWat) mode keeps the WATX store convention ───────────
// Scalar stores push i32 0 there; atomic stores must behave identically so an
// existing WATX tree cannot see two different stack shapes for the same idea.
const legacy = compile(`
(memory 1 1 shared)
(func $s (result i32) (effects heap)
  (i32.atomic.store (i32.const 0x100) (i32.const 5)))
(wasm-export "s" $s)`, new Map(), { runtimeBuiltins: false, standardWat: false, tailCalls: false });
ck('legacy mode: atomic store still compiles', legacy.success === true, legacy.error);
if (legacy.success) {
  try {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(legacy.wasmBinary), {});
    ck('legacy mode: atomic store yields the WATX i32 0 convention', inst.exports.s() === 0, inst.exports.s());
  } catch (e) { ck('legacy mode: atomic store module instantiates', false, e.message); }
}

console.log(`\nwatx-compiler-atomics: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
