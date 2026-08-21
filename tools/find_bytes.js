#!/usr/bin/env node
// find_bytes.js — locate every occurrence of a byte pattern in a PE.
//
// Usage:
//   node tools/find_bytes.js <pe> <hex>            # raw bytes
//   node tools/find_bytes.js <pe> --push=0xIMM     # push imm32 (5 bytes: 68 ll ll ll ll)
//   node tools/find_bytes.js <pe> --imm32=0xVAL    # any 4-byte LE occurrence (literal int)
//   node tools/find_bytes.js <pe> <hex> --section=.text
//   node tools/find_bytes.js <pe> <hex> --context=N
//
// Output per hit: VA  [section]  raw=0xOFF  bytes
// Skips overlapping matches (advance by 1 byte to allow overlapping; default
// behavior is "all matches" since opcode searches need every hit).

const fs = require('fs');
const { readPE } = require(require('path').join(__dirname, '..', 'lib', 'pe.js'));
const path = require('path');

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error('usage: find_bytes.js <pe> <hex|--push=0xIMM|--imm32=0xVAL> [--section=.text] [--context=N]');
  process.exit(1);
}

const pePath = argv[0];
let needle = null;
let sectionFilter = null;
let context = 0;
let label = '';

for (const a of argv.slice(1)) {
  if (a.startsWith('--push=')) {
    const v = parseInt(a.slice(7), 16) >>> 0;
    needle = Buffer.from([0x68, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
    label = `push 0x${v.toString(16)}`;
  } else if (a.startsWith('--push16=')) {
    // 16-bit code pushes an immediate as three bytes, not five. Searching a
    // 16-bit binary for `push 0x135` with the 32-bit encoding finds nothing
    // and looks exactly like "this value is never pushed".
    const v = parseInt(a.slice(9), 16) & 0xffff;
    needle = Buffer.from([0x68, v & 0xff, (v >>> 8) & 0xff]);
    label = `push16 0x${v.toString(16)}`;
  } else if (a.startsWith('--imm16=')) {
    const v = parseInt(a.slice(8), 16) & 0xffff;
    needle = Buffer.from([v & 0xff, (v >>> 8) & 0xff]);
    label = `imm16 0x${v.toString(16)}`;
  } else if (a.startsWith('--imm32=')) {
    const v = parseInt(a.slice(8), 16) >>> 0;
    needle = Buffer.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
    label = `imm32 0x${v.toString(16)}`;
  } else if (a.startsWith('--section=')) {
    sectionFilter = a.slice(10);
  } else if (a.startsWith('--context=')) {
    context = parseInt(a.slice(10), 10) | 0;
  } else if (!needle) {
    const hex = a.replace(/[\s,_-]/g, '').toLowerCase();
    if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2) {
      console.error(`bad hex: ${a}`);
      process.exit(1);
    }
    needle = Buffer.from(hex, 'hex');
    label = `bytes ${hex}`;
  } else {
    console.error(`unknown arg: ${a}`);
    process.exit(1);
  }
}

if (!needle) { console.error('need a pattern'); process.exit(1); }

// A 16-bit NE has no sections and no image base -- it has segments, and an
// address in one is seg:off, not a linear VA. Everything below works on file
// offsets either way, so the only difference is how a hit is named. Without
// this the 16-bit corpus was unsearchable: every PE tool here stops at the
// signature check, and MSHEARTS/SOL/WINMINE are exactly the binaries whose
// behaviour needs looking up in the code.
function readNE(file) {
  const { parse } = require(path.join(__dirname, 'ne-dump.js'));
  const { b, h } = parse(file);
  return {
    buf: b, imageBase: 0, ne: true,
    sections: h.segments.map(s => ({
      name: `seg ${s.index}`, rva: 0, vsize: s.alloc,
      rawOff: s.filePos, rawSize: s.length,
    })),
  };
}

const pe = (() => {
  try { return readPE(pePath); }
  catch (e) {
    if (!/not a PE image/.test(String(e && e.message))) throw e;
    return readNE(pePath);
  }
})();
const data = pe.buf;
const imageBase = pe.imageBase;
// Local field names kept: va is the section RVA here, raw/rsize the on-disk pair.
const sections = pe.sections.map(s => ({
  name: s.name, vsize: s.vsize, va: s.rva, rsize: s.rawSize, raw: s.rawOff,
}));

const findSection = (off) => sections.find(s => off >= s.raw && off < s.raw + s.rsize);

console.log(`Searching for ${label} in ${path.basename(pePath)} (imageBase=0x${imageBase.toString(16)})`);
console.log('');

let total = 0;
let i = 0;
while (true) {
  i = data.indexOf(needle, i);
  if (i < 0) break;
  const sec = findSection(i);
  if (sec && (!sectionFilter || sec.name === sectionFilter)) {
    const off = i - sec.raw;
    const where = pe.ne
      ? `  ${sec.name}:0x${off.toString(16).padStart(4, '0')}`
      : `  0x${(imageBase + sec.va + off).toString(16).padStart(8, '0')}  [${sec.name.padEnd(8)}]`;
    let line = `${where}  raw=0x${i.toString(16)}  ${needle.toString('hex')}`;
    if (context > 0) {
      const ctx = data.slice(Math.max(0, i - context), i + needle.length + context).toString('hex');
      line += `\n    ctx: ${ctx}`;
    }
    console.log(line);
    total++;
  }
  i++;
}

console.log('');
console.log(`Total: ${total} hit(s)`);
