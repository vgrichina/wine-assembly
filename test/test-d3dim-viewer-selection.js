#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const out = execFileSync('node', [
  path.join(__dirname, 'run.js'),
  '--app=dx_viewer',
  '--no-build',
  '--batch-size=10000',
  '--max-batches=140',
  '--quiet-api',
  '--input=100:click:330:100,110:post-cmd:104,125:dump-windows:color,130:stop',
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 120000,
  stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 32 * 1024 * 1024,
});

assert(/window:color .*title="Direct3D Object Viewer"/.test(out),
  'Viewer did not survive selecting the rendered mesh');
assert(/window:color .*dialog=true.*title="Color"/.test(out),
  'Edit -> Change Color did not open after selecting the rendered mesh');
assert(!/RuntimeError|UNIMPLEMENTED API|CRASH/.test(out),
  'Viewer selection/menu path crashed');

console.log('PASS Viewer rendered-mesh selection enables the Change Color dialog');
