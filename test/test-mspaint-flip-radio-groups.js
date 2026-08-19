#!/usr/bin/env node

// Paint's Flip/Rotate dialog contains two independent WS_GROUP radio sets:
// the operation and, when rotate is selected, the angle.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

const input = [
  '30:wait-title-command:untitled_-_Paint:80:37680:flip',
  '40:dlg-click:1089',       // Rotate by angle
  '42:dlg-dump:mode',
  '44:dlg-click:1091',       // 180 degrees
  '46:dlg-dump:angle',
  '48:dlg-click:2',
  '50:stop',
].join(',');

let output = '';
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=60',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
} catch (error) {
  output = `${error.stdout || ''}${error.stderr || ''}`;
  assert.fail(`Paint Flip/Rotate run failed:\n${output.slice(-4000)}`);
}

const mode = output.split('\n').find(line => line.includes('dlg-dump:mode:')) || '';
const angle = output.split('\n').find(line => line.includes('dlg-dump:angle:')) || '';
const checked = (line, id) => {
  const match = line.match(new RegExp(`id=${id} cls=1[^|]* checked=(\\d+)`));
  return match ? Number(match[1]) : -1;
};

assert.strictEqual(checked(mode, 1089), 1, 'Rotate by angle did not become selected');
assert.strictEqual(checked(angle, 1089), 1,
  'choosing an angle cleared Paint\'s Rotate by angle selection');
assert.strictEqual(checked(angle, 1090), 0, '90-degree angle remained selected');
assert.strictEqual(checked(angle, 1091), 1, '180-degree angle did not become selected');
assert.strictEqual(checked(angle, 1092), 0, '270-degree angle remained selected');
assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output),
  'Paint Flip/Rotate triggered an emulator failure');

console.log('PASS  Paint Flip/Rotate preserves independent operation and angle radio groups');
