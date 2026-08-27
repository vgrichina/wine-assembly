#!/usr/bin/env node
'use strict';

// Jazz needs a small cooperative slice because its decoder otherwise occupies
// the browser thread for too long. Once its main guest actually lives in a
// Worker, applying that same slice just creates thousands of message round
// trips and starves the emulated CPU. Keep the distinction tied to the backend
// that successfully started, not merely to the user's Threads preference.

const assert = require('assert');
const { createBrowserShell } = require('../lib/browser-shell.js');

let selected = 'auto';
global.document = {
  getElementById(id) {
    return id === 'slice-size-select' ? { value: selected } : null;
  },
};
global.window = {};
global.WineAssembly = { supportsWasmTailCalls: () => true };

const shell = createBrowserShell({
  apps: {},
  screenCanvasSize: () => ({ width: 800, height: 600 }),
});

assert.strictEqual(shell.selectedRunSlice('jazz2_demo'), 1000,
  'the default and cooperative Jazz path stays at 1k');
assert.strictEqual(shell.selectedRunSlice('jazz2_demo', false), 1000,
  'an explicit cooperative backend stays at 1k');
assert.strictEqual(shell.selectedRunSlice('jazz2_demo', true), 100000,
  'a confirmed Jazz guest Worker uses 100k');
assert.strictEqual(shell.selectedRunSlice('halflife_uplink', true), 1000,
  'the Worker override is app-scoped');

selected = '10000';
assert.strictEqual(shell.selectedRunSlice('jazz2_demo', true), 10000,
  'an explicit slice dropdown selection remains authoritative');

global.WineAssembly.supportsWasmTailCalls = () => false;
selected = 'auto';
assert.strictEqual(shell.selectedRunSlice('jazz2_demo', true), 100000,
  'the Worker auto policy does not depend on the dispatch implementation');
assert.strictEqual(shell.selectedRunSlice('jazz2_demo', false), 1000,
  'the compatibility cooperative path remains bounded');

console.log('PASS browser run-slice policy distinguishes Jazz Worker and cooperative backends');
