#!/usr/bin/env node
// Runs the loop-idiom matcher from docs/loop-idiom-superops-design.md over a
// PE, statically, and reports how many loops it would actually lower.
//
// tools/find-loops.js is a candidate FINDER: its family guess is a loose regex
// ("two loads and a store" => lut), so it counts stack-counter loops as
// blitters. This tool implements the design's real matcher instead:
//
//     body -> ROLES -> SUMMARY (induction vars, streams, side effects)
//          -> PREDICATES (COPY_RUN / FILL_RUN / LUT_RUN / SCAN_RUN)
//
// so the "how many loops do we match" number comes from the predicate that
// would be implemented in WAT, and every rejection is attributed to a reason.
//
// Fidelity note: the real matcher runs on EMITTED THREADED OPS, which are more
// canonical than disassembly (ModRM/SIB already resolved, one handler per
// operation shape). This static approximation should therefore be a LOWER
// bound on the match rate, not an upper one.
//
//   node tools/match-loops.js <pe> [<pe>...] [--max-body=24] [--list]
//                                  [--list=COPY_RUN] [--why] [--json]
const path = require('path');
const { findLoops } = require(path.join(__dirname, 'find-loops.js'));

// ---------------------------------------------------------------- operands --
const SIZE_KW = { byte: 1, word: 2, dword: 4, qword: 8, ptr: 0, short: 0, near: 0, far: 0 };
const REG_SIZE = { al: 1, bl: 1, cl: 1, dl: 1, ah: 1, bh: 1, ch: 1, dh: 1, ax: 2, bx: 2, cx: 2, dx: 2, si: 2, di: 2, bp: 2, sp: 2 };
const REGS = new Set(['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp',
  'ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp',
  'al', 'bl', 'cl', 'dl', 'ah', 'bh', 'ch', 'dh']);

// eax/ax/ah/al all name one architectural register for dependency purposes.
function reg(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  let m = /^e?([abcd])[xhl]$/.exec(n);
  if (m) return m[1];
  m = /^e?(si|di|bp|sp)$/.exec(n);
  return m ? m[1] : null;
}
function regSize(n) { return REG_SIZE[n.toLowerCase()] || 4; }

// "dword [0x514348+eax*4]" -> {kind:'mem', size:4, base, index, scale, disp}
// "byte [esi]"             -> {kind:'mem', size:1, base:'si', ...}
// "0x3"                    -> {kind:'imm', v:3}
// "al"                     -> {kind:'reg', r:'a', size:1}
function parseOperand(s) {
  let t = s.trim().toLowerCase();
  let size = 0;
  for (;;) {
    const m = /^([a-z]+)\s+/.exec(t);
    if (!m || !(m[1] in SIZE_KW)) break;
    size = SIZE_KW[m[1]] || size;
    t = t.slice(m[0].length);
  }
  const mem = /^\[([^\]]*)\]$/.exec(t);
  if (mem) {
    const o = { kind: 'mem', size, base: null, index: null, scale: 1, disp: 0, raw: mem[1] };
    for (const term of mem[1].replace(/-/g, '+-').split('+')) {
      const w = term.trim();
      if (!w) continue;
      const sc = /^(-?)([a-z]+)\*([0-9]+)$/.exec(w);
      if (sc) { o.index = reg(sc[2]); o.scale = parseInt(sc[3], 10); continue; }
      if (REGS.has(w.replace(/^-/, ''))) {
        const r = reg(w.replace(/^-/, ''));
        if (!o.base) o.base = r; else if (!o.index) o.index = r; else o.tooMany = true;
        continue;
      }
      const n = /^(-?)(0x[0-9a-f]+|[0-9]+)$/.exec(w);
      if (n) { o.disp += (n[1] ? -1 : 1) * parseInt(n[2], 16 === 16 && n[2].startsWith('0x') ? 16 : 10); continue; }
      o.unknown = true;
    }
    return o;
  }
  if (REGS.has(t)) return { kind: 'reg', r: reg(t), size: regSize(t), name: t };
  const n = /^(0x[0-9a-f]+|[0-9]+)$/.exec(t);
  if (n) return { kind: 'imm', v: parseInt(n[1], n[1].startsWith('0x') ? 16 : 10) };
  return { kind: 'other', raw: t };
}

function split2(ops) {
  // operands are comma-separated and no operand we care about contains a comma
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of ops) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(parseOperand);
}

// ------------------------------------------------------------------- roles --
// LOAD/STORE/ADDI/CMP/BRANCH/MOVE are the vocabulary the summary is built on;
// anything else is OTHER and makes the loop undecidable, exactly as the WAT
// matcher's decline list says it must.
function role(insn) {
  const mnem = insn.split(/[\s,]/)[0];
  const ops = insn.slice(mnem.length).trim();
  const o = ops ? split2(ops) : [];
  const R = { mnem, insn, ops: o };
  if (mnem === 'nop') return { ...R, kind: 'NOP' };
  if (mnem === 'call') return { ...R, kind: 'CALL' };
  if (/^(j[a-z]+|loop[a-z]*)$/.test(mnem)) return { ...R, kind: 'BRANCH' };
  if (mnem === 'cmp' || mnem === 'test') return { ...R, kind: 'CMP' };
  // `xor r,r` / `sub r,r` is the compiler's zeroing idiom, not arithmetic. It
  // is the single most common op in real blitter loops (111 declines in Heroes
  // II alone) and treating it as OTHER makes the matcher useless in practice.
  if ((mnem === 'xor' || mnem === 'sub') && o.length === 2
      && o[0].kind === 'reg' && o[1].kind === 'reg' && o[0].r === o[1].r) {
    return { ...R, kind: 'MOVE', dst: o[0], src: { kind: 'imm', v: 0 } };
  }
  if (mnem === 'mov' || mnem === 'movzx' || mnem === 'movsx') {
    if (o.length !== 2) return { ...R, kind: 'OTHER' };
    if (o[0].kind === 'reg' && o[1].kind === 'mem') {
      return { ...R, kind: 'LOAD', dst: o[0], mem: o[1], size: o[1].size || o[0].size };
    }
    if (o[0].kind === 'mem' && (o[1].kind === 'reg' || o[1].kind === 'imm')) {
      return { ...R, kind: 'STORE', src: o[1], mem: o[0], size: o[0].size || (o[1].size || 4) };
    }
    if (o[0].kind === 'reg' && (o[1].kind === 'reg' || o[1].kind === 'imm')) {
      return { ...R, kind: 'MOVE', dst: o[0], src: o[1] };
    }
    return { ...R, kind: 'OTHER' };
  }
  if ((mnem === 'inc' || mnem === 'dec') && o.length === 1) {
    if (o[0].kind === 'reg') return { ...R, kind: 'ADDI', dst: o[0], k: mnem === 'inc' ? 1 : -1 };
    return { ...R, kind: 'MEMADDI', mem: o[0] };
  }
  if ((mnem === 'add' || mnem === 'sub') && o.length === 2 && o[0].kind === 'reg' && o[1].kind === 'imm') {
    return { ...R, kind: 'ADDI', dst: o[0], k: mnem === 'add' ? o[1].v : -o[1].v };
  }
  if (mnem === 'lea' && o.length === 2 && o[0].kind === 'reg' && o[1].kind === 'mem'
      && o[1].base === o[0].r && !o[1].index) {
    return { ...R, kind: 'ADDI', dst: o[0], k: o[1].disp };
  }
  return { ...R, kind: 'OTHER' };
}

// ----------------------------------------------------------------- summary --
function summarize(body) {
  const roles = body.map(role).filter(r => r.kind !== 'NOP');
  const writes = new Map();                       // reg -> [role kinds]
  const push = (r, k) => { if (r) writes.set(r, (writes.get(r) || []).concat(k)); };
  for (const r of roles) {
    if (r.kind === 'LOAD') push(r.dst.r, 'LOAD');
    else if (r.kind === 'MOVE') push(r.dst.r, 'MOVE');
    else if (r.kind === 'ADDI') push(r.dst.r, 'ADDI');
    else if (r.kind === 'OTHER' || r.kind === 'CALL') {
      // conservatively: an unknown op may write anything it names
      for (const o of r.ops) if (o.kind === 'reg') push(o.r, 'OTHER');
    }
  }
  // Induction variable: written only by ADDI, by a constant, exactly once.
  const iv = new Map();
  for (const [r, kinds] of writes) {
    if (kinds.length === 1 && kinds[0] === 'ADDI') {
      const a = roles.find(x => x.kind === 'ADDI' && x.dst.r === r);
      if (a && Number.isFinite(a.k)) iv.set(r, a.k);
    }
  }
  const invariant = r => r && !writes.has(r);
  // A memory op is a STREAM when its address moves with an induction variable.
  const stream = m => {
    if (!m || m.unknown || m.tooMany) return null;
    if (iv.has(m.base) && (m.index === null || invariant(m.index))) return { iv: m.base, stride: iv.get(m.base) };
    if (iv.has(m.index) && (m.base === null || invariant(m.base))) return { iv: m.index, stride: iv.get(m.index) * m.scale };
    return null;
  };
  const loads = roles.filter(r => r.kind === 'LOAD');
  const stores = roles.filter(r => r.kind === 'STORE');
  // A "mirror" store keeps a fixed memory cell in sync with a register the
  // loop is updating -- register-pressure spill, or a global the code outside
  // the loop reads afterwards. The address is loop-invariant and nothing in
  // the body loads from it, so a lowering can write the final value once in
  // the epilogue. Real blitters are full of these and they are not streams.
  const invariantAddr = m => m && !m.unknown && !m.tooMany
    && (m.base === null || invariant(m.base)) && (m.index === null || invariant(m.index));
  const loadedAddrs = new Set(loads.map(l => l.mem.raw));
  const mirrors = stores.filter(st => invariantAddr(st.mem) && !loadedAddrs.has(st.mem.raw));
  const realStores = stores.filter(st => !mirrors.includes(st));
  return { roles, writes, iv, invariant, stream, loads, stores, mirrors, realStores,
    others: roles.filter(r => r.kind === 'OTHER'),
    calls: roles.filter(r => r.kind === 'CALL'),
    memAddi: roles.filter(r => r.kind === 'MEMADDI'),
    branch: roles.filter(r => r.kind === 'BRANCH') };
}

// -------------------------------------------------------------- predicates --
// Returns {pattern, stride} or {reject: reason}.
function match(body) {
  const s = summarize(body);
  if (s.calls.length) return { reject: 'call' };
  if (s.others.length) return { reject: 'unknown-op:' + s.others[0].mnem };
  if (s.branch.length > 1) return { reject: 'multi-branch' };
  if (s.memAddi.length) return { reject: 'memory-counter' };   // `inc [ebp-0x10]`
  if (s.iv.size === 0) return { reject: 'no-induction-var' };
  const nMem = s.loads.length + s.realStores.length;
  if (nMem === 0) return { reject: 'no-memory-op' };
  if (nMem > 3) return { reject: 'too-many-mem-ops' };

  const ls = s.loads.map(l => ({ r: l, st: s.stream(l.mem) }));
  const ss = s.realStores.map(l => ({ r: l, st: s.stream(l.mem) }));
  if (ss.some(x => !x.st)) return { reject: 'non-streamed-store' };
  // Every load must move with an induction variable, with ONE exception: a
  // table load addressed by another load's result. That is the LUT shape, and
  // exempting it here is what lets LUT_RUN exist at all.
  const badLoads = ls.filter(x => !x.st);
  if (badLoads.length > 1) return { reject: 'non-streamed-load' };
  if (badLoads.length === 1) {
    const tbl = badLoads[0].r;
    const fedBy = ls.find(x => x.st && (tbl.mem.base === x.r.dst.r || tbl.mem.index === x.r.dst.r));
    if (!fedBy) return { reject: 'non-streamed-load' };
  }

  // SCAN_RUN: one moving load, no stores, terminator inspects the loaded value.
  if (s.loads.length >= 1 && s.realStores.length === 0) {
    const cmp = s.roles.find(r => r.kind === 'CMP');
    if (!cmp) return { reject: 'scan-without-compare' };
    const touchesLoad = cmp.ops.some(o => o.kind === 'reg' && s.loads.some(l => l.dst.r === o.r));
    if (!touchesLoad) return { reject: 'reduce-not-scan' };
    return { pattern: 'SCAN_RUN', size: s.loads[0].size || 1, stride: ls[0].st.stride };
  }
  if (s.realStores.length !== 1) return { reject: 'multi-store' };
  const st = ss[0];

  // FILL_RUN: no load; stored value is an immediate or a loop-invariant reg.
  if (s.loads.length === 0) {
    const src = st.r.src;
    if (src.kind === 'imm' || (src.kind === 'reg' && s.invariant(src.r))) {
      return { pattern: 'FILL_RUN', size: st.r.size || 4, stride: st.st.stride };
    }
    return { reject: 'fill-src-varies' };
  }

  // COPY_RUN: one load feeds the store, same width, same stride.
  if (s.loads.length === 1) {
    const ld = ls[0];
    if (st.r.src.kind !== 'reg' || st.r.src.r !== ld.r.dst.r) return { reject: 'store-src-not-load' };
    if ((ld.r.size || 0) !== (st.r.size || 0)) return { reject: 'width-mismatch' };
    if (ld.st.stride !== st.st.stride) return { reject: 'stride-mismatch' };
    return { pattern: 'COPY_RUN', size: ld.r.size, stride: ld.st.stride };
  }

  // LUT_RUN: load1 -> index of load2 -> store.
  if (s.loads.length === 2) {
    const [a, b] = ls;
    const feeds = (x, y) => y.r.mem.base === x.r.dst.r || y.r.mem.index === x.r.dst.r;
    const pair = feeds(a, b) ? [a, b] : feeds(b, a) ? [b, a] : null;
    if (!pair) return { reject: 'two-loads-independent' };
    if (st.r.src.kind !== 'reg' || st.r.src.r !== pair[1].r.dst.r) return { reject: 'store-src-not-lut' };
    // the table load is indexed, not streamed -- re-check: only the first
    // load and the store need to move with an induction variable.
    return { pattern: 'LUT_RUN', size: st.r.size || 1, stride: st.st.stride };
  }
  return { reject: 'unclassified' };
}

module.exports = { match, summarize, role, parseOperand };

// ------------------------------------------------------------------- main --
if (require.main === module) {
  const args = process.argv.slice(2);
  const files = args.filter(a => !a.startsWith('--'));
  const opt = (n, d) => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
  const has = n => args.some(a => a === '--' + n || a.startsWith('--' + n + '='));
  if (!files.length) { console.error('usage: match-loops.js <pe> [<pe>...] [--max-body=N] [--list[=PATTERN]] [--why] [--json]'); process.exit(1); }
  const MAXB = parseInt(opt('max-body', '24'), 10);
  const LIST = has('list') ? (opt('list', '') || '*') : null;

  const PATTERNS = ['COPY_RUN', 'FILL_RUN', 'LUT_RUN', 'SCAN_RUN'];
  const rows = [];
  const whyAll = new Map();
  for (const f of files) {
    let loops;
    try { loops = findLoops(f, { maxBody: MAXB }); }
    catch (e) { console.error(`${path.basename(f)}: ${e.message}`); continue; }
    const row = { file: f, total: loops.length, matched: 0, unit: 0 };
    for (const p of PATTERNS) row[p] = 0;
    for (const lp of loops) {
      const m = match(lp.body);
      if (m.reject) { whyAll.set(m.reject, (whyAll.get(m.reject) || 0) + 1); continue; }
      row[m.pattern]++; row.matched++;
      if (Math.abs(m.stride) === m.size) row.unit++;
      if (LIST && (LIST === '*' || LIST === m.pattern)) {
        console.log(`${path.basename(f)} 0x${lp.va.toString(16)}  ${m.pattern} size=${m.size} stride=${m.stride}`);
        for (const b of lp.body) console.log('    ' + b);
      }
    }
    rows.push(row);
  }
  if (has('json')) { console.log(JSON.stringify({ rows, why: [...whyAll].sort((a, b) => b[1] - a[1]) }, null, 1)); process.exit(0); }

  const w = Math.max(12, ...rows.map(r => path.basename(r.file).length));
  console.log('app'.padEnd(w) + '  loops   COPY   FILL    LUT   SCAN  matched  unit-stride');
  console.log('-'.repeat(w + 58));
  const tot = { total: 0, matched: 0, unit: 0, COPY_RUN: 0, FILL_RUN: 0, LUT_RUN: 0, SCAN_RUN: 0 };
  for (const r of rows.sort((a, b) => b.matched - a.matched)) {
    for (const k in tot) tot[k] += r[k];
    const pct = r.total ? ` ${(100 * r.matched / r.total).toFixed(1)}%` : '';
    console.log(path.basename(r.file).padEnd(w)
      + String(r.total).padStart(7) + String(r.COPY_RUN).padStart(7)
      + String(r.FILL_RUN).padStart(7) + String(r.LUT_RUN).padStart(7)
      + String(r.SCAN_RUN).padStart(7) + String(r.matched).padStart(9)
      + pct.padStart(7) + String(r.unit).padStart(8));
  }
  if (rows.length > 1) {
    console.log('-'.repeat(w + 58));
    console.log('TOTAL'.padEnd(w) + String(tot.total).padStart(7) + String(tot.COPY_RUN).padStart(7)
      + String(tot.FILL_RUN).padStart(7) + String(tot.LUT_RUN).padStart(7)
      + String(tot.SCAN_RUN).padStart(7) + String(tot.matched).padStart(9)
      + ` ${(100 * tot.matched / Math.max(1, tot.total)).toFixed(1)}%`.padStart(7) + String(tot.unit).padStart(8));
  }
  if (has('why')) {
    console.log('\ndeclines:');
    for (const [k, v] of [...whyAll].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${String(v).padStart(6)}  ${k}`);
    }
  }
}
