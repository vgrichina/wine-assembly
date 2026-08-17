#!/usr/bin/env node
// 16-bit disassembler for NE (New Executable) segments.
//
//   node tools/ne-disasm.js <file.exe> <seg>:<off>[,<seg>:<off>...] [count=24]
//   node tools/ne-disasm.js <file.exe> 0x109b5f [count]      (runtime arena address)
//   node tools/ne-disasm.js <file.exe> --arena=0x100000 ...  (default 0x100000)
//
// Every other disassembly tool here assumes a 32-bit image, so a Win16 trace
// hit used to be read through a 32-bit decoder — which turns `c4 1f`
// (les bx,[bx]) into `db 0xc4` + `pop ds` and every [bp+n] into [esi+n]. This
// prints what the emulator actually executes.
//
// Segment relocations are resolved and shown inline, so an import call reads
// as `call far 0000:0000  ; KERNEL.91 INITTASK` instead of a hole. Relocation
// chains are followed, so every site a fixup patches is annotated, not just
// the head of its chain.

const fs = require('fs');
const path = require('path');
const { parse, segRelocs } = require('./ne-dump');
const { disasmAt } = require('./disasm');

const ORDINALS_PATH = path.join(__dirname, '..', 'src', 'win16-ordinals.generated.json');

function loadOrdinals() {
  try { return JSON.parse(fs.readFileSync(ORDINALS_PATH, 'utf8')); } catch (e) { return null; }
}

// Map every patched offset in a segment to the name of what it points at.
// A non-additive record stores the head of a chain in the image; each link
// holds the offset of the next site, terminated by 0xFFFF.
function relocMap(b, h, seg) {
  const map = new Map();
  for (const r of segRelocs(b, h, seg)) {
    const label = `${r.target}${r.addrType === 'FAR_ADDR' ? '' : ' (' + r.addrType + ')'}`;
    if (r.additive) { map.set(r.offset, label); continue; }
    let off = r.offset;
    for (let guard = 0; guard < 4096; guard++) {
      if (off === 0xffff || off + 2 > seg.length) break;
      if (map.has(off)) break;
      map.set(off, label);
      const next = b.readUInt16LE(seg.filePos + off);
      if (next === off) break;
      off = next;
    }
  }
  return map;
}

function nameOrdinal(ord, target) {
  // target looks like "KERNEL.#91"; give it the export's name when we know it.
  const m = /^([A-Za-z0-9_]+)\.#(\d+)$/.exec(target);
  if (!m || !ord) return target;
  const mod = ord.modules[m[1].toUpperCase()];
  const name = mod && mod.ordinals[m[2]];
  return name ? `${m[1]}.${m[2]} ${name}` : target;
}

function main() {
  const argv = process.argv.slice(2);
  let arena = 0x100000;
  const rest = argv.filter((a) => {
    const m = /^--arena=(?:0x)?([0-9a-fA-F]+)$/.exec(a);
    if (m) { arena = parseInt(m[1], 16); return false; }
    return true;
  });
  const file = rest[0];
  const spec = rest[1];
  const count = parseInt(rest[2] || '24', 10);
  if (!file || !spec) {
    console.error('Usage: node tools/ne-disasm.js <file.exe> <seg>:<off>[,...] [count=24]');
    console.error('       node tools/ne-disasm.js <file.exe> 0xLINEAR [count]   (arena address)');
    process.exit(1);
  }

  const { b, h } = parse(file);
  const ord = loadOrdinals();
  const cache = new Map();

  for (const one of spec.split(',')) {
    let segIndex, off;
    const c = one.indexOf(':');
    if (c >= 0) {
      segIndex = parseInt(one.slice(0, c), 10);
      off = parseInt(one.slice(c + 1), 16);
    } else {
      const linear = parseInt(one, 16);
      if (linear < arena) {
        console.error(`${one}: below the arena base 0x${arena.toString(16)}`
          + ' — pass <seg>:<off> or set --arena=');
        process.exit(1);
      }
      segIndex = ((linear - arena) >>> 16) + 1;
      off = linear & 0xffff;
    }
    const seg = h.segments[segIndex - 1];
    if (!seg) { console.error(`no segment ${segIndex} (image has ${h.segments.length})`); process.exit(1); }
    if (off >= seg.length) {
      console.error(`seg ${segIndex}:0x${off.toString(16)} is past the segment's `
        + `0x${seg.length.toString(16)} bytes`);
      process.exit(1);
    }
    if (!cache.has(segIndex)) cache.set(segIndex, relocMap(b, h, seg));
    const fixups = cache.get(segIndex);

    console.log(`\n${path.basename(file)}  seg ${segIndex}:0x${off.toString(16)}`
      + `  (arena 0x${(arena + (segIndex - 1) * 0x10000 + off).toString(16)})`
      + `${seg.flags & 0x0001 ? '  DATA' : ''}`);
    const lines = disasmAt(b, seg.filePos + off, off, count, null, { bits: 16 });
    for (const line of lines) {
      const at = parseInt(line.trim().split(/\s/)[0], 16);
      // A fixup patches operand bytes, never the opcode, so look inside the
      // instruction rather than only at its first byte.
      let note = null;
      const raw = line.slice(10, 38).trim().split(/\s+/).length;
      for (let i = 0; i < raw && !note; i++) note = fixups.get(at + i) || null;
      console.log(note ? `${line.padEnd(60)} ; ${nameOrdinal(ord, note)}` : line);
    }
  }
}

if (require.main === module) main();
