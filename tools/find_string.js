#!/usr/bin/env node
// Find every occurrence of a string literal in a PE and print the VA(s).
// Usage: node tools/find_string.js <pe-file> "<literal>" [--utf16] [--all]
//
//   --utf16   search for UTF-16LE encoding (default ASCII)
//   --all     also list matches that fall outside any section (raw file matches);
//             default is to print only matches that map to a section VA.
//
// Prints one match per line:  0xVA  [section]  "<literal>"
// Exits 1 if no matches are found.

const fs = require('fs');
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const file = positional[0];
const literal = positional[1];
const utf16 = args.includes('--utf16');
const all = args.includes('--all');

if (!file || literal === undefined) {
  console.error('Usage: find_string.js <pe-file> "<literal>" [--utf16] [--all]');
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

function fileToVa(fo) {
  for (const s of sections) {
    if (fo >= s.rawOff && fo < s.rawOff + s.rawSize) {
      return { va: imageBase + s.vaddr + (fo - s.rawOff), section: s.name };
    }
  }
  return null;
}

const needle = utf16
  ? Buffer.from(literal, 'utf16le')
  : Buffer.from(literal, 'binary');

const matches = [];
let pos = 0;
while (true) {
  const i = buf.indexOf(needle, pos);
  if (i < 0) break;
  matches.push(i);
  pos = i + 1;
}

if (matches.length === 0) {
  console.error(`No matches for ${utf16 ? 'UTF-16LE ' : ''}"${literal}" in ${file}`);
  process.exit(1);
}

let printed = 0;
for (const fo of matches) {
  const m = fileToVa(fo);
  if (!m) {
    if (all) console.log(`  raw=0x${fo.toString(16)}  [outside-section]  "${literal}"`);
    continue;
  }
  console.log(`  0x${m.va.toString(16).padStart(8,'0')}  [${m.section.padEnd(8)}]  raw=0x${fo.toString(16)}  "${literal}"`);
  printed++;
}

if (printed === 0 && !all) {
  console.error(`Found ${matches.length} raw match(es) but none inside a section. Re-run with --all to list them.`);
  process.exit(1);
}
