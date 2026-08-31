#!/usr/bin/env node

// A CD names its own program: Win98 launches whatever the disc's AUTORUN.INF
// [autorun] open= line points at. The generic exe ranking deliberately sinks
// "autorun"-named files (right for a zip of a game, wrong for a disc that
// says so) — the retail Diablo CD defaulted to DRTL104.EXE, its 1.04 patch,
// instead of the launcher until analyzeIso learned to read the INF.

'use strict';

const assert = require('assert');
const mediaImport = require('../lib/media-import');

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

// The retail-Diablo shape: an INF naming AUTORUN.EXE, beside a patch and a
// setup stub the filename heuristic would otherwise prefer or sink.
function makeIso(infText) {
  const files = [
    { name: 'AUTORUN.EXE;1', lba: 19 },
    { name: 'DRTL104.EXE;1', lba: 20 },
    { name: 'SETUP.EXE;1', lba: 21 },
  ];
  const sectors = 23;
  const bytes = new Uint8Array(sectors * ISO_SECTOR);
  const pvd = 16 * ISO_SECTOR;
  bytes[pvd] = 1;
  ascii(bytes, pvd + 1, 'CD001');
  bytes[pvd + 6] = 1;
  ascii(bytes, pvd + 40, 'DIABLO_TEST', 32);
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
  const inf = infText === null ? null : Buffer.from(infText, 'ascii');
  for (const file of files) {
    dir += directoryRecord(bytes, dir, file.lba, 4, 0, file.name);
    bytes.set([0x4d, 0x5a, 0x90, 0x00], file.lba * ISO_SECTOR);
  }
  if (inf) {
    dir += directoryRecord(bytes, dir, 22, inf.length, 0, 'AUTORUN.INF;1');
    bytes.set(inf, 22 * ISO_SECTOR);
  }
  return bytes;
}

async function main() {
  // --- the parser alone ----------------------------------------------------
  assert.strictEqual(mediaImport.autorunInfTarget(
    '[autorun]\r\nopen=autorun.exe\r\nicon=autorun.exe,0\r\n'), 'autorun.exe');
  assert.strictEqual(mediaImport.autorunInfTarget(
    ';comment\n[AutoRun]\nOPEN = "SUB DIR\\GAME.EXE" /nosound\n'),
  'SUB DIR\\GAME.EXE', 'quoted values keep spaces, arguments drop');
  assert.strictEqual(mediaImport.autorunInfTarget(
    '[autorun]\nopen=.\\setup.exe /auto extra\n'), 'setup.exe',
  'leading .\\ strips, unquoted arguments drop');
  assert.strictEqual(mediaImport.autorunInfTarget(
    '[autorun]\nshellexecute=index.exe\n'), 'index.exe',
  'shellexecute is the fallback when open is absent');
  assert.strictEqual(mediaImport.autorunInfTarget(
    '[autorun]\nopen=first.exe\nopen=second.exe\n'), 'first.exe');
  assert.strictEqual(mediaImport.autorunInfTarget(
    '[other]\nopen=notme.exe\n'), null,
  'only the [autorun] section counts');

  // --- through analyze() on a synthetic disc -------------------------------
  const withInf = await mediaImport.analyze(
    makeIso('[autorun]\nopen=autorun.exe\nicon=autorun.exe,0\n'),
    { name: 'DIABLO.ISO' });
  assert.strictEqual(withInf.kind, 'iso');
  assert.strictEqual(withInf.exeCandidates[0].path, 'D:\\AUTORUN.EXE',
    'the INF-named program is the default');
  assert.strictEqual(withInf.exeCandidates[0].autorun, true);
  assert.strictEqual(withInf.exeCandidates.length, 3,
    'the other programs stay offered, only ordered');

  const noInf = await mediaImport.analyze(makeIso(null), { name: 'DIABLO.ISO' });
  assert.notStrictEqual(noInf.exeCandidates[0].path, 'D:\\AUTORUN.EXE',
    'without an INF the ranking still sinks autorun-named files');

  const badTarget = await mediaImport.analyze(
    makeIso('[autorun]\nopen=missing.exe\n'), { name: 'DIABLO.ISO' });
  assert.notStrictEqual(badTarget.exeCandidates[0].path, 'D:\\AUTORUN.EXE',
    'an INF naming a file the disc does not have falls back to the ranking');

  console.log('PASS test-media-autorun-inf');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
