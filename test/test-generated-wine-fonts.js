#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
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
  'MSSansSerif.fon': {
    face: 'MS Sans Serif',
    metrics: [[6, 13], [7, 16], [8, 20]],
  },
  'Courier.fon': { face: 'Courier', metrics: [[8, 13]] },
  'Terminal.fon': { face: 'Terminal', metrics: [[8, 12]], charset: 255, first: 0 },
  // Tahoma is the Win98 shell and tooltip face. These are Wine's embedded
  // monochrome strikes, extracted verbatim across exactly the ppem range
  // dialogs use — no outline is rasterized at any of them.
  'Tahoma.fon': {
    face: 'Tahoma',
    metrics: [[4, 8], [5, 9], [5, 10], [6, 11], [7, 12], [7, 13], [8, 15], [9, 16]],
    weight: 400,
  },
  // Bold must declare dfWeight 700. A bold strike reporting 400 would be
  // indistinguishable from its regular sibling to face selection, and the
  // wrong one would win by table order.
  'TahomaBold.fon': {
    face: 'Tahoma Bold',
    metrics: [[6, 9], [6, 10], [7, 11], [8, 12], [8, 13], [10, 15], [10, 16]],
    weight: 700,
  },
  'SmallFonts.fon': { face: 'Small Fonts', metrics: [[5, 11]], weight: 400 },
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
        offset: strike,
        face,
        average: bytes.readUInt16LE(strike + 91),
        height: bytes.readUInt16LE(strike + 88),
        points: bytes.readUInt16LE(strike + 68),
        ascent: bytes.readUInt16LE(strike + 74),
        internalLeading: bytes.readUInt16LE(strike + 76),
        charset: bytes[strike + 85],
        first: bytes[strike + 95],
        last: bytes[strike + 96],
        weight: bytes.readUInt16LE(strike + 83),
      });
    }
  }
  return result;
}

function glyphRows(bytes, strike, code) {
  assert(code >= strike.first && code <= strike.last, 'glyph is within FNT range');
  const entry = strike.offset + 148 + (code - strike.first) * 6;
  const width = bytes.readUInt16LE(entry);
  const height = strike.height;
  const bits = strike.offset + bytes.readUInt32LE(entry + 2);
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      if (bytes[bits + Math.floor(x / 8) * height + y] & (0x80 >> (x & 7))) {
        row |= 0x80 >> x;
      }
    }
    rows.push(row);
  }
  return rows;
}

const anakronSource = fs.readFileSync(path.join(
  ROOT, 'fonts', 'anakron', 'ANAKRON-v0.3.3.bdf'));
assert.strictEqual(
  crypto.createHash('sha256').update(anakronSource).digest('hex'),
  'd792885acf2043beb7e16bd0a85fce498e3e072e2ce828c750d14b074474f119',
  'ANAKRON source must remain the pinned v0.3.3 release asset');

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
    if (spec.weight !== undefined) {
      assert(parsed.every(strike => strike.weight === spec.weight),
        `${name} must declare dfWeight ${spec.weight}`);
    }
    if (spec.charset !== undefined) {
      assert(parsed.every(strike => strike.charset === spec.charset), `${name} charset`);
      assert(parsed.every(strike => strike.first === spec.first && strike.last === 255),
        `${name} byte coverage`);
    }
    if (name === 'Tahoma.fon') {
      // Wine's Tahoma strikes carry no bitmap for space at 11ppem and above,
      // because it has an advance and no ink. That is the case that must come
      // out as a blank cell rather than as a rasterized outline or an error.
      for (const strike of parsed) {
        assert.deepStrictEqual(glyphRows(generated, strike, 0x20),
          Array(strike.height).fill(0),
          `Tahoma space must be blank at ${strike.height}px`);
        assert(glyphRows(generated, strike, 0x41).some(row => row !== 0),
          `Tahoma A must have ink at ${strike.height}px`);
      }
    }
    if (name === 'MSSansSerif.fon') {
      assert.deepStrictEqual(parsed.map(strike => strike.height),
        [13, 16, 20],
        'MS Sans Serif must preserve only Wine native bitmap cells');
      assert.deepStrictEqual(parsed.map(strike => strike.points),
        [8, 10, 12],
        'MS Sans Serif native point-size ladder');
      assert.deepStrictEqual(parsed.map(strike => strike.internalLeading),
        [2, 3, 4],
        'MS Sans Serif character-height metadata');
      assert.deepStrictEqual(parsed.map(strike => strike.ascent),
        [11, 13, 16],
        'native Wine bitmap baseline ladder');
    }
    if (name === 'Terminal.fon') {
      const strike = parsed[0];
      assert.deepStrictEqual(glyphRows(generated, strike, 0x00), Array(12).fill(0),
        'CP437 0x00 must remain a blank NUL cell');
      assert.deepStrictEqual(glyphRows(generated, strike, 0x01),
        [0, 0, 0x3c, 0x42, 0xa5, 0x81, 0xa5, 0x99, 0x42, 0x3c, 0, 0],
        'CP437 0x01 must be the ANAKRON white smiling face');
      assert.deepStrictEqual(glyphRows(generated, strike, 0xb3),
        Array(12).fill(0x08), 'CP437 0xb3 must be an unbroken vertical line');
      assert.deepStrictEqual(glyphRows(generated, strike, 0xc4),
        [0, 0, 0, 0, 0, 0, 0xff, 0, 0, 0, 0, 0],
        'CP437 0xc4 must be an edge-to-edge horizontal line');
      assert.deepStrictEqual(glyphRows(generated, strike, 0xdb),
        Array(12).fill(0xff), 'CP437 0xdb must be a complete 8x12 block');
    }
  }
  console.log(`PASS  Wine and ANAKRON sources reproduce all ${Object.keys(expected).length} tracked FON resources exactly`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
