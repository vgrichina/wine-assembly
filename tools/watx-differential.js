// ═══════════════════════════════════════════════════════════════
// tools/watx-differential.js — an INDEPENDENT oracle for the WATX encoder.
//
// WHY THIS EXISTS
// ---------------
// Until 24b79256 the legacy compiler (lib/compile-wat.js, a wrapper around
// wabt.js) was compiled alongside WATX on the real tree and the two binaries
// were compared BYTE FOR BYTE. That comparison was the only thing standing
// between "the encoder emits a valid module" and "the encoder emits the module
// the source describes" — WebAssembly.validate accepts a great many binaries
// that mean the wrong thing, and a hand-written suite only ever asserts what
// its author already thought of. Adversarial review keeps finding the gap
// (span-as-storage compiled cleanly until efba89ca).
//
// wabt.js is still a dependency, so the reference encoder never left. This
// file rebuilds the oracle on the only footing that survives WATX's extensions:
//
//   * the corpus is STANDARD WAT — no regions, no macros, no cstring, nothing
//     wabt cannot parse. Every module here is compiled twice, by WATX and by
//     wat2wasm, with the same feature set enabled on both.
//   * the ASSERTION is behavioural: instantiate both binaries and compare what
//     they compute, over a grid of inputs, plus the memory each leaves behind.
//     Byte equality is REPORTED as a bonus, never required — WATX legitimately
//     emits empty sections wabt omits, and lowers `return_call` to `call`+`ret`
//     when tail calls are off. Demanding byte identity would make the oracle
//     fail on things that are not bugs, and an oracle that cries wolf gets
//     turned off.
//   * every module is compiled in BOTH tailCalls modes, because that flag
//     changes the bytes the emitter produces and nothing else re-checks it.
//
// The corpus targets the encoder's dark corners rather than its happy path:
// LEB128 boundary values in both signed and unsigned position, the 33-bit
// i32 range (`i32.const -1` must be five bytes of SLEB, not a truncated four),
// i64 edges, float NaN payloads and -0.0, br_table with many targets, deep
// block nesting, multivalue results, every memarg alignment, SIMD lane
// extremes, atomics, and saturating truncation.
//
// USAGE
//   const { runDifferential } = require('./watx-differential');
//   const report = await runDifferential();          // whole corpus
//   const report = await runDifferential({ only: /leb/ });
//
// Also runnable directly:  node tools/watx-differential.js [--verbose] [--only=RE]
// ═══════════════════════════════════════════════════════════════
'use strict';

const path = require('path');
const { compile } = require(path.join(__dirname, 'watx.js'));

// ── Feature set, matched on both sides ────────────────────────────────────
// wabt takes these as a struct; V8 has them all on by default in the Node we
// ship against. Anything not listed here is off on BOTH sides, which is the
// point: a differential where one encoder is allowed a feature the other is
// not tests nothing.
const WABT_FEATURES = {
  exceptions: false,
  mutable_globals: true,
  sat_float_to_int: true,
  sign_extension: true,
  simd: true,
  threads: true,
  function_references: false,
  multi_value: true,
  tail_call: true,
  bulk_memory: true,
  reference_types: true,
  annotations: false,
  code_metadata: false,
  gc: false,
  memory64: false,
  multi_memory: false,
  extended_const: false,
  relaxed_simd: false,
};

// wabt.js is a wasm build with a fixed shadow stack, and a module deep enough
// to overflow it does not throw cleanly — it corrupts the instance, after which
// EVERY later parse fails with "memory access out of bounds". That failure mode
// is indistinguishable from a real divergence and it cost an hour the first
// time, so the instance is dropped and rebuilt after any throw. (Measured: 140
// nested blocks parse; 150 do not, and take the instance with them.)
let wabtPromise = null;
function getWabt() {
  if (!wabtPromise) wabtPromise = require('wabt')();
  return wabtPromise;
}
function resetWabt() { wabtPromise = null; }

// ── The two encoders ──────────────────────────────────────────────────────
// WATX takes a bare sequence of top-level forms; wabt wants them inside a
// (module ...). That wrapper is the ONLY textual difference permitted between
// the two inputs — anything else and the corpus stops being one program.
function compileWatx(source, { tailCalls }) {
  const r = compile(source, new Map(), {
    mode: 'production',
    standardWat: true,
    runtimeBuiltins: false,
    tailCalls,
  });
  if (!r.success) throw new Error(`WATX: ${r.error} (line ${r.errorLine})`);
  return Uint8Array.from(r.wasmBinary);
}

async function compileWabt(source) {
  const wabt = await getWabt();
  let mod = null;
  try {
    mod = wabt.parseWat('corpus.wat', `(module\n${source}\n)`, WABT_FEATURES);
    mod.resolveNames();
    mod.validate(WABT_FEATURES);
    return Uint8Array.from(mod.toBinary({ log: false, write_debug_names: false }).buffer);
  } catch (e) {
    resetWabt();
    throw e;
  } finally {
    if (mod) try { mod.destroy(); } catch (_) { /* already destroyed */ }
  }
}

// ── Dialect gaps: standard WAT spellings WATX does not accept ─────────────
// Measured, not assumed. These are all legal core WAT that wat2wasm compiles,
// so a corpus module cannot use them; they are listed here rather than deleted
// because "the corpus avoids X" and "X is a known gap" are different facts and
// only the second one is actionable. None of them is a MISCOMPILE — WATX
// refuses each with a located error, which is the safe direction — but every
// one is a .wat file that cannot be handed to this compiler unedited.
const DIALECT_GAPS = [
  { spelling: 'inf / -inf', note: 'infinity has no literal spelling; write (f32.reinterpret_i32 (i32.const 0x7f800000)) or rely on overflow (1e40)' },
  { spelling: 'nan / -nan', note: 'quiet NaN has no literal spelling' },
  { spelling: 'nan:0x1', note: 'the tokenizer splits on ":", so the payload arrives as a second operand ("expected exactly one literal operand, got 2")' },
  { spelling: '0x1p-149, 0x1.fffffep+127', note: 'hex float literals split at the exponent sign, same "got 2 operands" error' },
  { spelling: '(result i32 i32) on a func/block/loop/if/import', note: 'multivalue results are refused at the declaration — a block type is emitted as one VALTYPE byte with no type-index path, and expressionType carries a single type; this used to be an accepted-invalid module instead' },
];

// ── Byte comparison, modulo differences that are not bugs ─────────────────
// Sections whose payload is a single zero LEB (an empty vector) carry no
// information; WATX emits some of them unconditionally, wabt omits them. The
// normalizer drops them from both sides so the byte-identity BONUS reports
// something meaningful instead of being uniformly false.
function stripEmptySections(bin) {
  const out = [bin.subarray(0, 8)];
  let p = 8;
  while (p < bin.length) {
    const id = bin[p];
    let q = p + 1;
    let size = 0, shift = 0, b;
    do { b = bin[q++]; size |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const end = q + size;
    // id 8 is the START section, whose whole payload is a one-byte function
    // index — so `(start $f)` where $f is function 0 encodes as 08 01 00 and
    // looks EXACTLY like an empty vector. Stripping it made a module whose
    // start function never runs report as byte-identical, which is how this
    // exception earned its line.
    const empty = id !== 0 && id !== 8 && size === 1 && bin[q] === 0;
    if (!empty) out.push(bin.subarray(p, end));
    p = end;
  }
  let n = 0; for (const c of out) n += c.length;
  const joined = new Uint8Array(n);
  let o = 0; for (const c of out) { joined.set(c, o); o += c.length; }
  return joined;
}

function sameBytes(a, b) {
  const x = stripEmptySections(a), y = stripEmptySections(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// ── Observation ───────────────────────────────────────────────────────────
// A probe's answer must be comparable across two instances and printable when
// it differs. Numbers keep their exact bits (a probe that cares about NaN
// payloads or -0.0 returns the reinterpreted integer, which is why the corpus
// exports `*_bits` functions rather than floats), BigInts print with an `n`,
// and a trap is an observation like any other — both sides must trap, and on
// the same thing.
function normalize(v) {
  if (typeof v === 'bigint') return `i64:${v}`;
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'f:NaN';
    if (v === 0) return Object.is(v, -0) ? 'f:-0' : 'f:0';
    return `f:${v}`;
  }
  if (Array.isArray(v)) return v.map(normalize);
  if (v instanceof Uint8Array) return Array.from(v).join(',');
  return v;
}

function observe(binary, entry) {
  let instance;
  try {
    const mod = new WebAssembly.Module(binary);
    instance = new WebAssembly.Instance(mod, entry.imports ? entry.imports() : {});
  } catch (e) {
    return { instantiated: false, error: String(e && e.message || e) };
  }
  const ex = instance.exports;
  const results = [];
  for (const call of entry.probe(ex)) {
    try {
      results.push(normalize(typeof call === 'function' ? call() : call));
    } catch (e) {
      // A trap is part of the observed behaviour. Only its CLASS is compared:
      // both sides run on the same engine, so the text agrees whenever the
      // semantics do, but pinning the full string would make the oracle
      // sensitive to a V8 message tweak.
      results.push(`trap:${String(e && e.message || e).split(' ').slice(0, 4).join(' ')}`);
    }
  }
  const memory = entry.memoryExport ? ex[entry.memoryExport] : null;
  const memBytes = memory
    ? Array.from(new Uint8Array(memory.buffer, 0, entry.memoryBytes || 64)).join(',')
    : null;
  return { instantiated: true, results, memBytes };
}

// ═══════════════════════════════════════════════════════════════
// THE CORPUS
// Each entry:
//   name          — stable id, used by --only
//   source        — top-level WAT forms (no (module) wrapper)
//   probe(ex)     — array of thunks; each is called and its answer compared
//   imports()     — fresh import object per instance (optional)
//   memoryExport  — name of an exported memory to diff after the probe
// ═══════════════════════════════════════════════════════════════

// An entry may also carry `expectDivergence: 'why'`. That is not a way to
// silence a failure — it is the OPPOSITE. A marked entry must still diverge:
// if it starts agreeing with wabt, the suite says so and tells you to drop the
// marker. Every marker below names a bug that has been reported and has a
// runnable reproducer under tools/watx-repro/. Deleting the module instead
// would delete the evidence with it.
const CORPUS = [];
function mod(name, source, probe, extra = {}) {
  CORPUS.push({ name, source, probe, ...extra });
}

// ── LEB128 boundaries ─────────────────────────────────────────────────────
// The classic encoder bug is a signed value emitted with the unsigned rule (or
// the reverse) at exactly the byte boundary. 0x3F/0x40 is the one-byte SLEB
// edge, 0x7F/0x80 the one-byte ULEB edge, and -1 must be 0x7F as SLEB and five
// bytes as a 32-bit ULEB. Every one of these is an i32.const, which is where
// wine-assembly puts every address it has.
const I32_EDGES = [
  0, 1, -1, 63, 64, -64, -65, 127, 128, -128, -129, 255, 256,
  8191, 8192, -8192, -8193, 16383, 16384, -16384, -16385,
  0x7fffffff, -0x80000000, 0x3fffffff, 0x40000000 | 0,
  0x1fffff, 0x200000, 0xfffff | 0, 0x100000,
];
mod('leb-i32-edges',
  I32_EDGES.map((v, i) => `(func $c${i} (result i32) (i32.const ${v}))\n(export "c${i}" (func $c${i}))`).join('\n'),
  (ex) => I32_EDGES.map((_, i) => () => ex[`c${i}`]()));

const I64_EDGES = [
  '0', '1', '-1', '63', '64', '-64', '-65', '127', '128', '-128', '-129',
  '2147483647', '2147483648', '-2147483648', '-2147483649',
  '4294967295', '4294967296', '9223372036854775807', '-9223372036854775808',
  '72057594037927935', '72057594037927936', '562949953421311', '562949953421312',
];
mod('leb-i64-edges',
  I64_EDGES.map((v, i) => `(func $d${i} (result i64) (i64.const ${v}))\n(export "d${i}" (func $d${i}))`).join('\n'),
  (ex) => I64_EDGES.map((_, i) => () => ex[`d${i}`]()));

// Hex spelling of the same edges — the literal parser is a separate code path
// from the encoder and both have to agree that 0xFFFFFFFF is -1 in an i32.
mod('leb-i32-hex',
  ['0x0', '0x3f', '0x40', '0x7f', '0x80', '0xff', '0x100', '0x7fffffff', '0x80000000', '0xffffffff', '0xfffffffe']
    .map((v, i) => `(func $h${i} (result i32) (i32.const ${v}))\n(export "h${i}" (func $h${i}))`).join('\n'),
  (ex) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => () => ex[`h${i}`]()));

mod('leb-i64-hex',
  ['0x0', '0x7f', '0x80', '0xffffffff', '0x100000000', '0x7fffffffffffffff', '0x8000000000000000', '0xffffffffffffffff']
    .map((v, i) => `(func $g${i} (result i64) (i64.const ${v}))\n(export "g${i}" (func $g${i}))`).join('\n'),
  (ex) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => () => ex[`g${i}`]()));

// ── Floats: NaN payloads, -0.0, infinities, subnormals ────────────────────
// Returned as BITS. A float return would collapse every NaN to one value and
// -0.0 to 0, i.e. it would hide exactly the encodings this entry is about.
// DECIMAL spellings only — see DIALECT_GAPS: `inf`, `nan`, `nan:0x…` and hex
// floats are all rejected by WATX, so the special values are reached the one
// way both encoders agree on, by reinterpreting an integer bit pattern. That
// still exercises the f32/f64 immediate in the constant pool (the reinterpret
// is a no-op at runtime), which is what this entry is for.
const F32_LITS = ['0.0', '-0.0', '1.0', '-1.0', '3.14159265',
  '1e-45', '3.4028235e38', '1.1754944e-38', '16777217.0', '0.1'];
mod('f32-bits',
  F32_LITS.map((v, i) => `(func $f${i} (result i32) (i32.reinterpret_f32 (f32.const ${v})))\n(export "f${i}" (func $f${i}))`).join('\n')
  + '\n' + [0x7f800000, 0xff800000, 0x7fc00000, 0xffc00000, 0x7f800001, 0x7fbfffff, 0x00000001, 0x80000000]
    .map((b, i) => `(func $b${i} (result i32) (i32.reinterpret_f32 (f32.reinterpret_i32 (i32.const 0x${b.toString(16)}))))\n(export "b${i}" (func $b${i}))`).join('\n'),
  (ex) => [
    ...F32_LITS.map((_, i) => () => ex[`f${i}`]()),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => () => ex[`b${i}`]()),
  ]);

const F64_LITS = ['0.0', '-0.0', '1.0', '-1.0', '3.141592653589793',
  '5e-324', '1.7976931348623157e308', '2.2250738585072014e-308', '9007199254740993.0', '0.1'];
mod('f64-bits',
  F64_LITS.map((v, i) => `(func $q${i} (result i64) (i64.reinterpret_f64 (f64.const ${v})))\n(export "q${i}" (func $q${i}))`).join('\n')
  + '\n' + ['0x7ff0000000000000', '0xfff0000000000000', '0x7ff8000000000000',
    '0xfff8000000000000', '0x7ff0000000000001', '0x0000000000000001', '0x8000000000000000']
    .map((b, i) => `(func $r${i} (result i64) (i64.reinterpret_f64 (f64.reinterpret_i64 (i64.const ${b}))))\n(export "r${i}" (func $r${i}))`).join('\n'),
  (ex) => [
    ...F64_LITS.map((_, i) => () => ex[`q${i}`]()),
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => () => ex[`r${i}`]()),
  ]);

// Arithmetic on those values, so the differential covers the OPERATORS and not
// only the constant pool.
mod('float-arith', `
(func $fadd (param $a f32) (param $b f32) (result i32) (i32.reinterpret_f32 (f32.add (local.get $a) (local.get $b))))
(func $fdiv (param $a f32) (param $b f32) (result i32) (i32.reinterpret_f32 (f32.div (local.get $a) (local.get $b))))
(func $fmin (param $a f64) (param $b f64) (result i64) (i64.reinterpret_f64 (f64.min (local.get $a) (local.get $b))))
(func $fmax (param $a f64) (param $b f64) (result i64) (i64.reinterpret_f64 (f64.max (local.get $a) (local.get $b))))
(func $fcopy (param $a f64) (param $b f64) (result i64) (i64.reinterpret_f64 (f64.copysign (local.get $a) (local.get $b))))
(func $ftrunc (param $a f64) (result i64) (i64.reinterpret_f64 (f64.trunc (local.get $a))))
(func $fnearest (param $a f64) (result i64) (i64.reinterpret_f64 (f64.nearest (local.get $a))))
(export "fadd" (func $fadd)) (export "fdiv" (func $fdiv)) (export "fmin" (func $fmin))
(export "fmax" (func $fmax)) (export "fcopy" (func $fcopy)) (export "ftrunc" (func $ftrunc))
(export "fnearest" (func $fnearest))`,
  (ex) => {
    const out = [];
    for (const [a, b] of [[0, -0], [-0, 0], [NaN, 1], [1, NaN], [Infinity, -Infinity], [1, 0], [-1, 0], [0, 0]]) {
      out.push(() => ex.fadd(a, b), () => ex.fdiv(a, b), () => ex.fmin(a, b),
        () => ex.fmax(a, b), () => ex.fcopy(a, b));
    }
    for (const v of [0.5, -0.5, 1.5, 2.5, -1.5, -2.5, 0, -0, Infinity, NaN]) {
      out.push(() => ex.ftrunc(v), () => ex.fnearest(v));
    }
    return out;
  });

// ── Saturating truncation ─────────────────────────────────────────────────
// The non-trapping conversions. Their whole reason for existing is the edge
// behaviour, so the grid is entirely edges.
mod('trunc-sat', `
(func $s32 (param $a f64) (result i32) (i32.trunc_sat_f64_s (local.get $a)))
(func $u32 (param $a f64) (result i32) (i32.trunc_sat_f64_u (local.get $a)))
(func $s64 (param $a f64) (result i64) (i64.trunc_sat_f64_s (local.get $a)))
(func $u64 (param $a f64) (result i64) (i64.trunc_sat_f64_u (local.get $a)))
(func $s32f (param $a f32) (result i32) (i32.trunc_sat_f32_s (local.get $a)))
(func $trap32 (param $a f64) (result i32) (i32.trunc_f64_s (local.get $a)))
(export "s32" (func $s32)) (export "u32" (func $u32)) (export "s64" (func $s64))
(export "u64" (func $u64)) (export "s32f" (func $s32f)) (export "trap32" (func $trap32))`,
  (ex) => {
    const grid = [0, -0, 0.5, -0.5, 1.9, -1.9, 2147483647, 2147483648, -2147483648, -2147483649,
      4294967295, 4294967296, 1e300, -1e300, Infinity, -Infinity, NaN,
      9223372036854775807, -9223372036854775808];
    const out = [];
    for (const v of grid) {
      out.push(() => ex.s32(v), () => ex.u32(v), () => ex.s64(v), () => ex.u64(v),
        () => ex.s32f(v), () => ex.trap32(v));
    }
    return out;
  });

// ── Sign extension ────────────────────────────────────────────────────────
mod('sign-extend', `
(func $e8 (param $a i32) (result i32) (i32.extend8_s (local.get $a)))
(func $e16 (param $a i32) (result i32) (i32.extend16_s (local.get $a)))
(func $l8 (param $a i64) (result i64) (i64.extend8_s (local.get $a)))
(func $l16 (param $a i64) (result i64) (i64.extend16_s (local.get $a)))
(func $l32 (param $a i64) (result i64) (i64.extend32_s (local.get $a)))
(export "e8" (func $e8)) (export "e16" (func $e16))
(export "l8" (func $l8)) (export "l16" (func $l16)) (export "l32" (func $l32))`,
  (ex) => {
    const out = [];
    for (const v of [0, 1, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, -1, 0x7fffffff, -0x80000000]) {
      out.push(() => ex.e8(v), () => ex.e16(v));
      out.push(() => ex.l8(BigInt(v)), () => ex.l16(BigInt(v)), () => ex.l32(BigInt(v)));
    }
    out.push(() => ex.l32(0xffffffffn), () => ex.l32(0x80000000n), () => ex.l32(0x17fffffffn));
    return out;
  });

// ── Integer arithmetic, including the trapping edges ──────────────────────
// INT_MIN / -1 traps on div_s and yields 0 on rem_s; a shift count is taken
// mod 32 (mod 64 for i64). All three are places an emitter can quietly get the
// opcode one slot wrong and still validate.
mod('int-arith', `
(func $divs (param $a i32) (param $b i32) (result i32) (i32.div_s (local.get $a) (local.get $b)))
(func $divu (param $a i32) (param $b i32) (result i32) (i32.div_u (local.get $a) (local.get $b)))
(func $rems (param $a i32) (param $b i32) (result i32) (i32.rem_s (local.get $a) (local.get $b)))
(func $remu (param $a i32) (param $b i32) (result i32) (i32.rem_u (local.get $a) (local.get $b)))
(func $shl (param $a i32) (param $b i32) (result i32) (i32.shl (local.get $a) (local.get $b)))
(func $shrs (param $a i32) (param $b i32) (result i32) (i32.shr_s (local.get $a) (local.get $b)))
(func $shru (param $a i32) (param $b i32) (result i32) (i32.shr_u (local.get $a) (local.get $b)))
(func $rotl (param $a i32) (param $b i32) (result i32) (i32.rotl (local.get $a) (local.get $b)))
(func $rotr (param $a i32) (param $b i32) (result i32) (i32.rotr (local.get $a) (local.get $b)))
(func $clz (param $a i32) (result i32) (i32.clz (local.get $a)))
(func $ctz (param $a i32) (result i32) (i32.ctz (local.get $a)))
(func $pop (param $a i32) (result i32) (i32.popcnt (local.get $a)))
(func $lts (param $a i32) (param $b i32) (result i32) (i32.lt_s (local.get $a) (local.get $b)))
(func $ltu (param $a i32) (param $b i32) (result i32) (i32.lt_u (local.get $a) (local.get $b)))
(export "divs" (func $divs)) (export "divu" (func $divu)) (export "rems" (func $rems))
(export "remu" (func $remu)) (export "shl" (func $shl)) (export "shrs" (func $shrs))
(export "shru" (func $shru)) (export "rotl" (func $rotl)) (export "rotr" (func $rotr))
(export "clz" (func $clz)) (export "ctz" (func $ctz)) (export "pop" (func $pop))
(export "lts" (func $lts)) (export "ltu" (func $ltu))`,
  (ex) => {
    const vals = [0, 1, -1, 2, -2, 7, -7, 0x7fffffff, -0x80000000, 0x55555555, -0x55555556];
    const out = [];
    for (const a of vals) {
      out.push(() => ex.clz(a), () => ex.ctz(a), () => ex.pop(a));
      for (const b of vals) {
        out.push(() => ex.divs(a, b), () => ex.divu(a, b), () => ex.rems(a, b), () => ex.remu(a, b),
          () => ex.lts(a, b), () => ex.ltu(a, b));
      }
      for (const b of [0, 1, 31, 32, 33, 63, 64, -1]) {
        out.push(() => ex.shl(a, b), () => ex.shrs(a, b), () => ex.shru(a, b),
          () => ex.rotl(a, b), () => ex.rotr(a, b));
      }
    }
    return out;
  });

mod('int64-arith', `
(func $divs (param $a i64) (param $b i64) (result i64) (i64.div_s (local.get $a) (local.get $b)))
(func $shl (param $a i64) (param $b i64) (result i64) (i64.shl (local.get $a) (local.get $b)))
(func $shru (param $a i64) (param $b i64) (result i64) (i64.shr_u (local.get $a) (local.get $b)))
(func $wrap (param $a i64) (result i32) (i32.wrap_i64 (local.get $a)))
(func $exts (param $a i32) (result i64) (i64.extend_i32_s (local.get $a)))
(func $extu (param $a i32) (result i64) (i64.extend_i32_u (local.get $a)))
(func $clz (param $a i64) (result i64) (i64.clz (local.get $a)))
(export "divs" (func $divs)) (export "shl" (func $shl)) (export "shru" (func $shru))
(export "wrap" (func $wrap)) (export "exts" (func $exts)) (export "extu" (func $extu))
(export "clz" (func $clz))`,
  (ex) => {
    const vals = [0n, 1n, -1n, 0x7fffffffffffffffn, -0x8000000000000000n, 0x100000000n, 0xffffffffn];
    const out = [];
    for (const a of vals) {
      out.push(() => ex.clz(a), () => ex.wrap(a));
      for (const b of vals) out.push(() => ex.divs(a, b));
      for (const b of [0n, 1n, 63n, 64n, 65n, 127n]) out.push(() => ex.shl(a, b), () => ex.shru(a, b));
    }
    for (const v of [0, 1, -1, 0x7fffffff, -0x80000000]) out.push(() => ex.exts(v), () => ex.extu(v));
    return out;
  });

// ── br_table with many targets ────────────────────────────────────────────
// The table is a vector of ULEB label indices plus a default. 130 targets puts
// the vector's own count past the one-byte ULEB boundary, which is where an
// encoder that writes a raw byte for the length silently truncates.
{
  const N = 130;
  let src = '(func $sel (param $i i32) (result i32)\n';
  for (let i = 0; i < N; i++) src += '(block ';
  src += `(br_table ${Array.from({ length: N }, (_, i) => i).join(' ')} ${N - 1} (local.get $i))`;
  for (let i = N - 1; i >= 0; i--) src += `) (return (i32.const ${1000 + i}))`;
  src += '\n(i32.const -1))\n(export "sel" (func $sel))';
  mod('br-table-wide', src,
    (ex) => Array.from({ length: N + 4 }, (_, i) => () => ex.sel(i - 2)));
}

// A br_table whose targets all point at the SAME depth, plus a default that
// differs — the shape a jump table lowers to, and the one where an off-by-one
// in the depth arithmetic is invisible unless the default is exercised.
mod('br-table-default', `
(func $f (param $i i32) (result i32)
  (block $out (result i32)
    (block $a
      (block $b
        (block $c
          (br_table $a $b $c (local.get $i)))
        (br $out (i32.const 3)))
      (br $out (i32.const 2)))
    (br $out (i32.const 1))))
(export "f" (func $f))`,
  (ex) => [-1, 0, 1, 2, 3, 4, 100].map((i) => () => ex.f(i)));

// ── Deep block nesting ────────────────────────────────────────────────────
// Relative label depths past 127 need a multi-byte ULEB in the br operand. 140
// is as deep as the corpus can go: wabt.js overflows its shadow stack somewhere
// between 140 and 150 nested blocks and never recovers, so a deeper module
// would measure the reference encoder rather than WATX.
{
  const D = 140;
  let src = '(func $deep (param $x i32) (result i32) (block $top (result i32)\n';
  for (let i = 0; i < D; i++) src += '(block ';
  src += `(br ${D} (i32.const 42))`;
  for (let i = 0; i < D; i++) src += ')';
  src += '\n(i32.const 7)))\n(export "deep" (func $deep))';
  mod('deep-nesting', src, (ex) => [() => ex.deep(0), () => ex.deep(1)]);
}

// ── Multivalue block/if results ───────────────────────────────────────────
// A block type that is neither empty nor a single valtype is a TYPE INDEX
// encoded as a positive SLEB — the same field that holds 0x40 for "void" and
// 0x7f for "i32". Getting that dual encoding wrong is a classic.
mod('multivalue', `
(func $swap (param $a i32) (param $b i32) (result i32 i32)
  (local.get $b) (local.get $a))
(func $useswap (param $a i32) (param $b i32) (result i32)
  (i32.sub (call $swap (local.get $a) (local.get $b))))
(func $blk (param $a i32) (result i32)
  (i32.sub
    (block (result i32 i32)
      (i32.const 100) (local.get $a))))
(func $ifm (param $c i32) (result i32)
  (i32.mul
    (if (result i32 i32) (local.get $c)
      (then (i32.const 3) (i32.const 5))
      (else (i32.const 7) (i32.const 11)))))
(func $loopm (param $n i32) (result i32)
  (local $acc i32)
  (block $done
    (loop $l
      (br_if $done (i32.eqz (local.get $n)))
      (local.set $acc (i32.add (local.get $acc) (local.get $n)))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (br $l)))
  (local.get $acc))
(export "useswap" (func $useswap)) (export "blk" (func $blk))
(export "ifm" (func $ifm)) (export "loopm" (func $loopm))`,
  (ex) => [
    () => ex.useswap(9, 4), () => ex.useswap(-1, 0x7fffffff),
    () => ex.blk(1), () => ex.blk(-5),
    () => ex.ifm(0), () => ex.ifm(1), () => ex.ifm(-1),
    () => ex.loopm(0), () => ex.loopm(1), () => ex.loopm(100),
  ], { expectDivergence: 'WATX REFUSES multivalue (result i32 i32) at the declaration, with a located error. It used to accept it and emit a body V8 rejected at instantiate ("expected 2 elements on the stack for fallthru, found 1") — an accepted-invalid module, the worse of the two. The refusal is deliberate and permanent until the emitter carries more than one value: see DIALECT_GAPS.' });

// The multivalue shapes that DO work, split out so the marked entry above is
// the narrow claim it should be rather than "all multivalue is broken".
mod('single-value-control', `
(func $blk (param $a i32) (result i32)
  (i32.sub (block (result i32) (i32.add (i32.const 100) (local.get $a))) (i32.const 1)))
(func $ifv (param $c i32) (result i32)
  (if (result i32) (local.get $c) (then (i32.const 3)) (else (i32.const 7))))
(func $loopv (param $n i32) (result i32)
  (local $acc i32)
  (block $done
    (loop $l
      (br_if $done (i32.eqz (local.get $n)))
      (local.set $acc (i32.add (local.get $acc) (local.get $n)))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (br $l)))
  (local.get $acc))
(export "blk" (func $blk)) (export "ifv" (func $ifv)) (export "loopv" (func $loopv))`,
  (ex) => [
    () => ex.blk(1), () => ex.blk(-5), () => ex.blk(0x7fffffff),
    () => ex.ifv(0), () => ex.ifv(1), () => ex.ifv(-1),
    () => ex.loopv(0), () => ex.loopv(1), () => ex.loopv(1000),
  ]);

// ── Memarg alignments, every legal (align, offset) pair ───────────────────
// The align field is log2 and the offset is a ULEB; a store that writes the
// natural alignment regardless of what was asked still validates and still
// runs, so only a byte- or behaviour-level comparison catches it. Offsets
// straddle the ULEB boundary on purpose.
{
  const cases = [];
  for (const [op, nat] of [['i32.load', 2], ['i32.load8_u', 0], ['i32.load8_s', 0],
    ['i32.load16_u', 1], ['i32.load16_s', 1], ['i64.load', 3], ['i64.load32_u', 2],
    ['f32.load', 2], ['f64.load', 3]]) {
    for (let a = 0; a <= nat; a++) {
      for (const off of [0, 1, 127, 128, 255, 256, 1000]) {
        cases.push({ op, a, off });
      }
    }
  }
  const isI64 = (op) => op.startsWith('i64');
  const isF = (op) => op.startsWith('f');
  let src = '(memory 1 1)\n(export "mem" (memory 0))\n';
  cases.forEach((c, i) => {
    const res = isI64(c.op) ? 'i64' : isF(c.op) ? (c.op.startsWith('f32') ? 'i32' : 'i64') : 'i32';
    const wrap = c.op.startsWith('f32') ? 'i32.reinterpret_f32'
      : c.op.startsWith('f64') ? 'i64.reinterpret_f64' : null;
    const body = `(${c.op} offset=${c.off} align=${1 << c.a} (local.get $p))`;
    src += `(func $m${i} (param $p i32) (result ${res}) ${wrap ? `(${wrap} ${body})` : body})\n`;
    src += `(export "m${i}" (func $m${i}))\n`;
  });
  src += `(func $fill (param $p i32) (param $v i32) (i32.store (local.get $p) (local.get $v)))
(export "fill" (func $fill))
(data (i32.const 0) "\\01\\02\\03\\04\\05\\06\\07\\08\\09\\0a\\0b\\0c\\0d\\0e\\0f\\ff\\fe\\fd\\fc\\80\\7f")
(data (i32.const 1000) "\\de\\ad\\be\\ef\\ca\\fe\\ba\\be")
(data (i32.const 1128) "\\11\\22\\33\\44\\55\\66\\77\\88")`;
  mod('memarg-grid', src, (ex) => {
    const out = [];
    for (let i = 0; i < cases.length; i++) {
      for (const p of [0, 1, 3, 8]) out.push(() => ex[`m${i}`](p));
    }
    return out;
  }, { memoryExport: 'mem', memoryBytes: 256 });
}

// ── Stores, and the memory they leave behind ──────────────────────────────
mod('store-grid', `
(memory 1 1)
(export "mem" (memory 0))
(func $go
  (i32.store (i32.const 0) (i32.const -1))
  (i32.store8 (i32.const 4) (i32.const 0x1ff))
  (i32.store16 (i32.const 6) (i32.const 0x12345))
  (i64.store (i32.const 8) (i64.const 0x0123456789abcdef))
  (i64.store32 (i32.const 16) (i64.const 0xfedcba9876543210))
  (f32.store (i32.const 20) (f32.reinterpret_i32 (i32.const 0x7fc00001)))
  (f64.store (i32.const 24) (f64.const -0.0))
  (i32.store offset=100 align=1 (i32.const 2) (i32.const 0x11223344))
  (i64.store offset=1 align=2 (i32.const 39) (i64.const 0x55aa55aa55aa55aa)))
(export "go" (func $go))`,
  (ex) => [() => { ex.go(); return 0; }], { memoryExport: 'mem', memoryBytes: 128 });

// ── Bulk memory ───────────────────────────────────────────────────────────
mod('bulk-memory', `
(memory 1 1)
(export "mem" (memory 0))
(data (i32.const 0) "hello world, this is a data segment for bulk ops")
(func $copy (param $d i32) (param $s i32) (param $n i32)
  (memory.copy (local.get $d) (local.get $s) (local.get $n)))
(func $fill (param $d i32) (param $v i32) (param $n i32)
  (memory.fill (local.get $d) (local.get $v) (local.get $n)))
(func $size (result i32) (memory.size))
(export "copy" (func $copy)) (export "fill" (func $fill)) (export "size" (func $size))`,
  (ex) => [
    () => ex.size(),
    () => { ex.copy(64, 0, 16); return 1; },
    () => { ex.fill(96, 0xab, 12); return 2; },
    () => { ex.copy(70, 68, 20); return 3; },   // overlapping, forward
    () => { ex.copy(60, 62, 20); return 4; },   // overlapping, backward
    () => { try { ex.fill(65530, 1, 100); return 5; } catch (e) { return 'trap-fill'; } },
  ], { memoryExport: 'mem', memoryBytes: 128 });

// ── Atomics (threads) over a shared memory ────────────────────────────────
mod('atomics', `
(import "env" "mem" (memory $m 1 1 shared))
(export "mem" (memory $m))
(func $add (param $p i32) (param $v i32) (result i32) (i32.atomic.rmw.add (local.get $p) (local.get $v)))
(func $xchg (param $p i32) (param $v i32) (result i32) (i32.atomic.rmw.xchg (local.get $p) (local.get $v)))
(func $cmpx (param $p i32) (param $e i32) (param $v i32) (result i32)
  (i32.atomic.rmw.cmpxchg (local.get $p) (local.get $e) (local.get $v)))
(func $ld (param $p i32) (result i32) (i32.atomic.load (local.get $p)))
(func $st (param $p i32) (param $v i32) (i32.atomic.store (local.get $p) (local.get $v)))
(func $add8 (param $p i32) (param $v i32) (result i32) (i32.atomic.rmw8.add_u (local.get $p) (local.get $v)))
(func $or16 (param $p i32) (param $v i32) (result i32) (i32.atomic.rmw16.or_u (local.get $p) (local.get $v)))
(func $ld64 (param $p i32) (result i64) (i64.atomic.load (local.get $p)))
(func $fence (atomic.fence))
(export "add" (func $add)) (export "xchg" (func $xchg)) (export "cmpx" (func $cmpx))
(export "ld" (func $ld)) (export "st" (func $st)) (export "add8" (func $add8))
(export "or16" (func $or16)) (export "ld64" (func $ld64)) (export "fence" (func $fence))`,
  (ex) => [
    () => { ex.st(0, 5); return ex.ld(0); },
    () => ex.add(0, 7),
    () => ex.ld(0),
    () => ex.xchg(0, -1),
    () => ex.ld(0),
    () => ex.cmpx(0, -1, 99),
    () => ex.cmpx(0, -1, 123),
    () => ex.ld(0),
    () => ex.add8(16, 0xff),
    () => ex.or16(20, 0xf0f0),
    () => ex.ld64(8),
    () => { ex.fence(); return 'fenced'; },
    () => { try { return ex.ld(3); } catch (e) { return 'unaligned-trap'; } },
  ], {
    imports: () => ({ env: { mem: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }) } }),
    memoryExport: 'mem', memoryBytes: 64,
  });

// ── SIMD: lane extremes and the shuffle immediate ─────────────────────────
// v128.const is 16 raw bytes and i8x16.shuffle is 16 raw lane indices — both
// are the fixed-width immediates an encoder can drop a byte from and still
// produce something that validates, because the next opcode absorbs it.
// Vectors are built from splat / replace_lane / v128.load, NEVER from a
// `v128.const <shape> …` — that spelling is broken (see the entry below and
// tools/watx-repro/v128-const-shape.js), and mixing it in here would make one
// known bug mask everything else this entry covers.
mod('simd-lanes', `
(memory 1 1)
(export "mem" (memory 0))
(data (i32.const 0) "\\01\\02\\03\\04\\05\\06\\07\\08\\09\\0a\\0b\\0c\\0d\\0e\\0f\\10\\ff\\fe\\fd\\fc\\80\\7f\\00\\01")
(func $splat_extract (param $x i32) (result i32)
  (i32x4.extract_lane 3 (i32x4.splat (local.get $x))))
(func $lane8 (param $i i32) (result i32)
  (i8x16.extract_lane_s 0
    (i8x16.replace_lane 0 (v128.load (i32.const 0)) (local.get $i))))
(func $lane8u (param $i i32) (result i32)
  (i8x16.extract_lane_u 15 (i8x16.replace_lane 15 (v128.load (i32.const 0)) (local.get $i))))
(func $lane64 (param $i i64) (result i64)
  (i64x2.extract_lane 1 (i64x2.replace_lane 1 (v128.load (i32.const 0)) (local.get $i))))
(func $shuffled (param $unused i32) (result i32)
  (i8x16.extract_lane_u 0
    (i8x16.shuffle 31 30 29 28 27 26 25 24 23 22 21 20 19 18 17 16
      (v128.load (i32.const 0)) (v128.load (i32.const 8)))))
(func $addsat (param $unused i32) (result i32)
  (i8x16.extract_lane_s 4
    (i8x16.add_sat_s (v128.load (i32.const 16)) (v128.load (i32.const 16)))))
(func $fsplat (param $x f64) (result i64)
  (i64x2.extract_lane 0 (f64x2.splat (local.get $x))))
(func $store (param $p i32)
  (v128.store (local.get $p) (i8x16.replace_lane 3 (v128.load (i32.const 0)) (i32.const 0xab))))
(func $loadsplat (param $p i32) (result i32)
  (i32x4.extract_lane 1 (v128.load32_splat (local.get $p))))
(func $loadext (param $p i32) (result i32)
  (i32x4.extract_lane 3 (i32x4.extend_high_i16x8_s (v128.load (local.get $p)))))
(func $bitmask (param $p i32) (result i32) (i8x16.bitmask (v128.load (local.get $p))))
(func $anytrue (param $p i32) (result i32) (v128.any_true (v128.load (local.get $p))))
(func $narrow (param $p i32) (result i32)
  (i8x16.extract_lane_u 0 (i8x16.narrow_i16x8_u (v128.load (local.get $p)) (v128.load (i32.const 0)))))
(export "splat_extract" (func $splat_extract)) (export "lane8" (func $lane8))
(export "lane8u" (func $lane8u)) (export "lane64" (func $lane64))
(export "shuffled" (func $shuffled))
(export "addsat" (func $addsat)) (export "fsplat" (func $fsplat))
(export "store" (func $store)) (export "loadsplat" (func $loadsplat))
(export "loadext" (func $loadext)) (export "bitmask" (func $bitmask))
(export "anytrue" (func $anytrue)) (export "narrow" (func $narrow))`,
  (ex) => [
    () => ex.splat_extract(0x7fffffff), () => ex.splat_extract(-1), () => ex.splat_extract(0),
    () => ex.lane8(0x80), () => ex.lane8(0x7f), () => ex.lane8(-1),
    () => ex.lane8u(0x80), () => ex.lane8u(-1),
    () => ex.lane64(-1n), () => ex.lane64(0x7fffffffffffffffn),
    () => ex.shuffled(0), () => ex.addsat(0),
    () => ex.fsplat(-0), () => ex.fsplat(NaN), () => ex.fsplat(1.5),
    () => { ex.store(32); return 'stored'; },
    () => ex.loadsplat(32), () => ex.loadext(32),
    () => ex.bitmask(0), () => ex.bitmask(16),
    () => ex.anytrue(0), () => ex.narrow(16),
  ], { memoryExport: 'mem', memoryBytes: 64 });

// FIXED at 4ffdf4b3 ("A SIMD constant with a shape token is not 16 bytes"), and
// this is now a plain regression test. It was a `expectDivergence` witness for
// about ten minutes: the emitter read 16 operands from expr[2] and masked each
// to a byte with no idea the shape token existed, so the token became lane 0,
// every lane shifted, the last was dropped, and a wider shape truncated each
// lane to a single byte — silently. The marker came off because the suite
// FAILED on the fix, which is the point of asserting a known bug rather than
// deleting the module that shows it.
mod('simd-const-shape', `
(memory 1 1)
(export "mem" (memory 0))
(func $c8 (result i32)
  (i8x16.extract_lane_u 15 (v128.const i8x16 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16)))
(func $c32 (result i32)
  (i32x4.extract_lane 2 (v128.const i32x4 0x80000000 0x7fffffff 0xffffffff 0x00000001)))
(func $store (v128.store (i32.const 0) (v128.const i8x16 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16)))
(export "c8" (func $c8)) (export "c32" (func $c32)) (export "store" (func $store))`,
  (ex) => [() => ex.c8(), () => ex.c32(), () => { ex.store(); return 'stored'; }],
  { memoryExport: 'mem', memoryBytes: 32 });

// ── Globals: every type, mutable and not, and their initializers ──────────
mod('globals', `
(global $a (mut i32) (i32.const -1))
(global $b i32 (i32.const 0x7fffffff))
(global $c (mut i64) (i64.const -9223372036854775808))
(global $d f32 (f32.const -0.5))
(global $e (mut f64) (f64.const -0.0))
(func $geta (result i32) (global.get $a))
(func $seta (param $v i32) (global.set $a (local.get $v)))
(func $getb (result i32) (global.get $b))
(func $getc (result i64) (global.get $c))
(func $getd (result i32) (i32.reinterpret_f32 (global.get $d)))
(func $gete (result i64) (i64.reinterpret_f64 (global.get $e)))
(export "geta" (func $geta)) (export "seta" (func $seta)) (export "getb" (func $getb))
(export "getc" (func $getc)) (export "getd" (func $getd)) (export "gete" (func $gete))
(export "a" (global $a)) (export "b" (global $b))`,
  (ex) => [
    () => ex.geta(), () => ex.getb(), () => ex.getc(), () => ex.getd(), () => ex.gete(),
    () => { ex.seta(0x7fffffff); return ex.geta(); },
    () => { ex.seta(-0x80000000); return ex.geta(); },
    () => Number(ex.a.value), () => Number(ex.b.value),
  ]);

// ── Locals: many of them, so the local-declaration run-length encoding runs ─
{
  const N = 40;
  let src = '(func $many (param $x i32) (result i32)\n';
  for (let i = 0; i < N; i++) src += `(local $l${i} ${i % 4 === 0 ? 'i64' : 'i32'})\n`;
  src += '(local.set $l1 (local.get $x))\n';
  // The i64 slots are interleaved so the local-declaration run-length encoding
  // emits several runs rather than one; the i32 chain steps over them so the
  // arithmetic stays typed.
  let prev = 1;
  for (let i = 2; i < N; i++) {
    if (i % 4 === 0) { src += `(local.set $l${i} (i64.extend_i32_s (local.get $l${prev})))\n`; continue; }
    src += `(local.set $l${i} (i32.add (local.get $l${prev}) (i32.const ${i})))\n`;
    prev = i;
  }
  src += `(local.get $l${prev}))\n(export "many" (func $many))`;
  mod('many-locals', src, (ex) => [0, 1, -1, 0x7fffffff].map((v) => () => ex.many(v)));
}

// ── Call graph: direct, indirect, and a table with a hole ─────────────────
mod('calls', `
(type $bin (func (param i32 i32) (result i32)))
(type $un (func (param i32) (result i32)))
(table 8 8 funcref)
(func $add (param $a i32) (param $b i32) (result i32) (i32.add (local.get $a) (local.get $b)))
(func $sub (param $a i32) (param $b i32) (result i32) (i32.sub (local.get $a) (local.get $b)))
(func $neg (param $a i32) (result i32) (i32.sub (i32.const 0) (local.get $a)))
(elem (i32.const 1) $add $sub)
(elem (i32.const 5) $neg)
(func $dispatch (param $i i32) (param $a i32) (param $b i32) (result i32)
  (call_indirect (type $bin) (local.get $a) (local.get $b) (local.get $i)))
(func $dispatch1 (param $i i32) (param $a i32) (result i32)
  (call_indirect (type $un) (local.get $a) (local.get $i)))
(func $direct (param $a i32) (result i32) (call $neg (call $add (local.get $a) (i32.const 3))))
(export "dispatch" (func $dispatch)) (export "dispatch1" (func $dispatch1))
(export "direct" (func $direct))`,
  (ex) => [
    () => ex.dispatch(1, 5, 3), () => ex.dispatch(2, 5, 3),
    () => ex.dispatch(0, 1, 1),   // null element -> trap
    () => ex.dispatch(5, 1, 1),   // wrong signature -> trap
    () => ex.dispatch(8, 1, 1),   // out of bounds -> trap
    () => ex.dispatch1(5, 9), () => ex.dispatch1(1, 9),
    () => ex.direct(4), () => ex.direct(-0x80000000),
  ]);

// ── Tail calls ────────────────────────────────────────────────────────────
// The one place the two WATX modes must produce DIFFERENT bytes and the SAME
// answers: with tailCalls off, `return_call` lowers to call + return.
mod('tail-calls', `
(type $un (func (param i32) (result i32)))
(table 4 4 funcref)
(func $inner (param $n i32) (result i32) (i32.mul (local.get $n) (i32.const 3)))
(elem (i32.const 2) $inner)
(func $outer (param $n i32) (result i32) (return_call $inner (local.get $n)))
(func $outeri (param $n i32) (result i32)
  (return_call_indirect (type $un) (local.get $n) (i32.const 2)))
(func $cond (param $n i32) (result i32)
  (if (i32.gt_s (local.get $n) (i32.const 0))
    (then (return_call $inner (local.get $n))))
  (i32.const -1))
(export "outer" (func $outer)) (export "outeri" (func $outeri)) (export "cond" (func $cond))`,
  (ex) => [
    () => ex.outer(7), () => ex.outer(-1), () => ex.outeri(7), () => ex.outeri(0x7fffffff),
    () => ex.cond(5), () => ex.cond(0), () => ex.cond(-3),
  ]);

// ── Imported functions: the observable side of the import section ─────────
mod('imports', `
(import "env" "log" (func $log (param i32)))
(import "env" "combine" (func $combine (param i32 i64) (result i64)))
(import "env" "mem" (memory $m 1 1))
(func $use (param $a i32) (result i64)
  (call $log (local.get $a))
  (i32.store (i32.const 0) (local.get $a))
  (call $combine (i32.load (i32.const 0)) (i64.const -1)))
(export "use" (func $use))
(export "mem" (memory $m))`,
  (ex) => [() => ex.use(5), () => ex.use(-1), () => ex.use(0x7fffffff)],
  {
    imports: () => ({
      env: {
        log: () => {},
        combine: (a, b) => BigInt(a) * 1000n + b,
        mem: new WebAssembly.Memory({ initial: 1, maximum: 1 }),
      },
    }),
    memoryExport: 'mem', memoryBytes: 16,
  });

// An IMPORTED GLOBAL, which WATX does not resolve at all. Kept as a witness
// for the same reason as the SIMD one: a gap that is written down is a work
// item, a gap that is deleted from the corpus is forgotten.
mod('imported-global', `
(import "env" "g" (global $g i32))
(func $get (result i32) (global.get $g))
(func $add (param $a i32) (result i32) (i32.add (local.get $a) (global.get $g)))
(export "get" (func $get)) (export "add" (func $add))`,
  (ex) => [() => ex.get(), () => ex.add(3), () => ex.add(-1)],
  {
    imports: () => ({ env: { g: 17 } }),
    expectDivergence: 'WATX has no imported-global resolution: "Unknown global \'$g\'"',
  });

// ── Select, both typed and untyped ────────────────────────────────────────
mod('select', `
(func $s (param $a i32) (param $b i32) (param $c i32) (result i32)
  (select (local.get $a) (local.get $b) (local.get $c)))
(func $sf (param $a f64) (param $b f64) (param $c i32) (result i64)
  (i64.reinterpret_f64 (select (local.get $a) (local.get $b) (local.get $c))))
(export "s" (func $s)) (export "sf" (func $sf))`,
  (ex) => {
    const out = [];
    for (const c of [0, 1, -1, 2]) {
      out.push(() => ex.s(10, 20, c), () => ex.sf(-0, NaN, c));
    }
    return out;
  });

// ── unreachable / drop / nop, and the code after them ─────────────────────
mod('control-misc', `
(func $unreach (param $c i32) (result i32)
  (if (local.get $c) (then (unreachable)))
  (nop)
  (drop (i32.const 99))
  (i32.const 1))
(func $brif (param $x i32) (result i32)
  (block $out (result i32)
    (drop (br_if $out (i32.const 5) (local.get $x)))
    (i32.const 6)))
(func $retvoid)
(func $loopcount (param $n i32) (result i32)
  (local $i i32)
  (loop $l
    (local.set $i (i32.add (local.get $i) (i32.const 1)))
    (br_if $l (i32.lt_s (local.get $i) (local.get $n))))
  (local.get $i))
(export "unreach" (func $unreach)) (export "brif" (func $brif))
(export "retvoid" (func $retvoid)) (export "loopcount" (func $loopcount))`,
  (ex) => [
    () => ex.unreach(0), () => ex.unreach(1),
    () => ex.brif(0), () => ex.brif(1), () => ex.brif(-1),
    () => { ex.retvoid(); return 'void'; },
    () => ex.loopcount(0), () => ex.loopcount(1), () => ex.loopcount(1000),
  ]);

// ── Data segments: escapes, adjacency, empty, and a passive one ───────────
mod('data-segments', `
(memory 1 1)
(export "mem" (memory 0))
(data (i32.const 0) "\\00\\ff\\7f\\80AZ\\t\\n\\r\\"\\\\")
(data (i32.const 16) "")
(data (i32.const 16) "adjacent")
(data (i32.const 200) "late")
(func $touch (result i32) (i32.load8_u (i32.const 0)))
(export "touch" (func $touch))`,
  (ex) => [() => ex.touch()], { memoryExport: 'mem', memoryBytes: 256 });

// KNOWN BUG. `\u{…}` is a core-WAT string escape and WATX does not decode it:
// it drops the backslash and stores the LITERAL characters `u{1F600}`. Bytes in
// a data segment are the least recoverable thing to get silently wrong, and
// nothing about the module says anything went awry.
mod('data-unicode-escape', `
(memory 1 1)
(export "mem" (memory 0))
(data (i32.const 0) "\\u{1F600}\\u{00e9}\\u{41}")
(func $touch (result i32) (i32.load8_u (i32.const 0)))
(export "touch" (func $touch))`,
  (ex) => [() => ex.touch()],
  {
    memoryExport: 'mem', memoryBytes: 16,
    expectDivergence: '\\u{…} data-string escape is not decoded — the literal characters are stored instead of the UTF-8 bytes',
  });

// ── Export names: ordering, punctuation, empty, unicode ───────────────────
// A memory is declared even though nothing here uses one: with no (memory …)
// in the module WATX synthesises one and exports it as "memory", which is a
// deliberate convenience for the browser runtime and not a bug — but it would
// show up in this entry's export list as a phantom name, so the module states
// its own memory and the comparison stays exact.
mod('export-names', `
(memory 1 1)
(export "mem" (memory 0))
(func $f (result i32) (i32.const 1))
(export "" (func $f))
(export "a b" (func $f))
(export "z" (func $f))
(export "A" (func $f))
(export "0" (func $f))`,
  (ex) => [() => Object.keys(ex).sort().join('|'), () => ex[''](), () => ex['a b']()]);

// ── A start function ──────────────────────────────────────────────────────
// KNOWN BUG: WATX parses `(start $f)` and emits NO start section at all — the
// function simply never runs, with no diagnostic. wabt emits `08 01 00` here.
// (That three-byte encoding is also why the byte-identity normalizer has to
// special-case section 8; see stripEmptySections.)
mod('start-function', `
(memory 1 1)
(export "mem" (memory 0))
(global $ran (mut i32) (i32.const 0))
(func $init (global.set $ran (i32.const 0x1234))
  (i32.store (i32.const 0) (i32.const 0xcafebabe)))
(start $init)
(func $ran (result i32) (global.get $ran))
(export "ran" (func $ran))`,
  (ex) => [() => ex.ran()],
  {
    memoryExport: 'mem', memoryBytes: 16,
    expectDivergence: '(start $f) emits no start section — the start function never runs',
  });

// ── A big function body ───────────────────────────────────────────────────
// The code section writes each body's size as a ULEB before the body; a body
// past 128 bytes, and past 16384, is where a fixed-width size field shows up.
{
  const N = 4000;
  let src = '(func $big (param $x i32) (result i32)\n(local $a i32)\n(local.set $a (local.get $x))\n';
  for (let i = 0; i < N; i++) src += `(local.set $a (i32.add (local.get $a) (i32.const ${(i % 251) - 125})))\n`;
  src += '(local.get $a))\n(export "big" (func $big))';
  mod('big-body', src, (ex) => [() => ex.big(0), () => ex.big(-1), () => ex.big(0x7fffffff)]);
}

// ── Many functions ────────────────────────────────────────────────────────
// Function indices past 127 need a multi-byte ULEB in every call and every
// export. This is the shape of the real tree (thousands of functions).
{
  const N = 300;
  let src = '';
  for (let i = 0; i < N; i++) src += `(func $u${i} (result i32) (i32.const ${i}))\n`;
  src += `(func $sum (result i32)\n(i32.add (call $u0) (i32.add (call $u127) (i32.add (call $u128) (i32.add (call $u255) (call $u${N - 1})))))\n)\n`;
  src += '(export "sum" (func $sum))\n(export "u299" (func $u299))\n(export "u128" (func $u128))';
  mod('many-functions', src, (ex) => [() => ex.sum(), () => ex.u299(), () => ex.u128()]);
}

// ── Conversions between every numeric pair ────────────────────────────────
mod('conversions', `
(func $i32f32 (param $a i32) (result i32) (i32.reinterpret_f32 (f32.convert_i32_s (local.get $a))))
(func $u32f32 (param $a i32) (result i32) (i32.reinterpret_f32 (f32.convert_i32_u (local.get $a))))
(func $i64f64 (param $a i64) (result i64) (i64.reinterpret_f64 (f64.convert_i64_s (local.get $a))))
(func $u64f64 (param $a i64) (result i64) (i64.reinterpret_f64 (f64.convert_i64_u (local.get $a))))
(func $demote (param $a f64) (result i32) (i32.reinterpret_f32 (f32.demote_f64 (local.get $a))))
(func $promote (param $a f32) (result i64) (i64.reinterpret_f64 (f64.promote_f32 (local.get $a))))
(export "i32f32" (func $i32f32)) (export "u32f32" (func $u32f32))
(export "i64f64" (func $i64f64)) (export "u64f64" (func $u64f64))
(export "demote" (func $demote)) (export "promote" (func $promote))`,
  (ex) => {
    const out = [];
    for (const v of [0, 1, -1, 0x7fffffff, -0x80000000, 16777217, -16777217]) {
      out.push(() => ex.i32f32(v), () => ex.u32f32(v));
    }
    for (const v of [0n, 1n, -1n, 0x7fffffffffffffffn, -0x8000000000000000n, 9007199254740993n]) {
      out.push(() => ex.i64f64(v), () => ex.u64f64(v));
    }
    for (const v of [0, -0, 1e300, -1e300, 1e-300, NaN, Infinity, 3.141592653589793]) {
      out.push(() => ex.demote(v));
    }
    for (const v of [0, -0, NaN, Infinity, 3.14159]) out.push(() => ex.promote(v));
    return out;
  });

// ── An out-of-bounds memory access at every width ─────────────────────────
// Every one of these traps; the point is that they trap at the SAME address on
// both sides, which is a statement about the offset immediate.
mod('oob-access', `
(memory 1 1)
(func $l (param $p i32) (result i32) (i32.load (local.get $p)))
(func $lo (param $p i32) (result i32) (i32.load offset=65532 (local.get $p)))
(func $l8 (param $p i32) (result i32) (i32.load8_u (local.get $p)))
(func $l64 (param $p i32) (result i64) (i64.load (local.get $p)))
(func $s (param $p i32) (i32.store (local.get $p) (i32.const 1)))
(export "l" (func $l)) (export "lo" (func $lo)) (export "l8" (func $l8))
(export "l64" (func $l64)) (export "s" (func $s))`,
  (ex) => {
    const out = [];
    for (const p of [0, 65532, 65533, 65535, 65536, -1, 0x7fffffff]) {
      out.push(() => ex.l(p), () => ex.lo(p === 0 ? 0 : 0), () => ex.l8(p),
        () => ex.l64(p), () => { ex.s(p); return 'ok'; });
    }
    out.push(() => ex.lo(0), () => ex.lo(4), () => ex.lo(5));
    return out;
  });

// ═══════════════════════════════════════════════════════════════
// GENERATED SWEEPS — deterministic, seeded, no randomness in the corpus.
//
// The hand-written entries above cover shapes. These cover VOLUME over one
// shape: an identity chain that carries a constant through a call, a global,
// a local and a memory round trip, instantiated once per boundary value. A
// truncated LEB shows up here as a wrong number rather than as a crash.
// ═══════════════════════════════════════════════════════════════

function boundaryI32Values() {
  const vals = new Set();
  for (let bits = 0; bits <= 32; bits++) {
    const base = bits === 32 ? 0x100000000 : Math.pow(2, bits);
    for (const d of [-1, 0, 1]) {
      const v = base + d;
      if (v >= -0x80000000 && v <= 0xffffffff) vals.add(v | 0);
      const n = -base + d;
      if (n >= -0x80000000 && n <= 0xffffffff) vals.add(n | 0);
    }
  }
  for (const v of [0, 1, -1, 0x55555555, -0x55555556, 0x33333333, 0x0f0f0f0f]) vals.add(v | 0);
  return [...vals].sort((a, b) => a - b);
}

function boundaryI64Values() {
  const vals = new Set();
  for (let bits = 0; bits <= 64; bits += 1) {
    const base = 1n << BigInt(bits);
    for (const d of [-1n, 0n, 1n]) {
      for (const s of [1n, -1n]) {
        const v = s * base + d;
        if (v >= -(1n << 63n) && v < (1n << 63n)) vals.add(v);
      }
    }
  }
  return [...vals].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// One module per sweep, one exported function per value, so a divergence names
// the exact literal instead of a batch.
function makeSweepI32() {
  const vals = boundaryI32Values();
  let src = '(memory 1 1)\n(global $g (mut i32) (i32.const 0))\n';
  vals.forEach((v, i) => {
    src += `(func $k${i} (result i32) (local $l i32)\n` +
      `  (global.set $g (i32.const ${v}))\n` +
      `  (i32.store (i32.const 0) (global.get $g))\n` +
      `  (local.set $l (i32.load (i32.const 0)))\n` +
      `  (local.get $l))\n(export "k${i}" (func $k${i}))\n`;
  });
  return { name: 'sweep-i32-identity', source: src, probe: (ex) => vals.map((_, i) => () => ex[`k${i}`]()) };
}

function makeSweepI64() {
  const vals = boundaryI64Values();
  let src = '(memory 1 1)\n(global $g (mut i64) (i64.const 0))\n';
  vals.forEach((v, i) => {
    src += `(func $k${i} (result i64) (local $l i64)\n` +
      `  (global.set $g (i64.const ${v}))\n` +
      `  (i64.store (i32.const 0) (global.get $g))\n` +
      `  (local.set $l (i64.load (i32.const 0)))\n` +
      `  (local.get $l))\n(export "k${i}" (func $k${i}))\n`;
  });
  return { name: 'sweep-i64-identity', source: src, probe: (ex) => vals.map((_, i) => () => ex[`k${i}`]()) };
}

// Deterministic pseudo-random operand grid. The seed is fixed and the LCG is
// written out here rather than taken from a library, so this file's corpus is
// the same on every machine and in every Node version, forever.
function makeSweepOps(seed = 0x5EED1234) {
  let s = seed >>> 0;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
  const OPS = ['i32.add', 'i32.sub', 'i32.mul', 'i32.and', 'i32.or', 'i32.xor',
    'i32.shl', 'i32.shr_s', 'i32.shr_u', 'i32.rotl', 'i32.rotr',
    'i32.eq', 'i32.ne', 'i32.lt_s', 'i32.lt_u', 'i32.gt_s', 'i32.gt_u',
    'i32.le_s', 'i32.ge_u'];
  const cases = [];
  for (let i = 0; i < 200; i++) {
    cases.push({ op: OPS[rnd() % OPS.length], a: rnd() | 0, b: rnd() | 0 });
  }
  let src = '';
  cases.forEach((c, i) => {
    src += `(func $o${i} (result i32) (${c.op} (i32.const ${c.a}) (i32.const ${c.b})))\n(export "o${i}" (func $o${i}))\n`;
  });
  return { name: 'sweep-const-fold', source: src, probe: (ex) => cases.map((_, i) => () => ex[`o${i}`]()) };
}

CORPUS.push(makeSweepI32(), makeSweepI64(), makeSweepOps());

// ═══════════════════════════════════════════════════════════════
// The runner
// ═══════════════════════════════════════════════════════════════

async function runDifferential({ only = null, onResult = null } = {}) {
  const entries = only ? CORPUS.filter((e) => only.test(e.name)) : CORPUS;
  const results = [];
  for (const entry of entries) {
    const r = { name: entry.name, ok: true, byteIdentical: null, notes: [], divergences: [] };
    let ref;
    try {
      ref = await compileWabt(entry.source);
    } catch (e) {
      r.ok = false;
      r.notes.push(`reference encoder (wabt) refused the module: ${e.message || e}`);
      results.push(r); if (onResult) onResult(r); continue;
    }
    const refObs = observe(ref, entry);
    let identicalBoth = true;
    for (const tailCalls of [false, true]) {
      let bin;
      try {
        bin = compileWatx(entry.source, { tailCalls });
      } catch (e) {
        r.ok = false;
        r.divergences.push({ mode: `tailCalls=${tailCalls}`, kind: 'watx-refused', detail: String(e.message || e) });
        identicalBoth = false;
        continue;
      }
      if (!sameBytes(bin, ref)) identicalBoth = false;
      const obs = observe(bin, entry);
      if (obs.instantiated !== refObs.instantiated) {
        r.ok = false;
        r.divergences.push({
          mode: `tailCalls=${tailCalls}`, kind: 'instantiation',
          detail: `wabt=${refObs.instantiated ? 'ok' : refObs.error} watx=${obs.instantiated ? 'ok' : obs.error}`,
        });
        continue;
      }
      if (!obs.instantiated) continue;
      const n = Math.max(obs.results.length, refObs.results.length);
      for (let i = 0; i < n; i++) {
        const a = JSON.stringify(refObs.results[i]), b = JSON.stringify(obs.results[i]);
        if (a !== b) {
          r.ok = false;
          r.divergences.push({ mode: `tailCalls=${tailCalls}`, kind: 'result', index: i, wabt: a, watx: b });
          if (r.divergences.length > 8) { r.notes.push('… further result divergences suppressed'); break; }
        }
      }
      if (obs.memBytes !== refObs.memBytes) {
        r.ok = false;
        r.divergences.push({
          mode: `tailCalls=${tailCalls}`, kind: 'memory',
          wabt: String(refObs.memBytes).slice(0, 200), watx: String(obs.memBytes).slice(0, 200),
        });
      }
    }
    r.byteIdentical = identicalBoth;
    // A marked entry INVERTS the verdict. Agreeing is the news, not the pass.
    if (entry.expectDivergence) {
      r.expected = entry.expectDivergence;
      if (r.ok) {
        r.ok = false;
        r.notes.push(`NO LONGER DIVERGES — the bug behind "${entry.expectDivergence}" ` +
          `appears fixed. Drop the expectDivergence marker (and the matching ` +
          `tools/watx-repro/ script) so this module is asserted green from now on.`);
      } else {
        r.ok = true;
        r.knownBug = true;
      }
    }
    results.push(r);
    if (onResult) onResult(r);
  }
  return {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    knownBugs: results.filter((r) => r.knownBug).length,
    byteIdentical: results.filter((r) => r.byteIdentical).length,
    results,
  };
}

module.exports = { CORPUS, DIALECT_GAPS, runDifferential, compileWatx, compileWabt, sameBytes, WABT_FEATURES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const verbose = args.includes('--verbose');
  runDifferential({
    only: onlyArg ? new RegExp(onlyArg.slice(7)) : null,
    onResult: (r) => {
      const tag = r.knownBug ? 'KNOWN' : r.ok ? 'PASS' : 'FAIL';
      const bytes = r.byteIdentical === null ? '' : r.byteIdentical ? '  [byte-identical]' : '';
      console.log(`  ${tag} ${r.name}${bytes}${r.knownBug ? `  (${r.expected})` : ''}`);
      for (const n of r.notes) console.log(`       ${n}`);
      if (!r.knownBug) for (const d of r.divergences) console.log(`       ${JSON.stringify(d)}`);
    },
  }).then((rep) => {
    console.log(`\n${rep.passed}/${rep.total} modules as expected ` +
      `(${rep.knownBugs} of them a KNOWN divergence that must keep diverging); ` +
      `${rep.byteIdentical}/${rep.total} byte-identical to wabt (bonus, not required)`);
    console.log(`Dialect gaps (standard WAT that WATX refuses outright):`);
    for (const g of DIALECT_GAPS) console.log(`  ${g.spelling} — ${g.note}`);
    if (verbose) console.log(JSON.stringify(rep.results, null, 2));
    process.exit(rep.passed === rep.total ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(2); });
}
