#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const manifest = require('./dos-game-corpus/manifest.json');
assert.strictEqual(manifest.schemaVersion, 1);
assert(Array.isArray(manifest.games) && manifest.games.length > 0);
assert.strictEqual(new Set(manifest.games.map(game => game.id)).size, manifest.games.length);

const gta = manifest.games.find(game => game.id === 'gta1-demo');
assert(gta && gta.localOnly, 'GTA1 is explicitly an ignored local-only demo');
assert.strictEqual(gta.platform, 'DOS/4GW');
assert.strictEqual(gta.executable, 'GTA24/GTADOS/DEMO24.EXE');
assert.strictEqual(gta.package.sha256,
  '76f1e1da5c898f755597b86357c4d77b7447cb483673a23d10d34f40cfe03ec9');

const fixture = path.resolve(ROOT, manifest.assetRoot, gta.id);
const archive = path.join(fixture, gta.package.file);
if (!fs.existsSync(archive)) {
  console.log('SKIP  GTA1 DOS demo fixture is absent');
  process.exit(0);
}
assert.strictEqual(fs.statSync(archive).size, gta.package.size);
assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
  gta.package.sha256);
const executable = path.join(fixture, gta.executable);
assert(fs.existsSync(executable), 'GTA1 archive is extracted with its directory layout');
const bytes = fs.readFileSync(executable);
assert.strictEqual(bytes.length, 2001991);
assert.strictEqual(bytes.subarray(0, 2).toString('ascii'), 'MZ');
assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'),
  '2f1cedfb95254b2f1a8913f1aeac7a915966cb42c70c9c96b14b8861fbf78c9f');
assert(bytes.includes(Buffer.from('DOS/4GW Professional')));
assert(bytes.includes(Buffer.from('VESA driver version 1.2 or greater needed')));
for (const companion of ['DOS4GW.EXE', '../GTADATA/AUDIO/LEVEL001.RAW', 'STARTUP.INI']) {
  assert(fs.existsSync(path.resolve(path.dirname(executable), companion)),
    `GTA1 keeps required companion ${companion}`);
}

console.log('PASS  GTA1 official DOS demo is hash-pinned with its complete game tree');
