#!/usr/bin/env node
// Web manifest/deploy coverage for Pinball music assets.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const hostJs = fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8');
const deployJs = fs.readFileSync(path.join(ROOT, 'tools', 'deploy-berrry.js'), 'utf8');

for (const rel of [
  'binaries/pinball/PINBALL.MID',
  'binaries/pinball/PINBALL2.MID',
  'binaries/pinball/PINBALL.DAT',
  'binaries/pinball/wavemix.inf',
]) {
  assert(indexHtml.includes(`'${rel}'`), `index.html pinball manifest should include ${rel}`);
  const full = path.join(ROOT, rel);
  assert(fs.existsSync(full), `${rel} should exist for web fetch/deploy`);
  assert(fs.statSync(full).size > 0, `${rel} should not be empty`);
}

assert(/BINARY_EXTS\s*=\s*new Set\([^)]*'\.mid'/s.test(deployJs), 'deploy should include .mid binary assets');
assert(/BINARY_EXTS\s*=\s*new Set\([^)]*'\.inf'/s.test(deployJs), 'deploy should include .inf companion config assets');
assert(/LARGE_OK_PATHS\s*=\s*new Set\([^)]*'binaries\/pinball\/PINBALL\.DAT'/s.test(deployJs), 'deploy should include large pinball DAT');
assert(/LARGE_OK_PATHS\s*=\s*new Set\([^)]*'binaries\/pinball-plus95\/PINBALL\.DAT'/s.test(deployJs), 'deploy should include large Plus! 95 pinball DAT');
assert(/function apiMultipart/.test(deployJs), 'deploy should support multipart uploads');
assert(/new FormData\(\)/.test(deployJs), 'deploy should use FormData for multipart uploads');
assert(/form\.append\('file',\s*new Blob\(\[raw\]\),\s*f\.name\)/s.test(deployJs), 'deploy multipart upload should preserve repo-relative filenames');
assert(!/SKIP_BIN_DIRS\s*=\s*new Set\([^)]*'pinball'/s.test(deployJs), 'deploy should not skip binaries/pinball');
assert(indexHtml.includes('id="midi-select"'), 'debug toolbar should expose a MIDI selector');
assert(indexHtml.includes('playDebugMidi()'), 'debug toolbar should expose direct MIDI playback');
assert(indexHtml.includes('createHostImports(ctx)'), 'debug MIDI playback should exercise host MCI imports');
assert(indexHtml.includes('lib/vendor/webaudio-tinysynth.js'), 'web host should load the vendored TinySynth backend');
assert(/\[\s*'pinball'\s*,\s*'Pinball'/.test(indexHtml), 'default desktop whitelist should include Pinball');
assert(!indexHtml.includes('?v=55'), 'index.html should not keep stale cache-buster v55');
assert(indexHtml.includes('lib/host-imports.js?v=90'), 'web host should cache-bust host-imports after GDI changes');
assert(!hostJs.includes('?v=55'), 'host.js should not fetch stale WAT/API sources with v55');
assert(hostJs.includes("'?v=90'"), 'host.js should cache-bust WAT source fetches');
assert(hostJs.includes('flushRepaint(true)'), 'web host should refresh the display after WAT-only paints');
assert(indexHtml.includes('const rctFiles = ['), 'web RCT should preload shareware data files');
assert(indexHtml.includes("rct:        { exe: 'binaries/shareware/rct/English/RCT.exe', files: rctFiles, requiredFiles: true, fileConcurrency: 10 }"), 'web RCT app should attach required data files');
assert(indexHtml.includes("p.startsWith('English/')"), 'web RCT should mirror English files at C:\\ like the CLI harness');
for (const rel of [
  'Data/csg1.dat',
  'Data/css1.dat',
  'Scenarios/SC.IDX',
  'Tracks/Manic Miner.TD4',
  'Saved Games/001',
]) {
  assert(indexHtml.includes(JSON.stringify(rel)), `web RCT manifest should include ${rel}`);
  assert(fs.existsSync(path.join(ROOT, 'binaries', 'shareware', 'rct', rel)), `web RCT asset should exist: ${rel}`);
}
assert(indexHtml.includes("vfsPath: 'c:\\\\' + p"), 'web RCT files should preserve root-relative VFS paths');
assert(indexHtml.includes('Loading ${app.files.length} data file(s)...'), 'web launcher should log data-file preload progress');
assert(indexHtml.includes('onProgress: ({ loaded, failed, total }) =>'), 'web launcher should report data-file preload progress');
assert(indexHtml.includes('Data files ready: ${app.files.length}'), 'web launcher should log data-file preload completion');
assert(indexHtml.includes('Starting run slice=${runSlice}'), 'web launcher should log run-loop start');
assert(indexHtml.includes("if (appKey === 'rct') return 5000000;"), 'web RCT should use an accelerated startup run slice');
assert(hostJs.includes('ecx=0x${hex32(ecx)}'), 'web runner should report runtime register heartbeat progress');
assert(/const RCT_PATH_PREFIX\s*=\s*'binaries\/shareware\/rct\/'/.test(deployJs), 'deploy should include RCT shareware asset exception');
assert(/!rctAsset && parts\.some\(p => SKIP_BIN_DIRS\.has\(p\)\)/.test(deployJs), 'deploy should not skip RCT shareware assets');
assert(/!isRctPath\(f\.rel\)/.test(deployJs), 'deploy should allow large RCT data files');
for (const app of ['freecell', 'sol', 'cruel', 'golf', 'spider']) {
  const re = new RegExp(`${app}:\\s*\\{[^}]*dlls:\\s*\\['binaries/entertainment-pack/cards\\.dll'\\]`, 's');
  assert(re.test(indexHtml), `${app} web manifest should explicitly load cards.dll`);
}

console.log('PASS  web Pinball manifest includes MIDI assets');
console.log('PASS  deploy filters include .mid/.inf/DAT and do not skip pinball assets');
console.log('PASS  deploy uses multipart for binary uploads');
console.log('PASS  debug mode exposes direct MIDI playback');
console.log('PASS  web host loads TinySynth MIDI backend');
console.log('PASS  default desktop whitelist includes Pinball');
console.log('PASS  web host cache-buster is current');
console.log('PASS  web card games explicitly load cards.dll');
console.log('PASS  web RCT preloads shareware data files');
console.log('PASS  deploy includes RCT shareware assets');
