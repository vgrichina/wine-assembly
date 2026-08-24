#!/usr/bin/env node
'use strict';

// Dump an MPQ archive's header and block table.
//
// Storm hands the guest one ReadFile per compressed block, so a trace only ever
// shows the *compressed* length. The archive's block table is the only place
// that records what that block is supposed to decompress to, which is what you
// need when a decode looks truncated.
//
//   node tools/mpq-dir.js <file.mpq>                 # header + block summary
//   node tools/mpq-dir.js <file.mpq> --pos=0x9aec6   # the block read from there
//   node tools/mpq-dir.js <file.mpq> --all           # every block entry
//   node tools/mpq-dir.js <file.mpq> --table=22      # a block's sector offsets
//
// --table decrypts the per-file sector offset table. The table's key is derived
// from the file name, which a stripped archive does not record, so it is
// recovered from known plaintext instead: entry 0 of every sector table is the
// table's own byte length. That is what lets you check the offsets the guest
// decrypted against the ones the archive actually holds.

const fs = require('fs');

const CRYPT = new Uint32Array(0x500);
(function buildCryptTable() {
  let seed = 0x00100001;
  for (let i = 0; i < 0x100; i++) {
    for (let j = 0, index = i; j < 5; j++, index += 0x100) {
      seed = (seed * 125 + 3) % 0x2aaaab;
      const hi = (seed & 0xffff) << 16;
      seed = (seed * 125 + 3) % 0x2aaaab;
      CRYPT[index] = (hi | (seed & 0xffff)) >>> 0;
    }
  }
})();

function hashString(text, type) {
  let seed1 = 0x7fed7fed >>> 0;
  let seed2 = 0xeeeeeeee >>> 0;
  for (const rawChar of text) {
    const ch = rawChar.toUpperCase().charCodeAt(0);
    seed1 = (CRYPT[(type << 8) + ch] ^ (seed1 + seed2)) >>> 0;
    seed2 = (ch + seed1 + seed2 + (seed2 << 5) + 3) >>> 0;
  }
  return seed1 >>> 0;
}

function decryptBlock(buf, key) {
  let seed1 = key >>> 0;
  let seed2 = 0xeeeeeeee >>> 0;
  for (let offset = 0; offset + 4 <= buf.length; offset += 4) {
    seed2 = (seed2 + CRYPT[0x400 + (seed1 & 0xff)]) >>> 0;
    const value = (buf.readUInt32LE(offset) ^ ((seed1 + seed2) >>> 0)) >>> 0;
    buf.writeUInt32LE(value, offset);
    seed1 = ((((~seed1 << 0x15) >>> 0) + 0x11111111) | (seed1 >>> 0x0b)) >>> 0;
    seed2 = (value + seed2 + (seed2 << 5) + 3) >>> 0;
  }
  return buf;
}

// Recover the key a sector table was encrypted with from its first dword,
// whose plaintext is always the table's own size in bytes.
function detectSeed(raw, plain0, cSize) {
  const saved = ((raw.readUInt32LE(0) ^ plain0) - 0xeeeeeeee) >>> 0;
  for (let i = 0; i < 0x100; i++) {
    const seed1 = (saved - CRYPT[0x400 + i]) >>> 0;
    const trial = decryptBlock(Buffer.from(raw), seed1);
    // A false positive matches dword 0 and nothing else. The last offset of a
    // sector table is the file's total compressed size, which pins it.
    if (trial.readUInt32LE(0) === (plain0 >>> 0) &&
        trial.readUInt32LE(trial.length - 4) === (cSize >>> 0)) return seed1;
  }
  return null;
}

const FLAGS = [
  [0x00000100, 'IMPLODE'],
  [0x00000200, 'COMPRESS'],
  [0x00010000, 'ENCRYPTED'],
  [0x00020000, 'FIX_KEY'],
  [0x00100000, 'PATCH_FILE'],
  [0x01000000, 'SINGLE_UNIT'],
  [0x02000000, 'DELETE_MARKER'],
  [0x04000000, 'SECTOR_CRC'],
  [0x80000000, 'EXISTS'],
];

function flagNames(flags) {
  const names = FLAGS.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name);
  return names.length ? names.join('|') : '-';
}

function findHeader(buf) {
  for (let offset = 0; offset + 32 <= buf.length; offset += 512) {
    if (buf.readUInt32LE(offset) === 0x1a51504d) return offset;
  }
  return -1;
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node tools/mpq-dir.js <file.mpq> [--pos=0xOFF] [--all]');
    process.exit(2);
  }
  const showAll = args.includes('--all');
  const posArg = args.find(a => a.startsWith('--pos='));
  const wantPos = posArg ? Number(posArg.slice(6)) : null;
  const tableArg2 = args.find(a => a.startsWith('--table='));
  const tableArg = tableArg2 ? Number(tableArg2.slice(8)) : null;
  const nameArg = args.find(a => a.startsWith('--name='));
  const wantName = nameArg ? nameArg.slice(7) : null;

  const buf = fs.readFileSync(file);
  const base = findHeader(buf);
  if (base < 0) {
    console.error(`${file}: no MPQ header found`);
    process.exit(1);
  }

  const headerSize = buf.readUInt32LE(base + 0x04);
  const archiveSize = buf.readUInt32LE(base + 0x08);
  const formatVersion = buf.readUInt16LE(base + 0x0c);
  const sectorShift = buf.readUInt16LE(base + 0x0e);
  const hashTablePos = buf.readUInt32LE(base + 0x10);
  const blockTablePos = buf.readUInt32LE(base + 0x14);
  const hashTableSize = buf.readUInt32LE(base + 0x18);
  const blockTableSize = buf.readUInt32LE(base + 0x1c);
  const sectorSize = 512 << sectorShift;

  console.log(`${file}`);
  console.log(`  header at 0x${base.toString(16)}  size ${headerSize}  archive ${archiveSize}  v${formatVersion}`);
  console.log(`  sector size ${sectorSize} (shift ${sectorShift})`);
  console.log(`  hash  table @ 0x${hashTablePos.toString(16)}  ${hashTableSize} entries`);
  console.log(`  block table @ 0x${blockTablePos.toString(16)}  ${blockTableSize} entries`);

  const blocks = Buffer.from(buf.subarray(base + blockTablePos, base + blockTablePos + blockTableSize * 16));
  decryptBlock(blocks, hashString('(block table)', 3));

  const entries = [];
  for (let i = 0; i < blockTableSize; i++) {
    entries.push({
      index: i,
      filePos: blocks.readUInt32LE(i * 16 + 0),
      cSize: blocks.readUInt32LE(i * 16 + 4),
      fSize: blocks.readUInt32LE(i * 16 + 8),
      flags: blocks.readUInt32LE(i * 16 + 12),
    });
  }

  const print = e => {
    const sectors = e.fSize ? Math.ceil(e.fSize / sectorSize) : 0;
    console.log(
      `  [${String(e.index).padStart(5)}] pos 0x${e.filePos.toString(16).padStart(8, '0')}` +
      `  csize ${String(e.cSize).padStart(9)}  fsize ${String(e.fSize).padStart(9)}` +
      `  sectors ${String(sectors).padStart(5)}  flags 0x${e.flags.toString(16).padStart(8, '0')} ${flagNames(e.flags)}`);
  };

  if (wantPos !== null) {
    // The trace records an absolute file offset; block positions are relative
    // to the header, and a read can start at a sector inside the block.
    const relative = wantPos - base;
    const hits = entries.filter(e => relative >= e.filePos && relative < e.filePos + Math.max(e.cSize, 1));
    console.log(`\n  blocks covering file offset 0x${wantPos.toString(16)} (archive-relative 0x${relative.toString(16)}):`);
    if (!hits.length) console.log('    none');
    hits.forEach(print);
    return;
  }

  if (wantName !== null) {
    // A stripped archive has no listfile, but the hash table is still keyed by
    // name: slot = hashA(name,0) & (size-1), then linear probe comparing the
    // two verification hashes. This is how you get from "ui_art\logo.pcx" to a
    // block entry (and so to its real decompressed size) without a listfile.
    const hashes = Buffer.from(
      buf.subarray(base + hashTablePos, base + hashTablePos + hashTableSize * 16));
    decryptBlock(hashes, hashString('(hash table)', 3));
    const start = hashString(wantName, 0) >>> 0;
    const nameA = hashString(wantName, 1) >>> 0;
    const nameB = hashString(wantName, 2) >>> 0;
    let slot = start & (hashTableSize - 1);
    for (let probe = 0; probe < hashTableSize; probe++) {
      const off = slot * 16;
      const blockIndex = hashes.readInt32LE(off + 12);
      if (blockIndex === -1) break; // empty, never used: the name is absent
      if (hashes.readUInt32LE(off) === nameA &&
          hashes.readUInt32LE(off + 4) === nameB &&
          blockIndex >= 0 && blockIndex < blockTableSize) {
        console.log(`\n  "${wantName}" -> hash slot ${slot}, block ${blockIndex}:`);
        print(entries[blockIndex]);
        return;
      }
      slot = (slot + 1) & (hashTableSize - 1);
    }
    console.log(`\n  "${wantName}" is not in this archive's hash table`);
    return;
  }

  if (tableArg !== null) {
    const e = entries[tableArg];
    if (!e) { console.error(`no block ${tableArg}`); process.exit(1); }
    print(e);
    const nSectors = Math.ceil(e.fSize / sectorSize);
    const bytes = (nSectors + 1) * 4;
    const raw = Buffer.from(buf.subarray(base + e.filePos, base + e.filePos + bytes));
    if ((e.flags & 0x00010000) !== 0) {
      const seed = detectSeed(raw, bytes, e.cSize);
      if (seed === null) { console.error('  could not recover the sector-table key'); process.exit(1); }
      console.log(`  sector table key 0x${seed.toString(16)}`);
      decryptBlock(raw, seed);
    }
    console.log(`  ${nSectors + 1} offsets (compressed sizes in parens):`);
    for (let i = 0; i <= nSectors; i++) {
      const off = raw.readUInt32LE(i * 4);
      const size = i < nSectors ? raw.readUInt32LE((i + 1) * 4) - off : 0;
      console.log(`    [${String(i).padStart(4)}] 0x${off.toString(16).padStart(8, '0')}` +
        `  archive 0x${(e.filePos + off).toString(16)}${i < nSectors ? `  (${size})` : ''}`);
    }
    return;
  }

  const live = entries.filter(e => (e.flags & 0x80000000) !== 0);
  console.log(`\n  ${live.length} live blocks of ${blockTableSize}`);
  if (showAll) live.forEach(print);
  else {
    const bySize = [...live].sort((a, b) => b.fSize - a.fSize).slice(0, 20);
    console.log('  20 largest by decompressed size:');
    bySize.forEach(print);
  }
}

main();
