#!/usr/bin/env node
'use strict';

// Win16 class menus named by string have to be reachable with real mouse
// input. Cruel and Golf register their WNDCLASS with "CRUEL"/"GOLF" as
// lpszMenuName; the NE RT_NAMETABLE maps those names to numeric menu entries.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');

function run(app, input, batches) {
  return execFileSync(process.execPath, [
    RUN, `--app=${app}`, '--no-close', '--batch-size=100',
    `--max-batches=${batches}`, `--input=${input}`,
    '--quiet-api', '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 180000,
    maxBuffer: 32 * 1024 * 1024 });
}

if (!fs.existsSync(path.join(ROOT, 'test', 'binaries', 'wep16', 'WEP1', 'CRUEL.EXE'))) {
  console.log('SKIP  Win16 Cruel/Golf corpus is not installed');
  process.exit(0);
}

const cruel = run('wep16_cruel',
  '1650:dump-windows:startup,1700:click:75:31,1800:menu-dump:options,' +
  '1900:click:75:52,2400:dump-windows:deck,2450:stop', 2500);
assert.doesNotMatch(cruel, /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError/);
assert.match(cruel, /window:startup .*menuBar=true .*title="Cruel"/,
  'Cruel must expose the class-owned menu bar');
assert.match(cruel, /menu-dump:options: .*count=2 .*id=9 .*Deck/,
  'a real click must open Cruel\'s Options menu');
assert.match(cruel, /window:deck .*dialog=true .*title="Select Card Back"/,
  'clicking Options > Deck must open the card-back dialog');
console.log('PASS  Win16 Cruel exposes and operates its named class menu');

const golf = run('wep16_golf', '1650:dump-windows:startup,1700:stop', 1750);
assert.doesNotMatch(golf, /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError/);
assert.match(golf, /window:startup .*menuBar=true .*title="Golf"/,
  'Golf must expose the same named-class menu path');
console.log('PASS  Win16 Golf exposes its named class menu');
