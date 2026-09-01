// ═══════════════════════════════════════════════════════════════
// WATX COMPILER — Stages 5-6: Lowering & WASM Binary Code Gen
//
// ZERO IMPLICIT COERCION: This code generator never inserts
// type conversion instructions. All conversions must be explicit
// in the WATX source (i32.trunc_f32_s, f32.convert_i32_s, etc.)
// ═══════════════════════════════════════════════════════════════

// --- Stage 5: Lowering ---
function lowerIR(forms, checkResult, options = {}) {
  const lowered = [];
  const { layouts } = checkResult;
  
  // Byte width of a layout field type. The table is WATX_LAYOUT_FIELD_TYPES in
  // compiler-stages.js — the same one checkTypes() refuses unknown types against,
  // so this can no longer answer 4 for a type nobody recognizes and lay the struct
  // out at the wrong stride. Reaching the throw means the checker admitted a type
  // this table has no width for: a compiler bug, not a source error.
  function sizeOfType(t) {
    const size = watxLayoutFieldSize(t);
    if (size === null)
      throw new Error(`WATX internal: no byte width for layout field type '${t}' ` +
        `(it passed checkTypes but WATX_LAYOUT_FIELD_TYPES has no entry).`);
    return size;
  }
  
  function lowerForm(form) {
    if (!Array.isArray(form)) return form;
    const head = watxValue(watxAt(form, 0));
    
    if (head === 'layout') {
      const name = watxValue(watxAt(form, 1));
      let offset = 0;
      const fields = [];
      const fieldByName = new Map();
      for (let i = 2; i < watxFormLength(form); i++) {
        const fieldForm = watxAt(form, i);
        if (Array.isArray(fieldForm) && watxValue(watxAt(fieldForm, 0)) === 'field') {
          const fname = watxValue(watxAt(fieldForm, 1));
          const ftype = watxValue(watxAt(fieldForm, 2)) || 'i32';
          const elemSize = sizeOfType(ftype);
          // ARRAY FIELD sugar (heap-safety refactor, COMP): an optional 4th token is the element
          // COUNT (absent => 1 => a plain scalar field, unchanged); an optional 5th token is an
          // explicit byte STRIDE (absent => elemSize) so access-width and element-spacing decouple
          // (e.g. ARM V-regs: 16-byte stride but f32/f64/i64 sub-width access). Element k of the
          // field lives at (offset + k*stride), reached via load.field-elem/store.field-elem. The
          // field advances the struct offset by stride*count. Bad count/stride is a HARD ERROR
          // (silent-misuse guard — the whole point of the refactor).
          let count = 1, stride = elemSize;
          if (watxAt(fieldForm, 3) !== undefined) {
            const rawC = watxValue(watxAt(fieldForm, 3)); count = Number(rawC);
            if (!Number.isInteger(count) || count < 1)
              throw new Error(`Layout '${name}' field '${fname}': array count must be a positive integer, got '${rawC}'.`);
          }
          if (watxAt(fieldForm, 4) !== undefined) {
            const rawS = watxValue(watxAt(fieldForm, 4)); stride = Number(rawS);
            if (!Number.isInteger(stride) || stride < elemSize)
              throw new Error(`Layout '${name}' field '${fname}': explicit stride must be an integer >= elemSize (${elemSize}), got '${rawS}'.`);
          }
          const size = stride * count;
          const field = { name: fname, type: ftype, offset, size, count, elemSize, stride };
          fields.push(field);
          fieldByName.set(fname, field);
          offset += size;
        }
      }
      return { type: 'layout-lowered', name, fields, fieldByName, totalSize: offset };
    }
    
    return form.map(f => lowerForm(f));
  }
  
  if (options.layoutsOnly) {
    const layoutsOnly = [];
    for (const form of forms) {
      if (Array.isArray(form) && watxValue(watxAt(form, 0)) === 'layout') layoutsOnly.push(lowerForm(form));
    }
    return layoutsOnly;
  }
  return forms.map(lowerForm);
}


// --- Wasm Binary Encoding Helpers ---

function encodeULEB128(value) {
  const bytes = [];
  value = value >>> 0;
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function encodeSLEB128(value) {
  const bytes = [];
  let more = true;
  while (more) {
    let byte = value & 0x7f;
    value >>= 7;
    if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    bytes.push(byte);
  }
  return bytes;
}

// BigInt-based SLEB128 — required for i64 constants beyond 32 bits (e.g. NaN-box
// tag patterns like 0xFFF8000000000000). The 32-bit encoder above silently
// truncates those.
function encodeSLEB128Big(value) {
  value = BigInt(value);
  const bytes = [];
  let more = true;
  while (more) {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if ((value === 0n && (byte & 0x40) === 0) || (value === -1n && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    bytes.push(byte);
  }
  return bytes;
}
// ── Strict numeric-literal validation ───────────────────────────────────────
// A numeric literal has to parse in its ENTIRETY. `parseInt`/`parseFloat` stop at
// the first character they cannot use and hand back whatever prefix they managed
// to read, so before this existed `(i32.const 123abc)` compiled to 123,
// `(i64.const 0x10zz)` to 16, `(f32.const 1.25junk)` to 1.25 and
// `(i32.load offset=16junk ...)` to offset=16 — every one of them silently, with
// a plausible-looking wrong constant baked into the module. Trailing junk is now
// a hard error naming the token.
//
// UNDERSCORE DIGIT SEPARATORS: the WAT text format allows `_` BETWEEN digits
// (`1_000` is 1000, `0xFFFF_FFFF` is 0xFFFFFFFF). WATX's tokenizer used to stop a
// number at the underscore, so `1_000` arrived as the number `1` followed by a
// stray symbol `_000` and compiled to 1 — the worst of the three possible
// outcomes. The tokenizer now carries `_` through a number token (see
// WATX_CHAR_NUMBER in compiler-parser.js) and these validators accept it only in
// the spec position: between two digits of the same run, never leading, trailing
// or doubled. A separator is stripped before the value is computed, so every
// literal that was already valid keeps its exact previous value and encoding.
//
// Hex floats (`0x1p4`), `inf`, `nan`, `nan:0x…` and a `+`-signed exponent
// (`1e+10`) used to be rejected here — they are supported now. The first four
// name a bit pattern rather than a number, so they do NOT come through these
// validators at all: `watxSpecialFloatBits` below takes them before
// `watxParseFloatLiteral` is reached, because a JS Number cannot carry a NaN
// payload and Number() cannot read a hex float in the first place. Only the
// `+`-exponent case is a change here, in the regex.
const WATX_INT_LITERAL_RE = /^[+-]?(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|[0-9](?:_?[0-9])*)$/;
const WATX_FLOAT_LITERAL_RE =
  /^[+-]?(?:[0-9](?:_?[0-9])*)(?:\.(?:[0-9](?:_?[0-9])*)?)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/;

function watxLiteralReject(raw, what, expected) {
  const shown = raw === undefined || raw === null ? '<missing>' : String(raw);
  const e = new Error(
    `Invalid ${expected} literal '${shown}'${what ? ` in ${what}` : ''}: ` +
    `a numeric literal must parse in its entirety (trailing junk is not ignored; ` +
    `'_' is allowed only between digits)`);
  e.watxLiteral = shown;
  return e;
}

// ── Multivalue results are rejected, not silently emitted ───────────────────
// Wasm's multi-value proposal lets a function or a block yield more than one
// value. WATX PARSED `(result i32 i32)` — the type section even encoded both
// results correctly — and then emitted a body that assumes exactly one, because
// nothing downstream of the parse is multi-valued: a block type is emitted as a
// SINGLE `VALTYPE` byte with no path to the type-index form multivalue requires,
// `expressionType` reports `results[0]` and discards the rest, and
// `funcHasResult` / `exprYieldsValue` are booleans. The result was an
// accepted-invalid module: it compiled here, and V8 refused it at instantiate
// with `expected 2 elements on the stack for fallthru, found 1` — a diagnostic
// pointing at a byte offset in a generated binary, arriving from the engine long
// after the compiler that could have named the line let it through.
//
// Supporting it for real is not a contained change (it is a second value stack
// through the whole emitter, plus block types as type indices), so the honest
// behaviour is to fail HERE, at the declaration, naming the file and line.
function watxRejectMultivalue(what, types, node) {
  if (types.length <= 1) return;
  const e = new Error(
    `${what}: multivalue results are not supported — ${types.length} result types ` +
    `(${types.join(' ')}) were declared and WATX emits bodies that yield at most one. ` +
    `Return the extra values through memory or an out-pointer.`);
  const loc = watxFormLoc(node);
  if (loc !== undefined) { e.line = watxNodeLine(loc); e.col = watxNodeCol(loc); e.file = watxNodeFile(loc); }
  throw e;
}

// Validate an integer literal token and return it with digit separators removed.
function watxCheckIntLiteral(raw, what) {
  const s = String(raw ?? '');
  if (!WATX_INT_LITERAL_RE.test(s)) throw watxLiteralReject(raw, what, 'integer');
  return s.replace(/_/g, '');
}

// Validate a floating-point literal token and return it with separators removed.
// A plain integer is a valid float literal (`(f64.const 0)`, `(f32.const 0x10)`).
function watxCheckFloatLiteral(raw, what) {
  const s = String(raw ?? '');
  if (!WATX_INT_LITERAL_RE.test(s) && !WATX_FLOAT_LITERAL_RE.test(s)) {
    throw watxLiteralReject(raw, what, 'floating-point');
  }
  return s.replace(/_/g, '');
}

// Strict parseInt replacement for every position that reads an integer literal
// out of the source text. Returns a Number, exactly as parseInt did for the
// literals that were already valid.
function watxParseIntLiteral(raw, what) {
  // No explicit radix, exactly as the parseInt calls this replaces: the 0x prefix
  // selects hex and everything else is decimal. The token is already known to be
  // a complete literal, so parseInt's prefix-scanning behaviour cannot bite here.
  return parseInt(watxCheckIntLiteral(raw, what));
}

// Read the single literal token out of a `(TYPE.const LIT)` form used OUTSIDE a
// function body — a global initializer, an active data or elem segment offset.
// Same arity rule as the in-body constants, and for the same reason: junk that
// the tokenizer split into a second atom (`0x10zz`, `16zz`, `5oops`) is only
// visible as an extra child, and dropping it silently left a truncated constant.
function watxConstFormToken(form, what) {
  if (!Array.isArray(form) || form.length !== 3 || Array.isArray(form[2]) ||
      watxType(form[2]) === 'string') {
    throw new Error(
      `${what}: expected a constant with exactly one complete literal operand ` +
      `(an extra token here is usually trailing junk on the literal)`);
  }
  return watxValue(form[2]);
}

// Strict parseFloat replacement, same contract.
function watxParseFloatLiteral(raw, what) {
  const s = watxCheckFloatLiteral(raw, what);
  return /^[+-]?0[xX]/.test(s) ? parseInt(s) : parseFloat(s);
}

// Parse an integer literal (decimal or 0x hex, optional sign) as a BigInt,
// normalized to the signed two's-complement i64 value so SLEB128 stays <= 10
// bytes (e.g. 0xFFF8000000000000 -> -2251799813685248).
// A SIGN IN FRONT OF A HEX LITERAL HAS TO BE PEELED OFF BY HAND. BigInt('-0x10')
// throws — the BigInt constructor accepts a sign only on a decimal string — and
// this used to `return 0n` from the catch, so `(i64.const -0x1EE54E5E1FEE3030)`
// (src/09a7b-ole.wat:3801, the OLE compound-file magic 0xE11AB1A1E011CFD0)
// compiled to a silent zero and the container it writes had no signature at all.
// An unparseable literal is now a hard error rather than a plausible-looking 0.
function parseI64Literal(s) {
  watxCheckIntLiteral(s, 'i64 literal');
  s = String(s).trim().replace(/_/g, '');
  const neg = s.startsWith('-');
  const body = (neg || s.startsWith('+')) ? s.slice(1) : s;
  let v;
  // BigInt('-5') would happily absorb a SECOND sign, so reject one here: the peel above
  // consumed the only sign a literal is allowed to have.
  if (body === '' || body.startsWith('-') || body.startsWith('+')) throw new Error(`Invalid i64 literal '${s}'`);
  try { v = BigInt(body); } catch (_) { throw new Error(`Invalid i64 literal '${s}'`); }
  if (neg) v = -v;
  const MOD = 1n << 64n;
  v = ((v % MOD) + MOD) % MOD;        // wrap into [0, 2^64)
  if (v >= (1n << 63n)) v -= MOD;     // to signed
  return v;
}

function encodeF32(value) {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = value;
  return [...new Uint8Array(buf)];
}

function encodeF64(value) {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = value;
  return [...new Uint8Array(buf)];
}

const WATX_UTF8_ENCODER = new TextEncoder();
const WATX_F32_SCRATCH = new Float32Array(1);
const WATX_F32_BYTES = new Uint8Array(WATX_F32_SCRATCH.buffer);
const WATX_F64_SCRATCH = new Float64Array(1);
const WATX_F64_BYTES = new Uint8Array(WATX_F64_SCRATCH.buffer);

// ── Float literals that a JS Number cannot carry ────────────────────────────
// `inf`, `nan`, `nan:0xPAYLOAD` and hex floats used to be refused (see the
// NOT SUPPORTED note on the validators above). Three of those four spellings
// name a bit pattern rather than a real number, so the encoder cannot go
// through a JS Number at all:
//
//   * `nan:0x400000` has to land as EXACTLY that payload, and the payload is a
//     different width in each format (23 bits in f32, 52 in f64). Assigning any
//     NaN to a Float32Array/Float64Array is free to hand back the canonical
//     quiet NaN instead, so the round trip that encodes every other literal
//     would quietly replace the author's payload with a plausible one.
//   * a hex float is exact by construction — `0x1p-149` is the smallest f32
//     subnormal and `0x1.fffffep+127` the largest finite f32 — and JS has no
//     parser for the spelling at all. Number() returns NaN for it.
//
// So these go through integers: the significand is a BigInt and the rounding is
// done on it, once, round-to-nearest-ties-to-even, straight to the target
// format. There is no intermediate double and therefore no double-rounding step
// for f32 to get wrong at the subnormal boundary.
//
// DECIMAL literals are deliberately NOT rerouted through this path. They keep
// going through Number() and the typed-array store they always used, so every
// literal that compiled before this existed still encodes to the same bytes.
const WATX_FLOAT_FORMATS = {
  4: { mantBits: 23, expMax: 0xff, bias: 127, emin: -126, emax: 127 },
  8: { mantBits: 52, expMax: 0x7ff, bias: 1023, emin: -1022, emax: 1023 },
};

// `mant * 2^exp2`, with `mant` a positive BigInt, correctly rounded into `width`
// bytes of IEEE-754 and returned as the raw bit pattern.
function watxRoundToFloatBits(neg, mant, exp2, width) {
  const F = WATX_FLOAT_FORMATS[width];
  const signBit = neg ? (1n << BigInt(width * 8 - 1)) : 0n;
  if (mant === 0n) return signBit;

  const nbits = mant.toString(2).length;
  const e = nbits - 1 + exp2;                 // exponent if this were normal

  // Round `mant >> shift` to nearest, ties to even. A negative shift is an exact
  // left shift — nothing is discarded, so nothing is rounded.
  const roundAt = (shift) => {
    if (shift <= 0) return mant << BigInt(-shift);
    let q = mant >> BigInt(shift);
    const half = 1n << BigInt(shift - 1);
    const rem = mant & ((1n << BigInt(shift)) - 1n);
    const roundBit = (rem & half) !== 0n;
    const sticky = (rem & (half - 1n)) !== 0n;
    if (roundBit && (sticky || (q & 1n) !== 0n)) q += 1n;
    return q;
  };

  if (e < F.emin) {
    // Subnormal: the quantum is fixed at 2^(emin - mantBits), so ONE rounding at
    // that scale answers the whole question. `q` is then the raw low bits as they
    // stand — including the carry case q == 2^mantBits, which is the exponent
    // field ticking from 0 to 1, i.e. the smallest normal, with no special case.
    const q = roundAt(F.emin - F.mantBits - exp2);
    return signBit | q;
  }

  let q = roundAt(nbits - (F.mantBits + 1));
  let scale = exp2 + (nbits - (F.mantBits + 1));
  if (q.toString(2).length === F.mantBits + 2) { q >>= 1n; scale += 1; }   // rounded up into a new binade
  const e2 = F.mantBits + scale;
  if (e2 > F.emax) return signBit | (BigInt(F.expMax) << BigInt(F.mantBits));  // overflow -> inf
  return signBit | (BigInt(e2 + F.bias) << BigInt(F.mantBits)) | (q - (1n << BigInt(F.mantBits)));
}

const WATX_HEXFLOAT_RE =
  /^([+-]?)0[xX]([0-9a-fA-F](?:_?[0-9a-fA-F])*)?(?:\.((?:[0-9a-fA-F](?:_?[0-9a-fA-F])*)?))?(?:[pP]([+-]?[0-9](?:_?[0-9])*))?$/;
const WATX_INFNAN_RE = /^([+-]?)(inf|nan)(?::0[xX]([0-9a-fA-F](?:_?[0-9a-fA-F])*))?$/;

// Bits for one of the four non-decimal spellings, or null when `s` is not one of
// them and the ordinary decimal path should handle it.
function watxSpecialFloatBits(s, what, width) {
  const F = WATX_FLOAT_FORMATS[width];
  const infnan = WATX_INFNAN_RE.exec(s);
  if (infnan) {
    const signBit = infnan[1] === '-' ? (1n << BigInt(width * 8 - 1)) : 0n;
    const expField = BigInt(F.expMax) << BigInt(F.mantBits);
    if (infnan[2] === 'inf') return signBit | expField;
    if (infnan[3] === undefined) {
      // Bare `nan` is the CANONICAL quiet NaN: the payload's top bit set and
      // nothing else, which is what wat2wasm emits and what every engine
      // produces for an arithmetic NaN.
      return signBit | expField | (1n << BigInt(F.mantBits - 1));
    }
    const payload = BigInt('0x' + infnan[3].replace(/_/g, ''));
    if (payload === 0n || payload >= (1n << BigInt(F.mantBits))) {
      throw new Error(
        `Invalid NaN payload '${s}'${what ? ` in ${what}` : ''}: an f${width * 8} payload ` +
        `must be between 0x1 and 0x${((1n << BigInt(F.mantBits)) - 1n).toString(16)} ` +
        `(payload 0 would be an infinity, and the field is ${F.mantBits} bits wide)`);
    }
    return signBit | expField | payload;
  }

  // A hex literal with no '.' and no 'p' is an ordinary hex INTEGER written in a
  // float position (`(f64.const 0x10)`), which already compiled and must keep
  // encoding identically. Leave it on the decimal path.
  if (!/^[+-]?0[xX]/.test(s) || !/[.pP]/.test(s)) return null;
  const m = WATX_HEXFLOAT_RE.exec(s);
  if (!m) throw watxLiteralReject(s, what, 'hexadecimal floating-point');
  const intPart = (m[2] || '').replace(/_/g, '');
  const fracPart = (m[3] || '').replace(/_/g, '');
  if (!intPart && !fracPart) throw watxLiteralReject(s, what, 'hexadecimal floating-point');
  const digits = intPart + fracPart;
  const mant = digits ? BigInt('0x' + digits) : 0n;
  // Each hex fraction digit is four binary places, and `p` counts in binary
  // places already.
  const exp2 = (m[4] === undefined ? 0 : parseInt(m[4].replace(/_/g, ''), 10)) - 4 * fracPart.length;
  return watxRoundToFloatBits(m[1] === '-', mant, exp2, width);
}

// The one entry point every `TYPE.const` float site uses. Returns `width` bytes,
// little-endian, ready to append.
function watxFloatLiteralBytes(raw, what, width) {
  const s = String(raw ?? '');
  const special = watxSpecialFloatBits(s, what, width);
  if (special !== null) {
    const out = new Uint8Array(width);
    let bits = special;
    for (let i = 0; i < width; i++) { out[i] = Number(bits & 0xffn); bits >>= 8n; }
    return out;
  }
  const value = watxParseFloatLiteral(s, what);
  if (width === 4) { WATX_F32_SCRATCH[0] = value; return WATX_F32_BYTES.slice(); }
  WATX_F64_SCRATCH[0] = value; return WATX_F64_BYTES.slice();
}

var WATX_VALUE_OPS = null;
var WATX_F32_OPS = null;
var WATX_F64_OPS = null;
var WATX_I64_OPS = null;
var WATX_CMP_OPS = null;
var WATX_I32_OPS = null;
var WATX_BINARY_OPS = null;
var WATX_UNARY_OPS = null;
var WATX_CONV_OPS = null;
var WATX_SAT_CONV_OPS = null;
var WATX_SIMD_BINARY_OPS = null;
var WATX_SIMD_UNARY_OPS = null;
var WATX_SIMD_SHIFT_OPS = null;
var WATX_SIMD_SPLAT_OPS = null;
var WATX_SIMD_BITMASK_OPS = null;
var WATX_SIMD_MEM_OPS = null;
var WATX_SIMD_LANE_MEM_OPS = null;
var WATX_ATOMIC_OPS = null;
var WATX_LOAD_OPS = null;
var WATX_STORE_OPS = null;
var WATX_LAYOUT_ACCESS_OPS = null;

function encodeString(str) {
  const encoded = WATX_UTF8_ENCODER.encode(str);
  return [...encodeULEB128(encoded.length), ...encoded];
}

// Do not use Array#push(...largeArray) for sections or data blobs. Spread turns
// every byte into a JavaScript call argument, so sufficiently large modules hit
// the engine's call-stack/argument limit even when the compiler's AST recursion
// is shallow. Append in a loop for number arrays, or use BinaryWriter.append.
function appendArray(target, values) {
  for (let i = 0; i < values.length; i++) target.push(values[i]);
  return target.length;
}

class BinaryWriter {
  constructor(initialCapacity = 256) {
    this.buffer = new Uint8Array(initialCapacity);
    this.length = 0;
  }

  ensure(extra) {
    const needed = this.length + extra;
    if (needed <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  push(...values) {
    this.ensure(values.length);
    for (let i = 0; i < values.length; i++) this.buffer[this.length++] = values[i];
    return this.length;
  }

  byte(value) {
    this.ensure(1);
    this.buffer[this.length++] = value;
    return this.length;
  }

  uleb(value) {
    value = value >>> 0;
    this.ensure(5);
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      this.buffer[this.length++] = byte;
    } while (value !== 0);
    return this.length;
  }

  sleb(value) {
    this.ensure(5);
    let more = true;
    while (more) {
      let byte = value & 0x7f;
      value >>= 7;
      if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
        more = false;
      } else {
        byte |= 0x80;
      }
      this.buffer[this.length++] = byte;
    }
    return this.length;
  }

  slebBig(value) {
    value = BigInt(value);
    this.ensure(10);
    let more = true;
    while (more) {
      let byte = Number(value & 0x7fn);
      value >>= 7n;
      if ((value === 0n && (byte & 0x40) === 0) || (value === -1n && (byte & 0x40) !== 0)) {
        more = false;
      } else {
        byte |= 0x80;
      }
      this.buffer[this.length++] = byte;
    }
    return this.length;
  }

  f32(value) {
    WATX_F32_SCRATCH[0] = value;
    this.append(WATX_F32_BYTES);
    return this.length;
  }

  f64(value) {
    WATX_F64_SCRATCH[0] = value;
    this.append(WATX_F64_BYTES);
    return this.length;
  }

  string(value) {
    const encoded = WATX_UTF8_ENCODER.encode(value);
    this.uleb(encoded.length);
    this.append(encoded);
    return this.length;
  }

  append(values) {
    this.ensure(values.length);
    this.buffer.set(values, this.length);
    this.length += values.length;
    return this.length;
  }

  finish() {
    return this.buffer.slice(0, this.length);
  }
}

function appendSection(writer, id, content) {
  writer.byte(id);
  writer.uleb(content.length);
  if (content instanceof BinaryWriter) {
    writer.append(content.buffer.subarray(0, content.length));
  } else {
    writer.append(content);
  }
}

// Wasm opcodes
const OP = {
  unreachable: 0x00, nop: 0x01, block: 0x02, loop: 0x03, if_: 0x04, else_: 0x05, end: 0x0b,
  br: 0x0c, br_if: 0x0d, return_: 0x0f, call: 0x10, drop: 0x1a, select: 0x1b,
  // --- android-emu extensions: indirect + tail calls for threaded-code dispatch ---
  call_indirect: 0x11, return_call: 0x12, return_call_indirect: 0x13,
  local_get: 0x20, local_set: 0x21, local_tee: 0x22,
  global_get: 0x23, global_set: 0x24,
  i32_load: 0x28, i64_load: 0x29, f32_load: 0x2a, f64_load: 0x2b,
  i32_load8_s: 0x2c, i32_load8_u: 0x2d, i32_load16_s: 0x2e, i32_load16_u: 0x2f,
  i64_load8_s: 0x30, i64_load8_u: 0x31, i64_load16_s: 0x32, i64_load16_u: 0x33,
  i64_load32_s: 0x34, i64_load32_u: 0x35,
  i32_store: 0x36, i64_store: 0x37, f32_store: 0x38, f64_store: 0x39,
  i32_store8: 0x3a, i32_store16: 0x3b, i64_store8: 0x3c, i64_store16: 0x3d, i64_store32: 0x3e,
  memory_size: 0x3f, memory_grow: 0x40,
  i32_const: 0x41, i64_const: 0x42, f32_const: 0x43, f64_const: 0x44,
  i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_lt_s: 0x48, i32_lt_u: 0x49,
  i32_gt_s: 0x4a, i32_gt_u: 0x4b, i32_le_s: 0x4c, i32_le_u: 0x4d, i32_ge_s: 0x4e, i32_ge_u: 0x4f,
  f32_eq: 0x5b, f32_ne: 0x5c, f32_lt: 0x5d, f32_gt: 0x5e, f32_le: 0x5f, f32_ge: 0x60,
  i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_div_s: 0x6d, i32_div_u: 0x6e,
  i32_rem_s: 0x6f, i32_rem_u: 0x70,
  i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76,
  f32_add: 0x92, f32_sub: 0x93, f32_mul: 0x94, f32_div: 0x95, f32_min: 0x96, f32_max: 0x97, f32_copysign: 0x98,
  f32_abs: 0x8b, f32_neg: 0x8c, f32_ceil: 0x8d, f32_floor: 0x8e, f32_trunc: 0x8f, f32_nearest: 0x90, f32_sqrt: 0x91,
  i32_trunc_f32_s: 0xa8, i32_trunc_f32_u: 0xa9,
  f32_convert_i32_s: 0xb2, f32_convert_i32_u: 0xb3,
  f64_promote_f32: 0xbb, f32_demote_f64: 0xb6,
  i32_wrap_i64: 0xa7, i64_extend_i32_s: 0xac,
  f64_add: 0xa0, f64_sub: 0xa1, f64_mul: 0xa2, f64_div: 0xa3,
  f64_convert_i32_s: 0xb7,
  i32_reinterpret_f32: 0xbc, f32_reinterpret_i32: 0xbe,
  // --- watjs extensions: full i64 + f64 op set (additive) ---
  i32_clz: 0x67, i32_ctz: 0x68, i32_popcnt: 0x69, i32_rotl: 0x77, i32_rotr: 0x78,
  i64_eqz: 0x50, i64_eq: 0x51, i64_ne: 0x52, i64_lt_s: 0x53, i64_lt_u: 0x54,
  i64_gt_s: 0x55, i64_gt_u: 0x56, i64_le_s: 0x57, i64_le_u: 0x58, i64_ge_s: 0x59, i64_ge_u: 0x5a,
  i64_clz: 0x79, i64_ctz: 0x7a, i64_popcnt: 0x7b,
  i64_add: 0x7c, i64_sub: 0x7d, i64_mul: 0x7e, i64_div_s: 0x7f, i64_div_u: 0x80,
  i64_rem_s: 0x81, i64_rem_u: 0x82, i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85,
  i64_shl: 0x86, i64_shr_s: 0x87, i64_shr_u: 0x88, i64_rotl: 0x89, i64_rotr: 0x8a,
  f64_eq: 0x61, f64_ne: 0x62, f64_lt: 0x63, f64_gt: 0x64, f64_le: 0x65, f64_ge: 0x66,
  f64_abs: 0x99, f64_neg: 0x9a, f64_ceil: 0x9b, f64_floor: 0x9c, f64_trunc: 0x9d,
  f64_nearest: 0x9e, f64_sqrt: 0x9f, f64_min: 0xa4, f64_max: 0xa5, f64_copysign: 0xa6,
  i32_trunc_f64_s: 0xaa, i32_trunc_f64_u: 0xab,
  i64_extend_i32_u: 0xad, i64_trunc_f32_s: 0xae, i64_trunc_f32_u: 0xaf,
  i64_trunc_f64_s: 0xb0, i64_trunc_f64_u: 0xb1,
  f32_convert_i64_s: 0xb4, f32_convert_i64_u: 0xb5,
  f64_convert_i32_u: 0xb8, f64_convert_i64_s: 0xb9, f64_convert_i64_u: 0xba,
  i64_reinterpret_f64: 0xbd, f64_reinterpret_i64: 0xbf,
  i32_extend8_s: 0xc0, i32_extend16_s: 0xc1,
  i64_extend8_s: 0xc2, i64_extend16_s: 0xc3, i64_extend32_s: 0xc4,
};

// v128 (0x7B) added by the SIMD track (Vlad-blessed 2026-08-12) as a shared host-SIMD
// substrate. Two consumers: (1) guest ARM NEON emulation in src/arm-simd.watx (B-owned,
// host v128 collapses per-lane loops on the mappable subset); (2) raster/alpha-blend in
// framework-drawpass + graphics-canvas (RES-owned, 4x i32 pixels per iteration). Kernel
// migrations are O-gated for BIT-EXACTNESS vs the existing scalar reference and keep a
// scalar fallback for ops with no host equivalent.
const VALTYPE = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b, void: 0x40 };

// String -> WASM valtype byte. Replaces the inline `t === 'f32' ? ... : ...` ternary
// chains — adding a new scalar/vector type is now a single-line edit. Unknown types
// fall back to i32 (matches prior behavior of the ternary chains).
function valtypeOf(t) {
  if (t === 'f32')  return VALTYPE.f32;
  if (t === 'f64')  return VALTYPE.f64;
  if (t === 'i64')  return VALTYPE.i64;
  if (t === 'v128') return VALTYPE.v128;
  return VALTYPE.i32;
}
// Reverse map — for disassembly output.
function valtypeName(b) {
  if (b === VALTYPE.i32)  return 'i32';
  if (b === VALTYPE.i64)  return 'i64';
  if (b === VALTYPE.f32)  return 'f32';
  if (b === VALTYPE.f64)  return 'f64';
  if (b === VALTYPE.v128) return 'v128';
  return '?';
}

const BUILTIN_REGION_ENTER = '$__region_enter';
const BUILTIN_REGION_ALLOC = '$__region_alloc';
const BUILTIN_REGION_EXIT = '$__region_exit';

// ── The shake (docs/watx-region-safety-design.md §8) ─────────────────────────
// A layout that never moves is a layout nobody has tested. Byte identity proves
// each conversion was EXACT; it cannot prove they were COMPLETE, because a
// missed raw literal that still equals the right address emits identical bytes.
// So the allocator can be asked to produce a deliberately different — and
// deterministic — layout, and the test pool is run against it.
//
// The permutation touches the ALLOCATED sequence and nothing else: pinned and
// derived regions keep their addresses, because moving $GUEST_BASE or a
// guest-VA-anchored stack changes the guest ABI, which is a different
// experiment. A shaken artifact is therefore never canonical, and the build
// banner says so.
//
// Prime gaps are deliberate: a shift that is a multiple of every stride in the
// tree can be absorbed by an off-by-a-stride bug and stay green.
const REGION_SHAKE_PRIMES = [4099, 8209, 12289, 16411, 20483, 24593, 28687, 32771, 36871, 40961];

// The three region forms that are a compile-time CONSTANT rather than an
// instruction. They are legal in every constant position — an instruction
// operand, a data-segment offset, and a global initializer — because a region's
// address is known before any of the three are emitted. Named once so the
// positions cannot drift apart.
const REGION_CONST_HEADS = new Set(['region.addr', 'region.size', 'region.end']);

function normalizeRegionShake(value) {
  if (value === undefined || value === null || value === false || value === '') return null;
  const text = String(value).trim();
  if (text === '' || text === '0' || text === 'off' || text === 'none') return null;
  const named = text.toLowerCase();
  if (named === 'gap' || named === 'rotate' || named === 'reverse' || named === 'pad') {
    return { mode: named, seed: 0, label: named };
  }
  const seed = /^0x/i.test(text) ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
  if (!Number.isInteger(seed) || seed <= 0) {
    throw new Error(`region shake: '${text}' is not gap, rotate, reverse, pad or a positive numeric seed`);
  }
  return { mode: 'seed', seed: seed >>> 0, label: `seed 0x${(seed >>> 0).toString(16)}` };
}

function shakeRegionSequence(sequence, shake) {
  const items = sequence.map(item => ({ ...item }));
  const regionsAt = [];
  items.forEach((item, i) => { if (item.kind === 'region') regionsAt.push(i); });
  if (shake.mode === 'gap') {
    const out = [];
    let n = 0;
    for (const item of items) {
      if (item.kind === 'region') {
        out.push({ kind: 'gap', size: REGION_SHAKE_PRIMES[n % REGION_SHAKE_PRIMES.length], form: item.form,
                   reason: 'shake' });
        n++;
      }
      out.push(item);
    }
    return out;
  }
  if (shake.mode === 'pad') {
    // Space every region out by a prime page count WITHOUT changing its declared
    // size: growing the size would break the very (stride …)/(mask …) laws the
    // shake needs left intact to be a test of addressing rather than of arithmetic.
    let n = 0;
    for (const i of regionsAt) {
      items[i].extent = items[i].region.size + REGION_SHAKE_PRIMES[(n++) % REGION_SHAKE_PRIMES.length];
    }
    return items;
  }
  // The order permutations rearrange the allocated regions among the positions
  // they occupy, leaving the source's own gaps where they were declared.
  const picked = regionsAt.map(i => items[i]);
  let order;
  if (shake.mode === 'reverse') {
    order = picked.slice().reverse();
  } else if (shake.mode === 'rotate') {
    order = picked.length ? picked.slice(1).concat(picked.slice(0, 1)) : picked;
  } else {
    // A 32-bit LCG shuffle: reproducible from the seed alone, on any engine.
    let state = shake.seed >>> 0;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    order = picked.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = next() % (i + 1);
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
  }
  regionsAt.forEach((slot, k) => { items[slot] = order[k]; });
  return items;
}

// Place a SHAKEN sequence around the pins, with a cursor per free window rather
// than one for the whole memory.
//
// WHY THE SHAKE NEEDS ITS OWN PLACER. The canonical allocator is declaration-
// order first-fit above a floor with ONE monotonic cursor and no backfilling,
// deliberately: backfilling would make every base depend on the size history of
// every earlier region, and a canonical layout that reshuffles under an
// unrelated capacity bump is not reproducible in any useful sense. Under a
// shake that same monotonicity is a cliff. The pins cut the usable space into
// disjoint windows, and once the cursor overflows one it jumps past the pin and
// every remaining free byte BELOW that pin is gone for good — so a megabyte of
// `gap` primes aimed at a 73KB window did not cost a megabyte, it cost five,
// and the big regions further down the sequence then had nowhere to go. The
// map had 5.43MB of slack and the shake needed 3.55MB of it.
//
// So the shake gets first-fit ACROSS THE WINDOWS: each region goes in the first
// window with room for it, each window remembers its own cursor. That is the
// same "flow around the pins" rule, applied to space the single cursor could
// only walk past. It is robust to any future pin, because a pin only ever adds
// a window boundary.
//
// SCALING DOWN RATHER THAN FAILING. A shake's inflation is a request, not a
// requirement — the point is that the regions MOVED, not that they moved by a
// prime. So a region that fits nowhere at its inflated footprint is retried at
// its declared size, and the leading gap is dropped before the region itself is.
// Every such retry is counted and the build banner reports it: a shake that
// quietly could not inflate is the same trap as a mirror that quietly did not
// match, so it says so.
function placeShakenAroundPins(placedSequence, pins, floor, memoryBytes, located, hx, alignUp) {
  // The free windows: everything between the floor and the memory end that a
  // pin does not occupy. Pins arrive sorted by base.
  const windows = [];
  let edge = floor;
  for (const p of pins) {
    if (p.base > edge) windows.push({ base: edge, end: p.base, cursor: edge });
    edge = Math.max(edge, p.base + p.size);
  }
  if (edge < memoryBytes) windows.push({ base: edge, end: memoryBytes, cursor: edge });

  // BEST fit, not first fit, and the difference is the whole fix. First fit by
  // address hands every small region to the lowest window with room, so the
  // small ones eat into the one big window and the big ones arrive to find it
  // nibbled — measured, $THREAD_CACHE_BASE came up 318KB short of its 32MB in a
  // 47MB window that first fit had already spent 15.7MB of on regions that had
  // somewhere else to go. Best fit puts each region in the TIGHTEST window that
  // still holds it, so small regions drain into small windows and a long run
  // stays long for the region that actually needs one.
  const tryPlace = (align, lead, extent) => {
    let best = null;
    for (const w of windows) {
      const at = alignUp(w.cursor + lead, align);
      if (at < w.base || at + extent > w.end) continue;
      const leftover = w.end - (at + extent);
      if (!best || leftover < best.leftover) best = { w, at, leftover };
    }
    return best;
  };

  let scaledDown = 0;
  let pendingGap = 0;
  for (const item of placedSequence) {
    // A gap is a request to push the NEXT region along. Which window that
    // region lands in is not known yet, so the gap travels with it instead of
    // being spent on whichever window the cursor happens to be in.
    if (item.kind === 'gap') { pendingGap += item.size; continue; }
    const r = item.region;
    const extent = item.extent || r.size;   // `pad` shake spaces without resizing

    // Most permissive first, then give up one concession at a time: the gap,
    // then the padding. The declared size is never negotiable.
    let spot = tryPlace(r.align, pendingGap, extent);
    if (!spot && pendingGap) { spot = tryPlace(r.align, 0, extent); if (spot) scaledDown++; }
    if (!spot && extent !== r.size) {
      spot = tryPlace(r.align, pendingGap, r.size) || tryPlace(r.align, 0, r.size);
      if (spot) scaledDown++;
    }
    if (!spot) {
      const room = windows.map(w => `${hx(w.base)}..${hx(w.end)} free from ${hx(w.cursor)}`).join(', ');
      throw located(r.form, `${r.name} (${hx(r.size)} bytes, align ${hx(r.align)}) does not fit ` +
        `in any free window of the SHAKEN layout, even unpadded. Windows: ${room}. ` +
        `The pinned regions leave no run this large; this is a capacity problem, not a shake bug.`);
    }
    r.base = spot.at;
    spot.w.cursor = spot.at + (spot.at + extent <= spot.w.end ? extent : r.size);
    pendingGap = 0;
  }
  return scaledDown;
}


function generateWasm(forms, loweredForms, checkResult, options = {}) {
  const V = watxValue;
  const T = watxType;
  // Preserve the historical WATX runtime by default. Compatibility/migration
  // builds can disable it so declarations retain exact Wasm indices.
  const runtimeBuiltins = options.runtimeBuiltins !== false;
  const tailCalls = options.tailCalls !== false;
  const standardWat = options.standardWat === true;

  // ── Positional else is a HARD ERROR (see the `if` compiler below) ──────────
  // This was a warning, ending "This will become a hard error", with the stated
  // precondition "promotion is planned for when the closure has none left". The
  // closure has none left — a full tools/build.sh emits zero of these warnings,
  // in both dispatch modes — so the promotion is due and this is it.
  //
  // Why it cannot stay a warning. `(if COND (then A) B)` is not standard WAT.
  // WATX compiles the bare B AS the else arm; lib/compile-wat.js silently
  // DISCARDED it. Two compilers, one source, different programs, no error on
  // either side — the failure is a missing else branch at runtime, arbitrarily
  // far from the line that caused it. A warning is the wrong instrument for a
  // divergence you cannot see in the output, and this one was additionally
  // invisible in the configuration that matters: the production build routes
  // console.warn nowhere anybody reads.
  function failPositionalElse(expr, func) {
    const loc = watxFormLoc(expr);
    const file = loc !== undefined ? watxNodeFile(loc) : '<unknown>';
    const line = loc !== undefined ? watxNodeLine(loc) : 0;
    throw new Error(
      `${file}:${line}: bare expression in the else slot of ` +
      `(if COND (then ...) EXPR)${func && func.name ? ` in ${func.name}` : ''} — ` +
      `standard WAT requires (else ...). Wrap it: (if COND (then ...) (else ...)). ` +
      `WATX would compile the bare expression as the else arm and other WAT ` +
      `compilers discard it, so the same source means two different programs. ` +
      `Note this does NOT apply to WATX's own (if COND A B) shorthand, which has ` +
      `no (then ...) either and is a deliberate spelling.`);
  }
  const layoutInfo = new Map();
  for (const f of loweredForms) {
    if (f?.type === 'layout-lowered') {
      layoutInfo.set(f.name, f);
    }
  }

  // Resolve a (layout) name to its lowered info, or throw a hard compile error.
  // The old field/elem/size-of handlers silently defaulted an unknown layout to
  // offset 0 / size 16 — turning a typo'd layout or field name into a read/write
  // of the WRONG memory location with no diagnostic. `srcTok` is the symbol token
  // (carries line:col) for the error.
  function lookupLayout(layoutName, head, srcTok) {
    const info = layoutInfo.get(layoutName);
    if (!info) {
      const e = new Error(
        `Unknown layout '${layoutName}' in ${head}: no such (layout ...) declaration (typo?).`);
      e.line = watxNodeLine(srcTok); e.col = watxNodeCol(srcTok); e.file = watxNodeFile(srcTok);
      throw e;
    }
    return info;
  }
  // Resolve a field within a layout, or throw. Returns the lowered field record.
  function lookupField(info, fieldName, head, srcTok) {
    const field = info.fieldByName.get(fieldName);
    if (!field) {
      const e = new Error(
        `Unknown field '${fieldName}' of layout '${info.name}' in ${head}: ` +
        `layout has [${info.fields.map(f => f.name).join(', ')}] (typo?).`);
      e.line = watxNodeLine(srcTok); e.col = watxNodeCol(srcTok); e.file = watxNodeFile(srcTok);
      throw e;
    }
    return field;
  }

  // --- string / cstring data pool ---
  // (cstring "txt") interns a [i32 len][utf8 bytes] blob in linear memory at a
  // compile-assigned offset (base DATA_BASE) and compiles to i32.const <ptr>.
  // The engine treats that pointer as a JS string heap object (Str layout).
  // DATA_BASE is finalized once static regions are laid out (see below): the
  // data section sits ABOVE the static regions so string bytes never collide
  // with a region's storage. It stays 1024 when there are no static regions.
  let DATA_BASE = 1024;
  // Where the pool WOULD go under the legacy "above the last data segment" rule.
  // Kept separate from DATA_BASE so `(string.pool ...)` can move the pool without
  // also moving the bump heap, which is a different tenant of that same address.
  let legacyDataBase = 1024;
  // Set by `(string.pool $REGION)`: {name, base, size, form}. Null = legacy placement.
  let stringPoolRegion = null;
  // The first function whose body interned a literal. A misplaced pool is
  // diagnosed with no form of its own to point at — it is the ABSENCE of a
  // declaration — so the error points here instead, at a line that actually
  // contains one of the strings being placed.
  let firstInternFunc = null;
  // Location-tagged error, for forms outside the region block's own `located`.
  const locatedAt = (form, message) => {
    const e = new Error(message);
    const loc = form == null ? undefined : watxFormLoc(form);
    if (loc !== undefined) {
      e.line = watxNodeLine(loc); e.col = watxNodeCol(loc); e.file = watxNodeFile(loc);
    }
    return e;
  };
  const formWhere = (form) => {
    const loc = watxFormLoc(form);
    if (loc === undefined) return 'an earlier line';
    const file = watxNodeFile(loc);
    return file ? `${file}:${watxNodeLine(loc)}` : `line ${watxNodeLine(loc)}`;
  };
  const dataPool = { bytes: new BinaryWriter(1024), map: new Map() };
  function unescapeStr(raw) {
    // raw includes surrounding quotes; strip and process escapes
    let s = raw;
    if (s[0] === '"') s = s.slice(1, s[s.length - 1] === '"' ? -1 : s.length);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && i + 1 < s.length) {
        const n = s[++i];
        // Same `\u{…}` rule as the data-segment decoder, through the same
        // helper: a WATX pool string is UTF-8 encoded on the way out, so an
        // undecoded escape here stored the literal characters `u{1F600}` too.
        if (n === 'u') {
          const { cp, next } = decodeUnicodeEscape(s, i, (m) => new Error(`in a string literal: ${m}`));
          out += String.fromCodePoint(cp);
          i = next;
          continue;
        }
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r'
             : n === '0' ? '\0' : n === '\\' ? '\\' : n === '"' ? '"' : n;
      } else out += s[i];
    }
    return out;
  }
  // A `\u{…}` escape names a Unicode SCALAR VALUE, and the spec says to store its
  // UTF-8 encoding. WATX used to have no case for it at all, so `\u{1F600}` fell
  // through to the "unknown escape" branch, stored the byte `u`, and then copied
  // `{1F600}` across literally — seven wrong bytes where four belong, with no
  // diagnostic. Shared by both string decoders so the two spellings cannot drift.
  // Returns the codepoint and the index just past the closing brace.
  function decodeUnicodeEscape(s, i, fail) {
    // s[i] is 'u'; the spec's grammar requires a brace immediately after it.
    if (s[i + 1] !== '{') throw fail(`\\u must be followed by a braced codepoint, as \\u{1F600}`);
    const close = s.indexOf('}', i + 2);
    if (close < 0) throw fail(`\\u{ escape has no closing '}'`);
    const digits = s.slice(i + 2, close);
    if (!/^[0-9a-fA-F]+$/.test(digits)) {
      throw fail(`\\u{${digits}} is not a hexadecimal codepoint`);
    }
    const cp = parseInt(digits, 16);
    // A surrogate half is not a scalar value; UTF-8 has no encoding for one, and
    // String.fromCodePoint would hand back a lone surrogate that the encoder
    // silently replaces with U+FFFD — a wrong constant, quietly, again.
    if (cp > 0x10FFFF) throw fail(`\\u{${digits}} is past the last codepoint (max 10FFFF)`);
    if (cp >= 0xD800 && cp <= 0xDFFF) {
      throw fail(`\\u{${digits}} is a surrogate half, which is not a Unicode scalar value and has no UTF-8 encoding`);
    }
    return { cp, next: close };
  }

  // Standard WAT strings use \hh byte escapes (not C-style octal escapes).
  // Data segments need the exact byte stream, including non-UTF8 bytes.
  function decodeWatStringBytes(raw, mkErr) {
    const fail = mkErr || ((m) => new Error(`in a data string: ${m}`));
    let s = raw || '""';
    if (s[0] === '"') s = s.slice(1, s[s.length - 1] === '"' ? -1 : s.length);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '\\') {
        const cp = s.codePointAt(i);
        out.push(...WATX_UTF8_ENCODER.encode(String.fromCodePoint(cp)));
        if (cp > 0xffff) i++;
        continue;
      }
      const a = s[i + 1], b = s[i + 2];
      if (a && b && /^[0-9a-fA-F]$/.test(a) && /^[0-9a-fA-F]$/.test(b)) {
        out.push(parseInt(a + b, 16)); i += 2; continue;
      }
      i++;
      // `\u{…}` is checked BEFORE the two-hex-digit rule can misread it — it
      // cannot, since `u` is not a hex digit, but the ordering is the reason.
      if (s[i] === 'u') {
        const { cp, next } = decodeUnicodeEscape(s, i, fail);
        out.push(...WATX_UTF8_ENCODER.encode(String.fromCodePoint(cp)));
        i = next;
        continue;
      }
      const escaped = { n: 10, r: 13, t: 9, '\\': 92, '"': 34 }[s[i]];
      out.push(escaped === undefined ? (s.charCodeAt(i) & 0xff) : escaped);
    }
    return out;
  }
  // Pascal/length-prefixed string: [i32 len LE][bytes]. Pointer is to the blob;
  // read the length from [ptr], bytes start at ptr+4. This is what (string ...)
  // and the deprecated (cstring ...) alias emit.
  function internPString(raw) {
    const text = unescapeStr(raw);
    const key = 'p:' + text;
    if (dataPool.map.has(key)) return dataPool.map.get(key);
    const utf8 = WATX_UTF8_ENCODER.encode(text);
    const offset = DATA_BASE + dataPool.bytes.length;
    dataPool.bytes.push(utf8.length & 0xff, (utf8.length >> 8) & 0xff,
                        (utf8.length >> 16) & 0xff, (utf8.length >> 24) & 0xff);
    dataPool.bytes.append(utf8);
    while (dataPool.bytes.length & 3) dataPool.bytes.byte(0); // 4-byte align next
    dataPool.map.set(key, offset);
    return offset;
  }
  // Real C string: [bytes][NUL]. Pointer is to the first byte. This is what a
  // bare "text" literal emits.
  function internCStr(raw) {
    const text = unescapeStr(raw);
    const key = 'c:' + text;
    if (dataPool.map.has(key)) return dataPool.map.get(key);
    const utf8 = WATX_UTF8_ENCODER.encode(text);
    const offset = DATA_BASE + dataPool.bytes.length;
    dataPool.bytes.append(utf8);
    dataPool.bytes.byte(0); // NUL-terminated
    while (dataPool.bytes.length & 3) dataPool.bytes.byte(0); // 4-byte align next
    dataPool.map.set(key, offset);
    return offset;
  }
  
  // A memory declaration is a name, limits and an optional `shared`. Anything
  // else inside the form used to be SKIPPED, and the skip was invisible because
  // the limits then fell back to their defaults: `(memory (data "…"))` — the
  // spec's inline-data spelling, which also implies the memory's size — matched
  // no branch here, contributed no number, and produced a **silently synthesized
  // 16-page memory with none of the author's bytes in it**. An inline
  // `(export "…")` clause disappeared the same way.
  //
  // So the loop is exhaustive now. Neither form is one we need — the tree writes
  // its data segments and its memory export separately — and both have a
  // one-line standard rewrite, which the error gives.
  function parseLimits(mem) {
    const nums = [];
    let shared = false;
    let name = null;
    const fail = (msg) => {
      const e = new Error(`memory declaration: ${msg}`);
      const loc = watxFormLoc(mem);
      if (loc !== undefined) { e.line = watxNodeLine(loc); e.col = watxNodeCol(loc); e.file = watxNodeFile(loc); }
      return e;
    };
    for (let i = 1; i < (mem.length - 1); i++) {
      const item = mem[i + 1];
      const v = V(item);
      if (Array.isArray(item)) {
        const kind = V(item[1]);
        if (kind === 'data') {
          throw fail(`an inline (data …) on a memory is not supported — it also implies the ` +
            `memory's size, and ignoring it silently produced a default-sized memory with ` +
            `none of its bytes. Write the limits on the memory and a separate ` +
            `(data (i32.const OFFSET) "…") segment`);
        }
        if (kind === 'export') {
          throw fail(`an inline (export …) on a memory is not supported — write a top-level ` +
            `(export "name" (memory 0))`);
        }
        throw fail(`unexpected (${kind ?? '…'} …) clause; a memory takes an optional $name, ` +
          `its limits, and an optional 'shared'`);
      }
      if (v?.startsWith('$') && name === null) name = v;
      else if (v === 'shared') shared = true;
      else if (T(item) === 'number') nums.push(watxParseIntLiteral(v, 'memory limits'));
      else throw fail(`unexpected token '${v}'; a memory takes an optional $name, its limits, ` +
        `and an optional 'shared'`);
    }
    return { name, min: nums[0] ?? 16, max: nums[1], shared };
  }

  // Collect imports. `wasm-import` is the WATX spelling; standard `import`
  // is intentionally accepted to make large existing WAT trees migratable.
  const importDecls = [];
  const globalImportDecls = [];
  const moduleImports = [];
  let memoryDecl = null;
  for (const form of forms) {
    if (Array.isArray(form) && (V(form[1]) === 'wasm-import' || V(form[1]) === 'import')) {
      const mod = (V(form[2]) || '').replace(/"/g, '');
      const name = (V(form[3]) || '').replace(/"/g, '');
      const sig = form[4];
      if (Array.isArray(sig) && V(sig[1]) === 'func') {
        const funcName = V(sig[2]) || `$${name}`;
        const params = [];
        const results = [];
        for (let i = 2; i < (sig.length - 1); i++) {
          const sigPart = sig[i + 1];
          if (Array.isArray(sigPart)) {
            const kind = V(sigPart[1]);
            if (kind === 'param') {
              for (let j = 1; j < (sigPart.length - 1); j++) {
                const t = V(sigPart[j + 1]);
                if (!t?.startsWith('$')) params.push(valtypeOf(t));
              }
            } else if (kind === 'result') {
              for (let j = 1; j < (sigPart.length - 1); j++) {
                const t = V(sigPart[j + 1]);
                results.push(valtypeOf(t));
              }
              watxRejectMultivalue(`imported function '${mod}.${name}'`,
                results.map(valtypeName), sigPart);
            }
          }
        }
        const imp = { kind: 'func', module: mod, name, funcName, params, results };
        importDecls.push(imp);
        moduleImports.push(imp);
      } else if (Array.isArray(sig) && V(sig[1]) === 'global') {
        // `(import "m" "g" (global $g i32))` / `(global $g (mut i32))`. An
        // imported global occupies the FRONT of the global index space exactly
        // as an imported function does in the function index space, so it is
        // collected here and `globalIndexMap` below offsets the defined globals
        // past these. Nothing in src/*.watx imports a global today, so that
        // offset is zero for the canonical build.
        let j = 2;
        const gname = V(sig[j])?.startsWith('$') ? V(sig[j++]) : `$${name}`;
        const typeForm = sig[j];
        const gmut = Array.isArray(typeForm) && V(typeForm[1]) === 'mut';
        const gtype = gmut ? V(typeForm[2]) : V(typeForm);
        if (!['i32', 'i64', 'f32', 'f64'].includes(gtype)) {
          throw new Error(`Unsupported imported global type '${gtype}' for ${mod}.${name}`);
        }
        const gimp = { kind: 'global', module: mod, name, globalName: gname, type: gtype, mutable: gmut };
        globalImportDecls.push(gimp);
        moduleImports.push(gimp);
      } else if (Array.isArray(sig) && V(sig[1]) === 'memory') {
        if (memoryDecl) throw new Error('Only one memory declaration/import is supported');
        memoryDecl = { kind: 'memory', imported: true, module: mod, importName: name, ...parseLimits(sig) };
        if (memoryDecl.shared && memoryDecl.max === undefined) {
          throw new Error('Shared memory import requires an explicit maximum');
        }
        moduleImports.push(memoryDecl);
      }
    }
  }
  const importDeclByName = new Map();
  for (const imp of importDecls) {
    if (!importDeclByName.has(imp.funcName)) importDeclByName.set(imp.funcName, imp);
  }

  // Defined memory, standard WAT spelling. Defaults stay unchanged when absent.
  for (const form of forms) {
    if (Array.isArray(form) && V(form[1]) === 'memory') {
      if (memoryDecl) throw new Error('Only one memory declaration/import is supported');
      memoryDecl = { kind: 'memory', imported: false, ...parseLimits(form) };
    }
  }
  if (!memoryDecl) memoryDecl = { kind: 'memory', imported: false, name: null, min: 16, max: 16384, shared: false };

  // Collect region declarations (the allocating heads that predate Milestone 6)
  const regionDecls = [];
  for (const form of forms) {
    if (Array.isArray(form)) {
      const h = V(form[1]);
      if (h === 'region.declare-static' || h === 'region.declare-bump' || h === 'region.declare-rc') {
        const rname = V(form[2]);
        const sizeForm = form[3];
        let size = 4096;
        if (Array.isArray(sizeForm) && V(sizeForm[1]) === 'size') {
          size = parseInt(V(sizeForm[2])) || 4096;
        } else if (T(sizeForm) === 'number') {
          size = parseInt(V(sizeForm)) || 4096;
        }
        regionDecls.push({ name: rname, kind: h.split('-').pop(), size });
      }
    }
  }

  // ── The region family ───────────────────────────────────────────────────────
  // docs/watx-region-safety-design.md. Four declaration heads share ONE record
  // type, ONE name→base map and ONE validation pass, because a memory map with
  // two grammars has two places to look when an address is wrong:
  //
  //   (region.declare-static $S (size 64))                     ; laid out from 1024
  //   (region.declare-fixed  $N (base 0x12000) (size 0x3C00000))
  //   (region.declare-derived $N (base (g2w 0x07400000)) (size 0x100000))
  //   (region.declare        $N (size 0x1800) (align 0x100) (owner "…"))
  //
  // plus the sequence forms `(region.floor N)`, `(region.gap N (reason "…"))`
  // and `(region.image-base N)`.
  //
  // `region.declare` ALLOCATES, which is the target state (§3): a fixed pin
  // needs one of exactly two reasons — a guest-visible ABI, or an alignment /
  // derivation law — and most of a real map has neither. The allocator is
  // declaration-order first-fit above a floor (§4.1), deterministic by
  // construction: the same source yields the same layout, so byte identity is a
  // usable correctness oracle for a conversion wave.
  //
  // This whole block runs BEFORE the data-segment scan on purpose: §4.4's
  // `(data (region.addr $R 0x40) "…")` cannot resolve its offset until the
  // regions exist, and an absolute data offset is the single largest anchor
  // holding the map in place.
  const STATIC_REGION_BASE = 1024;
  const regionBase = new Map();
  let staticCursor = STATIC_REGION_BASE;
  const regions = new Map();
  let regionConstValue = null;   // shared by compileExpr and the data scan
  let regionLayoutReport = null; // surfaced on the compile result for the banner
  {
    const memoryBytes = memoryDecl.min * 65536;
    const located = (form, message) => {
      const e = new Error(message);
      const loc = watxFormLoc(form);
      if (loc !== undefined) {
        e.line = watxNodeLine(loc); e.col = watxNodeCol(loc); e.file = watxNodeFile(loc);
      }
      return e;
    };
    const at = (r) => r.file ? `${r.file}:${r.line}` : `line ${r.line}`;
    const hx = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
    const alignUp = (n, a) => ((n + a - 1) / a | 0) * a;
    const HEADS = new Map([
      ['region.declare-fixed', 'fixed'],
      ['region.declare-derived', 'derived'],
      ['region.declare-span', 'span'],
      ['region.declare', 'alloc'],
    ]);
    const REGION_CLAUSES = new Set(['base', 'size', 'end', 'align', 'owner', 'within',
      'stride', 'mask', 'size-is-power-of-2']);
    // §5.1: a SPAN is an address-range LIMIT, not storage. `$g2w`'s direct
    // guest window is the motivating case — its upper bound is the bare literal
    // `0x8000000` in three places, which is a union of regions with no name.
    // A span differs from every other head in exactly one way, and it is the
    // whole point: it is TRANSPARENT to the overlap check, because the regions
    // it bounds live inside it. Everything else follows from that — it is never
    // allocated (there is nothing to place), never shaken (a limit that moves
    // under a shake is testing the wrong thing), and carries no alignment,
    // nesting or (stride)/(mask) law, because it owns no bytes for one to hold.
    // What it DOES get is the fixed head's symbol resolution: `$DIRECT_WINDOW`,
    // `(region.end $DIRECT_WINDOW)` and `(region.addr $DIRECT_WINDOW 0x…)` all
    // work, which is what lets the literal be deleted.
    const SPAN_CLAUSES = new Set(['base', 'size', 'end', 'owner']);

    // The constant globals, read straight off the top-level forms. The laws in
    // §4.2 tie a region's extent to globals the code already reads
    // (`$CACHE_MASK`, `$DLL_TABLE_CAPACITY`), and those fourteen derived values
    // are exactly the ones nothing asserts today. Scanned here rather than taken
    // from the later `globalDecls` pass so the region block stays movable.
    const constGlobals = new Map();
    for (const form of forms) {
      if (!Array.isArray(form) || V(form[1]) !== 'global') continue;
      const gname = V(form[2]);
      const init = form[form.length - 1];
      if (!gname || !gname.startsWith('$')) continue;
      if (!Array.isArray(init) || V(init[1]) !== 'i32.const') continue;
      let value;
      try { value = watxParseIntLiteral(V(init[2]), 'global initializer'); } catch (err) { continue; }
      if (Number.isInteger(value) && !constGlobals.has(gname)) constGlobals.set(gname, value);
    }

    // ── Pass 1: read the declaration sequence in source order ─────────────────
    // Order is the allocator's only input besides the sizes, so it is the
    // module's top-level form order — the same order src/main.watx fixes — and
    // never the name or the size, both of which move under an unrelated edit.
    const sequence = [];
    let floor = null, floorForm = null;
    let imageBase = null, imageBaseForm = null;
    const DEFAULT_IMAGE_BASE = 0x400000;

    const litOperand = (form, part, label) => {
      const raw = V(part);
      let value;
      try {
        value = watxParseIntLiteral(raw, label);
      } catch (err) {
        throw located(form, `${label}: (${raw}) is not an integer literal`);
      }
      if (!Number.isInteger(value) || value < 0) {
        throw located(form, `${label}: ${raw} must be a non-negative integer`);
      }
      return value;
    };
    // A stride/count operand is either a literal or the NAME of an i32 constant
    // global — which is the point: `(stride 32 (count $DLL_TABLE_CAPACITY))`
    // makes the capacity global and the region's extent one statement instead of
    // two numbers that agree by luck.
    const amount = (form, part, label) => {
      const raw = V(part);
      if (typeof raw === 'string' && raw.startsWith('$')) {
        if (!constGlobals.has(raw)) {
          throw located(form, `${label}: ${raw} names no (global ${raw} i32 (i32.const N)) in this module`);
        }
        return constGlobals.get(raw);
      }
      return litOperand(form, part, label);
    };

    for (const form of forms) {
      if (!Array.isArray(form)) continue;
      const head = V(form[1]);

      if (head === 'region.floor') {
        if (floor !== null) throw located(form, `(region.floor ...) is already declared at ${at(floorForm)}`);
        if (form.length !== 3) throw located(form, `(region.floor N) takes exactly one operand`);
        floor = litOperand(form, form[2], 'region.floor');
        const loc = watxFormLoc(form);
        floorForm = { line: loc !== undefined ? watxNodeLine(loc) : 0, file: loc !== undefined ? watxNodeFile(loc) : null };
        continue;
      }
      if (head === 'region.image-base') {
        if (imageBase !== null) throw located(form, `(region.image-base ...) is already declared at ${at(imageBaseForm)}`);
        if (form.length !== 3) throw located(form, `(region.image-base N) takes exactly one operand`);
        imageBase = litOperand(form, form[2], 'region.image-base');
        const loc = watxFormLoc(form);
        imageBaseForm = { line: loc !== undefined ? watxNodeLine(loc) : 0, file: loc !== undefined ? watxNodeFile(loc) : null };
        continue;
      }
      if (head === 'region.gap') {
        // A hole in the map is either documented or it is a mystery the next
        // reader preserves out of fear. `(reason "…")` is mandatory for exactly
        // that: "unknown, preserved" is an honest marker, a silent gap is not.
        if (form.length !== 4) {
          throw located(form, `(region.gap N ...) needs a size and a (reason "text") clause`);
        }
        const size = litOperand(form, form[2], 'region.gap');
        const reasonForm = form[3];
        if (!Array.isArray(reasonForm) || V(reasonForm[1]) !== 'reason' || reasonForm.length !== 3) {
          throw located(form, `(region.gap ${hx(size)} ...) needs a (reason "text") clause; ` +
            `an undocumented hole is the mystery this feature exists to delete`);
        }
        if (size === 0) throw located(form, `(region.gap 0 ...) advances nothing`);
        sequence.push({ kind: 'gap', size, form, reason: V(reasonForm[2]) });
        continue;
      }

      const kind = HEADS.get(head);
      if (!kind) continue;

      const name = V(form[2]);
      if (!name || !name.startsWith('$')) {
        throw located(form, `${head}: expected a $-prefixed region name as the first operand`);
      }
      const prev = regions.get(name);
      if (prev) throw located(form, `${head} ${name} is already declared at ${at(prev)}`);

      const clause = new Map();
      for (let i = 3; i < form.length; i++) {
        const part = form[i];
        if (!Array.isArray(part)) {
          throw located(form, `${head} ${name}: unexpected bare operand '${V(part)}'; ` +
            `clauses are (base N) (size N) (end N) (align N) (owner "text") (within $R) ` +
            `(stride N (count N)) (mask $G) (size-is-power-of-2)`);
        }
        const key = V(part[1]);
        // Checked ahead of REGION_CLAUSES so a span's diagnostic lists a span's
        // clauses: telling somebody that `align` and `stride` were expected,
        // when the head accepts neither, is a worse error than no error.
        if (kind === 'span' && !SPAN_CLAUSES.has(key)) {
          throw located(form, `${head} ${name}: (${key} ...) is not a span clause; ` +
            `a span is a named address LIMIT, not storage, so it takes only ` +
            `(base N), one of (size N)/(end N), and (owner "text") — it owns no ` +
            `bytes for an alignment, a nesting or a (stride)/(mask) law to hold`);
        }
        if (!REGION_CLAUSES.has(key)) {
          throw located(form, `${head} ${name}: unknown clause (${key} ...); ` +
            `expected base, size, end, align, owner, within, stride, mask, size-is-power-of-2`);
        }
        if (clause.has(key)) {
          throw located(form, `${head} ${name}: duplicate (${key} ...) clause`);
        }
        if (key === 'size-is-power-of-2') {
          if (part.length !== 2) throw located(form, `${head} ${name}: (size-is-power-of-2) takes no operand`);
        } else if (key === 'stride') {
          if (part.length !== 4 || !Array.isArray(part[3]) || V(part[3][1]) !== 'count' || part[3].length !== 3) {
            throw located(form, `${head} ${name}: (stride ...) is spelled (stride N (count N)); ` +
              `either operand may be a $-named i32 constant global`);
          }
        } else if (part.length !== 3) {
          throw located(form, `${head} ${name}: (${key} ...) takes exactly one operand`);
        }
        clause.set(key, part);
      }
      const intClause = (key) => {
        const part = clause.get(key);
        const raw = V(part[2]);
        let value;
        try {
          value = watxParseIntLiteral(raw, `${head} ${name} (${key} ...)`);
        } catch (err) {
          throw located(form, `${head} ${name}: (${key} ${raw}) is not an integer literal`);
        }
        if (!Number.isInteger(value) || value < 0) {
          throw located(form, `${head} ${name}: (${key} ${raw}) must be a non-negative integer`);
        }
        return value;
      };

      // Extent. `end` is exclusive, and exactly one of the two is required —
      // "no extent" and "two extents" are both a map that does not say where a
      // region stops.
      if (clause.has('size') === clause.has('end')) {
        throw located(form, `${head} ${name} needs exactly one of (size N) or (end N)`);
      }
      let base = null, guestVa = null, size;

      if (kind === 'fixed' || kind === 'span') {
        if (!clause.has('base')) throw located(form, `${head} ${name} needs a (base N) clause`);
        base = intClause('base');
      } else if (kind === 'derived') {
        if (!clause.has('base')) throw located(form, `${head} ${name} needs a (base (g2w VA)) clause`);
        const spec = clause.get('base')[2];
        if (!Array.isArray(spec) || V(spec[1]) !== 'g2w' || spec.length !== 3) {
          throw located(form, `${head} ${name}: a derived base is spelled (base (g2w 0xVA)) — ` +
            `the GUEST address is the ABI and the wasm offset follows it; ` +
            `use region.declare-fixed for a literal wasm base`);
        }
        guestVa = litOperand(form, spec[2], `${head} ${name} (g2w ...)`);
      } else if (clause.has('base')) {
        throw located(form, `${head} ${name}: (base ...) is only for region.declare-fixed; ` +
          `an allocated region's base is the compiler's to choose`);
      }

      if (clause.has('size')) {
        size = intClause('size');
      } else {
        if (kind !== 'fixed' && kind !== 'span') {
          throw located(form, `${head} ${name}: (end N) states an absolute address, ` +
            `which an allocated region does not have; use (size N)`);
        }
        const end = intClause('end');
        if (end <= base) {
          throw located(form, `${head} ${name}: (end ${hx(end)}) is not above (base ${hx(base)})`);
        }
        size = end - base;
      }
      if (size === 0) {
        throw located(form, `${head} ${name}: (size 0) — a region must have an extent`);
      }
      // A span is transparent to the overlap check, so nothing else in the
      // module can catch one that was declared by accident or left behind after
      // the limit it named was deleted. `(owner "…")` is therefore mandatory
      // here for the same reason `(reason "…")` is mandatory on `region.gap`: an
      // undocumented transparent range IS the unnamed constant this head exists
      // to replace, only now it has a name and still explains nothing.
      if (kind === 'span' && !clause.has('owner')) {
        throw located(form, `${head} ${name} needs an (owner "text") clause naming the ` +
          `limit it stands for; a transparent range that documents nothing is the ` +
          `unnamed constant this head exists to delete`);
      }
      // Spans carry no alignment: the address they name is a boundary somebody
      // else's arithmetic tests against, not the start of an object, so there is
      // nothing for an alignment to be a property OF. `align 1` keeps them out
      // of checkPlaced's modulo without giving them a rule that reads as real.
      const align = kind === 'span' ? 1
        : clause.has('align') ? intClause('align') : 4;
      if (align < 1 || (align & (align - 1)) !== 0) {
        throw located(form, `${head} ${name}: (align ${align}) is not a power of two`);
      }
      const loc = watxFormLoc(form);
      const record = {
        name, head, kind, base, guestVa, size, align, form, clause,
        within: clause.has('within') ? V(clause.get('within')[2]) : null,
        owner: clause.has('owner') ? V(clause.get('owner')[2]) : null,
        line: loc !== undefined ? watxNodeLine(loc) : 0,
        file: loc !== undefined ? watxNodeFile(loc) : null,
      };
      regions.set(name, record);
      if (kind === 'alloc') sequence.push({ kind: 'region', region: record, form });
    }

    const imageBaseValue = imageBase === null ? DEFAULT_IMAGE_BASE : imageBase;

    // ── Pass 2: place the pins, then derive from them ─────────────────────────
    const checkPlaced = (r) => {
      if (r.base % r.align !== 0) {
        throw located(r.form, `${r.head} ${r.name} base ${hx(r.base)} is not a multiple of its (align ${hx(r.align)})`);
      }
      // Bound against the memory GUARANTEED to exist at instantiation, not the
      // maximum: a region that only exists after a memory.grow the compiler
      // cannot see is not a fixed region, and the family should refuse it rather
      // than bless it.
      if (r.base + r.size > memoryBytes) {
        throw located(r.form, `${r.head} ${r.name} ends at ${hx(r.base + r.size)}, past the ` +
          `${hx(memoryBytes)} bytes of initial memory (${memoryDecl.min} pages)`);
      }
    };
    // Spans are bound-checked like a pin: a limit that names an address past the
    // memory that exists at instantiation is a bug wherever it is tested, and
    // the transparency only excuses it from OVERLAP, never from the map's edge.
    for (const r of regions.values()) {
      if (r.kind === 'fixed' || r.kind === 'span') checkPlaced(r);
    }
    for (const r of regions.values()) {
      if (r.kind !== 'derived') continue;
      const gb = regions.get('$GUEST_BASE');
      if (!gb) {
        throw located(r.form, `${r.head} ${r.name}: (g2w ${hx(r.guestVa)}) needs a declared $GUEST_BASE region`);
      }
      if (gb.kind === 'alloc') {
        throw located(r.form, `${r.head} ${r.name}: (g2w ${hx(r.guestVa)}) needs a PINNED $GUEST_BASE; ` +
          `$GUEST_BASE is allocated, so the guest ABI would move with the layout`);
      }
      if (gb.kind === 'derived') {
        throw located(r.form, `${r.head} ${r.name}: (g2w ...) cannot be resolved through a derived $GUEST_BASE`);
      }
      const wasmBase = gb.base + (r.guestVa - imageBaseValue);
      if (wasmBase < 0) {
        throw located(r.form, `${r.head} ${r.name}: (g2w ${hx(r.guestVa)}) is below the image base ` +
          `${hx(imageBaseValue)}, so it translates to the negative wasm offset ${wasmBase}`);
      }
      r.base = wasmBase;
      checkPlaced(r);
    }

    // ── Pass 3: allocate ──────────────────────────────────────────────────────
    // Declaration-order first-fit above a floor, never backfilling into an
    // earlier gap: backfilling would make the layout depend on the size history
    // of every earlier region, and a layout that reshuffles under an unrelated
    // capacity bump is not reproducible in any sense that helps.
    const shake = normalizeRegionShake(options.regionShake);
    let placedSequence = sequence;
    let shakenCount = 0;
    if (shake && sequence.some(item => item.kind === 'region')) {
      placedSequence = shakeRegionSequence(sequence, shake);
      shakenCount = sequence.filter(item => item.kind === 'region').length;
    }
    // Obstacles the cursor must skip. Spans are NOT obstacles — the direct guest
    // window contains $GUEST_BASE, the stack, the thunks and PE staging, so
    // treating it as occupied would push every allocated region above it and
    // invert the map. That is the transparency, stated as code.
    const pins = [...regions.values()]
      .filter(r => r.kind !== 'alloc' && r.kind !== 'span')
      .sort((a, b) => a.base - b.base);
    let shakeScaledDown = 0;
    if (shake) {
      // ── The SHAKEN placement (see placeShakenAroundPins) ────────────────────
      // A shake has to survive the map it is shaking. The canonical branch below
      // carries one monotonic cursor and never backfills, which is right for a
      // reproducible canonical layout and fatal under a shake: the pins cut the
      // usable space into four windows, the smallest is 0x100..0x12000 (73KB
      // holding 54 tiny regions with nothing spare), and `gap` asks to put over
      // a megabyte of prime gaps into it. The cursor overflowed into $GUEST_BASE,
      // jumped past it, and ABANDONED every free byte of every earlier window;
      // the cascade repeated until 32MB $THREAD_CACHE_BASE had only a 14.68MB
      // window left and the compile died on $DIB_BACKING_BASE. Capacity was never
      // the problem — 5.43MB of tail slack against 3.55MB of inflation — the
      // single cursor was.
      shakeScaledDown = placeShakenAroundPins(placedSequence, pins,
        floor === null ? 0 : floor, memoryBytes, located, hx, alignUp);
    } else {
      let cursor = floor === null ? 0 : floor;
      let lastPlaced = null;
      for (const item of placedSequence) {
        if (item.kind === 'gap') { cursor += item.size; continue; }
        const r = item.region;
        const extent = item.extent || r.size;   // `pad` shake spaces without resizing
        let candidate = alignUp(cursor, r.align);
        for (;;) {
          const hit = pins.find(p => candidate < p.base + p.size && p.base < candidate + extent);
          if (!hit) break;
          const next = alignUp(hit.base + hit.size, r.align);
          if (next + extent > memoryBytes) {
            throw located(r.form, `${r.name} cannot be allocated at ${hx(candidate)}: ` +
              `pinned ${hit.name} occupies it, and nothing fits after it inside the ` +
              `${hx(memoryBytes)} bytes of memory`);
          }
          candidate = next;
        }
        if (candidate + extent > memoryBytes) {
          throw located(r.form, `allocating ${r.name} (${hx(candidate + extent)}) past the ` +
            `${hx(memoryBytes)} bytes of memory; the last placed region was ` +
            `${lastPlaced ? lastPlaced.name : '(none — the floor is already past it)'}`);
        }
        r.base = candidate;
        cursor = candidate + extent;
        lastPlaced = r;
      }
    }

    // ── Pass 4: set-level validation over the FINAL bases ─────────────────────
    for (const r of regions.values()) {
      if (!r.within) continue;
      const outer = regions.get(r.within);
      if (!outer) {
        throw located(r.form, `${r.head} ${r.name}: (within ${r.within}) names no declared region`);
      }
      if (outer === r) {
        throw located(r.form, `${r.head} ${r.name}: (within ${r.within}) names itself`);
      }
      if (r.base < outer.base || r.base + r.size > outer.base + outer.size) {
        throw located(r.form, `${r.head} ${r.name} [${hx(r.base)},${hx(r.base + r.size)}) ` +
          `is not contained in ${outer.name} [${hx(outer.base)},${hx(outer.base + outer.size)})`);
      }
    }
    // Overlap-freedom. Sort by base and compare each region with the ones still
    // open at its start; an interval list is small enough that the obvious
    // O(n log n) sweep is the whole algorithm.
    //
    // Spans do not take part, in EITHER direction: a span's whole job is to name
    // a range other regions live inside, so it can neither overlap them nor be
    // overlapped by them. Two spans may also nest (a window inside a window), so
    // dropping them from the sweep entirely is the honest rule rather than a
    // special case bolted onto `nested()`.
    const ordered = [...regions.values()]
      .filter(r => r.kind !== 'span')
      .sort((a, b) => (a.base - b.base) || (a.size - b.size));
    const nested = (a, b) => a.within === b.name || b.within === a.name;
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i], b = ordered[j];
        if (b.base >= a.base + a.size) break; // sorted: nothing later can overlap a
        if (nested(a, b)) continue;
        throw located(b.form, `${b.head} ${b.name} [${hx(b.base)},${hx(b.base + b.size)}) ` +
          `overlaps ${a.name} [${hx(a.base)},${hx(a.base + a.size)}) (declared at ${at(a)}); ` +
          `use (within ${a.name}) if the nesting is deliberate`);
      }
    }

    // ── Pass 5: the laws (§4.2) ───────────────────────────────────────────────
    // A law is enforced and emits nothing. The mask and the capacity stay
    // ordinary globals; what changes is that they can no longer drift from the
    // extent they were derived from, which is the fourteen-global debt §5.2
    // measured.
    for (const r of regions.values()) {
      if (r.clause.has('size-is-power-of-2') && (r.size & (r.size - 1)) !== 0) {
        throw located(r.form, `${r.head} ${r.name} declares (size-is-power-of-2) but its size is ${hx(r.size)}`);
      }
      if (r.clause.has('stride')) {
        const part = r.clause.get('stride');
        const stride = amount(r.form, part[2], `${r.head} ${r.name} (stride ...)`);
        const count = amount(r.form, part[3][2], `${r.head} ${r.name} (count ...)`);
        if (stride < 1 || count < 1) {
          throw located(r.form, `${r.head} ${r.name}: (stride ${hx(stride)}) x (count ${count}) must both be positive`);
        }
        if (stride * count !== r.size) {
          throw located(r.form, `${r.head} ${r.name} (size ${hx(r.size)}) is not ` +
            `(stride ${hx(stride)}) x (count ${count})`);
        }
        r.stride = stride; r.count = count;
      }
      if (r.clause.has('mask')) {
        const gname = V(r.clause.get('mask')[2]);
        if (typeof gname !== 'string' || !gname.startsWith('$')) {
          throw located(r.form, `${r.head} ${r.name}: (mask ...) names an i32 constant global, e.g. (mask $CACHE_MASK)`);
        }
        if (!constGlobals.has(gname)) {
          throw located(r.form, `${r.head} ${r.name}: (mask ${gname}) names no ` +
            `(global ${gname} i32 (i32.const N)) in this module`);
        }
        const slots = r.clause.has('stride') ? r.count : r.size;
        if ((slots & (slots - 1)) !== 0) {
          throw located(r.form, `${r.head} ${r.name}: (mask ${gname}) is only well formed over a ` +
            `power-of-two ${r.clause.has('stride') ? 'count' : 'size'}, and ${slots} is not one`);
        }
        const value = constGlobals.get(gname);
        if (value !== slots - 1) {
          throw located(r.form, `${r.head} ${r.name}: (mask ${gname}) is ${hx(value)}, not ` +
            `${hx(slots - 1)} — a mask is one below the ` +
            `${r.clause.has('stride') ? `(count ${r.count})` : `size ${hx(r.size)}`} it comes from`);
        }
      }
    }

    // Static/bump/rc regions keep their own cursor from 1024 up; declare-fixed,
    // -derived and declare contribute nothing to it, so the interned-string pool
    // and the bump heap do not move when a map is declared.
    for (const rd of regionDecls) {
      if (rd.kind === 'static') {
        regionBase.set(rd.name, staticCursor);
        staticCursor += (rd.size + 15) & ~15; // 16-byte align (safe for f64/v128)
      }
    }
    // Every region joins the SAME name→base map, which is the whole point of
    // making these heads in the existing family: `$NAME` in operand position
    // resolves to `i32.const <base>` through compileExpr's existing symbol
    // handler, with no new resolution path to keep in step.
    for (const r of regions.values()) {
      if (regionBase.has(r.name)) {
        throw located(r.form, `Region ${r.name} is declared both fixed and allocated; a region has one base`);
      }
      regionBase.set(r.name, r.base);
    }

    regionLayoutReport = {
      shake: shake ? shake.label : null,
      shaken: shakenCount,
      // How many shaken regions had to give up their gap or their padding to
      // fit. Zero on the canonical build, which does not shake at all.
      shakeScaledDown,
      allocated: sequence.filter(item => item.kind === 'region').length,
      floor: floor === null ? 0 : floor,
      imageBase: imageBaseValue,
      regions: [...regions.values()]
        .sort((a, b) => a.base - b.base)
        .map(r => ({ name: r.name, kind: r.kind, base: r.base, size: r.size, align: r.align, owner: r.owner })),
    };

    // ── region.addr / region.size / region.end, in ONE place ──────────────────
    // Used both by compileExpr (where it emits an i32.const) and by the data
    // scan (where the same constant becomes a segment offset), so a bounds rule
    // cannot hold in an instruction and not in a data segment.
    regionConstValue = (expr, extraSpan, context) => {
      const head = V(expr[1]);
      const loc8 = (message) => located(expr, context ? `${context}: ${message}` : message);
      const rname = V(expr[2]);
      const region = rname ? regions.get(rname) : null;
      if (!region) {
        const known = [...regions.keys()];
        throw loc8(`${head}: unknown region ${rname || '<missing>'}; declared regions are ` +
          (known.length ? known.join(', ') : '(none)'));
      }
      if (head === 'region.size') {
        if (expr.length !== 3) throw loc8(`region.size ${rname} takes no operand besides the region`);
        return region.size;
      }
      if (head === 'region.end') {
        if (expr.length !== 3) throw loc8(`region.end ${rname} takes no operand besides the region`);
        return region.base + region.size;
      }
      // `region.addr` names a byte INSIDE a region, and a span has no inside of
      // its own: the bytes between its base and its end belong to the regions it
      // covers, which have their own names, their own extents and — unlike the
      // span — their own overlap check. So an address computed off a span is an
      // address in a range nothing polices, which is the one thing transparency
      // must not be allowed to buy.
      //
      // Rejected for ANY offset, zero included, rather than only for a nonzero
      // one. `(region.addr $S 0)` and a bare `$S` are the same number, so
      // permitting the zero case buys no expressiveness at all and costs a rule
      // with a boundary — and a boundary at zero is exactly the sort that gets
      // widened by one reasonable-sounding exception later. The three spellings
      // a limit actually needs are all still here: `$S` is the lower bound,
      // `(region.end $S)` the upper, `(region.size $S)` the width for a
      // `lt_u (sub x base) size` range test. src/03-registers.wat uses only the
      // second.
      if (region.kind === 'span') {
        throw loc8(`region.addr ${rname}: ${rname} is a span — a named address LIMIT, not ` +
          `storage — so it has no interior to address; the bytes inside it belong to the ` +
          `regions it covers. Use ${rname} for its lower bound, (region.end ${rname}) for ` +
          `its upper bound, or (region.size ${rname}) for its width; if these bytes are ` +
          `really yours, declare a region for them so the overlap check can see it`);
      }
      if (expr.length < 4) throw loc8(`region.addr ${rname}: expected a constant offset operand`);
      const rawOffset = V(expr[3]);
      let offset;
      try {
        offset = watxParseIntLiteral(rawOffset, `region.addr ${rname} offset`);
      } catch (err) { offset = NaN; }
      if (!Number.isInteger(offset) || offset < 0 || Array.isArray(expr[3])) {
        throw loc8(`region.addr ${rname}: offset must be a non-negative integer literal ` +
          `(got '${Array.isArray(expr[3]) ? '<expression>' : rawOffset}')`);
      }
      // With no (span N) the form still addresses a byte, so the last valid
      // offset is size-1: an address AT the region end is one-past-the-end,
      // which is exactly the off-by-one this feature exists to catch.
      let span = 1, spanned = false;
      if (expr.length > 4) {
        const spanForm = expr[4];
        if (!Array.isArray(spanForm) || V(spanForm[1]) !== 'span' || spanForm.length !== 3) {
          throw loc8(`region.addr ${rname}: the only extra clause is (span N)`);
        }
        span = watxParseIntLiteral(V(spanForm[2]), `region.addr ${rname} span`);
        if (!Number.isInteger(span) || span < 1) {
          throw loc8(`region.addr ${rname}: (span ${V(spanForm[2])}) must be a positive integer`);
        }
        spanned = true;
        if (expr.length > 5) throw loc8(`region.addr ${rname}: too many operands`);
      }
      // A data segment's LENGTH is a span nobody writes down; check it, or
      // converting a segment to region-relative form silently loses the only
      // bound that mattered.
      if (extraSpan !== undefined && extraSpan !== null) { span = Math.max(span, extraSpan); spanned = true; }
      if (offset + span > region.size) {
        throw loc8(`region.addr ${rname} offset 0x${offset.toString(16)}` +
          (spanned ? ` span 0x${span.toString(16)}` : '') +
          ` runs past the region's 0x${region.size.toString(16)} bytes`);
      }
      return region.base + offset;
    };
  }

  const fixedDataSegments = [];
  for (const form of forms) {
    if (!Array.isArray(form) || V(form[1]) !== 'data') continue;
    let i = 1;
    if (V(form[i + 1])?.startsWith('$')) i++; // optional segment id
    if (Array.isArray(form[i + 1]) && V(form[i + 1][1]) === 'memory') i++; // explicit memory selector
    const offsetForm = form[(i++) + 1];
    const offsetHead = Array.isArray(offsetForm) ? V(offsetForm[1]) : null;
    // A data offset carries a location so the diagnostic names the segment.
    const dataErr = (message) => {
      const e = new Error(message);
      const loc = watxFormLoc(offsetForm) ?? watxFormLoc(form);
      if (loc !== undefined) {
        e.line = watxNodeLine(loc); e.col = watxNodeCol(loc); e.file = watxNodeFile(loc);
      }
      return e;
    };
    // §4.4 admits exactly ONE region-relative spelling, and the restriction is
    // load-bearing rather than tidy: failure mode 20 checks a segment's own
    // payload LENGTH against the region's extent, and only `region.addr` has an
    // offset for that check to be about. `(region.end $R)` is by definition
    // one past the last byte — a segment starting there is out of bounds no
    // matter how long it is — and `(region.size $R)` is an extent, not an
    // address at all; it only ever named a plausible offset by the accident of
    // a region based at zero. Both previously reached the emitter with the
    // bounds check silently skipped, which is the exact hole this feature
    // exists to close.
    const regionRelative = offsetHead === 'region.addr';
    if (offsetHead === 'region.end' || offsetHead === 'region.size') {
      throw dataErr(`active data offset (${offsetHead} ...) is not an addressable ` +
        `location: ${offsetHead === 'region.end'
          ? 'a region\'s end is one past its last byte, so a segment there is out of bounds by construction'
          : 'a region\'s size is an extent, not an address'}. ` +
        `Write (data (region.addr $R OFF) …), which is the only form whose ` +
        `payload length is checked against the region`);
    }
    if (!regionRelative && (!Array.isArray(offsetForm) || offsetHead !== 'i32.const')) {
      throw dataErr('Active data requires an i32.const offset or a (region.addr $R OFF) offset');
    }
    // A segment anchored to a SPAN is the sharpest form of the span-as-storage
    // mistake, so it gets its own diagnostic rather than inheriting the generic
    // "a span has no interior" one from regionConstValue below. Bytes in a
    // module are the least ambiguous evidence that somebody meant storage, and
    // a span is the one declaration head whose extent no overlap check covers —
    // so this segment would sit in a range that another region can be declared
    // straight on top of, silently, forever.
    if (regionRelative) {
      const anchor = regions.get(V(offsetForm[2]));
      if (anchor && anchor.kind === 'span') {
        throw dataErr(`(data (region.addr ${anchor.name} …) …): ${anchor.name} is a span — a ` +
          `named address LIMIT, not storage — and nothing checks a span for overlap, so these ` +
          `bytes would sit in a range any region may later be declared on top of. Declare a ` +
          `region for them (it may live (within ${anchor.name})'s extent) and anchor the ` +
          `segment to that`);
      }
    }
    const bytes = [];
    for (; i < (form.length - 1); i++) {
      const fragment=form[i + 1];
      if (T(fragment) !== 'string') throw new Error('Data payload must contain string fragments');
      appendArray(bytes, decodeWatStringBytes(V(fragment), (m) => dataErr(`data string: ${m}`)));
    }
    // §4.4: a region-relative segment. The offset is checked against the
    // region's extent INCLUDING the segment's own length — the bound that an
    // absolute `(data (i32.const 0x11300) …)` never had, and the reason 171 of
    // the tree's 221 segments are currently nails holding the map in place. It
    // emits the identical i32.const the absolute form emits.
    let offset;
    if (regionRelative) {
      offset = regionConstValue(offsetForm, bytes.length, `data segment (${bytes.length} bytes)`);
    } else {
      offset = watxParseIntLiteral(
        watxConstFormToken(offsetForm, 'active data segment offset'), 'active data segment offset');
      if (!Number.isInteger(offset) || offset < 0) throw new Error('Data offset must be a non-negative integer');
    }
    fixedDataSegments.push({ offset, bytes });
  }
  
  // Function declarations are indexed once by the checker and shared with
  // emission. Keep the fallback for callers that invoke generateWasm directly.
  const indexedFuncDecls = checkResult?.functionDecls;
  const funcDecls = indexedFuncDecls || [];
  const funcNameSet = new Set();
  const inlineExportDecls = checkResult?.inlineExportDecls ? checkResult.inlineExportDecls.slice() : [];
  let anonymousFuncId = 0;
  if (!indexedFuncDecls) {
    for (let formIndex = 0; formIndex < forms.length; formIndex++) {
      const form = forms[formIndex];
      if (Array.isArray(form) && V(form[1]) === 'func') {
      let cursor = 1;
      const explicitName = V(form[cursor + 1])?.startsWith('$') ? V(form[(cursor++) + 1]) : null;
      const name = explicitName || `$__anonymous_${anonymousFuncId++}`;
      const params = [];
      const results = [];
      const locals = [];
      const body = [];
      let effectsClause = null;
      
      for (let i = cursor; i < (form.length - 1); i++) {
        const part=form[i + 1];
        if (Array.isArray(part)) {
          const kind = V(part[1]);
          if (kind === 'param') {
            let pendingName = null;
            for (let j = 1; j < (part.length - 1); j++) {
              const v = V(part[j + 1]);
              if (v?.startsWith('$')) pendingName = v;
              else if (v) { params.push({ name: pendingName, type: v }); pendingName = null; }
            }
          } else if (kind === 'result') {
            for (let j = 1; j < (part.length - 1); j++) {
              results.push(V(part[j + 1]) || 'i32');
            }
          } else if (kind === 'effects') {
            effectsClause = part;
          } else if (kind === 'export') {
            inlineExportDecls.push({ exportName: (V(part[2]) || '').replace(/"/g, ''), kind: 'func', ref: name, formIndex });
          } else {
            body.push(part);
          }
        } else {
          body.push(part);
        }
      }
      
      if (options.strictDeclarations && funcNameSet.has(name)) throw new Error(`Duplicate function '${name}'`);
      funcNameSet.add(name);
        funcDecls.push({ name, params, results, locals, body, effectsClause });
      }
    }
  } else {
    for (const fd of funcDecls) {
      if (options.strictDeclarations && funcNameSet.has(fd.name)) throw new Error(`Duplicate function '${fd.name}'`);
      funcNameSet.add(fd.name);
    }
  }
  const funcDeclByName = new Map();
  for (const fd of funcDecls) {
    // Checked HERE rather than beside either `(result …)` parse, because there
    // are two of them — the inline one above and the streaming one in
    // compiler-stages.js — and a rule enforced in one parser and not the other
    // is a rule that holds only for whichever path the caller happened to take.
    watxRejectMultivalue(`function ${fd.name}`, fd.results, fd.form || fd.body);
    if (!funcDeclByName.has(fd.name)) funcDeclByName.set(fd.name, fd);
  }
  
  // Collect exports.
  //
  // The emitted export section must follow SOURCE DECLARATION order across
  // kinds, not group by kind: standard WAT (and lib/compile-wat.js, the legacy
  // compiler this output is differentially compared against) emits one entry
  // per export in the order it was written, so a `(export "memory" (memory 0))`
  // declared before every function lands at index 0. Inline `(func $f (export
  // "f") ...)` clauses and top-level `(export ...)` / `(wasm-export ...)` forms
  // are therefore interleaved by the index of the top-level form that carried
  // them, and a stable sort keeps several exports on one form in written order.
  const exportDecls = inlineExportDecls.slice();
  for (let formIndex = 0; formIndex < forms.length; formIndex++) {
    const form = forms[formIndex];
    if (Array.isArray(form) && V(form[1]) === 'wasm-export') {
      const exportName = (V(form[2]) || '').replace(/"/g, '');
      const funcRef = V(form[3]) || '';
      exportDecls.push({ exportName, kind: 'func', ref: funcRef, formIndex });
    } else if (Array.isArray(form) && V(form[1]) === 'export') {
      const exportName = (V(form[2]) || '').replace(/"/g, '');
      const desc = form[3];
      if (!Array.isArray(desc) || !['func','memory','table','global'].includes(V(desc[1]))) {
        throw new Error(`Invalid export '${exportName}'`);
      }
      exportDecls.push({ exportName, kind: V(desc[1]), ref: V(desc[2]) ?? '0', formIndex });
    }
  }
  // Array.prototype.sort is stable (ES2019+), so equal keys keep insertion
  // order. An entry with no recorded position (a caller that built the list by
  // hand) sorts ahead of everything, preserving the historical arrangement.
  exportDecls.sort((a, b) => (a.formIndex ?? -1) - (b.formIndex ?? -1));

  // Explicit globals. The optional WATX region runtime globals are prepended
  // only in legacy mode, keeping exact declaration indices available to WAT.
  const globalDecls = [];
  const globalNameSet = new Set();
  if (runtimeBuiltins) {
    globalDecls.push({ name: '$bump_ptr', type: 'i32', mutable: true, runtime: 'bump' });
    globalDecls.push({ name: '$region_save', type: 'i32', mutable: true, runtime: 'save' });
    globalNameSet.add('$bump_ptr');
    globalNameSet.add('$region_save');
  }
  for (const form of forms) {
    if (!Array.isArray(form) || V(form[1]) !== 'global') continue;
    let i = 1;
    const name = V(form[i + 1])?.startsWith('$') ? V(form[(i++) + 1]) : `$__global_${globalDecls.length}`;
    const typeForm = form[(i++) + 1];
    const mutable = Array.isArray(typeForm) && V(typeForm[1]) === 'mut';
    const type = mutable ? V(typeForm[2]) : V(typeForm);
    const init = form[i + 1];
    if (!['i32','i64','f32','f64'].includes(type)) throw new Error(`Unsupported global type '${type}' for ${name}`);
    // A global initializer may also be a REGION constant. That is what makes a
    // `(global $WND_RECORDS i32 …)` mirror follow an allocated region instead of
    // pinning it: without this the mirror is a literal, the literal is what all
    // 1000-odd `global.get` sites read, and the map cannot move at all.
    // (docs/watx-region-safety-design.md §6.) i32 only — an address is an i32
    // here, and there is no meaning to give the float or i64 cases.
    const regionInit = Array.isArray(init) && REGION_CONST_HEADS.has(V(init[1]));
    if (regionInit && type !== 'i32') {
      const e = new Error(`Global ${name}: (${V(init[1])} ...) yields an address, ` +
        `which is an i32, not a ${type}`);
      const loc = watxFormLoc(form);
      if (loc !== undefined) { e.line = watxNodeLine(loc); e.col = watxNodeCol(loc); e.file = watxNodeFile(loc); }
      throw e;
    }
    if (!regionInit && (!Array.isArray(init) || V(init[1]) !== `${type}.const`)) {
      throw new Error(`Global ${name} requires a ${type}.const initializer` +
        (type === 'i32' ? ` or a region constant (region.addr $R OFF), ` +
          `(region.size $R), (region.end $R)` : ''));
    }
    if (globalNameSet.has(name)) throw new Error(`Duplicate global '${name}'`);
    globalNameSet.add(name);
    globalDecls.push({ name, type, mutable, init });
  }
  // The global index space, imports first — the same shape as `funcIndexMap`,
  // where imported functions hold 0..n-1 and defined ones start after them. A
  // module with no global imports gets exactly the map it got before, so the
  // canonical build's indices do not move.
  const globalIndexMap = new Map();
  globalImportDecls.forEach((g, i) => {
    if (globalIndexMap.has(g.globalName)) throw new Error(`Duplicate global '${g.globalName}'`);
    globalIndexMap.set(g.globalName, i);
  });
  globalDecls.forEach((g, i) => {
    if (globalIndexMap.has(g.name)) throw new Error(`Duplicate global '${g.name}'`);
    globalIndexMap.set(g.name, globalImportDecls.length + i);
  });
  // One lookup table over both halves, so mutability and the bound are asked of
  // the index and not of whichever array the caller happened to remember.
  const globalSpace = [
    ...globalImportDecls.map(g => ({ name: g.globalName, type: g.type, mutable: g.mutable, imported: true })),
    ...globalDecls.map(g => ({ name: g.name, type: g.type, mutable: g.mutable, imported: false })),
  ];

  // Named type declarations used by standard (call_indirect (type $t) ...).
  const namedTypes = new Map();
  for (const form of forms) {
    if (!Array.isArray(form) || V(form[1]) !== 'type') continue;
    const name = V(form[2]);
    const sig = form[3];
    if (!name?.startsWith('$') || !Array.isArray(sig) || V(sig[1]) !== 'func') throw new Error('Invalid type declaration');
    if (namedTypes.has(name)) throw new Error(`Duplicate type '${name}'`);
    namedTypes.set(name, sig);
  }
  
  // Collect function-table declarations (android-emu: threaded-code dispatch).
  //   (func-table $h0 $h1 $h2 ...)  → table 0 (funcref), handlers at slots 0..n.
  // Multiple func-table forms concatenate into the single table.
  const tableEntries = [];        // ordered func names placed in table 0
  const funcSlotMap = new Map();  // func name → table slot index (for func-slot)
  let tableDecl = null;
  const elemSegments = [];
  for (const form of forms) {
    if (Array.isArray(form) && V(form[1]) === 'func-table') {
      for (let i = 1; i < (form.length - 1); i++) {
        const fn = V(form[i + 1]);
        if (fn && !funcSlotMap.has(fn)) { funcSlotMap.set(fn, tableEntries.length); tableEntries.push(fn); }
      }
    } else if (Array.isArray(form) && V(form[1]) === 'table') {
      if (tableDecl) throw new Error('Only one table declaration is supported');
      let i = 1;
      const name = V(form[i + 1])?.startsWith('$') ? V(form[(i++) + 1]) : null;
      const nums = [];
      for (; i < (form.length - 1); i++) if (T(form[i + 1]) === 'number') nums.push(parseInt(V(form[i + 1])));
      tableDecl = { name, min: nums[0] ?? 0, max: nums[1] };
    } else if (Array.isArray(form) && V(form[1]) === 'elem') {
      let i = 1;
      let table = 0;
      if (V(form[i + 1])?.startsWith('$')) i++; // segment name (accepted, not semantically significant)
      if (Array.isArray(form[i + 1]) && V(form[i + 1][1]) === 'table') { table = V(form[i + 1][2]) || 0; i++; }
      const offsetForm = form[(i++) + 1];
      if (!Array.isArray(offsetForm) || V(offsetForm[1]) !== 'i32.const') throw new Error('Active elem requires an i32.const offset');
      const offset = watxParseIntLiteral(
        watxConstFormToken(offsetForm, 'active elem segment offset'), 'active elem segment offset');
      const entries = [];
      for (; i < (form.length - 1); i++) {
        if (V(form[i + 1]) === 'func') continue;
        if (V(form[i + 1])?.startsWith('$')) entries.push(V(form[i + 1]));
      }
      elemSegments.push({ table, offset, entries });
      for (let j = 0; j < entries.length; j++) if (!funcSlotMap.has(entries[j])) funcSlotMap.set(entries[j], offset + j);
    }
  }
  if (!tableDecl && tableEntries.length) tableDecl = { name: null, min: tableEntries.length, max: tableEntries.length };
  if (tableEntries.length) elemSegments.unshift({ table: 0, offset: 0, entries: tableEntries });

  // Parse a (type (param ...) (result ...)) annotation → { params, results } as VALTYPE bytes.
  function parseIndirectSig(typeForm) {
    const params = [], results = [];
    if (Array.isArray(typeForm) && V(typeForm[1]) === 'type') {
      let resolved = typeForm;
      if (V(typeForm[2])?.startsWith('$')) {
        const sig = namedTypes.get(V(typeForm[2]));
        if (!sig) throw new Error(`Unknown type '${V(typeForm[2])}'`);
        resolved = [watxFormLoc(typeForm), 'type', ...sig.slice(2)];
      }
      for (let i = 1; i < (resolved.length - 1); i++) {
        const part = resolved[i + 1];
        if (!Array.isArray(part)) continue;
        const kind = V(part[1]);
        const arr = kind === 'param' ? params : kind === 'result' ? results : null;
        if (!arr) continue;
        for (let j = 1; j < (part.length - 1); j++) {
          const t = V(part[j + 1]);
          arr.push(valtypeOf(t));
        }
        // The type section could encode two results, but the call_indirect that
        // reads this signature pushes them onto a single-valued expression model.
        if (arr === results) watxRejectMultivalue('call_indirect signature', results.map(valtypeName), part);
      }
    }
    return { params, results };
  }

  // Data-segment bounds. The declaration set itself was validated far above,
  // before this scan, because a region-relative segment offset cannot resolve
  // until the regions exist.
  const initialMemoryBytes = memoryDecl.min * 65536;
  for (const seg of fixedDataSegments) {
    const end = seg.offset + seg.bytes.length;
    if (end > initialMemoryBytes) throw new Error(`Data segment [${seg.offset}, ${end}) exceeds initial memory (${initialMemoryBytes} bytes)`);
    if (seg.bytes.length && seg.offset < staticCursor && end > STATIC_REGION_BASE && staticCursor > STATIC_REGION_BASE) {
      throw new Error(`Data segment [${seg.offset}, ${end}) overlaps WATX static-region storage [${STATIC_REGION_BASE}, ${staticCursor})`);
    }
  }
  // String/cstring data goes immediately ABOVE the static regions so its bytes
  // never overlap a region's storage. The bump heap then starts after the data
  // (finalized at the global section, once the pool size is known). With no
  // static regions and no interned strings this stays 1024 — byte-identical.
  //
  // That rule holds only when WATX itself allocated the storage below, via
  // `region.declare-static/-bump/-rc` — those are what advance `staticCursor`.
  // A module whose regions come from the `region.declare`/`-fixed`/`-derived`
  // allocator leaves `staticCursor` at 1024, so "above the static regions"
  // degenerates to "above the last data segment", which is a point in the
  // MIDDLE of that map. Measured in wine-assembly: a single bare "ceil" literal
  // landed at 0x07B7B040, inside $D3DIM_AUX [0x07B7B000, 0x07B7C000), and every
  // gate passed — the check below only covers [1024, staticCursor), and a
  // segment-vs-segment overlap check cannot see a region whose storage carries
  // no data segment. So the pool silently overwrote live D3D state.
  //
  // Two things fix that, and neither changes a module that has no allocated
  // regions (the byte-identity case, and watjs's):
  //   1. `(string.pool $REGION)` pins the pool into a region declared for it,
  //      bounds-checked against that region's size like any other tenant.
  //   2. Absent that declaration, the legacy address is CHECKED against the
  //      region map instead of trusted (see the pool emit in section 11).
  legacyDataBase = Math.max(staticCursor, ...fixedDataSegments.map(seg => seg.offset + seg.bytes.length));
  legacyDataBase = (legacyDataBase + 15) & ~15;
  {
    const poolForms = forms.filter(f => Array.isArray(f) && V(f[1]) === 'string.pool');
    if (poolForms.length > 1) {
      throw locatedAt(poolForms[1],
        `(string.pool ...) is already declared at ${formWhere(poolForms[0])}; a module has one string pool`);
    }
    if (poolForms.length === 1) {
      const form = poolForms[0];
      if (watxFormLength(form) !== 2) {
        throw locatedAt(form, `(string.pool ...) takes exactly one operand: the region to place the pool in`);
      }
      const rname = V(form[2]);
      const region = rname ? regions.get(rname) : null;
      if (!region) {
        const known = [...regions.keys()];
        throw locatedAt(form, `string.pool: unknown region ${rname || '<missing>'}; declared regions are ` +
          (known.length ? known.join(', ') : '(none)'));
      }
      // A span names a range that other regions own; it has no storage of its
      // own to lend, exactly as region.addr refuses one.
      if (region.kind === 'span') {
        throw locatedAt(form, `string.pool: ${rname} is a span, which owns no storage of its own — ` +
          `name a region declared to hold the pool`);
      }
      stringPoolRegion = { name: rname, base: region.base, size: region.size, form };
    }
  }
  DATA_BASE = stringPoolRegion ? stringPoolRegion.base : legacyDataBase;

  // Build function index map:
  // Function imports first, then optional WATX runtime builtins, then user funcs.
  const funcIndexMap = new Map();
  let idx = 0;
  for (const imp of importDecls) {
    funcIndexMap.set(imp.funcName, idx++);
  }
  const builtinStartIdx = idx;
  if (runtimeBuiltins) {
    funcIndexMap.set(BUILTIN_REGION_ENTER, idx++);
    funcIndexMap.set(BUILTIN_REGION_ALLOC, idx++);
    funcIndexMap.set(BUILTIN_REGION_EXIT, idx++);
  }
  const userFuncStartIdx = idx;
  const funcNames = [];
  for (const fd of funcDecls) {
    if (options.strictDeclarations && funcIndexMap.has(fd.name)) throw new Error(`Duplicate function/import '${fd.name}'`);
    funcIndexMap.set(fd.name, idx++);
    funcNames.push(fd.name);
  }
  // Regions share the `$name` namespace with functions, globals and locals, and
  // only one of those collisions is ever intentional: a region named after the
  // `(global $R i32 (i32.const base))` it replaces, which is the designed
  // migration pattern and stays legal. A region named after a FUNCTION is not —
  // `(call $f)` still calls the function while a bare `$f` in operand position
  // now emits the region's base, so the same token means two things in one
  // module. Refuse it at declaration time rather than let a fan-out typo pick
  // whichever meaning the context happens to give it.
  for (const rname of regions.keys()) {
    if (!funcIndexMap.has(rname)) continue;
    const r = regions.get(rname);
    const e = new Error(`${r.head} ${rname} collides with a function of the same name; ` +
      `a bare ${rname} would emit the region base while (call ${rname}) still calls the function. ` +
      `Rename one of them.`);
    const loc = watxFormLoc(r.form);
    if (loc !== undefined) { e.line = watxNodeLine(loc); e.col = watxNodeCol(loc); e.file = watxNodeFile(loc); }
    throw e;
  }
  function expectedParamCount(name) {
    const imp = importDeclByName.get(name);
    if (imp) return imp.params.length;
    if (runtimeBuiltins && (name === BUILTIN_REGION_ENTER || name === BUILTIN_REGION_ALLOC)) return 1;
    if (runtimeBuiltins && name === BUILTIN_REGION_EXIT) return 0;
    const fd = funcDeclByName.get(name);
    return fd ? fd.params.length : undefined;
  }

  // ── Check if an expression produces a value on the Wasm stack ──
  // Returns false for void-returning calls, void if/block/loop, br, br_if, return, nop
  // ── Shared memarg parser ────────────────────────────────────────────────────
  // Consumes a run of standard `offset=N` / `align=N` symbols starting at logical
  // argument index `argIdx` (1 = first operand after the head) and returns the resolved
  // memarg plus the index of the first argument that is not a memarg. One parser serves
  // the scalar loads/stores, the v128 memory ops (migration gap G3 — these previously
  // hard-coded align=4 offset=0 and rejected `offset=16` outright) and the atomics.
  //
  // `requireNatural` is the threads proposal's rule: an atomic access MUST be naturally
  // aligned, so an explicit `align=` that disagrees is a hard error rather than a hint
  // the engine is free to reinterpret.
  function parseMemarg(expr, argIdx, head, naturalAlign, requireNatural) {
    let offset = 0, align = naturalAlign, i = argIdx, sawAlign = false;
    while (T(expr[i + 1]) === 'symbol' && /^(offset|align)=/.test(V(expr[i + 1]))) {
      // split('=', 2) is NOT enough: `offset=1=2` must be rejected outright, not
      // silently read as offset=1. Take the key and require ONE '=' with a
      // complete integer literal after it — `offset=16junk` used to compile as 16.
      const tokenText = V(expr[i + 1]);
      const eq = tokenText.indexOf('=');
      const key = tokenText.slice(0, eq);
      const raw = tokenText.slice(eq + 1);
      i++;
      const n = watxParseIntLiteral(raw, `${key}= memarg in ${head}`);
      if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${key} memarg '${raw}' in ${head}`);
      if (key === 'offset') offset = n;
      else {
        if (n === 0 || (n & (n - 1)) !== 0) throw new Error(`align=${n} must be a positive power of two in ${head}`);
        align = Math.log2(n);
        sawAlign = true;
      }
    }
    if (requireNatural && sawAlign && align !== naturalAlign) {
      throw new Error(
        `${head}: atomic accesses require natural alignment — align=${1 << align} given, ` +
        `align=${1 << naturalAlign} required`);
    }
    return { offset, align, next: i };
  }

  // ── The one place a layout access is encoded ───────────────────────────────
  //
  // Every one of the six layout accessors (load/store × field/elem/field-elem)
  // ends in exactly one memory instruction, chosen by the FIELD's declared type
  // — never by the site. `memargOffset` carries the fork of §3.4:
  //
  //   0            the add-form lowering: the caller already emitted
  //                `i32.const OFF; i32.add`, so the instruction addresses +0.
  //   field.offset the `.memarg` lowering: no arithmetic was emitted and the
  //                offset rides in the instruction instead.
  //
  // Encoded opcode / ULEB align / ULEB offset, which is byte-for-byte what the
  // plain `i32.load offset=N` path a few hundred lines below emits — that
  // equality is the whole oracle, so both spellings go through this one helper
  // rather than through six hand-written opcode triples that can drift apart.
  function emitLayoutAccess(bytes, fieldType, isStore, memargOffset) {
    const tbl = WATX_LAYOUT_ACCESS_OPS || (WATX_LAYOUT_ACCESS_OPS = {
      // (opcode, align) per field type. `align` is the log2 memarg the plain
      // WATX_LOAD_OPS/WATX_STORE_OPS tables below emit for the same instruction,
      // so a layout accessor stays byte-identical to its hand-spelled twin.
      // The sub-width integer types are access WIDTHS: each loads and stores
      // through an i32 on the stack. `s8`/`s16` sign-extend on load; their store
      // is the same truncating store as the unsigned twin, because a store
      // discards the high bits either way.
      load:  { f32: [OP.f32_load, 2],  f64: [OP.f64_load, 3],  i64: [OP.i64_load, 3],  i32: [OP.i32_load, 2],
               u8: [OP.i32_load8_u, 0], s8: [OP.i32_load8_s, 0], u16: [OP.i32_load16_u, 1], s16: [OP.i32_load16_s, 1] },
      store: { f32: [OP.f32_store, 2], f64: [OP.f64_store, 3], i64: [OP.i64_store, 3], i32: [OP.i32_store, 2],
               u8: [OP.i32_store8, 0],  s8: [OP.i32_store8, 0], u16: [OP.i32_store16, 1], s16: [OP.i32_store16, 1] },
    });
    const group = isStore ? tbl.store : tbl.load;
    // `ptr`/`ptr$Rec`/`weak` are 4-byte i32 fields — the ONLY types that map onto
    // the i32 group without being spelled i32. Everything else must have its own
    // entry: this used to be `group[fieldType] || group.i32`, so an unrecognized
    // type became a silent 4-byte access over a field of some other width. That
    // fallback is now unreachable — checkTypes() refuses any type outside
    // WATX_LAYOUT_FIELD_TYPES at the declaration — so reaching the throw means the
    // two tables have drifted apart, which is a compiler bug rather than bad source.
    const spec = group[fieldType] ||
      (typeof fieldType === 'string' && (fieldType === 'weak' || fieldType.startsWith('ptr'))
        ? group.i32 : null);
    if (!spec)
      throw new Error(`WATX internal: no ${isStore ? 'store' : 'load'} opcode for layout field type ` +
        `'${fieldType}' (it passed checkTypes but emitLayoutAccess has no entry).`);
    bytes.byte(spec[0]);
    bytes.uleb(spec[1]);
    bytes.uleb(memargOffset);
  }

  // ── block / loop signature ─────────────────────────────────────────────────
  // Returns the declared result valtype of a `(block $l (result T) …)` / `(loop …)`,
  // or null when the node is not a signature at all. Also accepts the bare-valtype
  // spelling `if` already takes. An unknown type name is a hard error rather than a
  // silent fall back to void — that fall-back is what migration gap G4 was.
  function blockSignature(node, head) {
    const named = ['i32', 'i64', 'f32', 'f64', 'v128'];
    if (Array.isArray(node) && V(node[1]) === 'result') {
      // A block type is one VALTYPE byte here, so a second declared result has
      // nowhere to go; it used to be dropped on the floor and the body was then
      // emitted for the first type alone.
      watxRejectMultivalue(head, watxFormSlice(node, 1).map(V), node);
      const t = V(node[2]);
      if (!named.includes(t)) throw new Error(`${head}: unknown (result ${t}) type`);
      return t;
    }
    if (!Array.isArray(node) && T(node) === 'symbol' && named.includes(V(node))) return V(node);
    return null;
  }

  // ── Explicit statement-level (drop) (migration gap G8) ─────────────────────
  // A bare `(drop)` — no operand of its own — is the CONSUMER of the value the previous
  // sibling statement left on the stack. That is how standard WAT and Wine-Assembly's own
  // legacy compiler (lib/compile-wat.js, which has no auto-drop at all — `drop` is a plain
  // 0x1A opcode-table entry) spell "call this i32-returning function for its effect only"
  // inside a void function:
  //
  //     (call $host_gdi_set_dib_to_device …)   ;; (result i32)
  //     (drop)
  //
  // WATX's statement compiler synthesizes a drop for any non-final statement that leaves a
  // value, so before this it emitted its own drop AND then compiled the explicit one on
  // top, and the second underflowed the stack. The site is src/09a8-handlers-directx.wat:
  // 4449, and it is load-bearing — deleting it makes the LEGACY build fail validation
  // ("expected 0 elements on the stack for fallthru, found 1" in $dx_blit_entry_rect_to_hdc).
  //
  // Deliberate scope: this suppresses the synthesized drop only when an explicit consumer
  // is right there. A value left with NO consumer is still auto-dropped exactly as before —
  // that is the status quo every WATX source in the tree is written against, and promoting
  // it to an error is a separate, much larger change.
  function isBareDrop(node) {
    return Array.isArray(node) && V(node[1]) === 'drop' && (node.length - 1) === 1;
  }
  // Should the compiler synthesize a drop for `stmt`, given the sibling that follows it?
  function needsAutoDrop(stmt, nextStmt, func) {
    return exprProducesValue(stmt, func) && !isBareDrop(nextStmt);
  }

  function exprProducesValue(expr, func) {
    if (!expr) return false;
    if (!Array.isArray(expr)) {
      // Literals and variable references always produce a value
      if (T(expr) === 'number' || T(expr) === 'string') return true;
      if (T(expr) === 'symbol') return true; // local.get or literal
      return false;
    }
    // `.memarg` is a lowering modifier, not a different operation: a
    // `load.field.memarg` produces a value exactly as `load.field` does, and a
    // `store.field.memarg` is a statement exactly as `store.field` is. Strip it
    // before any head test, or the valueOps set below misses the modified
    // spelling and the auto-drop decision is made for the wrong shape.
    const head = watxLayoutMemargHead(V(expr[1])).head;
    if (!head) return false;

    // Constants always produce values
    if (head === 'i32.const' || head === 'f32.const' || head === 'i64.const' || head === 'f64.const') return true;

    // Atomics (threads proposal). Loads, rmw, notify and wait all push a value; a fence
    // pushes nothing; a store follows the same rule as the scalar stores — void in
    // standard-WAT mode, the WATX i32 0 convention otherwise.
    if (typeof head === 'string' && (head === 'atomic.fence' || head.indexOf('.atomic.') > 0)) {
      if (head === 'atomic.fence') return false;
      if (head.indexOf('.atomic.store') > 0) return !standardWat;
      return true;
    }

    // Arithmetic, comparison, unary, conversion ops produce values
    const valueOps = WATX_VALUE_OPS || (WATX_VALUE_OPS = new Set([
      'i32.add','i32.sub','i32.mul','i32.div_s','i32.div_u','i32.rem_s','i32.rem_u',
      'i32.and','i32.or','i32.xor','i32.shl','i32.shr_s','i32.shr_u',
      'i32.eq','i32.ne','i32.lt_s','i32.lt_u','i32.gt_s','i32.gt_u','i32.le_s','i32.le_u','i32.ge_s','i32.ge_u',
      'f32.add','f32.sub','f32.mul','f32.div','f32.min','f32.max','f32.copysign','f32.eq','f32.ne','f32.lt','f32.gt','f32.le','f32.ge',
      'f64.add','f64.sub','f64.mul','f64.div',
      'i32.eqz','f32.neg','f32.abs','f32.ceil','f32.floor','f32.sqrt',
      'i32.trunc_f32_s','i32.trunc_f32_u','f32.convert_i32_s','f32.convert_i32_u',
      'f64.promote_f32','f32.demote_f64','i32.wrap_i64','i64.extend_i32_s',
      'f64.convert_i32_s','i32.reinterpret_f32','f32.reinterpret_i32',
      'local.get','local.tee','global.get',
      'let', 'set!', 'local.set', // these push i32.const 0 in legacy WATX mode
      'store.field','store.elem','store.field-elem','i32.store','f32.store','i32.store8','global.set',
      'load.field','load.elem','load.field-elem','i32.load','f32.load','i32.load8_u',
      'size-of','offset-of','elem-addr',
      'select','memory.size','memory.grow',
      'region.alloc',
      'region.addr','region.size','region.end',
      // watjs extensions
      'i32.rotl','i32.rotr','i32.clz','i32.ctz','i32.popcnt',
      'i64.clz','i64.ctz','i64.popcnt',
      'i64.add','i64.sub','i64.mul','i64.div_s','i64.div_u','i64.rem_s','i64.rem_u',
      'i64.and','i64.or','i64.xor','i64.shl','i64.shr_s','i64.shr_u','i64.rotl','i64.rotr',
      'i64.eqz','i64.eq','i64.ne','i64.lt_s','i64.lt_u','i64.gt_s','i64.gt_u',
      'i64.le_s','i64.le_u','i64.ge_s','i64.ge_u',
      'f64.eq','f64.ne','f64.lt','f64.gt','f64.le','f64.ge','f64.min','f64.max','f64.copysign',
      'f64.abs','f64.neg','f64.ceil','f64.floor','f64.trunc','f64.nearest','f64.sqrt',
      'i64.load','f64.load',
      'i32.trunc_f64_s','i32.trunc_f64_u','i64.extend_i32_u',
      'i64.trunc_f32_s','i64.trunc_f32_u','i64.trunc_f64_s','i64.trunc_f64_u',
      // saturating float->int (non-trapping): NaN->0, overflow->min/max. Matches ARM FCVTZS/U.
      'i32.trunc_sat_f32_s','i32.trunc_sat_f32_u','i32.trunc_sat_f64_s','i32.trunc_sat_f64_u',
      'i64.trunc_sat_f32_s','i64.trunc_sat_f32_u','i64.trunc_sat_f64_s','i64.trunc_sat_f64_u',
      'f32.convert_i64_s','f32.convert_i64_u','f64.convert_i32_u',
      'f64.convert_i64_s','f64.convert_i64_u',
      'i64.reinterpret_f64','f64.reinterpret_i64',
      'i32.load16_u','i32.load16_s','i32.load8_s','cstring','string',
      'i64.load8_s','i64.load8_u','i64.load16_s','i64.load16_u','i64.load32_s','i64.load32_u',
      'i32.extend8_s','i32.extend16_s','i64.extend8_s','i64.extend16_s','i64.extend32_s',
      'i64.store','f64.store','i32.store16','i64.store8','i64.store16','i64.store32',
    ]));
    if (valueOps.has(head)) {
      if (standardWat && (head === 'local.set' || head === 'set!' || head === 'global.set' || head.includes('store'))) return false;
      return true;
    }

    // WASM SIMD (v128) ops. All op names under the shape prefixes leave a value on the
    // stack: full-vector ops leave v128; extract_lane / any_true / all_true leave a
    // scalar; v128.store yields i32 0 (WATX store convention — see compileExpr). A
    // prefix check avoids duplicating every opcode name in this table AND the emit
    // dispatch. i32.* vs i32x4.* is safe because startsWith uses the full prefix
    // (including the '.').
    if (typeof head === 'string' && (
        head.startsWith('v128.') || head.startsWith('i8x16.') || head.startsWith('i16x8.') ||
        head.startsWith('i32x4.') || head.startsWith('i64x2.') ||
        head.startsWith('f32x4.') || head.startsWith('f64x2.'))) {
      // v128.store / v128.storeN_lane follow the scalar store rule: void in standard-WAT
      // mode, the legacy WATX i32 0 convention otherwise.
      if (head.startsWith('v128.store')) return !standardWat;
      return true;
    }

    // call — depends on whether function has results
    if (head === 'call') {
      const funcName = V(expr[2]);
      const imp = importDeclByName.get(funcName);
      if (imp) return imp.results.length > 0;
      // Check builtins
      if (funcName === BUILTIN_REGION_ENTER || funcName === BUILTIN_REGION_ALLOC) return true;
      if (funcName === BUILTIN_REGION_EXIT) return false;
      const fd = funcDeclByName.get(funcName);
      if (fd) return fd.results.length > 0;
      return false; // unknown
    }

    // call_indirect — produces a value iff its (type ...) has a result
    if (head === 'call_indirect') return parseIndirectSig(expr[2]).results.length > 0;
    // tail calls are terminal — they return from the function, leave nothing on the stack
    if (head === 'return_call' || head === 'return_call_indirect') return false;
    // func-slot — i32 table index constant
    if (head === 'func-slot') return true;

    // if — produces value only if it has a non-void block type AND branches produce values
    if (head === 'if') {
      // Has explicit type annotation? Both (if i32 ...) and (if (result i32) ...)
      // forms declare the if yields a value.
      if (T(expr[2]) === 'symbol' && ['i32','i64','f32','f64','v128'].includes(V(expr[2]))) return true;
      if (Array.isArray(expr[2]) && V(expr[2][1]) === 'result') return true;
      // Has both then and else branches?
      let condIdx = 1;
      let thenE = null, elseE = null;
      let restIdx = condIdx + 1;
      
      if (restIdx < (expr.length - 1)) {
        const rest=expr[restIdx + 1];
        if (Array.isArray(rest) && V(rest[1]) === 'then') {
          thenE = (rest.length - 1) === 2 ? rest[2] : rest[rest.length - 1];
        } else {
          thenE = rest;
        }
        restIdx++;
      }
      if (restIdx < (expr.length - 1)) {
        const rest=expr[restIdx + 1];
        if (V(rest) === 'else') {
          restIdx++;
          if (restIdx < (expr.length - 1)) { elseE = expr[restIdx + 1]; }
        } else if (Array.isArray(rest) && V(rest[1]) === 'else') {
          elseE = (rest.length - 1) === 2 ? rest[2] : rest[rest.length - 1];
        } else {
          elseE = rest;
        }
      }
      // Only produces a value if BOTH branches exist AND both produce values
      if (!thenE || !elseE) return false;
      return exprProducesValue(thenE, func) && exprProducesValue(elseE, func);
    }
    
    // block / loop — an explicit `(result T)` signature (migration gap G4) makes either
    // one a value. Without a signature the historical rule stands: a loop is void, and
    // an UNLABELED block yields the value of its last expression (like begin) so it can
    // be used as an if-arm, while a LABELED one stays void — value-typing it implicitly
    // would require every br to it to carry a value, which the break-style blocks
    // throughout the codebase do not do.
    if (head === 'block' || head === 'loop') {
      const labeled = T(expr[2]) === 'symbol' && V(expr[2]).startsWith('$');
      if (blockSignature(expr[labeled ? 3 : 2], head) !== null) return true;
      if (head === 'loop') return false;
      if (labeled || (expr.length - 1) < 2) return false;
      return exprProducesValue(expr[expr.length - 1], func);
    }

    // (local $x type) — a WAT-style declaration; emits nothing, yields no value
    if (head === 'local') return false;

    // br / br_if / br_table / return / nop — no value
    if (head === 'br' || head === 'br_if' || head === 'br_table' || head === 'return' || head === 'nop' || head === 'unreachable') return false;

    // drop — void
    if (head === 'drop') return false;

    // Bulk-memory: memory.copy / memory.fill both push NOTHING (WASM spec). Marked void so
    // `(begin ... (memory.copy ...) ...)` does not attempt to drop a phantom value.
    if (head === 'memory.copy' || head === 'memory.fill') return false;

    // begin — produces value of last expression
    if (head === 'begin') {
      if ((expr.length - 1) < 2) return false;
      return exprProducesValue(expr[expr.length - 1], func);
    }
    
    // with-region — produces value of last body expression
    if (head === 'with-region') {
      if ((expr.length - 1) < 4) return false;
      return exprProducesValue(expr[expr.length - 1], func);
    }
    
    // Fallback: assume it produces a value (to be safe about dropping)
    return true;
  }

  // ── Compile function body to Wasm bytecode ──
  function compileExpr(expr, func, depth, bytes = new BinaryWriter()) {
    if (!expr) return bytes;
    if (Array.isArray(expr)) func.sourceNode = expr;
    
    if (!Array.isArray(expr)) {
      if (T(expr) === 'number') {
        const val = V(expr);
        const where = `bare literal in function ${func.name}`;
        // A hex literal is never a float here, so test for the 0x prefix BEFORE the
        // exponent characters: `0xE1` contains an 'E' and used to take the float
        // branch, where parseFloat('0xE1') is 0 — a silent zero constant.
        const isHex = /^[+-]?0[xX]/.test(val);
        if (!isHex && (val.includes('.') || val.includes('e') || val.includes('E'))) {
          bytes.byte(OP.f32_const);
          bytes.append(watxFloatLiteralBytes(val, where, 4));
        } else {
          const n = watxParseIntLiteral(val, where);
          bytes.byte(OP.i32_const);
          bytes.sleb(n);
        }
        return bytes;
      }
      if (T(expr) === 'symbol') {
        // Variable reference — look up local index (active binding for
        // type-colliding names, else the default slot)
        const localIdx = func.activeLocal.get(V(expr)) ?? func.localMap.get(V(expr));
        if (localIdx !== undefined) {
          // A local WINS over a region of the same name, and silently: the base
          // the author wrote `$THREAD_BASE` for becomes whatever that local
          // holds. That is invisible in a conversion wave, where the whole point
          // is that `$REGION` replaces an address, so refuse the ambiguity
          // instead of resolving it. Renaming the local is the fix.
          if (regions.has(V(expr))) {
            const e = new Error(
              `'${V(expr)}' in function ${func.name} is both a local/parameter and a declared ` +
              `region; the local wins, so the region base can never be read here. Rename the local.`);
            // func.sourceNode is only set once an enclosing FORM has been
            // compiled; a one-atom body (`(func $f … $R)`) never sets it, so
            // fall back to the function's own declaration form.
            const loc = watxTokenLoc(func.sourceNode || func.sourceForm, V(expr));
            e.line = watxNodeLine(loc); e.col = watxNodeCol(loc); e.file = watxNodeFile(loc);
            throw e;
          }
          bytes.byte(OP.local_get);
          bytes.uleb(localIdx);
          return bytes;
        }
        // Could be a numeric literal that tokenized as symbol. A LEADING PLUS is
        // one of those: the tokenizer starts a number only on a digit or a '-',
        // so `+42` arrives as the symbol '+42'. The `.const` heads accept a
        // plus-signed literal, so a bare atom in operand position accepts one
        // too — the alternative was rejecting `+42` here as an unknown symbol
        // while `(i32.const +42)` compiled, which is an inconsistency with no
        // rationale behind it. The same int/float split as the number-atom path
        // above, so `+1.5` is a float rather than an integer-literal error.
        if (/^[+-]?[0-9]/.test(V(expr))) {
          const val = V(expr);
          const where = `bare literal in function ${func.name}`;
          const isHex = /^[+-]?0[xX]/.test(val);
          if (!isHex && (val.includes('.') || val.includes('e') || val.includes('E'))) {
            bytes.byte(OP.f32_const);
            bytes.append(watxFloatLiteralBytes(val, where, 4));
          } else {
            bytes.byte(OP.i32_const);
            bytes.sleb(watxParseIntLiteral(val, where));
          }
          return bytes;
        }
        // Static region symbol -> its base address (memory allocated in WATX via
        // (region.declare-static $r (size N))). Lets code address the region by
        // name instead of a hardcoded number.
        if (regionBase.has(V(expr))) {
          bytes.byte(OP.i32_const);
          bytes.sleb(regionBase.get(V(expr)));
          return bytes;
        }
        // Unknown symbol — a bare symbol that is neither a known local/param
        // nor a numeric literal has no valid meaning here. Silently pushing 0
        // (the old behavior) turned typos like `$reallval` into a constant 0,
        // miscompiling code with no diagnostic. Make it a hard compile error.
        {
          const e = new Error(
            `Unknown symbol '${V(expr)}' in function ${func.name}: ` +
            `not a declared local, parameter, or numeric literal (typo?).`);
          const loc = watxTokenLoc(func.sourceNode, V(expr));
          e.line = watxNodeLine(loc);
          e.col = watxNodeCol(loc);
          e.file = watxNodeFile(loc);
          throw e;
        }
      }
      if (T(expr) === 'string') {
        // Bare "text" literal → a real C string ([bytes][NUL]) in the data
        // segment; push a pointer to the first byte. (Use (string "...") for a
        // length-prefixed Pascal string.)
        if (!firstInternFunc) firstInternFunc = func;
        const ptr = internCStr(V(expr));
        bytes.byte(OP.i32_const);
        bytes.sleb(ptr);
        return bytes;
      }
      return bytes;
    }

    // A layout accessor may carry the `.memarg` modifier (§3.4 of
    // docs/watx-layout-migration-design.md): the field offset is folded into the
    // memory instruction's memarg instead of being added to the address first.
    // Strip it ONCE, here, so every head test below sees the base op and only
    // the six layout handlers ever consult the flag.
    const headForm = watxLayoutMemargHead(V(expr[1]));
    const head = headForm.head;
    const layoutMemarg = headForm.memarg;
    if (headForm.noMemarg) {
      const base = head.slice(0, -'.memarg'.length);
      const e = new Error(
        `'${head}' does not exist in ${func?.name || '<expr>'}: ${base} computes an address or a ` +
        `constant and performs no memory access, so it has no memarg to fold a field offset into.`);
      e.line = watxNodeLine(expr); e.col = watxNodeCol(expr); e.file = watxNodeFile(expr);
      throw e;
    }

    // Folded instructions must consume the WHOLE form. Emitting
    // only expr[2]/expr[3] is not validation: before this check
    // `(i32.or A B C D)` compiled A|B and silently discarded C and D. The
    // resulting wasm validates, so neither the engine nor the type pass can
    // recover the author's intent. Keep these helpers at the common dispatch
    // point and use them for every fixed-form family below, including direct
    // emitters and memarg forms whose exact count is known only after parsing
    // offset=/align= tokens.
    const arityError = (expected, got) => {
      const e = new Error(`${head} in function ${func.name}: expected ${expected}, got ${got}`);
      const loc = watxFormLoc(expr);
      if (loc !== undefined) {
        e.line = watxNodeLine(loc); e.col = watxNodeCol(loc); e.file = watxNodeFile(loc);
      }
      throw e;
    };
    const requireArity = (expected) => {
      const got = watxFormLength(expr) - 1;
      if (got === expected) return;
      arityError(`exactly ${expected} operand(s)`, got);
    };
    const requireArityOneOf = (...expected) => {
      const got = watxFormLength(expr) - 1;
      if (expected.includes(got)) return;
      const words = expected.length === 2
        ? `${expected[0]} or ${expected[1]}`
        : `${expected.slice(0, -1).join(', ')}, or ${expected[expected.length - 1]}`;
      arityError(`${words} operand(s)`, got);
    };
    const requireMinArity = (expected) => {
      const got = watxFormLength(expr) - 1;
      if (got >= expected) return;
      arityError(`at least ${expected} operand(s)`, got);
    };

    if (head === 'unreachable') {
      requireArity(0);
      bytes.push(OP.unreachable);
      return bytes;
    }
    if (!head) return bytes;

    // ── (string "text") → pointer to interned [i32 len][bytes] blob ──
    // (cstring "...") is a DEPRECATED alias of (string ...) kept working for
    // back-compat. NOTE: despite its name it is length-prefixed, NOT a C string
    // — a bare "text" literal is the real (NUL-terminated) C string now.
    // TODO(watjs): migrate watjs's ~3500 (cstring ...) call sites to (string ...)
    // and add (string ...) to watjs's own compiler copy.
    if (head === 'string' || head === 'cstring') {
      requireArity(1);
      const raw = V(expr[2]) || '""';
      if (!firstInternFunc) firstInternFunc = func;
      const ptr = internPString(raw);
      bytes.byte(OP.i32_const);
      bytes.sleb(ptr);
      return bytes;
    }

    // ── Numeric constants ──
    // The operand of a `.const` is a single literal TOKEN, never a sub-expression
    // and never two tokens. Checking the arity here is what catches junk that the
    // tokenizer split off into a second atom instead of keeping inside the number:
    // `(i64.const 0x10zz)` reads as `0x10` plus a stray symbol `zz`, and the extra
    // child used to be dropped on the floor, leaving a silently wrong 16.
    if (head === 'i32.const' || head === 'i64.const' || head === 'f32.const' || head === 'f64.const') {
      const where = `${head} in function ${func.name}`;
      if (watxFormLength(expr) !== 2 || Array.isArray(expr[2]) || T(expr[2]) === 'string') {
        const e = new Error(
          `${where}: expected exactly one literal operand, got ` +
          `${watxFormLength(expr) - 1} argument(s) — a constant takes a single complete ` +
          `numeric token (an extra token here is usually trailing junk on the literal)`);
        const loc = watxFormLoc(expr);
        if (loc !== undefined) { e.line = watxNodeLine(loc); e.col = watxNodeCol(loc); e.file = watxNodeFile(loc); }
        throw e;
      }
      const raw = V(expr[2]);
      try {
        if (head === 'i32.const') {
          bytes.byte(OP.i32_const);
          bytes.sleb(watxParseIntLiteral(raw, where));
        } else if (head === 'i64.const') {
          bytes.byte(OP.i64_const);
          bytes.slebBig(parseI64Literal(raw));
        } else if (head === 'f32.const') {
          bytes.byte(OP.f32_const);
          bytes.append(watxFloatLiteralBytes(raw, where, 4));
        } else {
          bytes.byte(OP.f64_const);
          bytes.append(watxFloatLiteralBytes(raw, where, 8));
        }
      } catch (err) {
        const loc = watxFormLoc(expr);
        if (loc !== undefined && err.line === undefined) {
          err.line = watxNodeLine(loc); err.col = watxNodeCol(loc); err.file = watxNodeFile(loc);
        }
        if (!/ in /.test(err.message)) err.message = `${err.message} in ${where}`;
        throw err;
      }
      return bytes;
    }

    // ── Arithmetic / comparison ops ──
    const binaryOps = WATX_BINARY_OPS || (WATX_BINARY_OPS = {
      'i32.add': OP.i32_add, 'i32.sub': OP.i32_sub, 'i32.mul': OP.i32_mul,
      'i32.div_s': OP.i32_div_s, 'i32.div_u': OP.i32_div_u,
      'i32.rem_s': OP.i32_rem_s, 'i32.rem_u': OP.i32_rem_u,
      'i32.and': OP.i32_and, 'i32.or': OP.i32_or, 'i32.xor': OP.i32_xor,
      'i32.shl': OP.i32_shl, 'i32.shr_s': OP.i32_shr_s, 'i32.shr_u': OP.i32_shr_u,
      'i32.eq': OP.i32_eq, 'i32.ne': OP.i32_ne,
      'i32.lt_s': OP.i32_lt_s, 'i32.lt_u': OP.i32_lt_u,
      'i32.gt_s': OP.i32_gt_s, 'i32.gt_u': OP.i32_gt_u,
      'i32.le_s': OP.i32_le_s, 'i32.le_u': OP.i32_le_u,
      'i32.ge_s': OP.i32_ge_s, 'i32.ge_u': OP.i32_ge_u,
      'f32.add': OP.f32_add, 'f32.sub': OP.f32_sub,
      'f32.mul': OP.f32_mul, 'f32.div': OP.f32_div,
      'f32.min': OP.f32_min, 'f32.max': OP.f32_max, 'f32.copysign': OP.f32_copysign,
      'f32.eq': OP.f32_eq, 'f32.ne': OP.f32_ne,
      'f32.lt': OP.f32_lt, 'f32.gt': OP.f32_gt,
      'f32.le': OP.f32_le, 'f32.ge': OP.f32_ge,
      'f64.add': OP.f64_add, 'f64.sub': OP.f64_sub,
      'f64.mul': OP.f64_mul, 'f64.div': OP.f64_div,
      'f64.eq': OP.f64_eq, 'f64.ne': OP.f64_ne, 'f64.lt': OP.f64_lt,
      'f64.gt': OP.f64_gt, 'f64.le': OP.f64_le, 'f64.ge': OP.f64_ge,
      'f64.min': OP.f64_min, 'f64.max': OP.f64_max, 'f64.copysign': OP.f64_copysign,
      'i32.rotl': OP.i32_rotl, 'i32.rotr': OP.i32_rotr,
      'i64.add': OP.i64_add, 'i64.sub': OP.i64_sub, 'i64.mul': OP.i64_mul,
      'i64.div_s': OP.i64_div_s, 'i64.div_u': OP.i64_div_u,
      'i64.rem_s': OP.i64_rem_s, 'i64.rem_u': OP.i64_rem_u,
      'i64.and': OP.i64_and, 'i64.or': OP.i64_or, 'i64.xor': OP.i64_xor,
      'i64.shl': OP.i64_shl, 'i64.shr_s': OP.i64_shr_s, 'i64.shr_u': OP.i64_shr_u,
      'i64.rotl': OP.i64_rotl, 'i64.rotr': OP.i64_rotr,
      'i64.eq': OP.i64_eq, 'i64.ne': OP.i64_ne,
      'i64.lt_s': OP.i64_lt_s, 'i64.lt_u': OP.i64_lt_u,
      'i64.gt_s': OP.i64_gt_s, 'i64.gt_u': OP.i64_gt_u,
      'i64.le_s': OP.i64_le_s, 'i64.le_u': OP.i64_le_u,
      'i64.ge_s': OP.i64_ge_s, 'i64.ge_u': OP.i64_ge_u,
    });

    if (binaryOps[head]) {
      requireArity(2);
      compileExpr(expr[2], func, depth, bytes);
      compileExpr(expr[3], func, depth, bytes);
      bytes.push(binaryOps[head]);
      return bytes;
    }
    
    // ── Unary ops ──
    const unaryOps = WATX_UNARY_OPS || (WATX_UNARY_OPS = {
      'i32.eqz': OP.i32_eqz, 'i64.eqz': OP.i64_eqz,
      'i32.clz': OP.i32_clz, 'i32.ctz': OP.i32_ctz, 'i32.popcnt': OP.i32_popcnt,
      'i64.clz': OP.i64_clz, 'i64.ctz': OP.i64_ctz, 'i64.popcnt': OP.i64_popcnt,
      'f32.neg': OP.f32_neg, 'f32.abs': OP.f32_abs,
      'f32.ceil': OP.f32_ceil, 'f32.floor': OP.f32_floor, 'f32.sqrt': OP.f32_sqrt,
      'f32.trunc': OP.f32_trunc, 'f32.nearest': OP.f32_nearest,
      'f64.abs': OP.f64_abs, 'f64.neg': OP.f64_neg, 'f64.ceil': OP.f64_ceil,
      'f64.floor': OP.f64_floor, 'f64.trunc': OP.f64_trunc, 'f64.nearest': OP.f64_nearest,
      'f64.sqrt': OP.f64_sqrt,
    });
    
    if (unaryOps[head]) {
      requireArity(1);
      compileExpr(expr[2], func, depth, bytes);
      bytes.push(unaryOps[head]);
      return bytes;
    }
    
    // ── Type conversions ──
    const convOps = WATX_CONV_OPS || (WATX_CONV_OPS = {
      'i32.trunc_f32_s': OP.i32_trunc_f32_s, 'i32.trunc_f32_u': OP.i32_trunc_f32_u,
      'f32.convert_i32_s': OP.f32_convert_i32_s, 'f32.convert_i32_u': OP.f32_convert_i32_u,
      'f64.promote_f32': OP.f64_promote_f32, 'f32.demote_f64': OP.f32_demote_f64,
      'i32.wrap_i64': OP.i32_wrap_i64, 'i64.extend_i32_s': OP.i64_extend_i32_s,
      'f64.convert_i32_s': OP.f64_convert_i32_s,
      'i32.reinterpret_f32': OP.i32_reinterpret_f32, 'f32.reinterpret_i32': OP.f32_reinterpret_i32,
      'i32.trunc_f64_s': OP.i32_trunc_f64_s, 'i32.trunc_f64_u': OP.i32_trunc_f64_u,
      'i64.extend_i32_u': OP.i64_extend_i32_u,
      'i64.trunc_f32_s': OP.i64_trunc_f32_s, 'i64.trunc_f32_u': OP.i64_trunc_f32_u,
      'i64.trunc_f64_s': OP.i64_trunc_f64_s, 'i64.trunc_f64_u': OP.i64_trunc_f64_u,
      'f32.convert_i64_s': OP.f32_convert_i64_s, 'f32.convert_i64_u': OP.f32_convert_i64_u,
      'f64.convert_i32_u': OP.f64_convert_i32_u,
      'f64.convert_i64_s': OP.f64_convert_i64_s, 'f64.convert_i64_u': OP.f64_convert_i64_u,
      'i64.reinterpret_f64': OP.i64_reinterpret_f64, 'f64.reinterpret_i64': OP.f64_reinterpret_i64,
      'i32.extend8_s': OP.i32_extend8_s, 'i32.extend16_s': OP.i32_extend16_s,
      'i64.extend8_s': OP.i64_extend8_s, 'i64.extend16_s': OP.i64_extend16_s, 'i64.extend32_s': OP.i64_extend32_s,
    });
    
    if (convOps[head]) {
      requireArity(1);
      compileExpr(expr[2], func, depth, bytes);
      bytes.push(convOps[head]);
      return bytes;
    }

    // Saturating float->int conversions: 0xFC prefix + opcode index (ULEB, single byte for 0-7).
    const satConvOps = WATX_SAT_CONV_OPS || (WATX_SAT_CONV_OPS = {
      'i32.trunc_sat_f32_s': 0, 'i32.trunc_sat_f32_u': 1, 'i32.trunc_sat_f64_s': 2, 'i32.trunc_sat_f64_u': 3,
      'i64.trunc_sat_f32_s': 4, 'i64.trunc_sat_f32_u': 5, 'i64.trunc_sat_f64_s': 6, 'i64.trunc_sat_f64_u': 7,
    });
    if (satConvOps[head] !== undefined) {
      requireArity(1);
      compileExpr(expr[2], func, depth, bytes);
      bytes.push(0xFC, satConvOps[head]);
      return bytes;
    }

    // Bulk-memory ops (WebAssembly bulk-memory proposal, baseline in modern Node/Chrome/Safari):
    //   memory.copy = 0xFC 0x0A + dst_memidx + src_memidx  -- pops (dst i32, src i32, len i32), pushes nothing
    //   memory.fill = 0xFC 0x0B + memidx                    -- pops (dst i32, val i32, len i32), pushes nothing
    // WATX form: (memory.copy $dst $src $len) / (memory.fill $dst $val $len). Both are VOID (see the
    // exprProducesValue table below) -- callers that want a value should wrap with a following i32.const.
    // We hard-code memidx 0x00 (module has a single memory); no runtime flag, baseline emit.
    if (head === 'memory.copy') {
      requireArity(3);
      compileExpr(expr[2], func, depth, bytes);   // dst
      compileExpr(expr[3], func, depth, bytes);   // src
      compileExpr(expr[4], func, depth, bytes);   // len
      bytes.push(0xFC, 0x0A, 0x00, 0x00);
      return bytes;
    }
    if (head === 'memory.fill') {
      requireArity(3);
      compileExpr(expr[2], func, depth, bytes);   // dst
      compileExpr(expr[3], func, depth, bytes);   // val
      compileExpr(expr[4], func, depth, bytes);   // len
      bytes.push(0xFC, 0x0B, 0x00);
      return bytes;
    }

    // ── WASM SIMD (0xFD prefix) — shared v128 host layer (SIMD track, 2026-08-12) ──
    // Two consumers: (1) guest ARM NEON emulation in src/arm-simd.watx (B-owned; host
    // v128 collapses per-lane loops to ~3 instrs on the mappable subset); (2) raster /
    // alpha-blend inner loops in framework-drawpass + graphics-canvas (RES-owned; 4x
    // i32 pixels per iteration). Kernel migrations are O-gated for BIT-EXACTNESS vs the
    // existing scalar reference and keep a scalar fallback for ops with no host
    // equivalent (saturating/rounding variants, pairwise/reductions, PMULL, TBL/TBX).
    //
    // Prefix encoding: 0xFD + ULEB128(subop). Subops <128 fit in one byte; higher subops
    // (e.g. i16x8.add=0x8E, f64x2.add=0xF0) take two bytes — encodeULEB128 handles both.

    // Binary ops (v128, v128) -> v128. Includes lane cmp (each yields a v128 lane mask
    // of all-ones / all-zeros per lane, WASM SIMD spec) and lane-narrowing.
    const simdBinOps = WATX_SIMD_BINARY_OPS || (WATX_SIMD_BINARY_OPS = {
      // Bitwise logic — v128.andnot = A AND NOT B (maps to NEON BIC).
      'v128.and': 0x4E, 'v128.andnot': 0x4F, 'v128.or': 0x50, 'v128.xor': 0x51,
      // Lane arithmetic
      'i8x16.add': 0x6E, 'i8x16.sub': 0x71,
      'i16x8.add': 0x8E, 'i16x8.sub': 0x91, 'i16x8.mul': 0x95,
      'i32x4.add': 0xAE, 'i32x4.sub': 0xB1, 'i32x4.mul': 0xB5,
      'i64x2.add': 0xCE, 'i64x2.sub': 0xD1, 'i64x2.mul': 0xD5,
      'f32x4.add': 0xE4, 'f32x4.sub': 0xE5, 'f32x4.mul': 0xE6, 'f32x4.div': 0xE7,
      'f32x4.min': 0xE8, 'f32x4.max': 0xE9, 'f32x4.pmin': 0xEA, 'f32x4.pmax': 0xEB,
      'f64x2.add': 0xF0, 'f64x2.sub': 0xF1, 'f64x2.mul': 0xF2, 'f64x2.div': 0xF3,
      'f64x2.min': 0xF4, 'f64x2.max': 0xF5, 'f64x2.pmin': 0xF6, 'f64x2.pmax': 0xF7,
      // Integer min/max (signed + unsigned)
      'i8x16.min_s': 0x76, 'i8x16.min_u': 0x77, 'i8x16.max_s': 0x78, 'i8x16.max_u': 0x79,
      'i16x8.min_s': 0x96, 'i16x8.min_u': 0x97, 'i16x8.max_s': 0x98, 'i16x8.max_u': 0x99,
      'i32x4.min_s': 0xB6, 'i32x4.min_u': 0xB7, 'i32x4.max_s': 0xB8, 'i32x4.max_u': 0xB9,
      // Lane comparisons (produce v128 masks)
      'i8x16.eq':   0x23, 'i8x16.ne':   0x24,
      'i8x16.lt_s': 0x25, 'i8x16.lt_u': 0x26, 'i8x16.gt_s': 0x27, 'i8x16.gt_u': 0x28,
      'i8x16.le_s': 0x29, 'i8x16.le_u': 0x2A, 'i8x16.ge_s': 0x2B, 'i8x16.ge_u': 0x2C,
      'i16x8.eq':   0x2D, 'i16x8.ne':   0x2E,
      'i16x8.lt_s': 0x2F, 'i16x8.lt_u': 0x30, 'i16x8.gt_s': 0x31, 'i16x8.gt_u': 0x32,
      'i16x8.le_s': 0x33, 'i16x8.le_u': 0x34, 'i16x8.ge_s': 0x35, 'i16x8.ge_u': 0x36,
      'i32x4.eq':   0x37, 'i32x4.ne':   0x38,
      'i32x4.lt_s': 0x39, 'i32x4.lt_u': 0x3A, 'i32x4.gt_s': 0x3B, 'i32x4.gt_u': 0x3C,
      'i32x4.le_s': 0x3D, 'i32x4.le_u': 0x3E, 'i32x4.ge_s': 0x3F, 'i32x4.ge_u': 0x40,
      'f32x4.eq':   0x41, 'f32x4.ne':   0x42,
      'f32x4.lt':   0x43, 'f32x4.gt':   0x44, 'f32x4.le':   0x45, 'f32x4.ge':   0x46,
      'f64x2.eq':   0x47, 'f64x2.ne':   0x48,
      'f64x2.lt':   0x49, 'f64x2.gt':   0x4A, 'f64x2.le':   0x4B, 'f64x2.ge':   0x4C,
      // Lane-narrowing (pairs of narrow-source lanes -> destination lanes)
      'i8x16.narrow_i16x8_s': 0x65, 'i8x16.narrow_i16x8_u': 0x66,
      'i16x8.narrow_i32x4_s': 0x85, 'i16x8.narrow_i32x4_u': 0x86,
      // ── Migration gap G2: standard fixed-width SIMD ops that were absent ──
      // Saturating add/sub. These are the reason the class matters: the unsaturated
      // twin computes a DIFFERENT number for the same inputs (0xF0 + 0x30 is 0xFF here
      // and 0x20 for i8x16.add), so a missing entry cannot be papered over.
      'i8x16.add_sat_s': 0x6F, 'i8x16.add_sat_u': 0x70,
      'i8x16.sub_sat_s': 0x72, 'i8x16.sub_sat_u': 0x73,
      'i16x8.add_sat_s': 0x8F, 'i16x8.add_sat_u': 0x90,
      'i16x8.sub_sat_s': 0x92, 'i16x8.sub_sat_u': 0x93,
      // Rounding average (NEON URHADD) and the Q15 fixed-point multiply.
      'i8x16.avgr_u': 0x7B, 'i16x8.avgr_u': 0x9B, 'i16x8.q15mulr_sat_s': 0x82,
      // Widening multiply of one half of each source, and the i16 pairwise dot product.
      'i16x8.extmul_low_i8x16_s':  0x9C, 'i16x8.extmul_high_i8x16_s': 0x9D,
      'i16x8.extmul_low_i8x16_u':  0x9E, 'i16x8.extmul_high_i8x16_u': 0x9F,
      'i32x4.extmul_low_i16x8_s':  0xBC, 'i32x4.extmul_high_i16x8_s': 0xBD,
      'i32x4.extmul_low_i16x8_u':  0xBE, 'i32x4.extmul_high_i16x8_u': 0xBF,
      'i64x2.extmul_low_i32x4_s':  0xDC, 'i64x2.extmul_high_i32x4_s': 0xDD,
      'i64x2.extmul_low_i32x4_u':  0xDE, 'i64x2.extmul_high_i32x4_u': 0xDF,
      'i32x4.dot_i16x8_s': 0xBA,
      // i64x2 comparisons (signed only — the proposal defines no unsigned i64 compares).
      'i64x2.eq':   0xD6, 'i64x2.ne':   0xD7,
      'i64x2.lt_s': 0xD8, 'i64x2.gt_s': 0xD9, 'i64x2.le_s': 0xDA, 'i64x2.ge_s': 0xDB,
    });
    if (simdBinOps[head] !== undefined) {
      requireArity(2);
      compileExpr(expr[2], func, depth, bytes);
      compileExpr(expr[3], func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(simdBinOps[head]);
      return bytes;
    }

    // Unary ops (v128) -> v128 (includes widening extends — one operand, no lane imm).
    const simdUnaryOps = WATX_SIMD_UNARY_OPS || (WATX_SIMD_UNARY_OPS = {
      'v128.not':  0x4D,
      'i8x16.abs': 0x60, 'i8x16.neg': 0x61, 'i8x16.popcnt': 0x62,
      'i16x8.abs': 0x80, 'i16x8.neg': 0x81,
      'i32x4.abs': 0xA0, 'i32x4.neg': 0xA1,
      'i64x2.abs': 0xC0, 'i64x2.neg': 0xC1,
      'f32x4.abs': 0xE0, 'f32x4.neg': 0xE1, 'f32x4.sqrt': 0xE3,
      'f64x2.abs': 0xEC, 'f64x2.neg': 0xED, 'f64x2.sqrt': 0xEF,
      // Widening extends (Nx2 -> N/2x4 lanes)
      'i16x8.extend_low_i8x16_s':  0x87, 'i16x8.extend_high_i8x16_s': 0x88,
      'i16x8.extend_low_i8x16_u':  0x89, 'i16x8.extend_high_i8x16_u': 0x8A,
      'i32x4.extend_low_i16x8_s':  0xA7, 'i32x4.extend_high_i16x8_s': 0xA8,
      'i32x4.extend_low_i16x8_u':  0xA9, 'i32x4.extend_high_i16x8_u': 0xAA,
      // ── Migration gap G2 ──
      'i64x2.extend_low_i32x4_s':  0xC7, 'i64x2.extend_high_i32x4_s': 0xC8,
      'i64x2.extend_low_i32x4_u':  0xC9, 'i64x2.extend_high_i32x4_u': 0xCA,
      // Pairwise widening add (NEON [SU]ADDLP).
      'i16x8.extadd_pairwise_i8x16_s': 0x7C, 'i16x8.extadd_pairwise_i8x16_u': 0x7D,
      'i32x4.extadd_pairwise_i16x8_s': 0x7E, 'i32x4.extadd_pairwise_i16x8_u': 0x7F,
      // Float rounding.
      'f32x4.ceil': 0x67, 'f32x4.floor': 0x68, 'f32x4.trunc': 0x69, 'f32x4.nearest': 0x6A,
      'f64x2.ceil': 0x74, 'f64x2.floor': 0x75, 'f64x2.trunc': 0x7A, 'f64x2.nearest': 0x94,
      // Width changes between the float shapes.
      'f32x4.demote_f64x2_zero': 0x5E, 'f64x2.promote_low_f32x4': 0x5F,
      // int <-> float converts. The _s / _u pair is a real behavioural fork: the same
      // 0xFFFFFFFF lane is -1.0 signed and 4294967296.0 unsigned, so a table entry
      // pointing at the wrong one of the pair is silent until the numbers are read.
      'i32x4.trunc_sat_f32x4_s': 0xF8, 'i32x4.trunc_sat_f32x4_u': 0xF9,
      'f32x4.convert_i32x4_s':   0xFA, 'f32x4.convert_i32x4_u':   0xFB,
      'i32x4.trunc_sat_f64x2_s_zero': 0xFC, 'i32x4.trunc_sat_f64x2_u_zero': 0xFD,
      'f64x2.convert_low_i32x4_s':    0xFE, 'f64x2.convert_low_i32x4_u':    0xFF,
    });
    if (simdUnaryOps[head] !== undefined) {
      requireArity(1);
      compileExpr(expr[2], func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(simdUnaryOps[head]);
      return bytes;
    }

    // bitmask — (v128) -> i32. Structurally a unary op, but its RESULT is a scalar, so
    // it lives in its own table: the shape-prefix return-type inference below must not
    // type it as v128 (that would sink an i32 into a v128 local and fail validation).
    const simdBitmaskOps = WATX_SIMD_BITMASK_OPS || (WATX_SIMD_BITMASK_OPS = {
      'i8x16.bitmask': 0x64, 'i16x8.bitmask': 0x84,
      'i32x4.bitmask': 0xA4, 'i64x2.bitmask': 0xC4,
    });
    if (simdBitmaskOps[head] !== undefined) {
      requireArity(1);
      compileExpr(expr[2], func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(simdBitmaskOps[head]);
      return bytes;
    }

    // Shift ops (v128, i32) -> v128. Shift amount is a scalar i32, not a lane immediate.
    const simdShiftOps = WATX_SIMD_SHIFT_OPS || (WATX_SIMD_SHIFT_OPS = {
      'i8x16.shl': 0x6B, 'i8x16.shr_s': 0x6C, 'i8x16.shr_u': 0x6D,
      'i16x8.shl': 0x8B, 'i16x8.shr_s': 0x8C, 'i16x8.shr_u': 0x8D,
      'i32x4.shl': 0xAB, 'i32x4.shr_s': 0xAC, 'i32x4.shr_u': 0xAD,
      'i64x2.shl': 0xCB, 'i64x2.shr_s': 0xCC, 'i64x2.shr_u': 0xCD,
    });
    if (simdShiftOps[head] !== undefined) {
      requireArity(2);
      compileExpr(expr[2], func, depth, bytes);
      compileExpr(expr[3], func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(simdShiftOps[head]);
      return bytes;
    }

    // Splats (scalar) -> v128. Operand's WASM type is fixed per shape: i32 for the
    // integer lane splats (WASM auto-truncates for narrow widths), f32 for f32x4, i64
    // for i64x2, f64 for f64x2.
    const simdSplatOps = WATX_SIMD_SPLAT_OPS || (WATX_SIMD_SPLAT_OPS = {
      'i8x16.splat': 0x0F, 'i16x8.splat': 0x10, 'i32x4.splat': 0x11,
      'i64x2.splat': 0x12, 'f32x4.splat': 0x13, 'f64x2.splat': 0x14,
    });
    if (simdSplatOps[head] !== undefined) {
      requireArity(1);
      compileExpr(expr[2], func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(simdSplatOps[head]);
      return bytes;
    }

    // Parse a compile-time integer immediate that WATX writers spell either as a bare
    // number literal (`5`) OR as an `(i32.const 5)` subform. Lane indices, shuffle
    // lane maps, and v128.const byte values are all in this shape. Silent-fail here
    // was the ROOT of B->SIMD 2026-08-12: `(i64x2.extract_lane $res (i32.const 1))`
    // read `expr.value` on the ARRAY, got undefined, fell back to 0, and both the
    // low and high lanes extracted from lane 0 -- looked EXACTLY like v128.load
    // splatting the low 64 bits (which was the wrong diagnosis; v128.load itself
    // is correct). Any WATX form written in the natural WAT-style (i32.const N)
    // must yield N here, not 0.
    function immVal(tok, dflt) {
      if (tok == null) return dflt;
      // (i32.const N) subform: array with head 'i32.const' and a number/symbol arg.
      if (Array.isArray(tok) && (V(tok[1]) === 'i32.const' || V(tok[1]) === 'i64.const')) {
        const inner = tok[2];
        if (V(inner) != null) return parseInt(V(inner));
        return dflt;
      }
      // Bare number / symbol token. Deliberately NOT strict: immVal is also
      // handed shape tokens like the `i32x4` of a (v128.const i32x4 ...), and it
      // is expected to fall through to the default on those. Lane immediates,
      // which are the positions where a truncated literal would be silently
      // wrong, go through laneImm below and ARE strict.
      if (V(tok) != null) return parseInt(V(tok));
      return dflt;
    }

    // ── Lane immediates (migration gaps G6 + G7) ────────────────────────────────
    // Standard WAT puts the lane immediate FIRST, straight after the opcode:
    //     (i32x4.replace_lane 3 VEC VAL)   (i64x2.extract_lane 1 VEC)
    //     (i8x16.shuffle l0 l1 ... l15 A B)
    // WATX historically wrote the vector operands first and the lane(s) after. BOTH
    // orders are accepted, unconditionally and with no flag: standard WAT is what the
    // real source trees are written in (all 88 lane sites in Wine-Assembly are
    // lane-first), and the WATX order is what the existing arm-simd / raster trees use.
    // Telling them apart is unambiguous — a lane immediate is always a bare number or an
    // (iNN.const N) form, and a v128 operand can never be either.
    function isLaneToken(tok) {
      if (tok == null) return false;
      if (Array.isArray(tok)) return V(tok[1]) === 'i32.const' || V(tok[1]) === 'i64.const';
      return T(tok) === 'number';
    }
    // Strict lane immediate. `immVal` above defaults an unreadable immediate to 0 — and
    // that default is how the 2026-08-12 "every lane reads lane 0" bug survived both
    // compilation AND wasm validation, where it was misdiagnosed as a broken v128.load
    // (see immVal's own comment). A lane index is never optional and is never a runtime
    // value, so this throws instead of guessing, and range-checks the result.
    function laneImm(tok, opName, laneCount, what) {
      if (tok == null) {
        throw new Error(`${opName}: missing its ${what} immediate (expected a constant 0..${laneCount - 1})`);
      }
      let n;
      if (Array.isArray(tok)) {
        const inner = V(tok[1]);
        if (inner !== 'i32.const' && inner !== 'i64.const') {
          throw new Error(`${opName}: ${what} immediate must be a compile-time constant, got a '${inner}' form`);
        }
        n = watxParseIntLiteral(V(tok[2]), `${opName} ${what} immediate`);
      } else if (T(tok) === 'number') {
        n = watxParseIntLiteral(V(tok), `${opName} ${what} immediate`);
      } else {
        throw new Error(`${opName}: ${what} immediate must be a compile-time constant, got '${V(tok)}'`);
      }
      if (!Number.isInteger(n) || n < 0 || n >= laneCount) {
        throw new Error(`${opName}: ${what} immediate '${V(tok)}' is out of range 0..${laneCount - 1}`);
      }
      return n;
    }
    function lanesOfShape(shapeHead) {
      if (shapeHead.indexOf('i8x16.') === 0) return 16;
      if (shapeHead.indexOf('i16x8.') === 0) return 8;
      if (shapeHead.indexOf('i32x4.') === 0 || shapeHead.indexOf('f32x4.') === 0) return 4;
      return 2; // i64x2 / f64x2
    }

    // extract_lane: (v128) + lane -> scalar. Encoded 0xFD subop LaneIdx.
    const simdExtractOps = {
      'i8x16.extract_lane_s': 0x15, 'i8x16.extract_lane_u': 0x16,
      'i16x8.extract_lane_s': 0x18, 'i16x8.extract_lane_u': 0x19,
      'i32x4.extract_lane':   0x1B, 'i64x2.extract_lane':   0x1D,
      'f32x4.extract_lane':   0x1F, 'f64x2.extract_lane':   0x21,
    };
    if (simdExtractOps[head] !== undefined) {
      requireArity(2);
      const laneFirst = isLaneToken(expr[2]);
      const vecExpr = laneFirst ? expr[3] : expr[2];
      const laneTok = laneFirst ? expr[2] : expr[3];
      const lane = laneImm(laneTok, head, lanesOfShape(head), 'lane');
      if (!vecExpr) throw new Error(`${head} is missing its vector operand`);
      compileExpr(vecExpr, func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(simdExtractOps[head]);
      bytes.byte(lane);
      return bytes;
    }
    // replace_lane: (v128, scalar) + lane -> v128.
    const simdReplaceOps = {
      'i8x16.replace_lane': 0x17, 'i16x8.replace_lane': 0x1A,
      'i32x4.replace_lane': 0x1C, 'i64x2.replace_lane': 0x1E,
      'f32x4.replace_lane': 0x20, 'f64x2.replace_lane': 0x22,
    };
    if (simdReplaceOps[head] !== undefined) {
      requireArity(3);
      const laneFirst = isLaneToken(expr[2]);
      const vecExpr = laneFirst ? expr[3] : expr[2];
      const laneTok = laneFirst ? expr[2] : expr[3];
      const valExpr = expr[4];
      const lane = laneImm(laneTok, head, lanesOfShape(head), 'lane');
      if (!vecExpr) throw new Error(`${head} is missing its vector operand`);
      if (!valExpr) throw new Error(`${head} is missing its replacement value operand`);
      compileExpr(vecExpr, func, depth, bytes);
      compileExpr(valExpr, func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(simdReplaceOps[head]);
      bytes.byte(lane);
      return bytes;
    }

    // i8x16.shuffle — two vectors and 16 lane bytes, each 0..31 (0..15 = lanes of A,
    // 16..31 = lanes of B). Standard WAT writes the lanes first; the WATX order put the
    // vectors first. Both are accepted (gap G7), and a short or out-of-range lane list is
    // a hard error rather than a silent pad with zeros.
    if (head === 'i8x16.shuffle') {
      requireArity(18);
      const laneFirst = isLaneToken(expr[2]);
      const aExpr = laneFirst ? expr[18] : expr[2];
      const bExpr = laneFirst ? expr[19] : expr[3];
      const laneBase = laneFirst ? 2 : 4;
      const lanes = [];
      for (let i = 0; i < 16; i++) lanes.push(laneImm(expr[laneBase + i], head, 32, `lane ${i}`));
      if (!aExpr || !bExpr) throw new Error(`${head} needs two vector operands alongside its 16 lane bytes`);
      compileExpr(aExpr, func, depth, bytes);
      compileExpr(bExpr, func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(0x0D);
      for (const l of lanes) bytes.push(l);
      return bytes;
    }
    // i8x16.swizzle (v128 vec, v128 idx) -> v128 — dynamic per-lane byte pick.
    if (head === 'i8x16.swizzle') {
      requireArity(2);
      compileExpr(expr[2], func, depth, bytes);
      compileExpr(expr[3], func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(0x0E);
      return bytes;
    }

    // ── v128 memory operations (migration gap G3) ───────────────────────────────
    // These used to hard-code `align=4 offset=0` and reject a memarg outright
    // ("Unknown symbol 'offset=16'"), so `(v128.load offset=16 …)` — ordinary standard
    // WAT — could not be compiled at all. They now go through the same parseMemarg used
    // by the scalar loads/stores. The whole v128 memory family is here, not just the
    // plain load/store: the splat and widening loads, the zero-extending loads, and the
    // per-lane load/store forms which carry a memarg AND a lane immediate.
    //
    // align= is a HINT on these (unlike the atomics), so a non-natural value is accepted
    // and encoded as given; only a non-power-of-two is an error.
    const simdMemOps = WATX_SIMD_MEM_OPS || (WATX_SIMD_MEM_OPS = {
      // name: [subop, natural align log2, isStore]
      'v128.load':         [0x00, 4, false],
      'v128.load8x8_s':    [0x01, 3, false], 'v128.load8x8_u':   [0x02, 3, false],
      'v128.load16x4_s':   [0x03, 3, false], 'v128.load16x4_u':  [0x04, 3, false],
      'v128.load32x2_s':   [0x05, 3, false], 'v128.load32x2_u':  [0x06, 3, false],
      'v128.load8_splat':  [0x07, 0, false], 'v128.load16_splat':[0x08, 1, false],
      'v128.load32_splat': [0x09, 2, false], 'v128.load64_splat':[0x0A, 3, false],
      'v128.load32_zero':  [0x5C, 2, false], 'v128.load64_zero': [0x5D, 3, false],
      'v128.store':        [0x0B, 4, true],
    });
    if (simdMemOps[head] !== undefined) {
      const [subop, natural, isStore] = simdMemOps[head];
      const ma = parseMemarg(expr, 1, head, natural, false);
      requireArity(ma.next + (isStore ? 1 : 0));
      let operand = ma.next;
      if (!expr[operand + 1]) throw new Error(`${head} is missing its address operand`);
      compileExpr(expr[(operand++) + 1], func, depth, bytes);
      if (isStore) {
        if (!expr[operand + 1]) throw new Error(`${head} is missing its value operand`);
        compileExpr(expr[operand + 1], func, depth, bytes);
      }
      bytes.byte(0xFD);
      bytes.uleb(subop);
      bytes.uleb(ma.align);
      bytes.uleb(ma.offset);
      // Legacy WATX convention: stores yield i32 0 so expression trees compose. Standard
      // WAT mode leaves the stack alone, matching the scalar stores.
      if (isStore && !standardWat) {
        bytes.byte(OP.i32_const);
        bytes.sleb(0);
      }
      return bytes;
    }
    // Per-lane memory ops: memarg, then a lane immediate, then (addr) or (addr, vec).
    //   (v128.load32_lane offset=4 3 ADDR VEC)  /  (v128.store32_lane offset=4 3 ADDR VEC)
    const simdLaneMemOps = WATX_SIMD_LANE_MEM_OPS || (WATX_SIMD_LANE_MEM_OPS = {
      // name: [subop, natural align log2, lane count, isStore]
      'v128.load8_lane':   [0x54, 0, 16, false], 'v128.load16_lane':  [0x55, 1, 8, false],
      'v128.load32_lane':  [0x56, 2,  4, false], 'v128.load64_lane':  [0x57, 3, 2, false],
      'v128.store8_lane':  [0x58, 0, 16, true],  'v128.store16_lane': [0x59, 1, 8, true],
      'v128.store32_lane': [0x5A, 2,  4, true],  'v128.store64_lane': [0x5B, 3, 2, true],
    });
    if (simdLaneMemOps[head] !== undefined) {
      const [subop, natural, laneCount, isStore] = simdLaneMemOps[head];
      const ma = parseMemarg(expr, 1, head, natural, false);
      requireArity(ma.next + 2);
      let operand = ma.next;
      const lane = laneImm(expr[operand + 1], head, laneCount, 'lane');
      operand++;
      if (!expr[operand + 1]) throw new Error(`${head} is missing its address operand`);
      compileExpr(expr[(operand++) + 1], func, depth, bytes);
      if (!expr[operand + 1]) throw new Error(`${head} is missing its vector operand`);
      compileExpr(expr[operand + 1], func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(subop);
      bytes.uleb(ma.align);
      bytes.uleb(ma.offset);
      bytes.byte(lane);
      if (isStore && !standardWat) {
        bytes.byte(OP.i32_const);
        bytes.sleb(0);
      }
      return bytes;
    }

    // v128.const — the 16 immediate bytes of a SIMD constant, in TWO spellings.
    //
    //   WATX byte-wise:  (v128.const b0 b1 ... b15)          -- 16 bytes, as written
    //   standard WAT:    (v128.const i32x4 0x80000000 ... )  -- a SHAPE token, then
    //                                                           one literal per lane
    //
    // The shape spelling used to be a SILENT MISCOMPILE (found 2026-08-31 by the
    // wabt differential oracle; reproducer tools/watx-repro/v128-const-shape.js).
    // This branch read exactly 16 operands and wrote each one `& 0xff`, with no
    // idea a shape token could be there: the token itself landed in lane 0 as a
    // 0 (immVal ran parseInt('i8x16') -> NaN -> the default), every later lane
    // shifted one position, the 16th was DROPPED, and under a shape wider than
    // i8x16 each lane was truncated to a single byte — so `i32x4 ... 0xffffffff`
    // put one 0xff byte where four belong and the other three bytes of that lane
    // came from the neighbouring operands. It compiled, it validated, it ran; it
    // just computed with a constant nobody wrote.
    //
    // Both spellings are accepted, and they are unambiguous: a shape token is a
    // symbol atom, and a byte-wise operand is always a number (or an (i32.const N)
    // subform). Anything else in the first position — a misspelled shape such as
    // `i16x4`, or any other symbol — is a LOCATED error rather than a guess.
    if (head === 'v128.const') {
      const where = `v128.const in function ${func.name}`;
      // lanes, and bytes per lane; the product is always 16.
      const V128_SHAPES = {
        i8x16: [16, 1], i16x8: [8, 2], i32x4: [4, 4], i64x2: [2, 8],
        f32x4: [4, 4], f64x2: [2, 8],
      };
      const v128Fail = (msg) => {
        const e = new Error(`${where}: ${msg}`);
        const loc = watxFormLoc(expr);
        if (loc !== undefined) { e.line = watxNodeLine(loc); e.col = watxNodeCol(loc); e.file = watxNodeFile(loc); }
        return e;
      };
      const first = expr[2];
      const shapeName = (!Array.isArray(first) && T(first) === 'symbol') ? V(first) : null;
      const nOperands = watxFormLength(expr) - 1;

      let lanes;
      if (shapeName !== null) {
        const shape = V128_SHAPES[shapeName];
        if (shape === undefined) {
          throw v128Fail(
            `'${shapeName}' is not a v128 shape — expected one of ` +
            `${Object.keys(V128_SHAPES).join(', ')} (or the WATX byte-wise form, ` +
            `16 bare byte values with no shape token)`);
        }
        const [count, width] = shape;
        if (nOperands - 1 !== count) {
          throw v128Fail(
            `shape ${shapeName} takes exactly ${count} lane value(s), got ${nOperands - 1}`);
        }
        lanes = [];
        const isFloat = shapeName.charCodeAt(0) === 102; // 'f'
        for (let i = 0; i < count; i++) {
          const raw = V(expr[3 + i]);
          if (Array.isArray(expr[3 + i]) || raw == null || T(expr[3 + i]) === 'string') {
            throw v128Fail(`lane ${i} of ${shapeName} is not a numeric literal`);
          }
          if (isFloat) {
            // Same encoder as a scalar `f32.const`, so a lane may be written
            // `inf`, `nan:0x1` or a hex float exactly like a scalar can — and a
            // NaN lane keeps its payload instead of being normalized by a store
            // through a DataView.
            const encoded = watxFloatLiteralBytes(raw, `lane ${i} of ${shapeName} in ${where}`, width);
            for (let b = 0; b < width; b++) lanes.push(encoded[b]);
          } else {
            // Every integer shape goes through the i64 literal path, so a lane
            // written 0x80000000 or -1 lands as the two's-complement bit pattern
            // rather than a JS Number that has already lost the sign bit.
            const v = BigInt.asUintN(64, parseI64Literal(raw));
            for (let b = 0; b < width; b++) lanes.push(Number((v >> BigInt(8 * b)) & 0xffn));
          }
        }
      } else {
        // WATX byte-wise form. Strict on arity for the same reason every other
        // literal position here is: a missing operand used to zero-pad and an
        // extra one used to be dropped, both silently.
        if (nOperands !== 16) {
          throw v128Fail(
            `the byte-wise form takes exactly 16 byte values, got ${nOperands} ` +
            `(a standard-WAT constant starts with a shape token: i8x16, i32x4, …)`);
        }
        lanes = [];
        for (let i = 0; i < 16; i++) lanes.push(immVal(expr[2 + i], 0) & 0xff);
      }

      bytes.byte(0xFD);
      bytes.uleb(0x0C);
      for (let i = 0; i < 16; i++) bytes.push(lanes[i]);
      return bytes;
    }

    // any_true / all_true — reductions (v128) -> i32.
    if (head === 'v128.any_true') {
      requireArity(1);
      compileExpr(expr[2], func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(0x53);
      return bytes;
    }
    const simdAllTrueOps = {
      'i8x16.all_true': 0x63, 'i16x8.all_true': 0x83,
      'i32x4.all_true': 0xA3, 'i64x2.all_true': 0xC3,
    };
    if (simdAllTrueOps[head] !== undefined) {
      requireArity(1);
      compileExpr(expr[2], func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(simdAllTrueOps[head]);
      return bytes;
    }
    // bitselect (a b mask) -> v128
    if (head === 'v128.bitselect') {
      requireArity(3);
      compileExpr(expr[2], func, depth, bytes);
      compileExpr(expr[3], func, depth, bytes);
      compileExpr(expr[4], func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(0x52);
      return bytes;
    }

    // ── local.get / local.set / local.tee ──
    if (head === 'local.get') {
      requireArity(1);
      const name = V(expr[2]);
      const numeric = /^\d+$/.test(name || '') ? parseInt(name) : undefined;
      const localIdx = numeric ?? func.activeLocal.get(name) ?? func.localMap.get(name);
      if (localIdx === undefined || localIdx >= func.params.length + func.locals.length) throw new Error(`Unknown local '${name}' in ${func.name}`);
      bytes.byte(OP.local_get);
      bytes.uleb(localIdx);
      return bytes;
    }
    
    if (head === 'local.set' || head === 'local.tee' || head === 'set!') {
      requireArity(2);
      const name = V(expr[2]);
      const numeric = /^\d+$/.test(name || '') ? parseInt(name) : undefined;
      const localIdx = numeric ?? func.activeLocal.get(name) ?? func.localMap.get(name);
      if (localIdx === undefined || localIdx >= func.params.length + func.locals.length) throw new Error(`Unknown local '${name}' in ${func.name}`);
      if (!expr[3]) throw new Error(`${head} for '${name}' is missing a value`);
      compileExpr(expr[3], func, depth, bytes);
      bytes.byte(head === 'local.tee' ? OP.local_tee : OP.local_set);
      bytes.uleb(localIdx);
      if (!standardWat && head !== 'local.tee') {
        bytes.byte(OP.i32_const);
        bytes.sleb(0);
      }
      return bytes;
    }
    
    // ── (local $x type) — WAT-style declaration ──
    // Pure declaration: the slot is already allocated by collectLocals, so this
    // emits nothing. Without this handler the generic fallback would try to
    // "compile" the bare type symbol (e.g. `i32`) as an expression.
    if (head === 'local') {
      requireArity(2);
      return bytes;
    }

    // ── let — local variable binding ──
    if (head === 'let') {
      const name = V(expr[2]);
      let initExpr, declaredType;
      
      // (let $name type init) or (let $name init)
      if ((expr.length - 1) >= 4 && T(expr[3]) === 'symbol' &&
          ['i32','i64','f32','f64','v128','u8','ptr','weak'].includes(V(expr[3]))) {
        requireArity(3);
        declaredType = V(expr[3]);
        initExpr = expr[4];
      } else {
        requireArity(2);
        initExpr = expr[3];
      }
      
      if (name && func.localMap.has(name) && initExpr) {
        // Pick the physical slot matching THIS let's type. For a name declared
        // with one type everywhere this is just localMap; for a name reused with
        // different types in sibling scopes (collision), select the slot of the
        // matching type and make it the active binding for subsequent refs.
        let slotType = declaredType;
        if (!slotType) {
          // Resolve bare-symbol inits against the function's known local/param
          // types so the chosen slot matches the value type (same fix as
          // collectLocals — keeps declaration and emit in agreement).
          const symT = new Map();
          for (const [nm, arr] of func.localSlots) if (arr && arr.length) symT.set(nm, arr[0].type);
          slotType = inferExprType(initExpr, symT);
        }
        if (slotType === 'u8' || slotType === 'ptr' || slotType === 'weak') slotType = 'i32';
        const slots = func.localSlots.get(name) || [];
        const match = slots.find(s => s.type === slotType);
        const localIdx = match ? match.index : func.localMap.get(name);
        func.activeLocal.set(name, localIdx);
        compileExpr(initExpr, func, depth, bytes);
        bytes.byte(OP.local_tee);
        bytes.uleb(localIdx);
      } else {
        bytes.byte(OP.i32_const);
        bytes.sleb(0);
      }
      return bytes;
    }

    // ── call ──
    if (head === 'call') {
      const funcName = V(expr[2]);
      const callIdx = funcIndexMap.get(funcName);
      if (callIdx !== undefined) {
        const expected = expectedParamCount(funcName);
        if (expected !== undefined && (expr.length - 1) - 2 !== expected) throw new Error(`call ${funcName}: expected ${expected} args, got ${(expr.length - 1) - 2}`);
        for (let i = 2; i < (expr.length - 1); i++) {
          compileExpr(expr[i + 1], func, depth, bytes);
        }
        bytes.byte(OP.call);
        bytes.uleb(callIdx);
      } else {
        // Unknown function — a call to an undeclared function is a typo or a
        // missing definition. The old behavior (warn + unreachable) produced a
        // binary that silently traps only when that path executes; make it a
        // hard compile error instead.
        const e = new Error(
          `Unknown function '${funcName}' called in ${func.name}: ` +
          `no such import, builtin, or user function (typo or missing definition?).`);
        e.line = watxNodeLine(expr);
        e.col = watxNodeCol(expr);
        e.file = watxNodeFile(expr);
        throw e;
      }
      return bytes;
    }

    // ── call_indirect / return_call_indirect (threaded-code dispatch) ──
    //   (call_indirect (type (param ...) (result ...)) idxExpr arg0 ... argN)
    // Stack discipline: push args, then the table index on top, then the op.
    if (head === 'call_indirect' || head === 'return_call_indirect') {
      const sig = parseIndirectSig(expr[2]);
      const typeIdx = getTypeIdx(sig.params, sig.results);
      if ((expr.length - 1) - 3 !== sig.params.length) throw new Error(`${head}: expected ${sig.params.length} args, got ${(expr.length - 1) - 3}`);
      if (standardWat) {
        // Standard folded WAT orders operands as args..., table-index.
        for (let i = 2; i < (expr.length - 1) - 1; i++) compileExpr(expr[i + 1], func, depth, bytes);
        compileExpr(expr[expr.length - 1], func, depth, bytes);
      } else {
        // Historical WATX spelling orders table-index first, then args.
        for (let i = 3; i < (expr.length - 1); i++) compileExpr(expr[i + 1], func, depth, bytes);
        compileExpr(expr[3], func, depth, bytes);
      }
      bytes.push(head === 'call_indirect' || !tailCalls ? OP.call_indirect : OP.return_call_indirect);
      bytes.uleb(typeIdx);
      bytes.uleb(0); // table 0
      if (head === 'return_call_indirect' && !tailCalls) bytes.push(OP.return_);
      return bytes;
    }

    // ── return_call (direct tail call) ──  (return_call $fn arg0 ... argN)
    if (head === 'return_call') {
      const callIdx = funcIndexMap.get(V(expr[2]));
      if (callIdx !== undefined) {
        const expected = expectedParamCount(V(expr[2]));
        if (expected !== undefined && (expr.length - 1) - 2 !== expected) throw new Error(`return_call ${V(expr[2])}: expected ${expected} args, got ${(expr.length - 1) - 2}`);
        for (let i = 2; i < (expr.length - 1); i++) compileExpr(expr[i + 1], func, depth, bytes);
        bytes.byte(tailCalls ? OP.return_call : OP.call);
        bytes.uleb(callIdx);
        if (!tailCalls) bytes.push(OP.return_);
      } else {
        const e = new Error(
          `Unknown function '${V(expr[2])}' in return_call in ${func.name}: ` +
          `no such import, builtin, or user function (typo or missing definition?).`);
        e.line = watxNodeLine(expr);
        e.col = watxNodeCol(expr);
        e.file = watxNodeFile(expr);
        throw e;
      }
      return bytes;
    }

    // ── func-slot — the table slot index of a handler, as an i32 const ──
    if (head === 'func-slot') {
      requireArity(1);
      const fn = V(expr[2]);
      const slot = funcSlotMap.get(fn);
      if (slot === undefined) throw new Error(`Function '${fn}' is not present in any element segment/func-table`);
      bytes.byte(OP.i32_const);
      bytes.sleb(slot);
      return bytes;
    }

    // ── if ──
    if (head === 'if') {
      // (if cond then) or (if cond then else alt) or (if type cond then else alt)
      let explicitResultType = null;
      let condIdx = 1;
      
      // Check for explicit type annotation, two accepted forms:
      //   (if f32 cond then else alt)            — bare valtype symbol (incl. v128)
      //   (if (result i32) cond then else alt)   — wasm-style (result T) clause
      if (T(expr[2]) === 'symbol' && ['i32','i64','f32','f64','v128'].includes(V(expr[2]))) {
        explicitResultType = V(expr[2]);
        condIdx = 2;
      } else if (Array.isArray(expr[2]) && V(expr[2][1]) === 'result') {
        // (result T) — take the first declared valtype as the if's block type.
        // "First" is only ever "only": a second one is a multivalue if, which
        // the single-byte block type below cannot express.
        watxRejectMultivalue('if', watxFormSlice(expr[2], 1).map(V), expr[2]);
        const t = V(expr[2][2]);
        explicitResultType = ['i32','i64','f32','f64','v128'].includes(t) ? t : 'i32';
        condIdx = 2;
      }
      
      const condExpr = expr[condIdx + 1];
      
      // Find then/else branches
      let thenExpr = null, elseExpr = null;
      let restIdx = condIdx + 1;
      
      // Look for then branch
      let sawThenForm = false;
      if (restIdx < (expr.length - 1)) {
        if (Array.isArray(expr[restIdx + 1]) && V(expr[restIdx + 1][1]) === 'then') {
          sawThenForm = true;
          thenExpr = expr[restIdx + 1].length === 3 ? expr[restIdx + 1][2] : { _multi: expr[restIdx + 1].slice(2) };
        } else {
          thenExpr = expr[restIdx + 1];
        }
        restIdx++;
      }
      
      // Look for else branch
      if (restIdx < (expr.length - 1)) {
        if (V(expr[restIdx + 1]) === 'else' || T(expr[restIdx + 1]) === 'symbol' && V(expr[restIdx + 1]) === 'else') {
          // bare 'else' keyword — next expr is the else body
          restIdx++;
          if (restIdx < (expr.length - 1)) {
            elseExpr = expr[restIdx + 1];
            restIdx++;
          }
        } else if (Array.isArray(expr[restIdx + 1]) && V(expr[restIdx + 1][1]) === 'else') {
          elseExpr = expr[restIdx + 1].length === 3 ? expr[restIdx + 1][2] : { _multi: expr[restIdx + 1].slice(2) };
          restIdx++;
        } else {
          // Positional: 4th element (after cond, then) is the else.
          // NOT standard WAT — the spec form is (else ...) — and REFUSED since
          // 2026-08-31, the promotion the old warning promised once the closure
          // had no sites left. It has none.
          // Only when the then arm was written in the standard (then ...) form:
          // WATX's own `(if COND A B)` shorthand has no (then ...) either and is a
          // deliberate, documented WATX spelling, not a mistake to refuse.
          if (sawThenForm) failPositionalElse(expr, func);
          elseExpr = expr[restIdx + 1];
          restIdx++;
        }
      }

      // The branches above deliberately accept several spellings, but every
      // accepted spelling still has to consume the whole form. Before this
      // check an expression after the recognized else arm simply vanished.
      if (restIdx !== watxFormLength(expr)) requireArity(restIdx - 1);
      
      // Determine block type by checking if branches actually produce values
      let blockType = VALTYPE.void;
      if (explicitResultType) {
        blockType = VALTYPE[explicitResultType] || VALTYPE.i32;
      } else if (thenExpr && elseExpr) {
        // Check if branches produce values — only then use i32 block type
        const thenLastExpr = thenExpr._multi ? thenExpr._multi[thenExpr._multi.length - 1] : thenExpr;
        const elseLastExpr = elseExpr._multi ? elseExpr._multi[elseExpr._multi.length - 1] : elseExpr;
        const thenProduces = exprProducesValue(thenLastExpr, func);
        const elseProduces = exprProducesValue(elseLastExpr, func);
        if (thenProduces && elseProduces) {
          blockType = VALTYPE.i32; // both branches produce values — treat as i32 expression
        }
        // else: one or both branches are void — keep blockType as void
      }
      
      const isVoidIf = (blockType === VALTYPE.void);
      
      // Emit: condition, if, then-body, [else, else-body], end
      compileExpr(condExpr, func, depth, bytes);
      bytes.push(OP.if_, blockType);
      
      // Push a sentinel label for the if-block scope so that br/br_if
      // depth calculations correctly count through intervening if blocks
      func.blockLabels.push('__if__');
      
      if (thenExpr) {
        if (thenExpr._multi) {
          const multi = thenExpr._multi;
          for (let mi = 0; mi < multi.length; mi++) {
            compileExpr(multi[mi], func, depth + 1, bytes);
            // Drop intermediate values (only keep last if non-void block)
            if (mi < multi.length - 1 && needsAutoDrop(multi[mi], multi[mi + 1], func)) {
              bytes.push(OP.drop);
            } else if (mi === multi.length - 1 && isVoidIf && exprProducesValue(multi[mi], func)) {
              bytes.push(OP.drop);
            }
          }
        } else {
          compileExpr(thenExpr, func, depth + 1, bytes);
          if (isVoidIf && exprProducesValue(thenExpr, func)) {
            bytes.push(OP.drop);
          }
        }
      }
      
      if (elseExpr) {
        bytes.push(OP.else_);
        if (elseExpr._multi) {
          const multi = elseExpr._multi;
          for (let mi = 0; mi < multi.length; mi++) {
            compileExpr(multi[mi], func, depth + 1, bytes);
            // Drop intermediate values (only keep last if non-void block)
            if (mi < multi.length - 1 && needsAutoDrop(multi[mi], multi[mi + 1], func)) {
              bytes.push(OP.drop);
            } else if (mi === multi.length - 1 && isVoidIf && exprProducesValue(multi[mi], func)) {
              bytes.push(OP.drop);
            }
          }
        } else {
          compileExpr(elseExpr, func, depth + 1, bytes);
          if (isVoidIf && exprProducesValue(elseExpr, func)) {
            bytes.push(OP.drop);
          }
        }
      } else if (!isVoidIf) {
        // Typed one-armed if: (if i32 cond (then X)) / (if (result i32) cond (then X))
        // with no else. Wasm requires both arms of a value-typed if to yield the
        // declared type, so a missing else is an arity error. Synthesize an else
        // that pushes a typed zero default — the predictable "cond false" value.
        bytes.push(OP.else_);
        const rt = explicitResultType || 'i32';
        if (rt === 'f32') {
          bytes.byte(OP.f32_const);
          bytes.f32(0);
        }
        else if (rt === 'f64') bytes.push(OP.f64_const, 0, 0, 0, 0, 0, 0, 0, 0);
        else if (rt === 'i64') {
          bytes.byte(OP.i64_const);
          bytes.slebBig(0n);
        } else {
          bytes.byte(OP.i32_const);
          bytes.sleb(0);
        }
      }

      func.blockLabels.pop();
      bytes.push(OP.end);
      return bytes;
    }

    // ── block ──
    if (head === 'block') {
      const label = V(expr[2])?.startsWith('$') ? V(expr[2]) : null;
      let bodyStart = label ? 2 : 1;
      // Migration gap G4: a standard `(block $l (result T) …)` signature. This used to
      // be unparsed and every LABELED block was forced to void on purpose ("its br
      // targets do not carry a result value"), which rejected core WAT that `if` had
      // accepted all along. Both the folded `(result T)` form and the bare-valtype form
      // `if` takes are honoured here.
      const declared = blockSignature(expr[bodyStart + 1], head);
      if (declared !== null) bodyStart++;

      const lastExpr = expr[expr.length - 1];
      // Without a declared signature the old rule stands: an UNLABELED block yields the
      // value of its last expression (so it can be used as an if-arm), a LABELED one
      // stays void.
      const producesValue = declared !== null
        || (!label && (expr.length - 1) > bodyStart && exprProducesValue(lastExpr, func));
      let resultType = VALTYPE.void;
      if (declared !== null) {
        resultType = VALTYPE[declared];
      } else if (producesValue) {
        const symT = new Map();
        for (const [nm, arr] of func.localSlots) if (arr && arr.length) symT.set(nm, arr[0].type);
        resultType = VALTYPE[inferExprType(lastExpr, symT)] || VALTYPE.i32;
      }

      if (label) func.blockLabels.push(label);

      bytes.push(OP.block, resultType);
      for (let i = bodyStart; i < (expr.length - 1); i++) {
        compileExpr(expr[i + 1], func, depth + 1, bytes);
        const isLast = (i === (expr.length - 1) - 1);
        // Drop each statement's value; keep only the last one, and only for a
        // value-producing block.
        if (needsAutoDrop(expr[i + 1], expr[i + 2], func) && !(isLast && producesValue)) {
          bytes.push(OP.drop);
        }
      }
      bytes.push(OP.end);

      if (label) func.blockLabels.pop();
      return bytes;
    }

    // ── loop ──
    if (head === 'loop') {
      const label = V(expr[2])?.startsWith('$') ? V(expr[2]) : null;
      let bodyStart = label ? 2 : 1;
      // A loop's result is what falls out of the BOTTOM of its body — a `br` to a loop
      // label jumps to the top and carries the loop's parameters, not its result.
      const declared = blockSignature(expr[bodyStart + 1], head);
      if (declared !== null) bodyStart++;

      if (label) func.blockLabels.push(label);

      bytes.push(OP.loop, declared !== null ? VALTYPE[declared] : VALTYPE.void);
      for (let i = bodyStart; i < (expr.length - 1); i++) {
        compileExpr(expr[i + 1], func, depth + 1, bytes);
        const isLast = (i === (expr.length - 1) - 1);
        // Drop every statement's value; keep the last one only for a typed loop.
        if (needsAutoDrop(expr[i + 1], expr[i + 2], func) && !(isLast && declared !== null)) {
          bytes.push(OP.drop);
        }
      }
      bytes.push(OP.end);

      if (label) func.blockLabels.pop();
      return bytes;
    }

    // ── br / br_if ──
    if (head === 'br') {
      requireArityOneOf(1, 2);
      const label = V(expr[2]);
      let labelDepth = 0;
      if (label?.startsWith('$')) {
        const idx = func.blockLabels.lastIndexOf(label);
        if (idx < 0) throw new Error(`Unknown branch label '${label}' in ${func.name}`);
        labelDepth = func.blockLabels.length - 1 - idx;
      } else {
        labelDepth = parseInt(label);
        if (!Number.isInteger(labelDepth) || labelDepth < 0 || labelDepth >= func.blockLabels.length + depth) throw new Error(`Invalid branch depth '${label}' in ${func.name}`);
      }
      // Standard folded WAT allows a value operand when the target block is typed:
      // `(br $l VALUE)` (migration gap G4). Without a target signature there is no
      // operand and nothing is emitted here.
      if (expr[3] !== undefined) compileExpr(expr[3], func, depth, bytes);
      bytes.byte(OP.br);
      bytes.uleb(labelDepth);
      return bytes;
    }

    if (head === 'br_if') {
      // `(br_if $l COND)` is the historical WATX/WAT spelling; `(br_if $l VALUE COND)`
      // is the standard folded form for a typed target block — the CONDITION is always
      // the last operand (migration gap G4).
      let label, condExpr, valueExpr = null;
      if (T(expr[2]) === 'symbol' && V(expr[2])?.startsWith('$') && (expr.length - 1) > 2) {
        requireArityOneOf(2, 3);
        label = V(expr[2]);
        if ((expr.length - 1) > 3) { valueExpr = expr[3]; condExpr = expr[4]; }
        else condExpr = expr[3];
      } else {
        requireArity(1);
        label = '0';
        condExpr = expr[2];
      }

      let labelDepth = 0;
      if (label?.startsWith('$')) {
        const idx = func.blockLabels.lastIndexOf(label);
        if (idx < 0) throw new Error(`Unknown branch label '${label}' in ${func.name}`);
        labelDepth = func.blockLabels.length - 1 - idx;
      } else {
        labelDepth = parseInt(label);
        if (!Number.isInteger(labelDepth) || labelDepth < 0 || labelDepth >= func.blockLabels.length + depth) throw new Error(`Invalid branch depth '${label}' in ${func.name}`);
      }
      
      if (valueExpr !== null) compileExpr(valueExpr, func, depth, bytes);
      compileExpr(condExpr, func, depth, bytes);
      bytes.byte(OP.br_if);
      bytes.uleb(labelDepth);
      return bytes;
    }

    // ── br_table ── ORCH GO 2026-08-12, BULK track (COMPILER-REQUESTS.md).
    // Accepted forms (unconditionally):
    //   standard folded WAT: (br_table $l0 $l1 ... $default <idx-expr>)
    //   explicit WATX:       (br_table (labels $l0 $l1 ...) $default <idx-expr>)
    // Encoding:   0x0E + vec(labelIdx)*N + defaultLabelIdx + <idx on stack>
    // Semantics:  pop i32 index; if 0<=index<N branch to labels[index], else branch to default.
    // Reuses the br/br_if label-resolution machinery (blockLabels stack + $name lastIndexOf).
    // Terminal like br (leaves nothing on stack) -- see exprProducesValue above.
    if (head === 'br_table') {
      const firstArg = expr[2];
      const grouped = Array.isArray(firstArg) && V(firstArg[1]) === 'labels';
      // The ordinary spelling consumes every operand before its last two as a
      // target label. The grouped spelling has exactly three operands, so an
      // expression after its index has no possible meaning and must not vanish.
      if (grouped) requireArity(3);
      else requireMinArity(2);
      const labelNodes = grouped ? firstArg.slice(2) : expr.slice(2, -2);
      const defaultLabel = V(grouped ? expr[3] : expr[expr.length - 2]);
      const idxExpr = grouped ? expr[4] : expr[expr.length - 1];
      if (!defaultLabel) {
        const e = new Error(`br_table: missing default label`);
        e.line = watxNodeLine(expr); e.col = watxNodeCol(expr); e.file = watxNodeFile(expr);
        throw e;
      }
      if (!idxExpr) {
        const e = new Error(`br_table: missing index expression (position 3 in the form)`);
        e.line = watxNodeLine(expr); e.col = watxNodeCol(expr); e.file = watxNodeFile(expr);
        throw e;
      }
      // Shared label -> depth resolver (matches br/br_if).
      function resolveDepth(lab) {
        if (typeof lab === 'string' && lab.startsWith('$')) {
          const idx = func.blockLabels.lastIndexOf(lab);
          return idx >= 0 ? func.blockLabels.length - 1 - idx : 0;
        }
        return parseInt(lab) || 0;
      }
      const targetDepths = [];
      for (const labelNode of labelNodes) {
        targetDepths.push(resolveDepth(V(labelNode)));
      }
      const defaultDepth = resolveDepth(defaultLabel);
      // Emit: <idx-expr>, then 0x0E, vec-count(ULEB), each label depth(ULEB), default depth(ULEB).
      compileExpr(idxExpr, func, depth, bytes);
      bytes.push(0x0E);
      bytes.uleb(targetDepths.length);
      for (const d of targetDepths) bytes.uleb(d);
      bytes.uleb(defaultDepth);
      return bytes;
    }

    // ── return ──
    if (head === 'return') {
      requireArityOneOf(0, 1);
      if (expr[2]) {
        compileExpr(expr[2], func, depth, bytes);
      }
      bytes.push(OP.return_);
      return bytes;
    }

    // ── drop ──
    if (head === 'drop') {
      // `(drop)` is the stacked spelling: it consumes the value already left
      // by the preceding expression. `(drop VALUE)` is the folded spelling.
      requireArityOneOf(0, 1);
      if (expr[2]) compileExpr(expr[2], func, depth, bytes);
      bytes.push(OP.drop);
      return bytes;
    }
    
    // ── nop ──
    if (head === 'nop') {
      requireArity(0);
      bytes.push(OP.nop);
      return bytes;
    }

    // ── select ──
    if (head === 'select') {
      requireArity(3);
      compileExpr(expr[2], func, depth, bytes);
      compileExpr(expr[3], func, depth, bytes);
      compileExpr(expr[4], func, depth, bytes);
      bytes.push(OP.select);
      return bytes;
    }
    
    // ── memory.size / memory.grow ──
    if (head === 'memory.size') {
      requireArity(0);
      bytes.push(OP.memory_size, 0x00);
      return bytes;
    }
    if (head === 'memory.grow') {
      requireArity(1);
      compileExpr(expr[2], func, depth, bytes);
      bytes.push(OP.memory_grow, 0x00);
      return bytes;
    }

    // ── begin — sequence of expressions ──
    if (head === 'begin') {
      for (let i = 1; i < (expr.length - 1); i++) {
        compileExpr(expr[i + 1], func, depth, bytes);
        // Drop intermediate values (only keep last)
        if (i < (expr.length - 1) - 1 && needsAutoDrop(expr[i + 1], expr[i + 2], func)) {
          bytes.push(OP.drop);
        }
      }
      return bytes;
    }

    // ── with-region ──
    if (head === 'with-region') {
      requireMinArity(2);
      const regionName = V(expr[2]);
      const regionSpec = expr[3];
      let regionSize = 4096;
      
      if (Array.isArray(regionSpec)) {
        const kind = V(regionSpec[1]);
        if (regionSpec[2]) {
          regionSize = parseInt(V(regionSpec[2])) || 4096;
        }
      } else if (T(regionSpec) === 'number') {
        regionSize = parseInt(V(regionSpec)) || 4096;
      }
      
      // Call region_enter(size) → handle
      bytes.byte(OP.i32_const);
      bytes.sleb(regionSize);
      bytes.byte(OP.call);
      bytes.uleb(funcIndexMap.get(BUILTIN_REGION_ENTER));
      bytes.push(OP.drop); // drop the handle for now
      
      // Compile body
      for (let i = 3; i < (expr.length - 1); i++) {
        compileExpr(expr[i + 1], func, depth, bytes);
        if (i < (expr.length - 1) - 1 && needsAutoDrop(expr[i + 1], expr[i + 2], func)) bytes.push(OP.drop);
      }
      
      // Call region_exit()
      bytes.byte(OP.call);
      bytes.uleb(funcIndexMap.get(BUILTIN_REGION_EXIT));
      
      return bytes;
    }

    // ── region.addr / region.size / region.end ──
    // The offset-checked complement to bare-symbol base resolution. A bare
    // `$NAME` already emits the base, but it carries no offset and therefore
    // nothing to check; `(region.addr $NAME 0x400)` is where a CONSTANT offset
    // becomes visible to bounds checking. It compiles to exactly one i32.const
    // — the identical bytes the raw hex literal emits — so adopting it costs
    // nothing at runtime and is a pure compile-time gain.
    if (head === 'region.addr' || head === 'region.size' || head === 'region.end') {
      bytes.byte(OP.i32_const);
      bytes.sleb(regionConstValue(expr));
      return bytes;
    }

    // ── region.alloc ──
    if (head === 'region.alloc') {
      requireArity(2);
      const layoutName = V(expr[3]);
      const size = lookupLayout(layoutName, 'region.alloc', expr[3]).totalSize;

      bytes.byte(OP.i32_const);
      bytes.sleb(size);
      bytes.byte(OP.call);
      bytes.uleb(funcIndexMap.get(BUILTIN_REGION_ALLOC));
      return bytes;
    }

    // ── store.field ──
    if (head === 'store.field') {
      requireArity(4);
      const layoutName = V(expr[2]);
      const fieldName = V(expr[3]);
      const ptrExpr = expr[4];
      const valExpr = expr[5];
      
      const info = lookupLayout(layoutName, 'store.field', expr[2]);
      const field = lookupField(info, fieldName, 'store.field', expr[3]);
      const offset = field.offset;
      const fieldType = field.type;

      // ptr + offset — unless the offset is riding in the memarg instead
      compileExpr(ptrExpr, func, depth, bytes);
      if (offset > 0 && !layoutMemarg) {
        bytes.byte(OP.i32_const);
        bytes.sleb(offset);
        bytes.push(OP.i32_add);
      }

      // value
      compileExpr(valExpr, func, depth, bytes);

      emitLayoutAccess(bytes, fieldType, true, layoutMemarg ? offset : 0);

      // store.field evaluates to 0 — in the WATX dialect, where every form is an
      // expression. NOT under standardWat, where a store is a statement: the
      // plain `i32.store` path below carries the same `!standardWat` guard, and
      // needsAutoDrop() deliberately returns false for any head containing
      // "store" in that dialect, so an unguarded value here is never dropped and
      // leaks onto the stack. A store in a void function then fails
      // WebAssembly.validate outright. Wave 0 of
      // docs/watx-layout-migration-design.md; it survived because nothing in the
      // tree used a layout op at all.
      if (!standardWat) {
        bytes.byte(OP.i32_const);
        bytes.sleb(0);
      }
      return bytes;
    }

    // ── load.field ──
    if (head === 'load.field') {
      requireArity(3);
      const layoutName = V(expr[2]);
      const fieldName = V(expr[3]);
      const ptrExpr = expr[4];
      
      const info = lookupLayout(layoutName, 'load.field', expr[2]);
      const field = lookupField(info, fieldName, 'load.field', expr[3]);
      const offset = field.offset;
      const fieldType = field.type;

      compileExpr(ptrExpr, func, depth, bytes);
      if (offset > 0 && !layoutMemarg) {
        bytes.byte(OP.i32_const);
        bytes.sleb(offset);
        bytes.push(OP.i32_add);
      }

      emitLayoutAccess(bytes, fieldType, false, layoutMemarg ? offset : 0);
      return bytes;
    }

    // ── store.elem — array element store ──
    if (head === 'store.elem') {
      requireArity(5);
      const layoutName = V(expr[2]);
      const fieldName = V(expr[3]);
      const baseExpr = expr[4];
      const indexExpr = expr[5];
      const valExpr = expr[6];
      
      const info = lookupLayout(layoutName, 'store.elem', expr[2]);
      const field = lookupField(info, fieldName, 'store.elem', expr[3]);
      const fieldOffset = field.offset;
      const fieldType = field.type;
      const structSize = info.totalSize;

      // base + index * structSize + fieldOffset
      compileExpr(baseExpr, func, depth, bytes);
      compileExpr(indexExpr, func, depth, bytes);
      bytes.byte(OP.i32_const);
      bytes.sleb(structSize);
      bytes.push(OP.i32_mul);
      bytes.push(OP.i32_add);
      if (fieldOffset > 0 && !layoutMemarg) {
        bytes.byte(OP.i32_const);
        bytes.sleb(fieldOffset);
        bytes.push(OP.i32_add);
      }

      compileExpr(valExpr, func, depth, bytes);

      emitLayoutAccess(bytes, fieldType, true, layoutMemarg ? fieldOffset : 0);

      // store.elem evaluates to 0 in the WATX dialect only — see store.field.
      if (!standardWat) {
        bytes.byte(OP.i32_const);
        bytes.sleb(0);
      }
      return bytes;
    }

    // ── load.elem — array element load ──
    if (head === 'load.elem') {
      requireArity(4);
      const layoutName = V(expr[2]);
      const fieldName = V(expr[3]);
      const baseExpr = expr[4];
      const indexExpr = expr[5];
      
      const info = lookupLayout(layoutName, 'load.elem', expr[2]);
      const field = lookupField(info, fieldName, 'load.elem', expr[3]);
      const fieldOffset = field.offset;
      const fieldType = field.type;
      const structSize = info.totalSize;

      compileExpr(baseExpr, func, depth, bytes);
      compileExpr(indexExpr, func, depth, bytes);
      bytes.byte(OP.i32_const);
      bytes.sleb(structSize);
      bytes.push(OP.i32_mul);
      bytes.push(OP.i32_add);
      if (fieldOffset > 0 && !layoutMemarg) {
        bytes.byte(OP.i32_const);
        bytes.sleb(fieldOffset);
        bytes.push(OP.i32_add);
      }

      emitLayoutAccess(bytes, fieldType, false, layoutMemarg ? fieldOffset : 0);
      return bytes;
    }

    // ── store.field-elem — store element `idx` of an ARRAY FIELD inside a struct ──
    // (store.field-elem Layout field base idx val) -> mem[base + fieldOffset + idx*stride] = val.
    // Distinct from store.elem (which strides by the WHOLE struct size for arrays-of-structs); this
    // strides by the field's own element stride, for a `(field name type count [stride])` array member.
    if (head === 'store.field-elem') {
      requireArity(5);
      const layoutName = V(expr[2]);
      const fieldName = V(expr[3]);
      const baseExpr = expr[4];
      const indexExpr = expr[5];
      const valExpr = expr[6];

      const info = lookupLayout(layoutName, 'store.field-elem', expr[2]);
      const field = lookupField(info, fieldName, 'store.field-elem', expr[3]);
      const fieldOffset = field.offset;
      const fieldType = field.type;
      const stride = field.stride ?? sizeOfType(fieldType);

      compileExpr(baseExpr, func, depth, bytes);
      if (fieldOffset > 0 && !layoutMemarg) {
        bytes.byte(OP.i32_const);
        bytes.sleb(fieldOffset);
        bytes.push(OP.i32_add);
      }
      compileExpr(indexExpr, func, depth, bytes);
      bytes.byte(OP.i32_const);
      bytes.sleb(stride);
      bytes.push(OP.i32_mul);
      bytes.push(OP.i32_add);

      compileExpr(valExpr, func, depth, bytes);

      emitLayoutAccess(bytes, fieldType, true, layoutMemarg ? fieldOffset : 0);

      // store.field-elem evaluates to 0 in the WATX dialect only — see store.field.
      if (!standardWat) {
        bytes.byte(OP.i32_const);
        bytes.sleb(0);
      }
      return bytes;
    }

    // ── load.field-elem — load element `idx` of an ARRAY FIELD inside a struct ──
    if (head === 'load.field-elem') {
      requireArity(4);
      const layoutName = V(expr[2]);
      const fieldName = V(expr[3]);
      const baseExpr = expr[4];
      const indexExpr = expr[5];

      const info = lookupLayout(layoutName, 'load.field-elem', expr[2]);
      const field = lookupField(info, fieldName, 'load.field-elem', expr[3]);
      const fieldOffset = field.offset;
      const fieldType = field.type;
      const stride = field.stride ?? sizeOfType(fieldType);

      compileExpr(baseExpr, func, depth, bytes);
      if (fieldOffset > 0 && !layoutMemarg) {
        bytes.byte(OP.i32_const);
        bytes.sleb(fieldOffset);
        bytes.push(OP.i32_add);
      }
      compileExpr(indexExpr, func, depth, bytes);
      bytes.byte(OP.i32_const);
      bytes.sleb(stride);
      bytes.push(OP.i32_mul);
      bytes.push(OP.i32_add);

      emitLayoutAccess(bytes, fieldType, false, layoutMemarg ? fieldOffset : 0);
      return bytes;
    }

    // ── elem-addr — ADDRESS of element `idx` of an array field (load.field-elem minus the final load) ──
    // (elem-addr Layout field base idx) -> base + offset-of(field) + idx*stride, as an i32 address.
    // For sites that compute a register/matrix base address then do their own lane arithmetic off it
    // (B's ~311 NEON `800 + rn*16` sites; RES Gl2State matrix-element addresses) -- keeps the offset+
    // stride compile-time/layout-typed without forcing a load of the element's declared width.
    if (head === 'elem-addr') {
      requireArity(4);
      const layoutName = V(expr[2]);
      const fieldName = V(expr[3]);
      const baseExpr = expr[4];
      const indexExpr = expr[5];

      const info = lookupLayout(layoutName, 'elem-addr', expr[2]);
      const field = lookupField(info, fieldName, 'elem-addr', expr[3]);
      const fieldOffset = field.offset;
      const stride = field.stride ?? sizeOfType(field.type);

      compileExpr(baseExpr, func, depth, bytes);
      if (fieldOffset > 0) {
        bytes.byte(OP.i32_const);
        bytes.sleb(fieldOffset);
        bytes.push(OP.i32_add);
      }
      compileExpr(indexExpr, func, depth, bytes);
      bytes.byte(OP.i32_const);
      bytes.sleb(stride);
      bytes.push(OP.i32_mul);
      bytes.push(OP.i32_add);
      return bytes;
    }

    // ── size-of ──
    if (head === 'size-of') {
      requireArity(1);
      const layoutName = V(expr[2]);
      const size = lookupLayout(layoutName, 'size-of', expr[2]).totalSize;
      bytes.byte(OP.i32_const);
      bytes.sleb(size);
      return bytes;
    }

    // ── offset-of ──
    if (head === 'offset-of') {
      requireArity(2);
      const layoutName = V(expr[2]);
      const fieldName = V(expr[3]);
      const info = lookupLayout(layoutName, 'offset-of', expr[2]);
      const offset = lookupField(info, fieldName, 'offset-of', expr[3]).offset;
      bytes.byte(OP.i32_const);
      bytes.sleb(offset);
      return bytes;
    }

    // ── Standard scalar memory operations, including offset=/align= memargs ──
    {
      const loads = WATX_LOAD_OPS || (WATX_LOAD_OPS = {
        'i32.load':[OP.i32_load,2], 'i64.load':[OP.i64_load,3], 'f32.load':[OP.f32_load,2], 'f64.load':[OP.f64_load,3],
        'i32.load8_s':[OP.i32_load8_s,0], 'i32.load8_u':[OP.i32_load8_u,0],
        'i32.load16_s':[OP.i32_load16_s,1], 'i32.load16_u':[OP.i32_load16_u,1],
        'i64.load8_s':[OP.i64_load8_s,0], 'i64.load8_u':[OP.i64_load8_u,0],
        'i64.load16_s':[OP.i64_load16_s,1], 'i64.load16_u':[OP.i64_load16_u,1],
        'i64.load32_s':[OP.i64_load32_s,2], 'i64.load32_u':[OP.i64_load32_u,2],
      });
      const stores = WATX_STORE_OPS || (WATX_STORE_OPS = {
        'i32.store':[OP.i32_store,2], 'i64.store':[OP.i64_store,3], 'f32.store':[OP.f32_store,2], 'f64.store':[OP.f64_store,3],
        'i32.store8':[OP.i32_store8,0], 'i32.store16':[OP.i32_store16,1],
        'i64.store8':[OP.i64_store8,0], 'i64.store16':[OP.i64_store16,1], 'i64.store32':[OP.i64_store32,2],
      });
      if (loads[head] || stores[head]) {
        const ma = parseMemarg(expr, 1, head, (loads[head] || stores[head])[1], false);
        requireArity(ma.next + (stores[head] ? 1 : 0));
        let operand = ma.next;
        const offset = ma.offset, align = ma.align;
        if (!expr[operand + 1]) throw new Error(`${head} is missing its address operand`);
        compileExpr(expr[(operand++) + 1], func, depth, bytes);
        if (stores[head]) {
          if (!expr[operand + 1]) throw new Error(`${head} is missing its value operand`);
          compileExpr(expr[operand + 1], func, depth, bytes);
        }
        const spec = loads[head] || stores[head];
        bytes.byte(spec[0]);
        bytes.uleb(align);
        bytes.uleb(offset);
        if (stores[head] && !standardWat) {
          bytes.byte(OP.i32_const);
          bytes.sleb(0);
        }
        return bytes;
      }
    }

    // ── Atomic memory operations (WebAssembly threads proposal, 0xFE prefix) ──
    // Migration gap G1: this family was absent entirely — the string `atomic` did not
    // occur anywhere in this file — while Wine-Assembly's own closure has 144 atomic
    // sites over an imported `shared` memory. The whole standard family is implemented,
    // not the subset one tree happens to use: a partial opcode table is exactly the
    // failure mode that makes an unknown-but-valid form vanish silently.
    //
    // Encoding: 0xFE + ULEB(subop) + ULEB(align log2) + ULEB(offset), with the operands
    // pushed first — address, then (for stores/rmw) the value, then (for cmpxchg and the
    // wait ops) the second value. `atomic.fence` is the one form with no memarg: it
    // carries a single 0x00 immediate naming the memory order.
    //
    // Natural alignment is REQUIRED here, unlike the non-atomic accesses where align= is
    // only a hint — see parseMemarg's `requireNatural`.
    {
      const atomics = WATX_ATOMIC_OPS || (WATX_ATOMIC_OPS = (function () {
        const tbl = {};
        const put = (name, op, align, args, store) => { tbl[name] = { op, align, args, store: !!store }; };
        put('memory.atomic.notify', 0x00, 2, 1, false);
        put('memory.atomic.wait32', 0x01, 2, 2, false);
        put('memory.atomic.wait64', 0x02, 3, 2, false);
        put('atomic.fence',         0x03, 0, 0, false);
        for (const [n, o, a] of [
          ['i32.atomic.load',      0x10, 2], ['i64.atomic.load',     0x11, 3],
          ['i32.atomic.load8_u',   0x12, 0], ['i32.atomic.load16_u', 0x13, 1],
          ['i64.atomic.load8_u',   0x14, 0], ['i64.atomic.load16_u', 0x15, 1],
          ['i64.atomic.load32_u',  0x16, 2],
        ]) put(n, o, a, 0, false);
        for (const [n, o, a] of [
          ['i32.atomic.store',     0x17, 2], ['i64.atomic.store',    0x18, 3],
          ['i32.atomic.store8',    0x19, 0], ['i32.atomic.store16',  0x1A, 1],
          ['i64.atomic.store8',    0x1B, 0], ['i64.atomic.store16',  0x1C, 1],
          ['i64.atomic.store32',   0x1D, 2],
        ]) put(n, o, a, 1, true);
        // The seven rmw families occupy 0x1E..0x4E as seven consecutive width groups
        // each, in this exact order. The narrow widths carry a `_u` suffix.
        const widths = [
          ['i32.atomic.rmw.',   2], ['i64.atomic.rmw.',   3],
          ['i32.atomic.rmw8.',  0], ['i32.atomic.rmw16.', 1],
          ['i64.atomic.rmw8.',  0], ['i64.atomic.rmw16.', 1],
          ['i64.atomic.rmw32.', 2],
        ];
        let op = 0x1E;
        for (const kind of ['add', 'sub', 'and', 'or', 'xor', 'xchg', 'cmpxchg']) {
          for (let w = 0; w < widths.length; w++) {
            put(widths[w][0] + kind + (w >= 2 ? '_u' : ''), op++, widths[w][1],
                kind === 'cmpxchg' ? 2 : 1, false);
          }
        }
        return tbl;
      })());
      const aspec = atomics[head];
      if (aspec) {
        if (head === 'atomic.fence') {
          requireArity(0);
          bytes.byte(0xFE);
          bytes.uleb(aspec.op);
          bytes.byte(0x00);
          return bytes;
        }
        const ma = parseMemarg(expr, 1, head, aspec.align, true);
        requireArity(ma.next + aspec.args);
        let operand = ma.next;
        if (!expr[operand + 1]) throw new Error(`${head} is missing its address operand`);
        compileExpr(expr[(operand++) + 1], func, depth, bytes);
        for (let k = 0; k < aspec.args; k++) {
          if (!expr[operand + 1]) {
            throw new Error(`${head} is missing operand ${k + 1} of ${aspec.args} after the address`);
          }
          compileExpr(expr[(operand++) + 1], func, depth, bytes);
        }
        bytes.byte(0xFE);
        bytes.uleb(aspec.op);
        bytes.uleb(ma.align);
        bytes.uleb(ma.offset);
        // Legacy WATX convention: a store yields i32 0 so expression trees compose.
        // Standard-WAT mode leaves the stack alone, matching the scalar stores above.
        if (aspec.store && !standardWat) {
          bytes.byte(OP.i32_const);
          bytes.sleb(0);
        }
        return bytes;
      }
    }

    // ── global.get / global.set ──
    if (head === 'global.get') {
      requireArity(1);
      const name = V(expr[2]);
      const globalIdx = /^\d+$/.test(name || '') ? parseInt(name) : globalIndexMap.get(name);
      if (globalIdx === undefined || globalIdx >= globalSpace.length) throw new Error(`Unknown global '${name}' in ${func.name}`);
      bytes.byte(OP.global_get);
      bytes.uleb(globalIdx);
      return bytes;
    }
    if (head === 'global.set') {
      requireArity(2);
      const name = V(expr[2]);
      const globalIdx = /^\d+$/.test(name || '') ? parseInt(name) : globalIndexMap.get(name);
      if (globalIdx === undefined || globalIdx >= globalSpace.length) throw new Error(`Unknown global '${name}' in ${func.name}`);
      // An IMMUTABLE import is refused here for the same reason a defined one
      // is: the engine would reject the module at validation with a byte offset
      // instead of a line, and the host cannot make it writable from its side.
      if (!globalSpace[globalIdx].mutable) throw new Error(`Cannot set immutable global '${name}'`);
      if (!expr[3]) throw new Error(`global.set for '${name}' is missing a value`);
      compileExpr(expr[3], func, depth, bytes);
      bytes.byte(OP.global_set);
      bytes.uleb(globalIdx);
      if (!standardWat) {
        bytes.byte(OP.i32_const);
        bytes.sleb(0);
      }
      return bytes;
    }

    // ── Unknown head — a form whose head is not a known op/keyword/builtin, not a (call ...), and
    // not a (defmacro) invocation (macros are already expanded in the EXPAND stage). This is almost
    // always a TYPO of a named-slot/macro (e.g. (RESULT_REGG) for (RESULT_REG)) or a mistyped op.
    // The old behavior silently compiled the children as an implicit (begin ...), emitting NOTHING
    // for a childless (TYPO) -> a silent wrong-address / stack-underflow bug exactly like the ones
    // this refactor exists to kill. Verified 2026-07-04: the ENTIRE src tree hits this path zero
    // times, so hard-erroring here breaks nothing and makes macro/slot typos fail loudly + named.
    if (head) {
      const e = new Error(
        `Unknown form head '${head}' in ${func?.name || '<expr>'}: not an instruction, keyword, ` +
        `builtin, (call ...), or defined macro/named-slot (typo of a macro/slot name?).`);
      e.line = watxNodeLine(expr);
      e.col = watxNodeCol(expr);
      e.file = watxNodeFile(expr);
      throw e;
    }
    // Headless form (no leading symbol) — keep the conservative compile-children behavior.
    for (let i = 1; i < (expr.length - 1); i++) {
      compileExpr(expr[i + 1], func, depth, bytes);
      if (i < (expr.length - 1) - 1 && needsAutoDrop(expr[i + 1], expr[i + 2], func)) bytes.push(OP.drop);
    }
    return bytes;
  }

  // ── Infer the Wasm type produced by an expression ──
  function inferExprType(expr, symTypes) {
    if (!expr) return 'i32';
    if (!Array.isArray(expr)) {
      if (T(expr) === 'number') {
        const val = V(expr);
        if (val.includes('.') || val.includes('e') || val.includes('E')) return 'f32';
        return 'i32';
      }
      // Symbol reference: resolve to the referenced local/param's actual type when
      // known. Without this, `(let $a $b)` where $b is f32 wrongly types $a as i32
      // (the old conservative default), sinking an f32 value into an i32 slot and
      // producing wasm that fails validation (local.tee/set type mismatch).
      if (T(expr) === 'symbol' && symTypes && symTypes.has(V(expr))) {
        return symTypes.get(V(expr));
      }
      return 'i32'; // unknown symbol — conservative default
    }
    // The `.memarg` modifier changes where the field offset is encoded, never
    // what the access yields — an f64 field read `.memarg` is still an f64.
    const hd = watxLayoutMemargHead(V(expr[1])).head;
    if (!hd) return 'i32';

    // f32 constants
    if (hd === 'f32.const') return 'f32';
    if (hd === 'f64.const') return 'f64';
    if (hd === 'i64.const') return 'i64';
    if (hd === 'i32.const') return 'i32';

    // Atomics: an i64.* atomic load or rmw yields i64, everything else in the family
    // (including memory.atomic.notify / wait32 / wait64) yields i32. Checked before the
    // generic `.store` rule below so `i64.atomic.load` is not mistaken for one.
    if (typeof hd === 'string' && hd.indexOf('.atomic.') > 0) {
      if (hd.indexOf('i64.') === 0 && hd.indexOf('.atomic.store') < 0) return 'i64';
      return 'i32';
    }

    // A labeled or unlabeled block/loop with an explicit (block $l (result T) ...)
    // signature yields T; without one, an unlabeled block yields its last expression
    // (migration gap G4).
    if (hd === 'block' || hd === 'loop') {
      const labeled = T(expr[2]) === 'symbol' && V(expr[2])?.startsWith('$');
      const sig = expr[labeled ? 3 : 2];
      if (Array.isArray(sig) && V(sig[1]) === 'result') return V(sig[2]) || 'i32';
      if (T(sig) === 'symbol' && ['i32','i64','f32','f64','v128'].includes(V(sig))) return V(sig);
      if (hd === 'block' && !labeled && (expr.length - 1) >= 2) {
        return inferExprType(expr[expr.length - 1], symTypes);
      }
      return 'i32';
    }

    // Stores push i32 0 (WATX store convention), regardless of the stored value's
    // width — so e.g. v128.store leaves i32, not v128. Handle before the SIMD
    // prefix check below so the inferred type matches what codegen emits.
    if (typeof hd === 'string' && (
        hd.endsWith('.store') || hd.endsWith('.store8') || hd.endsWith('.store16') || hd.endsWith('.store32') ||
        hd === 'store.field' || hd === 'store.elem' || hd === 'store.field-elem')) {
      return 'i32';
    }

    // f32 arithmetic/unary ops produce f32
    const f32Ops = WATX_F32_OPS || (WATX_F32_OPS = new Set([
      'f32.add','f32.sub','f32.mul','f32.div',
      'f32.min','f32.max','f32.copysign',
      'f32.neg','f32.abs','f32.ceil','f32.floor','f32.trunc','f32.nearest','f32.sqrt',
      'f32.convert_i32_s','f32.convert_i32_u','f32.convert_i64_s','f32.convert_i64_u',
      'f32.demote_f64','f32.reinterpret_i32',
      'f32.load',
    ]));
    if (f32Ops.has(hd)) return 'f32';

    // f64 ops produce f64
    const f64Ops = WATX_F64_OPS || (WATX_F64_OPS = new Set([
      'f64.add','f64.sub','f64.mul','f64.div',
      'f64.promote_f32','f64.convert_i32_s',
      'f64.load',
      'f64.min','f64.max','f64.copysign',
      'f64.abs','f64.neg','f64.ceil','f64.floor','f64.trunc','f64.nearest','f64.sqrt',
      'f64.convert_i32_u','f64.convert_i64_s','f64.convert_i64_u','f64.reinterpret_i64',
    ]));
    if (f64Ops.has(hd)) return 'f64';

    // i64 ops (value-producing, non-comparison)
    const i64Ops = WATX_I64_OPS || (WATX_I64_OPS = new Set([
      'i64.extend_i32_s','i64.extend_i32_u','i64.load',
      'i64.clz','i64.ctz','i64.popcnt',
      'i64.add','i64.sub','i64.mul','i64.div_s','i64.div_u','i64.rem_s','i64.rem_u',
      'i64.and','i64.or','i64.xor','i64.shl','i64.shr_s','i64.shr_u','i64.rotl','i64.rotr',
      'i64.trunc_f32_s','i64.trunc_f32_u','i64.trunc_f64_s','i64.trunc_f64_u',
      'i64.reinterpret_f64',
    ]));
    if (i64Ops.has(hd)) return 'i64';

    // Comparison ops always return i32 (even f32.lt, f64.lt, i64.lt_s, etc.)
    const cmpOps = WATX_CMP_OPS || (WATX_CMP_OPS = new Set([
      'i32.eq','i32.ne','i32.lt_s','i32.lt_u','i32.gt_s','i32.gt_u',
      'i32.le_s','i32.le_u','i32.ge_s','i32.ge_u','i32.eqz',
      'f32.eq','f32.ne','f32.lt','f32.gt','f32.le','f32.ge',
      'f64.eq','f64.ne','f64.lt','f64.gt','f64.le','f64.ge',
      'i64.eqz','i64.eq','i64.ne','i64.lt_s','i64.lt_u','i64.gt_s','i64.gt_u',
      'i64.le_s','i64.le_u','i64.ge_s','i64.ge_u',
    ]));
    if (cmpOps.has(hd)) return 'i32';

    // i32 arithmetic
    const i32Ops = WATX_I32_OPS || (WATX_I32_OPS = new Set([
      'i32.add','i32.sub','i32.mul','i32.div_s','i32.div_u',
      'i32.rem_s','i32.rem_u','i32.and','i32.or','i32.xor',
      'i32.shl','i32.shr_s','i32.shr_u',
      'i32.trunc_f32_s','i32.trunc_f32_u',
      'i32.wrap_i64','i32.reinterpret_f32',
      'i32.load','i32.load8_u','i32.load8_s','i32.load16_s','i32.load16_u',
    ]));
    if (i32Ops.has(hd)) return 'i32';

    // SIMD (v128) return-type inference. Most SIMD ops produce v128; a handful reduce
    // to a scalar: extract_lane_* to lane type, any_true/all_true to i32. Order matters —
    // check the scalar-returning ops first so `(let $x (i32x4.extract_lane v 0))` types
    // $x as i32, not v128 (which would sink the value into the wrong local slot).
    if (typeof hd === 'string') {
      if (hd === 'i8x16.extract_lane_s' || hd === 'i8x16.extract_lane_u' ||
          hd === 'i16x8.extract_lane_s' || hd === 'i16x8.extract_lane_u' ||
          hd === 'i32x4.extract_lane' ||
          hd === 'v128.any_true' ||
          hd === 'i8x16.bitmask' || hd === 'i16x8.bitmask' ||
          hd === 'i32x4.bitmask' || hd === 'i64x2.bitmask' ||
          hd === 'i8x16.all_true' || hd === 'i16x8.all_true' ||
          hd === 'i32x4.all_true' || hd === 'i64x2.all_true') return 'i32';
      if (hd === 'i64x2.extract_lane') return 'i64';
      if (hd === 'f32x4.extract_lane') return 'f32';
      if (hd === 'f64x2.extract_lane') return 'f64';
      if (hd.startsWith('v128.') || hd.startsWith('i8x16.') || hd.startsWith('i16x8.') ||
          hd.startsWith('i32x4.') || hd.startsWith('i64x2.') ||
          hd.startsWith('f32x4.') || hd.startsWith('f64x2.')) return 'v128';
    }

    // Call — look up function return type
    if (hd === 'call') {
      const funcName = V(expr[2]);
      const imp = importDeclByName.get(funcName);
      if (imp) {
        if (imp.results.length > 0) return valtypeName(imp.results[0]);
        return 'i32';
      }
      const fd = funcDeclByName.get(funcName);
      if (fd) {
        if (fd.results.length > 0) {
          const rt = fd.results[0];
          if (rt === 'f32' || rt === 'f64' || rt === 'i64' || rt === 'v128') return rt;
          return 'i32';
        }
        return 'i32';
      }
      return 'i32';
    }

    // call_indirect — return type comes from its (type ...) annotation
    if (hd === 'call_indirect') {
      const r = parseIndirectSig(expr[2]).results;
      if (r.length > 0) return valtypeName(r[0]);
      return 'i32';
    }
    if (hd === 'func-slot') return 'i32';

    // if with explicit type: (if f32 ...) or (if (result f32) ...)
    if (hd === 'if') {
      if (T(expr[2]) === 'symbol' && ['i32','i64','f32','f64','v128'].includes(V(expr[2]))) {
        return V(expr[2]);
      }
      if (Array.isArray(expr[2]) && V(expr[2][1]) === 'result') {
        const t = V(expr[2][2]);
        if (['i32','i64','f32','f64','v128'].includes(t)) return t;
      }
      return 'i32';
    }

    // select inherits type from its operands
    if (hd === 'select') {
      return inferExprType(expr[2]);
    }

    // load.field — look up layout field type
    if (hd === 'load.field') {
      const lname = V(expr[2]);
      const fname = V(expr[3]);
      const info = layoutInfo.get(lname);
      if (info) {
        const field = info.fieldByName.get(fname);
        if (field) {
          const ft = field.type;
          if (ft === 'f32') return 'f32';
          if (ft === 'f64') return 'f64';
          if (ft === 'i64') return 'i64';
        }
      }
      return 'i32';
    }

    // load.elem / load.field-elem — look up layout field type
    if (hd === 'load.elem' || hd === 'load.field-elem') {
      const lname = V(expr[2]);
      const fname = V(expr[3]);
      const info = layoutInfo.get(lname);
      if (info) {
        const field = info.fieldByName.get(fname);
        if (field) {
          const ft = field.type;
          if (ft === 'f32') return 'f32';
          if (ft === 'f64') return 'f64';
          if (ft === 'i64') return 'i64';
        }
      }
      return 'i32';
    }

    // begin — type of last expr
    if (hd === 'begin' && (expr.length - 1) >= 2) {
      return inferExprType(expr[expr.length - 1]);
    }

    // block — type of last expr
    if (hd === 'block' && (expr.length - 1) >= 2) {
      return inferExprType(expr[expr.length - 1]);
    }

    // let — type of its initializer. WATX `let` is a local.tee expression, not
    // a binding form with a trailing body; codegen's exact-arity check refuses
    // such a body rather than silently discarding it.
    if (hd === 'let') {
      if ((expr.length - 1) >= 4 && T(expr[3]) === 'symbol' &&
          ['i32','i64','f32','f64','v128','u8','ptr','weak'].includes(V(expr[3]))) {
        const declared = V(expr[3]);
        return declared === 'u8' || declared === 'ptr' || declared === 'weak'
          ? 'i32' : declared;
      }
      return inferExprType(expr[3], symTypes);
    }

    return 'i32'; // conservative default
  }

  // ── Collect function-local variable declarations ──
  const LOCAL_VALUE_TYPES = new Set(['i32','i64','f32','f64','v128','u8','ptr','weak']);
  const physicalLocalType = (t) => (t === 'u8' || t === 'ptr' || t === 'weak') ? 'i32' : t;

  function collectLocals(body, params) {
    const PHYS = physicalLocalType;
    const VT = LOCAL_VALUE_TYPES;

    // Running name -> physical type map so a bare-symbol let init (e.g.
    // `(let $a $b)`) resolves to the referenced local/param's type rather than
    // defaulting to i32. Seed with params; each declared local is added below as
    // it is walked (declaration order), so later refs see earlier types.
    const symTypes = new Map();
    if (params) for (const p of params) if (p.name) symTypes.set(p.name, PHYS(p.type));

    // Gather declarations and explicit-type evidence in one source-order walk.
    // Once the walk finishes, replay the tiny declaration list to assign slots.
    // This preserves first-declaration ordering without a full pre-scan.
    const declarations = [];
    const explicitTypes = new Map();

    function walk(expr) {
      if (!Array.isArray(expr)) return;
      const hd = V(expr[1]);

      if (hd === 'let') {
        const name = V(expr[2]);
        if (name) {
          // Determine type: explicit annotation takes priority
          let type = null;
          const isExplicit = (expr.length - 1) >= 4 && T(expr[3]) === 'symbol' && VT.has(V(expr[3]));
          if (isExplicit) {
            type = V(expr[3]);
          }
          // If no explicit type, infer from init expression (resolving bare
          // symbol refs against already-declared locals/params).
          if (!type) {
            const initExpr = expr[3];
            type = inferExprType(initExpr, symTypes);
          }
          type = PHYS(type);
          symTypes.set(name, type);
          declarations.push({ name, type });
          if (isExplicit) {
            if (!explicitTypes.has(name)) explicitTypes.set(name, new Set());
            explicitTypes.get(name).add(type);
          }
        }
      }

      // Standard WAT-style local declaration: (local $name type)
      // Without this, `(local ...)` vars are never allocated, so local.get
      // returns 0 and local.set is a silent no-op — a trap for code written
      // in standard WAT style (e.g. locals declared up-front before a loop).
      if (hd === 'local') {
        const name = V(expr[2]);
        let type = V(expr[3]);
        if (name && name.startsWith('$')) {
          if (!VT.has(type)) type = 'i32';
          type = PHYS(type);
          symTypes.set(name, type);
          declarations.push({ name, type });
          if (!explicitTypes.has(name)) explicitTypes.set(name, new Set());
          explicitTypes.get(name).add(type);
        }
      }

      for (let i = 0; i < (expr.length - 1); i++) {
        if (Array.isArray(expr[i + 1])) walk(expr[i + 1]);
      }
    }

    for (const e of body) walk(e);
    const polymorphic = new Set();
    for (const [name, types] of explicitTypes) if (types.size > 1) polymorphic.add(name);
    const locals = [];
    const seen = new Set();
    for (const declaration of declarations) {
      const key = polymorphic.has(declaration.name)
        ? declaration.name + ':' + declaration.type
        : declaration.name;
      if (!seen.has(key)) {
        seen.add(key);
        locals.push(declaration);
      }
    }
    return locals;
  }

  // ── Build type section ──
  // Type signatures: collect unique types for imports + builtins + user funcs
  const typeSigs = [];
  const typeMap = new Map(); // signature string → type index
  
  function getTypeIdx(params, results) {
    const key = `(${params.join(',')})=>(${results.join(',')})`;
    if (typeMap.has(key)) return typeMap.get(key);
    const idx = typeSigs.length;
    typeSigs.push({ params, results });
    typeMap.set(key, idx);
    return idx;
  }

  // ── Type-section ordering (parity with lib/compile-wat.js) ──
  // A (type N) operand is a *positional* reference into the type section, so
  // two compilers that intern the same set of signatures in a different order
  // emit different bytes for the same source. lib/compile-wat.js interns in a
  // fixed order: a first sub-pass over every top-level (type ...) declaration,
  // then one source-order pass in which imports and function definitions are
  // interned as they are encountered. Reproduce that here.
  //
  // Nothing downstream depends on the order — getTypeIdx dedups, so every
  // later call still returns the entry this pass created. All this decides is
  // which index each signature lands on, which is what makes $next's
  // `return_call_indirect (type $handler_t)` encode `(type 0)` in both.
  (function internTypesInDeclarationOrder() {
    // Sub-pass A: top-level (type $t (func ...)) declarations, in source order.
    for (const sig of namedTypes.values()) {
      const s = parseIndirectSig([watxFormLoc(sig), 'type', ...sig.slice(2)]);
      getTypeIdx(s.params, s.results);
    }

    // Sub-pass B: imports and function definitions interleaved in source order.
    // By the time this runs the (func ...) forms have already been consumed —
    // `forms` still holds the imports but no functions — so the interleaving
    // comes from checkResult.declOrder, the sequence the checker recorded in
    // the one pass where both kinds were still visible. The fallback walk over
    // `forms` covers callers that invoke generateWasm without a checkResult,
    // where the function forms ARE still present.
    let order = checkResult?.declOrder;
    if (!order) {
      order = [];
      for (const form of forms) {
        if (!Array.isArray(form)) continue;
        const h = V(form[1]);
        if ((h === 'wasm-import' || h === 'import') && Array.isArray(form[4]) && V(form[4][1]) === 'func') order.push('import');
        else if (h === 'func') order.push('func');
      }
    }
    // A cursor pairs each entry of `order` with a declaration, so a sequence
    // that does not account for exactly the declarations we have would
    // mis-pair them. Decline instead of guessing: the import-then-function
    // order below still produces a correct module, it just may not reproduce
    // legacy's numbering.
    let nImports = 0, nFuncs = 0;
    for (const kind of order) { if (kind === 'import') nImports++; else nFuncs++; }
    if (nImports !== importDecls.length || nFuncs !== funcDecls.length) return;
    let ii = 0, fj = 0;
    for (const kind of order) {
      if (kind === 'import') {
        const imp = importDecls[ii++];
        getTypeIdx(imp.params, imp.results);
      } else {
        const fd = funcDecls[fj++];
        getTypeIdx(fd.params.map(p => valtypeOf(p.type)), fd.results.map(r => valtypeOf(r)));
      }
    }
  })();

  // Import type indices
  const importTypeIdxs = importDecls.map(imp => getTypeIdx(imp.params, imp.results));
  
  // Builtin type indices
  const builtinRegionEnterType = runtimeBuiltins ? getTypeIdx([VALTYPE.i32], [VALTYPE.i32]) : null;
  const builtinRegionAllocType = runtimeBuiltins ? getTypeIdx([VALTYPE.i32], [VALTYPE.i32]) : null;
  const builtinRegionExitType = runtimeBuiltins ? getTypeIdx([], []) : null;
  
  // Keep only compact signatures module-wide. Local maps are substantially
  // larger and are needed by exactly one function at a time during emission.
  const userFuncTypes = funcDecls.map(fd => {
    const params = fd.params.map(p => valtypeOf(p.type));
    const results = fd.results.map(r => valtypeOf(r));
    return { typeIdx: getTypeIdx(params, results), params, results };
  });

  // Indirect signatures must exist before the type section is serialized.
  function registerIndirectTypes(fd) {
    if (fd.indirectTypeForms !== undefined) {
      for (const typeForm of fd.indirectTypeForms) {
        const sig = parseIndirectSig(typeForm);
        getTypeIdx(sig.params, sig.results);
      }
      return;
    }
    function scan(expr) {
      if (!Array.isArray(expr)) return;
      const hd = V(expr[1]);
      if (hd === 'call_indirect' || hd === 'return_call_indirect') {
        const sig = parseIndirectSig(expr[2]);
        getTypeIdx(sig.params, sig.results);
      }
      for (let i = 0; i < (expr.length - 1); i++) if (Array.isArray(expr[i + 1])) scan(expr[i + 1]);
    }
    for (const expr of fd.body) scan(expr);
  }
  for (const fd of funcDecls) registerIndirectTypes(fd);

  function prepareUserFunction(fd, typeInfo) {
    const declaredLocals = collectLocals(fd.body, fd.params);

    // Build local map (params first, then locals).
    // localMap: name -> first slot index (back-compat: the default binding used
    //   for non-colliding names and as a fallback).
    // localSlots: name -> [{type, index}] for ALL physical slots of that name —
    //   a name has >1 entry only when it was declared with different types in
    //   sibling scopes. compileExpr disambiguates those via func.activeLocal.
    const localMap = new Map();
    const localSlots = new Map();
    fd.params.forEach((p, i) => {
      if (p.name) {
        localMap.set(p.name, i);
        localSlots.set(p.name, [{ type: p.type, index: i }]);
      }
    });
    declaredLocals.forEach((l, i) => {
      const index = fd.params.length + i;
      if (!localMap.has(l.name)) localMap.set(l.name, index);
      if (!localSlots.has(l.name)) localSlots.set(l.name, []);
      localSlots.get(l.name).push({ type: l.type, index });
    });

    return {
      typeIdx: typeInfo.typeIdx,
      params: typeInfo.params,
      results: typeInfo.results,
      locals: declaredLocals,
      localMap,
      localSlots,
      activeLocal: new Map(),
      body: fd.body,
      name: fd.name,
      // The declaration form, so a diagnostic raised before any inner form has
      // been compiled still has a source location to point at.
      sourceForm: fd.form,
      blockLabels: [],
    };
  }

  // ── Emit binary sections ──
  const allBytes = new BinaryWriter(1024 * 1024);
  
  // Magic + Version
  allBytes.push(0x00, 0x61, 0x73, 0x6d); // \0asm
  allBytes.push(0x01, 0x00, 0x00, 0x00); // version 1
  
  // Section 1: Type section
  {
    const content = new BinaryWriter();
    content.uleb(typeSigs.length);
    for (const sig of typeSigs) {
      content.byte(0x60); // func type marker
      content.uleb(sig.params.length);
      for (const p of sig.params) content.byte(p);
      content.uleb(sig.results.length);
      for (const r of sig.results) content.byte(r);
    }
    appendSection(allBytes, 1, content);
  }
  
  // Section 2: Import section
  if (moduleImports.length || !standardWat) {
    const content = new BinaryWriter();
    content.uleb(moduleImports.length);
    let funcImportIndex = 0;
    for (const imp of moduleImports) {
      content.string(imp.module);
      content.string(imp.kind === 'memory' ? imp.importName : imp.name);
      if (imp.kind === 'func') {
        content.byte(0x00);
        content.uleb(importTypeIdxs[funcImportIndex++]);
      } else if (imp.kind === 'global') {
        content.byte(0x03);
        content.byte(valtypeOf(imp.type));
        content.byte(imp.mutable ? 0x01 : 0x00);
      } else {
        content.byte(0x02);
        const flags = imp.shared ? 0x03 : imp.max !== undefined ? 0x01 : 0x00;
        content.byte(flags);
        content.uleb(imp.min);
        if (imp.max !== undefined) content.uleb(imp.max);
      }
    }
    appendSection(allBytes, 2, content);
  }
  
  // Section 3: Function section (declares type index for each function)
  {
    const numFuncs = (runtimeBuiltins ? 3 : 0) + userFuncTypes.length;
    const content = new BinaryWriter();
    content.uleb(numFuncs);
    if (runtimeBuiltins) {
      content.uleb(builtinRegionEnterType);
      content.uleb(builtinRegionAllocType);
      content.uleb(builtinRegionExitType);
    }
    for (const typeInfo of userFuncTypes) {
      content.uleb(typeInfo.typeIdx);
    }
    appendSection(allBytes, 3, content);
  }

  // Section 4: Table section (funcref table for call_indirect / threaded dispatch)
  if (tableDecl) {
    const content = new BinaryWriter();
    content.uleb(1);                                      // 1 table
    content.byte(0x70);                                   // elem type: funcref
    content.byte(tableDecl.max !== undefined ? 0x01 : 0x00);
    content.uleb(tableDecl.min);
    if (tableDecl.max !== undefined) content.uleb(tableDecl.max);
    appendSection(allBytes, 4, content);
  }

  // Section 5: Memory section
  if (!memoryDecl.imported) {
    const content = new BinaryWriter();
    content.uleb(1); // 1 memory
    const flags = memoryDecl.shared ? 0x03 : memoryDecl.max !== undefined ? 0x01 : 0x00;
    if (memoryDecl.shared && memoryDecl.max === undefined) throw new Error('Shared memory requires an explicit maximum');
    content.byte(flags);
    content.uleb(memoryDecl.min);
    if (memoryDecl.max !== undefined) content.uleb(memoryDecl.max);
    appendSection(allBytes, 5, content);
  }
  
  // Section 6: Global section
  {
    const content = new BinaryWriter();
    content.uleb(globalDecls.length);
    // $bump_ptr: mut i32 = heap start = after static regions AND the string data
    // section (DATA_BASE + pool size, 16-byte aligned). 1024 when neither exists.
    // With the pool pinned into its own region by `(string.pool ...)`, the pool
    // no longer sits at the top of the data segments, so the heap starts right
    // after those instead of after the pool. Without the declaration this is
    // the original expression, unchanged.
    const bumpHeapStart = stringPoolRegion
      ? (legacyDataBase + 15) & ~15
      : (DATA_BASE + dataPool.bytes.length + 15) & ~15;
    for (const g of globalDecls) {
      content.push(valtypeOf(g.type), g.mutable ? 0x01 : 0x00);
      if (g.runtime === 'bump') {
        content.byte(OP.i32_const);
        content.sleb(bumpHeapStart);
      } else if (g.runtime === 'save') {
        content.byte(OP.i32_const);
        content.sleb(0);
      }
      else if (g.init && Array.isArray(g.init) && REGION_CONST_HEADS.has(V(g.init[1]))) {
        // A region-constant initializer. Resolved through the SAME
        // `regionConstValue` the instruction and data-segment positions use, so
        // the bounds rule on `(region.addr $R OFF)` — and the refusal to compute
        // an address off a span — hold here too.
        content.byte(OP.i32_const);
        content.sleb(regionConstValue(g.init, 0,
          `initializer of global ${g.name || '(anonymous)'}`));
      }
      else {
        const where = `initializer of global ${g.name || '(anonymous)'}`;
        const raw = g.init ? watxConstFormToken(g.init, where) : '0';
        if (g.type === 'i32') {
          content.byte(OP.i32_const);
          content.sleb(watxParseIntLiteral(raw, where));
        } else if (g.type === 'i64') {
          content.byte(OP.i64_const);
          content.slebBig(parseI64Literal(raw));
        } else if (g.type === 'f32') {
          content.byte(OP.f32_const);
          content.append(watxFloatLiteralBytes(raw, where, 4));
        } else {
          content.byte(OP.f64_const);
          content.append(watxFloatLiteralBytes(raw, where, 8));
        }
      }
      content.byte(OP.end);
    }
    appendSection(allBytes, 6, content);
  }
  
  // Section 7: Export section
  {
    const content = new BinaryWriter();
    const exports = [];
    
    // Historical WATX modules export their implicit memory. Explicit-memory
    // modules use explicit exports, matching standard WAT.
    const hasExplicitMemoryForm = forms.some(f => Array.isArray(f) &&
      (V(f[1]) === 'memory' || ((V(f[1]) === 'import' || V(f[1]) === 'wasm-import') && V(f[4]?.[1]) === 'memory')));
    if (!hasExplicitMemoryForm) exports.push({ name: 'memory', kind: 0x02, idx: 0 });
    
    // Export user-declared exports
    for (const exp of exportDecls) {
      const kindByte = { func: 0x00, table: 0x01, memory: 0x02, global: 0x03 }[exp.kind];
      let target;
      if (exp.kind === 'func') target = funcIndexMap.get(exp.ref);
      else if (exp.kind === 'global') target = /^\d+$/.test(exp.ref) ? parseInt(exp.ref) : globalIndexMap.get(exp.ref);
      else if (exp.kind === 'memory') target = (!exp.ref?.startsWith?.('$') || exp.ref === memoryDecl.name) ? 0 : undefined;
      else if (exp.kind === 'table') target = (!exp.ref?.startsWith?.('$') || exp.ref === tableDecl?.name) ? 0 : undefined;
      if (target === undefined) {
        if (standardWat || options.strictReferences) throw new Error(`Export '${exp.exportName}' references unknown ${exp.kind} '${exp.ref}'`);
        continue; // legacy WATX compatibility for existing stale exports
      }
      exports.push({ name: exp.exportName, kind: kindByte, idx: target });
    }
    
    content.uleb(exports.length);
    for (const exp of exports) {
      content.string(exp.name);
      content.byte(exp.kind);
      content.uleb(exp.idx);
    }
    appendSection(allBytes, 7, content);
  }

  // Section 8: Start section — the function the engine runs at instantiate.
  //
  // `(start $f)` used to be PARSED AND DROPPED: the string `start` did not occur
  // anywhere in the compiler, so the form fell off the end of the top-level scan
  // like a comment and no start section was emitted. The module loaded, it
  // validated, and the one function the author asked to run before anything else
  // simply never ran — with nothing to look at, because the difference between
  // "start ran and did nothing" and "start was never wired" is invisible from
  // outside. (watx-differential's stripEmptySections carries a matching scar:
  // a start section's whole payload is a one-byte function index, so `08 01 00`
  // looks exactly like an empty vector and a module whose start never ran once
  // reported as byte-identical to wabt's.)
  //
  // The index space is the one every other section already uses — imports first,
  // then defined functions — so this is `funcIndexMap` and nothing else.
  {
    let startDecl = null;
    for (const form of forms) {
      if (!Array.isArray(form) || V(form[1]) !== 'start') continue;
      if (startDecl !== null) {
        const e = new Error(`Only one (start …) declaration is allowed`);
        const loc = watxFormLoc(form);
        if (loc !== undefined) { e.line = watxNodeLine(loc); e.col = watxNodeCol(loc); e.file = watxNodeFile(loc); }
        throw e;
      }
      startDecl = form;
    }
    if (startDecl !== null) {
      const ref = V(startDecl[2]);
      const fail = (msg) => {
        const e = new Error(`(start ${ref ?? ''}): ${msg}`);
        const loc = watxFormLoc(startDecl);
        if (loc !== undefined) { e.line = watxNodeLine(loc); e.col = watxNodeCol(loc); e.file = watxNodeFile(loc); }
        return e;
      };
      if (watxFormLength(startDecl) !== 2 || ref == null) {
        throw fail('expected exactly one function reference');
      }
      const idx = /^\d+$/.test(ref) ? parseInt(ref) : funcIndexMap.get(ref);
      if (idx === undefined) throw fail(`unknown function '${ref}'`);
      // The wasm spec requires the start function to take no parameters and
      // return nothing; an engine rejects a mismatch, so name it here instead.
      const fd = funcDeclByName.get(ref);
      if (fd && (fd.params.length > 0 || fd.results.length > 0)) {
        throw fail(`a start function must take no parameters and return nothing, ` +
                   `but '${ref}' is declared (param ${fd.params.map(p => p.type).join(' ') || '—'}) ` +
                   `(result ${fd.results.join(' ') || '—'})`);
      }
      const content = new BinaryWriter();
      content.uleb(idx);
      appendSection(allBytes, 8, content);
    }
  }

  // Section 9: Element section (populate table 0 with handler func indices at slots 0..n)
  if (elemSegments.length > 0) {
    const content = new BinaryWriter();
    content.uleb(elemSegments.length);
    for (const seg of elemSegments) {
      if (seg.table !== 0 && seg.table !== '0' && seg.table !== tableDecl?.name) throw new Error(`Unknown table '${seg.table}' in elem segment`);
      content.push(0x00, OP.i32_const);
      content.sleb(seg.offset);
      content.byte(OP.end);
      content.uleb(seg.entries.length);
      for (const fn of seg.entries) {
        const fidx = funcIndexMap.get(fn);
        if (fidx === undefined) throw new Error(`Element segment references unknown function '${fn}'`);
        content.uleb(fidx);
      }
    }
    appendSection(allBytes, 9, content);
  }

  // Section 10: Code section
  {
    const functionCount = (runtimeBuiltins ? 3 : 0) + userFuncTypes.length;
    const content = new BinaryWriter(1024 * 1024);
    content.uleb(functionCount);
    
    if (runtimeBuiltins) {
    // Builtin: $__region_enter(size: i32) → i32
    // Saves bump_ptr, returns current bump_ptr
    {
      const body = new BinaryWriter(16);
      body.byte(0x00); // 0 locals
      body.push(OP.global_get, 0x00); // $bump_ptr
      body.push(OP.global_get, 0x00); // $bump_ptr (save)
      body.push(OP.global_set, 0x01); // $region_save = $bump_ptr
      body.byte(OP.end);
      content.uleb(body.length);
      content.append(body.buffer.subarray(0, body.length));
    }
    
    // Builtin: $__region_alloc(size: i32) → i32
    // Bump allocator: returns current ptr, advances by size (aligned to 4)
    {
      const body = new BinaryWriter(32);
      body.byte(0x00); // 0 locals
      // local 0 = size param
      // result = current $bump_ptr
      body.push(OP.global_get, 0x00); // current $bump_ptr → result
      body.push(OP.global_get, 0x00); // current $bump_ptr
      body.push(OP.local_get, 0x00); // size
      // Align size to 4 bytes: (size + 3) & ~3
      body.push(OP.i32_const, 0x03);
      body.push(OP.i32_add);
      body.push(OP.i32_const, 0x7c); // -4 in signed LEB128 = 0xFFFFFFFC = ~3
      body.push(OP.i32_and);
      body.push(OP.i32_add); // new_ptr = old_ptr + aligned_size
      body.push(OP.global_set, 0x00); // $bump_ptr = new_ptr
      body.byte(OP.end);
      content.uleb(body.length);
      content.append(body.buffer.subarray(0, body.length));
    }
    
    // Builtin: $__region_exit()
    // Restores bump_ptr from region_save
    {
      const body = new BinaryWriter(8);
      body.byte(0x00); // 0 locals
      body.push(OP.global_get, 0x01); // $region_save
      body.push(OP.global_set, 0x00); // $bump_ptr = $region_save
      body.byte(OP.end);
      content.uleb(body.length);
      content.append(body.buffer.subarray(0, body.length));
    }
    }
    
    // User functions
    for (let functionIndex = 0; functionIndex < funcDecls.length; functionIndex++) {
      const fd = funcDecls[functionIndex];
      const retainedBody = fd.body;
      const loadedBody = options.loadFunctionBody && fd.streamInfo ? options.loadFunctionBody(fd) : null;
      if (loadedBody) fd.body = loadedBody.body;
      const ufi = prepareUserFunction(fd, userFuncTypes[functionIndex]);
      const bodyBytes = new BinaryWriter(256);
      
      const isVoidFunc = ufi.results.length === 0;
      
      for (let i = 0; i < ufi.body.length; i++) {
        compileExpr(ufi.body[i], ufi, 0, bodyBytes);
        const isLast = (i === ufi.body.length - 1);
        if (!isLast && needsAutoDrop(ufi.body[i], ufi.body[i + 1], ufi)) {
          // Drop intermediate values — not the return value
          bodyBytes.push(OP.drop);
        } else if (isLast && isVoidFunc && exprProducesValue(ufi.body[i], ufi)) {
          // Void function: drop the last expression's value too
          bodyBytes.push(OP.drop);
        }
      }
      
      // If function has no body, push appropriate default
      if (ufi.body.length === 0) {
        if (ufi.results.length > 0) {
          const rt = ufi.results[0];
          if (rt === 'f32') {
            bodyBytes.byte(OP.f32_const);
            bodyBytes.f32(0);
          }
          else if (rt === 'f64') bodyBytes.push(OP.f64_const, 0,0,0,0,0,0,0,0);
          else bodyBytes.push(OP.i32_const, 0x00);
        }
      }
      
      bodyBytes.push(OP.end);
      
      // Encode locals — MUST preserve declaration order to match localMap indices.
      // Grouping by type (as before) reorders locals and breaks index assignments.
      // Use run-length encoding of consecutive same-type locals instead.
      let localGroupCount = 0;
      for (let li = 0, previousVt = -1; li < ufi.locals.length; li++) {
        const vt = valtypeOf(ufi.locals[li].type);
        if (vt !== previousVt) {
          localGroupCount++;
          previousVt = vt;
        }
      }
      const localSection = new BinaryWriter(Math.max(16, localGroupCount * 3));
      localSection.uleb(localGroupCount);
      if (localGroupCount > 0) {
        let currentVt = valtypeOf(ufi.locals[0].type);
        let count = 1;
        for (let li = 1; li < ufi.locals.length; li++) {
          const vt = valtypeOf(ufi.locals[li].type);
          if (vt === currentVt) {
            count++;
          } else {
            localSection.uleb(count);
            localSection.byte(currentVt);
            currentVt = vt;
            count = 1;
          }
        }
        localSection.uleb(count);
        localSection.byte(currentVt);
      }
      
      const funcBodyLength = localSection.length + bodyBytes.length;
      content.uleb(funcBodyLength);
      content.append(localSection.buffer.subarray(0, localSection.length));
      content.append(bodyBytes.buffer.subarray(0, bodyBytes.length));
      fd.body = retainedBody;
      if (loadedBody) loadedBody.release();
    }
    
    appendSection(allBytes, 10, content);
  }

  // The pool's size is only final now, after every function body has been
  // emitted and every literal interned — so this is the first point at which
  // its extent can be checked at all.
  if (dataPool.bytes.length > 0) {
    const poolEnd = DATA_BASE + dataPool.bytes.length;
    if (stringPoolRegion) {
      const regionEnd = stringPoolRegion.base + stringPoolRegion.size;
      if (poolEnd > regionEnd) {
        throw locatedAt(stringPoolRegion.form,
          `string pool (${dataPool.bytes.length} bytes of interned string/cstring data) runs past ` +
          `the ${stringPoolRegion.size} bytes of region ${stringPoolRegion.name} ` +
          `[0x${stringPoolRegion.base.toString(16).toUpperCase()}, 0x${regionEnd.toString(16).toUpperCase()}) — ` +
          `grow that region by at least ${poolEnd - regionEnd} bytes`);
      }
    } else if (regions.size > 0) {
      // No `(string.pool ...)`, but this module DOES have an allocated region
      // map, so the legacy address is a guess about somebody else's memory.
      // Check it instead of trusting it: a pool that lands inside a region's
      // storage overwrites live state, and neither the [1024, staticCursor)
      // guard above nor a segment-vs-segment overlap check can see it.
      const hit = [...regions.values()].find(
        r => r.size > 0 && DATA_BASE < r.base + r.size && poolEnd > r.base);
      if (hit) {
        throw locatedAt(firstInternFunc ? firstInternFunc.sourceNode : null,
          `String pool [0x${DATA_BASE.toString(16).toUpperCase()}, 0x${poolEnd.toString(16).toUpperCase()}) ` +
          `overlaps the storage of region ${hit.name} ` +
          `[0x${hit.base.toString(16).toUpperCase()}, 0x${(hit.base + hit.size).toString(16).toUpperCase()}). ` +
          `Interned strings — a bare "text" literal, (string ...) or (cstring ...) — are placed above the ` +
          `last data segment by default, which is inside the map when regions are allocated rather than ` +
          `declared static. Declare a region to hold them and name it with (string.pool $REGION).`);
      }
    }
  }

  // Section 11: explicit WAT data segments plus the WATX string pool.
  if (fixedDataSegments.length > 0 || dataPool.bytes.length > 0) {
    const content = new BinaryWriter(Math.max(256, dataPool.bytes.length + 64));
    content.uleb(fixedDataSegments.length + (dataPool.bytes.length ? 1 : 0));
    for (const seg of fixedDataSegments) {
      content.push(0x00, OP.i32_const);
      content.sleb(seg.offset);
      content.byte(OP.end);
      content.uleb(seg.bytes.length);
      content.append(seg.bytes);
    }
    if (dataPool.bytes.length) {
      content.push(0x00, OP.i32_const);
      content.sleb(DATA_BASE);
      content.byte(OP.end);
      content.uleb(dataPool.bytes.length);
      content.append(dataPool.bytes.buffer.subarray(0, dataPool.bytes.length));
    }
    appendSection(allBytes, 11, content);
  }

  // ── Custom section 0: the "name" section (opt-in) ───────────────────────────
  // What this buys: an instantiation failure or a trap stack reports a FUNCTION
  // INDEX and nothing else — `Compiling function #3849 failed: …` in a
  // ~3900-function module concatenated from two dozen files, naming no file, no
  // function and no line. `tools/func-index.js` exists solely to translate that
  // by walking build/combined.wat the same way the compiler does. A name section
  // puts the answer in the artifact, so the engine, DevTools and every profiler
  // print `$handle_CreateWindowExA` instead of `wasm-function[3849]`.
  //
  // OFF BY DEFAULT, and that is not timidity: names are ~100KB of custom section
  // on this module, and the canonical build's byte-identity gate is how every
  // compiler change in this changelog was proved safe. An option that quietly
  // changed the shipped bytes would take that instrument away.
  //
  // The index space is `funcIndexMap` itself — imports, then the runtime
  // builtins, then defined functions — rather than a second walk that agrees
  // with it today. That is the whole point: a name section built from a
  // reconstruction is a name section that can lie, and a lying one is worse than
  // none, because it names a plausible wrong function with total confidence.
  if (options.nameSection) {
    const nameBytes = (w, s) => {
      const utf8 = WATX_UTF8_ENCODER.encode(s);
      w.uleb(utf8.length);
      w.append(utf8);
    };
    const content = new BinaryWriter(1024 * 64);
    content.uleb(4); content.append(WATX_UTF8_ENCODER.encode('name'));

    // Subsection 0: module name.
    {
      const sub = new BinaryWriter();
      nameBytes(sub, typeof options.nameSection === 'string' ? options.nameSection : 'wine-assembly');
      appendSection(content, 0, sub);
    }
    // Subsection 1: the function-name map. The spec requires it sorted by index
    // and free of duplicates, so it is built from the map's entries and sorted —
    // never assumed to come out in order.
    {
      const entries = [];
      for (const [name, idx] of funcIndexMap) {
        if (typeof idx !== 'number') continue;
        // Strip the leading '$'; a wasm name is the identifier, not its sigil.
        entries.push([idx, name.startsWith('$') ? name.slice(1) : name]);
      }
      entries.sort((a, b) => a[0] - b[0]);
      const sub = new BinaryWriter(1024 * 64);
      sub.uleb(entries.length);
      for (const [idx, name] of entries) { sub.uleb(idx); nameBytes(sub, name); }
      appendSection(content, 1, sub);
    }
    // Local names are deliberately skipped: they multiply the section's size for
    // a payoff a stack trace does not need, and the question this exists to
    // answer is "which function is #3849".
    appendSection(allBytes, 0, content);
  }

  const binary = allBytes.finish();
  return {
    binary,
    importDecls,
    moduleImports,
    exportDecls,
    funcDecls: funcNames,
    layoutInfo,
    runtimeBuiltins,
    // The map as the compiler laid it out, so a build banner can print WHICH
    // layout it produced. A shaken artifact that cannot be told from a canonical
    // one is worse than no shake at all.
    regions: regionLayoutReport,
  };
}


// ── WAT-like disassembly for display ──

function disassembleWasm(wasmResult) {
  const { binary, importDecls, exportDecls, funcDecls, layoutInfo, runtimeBuiltins } = wasmResult;
  let out = ';; ═══ WASM Binary Output ═══\n';
  out += `;; Size: ${binary.length} bytes\n`;
  out += `;; Module: ${binary.length < 1024 ? binary.length + 'B' : (binary.length/1024).toFixed(1) + 'KB'}\n`;
  out += ';; Zero implicit coercion — all type conversions explicit in source\n\n';
  
  out += '(module\n';
  out += '  (memory (export "memory") 4 16)  ;; 256KB initial, 1MB max\n\n';
  out += '  (global $bump_ptr (mut i32) (i32.const 1024))\n';
  out += '  (global $region_save (mut i32) (i32.const 0))\n\n';
  
  for (const [name, info] of layoutInfo) {
    out += `  ;; layout ${name} (${info.totalSize} bytes)\n`;
    for (const f of info.fields) {
      out += `  ;;   .${f.name} : ${f.type} @ offset ${f.offset}\n`;
    }
    out += '\n';
  }
  
  for (const imp of importDecls) {
    const params = imp.params.map(valtypeName).join(' ');
    const results = imp.results.map(valtypeName).join(' ');
    out += `  (import "${imp.module}" "${imp.name}" (func ${imp.funcName}`;
    if (params) out += ` (param ${params})`;
    if (results) out += ` (result ${results})`;
    out += '))\n';
  }
  out += '\n';
  
  if (runtimeBuiltins) {
    out += '  ;; ── builtin region management ──\n';
    out += '  (func $__region_enter (param i32) (result i32) ...)\n';
    out += '  (func $__region_alloc (param i32) (result i32) ...)\n';
    out += '  (func $__region_exit ...)\n\n';
  }
  
  out += '  ;; ── user functions ──\n';
  for (const name of funcDecls) {
    out += `  (func ${name} ...)\n`;
  }
  out += '\n';
  
  for (const exp of exportDecls) {
    out += `  (export "${exp.exportName}" (${exp.kind} ${exp.ref}))\n`;
  }
  out += '  (export "memory" (memory 0))\n';
  
  out += ')\n\n';
  
  out += ';; ═══ Hex Dump (first 512 bytes) ═══\n';
  const limit = Math.min(binary.length, 512);
  for (let i = 0; i < limit; i += 16) {
    const hex = [];
    const ascii = [];
    for (let j = 0; j < 16 && i+j < limit; j++) {
      const b = binary[i+j];
      hex.push(b.toString(16).padStart(2, '0'));
      ascii.push(b >= 32 && b < 127 ? String.fromCharCode(b) : '.');
    }
    out += `;; ${i.toString(16).padStart(6, '0')}  ${hex.join(' ').padEnd(48)}  ${ascii.join('')}\n`;
  }
  if (binary.length > limit) {
    out += `;; ... (${binary.length - limit} more bytes)\n`;
  }
  
  return out;
}
