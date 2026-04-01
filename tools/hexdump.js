#!/usr/bin/env node
// Hex dump bytes from a PE at a given virtual address
// Usage: node tools/hexdump.js <exe> <VA> [count=32] [--base=0xLOADADDR]
// --base: runtime load address (auto-computes file offset from runtime VA)
// Example: node tools/hexdump.js test/binaries/notepad.exe 0x4010cc 64
// Example: node tools/hexdump.js test/binaries/dlls/mfc42.dll --base=0x01055000 0x010F7064 48

const fs = require('fs');
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && isNaN(parseInt(a, 16)) || a.includes('.'));
const baseArg = args.find(a => a.startsWith('--base='));
const nums = args.filter(a => !a.startsWith('--') && a !== file);
const va = parseInt(nums[0], 16);
const count = parseInt(nums[1] || '32');

if (!file || isNaN(va)) {
  console.error('Usage: node tools/hexdump.js <exe> <VA> [count=32] [--base=0xLOADADDR]');
  process.exit(1);
}

const buf = fs.readFileSync(file);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

const peOff = dv.getUint32(0x3c, true);
const numSect = dv.getUint16(peOff + 6, true);
const optSize = dv.getUint16(peOff + 4 + 16, true);
const imageBase = dv.getUint32(peOff + 4 + 20 + 28, true);
const sectOff = peOff + 4 + 20 + optSize;
const loadBase = baseArg ? parseInt(baseArg.slice(7), 16) : imageBase;
const rva = va - loadBase;

for (let i = 0; i < numSect; i++) {
  const so = sectOff + i * 40;
  const sva = dv.getUint32(so + 12, true);
  const svs = dv.getUint32(so + 8, true);
  const rawOff = dv.getUint32(so + 20, true);
  if (rva >= sva && rva < sva + svs) {
    const fileOff = rva - sva + rawOff;
    for (let row = 0; row < count; row += 16) {
      const addr = va + row;
      const hex = [];
      const ascii = [];
      for (let c = 0; c < 16 && row + c < count; c++) {
        const b = buf[fileOff + row + c];
        hex.push(b.toString(16).padStart(2, '0'));
        ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
      }
      console.log(`${addr.toString(16).padStart(8, '0')}  ${hex.join(' ').padEnd(48)}  ${ascii.join('')}`);
    }
    process.exit(0);
  }
}
console.error(`VA 0x${va.toString(16)} not found in any section`);
process.exit(1);
