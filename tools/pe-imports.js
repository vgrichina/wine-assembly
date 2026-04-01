#!/usr/bin/env node
// Usage: node tools/pe-imports.js <pe-file> [--dll=name] [--all]
// Lists import descriptors and optionally shows individual imports for a DLL.
const fs = require('fs');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('Usage: pe-imports.js <pe-file> [--dll=name] [--all]'); process.exit(1); }

const dllFilter = (args.find(a => a.startsWith('--dll=')) || '').slice(6).toLowerCase();
const showAll = args.includes('--all');

const buf = fs.readFileSync(file);
const peOff = buf.readUInt32LE(0x3C);
const numSections = buf.readUInt16LE(peOff + 6);
const optOff = peOff + 24;
const imageBase = buf.readUInt32LE(optOff + 28);
const importRVA = buf.readUInt32LE(optOff + 104);
const secOff = optOff + buf.readUInt16LE(optOff - 4);

function rva2off(rva) {
  for (let i = 0; i < numSections; i++) {
    const s = secOff + i * 40;
    const va = buf.readUInt32LE(s + 12);
    const rawOff = buf.readUInt32LE(s + 20);
    const vSize = buf.readUInt32LE(s + 8);
    if (rva >= va && rva < va + vSize) return rva - va + rawOff;
  }
  return -1;
}

function readStr(off) {
  let s = '';
  for (let i = 0; off + i < buf.length && buf[off + i]; i++) s += String.fromCharCode(buf[off + i]);
  return s;
}

console.log(`${file}  imageBase=0x${imageBase.toString(16)}  importRVA=0x${importRVA.toString(16)}`);
console.log();

let off = rva2off(importRVA);
if (off < 0) { console.error('Cannot resolve import directory'); process.exit(1); }

while (true) {
  const iltRVA = buf.readUInt32LE(off);
  const nameRVA = buf.readUInt32LE(off + 12);
  const iatRVA = buf.readUInt32LE(off + 16);
  if (iltRVA === 0 && nameRVA === 0) break;

  const name = readStr(rva2off(nameRVA));
  const match = !dllFilter || name.toLowerCase().includes(dllFilter);

  if (match || !dllFilter) {
    console.log(`${name}  ILT=0x${iltRVA.toString(16)}  IAT=0x${iatRVA.toString(16)}`);
  }

  if (match && (showAll || dllFilter)) {
    const iltOff = rva2off(iltRVA);
    for (let j = 0; ; j++) {
      const entry = buf.readUInt32LE(iltOff + j * 4);
      if (entry === 0) break;
      if (entry & 0x80000000) {
        console.log(`  [${j}] ordinal ${entry & 0xFFFF}`);
      } else {
        const hintOff = rva2off(entry);
        const hint = buf.readUInt16LE(hintOff);
        const fname = readStr(hintOff + 2);
        console.log(`  [${j}] ${fname}  hint=${hint}  RVA=0x${entry.toString(16)}`);
      }
    }
  }
  off += 20;
}
