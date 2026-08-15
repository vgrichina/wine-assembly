#!/usr/bin/env node
// List the internal files of a Windows HLP file and decode its |SYSTEM
// tagged records.
//
//   node tools/hlp-dir.js <file.hlp> [--system] [--dump=|NAME]
//
// Every WAT-side HLP feature starts with "does this file even carry the
// internal file that feature reads?" - A-keyword macros need |AWBTREE,
// PlayWave needs baggage, HC30 files carry |Phrases + |TOMAP instead of
// |PhrIndex + |CONTEXT. This prints that inventory directly instead of
// inferring it from a parse failure.
'use strict';
const fs = require('fs');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('usage: node tools/hlp-dir.js <file.hlp> [--system] [--dump=|NAME]');
  process.exit(2);
}
const wantSystem = args.includes('--system');
const dumpArg = args.find(a => a.startsWith('--dump='));
const dumpName = dumpArg ? dumpArg.slice('--dump='.length) : null;

const data = new Uint8Array(fs.readFileSync(file));
const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
const u16 = off => dv.getUint16(off, true);
const u32 = off => dv.getUint32(off, true);
const str = (off, len) => {
  let s = '';
  for (let i = 0; i < len && off + i < data.length; i++) {
    const c = data[off + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
};

if (u32(0) !== 0x00035F3F) {
  console.error(`not an HLP file: magic=0x${u32(0).toString(16)}`);
  process.exit(1);
}
const dirOff = u32(4);

// B+tree header of the internal-file directory, then a walk of every leaf.
const btree = dirOff + 9;
if (u16(btree) !== 0x293B) {
  console.error(`bad directory B+tree magic 0x${u16(btree).toString(16)}`);
  process.exit(1);
}
const pageSize = u16(btree + 4);
const nLevels = u16(btree + 32);
const rootPage = u16(btree + 26);
const pagesStart = btree + 38;

function leafPage(page, level) {
  const off = pagesStart + page * pageSize;
  if (level >= nLevels) return page;
  // Index page: NEntries, PreviousPage, then (name, page) pairs.
  const n = u16(off + 2);
  let p = u16(off + 4);
  let cur = off + 6;
  for (let i = 0; i < n; i++) {
    const name = str(cur, pageSize);
    cur += name.length + 1;
    const child = u16(cur);
    cur += 2;
    void name;
    void child;
  }
  // Only the leftmost descent is needed: leaves chain through NextPage.
  return leafPage(p, level + 1);
}

const entries = [];
let page = leafPage(rootPage, 1);
while (page !== 0xFFFF) {
  const off = pagesStart + page * pageSize;
  const n = u16(off + 2);
  let cur = off + 8;
  for (let i = 0; i < n; i++) {
    const name = str(cur, pageSize);
    cur += name.length + 1;
    entries.push({ name, offset: u32(cur) });
    cur += 4;
  }
  page = u16(off + 6);
}

const byName = new Map();
for (const e of entries) {
  e.used = e.offset + 8 < data.length ? u32(e.offset + 4) : 0;
  e.reserved = e.offset + 4 < data.length ? u32(e.offset) : 0;
  byName.set(e.name, e);
}

console.log(`${file}: ${entries.length} internal files`);
for (const e of entries) {
  console.log(`  ${e.name.padEnd(22)} off=0x${e.offset.toString(16).padStart(6, '0')}  used=${e.used}`);
}

const SYSTEM_RECORD = {
  1: 'title', 2: 'copyright', 3: 'contents', 4: 'macro', 5: 'icon',
  6: 'window', 8: 'citation', 9: 'lcid', 10: 'content-charset',
  11: 'defont', 12: 'ftindex', 13: 'groups', 14: 'index-separators',
  18: 'language', 19: 'dllmaps',
};

const sys = byName.get('|SYSTEM');
if (sys && (wantSystem || true)) {
  const base = sys.offset + 9;
  console.log(`\n|SYSTEM magic=0x${u16(base).toString(16)} minor=${u16(base + 2)} major=${u16(base + 4)} date=${u32(base + 6)} flags=0x${u16(base + 10).toString(16)}`);
  let off = base + 12;
  const end = base + sys.used;
  while (off + 4 <= end) {
    const type = u16(off);
    const size = u16(off + 2);
    if (size === 0 && type === 0) break;
    if (off + 4 + size > end) {
      console.log(`  !! record type=${type} size=${size} overruns the file`);
      break;
    }
    const label = SYSTEM_RECORD[type] || `type${type}`;
    let detail = '';
    if (type === 1 || type === 2 || type === 4 || type === 8) {
      detail = ` ${JSON.stringify(str(off + 4, size))}`;
    } else if (type === 6) {
      detail = ` name=${JSON.stringify(str(off + 16, 9))} caption=${JSON.stringify(str(off + 25, 51))}`;
    } else if (size <= 8) {
      detail = ' ' + Array.from(data.subarray(off + 4, off + 4 + size))
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
    }
    console.log(`  [${type}] ${label.padEnd(16)} size=${size}${detail}`);
    off += 4 + size;
  }
}

if (dumpName) {
  const e = byName.get(dumpName);
  if (!e) {
    console.error(`\nno internal file named ${dumpName}`);
    process.exit(1);
  }
  console.log(`\n=== ${dumpName} (${e.used} bytes) ===`);
  const body = data.subarray(e.offset + 9, e.offset + 9 + e.used);
  for (let i = 0; i < body.length; i += 16) {
    const row = body.subarray(i, i + 16);
    const hex = Array.from(row).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(row).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
    console.log(`  ${i.toString(16).padStart(6, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
}
