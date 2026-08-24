#!/usr/bin/env node
// Static scanner for self-contained inner loops -- the shapes a loop-idiom
// superinstruction could collapse (see docs/loop-idiom-superops-design.md).
//
// Walks every code section linearly, finds short backward branches whose
// target is an instruction boundary inside the same sweep, and reports the
// loop body: its length, its mnemonic skeleton, and a coarse family guess.
//
// The family guess here is deliberately LOOSE -- it is a candidate finder.
// tools/match-loops.js applies the design's actual matcher to these bodies.
//
// A linear sweep misdecodes data embedded in code, so treat single hits as
// leads and repeated skeletons as signal. Nothing here is a proof that a loop
// is hot -- pair it with --handler-hist for that.
//
//   node tools/find-loops.js <pe> [--max-body=24] [--min-body=2]
//                                 [--family=lut,copy] [--skeletons=20]
//                                 [--json] [--quiet]
//
// Importable: require('./find-loops').findLoops(file, {minBody, maxBody})
const fs = require('fs');
const path = require('path');
const { readPE } = require(path.join(__dirname, '..', 'lib', 'pe.js'));
const { disasmAt } = require(path.join(__dirname, 'disasm.js'));

const JCC = /^(j[a-z]+|loop[a-z]*)\s/;

// One linear pass per code section -> [{va, len, insn, mnem}], plus a
// va -> index map so a branch target can be tested for instruction alignment.
function sweep(pe, sec) {
  const raw = pe.va2off(sec.va);
  if (raw < 0) return null;
  const size = Math.min(sec.rawSize || sec.size, (pe.buf.length - raw));
  // Average x86 instruction is >2.5 bytes; this bounds the sweep without
  // decoding past the section into whatever follows it.
  const maxIns = Math.ceil(size / 2.5);
  const lines = disasmAt(pe.buf, raw, sec.va, maxIns, null, { linear: true });
  const ins = [];
  const at = new Map();
  for (const ln of lines) {
    const m = /^([0-9a-f]{8})\s{2}((?:[0-9a-f]{2} )+)\s*(.*)$/.exec(ln);
    if (!m) continue;
    const va = parseInt(m[1], 16);
    const len = m[2].trim().split(' ').length;
    const insn = m[3].trim();
    if (va + len > sec.va + size) break;
    at.set(va, ins.length);
    ins.push({ va, len, insn, mnem: insn.split(/[\s,]/)[0] });
  }
  return { ins, at };
}

// Coarse family guess from the body. Deliberately loose: the point is to
// surface candidate shapes for the library, not to prove a lowering is legal.
// eax/ax/ah/al all name the same architectural register for aliasing purposes.
const FAMILIES_REG = { a: 'a', b: 'b', c: 'c', d: 'd', si: 'si', di: 'di', bp: 'bp', sp: 'sp' };
function family(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  let m = /^e?([abcd])[xhl]$/.exec(n);
  if (m) return FAMILIES_REG[m[1]];
  m = /^e?(si|di|bp|sp)$/.exec(n);
  return m ? FAMILIES_REG[m[1]] : null;
}

function classify(body) {
  const txt = body.map(b => b.insn);
  const mn = body.map(b => b.mnem);
  const isMem = s => /\[/.test(s);
  const loads = txt.filter(t => /^(mov|movzx|movsx)\s+[a-z0-9]+,\s*.*\[/.test(t));
  const stores = txt.filter(t => /^mov\s+.*\[[^\]]*\],/.test(t));
  const hasCall = mn.some(m => m === 'call');
  const hasRep = mn.some(m => m.startsWith('rep'));
  const cmps = txt.filter(t => /^(cmp|test)\s/.test(t));
  if (hasCall) return 'call';
  if (hasRep) return 'rep';
  // Arithmetic blend: 16bpp alpha/additive blends mask the low bits of each
  // channel with a wide immediate (0xf7de, 0x7bef, 0xf81f...), shift, then add
  // or or the halves back together. 8bpp blends go through a table instead and
  // land in 'lut' below, which is the point of keeping the two separate.
  if (loads.length >= 1 && stores.length >= 1) {
    const masks = txt.filter(t => /^and\s+[a-z0-9]+,\s*0x[0-9a-f]{3,}/.test(t));
    const shifts = mn.filter(m => m === 'shr' || m === 'shl' || m === 'sar');
    const mixes = mn.filter(m => m === 'add' || m === 'or' || m === 'adc' || m === 'sub' || m === 'xor');
    if (masks.length >= 1 && shifts.length >= 1 && mixes.length >= 1) return 'blend';
  }
  // dst[i] = tbl[src[i]]: a load whose result register feeds the base or index
  // of a second load, then a store. The byte load is usually into `al` and the
  // second load addresses `eax`, so compare register *families*, not names.
  if (loads.length >= 2 && stores.length >= 1) {
    const firstDst = /^(?:mov|movzx|movsx)\s+([a-z0-9]+),/.exec(loads[0]);
    if (firstDst) {
      const fam = family(firstDst[1]);
      if (fam && loads.slice(1).some(l => {
        const mem = /\[([^\]]*)\]/.exec(l);
        return mem && mem[1].split(/[^a-z0-9]+/).some(w => family(w) === fam);
      })) return 'lut';
    }
    return 'load2-store';
  }
  if (loads.length === 1 && stores.length === 1) return 'copy';
  if (loads.length === 0 && stores.length >= 1) return 'fill';
  if (loads.length >= 1 && stores.length === 0 && cmps.length >= 1) return 'scan';
  if (loads.length >= 1 && stores.length === 0) return 'reduce';
  if (!isMem(txt.join(' '))) return 'regonly';
  return 'other';
}

// Skeleton: mnemonics plus operand *shape* (r=reg, m=mem, i=imm), so two loops
// over different registers collapse to the same string.
function skeleton(body) {
  return body.map(b => {
    const ops = b.insn.slice(b.mnem.length).trim();
    if (!ops) return b.mnem;
    const shape = ops.split(',').map(o => /\[/.test(o) ? 'm' : /^\s*(0x)?[0-9]/.test(o) ? 'i' : 'r').join(',');
    return b.mnem + ' ' + shape;
  }).join('; ');
}

function findLoops(file, opts = {}) {
  const MINB = opts.minBody === undefined ? 2 : opts.minBody;
  const MAXB = opts.maxBody === undefined ? 24 : opts.maxBody;
  const pe = readPE(file);
  const found = [];
  for (const sec of pe.sections) {
    if (!sec.isCode) continue;
    const sw = sweep(pe, sec);
    if (!sw) continue;
    for (let i = 0; i < sw.ins.length; i++) {
      const cur = sw.ins[i];
      if (!JCC.test(cur.insn)) continue;
      const t = /0x([0-9a-f]+)\s*$/.exec(cur.insn);
      if (!t) continue;
      const target = parseInt(t[1], 16);
      if (target >= cur.va) continue;
      const ti = sw.at.get(target);
      if (ti === undefined) continue;
      const n = i - ti + 1;
      if (n < MINB || n > MAXB) continue;
      const body = sw.ins.slice(ti, i + 1);
      found.push({
        va: target, n, section: sec.name,
        family: classify(body), skeleton: skeleton(body),
        body: body.map(b => b.insn),
      });
    }
  }
  return found;
}

module.exports = { findLoops, family, classify, skeleton };

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const opt = (n, d) => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
  const has = n => args.includes('--' + n);
  if (!file) { console.error('usage: find-loops.js <pe> [--max-body=N] [--min-body=N] [--family=a,b] [--skeletons=N] [--json] [--quiet]'); process.exit(1); }

  const MAXB = parseInt(opt('max-body', '24'), 10);
  const MINB = parseInt(opt('min-body', '2'), 10);
  const NSKEL = parseInt(opt('skeletons', '20'), 10);
  const FAMILIES = opt('family', '') ? opt('family', '').split(',') : null;

  const found = findLoops(file, { minBody: MINB, maxBody: MAXB });
  const kept = FAMILIES ? found.filter(f => FAMILIES.includes(f.family)) : found;
  if (has('json')) { console.log(JSON.stringify({ file, loops: kept }, null, 1)); process.exit(0); }

  const fam = new Map();
  for (const f of found) fam.set(f.family, (fam.get(f.family) || 0) + 1);
  console.log(`${path.basename(file)}: ${found.length} self-loops (body ${MINB}..${MAXB} instrs)`);
  console.log('  by family: ' + [...fam].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));

  const sk = new Map();
  for (const f of kept) {
    const k = f.family + ' | ' + f.skeleton;
    if (!sk.has(k)) sk.set(k, { n: 0, vas: [] });
    const e = sk.get(k); e.n++; if (e.vas.length < 4) e.vas.push('0x' + f.va.toString(16));
  }
  const top = [...sk].sort((a, b) => b[1].n - a[1].n).slice(0, NSKEL);
  if (!has('quiet')) {
    console.log(`  top ${top.length} skeletons:`);
    for (const [k, e] of top) console.log(`   ${String(e.n).padStart(4)}x  ${k}\n          at ${e.vas.join(' ')}`);
  }
}
