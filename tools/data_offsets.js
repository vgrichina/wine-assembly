#!/usr/bin/env node
// Print the address of every NUL-terminated string inside a WAT (data ...)
// segment. Ordinal-import tables in src/08b-dll-loader.wat address these
// strings by absolute offset, so an inserted or renamed name silently
// shifts every later entry — this is how you check that the offsets a
// lookup table uses still name what they claim to.
//
// Usage: node tools/data_offsets.js <file.wat> 0xBASE
//        node tools/data_offsets.js src/01-header.wat 0x11300
//        node tools/data_offsets.js src/01-header.wat 0x11300 --check=0x113BF

'use strict';

const fs = require('fs');

const [, , file, baseArg, ...rest] = process.argv;
if (!file || !baseArg) {
  console.error('usage: node tools/data_offsets.js <file.wat> 0xBASE [--check=0xADDR]');
  process.exit(2);
}
const base = parseInt(baseArg, 16 | 0) || Number(baseArg);
const checks = rest
  .filter(a => a.startsWith('--check='))
  .flatMap(a => a.slice(8).split(',').map(v => parseInt(v, 16) || Number(v)));

const src = fs.readFileSync(file, 'utf8');
const needle = `(data (i32.const ${baseArg})`;
let at = src.indexOf(needle);
if (at < 0) {
  // Try a normalized numeric match so 0x11300 also finds 0X11300 / 70400.
  const re = new RegExp(`\\(data \\(i32\\.const (0x[0-9a-fA-F]+|\\d+)\\)`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const v = m[1].startsWith('0x') ? parseInt(m[1], 16) : Number(m[1]);
    if (v === base) { at = m.index; break; }
  }
}
if (at < 0) {
  console.error(`no (data ...) segment at ${baseArg} in ${file}`);
  process.exit(1);
}

const open = src.indexOf('"', at);
const close = src.indexOf('"', open + 1);
if (open < 0 || close < 0) {
  console.error('malformed data segment');
  process.exit(1);
}
const literal = src.slice(open + 1, close);

// WAT string literals escape bytes as \NN; everything else is one byte.
const bytes = [];
for (let i = 0; i < literal.length;) {
  if (literal[i] === '\\' && /[0-9a-fA-F]{2}/.test(literal.slice(i + 1, i + 3))) {
    bytes.push(parseInt(literal.slice(i + 1, i + 3), 16));
    i += 3;
  } else {
    bytes.push(literal.charCodeAt(i));
    i += 1;
  }
}

const hex = n => '0x' + n.toString(16).toUpperCase().padStart(5, '0');
const found = new Map();
let start = 0;
for (let i = 0; i < bytes.length; i++) {
  if (bytes[i] !== 0) continue;
  const s = String.fromCharCode(...bytes.slice(start, i));
  const addr = base + start;
  found.set(addr, s);
  console.log(`${hex(addr)}  "${s}"`);
  start = i + 1;
}
console.log(`${hex(base + bytes.length)}  <end>  (${bytes.length} bytes)`);

let bad = 0;
for (const c of checks) {
  if (found.has(c)) {
    console.log(`check ${hex(c)} -> "${found.get(c)}"`);
  } else {
    console.log(`check ${hex(c)} -> NOT a string start`);
    bad++;
  }
}
process.exit(bad ? 1 : 0);
