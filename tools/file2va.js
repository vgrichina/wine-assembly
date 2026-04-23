#!/usr/bin/env node
// Convert PE file offsets <-> VAs.
// Usage:
//   node tools/file2va.js <pe-file> 0xOFFSET[,0xOFFSET...]
//   node tools/file2va.js <pe-file> --va=0xVA[,0xVA...]
//
// Prints one line per input, e.g.:
//   raw=0xc8a9c  →  VA=0x744c9a9c  [.rdata]
//   VA=0x744c9a9c  →  raw=0xc8a9c  [.rdata]

const fs = require('fs');
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && !/^0x/i.test(a));
const vaArg = args.find(a => a.startsWith('--va='));
const offArg = args.find(a => /^0x/i.test(a));

if (!file || (!vaArg && !offArg)) {
  console.error('Usage: file2va.js <pe-file> 0xOFFSET[,...]   |   --va=0xVA[,...]');
  process.exit(1);
}

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

const parseList = (str) => str.split(',').map(x => parseInt(x, 16));

if (offArg) {
  for (const fo of parseList(offArg)) {
    const s = sections.find(s => fo >= s.rawOff && fo < s.rawOff + s.rawSize);
    if (s) console.log(`raw=0x${fo.toString(16)}  →  VA=0x${(imageBase + s.vaddr + (fo - s.rawOff)).toString(16)}  [${s.name}]`);
    else   console.log(`raw=0x${fo.toString(16)}  →  (outside any section)`);
  }
}

if (vaArg) {
  for (const va of parseList(vaArg.slice(5))) {
    const rva = va - imageBase;
    const s = sections.find(s => rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize));
    if (s) {
      const fo = s.rawOff + (rva - s.vaddr);
      const inRaw = (rva - s.vaddr) < s.rawSize;
      console.log(`VA=0x${va.toString(16)}  →  raw=0x${fo.toString(16)}  [${s.name}]${inRaw ? '' : '  (BSS — no raw data)'}`);
    } else {
      console.log(`VA=0x${va.toString(16)}  →  (outside any section)`);
    }
  }
}
