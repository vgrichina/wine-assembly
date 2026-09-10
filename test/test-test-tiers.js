#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  E2E_EXCEPTIONS,
  SMOKE_TESTS,
  UNIT_EXCEPTIONS,
  classifyTest,
  conventionTier,
  validateTiers,
} = require('../tools/test-tiers');

const ROOT = path.join(__dirname, '..');
const result = validateTiers(ROOT);
assert.deepStrictEqual(result.errors, [], 'the live test tree should have a valid tier assignment');

const placed = Object.values(result.tiers).flat();
assert.strictEqual(placed.length, result.actual.length,
  'every discovered test should be placed exactly once');
assert.strictEqual(new Set(placed).size, result.actual.length,
  'no test should appear in two tiers');
assert(result.actual.includes('test/test-test-tiers.js'),
  'new conventionally named tests should be discovered without a manifest edit');

for (const name of [
  'test-future-browser-web.js',
  'test-future-gameplay.js',
  'test-future-candidate.js',
  'test-future-installer.js',
  'test-future-installed.js',
  'test-future-dosbox.js',
  'test-future-scummvm.js',
]) {
  assert.strictEqual(classifyTest(`test/${name}`), 'e2e', `${name} should follow the E2E convention`);
}
assert.strictEqual(classifyTest('test/test-future-api.js'), 'unit');
assert.strictEqual(classifyTest('test/future-compiler.test.js'), 'unit');
assert.strictEqual(classifyTest('test/browser-runtime-scripts.js'), null,
  'test helpers should not be mistaken for executable tests');

for (const name of UNIT_EXCEPTIONS) {
  assert.strictEqual(conventionTier(name), 'e2e', `${name} should override an E2E convention`);
  assert.strictEqual(classifyTest(`test/${name}`), 'unit');
}
for (const name of E2E_EXCEPTIONS) {
  assert.strictEqual(conventionTier(name), 'unit', `${name} should be an actual E2E exception`);
  assert.strictEqual(classifyTest(`test/${name}`), 'e2e');
}
for (const name of SMOKE_TESTS) assert.strictEqual(classifyTest(`test/${name}`), 'smoke');

const runner = fs.readFileSync(path.join(ROOT, 'test', 'run-all.sh'), 'utf8');
assert.doesNotMatch(runner, /^\s+test\/(?:test-|[^\s]+\.test\.js)/m,
  'run-all should not transcribe individual test memberships');
assert.match(runner, /node tools\/test-tiers\.js unit/);
assert.match(runner, /node tools\/test-tiers\.js e2e/);
assert.match(runner, /node tools\/test-tiers\.js smoke/);

const timeoutGate = fs.readFileSync(path.join(ROOT, 'tools', 'check-test-timeouts.js'), 'utf8');
assert.match(timeoutGate, /validateTiers\(ROOT\)/,
  'the timeout gate should audit the same discovered test set as the runner');

console.log(`PASS  ${result.actual.length} tests derive one tier from filenames and validated exceptions`);
