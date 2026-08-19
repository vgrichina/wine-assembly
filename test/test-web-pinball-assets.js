#!/usr/bin/env node
// Web manifest/deploy coverage for desktop companion media assets.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const hostJs = fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8');
const hostImportsJs = fs.readFileSync(path.join(ROOT, 'lib', 'host-imports.js'), 'utf8');
const rendererJs = fs.readFileSync(path.join(ROOT, 'lib', 'renderer.js'), 'utf8');
const rendererInputJs = fs.readFileSync(path.join(ROOT, 'lib', 'renderer-input.js'), 'utf8');
const recorderJs = fs.readFileSync(path.join(ROOT, 'lib', 'recorder.js'), 'utf8');
const deployJs = fs.readFileSync(path.join(ROOT, 'tools', 'deploy-berrry.js'), 'utf8');
const sourcesMd = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'SOURCES.md'), 'utf8');
const exportsWat = fs.readFileSync(path.join(ROOT, 'src', '13-exports.wat'), 'utf8');
const windowHandlersWat = fs.readFileSync(path.join(ROOT, 'src', '09a5-handlers-window.wat'), 'utf8');

function assertBundled(rel) {
  assert(indexHtml.includes(`'${rel}'`), `index.html app manifest should include ${rel}`);
  const full = path.join(ROOT, rel);
  assert(fs.existsSync(full), `${rel} should exist for web fetch/deploy`);
  assert(fs.statSync(full).size > 0, `${rel} should not be empty`);
}

function assertDeployFile(rel) {
  assert(deployJs.includes(`'${rel}'`), `deploy should include ${rel}`);
  const full = path.join(ROOT, rel);
  assert(fs.existsSync(full), `${rel} should exist for web fetch/deploy`);
  assert(fs.statSync(full).size > 0, `${rel} should not be empty`);
}

for (const dir of ['binaries/pinball', 'binaries/pinball-plus95']) {
  const fullDir = path.join(ROOT, dir);
  const files = fs.readdirSync(fullDir)
    .filter(name => /\.(dat|mid|inf|bmp|wav)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  assert(files.some(name => /^SOUND.*\.WAV$/i.test(name)), `${dir} should contain WAV sidecar files`);
  for (const name of files) assertBundled(`${dir}/${name}`);
}

assert(/BINARY_EXTS\s*=\s*new Set\([^)]*'\.mid'/s.test(deployJs), 'deploy should include .mid binary assets');
assert(/BINARY_EXTS\s*=\s*new Set\([^)]*'\.mp3'/s.test(deployJs), 'deploy should include .mp3 binary assets');
assert(/BINARY_EXTS\s*=\s*new Set\([^)]*'\.wav'/s.test(deployJs), 'deploy should include .wav sidecar audio assets');
assert(/BINARY_EXTS\s*=\s*new Set\([^)]*'\.inf'/s.test(deployJs), 'deploy should include .inf companion config assets');
assert(/BINARY_EXTS\s*=\s*new Set\([^)]*'\.txt'/s.test(deployJs), 'deploy should include .txt companion assets');
assert(/BINARY_EXTS\s*=\s*new Set\([^)]*'\.manifest'/s.test(deployJs), 'deploy should include .manifest companion assets');
assert(/TEXT_EXTS\s*=\s*new Set\([^)]*'\.ini'/s.test(deployJs), 'deploy should include Winamp INI text assets');
assert(/LARGE_OK_PATHS\s*=\s*new Set\([^)]*'binaries\/pinball\/PINBALL\.DAT'/s.test(deployJs), 'deploy should include large pinball DAT');
assert(/LARGE_OK_PATHS\s*=\s*new Set\([^)]*'binaries\/pinball-plus95\/PINBALL\.DAT'/s.test(deployJs), 'deploy should include large Plus! 95 pinball DAT');
assert(/LARGE_OK_PATHS\s*=\s*new Set\([^)]*'binaries\/wep32-community\/QBlackjack\/QuickBlackjack\.exe'/s.test(deployJs), 'deploy should allow large QuickBlackjack binary');
assert(/LARGE_OK_PATHS\s*=\s*new Set\([^)]*'binaries\/plus98\/DIALOG\.BMP'/s.test(deployJs), 'deploy should allow large Marbles dialog art');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/entertainment-pack\/tictac\.exe'/s.test(deployJs), 'deploy should include desktop TicTactics binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/entertainment-pack\/winmine\.exe'/s.test(deployJs), 'deploy should include desktop Minesweeper binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/plus98\/SPIDER\.EXE'/s.test(deployJs), 'deploy should include desktop Spider binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/plus98\/SPIDER\.CHM'/s.test(deployJs), 'deploy should include Spider help file');
assert(/'comctl32\.dll':\s*'binaries\/dlls\/comctl32\.dll'/.test(indexHtml), 'web DLL auto-loader should map comctl32.dll');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/dlls\/comctl32\.dll'/s.test(deployJs), 'deploy should include comctl32.dll for Pinball');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/winamp\.exe'/s.test(deployJs), 'deploy should include desktop Winamp binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/demo\.mp3'/s.test(deployJs), 'deploy should include Winamp demo MP3');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/whatsnew\.txt'/s.test(deployJs), 'deploy should include Winamp version history text');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/wep32-community\/Bricks\/bricks\.exe'/s.test(deployJs), 'deploy should include desktop Bricks binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/wep32-community\/EmPipe\/EMPIPE\.EXE'/s.test(deployJs), 'deploy should include desktop EmPipe binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/wep32-community\/EmPipe\/EMPIPE\.EXE\.manifest'/s.test(deployJs), 'deploy should include desktop EmPipe manifest');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/wep32-community\/EmPipe\/EMPIPEE\.TXT'/s.test(deployJs), 'deploy should include desktop EmPipe text companion');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/wep32-community\/Funpack\/Funtris\.exe'/s.test(deployJs), 'deploy should include desktop Funtris binary');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/wep32-community\/Funpack\/Pyramid\.exe'/s.test(deployJs), 'deploy should include desktop Pyramid binary');
for (const rel of [
  'binaries/wep32-community/Funpack/Peaks.exe',
  'binaries/wep32-community/Funpack/FourStones.exe',
  'binaries/wep32-community/Wordzap/CWordZap.exe',
  'binaries/wep32-community/QBlackjack/QuickBlackjack.exe',
  'binaries/plus98/MARBLES.EXE',
]) {
  assertDeployFile(rel);
}
assert(/LARGE_OK_PATHS\s*=\s*new Set\([^)]*'binaries\/winamp\.exe'/s.test(deployJs), 'deploy should allow large Winamp binary');
assert(/LARGE_OK_PATHS\s*=\s*new Set\([^)]*'binaries\/wep32-community\/Funpack\/FunPack\.dll'/s.test(deployJs), 'deploy should allow large FunPack DLL');
assert(/DESKTOP_BINARY_PREFIXES\s*=\s*\[[^\]]*'binaries\/pinball\/'/s.test(deployJs), 'deploy should include desktop Pinball asset directory');
assert(/DESKTOP_BINARY_PREFIXES\s*=\s*\[[^\]]*'binaries\/pinball-plus95\/'/s.test(deployJs), 'deploy should include desktop Plus! 95 Pinball asset directory');
assert(/DESKTOP_BINARY_FILES\s*=\s*new Set\([^)]*'binaries\/pinball-plus95\/pinball\.exe'/s.test(deployJs), 'deploy should include desktop Plus! 95 Pinball binary');
assert(/function apiMultipart/.test(deployJs), 'deploy should support multipart uploads');
assert(/new FormData\(\)/.test(deployJs), 'deploy should use FormData for multipart uploads');
assert(/form\.append\('file',\s*new Blob\(\[raw\]\),\s*f\.name\)/s.test(deployJs), 'deploy multipart upload should preserve repo-relative filenames');
assert(!/SKIP_BIN_DIRS\s*=\s*new Set\([^)]*'pinball'/s.test(deployJs), 'deploy should not skip binaries/pinball');
assert(!/RCT_PATH_PREFIX/.test(deployJs), 'default deploy should not include debug-only RCT shareware assets');
assert(!/Pinball sound fallback/.test(exportsWat), 'run loop should not contain Pinball-specific sound fallback');
assert(!/0x01009895/.test(exportsWat), 'run loop should not trap Pinball sound-request EIP');
assert(!/Pinball flag poke/.test(windowHandlersWat), 'window handlers should not contain Pinball-specific gameplay flag pokes');
assert(!/0x1024fe0|0x1024ff8|0x01007264/.test(windowHandlersWat), 'window handlers should not poke Pinball-specific guest addresses');
assert(/menu_prepare_overlay/.test(rendererJs) && /menu_paint_dropdown/.test(rendererJs) &&
  /_dropdownOverlay/.test(rendererJs) && !/_menuPaintDropdownJs/.test(rendererJs),
  'renderer should composite the WAT-painted canonical popup-menu overlay');
assert(!/menu_hittest_bar|\.menu_open\(/.test(rendererInputJs), 'renderer input should not fall back to JS-driven menu hit-test/open logic');
assert(indexHtml.includes('id="midi-select"'), 'debug toolbar should expose a MIDI selector');
assert(indexHtml.includes('<option value="dxball">DX-Ball 1.09</option>'),
  'debug app selector should expose the local DX-Ball candidate');
assert(/dxball:\s*\{[^}]*exe:\s*dxballCandidateRoot \+ 'dxball\.exe'[^}]*files:\s*dxballCandidateFiles[^}]*requiredFiles:\s*true/s.test(indexHtml),
  'DX-Ball debug launch should require its prepared installed payload');
assert(!/\[\s*'dxball'\s*,\s*'DX-Ball'/.test(indexHtml),
  'normal desktop whitelist should not promote the local DX-Ball payload');
assert(!deployJs.includes('test/binaries/candidates/dxball'),
  'public deploy should exclude the local DX-Ball payload');
assert(indexHtml.includes('<option value="blobby_volley">Blobby Volley</option>'),
  'debug app selector should expose the local Blobby Volley candidate');
assert(/const blobbyCandidateFiles = \[\s*'graph\.pak', 'sound\.pak', 'text\.pak',\s*\]/s.test(indexHtml),
  'Blobby Volley debug launch should preload its three runtime PAK files');
assert(/blobby_volley:\s*\{[^}]*exe:\s*blobbyCandidateRoot \+ 'volley\.exe'[^}]*files:\s*blobbyCandidateFiles[^}]*requiredFiles:\s*true/s.test(indexHtml),
  'Blobby Volley debug launch should require its local runtime payload');
assert(!/\[\s*'blobby_volley'\s*,\s*'Blobby Volley'/.test(indexHtml),
  'normal desktop whitelist should not promote the local Blobby Volley payload');
assert(!deployJs.includes('test/binaries/candidates/blobby-volley'),
  'public deploy should exclude the local Blobby Volley payload');
assert(indexHtml.includes('playDebugMidi()'), 'debug toolbar should expose direct MIDI playback');
assert(indexHtml.includes('createHostImports(ctx)'), 'debug MIDI playback should exercise host MCI imports');
assert(indexHtml.includes('lib/vendor/webaudio-tinysynth.js'), 'web host should load the vendored TinySynth backend');
assert(indexHtml.includes('id="start-record-item"'), 'Start menu should expose screen recording');
assert(indexHtml.includes('id="record-btn" onclick="toggleRecording()"'), 'debug toolbar recorder should use default screen capture');
assert(indexHtml.includes("if (typeof toggleRecording === 'function') toggleRecording();"), 'Start menu recorder should use default screen capture');
assert(recorderJs.includes("let recordTarget = 'screen'"), 'recorder should default to the whole emulator screen');
assert(recorderJs.includes("recordTarget = options && options.target === 'window' ? 'window' : 'screen'"), 'recorder should only crop to an active window when explicitly requested');
assert(recorderJs.includes("document.getElementById('start-record-label')"), 'recorder should keep Start menu recording state in sync');
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
for (const [id, label, exe] of [
  ['peaks',      'Peaks',      'binaries/wep32-community/Funpack/Peaks.exe'],
  ['fourstones', 'FourStones', 'binaries/wep32-community/Funpack/FourStones.exe'],
  ['cwordzap',   'CWordZap',   'binaries/wep32-community/Wordzap/CWordZap.exe'],
  ['qblackjack', 'Blackjack',  'binaries/wep32-community/QBlackjack/QuickBlackjack.exe'],
  ['marbles',    'Marbles',    'binaries/plus98/MARBLES.EXE'],
]) {
  assert(new RegExp(`\\[\\s*'${id}'\\s*,\\s*'${label}'`).test(indexHtml), `default desktop whitelist should include ${label}`);
  assertBundled(exe);
  assertDeployFile(exe);
}
assert(/\[\s*'pyramid'\s*,\s*'Pyramid'/.test(indexHtml), 'default desktop whitelist should include Pyramid');
assert(/funtris:\s*\{[\s\S]*Funtris\\\\Options'[\s\S]*GetStarted'[\s\S]*data:\s*0[\s\S]*dismissStartupDialog:\s*\{\s*title:\s*'Funtris',\s*command:\s*1\s*\}/s.test(indexHtml), 'Funtris browser launch should suppress startup nag dialogs');
assert(/peaks:\s*\{[\s\S]*Peaks\\\\Options'[\s\S]*GetStarted'[\s\S]*data:\s*0/s.test(indexHtml), 'Peaks browser launch should suppress startup nag dialogs');
assert(/pyramid:\s*\{[\s\S]*iCDateCount'[\s\S]*value:\s*-1[\s\S]*GetStarted'[\s\S]*data:\s*0/s.test(indexHtml), 'Pyramid browser launch should suppress startup nag dialogs');
for (const rel of [
  'binaries/plus98/LLOGO.BMP',
  'binaries/plus98/LSPLASH.BMP',
  'binaries/plus98/CHOOSE1.BMP',
  'binaries/plus98/CHOOSE2.BMP',
  'binaries/plus98/COMMON01.BMP',
  'binaries/plus98/COMMON02.BMP',
  'binaries/plus98/COMMON03.BMP',
  'binaries/plus98/COMMON04.BMP',
  'binaries/plus98/COMMON05.BMP',
  'binaries/plus98/CMNBONUS.BMP',
  'binaries/plus98/LEVEL-01.BMP',
  'binaries/plus98/LEVEL-01.DAT',
  'binaries/plus98/LEVEL1BG.BMP',
  'binaries/plus98/TRANS1A.BMP',
  'binaries/plus98/TRANS2A.BMP',
  'binaries/plus98/DIALOG.BMP',
  'binaries/plus98/OPTIONS.BMP',
  'binaries/plus98/TEXTFONT.BMP',
  'binaries/plus98/CRACK.BMP',
  'binaries/plus98/GRASTILE.BMP',
  'binaries/plus98/B1.MID',
  'binaries/plus98/CRD.MID',
  'binaries/plus98/LVL1.MID',
  'binaries/plus98/2.WAV',
  'binaries/plus98/MARBLES.ICO',
]) {
  assertBundled(rel);
  assertDeployFile(rel);
}
assert(indexHtml.includes('StorageImports.setIniValue(entry.fileName, entry.section, entry.key, entry.value)'), 'web launcher should apply app-scoped startup INI values');
assert(/\[\s*'winamp'\s*,\s*'Winamp'/.test(indexHtml), 'default desktop whitelist should include Winamp');
assert(indexHtml.includes("'binaries/demo.mp3'"), 'Winamp web manifest should preload demo.mp3');
assert(indexHtml.includes("'binaries/whatsnew.txt'"), 'Winamp web manifest should preload version history text');
assert(indexHtml.includes("winampDemo: 'C:\\\\demo.mp3'"), 'Winamp web manifest should make demo.mp3 available');
for (const dll of [
  'in_mp3.dll',
  'out_wave.dll',
]) {
  assert(indexHtml.includes(`vfsPath: 'c:\\\\plugins\\\\${dll}'`), `Winamp web manifest should mount ${dll} under C:\\Plugins`);
  assert(deployJs.includes(`'binaries/plugins/${dll}'`), `deploy should include ${dll}`);
  const full = path.join(ROOT, 'binaries', 'plugins', dll);
  assert(fs.existsSync(full), `${dll} should exist for web fetch/deploy`);
  assert(fs.statSync(full).size > 0, `${dll} should not be empty`);
}
assert(indexHtml.includes(`vfsPath: 'c:\\\\plugins\\\\vis_w.dll'`), 'Winamp web manifest should mount wVis as a visualizer plugin');
assert(indexHtml.includes(`'binaries/plugins/candidates/vis_w.dll'`), 'Winamp web manifest should load wVis from candidates');
assert(/winamp:\s*\{[\s\S]*dlls:\s*\[[^\]]*'binaries\/plugins\/candidates\/vis_w\.dll'/s.test(indexHtml), 'Winamp web manifest should preload wVis before preferences enumerates plugins');
assert(deployJs.includes(`'binaries/plugins/candidates/vis_w.dll'`), 'deploy should include wVis candidate');
assert(fs.existsSync(path.join(ROOT, 'binaries', 'plugins', 'candidates', 'vis_w.dll')), 'wVis candidate should exist for web fetch/deploy');
assert(sourcesMd.includes('vis_w.dll'), 'SOURCES.md should document how to recover vis_w.dll');
for (const dll of [
  'cddbcontrolwinamp.dll',
  'cddbuiwinamp.dll',
  'enc_vorbis.dll',
  'gen_ml.dll',
  'in_cdda.dll',
  'in_midi.dll',
  'in_mod.dll',
  'in_vorbis.dll',
  'in_wm.dll',
  'out_wm.dll',
  'read_file.dll',
]) {
  assert(!indexHtml.includes(`vfsPath: 'c:\\\\plugins\\\\${dll}'`), `Winamp web manifest should not mount ${dll} until arbitrary plugin LoadLibrary is supported`);
  assert(!deployJs.includes(`'binaries/plugins/${dll}'`), `deploy should not include unmounted ${dll}`);
  assert(sourcesMd.includes(dll), `SOURCES.md should document how to recover ${dll}`);
}
assert(/winamp:\s*\{[\s\S]*'binaries\/winamp\.ini'/s.test(indexHtml), 'Winamp web manifest should preload winamp.ini to keep the minibrowser closed');
assert(/winamp:\s*\{[\s\S]*resetIniOnLaunch:\s*\['winamp\.ini'\]/s.test(indexHtml), 'Winamp web launch should reset stale persisted INI layout state');
assert(/\[WinampReg\][\s\S]*?NeedReg=0/.test(fs.readFileSync(path.join(ROOT, 'binaries', 'winamp.ini'), 'utf8')), 'Winamp web INI should suppress first-run setup so playback controls are reachable');
assert(fs.existsSync(path.join(ROOT, 'binaries', 'whatsnew.txt')), 'Winamp version history text should exist for web fetch/deploy');
assert(fs.statSync(path.join(ROOT, 'binaries', 'whatsnew.txt')).size > 0, 'Winamp version history text should not be empty');
assert(!indexHtml.includes('wine.waitForMainHwnd(() =>'), 'Winamp web launch should not auto-drive playback through IPC');
assert(!indexHtml.includes('?v=55'), 'index.html should not keep stale cache-buster v55');
assert(indexHtml.includes('lib/renderer-input.js?v=188'), 'web host should cache-bust renderer input after Paint palette routing');
assert(indexHtml.includes('lib/renderer.js?v=177'), 'web host should cache-bust renderer after fullscreen consent changes');
assert(!hostJs.includes('?v=55'), 'host.js should not fetch stale WAT/API sources with v55');
assert(indexHtml.includes('lib/storage.js?v=169'), 'web host should cache-bust storage after Media Player association changes');
assert(indexHtml.includes('lib/gdi-surface.js?v=1'), 'web host should load the canonical GDI surface module');
assert(indexHtml.indexOf('lib/gdi-surface.js?v=1') < indexHtml.indexOf('lib/host-imports.js?v=200'),
  'web host should load the GDI surface module before host imports');
assert(indexHtml.includes('lib/host-imports.js?v=200'), 'web host should cache-bust binary text rasterization');
assert(indexHtml.includes('lib/thread-manager.js?v=175'), 'web host should cache-bust thread manager after reporting per-thread bad Leaves');
assert(indexHtml.includes('lib/compile-wat.js?v=169'), 'web host should cache-bust the snapshot-capable WAT compiler');
assert(indexHtml.includes('host.js?v=208'), 'web host should cache-bust host.js after the current source update');
assert(hostJs.includes("static SOURCE_VERSION = '207'"), 'web host should cache-bust WASM artifacts and WAT source compilation');
assert(indexHtml.includes("['mspaint98',   'Paint'"), 'normal desktop should expose Paint without the downscaled debug pane');
assert(indexHtml.includes("mplay32:  { exe: 'binaries/win98-apps/mplay32.exe' }"),
  'Media Player 32 should use normal DLL auto-detection now that native and WAT toolbars are supported');
assert(hostJs.includes("'build/wine-assembly.wasm'"), 'web startup should load the precompiled tail-call WASM artifact');
assert(hostJs.includes("'build/wine-assembly.compat.wasm'"), 'web startup should load the precompiled compatibility WASM artifact');
assert(hostJs.includes("has('compile-wat')"), 'web startup should retain an explicit source-compilation mode');
assert(hostJs.includes('compileWatSnapshot('), 'host.js should retain WAT source compilation as a development/failure fallback');
assert(hostJs.includes('Promise.all([fontsReady, wasmReady, apiTableReady])'), 'web startup should overlap independent font, WASM, and API-table loading');
assert(hostJs.includes('Promise.all(dllPaths.map(async item =>'), 'web startup should fetch independent DLL payloads in parallel');
assert(deployJs.includes("const BINARY_DIRS = ['binaries', 'icons', 'build']"), 'deploy should include precompiled browser WASM artifacts');
assert(deployJs.includes("'build/wine-assembly.wasm'"), 'deploy should allow the tail-call browser WASM artifact above the general binary-size cap');
assert(deployJs.includes("'build/wine-assembly.compat.wasm'"), 'deploy should allow the compatibility browser WASM artifact above the general binary-size cap');
assert(deployJs.includes("'.wasm'"), 'deploy should encode WASM artifacts as binary');
assert(hostJs.includes('WineAssembly._wasmModulePromise = null'), 'host.js should allow a failed WAT compilation to retry');
assert(indexHtml.includes('wine._availableDllFiles = new Set(Object.keys(availableDlls))'), 'web launch should tell host imports which DLLs can be dynamically fetched');
assert(/availableDllFiles\(\)\s*\{\s*return opts\.availableDllFiles \|\| self\._availableDllFiles \|\| null;/.test(hostJs), 'host.js should pass browser-fetchable DLL names into host imports');
assert(hostImportsJs.includes('ctx.availableDllFiles'), 'host imports should let LoadLibraryA yield for browser-fetchable DLLs not already in VFS');
assert(hostJs.includes("this._audioCtx.state === 'closed'"), 'web host should not reuse a closed browser AudioContext');
assert(hostJs.includes('h.get_ticks = () => self._guestTickMs(sharedAudio)'), 'web host should route timeGetTime/GetTickCount through browser guest ticks');
assert(hostJs.includes('self._beginGuestTickBatch()'), 'web host should reset deterministic guest tick calls each run slice');
assert(hostJs.includes('flushRepaint(true)'), 'web host should refresh the display after WAT-only paints');
assert(hostJs.includes('runBudgeted({'), 'web host should use wall-budgeted worker scheduling for visible-window workers');
assert(hostJs.includes('maxTotalSteps: audioHot ? threadBudget : threadBudget * 4'), 'web host should let non-audio UI workers consume their wall-clock budget');
assert(hostJs.includes('audioHot ? (menuOpen ? 20000 : 10000) : 50000'), 'web host should use larger non-audio worker quanta for visible compute workers');
assert(hostJs.includes('menuOpen ? (mainThreadWaiting ? 8 : 6) : 4'), 'web host should use a smaller wall budget while waveOut audio is active');
assert(hostJs.includes('prioritizeAudioThreads: audioHot && !menuOpen'), 'web host should leave WAT menu tracking responsive while waveOut audio is active');
assert(hostJs.includes('recentInputWake ? 0'), 'web host should give synchronous dialog input a short worker-free grace period');
assert(hostJs.includes('WineAssembly.hasRemainingAppWindow('),
  'web multi-app cleanup should distinguish Pinball startup from dialog-only accessory shutdown');
assert(hostImportsJs.includes('onTopLevelWindowDestroyed(hwnd, destroyed)'), 'host imports should pass destroyed window metadata to browser cleanup');
assert(indexHtml.includes('Loading ${app.files.length} data file(s)...'), 'web launcher should log data-file preload progress');
assert(indexHtml.includes('onProgress: ({ loaded, failed, total }) =>'), 'web launcher should report data-file preload progress');
assert(indexHtml.includes('Data files ready: ${app.files.length}'), 'web launcher should log data-file preload completion');
assert(indexHtml.includes('Starting run slice=${runSlice}'), 'web launcher should log run-loop start');
assert(!/function selectedRunSlice\(appKey\)\s*\{\s*return 100000;\s*\}/.test(indexHtml), 'slice dropdown should not be ignored');
assert(indexHtml.includes("document.getElementById('slice-size-select')"), 'slice picker should drive the run-loop slice size');
assert(indexHtml.includes('function hasWasmTailCalls()'), 'auto slice should detect no-tail-call browser dispatch');
assert(indexHtml.includes('return compatDispatch ? 100 : 25000;'), 'auto slice should cap Spider/card games for no-tail-call browsers');
assert(indexHtml.includes('return compatDispatch ? 500 : 100000;'), 'auto slice should cap default apps for no-tail-call browsers');
assert(indexHtml.includes('return compatDispatch ? Math.min(selected, autoSlice) : selected;'), 'manual slice should be clamped in no-tail-call browsers');
assert(!/case 'winamp':\s*return 1;/.test(indexHtml), 'Winamp auto slice should not rely on slice=1 startup masking');
assert(indexHtml.includes('function unlockRunningAudio()'), 'web canvas input should explicitly unlock running app audio');
assert(indexHtml.includes('unlockRunningAudio();\n        const { x: cx, y: cy } = eventPoint(e);'), 'mouse input should resume audio before guest dispatch');
assert(indexHtml.includes('unlockRunningAudio();\n        const { x: cx, y: cy } = eventPointFromClient'), 'touch input should resume audio before guest dispatch');
assert(indexHtml.includes('unlockRunningAudio();\n        renderer.handleKeyDown(vk);'), 'keyboard input should resume audio before guest dispatch');
assert(hostJs.includes('ecx=0x${hex32(ecx)}'), 'web runner should report runtime register heartbeat progress');
for (const app of ['freecell', 'sol', 'cruel', 'golf']) {
  const re = new RegExp(`${app}:\\s*\\{[^}]*dlls:\\s*\\['binaries/entertainment-pack/cards\\.dll'\\]`, 's');
  assert(re.test(indexHtml), `${app} web manifest should explicitly load cards.dll`);
}

console.log('PASS  web Pinball manifests include sidecar media assets');
console.log('PASS  deploy filters include .mid/.wav/.inf/DAT and Pinball asset directories');
console.log('PASS  Pinball sound uses bundled assets instead of a run-loop EIP hack');
console.log('PASS  deploy uses multipart for binary uploads');
console.log('PASS  debug mode exposes direct MIDI playback');
console.log('PASS  debug-only selector exposes local DX-Ball without deploying it');
console.log('PASS  Start menu exposes screen recording');
console.log('PASS  web host loads TinySynth MIDI backend');
console.log('PASS  default desktop whitelist includes Pinball');
console.log('PASS  default desktop whitelist includes Spider');
console.log('PASS  default desktop whitelist includes added games and Winamp');
console.log('PASS  web host cache-buster is current');
console.log('PASS  web card games explicitly load cards.dll');
console.log('PASS  deploy limits default binaries to desktop apps');
