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
assert.strictEqual(shell.selectedRunSlice('halflife_uplink', false), 250,
  'cooperative Uplink keeps bitmap blending interruptible');
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

const fs = require('fs');
const path = require('path');
const hostSource = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
assert(hostSource.includes('const activeStepsPerSlice = Math.max(1, (self.stepsPerSlice | 0) || stepsPerSlice);'),
  'the cooperative host must honor browser-shell slices below 1k');
assert(hostSource.includes('const configuredSteps = Math.max(1000, (self.stepsPerSlice | 0) || stepsPerSlice);'),
  'the guest-Worker backend should retain its 1k messaging floor');
assert(indexSource.includes('lib/browser-shell.js?v=9'),
  'the page cache-busts the Uplink slice policy');
assert(indexSource.includes('host.js?v=240'),
  'the page cache-busts cooperative slice enforcement');

console.log('PASS browser run-slice policy distinguishes Jazz Worker and cooperative backends');
