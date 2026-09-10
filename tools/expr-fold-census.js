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

// Classify one decoded instruction.
// Returns { kind, class, writes:[reg32], loads, stores, terminator:bool }
// kind: 'fold' | 'barrier' | 'terminator'
function classify(insn) {
  const { seg, mn, ops } = splitInsn(insn);
  const list = operands(ops);
  const res = {
    mn, ops, seg, kind: 'barrier', cls: 'other',
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
  if (/\b(mm[0-7]|xmm[0-7])\b/.test(ops) || /^(p[a-z]+|movq|movd|emms|movaps|movups|movss|movlps|movhps|cvt|add[ps]s|mul[ps]s)$/.test(mn)) {
    res.cls = 'fpu/simd';
    return res;
  }

  // --- flag consumers / producers we cannot reproduce ---------------------
  if (mn === 'adc' || mn === 'sbb') { res.cls = 'adc/sbb'; return res; }
  if (FLAG_CONSUMERS.test(mn) || /^set/.test(mn) || /^cmov/.test(mn)) { res.cls = 'flags'; return res; }
  if (mn === 'rcl' || mn === 'rcr') { res.cls = 'flags'; return res; }

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
    return res;
  }

  // --- inc/dec: full-width but flag-writing; fold-safe shape, but they are
  // partial flag updates (CF preserved), which an expression tree cannot
  // reproduce without modelling CF. Count separately as 'other'.
  if (mn === 'inc' || mn === 'dec') {
    res.cls = 'other';
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
    insns.push({ va, insn, len, ...c });
    if (c.terminator) break;
  }
  // No terminator inside MAX_OPS: the block is longer than the window, so its
  // op count is a floor, not the truth. Flagged so the report can say so.
  insns.truncated = !insns[insns.length - 1].terminator;
  return insns;
}

// ------------------------------------------------------------------ analysis
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

// ------------------------------------------------------------------- main
const dumpText = fs.readFileSync(DUMP, 'utf8');
const blocks = [];
for (const line of dumpText.split('\n')) {
  const m = /^\s*(0x[0-9a-fA-F]+)\s+(\d+)/.exec(line);
  if (!m) continue;
  blocks.push({ addr: Number(m[1]), hits: Number(m[2]) });
}

let outsideHits = 0, insideHits = 0, undecodableHits = 0, truncatedHits = 0;
let totalOps = 0, totalFold = 0, foldIn4Plus = 0, opsIn4Plus = 0, totalRuns = 0;
const barrierOps = {};      // class -> retired barrier instructions
const runSamples = [];      // {longest, weight}
const rows = [];

for (const b of blocks) {
  const mod = moduleFor(b.addr);
  if (!mod) { outsideHits += b.hits; continue; }
  insideHits += b.hits;
  const insns = decodeBlock(mod, b.addr);
  if (!insns) { undecodableHits += b.hits; continue; }
  if (insns.truncated) truncatedHits += b.hits;
  const a = analyzeBlock(insns);
  const retired = a.ops * b.hits;
  totalOps += retired;
  totalFold += a.foldable * b.hits;
  totalRuns += a.runs * b.hits;
  if (a.foldable >= 4) { foldIn4Plus += a.foldable * b.hits; opsIn4Plus += retired; }
  for (const [k, v] of Object.entries(a.barriers)) barrierOps[k] = (barrierOps[k] || 0) + v * b.hits;
  runSamples.push({ longest: a.longest, longestNA: a.longestNA, w: retired });
  rows.push({ addr: b.addr, hits: b.hits, mod: mod.name, retired, insns, ...a });
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
out.push('');
out.push(`top ${TOP} blocks by hits*ops:`);
out.push('  addr        module          hits        ops  fold  run  liveout  ld  st   retired');
for (const r of rows.slice(0, TOP)) {
  out.push(`  0x${r.addr.toString(16).padStart(8, '0')}  ${r.mod.padEnd(14)} ${String(r.hits).padStart(9)}  ${String(r.ops).padStart(4)}  ${String(r.foldable).padStart(4)}  ${String(r.longest).padStart(3)}  ${String(r.liveOuts).padStart(7)}  ${String(r.loads).padStart(2)}  ${String(r.stores).padStart(2)}  ${String(r.retired).padStart(9)}`);
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
    top: rows.slice(0, TOP).map(r => ({
      addr: r.addr, mod: r.mod, hits: r.hits, ops: r.ops, foldable: r.foldable,
      longest: r.longest, liveOuts: r.liveOuts, loads: r.loads, stores: r.stores,
      retired: r.retired,
      disasm: r.insns.map(i => ({ va: i.va, insn: i.insn, cls: i.cls, fold: i.kind === 'fold' })),
    })),
  }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
