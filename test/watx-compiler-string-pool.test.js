// test/watx-compiler-string-pool.test.js -- where interned strings are placed.
//
// WHY THIS SUITE EXISTS (2026-08-31).
//
// A bare "text" literal, `(string ...)` and `(cstring ...)` all intern into one
// pool, and the compiler placed that pool at
//
//     DATA_BASE = align16(max(staticCursor, max data-segment end))
//
// documented as "immediately ABOVE the static regions, so its bytes never
// overlap a region's storage". That reasoning holds only when WATX itself
// allocated the storage below, via `region.declare-static/-bump/-rc` -- those
// are the three heads that advance `staticCursor`.
//
// A module whose map comes from the `region.declare`/`-fixed`/`-derived`
// allocator advances `staticCursor` not at all. It stays at 1024, so "above the
// static regions" quietly degenerates to "above the last data segment" -- which
// is not above the map, it is a point in the MIDDLE of it.
//
// Measured in wine-assembly before this change: adding a single bare "ceil"
// literal to src/08b-dll-loader.wat placed it at 0x07B7B040, inside
// $D3DIM_AUX [0x07B7B000, 0x07B7C000), on top of live Direct3D state -- and the
// entire build passed. Nothing could see it: the pre-existing guard covers only
// [1024, staticCursor), and tools/wasm-data.js compares data SEGMENTS to each
// other, while a region's storage is not a segment at all. The failure would
// have surfaced as corrupted 3D rendering, arbitrarily far from the literal.
//
// So placement stops being a guess:
//   1. `(string.pool $REGION)` pins the pool into a region declared to hold it,
//      bounds-checked against that region's size like any other tenant.
//   2. Without that declaration the default address is CHECKED against the
//      region map rather than trusted.
//
// A module with no allocated regions -- the byte-identity case, and watjs's,
// which has ~3500 intern sites and no region map -- reaches neither rule and is
// unchanged.
//
// The assertions read the bytes back out of an INSTANTIATED module's memory, so
// they pin where the string actually lands at runtime, not what the emitter
// believed it was doing.

'use strict';

const assert = require('assert');
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

const PRELUDE = '(memory 2 2)\n';

function build(src) {
  return compile(PRELUDE + src, new Map(), { mode: 'production', runtimeBuiltins: false });
}

function instantiate(src) {
  const r = build(src);
  assert.ok(r.success, `expected this module to compile, got: ${r.error}`);
  const mod = new WebAssembly.Module(Uint8Array.from(r.wasmBinary));
  const inst = new WebAssembly.Instance(mod, {});
  return inst;
}

// Read a NUL-terminated string out of the instance's memory at `ptr`.
function readCStr(inst, ptr) {
  const bytes = new Uint8Array(inst.exports.mem.buffer);
  let end = ptr;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return Buffer.from(bytes.subarray(ptr, end)).toString('latin1');
}

const POOL = '(region.declare-fixed $POOL (base 0x11000) (size 0x100) (owner "strings"))';
const EXPORT_MEM = '(export "mem" (memory 0))';

// ── 1. (string.pool $R) places the pool at that region's base ──────────────
{
  const inst = instantiate(
    `${POOL}\n(string.pool $POOL)\n${EXPORT_MEM}\n` +
    `(func $f (result i32) "WSAStartup")\n(export "f" (func $f))`);
  const ptr = inst.exports.f();
  assert.strictEqual(ptr, 0x11000,
    `the pinned pool must start at $POOL's base 0x11000, got 0x${ptr.toString(16)}`);
  assert.strictEqual(readCStr(inst, ptr), 'WSAStartup',
    'the pointer must address the string itself, NUL-terminated');
}

// ── 2. Identical literals intern once ─────────────────────────────────────
// This is what makes a symbolic use site free: naming the same string at
// twenty call sites costs one copy, so nothing is gained by hand-packing them.
{
  const inst = instantiate(
    `${POOL}\n(string.pool $POOL)\n${EXPORT_MEM}\n` +
    `(func $a (result i32) "recv")\n(export "a" (func $a))\n` +
    `(func $b (result i32) "recv")\n(export "b" (func $b))\n` +
    `(func $c (result i32) "send")\n(export "c" (func $c))`);
  assert.strictEqual(inst.exports.a(), inst.exports.b(),
    'two occurrences of the same literal must share one address');
  assert.notStrictEqual(inst.exports.a(), inst.exports.c(),
    'different literals must not alias');
  assert.strictEqual(readCStr(inst, inst.exports.c()), 'send');
}

// ── 3. The default placement is refused when it lands in the map ──────────
// With no data segments the default pool address is 1024 = 0x400, so a region
// declared there is exactly the collision the old code could not see.
{
  const r = build(
    `(region.declare-fixed $LOW (base 0x400) (size 0x100) (owner "a tenant at the default address"))\n` +
    `(func $f (result i32) "hi")\n(export "f" (func $f))`);
  assert.ok(!r.success, 'a pool landing inside a declared region must be refused');
  assert.match(r.error, /overlaps the storage of region \$LOW/,
    'the refusal must name the region whose storage was about to be overwritten');
  assert.match(r.error, /string\.pool/,
    'the refusal must name the declaration that fixes it');
}

// ── 4. A module with no region map is untouched ───────────────────────────
// watjs interns thousands of strings and declares no regions; it must keep
// compiling, and keep getting the historical address.
{
  const inst = instantiate(`${EXPORT_MEM}\n(func $f (result i32) "hi")\n(export "f" (func $f))`);
  assert.strictEqual(inst.exports.f(), 1024,
    'with no regions declared the pool keeps its historical 1024 base');
  assert.strictEqual(readCStr(inst, 1024), 'hi');
}

// ── 5. A pool that outgrows its region is refused, not silently spilled ───
{
  const r = build(
    `(region.declare-fixed $P2 (base 0x11000) (size 0x4) (owner "strings"))\n(string.pool $P2)\n` +
    `(func $f (result i32) "hello")\n(export "f" (func $f))`);
  assert.ok(!r.success, 'a pool larger than its region must be refused');
  assert.match(r.error, /runs past the 4 bytes of region \$P2/);
  assert.match(r.error, /grow that region by at least/,
    'the refusal must say how much more room is needed');
}

console.log('PASS  WATX string pool: pinned placement, dedupe, overlap refusal, legacy default, overflow refusal');
