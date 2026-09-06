'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { APPS, DESKTOP_APPS, LOCAL_CANDIDATE_APPS, DEBUG_ONLY_APPS } = require('../lib/apps');

const root = path.join(__dirname, '..');
const debugIds = new Set(DEBUG_ONLY_APPS.map(([id]) => id));
const localCandidateIds = new Set(LOCAL_CANDIDATE_APPS.map(([id]) => id));
const expectedLocalCandidates = new Map([
  ['cdplayer', 'binaries/win98-apps/cdplayer.exe'],
  ['elasto_mania', 'test/binaries/candidates/elasto-mania/Elma/Elma.exe'],
  ['jardinains', 'test/binaries/candidates/jardinains/installed/jardinains.exe'],
  ['nethack_win32', 'test/binaries/candidates/nethack-win32/installed/NetHackW.exe'],
  ['jazz2_demo', 'test/binaries/candidates/jazz-jackrabbit-2-demo-installer/installed/jazz2.exe'],
  ['quake2_demo', 'test/binaries/candidates/quake-2-demo-installer/installed-extracted/Install/Data/quake2.exe'],
  ['quake2_demo_installer', 'test/binaries/candidates/quake-2-demo-installer/q2-314-demo-x86.exe'],
  ['heroes3_demo', 'test/binaries/candidates/heroes-3-demo-installer/installed-extracted/Program_Files/h3demo.exe'],
  ['heroes3_demo_installer', 'test/binaries/candidates/heroes-3-demo-installer/installer-engine/_ins5576._mp'],
  ['diablo2_demo', 'test/binaries/candidates/diablo-2-demo-installer/installed-extracted/diablo ii.exe'],
  ['diablo2_demo_installer', 'test/binaries/candidates/diablo-2-demo-installer/DiabloIIDemo.exe'],
  ['gta2_demo', 'test/binaries/candidates/gta2-demo/installed/Program_Executable_Files/gta2.exe'],
  ['halflife_uplink', 'test/binaries/candidates/half-life-uplink-installer/installed/hldemo.exe'],
  ['halflife_uplink_installer', 'test/binaries/candidates/half-life-uplink-installer/hluplink.exe'],
]);
for (const [id, exe] of expectedLocalCandidates) {
  assert(localCandidateIds.has(id),
    `${id} is reachable from the localhost-only app dropdown`);
  assert(APPS[id], `${id} has an app manifest`);
  assert.strictEqual(APPS[id].exe, exe, `${id} launches the pinned local payload`);
}
assert(APPS.jazz2_demo, 'Jazz Jackrabbit 2 has an app manifest');
assert.strictEqual(APPS.jardinains.requiredFiles, true);
assert.strictEqual(APPS.jardinains.asyncMultimediaTimer, true,
  'Jardinains advances its Blitz multimedia timers while the guest runs');
assert.strictEqual(APPS.jardinains.localFileManifest,
  'test/binaries/candidates/jardinains/installed/.wine-assembly-browser.json');
assert.deepStrictEqual(APPS.nethack_win32.environment, { HACKDIR: 'C:\\' });
assert.strictEqual(APPS.nethack_win32.localFileManifest,
  'test/binaries/candidates/nethack-win32/.wine-assembly-browser.json');
assert.deepStrictEqual(APPS.nethack_win32.persistFiles,
  ['c:\\user-*.0', 'c:\\record']);
const browserShellSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'browser-shell.js'), 'utf8');
const cliSource = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
assert(browserShellSource.includes('Object.entries(app.environment || {})') &&
  browserShellSource.includes("callGuest('set_process_environment_a'"),
  'browser launch applies registered environments in both guest modes');
assert(cliSource.includes('(ASSET_ENTRY && ASSET_ENTRY.environment) || {}') &&
  cliSource.includes('processEnvironment.set(name, value)'),
  'CLI launch merges registered environments before explicit --env overrides');
assert.strictEqual(APPS.elasto_mania.requiredFiles, true);
assert.strictEqual(APPS.elasto_mania.localFileManifest,
  'test/binaries/candidates/elasto-mania/.wine-assembly-browser.json');
assert.deepStrictEqual(APPS.elasto_mania.persistFiles,
  ['c:\\state.dat', 'c:\\stats.txt', 'c:\\Rec\\*.rec']);
assert.strictEqual(APPS.jazz2_demo.requiredFiles, true);
assert(APPS.jazz2_demo.files.some(file => file.endsWith('/share1.j2l')),
  'Jazz Jackrabbit 2 mounts its playable shareware level');
assert.strictEqual(APPS.jazz2_demo.args, 'Share1.j2l -nonetwork',
  'Jazz Jackrabbit 2 skips the long intro and loads the playable shareware level');
assert.strictEqual(APPS.quake2_demo.args, '+set vid_ref gl +menu_main',
  'Quake II starts its normal OpenGL-rendered menu from the dropdown');
assert(APPS.quake2_demo.files.some(file => file.url === 'lib/quake2-modern-controls.ini' &&
  file.vfsPath === 'c:\\baseq2\\config.cfg'),
  'Quake II mounts modern WASD/mouse controls as its first-launch config');
assert.deepStrictEqual(APPS.quake2_demo.persistFiles, ['c:\\baseq2\\config.cfg'],
  'Quake II restores and persists later user control changes over the defaults');
assert.deepStrictEqual(APPS.mcm.persistFiles, [
  'c:\\ui\\uilst.ini',
  'c:\\ui\\profile\\*\\*.prf',
], 'Motocross Madness restores its profile index and per-player settings');
const aoe1 = APPS.aoe1;
const aoe1File = name => aoe1.files.find(file => file.url.endsWith('/' + name));
assert.strictEqual(aoe1.requiredFiles, true);
assert.strictEqual(aoe1File('Armies_1.cpn').vfsPath, 'c:\\campaign\\armies_1.cpn',
  'Age of Empires mounts campaigns where its enumerator subsequently opens them');
assert.strictEqual(aoe1File('Multip_1.scn').vfsPath, 'c:\\scenario\\multip_1.scn',
  'Age of Empires mounts scenarios under its runtime scenario directory');
assert.strictEqual(aoe1File('Scenario.inf').vfsPath, 'c:\\scenario\\scenario.inf');
assert.strictEqual(aoe1File('Empires.dat').vfsPath, 'c:\\data\\empires.dat');
assert.strictEqual(aoe1File('Tileedge.dat').vfsPath, 'c:\\data\\tileedge.dat',
  'Age of Empires mounts the terrain edge table at the path hard-coded by the renderer');
assert.strictEqual(aoe1File('Music1.mid').vfsPath, 'c:\\sound\\music1.mid');
const quake2Controls = fs.readFileSync(path.join(root, 'lib/quake2-modern-controls.ini'), 'utf8');
for (const binding of [
  'bind w "+forward"', 'bind s "+back"', 'bind a "+moveleft"',
  'bind d "+moveright"', 'bind MOUSE1 "+attack"', 'set freelook "1"',
]) {
  assert(quake2Controls.includes(binding), `Quake II modern controls include ${binding}`);
}
assert(APPS.quake2_demo.dlls.some(file => file.endsWith('/ref_gl.dll')),
  'Quake II preloads its authentic OpenGL renderer for runtime selection');
assert(APPS.quake2_demo.files.some(file =>
  typeof file === 'string' && file.endsWith('/ref_gl.dll')),
  'Quake II mounts ref_gl.dll at C:\\ref_gl.dll for LoadLibrary');
assert.strictEqual(APPS.halflife_uplink.requiredFiles, true);
assert.strictEqual(APPS.halflife_uplink.windowlessGraceMs, 60000,
  'Half-Life Uplink survives the renderer-init gap after its socket warning');
assert.deepStrictEqual(APPS.halflife_uplink.dlls, [
  'test/binaries/candidates/half-life-uplink-installer/installed/hw.dll',
  'test/binaries/candidates/half-life-uplink-installer/installed/sw.dll',
  'test/binaries/candidates/half-life-uplink-installer/installed/hl_res.dll',
  'test/binaries/candidates/half-life-uplink-installer/installed/a3dapi.dll',
  'test/binaries/candidates/half-life-uplink-installer/installed/valve/dlls/hl.dll',
  'test/binaries/candidates/half-life-uplink-installer/installed/valve/cl_dlls/client.dll',
]);
assert(APPS.halflife_uplink.files.some(file =>
  file.url.endsWith('/valve/pak0.pak') && file.vfsPath === 'c:\\valve\\pak0.pak'),
'Half-Life Uplink mounts the complete installer-produced PAK');
assert(APPS.halflife_uplink.files.some(file =>
  file.url.endsWith('/media/intro.avi') && file.vfsPath === 'c:\\media\\intro.avi'),
'Half-Life Uplink mounts its MCI intro video at the runtime path');
assert.strictEqual(APPS.diablo2_demo.requiredFiles, true);
assert.strictEqual(APPS.diablo2_demo.fileConcurrency, 10);
assert(APPS.diablo2_demo.dlls.some(file => file.endsWith('/d2ddraw.dll')),
  'Diablo II preloads its selected DirectDraw renderer');
assert(APPS.diablo2_demo.files.some(file => file.endsWith('/d2data.mpq')),
  'Diablo II mounts its installer-produced data archive');
assert(APPS.diablo2_demo.files.some(file => file.endsWith('/d2music.mpq')),
  'Diablo II mounts its installer-produced music archive');
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
assert.strictEqual(starcraft.args, 'ophelia terran1',
  'StarCraft starts the first Terran mission without disabling DirectSound');
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
assert.deepStrictEqual(diabloShareware.persistFiles, ['c:\\spawn_*.sv'],
  'Diablo Shareware persists the save archive created beside its executable');
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

const diablo2Demo = APPS.diablo2_demo;
for (const renderer of ['d2direct3d.dll', 'd2gdi.dll', 'd2glide.dll']) {
  assert(!diablo2Demo.dlls.some(file => file.endsWith('/' + renderer)),
    `${renderer} is an alternate renderer, not a startup DLL seed`);
  assert(diablo2Demo.files.some(file => file.endsWith('/' + renderer)),
    `${renderer} remains available for on-demand LoadLibrary`);
}
assert(diablo2Demo.dlls.some(file => file.endsWith('/d2ddraw.dll')),
  'the selected DirectDraw renderer remains in the startup dependency graph');

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
const browserShell = fs.readFileSync(path.join(root, 'lib/browser-shell.js'), 'utf8');
assert(/<script src="lib\/apps\.js\?v=24"><\/script>/.test(html),
  'the browser fetches the playable Jardinains asset manifest');
assert(/case 'quake2_demo':\s*return 10000;/.test(browserShell),
  'Quake II OpenGL startup uses the proven cooperative browser slice');
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
