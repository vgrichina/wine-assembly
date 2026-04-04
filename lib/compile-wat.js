// Compile WAT source files to WASM binary
// Pure-JS WAT→WASM compiler, zero dependencies. Works in Node.js and browser.
// Two-pass streaming design: pass 1 collects declarations, pass 2 re-reads files
// and emits function bodies one at a time. Only ~20KB of metadata stays in memory.

const WAT_FILES = [
  '01-header.wat', '01b-api-hashes.generated.wat', '02-thread-table.wat',
  '03-registers.wat', '04-cache.wat', '05-alu.wat', '05b-string-ops.wat',
  '06-fpu.wat', '07-decoder.wat', '08-pe-loader.wat', '08b-dll-loader.wat',
  '09a-handlers.wat', '09a2-handlers-console.wat', '09a3-handlers-audio.wat',
  '09a4-handlers-gdi.wat', '09a5-handlers-window.wat', '09a6-handlers-crt.wat',
  '09a7-handlers-dispatch.wat', '09b-dispatch.wat', '09b2-dispatch-table.generated.wat',
  '09c-help.wat', '10-helpers.wat', '11-seh.wat', '12-wsprintf.wat', '13-exports.wat',
];

// ============================================================
// OPCODE TABLE
// ============================================================
const OPCODES = {
  'unreachable': 0x00, 'nop': 0x01, 'block': 0x02, 'loop': 0x03,
  'if': 0x04, 'else': 0x05, 'end': 0x0B, 'br': 0x0C, 'br_if': 0x0D,
  'br_table': 0x0E, 'return': 0x0F, 'call': 0x10, 'call_indirect': 0x11, 'return_call': 0x12,
  'drop': 0x1A, 'select': 0x1B,
  'local.get': 0x20, 'local.set': 0x21, 'local.tee': 0x22,
  'global.get': 0x23, 'global.set': 0x24,
  // Memory
  'i32.load': 0x28, 'i64.load': 0x29, 'f32.load': 0x2A, 'f64.load': 0x2B,
  'i32.load8_s': 0x2C, 'i32.load8_u': 0x2D, 'i32.load16_s': 0x2E, 'i32.load16_u': 0x2F,
  'i64.load8_s': 0x30, 'i64.load8_u': 0x31, 'i64.load16_s': 0x32, 'i64.load16_u': 0x33,
  'i64.load32_s': 0x34, 'i64.load32_u': 0x35,
  'i32.store': 0x36, 'i64.store': 0x37, 'f32.store': 0x38, 'f64.store': 0x39,
  'i32.store8': 0x3A, 'i32.store16': 0x3B,
  'i64.store8': 0x3C, 'i64.store16': 0x3D, 'i64.store32': 0x3E,
  'memory.size': 0x3F, 'memory.grow': 0x40,
  // Constants
  'i32.const': 0x41, 'i64.const': 0x42, 'f32.const': 0x43, 'f64.const': 0x44,
  // i32 comparison
  'i32.eqz': 0x45, 'i32.eq': 0x46, 'i32.ne': 0x47,
  'i32.lt_s': 0x48, 'i32.lt_u': 0x49, 'i32.gt_s': 0x4A, 'i32.gt_u': 0x4B,
  'i32.le_s': 0x4C, 'i32.le_u': 0x4D, 'i32.ge_s': 0x4E, 'i32.ge_u': 0x4F,
  // i64 comparison
  'i64.eqz': 0x50, 'i64.eq': 0x51, 'i64.ne': 0x52,
  'i64.lt_s': 0x53, 'i64.lt_u': 0x54, 'i64.gt_s': 0x55, 'i64.gt_u': 0x56,
  'i64.le_s': 0x57, 'i64.le_u': 0x58, 'i64.ge_s': 0x59, 'i64.ge_u': 0x5A,
  // f64 comparison
  'f64.eq': 0x61, 'f64.ne': 0x62, 'f64.lt': 0x63, 'f64.gt': 0x64,
  'f64.le': 0x65, 'f64.ge': 0x66,
  // i32 arithmetic
  'i32.clz': 0x67, 'i32.ctz': 0x68, 'i32.popcnt': 0x69,
  'i32.add': 0x6A, 'i32.sub': 0x6B, 'i32.mul': 0x6C,
  'i32.div_s': 0x6D, 'i32.div_u': 0x6E, 'i32.rem_s': 0x6F, 'i32.rem_u': 0x70,
  'i32.and': 0x71, 'i32.or': 0x72, 'i32.xor': 0x73,
  'i32.shl': 0x74, 'i32.shr_s': 0x75, 'i32.shr_u': 0x76,
  'i32.rotl': 0x77, 'i32.rotr': 0x78,
  // i64 arithmetic
  'i64.clz': 0x79, 'i64.ctz': 0x7A, 'i64.popcnt': 0x7B,
  'i64.add': 0x7C, 'i64.sub': 0x7D, 'i64.mul': 0x7E,
  'i64.div_s': 0x7F, 'i64.div_u': 0x80, 'i64.rem_s': 0x81, 'i64.rem_u': 0x82,
  'i64.and': 0x83, 'i64.or': 0x84, 'i64.xor': 0x85,
  'i64.shl': 0x86, 'i64.shr_s': 0x87, 'i64.shr_u': 0x88,
  'i64.rotl': 0x89, 'i64.rotr': 0x8A,
  // f64 arithmetic
  'f64.abs': 0x99, 'f64.neg': 0x9A, 'f64.ceil': 0x9B, 'f64.floor': 0x9C,
  'f64.trunc': 0x9D, 'f64.nearest': 0x9E, 'f64.sqrt': 0x9F,
  'f64.add': 0xA0, 'f64.sub': 0xA1, 'f64.mul': 0xA2, 'f64.div': 0xA3,
  'f64.min': 0xA4, 'f64.max': 0xA5,
  // Conversions
  'i32.wrap_i64': 0xA7,
  'i32.trunc_f64_s': 0xAA, 'i32.trunc_f64_u': 0xAB,
  'i64.extend_i32_s': 0xAC, 'i64.extend_i32_u': 0xAD,
  'i64.trunc_f64_s': 0xB0,
  'f32.demote_f64': 0xB6,
  'f64.convert_i32_s': 0xB7, 'f64.convert_i32_u': 0xB8,
  'f64.convert_i64_s': 0xB9, 'f64.convert_i64_u': 0xBA,
  'f64.promote_f32': 0xBB,
  'i32.extend8_s': 0xC0, 'i32.extend16_s': 0xC1,
};

// 0xFC-prefixed ops
const FC_OPS = {
  'i32.trunc_sat_f64_s': 0x02, 'i32.trunc_sat_f64_u': 0x03,
  'i64.trunc_sat_f64_s': 0x06, 'i64.trunc_sat_f64_u': 0x07,
  'memory.copy': 0x0A, 'memory.fill': 0x0B,
};

const VALTYPES = { 'i32': 0x7F, 'i64': 0x7E, 'f32': 0x7D, 'f64': 0x7C };
const BLOCKTYPE_VOID = 0x40;

// Set of ops that take memarg (align + offset)
const MEMARG_OPS = new Set([
  'i32.load', 'i64.load', 'f32.load', 'f64.load',
  'i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u',
  'i64.load8_s', 'i64.load8_u', 'i64.load16_s', 'i64.load16_u',
  'i64.load32_s', 'i64.load32_u',
  'i32.store', 'i64.store', 'f32.store', 'f64.store',
  'i32.store8', 'i32.store16',
  'i64.store8', 'i64.store16', 'i64.store32',
]);

function naturalAlign(op) {
  if (op.includes('8')) return 0;
  if (op.includes('16')) return 1;
  if (op.startsWith('i32') || op.startsWith('f32')) return 2;
  return 3; // i64, f64
}

// ============================================================
// BINARY WRITER
// ============================================================
class BinaryWriter {
  constructor(initSize) {
    this.buf = new Uint8Array(initSize || 65536);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length;
    while (size < this.pos + n) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf);
    this.buf = nb;
  }
  byte(v) { this.ensure(1); this.buf[this.pos++] = v & 0xFF; }
  bytes(arr) {
    const n = arr.length;
    this.ensure(n);
    if (arr instanceof Uint8Array) this.buf.set(arr, this.pos);
    else for (let i = 0; i < n; i++) this.buf[this.pos + i] = arr[i];
    this.pos += n;
  }
  uleb(v) {
    this.ensure(5);
    v = v >>> 0;
    do {
      let b = v & 0x7F; v >>>= 7;
      if (v) b |= 0x80;
      this.buf[this.pos++] = b;
    } while (v);
  }
  sleb(v) {
    this.ensure(5);
    v = v | 0;
    for (;;) {
      const b = v & 0x7F; v >>= 7;
      if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { this.buf[this.pos++] = b; return; }
      this.buf[this.pos++] = b | 0x80;
    }
  }
  sleb64(v) {
    this.ensure(10);
    for (;;) {
      const b = Number(v & 0x7Fn); v >>= 7n;
      if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) { this.buf[this.pos++] = b; return; }
      this.buf[this.pos++] = b | 0x80;
    }
  }
  f64(v) {
    this.ensure(8);
    new DataView(this.buf.buffer, this.buf.byteOffset).setFloat64(this.pos, v, true);
    this.pos += 8;
  }
  f32(v) {
    this.ensure(4);
    new DataView(this.buf.buffer, this.buf.byteOffset).setFloat32(this.pos, v, true);
    this.pos += 4;
  }
  // Write section: id byte, then LEB-prefixed content via callback
  section(id, fn) {
    this.byte(id);
    const tmp = new BinaryWriter(32768);
    fn(tmp);
    this.uleb(tmp.pos);
    this.ensure(tmp.pos);
    this.buf.set(tmp.buf.subarray(0, tmp.pos), this.pos);
    this.pos += tmp.pos;
  }
  appendWriter(other) {
    this.ensure(other.pos);
    this.buf.set(other.buf.subarray(0, other.pos), this.pos);
    this.pos += other.pos;
  }
  result() { return this.buf.slice(0, this.pos); }
}

// ============================================================
// TOKENIZER — processes one string at a time, returns flat token array
// ============================================================
function tokenize(src) {
  const tokens = [];
  let i = 0;
  const len = src.length;
  while (i < len) {
    const c = src.charCodeAt(i);
    if (c <= 32) { i++; continue; } // whitespace
    if (c === 59 /* ; */) { // line comment
      if (i + 1 < len && src.charCodeAt(i + 1) === 59) {
        i += 2; while (i < len && src.charCodeAt(i) !== 10) i++; continue;
      }
    }
    if (c === 40 /* ( */) {
      if (i + 1 < len && src.charCodeAt(i + 1) === 59) { // block comment
        i += 2; let depth = 1;
        while (i < len && depth) {
          if (src.charCodeAt(i) === 40 && i + 1 < len && src.charCodeAt(i + 1) === 59) { depth++; i += 2; }
          else if (src.charCodeAt(i) === 59 && i + 1 < len && src.charCodeAt(i + 1) === 41) { depth--; i += 2; }
          else i++;
        }
        continue;
      }
      tokens.push('('); i++; continue;
    }
    if (c === 41 /* ) */) { tokens.push(')'); i++; continue; }
    if (c === 34 /* " */) {
      let s = '';
      i++;
      while (i < len && src.charCodeAt(i) !== 34) {
        if (src.charCodeAt(i) === 92 /* \ */) {
          i++;
          if (i >= len) break;
          const e = src.charCodeAt(i);
          if (e === 110) { s += '\n'; i++; }
          else if (e === 116) { s += '\t'; i++; }
          else if (e === 114) { s += '\r'; i++; }
          else if (e === 92) { s += '\\'; i++; }
          else if (e === 34) { s += '"'; i++; }
          else { // hex escape \XX
            const h1 = src[i], h2 = i + 1 < len ? src[i + 1] : '0';
            s += String.fromCharCode(parseInt(h1 + h2, 16));
            i += 2;
          }
        } else { s += src[i++]; }
      }
      if (i < len) i++; // closing "
      tokens.push({ str: s });
      continue;
    }
    // Atom
    const start = i;
    while (i < len) {
      const cc = src.charCodeAt(i);
      if (cc <= 32 || cc === 40 || cc === 41 || cc === 59 || cc === 34) break;
      i++;
    }
    tokens.push(src.substring(start, i));
  }
  return tokens;
}

// ============================================================
// S-EXPRESSION PARSER — returns nested arrays from flat token array
// ============================================================
function parseSExprs(tokens) {
  const result = [];
  let i = 0;
  function parse() {
    if (tokens[i] === '(') {
      i++;
      const list = [];
      while (i < tokens.length && tokens[i] !== ')') list.push(parse());
      if (i < tokens.length) i++; // ')'
      return list;
    }
    return tokens[i++];
  }
  while (i < tokens.length) result.push(parse());
  return result;
}

// ============================================================
// HELPERS
// ============================================================
function parseNumber(s) {
  if (typeof s !== 'string') return 0;
  s = s.replace(/_/g, '');
  const neg = s.startsWith('-');
  let raw = neg ? s.substring(1) : s;
  let v;
  if (raw.startsWith('0x') || raw.startsWith('0X')) v = parseInt(raw.substring(2), 16);
  else if (raw.includes('.') || raw.includes('e') || raw.includes('E') ||
           raw === 'inf' || raw === 'nan') v = parseFloat(raw);
  else v = parseInt(raw, 10);
  return neg ? -v : v;
}

function parseBigInt(s) {
  if (typeof s !== 'string') return 0n;
  s = s.replace(/_/g, '');
  const neg = s.startsWith('-');
  let raw = neg ? s.substring(1) : s;
  const v = raw.startsWith('0x') || raw.startsWith('0X')
    ? BigInt('0x' + raw.substring(2)) : BigInt(raw);
  return neg ? -v : v;
}

function sigKey(params, results) {
  return params.join(',') + ':' + results.join(',');
}

function encodeUTF8(s) {
  const b = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) b.push(c);
    else if (c < 0x800) { b.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
    else { b.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
  }
  return b;
}

function resolveRef(ref, nameMap, kind) {
  if (typeof ref === 'string' && ref.startsWith('$')) {
    const v = nameMap[ref];
    if (v !== undefined) return v;
    console.warn(`compile-wat: unknown ${kind}: ${ref}`);
    return 0;
  }
  return parseNumber(ref) || 0;
}

// Parse (param ...) (result ...) (local ...) (export ...) (type ...) from func body items
function parseFuncSig(items) {
  const params = [], paramNames = [], results = [];
  const locals = [], localNames = [];
  let bodyStart = 0, inlineExport = null, typeRef = null;

  for (let i = 0; i < items.length; i++) {
    const e = items[i];
    if (!Array.isArray(e)) { bodyStart = i; break; }
    const h = e[0];
    if (h === 'param') {
      for (let j = 1; j < e.length; j++) {
        if (typeof e[j] === 'string' && e[j][0] === '$') {
          paramNames.push(e[j]);
          if (j + 1 < e.length) { params.push(e[++j]); }
        } else { paramNames.push(null); params.push(e[j]); }
      }
    } else if (h === 'result') {
      for (let j = 1; j < e.length; j++) results.push(e[j]);
    } else if (h === 'local') {
      for (let j = 1; j < e.length; j++) {
        if (typeof e[j] === 'string' && e[j][0] === '$') {
          localNames.push(e[j]);
          if (j + 1 < e.length) { locals.push(e[++j]); }
        } else { localNames.push(null); locals.push(e[j]); }
      }
    } else if (h === 'export') {
      const v = e[1];
      inlineExport = (typeof v === 'object' && v.str !== undefined) ? v.str : v;
    } else if (h === 'type') {
      typeRef = e[1];
    } else { bodyStart = i; break; }
    bodyStart = i + 1;
  }
  return { params, paramNames, results, locals, localNames, bodyStart, inlineExport, typeRef };
}

// Flatten top-level items, unwrapping (module ...) wrappers
function* iterTopLevel(exprs) {
  for (const item of exprs) {
    if (Array.isArray(item) && item[0] === 'module') {
      yield* item.slice(1).filter(e => Array.isArray(e));
    } else if (Array.isArray(item)) {
      yield item;
    }
  }
}

// ============================================================
// PASS 1: Collect declarations (types, imports, func sigs, globals, etc.)
// No function bodies are stored — only signatures.
// ============================================================
function pass1(readFile) {
  const mod = {
    types: [], typeMap: {},
    imports: [],
    funcs: [],          // [{name, typeIdx, params, results, paramNames}] — no bodies
    globals: [],        // [{name, valtype, mut, init?, isImport}]
    tables: [],
    memories: [],
    exports: [],
    elems: [],
    dataSegments: [],
    funcNameMap: {}, globalNameMap: {}, typeNameMap: {}, tableNameMap: {},
    numImportFuncs: 0, numImportGlobals: 0,
  };

  function ensureType(params, results) {
    const key = sigKey(params, results);
    if (mod.typeMap[key] !== undefined) return mod.typeMap[key];
    const idx = mod.types.length;
    mod.types.push({ params, results });
    mod.typeMap[key] = idx;
    return idx;
  }

  // Sub-pass A: collect explicit (type ...) declarations first
  // wat2wasm assigns type indices to named types before implicit types
  return async function() {
    // Read all files, tokenize+parse, collect types first
    const allSrc = [];
    for (const f of WAT_FILES) {
      allSrc.push(await readFile(f));
    }

    // Sub-pass A: types only
    for (const src of allSrc) {
      const tokens = tokenize(src);
      const exprs = parseSExprs(tokens);
      for (const item of iterTopLevel(exprs)) {
        if (item[0] !== 'type') continue;
        const name = typeof item[1] === 'string' && item[1][0] === '$' ? item[1] : null;
        const ft = name ? item[2] : item[1];
        if (Array.isArray(ft) && ft[0] === 'func') {
          const sig = parseFuncSig(ft.slice(1));
          const idx = ensureType(sig.params, sig.results);
          if (name) mod.typeNameMap[name] = idx;
        }
      }
    }

    // Sub-pass B: everything except types
    for (const src of allSrc) {
      const tokens = tokenize(src);
      const exprs = parseSExprs(tokens);

      for (const item of iterTopLevel(exprs)) {
        const head = item[0];

        if (head === 'type') continue; // done in sub-pass A

        if (head === 'import') {
          const modName = typeof item[1] === 'object' ? item[1].str : item[1];
          const impName = typeof item[2] === 'object' ? item[2].str : item[2];
          const desc = item[3];
          if (!Array.isArray(desc)) continue;
          const kind = desc[0];
          if (kind === 'func') {
            const name = typeof desc[1] === 'string' && desc[1][0] === '$' ? desc[1] : null;
            const sig = parseFuncSig(desc.slice(name ? 2 : 1));
            const typeIdx = ensureType(sig.params, sig.results);
            const funcIdx = mod.funcs.length;
            mod.funcs.push({ name, typeIdx, params: sig.params, results: sig.results, isImport: true });
            if (name) mod.funcNameMap[name] = funcIdx;
            mod.imports.push({ module: modName, name: impName, kind: 'func', typeIdx });
            mod.numImportFuncs++;
          } else if (kind === 'memory') {
            const min = parseNumber(desc[1]);
            mod.memories.push({ min, isImport: true });
            mod.imports.push({ module: modName, name: impName, kind: 'memory', min });
          } else if (kind === 'global') {
            const name = typeof desc[1] === 'string' && desc[1][0] === '$' ? desc[1] : null;
            const ts = desc[name ? 2 : 1];
            const mut = Array.isArray(ts) && ts[0] === 'mut';
            const valtype = mut ? ts[1] : ts;
            const idx = mod.globals.length;
            mod.globals.push({ name, valtype, mut, isImport: true });
            if (name) mod.globalNameMap[name] = idx;
            mod.imports.push({ module: modName, name: impName, kind: 'global', valtype, mut });
            mod.numImportGlobals++;
          } else if (kind === 'table') {
            const name = typeof desc[1] === 'string' && desc[1][0] === '$' ? desc[1] : null;
            const s = name ? 2 : 1;
            const min = parseNumber(desc[s]);
            mod.tables.push({ min, isImport: true });
            if (name) mod.tableNameMap[name] = mod.tables.length - 1;
            mod.imports.push({ module: modName, name: impName, kind: 'table', min });
          }
          continue;
        }

        if (head === 'func') {
          const name = typeof item[1] === 'string' && item[1][0] === '$' ? item[1] : null;
          const bodyItems = item.slice(name ? 2 : 1);
          const sig = parseFuncSig(bodyItems);
          const typeIdx = ensureType(sig.params, sig.results);
          const funcIdx = mod.funcs.length;
          // Store sig only, no body
          mod.funcs.push({ name, typeIdx, params: sig.params, results: sig.results,
                           paramNames: sig.paramNames, isImport: false });
          if (name) mod.funcNameMap[name] = funcIdx;
          if (sig.inlineExport) {
            mod.exports.push({ name: sig.inlineExport, kind: 'func', idx: funcIdx });
          }
          continue;
        }

        if (head === 'global') {
          const name = typeof item[1] === 'string' && item[1][0] === '$' ? item[1] : null;
          let pos = name ? 2 : 1;
          const ts = item[pos];
          const mut = Array.isArray(ts) && ts[0] === 'mut';
          const valtype = mut ? ts[1] : ts;
          pos++;
          const init = item[pos];
          const idx = mod.globals.length;
          mod.globals.push({ name, valtype, mut, init, isImport: false });
          if (name) mod.globalNameMap[name] = idx;
          continue;
        }

        if (head === 'table') {
          const name = typeof item[1] === 'string' && item[1][0] === '$' ? item[1] : null;
          const s = name ? 2 : 1;
          mod.tables.push({ min: parseNumber(item[s]), isImport: false });
          if (name) mod.tableNameMap[name] = mod.tables.length - 1;
          continue;
        }

        if (head === 'memory') {
          const name = typeof item[1] === 'string' && item[1][0] === '$' ? item[1] : null;
          const s = name ? 2 : 1;
          mod.memories.push({ min: parseNumber(item[s]), isImport: false });
          continue;
        }

        if (head === 'export') {
          const expName = typeof item[1] === 'object' ? item[1].str : item[1];
          const desc = item[2];
          if (Array.isArray(desc)) {
            mod.exports.push({ name: expName, kind: desc[0], ref: desc[1] });
          }
          continue;
        }

        if (head === 'elem') {
          mod.elems.push({ offsetExpr: item[1], funcNames: item.slice(2) });
          continue;
        }

        if (head === 'data') {
          const bytes = [];
          for (let j = 2; j < item.length; j++) {
            const seg = item[j];
            if (typeof seg === 'object' && seg.str !== undefined) {
              for (let k = 0; k < seg.str.length; k++) bytes.push(seg.str.charCodeAt(k) & 0xFF);
            }
          }
          mod.dataSegments.push({ offsetExpr: item[1], bytes });
          continue;
        }
      }
    }

    return mod;
  };
}

// ============================================================
// PASS 2: Emit binary — re-reads files to stream function bodies
// ============================================================
function emitBinary(mod, readFile) {
  return async function() {
    const w = new BinaryWriter(131072);

    // Magic + version
    w.bytes([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]);

    // --- Section 1: Type ---
    w.section(1, s => {
      s.uleb(mod.types.length);
      for (const t of mod.types) {
        s.byte(0x60);
        s.uleb(t.params.length);
        for (const p of t.params) s.byte(VALTYPES[p]);
        s.uleb(t.results.length);
        for (const r of t.results) s.byte(VALTYPES[r]);
      }
    });

    // --- Section 2: Import ---
    if (mod.imports.length) {
      w.section(2, s => {
        s.uleb(mod.imports.length);
        for (const imp of mod.imports) {
          const mb = encodeUTF8(imp.module), nb = encodeUTF8(imp.name);
          s.uleb(mb.length); s.bytes(mb);
          s.uleb(nb.length); s.bytes(nb);
          if (imp.kind === 'func') { s.byte(0x00); s.uleb(imp.typeIdx); }
          else if (imp.kind === 'table') { s.byte(0x01); s.byte(0x70); s.byte(0x00); s.uleb(imp.min); }
          else if (imp.kind === 'memory') { s.byte(0x02); s.byte(0x00); s.uleb(imp.min); }
          else if (imp.kind === 'global') { s.byte(0x03); s.byte(VALTYPES[imp.valtype]); s.byte(imp.mut ? 1 : 0); }
        }
      });
    }

    // --- Section 3: Function ---
    const nonImportFuncs = mod.funcs.filter(f => !f.isImport);
    w.section(3, s => {
      s.uleb(nonImportFuncs.length);
      for (const f of nonImportFuncs) s.uleb(f.typeIdx);
    });

    // --- Section 4: Table ---
    const niTables = mod.tables.filter(t => !t.isImport);
    if (niTables.length) {
      w.section(4, s => {
        s.uleb(niTables.length);
        for (const t of niTables) { s.byte(0x70); s.byte(0x00); s.uleb(t.min); }
      });
    }

    // --- Section 5: Memory ---
    const niMem = mod.memories.filter(m => !m.isImport);
    if (niMem.length) {
      w.section(5, s => {
        s.uleb(niMem.length);
        for (const m of niMem) { s.byte(0x00); s.uleb(m.min); }
      });
    }

    // --- Section 6: Global ---
    const niGlobals = mod.globals.filter(g => !g.isImport);
    if (niGlobals.length) {
      w.section(6, s => {
        s.uleb(niGlobals.length);
        for (const g of niGlobals) {
          s.byte(VALTYPES[g.valtype]); s.byte(g.mut ? 1 : 0);
          emitInitExpr(s, g.init); s.byte(0x0B);
        }
      });
    }

    // --- Section 7: Export ---
    if (mod.exports.length) {
      w.section(7, s => {
        s.uleb(mod.exports.length);
        for (const exp of mod.exports) {
          const nb = encodeUTF8(exp.name);
          s.uleb(nb.length); s.bytes(nb);
          let kindByte, idx;
          if (exp.kind === 'func') {
            kindByte = 0x00;
            idx = exp.idx !== undefined ? exp.idx : resolveRef(exp.ref, mod.funcNameMap, 'func');
          } else if (exp.kind === 'table') {
            kindByte = 0x01;
            idx = exp.idx !== undefined ? exp.idx : resolveRef(exp.ref, mod.tableNameMap, 'table');
          } else if (exp.kind === 'memory') {
            kindByte = 0x02;
            idx = typeof exp.ref === 'string' && exp.ref[0] === '$' ? 0 : (parseNumber(exp.ref) || 0);
          } else if (exp.kind === 'global') {
            kindByte = 0x03;
            idx = exp.idx !== undefined ? exp.idx : resolveRef(exp.ref, mod.globalNameMap, 'global');
          }
          s.byte(kindByte); s.uleb(idx);
        }
      });
    }

    // --- Section 9: Element ---
    if (mod.elems.length) {
      w.section(9, s => {
        s.uleb(mod.elems.length);
        for (const el of mod.elems) {
          s.byte(0x00);
          emitInitExpr(s, el.offsetExpr); s.byte(0x0B);
          s.uleb(el.funcNames.length);
          for (const fn of el.funcNames) s.uleb(resolveRef(fn, mod.funcNameMap, 'func'));
        }
      });
    }

    // --- Section 10: Code --- (streaming: re-read files, emit one func at a time)
    w.section(10, s => {
      s.uleb(nonImportFuncs.length);
      // We need to re-read and parse files to get function bodies.
      // But we're inside an async function wrapped in section() which is sync.
      // So we pre-collect the code bodies into codeBodies[] before this call.
      // Actually, section() is sync with a callback. We need a different approach.
      // We'll pre-build the code section content separately.
      // -- this is handled below via codeSectionBuf --
    });
    // Rewind: we'll replace the code section. Remove the empty one we just wrote.
    // Better approach: build code section content first, then write it.

    // Actually, let's build the code section by re-reading files
    const codeBuf = new BinaryWriter(65536);
    codeBuf.uleb(nonImportFuncs.length);

    let funcCounter = 0;
    for (const f of WAT_FILES) {
      const src = await readFile(f);
      const tokens = tokenize(src);
      const exprs = parseSExprs(tokens);
      // tokens and exprs freed after this iteration

      for (const item of iterTopLevel(exprs)) {
        if (item[0] !== 'func') continue;
        const name = typeof item[1] === 'string' && item[1][0] === '$' ? item[1] : null;
        const bodyItems = item.slice(name ? 2 : 1);
        const sig = parseFuncSig(bodyItems);
        const body = bodyItems.slice(sig.bodyStart);

        // Get the stored func metadata (params/paramNames for local name map)
        const funcMeta = nonImportFuncs[funcCounter++];

        // Emit function body into temp writer
        const bodyW = new BinaryWriter(1024);
        emitFuncBody(bodyW, funcMeta, sig.locals, sig.localNames, body, mod);

        // Write size-prefixed body
        codeBuf.uleb(bodyW.pos);
        codeBuf.appendWriter(bodyW);
        // bodyW, body, sig are now eligible for GC
      }
    }

    // Now rewind w to before the empty code section and write the real one
    // Find where to put code section: we wrote an empty section 10 above.
    // Instead, let's not write the empty one. Rebuild w without it.
    // Simplest fix: redo the approach — don't call w.section(10,...) above.
    // We already did though. Let's just reset w.pos to before that section.

    // Actually the section(10,...) above wrote: byte(10) + uleb(size) + content.
    // The content was just uleb(count). Let's just back up.
    // But we don't know exactly how many bytes it took. Let's use a different approach entirely.

    // I'll restructure: build everything except code section, then insert code section at the right spot.
    // Nah, simplest: we know the position. Let's track it.

    // OK, this got messy. Let me just not use section() for code, and manually write it.
    // The problem is we already wrote the empty code section. Let me back up.

    // Let's redo: don't write sections 10-11 above. After section 9, save pos, then
    // write code and data sections manually.

    // For now, the simplest correct approach: rebuild w from scratch after collecting code bodies.
    // But that defeats streaming too. The real fix is to not use section() for code.

    // Let me just track the position before section 10 was written.
    // ... we already wrote it. The cleanest fix:

    // Remove the empty code section by resetting w.pos to before it was written.
    // We need to know where section 10 started. Let's re-approach.

    // PLAN: Reset w to right before section 10, write code section from codeBuf, then data section.
    // We saved no bookmark, so let's compute: section 10 was the last thing written.
    // The empty section 10 has: 0x0A (1 byte), uleb(content_len), uleb(count).
    // count = nonImportFuncs.length. Content = just uleb(count).
    // So total = 1 + ulebSize(ulebSize(count)) + ulebSize(count) bytes.
    // Instead of computing, let's just redo the whole thing properly.

    return null; // signal to redo
  };
}

// ============================================================
// INIT EXPR EMITTER
// ============================================================
function emitInitExpr(w, expr) {
  if (Array.isArray(expr)) {
    if (expr[0] === 'i32.const') { w.byte(0x41); w.sleb(parseNumber(expr[1]) | 0); }
    else if (expr[0] === 'i64.const') { w.byte(0x42); w.sleb64(parseBigInt(expr[1])); }
    else if (expr[0] === 'f64.const') { w.byte(0x44); w.f64(parseNumber(expr[1])); }
    else if (expr[0] === 'f32.const') { w.byte(0x43); w.f32(parseNumber(expr[1])); }
  }
}

// ============================================================
// FUNCTION BODY EMITTER — called once per func in pass 2, body discarded after
// ============================================================
function emitFuncBody(w, funcMeta, localDecls, localDeclNames, bodyExprs, mod) {
  // Build local name map: params first, then declared locals
  const localNameMap = {};
  let idx = 0;
  const paramNames = funcMeta.paramNames || [];
  for (let i = 0; i < paramNames.length; i++) {
    if (paramNames[i]) localNameMap[paramNames[i]] = idx;
    idx++;
  }
  if (!paramNames.length) idx = funcMeta.params.length;

  for (let i = 0; i < localDeclNames.length; i++) {
    if (localDeclNames[i]) localNameMap[localDeclNames[i]] = idx;
    idx++;
  }

  // Local declarations grouped by type
  const groups = [];
  if (localDecls.length) {
    let ct = localDecls[0], cc = 1;
    for (let i = 1; i < localDecls.length; i++) {
      if (localDecls[i] === ct) cc++;
      else { groups.push([cc, ct]); ct = localDecls[i]; cc = 1; }
    }
    groups.push([cc, ct]);
  }
  w.uleb(groups.length);
  for (const [count, type] of groups) { w.uleb(count); w.byte(VALTYPES[type]); }

  const labelStack = [];

  function resolveLocal(ref) {
    if (typeof ref === 'string' && ref[0] === '$') {
      const v = localNameMap[ref];
      if (v !== undefined) return v;
      console.warn(`compile-wat: unknown local: ${ref}`);
      return 0;
    }
    return parseNumber(ref);
  }

  function resolveLabel(ref) {
    if (typeof ref === 'string' && ref[0] === '$') {
      for (let i = labelStack.length - 1; i >= 0; i--)
        if (labelStack[i] === ref) return labelStack.length - 1 - i;
      console.warn(`compile-wat: unknown label: ${ref}`);
      return 0;
    }
    return parseNumber(ref);
  }

  function emitExpr(expr) {
    if (typeof expr === 'string') {
      // Could be a bare instruction (return, unreachable, nop, drop, select)
      // or a $name that somehow ended up at top level (shouldn't happen)
      if (expr[0] === '$') return; // stray $name, ignore
      emitOp(expr, []);
      return;
    }
    if (!Array.isArray(expr) || !expr.length) return;
    const head = expr[0];
    if (typeof head !== 'string') return;

    const args = expr.slice(1);

    // Block/loop
    if (head === 'block' || head === 'loop') {
      let label = null, resultType = null, bodyStart = 0;
      for (let i = 0; i < args.length; i++) {
        if (typeof args[i] === 'string' && args[i][0] === '$') { label = args[i]; bodyStart = i + 1; }
        else if (Array.isArray(args[i]) && args[i][0] === 'result') { resultType = args[i][1]; bodyStart = i + 1; }
        else { bodyStart = i; break; }
      }
      w.byte(head === 'block' ? 0x02 : 0x03);
      w.byte(resultType ? VALTYPES[resultType] : BLOCKTYPE_VOID);
      labelStack.push(label);
      for (let i = bodyStart; i < args.length; i++) emitExpr(args[i]);
      labelStack.pop();
      w.byte(0x0B);
      return;
    }

    // If
    if (head === 'if') {
      let label = null, resultType = null, i = 0;
      if (i < args.length && typeof args[i] === 'string' && args[i][0] === '$') { label = args[i++]; }
      if (i < args.length && Array.isArray(args[i]) && args[i][0] === 'result') { resultType = args[i++][1]; }

      // Find (then ...) to determine folded vs stacked
      let hasThen = false;
      for (let j = i; j < args.length; j++)
        if (Array.isArray(args[j]) && args[j][0] === 'then') { hasThen = true; break; }

      if (hasThen) {
        // Emit condition exprs before (then)
        for (; i < args.length; i++) {
          if (Array.isArray(args[i]) && (args[i][0] === 'then' || args[i][0] === 'else')) break;
          emitExpr(args[i]);
        }
        w.byte(0x04);
        w.byte(resultType ? VALTYPES[resultType] : BLOCKTYPE_VOID);
        labelStack.push(label);
        for (; i < args.length; i++) {
          if (Array.isArray(args[i]) && args[i][0] === 'then') {
            for (let j = 1; j < args[i].length; j++) emitExpr(args[i][j]);
          } else if (Array.isArray(args[i]) && args[i][0] === 'else') {
            w.byte(0x05);
            for (let j = 1; j < args[i].length; j++) emitExpr(args[i][j]);
          }
        }
        labelStack.pop();
        w.byte(0x0B);
      } else {
        w.byte(0x04);
        w.byte(resultType ? VALTYPES[resultType] : BLOCKTYPE_VOID);
        labelStack.push(label);
        for (; i < args.length; i++) emitExpr(args[i]);
        labelStack.pop();
        w.byte(0x0B);
      }
      return;
    }

    if (head === 'then' || head === 'else') {
      for (let i = 1; i < expr.length; i++) emitExpr(expr[i]);
      return;
    }

    // Separate sub-exprs (arrays) and atoms (strings/objects)
    const subExprs = [], atoms = [];
    for (const a of args) {
      if (Array.isArray(a)) subExprs.push(a);
      else atoms.push(a);
    }

    // br_table
    if (head === 'br_table') {
      for (const se of subExprs) emitExpr(se);
      w.byte(0x0E);
      const labels = atoms.filter(a => typeof a === 'string');
      w.uleb(labels.length - 1); // N labels, last is default
      for (const l of labels) w.uleb(resolveLabel(l));
      return;
    }

    // call_indirect
    if (head === 'call_indirect') {
      let typeRef = null;
      const callArgs = [];
      for (const a of args) {
        if (Array.isArray(a) && a[0] === 'type') typeRef = a[1];
        else callArgs.push(a);
      }
      for (const a of callArgs) emitExpr(a);
      w.byte(0x11);
      w.uleb(resolveRef(typeRef, mod.typeNameMap, 'type'));
      w.byte(0x00);
      return;
    }

    // Standard folded: emit sub-exprs, then the instruction
    for (const se of subExprs) emitExpr(se);
    emitOp(head, atoms);
  }

  function emitOp(op, atoms) {
    // FC-prefixed ops
    if (FC_OPS[op] !== undefined) {
      w.byte(0xFC);
      w.uleb(FC_OPS[op]);
      if (op === 'memory.copy') { w.byte(0x00); w.byte(0x00); }
      else if (op === 'memory.fill') { w.byte(0x00); }
      return;
    }

    const opc = OPCODES[op];
    if (opc === undefined) {
      if (op[0] !== '$') console.warn(`compile-wat: unknown op: ${op}`);
      w.byte(0x00); // unreachable
      return;
    }

    // Memory ops with memarg
    if (MEMARG_OPS.has(op)) {
      w.byte(opc);
      let offset = 0;
      for (const a of atoms)
        if (typeof a === 'string' && a.startsWith('offset=')) offset = parseNumber(a.substring(7));
      w.uleb(naturalAlign(op));
      w.uleb(offset);
      return;
    }

    // Ops with immediates
    if (op === 'i32.const') { w.byte(0x41); w.sleb(parseNumber(atoms[0]) | 0); return; }
    if (op === 'i64.const') { w.byte(0x42); w.sleb64(parseBigInt(atoms[0])); return; }
    if (op === 'f64.const') { w.byte(0x44); w.f64(parseNumber(atoms[0])); return; }
    if (op === 'f32.const') { w.byte(0x43); w.f32(parseNumber(atoms[0])); return; }

    if (op === 'local.get' || op === 'local.set' || op === 'local.tee') {
      w.byte(opc); w.uleb(resolveLocal(atoms[0])); return;
    }
    if (op === 'global.get' || op === 'global.set') {
      w.byte(opc); w.uleb(resolveRef(atoms[0], mod.globalNameMap, 'global')); return;
    }
    if (op === 'call') { w.byte(0x10); w.uleb(resolveRef(atoms[0], mod.funcNameMap, 'func')); return; }
    if (op === 'return_call') { w.byte(0x12); w.uleb(resolveRef(atoms[0], mod.funcNameMap, 'func')); return; }
    if (op === 'br' || op === 'br_if') { w.byte(opc); w.uleb(resolveLabel(atoms[0])); return; }

    if (op === 'memory.size' || op === 'memory.grow') { w.byte(opc); w.byte(0x00); return; }

    // Simple opcode, no immediates
    w.byte(opc);
  }

  emitExprList(bodyExprs);
  w.byte(0x0B); // end

  // Emit a list of expressions, handling flat/stacked syntax where bare instructions
  // consume following tokens as operands (e.g. "global.set $eax" without parens)
  function emitExprList(exprs) {
    for (let i = 0; i < exprs.length; i++) {
      const e = exprs[i];
      if (typeof e === 'string' && e[0] !== '$' && needsOperand(e) &&
          i + 1 < exprs.length && typeof exprs[i + 1] === 'string') {
        emitOp(e, [exprs[++i]]);
      } else {
        emitExpr(e);
      }
    }
  }

  function needsOperand(op) {
    return op === 'local.get' || op === 'local.set' || op === 'local.tee' ||
           op === 'global.get' || op === 'global.set' ||
           op === 'call' || op === 'return_call' || op === 'br' || op === 'br_if';
  }
}

// ============================================================
// MAIN ENTRY POINT — two passes, streaming
// ============================================================
async function compileWat(readFile) {
  // --- Pass 1: collect declarations ---
  const mod = await (pass1(readFile))();

  // --- Pass 2: emit binary, re-reading files for function bodies ---
  const w = new BinaryWriter(131072);

  // Magic + version
  w.bytes([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]);

  // Section 1: Type
  w.section(1, s => {
    s.uleb(mod.types.length);
    for (const t of mod.types) {
      s.byte(0x60);
      s.uleb(t.params.length);
      for (const p of t.params) s.byte(VALTYPES[p]);
      s.uleb(t.results.length);
      for (const r of t.results) s.byte(VALTYPES[r]);
    }
  });

  // Section 2: Import
  if (mod.imports.length) {
    w.section(2, s => {
      s.uleb(mod.imports.length);
      for (const imp of mod.imports) {
        const mb = encodeUTF8(imp.module), nb = encodeUTF8(imp.name);
        s.uleb(mb.length); s.bytes(mb);
        s.uleb(nb.length); s.bytes(nb);
        if (imp.kind === 'func') { s.byte(0x00); s.uleb(imp.typeIdx); }
        else if (imp.kind === 'table') { s.byte(0x01); s.byte(0x70); s.byte(0x00); s.uleb(imp.min); }
        else if (imp.kind === 'memory') { s.byte(0x02); s.byte(0x00); s.uleb(imp.min); }
        else if (imp.kind === 'global') { s.byte(0x03); s.byte(VALTYPES[imp.valtype]); s.byte(imp.mut ? 1 : 0); }
      }
    });
  }

  // Section 3: Function
  const nonImportFuncs = mod.funcs.filter(f => !f.isImport);
  w.section(3, s => {
    s.uleb(nonImportFuncs.length);
    for (const f of nonImportFuncs) s.uleb(f.typeIdx);
  });

  // Section 4: Table
  const niTables = mod.tables.filter(t => !t.isImport);
  if (niTables.length) {
    w.section(4, s => {
      s.uleb(niTables.length);
      for (const t of niTables) { s.byte(0x70); s.byte(0x00); s.uleb(t.min); }
    });
  }

  // Section 5: Memory
  const niMem = mod.memories.filter(m => !m.isImport);
  if (niMem.length) {
    w.section(5, s => {
      s.uleb(niMem.length);
      for (const m of niMem) { s.byte(0x00); s.uleb(m.min); }
    });
  }

  // Section 6: Global
  const niGlobals = mod.globals.filter(g => !g.isImport);
  if (niGlobals.length) {
    w.section(6, s => {
      s.uleb(niGlobals.length);
      for (const g of niGlobals) {
        s.byte(VALTYPES[g.valtype]); s.byte(g.mut ? 1 : 0);
        emitInitExpr(s, g.init); s.byte(0x0B);
      }
    });
  }

  // Section 7: Export
  if (mod.exports.length) {
    w.section(7, s => {
      s.uleb(mod.exports.length);
      for (const exp of mod.exports) {
        const nb = encodeUTF8(exp.name);
        s.uleb(nb.length); s.bytes(nb);
        let kindByte, idx;
        if (exp.kind === 'func') {
          kindByte = 0x00;
          idx = exp.idx !== undefined ? exp.idx : resolveRef(exp.ref, mod.funcNameMap, 'func');
        } else if (exp.kind === 'table') {
          kindByte = 0x01;
          idx = exp.idx !== undefined ? exp.idx : resolveRef(exp.ref, mod.tableNameMap, 'table');
        } else if (exp.kind === 'memory') {
          kindByte = 0x02;
          idx = typeof exp.ref === 'string' && exp.ref[0] === '$' ? 0 : (parseNumber(exp.ref) || 0);
        } else if (exp.kind === 'global') {
          kindByte = 0x03;
          idx = exp.idx !== undefined ? exp.idx : resolveRef(exp.ref, mod.globalNameMap, 'global');
        }
        s.byte(kindByte); s.uleb(idx);
      }
    });
  }

  // Section 9: Element
  if (mod.elems.length) {
    w.section(9, s => {
      s.uleb(mod.elems.length);
      for (const el of mod.elems) {
        s.byte(0x00);
        emitInitExpr(s, el.offsetExpr); s.byte(0x0B);
        s.uleb(el.funcNames.length);
        for (const fn of el.funcNames) s.uleb(resolveRef(fn, mod.funcNameMap, 'func'));
      }
    });
  }

  // Section 10: Code — streaming, re-read files one at a time
  const codeBuf = new BinaryWriter(65536);
  codeBuf.uleb(nonImportFuncs.length);

  let funcIdx = 0;
  for (const f of WAT_FILES) {
    const src = await readFile(f);
    const tokens = tokenize(src);
    const exprs = parseSExprs(tokens);
    // After this loop iteration, tokens/exprs/src are GC-eligible

    for (const item of iterTopLevel(exprs)) {
      if (item[0] !== 'func') continue;
      const name = typeof item[1] === 'string' && item[1][0] === '$' ? item[1] : null;
      const bodyItems = item.slice(name ? 2 : 1);
      const sig = parseFuncSig(bodyItems);
      const body = bodyItems.slice(sig.bodyStart);

      const funcMeta = nonImportFuncs[funcIdx++];
      const bodyW = new BinaryWriter(1024);
      emitFuncBody(bodyW, funcMeta, sig.locals, sig.localNames, body, mod);

      codeBuf.uleb(bodyW.pos);
      codeBuf.appendWriter(bodyW);
      // bodyW, body, sig eligible for GC
    }
  }

  // Write code section: id + size + content
  w.byte(10);
  w.uleb(codeBuf.pos);
  w.appendWriter(codeBuf);

  // Section 11: Data
  if (mod.dataSegments.length) {
    w.section(11, s => {
      s.uleb(mod.dataSegments.length);
      for (const seg of mod.dataSegments) {
        s.byte(0x00);
        emitInitExpr(s, seg.offsetExpr); s.byte(0x0B);
        s.uleb(seg.bytes.length);
        s.bytes(seg.bytes);
      }
    });
  }

  return w.result();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { compileWat, WAT_FILES };
}
