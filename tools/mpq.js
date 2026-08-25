'use strict';

// Shared MPQ (Blizzard Mo'PaQ) reader: header, hash/block tables, the Storm
// crypt table, and per-sector decompression.
//
// Used by tools/mpq-dir.js (inspection) and tools/mpq-extract.js (extraction).
// Everything here is host-side ground truth: it never touches the emulator, so
// what it produces is what the guest's Storm decode is supposed to have
// produced.

const fs = require('fs');

// ---------------------------------------------------------------------------
// Storm crypt table
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Block flags
// ---------------------------------------------------------------------------

const FLAG_IMPLODE = 0x00000100;
const FLAG_COMPRESS = 0x00000200;
const FLAG_ENCRYPTED = 0x00010000;
const FLAG_FIX_KEY = 0x00020000;
const FLAG_SINGLE_UNIT = 0x01000000;
const FLAG_SECTOR_CRC = 0x04000000;
const FLAG_EXISTS = 0x80000000;

const FLAGS = [
  [FLAG_IMPLODE, 'IMPLODE'],
  [FLAG_COMPRESS, 'COMPRESS'],
  [FLAG_ENCRYPTED, 'ENCRYPTED'],
  [FLAG_FIX_KEY, 'FIX_KEY'],
  [0x00100000, 'PATCH_FILE'],
  [FLAG_SINGLE_UNIT, 'SINGLE_UNIT'],
  [0x02000000, 'DELETE_MARKER'],
  [FLAG_SECTOR_CRC, 'SECTOR_CRC'],
  [FLAG_EXISTS, 'EXISTS'],
];

function flagNames(flags) {
  const names = FLAGS.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name);
  return names.length ? names.join('|') : '-';
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

function findHeader(buf) {
  for (let offset = 0; offset + 32 <= buf.length; offset += 512) {
    if (buf.readUInt32LE(offset) === 0x1a51504d) return offset;
  }
  return -1;
}

// Parse header + block table (and lazily the hash table).
function openArchive(file) {
  const buf = fs.readFileSync(file);
  const base = findHeader(buf);
  if (base < 0) throw new Error(`${file}: no MPQ header found`);

  const a = {
    file,
    buf,
    base,
    headerSize: buf.readUInt32LE(base + 0x04),
    archiveSize: buf.readUInt32LE(base + 0x08),
    formatVersion: buf.readUInt16LE(base + 0x0c),
    sectorShift: buf.readUInt16LE(base + 0x0e),
    hashTablePos: buf.readUInt32LE(base + 0x10),
    blockTablePos: buf.readUInt32LE(base + 0x14),
    hashTableSize: buf.readUInt32LE(base + 0x18),
    blockTableSize: buf.readUInt32LE(base + 0x1c),
  };
  a.sectorSize = 512 << a.sectorShift;

  const blocks = Buffer.from(
    buf.subarray(base + a.blockTablePos, base + a.blockTablePos + a.blockTableSize * 16));
  decryptBlock(blocks, hashString('(block table)', 3));
  a.blocks = [];
  for (let i = 0; i < a.blockTableSize; i++) {
    a.blocks.push({
      index: i,
      filePos: blocks.readUInt32LE(i * 16 + 0),
      cSize: blocks.readUInt32LE(i * 16 + 4),
      fSize: blocks.readUInt32LE(i * 16 + 8),
      flags: blocks.readUInt32LE(i * 16 + 12),
    });
  }
  return a;
}

// A stripped archive has no listfile, but the hash table is still keyed by
// name: slot = hashA(name,0) & (size-1), then linear probe comparing the two
// verification hashes. Returns { slot, blockIndex } or null.
function lookupName(a, name) {
  if (!a._hashes) {
    const h = Buffer.from(
      a.buf.subarray(a.base + a.hashTablePos,
                     a.base + a.hashTablePos + a.hashTableSize * 16));
    decryptBlock(h, hashString('(hash table)', 3));
    a._hashes = h;
  }
  const hashes = a._hashes;
  const nameA = hashString(name, 1) >>> 0;
  const nameB = hashString(name, 2) >>> 0;
  let slot = hashString(name, 0) & (a.hashTableSize - 1);
  for (let probe = 0; probe < a.hashTableSize; probe++) {
    const off = slot * 16;
    const blockIndex = hashes.readInt32LE(off + 12);
    if (blockIndex === -1) return null; // empty, never used: the name is absent
    if (hashes.readUInt32LE(off) === nameA &&
        hashes.readUInt32LE(off + 4) === nameB &&
        blockIndex >= 0 && blockIndex < a.blockTableSize) {
      return { slot, blockIndex };
    }
    slot = (slot + 1) & (a.hashTableSize - 1);
  }
  return null;
}

// The file-data key is the hash of the bare file name (no directory), type 3.
function fileKey(name, entry) {
  const bare = name.slice(name.lastIndexOf('\\') + 1);
  let key = hashString(bare, 3) >>> 0;
  if ((entry.flags & FLAG_FIX_KEY) !== 0) {
    key = (((key + entry.filePos) >>> 0) ^ (entry.fSize >>> 0)) >>> 0;
  }
  return key;
}

// Read + decrypt + decompress one block entry into its full fSize bytes.
// `name` is needed for the decryption key when the block is ENCRYPTED; pass
// null to fall back to key recovery from the sector table's known plaintext.
function extractBlock(a, entry, name) {
  const out = Buffer.alloc(entry.fSize);
  const encrypted = (entry.flags & FLAG_ENCRYPTED) !== 0;
  const compressed = (entry.flags & (FLAG_IMPLODE | FLAG_COMPRESS)) !== 0;
  let key = encrypted && name !== null ? fileKey(name, entry) : null;

  const raw = a.buf.subarray(a.base + entry.filePos,
                             a.base + entry.filePos + entry.cSize);

  if ((entry.flags & FLAG_SINGLE_UNIT) !== 0) {
    if (encrypted && key === null) {
      throw new Error('SINGLE_UNIT + ENCRYPTED needs the file name for its key');
    }
    const data = Buffer.from(raw);
    if (encrypted) decryptBlock(data, key);
    out.set(decompressSector(data, entry.fSize, entry.flags), 0);
    return out;
  }

  const nSectors = Math.ceil(entry.fSize / a.sectorSize);
  const tableEntries = nSectors + 1 + ((entry.flags & FLAG_SECTOR_CRC) !== 0 ? 1 : 0);
  const table = Buffer.from(raw.subarray(0, tableEntries * 4));
  if (encrypted) {
    // The sector table is encrypted with key-1; sector i with key+i. Without a
    // name we recover the table's key from known plaintext and step back up.
    const tkey = key === null
      ? detectSeed(table, tableEntries * 4, entry.cSize)
      : ((key - 1) >>> 0);
    if (tkey === null) throw new Error('could not recover the sector-table key');
    if (key === null) key = (tkey + 1) >>> 0;
    decryptBlock(table, tkey);
  }
  if (table.readUInt32LE(0) !== tableEntries * 4) {
    throw new Error(
      `sector table looks wrong: offset[0]=${table.readUInt32LE(0)}, expected ${tableEntries * 4}` +
      ' (bad decryption key?)');
  }

  let written = 0;
  for (let i = 0; i < nSectors; i++) {
    const start = table.readUInt32LE(i * 4);
    const end = table.readUInt32LE((i + 1) * 4);
    const want = Math.min(a.sectorSize, entry.fSize - written);
    let sector = Buffer.from(raw.subarray(start, end));
    if (encrypted) decryptBlock(sector, ((key + i) >>> 0));
    // A sector that did not shrink is stored verbatim. Storm writes the raw
    // bytes rather than a compressed stream in that case, and the only signal
    // is that the stored length is not smaller than the decompressed length.
    const plain = sector.length >= want
      ? sector.subarray(0, want)
      : decompressSector(sector, want, entry.flags);
    if (plain.length !== want) {
      throw new Error(`sector ${i}: got ${plain.length} bytes, expected ${want}`);
    }
    out.set(plain, written);
    written += want;
  }
  return out;
}

function decompressSector(data, outSize, flags) {
  if ((flags & FLAG_IMPLODE) !== 0 && (flags & FLAG_COMPRESS) === 0) {
    // MPQ_FILE_IMPLODE: the whole sector is a PKWARE DCL stream, no type byte.
    return explode(data);
  }
  if ((flags & FLAG_COMPRESS) !== 0) {
    const mask = data[0];
    const body = data.subarray(1);
    if (mask === 0x08) return explode(body);
    throw new Error(`unsupported multi-compression mask 0x${mask.toString(16)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// PKWARE Data Compression Library "implode" / explode
// ---------------------------------------------------------------------------
//
// Ported from the format description implemented by Mark Adler's blast.c
// (zlib contrib/blast, public-domain-equivalent zlib licence). The three
// `*len` arrays below are that decoder's compact run-length encoding of the
// fixed Huffman code lengths baked into PKWARE's DCL: each byte is
// (repeat-1) << 4 | bit-length. The codes are stored bit-reversed in the
// stream, which is why decode() inverts each bit as it walks the tree.

const LITLEN = [
  11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
  9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
  7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12,
  8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
  44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45,
  44, 173,
];
const LENLEN = [2, 35, 36, 53, 38, 23];
const DISTLEN = [2, 20, 53, 230, 247, 151, 248];

// Base length and extra bits per length code. Note codes 0 and 1 are 3 and 2:
// DCL's shortest match is 2 bytes but it is not the first code.
const LEN_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

const MAXBITS = 13;

function construct(rep, expectedSymbols) {
  const length = [];
  for (const byte of rep) {
    const bits = byte & 15;
    const times = (byte >> 4) + 1;
    for (let i = 0; i < times; i++) length.push(bits);
  }
  if (expectedSymbols !== undefined && length.length !== expectedSymbols) {
    throw new Error(`DCL table: ${length.length} symbols, expected ${expectedSymbols}`);
  }
  const count = new Array(MAXBITS + 1).fill(0);
  for (const l of length) count[l]++;
  const offs = new Array(MAXBITS + 2).fill(0);
  for (let len = 1; len < MAXBITS + 1; len++) offs[len + 1] = offs[len] + count[len];
  const symbol = new Array(length.length).fill(0);
  for (let s = 0; s < length.length; s++) {
    if (length[s] !== 0) symbol[offs[length[s]]++] = s;
  }
  return { count, symbol };
}

const LIT_CODE = construct(LITLEN, 256);
const LEN_CODE = construct(LENLEN, 16);
const DIST_CODE = construct(DISTLEN, 64);

function explode(input) {
  let inPos = 0;
  let bitbuf = 0;
  let bitcnt = 0;

  function bits(need) {
    let val = bitbuf;
    while (bitcnt < need) {
      if (inPos >= input.length) throw new Error('explode: out of input');
      val |= input[inPos++] << bitcnt;
      bitcnt += 8;
    }
    bitbuf = val >> need;
    bitcnt -= need;
    return val & ((1 << need) - 1);
  }

  // Walk the canonical code one bit at a time, inverting each bit because DCL
  // stores its codes reversed relative to the canonical ordering.
  function decode(h) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= MAXBITS; len++) {
      code |= bits(1) ^ 1;
      const count = h.count[len];
      if (code - first < count) return h.symbol[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('explode: invalid code');
  }

  const lit = bits(8);
  if (lit > 1) throw new Error(`explode: bad literal mode ${lit}`);
  const dictBits = bits(8);
  if (dictBits < 4 || dictBits > 6) throw new Error(`explode: bad dictionary size ${dictBits}`);

  // The output is its own window: back references just index into what we have
  // already emitted, so a growable buffer serves as both.
  let out = Buffer.alloc(Math.max(4096, input.length * 4));
  let n = 0;
  const need = extra => {
    if (n + extra <= out.length) return;
    let cap = out.length;
    while (cap < n + extra) cap *= 2;
    const grown = Buffer.alloc(cap);
    out.copy(grown, 0, 0, n);
    out = grown;
  };

  for (;;) {
    if (bits(1)) {
      // Length/distance pair.
      const sym = decode(LEN_CODE);
      const len = LEN_BASE[sym] + (LEN_EXTRA[sym] ? bits(LEN_EXTRA[sym]) : 0);
      if (len === 519) break; // end-of-stream code
      const distBits = len === 2 ? 2 : dictBits;
      let dist = decode(DIST_CODE) << distBits;
      dist += bits(distBits);
      dist++;
      if (dist > n) throw new Error('explode: distance too far back');
      need(len);
      let from = n - dist;
      for (let i = 0; i < len; i++) out[n++] = out[from++];
    } else {
      need(1);
      out[n++] = lit === 1 ? decode(LIT_CODE) : bits(8);
    }
  }
  return Buffer.from(out.subarray(0, n));
}

// ---------------------------------------------------------------------------

function extractByName(a, name) {
  const hit = lookupName(a, name);
  if (!hit) return null;
  const entry = a.blocks[hit.blockIndex];
  return { entry, slot: hit.slot, data: extractBlock(a, entry, name) };
}

module.exports = {
  CRYPT,
  hashString,
  decryptBlock,
  detectSeed,
  FLAGS,
  flagNames,
  findHeader,
  openArchive,
  lookupName,
  fileKey,
  extractBlock,
  extractByName,
  explode,
};
