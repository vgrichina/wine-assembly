#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const exe = path.join(root,
  'test/binaries/candidates/half-life-uplink-installer/installed/hldemo.exe');
if (!fs.existsSync(exe)) {
  console.log('SKIP Half-Life Uplink installer-produced payload is not present');
  process.exit(0);
}

const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'hlu-web-'));
const run = spawnSync(process.execPath, ['test/test-local-candidate-desktop-web.js'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 240000,
  maxBuffer: 16 * 1024 * 1024,
  env: {
    ...process.env,
    CANDIDATE_IDS: 'halflife_uplink',
    CANDIDATE_SCREENSHOT_DIR: shots,
  },
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
assert.strictEqual(run.error, undefined, run.error && run.error.message);
assert.strictEqual(run.status, 0, output.slice(-6000));
assert(/PASS\s+halflife_uplink:/i.test(output),
  `browser harness did not report the Uplink menu acceptance\n${output.slice(-6000)}`);
console.log(`PASS Half-Life Uplink localhost dropdown renders its menu (${shots})`);
