#!/usr/bin/env node
// Find all cross-references to a target VA in a PE file.
// Usage: node tools/xrefs.js <exe> <VA> [--code] [--near=RANGE]
//   <VA>      target address (hex). Matches on the literal 4-byte address in any instruction,
//             plus call/jmp rel32 whose target falls in [VA, VA+near].
//   --near=N  widen target range for branch xrefs (default 0). E.g. --near=0x40 catches
//             calls into any byte of a 64-byte trampoline entry.
//   --code    only scan executable sections (default: all sections).
//
// Output per hit: VA  section  kind  bytes  disasm
//   kinds: load, store, imm, branch, other

const fs = require('fs');
const { disasmAt } = require('./disasm');

const args = process.argv.slice(2);
const file = args[0];
const tgtArg = args[1];
if (!file || !tgtArg) {
  console.error('Usage: xrefs.js <exe> <VA> [--near=RANGE] [--code]');
  process.exit(1);
}
const target = parseInt(tgtArg, 16);
const nearArg = args.find(a => a.startsWith('--near='));
const near = nearArg ? parseInt(nearArg.slice(7), 16) : 0;
const codeOnly = args.includes('--code');
// Some compilers (Borland) put real code in sections flagged as data (CodeSeg, DataSeg).
// Always scan sections whose name looks code-ish so we don't miss branches in them.
const looksCode = name => /code|text|seg/i.test(name);

const buf = fs.readFileSync(file);
const peOff = buf.readUInt32LE(0x3C);
const numSect = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const imageBase = buf.readUInt32LE(peOff + 52);
const sectOff = peOff + 24 + optSize;

const sections = [];
for (let i = 0; i < numSect; i++) {
  const s = sectOff + i * 40;
  let name = '';
  for (let j = 0; j < 8 && buf[s + j]; j++) name += String.fromCharCode(buf[s + j]);
  const chr = buf.readUInt32LE(s + 36);
  sections.push({
    name,
    vaddr: imageBase + buf.readUInt32LE(s + 12),
    vsize: buf.readUInt32LE(s + 8),
    rawOff: buf.readUInt32LE(s + 20),
    rawSize: buf.readUInt32LE(s + 16),
    exec: (chr & 0x20000000) !== 0,
  });
}

// Classify a matched 4-byte literal within an instruction stream.
// Returns { kind, insnOff } where insnOff is the VA of the opcode byte.
// kind ∈ 'load' | 'store' | 'imm' | 'branch' | 'other'.
function classifyDataRef(buf, hitOff) {
  const b1 = buf[hitOff - 1];   // byte immediately before the literal
  const b2 = buf[hitOff - 2];   // one further back (for 2-byte opcode forms)

  // 1-byte opcode + disp32 forms (A0/A1/A2/A3)
  if (b1 === 0xA1 || b1 === 0xA0) return { kind: 'load',  insnOff: hitOff - 1 };
  if (b1 === 0xA3 || b1 === 0xA2) return { kind: 'store', insnOff: hitOff - 1 };

  // 2-byte opcode + modrm=(mod=0, rm=5, any reg) → (b1 & 0xC7) === 0x05
  if ((b1 & 0xC7) === 0x05) {
    const sub = (b1 >> 3) & 7;
    const insnOff = hitOff - 2;
    if (b2 === 0xC7) return { kind: 'store',  insnOff };              // mov m32, imm32
    if (b2 === 0x89 || b2 === 0x88) return { kind: 'store', insnOff }; // mov m, reg
    if (b2 === 0x80 || b2 === 0x81 || b2 === 0x83) return { kind: 'store', insnOff }; // alu m,imm
    if (b2 === 0x8B || b2 === 0x8A) return { kind: 'load', insnOff };  // mov reg, m
    if (b2 === 0xFF) {
      if (sub === 0 || sub === 1) return { kind: 'store', insnOff };   // inc/dec
      if (sub === 2 || sub === 3 || sub === 4 || sub === 5) return { kind: 'branch', insnOff };
      if (sub === 6) return { kind: 'load', insnOff };                 // push m32
    }
    if (b2 === 0xD1 || b2 === 0xD3 || b2 === 0xC1) return { kind: 'store', insnOff }; // shifts rmw
    if (b2 === 0xF6 || b2 === 0xF7) {
      if (sub === 0 || sub === 1) return { kind: 'other', insnOff };   // test
      return { kind: 'store', insnOff };                               // not/neg/mul/div
    }
    if (b2 === 0x39 || b2 === 0x3B || b2 === 0x85 || b2 === 0x84) return { kind: 'other', insnOff };
    // ALU reg, [m] forms: 01/03/09/0B/... (reg dst is [m] for 01/09/11/19/21/29/31/39)
    if ((b2 & 0xC7) === 0x01) return { kind: 'store', insnOff };  // 01/09/11/... m,reg
    if ((b2 & 0xC7) === 0x03) return { kind: 'load',  insnOff };  // 03/0B/13/... reg,m
    // 0F-prefixed: treat as 'other' (movsx/movzx/setcc etc.) with 3-byte lookback
    if (b2 === 0x0F) return { kind: 'other', insnOff: hitOff - 3 };
    return { kind: 'other', insnOff };
  }
  return { kind: 'imm', insnOff: hitOff - 4 };  // generic 4-byte imm in some longer instruction
}

const results = [];
for (const s of sections) {
  if (codeOnly && !s.exec) continue;
  const treatAsCode = s.exec || looksCode(s.name);
  const end = s.rawOff + Math.min(s.rawSize, s.vsize);
  // 1) Scan for literal 4-byte occurrences of target
  for (let i = s.rawOff; i + 4 <= end; i++) {
    const v = buf.readUInt32LE(i);
    if (v === target) {
      if (treatAsCode) {
        const { kind, insnOff } = classifyDataRef(buf, i);
        const insnVA = s.vaddr + (insnOff - s.rawOff);
        results.push({ va: insnVA, section: s.name, kind, off: insnOff });
      } else {
        results.push({ va: s.vaddr + (i - s.rawOff), section: s.name, kind: 'data', off: i });
      }
    }
  }
  // 2) Scan for call/jmp rel32 targeting [target, target+near]
  if (treatAsCode) {
    for (let i = s.rawOff; i + 5 <= end; i++) {
      const op = buf[i];
      if (op !== 0xE8 && op !== 0xE9) continue;
      const off = buf.readInt32LE(i + 1);
      const cva = s.vaddr + (i - s.rawOff);
      const tgt = (cva + 5 + off) >>> 0;
      if (tgt >= target && tgt <= target + near) {
        results.push({
          va: cva, section: s.name, kind: 'branch', off: i,
          branchTo: tgt, branchKind: op === 0xE8 ? 'call' : 'jmp ',
        });
      }
    }
    // Short jcc (0x70-0x7F) and short jmp (0xEB) — only matter when near==0 and target is <=127 from site.
    // Rare in practice for cross-function xref; skip for now.
  }
}

function va2off(va) {
  for (const s of sections) {
    if (va >= s.vaddr && va < s.vaddr + s.rawSize) return { off: va - s.vaddr + s.rawOff, sect: s };
  }
  return null;
}

results.sort((a, b) => a.va - b.va);
if (!results.length) {
  console.log(`No xrefs to 0x${target.toString(16)} found.`);
  process.exit(0);
}
console.log(`${results.length} xref(s) to 0x${target.toString(16)}${near ? `..+0x${near.toString(16)}` : ''}:`);
for (const r of results) {
  let extra = '';
  if (r.branchTo !== undefined) extra = ` -> 0x${r.branchTo.toString(16)}`;
  let disasm = '';
  try {
    const lines = disasmAt(buf, r.off, r.va, 1);
    if (lines[0]) {
      // strip the leading VA and raw-bytes columns from disasmAt output
      const m = lines[0].match(/^[0-9a-f]+\s+([0-9a-f ]+?)\s{2,}(.*)$/);
      disasm = m ? m[2] : lines[0];
    }
  } catch (e) {}
  console.log(`  0x${r.va.toString(16).padStart(8, '0')}  [${r.section.padEnd(8)}]  ${r.kind.padEnd(6)}  ${disasm}${extra}`);
}
