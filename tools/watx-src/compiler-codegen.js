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
  
  function sizeOfType(t) {
    if (t === 'i32' || t === 'f32') return 4;
    if (t === 'i64' || t === 'f64') return 8;
    if (t === 'u8') return 1;
    if (t?.startsWith && t.startsWith('ptr')) return 4;
    return 4;
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
// NOT SUPPORTED, deliberately, and now rejected loudly instead of silently
// truncated: hex floats (`0x1p4`), `inf`/`nan[:0x…]`, and a `+`-signed exponent
// (`1e+10`). No site in the Wine-Assembly closure uses any of them (a NEGATIVE
// exponent, `2.2250738585072014e-308` at src/06-fpu.wat:193, does tokenize and
// keeps working). Adding them is a tokenizer change plus an encoder, not a
// validator change.
const WATX_INT_LITERAL_RE = /^[+-]?(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|[0-9](?:_?[0-9])*)$/;
const WATX_FLOAT_LITERAL_RE =
  /^[+-]?(?:[0-9](?:_?[0-9])*)(?:\.(?:[0-9](?:_?[0-9])*)?)?(?:[eE]-?[0-9](?:_?[0-9])*)?$/;

function watxLiteralReject(raw, what, expected) {
  const shown = raw === undefined || raw === null ? '<missing>' : String(raw);
  const e = new Error(
    `Invalid ${expected} literal '${shown}'${what ? ` in ${what}` : ''}: ` +
    `a numeric literal must parse in its entirety (trailing junk is not ignored; ` +
    `'_' is allowed only between digits)`);
  e.watxLiteral = shown;
  return e;
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


function generateWasm(forms, loweredForms, checkResult, options = {}) {
  const V = watxValue;
  const T = watxType;
  // Preserve the historical WATX runtime by default. Compatibility/migration
  // builds can disable it so declarations retain exact Wasm indices.
  const runtimeBuiltins = options.runtimeBuiltins !== false;
  const tailCalls = options.tailCalls !== false;
  const standardWat = options.standardWat === true;

  // ── Positional-else warning (see the `if` compiler below) ──────────────────
  // One line per SOURCE SITE, not per compile of that site: a function body can be
  // walked more than once and the closure is compiled twice (tail / compat).
  const positionalElseSeen = new Set();
  function warnPositionalElse(expr, func) {
    const loc = watxFormLoc(expr);
    const file = loc !== undefined ? watxNodeFile(loc) : '<unknown>';
    const line = loc !== undefined ? watxNodeLine(loc) : 0;
    const key = `${file}:${line}`;
    if (positionalElseSeen.has(key)) return;
    positionalElseSeen.add(key);
    console.warn(
      `[WATX WARNING] ${file}:${line}: bare expression in the else slot of ` +
      `(if COND (then ...) EXPR)${func && func.name ? ` in ${func.name}` : ''} — ` +
      `standard WAT requires (else ...). WATX is compiling it AS the else arm; ` +
      `note that lib/compile-wat.js silently DISCARDS it instead, so the two ` +
      `compilers disagree here. Wrap it in (else ...). This will become a hard error.`);
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
  const dataPool = { bytes: new BinaryWriter(1024), map: new Map() };
  function unescapeStr(raw) {
    // raw includes surrounding quotes; strip and process escapes
    let s = raw;
    if (s[0] === '"') s = s.slice(1, s[s.length - 1] === '"' ? -1 : s.length);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && i + 1 < s.length) {
        const n = s[++i];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r'
             : n === '0' ? '\0' : n === '\\' ? '\\' : n === '"' ? '"' : n;
      } else out += s[i];
    }
    return out;
  }
  // Standard WAT strings use \hh byte escapes (not C-style octal escapes).
  // Data segments need the exact byte stream, including non-UTF8 bytes.
  function decodeWatStringBytes(raw) {
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
  
  function parseLimits(mem) {
    const nums = [];
    let shared = false;
    let name = null;
    for (let i = 1; i < (mem.length - 1); i++) {
      const item = mem[i + 1];
      const v = V(item);
      if (v?.startsWith('$') && name === null) name = v;
      else if (v === 'shared') shared = true;
      else if (T(item) === 'number') nums.push(parseInt(v));
    }
    return { name, min: nums[0] ?? 16, max: nums[1], shared };
  }

  // Collect imports. `wasm-import` is the WATX spelling; standard `import`
  // is intentionally accepted to make large existing WAT trees migratable.
  const importDecls = [];
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
            }
          }
        }
        const imp = { kind: 'func', module: mod, name, funcName, params, results };
        importDecls.push(imp);
        moduleImports.push(imp);
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

  const fixedDataSegments = [];
  for (const form of forms) {
    if (!Array.isArray(form) || V(form[1]) !== 'data') continue;
    let i = 1;
    if (V(form[i + 1])?.startsWith('$')) i++; // optional segment id
    if (Array.isArray(form[i + 1]) && V(form[i + 1][1]) === 'memory') i++; // explicit memory selector
    const offsetForm = form[(i++) + 1];
    if (!Array.isArray(offsetForm) || V(offsetForm[1]) !== 'i32.const') throw new Error('Active data requires an i32.const offset');
    const offset = watxParseIntLiteral(
      watxConstFormToken(offsetForm, 'active data segment offset'), 'active data segment offset');
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Data offset must be a non-negative integer');
    const bytes = [];
    for (; i < (form.length - 1); i++) {
      const fragment=form[i + 1];
      if (T(fragment) !== 'string') throw new Error('Data payload must contain string fragments');
      appendArray(bytes, decodeWatStringBytes(V(fragment)));
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
    if (!Array.isArray(init) || V(init[1]) !== `${type}.const`) throw new Error(`Global ${name} requires a ${type}.const initializer`);
    if (globalNameSet.has(name)) throw new Error(`Duplicate global '${name}'`);
    globalNameSet.add(name);
    globalDecls.push({ name, type, mutable, init });
  }
  const globalIndexMap = new Map(globalDecls.map((g, i) => [g.name, i]));

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
      }
    }
    return { params, results };
  }

  // Collect region declarations
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

  // Lay static regions out at fixed base addresses and start the bump heap after
  // them. This makes a `(region.declare-static $r (size N))` symbol resolve to a
  // real base address (see compileExpr's symbol handler), so code addresses the
  // region by NAME — e.g. `(store.elem Ball x $balls i v)` — instead of a magic
  // number. Static regions occupy [1024, bumpStart); the bump allocator's heap
  // begins at bumpStart. With no static regions (e.g. all of android-emu) the
  // bump heap stays at 1024, so this is a no-op there.
  const STATIC_REGION_BASE = 1024;
  const regionBase = new Map();
  let staticCursor = STATIC_REGION_BASE;
  for (const rd of regionDecls) {
    if (rd.kind === 'static') {
      regionBase.set(rd.name, staticCursor);
      staticCursor += (rd.size + 15) & ~15; // 16-byte align (safe for f64/v128)
    }
  }
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
  DATA_BASE = Math.max(staticCursor, ...fixedDataSegments.map(seg => seg.offset + seg.bytes.length));
  DATA_BASE = (DATA_BASE + 15) & ~15;

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

  // ── block / loop signature ─────────────────────────────────────────────────
  // Returns the declared result valtype of a `(block $l (result T) …)` / `(loop …)`,
  // or null when the node is not a signature at all. Also accepts the bare-valtype
  // spelling `if` already takes. An unknown type name is a hard error rather than a
  // silent fall back to void — that fall-back is what migration gap G4 was.
  function blockSignature(node, head) {
    const named = ['i32', 'i64', 'f32', 'f64', 'v128'];
    if (Array.isArray(node) && V(node[1]) === 'result') {
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
    const head = V(expr[1]);
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
          bytes.f32(watxParseFloatLiteral(val, where));
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
            bytes.f32(watxParseFloatLiteral(val, where));
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
        const ptr = internCStr(V(expr));
        bytes.byte(OP.i32_const);
        bytes.sleb(ptr);
        return bytes;
      }
      return bytes;
    }

    const head = V(expr[1]);

    if (head === 'unreachable') {
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
      const raw = V(expr[2]) || '""';
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
          bytes.f32(watxParseFloatLiteral(raw, where));
        } else {
          bytes.byte(OP.f64_const);
          bytes.f64(watxParseFloatLiteral(raw, where));
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
      if ((expr.length - 1) !== 4) throw new Error(`memory.copy: expected 3 args (dst,src,len), got ${(expr.length - 1) - 1}`);
      compileExpr(expr[2], func, depth, bytes);   // dst
      compileExpr(expr[3], func, depth, bytes);   // src
      compileExpr(expr[4], func, depth, bytes);   // len
      bytes.push(0xFC, 0x0A, 0x00, 0x00);
      return bytes;
    }
    if (head === 'memory.fill') {
      if ((expr.length - 1) !== 4) throw new Error(`memory.fill: expected 3 args (dst,val,len), got ${(expr.length - 1) - 1}`);
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

    // v128.const — 16 immediate bytes. WATX form: (v128.const b0 b1 ... b15).
    // Useful for tests + compile-time lane masks (e.g. shuffle helpers, 0xff sentinels).
    if (head === 'v128.const') {
      bytes.byte(0xFD);
      bytes.uleb(0x0C);
      for (let i = 0; i < 16; i++) {
        const b = immVal(expr[2 + i], 0);
        bytes.push(b & 0xff);
      }
      return bytes;
    }

    // any_true / all_true — reductions (v128) -> i32.
    if (head === 'v128.any_true') {
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
      compileExpr(expr[2], func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(simdAllTrueOps[head]);
      return bytes;
    }
    // bitselect (a b mask) -> v128
    if (head === 'v128.bitselect') {
      compileExpr(expr[2], func, depth, bytes);
      compileExpr(expr[3], func, depth, bytes);
      compileExpr(expr[4], func, depth, bytes);
      bytes.byte(0xFD);
      bytes.uleb(0x52);
      return bytes;
    }

    // ── local.get / local.set / local.tee ──
    if (head === 'local.get') {
      const name = V(expr[2]);
      const numeric = /^\d+$/.test(name || '') ? parseInt(name) : undefined;
      const localIdx = numeric ?? func.activeLocal.get(name) ?? func.localMap.get(name);
      if (localIdx === undefined || localIdx >= func.params.length + func.locals.length) throw new Error(`Unknown local '${name}' in ${func.name}`);
      bytes.byte(OP.local_get);
      bytes.uleb(localIdx);
      return bytes;
    }
    
    if (head === 'local.set' || head === 'local.tee' || head === 'set!') {
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
      return bytes;
    }

    // ── let — local variable binding ──
    if (head === 'let') {
      const name = V(expr[2]);
      let initExpr, declaredType;
      
      // (let $name type init) or (let $name init)
      if ((expr.length - 1) >= 4 && T(expr[3]) === 'symbol' &&
          ['i32','i64','f32','f64','v128','u8','ptr','weak'].includes(V(expr[3]))) {
        declaredType = V(expr[3]);
        initExpr = expr[4];
      } else {
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
          // NOT standard WAT — the spec form is (else ...). Accepted for now
          // because the Wine tree still has such sites, but warned about once per
          // site so they can be found and wrapped; promotion to a hard error is
          // planned for when the closure has none left.
          // Only when the then arm was written in the standard (then ...) form:
          // WATX's own `(if COND A B)` shorthand has no (then ...) either and is a
          // deliberate, documented WATX spelling, not a mistake to warn about.
          if (sawThenForm) warnPositionalElse(expr, func);
          elseExpr = expr[restIdx + 1];
          restIdx++;
        }
      }
      
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
        label = V(expr[2]);
        if ((expr.length - 1) > 3) { valueExpr = expr[3]; condExpr = expr[4]; }
        else condExpr = expr[3];
      } else {
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
      if (expr[2]) {
        compileExpr(expr[2], func, depth, bytes);
      }
      bytes.push(OP.return_);
      return bytes;
    }

    // ── drop ──
    if (head === 'drop') {
      if (expr[2]) compileExpr(expr[2], func, depth, bytes);
      bytes.push(OP.drop);
      return bytes;
    }
    
    // ── nop ──
    if (head === 'nop') {
      bytes.push(OP.nop);
      return bytes;
    }

    // ── select ──
    if (head === 'select') {
      compileExpr(expr[2], func, depth, bytes);
      compileExpr(expr[3], func, depth, bytes);
      compileExpr(expr[4], func, depth, bytes);
      bytes.push(OP.select);
      return bytes;
    }
    
    // ── memory.size / memory.grow ──
    if (head === 'memory.size') {
      bytes.push(OP.memory_size, 0x00);
      return bytes;
    }
    if (head === 'memory.grow') {
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

    // ── region.alloc ──
    if (head === 'region.alloc') {
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
      const layoutName = V(expr[2]);
      const fieldName = V(expr[3]);
      const ptrExpr = expr[4];
      const valExpr = expr[5];
      
      const info = lookupLayout(layoutName, 'store.field', expr[2]);
      const field = lookupField(info, fieldName, 'store.field', expr[3]);
      const offset = field.offset;
      const fieldType = field.type;

      // ptr + offset
      compileExpr(ptrExpr, func, depth, bytes);
      if (offset > 0) {
        bytes.byte(OP.i32_const);
        bytes.sleb(offset);
        bytes.push(OP.i32_add);
      }
      
      // value
      compileExpr(valExpr, func, depth, bytes);
      
      // store based on type
      if (fieldType === 'f32') {
        bytes.push(OP.f32_store, 0x02, 0x00);
      } else if (fieldType === 'f64') {
        bytes.push(OP.f64_store, 0x03, 0x00);
      } else if (fieldType === 'u8') {
        bytes.push(OP.i32_store8, 0x00, 0x00);
      } else if (fieldType === 'i64') {
        bytes.push(OP.i64_store, 0x03, 0x00);
      } else {
        bytes.push(OP.i32_store, 0x02, 0x00);
      }
      
      // store.field evaluates to 0
      bytes.byte(OP.i32_const);
      bytes.sleb(0);
      return bytes;
    }

    // ── load.field ──
    if (head === 'load.field') {
      const layoutName = V(expr[2]);
      const fieldName = V(expr[3]);
      const ptrExpr = expr[4];
      
      const info = lookupLayout(layoutName, 'load.field', expr[2]);
      const field = lookupField(info, fieldName, 'load.field', expr[3]);
      const offset = field.offset;
      const fieldType = field.type;

      compileExpr(ptrExpr, func, depth, bytes);
      if (offset > 0) {
        bytes.byte(OP.i32_const);
        bytes.sleb(offset);
        bytes.push(OP.i32_add);
      }
      
      if (fieldType === 'f32') {
        bytes.push(OP.f32_load, 0x02, 0x00);
      } else if (fieldType === 'f64') {
        bytes.push(OP.f64_load, 0x03, 0x00);
      } else if (fieldType === 'u8') {
        bytes.push(OP.i32_load8_u, 0x00, 0x00);
      } else if (fieldType === 'i64') {
        bytes.push(OP.i64_load, 0x03, 0x00);
      } else {
        bytes.push(OP.i32_load, 0x02, 0x00);
      }
      return bytes;
    }

    // ── store.elem — array element store ──
    if (head === 'store.elem') {
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
      if (fieldOffset > 0) {
        bytes.byte(OP.i32_const);
        bytes.sleb(fieldOffset);
        bytes.push(OP.i32_add);
      }
      
      compileExpr(valExpr, func, depth, bytes);
      
      if (fieldType === 'f32') {
        bytes.push(OP.f32_store, 0x02, 0x00);
      } else if (fieldType === 'f64') {
        bytes.push(OP.f64_store, 0x03, 0x00);
      } else if (fieldType === 'u8') {
        bytes.push(OP.i32_store8, 0x00, 0x00);
      } else {
        bytes.push(OP.i32_store, 0x02, 0x00);
      }
      
      bytes.byte(OP.i32_const);
      bytes.sleb(0);
      return bytes;
    }

    // ── load.elem — array element load ──
    if (head === 'load.elem') {
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
      if (fieldOffset > 0) {
        bytes.byte(OP.i32_const);
        bytes.sleb(fieldOffset);
        bytes.push(OP.i32_add);
      }
      
      if (fieldType === 'f32') {
        bytes.push(OP.f32_load, 0x02, 0x00);
      } else if (fieldType === 'f64') {
        bytes.push(OP.f64_load, 0x03, 0x00);
      } else if (fieldType === 'u8') {
        bytes.push(OP.i32_load8_u, 0x00, 0x00);
      } else {
        bytes.push(OP.i32_load, 0x02, 0x00);
      }
      return bytes;
    }

    // ── store.field-elem — store element `idx` of an ARRAY FIELD inside a struct ──
    // (store.field-elem Layout field base idx val) -> mem[base + fieldOffset + idx*stride] = val.
    // Distinct from store.elem (which strides by the WHOLE struct size for arrays-of-structs); this
    // strides by the field's own element stride, for a `(field name type count [stride])` array member.
    if (head === 'store.field-elem') {
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

      compileExpr(valExpr, func, depth, bytes);

      if (fieldType === 'f32') {
        bytes.push(OP.f32_store, 0x02, 0x00);
      } else if (fieldType === 'f64') {
        bytes.push(OP.f64_store, 0x03, 0x00);
      } else if (fieldType === 'i64') {
        bytes.push(OP.i64_store, 0x03, 0x00);
      } else if (fieldType === 'u8') {
        bytes.push(OP.i32_store8, 0x00, 0x00);
      } else {
        bytes.push(OP.i32_store, 0x02, 0x00);
      }

      bytes.byte(OP.i32_const);
      bytes.sleb(0);
      return bytes;
    }

    // ── load.field-elem — load element `idx` of an ARRAY FIELD inside a struct ──
    if (head === 'load.field-elem') {
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

      if (fieldType === 'f32') {
        bytes.push(OP.f32_load, 0x02, 0x00);
      } else if (fieldType === 'f64') {
        bytes.push(OP.f64_load, 0x03, 0x00);
      } else if (fieldType === 'i64') {
        bytes.push(OP.i64_load, 0x03, 0x00);
      } else if (fieldType === 'u8') {
        bytes.push(OP.i32_load8_u, 0x00, 0x00);
      } else {
        bytes.push(OP.i32_load, 0x02, 0x00);
      }
      return bytes;
    }

    // ── elem-addr — ADDRESS of element `idx` of an array field (load.field-elem minus the final load) ──
    // (elem-addr Layout field base idx) -> base + offset-of(field) + idx*stride, as an i32 address.
    // For sites that compute a register/matrix base address then do their own lane arithmetic off it
    // (B's ~311 NEON `800 + rn*16` sites; RES Gl2State matrix-element addresses) -- keeps the offset+
    // stride compile-time/layout-typed without forcing a load of the element's declared width.
    if (head === 'elem-addr') {
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
      const layoutName = V(expr[2]);
      const size = lookupLayout(layoutName, 'size-of', expr[2]).totalSize;
      bytes.byte(OP.i32_const);
      bytes.sleb(size);
      return bytes;
    }

    // ── offset-of ──
    if (head === 'offset-of') {
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
          bytes.byte(0xFE);
          bytes.uleb(aspec.op);
          bytes.byte(0x00);
          return bytes;
        }
        const ma = parseMemarg(expr, 1, head, aspec.align, true);
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
      const name = V(expr[2]);
      const globalIdx = /^\d+$/.test(name || '') ? parseInt(name) : globalIndexMap.get(name);
      if (globalIdx === undefined || globalIdx >= globalDecls.length) throw new Error(`Unknown global '${name}' in ${func.name}`);
      bytes.byte(OP.global_get);
      bytes.uleb(globalIdx);
      return bytes;
    }
    if (head === 'global.set') {
      const name = V(expr[2]);
      const globalIdx = /^\d+$/.test(name || '') ? parseInt(name) : globalIndexMap.get(name);
      if (globalIdx === undefined || globalIdx >= globalDecls.length) throw new Error(`Unknown global '${name}' in ${func.name}`);
      if (!globalDecls[globalIdx].mutable) throw new Error(`Cannot set immutable global '${name}'`);
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
    const hd = V(expr[1]);
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

    // let — type of body (last expression after bindings)
    if (hd === 'let') {
      // (let $name type? init body...)
      // Find where body starts: after name, optional type, init
      let bodyStart = 3; // default: (let $name init body)
      if ((expr.length - 1) >= 4 && T(expr[3]) === 'symbol' &&
          ['i32','i64','f32','f64','v128','u8','ptr','weak'].includes(V(expr[3]))) {
        bodyStart = 4; // has explicit type: (let $name type init body)
      }
      if ((expr.length - 1) > bodyStart) {
        return inferExprType(expr[expr.length - 1]); // type of last body expr
      }
      return 'i32';
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
    const bumpHeapStart = (DATA_BASE + dataPool.bytes.length + 15) & ~15;
    for (const g of globalDecls) {
      content.push(valtypeOf(g.type), g.mutable ? 0x01 : 0x00);
      if (g.runtime === 'bump') {
        content.byte(OP.i32_const);
        content.sleb(bumpHeapStart);
      } else if (g.runtime === 'save') {
        content.byte(OP.i32_const);
        content.sleb(0);
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
          content.f32(watxParseFloatLiteral(raw, where));
        } else {
          content.byte(OP.f64_const);
          content.f64(watxParseFloatLiteral(raw, where));
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

  const binary = allBytes.finish();
  return {
    binary,
    importDecls,
    moduleImports,
    exportDecls,
    funcDecls: funcNames,
    layoutInfo,
    runtimeBuiltins,
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
