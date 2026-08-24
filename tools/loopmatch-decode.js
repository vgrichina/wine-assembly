#!/usr/bin/env node
// Decode the --trace-loopmatch stream from a test/run.js log into readable
// blocks: one entry per self-loop block the decoder emitted, with each op as
// (handler index, handler name, operand).
//
// The raw trace is a flat sequence of [i32] host-log words, because that is
// the only channel a decode-time WAT function has. This turns it back into
// structure and names the handlers from src/02-thread-table.wat, so a decline
// can be read directly instead of cross-referenced by hand.
//
//   node tools/loopmatch-decode.js <run.js log> [--eip=0x4c755d] [--uniq]
const fs = require('fs');
const path = require('path');

const MARKER = 0x100b0000;

// handler index -> name, straight from the (elem ...) block. The table is the
// source of truth; parsing it means this tool cannot drift from a renumber.
function handlerNames() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', '02-thread-table.wat'), 'utf8');
  const names = new Map();
  for (const line of src.split('\n')) {
    const m = /^\s*\$(\w+)\s*;;\s*(\d+)/.exec(line);
    if (m) names.set(parseInt(m[2], 10), m[1]);
  }
  return names;
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: loopmatch-decode.js <log> [--eip=0xVA] [--uniq]'); process.exit(1); }
  const opt = n => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
  const wantEip = opt('eip') ? parseInt(opt('eip'), 16) >>> 0 : null;
  const uniq = args.includes('--uniq');

  const names = handlerNames();
  const words = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\[i32\] (0x[0-9a-f]+)/.exec(line);
    if (m) words.push(parseInt(m[1], 16) >>> 0);
  }

  const blocks = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== MARKER) continue;
    const eip = words[i + 1], n = words[i + 2];
    if (n === undefined || n > 2048) continue;
    if (i + 3 + n * 2 > words.length) continue;
    const ops = [];
    for (let k = 0; k < n; k++) ops.push([words[i + 3 + k * 2], words[i + 4 + k * 2]]);
    blocks.push({ eip, ops });
    i += 2 + n * 2;
  }

  const seen = new Set();
  let shown = 0;
  for (const b of blocks) {
    if (wantEip !== null && b.eip !== wantEip) continue;
    const key = b.ops.map(o => o[0]).join(',');
    if (uniq) { if (seen.has(key)) continue; seen.add(key); }
    console.log(`block 0x${b.eip.toString(16)}  ${b.ops.length} ops`);
    for (const [fn, op] of b.ops) {
      console.log(`   ${String(fn).padStart(4)}  ${(names.get(fn) || '?').padEnd(22)} op=0x${op.toString(16)}`);
    }
    shown++;
  }
  console.log(`\n${blocks.length} self-loop block records, ${shown} shown`);
}

main();
