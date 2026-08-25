#!/usr/bin/env node
// Which binaries in the corpus actually contain SIMD (MMX / SSE / SSE2 / 3DNow!)
// instructions -- i.e. which ones would need SIMD support in the interpreter.
//
// Usage:
//   node tools/scan-simd.js <pe> [<pe> ...] [--samples=N] [--min=N] [--json]
//
// Method: scan every code section for the two-byte 0F escape opcodes that are
// exclusively SIMD, decoding the ModRM so each hit gets a real length and
// mnemonic. The opcode table itself lives in tools/simd-ops.js, shared with
// tools/disasm.js so the two can never disagree about what a byte pair means.
// The 66/F2/F3 prefix immediately before the 0F picks the xmm/SSE2 form, which
// is how MMX (mm regs, works on any Pentium MMX) is told apart from
// SSE/SSE2 (xmm regs, needs FXSAVE state).
//
// A raw byte scan over code sections has false positives -- these byte pairs
// also occur inside jump tables, string literals in .text, and as the tail of
// a longer instruction. Two things keep the answer honest:
//   * only opcodes with NO non-SIMD meaning are counted (0F 6x/7x/D-Fx, 0F 5x,
//     0F 10-17, 0F 28-2F, 0F C2/C6, 0F 0F 3DNow!) -- 0F 8x jcc, 0F 9x setcc,
//     0F Ax/Bx bit ops and 0F 4x cmov are excluded entirely;
//   * --samples prints the hits with context bytes so a cluster of real code
//     can be told from one stray byte pair.
// CPUID (0F A2) sites are counted separately: an app that *detects* MMX and
// then branches around it needs nothing from us but a correct feature bit.
'use strict';

const { readPE } = require('../lib/pe');
const { disasmAt } = require('./disasm');
const { decodeSimd, NOW3D, regName } = require('./simd-ops');

// Is `off` a real instruction boundary? A 0F byte is also the tail of dozens of
// ordinary encodings (a `jz rel32` operand, an address literal, a padding run),
// and in a 200KB .text those coincidences outnumber real SIMD by a lot -- raw
// scanning calls notepad.exe an SSE app. x86 decoding is self-synchronizing, so
// sweep forward from three different points behind the candidate: if the
// decoder lands exactly on `off` from at least two of them, the byte really
// starts an instruction.
function isBoundary(buf, off, secStart) {
  let votes = 0;
  for (const back of [16, 32, 48]) {
    const from = off - back;
    if (from < secStart) { votes++; continue; }
    let lines;
    try { lines = disasmAt(buf, from, from, 40); } catch (e) { continue; }
    for (const ln of lines) {
      const at = parseInt(ln.slice(0, 8), 16);
      if (at === off) { votes++; break; }
      if (at > off) break;
    }
    if (votes >= 2) return true;
  }
  return votes >= 2;
}


const R32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

// Decode ModRM+SIB+disp starting at i; returns {len, reg, rm} or null if
// truncated. `s` is the decodeSimd result, which names the register file for
// each operand.
function modrm(buf, i, s, wide) {
  if (i >= buf.length) return null;
  const m = buf[i];
  const mod = m >> 6, reg = (m >> 3) & 7, rm = m & 7;
  let len = 1, mem;
  if (mod === 3) {
    mem = regName(s.rmKind, wide, rm);
  } else {
    let base = R32[rm];
    if (rm === 4) {
      if (i + 1 >= buf.length) return null;
      const sib = buf[i + 1]; len++;
      const idx = (sib >> 3) & 7, sc = 1 << (sib >> 6);
      const b = (sib & 7) === 5 && mod === 0 ? 'disp32' : R32[sib & 7];
      base = idx === 4 ? b : `${b}+${R32[idx]}*${sc}`;
    }
    if (mod === 0 && rm === 5) { base = 'disp32'; len += 4; }
    else if (mod === 1) len += 1;
    else if (mod === 2) len += 4;
    mem = `[${base}]`;
  }
  return { len, mod, reg: regName(s.regKind, wide, reg), rm: mem };
}

// Render operands the way the mnemonic actually takes them.
function operands(s, md) {
  if (s.isGroup) return md.rm;
  return s.dir === 'mr' ? `${md.rm}, ${md.reg}` : `${md.reg}, ${md.rm}`;
}

function scanFile(path, opts) {
  const pe = readPE(path);
  const res = { path, total: 0, cpuid: 0, byIsa: {}, byMnem: {}, hits: [], offs: [], cluster: 0 };
  for (const s of pe.sections) {
    if (!s.isCode || !s.rawSize) continue;
    const start = s.rawOff, end = Math.min(s.rawOff + s.rawSize, pe.buf.length);
    for (let i = start; i < end - 1; i++) {
      if (pe.buf[i] !== 0x0f) continue;
      const op = pe.buf[i + 1];
      // CPUID needs the same boundary check as everything else: `e8 0f a2 0f 00`
      // is a `call rel32`, and counting its bytes as a cpuid site invents a
      // feature check that isn't there (mech3demo.exe has one such ghost).
      if (op === 0xa2) {
        if (isBoundary(pe.buf, i, start)) res.cpuid++;
        continue;
      }
      if (op === 0x0f) { // 3DNow!: 0F 0F modrm ... imm8
        const now = { regKind: 'q', rmKind: 'q', dir: 'rm', isGroup: false };
        const md = modrm(pe.buf, i + 2, now, false);
        if (!md) continue;
        const mnem = NOW3D[pe.buf[i + 2 + md.len]];
        if (!mnem) continue;
        if (!isBoundary(pe.buf, i, start)) continue;
        record(res, s, pe, i, 2 + md.len + 1, '3dnow', mnem, operands(now, md), opts);
        continue;
      }
      const pfx = i > start && (pe.buf[i - 1] === 0x66 || pe.buf[i - 1] === 0xf2 || pe.buf[i - 1] === 0xf3)
        ? pe.buf[i - 1] : 0;
      const sd = decodeSimd(op, pfx, i + 2 < pe.buf.length ? (pe.buf[i + 2] >> 3) & 7 : 0);
      if (!sd) continue;
      if (!isBoundary(pe.buf, i - (pfx ? 1 : 0), start)) continue;
      let len = 2, text = '';
      if (!sd.noModrm) {
        const md = modrm(pe.buf, i + 2, sd, sd.isa !== 'mmx');
        if (!md) continue;
        if (sd.mod3Only && md.mod !== 3) continue;
        len += md.len; text = operands(sd, md);
        if (sd.imm8) len += 1;
      }
      record(res, s, pe, i - (pfx ? 1 : 0), len + (pfx ? 1 : 0), sd.isa, sd.mnem, text, opts);
    }
  }
  // Density check. Real SIMD code comes in runs -- a routine that touches mm0
  // touches it a dozen times in a few hundred bytes. Scattered singletons in a
  // 200KB .text are byte-pair coincidences inside ordinary instructions. The
  // cluster score is the most hits found in any 256-byte window.
  res.offs.sort((a, b) => a - b);
  for (let i = 0, j = 0; i < res.offs.length; i++) {
    while (res.offs[i] - res.offs[j] > 256) j++;
    res.cluster = Math.max(res.cluster, i - j + 1);
  }
  return res;
}

function record(res, sec, pe, off, len, isa, mnem, text, opts) {
  res.total++;
  res.byIsa[isa] = (res.byIsa[isa] || 0) + 1;
  res.byMnem[mnem] = (res.byMnem[mnem] || 0) + 1;
  res.offs.push(off);
  if (res.hits.length < opts.samples) {
    const va = pe.imageBase + sec.rva + (off - sec.rawOff);
    const bytes = [...pe.buf.slice(off, off + Math.min(len, 12))]
      .map(b => b.toString(16).padStart(2, '0')).join(' ');
    res.hits.push({ va, sec: sec.name, isa, mnem, text, bytes });
  }
}

function main() {
  const args = process.argv.slice(2);
  const opts = { samples: 0, min: 1, json: false };
  const files = [];
  for (const a of args) {
    if (a.startsWith('--samples=')) opts.samples = +a.slice(10);
    else if (a.startsWith('--min=')) opts.min = +a.slice(6);
    else if (a === '--json') opts.json = true;
    else files.push(a);
  }
  if (!files.length) {
    console.error('usage: node tools/scan-simd.js <pe> [...] [--samples=N] [--min=N] [--json]');
    process.exit(2);
  }
  const out = [];
  for (const f of files) {
    try { out.push(scanFile(f, opts)); }
    catch (e) { out.push({ path: f, error: e.message, total: 0, cpuid: 0, byIsa: {}, byMnem: {}, hits: [] }); }
  }
  if (opts.json) { console.log(JSON.stringify(out, null, 2)); return; }
  out.sort((a, b) => (b.cluster - a.cluster) || (b.total - a.total));
  for (const r of out) {
    if (r.error) { console.log(`${r.path}: ERROR ${r.error}`); continue; }
    if (r.total < opts.min && !r.cpuid) continue;
    const isa = Object.entries(r.byIsa).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`).join(' ');
    // Confidence. `emms` is the tell: it exists for one reason (leave MMX
    // state before the next FPU op), it is a whole 2-byte instruction with no
    // operands to misparse, and every real MMX routine ends with one. A file
    // with validated emms plus a dense cluster is running MMX; a handful of
    // scattered singletons with no emms is very likely still byte noise.
    const emms = r.byMnem['emms'] || 0;
    const conf = emms && r.cluster >= 5 ? 'HIGH'
      : r.cluster >= 8 ? 'medium' : 'low';
    const top = Object.entries(r.byMnem).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, v]) => `${k}x${v}`).join(', ');
    console.log(`${r.path}\n  simd=${r.total} cluster=${r.cluster} cpuid=${r.cpuid} conf=${conf}  ${isa}\n  top: ${top}`);
    for (const h of r.hits) {
      console.log(`    0x${h.va.toString(16)} [${h.sec}] ${h.isa.padEnd(8)} ${h.mnem} ${h.text}   ; ${h.bytes}`);
    }
  }
}

if (require.main === module) main();
module.exports = { scanFile };
