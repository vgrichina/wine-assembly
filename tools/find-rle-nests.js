#!/usr/bin/env node
// Census of RLE sprite-blit loop NESTS in a PE.
//
//   node tools/find-rle-nests.js <pe> [<pe>...] [--min-cases=4] [--detail] [--json]
//
// The shape, as Caesar III writes it at 0x40f715:
//
//   head:  cmp counter, 0 / jle exit
//          mov al, [src]
//          cmp al, imm8 / jz caseA          <- the ladder $th_case_chain folds
//          cmp al, imm8 / jz caseB
//          ...
//   caseK: mov r32,[src+d] / mov [dst+d],r32   (k times, branch-free)
//          add src,imm / add dst,imm / sub counter,imm
//          jmp head
//
// That is a run-length blit: a token byte selects a fixed-width literal copy,
// and one token (Caesar's 0xff) is a transparent skip that only advances the
// destination. It is the standard 90s sprite encoding, so the question this
// tool answers is whether a fold for it would be reusable or Caesar-specific.
//
// Why not match-loops.js: that applies the Design-A matcher, which classifies
// a single self-loop BLOCK. This is a nest of ~20 blocks reached through a
// jump ladder and is invisible to it by construction.
//
// The body decoder below is deliberately a small subset (the instructions
// these bodies are actually built from). An unknown opcode rejects the body
// rather than guessing, so this under-reports and never over-reports.

const fs = require('fs');
const path = require('path');
const { readPE } = require(path.join(__dirname, '..', 'lib', 'pe.js'));

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
const flag = (n, d) => {
  const a = args.find(x => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};
const MIN_CASES = parseInt(flag('min-cases', '4'), 10);
const DETAIL = args.includes('--detail');
const JSON_OUT = args.includes('--json');

// ---- minimal length decoder for the instruction subset the bodies use ----
function modrmLen(buf, p) {
  const b = buf[p], mod = b >> 6, rm = b & 7;
  let len = 1;
  if (mod !== 3 && rm === 4) {
    const base = buf[p + 1] & 7;
    len += 1;
    if (mod === 0 && base === 5) len += 4;
  }
  if (mod === 0 && rm === 5) len += 4;
  else if (mod === 1) len += 1;
  else if (mod === 2) len += 4;
  return len;
}
function modrm(buf, p) {
  const b = buf[p], mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
  return { mod, reg, rm, len: modrmLen(buf, p) };
}

// Returns {len, kind, ...} or null when the opcode is outside the subset.
// kinds: load (reg <- mem), store (mem <- reg), alu_ri (reg op= imm),
//        alu_rr (reg op= reg), jmp (target), branch (ends body, not foldable)
function decodeOne(buf, p, va) {
  let op = buf[p], len = 1, o16 = false;
  if (op === 0x66) { o16 = true; op = buf[++p]; len = 2; p--; len = 1; p++; }
  const start = p;
  const at = q => buf[q];
  const rel8 = q => (buf[q] << 24) >> 24;
  const rel32 = q => buf.readInt32LE(q);
  const pre = o16 ? 1 : 0;
  switch (op) {
    case 0x8b: { const m = modrm(buf, p + 1); if (m.mod === 3) return { len: pre + 1 + m.len, kind: 'alu_rr' };
      return { len: pre + 1 + m.len, kind: 'load', reg: m.reg, base: m.rm, mod: m.mod, wide: !o16 }; }
    case 0x89: { const m = modrm(buf, p + 1); if (m.mod === 3) return { len: pre + 1 + m.len, kind: 'alu_rr' };
      return { len: pre + 1 + m.len, kind: 'store', reg: m.reg, base: m.rm, mod: m.mod, wide: !o16 }; }
    case 0x8a: case 0x88: { const m = modrm(buf, p + 1);
      return { len: pre + 1 + m.len, kind: m.mod === 3 ? 'alu_rr' : (op === 0x8a ? 'load8' : 'store8') }; }
    case 0x01: case 0x03: case 0x29: case 0x2b: case 0x31: case 0x33:
    case 0x21: case 0x23: case 0x09: case 0x0b: case 0x39: case 0x3b: {
      const m = modrm(buf, p + 1); return { len: pre + 1 + m.len, kind: 'alu_rr' }; }
    case 0x83: { const m = modrm(buf, p + 1); return { len: pre + 1 + m.len + 1, kind: 'alu_ri' }; }
    case 0x81: { const m = modrm(buf, p + 1); return { len: pre + 1 + m.len + (o16 ? 2 : 4), kind: 'alu_ri' }; }
    case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47:
    case 0x48: case 0x49: case 0x4a: case 0x4b: case 0x4c: case 0x4d: case 0x4e: case 0x4f:
      return { len: pre + 1, kind: 'alu_ri' };                       // inc/dec r32
    case 0xc1: { const m = modrm(buf, p + 1); return { len: pre + 1 + m.len + 1, kind: 'alu_ri' }; }
    case 0xeb: return { len: pre + 2, kind: 'jmp', target: va + pre + 2 + rel8(p + 1) };
    case 0xe9: return { len: pre + 5, kind: 'jmp', target: va + pre + 5 + rel32(p + 1) };
    case 0x0f: {
      const o2 = at(p + 1);
      if (o2 >= 0x80 && o2 <= 0x8f) return { len: pre + 6, kind: 'branch' };
      if (o2 === 0xb6 || o2 === 0xb7 || o2 === 0xbe || o2 === 0xbf) {
        const m = modrm(buf, p + 2); return { len: pre + 2 + m.len, kind: m.mod === 3 ? 'alu_rr' : 'load8' }; }
      return null; }
    default:
      if (op >= 0x70 && op <= 0x7f) return { len: pre + 2, kind: 'branch' };
      if (op === 0xc3 || op === 0xc2) return { len: pre + 1, kind: 'branch' };
      return null;
  }
}

// A ladder of `cmp r8,imm8 / jz target` pairs starting at file offset p.
// Both jz encodings, exactly as $case_chain_count accepts them.
function ladderAt(buf, p, va, end) {
  const cases = [];
  let o = p, v = va;
  while (o + 4 <= end) {
    let cmpLen;
    if (buf[o] === 0x3c) cmpLen = 2;                                   // cmp al,imm8
    else if (buf[o] === 0x80 && (buf[o + 1] >> 6) === 3 && ((buf[o + 1] >> 3) & 7) === 7) cmpLen = 3;
    else break;
    const j = o + cmpLen;
    let target, jLen;
    if (buf[j] === 0x74) { jLen = 2; target = v + cmpLen + 2 + ((buf[j + 1] << 24) >> 24); }
    else if (buf[j] === 0x0f && buf[j + 1] === 0x84) { jLen = 6; target = v + cmpLen + 6 + buf.readInt32LE(j + 2); }
    else break;
    cases.push({ imm: buf[o + cmpLen - 1], target });
    o += cmpLen + jLen; v += cmpLen + jLen;
  }
  return { cases, endOff: o, endVa: v };
}

// Walk a case body straight-line. Returns null if it leaves the subset.
function classifyBody(pe, va, budget = 48) {
  const info = pe.va2offInfo ? pe.va2offInfo(va) : null;
  let off = pe.va2off(va);
  if (off < 0 || (info && info.hasRaw === false)) return null;
  let pairs = 0, load8 = 0, aluRi = 0, aluRr = 0, n = 0, lastLoad = null;
  while (n++ < budget) {
    const d = decodeOne(pe.buf, off, va);
    if (!d) return null;
    if (d.kind === 'branch') return null;                 // a branch inside the body
    if (d.kind === 'jmp') return { pairs, load8, aluRi, aluRr, back: d.target };
    if (d.kind === 'load') lastLoad = d;
    else if (d.kind === 'store') {
      // A copy moves between two different places. `mov eax,[esp+0x38] / inc /
      // mov [esp+0x38],eax` is a read-modify-write of one variable -- that is
      // how donuts.exe's whitespace-skipping parser read as a sprite blit.
      if (lastLoad && lastLoad.reg === d.reg
          && !(lastLoad.base === d.base && lastLoad.mod === d.mod)) { pairs++; }
      lastLoad = null;
    }
    else if (d.kind === 'load8' || d.kind === 'store8') load8++;
    else if (d.kind === 'alu_ri') aluRi++;
    else if (d.kind === 'alu_rr') aluRr++;
    off += d.len; va += d.len;
  }
  return null;
}

function scan(file) {
  const pe = readPE(file);
  const nests = [];
  for (const s of pe.sections) {
    if (!s.isCode || !s.rawSize) continue;
    const start = s.rawOff, end = Math.min(s.rawOff + s.rawSize, pe.buf.length);
    for (let off = start; off + 8 < end; off++) {
      if (pe.buf[off] !== 0x3c && pe.buf[off] !== 0x80) continue;
      const va = pe.off2va(off);
      const L = ladderAt(pe.buf, off, va, end);
      if (L.cases.length < MIN_CASES) continue;
      // Classify every target; count copy bodies and where they jump back.
      const backs = new Map();
      let copyBodies = 0, skipBodies = 0, widths = [];
      for (const c of L.cases) {
        const b = classifyBody(pe, c.target);
        if (!b || b.back === undefined) continue;
        if (b.pairs > 0) { copyBodies++; widths.push(b.pairs); }
        else if (b.load8 > 0 && b.aluRr >= 2) skipBodies++;   // n = [src+1]; dst += 2n
        else continue;
        backs.set(b.back, (backs.get(b.back) || 0) + 1);
      }
      if (copyBodies < 3) { off = L.endOff - 1; continue; }
      // The point of a run-length ladder is that the cases copy runs of
      // *different* lengths. All-equal widths is an ordinary switch whose arms
      // happen to move a dword.
      if (new Set(widths).size < 2) { off = L.endOff - 1; continue; }
      // The bodies must converge on one head, and it must be behind them.
      let head = 0, headN = 0;
      for (const [t, n] of backs) if (n > headN) { head = t; headN = n; }
      if (headN < 3 || head >= L.cases[0].target) { off = L.endOff - 1; continue; }
      nests.push({
        ladderVa: va, head, cases: L.cases.length, copyBodies, skipBodies,
        minWidth: Math.min(...widths), maxWidth: Math.max(...widths),
        converge: headN,
      });
      off = L.endOff - 1;
    }
  }
  return nests;
}

const all = [];
for (const f of files) {
  let nests;
  try { nests = scan(f); } catch (e) { if (!JSON_OUT) console.log(`${path.basename(f)}: ERROR ${e.message}`); continue; }
  all.push({ file: f, nests });
  if (JSON_OUT) continue;
  if (!nests.length) { if (files.length === 1) console.log(`${path.basename(f)}: no RLE nests`); continue; }
  console.log(`${path.basename(f)}: ${nests.length} RLE nest(s)`);
  if (DETAIL || files.length === 1) {
    for (const n of nests) {
      console.log(`   head 0x${n.head.toString(16)}  ladder 0x${n.ladderVa.toString(16)}`
        + `  cases ${n.cases}  copy-bodies ${n.copyBodies} (${n.minWidth}..${n.maxWidth} dwords)`
        + `  skip-run ${n.skipBodies ? 'yes' : 'no'}  converge ${n.converge}`);
    }
  }
}
if (JSON_OUT) console.log(JSON.stringify(all, null, 2));
