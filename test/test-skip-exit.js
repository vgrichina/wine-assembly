#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PRELOAD = path.join(__dirname, 'skip-exit.js');
function run(source) {
  return spawnSync(process.execPath, ['--require', PRELOAD, '--eval', source], {
    encoding: 'utf8',
    env: { ...process.env, WA_TEST_SKIP_EXIT: '77' },
  });
}

assert.strictEqual(run("console.log('PASS ordinary')").status, 0,
  'ordinary success was reclassified');
assert.strictEqual(run("console.log('SKIP fixture absent')").status, 77,
  'natural completion after SKIP was reported as PASS');
assert.strictEqual(run("console.log('SKIP fixture absent'); process.exit(0)").status, 77,
  'explicit process.exit(0) bypassed SKIP status');
assert.strictEqual(run("console.log('SKIP fixture absent'); process.exit(2)").status, 2,
  'a real failure after SKIP was hidden');
assert.strictEqual(run("console.log('SKIPPED is ordinary prose')").status, 0,
  'non-protocol prose was treated as SKIP');

const runner = fs.readFileSync(path.join(__dirname, 'run-all.sh'), 'utf8');
assert.match(runner, /SKIP_EXIT_STATUS=77/);
assert.match(runner, /status -eq "\$SKIP_EXIT_STATUS"/);
assert.match(runner, /TOTAL: \$TOTAL_PASS passed, \$TOTAL_SKIP skipped, \$TOTAL_FAIL failed/);

console.log('PASS  SKIP protocol exits 77 without hiding failures');
