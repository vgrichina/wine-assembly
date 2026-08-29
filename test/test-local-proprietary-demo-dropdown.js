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

for (const id of ['deus_ex_demo', 'icewind_dale_demo']) {
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
  'test/binaries/candidates/deus-ex-demo/System/DeusEx.exe');
assert.strictEqual(deus.args, '-windowed');
assert.strictEqual(deus.dlls.length, 13);
for (const suffix of [
  '/System/DeusEx.ini', '/Maps/Entry.dx', '/Maps/00_Training.dx',
  '/Help/Logo.bmp', '/Textures/DXFonts.utx', '/System/DeusExUI.u',
]) {
  assert(deus.files.some(file => urlOf(file).endsWith(suffix)),
    `Deus Ex manifest includes ${suffix}`);
}
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

// If the ignored fixtures are present, every dropdown fetch must resolve now.
for (const id of ['deus_ex_demo', 'icewind_dale_demo']) {
  if (!fs.existsSync(path.join(root, APPS[id].exe))) continue;
  for (const file of [...APPS[id].files, ...(APPS[id].dlls || [])]) {
    assert(fs.existsSync(path.join(root, urlOf(file))),
      `${id} local dropdown asset is missing: ${urlOf(file)}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(
  path.join(root, 'test/candidate-corpus/manifest.json'), 'utf8'));
const deusRecipe = manifest.candidates.find(candidate => candidate.id === 'deus-ex-demo');
assert(deusRecipe && deusRecipe.localOnly, 'Deus Ex fetch recipe remains local-only');
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
assert(html.includes('lib/mem-utils.js?v=169'),
  'the browser cache-busts hidden-SharedArrayBuffer string decoding');

console.log('PASS  Deus Ex and Icewind Dale are complete localhost-only dropdown apps');
