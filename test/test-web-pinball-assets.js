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
assert(/BINARY_EXTS\s*=\s*new Set\([^)]*'\.mp3'/s.test(deployJs), 'deploy should include .mp3 binary assets');
assert(/BINARY_EXTS\s*=\s*new Set\([^)]*'\.inf'/s.test(deployJs), 'deploy should include .inf companion config assets');
assert(/TEXT_EXTS\s*=\s*new Set\([^)]*'\.ini'/s.test(deployJs), 'deploy should include Winamp INI text assets');
assert(/LARGE_OK_PATHS\s*=\s*new Set\([^)]*'binaries\/pinball\/PINBALL\.DAT'/s.test(deployJs), 'deploy should include large pinball DAT');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/entertainment-pack\/tictac\.exe'/s.test(deployJs), 'deploy should include desktop TicTactics binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/entertainment-pack\/winmine\.exe'/s.test(deployJs), 'deploy should include desktop Minesweeper binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/plus98\/SPIDER\.EXE'/s.test(deployJs), 'deploy should include desktop Spider binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/plus98\/SPIDER\.CHM'/s.test(deployJs), 'deploy should include Spider help file');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/winamp\.exe'/s.test(deployJs), 'deploy should include desktop Winamp binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/demo\.mp3'/s.test(deployJs), 'deploy should include Winamp demo MP3');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/wep32-community\/Bricks\/bricks\.exe'/s.test(deployJs), 'deploy should include desktop Bricks binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/wep32-community\/EmPipe\/EMPIPE\.EXE'/s.test(deployJs), 'deploy should include desktop EmPipe binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/wep32-community\/EmPipe\/EMPIPE\.EXE\.manifest'/s.test(deployJs), 'deploy should include desktop EmPipe manifest');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/wep32-community\/EmPipe\/EMPIPEE\.TXT'/s.test(deployJs), 'deploy should include desktop EmPipe text companion');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/wep32-community\/Funpack\/Funtris\.exe'/s.test(deployJs), 'deploy should include desktop Funtris binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/wep32-community\/Funpack\/Pyramid\.exe'/s.test(deployJs), 'deploy should include desktop Pyramid binary');
assert(/LARGE_OK_PATHS\s*=\s*new Set\([^)]*'binaries\/winamp\.exe'/s.test(deployJs), 'deploy should allow large Winamp binary');
assert(/LARGE_OK_PATHS\s*=\s*new Set\([^)]*'binaries\/wep32-community\/Funpack\/FunPack\.dll'/s.test(deployJs), 'deploy should allow large FunPack DLL');
assert(/DESKTOP_BINARY_PREFIXES\s*=\s*\[[^\]]*'binaries\/pinball\/'/s.test(deployJs), 'deploy should include desktop Pinball asset directory');
assert(/function apiMultipart/.test(deployJs), 'deploy should support multipart uploads');
assert(/new FormData\(\)/.test(deployJs), 'deploy should use FormData for multipart uploads');
assert(/form\.append\('file',\s*new Blob\(\[raw\]\),\s*f\.name\)/s.test(deployJs), 'deploy multipart upload should preserve repo-relative filenames');
assert(!/SKIP_BIN_DIRS\s*=\s*new Set\([^)]*'pinball'/s.test(deployJs), 'deploy should not skip binaries/pinball');
assert(!/RCT_PATH_PREFIX/.test(deployJs), 'default deploy should not include debug-only RCT shareware assets');
assert(indexHtml.includes('id="midi-select"'), 'debug toolbar should expose a MIDI selector');
assert(indexHtml.includes('playDebugMidi()'), 'debug toolbar should expose direct MIDI playback');
assert(indexHtml.includes('createHostImports(ctx)'), 'debug MIDI playback should exercise host MCI imports');
assert(indexHtml.includes('lib/vendor/webaudio-tinysynth.js'), 'web host should load the vendored TinySynth backend');
assert(/\[\s*'pinball'\s*,\s*'Pinball'/.test(indexHtml), 'default desktop whitelist should include Pinball');
assert(/\[\s*'spider'\s*,\s*'Spider'/.test(indexHtml), 'default desktop whitelist should include Spider');
assert(/\[\s*'bricks'\s*,\s*'Bricks'/.test(indexHtml), 'default desktop whitelist should include Bricks');
assert(/bricks:\s*\{[^}]*files:\s*\['binaries\/wep32-community\/Bricks\/brk1\.dll'\]/s.test(indexHtml), 'Bricks should expose brk1.dll as a runtime VFS file');
assert(!/bricks:\s*\{[^}]*dlls:\s*\['binaries\/wep32-community\/Bricks\/brk1\.dll'\]/s.test(indexHtml), 'Bricks should not preload brk1.dll as an import DLL');
assert(/\[\s*'empipe'\s*,\s*'EmPipe'/.test(indexHtml), 'default desktop whitelist should include EmPipe');
assert(/empipe:\s*\{[^}]*requiredFiles:\s*true/s.test(indexHtml), 'EmPipe web launch should fail fast if companion assets are missing');
for (const rel of [
  'binaries/wep32-community/EmPipe/EMPIPEE.HLP',
  'binaries/wep32-community/EmPipe/EMPIPEE.TXT',
  'binaries/wep32-community/EmPipe/EMPIPE.EXE.manifest',
  'binaries/wep32-community/EmPipe/EMPCLEAR.MID',
  'binaries/wep32-community/EmPipe/EMPGMOV.MID',
  'binaries/wep32-community/EmPipe/EMPSCR1.MID',
  'binaries/wep32-community/EmPipe/EMPSCR2.MID',
  'binaries/wep32-community/EmPipe/EMPSCR3.MID',
  'binaries/wep32-community/EmPipe/EMPSCR4.MID',
  'binaries/wep32-community/EmPipe/EMPSCR5.MID',
  'binaries/wep32-community/EmPipe/EMPSTART.MID',
]) {
  assert(indexHtml.includes(`'${rel}'`), `index.html EmPipe manifest should include ${rel}`);
  assert(deployJs.includes(`'${rel}'`), `deploy should include ${rel}`);
  const full = path.join(ROOT, rel);
  assert(fs.existsSync(full), `${rel} should exist for web fetch/deploy`);
  assert(fs.statSync(full).size > 0, `${rel} should not be empty`);
}
assert(/\[\s*'funtris'\s*,\s*'Funtris'/.test(indexHtml), 'default desktop whitelist should include Funtris');
assert(/\[\s*'pyramid'\s*,\s*'Pyramid'/.test(indexHtml), 'default desktop whitelist should include Pyramid');
assert(/\[\s*'winamp'\s*,\s*'Winamp'/.test(indexHtml), 'default desktop whitelist should include Winamp');
assert(indexHtml.includes("'binaries/demo.mp3'"), 'Winamp web manifest should preload demo.mp3');
assert(indexHtml.includes("winampDemo: 'C:\\\\demo.mp3'"), 'Winamp web manifest should make demo.mp3 available');
assert(indexHtml.includes("vfsPath: 'c:\\\\plugins\\\\in_mp3.dll'"), 'Winamp web manifest should mount in_mp3.dll under C:\\Plugins');
assert(indexHtml.includes("vfsPath: 'c:\\\\plugins\\\\out_wave.dll'"), 'Winamp web manifest should mount out_wave.dll under C:\\Plugins');
assert(/winamp:\s*\{[\s\S]*'binaries\/winamp\.ini'/s.test(indexHtml), 'Winamp web manifest should preload winamp.ini to keep the minibrowser closed');
assert(/\[WinampReg\][\s\S]*?NeedReg=0/.test(fs.readFileSync(path.join(ROOT, 'binaries', 'winamp.ini'), 'utf8')), 'Winamp web INI should suppress first-run setup so playback controls are reachable');
assert(!indexHtml.includes('wine.waitForMainHwnd(() =>'), 'Winamp web launch should not auto-drive playback through IPC');
assert(!indexHtml.includes('?v=55'), 'index.html should not keep stale cache-buster v55');
assert(indexHtml.includes('lib/host-imports.js?v=114'), 'web host should cache-bust host-imports after desktop changes');
assert(!hostJs.includes('?v=55'), 'host.js should not fetch stale WAT/API sources with v55');
assert(hostJs.includes("SOURCE_VERSION = '114'"), 'host.js should define the current WAT/API cache-buster');
assert(hostJs.includes('sourceVersion: WineAssembly.SOURCE_VERSION'), 'host.js should include WAT source version in compile cache key');
assert(hostJs.includes('flushRepaint(true)'), 'web host should refresh the display after WAT-only paints');
assert(indexHtml.includes('Loading ${app.files.length} data file(s)...'), 'web launcher should log data-file preload progress');
assert(indexHtml.includes('onProgress: ({ loaded, failed, total }) =>'), 'web launcher should report data-file preload progress');
assert(indexHtml.includes('Data files ready: ${app.files.length}'), 'web launcher should log data-file preload completion');
assert(indexHtml.includes('Starting run slice=${runSlice}'), 'web launcher should log run-loop start');
assert(!/function selectedRunSlice\(appKey\)\s*\{\s*return 100000;\s*\}/.test(indexHtml), 'slice dropdown should not be ignored');
assert(indexHtml.includes("document.getElementById('slice-size-select')"), 'slice picker should drive the run-loop slice size');
assert(/case 'spider':[\s\S]*?return 25000;/.test(indexHtml), 'auto slice should use smaller slices for Spider/card games');
assert(!/case 'winamp':\s*return 1;/.test(indexHtml), 'Winamp auto slice should not rely on slice=1 startup masking');
assert(hostJs.includes('ecx=0x${hex32(ecx)}'), 'web runner should report runtime register heartbeat progress');
for (const app of ['freecell', 'sol', 'cruel', 'golf']) {
  const re = new RegExp(`${app}:\\s*\\{[^}]*dlls:\\s*\\['binaries/entertainment-pack/cards\\.dll'\\]`, 's');
  assert(re.test(indexHtml), `${app} web manifest should explicitly load cards.dll`);
}

console.log('PASS  web Pinball manifest includes MIDI assets');
console.log('PASS  deploy filters include .mid/.inf/DAT and do not skip pinball assets');
console.log('PASS  deploy uses multipart for binary uploads');
console.log('PASS  debug mode exposes direct MIDI playback');
console.log('PASS  web host loads TinySynth MIDI backend');
console.log('PASS  default desktop whitelist includes Pinball');
console.log('PASS  default desktop whitelist includes Spider');
console.log('PASS  default desktop whitelist includes added games and Winamp');
console.log('PASS  web host cache-buster is current');
console.log('PASS  web card games explicitly load cards.dll');
console.log('PASS  deploy limits default binaries to desktop apps');
