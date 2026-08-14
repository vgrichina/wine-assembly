#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const probe = spawnSync('pkg-config', ['--exists', 'freetype2']);
if (probe.error || probe.status !== 0) {
  console.log('SKIP  generated Wine font test requires pkg-config freetype2');
  process.exit(0);
}

const expected = {
  'Fixedsys.fon': { face: 'Fixedsys', metrics: [[8, 15]] },
  'System.fon': { face: 'System', metrics: [[7, 16], [8, 18]] },
  'MSSansSerif.fon': { face: 'MS Sans Serif', metrics: [[6, 13], [7, 16], [8, 20]] },
  'Courier.fon': { face: 'Courier', metrics: [[8, 13]] },
};

function strikes(bytes) {
  const ne = bytes.readUInt32LE(0x3c);
  assert.strictEqual(bytes.readUInt16LE(ne), 0x454e, 'NE signature');
  const resources = ne + bytes.readUInt16LE(ne + 0x24);
  const shift = bytes.readUInt16LE(resources);
  let cursor = resources + 2;
  const result = [];
  for (;;) {
    const type = bytes.readUInt16LE(cursor) & 0x7fff;
    if (!type) break;
    const count = bytes.readUInt16LE(cursor + 2);
    cursor += 8;
    for (let index = 0; index < count; index++, cursor += 12) {
      if (type !== 8) continue;
      const strike = bytes.readUInt16LE(cursor) << shift;
      const face = bytes.subarray(strike + bytes.readUInt32LE(strike + 105))
        .toString('latin1').split('\0')[0];
      result.push({
        face,
        average: bytes.readUInt16LE(strike + 91),
        height: bytes.readUInt16LE(strike + 88),
      });
    }
  }
  return result;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-wine-fonts-'));
try {
  execFileSync('bash', [path.join(ROOT, 'tools', 'gen-wine-fonts.sh'), temp], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  for (const [name, spec] of Object.entries(expected)) {
    const generated = fs.readFileSync(path.join(temp, name));
    const tracked = fs.readFileSync(path.join(ROOT, 'fonts', name));
    assert(generated.equals(tracked), `${name} must reproduce byte-for-byte`);
    const parsed = strikes(generated);
    assert(parsed.every(strike => strike.face === spec.face), `${name} face names`);
    assert.deepStrictEqual(parsed.map(strike => [strike.average, strike.height]), spec.metrics,
      `${name} embedded strike metrics`);
  }
  console.log('PASS  Wine bitmap sources reproduce all four tracked FON resources byte-for-byte');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
