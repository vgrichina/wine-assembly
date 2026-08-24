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
//
// --why replaces the per-block dump with a decline histogram: each block is
// run through the same staged gates $loop_try_lut applies, and charged to the
// FIRST gate it fails. This is the runtime counterpart of
// `tools/match-loops.js --why`, which sees a linear disassembly of the PE;
// this one sees the ops the decoder actually emitted, fusions and all, for
// blocks that actually executed. Add --why-list to name the blocks per bucket.
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

// Roles, mirroring $loop_role in src/07b-loop-match.wat. Keep in step with it:
// a role added there and not here makes this tool over-report declines.
const ROLE = { UNKNOWN: 0, LOAD8: 1, LOAD8S: 2, STORE8: 3, ADDI: 4, ZERO: 5, MIRROR: 6, JCC: 7 };
const isJcc = fn => fn === 44 || (fn >= 307 && fn <= 322);

function roleOf(fn, op) {
  if (fn === 28) return ROLE.LOAD8;
  if (fn === 149) return (op & 0x100) ? ROLE.LOAD8S : ROLE.UNKNOWN;
  if (fn === 29) return ROLE.STORE8;
  if (fn === 64 || fn === 65) return ROLE.ADDI;
  if (fn === 18 || fn === 17) return ((op >>> 4) === (op & 0xF)) ? ROLE.ZERO : ROLE.UNKNOWN;
  if (fn === 21) return ROLE.MIRROR;
  if (isJcc(fn)) return ROLE.JCC;
  return ROLE.UNKNOWN;
}

// The gates of $loop_try_lut, in the order it applies them. Returns the name
// of the first one that fails, or null for a block that reaches the emit.
// The register-identity gates past the counting stage are approximated: the
// operand encodings this reads (reg<<4|base for the byte accesses, reg for
// inc/dec) are the ones the matcher reads too, but the displacement folding
// and mirror bookkeeping are not replayed here.
function declineReason(ops, names) {
  const n = ops.length;
  if (n < 7) return 'op-count<7';
  if (n > 16) return 'op-count>16';

  const roles = ops.map(([fn, op]) => roleOf(fn, op));
  const unknown = roles.indexOf(ROLE.UNKNOWN);
  if (unknown >= 0) return `unknown-op:${names.get(ops[unknown][0]) || ops[unknown][0]}`;

  const count = r => roles.filter(x => x === r).length;
  const loads = count(ROLE.LOAD8) + count(ROLE.LOAD8S);
  if (count(ROLE.ADDI) !== 2) return `addi-count=${count(ROLE.ADDI)}`;
  if (count(ROLE.ZERO) !== 1) return `zero-count=${count(ROLE.ZERO)}`;
  if (count(ROLE.STORE8) !== 1) return `store-count=${count(ROLE.STORE8)}`;
  if (loads !== 2) return `load-count=${loads}`;
  if (count(ROLE.LOAD8S) < 1) return 'no-indexed-load';

  const term = ops[n - 1][0];
  if (term !== 312) return `jcc-kind:${names.get(term) || term}`;

  // iv/ctr split: one inc/dec drives the cursor the byte accesses share, the
  // other is the trip counter the jnz reads.
  const st = ops[roles.indexOf(ROLE.STORE8)];
  const ld = ops[roles.indexOf(ROLE.LOAD8)];
  if (!ld) return 'no-plain-load';
  const stBase = st[1] & 0xF, ldBase = ld[1] & 0xF;
  if (stBase !== ldBase) return 'load/store-base-differ';
  const addiRegs = ops.filter((_, i) => roles[i] === ROLE.ADDI).map(o => o[1] & 0x7);
  if (!addiRegs.includes(stBase)) return 'cursor-not-stepped';
  if (addiRegs[0] === addiRegs[1]) return 'no-separate-counter';
  return null;
}

function whyReport(blocks, names, list) {
  const buckets = new Map();
  for (const b of blocks) {
    const why = declineReason(b.ops, names) || 'MATCH';
    if (!buckets.has(why)) buckets.set(why, []);
    buckets.get(why).push(b.eip);
  }
  const rows = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  const total = blocks.length;
  console.log(`${total} unique self-loop block shapes\n`);
  for (const [why, eips] of rows) {
    const pct = (eips.length * 100 / total).toFixed(1);
    console.log(`${String(eips.length).padStart(5)}  ${pct.padStart(5)}%  ${why}`);
    if (list) {
      const shown = eips.slice(0, 8).map(e => '0x' + e.toString(16)).join(' ');
      console.log(`                ${shown}${eips.length > 8 ? ` (+${eips.length - 8} more)` : ''}`);
    }
  }
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

  if (args.includes('--why')) {
    // A decline histogram over repeated copies of one block says more about
    // how often that block was decoded than about the matcher, so dedupe by
    // shape first regardless of --uniq.
    const byShape = new Map();
    for (const b of blocks) {
      if (wantEip !== null && b.eip !== wantEip) continue;
      const key = b.ops.map(o => `${o[0]}:${o[1]}`).join(',');
      if (!byShape.has(key)) byShape.set(key, b);
    }
    whyReport([...byShape.values()], names, args.includes('--why-list'));
    return;
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
