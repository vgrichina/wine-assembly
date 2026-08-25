#!/usr/bin/env node

// HYPERTRM.DLL resolves the whole TAPI line* entry-point set through
// LoadLibraryA("TAPI32.DLL") + GetProcAddress and treats one NULL as fatal:
// it puts up "HyperTerminal has reported a general TAPI Error" and never
// becomes usable. With the set present lineInitialize succeeds and reports
// zero line devices — the honest state of a machine with no modem — and
// HyperTerminal reaches its real no-modem prompt instead.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-apps', 'hypertrm.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  test-tapi-line-init: hypertrm.exe not present');
  process.exit(0);
}

const out = execFileSync('node', [
  path.join(ROOT, 'test', 'run.js'),
  '--app=hypertrm',
  '--no-build',
  '--no-close',
  '--quiet-api',
  '--quiet-blocks',
  '--max-batches=1500',
  '--batch-size=100000',
], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

assert(!/general TAPI Error/i.test(out),
  'HyperTerminal must not report a general TAPI Error — a line* export is missing');
assert(!/CRASH|RuntimeError|UNIMPLEMENTED/.test(out),
  'HyperTerminal must not crash while initializing TAPI');
assert(/\[CreateWindow\].*title="HyperTerminal"/.test(out),
  'HyperTerminal must create its main window');
// The prompt is what lineInitialize's dwNumDevs = 0 actually means to the
// app, so it doubles as proof the out-parameter was written.
assert(/You need to install a modem/i.test(out),
  'HyperTerminal must reach its no-modem prompt, proving lineInitialize reported 0 devices');

console.log('PASS  test-tapi-line-init: TAPI line device set resolves and reports no devices');
