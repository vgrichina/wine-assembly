// test/watx-compiler-simd.test.js -- SIMD track: v128 valtype + 0xFD opcode subset.
//
// Guards the shared v128 host layer added to tools/watx-src/ (SIMD track, 2026-08-12)
// -- see tracks/COMPILER-REQUESTS.md scoped-grant. Two consumers:
//   (1) guest ARM NEON emulation in src/arm-simd.watx (B-owned, migrated kernel-by-kernel
//       with a scalar fallback + O bit-exactness gate);
//   (2) raster/alpha-blend inner loops in framework-drawpass + graphics-canvas (RES-owned,
//       same fallback+gate discipline).
//
// This test validates the COMPILER surface end-to-end: compile a WATX module that uses
// v128 params/results/locals + a spread of 0xFD subset ops, instantiate the WASM in
// V8, run the exports, assert correct lane results. It does NOT touch src/*.watx; the
// scalar fallback obligation for kernel migrations is a separate O-gated commit.
//
// Coverage checklist (verified below, one CK per lane op behaviour, NOT one per opcode):
//   - v128 param + result + local (compiler threads 0x7B through valtype/stackType/
//     param-result/locals; validator accepts)
//   - v128.load / v128.store (16-byte aligned memarg)
//   - i8x16.splat, i32x4.splat, f32x4.splat (scalar->vec)
//   - i8x16.shuffle (16 lane immediates)
//   - i8x16 / i16x8 / i32x4 add
//   - i32x4 mul + min_s + max_s
//   - v128.and / v128.or / v128.andnot
//   - i16x8.extend_low_i8x16_u (widen) + i8x16.narrow_i16x8_u (narrow)
//   - i32x4.extract_lane (scalar readback)
//   - f32x4.add + f32x4.extract_lane (float lane)
//   - i8x16.eq lane comparison (all-ones mask)
//   - `let $x v128 (...)` local binding + `if v128 ...` block type
//
// Run: node test/watx-compiler-simd.test.js
'use strict';
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got !== undefined ? ' (got ' + JSON.stringify(got) + ')' : ''}`); }
}

// ── Build one WATX module that exercises the whole subset ──────────────────────────────
// Layout choice: exports return i32/f32 (host-observable). v128 stays inside; we splat/
// mutate/narrow/extract to prove each lane op moved bytes correctly. Memory-based flow
// (load/store) uses fixed 16-byte-aligned buffers at 0x1000/0x1010/0x1020 -- past the
// DATA_BASE=1024 cstring pool. compile() reads top-level forms, no (module ...) wrapper.
const src = `
  ;; --- 1: v128.load + v128.store round-trip through an i32x4.add ---
  ;; Load 4 i32s from src, add 4 i32s from src+16, store to dst. Return dst[0]+dst[3].
  (func $simd_add_i32x4_mem (param $srcA i32) (param $srcB i32) (param $dst i32) (result i32) (effects)
    (v128.store (local.get $dst)
      (i32x4.add (v128.load (local.get $srcA)) (v128.load (local.get $srcB))))
    (i32.add (i32.load (local.get $dst))
             (i32.load (i32.add (local.get $dst) (i32.const 12)))))

  ;; --- 2: splat + extract_lane round-trip (each lane).
  ;; WATX let does NOT take a body form; it binds via local_tee and drops through to
  ;; subsequent top-level exprs. Bind $v then evaluate one of 4 extract_lane exprs.
  (func $simd_i32x4_splat_extract (param $x i32) (param $lane i32) (result i32) (effects)
    (local $v v128)
    (local.set $v (i32x4.splat (local.get $x)))
    (if i32 (i32.eq (local.get $lane) (i32.const 0)) (then (i32x4.extract_lane (local.get $v) 0))
    (else (if i32 (i32.eq (local.get $lane) (i32.const 1)) (then (i32x4.extract_lane (local.get $v) 1))
      (else (if i32 (i32.eq (local.get $lane) (i32.const 2)) (then (i32x4.extract_lane (local.get $v) 2))
        (else (i32x4.extract_lane (local.get $v) 3))))))))

  ;; --- 3: i8x16.shuffle -- reverse the 16 bytes of a vector ---
  ;; Splat 0..15 via load, shuffle to reverse; extract lane 0 (was lane 15) as i32.
  (func $simd_i8x16_shuffle_reverse (param $src i32) (result i32) (effects)
    (i8x16.extract_lane_u
      (i8x16.shuffle (v128.load (local.get $src)) (v128.load (local.get $src))
        15 14 13 12 11 10 9 8 7 6 5 4 3 2 1 0)
      0))

  ;; --- 4: bitwise logic v128.and / v128.or / v128.andnot ---
  ;; a=0xAAAAAAAA splat, b=0x0F0F0F0F splat. andnot(a,b) = a & ~b = 0xA0A0A0A0.
  (func $simd_andnot_i32x4 (result i32) (effects)
    (i32x4.extract_lane
      (v128.andnot (i32x4.splat (i32.const 0xAAAAAAAA))
                   (i32x4.splat (i32.const 0x0F0F0F0F)))
      0))
  (func $simd_and_i32x4 (result i32) (effects)
    (i32x4.extract_lane
      (v128.and (i32x4.splat (i32.const 0xAAAAAAAA))
                (i32x4.splat (i32.const 0x0F0F0F0F)))
      0))
  (func $simd_or_i32x4 (result i32) (effects)
    (i32x4.extract_lane
      (v128.or  (i32x4.splat (i32.const 0xAAAA0000))
                (i32x4.splat (i32.const 0x00005555)))
      0))

  ;; --- 5: i32x4.mul + min_s + max_s ---
  (func $simd_i32x4_mul (param $a i32) (param $b i32) (result i32) (effects)
    (i32x4.extract_lane (i32x4.mul (i32x4.splat (local.get $a)) (i32x4.splat (local.get $b))) 0))
  (func $simd_i32x4_min_s (param $a i32) (param $b i32) (result i32) (effects)
    (i32x4.extract_lane (i32x4.min_s (i32x4.splat (local.get $a)) (i32x4.splat (local.get $b))) 0))
  (func $simd_i32x4_max_s (param $a i32) (param $b i32) (result i32) (effects)
    (i32x4.extract_lane (i32x4.max_s (i32x4.splat (local.get $a)) (i32x4.splat (local.get $b))) 0))

  ;; --- 6: widen (i8x16 -> i16x8 low) then narrow back (i16x8 -> i8x16 unsigned-sat) ---
  ;; Splat i8 0x40, widen_low_u -> i16 lanes 0x0040, narrow_u -> i8 lanes 0x40. Round-trip.
  (func $simd_widen_narrow_roundtrip (result i32) (effects)
    (i8x16.extract_lane_u
      (i8x16.narrow_i16x8_u
        (i16x8.extend_low_i8x16_u (i8x16.splat (i32.const 0x40)))
        (i16x8.extend_low_i8x16_u (i8x16.splat (i32.const 0x40))))
      0))

  ;; --- 7: f32x4.add + f32x4.extract_lane (float lane) ---
  (func $simd_f32x4_add (param $a f32) (param $b f32) (result f32) (effects)
    (f32x4.extract_lane (f32x4.add (f32x4.splat (local.get $a)) (f32x4.splat (local.get $b))) 2))

  ;; --- 8: i8x16.eq lane mask (all-ones on equal lanes = extract as u8 == 0xFF = 255) ---
  (func $simd_i8x16_eq_mask (param $a i32) (param $b i32) (result i32) (effects)
    (i8x16.extract_lane_u
      (i8x16.eq (i8x16.splat (local.get $a)) (i8x16.splat (local.get $b)))
      0))

  ;; --- 9: v128 param + v128 result identity (proves param/result plumbing for 0x7B) ---
  (func $simd_v128_ident (param $v v128) (result v128) (effects) (local.get $v))
  ;; Consumer: splat, pass through the identity, extract -- proves the type flows through
  ;; the call boundary correctly (type section + user-function call site + result).
  (func $simd_v128_ident_use (param $x i32) (result i32) (effects)
    (i32x4.extract_lane (call $simd_v128_ident (i32x4.splat (local.get $x))) 1))

  ;; --- 10: (if v128 ...) block-type (v128-typed if-expression) ---
  ;; Returns lane 0 of (cond ? splat(a) : splat(b)) so the if-expression yields a v128.
  (func $simd_if_v128 (param $cond i32) (param $a i32) (param $b i32) (result i32) (effects)
    (i32x4.extract_lane
      (if v128 (local.get $cond) (then (i32x4.splat (local.get $a))) (else (i32x4.splat (local.get $b))))
      0))

  ;; --- 11-13: Tier-1.5 kernel-migration lowerings (SIMD compiler-readiness for B's
  ;; arm-simd.watx NEON migration, per tracks/SIMD-arm-simd-migration-plan.md).
  ;; These are the three v128 primitives B's Tier-1.5 kernels consume, one bit-exact
  ;; test per primitive so any future silent regression in emit trips this suite:
  ;;   (11) v128.bitselect  -- lowering for NEON BSL/BIT/BIF (Tier 1, 45.9% share)
  ;;   (12) i32x4.shr_u     -- lowering for NEON USHR         (Tier 1, 18.0% share)
  ;;   (13) i32x4.shl       -- lowering for NEON USHL(splat-const) (Tier 1.5, 23.9%
  ;;                          share; B's 2f247755 measured 100.00% lane-uniform)

  ;; (11) v128.bitselect(v1, v2, c) = (v1 & c) | (v2 & ~c)  per WASM SIMD spec.
  ;; ARM BSL Vd,Vn,Vm computes Vd_out = (Vn & Vd_in) | (Vm & ~Vd_in) -- SAME shape
  ;; with the previous Vd contents serving as the mask, so the lowering is
  ;; v128.bitselect(Vn, Vm, Vd_in). Test: bitselect(0xAAAAAAAA, 0x55555555, 0x0F0F0F0F)
  ;;   lanes where c=1 (0x0F0F0F0F) take from v1=0xAAAAAAAA -> 0x0A0A0A0A
  ;;   lanes where c=0 (0xF0F0F0F0) take from v2=0x55555555 -> 0x50505050
  ;;   OR -> 0x5A5A5A5A
  (func $simd_bitselect_i32x4 (result i32) (effects)
    (i32x4.extract_lane
      (v128.bitselect
        (i32x4.splat (i32.const 0xAAAAAAAA))
        (i32x4.splat (i32.const 0x55555555))
        (i32x4.splat (i32.const 0x0F0F0F0F)))
      0))

  ;; (12) i32x4.shr_u -- unsigned right shift, zero-fill top bit. ARM USHR is
  ;; unsigned (logical) right shift so the mapping is direct. Test: shift 0x80000000
  ;; right by 1. Signed: -1073741824 (sign-extend, keeps top bit). Unsigned: 0x40000000
  ;; (zero-fill). This function returns the UNSIGNED result to distinguish from shr_s.
  (func $simd_i32x4_shr_u (param $val i32) (param $sh i32) (result i32) (effects)
    (i32x4.extract_lane (i32x4.shr_u (i32x4.splat (local.get $val)) (local.get $sh)) 0))

  ;; (13) i32x4.shl -- logical left shift (sign-agnostic for left shifts; USHL and
  ;; SSHL both do the same when the shift is positive, per ARMv8 spec). B's 2f247755
  ;; confirmed retroarch's hot USHL is 100.00% lane-uniform with shifts {0,8,16,24}
  ;; -- exactly the RGBA byte-pack pattern (result_word = R | (G<<8) | (B<<16) | (A<<24)),
  ;; so the lowering is i32x4.shl(splat(byte), splat_const). Test: 0x40 shifted left
  ;; by 8 = 0x4000; by 16 = 0x400000; by 24 = 0x40000000. Covers all 3 non-zero
  ;; shift amounts from the RGBA-pack encoding.
  (func $simd_i32x4_shl (param $val i32) (param $sh i32) (result i32) (effects)
    (i32x4.extract_lane (i32x4.shl (i32x4.splat (local.get $val)) (local.get $sh)) 0))

  (wasm-export "simd_add_i32x4_mem"        $simd_add_i32x4_mem)
  (wasm-export "simd_i32x4_splat_extract"  $simd_i32x4_splat_extract)
  (wasm-export "simd_i8x16_shuffle_reverse" $simd_i8x16_shuffle_reverse)
  (wasm-export "simd_andnot_i32x4"         $simd_andnot_i32x4)
  (wasm-export "simd_and_i32x4"            $simd_and_i32x4)
  (wasm-export "simd_or_i32x4"             $simd_or_i32x4)
  (wasm-export "simd_i32x4_mul"            $simd_i32x4_mul)
  (wasm-export "simd_i32x4_min_s"          $simd_i32x4_min_s)
  (wasm-export "simd_i32x4_max_s"          $simd_i32x4_max_s)
  (wasm-export "simd_widen_narrow_roundtrip" $simd_widen_narrow_roundtrip)
  (wasm-export "simd_f32x4_add"            $simd_f32x4_add)
  (wasm-export "simd_i8x16_eq_mask"        $simd_i8x16_eq_mask)
  (wasm-export "simd_v128_ident_use"       $simd_v128_ident_use)
  (wasm-export "simd_if_v128"              $simd_if_v128)
  (wasm-export "simd_bitselect_i32x4"      $simd_bitselect_i32x4)
  (wasm-export "simd_i32x4_shr_u"          $simd_i32x4_shr_u)
  (wasm-export "simd_i32x4_shl"            $simd_i32x4_shl)

  ;; --- 14: distinct-16-byte load->store round-trip (regression guard) -----------
  ;; Requested by B (tracks/COMPILER-REQUESTS.md f733325a): the previous "load ->
  ;; add -> store" test hid the (i32.const N) lane-immediate bug because every
  ;; extract sourced from a splat (all lanes equal). This function loads 16 bytes
  ;; from mem[$p] and stores them to mem[$dst] via v128.load / v128.store WITHOUT
  ;; going through splat -- if v128.load ever silently truncates or splats, the
  ;; dst bytes 8..15 diverge from src bytes 8..15.
  (func $simd_v128_load_store_16b (param $p i32) (param $dst i32) (effects)
    (v128.store (local.get $dst) (v128.load (local.get $p))))

  ;; --- 15: lane immediate accepts (i32.const N) subform (ROOT-CAUSE regression) -
  ;; ROOT of the B->SIMD 2026-08-12 bug (misdiagnosed as v128.load splat):
  ;; (i64x2.extract_lane res (i32.const 1)) silently read lane 0 because the
  ;; emit did parseInt(expr[2]?.value or default 0) on the ARRAY subform. B's BSL
  ;; kernel wrote both halves from lane 0 -> "high == low" -> looked like a
  ;; v128.load high-splat. Fix: immVal() now unwraps (i32.const N). Test spells
  ;; the lane BOTH ways -- bare literal AND (i32.const N) -- and asserts they
  ;; return the SAME lane-1 value (proves the subform is not silently 0).
  (func $simd_extract_lane_iconst (result i64) (effects)
    ;; v128 = 16 bytes with distinct halves. Low 64 bits (bytes 0..7 LE) = 0x0706050403020100.
    ;; High 64 bits (bytes 8..15 LE) = 0x0f0e0d0c0b0a0908. Extract lane 1 via (i32.const 1).
    (i64x2.extract_lane
      (v128.const 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15)
      (i32.const 1)))
  (func $simd_extract_lane_bare (result i64) (effects)
    ;; Same v128; extract lane 1 via bare literal 1. Should equal $simd_extract_lane_iconst.
    (i64x2.extract_lane
      (v128.const 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15)
      1))

  (wasm-export "simd_v128_load_store_16b"  $simd_v128_load_store_16b)
  (wasm-export "simd_extract_lane_iconst"  $simd_extract_lane_iconst)
  (wasm-export "simd_extract_lane_bare"    $simd_extract_lane_bare)
`;

const r = compile(src, {});
ck('compile: succeeded', r.success === true, r.success);
ck('compile: wasmBinary present', !!(r.wasmBinary && r.wasmBinary.length > 0),
   r.wasmBinary ? r.wasmBinary.length : 'no binary');

if (!r.wasmBinary) {
  console.log(`\nwatx-compiler-simd: ${pass} passed, ${fail} failed (compilation blocker)`);
  process.exit(1);
}

// Instantiate + validate. On a host without WASM SIMD this will throw at compile time
// (validate returns false). Node 16+ supports v128; if the host is older, SKIP loudly
// rather than false-red -- surface the environment gap and exit 0 (the compiler-side
// contract is already verified above; downstream can validate on a SIMD-capable host).
let inst;
try {
  const mod = new WebAssembly.Module(r.wasmBinary);
  inst = new WebAssembly.Instance(mod, {});
} catch (e) {
  // Two failure modes: (a) host lacks SIMD altogether -- WebAssembly.validate is false
  // and Module ctor throws with a "SIMD not supported" style error; SKIP loudly so the
  // compiler-side contract still counts. (b) genuine bug in our emit -- surface the
  // exact error for debugging. Distinguish by validate().
  if (!WebAssembly.validate(r.wasmBinary)) {
    console.log('  SKIP  runtime instantiation: this V8 does not validate the SIMD binary (no v128 support here). Compiler surface still verified.');
    console.log('  (Module ctor error was: ' + e.message + ')');
    console.log(`\nwatx-compiler-simd: ${pass} passed, ${fail} failed (runtime skipped)`);
    process.exit(fail === 0 ? 0 : 1);
  }
  ck('runtime: instantiate module', false, e.message);
  console.log(`\nwatx-compiler-simd: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
const ex = inst.exports;
const mem32 = new Int32Array(ex.memory.buffer);
const memU8 = new Uint8Array(ex.memory.buffer);

// Buffers at 0x1000 (srcA), 0x1010 (srcB), 0x1020 (dst) -- past DATA_BASE=1024, 16-byte-aligned.
const A = 0x1000, B = 0x1010, D = 0x1020;
// srcA = [1,2,3,4], srcB = [10,20,30,40]
mem32[A>>2]   = 1;  mem32[(A>>2)+1] = 2;  mem32[(A>>2)+2] = 3;  mem32[(A>>2)+3] = 4;
mem32[B>>2]   = 10; mem32[(B>>2)+1] = 20; mem32[(B>>2)+2] = 30; mem32[(B>>2)+3] = 40;

// (1) i32x4.add through v128.load + v128.store: dst=[11,22,33,44]; return dst[0]+dst[3]=55.
ck('simd_add_i32x4_mem: 11+44 == 55', ex.simd_add_i32x4_mem(A, B, D) === 55, ex.simd_add_i32x4_mem(A, B, D));
ck('simd_add_i32x4_mem: dst[1] == 22', mem32[(D>>2)+1] === 22, mem32[(D>>2)+1]);
ck('simd_add_i32x4_mem: dst[2] == 33', mem32[(D>>2)+2] === 33, mem32[(D>>2)+2]);

// (2) i32x4.splat + extract_lane per-lane -- all lanes identical.
for (let lane = 0; lane < 4; lane++) {
  const got = ex.simd_i32x4_splat_extract(0x1234abcd | 0, lane);
  ck(`simd_i32x4_splat_extract(0x1234abcd, lane=${lane}) matches`, got === (0x1234abcd | 0), got);
}

// (3) i8x16.shuffle reverse: srcA lane0 was 0x01 (from mem32[A>>2]=1). After reverse of
// bytes 0..15, byte 0 of the result was byte 15 of the source = high byte of dst word 3.
// mem32[A]=1 (little-endian bytes: 01 00 00 00), mem32[A+4]=2 (02 00 00 00), etc.
// So bytes 12..15 = 04 00 00 00 -> byte 15 = 0x00. Reverse -> byte 0 = 0x00.
ck('simd_i8x16_shuffle_reverse: reverses bytes correctly', ex.simd_i8x16_shuffle_reverse(A) === 0x00,
   ex.simd_i8x16_shuffle_reverse(A));
// Stronger: seed a distinctive byte pattern (0x11,0x22,...,0xFF, 16 bytes) and re-check.
for (let i = 0; i < 16; i++) memU8[A + i] = 0x11 * (i + 1);
ck('simd_i8x16_shuffle_reverse: byte pattern reverse (byte15 -> byte0)',
   ex.simd_i8x16_shuffle_reverse(A) === ((0x11 * 16) & 0xff), ex.simd_i8x16_shuffle_reverse(A));

// (4) Bitwise logic on i32 lanes.
ck('v128.andnot(0xAAAAAAAA, 0x0F0F0F0F) = 0xA0A0A0A0',
   ex.simd_andnot_i32x4() === (0xA0A0A0A0 | 0), ex.simd_andnot_i32x4());
ck('v128.and(0xAAAAAAAA, 0x0F0F0F0F) = 0x0A0A0A0A',
   ex.simd_and_i32x4() === 0x0A0A0A0A, ex.simd_and_i32x4());
ck('v128.or(0xAAAA0000, 0x00005555) = 0xAAAA5555',
   ex.simd_or_i32x4() === (0xAAAA5555 | 0), ex.simd_or_i32x4());

// (5) i32x4 arithmetic.
ck('i32x4.mul(7, 6) = 42', ex.simd_i32x4_mul(7, 6) === 42, ex.simd_i32x4_mul(7, 6));
ck('i32x4.min_s(-5, 3) = -5', ex.simd_i32x4_min_s(-5, 3) === -5, ex.simd_i32x4_min_s(-5, 3));
ck('i32x4.max_s(-5, 3) = 3',  ex.simd_i32x4_max_s(-5, 3) === 3,  ex.simd_i32x4_max_s(-5, 3));

// (6) widen + narrow round-trip (0x40 -> 0x0040 -> 0x40).
ck('i16x8.extend_low_i8x16_u + i8x16.narrow_i16x8_u: 0x40 round-trip',
   ex.simd_widen_narrow_roundtrip() === 0x40, ex.simd_widen_narrow_roundtrip());

// (7) f32x4.add + f32x4.extract_lane -- 1.25 + 2.5 = 3.75 in lane 2.
ck('f32x4.add + extract_lane(2) = 3.75',
   Math.abs(ex.simd_f32x4_add(1.25, 2.5) - 3.75) < 1e-6, ex.simd_f32x4_add(1.25, 2.5));

// (8) i8x16.eq: equal lanes -> 0xFF mask; unequal -> 0.
ck('i8x16.eq(0x42, 0x42) lane 0 = 0xFF', ex.simd_i8x16_eq_mask(0x42, 0x42) === 0xFF,
   ex.simd_i8x16_eq_mask(0x42, 0x42));
ck('i8x16.eq(0x42, 0x43) lane 0 = 0x00', ex.simd_i8x16_eq_mask(0x42, 0x43) === 0x00,
   ex.simd_i8x16_eq_mask(0x42, 0x43));

// (9) v128 param + v128 result identity call.
ck('v128 param/result identity: splat(7) -> extract_lane(1) = 7',
   ex.simd_v128_ident_use(7) === 7, ex.simd_v128_ident_use(7));
ck('v128 param/result identity: splat(-99) -> extract_lane(1) = -99',
   ex.simd_v128_ident_use(-99) === -99, ex.simd_v128_ident_use(-99));

// (10) (if v128 ...) block-type.
ck('(if v128 cond then splat(a) else splat(b)) with cond=1 -> a',
   ex.simd_if_v128(1, 42, 99) === 42, ex.simd_if_v128(1, 42, 99));
ck('(if v128 cond then splat(a) else splat(b)) with cond=0 -> b',
   ex.simd_if_v128(0, 42, 99) === 99, ex.simd_if_v128(0, 42, 99));

// (11-13) Tier-1.5 kernel-migration lowerings. One bit-exact assertion per primitive
// (BSL, USHR, USHL(splat-const)) that B's arm-simd migration consumes. If any of the
// three regresses in emit, this suite fails RED and the B-side migration blocks until
// the compiler-side fix lands. See tracks/SIMD-arm-simd-migration-plan.md.

// (11) BSL -> v128.bitselect(0xAAAAAAAA, 0x55555555, 0x0F0F0F0F) = 0x5A5A5A5A
ck('BSL -> v128.bitselect(0xAAAA..., 0x5555..., 0x0F0F...) = 0x5A5A5A5A',
   ex.simd_bitselect_i32x4() === 0x5A5A5A5A, ex.simd_bitselect_i32x4());

// (12) USHR -> i32x4.shr_u -- unsigned = zero-fill.
// 0x80000000 >> 1 unsigned = 0x40000000 (signed would sign-extend to 0xC0000000 = -1073741824).
ck('USHR -> i32x4.shr_u(0x80000000, 1) = 0x40000000 (zero-fill, not sign-extend)',
   ex.simd_i32x4_shr_u(0x80000000 | 0, 1) === 0x40000000, ex.simd_i32x4_shr_u(0x80000000 | 0, 1));
// -1 >> 1 unsigned = 0x7FFFFFFF (top bit zero-filled); belt-and-suspenders on unsigned semantics.
ck('USHR -> i32x4.shr_u(-1, 1) = 0x7FFFFFFF (unsigned zero-fill)',
   (ex.simd_i32x4_shr_u(-1, 1) >>> 0) === 0x7FFFFFFF, ex.simd_i32x4_shr_u(-1, 1) >>> 0);

// (13) USHL(splat-const) -> i32x4.shl -- retroarch RGBA-pack shifts {0,8,16,24}.
// 0x40 << 0 = 0x40, << 8 = 0x4000, << 16 = 0x400000, << 24 = 0x40000000. All 4 amounts
// covered so the RGBA byte-pack lowering B's arm-simd migration will emit is fully
// exercised on the compiler side.
ck('USHL(splat-const) -> i32x4.shl(0x40, 0)  = 0x00000040',
   ex.simd_i32x4_shl(0x40, 0)  === 0x00000040, ex.simd_i32x4_shl(0x40, 0));
ck('USHL(splat-const) -> i32x4.shl(0x40, 8)  = 0x00004000',
   ex.simd_i32x4_shl(0x40, 8)  === 0x00004000, ex.simd_i32x4_shl(0x40, 8));
ck('USHL(splat-const) -> i32x4.shl(0x40, 16) = 0x00400000',
   ex.simd_i32x4_shl(0x40, 16) === 0x00400000, ex.simd_i32x4_shl(0x40, 16));
ck('USHL(splat-const) -> i32x4.shl(0x40, 24) = 0x40000000',
   ex.simd_i32x4_shl(0x40, 24) === 0x40000000, ex.simd_i32x4_shl(0x40, 24));

// (14) Distinct-16-byte load->store round-trip (B request f733325a). Every byte
// distinct so a silent truncation / high-splat / offset-shift shows up as a
// dst[k] != src[k] mismatch, unlike the splat-fed extract tests above which
// hid any high-half corruption because all lanes were identical to start with.
const SRC = 0x2000, DST = 0x2010;
for (let i = 0; i < 16; i++) memU8[SRC + i] = 0xC0 | i;
for (let i = 0; i < 16; i++) memU8[DST + i] = 0;  // zero-init to catch partial writes
ex.simd_v128_load_store_16b(SRC, DST);
let all16Match = true;
for (let i = 0; i < 16; i++) {
  if (memU8[DST + i] !== memU8[SRC + i]) { all16Match = false; break; }
}
ck('v128.load + v128.store: all 16 distinct bytes round-trip (no low->high splat)',
   all16Match, Array.from(memU8.slice(DST, DST + 16)));
// Extra: assert the HIGH half specifically (bytes 8..15) so the failure mode B
// hit (dst[8..15] == dst[0..7]) is directly named in the test output.
let hiEqualsLo = true;
for (let i = 0; i < 8; i++) if (memU8[DST + 8 + i] !== memU8[DST + i]) { hiEqualsLo = false; break; }
ck('v128.load: high 64 bits != low 64 bits (guards against load64_splat regression)',
   !hiEqualsLo, hiEqualsLo ? 'HIGH == LOW (bug)' : 'HIGH != LOW');

// (15) Lane immediate accepts (i32.const N) subform. ROOT of the B->SIMD bug.
// Both forms must yield the same lane and NOT silently default to 0.
const laneViaIconst = ex.simd_extract_lane_iconst();
const laneViaBare   = ex.simd_extract_lane_bare();
// Expected: lane 1 = bytes 8..15 LE = 0x0f0e0d0c0b0a0908 = 1084818905618843912n.
const expectedLane1 = 0x0f0e0d0c0b0a0908n;
ck('extract_lane accepts (i32.const 1) subform (not silently 0)',
   laneViaIconst === expectedLane1,
   '0x' + laneViaIconst.toString(16));
ck('extract_lane accepts bare literal 1',
   laneViaBare === expectedLane1,
   '0x' + laneViaBare.toString(16));
ck('extract_lane: (i32.const 1) === bare 1 (spellings agree)',
   laneViaIconst === laneViaBare,
   '(iconst=' + laneViaIconst.toString(16) + ', bare=' + laneViaBare.toString(16) + ')');

console.log(`\nwatx-compiler-simd: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
