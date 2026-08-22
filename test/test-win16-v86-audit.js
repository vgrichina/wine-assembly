#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { APPS } = require('../lib/apps');
const profile = require('../tools/v86-reference/win16-apps.json');

const registered = Object.keys(APPS).filter(id => id.startsWith('wep16_') ||
  ['winmine16', 'freecell16', 'sol16', 'mshearts16'].includes(id)).sort();
const profiled = profile.apps.map(app => app.id).sort();

assert.strictEqual(profile.schemaVersion, 1);
assert.strictEqual(new Set(profiled).size, profiled.length, 'Win16 v86 profiles must have unique ids');
assert.deepStrictEqual(profiled, registered,
  'the v86 comparison matrix must cover every registered Win16 app exactly once');
assert.strictEqual(profiled.length, 33, 'the registered Win16 launcher corpus should contain 33 apps');

for (const app of profile.apps) {
  assert(APPS[app.id], `${app.id} must exist in lib/apps.js`);
  assert(fs.existsSync(path.join(ROOT, app.payloadDir, app.exe)),
    `${app.id} native payload executable must exist`);
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
for (const app of profile.apps) {
  assert(new RegExp(`<option\\s+value=["']${app.id}["']`).test(html),
    `${app.id} must be selectable in the debug launcher`);
}
assert.match(html, /<option value="wep16_tp">Taipei<\/option>/,
  'the TP executable is Taipei, not TriPeaks');

const capture = fs.readFileSync(path.join(ROOT, 'tools', 'v86-reference', 'capture.js'), 'utf8');
const harness = fs.readFileSync(path.join(ROOT, 'tools', 'v86-reference', 'harness.js'), 'utf8');
assert.match(capture, /--apps ID,ID/);
assert.match(capture, /restorePristine/);
assert.match(harness, /savePristine/);
assert.match(harness, /restorePristine/);

console.log('PASS Win16 v86 audit covers all 33 registered/selectable apps');
