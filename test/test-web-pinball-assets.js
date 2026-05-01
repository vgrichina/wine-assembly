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
assert(!/SKIP_BIN_DIRS\s*=\s*new Set\([^)]*'pinball'/s.test(deployJs), 'deploy should not skip binaries/pinball');

console.log('PASS  web Pinball manifest includes MIDI assets');
console.log('PASS  deploy filters include .mid and do not skip pinball assets');
