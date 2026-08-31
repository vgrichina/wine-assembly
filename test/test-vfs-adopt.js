#!/usr/bin/env node

// A ShellExecute chain-launch boots a new process that must see the same
// filesystem as the caller: the Diablo CD launcher installs to C:\Diablo,
// then hands off to C:\Diablo\diablo.exe — a path that exists only in the
// calling process's VFS. VirtualFS.adoptFrom is that inheritance: file
// entries (shared, not copied — provider-backed ISO entries have live
// state), directories, per-drive metadata, cwd. Open handles and pending
// reads stay behind by design.

'use strict';

const assert = require('assert');
const { VirtualFS } = require('../lib/filesystem');
const iso9660 = require('../lib/iso9660');

const ISO_SECTOR = 2048;

// The synthetic-disc builder from test-media-autorun-inf.js, trimmed to one
// program file: real enough for mountIso to hang lazy entries off it.
function both16(bytes, off, value) {
  bytes[off] = value & 0xff;
  bytes[off + 1] = value >>> 8;
  bytes[off + 2] = value >>> 8;
  bytes[off + 3] = value & 0xff;
}

function both32(bytes, off, value) {
  new DataView(bytes.buffer).setUint32(off, value, true);
  bytes[off + 4] = value >>> 24;
  bytes[off + 5] = value >>> 16;
  bytes[off + 6] = value >>> 8;
  bytes[off + 7] = value;
}

function ascii(bytes, off, value, width) {
  for (let i = 0; i < (width || value.length); i++) bytes[off + i] =
    i < value.length ? value.charCodeAt(i) : 0x20;
}

function directoryRecord(bytes, off, lba, size, flags, name) {
  const id = Uint8Array.from(Buffer.from(name, 'ascii'));
  const length = 33 + id.length + ((33 + id.length) & 1);
  bytes[off] = length;
  both32(bytes, off + 2, lba);
  both32(bytes, off + 10, size);
  bytes[off + 25] = flags;
  both16(bytes, off + 28, 1);
  bytes[off + 32] = id.length;
  bytes.set(id, off + 33);
  return length;
}

function makeIso() {
  const sectors = 20;
  const bytes = new Uint8Array(sectors * ISO_SECTOR);
  const pvd = 16 * ISO_SECTOR;
  bytes[pvd] = 1;
  ascii(bytes, pvd + 1, 'CD001');
  bytes[pvd + 6] = 1;
  ascii(bytes, pvd + 40, 'ADOPT_TEST', 32);
  both32(bytes, pvd + 80, sectors);
  both16(bytes, pvd + 128, ISO_SECTOR);
  directoryRecord(bytes, pvd + 156, 18, ISO_SECTOR, 2, '\0');
  ascii(bytes, pvd + 813, '1996123112000000');
  const end = 17 * ISO_SECTOR;
  bytes[end] = 255;
  ascii(bytes, end + 1, 'CD001');
  bytes[end + 6] = 1;
  let dir = 18 * ISO_SECTOR;
  dir += directoryRecord(bytes, dir, 18, ISO_SECTOR, 2, '\0');
  dir += directoryRecord(bytes, dir, 18, ISO_SECTOR, 2, '\x01');
  dir += directoryRecord(bytes, dir, 19, 4, 0, 'GAME.DAT;1');
  bytes.set([0xca, 0xfe, 0xba, 0xbe], 19 * ISO_SECTOR);
  return bytes;
}

function writeGuestFile(vfs, path, bytes) {
  const handle = vfs.createFile(path, 0x40000000, 2); // GENERIC_WRITE, CREATE_ALWAYS
  assert(handle, `CreateFile failed for ${path}`);
  const r = vfs.writeFile(handle, bytes, bytes.length);
  assert(r.ok, `WriteFile failed for ${path}`);
  vfs.closeHandle(handle);
}

function readGuestFile(vfs, path, length) {
  const handle = vfs.createFile(path, 0x80000000, 3); // GENERIC_READ, OPEN_EXISTING
  assert(handle, `CreateFile failed for ${path}`);
  const buf = new Uint8Array(length);
  const r = vfs.readFile(handle, buf, length);
  assert(r.ok, `ReadFile failed for ${path}`);
  vfs.closeHandle(handle);
  return buf.subarray(0, r.bytesRead);
}

async function main() {
  // The calling process: a mounted CD plus files its installer wrote.
  const caller = new VirtualFS();
  iso9660.mountIso(caller, makeIso(), { drive: 'D' });
  writeGuestFile(caller, 'C:\\Diablo\\diablo.exe', Uint8Array.from([0x4d, 0x5a, 1, 2]));
  writeGuestFile(caller, 'C:\\Diablo\\storm.dll', Uint8Array.from([0x4d, 0x5a, 3, 4]));
  caller.setCurrentDirectory('C:\\Diablo');
  const openInCaller = caller.createFile('C:\\Diablo\\diablo.exe', 0x80000000, 3);
  assert(openInCaller, 'caller open handle');

  const child = new VirtualFS();
  child.adoptFrom(caller);

  // The installed files and their directory arrived.
  assert.deepStrictEqual(Array.from(readGuestFile(child, 'C:\\Diablo\\diablo.exe', 16)),
    [0x4d, 0x5a, 1, 2]);
  assert(child.dirs.has('c:\\diablo'), 'installed directory must exist in the child');
  assert.strictEqual(child.cwd, caller.cwd, 'the working directory is inherited');

  // The mounted disc arrived with its identity, still lazy, still readable.
  assert.strictEqual(child.driveTypes.get('d'), 5, 'D: stays a CD-ROM');
  assert.strictEqual(child.volumeLabels.get('d'), 'ADOPT_TEST');
  assert(child.readOnlyDrives.has('d'), 'D: stays read-only');
  const disc = Object.getOwnPropertyDescriptor(child.files.get('d:\\game.dat'), 'data');
  assert(disc.get, 'adoption must not materialize lazy disc entries');
  assert.deepStrictEqual(Array.from(readGuestFile(child, 'D:\\GAME.DAT', 8)),
    [0xca, 0xfe, 0xba, 0xbe]);

  // Runtime state stays behind: the caller's open handle means nothing here.
  assert(!child.handles.has(openInCaller), 'open handles are not inherited');

  // A child-side write after the caller is gone must not need the caller.
  writeGuestFile(child, 'C:\\Diablo\\diablo.ini', Uint8Array.from([59, 13, 10]));
  assert(child.files.has('c:\\diablo\\diablo.ini'));
  assert(!caller.files.has('c:\\diablo\\diablo.ini'),
    'a post-adoption write must not appear in the caller');

  console.log('PASS test-vfs-adopt');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
