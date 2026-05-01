#!/usr/bin/env node
// Web manifest/deploy coverage for Pinball music assets.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
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

console.log('PASS  web Pinball manifest includes MIDI assets');
console.log('PASS  deploy filters include .mid/.inf/DAT and do not skip pinball assets');
console.log('PASS  deploy uses multipart for binary uploads');
console.log('PASS  debug mode exposes direct MIDI playback');
console.log('PASS  web host loads TinySynth MIDI backend');
console.log('PASS  default desktop whitelist includes Pinball');
