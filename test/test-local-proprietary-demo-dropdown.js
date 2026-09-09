'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  APPS, DESKTOP_APPS, LOCAL_CANDIDATE_APPS, DEBUG_ONLY_APPS,
} = require('../lib/apps');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const localIds = new Set(LOCAL_CANDIDATE_APPS.map(([id]) => id));
const publicIds = new Set(DESKTOP_APPS.map(([id]) => id));
const debugIds = new Set(DEBUG_ONLY_APPS.map(([id]) => id));

function urlOf(file) {
  return typeof file === 'string' ? file : file.url;
}

const proprietaryLocalIds = [
  'deus_ex_demo', 'icewind_dale_demo',
  'baldurs_gate_noninteractive_demo', 'baldurs_gate_interactive_demo',
  'baldurs_gate_chapters_1_2_demo',
  'civ2_win16', 'civ2_mge',
];

for (const id of proprietaryLocalIds) {
  assert(localIds.has(id), `${id} is shown by the localhost-only dropdown`);
  assert(!publicIds.has(id), `${id} is not exposed on the deployed desktop`);
  assert(!debugIds.has(id), `${id} is not duplicated in the debug-only list`);
  assert(APPS[id] && APPS[id].requiredFiles, `${id} has a required-file app manifest`);
  assert(APPS[id].exe.startsWith('test/binaries/candidates/'),
    `${id} launches only an ignored local candidate payload`);
  for (const file of [...APPS[id].files, ...(APPS[id].dlls || [])]) {
    assert(urlOf(file).startsWith('test/binaries/candidates/'),
      `${id} does not reference a deployable proprietary asset: ${urlOf(file)}`);
  }
  assert(html.includes(`<option value="${id}">`),
    `${id} has a concrete toolbar dropdown option before localhost filtering`);
}

const deus = APPS.deus_ex_demo;
assert.strictEqual(deus.exe,
  'test/binaries/candidates/deus-ex-demo/installed/system/deusex.exe');
assert.strictEqual(deus.args, '-windowed');
assert.strictEqual(deus.dlls.length, 13);
for (const suffix of [
  '/system/deusex.ini', '/maps/entry.dx', '/maps/00_training.dx',
  '/help/logo.bmp', '/textures/dxfonts.utx', '/system/deusexui.u',
]) {
  assert(deus.files.some(file => urlOf(file).endsWith(suffix)),
    `Deus Ex manifest includes ${suffix}`);
}
const deusEngine = deus.files.find(file => urlOf(file).endsWith('/system/engine.u'));
assert.deepStrictEqual(deusEngine && deusEngine.vfsPaths,
  ['c:\\Engine.u', 'c:\\System\\Engine.u'],
  'UE1 system packages are visible at both startup and configured lookup paths');
assert(deus.files.some(file => file.vfsPath === 'c:\\Maps\\Entry.dx'),
  'Deus Ex keeps the UE1 sibling Maps directory');

const icewind = APPS.icewind_dale_demo;
assert.strictEqual(icewind.exe,
  'test/binaries/candidates/icewind-dale-demo/installed-extracted/Recommended_compressed/IDDemo.exe');
for (const suffix of [
  '/CHITIN-full.KEY', '/Dialog.tlk', '/Data/DEFAULT.bif', '/Data/GUIbam.bif',
  '/Data/GUImos.bif', '/Data/SNDgen.bif', '/Data/BCSgen.bif',
  '/Data/CREanim.bif', '/Data/CHRanim.bif', '/Data/SNDcreat.bif',
  '/Data/SNDspell.bif', '/Sounds/sndlist.txt',
]) {
  assert(icewind.files.some(file => urlOf(file).endsWith(suffix)),
    `Icewind Dale menu manifest includes ${suffix}`);
}
assert.strictEqual(icewind.files.filter(file => file.vfsPath &&
  /\/Data\/.*\.bif$/i.test(urlOf(file)) &&
  !/\/(?:Cache|Full)\/Data\//i.test(urlOf(file))).length, 34,
  'Icewind Dale mounts every installed CHITIN.KEY location=1 archive');
assert.strictEqual(icewind.files.filter(file => file.vfsPath &&
  /\/Full\/Data\/.*\.bif$/i.test(urlOf(file))).length, 24,
  'Icewind Dale mounts every CD2 CBF expanded by local fixture preparation');
assert(icewind.files.some(file => file.vfsPath === 'c:\\CHITIN.KEY' &&
  urlOf(file).endsWith('/CHITIN-full.KEY')),
  'Icewind Dale mounts the matching full-install KEY at the canonical path');
const disc = icewind.files.find(file => urlOf(file).endsWith('/Data/IWDCD.2'));
assert(disc && disc.vfsPaths.includes('d:\\cd2\\data\\IWDCD.2'),
  'Icewind Dale exposes its authentic CD2 marker on the emulated CD drive');
const cdFiles = icewind.files.filter(file => file.vfsPaths &&
  file.vfsPaths.some(vfsPath => /^d:\\(?:cd2\\)?data\\/i.test(vfsPath)));
assert.strictEqual(cdFiles.length, 27,
  'Icewind Dale mounts every official CD2 gameplay archive and marker');
for (const suffix of ['/Data/AR100A.cbf', '/Data/MVEfile2.bif']) {
  const file = cdFiles.find(item => urlOf(item).endsWith(suffix));
  assert(file && file.vfsPaths.includes('d:\\data\\' + suffix.split('/').pop()),
    `Icewind Dale maps ${suffix} onto the D: data CD`);
}
assert(icewind.files.some(file => file.vfsPath === 'c:\\Sounds\\sndlist.txt'),
  'Icewind Dale mounts the installed sound-set guide');
const icewindVoiceFiles = icewind.files.filter(file =>
  /^c:\\Sounds\\[^\\]+\\[^\\]+_\d\d\.wav$/i.test(file.vfsPath || ''));
assert.strictEqual(icewindVoiceFiles.length, 640,
  'Icewind Dale mounts all 16 installed 40-line voice sets');
assert.strictEqual(new Set(icewindVoiceFiles.map(file =>
  file.vfsPath.split('\\')[2])).size, 16,
  'Icewind Dale creates every installed voice-set directory');
for (const vfsPath of [
  'c:\\Sounds\\Female_Fighter_1\\DFF_01.wav',
  'c:\\Sounds\\Male_Thief_2\\HeMT_40.wav',
]) {
  assert(icewindVoiceFiles.some(file => file.vfsPath === vfsPath),
    `Icewind Dale mounts official voice asset ${vfsPath}`);
}
const icewindOverrideWavs = icewind.files.filter(file =>
  /^c:\\override\\[^\\]+\.wav$/i.test(file.vfsPath || ''));
assert.strictEqual(icewindOverrideWavs.length, 188,
  'Icewind Dale mounts every loose demo narration/NPC voice that replaces the absent retail SNDVO archive');

const baldursNoninteractive = APPS.baldurs_gate_noninteractive_demo;
assert.strictEqual(baldursNoninteractive.exe,
  'test/binaries/candidates/baldurs-gate-noninteractive-demo/Baldur.exe');
for (const vfsPath of [
  'c:\\CHITIN.KEY', 'c:\\NID.bif', 'c:\\NID2.bif',
  'c:\\Music\\sst1\\sst1a.acm',
]) {
  assert(baldursNoninteractive.files.some(file => file.vfsPath === vfsPath),
    `Baldur non-interactive manifest mounts ${vfsPath}`);
}

const baldursInteractive = APPS.baldurs_gate_interactive_demo;
assert.strictEqual(baldursInteractive.exe,
  'test/binaries/candidates/baldurs-gate-interactive-demo/installed-extracted/MinimumData/BGDemo.exe');
for (const vfsPath of [
  'c:\\Chitin.key', 'c:\\dialog.tlk', 'c:\\data\\Areas.bif',
  'c:\\data\\Gui.bif', 'c:\\CD1\\data\\AREA2600.bif',
  'c:\\CD1\\Movies\\Movies.bif', 'c:\\Scripts\\default.bs',
]) {
  assert(baldursInteractive.files.some(file => file.vfsPath === vfsPath),
    `Baldur interactive manifest mounts ${vfsPath}`);
}

const baldursChapters = APPS.baldurs_gate_chapters_1_2_demo;
assert.strictEqual(baldursChapters.exe,
  'test/binaries/candidates/baldurs-gate-chapters-1-2-demo/installed-extracted/MinimumData/BGMain.exe');
for (const vfsPath of [
  'c:\\Chitin.key', 'c:\\dialog.tlk', 'c:\\data\\AreasVE.bif',
  'c:\\data\\Gui.bif', 'c:\\cd1\\data\\AREA2600.bif',
  'c:\\cd1\\movies\\Movies.bif', 'c:\\Override\\WorldMap.WMP',
]) {
  assert(baldursChapters.files.some(file => file.vfsPath === vfsPath),
    `Baldur Chapters I & II manifest mounts ${vfsPath}`);
}
assert.deepStrictEqual(baldursInteractive.persistFiles, baldursChapters.persistFiles,
  'both playable Baldur previews persist character and save-game state');

const civ2Win16 = APPS.civ2_win16;
const civ2Mge = APPS.civ2_mge;
assert.strictEqual(civ2Win16.exe,
  'test/binaries/candidates/civilization-2-win16/cd/CIV2/CIV2.EXE');
assert.strictEqual(civ2Mge.exe,
  'test/binaries/candidates/civilization-2-mge-win32/installed/civ2.exe');
assert.deepStrictEqual(civ2Win16.win16Modules,
  ['WING', 'CIV2ART', 'CV', 'INTRO', 'MK', 'PV', 'SS', 'TILES',
    'TIMERDLL', 'WONDER'],
  'the Win16 dropdown stages WinG and every resource-only artwork library');
assert(civ2Mge.dlls.some(file => /\/XDaemon\.dll$/i.test(file)),
  'the Win32 dropdown seeds the MGE network helper DLL');
for (const app of [civ2Win16, civ2Mge]) {
  assert(app.localFileManifest.endsWith('/.wine-assembly-browser.json'),
    'Civ II reads its ignored prepared file inventory at launch');
  assert(app.cdAudio && /\.cue$/i.test(app.cdAudio.cue),
    'Civ II mounts its authentic mixed-mode disc for CD audio');
}

// If the ignored fixtures are present, every dropdown fetch must resolve now.
for (const id of proprietaryLocalIds) {
  if (!fs.existsSync(path.join(root, APPS[id].exe))) continue;
  for (const file of [...APPS[id].files, ...(APPS[id].dlls || [])]) {
    assert(fs.existsSync(path.join(root, urlOf(file))),
      `${id} local dropdown asset is missing: ${urlOf(file)}`);
  }
}

for (const id of ['civ2_win16', 'civ2_mge']) {
  const browserManifest = path.join(root, APPS[id].localFileManifest);
  if (!fs.existsSync(browserManifest)) continue;
  const local = JSON.parse(fs.readFileSync(browserManifest, 'utf8'));
  assert.strictEqual(local.schemaVersion, 1);
  assert(local.files.length > 50, `${id} prepared browser inventory includes game data`);
  assert(Object.keys(local.trackSizes).length > 1,
    `${id} prepared browser inventory includes CD track sizes`);
  for (const file of local.files) {
    assert(fs.existsSync(path.join(path.dirname(browserManifest), file.url)),
      `${id} browser inventory asset is missing: ${file.url}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(
  path.join(root, 'test/candidate-corpus/manifest.json'), 'utf8'));
const deusRecipe = manifest.candidates.find(candidate => candidate.id === 'deus-ex-demo');
assert(deusRecipe && deusRecipe.localOnly, 'Deus Ex fetch recipe remains local-only');
assert(deusRecipe.packages.every(pkg => pkg.type === 'file'),
  'Deus Ex keeps the original installer intact instead of host-extracting it');
assert(deusRecipe.postExtract.some(step => step.type === 'installDeusExDemo'),
  'fresh Deus Ex fixtures run the authentic installer in Wine Assembly');
assert.strictEqual(deusRecipe.postExtract.filter(step => step.type === 'replaceText').length, 2,
  'fresh Deus Ex fixtures prepare both runtime INIs for the software renderer');
const icewindRecipe = manifest.candidates.find(candidate => candidate.id === 'icewind-dale-demo');
assert(icewindRecipe && icewindRecipe.localOnly,
  'Icewind Dale fetch recipe remains local-only');
const icewindIniRewrite = icewindRecipe.postExtract.find(step =>
  step.type === 'replaceText' && /icewind\.ini$/i.test(step.file));
assert(icewindIniRewrite, 'Icewind Dale fetch recipe installs absolute drive aliases');
assert.deepStrictEqual(icewindIniRewrite.replacements.map(item => item.to),
  ['HD0:=C:\\', 'CD1:=D:\\', 'CD2:=D:\\'],
  'Icewind Dale aliases match the C: install and D: CD mounts');
assert(icewindRecipe.postExtract.some(step => step.type === 'prepareInfinityFullInstall'),
  'fresh Icewind Dale fixtures expand CD2 CBFs and produce the local full-install KEY');
const preparedKey = path.join(root,
  'test/binaries/candidates/icewind-dale-demo/installed-extracted/Recommended_compressed/CHITIN-full.KEY');
if (fs.existsSync(preparedKey)) {
  const key = fs.readFileSync(preparedKey);
  assert.strictEqual(key.readUInt32LE(12), 12682,
    'the prepared KEY excludes dangling retail resources whose BIFs are absent from the official demo');
}
assert.deepStrictEqual(icewind.persistFiles, [
  'c:\\characters\\*.chr', 'c:\\characters\\*.res',
  'c:\\save\\*', 'c:\\mpsave\\*',
], 'Icewind Dale persists only authored character and save-game state');
for (const candidateId of [
  'baldurs-gate-noninteractive-demo',
  'baldurs-gate-interactive-demo',
  'baldurs-gate-chapters-1-2-demo',
]) {
  const recipe = manifest.candidates.find(candidate => candidate.id === candidateId);
  assert(recipe && recipe.localOnly,
    `${candidateId} fetch recipe remains local-only`);
}
for (const candidateId of ['civilization-2-win16', 'civilization-2-mge-win32']) {
  const recipe = manifest.candidates.find(candidate => candidate.id === candidateId);
  assert(recipe && recipe.localOnly && recipe.browser,
    `${candidateId} remains local-only and emits a browser inventory`);
  assert(recipe.browser.cue === recipe.cli.cue,
    `${candidateId} browser and CLI use the same authentic CUE`);
}
console.log('PASS  proprietary previews are complete localhost-only dropdown apps');
