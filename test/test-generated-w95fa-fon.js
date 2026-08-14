#!/usr/bin/env node
// Manual build/structure regression for the optional FreeType font generator.
// This is intentionally not in run-all.sh because FreeType headers are a host
// build dependency rather than an emulator runtime dependency.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const probe = spawnSync('pkg-config', ['--exists', 'freetype2']);
if (probe.error || probe.status !== 0) {
  console.log('SKIP  generated W95FA FON test requires pkg-config freetype2');
  process.exit(0);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-w95fa-'));
const output = path.join(temp, 'w95fa.fon');
try {
  execFileSync('bash', [path.join(ROOT, 'tools', 'gen-w95fa-fon.sh'), output], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const bytes = fs.readFileSync(output);
  assert.strictEqual(bytes.readUInt16LE(0), 0x5a4d, 'DOS signature');
  const ne = bytes.readUInt32LE(0x3c);
  assert.strictEqual(bytes.readUInt16LE(ne), 0x454e, 'NE signature');
  const resources = ne + bytes.readUInt16LE(ne + 0x24);
  const shift = bytes.readUInt16LE(resources);
  const strikes = [];
  let sawFontDir = false;
  let cursor = resources + 2;
  for (;;) {
    const rawType = bytes.readUInt16LE(cursor);
    if (!rawType) break;
    const type = rawType & 0x7fff;
    const count = bytes.readUInt16LE(cursor + 2);
    cursor += 8;
    for (let index = 0; index < count; index++, cursor += 12) {
      const offset = bytes.readUInt16LE(cursor) << shift;
      if (type === 7) sawFontDir = true;
      if (type !== 8) continue;
      assert.strictEqual(bytes.readUInt16LE(offset), 0x0300, 'FNT 3.0 version');
      const declaredSize = bytes.readUInt32LE(offset + 2);
      const faceOffset = bytes.readUInt32LE(offset + 105);
      assert(declaredSize > 148 && offset + declaredSize <= bytes.length,
        'bounded FNT payload');
      assert.strictEqual(bytes.subarray(offset + faceOffset).toString('latin1').split('\0')[0],
        'W95FA');
      strikes.push(bytes.readUInt16LE(offset + 88));
    }
  }
  assert(sawFontDir, 'RT_FONTDIR resource');
  assert.deepStrictEqual(strikes, [11, 12, 16, 24, 32, 48, 64]);
  console.log(`PASS  generated NE FON contains W95FA strikes ${strikes.join(', ')}px`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
