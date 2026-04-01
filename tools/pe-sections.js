#!/usr/bin/env node
// Usage: node tools/pe-sections.js <pe-file> [--base=0xLOADADDR]
const fs = require('fs');
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const baseArg = args.find(a => a.startsWith('--base='));
if (!file) { console.error('Usage: pe-sections.js <pe-file> [--base=0xLOADADDR]'); process.exit(1); }

const buf = fs.readFileSync(file);
const peOff = buf.readUInt32LE(0x3C);
const numSect = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const imageBase = buf.readUInt32LE(peOff + 52);
const sizeOfImage = buf.readUInt32LE(peOff + 80);
const loadBase = baseArg ? parseInt(baseArg.slice(7), 16) : imageBase;
const sectOff = peOff + 24 + optSize;

console.log(`${file}  imageBase=0x${imageBase.toString(16)}  sizeOfImage=0x${sizeOfImage.toString(16)}  loadBase=0x${loadBase.toString(16)}`);
console.log(`  Total mapped: 0x${loadBase.toString(16)} – 0x${(loadBase + sizeOfImage).toString(16)}`);
console.log(`  g2w range: 0x${(loadBase - 0x01000000 + 0x12000).toString(16)} – 0x${(loadBase + sizeOfImage - 0x01000000 + 0x12000).toString(16)}`);
console.log();

for (let i = 0; i < numSect; i++) {
  const s = sectOff + i * 40;
  let name = '';
  for (let j = 0; j < 8 && buf[s + j]; j++) name += String.fromCharCode(buf[s + j]);
  const vsize = buf.readUInt32LE(s + 8);
  const vaddr = buf.readUInt32LE(s + 12);
  const rawSize = buf.readUInt32LE(s + 16);
  const rawOff = buf.readUInt32LE(s + 20);
  const end = loadBase + vaddr + vsize;
  const wasmEnd = end - 0x01000000 + 0x12000;
  console.log(`  ${name.padEnd(8)} VA=0x${(loadBase + vaddr).toString(16)}  VSize=0x${vsize.toString(16).padStart(6,'0')}  Raw=0x${rawSize.toString(16).padStart(6,'0')}  End=0x${end.toString(16)}  wasmEnd=0x${wasmEnd.toString(16)}${vsize > rawSize ? '  BSS='+(vsize-rawSize) : ''}`);
}
