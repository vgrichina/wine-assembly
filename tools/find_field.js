#!/usr/bin/env node
// Find all accesses to struct field [reg+OFFSET] in a PE .text/.code section.
// Scans for ModRM-encoded memory operands with a given displacement.
//
// Usage: node tools/find_field.js <exe> <offset> [options]
//   <offset>      Field displacement (hex), e.g. 0x44
//   --reg=R,...   Filter by base register: eax,ecx,edx,ebx,ebp,esi,edi (rm=4 SIB, rm=5+mod0 skipped)
//   --op=K,...    Filter by op kind: read, write, lea, cmp, imm, indirect (default: all)
//   --near=N      Also match displacements in [offset, offset+N]
//   --context=N   Show N instructions of context before+after each hit (default: 0)
//   --fn          Show enclosing function entry for each hit
//
// Example:
//   node tools/find_field.js test/binaries/mspaint.exe 0x44 --reg=esi --op=write --context=3 --fn

const fs = require('fs');
const { disasmAt } = require('./disasm');

const args = process.argv.slice(2);
const file = args[0];
const offArg = args[1];
if (!file || !offArg || offArg.startsWith('-')) {
  console.error('Usage: find_field.js <exe> <offset> [--reg=R,...] [--op=K,...] [--near=N]');
  process.exit(1);
}
const targetOff = parseInt(offArg, 16);
const nearArg = args.find(a => a.startsWith('--near='));
const near = nearArg ? parseInt(nearArg.slice(7), 16) : 0;
const regArg = args.find(a => a.startsWith('--reg='));
const regFilter = regArg ? new Set(regArg.slice(6).split(',')) : null;
const opArg = args.find(a => a.startsWith('--op='));
const opFilter = opArg ? new Set(opArg.slice(5).split(',')) : null;
const ctxArg = args.find(a => a.startsWith('--context='));
const context = ctxArg ? parseInt(ctxArg.slice(10), 10) : 0;
const showFn = args.includes('--fn');

const regs32 = ['eax','ecx','edx','ebx','esp','ebp','esi','edi'];

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
const looksCode = n => /code|text|seg/i.test(n);

// Walk backward to find enclosing function entry (prologue 55 8B EC, or
// post-ret / post-padding boundary). Mirrors tools/find_fn.js heuristics.
function findEntry(rawOff, sec) {
  const floor = Math.max(sec.rawOff, rawOff - 0x4000);
  for (let i = rawOff; i >= floor; i--) {
    const b = buf[i];
    if (b === 0x55 && buf[i+1] === 0x8B && buf[i+2] === 0xEC) return sec.vaddr + (i - sec.rawOff);
    if (b !== 0xCC && b !== 0x90 && i - 2 >= sec.rawOff) {
      const p1 = buf[i-1], p2 = buf[i-2];
      if ((p1 === 0xCC && p2 === 0xCC) || (p1 === 0x90 && p2 === 0x90)) return sec.vaddr + (i - sec.rawOff);
    }
    if (i - 1 >= sec.rawOff && buf[i-1] === 0xC3) return sec.vaddr + (i - sec.rawOff);
    if (i - 3 >= sec.rawOff && buf[i-3] === 0xC2) return sec.vaddr + (i - sec.rawOff);
  }
  return null;
}

// Classify ModRM-using opcodes into a small vocabulary.
// Returns { kind, skipPrefix } where skipPrefix is how many bytes before ModRM.
// kind ∈ 'read' | 'write' | 'lea' | 'cmp' | 'imm' | 'indirect' | 'other'
function classify(buf, i) {
  let b = buf[i];
  let skip = 1;
  if (b === 0x0F) {
    const b2 = buf[i+1];
    skip = 2;
    // 0F B6/B7 movzx, 0F BE/BF movsx, 0F AF imul → all read
    if ([0xB6,0xB7,0xBE,0xBF,0xAF].includes(b2)) return { kind:'read', skip };
    return null;
  }
  // Primary opcodes
  switch (b) {
    case 0x88: case 0x89: return { kind:'write', skip };
    case 0x8A: case 0x8B: return { kind:'read', skip };
    case 0x8D: return { kind:'lea', skip };
    case 0xC6: case 0xC7: return { kind:'imm', skip };
    case 0x38: case 0x39: case 0x3A: case 0x3B: return { kind:'cmp', skip };
    case 0x84: case 0x85: return { kind:'cmp', skip }; // test
    case 0xFF: return { kind:'indirect', skip };       // call/jmp/push/inc/dec via r/m
    case 0xF6: case 0xF7: return { kind:'other', skip }; // grp3: test/not/neg/mul/div
    case 0x80: case 0x81: case 0x83: return { kind:'other', skip }; // grp1 imm alu
    case 0xD0: case 0xD1: case 0xD2: case 0xD3: return { kind:'other', skip }; // shifts
    // ALU r/m, r and r, r/m forms
    case 0x00: case 0x01: case 0x08: case 0x09: case 0x10: case 0x11:
    case 0x18: case 0x19: case 0x20: case 0x21: case 0x28: case 0x29:
    case 0x30: case 0x31:
      return { kind:'write', skip }; // reads+writes memory, treat as write-ish
    case 0x02: case 0x03: case 0x0A: case 0x0B: case 0x12: case 0x13:
    case 0x1A: case 0x1B: case 0x22: case 0x23: case 0x2A: case 0x2B:
    case 0x32: case 0x33:
      return { kind:'read', skip };
  }
  return null;
}

const hits = [];

for (const sec of sections) {
  if (!sec.exec && !looksCode(sec.name)) continue;
  const start = sec.rawOff;
  const end = sec.rawOff + sec.rawSize;
  const va0 = sec.vaddr;

  for (let i = start; i < end - 6; i++) {
    const cls = classify(buf, i);
    if (!cls) continue;
    const modrmPos = i + cls.skip;
    const modrm = buf[modrmPos];
    const mod = modrm >> 6, rm = modrm & 7;
    if (mod !== 1 && mod !== 2) continue;           // need displacement
    if (rm === 4) continue;                          // SIB — skip (rare for fields)
    if (rm === 5 && mod === 0) continue;             // disp32-only, no base

    let disp, dispBytes;
    if (mod === 1) { disp = buf[modrmPos+1]; if (disp & 0x80) disp -= 256; dispBytes = 1; }
    else           { disp = buf.readInt32LE(modrmPos+1); dispBytes = 4; }

    if (disp < targetOff || disp > targetOff + near) continue;

    const base = regs32[rm];
    if (regFilter && !regFilter.has(base)) continue;
    if (opFilter && !opFilter.has(cls.kind)) continue;

    const va = va0 + (i - start);
    hits.push({ va, base, kind: cls.kind, rawOff: i, sec });
  }
}

console.log(`${hits.length} hit(s) for [reg+0x${targetOff.toString(16)}${near?`..+0x${(targetOff+near).toString(16)}`:''}]`);

// For context, disassemble a window forward from a starting offset and return
// the decoded instruction boundaries. To approximate "N instructions before",
// walk backward from the hit up to N*6 bytes and linear-disasm forward until
// we reach (or pass) the hit; keep the last N lines before it.
function disasmRange(rawOff, va, maxInstrs) {
  const out = [];
  let p = rawOff, v = va, remaining = maxInstrs;
  while (remaining-- > 0) {
    let line;
    try { line = disasmAt(buf, p, v, 1)[0]; } catch { break; }
    if (!line) break;
    out.push(line);
    // Parse byte-count from line: "<va>  <hex bytes>  <mnem>..." — hex bytes cols 10..37
    const hexField = line.slice(10, 37).trim();
    const nBytes = hexField.split(/\s+/).filter(Boolean).length;
    if (!nBytes) break;
    p += nBytes;
    v += nBytes;
  }
  return { lines: out, endOff: p, endVa: v };
}

for (const h of hits) {
  const header = `[${h.kind.padEnd(8)}] 0x${h.va.toString(16).padStart(8,'0')} base=${h.base}`;
  let fnTag = '';
  if (showFn) {
    const entry = findEntry(h.rawOff, h.sec);
    fnTag = entry ? `  fn=0x${entry.toString(16).padStart(8,'0')}` : '  fn=?';
  }
  console.log(`${header}${fnTag}`);
  if (context > 0) {
    // Back up: start disasm at max(sec.rawOff, hit - context*6) and walk forward.
    const backBytes = context * 6;
    const startOff = Math.max(h.sec.rawOff, h.rawOff - backBytes);
    const startVa = h.sec.vaddr + (startOff - h.sec.rawOff);
    // Disasm forward until we land exactly on h.rawOff (or pass it, then bail).
    const preLines = [];
    let p = startOff, v = startVa;
    while (p < h.rawOff) {
      let line; try { line = disasmAt(buf, p, v, 1)[0]; } catch { break; }
      if (!line) break;
      const nb = (line.slice(10,37).trim().split(/\s+/).filter(Boolean)).length || 1;
      if (p + nb > h.rawOff) break;                // would overshoot — alignment problem
      preLines.push(line);
      p += nb; v += nb;
    }
    // Keep last `context` pre-lines.
    for (const L of preLines.slice(-context)) console.log(`      ${L}`);
    // The hit line itself + context after.
    const { lines } = disasmRange(h.rawOff, h.va, 1 + context);
    if (lines.length) console.log(`  >>  ${lines[0]}`);
    for (const L of lines.slice(1)) console.log(`      ${L}`);
    console.log('');
  } else {
    try { console.log(`      ${disasmAt(buf, h.rawOff, h.va, 1)[0]}`); } catch {}
  }
}
