#!/usr/bin/env node
// Check every MMX operation in src/06c-mmx.wat against an independent model.
//
//   node tools/mmx-check.js [--iters=N] [--seed=N]
//
// Why this exists: most of the MMX set is implemented by widening a 64-bit
// register to v128, running one wasm SIMD instruction, and taking lane 0 back.
// That mapping is exact when it is right and silently plausible when it is
// wrong -- a shuffle with two lane indices swapped still produces bytes that
// look like an image, and pmulhw taking the wrong half of each product still
// produces a number. Neither shows up as a crash, and in a real app the first
// symptom is a video frame that is subtly wrong ten minutes in.
//
// So the operations are exercised here directly. $mmx_binop is pure, and
// 13-exports.wat re-exports it, so this instantiates the shipped wasm with
// stub imports (none of which can be called on this path) and compares against
// a BigInt/typed-array model written from the Intel description rather than
// from the WAT.
'use strict';

const fs = require('fs');
const path = require('path');

const WASM = path.join(__dirname, '..', 'build', 'wine-assembly.wasm');

// ---- reference model ----
// Each entry unpacks the two 64-bit operands into lanes, does the arithmetic
// in plain JS, and repacks. Deliberately not clever: this is the thing the
// implementation is being checked against.

const buf = new ArrayBuffer(8);
const dv = new DataView(buf);

function lanes(v, width, signed) {
  dv.setBigUint64(0, v, true);
  const n = 8 / width, out = [];
  for (let i = 0; i < n; i++) {
    if (width === 1) out.push(signed ? dv.getInt8(i) : dv.getUint8(i));
    else if (width === 2) out.push(signed ? dv.getInt16(i * 2, true) : dv.getUint16(i * 2, true));
    else out.push(signed ? dv.getInt32(i * 4, true) : dv.getUint32(i * 4, true));
  }
  return out;
}

function pack(vals, width) {
  for (let i = 0; i < vals.length; i++) {
    if (width === 1) dv.setUint8(i, vals[i] & 0xFF);
    else if (width === 2) dv.setUint16(i * 2, vals[i] & 0xFFFF, true);
    else dv.setUint32(i * 4, vals[i] >>> 0, true);
  }
  return dv.getBigUint64(0, true);
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const S8 = x => clamp(x, -128, 127), U8 = x => clamp(x, 0, 255);
const S16 = x => clamp(x, -32768, 32767), U16 = x => clamp(x, 0, 65535);

// Elementwise over lanes of `width`, `signed` interpretation.
function ew(width, signed, f) {
  return (a, b) => {
    const la = lanes(a, width, signed), lb = lanes(b, width, signed);
    return pack(la.map((x, i) => f(x, lb[i])), width);
  };
}

// Interleave: take alternating elements from the low (or high) half of each.
function unpack(width, high) {
  return (a, b) => {
    const n = 8 / width, half = n / 2, off = high ? half : 0;
    const la = lanes(a, width, false), lb = lanes(b, width, false), out = [];
    for (let i = 0; i < half; i++) { out.push(la[off + i]); out.push(lb[off + i]); }
    return pack(out, width);
  };
}

// Pack: the four elements of each source saturate down to half-width, a first.
function packTo(srcW, sat) {
  return (a, b) => {
    const la = lanes(a, srcW, true), lb = lanes(b, srcW, true);
    return pack([...la, ...lb].map(sat), srcW / 2);
  };
}

const mask64 = (1n << 64n) - 1n;

// x86 shifts flush to zero (or to the sign bit) once the count reaches the
// lane width, instead of taking the count modulo it.
function shift(width, dir) {
  return (a, b) => {
    const cnt = b > 255n ? 256 : Number(b);
    const bits = width * 8;
    if (width === 8) {
      if (cnt >= 64) {
        if (dir === 's') return BigInt.asUintN(64, BigInt.asIntN(64, a) >> 63n);
        return 0n;
      }
      const c = BigInt(cnt);
      if (dir === 'l') return BigInt.asUintN(64, a << c);
      if (dir === 'u') return a >> c;
      return BigInt.asUintN(64, BigInt.asIntN(64, a) >> c);
    }
    const la = lanes(a, width, dir === 's');
    const out = la.map(x => {
      if (cnt >= bits) return dir === 's' ? (x < 0 ? -1 : 0) : 0;
      if (dir === 'l') return x << cnt;
      if (dir === 'u') return x >>> cnt;   // lanes() already returned it unsigned
      return x >> cnt;
    });
    return pack(out, width);
  };
}

const MODEL = {
  3:  (a, b) => a & b,
  4:  (a, b) => (~a & b) & mask64,           // pandn: ~dst & src
  5:  (a, b) => a | b,
  6:  (a, b) => a ^ b,
  7:  (a, b) => (a & 0xFFFFFFFFn) | ((b & 0xFFFFFFFFn) << 32n),   // punpckldq
  8:  (a, b) => (a >> 32n) | ((b >> 32n) << 32n),                 // punpckhdq
  9:  unpack(1, false), 10: unpack(1, true),
  11: unpack(2, false), 12: unpack(2, true),
  13: packTo(2, S8), 14: packTo(4, S16), 15: packTo(2, U8),
  16: (a, b) => {                                                  // pmaddwd
    const la = lanes(a, 2, true), lb = lanes(b, 2, true);
    return pack([la[0] * lb[0] + la[1] * lb[1], la[2] * lb[2] + la[3] * lb[3]], 4);
  },
  17: ew(2, true,  (x, y) => (x * y) >> 16),                       // pmulhw
  18: ew(2, false, (x, y) => Math.floor((x * y) / 65536)),         // pmulhuw
  19: ew(2, true,  (x, y) => x * y),                               // pmullw

  32: ew(1, false, (x, y) => x + y),
  33: ew(2, false, (x, y) => x + y),
  34: ew(4, false, (x, y) => x + y),
  35: (a, b) => (a + b) & mask64,
  36: ew(1, false, (x, y) => x - y),
  37: ew(2, false, (x, y) => x - y),
  38: ew(4, false, (x, y) => x - y),
  39: (a, b) => (a - b) & mask64,
  40: ew(1, true,  (x, y) => S8(x + y)),
  41: ew(2, true,  (x, y) => S16(x + y)),
  44: ew(1, true,  (x, y) => S8(x - y)),
  45: ew(2, true,  (x, y) => S16(x - y)),
  48: ew(1, false, (x, y) => U8(x + y)),
  49: ew(2, false, (x, y) => U16(x + y)),
  52: ew(1, false, (x, y) => U8(x - y)),
  53: ew(2, false, (x, y) => U16(x - y)),
  56: ew(1, false, (x, y) => (x === y ? 0xFF : 0)),
  57: ew(2, false, (x, y) => (x === y ? 0xFFFF : 0)),
  58: ew(4, false, (x, y) => (x === y ? 0xFFFFFFFF : 0)),
  60: ew(1, true,  (x, y) => (x > y ? -1 : 0)),
  61: ew(2, true,  (x, y) => (x > y ? -1 : 0)),
  62: ew(4, true,  (x, y) => (x > y ? -1 : 0)),
  64: ew(1, false, Math.min),
  68: ew(1, false, Math.max),
  73: ew(2, true,  Math.min),
  77: ew(2, true,  Math.max),
  80: ew(1, false, (x, y) => (x + y + 1) >> 1),
  81: ew(2, false, (x, y) => (x + y + 1) >> 1),

  129: shift(2, 'l'), 130: shift(4, 'l'), 131: shift(8, 'l'),
  133: shift(2, 'u'), 134: shift(4, 'u'), 135: shift(8, 'u'),
  137: shift(2, 's'), 138: shift(4, 's'),
};

const NAMES = {
  3: 'pand', 4: 'pandn', 5: 'por', 6: 'pxor', 7: 'punpckldq', 8: 'punpckhdq',
  9: 'punpcklbw', 10: 'punpckhbw', 11: 'punpcklwd', 12: 'punpckhwd',
  13: 'packsswb', 14: 'packssdw', 15: 'packuswb', 16: 'pmaddwd',
  17: 'pmulhw', 18: 'pmulhuw', 19: 'pmullw',
  32: 'paddb', 33: 'paddw', 34: 'paddd', 35: 'paddq',
  36: 'psubb', 37: 'psubw', 38: 'psubd', 39: 'psubq',
  40: 'paddsb', 41: 'paddsw', 44: 'psubsb', 45: 'psubsw',
  48: 'paddusb', 49: 'paddusw', 52: 'psubusb', 53: 'psubusw',
  56: 'pcmpeqb', 57: 'pcmpeqw', 58: 'pcmpeqd',
  60: 'pcmpgtb', 61: 'pcmpgtw', 62: 'pcmpgtd',
  64: 'pminub', 68: 'pmaxub', 73: 'pminsw', 77: 'pmaxsw',
  80: 'pavgb', 81: 'pavgw',
  129: 'psllw', 130: 'pslld', 131: 'psllq',
  133: 'psrlw', 134: 'psrld', 135: 'psrlq',
  137: 'psraw', 138: 'psrad',
};

// ---- harness ----

function instantiate() {
  const mod = new WebAssembly.Module(fs.readFileSync(WASM));
  const imports = {};
  for (const im of WebAssembly.Module.imports(mod)) {
    imports[im.module] = imports[im.module] || {};
    if (im.kind === 'memory') {
      imports[im.module][im.name] = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
    } else if (im.kind === 'global') {
      imports[im.module][im.name] = 0;
    } else {
      // Never called: mmx_binop touches no imports. A stub that throws makes
      // that assumption visible rather than letting a silent 0 through.
      imports[im.module][im.name] = () => { throw new Error(`mmx-check: unexpected host call ${im.name}`); };
    }
  }
  return new WebAssembly.Instance(mod, imports);
}

// Values that break lane-boundary bugs: all-zero, all-one, alternating, sign
// bits set in every lane width, and saturation edges.
const FIXED = [
  0x0000000000000000n, 0xFFFFFFFFFFFFFFFFn, 0x0123456789ABCDEFn, 0xFEDCBA9876543210n,
  0x8080808080808080n, 0x7F7F7F7F7F7F7F7Fn, 0x8000800080008000n, 0x7FFF7FFF7FFF7FFFn,
  0x0001000200030004n, 0xFFFF0001FFFF0001n, 0x00000001FFFFFFFFn, 0x0102040810204080n,
];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s;
  };
}

function main() {
  const args = process.argv.slice(2);
  const iters = +(args.find(a => a.startsWith('--iters=')) || '').slice(8) || 400;
  const seed = +(args.find(a => a.startsWith('--seed=')) || '').slice(7) || 0x1234567;
  if (!fs.existsSync(WASM)) {
    console.error(`mmx-check: ${WASM} not found -- run tools/build.sh first`);
    process.exit(2);
  }
  const inst = instantiate();
  const mmx = inst.exports.mmx_binop;
  if (!mmx) {
    console.error('mmx-check: build has no mmx_binop export (13-exports.wat)');
    process.exit(2);
  }

  const next = rng(seed);
  const rand64 = () => (BigInt(next()) << 32n) | BigInt(next());
  const subs = Object.keys(MODEL).map(Number).sort((x, y) => x - y);
  let fails = 0, checks = 0;

  for (const sub of subs) {
    const model = MODEL[sub];
    const isShift = sub >= 128;
    const cases = [];
    for (const a of FIXED) for (const b of FIXED) cases.push([a, b]);
    for (let i = 0; i < iters; i++) cases.push([rand64(), rand64()]);
    // Shifts care about the count far more than about its bit pattern, so walk
    // every interesting count including the out-of-range ones x86 flushes.
    if (isShift) for (const a of FIXED) for (let c = 0; c <= 65; c++) cases.push([a, BigInt(c)]);

    let bad = 0, first = null;
    for (const [a, b] of cases) {
      checks++;
      const want = BigInt.asUintN(64, model(a, b));
      const got = BigInt.asUintN(64, mmx(a, b, sub));
      if (want !== got) {
        bad++;
        if (!first) first = { a, b, want, got };
      }
    }
    if (bad) {
      fails++;
      const h = v => '0x' + v.toString(16).padStart(16, '0');
      console.log(`FAIL ${NAMES[sub] || sub} (sub ${sub}): ${bad}/${cases.length} mismatched`);
      console.log(`       a=${h(first.a)} b=${h(first.b)}`);
      console.log(`    want=${h(first.want)}  got=${h(first.got)}`);
    }
  }

  console.log(`${subs.length - fails}/${subs.length} operations correct over ${checks} checks`);
  process.exit(fails ? 1 : 0);
}

if (require.main === module) main();
