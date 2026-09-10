#!/usr/bin/env node
// expr-fold-census.js — how much retired guest work is "expression-shaped"?
//
// tl;dr of what this script does, and why it exists
// ------------------------------------------------
// A decode-time integer expression fold would take a basic block whose interior
// is a chain of full-width 32-bit integer ops, build one dataflow expression
// tree out of it, and emit a SINGLE threaded-code op for the whole block:
// intermediates stay in wasm locals, and only the registers that are live out
// get written back to the register file at block exit. That removes one
// dispatch per folded op and one register-file round trip per intermediate.
//
// Whether that is worth building depends entirely on one number: the share of
// *retired* ops (dispatches actually executed, not static instructions) that
// sit inside such a run. This tool measures that ceiling, exactly, under a
// deliberately conservative barrier list — anything whose semantics the fold
// could not reproduce bit-for-bit ends the run.
//
// Input: a hot-block dump from
//   node test/run.js --app=ID --handler-hist --handler-hist-thread=0 \
//        --handler-hist-start=A --handler-hist-stop=B --hot-block-dump=FILE
// (one line per distinct block, "0xADDR hits"), plus the app's PE image(s).
// Each block address is decoded from its entry until a block terminator, every
// instruction is classified, and everything is weighted by the block's hit
// count. "Retired ops" = sum over blocks of hits * ops_in_block.
//
// Usage:
//   node tools/expr-fold-census.js --dump=FILE --exe=PATH [--module=NAME=PATH@0xLOAD]
//        [--modules-from=RUNLOG] [--json=OUT] [--top=20] [--label=NAME]
//        [--relax=alias,partial,flags] [--thunk-base=0x..] [--thunk-size=0x..]
//
// Further questions the report answers:
//  * the TERMINATOR CLASS of every hot block (self-loop / interior-branch /
//    plain-exit), hit-weighted, and for self-loops the trip structure — which
//    says whether the fold is collapsing a loop or a straight-line fragment;
//  * the same census re-run under RELAXED barrier rules, so the cost of each
//    barrier class can be read off directly. --relax picks which of those
//    modes get a detailed barrier histogram; the summary table always shows
//    exact, each single relaxation, and all three;
//  * MODULE ATTRIBUTION of the retired ops, with the "outside images" bucket
//    split into the API thunk zone (host Win32 entries, not guest code) and
//    genuinely unmapped addresses;
//  * the X87 POPULATION as its own walk. The integer census counts every x87
//    instruction as one flat `fpu/simd` barrier, which says nothing about
//    whether the float side is expression-shaped; on a software renderer that
//    barrier is the largest single class, so it gets its own run/barrier/mix
//    census with a static TOP rename.
//
// --module/--modules-from map DLL blocks back to a file image so they can be
// decoded too; without them, DLL blocks land in the "outside exe" bucket and
// only their hit share is reported.

'use strict';

const fs = require('fs');
const path = require('path');
const { readPE } = require('../lib/pe');
const { disasmAt } = require('./disasm');

// ---------------------------------------------------------------- arg parsing
const argv = process.argv.slice(2);
const getArg = (name, def = null) => {
  const p = `--${name}=`;
  const hit = argv.filter(a => a.startsWith(p));
  return hit.length ? hit[hit.length - 1].slice(p.length) : def;
};
const getAll = (name) => {
  const p = `--${name}=`;
  return argv.filter(a => a.startsWith(p)).map(a => a.slice(p.length));
};

const DUMP = getArg('dump');
const EXE = getArg('exe');
const JSON_OUT = getArg('json');
const TOP = parseInt(getArg('top', '20'), 10);
const LABEL = getArg('label', EXE ? path.basename(EXE) : 'app');
const MAX_OPS = parseInt(getArg('max-ops', '256'), 10);

if (!DUMP || !EXE) {
  console.error('usage: node tools/expr-fold-census.js --dump=FILE --exe=PATH [--module=NAME=PATH@0xLOAD] [--modules-from=LOG] [--json=OUT]');
  process.exit(2);
}

// ------------------------------------------------------------------- modules
// A module is { name, pe, loadAddr, origBase, lo, hi }. Runtime VA maps to a
// file VA by (va - loadAddr + origBase), the same arithmetic run.js uses for
// its `module+0xVA` specs.
const modules = [];
function addModule(name, filePath, loadAddr) {
  let pe;
  try { pe = readPE(filePath); } catch (e) {
    console.error(`[skip] ${name}: ${e.message}`);
    return;
  }
  const last = pe.sections.reduce((m, s) => Math.max(m, s.rva + Math.max(s.vsize, s.rawSize)), 0);
  const base = loadAddr === null ? pe.imageBase : loadAddr;
  modules.push({
    name, pe, loadAddr: base, origBase: pe.imageBase,
    lo: base, hi: base + last,
  });
}

addModule(path.basename(EXE), EXE, null);

for (const spec of getAll('module')) {
  // NAME=PATH@0xLOAD
  const m = /^([^=]+)=(.+)@(0x[0-9a-fA-F]+|\d+)$/.exec(spec);
  if (!m) { console.error(`bad --module spec: ${spec}`); process.exit(2); }
  addModule(m[1], m[2], Number(m[3]));
}

// --modules-from=LOG: parse run.js --verbose lines
//   DLL: NAME at 0xLOAD, DllMain=0x..., thunks=N, origBase=0x...
// Paths are resolved against --module-dir (default: the exe's directory).
// --module-dir may be repeated; the exe's own directory is always searched.
const MODULE_DIRS = [...getAll('module-dir'), path.dirname(EXE)];
for (const logPath of getAll('modules-from')) {
  const text = fs.readFileSync(logPath, 'utf8');
  const re = /^DLL: (\S+) at (0x[0-9a-f]+),.*origBase=(0x[0-9a-f]+)/gm;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    const cand = [];
    for (const d of MODULE_DIRS) {
      cand.push(path.join(d, name), path.join(d, name.toLowerCase()), path.join(d, name.toUpperCase()));
    }
    const found = cand.find(p => fs.existsSync(p));
    if (!found) { console.error(`[skip] no image on disk for ${name}`); continue; }
    addModule(name, found, Number(m[2]));
  }
}

// --mem=FILE: a run.js hexdump ("  0xADDR  bb bb ...  ascii") used as a code
// image. This is the only way to reach a packed executable — UPX leaves the
// text section with rawSize 0, so the bytes that actually run exist nowhere on
// disk. Take the dump from `--input=N:dump-mem:0xADDR:LEN` after the unpacker
// has run. Each contiguous run of dumped lines becomes its own pseudo-module.
for (const memPath of getAll('mem')) {
  const text = fs.readFileSync(memPath, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(0x[0-9a-fA-F]+)\s+((?:[0-9a-f]{2} )+[0-9a-f]{2})/.exec(line);
    if (!m) continue;
    rows.push({ addr: Number(m[1]), bytes: m[2].split(' ').map(b => parseInt(b, 16)) });
  }
  rows.sort((a, b) => a.addr - b.addr);
  let run = null;
  const flush = () => {
    if (!run) return;
    const buf = Buffer.from(run.bytes);
    const lo = run.addr, hi = run.addr + buf.length;
    modules.push({
      name: `${path.basename(memPath)}@0x${lo.toString(16)}`,
      loadAddr: lo, origBase: lo, lo, hi,
      pe: { buf, va2off: (va) => (va >= lo && va < hi ? va - lo : -1) },
    });
    run = null;
  };
  for (const r of rows) {
    if (run && r.addr === run.addr + run.bytes.length) run.bytes.push(...r.bytes);
    else { flush(); run = { addr: r.addr, bytes: r.bytes.slice() }; }
  }
  flush();
}

function moduleFor(va) {
  let fallback = null;
  for (const mod of modules) {
    if (va < mod.lo || va >= mod.hi) continue;
    // A --mem snapshot beats the on-disk image wherever both cover the address:
    // the disk copy of a packed section has no bytes there at all.
    if (mod.pe.va2off(va - mod.loadAddr + mod.origBase) >= 0) return mod;
    if (!fallback) fallback = mod;
  }
  return fallback;
}

// -------------------------------------------------------------- classifier
const REG32 = new Set(['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi']);
const REG16 = new Set(['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di']);
const REG8 = new Set(['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh']);
const SREG = new Set(['es', 'cs', 'ss', 'ds', 'fs', 'gs']);

// The ops a dataflow expression tree can reproduce exactly, as full 32-bit
// values, with no flag side effect that anything in the block observes.
const FOLDABLE_MN = new Set([
  'mov', 'lea', 'add', 'sub', 'and', 'or', 'xor', 'imul',
  'neg', 'not', 'shl', 'sal', 'shr', 'sar', 'movzx', 'movsx', 'nop',
]);

const FLAG_CONSUMERS = /^(set[a-z]{1,3}|cmov[a-z]{1,3}|lahf|pushf|pushfd|popf|popfd|sahf|rcl|rcr|adc|sbb|int o|salc)$/;
const STRING_MN = /^(rep |repe |repne )?(movs[bwd]|stos[bwd]|lods[bwd]|scas[bwd]|cmps[bwd]|ins[bwd]|outs[bwd])$/;

// Split "mnemonic operands" honouring a leading segment prefix ("fs mov ...").
function splitInsn(insn) {
  let seg = null;
  let s = insn;
  const first = s.split(' ')[0];
  if (SREG.has(first)) { seg = first; s = s.slice(first.length + 1); }
  const sp = s.indexOf(' ');
  const mn = sp < 0 ? s : s.slice(0, sp);
  const ops = sp < 0 ? '' : s.slice(sp + 1);
  return { seg, mn, ops, text: s };
}

// Split an operand list at top-level commas (memory operands have no commas).
function operands(ops) {
  if (!ops) return [];
  // strip a trailing "  ; comment"
  const c = ops.indexOf(';');
  const body = c >= 0 ? ops.slice(0, c) : ops;
  return body.split(',').map(s => s.trim()).filter(Boolean);
}

function isMem(op) { return op.includes('['); }
// Bare register token, ignoring any "byte "/"word "/"dword " size prefix.
function bareReg(op) {
  const t = op.replace(/^(byte|word|dword|qword) +/, '').trim();
  return t;
}
// Every 32-bit register named anywhere in an operand (base/index included).
function regsIn(op) {
  const out = [];
  for (const m of op.matchAll(/\b(eax|ecx|edx|ebx|esp|ebp|esi|edi)\b/g)) out.push(m[1]);
  return out;
}
function reg32Of(name) {
  const map = {
    ax: 'eax', cx: 'ecx', dx: 'edx', bx: 'ebx', sp: 'esp', bp: 'ebp', si: 'esi', di: 'edi',
    al: 'eax', cl: 'ecx', dl: 'edx', bl: 'ebx', ah: 'eax', ch: 'ecx', dh: 'edx', bh: 'ebx',
  };
  return map[name] || (REG32.has(name) ? name : null);
}

const TERMINATORS = /^(j[a-z]{1,4}|jmp|call|ret|retf|iret|iretd|int|int3|into|loop|loopz|loopnz|hlt|leave)$/;

// ------------------------------------------------------- memory operand model
// Used only by the `alias` relaxation. A parsed operand is
//   { base, idx, scale, disp, absolute }
// where `absolute` means "no register at all", i.e. a fixed address. Anything
// the parser does not fully understand returns null, which the disjointness
// test reads as "may alias" — the conservative direction.
function parseMem(op) {
  const m = /\[([^\]]+)\]/.exec(op);
  if (!m) return null;
  const toks = m[1].match(/[+-]?[^+-]+/g);
  if (!toks) return null;
  let base = null, idx = null, scale = 1, disp = 0, sawReg = false;
  for (let raw of toks) {
    let sign = 1;
    let t = raw.trim();
    if (t[0] === '+') t = t.slice(1).trim();
    else if (t[0] === '-') { sign = -1; t = t.slice(1).trim(); }
    const sc = /^(e[a-z][a-z])\*(\d)$/.exec(t);
    if (sc && REG32.has(sc[1])) {
      if (idx !== null || sign < 0) return null;
      idx = sc[1]; scale = Number(sc[2]); sawReg = true; continue;
    }
    if (REG32.has(t)) {
      if (sign < 0) return null;
      if (base === null) base = t;
      else if (idx === null) idx = t;
      else return null;
      sawReg = true; continue;
    }
    if (/^0x[0-9a-fA-F]+$/.test(t) || /^\d+$/.test(t)) { disp += sign * Number(t); continue; }
    return null;
  }
  return { base, idx, scale, disp, absolute: !sawReg };
}

function memSize(op) {
  if (/\bbyte\b/.test(op)) return 1;
  if (/\bword\b/.test(op) && !/\bdword\b/.test(op)) return 2;
  return 4;
}

// Every memory reference an instruction makes, in program order, as
// { role: 'load'|'store', mem, sz }.
function memRefs(mn, ops) {
  const list = operands(ops);
  const out = [];
  if (!list.length || mn === 'lea') return out;
  const push = (role, op) => out.push({ role, mem: parseMem(op), sz: memSize(op) });
  if (list.length === 1) {
    if (!isMem(list[0])) return out;
    if (mn === 'push') push('load', list[0]);
    else if (mn === 'pop') push('store', list[0]);
    else { push('load', list[0]); push('store', list[0]); }
    return out;
  }
  const writesDst = !(mn === 'cmp' || mn === 'test');
  const readsDst = writesDst && !(mn === 'mov' || mn === 'movzx' || mn === 'movsx' || /^set/.test(mn));
  for (let i = 0; i < list.length; i++) {
    if (!isMem(list[i])) continue;
    if (i === 0) {
      if (!writesDst) push('load', list[0]);
      else { if (readsDst) push('load', list[0]); push('store', list[0]); }
    } else push('load', list[i]);
  }
  return out;
}

const STACKISH = new Set(['esp', 'ebp']);

// Can a store to `s` and a later load from `l` touch the same byte?
// `s.unsafe` is set when a register the store's address depended on has been
// rewritten since, which invalidates any displacement arithmetic.
//
// ASSUMPTION, stated because it is not sound in general: a reference based on
// esp/ebp and one that is not are treated as disjoint (stack frame vs heap or
// static data). Real code that hands out a pointer to a local and then reaches
// it through a non-frame register violates this; nothing in the four measured
// windows does, but a fold that shipped this rule would need the check made
// real (or restricted to frames whose address is never taken).
function mayAlias(s, l) {
  const a = s.mem, b = l.mem;
  if (!a || !b) return true;
  const overlap = () => !(a.disp + s.sz <= b.disp || b.disp + l.sz <= a.disp);
  if (a.absolute && b.absolute) return overlap();
  const aStack = a.base && STACKISH.has(a.base);
  const bStack = b.base && STACKISH.has(b.base);
  // static/absolute address vs a stack frame reference
  if (a.absolute && bStack) return false;
  if (b.absolute && aStack) return false;
  if (a.absolute || b.absolute) return true;
  if (a.base && b.base && a.base !== b.base && (aStack !== bStack)) return false;
  if (s.unsafe) return true;
  if (a.base !== b.base) return true;
  if (a.idx !== b.idx || (a.idx && a.scale !== b.scale)) return true;
  return overlap();
}

// Classify one decoded instruction.
// Returns { kind, class, writes:[reg32], loads, stores, terminator:bool }
// kind: 'fold' | 'barrier' | 'terminator'
function classify(insn) {
  const { seg, mn, ops } = splitInsn(insn);
  const list = operands(ops);
  const res = {
    mn, ops, seg, kind: 'barrier', cls: 'other', sub: null,
    writes: [], loads: 0, stores: 0, terminator: false,
  };

  if (insn.startsWith('db ') || insn === '??' || insn === '<decode error>') {
    res.cls = 'undecoded';
    res.terminator = true;
    return res;
  }

  // --- terminators -------------------------------------------------------
  const isJcc = /^j[a-z]{1,3}$/.test(mn) && mn !== 'jmp';
  if (mn === 'jmp' || isJcc || mn === 'call' || mn === 'ret' || mn === 'retf'
    || mn === 'iret' || mn === 'iretd' || mn === 'int' || mn === 'int3'
    || mn === 'into' || /^loop/.test(mn) || mn === 'jecxz' || mn === 'jcxz'
    || mn === 'hlt') {
    res.kind = 'terminator';
    res.terminator = true;
    res.cls = mn === 'call' ? 'call'
      : (mn === 'ret' || mn === 'retf' || mn === 'iret' || mn === 'iretd') ? 'ret'
        : (mn === 'int' || mn === 'int3' || mn === 'into') ? 'int'
          : (isJcc || /^loop/.test(mn) || mn === 'jecxz' || mn === 'jcxz') ? 'branch-cc'
            : 'branch';
    if (list.some(isMem)) res.loads++;
    return res;
  }
  if (STRING_MN.test(insn)) {
    res.cls = 'string';
    res.terminator = insn.startsWith('rep');
    return res;
  }

  // --- segment / special-register access ---------------------------------
  if (seg && seg !== 'ds' && seg !== 'cs' && seg !== 'ss') { res.cls = 'segment'; return res; }
  if (list.some(o => SREG.has(bareReg(o)))) { res.cls = 'segment'; return res; }

  // --- x87 / MMX / SSE ---------------------------------------------------
  if (/^f/.test(mn) && mn !== 'fs') { res.cls = 'fpu/simd'; return res; }
  // NOTE: the packed-op alternation must not be a bare /p[a-z]+/ — that also
  // matches push/pop/pusha/popa/pushf/popf and files every stack instruction
  // under fpu/simd. Spell out the real MMX/SSE/3DNow prefixes instead.
  const PACKED = /^(p(?:ack|add|and|andn|avg|cmp|extr|f[a-z]+|insr|madd|max|min|mov|mul|or|sad|shuf|sll|sra|srl|sub|unpck|xor)[a-z0-9]*|movq|movd|emms|movaps|movups|movss|movlps|movhps|cvt[a-z0-9]*|add[ps]s|mul[ps]s)$/;
  if (/\b(mm[0-7]|xmm[0-7])\b/.test(ops) || PACKED.test(mn)) {
    res.cls = 'fpu/simd';
    return res;
  }

  // --- flag consumers / producers we cannot reproduce ---------------------
  if (mn === 'adc' || mn === 'sbb') {
    res.cls = 'adc/sbb';
    res.sub = 'adc/sbb';
    if (list.length > 1 && isMem(list[0])) { res.loads++; res.stores++; }
    else { if (list.some(isMem)) res.loads++; const r = reg32Of(bareReg(list[0] || '')); if (r) res.writes.push(r); }
    return res;
  }
  if (FLAG_CONSUMERS.test(mn) || /^set/.test(mn) || /^cmov/.test(mn)) {
    res.cls = 'flags';
    // setcc/cmovcc read a flag *field*; a per-field last-writer model can
    // reproduce them. lahf/sahf/pushf/popf read the whole word, and rcl/rcr
    // are a carry-through rotate — those stay barriers under every mode.
    if (/^set/.test(mn)) {
      res.sub = 'setcc';
      if (list.some(isMem)) res.stores++;
      else { const r = reg32Of(bareReg(list[0] || '')); if (r) res.writes.push(r); }
    } else if (/^cmov/.test(mn)) {
      res.sub = 'cmov';
      if (list.some(isMem)) res.loads++;
      const r = reg32Of(bareReg(list[0] || '')); if (r) res.writes.push(r);
    } else res.sub = 'flags-word';
    return res;
  }
  if (mn === 'rcl' || mn === 'rcr') { res.cls = 'flags'; res.sub = 'flags-word'; return res; }

  // --- stack -------------------------------------------------------------
  if (mn === 'push' || mn === 'pop' || mn === 'pusha' || mn === 'pushad'
    || mn === 'popa' || mn === 'popad' || mn === 'leave' || mn === 'enter') {
    res.cls = 'stack';
    if (mn === 'push') { res.stores++; if (list.some(isMem)) res.loads++; }
    else if (mn === 'pop') { res.loads++; if (list.some(isMem)) res.stores++; else res.writes.push(bareReg(list[0])); }
    res.writes.push('esp');
    return res;
  }

  // --- div / mul ---------------------------------------------------------
  if (mn === 'div' || mn === 'idiv') { res.cls = 'div'; return res; }
  if (mn === 'mul' || (mn === 'imul' && list.length === 1)) { res.cls = 'mul64'; return res; }

  // --- shift by cl -------------------------------------------------------
  if (/^(shl|sal|shr|sar|rol|ror|shld|shrd)$/.test(mn)) {
    if (list.some(o => bareReg(o) === 'cl')) { res.cls = 'shift-cl'; return res; }
    if (mn === 'rol' || mn === 'ror' || mn === 'shld' || mn === 'shrd') { res.cls = 'other'; return res; }
  }

  // --- cmp/test: flag producers whose only consumer may be the terminator -
  if (mn === 'cmp' || mn === 'test') {
    res.cls = 'cmp/test';
    if (list.some(isMem)) res.loads++;
    return res;
  }

  // --- partial-register width -------------------------------------------
  // The disassembler prints 8/16-bit forms with 8/16-bit register names, or
  // with an explicit "byte "/"word " size word on a memory destination.
  const sizeWord = /\b(byte|word) \[/.test(ops) || /^(byte|word) /.test(ops);
  const named8or16 = list.some(o => {
    const b = bareReg(o);
    return REG8.has(b) || REG16.has(b);
  });
  const isExt = mn === 'movzx' || mn === 'movsx';
  if (!isExt && (sizeWord || named8or16)) {
    // A partial write only if the *destination* is narrow; a narrow source
    // into a wide dest cannot happen outside movzx/movsx, so treat any narrow
    // operand as a partial-width op.
    res.cls = 'partial-reg';
    if (list.length > 1 && isMem(list[0])) { res.loads += (mn !== 'mov') ? 1 : 0; res.stores++; }
    else if (list.some(isMem)) res.loads++;
    const d = list.length ? bareReg(list[0]) : null;
    if (d && !isMem(d)) { const r = reg32Of(d); if (r) res.writes.push(r); }
    // ah/ch/dh/bh writes are the awkward case for an insert/extract model:
    // the field is at bit 8, so it costs an extra shift on both sides.
    res.sub = (d && /^(ah|ch|dh|bh)$/.test(d)) ? 'high-byte' : 'partial';
    return res;
  }

  // --- inc/dec: full-width but flag-writing; fold-safe shape, but they are
  // partial flag updates (CF preserved), which an expression tree cannot
  // reproduce without modelling CF. Count separately as 'other'.
  if (mn === 'inc' || mn === 'dec') {
    res.cls = 'other';
    res.sub = 'inc/dec';
    if (list.some(isMem)) { res.loads++; res.stores++; }
    else res.writes.push(bareReg(list[0]));
    return res;
  }

  // --- xchg, bswap, bt*, cdq/cwde, etc. ----------------------------------
  if (!FOLDABLE_MN.has(mn)) { res.cls = 'other'; return res; }

  // --- FOLDABLE ----------------------------------------------------------
  if (mn === 'nop') { res.kind = 'fold'; res.cls = 'fold'; return res; }

  const dst = list[0] !== undefined ? list[0] : null;
  if (dst === null) { res.cls = 'other'; return res; }

  if (isMem(dst)) {
    res.stores++;
    if (mn !== 'mov' && mn !== 'lea') res.loads++;  // read-modify-write
  } else {
    const r = bareReg(dst);
    if (!REG32.has(r)) { res.cls = 'other'; return res; }
    res.writes.push(r);
  }
  for (let i = 1; i < list.length; i++) if (isMem(list[i])) res.loads++;
  if (mn === 'lea') res.loads = 0;   // lea computes an address, it does not read

  res.kind = 'fold';
  res.cls = 'fold';
  return res;
}

// --------------------------------------------------------------- block decode
function decodeBlock(mod, runtimeVA) {
  const fileVA = runtimeVA - mod.loadAddr + mod.origBase;
  const off = mod.pe.va2off(fileVA);
  if (off < 0) return null;
  let lines;
  try {
    lines = disasmAt(mod.pe.buf, off, fileVA, MAX_OPS, null, { linear: true });
  } catch (e) { return null; }
  if (!lines.length) return null;

  const insns = [];
  for (let i = 0; i < lines.length; i++) {
    const va = parseInt(lines[i].slice(0, 8), 16);
    const nextVa = i + 1 < lines.length ? parseInt(lines[i + 1].slice(0, 8), 16) : null;
    const len = nextVa !== null ? nextVa - va : null;
    const rest = lines[i].slice(10);
    // The bytes column is padEnd(28); with len known it is exactly len*3-1
    // chars, so the mnemonic starts right after whichever is longer.
    const bytesWidth = len !== null ? Math.max(28, len * 3 - 1) : 28;
    const insn = rest.slice(bytesWidth + 1).trim();
    const c = classify(insn);
    c.mems = memRefs(c.mn, c.ops);
    const t = /^(?:j[a-z]{1,4}|loop[a-z]*)\s+(?:short\s+)?(0x[0-9a-fA-F]+)$/.exec(insn);
    c.target = t ? Number(t[1]) : null;
    insns.push({ va, insn, len, ...c });
    if (c.terminator) break;
  }
  // No terminator inside MAX_OPS: the block is longer than the window, so its
  // op count is a floor, not the truth. Flagged so the report can say so.
  insns.truncated = !insns[insns.length - 1].terminator;
  return insns;
}

// ------------------------------------------------------------------ analysis
// ------------------------------------------------------------- relaxed modes
// Each relaxation names a barrier class the fold would have to model, and asks
// what the census looks like if it did.
//
//   alias    a store followed by a load is a barrier only when the two
//            addresses may overlap (see mayAlias above).
//   partial  8/16-bit register and memory accesses are modelled as
//            insert/extract on the 32-bit value and fold.
//   flags    flags are carried as values with a per-FIELD last writer, so
//            inc/dec (CF-preserving), adc/sbb, cmp/test feeding a jcc, and
//            setcc/cmovcc fold. pushf/popf/lahf/sahf, shifts by cl and
//            rcl/rcr stay barriers: they read or write the whole word.
const RELAXATIONS = ['alias', 'partial', 'flags'];
const MODES = [
  { name: 'exact', relax: new Set() },
  { name: 'alias', relax: new Set(['alias']) },
  { name: 'partial', relax: new Set(['partial']) },
  { name: 'flags', relax: new Set(['flags']) },
  { name: 'all', relax: new Set(RELAXATIONS) },
];

// Does this instruction fold under `relax`? Returns the class it is counted
// under when it does not. `cls` is the already-resolved class (cmp/test has
// been mapped to terminator-flags/flags by the caller).
function foldsUnder(ins, cls, relax) {
  if (ins.kind === 'fold') return true;
  if (ins.terminator) return false;
  if (relax.has('partial') && ins.cls === 'partial-reg') return true;
  if (relax.has('flags')) {
    if (ins.cls === 'adc/sbb') return true;
    if (cls === 'terminator-flags' || (ins.cls === 'cmp/test')) return true;
    if (ins.cls === 'other' && ins.sub === 'inc/dec') return true;
    if (ins.cls === 'flags' && (ins.sub === 'setcc' || ins.sub === 'cmov')) return true;
  }
  return false;
}

function analyzeBlockMode(insns, relax) {
  const n = insns.length;
  let foldable = 0, runs = 0, longest = 0, cur = 0, highByte = 0;
  const barriers = {};
  let pending = [];   // stores live in the current run (alias mode)
  let sawStoreInRun = false;
  const lastIsBranchCc = n > 0 && insns[n - 1].cls === 'branch-cc';
  const foldMask = new Array(n).fill(false);

  for (let i = 0; i < n; i++) {
    const ins = insns[i];
    let cls = ins.cls;
    if (cls === 'cmp/test') cls = (lastIsBranchCc && i === n - 2) ? 'terminator-flags' : 'flags';
    const folds = foldsUnder(ins, cls, relax);

    if (folds) {
      const loadsHere = ins.mems.filter(m => m.role === 'load');
      let broke = false;
      if (relax.has('alias')) {
        for (const l of loadsHere) {
          if (pending.some(s => mayAlias(s, l))) { broke = true; break; }
        }
      } else if (sawStoreInRun && ins.loads > 0) broke = true;

      if (broke) {
        barriers.alias = (barriers.alias || 0) + 1;
        if (cur > longest) longest = cur;
        cur = 0; pending = []; sawStoreInRun = false;
      }
      if (relax.has('partial') && ins.cls === 'partial-reg' && ins.sub === 'high-byte') highByte++;
      foldable++;
      foldMask[i] = true;
      if (cur === 0) runs++;
      cur++;
      // register writes invalidate displacement arithmetic on any pending
      // store whose address used them
      for (const w of ins.writes) {
        for (const s of pending) {
          if (s.mem && (s.mem.base === w || s.mem.idx === w)) s.unsafe = true;
        }
      }
      for (const m of ins.mems) if (m.role === 'store') { pending.push({ mem: m.mem, sz: m.sz, unsafe: false }); sawStoreInRun = true; }
    } else {
      if (cur > longest) longest = cur;
      cur = 0; pending = []; sawStoreInRun = false;
      barriers[cls] = (barriers[cls] || 0) + 1;
    }
  }
  if (cur > longest) longest = cur;

  // A block whose whole interior folds AND does so as a single run: that is
  // what actually collapses to ONE dispatch. (A body that folds but is chopped
  // by alias breaks is several dispatches, not one, so it does not count.) In
  // a self-loop this is the "collapsible loop" of the bench's 64-trip column.
  let fullyFoldable = n > 1 && runs === 1;
  for (let i = 0; i < n - 1; i++) if (!foldMask[i]) { fullyFoldable = false; break; }
  // ...and the same restricted to bodies worth collapsing: a 1- or 2-op body
  // that "fully folds" is a degenerate case that flatters the number.
  const collapsibleBig = fullyFoldable && (n - 1) >= 4;

  return { ops: n, foldable, runs, longest, barriers, highByte, fullyFoldable, collapsibleBig };
}

// ------------------------------------------------------- terminator taxonomy
// self-loop       the terminator jumps back to the block's own head
// interior-branch a conditional branch to somewhere else (one arm of an
//                 if/else, or a multi-block loop)
// plain-exit      jmp/call/ret/int/fallthrough to another block
// Mnemonics that write the condition codes. Everything else is transparent to
// the flag the terminator reads, so the trip test can be several instructions
// back — mw3's blend loop puts two `mov`s between its `dec esi` and its `jnz`.
const SETS_FLAGS = /^(add|sub|and|or|xor|cmp|test|inc|dec|neg|shl|sal|shr|sar|rol|ror|rcl|rcr|shld|shrd|adc|sbb|imul|mul|div|idiv|bt|bts|btr|btc|xadd|cmpxchg|scas|cmps|sahf|popf|popfd)$/;

function terminatorClass(insns, headVA) {
  const n = insns.length;
  const t = insns[n - 1];
  const cc = t.cls === 'branch-cc';
  if ((cc || t.cls === 'branch') && t.target === headVA) {
    // trip structure: what drives the back edge? Walk back to the last
    // instruction that actually wrote the flags the terminator reads.
    let prev = null;
    for (let i = n - 2; i >= 0; i--) {
      const mn = insns[i].mn.replace(/^rep[a-z]* /, '');
      if (SETS_FLAGS.test(mn)) { prev = insns[i]; break; }
    }
    let trip = 'other';
    if (/^loop/.test(t.mn)) trip = 'loop';
    else if (t.cls === 'branch') trip = 'unconditional';
    else if (prev && prev.sub === 'inc/dec' && /^j(n?z|n?e)$/.test(t.mn)) trip = 'dec/jnz';
    else if (prev && prev.cls === 'cmp/test') trip = 'cmp/jcc';
    else if (prev) trip = `alu/${prev.mn}`;
    return { cls: 'self-loop', trip };
  }
  if (cc) return { cls: 'interior-branch', trip: null };
  return { cls: 'plain-exit', trip: null };
}

function analyzeBlock(insns) {
  const n = insns.length;
  let foldable = 0, loads = 0, stores = 0;
  const written = new Set();
  const barriers = {};       // class -> ops it blocked (1 per barrier insn)
  let longest = 0, cur = 0;
  let sawStoreInRun = false;
  let aliasBreaks = 0;
  // Second pass bound: the same walk with the may-alias rule switched off, so
  // the report can bracket the answer between "no alias analysis at all" and
  // "perfect alias analysis". Everything else stays conservative.
  let longestNA = 0, curNA = 0;
  let runs = 0;                 // number of maximal foldable runs in the block

  const lastIsBranchCc = n > 0 && insns[n - 1].cls === 'branch-cc';

  for (let i = 0; i < n; i++) {
    const ins = insns[i];
    loads += ins.loads;
    stores += ins.stores;
    for (const w of ins.writes) written.add(w);

    let cls = ins.cls;
    // A cmp/test immediately feeding a conditional terminator is the normal
    // shape, not a failure of the fold: the tree just ends there.
    if (cls === 'cmp/test') {
      cls = (lastIsBranchCc && i === n - 2) ? 'terminator-flags' : 'flags';
    }

    if (ins.kind === 'fold') {
      // Order rule: a load that follows a store inside the same run may alias
      // it, and an expression tree reorders freely, so the run ends there.
      if (sawStoreInRun && ins.loads > 0) {
        aliasBreaks++;
        barriers.alias = (barriers.alias || 0) + 1;
        if (cur > longest) longest = cur;
        cur = 0;
        sawStoreInRun = false;
      }
      foldable++;
      if (cur === 0) runs++;      // a new maximal run starts here
      cur++;
      curNA++;
      if (ins.stores > 0) sawStoreInRun = true;
    } else {
      if (cur > longest) longest = cur;
      if (curNA > longestNA) longestNA = curNA;
      cur = 0;
      curNA = 0;
      sawStoreInRun = false;
      barriers[cls] = (barriers[cls] || 0) + 1;
    }
  }
  if (cur > longest) longest = cur;
  if (curNA > longestNA) longestNA = curNA;

  return {
    ops: n, foldable, runs, longest, longestNA, liveOuts: written.size,
    loads, stores, barriers, aliasBreaks,
  };
}

// ============================================================== x87 census
// The integer walk above treats every x87 instruction as one flat `fpu/simd`
// barrier, which is only correct as a statement about the *integer* fold: it
// says nothing about whether the float side is expression-shaped. On a
// software-rendered 3D game that barrier is the single largest class, so the
// question "would a float expression fold pay?" needs its own population.
//
// An **x87 run** is a maximal sequence of stack-arithmetic instructions whose
// register naming can be resolved statically at decode time. Inside a run the
// x87 stack is renamed: `fld`/`fild`/`fld1`/`fldz`/constant loads push,
// `fstp`/`fistp`/the `p`-suffixed arithmetic pop, `fxch` swaps two names, and
// everything else leaves TOP alone. Because every operand is written `st(N)`
// *relative to the current TOP*, the rename is exact as long as we know the
// running delta -- which we do, from the run's first instruction. So the run
// is a float dataflow tree over at most eight named values plus its memory
// operands, exactly the shape a fold would emit as one threaded op.
//
// MEMBERS (the run body)
//   fld fst fstp fld1 fldz fldpi fldl2e fldl2t fldlg2 fldln2
//   fadd fsub fsubr fmul fdiv fdivr (+ the p / i variants)
//   fxch fchs fabs fild fist fistp fsqrt fwait fnop
//   The constant loads other than fld1/fldz are members rather than
//   transcendentals: they push a literal and cost nothing to model.
//
// BARRIERS (each ends the run; counted as "what ended it")
//   status-word     fnstsw/fstsw/fnstcw/fstcw/fldcw/fclex/finit/fnsave/frstor
//                   -- the control and status words are architectural state a
//                   value-tree does not carry, and the exception flags are
//                   sticky, so a fold may not reorder across them.
//   compare         fcom* / fucom* / ficom* / fcomi* / ftst / fxam -- these
//                   write the condition codes into the status word, which is
//                   then read by an fnstsw/sahf or a jcc some distance away.
//   transcendental  fsin fcos fsincos fptan fpatan f2xm1 fyl2x fyl2xp1
//                   fscale fprem fprem1 frndint fxtract
//   branch          any call/ret/int/jmp/jcc -- the block terminator.
//   integer-interleave  an integer instruction that touches memory the run
//                   also touches (`mayAlias`, the same rule the integer walk
//                   uses). An integer op that does NOT is allowed to sit
//                   inside the run and is counted as "interleaved integer":
//                   it is scheduled around the tree, not through it.
//   other-fp        MMX/SSE, ffree/fincstp/fdecstp, fisttp -- outside the
//                   modelled set.
//   top-overflow    the static rename would need more than eight live stack
//                   slots. Cannot happen on a real x87 from an empty stack,
//                   but it is checked rather than assumed.
//   other           string ops, segment accesses, undecoded bytes.
//   block-end       the block ran out; not a barrier, reported for balance.
const X87_MEMBER = /^(fld|fst|fstp|fld1|fldz|fldpi|fldl2e|fldl2t|fldlg2|fldln2|fadd|faddp|fiadd|fsub|fsubr|fsubp|fsubrp|fisub|fisubr|fmul|fmulp|fimul|fdiv|fdivr|fdivp|fdivrp|fidiv|fidivr|fxch|fchs|fabs|fild|fist|fistp|fsqrt|fwait|wait|fnop)$/;
const X87_COMPARE = /^(fcom|fcomp|fcompp|fucom|fucomp|fucompp|ficom|ficomp|fcomi|fcomip|fucomi|fucomip|ftst|fxam)$/;
const X87_STATUS = /^(fnstsw|fstsw|fnstcw|fstcw|fldcw|fclex|fnclex|finit|fninit|fstenv|fnstenv|fldenv|fsave|fnsave|frstor)$/;
const X87_TRANS = /^(fsin|fcos|fsincos|fptan|fpatan|f2xm1|fyl2x|fyl2xp1|fscale|fprem|fprem1|frndint|fxtract)$/;
const X87_OTHERFP = /^(ffree|ffreep|fincstp|fdecstp|fisttp|fbld|fbstp|fxsave|fxrstor|fcmov[a-z]+|fpu_d[89abcdef])$/;
const X87_PUSH = /^(fld|fld1|fldz|fldpi|fldl2e|fldl2t|fldlg2|fldln2|fild|fbld)$/;
const X87_POP = /^(fstp|fistp|fbstp|faddp|fsubp|fsubrp|fmulp|fdivp|fdivrp)$/;
// x87 memory forms: which of them read and which write.
const X87_MEM_STORE = /^(fst|fstp|fist|fistp|fbstp|fnstsw|fstsw|fnstcw|fstcw|fnstenv|fstenv|fnsave|fsave)$/;

function isX87(mn) {
  return X87_MEMBER.test(mn) || X87_COMPARE.test(mn) || X87_STATUS.test(mn)
    || X87_TRANS.test(mn) || X87_OTHERFP.test(mn);
}

// THE PUSH/POP CLASSIFIER BUG, now fixed in classify() above.
// classify() used to test a SIMD mnemonic set spelled `/^(p[a-z]+|movq|...)$/`
// BEFORE its stack case, and `p[a-z]+` matches `push`, `pop`, `pusha`, `popa`,
// `pushf` and `popf`. Every stack instruction was therefore counted in the
// integer census's `fpu/simd` barrier, and the `stack` class the barrier table
// documents never appeared in any report. Measured on the quake2 software
// window that was 527,965 retired ops, i.e. 2.8 of the 20.3 percentage points
// the integer walk attributed to `fpu/simd`; the real x87 share is 17.5 %, and
// that is the number this tool now prints (see PACKED in classify()).
// The mnemonic test below is kept because it is still load-bearing for the
// flag-word forms: `pushf`/`popf`/`pushfd`/`popfd` classify as `flags`, not
// `stack`, yet they do touch [esp] and the interleave test must know that.
const STACK_MN = /^(push|pop|pusha|pushad|popa|popad|pushf|pushfd|popf|popfd|leave|enter)$/;

// x87 memory operands print their width, and `qword` must not be read as
// `word` (the integer memSize() deliberately only knows byte/word/dword).
function x87MemSize(op) {
  if (/\bqword\b/.test(op)) return 8;
  if (/\btbyte\b/.test(op)) return 10;
  if (/\bdword\b/.test(op)) return 4;
  if (/\bword\b/.test(op)) return 2;
  return 4;
}

function x87MemRefs(mn, ops) {
  const out = [];
  for (const o of operands(ops)) {
    if (!isMem(o)) continue;
    out.push({ role: X87_MEM_STORE.test(mn) ? 'store' : 'load',
      mem: parseMem(o), sz: x87MemSize(o) });
  }
  return out;
}

// The memory an *integer* instruction touches, for the interleave test.
// push/pop name no operand but do touch the stack, so give them the implicit
// [esp] reference rather than letting them read as memory-free.
function intMemRefs(ins) {
  const refs = ins.mems.slice();
  if (ins.cls === 'stack' || STACK_MN.test(ins.mn)) {
    refs.push({ role: 'store', mem: { base: 'esp', idx: null, scale: 1, disp: 0, absolute: false }, sz: 4 });
  }
  return refs;
}

function analyzeX87(insns) {
  const n = insns.length;
  const res = {
    x87Ops: 0, memberOps: 0, interleavedInt: 0,
    runs: [], barriers: {}, classOps: {}, longest: 0,
  };
  let cur = 0, pend = [], depth = 0, hi = 0, lo = 0;
  const endRun = (cls) => {
    if (cur > 0) {
      res.runs.push({ len: cur, span: hi - lo, end: cls });
      if (cur > res.longest) res.longest = cur;
      res.barriers[cls] = (res.barriers[cls] || 0) + 1;
    }
    cur = 0; pend = []; depth = 0; hi = 0; lo = 0;
  };
  const bump = (k) => { res.classOps[k] = (res.classOps[k] || 0) + 1; };

  for (let i = 0; i < n; i++) {
    const ins = insns[i];
    const mn = ins.mn;
    if (isX87(mn)) res.x87Ops++;

    if (X87_MEMBER.test(mn)) {
      bump('member');
      let d = depth;
      if (X87_PUSH.test(mn)) d++;
      else if (X87_POP.test(mn)) d--;
      if (Math.max(hi, d) - Math.min(lo, d) > 8) {
        endRun('top-overflow');
        d = X87_PUSH.test(mn) ? 1 : (X87_POP.test(mn) ? -1 : 0);
      }
      depth = d;
      if (depth > hi) hi = depth;
      if (depth < lo) lo = depth;
      cur++; res.memberOps++;
      for (const m of x87MemRefs(mn, ins.ops)) {
        pend.push({ mem: m.mem, sz: m.sz, unsafe: false, role: m.role });
      }
      continue;
    }
    if (X87_COMPARE.test(mn)) { bump('compare'); endRun('compare'); continue; }
    if (X87_STATUS.test(mn)) { bump('status-word'); endRun('status-word'); continue; }
    if (X87_TRANS.test(mn)) { bump('transcendental'); endRun('transcendental'); continue; }
    if (X87_OTHERFP.test(mn) || (/^f/.test(mn) && ins.cls === 'fpu/simd')) {
      bump('other-fp'); endRun('other-fp'); continue;
    }
    // Genuine MMX/SSE. `push`/`pop` reach here misclassified (see STACK_MN
    // above) and must fall through to the integer path instead.
    if (ins.cls === 'fpu/simd' && !STACK_MN.test(mn)) { endRun('simd'); continue; }
    if (ins.terminator || ins.cls === 'call' || ins.cls === 'ret'
      || ins.cls === 'branch' || ins.cls === 'branch-cc' || ins.cls === 'int') {
      endRun('branch'); continue;
    }
    if (ins.cls === 'undecoded' || ins.cls === 'string' || ins.cls === 'segment') {
      endRun('other'); continue;
    }
    // --- a plain integer instruction ---------------------------------------
    if (cur > 0) {
      const refs = intMemRefs(ins);
      const clash = refs.some(r => pend.some(p => mayAlias(p, r)));
      if (!clash) {
        res.interleavedInt++;
        for (const w of ins.writes) {
          for (const p of pend) if (p.mem && (p.mem.base === w || p.mem.idx === w)) p.unsafe = true;
        }
        continue;
      }
      endRun('integer-interleave');
    }
  }
  endRun('block-end');
  return res;
}

// ------------------------------------------------------------------- main
const dumpText = fs.readFileSync(DUMP, 'utf8');
const blocks = [];
for (const line of dumpText.split('\n')) {
  const m = /^\s*(0x[0-9a-fA-F]+)\s+(\d+)/.exec(line);
  if (!m) continue;
  blocks.push({ addr: Number(m[1]), hits: Number(m[2]) });
}

// Guest API thunk zone. Pinned (derived off GUEST_BASE), so it is one of the
// handful of addresses safe to name; --thunk-base overrides it anyway.
const THUNK_LO = Number(getArg('thunk-base', '0x07500000'));
const THUNK_HI = THUNK_LO + Number(getArg('thunk-size', '0x40000'));
let thunkHits = 0, unknownOutsideHits = 0;
const modAcc = {};   // module name -> { hits, ops }

let outsideHits = 0, insideHits = 0, undecodableHits = 0, truncatedHits = 0;
let totalOps = 0, totalFold = 0, foldIn4Plus = 0, opsIn4Plus = 0, totalRuns = 0;
const barrierOps = {};      // class -> retired barrier instructions
const runSamples = [];      // {longest, weight}
const rows = [];

// per-mode accumulators, and the terminator-class census
const modeAcc = MODES.map(m => ({
  name: m.name, relax: m.relax,
  fold: 0, runs: 0, opsIn4Plus: 0, foldIn4Plus: 0, highByte: 0,
  barriers: {}, samples: [], fullyFoldableOps: 0, selfLoopFullyFoldableOps: 0,
  bigOps: 0, selfLoopBigOps: 0,
}));
const termAcc = {
  'self-loop': { ops: 0, blocks: 0, foldSum: 0 },
  'interior-branch': { ops: 0, blocks: 0, foldSum: 0 },
  'plain-exit': { ops: 0, blocks: 0, foldSum: 0 },
};
const tripAcc = {};   // trip structure -> { ops, blocks, foldSum }

// x87: a parallel population, accumulated on the same hit weights.
const x87 = {
  ops: 0, members: 0, interleaved: 0, runs: 0, membersIn4Plus: 0,
  barriers: {}, classOps: {}, samples: [], spanSamples: [], maxRun: 0, maxSpan: 0,
  term: { 'self-loop': 0, 'interior-branch': 0, 'plain-exit': 0 },
  trips: {},
};

for (const b of blocks) {
  const mod = moduleFor(b.addr);
  if (!mod) {
    outsideHits += b.hits;
    // An address in the emulator's API thunk zone is a Win32 import entry:
    // the guest called an imported function, EIP landed in the thunk, and
    // $win32_dispatch took over. Those hits are host API calls, not guest
    // code, and they are the one part of the "outside images" bucket that has
    // a fixed meaning. THUNK_BASE is guest 0x07500000 (a derived, pinned
    // address -- see the Memory Layout table in CLAUDE.md), 256 KB long.
    if (b.addr >= THUNK_LO && b.addr < THUNK_HI) thunkHits += b.hits;
    else unknownOutsideHits += b.hits;
    continue;
  }
  insideHits += b.hits;
  const insns = decodeBlock(mod, b.addr);
  if (!insns) { undecodableHits += b.hits; continue; }
  if (insns.truncated) truncatedHits += b.hits;
  const a = analyzeBlock(insns);
  const retired = a.ops * b.hits;
  const ma = modAcc[mod.name] || (modAcc[mod.name] = { hits: 0, ops: 0 });
  ma.hits += b.hits; ma.ops += retired;
  totalOps += retired;
  totalFold += a.foldable * b.hits;
  totalRuns += a.runs * b.hits;
  if (a.foldable >= 4) { foldIn4Plus += a.foldable * b.hits; opsIn4Plus += retired; }
  for (const [k, v] of Object.entries(a.barriers)) barrierOps[k] = (barrierOps[k] || 0) + v * b.hits;
  runSamples.push({ longest: a.longest, longestNA: a.longestNA, w: retired });

  // The block is disassembled at its FILE va, so the back-edge target must be
  // compared against insns[0].va, not the runtime address in the dump.
  const term = terminatorClass(insns, insns[0].va);
  const ta = termAcc[term.cls];
  ta.ops += retired; ta.blocks += b.hits; ta.foldSum += a.foldable * b.hits;
  if (term.cls === 'self-loop') {
    const key = term.trip;
    const t = tripAcc[key] || (tripAcc[key] = { ops: 0, blocks: 0, foldSum: 0, fullyByMode: {} });
    t.ops += retired; t.blocks += b.hits; t.foldSum += a.foldable * b.hits;
  }

  const perMode = {};
  for (const acc of modeAcc) {
    const r = analyzeBlockMode(insns, acc.relax);
    perMode[acc.name] = r;
    acc.fold += r.foldable * b.hits;
    acc.runs += r.runs * b.hits;
    acc.highByte += r.highByte * b.hits;
    if (r.foldable >= 4) { acc.opsIn4Plus += retired; acc.foldIn4Plus += r.foldable * b.hits; }
    for (const [k, v] of Object.entries(r.barriers)) acc.barriers[k] = (acc.barriers[k] || 0) + v * b.hits;
    acc.samples.push({ longest: r.longest, w: retired });
    if (r.fullyFoldable) {
      acc.fullyFoldableOps += retired;
      if (r.collapsibleBig) acc.bigOps += retired;
      if (term.cls === 'self-loop') {
        acc.selfLoopFullyFoldableOps += retired;
        if (r.collapsibleBig) acc.selfLoopBigOps += retired;
        const t = tripAcc[term.trip];
        t.fullyByMode[acc.name] = (t.fullyByMode[acc.name] || 0) + retired;
      }
    }
  }

  // --- the x87 population, on the same hit weights ------------------------
  const fx = analyzeX87(insns);
  x87.ops += fx.x87Ops * b.hits;
  x87.members += fx.memberOps * b.hits;
  x87.interleaved += fx.interleavedInt * b.hits;
  x87.runs += fx.runs.length * b.hits;
  for (const [k, v] of Object.entries(fx.barriers)) x87.barriers[k] = (x87.barriers[k] || 0) + v * b.hits;
  for (const [k, v] of Object.entries(fx.classOps)) x87.classOps[k] = (x87.classOps[k] || 0) + v * b.hits;
  for (const r of fx.runs) {
    x87.samples.push({ longest: r.len, w: b.hits });
    x87.spanSamples.push({ longest: r.span, w: b.hits });
    if (r.len >= 4) x87.membersIn4Plus += r.len * b.hits;
    if (r.len > x87.maxRun) x87.maxRun = r.len;
    if (r.span > x87.maxSpan) x87.maxSpan = r.span;
  }
  if (fx.x87Ops) {
    x87.term[term.cls] += fx.x87Ops * b.hits;
    if (term.cls === 'self-loop') {
      x87.trips[term.trip] = (x87.trips[term.trip] || 0) + fx.x87Ops * b.hits;
    }
  }

  rows.push({ addr: b.addr, hits: b.hits, mod: mod.name, retired, insns, term, perMode, x87: fx, ...a });
}

function weightedPct(samples, p, key = 'longest') {
  const sorted = samples.slice().sort((x, y) => x[key] - y[key]);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  if (!total) return 0;
  let acc = 0;
  for (const s of sorted) { acc += s.w; if (acc >= total * p) return s[key]; }
  return sorted[sorted.length - 1][key];
}

const maxRun = runSamples.reduce((m, s) => Math.max(m, s.longest), 0);
const p50 = weightedPct(runSamples, 0.5);
const p90 = weightedPct(runSamples, 0.9);
const p50NA = weightedPct(runSamples, 0.5, 'longestNA');
const p90NA = weightedPct(runSamples, 0.9, 'longestNA');
const maxRunNA = runSamples.reduce((m, s) => Math.max(m, s.longestNA), 0);

rows.sort((a, b) => b.retired - a.retired);

const pct = (x, y) => y ? (100 * x / y).toFixed(1) + '%' : 'n/a';

const out = [];
out.push(`=== expression-fold census: ${LABEL} ===`);
out.push(`blocks in dump          ${blocks.length}`);
out.push(`hits inside images      ${insideHits}  (${pct(insideHits, insideHits + outsideHits)})`);
out.push(`hits outside images     ${outsideHits}  (${pct(outsideHits, insideHits + outsideHits)})`);
out.push(`hits undecodable        ${undecodableHits}  (no raw bytes at that VA: packed/self-modifying code)`);
out.push(`hits in blocks truncated at --max-ops=${MAX_OPS}   ${truncatedHits}  (their op counts are a floor)`);
out.push('');
out.push(`retired ops             ${totalOps}`);
out.push(`foldable ops            ${totalFold}  (${pct(totalFold, totalOps)} of retired)`);
out.push(`ops in blocks w/ >=4 foldable   ${opsIn4Plus} (${pct(opsIn4Plus, totalOps)});  their foldable ops ${foldIn4Plus} (${pct(foldIn4Plus, totalOps)} of retired)`);
out.push(`longest foldable run per block (hit-weighted): p50=${p50}  p90=${p90}  max=${maxRun}`);
out.push(`  ... with the may-alias rule off (perfect alias analysis): p50=${p50NA}  p90=${p90NA}  max=${maxRunNA}`);
// The payoff, stated as the emulator would feel it: each maximal run collapses
// to one dispatch, so the dispatches removed are (foldable ops - runs).
out.push(`maximal foldable runs   ${totalRuns}  (mean length ${totalRuns ? (totalFold / totalRuns).toFixed(2) : 0})`);
out.push(`dispatches removed if every run folds:  ${totalFold - totalRuns}  (${pct(totalFold - totalRuns, totalOps)} of retired ops)`);
out.push('');
out.push('barrier histogram (retired barrier instructions, share of retired ops):');
for (const [k, v] of Object.entries(barrierOps).sort((a, b) => b[1] - a[1])) {
  out.push(`  ${k.padEnd(18)} ${String(v).padStart(12)}  ${pct(v, totalOps)}`);
}
// ------------------------------------------------- (1) terminator classes
out.push('');
out.push('terminator class per block (hit-weighted share of retired ops):');
out.push('  class             retired ops   share   mean fold/block');
for (const k of ['self-loop', 'interior-branch', 'plain-exit']) {
  const t = termAcc[k];
  const meanFold = t.blocks ? (t.foldSum / t.blocks).toFixed(1) : '0.0';
  out.push(`  ${k.padEnd(16)} ${String(t.ops).padStart(11)}  ${pct(t.ops, totalOps).padStart(6)}   ${meanFold.padStart(6)}`);
}
out.push('');
out.push('self-loop trip structure (hit-weighted):');
out.push('  trip            retired ops   share of all   mean fold/block   fully-foldable body (exact -> all)');
for (const [k, t] of Object.entries(tripAcc).sort((a, b) => b[1].ops - a[1].ops)) {
  const meanFold = t.blocks ? (t.foldSum / t.blocks).toFixed(1) : '0.0';
  const fe = t.fullyByMode.exact || 0, fa = t.fullyByMode.all || 0;
  out.push(`  ${k.padEnd(14)} ${String(t.ops).padStart(11)}  ${pct(t.ops, totalOps).padStart(12)}   ${meanFold.padStart(13)}   ${pct(fe, totalOps)} -> ${pct(fa, totalOps)}`);
}
out.push('');
out.push('collapsible mass — retired ops in blocks whose entire body folds as ONE run');
out.push('(each such block is one dispatch; in a self-loop that is the bench\'s 64-trip column).');
out.push('"body>=4" drops bodies of 1-3 ops, which fold trivially and flatter the total.');
out.push('  mode      all blocks   body>=4    self-loop   self-loop body>=4');
for (const acc of modeAcc) {
  out.push(`  ${acc.name.padEnd(9)} ${pct(acc.fullyFoldableOps, totalOps).padStart(10)}  ${pct(acc.bigOps, totalOps).padStart(8)}  ${pct(acc.selfLoopFullyFoldableOps, totalOps).padStart(11)}  ${pct(acc.selfLoopBigOps, totalOps).padStart(18)}`);
}

// ------------------------------------------------- (2) relaxed barrier modes
const RELAX_ARG = getArg('relax', null);
const WANT = RELAX_ARG === null ? null : new Set(RELAX_ARG.split(',').map(s => s.trim()).filter(Boolean));
const shownModes = modeAcc.filter(m => !WANT || m.name === 'exact' || m.name === 'all'
  || WANT.has(m.name) || [...m.relax].every(r => WANT.has(r)));

out.push('');
out.push('relaxed barrier modes:');
out.push('  mode      foldable   >=4-fold ops   run p50  p90   max   dispatches removed   mean run');
for (const acc of shownModes) {
  const p50m = weightedPct(acc.samples, 0.5);
  const p90m = weightedPct(acc.samples, 0.9);
  const maxm = acc.samples.reduce((m, s) => Math.max(m, s.longest), 0);
  const removed = acc.fold - acc.runs;
  const mean = acc.runs ? (acc.fold / acc.runs).toFixed(2) : '0';
  out.push(`  ${acc.name.padEnd(9)} ${pct(acc.fold, totalOps).padStart(8)}   ${pct(acc.opsIn4Plus, totalOps).padStart(12)}   ${String(p50m).padStart(7)}  ${String(p90m).padStart(3)}  ${String(maxm).padStart(4)}   ${pct(removed, totalOps).padStart(18)}   ${mean.padStart(8)}`);
}
for (const acc of shownModes) {
  out.push('');
  out.push(`remaining barriers under --relax=${acc.name === 'exact' ? '(none)' : [...acc.relax].join(',')}:`);
  const entries = Object.entries(acc.barriers).sort((a, b) => b[1] - a[1]);
  if (!entries.length) out.push('  (none)');
  for (const [k, v] of entries) out.push(`  ${k.padEnd(18)} ${String(v).padStart(12)}  ${pct(v, totalOps)}`);
  if (acc.relax.has('partial')) {
    out.push(`  [partial] of the now-folding 8/16-bit ops, ${acc.highByte} retired are ah/ch/dh/bh high-byte writes (${pct(acc.highByte, totalOps)} of retired)`);
  }
}

// ------------------------------------------- (3) where the work actually is
out.push('');
out.push('module attribution (hit-weighted retired ops):');
out.push('  module            retired ops    share      hits');
for (const [k, v] of Object.entries(modAcc).sort((a, b) => b[1].ops - a[1].ops)) {
  out.push(`  ${k.padEnd(16)} ${String(v.ops).padStart(11)}  ${pct(v.ops, totalOps).padStart(7)}  ${String(v.hits).padStart(9)}`);
}
// The outside-image bucket is not one thing. Blocks in the API thunk zone are
// Win32 import entries -- the guest called an imported function and EIP landed
// in a thunk -- so they are host API calls, not guest code. Everything else
// out there is a DLL with no image on disk (or JIT/self-modifying code).
out.push(`  [API thunk zone] ${String(thunkHits).padStart(11)}  ${pct(thunkHits, insideHits + outsideHits).padStart(7)}  (share of ALL hits; these are host API entries, not decoded)`);
out.push(`  [other outside]  ${String(unknownOutsideHits).padStart(11)}  ${pct(unknownOutsideHits, insideHits + outsideHits).padStart(7)}  (no image on disk at that VA)`);

// --------------------------------------------------- (4) the x87 population
const x87Rows = rows.filter(r => r.x87.x87Ops > 0)
  .map(r => ({ ...r, x87Retired: r.x87.x87Ops * r.hits }))
  .sort((a, b) => b.x87Retired - a.x87Retired);
out.push('');
out.push('x87 expression population (a SEPARATE walk from the integer one above:');
out.push('the integer census still counts every x87 op as one `fpu/simd` barrier).');
out.push(`  x87 ops                    ${String(x87.ops).padStart(12)}  ${pct(x87.ops, totalOps)} of retired`);
out.push(`  x87 run members            ${String(x87.members).padStart(12)}  ${pct(x87.members, totalOps)} of retired, ${pct(x87.members, x87.ops)} of x87 ops`);
out.push(`  integer ops interleaved    ${String(x87.interleaved).padStart(12)}  ${pct(x87.interleaved, totalOps)} of retired  (scheduled around a run, not through it)`);
out.push(`  x87 runs                   ${String(x87.runs).padStart(12)}  (mean length ${x87.runs ? (x87.members / x87.runs).toFixed(2) : '0'})`);
out.push(`  x87 run length (hit-weighted): p50=${weightedPct(x87.samples, 0.5)}  p90=${weightedPct(x87.samples, 0.9)}  max=${x87.maxRun}`);
out.push(`  x87 ops in runs >=4        ${String(x87.membersIn4Plus).padStart(12)}  ${pct(x87.membersIn4Plus, x87.members)} of x87 run members, ${pct(x87.membersIn4Plus, x87.ops)} of x87 ops`);
out.push(`  live stack slots a run needs (hit-weighted): p50=${weightedPct(x87.spanSamples, 0.5)}  p90=${weightedPct(x87.spanSamples, 0.9)}  max=${x87.maxSpan}`);
out.push(`  dispatches removed if every x87 run folds:  ${x87.members - x87.runs}  (${pct(x87.members - x87.runs, totalOps)} of retired ops)`);
out.push('');
out.push('x87 run barrier histogram (what ended each run, hit-weighted runs ended):');
{
  const tot = Object.values(x87.barriers).reduce((s, v) => s + v, 0);
  const ent = Object.entries(x87.barriers).sort((a, b) => b[1] - a[1]);
  if (!ent.length) out.push('  (no x87 in this window)');
  for (const [k, v] of ent) out.push(`  ${k.padEnd(20)} ${String(v).padStart(12)}  ${pct(v, tot)} of runs ended`);
}
out.push('');
out.push('x87 instruction mix (retired, share of all x87 ops):');
for (const [k, v] of Object.entries(x87.classOps).sort((a, b) => b[1] - a[1])) {
  out.push(`  ${k.padEnd(20)} ${String(v).padStart(12)}  ${pct(v, x87.ops)}`);
}
out.push('');
out.push('where the x87 lives — terminator class of the blocks holding it');
out.push('(hit-weighted share of x87 retired ops):');
for (const k of ['self-loop', 'interior-branch', 'plain-exit']) {
  out.push(`  ${k.padEnd(18)} ${String(x87.term[k]).padStart(12)}  ${pct(x87.term[k], x87.ops)}`);
}
if (Object.keys(x87.trips).length) {
  out.push('  self-loop trip structure of x87-bearing blocks:');
  for (const [k, v] of Object.entries(x87.trips).sort((a, b) => b[1] - a[1])) {
    out.push(`    ${k.padEnd(16)} ${String(v).padStart(12)}  ${pct(v, x87.ops)} of x87 ops`);
  }
}
out.push('');
out.push(`top ${Math.min(TOP, x87Rows.length)} blocks by x87 retired ops:`);
out.push('  addr        module          hits   ops  x87  memb  run  ileav  terminator');
for (const r of x87Rows.slice(0, TOP)) {
  const term = r.term.cls + (r.term.trip ? `:${r.term.trip}` : '');
  out.push(`  0x${r.addr.toString(16).padStart(8, '0')}  ${r.mod.padEnd(14)} ${String(r.hits).padStart(7)}  ${String(r.ops).padStart(4)} ${String(r.x87.x87Ops).padStart(4)}  ${String(r.x87.memberOps).padStart(4)}  ${String(r.x87.longest).padStart(3)}  ${String(r.x87.interleavedInt).padStart(5)}  ${term}`);
}
out.push('');
out.push('disassembly of the top 3 x87 blocks (X = x87 run member, i = integer interleaved inside a run):');
for (const r of x87Rows.slice(0, 3)) {
  out.push(`--- 0x${r.addr.toString(16)}  ${r.mod}  hits=${r.hits} ops=${r.ops} x87=${r.x87.x87Ops} members=${r.x87.memberOps} longestRun=${r.x87.longest}`);
  // Re-walk the block so each line can be tagged the way the census saw it.
  let cur = 0, pend = [];
  for (const ins of r.insns) {
    let tag = ' ';
    if (X87_MEMBER.test(ins.mn)) {
      tag = 'X'; cur++;
      for (const m of x87MemRefs(ins.mn, ins.ops)) pend.push({ mem: m.mem, sz: m.sz, unsafe: false });
    } else if (isX87(ins.mn) || ins.terminator
      || (ins.cls === 'fpu/simd' && !STACK_MN.test(ins.mn))
      || ins.cls === 'undecoded' || ins.cls === 'string' || ins.cls === 'segment') {
      tag = '*'; cur = 0; pend = [];
    } else if (cur > 0) {
      const clash = intMemRefs(ins).some(x => pend.some(p => mayAlias(p, x)));
      if (clash) { tag = '*'; cur = 0; pend = []; } else tag = 'i';
    }
    out.push(`    ${tag} ${ins.va.toString(16).padStart(8, '0')}  ${ins.insn.padEnd(34)} [${ins.cls}]`);
  }
}

out.push('');
out.push(`top ${TOP} blocks by hits*ops:`);
out.push('  addr        module          hits        ops  fold  run  liveout  ld  st   retired  terminator       fold/run @all');
for (const r of rows.slice(0, TOP)) {
  const all = r.perMode.all;
  const term = r.term.cls + (r.term.trip ? `:${r.term.trip}` : '');
  out.push(`  0x${r.addr.toString(16).padStart(8, '0')}  ${r.mod.padEnd(14)} ${String(r.hits).padStart(9)}  ${String(r.ops).padStart(4)}  ${String(r.foldable).padStart(4)}  ${String(r.longest).padStart(3)}  ${String(r.liveOuts).padStart(7)}  ${String(r.loads).padStart(2)}  ${String(r.stores).padStart(2)}  ${String(r.retired).padStart(9)}  ${term.padEnd(16)} ${String(all.foldable).padStart(4)}/${String(all.longest).padStart(4)}${all.fullyFoldable ? ' FULL' : ''}`);
}
out.push('');
out.push('disassembly of the top 5 (F = classified foldable):');
for (const r of rows.slice(0, 5)) {
  out.push(`--- 0x${r.addr.toString(16)}  ${r.mod}  hits=${r.hits} ops=${r.ops} fold=${r.foldable} run=${r.longest} liveout=${r.liveOuts}`);
  for (const i of r.insns) {
    out.push(`    ${i.kind === 'fold' ? 'F' : ' '} ${i.va.toString(16).padStart(8, '0')}  ${i.insn.padEnd(34)} [${i.cls}]`);
  }
}

const text = out.join('\n');
console.log(text);

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({
    label: LABEL, dump: DUMP, exe: EXE,
    blocks: blocks.length, insideHits, outsideHits, undecodableHits, truncatedHits,
    maxOps: MAX_OPS,
    totalOps, totalFold, totalRuns,
    dispatchesRemoved: totalFold - totalRuns,
    foldShare: totalOps ? totalFold / totalOps : 0,
    opsIn4Plus, foldIn4Plus,
    runP50: p50, runP90: p90, runMax: maxRun,
    runP50NoAlias: p50NA, runP90NoAlias: p90NA, runMaxNoAlias: maxRunNA,
    barrierOps,
    terminatorClasses: Object.fromEntries(Object.entries(termAcc).map(([k, t]) => [k, {
      ops: t.ops, share: totalOps ? t.ops / totalOps : 0,
      meanFoldPerBlock: t.blocks ? t.foldSum / t.blocks : 0,
    }])),
    selfLoopTrips: Object.fromEntries(Object.entries(tripAcc).map(([k, t]) => [k, {
      ops: t.ops, share: totalOps ? t.ops / totalOps : 0,
      meanFoldPerBlock: t.blocks ? t.foldSum / t.blocks : 0,
      fullyFoldableOpsByMode: t.fullyByMode,
    }])),
    modes: Object.fromEntries(modeAcc.map(m => [m.name, {
      relax: [...m.relax],
      foldable: m.fold, foldShare: totalOps ? m.fold / totalOps : 0,
      runs: m.runs, dispatchesRemoved: m.fold - m.runs,
      dispatchesRemovedShare: totalOps ? (m.fold - m.runs) / totalOps : 0,
      opsIn4Plus: m.opsIn4Plus, foldIn4Plus: m.foldIn4Plus,
      runP50: weightedPct(m.samples, 0.5), runP90: weightedPct(m.samples, 0.9),
      runMax: m.samples.reduce((x, s) => Math.max(x, s.longest), 0),
      meanRun: m.runs ? m.fold / m.runs : 0,
      highByteOps: m.highByte,
      fullyFoldableOps: m.fullyFoldableOps,
      selfLoopFullyFoldableOps: m.selfLoopFullyFoldableOps,
      collapsibleBigOps: m.bigOps,
      selfLoopCollapsibleBigOps: m.selfLoopBigOps,
      barriers: m.barriers,
    }])),
    modules: Object.fromEntries(Object.entries(modAcc).map(([k, v]) =>
      [k, { ops: v.ops, hits: v.hits, share: totalOps ? v.ops / totalOps : 0 }])),
    apiThunkHits: thunkHits,
    apiThunkHitShare: (insideHits + outsideHits) ? thunkHits / (insideHits + outsideHits) : 0,
    unknownOutsideHits,
    x87: {
      ops: x87.ops, opsShare: totalOps ? x87.ops / totalOps : 0,
      members: x87.members, memberShare: totalOps ? x87.members / totalOps : 0,
      interleavedInt: x87.interleaved,
      runs: x87.runs, meanRun: x87.runs ? x87.members / x87.runs : 0,
      runP50: weightedPct(x87.samples, 0.5), runP90: weightedPct(x87.samples, 0.9),
      runMax: x87.maxRun,
      membersInRuns4Plus: x87.membersIn4Plus,
      shareOfX87MembersInRuns4Plus: x87.members ? x87.membersIn4Plus / x87.members : 0,
      stackSpanP50: weightedPct(x87.spanSamples, 0.5),
      stackSpanP90: weightedPct(x87.spanSamples, 0.9), stackSpanMax: x87.maxSpan,
      dispatchesRemoved: x87.members - x87.runs,
      dispatchesRemovedShare: totalOps ? (x87.members - x87.runs) / totalOps : 0,
      barriers: x87.barriers, instructionMix: x87.classOps,
      terminatorClasses: Object.fromEntries(Object.entries(x87.term).map(([k, v]) =>
        [k, { ops: v, share: x87.ops ? v / x87.ops : 0 }])),
      selfLoopTrips: x87.trips,
      top: x87Rows.slice(0, TOP).map(r => ({
        addr: r.addr, mod: r.mod, hits: r.hits, ops: r.ops,
        x87Ops: r.x87.x87Ops, members: r.x87.memberOps, longestRun: r.x87.longest,
        interleavedInt: r.x87.interleavedInt, x87Retired: r.x87Retired,
        terminator: r.term.cls, trip: r.term.trip,
      })),
    },
    top: rows.slice(0, TOP).map(r => ({
      addr: r.addr, mod: r.mod, hits: r.hits, ops: r.ops, foldable: r.foldable,
      longest: r.longest, liveOuts: r.liveOuts, loads: r.loads, stores: r.stores,
      retired: r.retired,
      terminator: r.term.cls, trip: r.term.trip,
      modes: Object.fromEntries(Object.entries(r.perMode).map(([k, v]) => [k, {
        foldable: v.foldable, runs: v.runs, longest: v.longest, fullyFoldable: v.fullyFoldable,
      }])),
      disasm: r.insns.map(i => ({ va: i.va, insn: i.insn, cls: i.cls, fold: i.kind === 'fold' })),
    })),
  }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
