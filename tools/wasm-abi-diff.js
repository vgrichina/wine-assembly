#!/usr/bin/env node
'use strict';

// Compare the decoded ABI of two .wasm modules, section by section.
//
//   node tools/wasm-abi-diff.js a.wasm b.wasm [--max=N] [--quiet]
//                                             [--require-no-tailcalls]
//                                             [--strict-code] [--no-validate]
//                                             [--sections=imports,data]
//
// WHY THIS EXISTS: Milestone 3 of docs/watx-migration-plan.md gates the
// compiler swap on decoded-ABI equality, not on byte equality — two valid
// compilers may deduplicate types, reorder a type section or encode a LEB
// differently and still produce the same module. `cmp`/sha256 cannot express
// that, and `wasm-objdump` is not vendored here. So this decodes both modules
// and compares exactly the list the plan names:
//
//   imports (module/name/kind/type, memory limits + shared flag), exports,
//   RESOLVED function signatures (so type dedup/reorder is tolerated),
//   function declaration order and the name-section index map, globals
//   (type/mut/order/initializer bytes), tables and resolved element entries,
//   memories, data segments (offset/length/bytes), code and function counts,
//   and the presence of tail-call opcodes across every code body.
//
// ACCEPTANCE vs DIAGNOSTIC. The plan says outright that byte equality is
// welcome but is NOT the criterion, so the verdict must not be decided by
// anything a valid compiler may legitimately encode differently. Per-function
// code BODY bytes are exactly that: local grouping, LEB width and instruction
// selection are all free choices, and a WATX artifact will differ in them
// while being ABI-identical. So body comparison is a DIAGNOSTIC — always
// decoded, always reported, never fatal by default. What is fatal is the
// section list above plus the function and code COUNTS.
//
//   --strict-code promotes the body comparison back to an acceptance item.
//   Use it for same-compiler determinism checks ("does this build twice to
//   the same bytes"), never for a cross-compiler gate.
//
// The tail-call census is always printed and is an acceptance-report item,
// but census EQUALITY is deliberately not part of the verdict: a tail-call
// artifact and its compatibility twin are supposed to disagree there. Gate on
// it explicitly with --require-no-tailcalls, which exits non-zero if EITHER
// module contains a tail call — the check for `build/*.compat.wasm`.
//
// The tail-call scan is a real instruction walk, not a byte grep: 0x12 and
// 0x13 occur constantly inside LEB immediates and 16-byte v128 constants, so
// a grep reports tail calls in every module ever built.
//
// Both inputs are run through WebAssembly.validate() before anything is
// compared, because this decoder is structural and will happily report MATCH
// on two modules that no engine would accept. That check lives inside
// diffWasmAbi(), not in the CLI, so an importing caller — the migration matrix
// tooling above all — cannot get a weaker guarantee than a shell caller.
// Pass {validate: false} (CLI: --no-validate) to skip it when the module uses
// a proposal this Node build has not shipped.
//
// Exit code 0 on a full ABI match, 1 on any acceptance diff (or a failed
// --require-no-tailcalls), 2 on error — so it chains in a shell.
//
// Importable: require('./wasm-abi-diff').{decodeWasm, diffWasmAbi}
//
// MEASURED, tail-call vs compatibility artifact (2026-08-31, build at HEAD
// e87d8325 + shared WIP): `node tools/wasm-abi-diff.js build/wine-assembly.wasm
// build/wine-assembly.compat.wasm` exits 0 — every acceptance section matches:
//
//   * imports, exports, types, functions, globals, tables, elements,
//     memories, data, code(counts) — all MATCH. That is the set of invariants
//     the plan actually gates on, and the reason this tool exists: the two
//     artifacts are not byte-equal and never will be, but their ABI is.
//   * code-bodies — DIAGNOSTIC, 422 of 8142 bodies differ, each by 1-2 bytes,
//     and the tail-call census reads "A 448 sites in 422 functions, B 0 sites
//     in 0 functions". That is the lowering itself: `return_call f` (0x12 + a
//     funcidx LEB) becomes `call f` + `return` (0x10 + the same LEB + 0x0f),
//     so exactly the 422 functions that used a tail call grow by one byte per
//     site. Function COUNT is identical (8142 both sides), which is what the
//     verdict checks.
//
// Under --strict-code that pair reports `code-bodies` as a DIFF and exits 1,
// which is correct and is why --strict-code is not the default.
//
// KNOWN LIMITATION — the name map is vacuous today, and that matters more now
// that body bytes are diagnostic. `lib/compile-wat.js` emits no `name` custom
// section (section ids present are 1,2,3,4,6,7,9,10,11), so every function
// renders as `<unnamed>`. Combined with resolved-signature comparison, that
// means SWAPPING TWO FUNCTIONS OF THE SAME SIGNATURE is invisible to the
// acceptance set: nothing in the decoded ABI distinguishes them, and the one
// thing that would — the body bytes — is a diagnostic. Element targets and
// export indices still pin any function reachable through the handler table or
// an export, so the blind spot is same-signature internal helpers. The tool
// prints a WARNING when neither module carries a name section. The real fix is
// for the compiler to emit a name section or a sidecar index map; that is out
// of this tool's scope, and until then treat a `code-bodies` diagnostic on a
// pair you expected to be identical as a finding, not as noise.

const fs = require('fs');

// ---------------------------------------------------------------------------
// Binary reader
// ---------------------------------------------------------------------------

class Reader {
  constructor(buf, pos, end) {
    this.buf = buf;
    this.pos = pos || 0;
    this.end = end === undefined ? buf.length : end;
  }

  get eof() { return this.pos >= this.end; }

  byte() {
    if (this.pos >= this.end) throw new Error(`read past end at ${this.pos}`);
    return this.buf[this.pos++];
  }

  bytes(n) {
    if (this.pos + n > this.end) throw new Error(`read of ${n} past end at ${this.pos}`);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  // Unsigned LEB128. Returns a Number; wasm u32 fits exactly.
  u32() {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = this.byte();
      result += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if (shift > 35) throw new Error(`u32 LEB too long at ${this.pos}`);
    } while (b & 0x80);
    return result;
  }

  // Signed LEB128, arbitrary width. Returned as a BigInt-free decimal string
  // for i64 and as a Number when it fits; we only ever print these.
  s64() {
    let result = 0n;
    let shift = 0n;
    let b;
    do {
      b = BigInt(this.byte());
      result |= (b & 0x7fn) << shift;
      shift += 7n;
    } while (b & 0x80n);
    if ((b & 0x40n) && shift < 128n) result -= (1n << shift);
    return result;
  }

  // Skip a signed LEB without decoding it.
  skipLeb() {
    let b;
    do { b = this.byte(); } while (b & 0x80);
  }

  name() {
    const len = this.u32();
    return Buffer.from(this.bytes(len)).toString('utf8');
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const VALTYPE = {
  0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64',
  0x7b: 'v128', 0x70: 'funcref', 0x6f: 'externref',
};

function valtype(code) {
  const t = VALTYPE[code];
  if (!t) throw new Error(`unknown valtype 0x${code.toString(16)}`);
  return t;
}

function readValtypes(r) {
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) out.push(valtype(r.byte()));
  return out;
}

// A limits record, including the shared bit — the plan's memory invariant is
// specifically "8192 8192 shared", and dropping the flag would let a
// non-shared memory pass.
function readLimits(r) {
  const flags = r.byte();
  const min = r.u32();
  const max = (flags & 0x01) ? r.u32() : null;
  return { min, max, shared: !!(flags & 0x02), flags };
}

function limitsStr(l) {
  return `${l.min}${l.max === null ? '' : ` ${l.max}`}${l.shared ? ' shared' : ''}`;
}

function sigStr(t) {
  if (!t) return '<unknown type>';
  return `(${t.params.join(', ')}) -> (${t.results.join(', ')})`;
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// Instruction walker
//
// Used only to find tail-call opcodes, but it has to be exact: an immediate
// byte that happens to be 0x12 is not a return_call, and treating it as one
// makes every module look like it uses tail calls.
// ---------------------------------------------------------------------------

function readBlockType(r) {
  const b = r.buf[r.pos];
  if (b === 0x40 || VALTYPE[b] !== undefined) { r.pos++; return; }
  r.skipLeb(); // s33 type index
}

function readMemarg(r) {
  const align = r.u32();
  // Multi-memory sets bit 6 of the alignment field and follows with a memidx.
  if (align & 0x40) r.u32();
  r.u32(); // offset
}

// SIMD sub-opcodes grouped by immediate shape.
const SIMD_MEMARG = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 92, 93]);
const SIMD_MEMARG_LANE = new Set([84, 85, 86, 87, 88, 89, 90, 91]);
const SIMD_LANE = new Set([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34]);

// Walk one expression/body to `end` at depth 0. Records tail-call sites.
function walkCode(r, endPos, sites, fnIndex) {
  let depth = 0;
  while (r.pos < endPos) {
    const op = r.byte();
    switch (op) {
      case 0x02: case 0x03: case 0x04: // block, loop, if
        readBlockType(r); depth++; break;
      case 0x05: break;                // else
      case 0x0b:                       // end
        if (depth === 0) return;
        depth--; break;
      case 0x00: case 0x01: case 0x0f: // unreachable, nop, return
      case 0x1a: case 0x1b:            // drop, select
      case 0xd1:                       // ref.is_null
        break;
      case 0x0c: case 0x0d:            // br, br_if
        r.u32(); break;
      case 0x0e: {                     // br_table
        const n = r.u32();
        for (let i = 0; i < n; i++) r.u32();
        r.u32();
        break;
      }
      case 0x10:                       // call
        r.u32(); break;
      case 0x11:                       // call_indirect
        r.u32(); r.u32(); break;
      case 0x12:                       // return_call
        sites.push({ fnIndex, op: 'return_call', target: r.u32() });
        break;
      case 0x13:                       // return_call_indirect
        r.u32(); r.u32();
        sites.push({ fnIndex, op: 'return_call_indirect' });
        break;
      case 0x1c: {                     // select t*
        const n = r.u32();
        for (let i = 0; i < n; i++) r.byte();
        break;
      }
      case 0x20: case 0x21: case 0x22: // local.get/set/tee
      case 0x23: case 0x24:            // global.get/set
      case 0x25: case 0x26:            // table.get/set
      case 0xd2:                       // ref.func
        r.u32(); break;
      case 0x3f: case 0x40:            // memory.size, memory.grow
        r.u32(); break;
      case 0x41: r.skipLeb(); break;   // i32.const
      case 0x42: r.skipLeb(); break;   // i64.const
      case 0x43: r.bytes(4); break;    // f32.const
      case 0x44: r.bytes(8); break;    // f64.const
      case 0xd0: r.byte(); break;      // ref.null
      case 0xfc: {                     // misc prefix
        const sub = r.u32();
        if (sub <= 7) break;                                    // trunc_sat
        if (sub === 8) { r.u32(); r.u32(); break; }              // memory.init
        if (sub === 9) { r.u32(); break; }                       // data.drop
        if (sub === 10) { r.u32(); r.u32(); break; }             // memory.copy
        if (sub === 11) { r.u32(); break; }                      // memory.fill
        if (sub === 12) { r.u32(); r.u32(); break; }             // table.init
        if (sub === 13) { r.u32(); break; }                      // elem.drop
        if (sub === 14) { r.u32(); r.u32(); break; }             // table.copy
        if (sub >= 15 && sub <= 17) { r.u32(); break; }          // table.grow/size/fill
        throw new Error(`unknown 0xfc sub-opcode ${sub} at ${r.pos}`);
      }
      case 0xfd: {                     // SIMD prefix
        const sub = r.u32();
        if (SIMD_MEMARG.has(sub)) { readMemarg(r); break; }
        if (SIMD_MEMARG_LANE.has(sub)) { readMemarg(r); r.byte(); break; }
        if (sub === 12 || sub === 13) { r.bytes(16); break; }    // v128.const, shuffle
        if (SIMD_LANE.has(sub)) { r.byte(); break; }
        break;                                                   // everything else: no immediate
      }
      case 0xfe: {                     // atomics prefix
        const sub = r.u32();
        if (sub === 0x03) { r.byte(); break; }                   // atomic.fence
        readMemarg(r);
        break;
      }
      default:
        if (op >= 0x28 && op <= 0x3e) { readMemarg(r); break; }  // loads/stores
        if (op >= 0x45 && op <= 0xc4) break;                     // numeric, no immediate
        throw new Error(`unknown opcode 0x${op.toString(16)} at ${r.pos - 1}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Module decoder
// ---------------------------------------------------------------------------

function toBuffer(input) {
  if (typeof input === 'string') return fs.readFileSync(input);
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.length);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new Error('expected a file path, Buffer, Uint8Array or ArrayBuffer');
}

function decodeWasm(input) {
  const buf = toBuffer(input);
  if (buf.length < 8 || buf.readUInt32LE(0) !== 0x6d736100) {
    throw new Error('not a wasm module (bad magic)');
  }
  const version = buf.readUInt32LE(4);

  const m = {
    version,
    types: [],
    imports: [],
    importedFuncTypes: [],
    importedTables: [],
    importedMemories: [],
    importedGlobals: [],
    funcTypeIndices: [],
    tables: [],
    memories: [],
    globals: [],
    exports: [],
    start: null,
    elements: [],
    data: [],
    codeCount: 0,
    codeBodies: [],
    tailCalls: [],
    funcNames: new Map(),
    sectionOrder: [],
  };

  const r = new Reader(buf, 8);
  const deferred = []; // code + element sections need the full func table first

  while (!r.eof) {
    const id = r.byte();
    const size = r.u32();
    const start = r.pos;
    const end = start + size;
    const sr = new Reader(buf, start, end);
    m.sectionOrder.push(id);

    switch (id) {
      case 0: { // custom
        const name = sr.name();
        if (name === 'name') readNameSection(sr, m);
        break;
      }
      case 1: { // type
        const n = sr.u32();
        for (let i = 0; i < n; i++) {
          const form = sr.byte();
          if (form !== 0x60) throw new Error(`unsupported type form 0x${form.toString(16)}`);
          m.types.push({ params: readValtypes(sr), results: readValtypes(sr) });
        }
        break;
      }
      case 2: { // import
        const n = sr.u32();
        for (let i = 0; i < n; i++) {
          const module = sr.name();
          const name = sr.name();
          const kindByte = sr.byte();
          const rec = { module, name, kindByte };
          if (kindByte === 0x00) {
            rec.kind = 'func';
            rec.typeIndex = sr.u32();
            m.importedFuncTypes.push(rec.typeIndex);
          } else if (kindByte === 0x01) {
            rec.kind = 'table';
            rec.elemType = valtype(sr.byte());
            rec.limits = readLimits(sr);
            m.importedTables.push(rec);
          } else if (kindByte === 0x02) {
            rec.kind = 'memory';
            rec.limits = readLimits(sr);
            m.importedMemories.push(rec);
          } else if (kindByte === 0x03) {
            rec.kind = 'global';
            rec.valType = valtype(sr.byte());
            rec.mutable = !!sr.byte();
            m.importedGlobals.push(rec);
          } else {
            throw new Error(`unknown import kind ${kindByte}`);
          }
          m.imports.push(rec);
        }
        break;
      }
      case 3: { // function
        const n = sr.u32();
        for (let i = 0; i < n; i++) m.funcTypeIndices.push(sr.u32());
        break;
      }
      case 4: { // table
        const n = sr.u32();
        for (let i = 0; i < n; i++) {
          m.tables.push({ elemType: valtype(sr.byte()), limits: readLimits(sr) });
        }
        break;
      }
      case 5: { // memory
        const n = sr.u32();
        for (let i = 0; i < n; i++) m.memories.push({ limits: readLimits(sr) });
        break;
      }
      case 6: { // global
        const n = sr.u32();
        for (let i = 0; i < n; i++) {
          const vt = valtype(sr.byte());
          const mutable = !!sr.byte();
          const initStart = sr.pos;
          walkCode(sr, end, [], -1);
          const init = buf.subarray(initStart, sr.pos - 1); // drop trailing 0x0b
          m.globals.push({ valType: vt, mutable, init: hex(init) });
        }
        break;
      }
      case 7: { // export
        const n = sr.u32();
        for (let i = 0; i < n; i++) {
          const name = sr.name();
          const kindByte = sr.byte();
          const index = sr.u32();
          const kind = ['func', 'table', 'memory', 'global'][kindByte];
          if (!kind) throw new Error(`unknown export kind ${kindByte}`);
          m.exports.push({ name, kind, index });
        }
        break;
      }
      case 8: // start
        m.start = sr.u32();
        break;
      case 9: // element
      case 10: // code
      case 11: // data
        deferred.push({ id, sr, end });
        break;
      case 12: // data count
        sr.u32();
        break;
      default:
        break; // unknown section: recorded in sectionOrder, contents ignored
    }
    r.pos = end;
  }

  // The resolved-signature view is what the plan compares: imported functions
  // first, then defined ones, each carrying its structural signature rather
  // than an index into a type section that a different compiler may have
  // deduplicated differently.
  m.funcSignatures = []
    .concat(m.importedFuncTypes.map(ti => m.types[ti]))
    .concat(m.funcTypeIndices.map(ti => m.types[ti]))
    .map(sigStr);
  m.importedFuncCount = m.importedFuncTypes.length;

  for (const d of deferred) {
    if (d.id === 9) readElementSection(d.sr, d.end, m);
    else if (d.id === 10) readCodeSection(d.sr, d.end, m, buf);
    else readDataSection(d.sr, d.end, m, buf);
  }

  // Keep the source bytes on the decoded module so a caller that pre-decodes
  // and then hands the object to diffWasmAbi still gets validated.
  // Non-enumerable so it does not swamp a console.log of the module.
  Object.defineProperty(m, 'sourceBytes', {
    value: buf, enumerable: false, writable: false,
  });

  return m;
}

function readNameSection(sr, m) {
  while (!sr.eof) {
    const subId = sr.byte();
    const subSize = sr.u32();
    const subEnd = sr.pos + subSize;
    if (subId === 1) { // function names
      const n = sr.u32();
      for (let i = 0; i < n; i++) {
        const idx = sr.u32();
        m.funcNames.set(idx, sr.name());
      }
    }
    sr.pos = subEnd;
  }
}

// Read a constant offset expression and render it. Offsets are i32.const or
// global.get in every module we build; anything else is printed as raw bytes
// rather than guessed at.
function readOffsetExpr(sr, end, buf) {
  const start = sr.pos;
  const op = sr.buf[sr.pos];
  let value = null;
  if (op === 0x41) { sr.pos++; value = Number(sr.s64()); sr.byte(); }
  else { walkCode(sr, end, [], -1); }
  return { value, raw: hex(buf.subarray(start, sr.pos)) };
}

function readElementSection(sr, end, m, buf) {
  const n = sr.u32();
  for (let i = 0; i < n; i++) {
    const flags = sr.u32();
    const seg = { flags, tableIndex: 0, mode: 'active', offset: null, entries: [] };
    if (flags & 0x01) seg.mode = (flags & 0x02) ? 'declarative' : 'passive';
    if (flags === 2 || flags === 6) seg.tableIndex = sr.u32();
    if (seg.mode === 'active') seg.offset = readOffsetExpr(sr, end, sr.buf);
    if (flags === 1 || flags === 2 || flags === 3) sr.byte();       // elemkind
    if (flags === 5 || flags === 6 || flags === 7) sr.byte();       // reftype
    const exprForm = flags >= 4;
    const count = sr.u32();
    for (let j = 0; j < count; j++) {
      if (!exprForm) {
        seg.entries.push(sr.u32());
      } else {
        // (ref.func N end) or (ref.null t end)
        const op = sr.byte();
        if (op === 0xd2) { seg.entries.push(sr.u32()); sr.byte(); }
        else if (op === 0xd0) { sr.byte(); sr.byte(); seg.entries.push(null); }
        else throw new Error(`unexpected element expr opcode 0x${op.toString(16)}`);
      }
    }
    m.elements.push(seg);
  }
}

function readCodeSection(sr, end, m, buf) {
  const n = sr.u32();
  m.codeCount = n;
  for (let i = 0; i < n; i++) {
    const size = sr.u32();
    const bodyStart = sr.pos;
    const bodyEnd = bodyStart + size;
    const fnIndex = m.importedFuncCount + i;
    const localGroups = sr.u32();
    const locals = [];
    for (let g = 0; g < localGroups; g++) {
      const count = sr.u32();
      locals.push(`${count} x ${valtype(sr.byte())}`);
    }
    walkCode(sr, bodyEnd, m.tailCalls, fnIndex);
    m.codeBodies.push({
      index: fnIndex,
      size,
      locals: locals.join(', '),
      bodyHash: hashBytes(sr.buf.subarray(bodyStart, bodyEnd)),
    });
    sr.pos = bodyEnd;
  }
}

function readDataSection(sr, end, m, buf) {
  const n = sr.u32();
  for (let i = 0; i < n; i++) {
    const flags = sr.u32();
    const seg = { flags, memIndex: 0, passive: flags === 1, offset: null };
    if (flags === 2) seg.memIndex = sr.u32();
    if (flags !== 1) seg.offset = readOffsetExpr(sr, end, sr.buf);
    const len = sr.u32();
    const bytes = sr.buf.subarray(sr.pos, sr.pos + len);
    sr.pos += len;
    seg.length = len;
    seg.hash = hashBytes(bytes);
    seg.bytes = bytes;
    m.data.push(seg);
  }
}

// FNV-1a over the bytes: enough to say "these differ" without holding two
// copies of a 900KB module's segments in memory for the report.
function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

// Compare two arrays of pre-rendered strings positionally. Order matters for
// everything the plan lists — function declaration order, global order and
// element order are all load-bearing.
function compareLists(a, b, label, max) {
  const diffs = [];
  if (a.length !== b.length) {
    diffs.push(`count: ${a.length} vs ${b.length}`);
  }
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && diffs.length < max; i++) {
    if (a[i] !== b[i]) {
      diffs.push(`[${i}] ${label}: ${a[i] === undefined ? '<absent>' : a[i]} ` +
        `!= ${b[i] === undefined ? '<absent>' : b[i]}`);
    }
  }
  return diffs;
}

function renderImports(m) {
  return m.imports.map(imp => {
    let type;
    if (imp.kind === 'func') type = sigStr(m.types[imp.typeIndex]);
    else if (imp.kind === 'table') type = `${imp.elemType} ${limitsStr(imp.limits)}`;
    else if (imp.kind === 'memory') type = limitsStr(imp.limits);
    else type = `${imp.mutable ? 'mut ' : ''}${imp.valType}`;
    return `${imp.module}.${imp.name} ${imp.kind} ${type}`;
  });
}

function renderExports(m) {
  return m.exports.map(e => {
    let type = '';
    if (e.kind === 'func') type = ` ${sigStr(m.types[funcTypeOf(m, e.index)])}`;
    else if (e.kind === 'global') type = ` ${globalTypeOf(m, e.index)}`;
    else if (e.kind === 'memory') type = ` ${limitsStr(memoryOf(m, e.index).limits)}`;
    else if (e.kind === 'table') {
      const t = tableOf(m, e.index);
      type = ` ${t.elemType} ${limitsStr(t.limits)}`;
    }
    return `${e.name} ${e.kind} #${e.index}${type}`;
  });
}

function funcTypeOf(m, index) {
  return index < m.importedFuncCount
    ? m.importedFuncTypes[index]
    : m.funcTypeIndices[index - m.importedFuncCount];
}

function globalTypeOf(m, index) {
  if (index < m.importedGlobals.length) {
    const g = m.importedGlobals[index];
    return `${g.mutable ? 'mut ' : ''}${g.valType}`;
  }
  const g = m.globals[index - m.importedGlobals.length];
  return g ? `${g.mutable ? 'mut ' : ''}${g.valType}` : '<absent>';
}

function memoryOf(m, index) {
  return index < m.importedMemories.length
    ? m.importedMemories[index]
    : m.memories[index - m.importedMemories.length];
}

function tableOf(m, index) {
  return index < m.importedTables.length
    ? m.importedTables[index]
    : m.tables[index - m.importedTables.length];
}

function renderGlobals(m) {
  return m.globals.map(g => `${g.mutable ? 'mut ' : ''}${g.valType} = 0x${g.init}`);
}

function renderTables(m) {
  return m.tables.map(t => `${t.elemType} ${limitsStr(t.limits)}`);
}

function renderMemories(m) {
  return m.memories.map(x => limitsStr(x.limits));
}

function renderElements(m) {
  const out = [];
  m.elements.forEach((seg, i) => {
    const off = seg.offset
      ? (seg.offset.value !== null ? String(seg.offset.value) : `raw:${seg.offset.raw}`)
      : seg.mode;
    out.push(`seg ${i} table=${seg.tableIndex} ${seg.mode} offset=${off} ` +
      `count=${seg.entries.length}`);
    // Element ENTRIES are the threaded-handler slot map. A single shifted slot
    // silently dispatches every opcode to its neighbour, so compare targets
    // one by one rather than hashing the segment.
    seg.entries.forEach((target, j) => {
      out.push(`seg ${i}[${j}] -> ${target === null ? 'null' : `#${target}`}`);
    });
  });
  return out;
}

function renderData(m) {
  return m.data.map((seg, i) => {
    const off = seg.offset
      ? (seg.offset.value !== null
        ? `0x${(seg.offset.value >>> 0).toString(16)}`
        : `raw:${seg.offset.raw}`)
      : 'passive';
    return `seg ${i} mem=${seg.memIndex} offset=${off} len=${seg.length} fnv=${seg.hash}`;
  });
}

function renderFunctions(m) {
  const out = [];
  for (let i = 0; i < m.funcSignatures.length; i++) {
    const name = m.funcNames.get(i);
    out.push(`#${i} ${name === undefined ? '<unnamed>' : name} ${m.funcSignatures[i]}`);
  }
  return out;
}

function renderTypes(m) {
  // Types are compared as a SET, deliberately: the plan tolerates
  // deduplication and reordering, and every consumer-visible signature is
  // already compared positionally through renderFunctions/renderImports.
  return Array.from(new Set(m.types.map(sigStr))).sort();
}

const SECTIONS = ['imports', 'exports', 'types', 'functions', 'globals',
  'tables', 'elements', 'memories', 'data', 'code', 'code-bodies'];

// Name a side in an error message: the file path when there is one, otherwise
// just "A"/"B", so a failure says which input was bad.
function describeSide(input, letter) {
  return typeof input === 'string' ? input : `side ${letter}`;
}

// Resolve one side to a decoded module, validating it first unless the caller
// opted out. Validation lives HERE and not in the CLI on purpose: the whole
// value of this comparator is that other code imports it, and a structural
// decoder that skips validation will report a confident ABI MATCH on two
// modules no engine would accept. A caller reaching for the library must not
// get a weaker check than a caller reaching for the shell.
function loadSide(input, label, validate) {
  const preDecoded = input !== null && typeof input === 'object'
    && !Buffer.isBuffer(input) && !(input instanceof Uint8Array)
    && !(input instanceof ArrayBuffer);
  const bytes = preDecoded ? (input.sourceBytes || null) : toBuffer(input);

  if (validate) {
    if (!bytes) {
      const error = new Error(`${label}: cannot validate a pre-decoded module ` +
        'that carries no source bytes. Pass the path or bytes instead, or ' +
        'pass {validate: false} (CLI: --no-validate) to skip validation.');
      error.code = 'ERR_WASM_UNVALIDATABLE';
      throw error;
    }
    if (!WebAssembly.validate(bytes)) {
      const error = new Error(`${label}: not a valid WebAssembly module ` +
        '(WebAssembly.validate failed). Comparing it would report an ABI that ' +
        'no engine will accept. If this Node build simply lacks a proposal the ' +
        'module uses, pass {validate: false} (CLI: --no-validate).');
      error.code = 'ERR_INVALID_WASM';
      throw error;
    }
  }
  return preDecoded ? input : decodeWasm(bytes);
}

function diffWasmAbi(fileA, fileB, options) {
  options = options || {};
  const max = options.max === undefined ? 10 : options.max;
  const strictCode = !!options.strictCode;
  const validate = options.validate !== false;
  const want = options.sections ? new Set(options.sections) : null;
  const a = loadSide(fileA, describeSide(fileA, 'A'), validate);
  const b = loadSide(fileB, describeSide(fileB, 'B'), validate);

  const results = [];
  // `acceptance: false` sections are decoded and reported but never decide the
  // verdict — see the ACCEPTANCE vs DIAGNOSTIC note in the header.
  const add = (name, diffs, note, acceptance) => {
    if (want && !want.has(name)) return;
    results.push({
      name,
      diffs,
      note: note || null,
      acceptance: acceptance === undefined ? true : acceptance,
    });
  };

  add('imports', compareLists(renderImports(a), renderImports(b), 'import', max));
  add('exports', compareLists(renderExports(a), renderExports(b), 'export', max));
  add('types', compareLists(renderTypes(a), renderTypes(b), 'type', max),
    'compared as a set of resolved signatures; dedup/reorder tolerated');
  add('functions', compareLists(renderFunctions(a), renderFunctions(b), 'func', max),
    'declaration order + name-section map + resolved signature');
  add('globals', compareLists(renderGlobals(a), renderGlobals(b), 'global', max));
  add('tables', compareLists(renderTables(a), renderTables(b), 'table', max));
  add('elements', compareLists(renderElements(a), renderElements(b), 'elem', max));
  add('memories', compareLists(renderMemories(a), renderMemories(b), 'memory', max));
  add('data', compareLists(renderData(a), renderData(b), 'data', max));

  // Counts are an acceptance item: a compiler is free to encode a body
  // differently, but it is not free to emit a different number of functions.
  const countDiffs = [];
  if (a.codeCount !== b.codeCount) {
    countDiffs.push(`code section function count: ${a.codeCount} vs ${b.codeCount}`);
  }
  if (a.funcTypeIndices.length !== b.funcTypeIndices.length) {
    countDiffs.push(`declared function count: ${a.funcTypeIndices.length} vs ` +
      `${b.funcTypeIndices.length}`);
  }
  if (a.importedFuncCount !== b.importedFuncCount) {
    countDiffs.push(`imported function count: ${a.importedFuncCount} vs ` +
      `${b.importedFuncCount}`);
  }
  add('code', countDiffs, 'function and code counts only; body bytes are the ' +
    'code-bodies diagnostic');

  // Bodies are the diagnostic half. Local grouping, LEB width and instruction
  // selection are all a compiler's free choice, so a difference here is
  // information, not a failure — unless --strict-code says this is a
  // same-compiler determinism check.
  const bodyDetail = [];
  let bodyDiffs = 0;
  for (let i = 0; i < Math.min(a.codeBodies.length, b.codeBodies.length); i++) {
    const x = a.codeBodies[i];
    const y = b.codeBodies[i];
    if (x.bodyHash !== y.bodyHash || x.locals !== y.locals) {
      bodyDiffs++;
      if (bodyDetail.length < max + 1) {
        const name = a.funcNames.get(x.index) || `#${x.index}`;
        bodyDetail.push(`body ${name}: ${x.size}B/${x.bodyHash} vs ` +
          `${y.size}B/${y.bodyHash}`);
      }
    }
  }
  const bodyLines = bodyDiffs
    ? [`${bodyDiffs} of ${a.codeBodies.length} bodies differ`].concat(bodyDetail)
    : [];
  add('code-bodies', bodyLines,
    strictCode
      ? 'fatal under --strict-code (same-compiler determinism check)'
      : 'diagnostic: encoding differences are permitted by the plan; ' +
        '--strict-code makes this fatal',
    strictCode);

  const acceptance = results.filter(s => s.acceptance);
  return {
    a, b,
    strictCode,
    sections: results,
    acceptanceSections: acceptance,
    diagnosticSections: results.filter(s => !s.acceptance),
    match: acceptance.every(s => s.diffs.length === 0),
    bodyDiffs,
    // True when neither module carries a name section: same-signature function
    // swaps are then invisible to the acceptance set. See the header.
    nameMapVacuous: a.funcNames.size === 0 && b.funcNames.size === 0,
    tailCalls: {
      a: a.tailCalls.length,
      b: b.tailCalls.length,
      aFuncs: new Set(a.tailCalls.map(t => t.fnIndex)).size,
      bFuncs: new Set(b.tailCalls.map(t => t.fnIndex)).size,
    },
  };
}

module.exports = { decodeWasm, diffWasmAbi, walkCode, SECTIONS };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => {
    const hit = argv.find(x => x.startsWith(`--${name}=`));
    return hit === undefined ? dflt : hit.slice(name.length + 3);
  };
  const files = argv.filter(x => !x.startsWith('--'));
  if (files.length !== 2) {
    console.error('usage: node tools/wasm-abi-diff.js a.wasm b.wasm [--max=N] ' +
      '[--quiet] [--require-no-tailcalls] [--strict-code] [--no-validate] ' +
      '[--sections=imports,data,...]');
    console.error(`sections: ${SECTIONS.join(', ')}`);
    process.exit(2);
  }
  const quiet = argv.includes('--quiet');
  const requireNoTailcalls = argv.includes('--require-no-tailcalls');
  const strictCode = argv.includes('--strict-code');
  const sectionsArg = opt('sections', '');

  // Validation lives in diffWasmAbi, so the shell and the library get the same
  // guarantee; --no-validate is just the flag form of {validate: false}.
  let result;
  try {
    result = diffWasmAbi(files[0], files[1], {
      max: Number(opt('max', 10)),
      strictCode,
      validate: !argv.includes('--no-validate'),
      sections: sectionsArg ? sectionsArg.split(',').map(s => s.trim()).filter(Boolean) : null,
    });
  } catch (error) {
    // A rejected module is a normal outcome and its message says everything;
    // a decode bug is not, and there the stack is the whole point.
    const expected = error.code === 'ERR_INVALID_WASM'
      || error.code === 'ERR_WASM_UNVALIDATABLE'
      || error.code === 'ENOENT';
    console.error(expected
      ? String(error.message)
      : String(error.stack || error.message || error));
    process.exit(2);
  }

  if (!quiet) {
    console.log(`A: ${files[0]}`);
    console.log(`B: ${files[1]}`);
    console.log('');
    for (const s of result.sections) {
      const tag = s.acceptance ? '' : ' [diagnostic]';
      if (s.diffs.length === 0) {
        console.log(`MATCH  ${s.name}${tag}`);
      } else if (!s.acceptance) {
        console.log(`NOTE   ${s.name}${tag}${s.note ? `  (${s.note})` : ''}`);
        for (const d of s.diffs) console.log(`         ${d}`);
      } else {
        console.log(`DIFF   ${s.name}${s.note ? `  (${s.note})` : ''}`);
        for (const d of s.diffs) console.log(`         ${d}`);
      }
    }
    console.log('');
    console.log(`tail-calls: A ${result.tailCalls.a} sites in ` +
      `${result.tailCalls.aFuncs} functions, B ${result.tailCalls.b} sites in ` +
      `${result.tailCalls.bFuncs} functions`);
    if (result.nameMapVacuous) {
      console.log('WARNING: neither module has a name section, so the ' +
        'name-to-index comparison is vacuous — two functions with the same ' +
        'signature could be swapped without any acceptance section noticing. ' +
        'Read the code-bodies diagnostic above before trusting a MATCH.');
    }
  }

  let failed = !result.match;
  if (requireNoTailcalls) {
    if (result.tailCalls.a || result.tailCalls.b) {
      console.log('FAIL   --require-no-tailcalls: tail-call opcodes present ' +
        `(A=${result.tailCalls.a}, B=${result.tailCalls.b})`);
      failed = true;
    } else if (!quiet) {
      console.log('OK     --require-no-tailcalls: neither module uses ' +
        'return_call/return_call_indirect');
    }
  }
  if (!quiet) {
    const suffix = result.bodyDiffs && !strictCode
      ? ` (${result.bodyDiffs} body encodings differ; diagnostic only)`
      : '';
    console.log(result.match ? `ABI MATCH${suffix}` : 'ABI DIFF');
  }
  process.exit(failed ? 1 : 0);
}
