#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { findTimeouts, listedTests } = require('../tools/check-test-timeouts');

assert.deepStrictEqual(findTimeouts(`
  spawnSync('node', [], { timeout: 300000 });
  const timeoutMs = 300_000;
  const args = ['--max-seconds=300'];
`, 300), [], 'budgets equal to the runner cap should be accepted');

const overByOne = 300001;
const overByMinutes = 600000;
const overSeconds = 301;
const violations = findTimeouts(`
  // timeout: ${999999} is documentation, not a declaration
  const a = { timeout: ${overByOne} };
  function wait(timeoutMs = ${overByMinutes}) {}
  const args = ['--max-seconds=${overSeconds}'];
`, 300);
assert.deepStrictEqual(violations.map(item => [item.kind, item.value]), [
  ['timeout', 300001],
  ['timeout', 600000],
  ['--max-seconds', 301],
]);

assert.deepStrictEqual(listedTests(`
UNIT=(
  test/test-z.js
  test/test-a.js
  test/test-a.js
)
`), ['test/test-a.js', 'test/test-z.js']);

const manifest = fs.readFileSync(path.join(__dirname, '..', 'tools', 'check-test-manifest.sh'), 'utf8');
assert.match(manifest, /node tools\/check-test-timeouts\.js/,
  'timeout audit is not part of the manifest gate');

console.log('PASS  test manifest rejects per-test budgets above runner cap');
