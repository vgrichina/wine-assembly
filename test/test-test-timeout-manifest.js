#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { findTimeouts, listedTests } = require('../tools/check-test-timeouts');
const { validateOverrides, loadTimeoutOverrides, parseGlobalTimeout } = require('../tools/test-timeouts');
const { spawnSync } = require('child_process');
const os = require('os');

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

const root = path.join(__dirname, '..');
const runner = fs.readFileSync(path.join(root, 'test/run-all.sh'), 'utf8');
const overrides = loadTimeoutOverrides({ tests: new Set(listedTests(runner)) });
const darkstone = 'test/test-darkstone-gameplay.js';
assert.strictEqual(overrides.get(darkstone).seconds, 660);
assert.deepStrictEqual(findTimeouts(fs.readFileSync(path.join(root, darkstone), 'utf8'), 660), []);
const entry = { test: darkstone, seconds: 660, reason: 'full gameplay acceptance' };
for (const bad of [null, {}, [null], [{ ...entry, extra: true }],
  [entry, entry], [{ ...entry, seconds: 0 }], [{ ...entry, seconds: -1 }],
  [{ ...entry, seconds: 1.5 }], [{ ...entry, seconds: '660' }],
  [{ ...entry, seconds: Infinity }], [{ ...entry, seconds: 2147483648 }],
  [{ ...entry, reason: '' }], [{ ...entry, reason: ' ' }],
  [{ ...entry, test: '../test/test-darkstone-gameplay.js' }],
  [{ ...entry, test: 'test/test-nonexistent-timeout-override.js' }]]) {
  assert.throws(() => validateOverrides(bad), 'invalid timeout overrides must fail closed');
}
assert.throws(() => validateOverrides([entry], { tests: new Set() }), /not in the manifest/);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-timeout-schema-'));
try {
  fs.mkdirSync(path.join(fixture, 'test/test-directory.js'), { recursive: true });
  assert.throws(() => validateOverrides([{ ...entry, test: 'test/test-directory.js' }],
    { root: fixture }), /regular test file/);
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
assert.strictEqual(parseGlobalTimeout('0'), 0);
assert.strictEqual(parseGlobalTimeout('0300'), 300);
for (const value of ['', '-1', '1.5', 'Infinity', ' 300', '2147483648']) {
  assert.throws(() => parseGlobalTimeout(value));
}

// Execute the runner's real argument/default-selection code without launching
// a test tier. This covers Bash precedence and the map-loading interface too.
const argsSource = runner.slice(runner.indexOf('TIER=all'), runner.indexOf('\nUNIT=('));
const capsSource = runner.slice(runner.indexOf('DEFAULT_TEST_TIMEOUT='), runner.indexOf('\nSKIP_EXIT_STATUS='));
assert(argsSource.includes('TEST_TIMEOUT_EXPLICIT'));
assert(capsSource.includes('test_timeout_for()'));
function selectedCap(test, envValue, args = []) {
  const env = { ...process.env, TARGET_TEST: test };
  delete env.TEST_TIMEOUT;
  if (envValue !== undefined) env.TEST_TIMEOUT = envValue;
  return spawnSync('bash', ['-c', `set -u\n${argsSource}\n${capsSource}\ntest_timeout_for "$TARGET_TEST"`,
    'timeout-probe', ...args], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
}
for (const [test, envValue, args, expected] of [
  ['test/test-vfs.js', undefined, [], '300'],
  [darkstone, undefined, [], '660'],
  [darkstone, '', [], '660'],
  [darkstone, '120', [], '120'],
  [darkstone, '120', ['--timeout=180'], '180'],
  [darkstone, undefined, ['--timeout=0'], '0'],
  [darkstone, '0', [], '0'],
]) {
  const result = selectedCap(test, envValue, args);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout.trim(), expected);
}
for (const [envValue, args] of [['bad', []], [undefined, ['--timeout=']], [undefined, ['--timeout=-1']]]) {
  assert.strictEqual(selectedCap(darkstone, envValue, args).status, 2);
}
assert(runner.includes('slot_timeout[$i]=$(test_timeout_for "$f")'));
assert(runner.includes('killed after ${slot_timeout[$i]}s wall clock'), 'watchdog logs the selected cap');

console.log('PASS  timeout manifest validation and runner default/per-test/user precedence');
