#!/usr/bin/env node
// Manual build/structure regression for the optional FreeType font generator.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const probe = spawnSync('pkg-config', ['--exists', 'freetype2']);
if (probe.error || probe.status !== 0) {
  console.log('SKIP  generated Fixedsys FON test requires pkg-config freetype2');
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-fixedsys-'));
const output = path.join(temp, 'fixedsys.fon');
try {
  execFileSync('bash', [path.join(ROOT, 'tools', 'gen-fixedsys-fon.sh'), output], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const bytes = fs.readFileSync(output);
  const ne = bytes.readUInt32LE(0x3c);
  assert.strictEqual(bytes.readUInt16LE(ne), 0x454e, 'NE signature');
  const resources = ne + bytes.readUInt16LE(ne + 0x24);
  const shift = bytes.readUInt16LE(resources);
  let cursor = resources + 2;
  const strikes = [];
  for (;;) {
    const type = bytes.readUInt16LE(cursor) & 0x7fff;
    if (!type) break;
    const count = bytes.readUInt16LE(cursor + 2);
    cursor += 8;
    for (let index = 0; index < count; index++, cursor += 12) {
      if (type === 8) strikes.push(bytes.readUInt16LE(cursor) << shift);
    }
  }
  assert.strictEqual(strikes.length, 8, 'RT_FONT strike count');
  const metrics = strikes.map(strike => {
    assert.strictEqual(bytes.readUInt16LE(strike), 0x0300, 'FNT 3.0 version');
    const width = bytes.readUInt16LE(strike + 86);
    const height = bytes.readUInt16LE(strike + 88);
    assert(width > 0, `${height}px fixed cell width`);
    assert.strictEqual(bytes[strike + 90] & 1, 0,
      `${height}px fixed-pitch family flag`);
    assert.strictEqual(bytes.readUInt16LE(strike + 91), width,
      `${height}px average width`);
    assert.strictEqual(bytes.readUInt16LE(strike + 93), width,
      `${height}px maximum width`);
    for (let code = 32; code <= 255; code++) {
      assert.strictEqual(bytes.readUInt16LE(strike + 148 + (code - 32) * 6), width,
        `${height}px character ${code} width`);
    }
    const face = bytes.subarray(strike + bytes.readUInt32LE(strike + 105))
      .toString('latin1').split('\0')[0];
    assert.strictEqual(face, 'Fixedsys');
    return { width, height };
  });
  assert.deepStrictEqual(metrics.map(({ height }) => height),
    [16, 18, 21, 24, 32, 48, 64, 80], 'native Fixedsys cell heights');
  console.log(`PASS  generated NE FON contains native Fixedsys strikes ${
    metrics.map(({ width, height }) => `${width}x${height}`).join(', ')}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
