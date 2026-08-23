'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { APPS, DEBUG_ONLY_APPS } = require('../lib/apps');

const root = path.join(__dirname, '..');
const debugIds = new Set(DEBUG_ONLY_APPS.map(([id]) => id));
for (const id of ['diablo_demo', 'starcraft_shareware', 'fallout_demo', 'total_annihilation_demo']) {
  assert(debugIds.has(id), `${id} is reachable from the debug app selector`);
  assert(APPS[id], `${id} has an app manifest`);
}

const starcraft = APPS.starcraft_shareware;
assert.strictEqual(starcraft.args, 'ophelia terran1 nosound');
assert(starcraft.requiredFiles);
assert(starcraft.files.some(file =>
  file.url.endsWith('/stardatsw.mpq') &&
  file.vfsPaths.includes('c:\\stardatsw.mpq') &&
  file.vfsPaths.includes('c:\\program files\\starcraft shareware\\stardatsw.mpq')),
'StarCraft mounts its installed MPQ at both proven paths');
assert(starcraft.files.some(file =>
  file.url.endsWith('/disc/INSTALL.EXE') && file.vfsPath === 'c:\\install.exe'),
'StarCraft mounts the original shareware CD container where its StarCD check opens it');

const starcraftReg = new Map(starcraft.startupRegistry.map(entry =>
  [entry.valueName, entry.data]));
assert.strictEqual(starcraftReg.get('InstallPath'),
  'C:\\Program Files\\Starcraft Shareware');
assert.strictEqual(starcraftReg.get('Program'),
  'C:\\Program Files\\Starcraft Shareware\\Starcraft.exe');
assert.strictEqual(starcraftReg.get('StarCD'), 'C');

const fallout = APPS.fallout_demo;
assert(fallout.requiredFiles);
assert.deepStrictEqual(fallout.files,
  ['test/binaries/candidates/fallout-demo/falldemo/Falldemo.dat']);

const totalAnnihilation = APPS.total_annihilation_demo;
assert.strictEqual(totalAnnihilation.exe,
  'test/binaries/candidates/total-annihilation-demo/installed-fixed/cavedog/totala/demo/tademo.exe');
assert.strictEqual(totalAnnihilation.requiredFiles, true);
assert.deepStrictEqual(totalAnnihilation.files, [{
  url: 'test/binaries/candidates/total-annihilation-demo/installed-fixed/cavedog/totala/demo/tademo.hpi',
  vfsPath: 'c:\\tademo.hpi',
}], 'Total Annihilation mounts the validated native-installer HPI at its runtime path');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
for (const id of ['diablo_demo', 'starcraft_shareware', 'fallout_demo', 'total_annihilation_demo']) {
  assert(new RegExp(`<option value=["']${id}["']>`).test(html),
    `${id} has a static debug-selector option`);
}

console.log('test-debug-game-apps: PASS');
