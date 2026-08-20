#!/usr/bin/env node
// Print the WAT-private memory map, and the gaps in it.
//
//   node tools/wat-memory-map.js              # the whole map, with gaps
//   node tools/wat-memory-map.js --free=1024  # only gaps of at least N bytes
//   node tools/wat-memory-map.js --check=0x11300:0x100   # is this range free?
//
// Every table below GUEST_BASE is placed by hand at a literal address, and the
// addresses live in whichever src/*.wat owns the feature — GDI_BITMAP_FONT_TABLE
// is in 10b-gdi-font.wat, the string constants are (data ...) segments in
// 01-header.wat. Picking an address by reading one file is how a table ends up
// on top of another one: it has happened twice in a day, once over the bitmap
// font table (every loaded strike corrupted, menus crashing in
// $gdi_bitmap_font_parse_file) and once over the dialog button captions
// (windows erasing "OK" and "Cancel" out of memory at creation).
//
// A region is counted when a global's name ends in a known table suffix and a
// matching _SIZE global exists; sized data segments are counted from their
// literal contents. Globals with no size are listed as points, because a bare
// address tells us something is there even when its extent is unknown.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const MIN_FREE = Number(arg('free', 0));
const CHECK = arg('check', '');

// Data segments are written as WAT strings: \NN escapes are one byte, and a
// backslash-escaped quote is one byte too.
function dataLength(literal) {
  let n = 0;
  for (let i = 0; i < literal.length; i++) {
    if (literal[i] === '\\') {
      // \NN hex escape, or \" \\ \t \n \r
      if (/[0-9a-fA-F]/.test(literal[i + 1] || '') && /[0-9a-fA-F]/.test(literal[i + 2] || '')) i += 2;
      else i += 1;
    }
    n++;
  }
  return n;
}

function collect() {
  const regions = [];
  for (const file of fs.readdirSync(SRC).sort()) {
    if (!file.endsWith('.wat')) continue;
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    const lines = text.split('\n');

    // Address globals, and their _SIZE partners wherever they are declared.
    const addrs = new Map();
    const sizes = new Map();
    lines.forEach((line, i) => {
      const m = /\(global \$([A-Za-z0-9_]+)\s+i32\s+\(i32\.const\s+(0x[0-9a-fA-F]+|\d+)\)/.exec(line);
      if (!m) return;
      const [, name, value] = m;
      const v = Number(value);
      if (/_SIZE$/.test(name)) sizes.set(name.replace(/_SIZE$/, ''), v);
      else if (v >= 0x100 && v < 0x08000000) addrs.set(name, { v, file, line: i + 1 });
    });
    for (const [name, at] of addrs) {
      regions.push({ name, start: at.v, size: sizes.get(name) ?? null,
                     file: at.file, line: at.line, kind: 'global' });
    }

    // Data segments.
    lines.forEach((line, i) => {
      const m = /\(data \(i32\.const\s+(0x[0-9a-fA-F]+|\d+)\)\s+"((?:[^"\\]|\\.)*)"/.exec(line);
      if (!m) return;
      regions.push({ name: `(data)`, start: Number(m[1]), size: dataLength(m[2]),
                     file, line: i + 1, kind: 'data' });
    });
  }
  return regions.sort((a, b) => a.start - b.start || (a.size ?? 0) - (b.size ?? 0));
}

const hex = (n) => `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;

function main() {
  const regions = collect();

  if (CHECK) {
    const [startStr, lenStr] = CHECK.split(':');
    const start = Number(startStr);
    const len = Number(lenStr || 1);
    const end = start + len;
    const hits = regions.filter(r => {
      const rEnd = r.start + (r.size ?? 1);
      return r.start < end && rEnd > start;
    });
    if (!hits.length) {
      console.log(`${hex(start)}..${hex(end)} is clear of every placed region.`);
      process.exit(0);
    }
    console.log(`${hex(start)}..${hex(end)} overlaps:`);
    for (const r of hits) {
      console.log(`  ${hex(r.start)} +${(r.size ?? 0).toString().padStart(6)}  ${r.name}`
        + `  (${r.file}:${r.line})`);
    }
    process.exit(1);
  }

  let prevEnd = 0;
  let prevName = 'start of memory';
  for (const r of regions) {
    if (MIN_FREE) {
      const gap = r.start - prevEnd;
      if (gap >= MIN_FREE && prevEnd) {
        console.log(`FREE ${hex(prevEnd)}..${hex(r.start)}  ${gap} bytes`
          + `  (after ${prevName})`);
      }
    } else {
      const gap = r.start - prevEnd;
      if (gap > 0 && prevEnd) console.log(`     ---- ${gap} bytes free ----`);
      console.log(`${hex(r.start)} +${(r.size ?? 0).toString().padStart(6)}`
        + `  ${r.name.padEnd(30)} ${r.file}:${r.line}`);
    }
    const end = r.start + (r.size ?? 0);
    if (end > prevEnd) { prevEnd = end; prevName = r.name; }
  }
}

main();
