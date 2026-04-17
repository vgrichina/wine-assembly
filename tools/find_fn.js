#!/usr/bin/env node
// Given an interior VA inside a function, find the function's entry by scanning
// backward for a prologue or padding boundary.
// Usage: node tools/find_fn.js <exe> <VA>[,VA,...]
//
// Heuristics (checked in order, nearest to VA wins):
//   1. Function-prologue signatures: 55 8B EC (push ebp; mov ebp,esp) or
//      55 8B EC 83 EC XX (... ; sub esp, imm) — very common in MSVC/Borland.
//   2. Bare-register prologues like `53 56 57 55 8B EC`? treat `55 8B EC` as primary.
//   3. Padding boundary: CC CC CC... (int3) or 90 90 90... (nop) followed by
//      something that isn't CC/90 — the first non-pad byte is an entry point.
//   4. Preceding `C3` (ret) / `C2 XX XX` (ret imm16) — the byte after is often entry.
//
// Prints, for each VA: its enclosing section, the chosen entry, how far back, and the reason.

const fs = require('fs');
const args = process.argv.slice(2);
const file = args[0];
const vaArg = args[1];
if (!file || !vaArg) { console.error('Usage: find_fn.js <exe> <VA>[,VA,...]'); process.exit(1); }
const vas = vaArg.split(',').map(s => parseInt(s, 16));

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
    vaddr: imageBase + buf.readUInt32LE(s + 12),
    vsize: buf.readUInt32LE(s + 8),
    rawOff: buf.readUInt32LE(s + 20),
    rawSize: buf.readUInt32LE(s + 16),
  });
}

function va2off(va) {
  for (const s of sections) {
    const size = Math.min(s.rawSize, s.vsize);
    if (va >= s.vaddr && va < s.vaddr + size) {
      return { off: va - s.vaddr + s.rawOff, sect: s };
    }
  }
  return null;
}

const MAX_BACKSCAN = 0x4000;  // 16 KB — plenty for any sane function

function findEntry(va) {
  const loc = va2off(va);
  if (!loc) return { err: 'VA not in any section' };
  const { off, sect } = loc;
  const floor = Math.max(sect.rawOff, off - MAX_BACKSCAN);

  for (let i = off; i >= floor; i--) {
    const b = buf[i];
    // Prologue: 55 8B EC
    if (b === 0x55 && buf[i+1] === 0x8B && buf[i+2] === 0xEC) {
      return { entry: sect.vaddr + (i - sect.rawOff), distance: off - i, reason: 'prologue (push ebp; mov ebp,esp)' };
    }
    // Padding boundary: previous ≥2 bytes are CC (or ≥2 are 90), current is neither → entry.
    // Requiring two is important: a lone CC/90 is usually a byte inside a disp32 or imm, not padding.
    if (b !== 0xCC && b !== 0x90 && i - 2 >= sect.rawOff) {
      const p1 = buf[i - 1], p2 = buf[i - 2];
      if ((p1 === 0xCC && p2 === 0xCC) || (p1 === 0x90 && p2 === 0x90)) {
        return { entry: sect.vaddr + (i - sect.rawOff), distance: off - i, reason: `after padding (${p1 === 0xCC ? 'int3' : 'nop'} run)` };
      }
    }
    // ret boundary: preceding byte is C3 (ret) or C2 XX XX (ret imm16)
    if (i - 1 >= sect.rawOff && buf[i - 1] === 0xC3) {
      return { entry: sect.vaddr + (i - sect.rawOff), distance: off - i, reason: 'after ret (C3)' };
    }
    if (i - 3 >= sect.rawOff && buf[i - 3] === 0xC2) {
      // C2 XX XX ?? — candidate; accept if i is entry
      return { entry: sect.vaddr + (i - sect.rawOff), distance: off - i, reason: 'after retn imm16 (C2)' };
    }
  }
  return { err: `no prologue/boundary within ${MAX_BACKSCAN} bytes` };
}

for (const va of vas) {
  const r = findEntry(va);
  const head = `0x${va.toString(16).padStart(8, '0')}`;
  if (r.err) {
    console.log(`${head}  ERROR: ${r.err}`);
    continue;
  }
  console.log(`${head}  entry=0x${r.entry.toString(16).padStart(8, '0')}  (-${r.distance} bytes)  ${r.reason}`);
}
