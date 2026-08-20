#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fixture = require('./fixtures/gdi-font-outline-win98.json');

assert.strictEqual(fixture.provenance.kind, 'native-windows-98-reference');
assert.match(fixture.provenance.probeSourceSha256, /^[0-9a-f]{64}$/);
assert.match(fixture.provenance.probeExeSha256, /^[0-9a-f]{64}$/);
assert.match(fixture.provenance.serialOutputSha256, /^[0-9a-f]{64}$/);
assert.match(fixture.provenance.screenshotSha256, /^[0-9a-f]{64}$/);
const probeSource = fs.readFileSync(path.join(__dirname, '..', fixture.provenance.source));
assert.strictEqual(crypto.createHash('sha256').update(probeSource).digest('hex'),
  fixture.provenance.probeSourceSha256,
  'the pinned fixture must identify the exact probe source that produced it');
assert.deepStrictEqual(fixture.face, { requested: 'Arial', selected: 'Arial', height: -24 });

const outlineCase = (character, format, matrix = 'identity') => {
  const found = fixture.cases.find(entry => entry.character === character
    && entry.format === format && entry.matrix === matrix);
  assert.ok(found, `missing Win98 outline case ${character}/${format}/${matrix}`);
  return found;
};

for (const character of [65, 103, 233]) {
  assert.strictEqual(outlineCase(character, 0).needed, 0,
    'GGO_METRICS returns no payload');
  assert.ok(outlineCase(character, 1).needed > 0, 'GGO_BITMAP must succeed');
  assert.ok(outlineCase(character, 2).needed > 0, 'GGO_NATIVE must succeed');
  assert.strictEqual(outlineCase(character, 3).needed, -1,
    'real Win98 rejects the newer GGO_BEZIER format');
  for (const [format, maximum] of [[4, 4], [5, 16], [6, 64]]) {
    const entry = outlineCase(character, format);
    assert.ok(entry.needed > 0 && entry.result === entry.needed,
      `GGO gray-${maximum} must size and return a payload`);
    assert.strictEqual(entry.dataMax, maximum,
      `GGO gray-${maximum} uses inclusive coverage maximum ${maximum}`);
  }
  assert.deepStrictEqual(outlineCase(character, 257).resultMetrics,
    outlineCase(character, 1).resultMetrics,
    'GGO_UNHINTED bitmap metrics match Win98 hinted metrics');
  assert.deepStrictEqual(outlineCase(character, 258).resultMetrics,
    outlineCase(character, 2).resultMetrics,
    'GGO_UNHINTED native metrics match Win98 hinted metrics');
}

assert.ok(outlineCase(65, 2, 'shear-quarter').needed > 0,
  'Win98 transforms GGO_NATIVE through MAT2');
assert.ok(outlineCase(65, 1, 'shear-quarter').needed > 0,
  'Win98 transforms GGO_BITMAP through MAT2');
assert.strictEqual(fixture.kerning.total, 105);
for (const [first, second, amount] of [
  [65, 86, -2], [65, 87, -1], [84, 111, -3],
  [87, 97, -1], [89, 111, -2],
]) {
  assert.deepStrictEqual(fixture.kerning.pairs.find(pair =>
    pair.first === first && pair.second === second),
  { first, second, found: true, amount });
}
assert.deepStrictEqual(fixture.kerning.pairs.find(pair =>
  pair.first === 102 && pair.second === 105),
{ first: 102, second: 105, found: false, amount: 0 });

const placement = (text, flags) => {
  const found = fixture.placements.find(entry => entry.text === text && entry.flags === flags);
  assert.ok(found, `missing Win98 GCP case ${text}/${flags}`);
  return found;
};
assert.deepStrictEqual(placement('AV', 0).dx, [15, 15]);
assert.deepStrictEqual(placement('AV', 8).dx, [13, 15],
  'GCP_USEKERNING applies the pair adjustment to the left glyph advance');
assert.deepStrictEqual(placement('AV', 8).caret, [0, 13]);
assert.deepStrictEqual(placement('To', 0).dx, [14, 13]);
assert.deepStrictEqual(placement('To', 8).dx, [11, 13]);
assert.strictEqual((placement('AV', 0).packed & 0xffff)
  - (placement('AV', 8).packed & 0xffff), 2);

console.log(`PASS  pinned Win98 GDI outline contract: ${fixture.cases.length} cases, `
  + `${fixture.kerning.total} kerning pairs, ${fixture.placements.length} placements`);
