'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { APPS, DESKTOP_APPS, LOCAL_CANDIDATE_APPS, DEBUG_ONLY_APPS } = require('../lib/apps');

const root = path.join(__dirname, '..');
const debugIds = new Set(DEBUG_ONLY_APPS.map(([id]) => id));
const localCandidateIds = new Set(LOCAL_CANDIDATE_APPS.map(([id]) => id));
const expectedLocalCandidates = new Map([
  ['jazz2_demo', 'test/binaries/candidates/jazz-jackrabbit-2-demo-installer/installed/jazz2.exe'],
  ['quake2_demo', 'test/binaries/candidates/quake-2-demo-installer/installed-extracted/Install/Data/quake2.exe'],
  ['quake2_demo_installer', 'test/binaries/candidates/quake-2-demo-installer/q2-314-demo-x86.exe'],
  ['heroes3_demo', 'test/binaries/candidates/heroes-3-demo-installer/installed-extracted/Program_Files/h3demo.exe'],
  ['heroes3_demo_installer', 'test/binaries/candidates/heroes-3-demo-installer/installer-engine/_ins5576._mp'],
  ['diablo2_demo_installer', 'test/binaries/candidates/diablo-2-demo-installer/DiabloIIDemo.exe'],
  ['halflife_uplink_installer', 'test/binaries/candidates/half-life-uplink-installer/hluplink.exe'],
]);
for (const [id, exe] of expectedLocalCandidates) {
  assert(localCandidateIds.has(id),
    `${id} is reachable from the localhost-only app dropdown`);
  assert(APPS[id], `${id} has an app manifest`);
  assert.strictEqual(APPS[id].exe, exe, `${id} launches the pinned local payload`);
}
assert(APPS.jazz2_demo, 'Jazz Jackrabbit 2 has an app manifest');
assert.strictEqual(APPS.jazz2_demo.requiredFiles, true);
assert(APPS.jazz2_demo.files.some(file => file.endsWith('/share1.j2l')),
  'Jazz Jackrabbit 2 mounts its playable shareware level');
for (const id of ['diablo_demo', 'diablo_shareware', 'worms2_demo', 'starcraft_shareware', 'fallout_demo',
  'total_annihilation_demo', 'caesar3_demo', 'captain_claw_demo']) {
  assert(debugIds.has(id), `${id} is reachable from the debug app selector`);
  assert(APPS[id], `${id} has an app manifest`);
}

// Heroes II ships its own freely-copyable demo data and its assets deploy, so
// it graduated from the debug selector to the public desktop.
const desktopIds = new Set(DESKTOP_APPS.map(([id]) => id));
assert(desktopIds.has('heroes2_demo'), 'Heroes II is a desktop app');
assert(!debugIds.has('heroes2_demo'), 'Heroes II is not listed twice');
assert(APPS.heroes2_demo, 'heroes2_demo has an app manifest');

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

const diabloShareware = APPS.diablo_shareware;
assert.strictEqual(diabloShareware.exe,
  'test/binaries/candidates/diablo-shareware/installed/diablo_s.exe');
assert.strictEqual(diabloShareware.requiredFiles, true);
assert.strictEqual(diabloShareware.asyncMultimediaTimer, true);
assert.deepStrictEqual(diabloShareware.dlls, [
  'test/binaries/candidates/diablo-shareware/installed/storm.dll',
  'test/binaries/candidates/diablo-shareware/installed/diabloui.dll',
  'test/binaries/candidates/diablo-shareware/installed/smackw32.dll',
]);
assert.deepStrictEqual(diabloShareware.files, [
  'test/binaries/candidates/diablo-shareware/installed/spawn.mpq',
  'test/binaries/candidates/diablo-shareware/installed/diablo.ini',
  'test/binaries/candidates/diablo-shareware/installed/battle.snp',
  'test/binaries/candidates/diablo-shareware/installed/standard.snp',
]);

const worms2 = APPS.worms2_demo;
assert.strictEqual(worms2.exe,
  'test/binaries/candidates/worms-2-demo/installed-10oct/worms2.dat');
assert.strictEqual(worms2.requiredFiles, true);
assert(worms2.files.some(file =>
  file.url.endsWith('/data/land.dat') && file.vfsPath === 'c:\\data\\land.dat'),
'Worms 2 mounts the installed terrain archive at its runtime path');
assert(worms2.files.some(file =>
  file.url.endsWith('/data/level/medieval/level.dir') &&
  file.vfsPath === 'c:\\data\\level\\medieval\\level.dir'),
'Worms 2 mounts the playable demo level installed by the original setup');
assert(worms2.files.some(file =>
  file.url.endsWith('/data/wav/effects/explosion1.wav') &&
  file.vfsPath === 'c:\\data\\wav\\effects\\explosion1.wav'),
'Worms 2 mounts its installed DirectSound effects');

const fallout = APPS.fallout_demo;
assert(fallout.requiredFiles);
assert.deepStrictEqual(fallout.files,
  ['test/binaries/candidates/fallout-demo/falldemo/Falldemo.dat']);

const heroes2 = APPS.heroes2_demo;
assert.strictEqual(heroes2.args, '/R0');
assert.deepStrictEqual(heroes2.dlls, [
  'test/binaries/candidates/heroes-2-demo/files/MSS32.DLL',
  'test/binaries/candidates/heroes-2-demo/files/SMACKW32.DLL',
]);
assert(heroes2.requiredFiles);
assert(heroes2.files.some(file =>
  file.url.endsWith('/DATA/HEROES2.AGG') && file.vfsPath === 'c:\\data\\heroes2.agg'),
'Heroes II mounts its aggregate at the path opened by the demo');
assert(heroes2.files.some(file =>
  file.url.endsWith('/MAPS/BROKENA.MP2') && file.vfsPath === 'c:\\maps\\brokena.mp2'),
'Heroes II mounts the playable Broken Alliance scenario');

const totalAnnihilation = APPS.total_annihilation_demo;
assert.strictEqual(totalAnnihilation.exe,
  'test/binaries/candidates/total-annihilation-demo/installed-fixed/cavedog/totala/demo/tademo.exe');
assert.strictEqual(totalAnnihilation.requiredFiles, true);
assert.deepStrictEqual(totalAnnihilation.files, [{
  url: 'test/binaries/candidates/total-annihilation-demo/installed-fixed/cavedog/totala/demo/tademo.hpi',
  vfsPath: 'c:\\tademo.hpi',
}], 'Total Annihilation mounts the validated native-installer HPI at its runtime path');

const caesar3 = APPS.caesar3_demo;
assert.strictEqual(caesar3.exe,
  'test/binaries/candidates/caesar-3-demo/installed/c3.exe');
assert.deepStrictEqual(caesar3.dlls, [
  'test/binaries/candidates/caesar-3-demo/installed/SMACKW32.DLL',
]);
assert.strictEqual(caesar3.requiredFiles, true);
assert(caesar3.files.some(file =>
  file.url.endsWith('/mission1.pak') && file.vfsPath === 'c:\\mission1.pak'),
'Caesar III mounts its playable demo mission at the installed runtime path');
assert(caesar3.files.some(file =>
  file.url.endsWith('/Wavs/rome1.wav') && file.vfsPath === 'c:\\wavs\\rome1.wav'),
'Caesar III mounts the complete native demo narration instead of an interrupted installer file');

const captainClaw = APPS.captain_claw_demo;
assert.strictEqual(captainClaw.exe,
  'test/binaries/candidates/captain-claw-demo/installed/clawdemo.exe');
assert.deepStrictEqual(captainClaw.dlls, [
  'test/binaries/candidates/captain-claw-demo/installed/mss32.dll',
]);
assert.strictEqual(captainClaw.requiredFiles, true);
assert.deepStrictEqual(captainClaw.files, [
  'test/binaries/candidates/captain-claw-demo/installed/clawdemo.rez',
]);
const captainClawReg = new Map(captainClaw.startupRegistry.map(entry =>
  [entry.valueName, entry.data]));
assert.strictEqual(captainClawReg.get('Skip Joystick Calibration Test'), 1);
assert.strictEqual(captainClawReg.get('Skip Title Screen'), 1);
assert.strictEqual(captainClawReg.get('Skip Logo Movies'), 1);

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(/<option value=["']jazz2_demo["']>Jazz Jackrabbit 2 Demo<\/option>/.test(html),
  'Jazz Jackrabbit 2 has a static option for the localhost debug dropdown');
for (const id of expectedLocalCandidates.keys()) {
  assert(new RegExp(`<option value=["']${id}["']>`).test(html),
    `${id} has a static option for the localhost debug dropdown`);
}
assert(/DEFAULT_APPS\.concat\(DEBUG_ONLY_APPS,\s*LOCAL_DESKTOP\s*\?\s*LOCAL_CANDIDATE_APPS\s*:\s*\[\]\)/s.test(html),
  'debug mode retains localhost-only candidates when running on a local origin');
for (const id of ['diablo_demo', 'diablo_shareware', 'worms2_demo', 'starcraft_shareware', 'fallout_demo', 'heroes2_demo',
  'total_annihilation_demo', 'caesar3_demo', 'captain_claw_demo']) {
  assert(new RegExp(`<option value=["']${id}["']>`).test(html),
    `${id} has a static debug-selector option`);
}

console.log('test-debug-game-apps: PASS');
