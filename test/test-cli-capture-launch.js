#!/usr/bin/env node
'use strict';

// Pocket Tanks uses an Inno bootstrap that deletes its VFS-backed child as
// soon as ShellExecute returns. The CLI capture mode must preserve that child
// and its exact /SL command line for a separately controlled frozen run.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const INSTALLER = path.join(__dirname, 'binaries', 'candidates',
  'pocket-tanks-installer', 'ptanks.exe');

const runSource = fs.readFileSync(RUN, 'utf8');
assert(runSource.includes('ctx.vfs._resolvePath ? ctx.vfs._resolvePath(executable)'),
  'relative installer children must resolve against the guest current directory');

if (!fs.existsSync(INSTALLER)) {
  console.log('SKIP  Pocket Tanks installer fixture not found at ' + INSTALLER);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-launch-'));
try {
  const result = spawnSync('node', [
    RUN,
    '--exe=' + INSTALLER,
    '--screen=800x600',
    '--batch-size=100000',
    '--max-batches=300',
    '--max-seconds=90',
    '--quiet-api',
    '--quiet-blocks',
    '--no-build',
    '--capture-launch=' + tmp,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const output = String(result.stdout || '') + String(result.stderr || '');
  assert.strictEqual(result.status, 0,
    'capture run exited ' + result.status + '\n' + output.slice(-4000));
  assert.match(output, /\[capture-launch\] snapshotted .*\.tmp/i,
    'bootstrap child was not captured\n' + output.slice(-4000));

  const metadataPath = path.join(tmp, 'launch.json');
  assert(fs.existsSync(metadataPath), 'capture did not write launch.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  assert.strictEqual(metadata.schemaVersion, 1);
  assert.match(metadata.guestExe, /^c:\\windows\\temp\\.*\.tmp$/i);
  assert.match(metadata.args, /^\/SL4 \$10001 "C:\\ptanks\.exe" \d+ \d+$/i);
  assert(Number.isInteger(metadata.files) && metadata.files > 1,
    'capture omitted the bootstrap VFS');

  const childPath = path.join(tmp, ...metadata.exe.split('/'));
  assert(fs.statSync(childPath).size > 500000,
    'captured bootstrap child is missing or truncated');
  console.log('PASS  CLI captures a temporary installer child and launch metadata');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
