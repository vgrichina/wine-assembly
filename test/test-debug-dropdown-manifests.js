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
  ['scr_scifi', 'SCIFI.SCN', ['SF_PINCE.X', 'SF_BACK.GIF']],
]) {
  assert(hasBasename(id, scene), `${id} must mount its Organic Art scene`);
  for (const asset of assets) assert(hasBasename(id, asset), `${id} must mount ${asset}`);
  assert.strictEqual(APPS[id].requiredFiles, true, `${id} assets must be launch-critical`);
}

assert(urls('scr_oasaver').filter(url => /\/CA_.*\.SCN$/i.test(url)).length >= 20,
  'Organic Art Saver must mount its default scene collection');

const mw3 = APPS.mw3.files.filter(item => item && typeof item === 'object');
assert(mw3.some(item => item.vfsPath.toLowerCase() === 'c:\\zbd\\reader.zbd'),
  'MechWarrior 3 must mount its bootstrap database at c:\\zbd\\reader.zbd');
assert(mw3.some(item => item.vfsPath.toLowerCase() === 'c:\\zbd\\c4\\gamez.zbd'),
  'MechWarrior 3 must preserve nested database paths');
assert.strictEqual(APPS.mw3.requiredFiles, true,
  'MechWarrior 3 database files must be launch-critical');

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
