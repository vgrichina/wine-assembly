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

function makeIso(withAutorun = false) {
  const sectors = withAutorun ? 24 : 20;
  const bytes = new Uint8Array(sectors * ISO_SECTOR);
  const pvd = 16 * ISO_SECTOR;
  bytes[pvd] = 1;
  ascii(bytes, pvd + 1, 'CD001');
  bytes[pvd + 6] = 1;
  ascii(bytes, pvd + 40, 'CIV2_TEST', 32);
  both32(bytes, pvd + 80, sectors);
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
  dir += directoryRecord(bytes, dir, 19, 4, 0,
    Array.from(Buffer.from('CIV2.EXE;1', 'ascii')));
  bytes.set([0x4d, 0x5a, 0x90, 0x00], 19 * ISO_SECTOR);
  if (withAutorun) {
    dir += directoryRecord(bytes, dir, 20, 4, 0,
      Array.from(Buffer.from('SETUP.EXE;1', 'ascii')));
    dir += directoryRecord(bytes, dir, 21, 4, 0,
      Array.from(Buffer.from('SETUP_DE.EXE;1', 'ascii')));
    const inf = Buffer.from('[autorun]\r\nopen=setup.exe\r\n', 'ascii');
    dir += directoryRecord(bytes, dir, 22, inf.length, 0,
      Array.from(Buffer.from('AUTORUN.INF;1', 'ascii')));
    const ini = Buffer.from('[Startup]\r\nSourcePath=D:\\\r\n', 'ascii');
    dir += directoryRecord(bytes, dir, 23, ini.length, 0,
      Array.from(Buffer.from('SETUP.INI;1', 'ascii')));
    bytes.set([0x4d, 0x5a, 0x90, 0x00], 20 * ISO_SECTOR);
    bytes.set([0x4d, 0x5a, 0x90, 0x00], 21 * ISO_SECTOR);
    bytes.set(inf, 22 * ISO_SECTOR);
    bytes.set(ini, 23 * ISO_SECTOR);
  }
  return bytes;
}

function rawMode1(iso) {
  const raw = new Uint8Array((iso.length / ISO_SECTOR) * SECTOR_BYTES);
  for (let sector = 0; sector < iso.length / ISO_SECTOR; sector++) {
    const offset = sector * SECTOR_BYTES;
    raw.fill(0xff, offset + 1, offset + 11); // 00 ff×10 00 sync pattern
    const absoluteFrame = sector + 150;      // raw CD addresses include 2s lead-in
    const bcd = value => ((Math.floor(value / 10) << 4) | (value % 10));
    raw[offset + 12] = bcd(Math.floor(absoluteFrame / (60 * 75)));
    raw[offset + 13] = bcd(Math.floor(absoluteFrame / 75) % 60);
    raw[offset + 14] = bcd(absoluteFrame % 75);
    raw[offset + 15] = 1;                    // Mode 1
    raw.set(iso.subarray(sector * ISO_SECTOR, (sector + 1) * ISO_SECTOR),
      offset + 16);
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
  const data = countingSource(rawMode1(makeIso(true)));
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
  assert.deepStrictEqual(plan.exeCandidates.map(item => item.path),
    ['D:\\SETUP.EXE', 'D:\\CIV2.EXE', 'D:\\SETUP_DE.EXE']);
  assert.strictEqual(plan.exeCandidates[0].autorun, true,
    'a mixed-mode disc must honor AUTORUN.INF before generic candidate ranking');
  assert.strictEqual(plan.storageFiles.length, 3, 'keeping must retain CUE plus both BINs');
  assert.strictEqual(audio.reads, 0, 'analysis must not read an audio track');
  assert.strictEqual(mediaImport.rankCandidates([
    { path: 'D:\\_ISDEL.EXE', name: '_ISDEL.EXE' },
    { path: 'D:\\Autorun.exe', name: 'Autorun.exe' },
    { path: 'D:\\Civ2\\civ2.exe', name: 'civ2.exe' },
  ], 'Civ2:MGE v1.0')[0].path, 'D:\\Civ2\\civ2.exe',
  'the MGE disc should offer the game before its autorun/uninstall helpers');
  assert.deepStrictEqual(mediaImport.rankCandidates([
    { path: 'D:\\setup_de.exe', name: 'setup_de.exe' },
    { path: 'D:\\setup.exe', name: 'setup.exe' },
    { path: 'D:\\setup_fr.exe', name: 'setup_fr.exe' },
  ], 'Speed Demons').map(item => item.path),
  ['D:\\setup.exe', 'D:\\setup_de.exe', 'D:\\setup_fr.exe'],
  'the unsuffixed installer sorts before localized variants even without autorun metadata');

  const vfs = new VirtualFS();
  const mounted = await plan.mount(vfs);
  assert.strictEqual(mounted.root, 'D:\\');
  assert.strictEqual(vfs.driveTypes.get('d'), 5);
  assert.strictEqual(vfs.volumeLabels.get('d'), 'CIV2_TEST');
  assert(vfs.cdAudioDrives.get('d'), 'the data mount must also expose the CUE TOC');
  assert.strictEqual(audio.reads, 0, 'mounting must leave CD audio lazy');
  assert.strictEqual(vfs.files.get('d:\\setup.ini')._provider, null,
    'mounting must make INI bytes resident for synchronous profile APIs');
  assert.match(Buffer.from(vfs.files.get('d:\\setup.ini').data).toString('ascii'),
    /SourcePath=D:\\/);
  assert(vfs.files.get('d:\\setup_de.exe')._provider,
    'unrelated files must remain lazy');
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

  // A standalone raw-sector BIN has enough information to expose its ISO data
  // volume. The fixture carries real Mode 1 sync/header bytes rather than only
  // mirroring the implementation's 16-byte payload offset.
  const standaloneRaw = rawMode1(makeIso());
  const standalonePlans = await mediaImport.analyzeFiles([
    { name: 'Civilization II.bin', size: standaloneRaw.length,
      source: countingSource(standaloneRaw) },
  ]);
  assert.strictEqual(standalonePlans.length, 1);
  assert.strictEqual(standalonePlans[0].kind, 'iso');
  assert.strictEqual(standalonePlans[0].flavor, 'mode1/2352');
  assert.match(standalonePlans[0].label, /Raw Mode 1/);
  assert.match(standalonePlans[0].warning, /matching \.cue file is required/i);
  assert.strictEqual(standalonePlans[0].inferredTrackLayout, true);
  assert.strictEqual(standalonePlans[0].unparsedTrailingBytes, 0);
  assert.strictEqual(standalonePlans[0].volumeLabel, 'CIV2_TEST');
  assert.deepStrictEqual(standalonePlans[0].exeCandidates.map(item => item.path),
    ['D:\\CIV2.EXE']);
  const standaloneVfs = new VirtualFS();
  await standalonePlans[0].mount(standaloneVfs);
  assert.deepStrictEqual(Array.from(await standaloneVfs.materialize('D:\\CIV2.EXE')),
    [0x4d, 0x5a, 0x90, 0x00]);

  // CD001 at the payload-shaped offset alone is not evidence of a raw CD. The
  // sector must also carry the raw Mode 1 sync/header framing.
  const headerlessRaw = standaloneRaw.slice();
  headerlessRaw.fill(0, 16 * SECTOR_BYTES, 16 * SECTOR_BYTES + 16);
  const headerlessPlans = await mediaImport.analyzeFiles([
    { name: 'headerless.bin', size: headerlessRaw.length,
      source: countingSource(headerlessRaw) },
  ]);
  assert.strictEqual(headerlessPlans[0].kind, 'unknown');

  // Extra raw sectors could be padding or CD-DA. Mount the ISO data volume as
  // a best effort, but preserve that uncertainty as a user-visible warning.
  const possibleMixedMode = new Uint8Array(standaloneRaw.length + SECTOR_BYTES);
  possibleMixedMode.set(standaloneRaw);
  const ambiguousPlans = await mediaImport.analyzeFiles([
    { name: 'possibly-mixed.bin', size: possibleMixedMode.length,
      source: countingSource(possibleMixedMode) },
  ]);
  assert.strictEqual(ambiguousPlans.length, 1);
  assert.strictEqual(ambiguousPlans[0].kind, 'iso');
  assert.strictEqual(ambiguousPlans[0].unparsedTrailingBytes, SECTOR_BYTES);
  assert.match(ambiguousPlans[0].warning, /could not be identified as CD audio/i);
  assert.deepStrictEqual(ambiguousPlans[0].exeCandidates.map(item => item.path),
    ['D:\\CIV2.EXE']);
  const ambiguousVfs = new VirtualFS();
  await ambiguousPlans[0].mount(ambiguousVfs);
  assert.deepStrictEqual(Array.from(await ambiguousVfs.materialize('D:\\CIV2.EXE')),
    [0x4d, 0x5a, 0x90, 0x00]);

  function pcmSectors(count, startFrame = 0) {
    const bytes = new Uint8Array(count * SECTOR_BYTES);
    const view = new DataView(bytes.buffer);
    for (let at = 0, frame = startFrame; at < bytes.length; at += 4, frame++) {
      const sample = Math.round(Math.sin(frame / 24) * 12000);
      view.setInt16(at, sample, true);
      view.setInt16(at + 2, Math.round(sample * 0.8), true);
    }
    return bytes;
  }

  // Repeated Red Book-sized silence pregaps plus smooth PCM recover separate
  // tracks. The final 150-sector silence is lead-out, not another track.
  const gap = new Uint8Array(150 * SECTOR_BYTES);
  const song1 = pcmSectors(800);
  const song2 = pcmSectors(800, song1.length / 4);
  const inferredTail = new Uint8Array(gap.length * 3 + song1.length + song2.length);
  let tailAt = 0;
  for (const part of [gap, song1, gap, song2, gap]) {
    inferredTail.set(part, tailAt);
    tailAt += part.length;
  }
  const rawWithTracks = new Uint8Array(standaloneRaw.length + inferredTail.length);
  rawWithTracks.set(standaloneRaw);
  rawWithTracks.set(inferredTail, standaloneRaw.length);
  const inferredPlans = await mediaImport.analyzeFiles([
    { name: 'two-songs.bin', size: rawWithTracks.length,
      source: countingSource(rawWithTracks) },
  ]);
  const inferred = inferredPlans[0];
  assert.strictEqual(inferred.inferredAudioLayout.confidence, 'high');
  assert.deepStrictEqual(inferred.inferredAudioLayout.tracks, [
    { index0Sector: 20, index1Sector: 170 },
    { index0Sector: 970, index1Sector: 1120 },
  ]);
  assert.match(inferred.warning, /Recovered 2 likely audio tracks/);
  const inferredVfs = new VirtualFS();
  const inferredMounted = await inferred.mount(inferredVfs);
  assert.strictEqual(inferredMounted.disc.audioTracks.length, 2);
  assert.strictEqual(inferredMounted.disc.track(1).playableSectors, 20);
  assert.strictEqual(inferredMounted.disc.track(2).index1Sector, 170);
  assert.strictEqual(inferredMounted.disc.track(3).index1Sector, 1120);

  // Smooth PCM with no convincing gaps still gets useful playback as one
  // combined track, without pretending to know song boundaries.
  const joinedTail = pcmSectors(800);
  const rawWithJoinedAudio = new Uint8Array(standaloneRaw.length + joinedTail.length);
  rawWithJoinedAudio.set(standaloneRaw);
  rawWithJoinedAudio.set(joinedTail, standaloneRaw.length);
  const joinedPlans = await mediaImport.analyzeFiles([
    { name: 'joined-soundtrack.bin', size: rawWithJoinedAudio.length,
      source: countingSource(rawWithJoinedAudio) },
  ]);
  assert.strictEqual(joinedPlans[0].inferredAudioLayout.confidence, 'combined');
  assert.strictEqual(joinedPlans[0].inferredAudioLayout.tracks.length, 1);
  assert.match(joinedPlans[0].warning, /joined as one audio track/);
  const joinedVfs = new VirtualFS();
  const joinedMounted = await joinedPlans[0].mount(joinedVfs);
  assert.strictEqual(joinedMounted.disc.audioTracks.length, 1);

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
