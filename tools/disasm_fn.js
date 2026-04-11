// Usage: node tools/disasm_fn.js <exe> <VA_hex> [count=30]
const { disasmAt } = require('./disasm');
const fs = require('fs');

const exe = process.argv[2] || 'test/binaries/winamp.exe';
const vaStart = parseInt(process.argv[3], 16);
const count = parseInt(process.argv[4] || '30', 10);

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
    rawSize: buf.readUInt32LE(s + 16)
  });
}

function va2off(va) {
  const rva = va - imageBase;
  for (const s of sections) {
    if (rva >= s.vaddr && rva < s.vaddr + s.rawSize) return rva - s.vaddr + s.rawOff;
  }
  return -1;
}

const off = va2off(vaStart);
if (off < 0) { console.error('VA not found in any section'); process.exit(1); }
disasmAt(buf, off, vaStart, count).forEach(l => console.log(l));
