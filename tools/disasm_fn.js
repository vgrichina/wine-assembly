// Usage: node tools/disasm_fn.js <exe> <VA_hex>[,VA_hex,...] [count=30]
const { disasmAt } = require('./disasm');
const fs = require('fs');

const exe = process.argv[2] || 'test/binaries/winamp.exe';
const vaList = (process.argv[3] || '').split(',').map(s => parseInt(s, 16));
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

// Heuristic: if the first instructions look like a known desync pattern
// (executing zero-bytes or jmp/call far), emit a warning. Mid-instruction
// starts usually produce one of these within the first 3 lines.
function looksDesync(lines) {
  const head = lines.slice(0, 3).join('\n');
  return (
    /\badd \[eax\], (eax|al)\b/.test(head) ||    // 00 00 = add [eax], al
    /\bjmp far\b/.test(head) ||
    /\bcall far\b/.test(head) ||
    /\?\?/.test(head) ||                         // unknown opcode marker
    /\badc al, 0x/.test(head)                    // 14 XX often garbage
  );
}

for (const va of vaList) {
  const off = va2off(va);
  if (off < 0) { console.error(`VA 0x${va.toString(16)} not found in any section`); continue; }
  if (vaList.length > 1) console.log(`--- 0x${va.toString(16)} ---`);
  const lines = disasmAt(buf, off, va, count);
  if (looksDesync(lines)) {
    console.log(`[WARN] output may be desynchronized — start VA is likely mid-instruction.`);
    console.log(`       Try \`node tools/find_fn.js <exe> 0x${va.toString(16)}\` to locate a known entry.`);
  }
  lines.forEach(l => console.log(l));
}
