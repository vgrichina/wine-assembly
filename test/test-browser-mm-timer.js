#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const hostSource = fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8');
const shellSource = fs.readFileSync(path.join(ROOT, 'lib', 'browser-shell.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const apps = require(path.join(ROOT, 'lib', 'apps.js')).APPS;
const context = { console };
vm.runInNewContext(hostSource + '\n;globalThis.WineAssembly = WineAssembly;', context);

const wine = new context.WineAssembly();
let calls = 0;
wine.instance = {
  exports: {
    get_eip: () => 0x00401000,
    fire_mm_timer: () => { calls++; return 1; },
  },
};

assert.strictEqual(wine._pumpMultimediaTimer(), 0,
  'multimedia timer pumping is disabled unless the app opts in');
assert.strictEqual(calls, 0, 'disabled timer delivery must not call into WASM');

wine.asyncMultimediaTimer = true;
assert.strictEqual(wine._pumpMultimediaTimer(), 1,
  'an opted-in app pumps the cooperative multimedia callback');
assert.strictEqual(calls, 1, 'the browser calls the existing WASM timer hook once');

wine.instance.exports.get_eip = () => 0;
assert.strictEqual(wine._pumpMultimediaTimer(), 0,
  'an exited guest cannot receive a multimedia callback');
assert.strictEqual(calls, 1, 'the exited guest did not call the timer hook');

assert.strictEqual(apps.diablo_demo.asyncMultimediaTimer, true,
  'Diablo opts into out-of-message-loop timeSetEvent delivery');
assert(shellSource.includes('wine.asyncMultimediaTimer = !!app.asyncMultimediaTimer'),
  'the browser launcher passes the per-app timer policy to WineAssembly');
assert(hostSource.includes('self._pumpMultimediaTimer();'),
  'the browser run loop pumps the opted-in timer after each main slice');
assert(indexSource.includes('lib/apps.js?v=2'),
  'the browser cache-busts Diablo app metadata');
assert(indexSource.includes('lib/browser-shell.js?v=2'),
  'the browser cache-busts per-app timer policy wiring');

console.log('PASS  browser multimedia timer delivery is isolated and per-app');
