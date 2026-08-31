// test/watx-compiler-simd-memarg.test.js -- WATX migration gap G3: `offset=` / `align=`
// memargs on the v128 memory operations.
//
// docs/watx-migration-gaps.md G3: `v128.load` / `v128.store` hard-coded align=4 offset=0 and
// rejected a memarg outright ("Unknown symbol 'offset=16'"). The census's own regression
// design is used here: store a known 32-byte pattern and read the SECOND half back with
// `(v128.load offset=16 ...)`, so a silently-dropped offset returns the first half and
// fails, rather than passing by luck on a uniform buffer.
//
// The same memarg wiring covers the v128 splat/widening loads, `v128.loadN_zero`, and the
// per-lane `v128.loadN_lane` / `v128.storeN_lane` forms, which carry a memarg AND a lane
// immediate. Those are exercised too -- a family half-wired is the failure mode this
// migration exists to remove.
//
// Run: node test/watx-compiler-simd-memarg.test.js
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

const r = build(`

;; Copy the 16 bytes at $src+16 to 256. With the offset dropped this copies $src+0.
(func $second_half (param $src i32) (effects heap)
  (v128.store (i32.const 256) (v128.load offset=16 (local.get $src))))
(wasm-export "second_half" $second_half)

;; Write through a store offset: the vector lands at 256+16, leaving 256..271 untouched.
(func $store_offset (effects heap)
  (v128.store offset=16 (i32.const 256) (v128.load (i32.const 0))))
(wasm-export "store_offset" $store_offset)

;; align= is a hint on v128 memory ops (unlike atomics) and must be accepted and encoded.
(func $unaligned (param $src i32) (effects heap)
  (v128.store align=1 (i32.const 256) (v128.load align=1 offset=1 (local.get $src))))
(wasm-export "unaligned" $unaligned)

;; Splat / widening / zero loads, all memarg-carrying.
(func $splat8 (effects heap)  (v128.store (i32.const 256) (v128.load8_splat offset=3 (i32.const 0))))
(wasm-export "splat8" $splat8)
(func $splat32 (effects heap) (v128.store (i32.const 256) (v128.load32_splat offset=4 (i32.const 0))))
(wasm-export "splat32" $splat32)
(func $widen (effects heap)   (v128.store (i32.const 256) (v128.load8x8_u offset=8 (i32.const 0))))
(wasm-export "widen" $widen)
(func $zero32 (effects heap)  (v128.store (i32.const 256) (v128.load32_zero offset=4 (i32.const 0))))
(wasm-export "zero32" $zero32)

;; Lane loads/stores carry BOTH a memarg and a lane immediate.
(func $load_lane (effects heap)
  (v128.store (i32.const 256)
    (v128.load8_lane offset=5 2 (i32.const 0) (v128.const 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0))))
(wasm-export "load_lane" $load_lane)
(func $store_lane (effects heap)
  (v128.store32_lane offset=4 3 (i32.const 256) (v128.load (i32.const 0))))
(wasm-export "store_lane" $store_lane)`);

ck('memarg: module compiles', r.success === true, r.error);

if (r.success) {
  // v128.load  = 0xFD 0x00, v128.store = 0xFD 0x0B. The two memarg bytes follow:
  // align(log2) then offset. offset=16 with the default 16-byte align -> 04 10.
  const bin = Array.from(r.wasmBinary);
  ck('memarg: v128.load offset=16 encodes as FD 00 04 10',
     findSubseq(bin, [0xFD, 0x00, 0x04, 0x10]) >= 0);
  ck('memarg: v128.store offset=16 encodes as FD 0B 04 10',
     findSubseq(bin, [0xFD, 0x0B, 0x04, 0x10]) >= 0);
  ck('memarg: align=1 offset=1 on v128.load encodes as FD 00 00 01',
     findSubseq(bin, [0xFD, 0x00, 0x00, 0x01]) >= 0);

  let X = null, mem = null;
  try {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(r.wasmBinary), {});
    X = inst.exports; mem = new Uint8Array(inst.exports.memory.buffer);
    ck('memarg: module instantiates', true);
  } catch (e) { ck('memarg: module instantiates', false, e.message); }

  if (X) {
    // 32 distinct bytes at 0: 0x00..0x1F. First half 0x00-0x0F, second 0x10-0x1F.
    for (let i = 0; i < 32; i++) mem[i] = i;
    mem.fill(0, 256, 320);
    X.second_half(0);
    const got = Array.from(mem.slice(256, 272));
    ck('v128.load offset=16 reads the SECOND half, not the first',
       got.every((v, i) => v === 16 + i), got.join(','));

    mem.fill(0, 256, 320);
    X.store_offset();
    ck('v128.store offset=16 writes past the base address (256..271 untouched)',
       Array.from(mem.slice(256, 272)).every(v => v === 0), Array.from(mem.slice(256, 272)).join(','));
    ck('v128.store offset=16 writes at base+16',
       Array.from(mem.slice(272, 288)).every((v, i) => v === i), Array.from(mem.slice(272, 288)).join(','));

    mem.fill(0, 256, 320);
    X.unaligned(0);
    ck('align=1 offset=1 loads the byte-shifted window',
       Array.from(mem.slice(256, 272)).every((v, i) => v === i + 1), Array.from(mem.slice(256, 272)).join(','));

    mem.fill(0, 256, 320);
    X.splat8();
    ck('v128.load8_splat offset=3 splats byte 3 (value 3)',
       Array.from(mem.slice(256, 272)).every(v => v === 3), Array.from(mem.slice(256, 272)).join(','));

    mem.fill(0, 256, 320);
    X.splat32();
    ck('v128.load32_splat offset=4 splats the dword at byte 4',
       Array.from(mem.slice(256, 272)).join(',') === [4,5,6,7, 4,5,6,7, 4,5,6,7, 4,5,6,7].join(','),
       Array.from(mem.slice(256, 272)).join(','));

    mem.fill(0, 256, 320);
    X.widen();
    // bytes 8..15 = 8,9,10,...15 zero-extended into eight 16-bit lanes
    ck('v128.load8x8_u offset=8 widens eight bytes into i16 lanes',
       Array.from(mem.slice(256, 272)).join(',') === [8,0,9,0,10,0,11,0,12,0,13,0,14,0,15,0].join(','),
       Array.from(mem.slice(256, 272)).join(','));

    mem.fill(0, 256, 320);
    X.zero32();
    ck('v128.load32_zero offset=4 loads one dword and zeroes the rest',
       Array.from(mem.slice(256, 272)).join(',') === [4,5,6,7, 0,0,0,0, 0,0,0,0, 0,0,0,0].join(','),
       Array.from(mem.slice(256, 272)).join(','));

    mem.fill(0, 256, 320);
    X.load_lane();
    // lane 2 of an all-zero vector replaced by the byte at offset 5 (value 5)
    ck('v128.load8_lane writes only its lane, at its memarg offset',
       Array.from(mem.slice(256, 272)).join(',') === [0,0,5,0, 0,0,0,0, 0,0,0,0, 0,0,0,0].join(','),
       Array.from(mem.slice(256, 272)).join(','));

    mem.fill(0, 256, 320);
    X.store_lane();
    // lane 3 of the vector at 0 = bytes 12..15, written at 256+4
    ck('v128.store32_lane writes the named lane at base+offset',
       Array.from(mem.slice(256, 272)).join(',') === [0,0,0,0, 12,13,14,15, 0,0,0,0, 0,0,0,0].join(','),
       Array.from(mem.slice(256, 272)).join(','));
  }
}

// A malformed memarg must be a hard error, not a silent 0.
const badAlign = build(`
(func $a (effects heap) (v128.store (i32.const 0) (v128.load align=3 (i32.const 0))))
(wasm-export "a" $a)`);
ck('v128.load align=3 (not a power of two) is a hard compile error', badAlign.success === false, badAlign.error);

const badOffset = build(`
(func $a (effects heap) (v128.store (i32.const 0) (v128.load offset=abc (i32.const 0))))
(wasm-export "a" $a)`);
ck('v128.load offset=abc is a hard compile error', badOffset.success === false, badOffset.error);

// In standard-WAT mode a v128 store is void, exactly like a scalar store: no phantom i32.
const voidStore = build(`
(func $a (result i32) (effects heap)
  (v128.store (i32.const 0) (v128.load (i32.const 16)))
  (i32.const 7))
(wasm-export "a" $a)`);
ck('standard-WAT mode: v128.store is void and the function still returns 7',
   voidStore.success === true, voidStore.error);
if (voidStore.success) {
  try {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(voidStore.wasmBinary), {});
    ck('standard-WAT mode: v128.store leaves nothing on the stack', inst.exports.a() === 7, inst.exports.a());
  } catch (e) { ck('standard-WAT mode: v128.store leaves nothing on the stack', false, e.message); }
}

console.log(`\nwatx-compiler-simd-memarg: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
