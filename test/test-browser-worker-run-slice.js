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
assert.strictEqual(shell.selectedRunSlice('halflife_uplink', false), 10000,
  'cooperative Uplink gives OpenGL enough work per slice for gameplay');
assert.strictEqual(shell.selectedRunSlice('halflife_uplink', true), 10000,
  'the Worker override is app-scoped');
assert.strictEqual(shell.selectedRunSlice('cue:speed-demons', false), 500000,
  'Speed Demons Auto uses the measured installer/gameplay budget');
assert.strictEqual(shell.selectedRunSlice(
  'iso:sidmeieralphacentauriclassic-windows95', false), 500000,
  'the exact SMAC disc feeds synchronous Quick Start terrain generation');

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
const { hasPageScript } = require('./browser-runtime-scripts');
const hostSource = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
const shellSource = fs.readFileSync(path.join(__dirname, '..', 'lib/browser-shell.js'), 'utf8');
assert(hostSource.includes('const activeStepsPerSlice = Math.max(1, (self.stepsPerSlice | 0) || stepsPerSlice);'),
  'the cooperative host must honor browser-shell slices below 1k');
assert(hostSource.includes('const configuredSteps = Math.max(1000, (self.stepsPerSlice | 0) || stepsPerSlice);'),
  'the guest-Worker backend should retain its 1k messaging floor');
assert(hasPageScript('lib/browser-shell.js'),
  'the page centrally versions the Uplink slice policy');
assert(shellSource.includes("if (Number(change.data) === 2) applyRendererSlice('opengl');"),
  'Uplink keeps the setup quantum until a real DirectDraw frame selects Software');
assert(!shellSource.includes("applyRendererSlice(Number(change.data) === 2 ? 'opengl' : 'software')"),
  'the registry write must not throttle Software before renderer restart completes');
assert(hasPageScript('host.js'),
  'the page centrally versions cooperative slice enforcement');

console.log('PASS browser run-slice policy distinguishes Jazz Worker and cooperative backends');
