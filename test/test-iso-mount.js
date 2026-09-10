#!/usr/bin/env node
//
// ISO 9660 mount (docs/design-byo-media.md phase 3).
//
// The fixture is mastered at test time with `hdiutil makehybrid -iso -joliet`,
// so the bytes under test come from a real mastering tool rather than from a
// hand-built image that could share a misreading with the parser. Everything
// asserted here is checked against the host-side file the fixture wrote:
// enumeration through FindFirstFile on D:\, byte-exact ReadFile, and the drive
// identity the guest sees (DRIVE_CDROM plus the volume label).

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { VirtualFS } = require(path.join(ROOT, 'lib', 'filesystem'));
const iso9660 = require(path.join(ROOT, 'lib', 'iso9660'));
const { compileSrcWasm } = require('./compile-src');
const { createHostImports } = require(path.join(ROOT, 'lib', 'host-imports'));
const { makeTestIso, LABEL } = require(path.join(__dirname, 'fixtures', 'make-test-iso'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS: ${name}`); }
  catch (e) { failed++; console.log(`  FAIL: ${name} — ${e.message}`); }
}

// findFirstFile/findNextFile return entries; collect the names of a pattern.
function listing(vfs, pattern) {
  const names = [];
  const { handle, entry } = vfs.findFirstFile(pattern);
  if (!handle) return names;
  names.push(entry.name);
  let next;
  while ((next = vfs.findNextFile(handle))) names.push(next.name);
  vfs.findClose(handle);
  return names;
}

// Mutate one identifier inside the primary directory of an image mastered by
// hdiutil. Keeping the byte length identical preserves the real record's
// structure; requiring the preceding identifier-length byte prevents an
// incidental copy of the text elsewhere in the image from becoming the test.
function mutatePrimaryIdentifier(bytes, from, to) {
  const needle = Buffer.from(from, 'ascii');
  const replacement = Buffer.from(to, 'latin1');
  assert.strictEqual(replacement.length, needle.length, 'identifier mutation must be length-neutral');
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = -1;
  for (let cursor = 0; cursor < haystack.length;) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) break;
    if (found > 0 && haystack[found - 1] === needle.length) { at = found; break; }
    cursor = found + 1;
  }
  assert(at >= 0, `mastered primary directory has no ${from} identifier`);
  const out = bytes.slice();
  out.set(replacement, at);
  return out;
}

async function main() {
  console.log('ISO 9660 mount tests:');

  const fixture = makeTestIso();
  if (!fixture.isoPath) {
    console.log(`SKIP  ${fixture.reason}`);
    return;
  }
  const srcDir = path.join(fixture.dir, 'src');
  const bytes = new Uint8Array(fs.readFileSync(fixture.isoPath));

  // --- parser -------------------------------------------------------------

  const image = iso9660.parseIso(bytes);
  test('the primary descriptor supplies the volume label', () => {
    assert.strictEqual(image.volumeLabel, LABEL);
  });
  test('Joliet is selected when the image carries it', () => {
    assert.strictEqual(image.hasJoliet, true);
    assert.strictEqual(image.joliet, true);
    const names = image.files.map(f => f.path);
    assert(names.includes('ReadMe Long Name.txt'),
      `long Joliet name missing from ${JSON.stringify(names)}`);
  });
  test('--primary falls back to the 8.3 ISO names', () => {
    const primary = iso9660.parseIso(bytes, { prefer: 'primary' });
    assert.strictEqual(primary.joliet, false);
    const names = primary.files.map(f => f.path.toUpperCase());
    assert(names.includes('README LONG NAME.TXT') || names.some(n => n.startsWith('README')),
      `no primary-descriptor spelling of the long name in ${JSON.stringify(names)}`);
    assert(!names.includes('ReadMe Long Name.txt'));
  });
  test('a subdirectory is walked and its records carry the parent path', () => {
    const nested = image.files.find(f => f.path === 'DATA\\NESTED.BIN');
    assert(nested, 'DATA\\NESTED.BIN missing');
    assert.strictEqual(nested.length, 8);
    assert(image.files.some(f => f.path === 'DATA' && f.isDirectory));
  });
  test('every extent reads back byte-exact, including a multi-sector file', () => {
    for (const entry of image.files.filter(f => !f.isDirectory)) {
      // The fixture's host name only differs from the ISO path by separator.
      const hostPath = path.join(srcDir, entry.path.replace(/\\/g, path.sep));
      const want = new Uint8Array(fs.readFileSync(hostPath));
      const got = iso9660.readEntry(image, entry);
      assert.deepStrictEqual(Array.from(got), Array.from(want),
        `${entry.path} does not match the file it was mastered from`);
    }
    const big = image.files.find(f => f.path === 'BIG.DAT');
    assert(big.length > iso9660.SECTOR, 'BIG.DAT should span more than one sector');
  });
  test('a non-ISO buffer is rejected, not guessed at', () => {
    assert.throws(() => iso9660.parseIso(new Uint8Array(64 * 1024)), /CD001/);
    assert.throws(() => iso9660.parseIso(new Uint8Array(16)), /too small/);
  });

  test('a both-endian field that disagrees with itself is corruption', () => {
    // Every ECMA-119 number is stored twice. Break one half of the root
    // directory record's extent and the image must be refused rather than
    // range-read at a nonsense LBA.
    const broken = bytes.slice();
    broken[16 * iso9660.SECTOR + 156 + 6] ^= 0xff; // big-endian half of the LBA
    assert.throws(() => iso9660.parseIso(broken, { prefer: 'primary' }),
      /little-endian .* big-endian|corrupt/);
  });

  test('hostile ISO names and Win32 path collisions are refused', () => {
    const hostile = [
      ['/LPHA.BIN', /unsafe directory identifier|one path component/],
      ['../HA.BIN', /unsafe directory identifier|one path component/],
      ['\x01LPHA.BIN', /unsafe directory identifier|cannot use/],
      ['CON.X.BIN', /unsafe directory identifier|reserved device name/],
      ['BRAVO.BIN', /both mount at|case-insensitive/],
    ];
    for (const [replacement, pattern] of hostile) {
      const image = mutatePrimaryIdentifier(bytes, 'ALPHA.BIN', replacement);
      assert.throws(() => iso9660.parseIso(image, { prefer: 'primary' }), pattern,
        `hostile ISO identifier ${JSON.stringify(replacement)} must be refused`);
    }
  });

  test('the volume serial is stable and image-specific', () => {
    assert(image.volumeSerial >>> 0, 'a mounted disc must have a nonzero serial');
    assert.strictEqual(iso9660.parseIso(bytes).volumeSerial, image.volumeSerial,
      'two mounts of one image must report the same serial');
    assert(/^\d{4}/.test(image.volumeCreated),
      `expected a PVD timestamp, got ${JSON.stringify(image.volumeCreated)}`);
  });

  // --- mount --------------------------------------------------------------

  const vfs = new VirtualFS();
  const mount = iso9660.mountIso(vfs, bytes);

  test('mounting lands on D:\\ as a first-class drive', () => {
    assert.strictEqual(mount.drive, 'D');
    assert.strictEqual(mount.root, 'D:\\');
    assert(vfs.dirs.has('d:'), 'the drive itself must be a directory');
    assert(vfs.dirs.has('d:\\'));
    assert(vfs.dirs.has('d:\\data'));
    assert.strictEqual(mount.fileCount, 6);
  });

  test('FindFirstFile enumerates the disc root', () => {
    const names = listing(vfs, 'D:\\*.*').map(n => n.toLowerCase());
    for (const want of ['setup.exe', 'readme long name.txt', 'big.dat', 'data']) {
      assert(names.includes(want), `${want} missing from ${JSON.stringify(names)}`);
    }
  });

  test('FindFirstFile enumerates a subdirectory', () => {
    const names = listing(vfs, 'D:\\DATA\\*').map(n => n.toLowerCase());
    assert(names.includes('nested.bin'), JSON.stringify(names));
  });

  test('enumeration reports sizes without materializing any bytes', () => {
    // The lazy entry knows its size from the directory record; touching .data
    // is what pulls the extent in. Read the size the way FindFirstFile does
    // and check nothing was loaded.
    const entry = vfs.files.get('d:\\big.dat');
    assert.strictEqual(entry._size, 5000);
    const descriptor = Object.getOwnPropertyDescriptor(entry, 'data');
    assert(descriptor.get, 'BIG.DAT should still be a lazy accessor before any read');
  });

  test('ReadFile returns the mastered bytes exactly', () => {
    for (const rel of ['SETUP.EXE', 'ReadMe Long Name.txt', 'BIG.DAT',
                       path.join('DATA', 'NESTED.BIN')]) {
      const guest = 'D:\\' + rel.split(path.sep).join('\\');
      const want = new Uint8Array(fs.readFileSync(path.join(srcDir, rel)));
      const handle = vfs.createFile(guest, 0x80000000, 3);
      assert(handle, `CreateFile failed for ${guest}`);
      const buf = new Uint8Array(want.length + 16);
      const r = vfs.readFile(handle, buf, buf.length);
      assert(r.ok, `ReadFile failed for ${guest}`);
      assert.strictEqual(r.bytesRead, want.length, `${guest} length`);
      assert.deepStrictEqual(Array.from(buf.subarray(0, want.length)), Array.from(want),
        `${guest} contents`);
      vfs.closeHandle(handle);
    }
  });

  test('the disc is read-only', () => {
    assert.strictEqual(vfs.createFile('D:\\NEW.TXT', 0x40000000, 2), 0,
      'creating a file on a mounted disc must fail');
    assert(vfs.files.get('d:\\setup.exe').attrs & 0x01,
      'FILE_ATTRIBUTE_READONLY should be set on every disc file');
  });

  test('the mount records CD-ROM identity for the drive', () => {
    assert.strictEqual(vfs.driveTypes.get('d'), 5);
    assert.strictEqual(vfs.volumeLabels.get('d'), LABEL);
  });

  test('a second image can take another letter', () => {
    const other = new VirtualFS();
    const m = iso9660.mountIso(other, bytes, { drive: 'E' });
    assert.strictEqual(m.root, 'E:\\');
    assert(other.files.has('e:\\setup.exe'));
    assert.strictEqual(other.driveTypes.get('e'), 5);
    assert.throws(() => iso9660.mountIso(other, bytes, { drive: '4' }), /invalid drive/);
  });

  // --- drive identity, as the guest sees it -------------------------------

  const wasmBytes = compileSrcWasm();
  const module = await WebAssembly.compile(wasmBytes);
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const guestVfs = new VirtualFS();
  // Mount at E: so the assertion cannot be satisfied by the built-in "D: is a
  // CD-ROM" answer the emulator gives with no media at all.
  iso9660.mountIso(guestVfs, bytes, { drive: 'E' });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {}, vfs: guestVfs };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  for (const name of ['create_thread', 'exit_thread', 'terminate_thread', 'create_event', 'set_event',
                      'reset_event', 'wait_single', 'wait_multiple']) {
    imports.host[name] = () => 0;
  }
  imports.host.com_create_instance = () => 0x80004002;
  const instance = await WebAssembly.instantiate(module, imports);
  const { exports } = instance;
  const mem = new Uint8Array(memory.buffer);
  const guestBase = exports.get_guest_base();
  const rootGA = 0x2000, bufGA = 0x2100, stackGA = 0x2200;
  const at = ga => guestBase + ga;
  const writeAnsi = (ga, value) => {
    mem.fill(0, at(ga), at(ga) + 64);
    mem.set(Buffer.from(value + '\0', 'ascii'), at(ga));
  };

  test('GetDriveTypeA reports DRIVE_CDROM for the mounted letter', () => {
    writeAnsi(rootGA, 'E:\\');
    assert.strictEqual(exports.test_call_GetDriveTypeA(rootGA), 5);
    writeAnsi(rootGA, 'e:\\setup.exe');
    assert.strictEqual(exports.test_call_GetDriveTypeA(rootGA), 5,
      'the letter decides, not the rest of the path');
  });

  test('an unmounted letter keeps the built-in Win98 answer', () => {
    writeAnsi(rootGA, 'C:\\');
    assert.strictEqual(exports.test_call_GetDriveTypeA(rootGA), 3, 'C: is DRIVE_FIXED');
    writeAnsi(rootGA, 'Z:\\');
    assert.strictEqual(exports.test_call_GetDriveTypeA(rootGA), 1, 'Z: has no root');
  });

  test('GetVolumeInformationA returns the disc label and its serial', () => {
    mem.fill(0, at(stackGA), at(stackGA) + 64);
    mem.fill(0xcc, at(bufGA), at(bufGA) + 64);
    writeAnsi(rootGA, 'E:\\');
    const serialGA = 0x2300;
    mem.fill(0, at(serialGA), at(serialGA) + 8);
    assert.strictEqual(
      exports.test_call_GetVolumeInformationA(rootGA, bufGA, 32, stackGA, serialGA), 1);
    const end = mem.indexOf(0, at(bufGA));
    const label = Buffer.from(mem.subarray(at(bufGA), end)).toString('ascii');
    assert.strictEqual(label, LABEL);
    const serial = new DataView(memory.buffer).getUint32(at(serialGA), true);
    assert.strictEqual(serial, image.volumeSerial >>> 0,
      'the serial the guest reads is the one the image derives');
  });

  test('a drive with no mounted media still reports an empty label', () => {
    mem.fill(0, at(stackGA), at(stackGA) + 64);
    mem.fill(0xcc, at(bufGA), at(bufGA) + 64);
    writeAnsi(rootGA, 'C:\\');
    assert.strictEqual(
      exports.test_call_GetVolumeInformationA(rootGA, bufGA, 32, stackGA, 0), 1);
    assert.strictEqual(mem[at(bufGA)], 0, 'C: has no volume label');
  });

  test('a label longer than the caller\'s buffer is truncated, not overrun', () => {
    const small = new VirtualFS();
    iso9660.mountIso(small, bytes, { drive: 'F' });
    small.volumeLabels.set('f', 'A_VERY_LONG_VOLUME_LABEL');
    const saved = ctx.vfs;
    ctx.vfs = small;
    mem.fill(0, at(stackGA), at(stackGA) + 64);
    mem.fill(0xcc, at(bufGA), at(bufGA) + 64);
    writeAnsi(rootGA, 'F:\\');
    assert.strictEqual(
      exports.test_call_GetVolumeInformationA(rootGA, bufGA, 5, stackGA, 0), 1);
    assert.strictEqual(
      Buffer.from(mem.subarray(at(bufGA), at(bufGA) + 4)).toString('ascii'), 'A_VE');
    assert.strictEqual(mem[at(bufGA) + 4], 0, 'the terminator fits inside the buffer');
    assert.strictEqual(mem[at(bufGA) + 5], 0xcc, 'nothing is written past the buffer');
    ctx.vfs = saved;
  });

  test('GetVolumeInformationA names the filesystem CDFS on the mounted letter', () => {
    // Diablo's CD check XOR-folds the fs-name string, BytesPerSector and the
    // drive type into a constant, so "CDFS" here is load-bearing, not garnish.
    const dv = new DataView(memory.buffer);
    const fsNameGA = 0x2400;
    mem.fill(0, at(stackGA), at(stackGA) + 64);
    dv.setUint32(at(stackGA) + 28, fsNameGA, true); // 7th stdcall arg: lpFileSystemNameBuffer
    mem.fill(0xcc, at(fsNameGA), at(fsNameGA) + 16);
    writeAnsi(rootGA, 'E:\\');
    assert.strictEqual(
      exports.test_call_GetVolumeInformationA(rootGA, bufGA, 32, stackGA, 0), 1);
    let end = mem.indexOf(0, at(fsNameGA));
    assert.strictEqual(
      Buffer.from(mem.subarray(at(fsNameGA), end)).toString('ascii'), 'CDFS');
    mem.fill(0xcc, at(fsNameGA), at(fsNameGA) + 16);
    writeAnsi(rootGA, 'C:\\');
    assert.strictEqual(
      exports.test_call_GetVolumeInformationA(rootGA, bufGA, 32, stackGA, 0), 1);
    end = mem.indexOf(0, at(fsNameGA));
    assert.strictEqual(
      Buffer.from(mem.subarray(at(fsNameGA), end)).toString('ascii'), 'FAT',
      'an unmounted letter keeps the FAT answer');
  });

  test('GetDiskFreeSpaceA reports the disc\'s CDFS geometry, and C: keeps its own', () => {
    const dv = new DataView(memory.buffer);
    const spcGA = 0x2500, bpsGA = 0x2504, freeGA = 0x2508, totalGA = 0x250c;
    writeAnsi(rootGA, 'E:\\');
    assert.strictEqual(
      exports.test_call_GetDiskFreeSpaceA(rootGA, spcGA, bpsGA, freeGA, totalGA), 1);
    assert.strictEqual(dv.getUint32(at(spcGA), true), 1, 'one sector per cluster');
    assert.strictEqual(dv.getUint32(at(bpsGA), true), 2048, '2048-byte sectors');
    assert.strictEqual(dv.getUint32(at(freeGA), true), 0, 'a pressed disc has nothing free');
    assert.strictEqual(dv.getUint32(at(totalGA), true), image.volumeSpaceSize >>> 0,
      'total clusters are the PVD volume space size');
    writeAnsi(rootGA, 'C:\\');
    assert.strictEqual(
      exports.test_call_GetDiskFreeSpaceA(rootGA, spcGA, bpsGA, freeGA, totalGA), 1);
    assert.strictEqual(dv.getUint32(at(bpsGA), true), 512,
      'the fixed disk keeps 512-byte sectors');
    assert.strictEqual(dv.getUint32(at(spcGA), true), 8,
      'the fixed disk keeps 8 sectors per cluster');
    const freeBytes = dv.getUint32(at(spcGA), true) *
      dv.getUint32(at(bpsGA), true) * dv.getUint32(at(freeGA), true);
    const totalBytes = dv.getUint32(at(spcGA), true) *
      dv.getUint32(at(bpsGA), true) * dv.getUint32(at(totalGA), true);
    assert(freeBytes > 43 * 1024 * 1024,
      'the fixed disk has enough room for period game installers');
    assert(freeBytes <= 0x7fffffff && totalBytes <= 0x7fffffff,
      'legacy geometry products stay positive in signed 32-bit arithmetic');
  });

  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
