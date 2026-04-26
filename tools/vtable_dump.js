#!/usr/bin/env node
// Dump function pointers from a vtable in a PE/DLL.
// Usage:
//   node tools/vtable_dump.js <pe-file> 0xVTABLE_VA [n_slots=16]
//
// Reads N consecutive 4-byte function pointers starting at VTABLE_VA. For each
// slot, prints the slot index, its address, the function VA it points to, and
// (when readable) the first instruction at that target — useful to confirm the
// slot resolves to a real prologue rather than a NULL/garbage word.
//
// Stops early if a slot value is 0 or points outside any section.

const fs = require('fs');
const { disasmAt } = require('./disasm');

const file = process.argv[2];
const vtArg = process.argv[3];
const nSlots = parseInt(process.argv[4] || '16', 10);

if (!file || !vtArg) {
  console.error('Usage: vtable_dump.js <pe-file> 0xVA [n_slots=16]');
  process.exit(1);
}
const vt = parseInt(vtArg, 16);

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
  sections.push({
    name,
    vaddr: buf.readUInt32LE(s + 12),
    vsize: buf.readUInt32LE(s + 8),
    rawOff: buf.readUInt32LE(s + 20),
    rawSize: buf.readUInt32LE(s + 16),
  });
}

function va2off(va) {
  const rva = va - imageBase;
  for (const s of sections) {
    if (rva >= s.vaddr && rva < s.vaddr + s.rawSize) {
      return { off: s.rawOff + (rva - s.vaddr), sect: s };
    }
  }
  return null;
}

const vtInfo = va2off(vt);
if (!vtInfo) { console.error(`vtable VA 0x${vt.toString(16)} not in any raw section`); process.exit(1); }
console.log(`vtable @ 0x${vt.toString(16)}  [${vtInfo.sect.name}]  raw=0x${vtInfo.off.toString(16)}`);

for (let i = 0; i < nSlots; i++) {
  const slotVA = vt + i * 4;
  const slotOff = vtInfo.off + i * 4;
  if (slotOff + 4 > vtInfo.sect.rawOff + vtInfo.sect.rawSize) {
    console.log(`  slot ${i}: (past section end)`);
    break;
  }
  const fnVA = buf.readUInt32LE(slotOff);
  const tgt = va2off(fnVA);
  let suffix = '';
  if (fnVA === 0) suffix = '  NULL';
  else if (!tgt) suffix = '  (target outside any section)';
  else {
    try {
      const lines = disasmAt(buf, tgt.off, fnVA, 1);
      suffix = `  [${tgt.sect.name}]  ${lines[0] ? lines[0].split(/\s{2,}/).slice(1).join(' ').trim() : ''}`;
    } catch (e) { suffix = `  [${tgt.sect.name}]`; }
  }
  console.log(`  slot ${String(i).padStart(2)} @ 0x${slotVA.toString(16)}  →  0x${fnVA.toString(16).padStart(8,'0')}${suffix}`);
  if (fnVA === 0) break;
}
