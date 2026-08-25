#!/usr/bin/env node
'use strict';

// OBSOLETE. This tool models the direct-mapped *hash* block-cache index, and
// that index no longer exists: docs/page-compile-design.md section 4 replaced it
// with the per-page byte index, which is exact and cannot alias. There is no
// $CACHE_MASK in src/01-header.wat any more, so --mask is now mandatory and the
// tool answers a what-if about a structure the build does not have.
//
// Kept because the analysis it does -- distinct blocks vs slots, and the cost of
// each collision measured in hits into the loser -- is the right shape for the
// question the page directory now raises: PAGE_INDEX_SLOTS is 128 per thread and
// two hot code pages 128 pages apart evict each other exactly the way two hot
// blocks used to. Retargeting it at the directory is a small edit (the index is
// (page >> 12) % PAGE_INDEX_SLOTS) and nobody has needed it yet; until then, use
// the `pages: compiled N` and `cache: ... evicted N` counters run.js prints.
//
// --- original description, for the structure that is gone ---
//
// Does the block cache alias an app's hot blocks, or is it simply too small?
//
// The block cache index is direct-mapped: slot = (ga ^ (ga >>> 12)) & CACHE_MASK.
// Those are two different failures and only one is fixed by more slots:
//
//   * too small   -- distinct blocks > slots. Nothing to do but grow the index.
//   * aliasing    -- distinct blocks << slots, yet hot blocks share a slot and
//                    evict each other on every entry. Growing the index may not
//                    help at all; a better index will.
//
// `test/run.js --handler-hist --handler-hist-thread=N --hot-block-dump=FILE`
// writes the executed-block working set for the histogram window. Feed it here.
//
//   node tools/cache-slots.js /tmp/c3-blocks.txt
//   node tools/cache-slots.js /tmp/c3-blocks.txt --mask=0x3fff   # what-if
//   node tools/cache-slots.js --addr=0x417204,0x417213
//
// CACHE_MASK is read out of src/01-header.wat so this cannot drift from the
// build; --mask overrides it to model a resize before writing any WAT.

const fs = require('fs');
const path = require('path');

function headerMask() {
  const header = path.join(__dirname, '..', 'src', '01-header.wat');
  const source = fs.readFileSync(header, 'utf8');
  const match = source.match(/\(global \$CACHE_MASK\s+i32 \(i32\.const\s+(0x[0-9a-fA-F]+|\d+)\)/);
  if (!match) {
    throw new Error(
      'CACHE_MASK not found in src/01-header.wat — the hash block cache was ' +
      'deleted (docs/page-compile-design.md section 4). Pass --mask=0x3fff to ' +
      'run this tool as a pure what-if.');
  }
  return Number(match[1]) >>> 0;
}

const args = process.argv.slice(2);
const getArg = name => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const files = args.filter(a => !a.startsWith('--'));
const maskArg = getArg('mask');
const mask = maskArg ? Number(maskArg) >>> 0 : headerMask();
const addrArg = getArg('addr');
const top = parseInt(getArg('top') || '12', 10);

// The index the build ships is `fold12`. The others are here so a proposed
// replacement can be scored against a real working set before any WAT is
// written -- the verdict line is only useful if you can check whether a
// smarter index actually helps this app.
const HASHES = {
  fold12: ga => ga ^ (ga >>> 12),
  fold8: ga => ga ^ (ga >>> 8) ^ (ga >>> 16),
  mul: ga => Math.imul(ga, 0x9E3779B1) >>> 8,
};
const hashName = getArg('hash') || 'fold12';
const hash = HASHES[hashName];
if (!hash) {
  console.error(`unknown --hash=${hashName}; known: ${Object.keys(HASHES).join(', ')}`);
  process.exit(2);
}

const entries = [];
if (addrArg) {
  for (const part of addrArg.split(',')) entries.push({ addr: Number(part) >>> 0, hits: 0 });
}
for (const file of files) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    // Accepts the --hot-block-dump format and, loosely, a pasted "top blocks"
    // section: leading address, optional hit count, anything else ignored.
    const match = line.trim().match(/^(0x[0-9a-fA-F]+|[0-9a-fA-F]{6,8})\s*(\d+)?/);
    if (match) entries.push({ addr: Number(match[1].startsWith('0x') ? match[1] : '0x' + match[1]) >>> 0,
      hits: match[2] ? Number(match[2]) : 0 });
  }
}
if (!entries.length) {
  console.error('usage: node tools/cache-slots.js <hot-block-dump> [...] [--addr=0xA,0xB] [--mask=0xFFF] [--top=N]');
  process.exit(2);
}

// Dedup, keeping the largest hit count seen for an address.
const byAddr = new Map();
for (const e of entries) {
  const prev = byAddr.get(e.addr);
  if (!prev || e.hits > prev.hits) byAddr.set(e.addr, e);
}
const blocks = Array.from(byAddr.values());
const slots = mask + 1;

const bySlot = new Map();
for (const block of blocks) {
  const slot = (hash(block.addr) & mask) >>> 0;
  if (!bySlot.has(slot)) bySlot.set(slot, []);
  bySlot.get(slot).push(block);
}

const contested = Array.from(bySlot.entries()).filter(([, list]) => list.length > 1);
// Only a contested slot whose sharers all run costs anything: the loser is
// re-decoded on every entry, so the price is the hits of everyone but the
// busiest sharer.
let wastedEntries = 0;
let totalHits = 0;
for (const block of blocks) totalHits += block.hits;
for (const [, list] of contested) {
  const sorted = list.slice().sort((a, b) => b.hits - a.hits);
  for (const block of sorted.slice(1)) wastedEntries += block.hits;
}

const pct = (n, d) => (d ? (n * 100 / d).toFixed(2) : '0.00') + '%';
console.log(`slots ${slots} (mask 0x${mask.toString(16)})${maskArg ? ' [override]' : ' [src/01-header.wat]'}` +
  `  hash ${hashName}${hashName === 'fold12' ? ' [shipping]' : ' [what-if]'}`);
console.log(`distinct blocks ${blocks.length}  occupancy ${pct(blocks.length, slots)}  slots used ${bySlot.size}`);
console.log(`contested slots ${contested.length}  blocks sharing a slot ${contested.reduce((n, [, l]) => n + l.length, 0)}`);
if (totalHits) {
  console.log(`entries into a slot's loser ${wastedEntries} of ${totalHits} (${pct(wastedEntries, totalHits)})` +
    ' -- a lower bound on forced re-decodes');
}
if (blocks.length > slots) {
  console.log('VERDICT  the working set does not fit: the index is too small.');
} else if (!contested.length) {
  console.log('VERDICT  no aliasing in this set. Re-decodes come from somewhere else' +
    ' (full clears, page invalidations, or code the window never executed).');
} else {
  console.log('VERDICT  the set fits; the index aliases. A bigger cache is not the only fix.');
}

if (contested.length) {
  console.log('\ncontested slots, worst first:');
  const ranked = contested.map(([slot, list]) => {
    const sorted = list.slice().sort((a, b) => b.hits - a.hits);
    return { slot, sorted, cost: sorted.slice(1).reduce((n, b) => n + b.hits, 0) };
  }).sort((a, b) => b.cost - a.cost);
  for (const row of ranked.slice(0, top)) {
    console.log(`  slot ${row.slot} cost ${row.cost}: ` +
      row.sorted.map(b => `0x${b.addr.toString(16).padStart(8, '0')}(${b.hits})`).join(' vs '));
  }
}
