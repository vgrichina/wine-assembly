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
//
//   node tools/toyvm/dos-disasm.js --image=run.log@100:0 773:0560 --to=773:05c0
//
// ...and a static image is not always the code that runs. An overlaid program
// -- Turbo Pascal writes them, and ANGEL's SETUP.EXE is one -- fills whole
// segments at runtime, so the file has zeros where the interesting code will
// be and a disassembly of it says `add [bx+si], al` two hundred times.
// `--image=FILE@SEG:OFF` takes a `run-dos.js --dump=` hexdump instead and lays
// it down at that address, which is the same log the addresses were read out
// of. With no `@`, the dump is placed where --dump's own default puts it.

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

// A `--dump` hexdump back into bytes. The address column is an offset from the
// start of the dumped region, not a linear address, so where the region was
// taken from has to be said separately -- that is the `@SEG:OFF` half.
// Anything that is not a hexdump line is ignored, so the whole run log can be
// handed over rather than the operator having to cut the dump out of it.
function readDump(file) {
  const mem = [];
  for (const line of fs.readFileSync(file, 'latin1').split('\n')) {
    const m = /^\s*([0-9a-f]{4,8})\s+((?:[0-9a-f]{2} ){1,16})/i.exec(line);
    if (!m) continue;
    const at = parseInt(m[1], 16);
    const bytes = m[2].trim().split(/\s+/).map(b => parseInt(b, 16));
    for (let i = 0; i < bytes.length; i++) mem[at + i] = bytes[i];
  }
  if (!mem.length) throw new Error(`no hexdump lines in ${file}`);
  return mem;
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const rest = args.filter(a => a !== file && !a.startsWith('--'));
  const to = args.find(a => a.startsWith('--to='));
  const image = args.find(a => a.startsWith('--image='));
  if (!(file || image) || !rest.length) {
    console.log('usage: node tools/toyvm/dos-disasm.js <file.exe> SEG:OFF [count] [--to=SEG:OFF]');
    process.exit(2);
  }

  // The whole 1MB, so a segment anywhere in the image resolves by plain
  // arithmetic rather than by a section walk.
  const mem = Buffer.alloc(1 << 20);
  const buf = file ? fs.readFileSync(file) : Buffer.alloc(0);
  let entry = { cs: LOAD_SEG, ip: 0 };
  if (!file) {
    // Nothing to load: the memory image IS the program.
  } else if (buf[0] === 0x4D && buf[1] === 0x5A) {
    entry = loadExe(mem, buf);
  } else {
    // .COM: the image is the file, loaded at PSP:0100.
    buf.copy(mem, (PSP_SEG << 4) + 0x100);
    entry = { cs: PSP_SEG, ip: 0x100 };
  }
  // After the static load, never before: where the two overlap, what the
  // machine had at run time is the answer and the file is the stale copy.
  if (image) {
    const [dump, where] = image.slice(8).split('@');
    const put = parseAddr(where === undefined ? '100:0' : where);
    const base = (((put.seg === null ? 0 : put.seg) << 4) + put.off) & 0xFFFFF;
    const bytes = readDump(dump);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== undefined) mem[(base + i) & 0xFFFFF] = bytes[i];
    }
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
    // A branch target is printed linear too, and next to a seg:off address
    // column that is a trap: `jmp 0x1b4f` on the line labelled 100:0120 is the
    // instruction at 100:0b4f, and reading it as an offset sends you to the
    // wrong disassembly twice before you notice the constant 0x1000 gap.
    const text = m[3].replace(/((?:^|\s)(?:j\w+|call|loop\w*)\s+(?:short\s+|near\s+)?)0x([0-9a-f]+)$/,
      (_, head, hex) => `${head}${seg.toString(16)}:`
        + `${(parseInt(hex, 16) - (seg << 4)).toString(16).padStart(4, '0')}`);
    console.log(`${seg.toString(16)}:${(lin - (seg << 4)).toString(16).padStart(4, '0')}`
      + `  ${text}`);
  }
}

main();
