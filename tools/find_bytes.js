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

const data = fs.readFileSync(pePath);
const peOff = data.readUInt32LE(0x3c);
const numSections = data.readUInt16LE(peOff + 6);
const optHdrSize = data.readUInt16LE(peOff + 0x14);
const imageBase = data.readUInt32LE(peOff + 0x18 + 0x1c) >>> 0;
const secOff = peOff + 0x18 + optHdrSize;

const sections = [];
for (let i = 0; i < numSections; i++) {
  const o = secOff + i * 0x28;
  const name = data.slice(o, o + 8).toString('latin1').replace(/\0+$/, '');
  const vsize = data.readUInt32LE(o + 8);
  const va = data.readUInt32LE(o + 12);
  const rsize = data.readUInt32LE(o + 16);
  const raw = data.readUInt32LE(o + 20);
  sections.push({ name, vsize, va, rsize, raw });
}

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
    const va = imageBase + sec.va + (i - sec.raw);
    let line = `  0x${va.toString(16).padStart(8, '0')}  [${sec.name.padEnd(8)}]  raw=0x${i.toString(16)}  ${needle.toString('hex')}`;
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
