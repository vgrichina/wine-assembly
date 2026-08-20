#!/usr/bin/env node
// Dump the data segments of a compiled wasm module.
//
// tools/data_offsets.js answers "what string does this address name in the
// .wat source". This answers the other half: what the *compiled* module
// actually has there. The two can disagree — a segment the compiler dropped,
// merged, or placed at a different offset is invisible in the source and
// silently turns a string compare into a compare against zeros.
//
// Usage:
//   node tools/wasm-data.js build/wine-assembly.wasm            # list segments
//   node tools/wasm-data.js build/wine-assembly.wasm 0x316A 32  # bytes at addr
//   node tools/wasm-data.js build/wine-assembly.wasm --overlaps # build gate
//
// --overlaps exits non-zero when two segments cover the same byte. A later
// segment wins at instantiation time, so an overlap silently eats the NUL
// terminator of the string before it: "SysTreeView32\0" at 0x316B followed by
// "SysLink\0" at 0x3178 made every SysTreeView32 compare fail, and Winamp's
// preferences tree quietly fell back to the app's own wndproc.

const fs = require('fs');

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const checkOverlaps = args.includes('--overlaps');
const file = positional[0] || 'build/wine-assembly.wasm';
const at = positional[1] !== undefined ? parseInt(positional[1], 16) : null;
const len = positional[2] !== undefined ? parseInt(positional[2], 10) : 32;

const buf = fs.readFileSync(file);
if (buf.readUInt32LE(0) !== 0x6d736100) {
  console.error(`${file}: not a wasm module`);
  process.exit(1);
}

let p = 8;
function uleb() {
  let result = 0, shift = 0, b;
  do { b = buf[p++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  return result >>> 0;
}
function sleb() {
  let result = 0, shift = 0, b;
  do { b = buf[p++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  if (shift < 32 && (b & 0x40)) result |= -(1 << shift);
  return result;
}

const segments = [];
while (p < buf.length) {
  const id = buf[p++];
  const size = uleb();
  const end = p + size;
  if (id === 11) { // data section
    const count = uleb();
    for (let i = 0; i < count; i++) {
      const flags = uleb();
      let offset = 0;
      if (flags === 0 || flags === 2) {
        if (flags === 2) uleb(); // memory index
        // Constant expression: i32.const <sleb> end
        if (buf[p] !== 0x41) { console.error('unsupported data offset expr'); process.exit(1); }
        p++;
        offset = sleb();
        if (buf[p] !== 0x0b) { console.error('unterminated data offset expr'); process.exit(1); }
        p++;
      }
      const n = uleb();
      segments.push({ offset, bytes: buf.slice(p, p + n) });
      p += n;
    }
  }
  p = end;
}

segments.sort((a, b) => a.offset - b.offset);

if (checkOverlaps) {
  const show = s => JSON.stringify(s.bytes.toString('latin1').replace(/\0/g, '\\0').slice(0, 32));
  let bad = 0;
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1], cur = segments[i];
    const prevEnd = prev.offset + prev.bytes.length;
    if (prevEnd > cur.offset) {
      bad++;
      console.error(`OVERLAP: 0x${prev.offset.toString(16)}+${prev.bytes.length} (ends 0x${prevEnd.toString(16)})`
        + ` runs into 0x${cur.offset.toString(16)}`);
      console.error(`  ${show(prev)}  vs  ${show(cur)}`);
    }
  }
  if (bad) {
    console.error(`${file}: ${bad} overlapping data segment(s) — the later one overwrites the earlier one's tail.`);
    process.exit(1);
  }
  console.log(`wasm-data: ${segments.length} data segments, no overlaps`);
  process.exit(0);
}

if (at === null) {
  console.log(`${file}: ${segments.length} data segments`);
  for (const s of segments) {
    const printable = s.bytes.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
    console.log(`  0x${s.offset.toString(16).padStart(8, '0')}  ${String(s.bytes.length).padStart(7)} bytes  ${printable.slice(0, 60)}`);
  }
  process.exit(0);
}

// Bytes at an address, across whichever segments cover it. Anything not
// covered by a segment is zero at runtime, and printed as `--` here so a
// missing segment cannot masquerade as a segment full of NULs.
const out = Buffer.alloc(len);
const covered = new Uint8Array(len);
for (const s of segments) {
  for (let i = 0; i < len; i++) {
    const a = at + i;
    if (a >= s.offset && a < s.offset + s.bytes.length) {
      out[i] = s.bytes[a - s.offset];
      covered[i] = 1;
    }
  }
}
for (let off = 0; off < len; off += 16) {
  let hexPart = '', ascPart = '';
  for (let i = 0; i < 16 && off + i < len; i++) {
    hexPart += covered[off + i] ? out[off + i].toString(16).padStart(2, '0') + ' ' : '-- ';
    const b = out[off + i];
    ascPart += covered[off + i] && b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  }
  console.log(`  0x${(at + off).toString(16).padStart(8, '0')}  ${hexPart.padEnd(49)}${ascPart}`);
}
