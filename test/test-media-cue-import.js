#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { VirtualFS } = require('../lib/filesystem');
const mediaImport = require('../lib/media-import');
const { SECTOR_BYTES } = require('../lib/cdrom');

const ISO_SECTOR = 2048;

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

function directoryRecord(bytes, off, lba, size, flags, nameBytes) {
  const id = Uint8Array.from(nameBytes);
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
  const bytes = new Uint8Array(20 * ISO_SECTOR);
  const pvd = 16 * ISO_SECTOR;
  bytes[pvd] = 1;
  ascii(bytes, pvd + 1, 'CD001');
  bytes[pvd + 6] = 1;
  ascii(bytes, pvd + 40, 'CIV2_TEST', 32);
  both32(bytes, pvd + 80, 20);
  both16(bytes, pvd + 128, ISO_SECTOR);
  directoryRecord(bytes, pvd + 156, 18, ISO_SECTOR, 2, [0]);
  ascii(bytes, pvd + 813, '1996022912000000');

  const end = 17 * ISO_SECTOR;
  bytes[end] = 255;
  ascii(bytes, end + 1, 'CD001');
  bytes[end + 6] = 1;

  let dir = 18 * ISO_SECTOR;
  dir += directoryRecord(bytes, dir, 18, ISO_SECTOR, 2, [0]);
  dir += directoryRecord(bytes, dir, 18, ISO_SECTOR, 2, [1]);
  directoryRecord(bytes, dir, 19, 4, 0,
    Array.from(Buffer.from('CIV2.EXE;1', 'ascii')));
  bytes.set([0x4d, 0x5a, 0x90, 0x00], 19 * ISO_SECTOR);
  return bytes;
}

function rawMode1(iso) {
  const raw = new Uint8Array((iso.length / ISO_SECTOR) * SECTOR_BYTES);
  for (let sector = 0; sector < iso.length / ISO_SECTOR; sector++) {
    raw.set(iso.subarray(sector * ISO_SECTOR, (sector + 1) * ISO_SECTOR),
      sector * SECTOR_BYTES + 16);
  }
  return raw;
}

function countingSource(bytes) {
  let reads = 0;
  return {
    size: bytes.length,
    async readRange(offset, length) {
      reads++;
      return bytes.slice(offset, offset + length);
    },
    get reads() { return reads; },
  };
}

async function main() {
  const cueText = `FILE "track01.bin" BINARY\n` +
    `  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n` +
    `FILE "track02.bin" BINARY\n` +
    `  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n`;
  const cueBytes = new TextEncoder().encode(cueText);
  const data = countingSource(rawMode1(makeIso()));
  const audio = countingSource(new Uint8Array(SECTOR_BYTES));
  const cue = countingSource(cueBytes);
  const selected = [
    { name: 'track02.bin', size: audio.size, source: audio },
    { name: 'Civilization II.cue', size: cue.size, source: cue },
    { name: 'track01.bin', size: data.size, source: data },
  ];

  const plans = await mediaImport.analyzeFiles(selected);
  assert.strictEqual(plans.length, 1, 'one CUE selection should make one import plan');
  const plan = plans[0];
  assert.strictEqual(plan.kind, 'cue');
  assert.match(plan.label, /Mixed-mode CD image/);
  assert.strictEqual(plan.volumeLabel, 'CIV2_TEST');
  assert.deepStrictEqual(plan.exeCandidates.map(item => item.path), ['D:\\CIV2.EXE']);
  assert.strictEqual(plan.storageFiles.length, 3, 'keeping must retain CUE plus both BINs');
  assert.strictEqual(audio.reads, 0, 'analysis must not read an audio track');
  assert.strictEqual(mediaImport.rankCandidates([
    { path: 'D:\\_ISDEL.EXE', name: '_ISDEL.EXE' },
    { path: 'D:\\Autorun.exe', name: 'Autorun.exe' },
    { path: 'D:\\Civ2\\civ2.exe', name: 'civ2.exe' },
  ], 'Civ2:MGE v1.0')[0].path, 'D:\\Civ2\\civ2.exe',
  'the MGE disc should offer the game before its autorun/uninstall helpers');

  const vfs = new VirtualFS();
  const mounted = await plan.mount(vfs);
  assert.strictEqual(mounted.root, 'D:\\');
  assert.strictEqual(vfs.driveTypes.get('d'), 5);
  assert.strictEqual(vfs.volumeLabels.get('d'), 'CIV2_TEST');
  assert(vfs.cdAudioDrives.get('d'), 'the data mount must also expose the CUE TOC');
  assert.strictEqual(audio.reads, 0, 'mounting must leave CD audio lazy');
  assert.deepStrictEqual(Array.from(await vfs.materialize('D:\\CIV2.EXE')),
    [0x4d, 0x5a, 0x90, 0x00]);

  await vfs.cdAudioDrives.get('d').track(2).load();
  assert(audio.reads > 0, 'playing/loading track 2 should fetch its BIN on demand');

  // MODE1/2048 is already the cooked ISO byte stream. This fixture is
  // deliberately not wrapped in a synthetic +16 raw-sector header: applying
  // the MODE1/2352 shortcut to it shifts every volume descriptor and fails.
  const cookedCueText = `FILE "disc.iso" BINARY\n` +
    `  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n`;
  const cookedCue = countingSource(new TextEncoder().encode(cookedCueText));
  const cookedData = countingSource(makeIso());
  const cookedPlans = await mediaImport.analyzeFiles([
    { name: 'Civilization II cooked.cue', size: cookedCue.size, source: cookedCue },
    { name: 'disc.iso', size: cookedData.size, source: cookedData },
  ]);
  assert.strictEqual(cookedPlans.length, 1);
  assert.strictEqual(cookedPlans[0].volumeLabel, 'CIV2_TEST');
  assert.deepStrictEqual(cookedPlans[0].exeCandidates.map(item => item.path), ['D:\\CIV2.EXE']);
  const cookedVfs = new VirtualFS();
  const cookedMounted = await cookedPlans[0].mount(cookedVfs);
  assert.strictEqual(cookedMounted.disc.track(1).playableSectors, 20);
  assert.strictEqual(cookedMounted.disc.leadOutSector, 20);
  assert.deepStrictEqual(Array.from(await cookedVfs.materialize('D:\\CIV2.EXE')),
    [0x4d, 0x5a, 0x90, 0x00]);

  await assert.rejects(() => mediaImport.analyzeFiles([
    { name: 'Civilization II.cue', size: cue.size, source: cue },
    { name: 'track01.bin', size: data.size, source: data },
  ]), /missing file "track02\.bin"/);

  const setup = countingSource(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]));
  const gogBin = countingSource(Uint8Array.from([5, 6, 7, 8]));
  const gogPlans = await mediaImport.analyzeFiles([
    { name: 'setup_civilization_ii_1.0.exe', size: setup.size, source: setup },
    { name: 'setup_civilization_ii_1.0-1.bin', size: gogBin.size, source: gogBin },
  ]);
  assert.strictEqual(gogPlans.length, 1, 'a setup exe and its numbered BIN should be one import');
  assert.strictEqual(gogPlans[0].storageFiles.length, 2);
  assert.match(gogPlans[0].label, /installer data file/);
  const installerVfs = new VirtualFS();
  await gogPlans[0].mount(installerVfs);
  assert(installerVfs.files.has('c:\\setup_civilization_ii_1.0.exe'));
  assert.deepStrictEqual(Array.from(await installerVfs.materialize(
    'C:\\SETUP_CIVILIZATION_II_1.0-1.BIN')), [5, 6, 7, 8]);

  console.log('PASS BYO media groups CUE/BIN, mounts raw MODE1 data lazily, and keeps installer sidecars');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
