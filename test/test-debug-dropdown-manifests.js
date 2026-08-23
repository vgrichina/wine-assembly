#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { APPS } = require(path.join(ROOT, 'lib', 'apps.js'));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const select = html.match(/<select id="app-select">([\s\S]*?)<\/select>/);
assert(select, 'index.html has no #app-select');
const dropdownIds = [...select[1].matchAll(/<option value="([^"]+)"/g)]
  .map(match => match[1]);

assert.strictEqual(new Set(dropdownIds).size, dropdownIds.length,
  'debug dropdown app IDs must be unique');
for (const id of dropdownIds) assert(APPS[id], `debug dropdown app ${id} is not registered`);

function urls(id) {
  return (APPS[id].files || []).map(item => typeof item === 'string' ? item : item.url);
}

function hasBasename(id, name) {
  return urls(id).some(url => path.basename(url).toLowerCase() === name.toLowerCase());
}

for (const [id, scene, assets] of [
  ['scr_fallingl', 'FALLINGL.SCN', ['LEAF.X', 'LEAVES.GIF']],
  ['scr_geometry', 'GEOMETRY.SCN', ['GE_MESH1.X', 'GE_BACK.GIF']],
  ['scr_jazz', 'JAZZ.SCN', ['JA_NOTE2.X', 'JA_NOTE4.X']],
  // Without its scene ROCKROLL.SCR puts up "Couldn't find any scene
  // definitions in location '.\;.' - reinstall?" and never draws.
  ['scr_rockroll', 'ROCKROLL.SCN', ['RO_GIT.X', 'RO_PICK.X', 'RO_BACK.GIF']],
  ['scr_scifi', 'SCIFI.SCN', ['SF_PINCE.X', 'SF_BACK.GIF']],
]) {
  assert(hasBasename(id, scene), `${id} must mount its Organic Art scene`);
  for (const asset of assets) assert(hasBasename(id, asset), `${id} must mount ${asset}`);
  assert.strictEqual(APPS[id].requiredFiles, true, `${id} assets must be launch-critical`);
}

assert(urls('scr_oasaver').filter(url => /\/CA_.*\.SCN$/i.test(url)).length >= 20,
  'Organic Art Saver must mount its default scene collection');

for (const [id, prefix, count, theme] of [
  ['scr_corbis', 'CP_SCN', 16, 'corbis'],
  ['scr_fashion', 'FA_SCN', 13, 'fashion'],
  ['scr_horror', 'HO_SCR', 15, 'horror'],
  ['scr_wotravel', 'WO_SCN', 14, 'wotravel'],
]) {
  const frames = (APPS[id].files || []).filter(item => item && typeof item === 'object');
  assert.strictEqual(frames.length, count, `${id} must mount all original Plus! 98 frames`);
  const first = `${prefix}01.JPG`;
  const last = `${prefix}${String(count).padStart(2, '0')}.JPG`;
  assert(hasBasename(id, first) && hasBasename(id, last),
    `${id} must mount its complete ${first} through ${last} sequence`);
  assert(frames.every(item => (item.vfsPaths || []).some(vfsPath =>
    vfsPath.toLowerCase().startsWith(`c:\\program files\\plus!\\themes\\${theme}\\`))),
  `${id} frames must preserve their hard-coded Plus! 98 theme path`);
  assert(frames.every(item => item.decodeImage === true),
    `${id} frames must be decoded before the synchronous DirectAnimation timeline starts`);
  assert.strictEqual(APPS[id].requiredFiles, true, `${id} frames must be launch-critical`);
}

const mw3 = APPS.mw3.files.filter(item => item && typeof item === 'object');
assert(mw3.some(item => item.vfsPath.toLowerCase() === 'c:\\zbd\\reader.zbd'),
  'MechWarrior 3 must mount its bootstrap database at c:\\zbd\\reader.zbd');
assert(mw3.some(item => item.vfsPath.toLowerCase() === 'c:\\zbd\\c4\\gamez.zbd'),
  'MechWarrior 3 must preserve nested database paths');
assert.strictEqual(APPS.mw3.requiredFiles, true,
  'MechWarrior 3 database files must be launch-critical');

const rodentLevels = APPS.rodent2000.files.filter(item => item && typeof item === 'object');
for (const level of ['00000', '00001', '00002', '00003', '00004', 'new']) {
  assert(rodentLevels.some(item => item.vfsPath.toLowerCase() === `c:\\levels\\${level}.rodent_level`),
    `Rodent2000 must mount ${level}.rodent_level in its runtime Levels directory`);
}
assert.strictEqual(APPS.rodent2000.requiredFiles, true,
  'Rodent2000 levels must be launch-critical');

assert(hasBasename('jigssawme', 'LDMinMax6.ocx'),
  'JigSawedME must mount its custom VB6 control');
assert(hasBasename('jigssawme', 'piecelock.wav'),
  'JigSawedME must mount its gameplay sound');
assert.strictEqual(APPS.jigssawme.requiredFiles, true,
  'JigSawedME sidecars must be launch-critical');
assert((APPS.jigssawme.startupRegistry || []).some(entry =>
  entry.keyPath.toLowerCase() === 'hkcr\\clsid\\{af3f3434-a691-11d3-a934-00e029417274}\\inprocserver32' &&
  entry.valueName === '' && String(entry.data).toLowerCase() === 'c:\\ldminmax6.ocx'),
  'JigSawedME must register LDMinMax6.ocx as its in-process COM server');

assert((APPS.explorer98.dlls || []).some(url =>
  path.basename(url).toLowerCase() === 'shdoc401.dll'),
  'Explorer 98 must mount SHDOC401.dll for SHDOCVW compatibility ordinals');
assert((APPS.explorer98.dlls || []).some(url =>
  path.basename(url).toLowerCase() === 'ole32.dll'),
  'Explorer 98 must mount stock OLE32.dll for SHELL32 allocation and COM');

assert.strictEqual(APPS.total_annihilation_demo.requiredFiles, true,
  'Total Annihilation HPI must be launch-critical');
assert((APPS.total_annihilation_demo.files || []).some(item =>
  item.url.endsWith('/installed-fixed/cavedog/totala/demo/tademo.hpi') &&
  item.vfsPath.toLowerCase() === 'c:\\tademo.hpi'),
  'Total Annihilation must mount the validated HPI at c:\\tademo.hpi');

// WELCOME.EXE opens welcome.dat as its second act and exits when it is
// missing, so the file is not optional and the path it is mounted at is the
// whole point — the exe looks under the per-user Application Data tree, not
// beside itself.
assert((APPS.welcome98.files || []).some(item => item &&
  path.basename(item.url || '').toLowerCase() === 'welcome.dat' &&
  String(item.vfsPath || '').toLowerCase() ===
    'c:\\windows\\application data\\microsoft\\welcome\\welcome.dat'),
'Welcome to Windows 98 must mount welcome.dat under Application Data');

console.log(`PASS  ${dropdownIds.length} debug dropdown IDs are registered and corrected data manifests are complete`);
