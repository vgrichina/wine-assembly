#!/usr/bin/env node
// Convert PE file offsets <-> VAs.
// Usage:
//   node tools/file2va.js <pe-file> 0xOFFSET[,0xOFFSET...]
//   node tools/file2va.js <pe-file> --va=0xVA[,0xVA...]
//
// Prints one line per input, e.g.:
//   raw=0xc8a9c  →  VA=0x744c9a9c  [.rdata]
//   VA=0x744c9a9c  →  raw=0xc8a9c  [.rdata]

const path = require('path');
const { readPE } = require(path.join(__dirname, '..', 'lib', 'pe.js'));
const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && !/^0x/i.test(a));
const vaArg = args.find(a => a.startsWith('--va='));
const offArg = args.find(a => /^0x/i.test(a));

if (!file || (!vaArg && !offArg)) {
  console.error('Usage: file2va.js <pe-file> 0xOFFSET[,...]   |   --va=0xVA[,...]');
  process.exit(1);
}

const pe = readPE(file);
const { imageBase, sections } = pe;

const parseList = (str) => str.split(',').map(x => parseInt(x, 16));

if (offArg) {
  for (const fo of parseList(offArg)) {
    const s = sections.find(s => fo >= s.rawOff && fo < s.rawOff + s.rawSize);
    if (s) console.log(`raw=0x${fo.toString(16)}  →  VA=0x${(imageBase + s.rva + (fo - s.rawOff)).toString(16)}  [${s.name}]`);
    else   console.log(`raw=0x${fo.toString(16)}  →  (outside any section)`);
  }
}

if (vaArg) {
  for (const va of parseList(vaArg.slice(5))) {
    const rva = va - imageBase;
    const s = sections.find(s => rva >= s.rva && rva < s.rva + Math.max(s.vsize, s.rawSize));
    if (s) {
      const fo = s.rawOff + (rva - s.rva);
      const inRaw = (rva - s.rva) < s.rawSize;
      console.log(`VA=0x${va.toString(16)}  →  raw=0x${fo.toString(16)}  [${s.name}]${inRaw ? '' : '  (BSS — no raw data)'}`);
    } else {
      console.log(`VA=0x${va.toString(16)}  →  (outside any section)`);
    }
  }
}
