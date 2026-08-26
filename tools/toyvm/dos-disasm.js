#!/usr/bin/env node

'use strict';

// Disassemble a DOS program at a runtime seg:off.
//
//   node tools/toyvm/dos-disasm.js <file.exe> 110:00da [count=24]
//   node tools/toyvm/dos-disasm.js <file.exe> 110:00da --to=110:0120
//
// Every other disassembler here assumes a 32-bit PE (`disasm_fn.js` goes
// through `readPE`) or a 16-bit NE (`ne-dump.js`), and neither can open an MZ.
// This loads the image exactly the way the VM does -- same load segment, same
// relocations applied -- so an address out of a `--trace-int` line or a
// `stuck at` report can be pasted straight in and means the same thing.
//
// A .COM is loaded at PSP:0100 with no header and no fixups, which is handled
// too: the extension decides, and a file whose first two bytes are not "MZ" is
// treated as a .COM whatever it is called.

const fs = require('fs');
const path = require('path');
const { disasmAt } = require('../disasm');
const { loadExe, LOAD_SEG, PSP_SEG } = require('./dos');

function parseAddr(s) {
  const m = /^(?:([0-9a-fA-F]+):)?(?:0x)?([0-9a-fA-F]+)$/.exec(String(s).trim());
  if (!m) throw new Error(`not a seg:off address: ${s}`);
  return m[1] === undefined
    ? { seg: null, off: parseInt(m[2], 16) }
    : { seg: parseInt(m[1], 16), off: parseInt(m[2], 16) };
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const rest = args.filter(a => a !== file && !a.startsWith('--'));
  const to = args.find(a => a.startsWith('--to='));
  if (!file || !rest.length) {
    console.log('usage: node tools/toyvm/dos-disasm.js <file.exe> SEG:OFF [count] [--to=SEG:OFF]');
    process.exit(2);
  }

  // The whole 1MB, so a segment anywhere in the image resolves by plain
  // arithmetic rather than by a section walk.
  const mem = Buffer.alloc(1 << 20);
  const buf = fs.readFileSync(file);
  let entry;
  if (buf[0] === 0x4D && buf[1] === 0x5A) {
    entry = loadExe(mem, buf);
  } else {
    // .COM: the image is the file, loaded at PSP:0100.
    buf.copy(mem, (PSP_SEG << 4) + 0x100);
    entry = { cs: PSP_SEG, ip: 0x100 };
  }

  const at = parseAddr(rest[0]);
  const seg = at.seg === null ? entry.cs : at.seg;
  const start = ((seg << 4) + at.off) & 0xFFFFF;
  let count = rest[1] ? Number(rest[1]) : 24;
  if (to) {
    const end = parseAddr(to.slice(5));
    // Instruction count is not known ahead of a variable-length decode, so
    // over-ask and trim on the printed address.
    count = Math.max(1, Math.min(4096, ((end.seg === null ? seg : end.seg) << 4)
      + end.off - start));
  }

  console.log(`${path.basename(file)}  entry ${entry.cs.toString(16)}:`
    + `${entry.ip.toString(16)}  load seg ${LOAD_SEG.toString(16)}`);
  const lines = disasmAt(mem, start, start, count, null, { bits: 16 });
  const limit = to ? (((parseAddr(to.slice(5)).seg ?? seg) << 4)
    + parseAddr(to.slice(5)).off) : Infinity;
  for (const line of lines) {
    // disasmAt prints a linear address; relabel it as the seg:off the guest
    // and every trace line use.
    const m = /^([0-9a-f]+)(\s+)(.*)$/.exec(line.trim());
    if (!m) { console.log(line); continue; }
    const lin = parseInt(m[1], 16);
    if (lin >= limit) break;
    console.log(`${seg.toString(16)}:${(lin - (seg << 4)).toString(16).padStart(4, '0')}`
      + `  ${m[3]}`);
  }
}

main();
