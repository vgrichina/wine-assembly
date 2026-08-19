#!/usr/bin/env node
// Read raw bytes from a PE/DLL at one or more VAs (image-base relative).
// Usage:
//   node tools/dump_va.js <pe-file> 0xVA[,0xVA,...] [len=32]
//
// Output per VA: hexdump (16-byte rows) plus "[section]" tag.
// For BSS-only ranges (no raw data), prints a notice instead of zero-filled noise.
//
// Use this instead of --trace-at-dump when you just need to peek at static
// .rdata / .data — no emulator run required.

const path = require('path');
const { readPE } = require(path.join(__dirname, '..', 'lib', 'pe.js'));

const file = process.argv[2];
const vaArg = process.argv[3];
const len = parseInt(process.argv[4] || '32', 10);

if (!file || !vaArg) {
  console.error('Usage: dump_va.js <pe-file> 0xVA[,0xVA,...] [len=32]');
  process.exit(1);
}

const pe = readPE(file);
const buf = pe.buf;
const vaInfo = va => {
  const info = pe.va2offInfo(va);
  return info && { sect: info.section, fileOff: info.fileOff, hasRaw: info.hasRaw, secOff: info.secOff };
};

function row(addr, bytes) {
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(48, ' ');
  const ascii = Array.from(bytes).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
  return `  0x${addr.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`;
}

const vaList = vaArg.split(',').map(s => parseInt(s, 16));
for (const va of vaList) {
  const info = vaInfo(va);
  if (!info) { console.log(`VA 0x${va.toString(16)}: not in any section`); continue; }
  console.log(`VA 0x${va.toString(16)}  [${info.sect.name}]  raw=0x${info.fileOff.toString(16)}${info.hasRaw ? '' : '  (BSS — zero-init)'}`);
  if (!info.hasRaw) { continue; }
  const end = Math.min(info.fileOff + len, info.sect.rawOff + info.sect.rawSize);
  for (let p = info.fileOff; p < end; p += 16) {
    const slice = buf.subarray(p, Math.min(p + 16, end));
    console.log(row(va + (p - info.fileOff), slice));
  }
}
