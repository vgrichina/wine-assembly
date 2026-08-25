#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const engine = path.join(root,
  'test/binaries/candidates/heroes-3-demo-installer/installer-engine/_ins5576._mp');
if (!fs.existsSync(engine)) {
  console.log('SKIP Heroes III local installer payload is not present');
  process.exit(0);
}

const run = spawnSync(process.execPath, [
  'test/run.js',
  '--app=heroes3_demo_installer',
  '--screen=800x600',
  '--max-batches=30000',
  '--max-seconds=180',
  '--stuck-after=1000000',
  '--quiet-api',
  '--quiet-blocks',
  '--no-close',
  '--no-renderer',
  '--input=1:wait-dlg-control:1:25000,2:dlg-input-click:1,' +
    '3:wait-dlg-control:6:25000,4:dlg-input-click:6,' +
    '5:wait-dlg-control:1001:25000,6:dlg-input-click:1001,' +
    '7:wait-dlg-control:1:25000,8:dlg-dump:destination',
], {
  cwd: root,
  encoding: 'utf8',
  timeout: 90000,
  maxBuffer: 16 * 1024 * 1024,
});
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
assert.strictEqual(run.error, undefined, run.error && run.error.message);
assert.strictEqual(run.status, 0, output.slice(-6000));
for (const marker of [
  '[LoadLibrary] chkreqs.dll loaded',
  'System Requirements for Heroes of Might and Magic® III Demo',
  'dlg-dump:destination:',
  'Destination Folder',
  'C:\\Program Files\\3DO\\Heroes III Demo',
]) {
  assert(output.includes(marker), `missing installer marker ${marker}\n${output.slice(-6000)}`);
}
assert(!/UNIMPLEMENTED API|ABANDONED wndproc|\*\*\* CRASH/i.test(output),
  `installer hit a runtime failure\n${output.slice(-6000)}`);

console.log('PASS Heroes III installer accepts its license and system requirements');
console.log('PASS Heroes III installer reaches its destination page without a runtime failure');
