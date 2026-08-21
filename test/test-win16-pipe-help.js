#!/usr/bin/env node
'use strict';

// Exercise Pipe Dream's three document-specific Help menu commands through
// the real Win16 menu and USER.171 boundary. Index uses HELP_CONTENTS; How to
// Play and Commands use pointer-valued HELP_KEY data.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PIPE = path.join(ROOT, 'test', 'binaries', 'wep16', 'WEP2', 'PIPE.EXE');
const OPTIONAL_WASM = process.env.WINE_ASSEMBLY_WASM || '';

if (!fs.existsSync(PIPE)) {
  console.log('SKIP  Pipe Dream Help corpus is not installed');
  process.exit(0);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win16-pipe-help-'));
try {
  for (const [name, y] of [['Index', 52], ['How to Play', 72], ['Commands', 92]]) {
    const screenshot = path.join(outDir, `${name.toLowerCase().replaceAll(' ', '-')}.png`);
    const args = [path.join(ROOT, 'test', 'run.js'), '--app=wep16_pipe', '--no-close',
      '--batch-size=20000', '--max-batches=135', '--quiet-api', '--quiet-blocks'];
    if (OPTIONAL_WASM) args.push('--no-build', `--wasm=${OPTIONAL_WASM}`);
    args.push(`--input=30:mousedown:320:220,31:mouseup:320:220,` +
      `42:mousedown:115:31,43:mouseup:115:31,55:mousedown:145:${y},` +
      `56:mouseup:145:${y},90:png:${screenshot},105:stop`);
    const output = execFileSync(process.execPath, args, {
      cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.doesNotMatch(output, /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError/);
    assert.match(output, /\[CreateWindow\] hwnd=.*title="PipeDream"/,
      `${name} should open the original Pipe Dream help document`);
    assert(fs.existsSync(screenshot) && fs.statSync(screenshot).size > 10000,
      `${name} should render a non-empty Help window`);
    console.log(`PASS  Win16 Pipe Dream Help > ${name} opens`);
  }
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
