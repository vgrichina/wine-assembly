// Build zip fixtures at test time.
//
// The real archive is produced by the system `zip`, not by our own writer:
// a parser tested only against bytes it also emitted proves nothing about the
// archives users will actually drop in. The structural properties it needs are
// a stored entry, a deflated entry, a nested folder, one top-level wrapper
// folder to unwrap, and a non-ASCII name.
//
// The unsupported-method archive has no producer — no tool emits a method our
// parser refuses — so that one is assembled by hand, minimally.
//
//   const { makeTestZip, makeBadMethodZip } = require('./fixtures/make-test-zip');

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOP = 'keen4';
// A CP437-spellable name: `zip` stores it without the UTF-8 flag on macOS only
// if the bytes are already CP437, which they are not, so this exercises the
// UTF-8 flag path. The CP437 path is covered by the unit assertions instead.
const ACCENTED = 'lisämäärä.txt';

function contents() {
  // Deflate needs something compressible to actually pick method 8; a few
  // random bytes would be stored instead and the fixture would lose its point.
  const compressible = Buffer.from('the quick brown fox\n'.repeat(400));
  return [
    { rel: 'README.TXT', data: Buffer.from('HELLO FROM THE ZIP\r\n', 'latin1'), stored: true },
    { rel: 'BIG.DAT', data: compressible, stored: false },
    { rel: path.join('DATA', 'NESTED.DAT'), data: Buffer.from('nested payload\n'), stored: false },
    { rel: ACCENTED, data: Buffer.from('unicode name\n'), stored: true },
  ];
}

// Returns { zipPath, dir, files } or null when the system `zip` is missing.
function makeTestZip() {
  let zipBin = null;
  try {
    zipBin = execFileSync('/usr/bin/which', ['zip'], { encoding: 'utf8' }).trim();
  } catch (_) {
    return null;
  }
  if (!zipBin) return null;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-zip-fixture-'));
  const stage = path.join(dir, TOP);
  fs.mkdirSync(path.join(stage, 'DATA'), { recursive: true });
  const files = contents();
  for (const file of files) fs.writeFileSync(path.join(stage, file.rel), file.data);

  const zipPath = path.join(dir, 'keen4.zip');
  const deflated = files.filter(f => !f.stored).map(f => path.join(TOP, f.rel));
  const stored = files.filter(f => f.stored).map(f => path.join(TOP, f.rel));
  // Two passes so both methods are present regardless of what `zip` would have
  // chosen on its own: -0 forces stored, the default pass deflates.
  execFileSync(zipBin, ['-q', '-r', zipPath, ...deflated], { cwd: dir });
  execFileSync(zipBin, ['-q', '-0', zipPath, ...stored], { cwd: dir });
  return { zipPath, dir, top: TOP, files, accented: ACCENTED };
}

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Hand-assembled archives, for the shapes no producer will make: an unknown
// compression method, a name that escapes the mount, two names that collide
// once Win32 folds their case, a lying CRC. Everything else about them is a
// correct zip, so whatever rejects one is the check being tested and not an
// accident of a malformed file.
//
//   makeRawZip([{ name, data, method, crc, flags }], outPath)
function makeRawZip(entries, outPath) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const spec of entries) {
    const name = Buffer.from(spec.name, 'latin1');
    const data = spec.data === undefined ? Buffer.from('payload\n') : spec.data;
    const method = spec.method === undefined ? 0 : spec.method;
    const crc = spec.crc === undefined ? crc32(data) : spec.crc;
    const flags = spec.flags || 0;
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(crc), u32(data.length), u32(spec.uncompressedSize === undefined
        ? data.length : spec.uncompressedSize),
      u16(name.length), u16(0), name, data,
    ]);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(crc), u32(data.length), u32(spec.uncompressedSize === undefined
        ? data.length : spec.uncompressedSize),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      name,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  const bytes = Buffer.concat([...locals, cd, eocd]);
  if (outPath) fs.writeFileSync(outPath, bytes);
  return bytes;
}

// A structurally valid one-entry zip whose compression method is 9 (Deflate64).
function makeBadMethodZip(outPath, method = 9) {
  return makeRawZip([{ name: 'WEIRD.DAT', method }], outPath);
}

module.exports = { makeTestZip, makeRawZip, makeBadMethodZip, crc32, TOP, ACCENTED };
