// Scan a code range for function boundaries (rets, CC padding) and
// incoming call rel32 targets. Used when find_fn.js heuristics fail
// because the function lacks a `push ebp` prologue.
// Usage: node tools/scan_fn_bounds.js <exe> <lo_VA> <hi_VA> [target_VA]
const { disasmAt } = require('./disasm');
const fs = require('fs');

const exe = process.argv[2];
const lo = parseInt(process.argv[3], 16);
const hi = parseInt(process.argv[4], 16);
const target = parseInt(process.argv[5] || '0', 16);

const buf = fs.readFileSync(exe);
const peOff = buf.readUInt32LE(0x3c);
const optOff = peOff + 24;
const imageBase = buf.readUInt32LE(optOff + 28);
const numSections = buf.readUInt16LE(peOff + 6);
const sectOff = optOff + buf.readUInt16LE(peOff + 20);
const sections = [];
for (let i = 0; i < numSections; i++) {
  const s = sectOff + i * 40;
  sections.push({
    vaddr: buf.readUInt32LE(s + 12),
    vsize: buf.readUInt32LE(s + 8),
    rawOff: buf.readUInt32LE(s + 20),
    rawSize: buf.readUInt32LE(s + 16),
  });
}
function va2off(va) {
  const rva = va - imageBase;
  for (const s of sections) {
    if (rva >= s.vaddr && rva < s.vaddr + s.rawSize) return rva - s.vaddr + s.rawOff;
  }
  return -1;
}

// disasmAt stops at the first ret. Re-invoke from past each ret boundary to
// keep walking. Parse line size from "VA  <hex bytes>  <insn>".
const boundaries = [];
const calls = [];
let pc = lo;
while (pc < hi) {
  const off = va2off(pc);
  if (off < 0) break;
  const lines = disasmAt(buf, off, pc, 4096);
  if (!lines || lines.length === 0) break;
  let cur = pc;
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]+)\s+((?:[0-9a-f]{2} )+)/);
    if (!m) break;
    const va = parseInt(m[1], 16);
    const bytes = m[2].trim().split(/\s+/).map(b => parseInt(b, 16));
    const op = bytes[0];
    if (op === 0xc3) boundaries.push({ va, kind: 'ret' });
    else if (op === 0xc2) boundaries.push({ va, kind: 'retn imm16' });
    else if (op === 0xcc) boundaries.push({ va, kind: 'int3' });
    if (op === 0xe8 && bytes.length >= 5) {
      const disp = (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) | 0;
      const tgt = (va + 5 + disp) >>> 0;
      if (tgt >= lo && tgt < hi) calls.push({ from: va, to: tgt });
    }
    cur = va + bytes.length;
  }
  if (cur <= pc) break;
  pc = cur;
}

console.log(`Scanned 0x${lo.toString(16)}..0x${hi.toString(16)}`);
console.log(`\nBoundaries (last 5 before target=0x${target.toString(16)}):`);
const before = boundaries.filter(b => b.va < target).slice(-5);
for (const b of before) console.log(`  0x${b.va.toString(16)}  ${b.kind}`);
// Find the function entry: smallest call target > last_boundary_before_target
const lastBoundary = before.length ? before[before.length-1].va : 0;
console.log(`\nLikely entry (smallest call target in (${lastBoundary.toString(16)}, ${target.toString(16)}]):`);
console.log(`\nIncoming call rel32 targets (in range):`);
const tgts = new Map();
for (const c of calls) {
  if (!tgts.has(c.to)) tgts.set(c.to, []);
  tgts.get(c.to).push(c.from);
}
for (const [tgt, froms] of [...tgts].sort((a,b)=>a[0]-b[0])) {
  console.log(`  → 0x${tgt.toString(16)}  from ${froms.map(f=>'0x'+f.toString(16)).join(', ')}`);
}
