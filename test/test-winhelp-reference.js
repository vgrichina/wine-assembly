#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const viewer = path.join(root, 'test', 'binaries', 'help', 'winhlp32.exe');
const helpFile = path.join(root, 'test', 'binaries', 'help', 'notepad.hlp');
const screenshot = path.join(root, 'build', 'winhelp-reference.png');

if (!fs.existsSync(viewer)) {
  console.log('WinHelp reference: SKIP (test/binaries/help/winhlp32.exe absent)');
  process.exit(0);
}

const bytes = fs.readFileSync(viewer);
if (bytes.length !== 319488) throw new Error(`unexpected winhlp32.exe size: ${bytes.length}`);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
if (sha256 !== 'd18e766a5dec37a21775eb1933b67fd211e82cd4f8f83ca0824d9d443838fb0a') {
  throw new Error(`unexpected winhlp32.exe SHA-256: ${sha256}`);
}
if (!fs.existsSync(helpFile)) throw new Error('tracked Notepad HLP fixture is missing');

fs.mkdirSync(path.dirname(screenshot), { recursive: true });
const run = spawnSync(process.execPath, [
  path.join(root, 'test', 'run.js'),
  `--exe=${viewer}`,
  '--args=notepad.hlp',
  '--max-batches=2500',
  '--no-build',
  '--quiet-api',
  '--quiet-blocks',
  `--png=${screenshot}`,
], {
  cwd: root,
  encoding: 'utf8',
  timeout: 45000,
  env: { ...process.env, NODE_OPTIONS: '' },
});

const output = (run.stdout || '') + (run.stderr || '');
const failures = [];
if (!output.includes('[SetWindowText] "Notepad Help"')) failures.push('viewer never loaded Notepad Help');
if (!output.includes('[ShowWindow] hwnd=0x10001 cmd=10')) failures.push('main Help window was not shown');
if (!fs.existsSync(screenshot) || fs.statSync(screenshot).size < 1000) failures.push('rendered screenshot is missing');
if (/UNIMPLEMENTED API|R6018|\*\*\* CRASH|FATAL:/.test(output)) failures.push('viewer hit a fatal compatibility path');
if (run.error && run.error.code !== 'ETIMEDOUT') failures.push(run.error.message);

if (failures.length) {
  console.error(output.slice(-12000));
  throw new Error(failures.join('; '));
}

console.log(`WinHelp reference: PASS (${path.relative(root, screenshot)})`);
