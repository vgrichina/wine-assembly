#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  guestToWasm, GUEST_BASE, DIB_GUEST_BASE, DIB_BACKING_BASE,
} = require('../lib/mem-utils');
const {
  hasPageScript, hasWorkerScript, workerScripts,
} = require('./browser-runtime-scripts');

const ROOT = path.join(__dirname, '..');
const runtimeSources = [
  'host.js',
  'lib/app-profiles.js',
  'lib/dll-loader.js',
  'lib/filesystem.js',
  'lib/gl-compat.js',
  'lib/guest-worker.js',
  'lib/host-imports.js',
  'lib/renderer-input.js',
  'lib/thread-manager.js',
];

let exportedArg = null;
const exported = guestToWasm(0x1_0000_1234, {
  guest_to_wasm(addr) {
    exportedArg = addr;
    return 0x12345678;
  },
}, null);
assert.strictEqual(exportedArg, 0x1234,
  'guestToWasm must normalize a pointer before calling the WAT export');
assert.strictEqual(exported, 0x12345678,
  'guestToWasm must return the WAT translator result');

assert.strictEqual(guestToWasm(0x401234,
  { get_image_base: () => 0x400000 }, null), GUEST_BASE + 0x1234,
  'the no-export fallback must preserve direct-window translation');
assert.strictEqual(guestToWasm(DIB_GUEST_BASE + 0x4321,
  { get_image_base: () => 0x400000 }, null), DIB_BACKING_BASE + 0x4321,
  'the no-export fallback must preserve DIB translation');

for (const relative of runtimeSources) {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  assert(source.includes('guestToWasm'),
    `${relative} must consume the shared guestToWasm entry point`);
  assert(!/VIRTUAL_MAP_TABLE\s*\+\s*i\s*\*\s*16/.test(source),
    `${relative} must not revive the legacy sparse-map record walk`);
  assert(!/(?:addr|pointer|ptr|esp|ebp|slot|prev)\s*-\s*imageBase\s*\+\s*(?:[_A-Za-z0-9.]+\.)?GUEST_BASE/.test(source),
    `${relative} must not carry a private affine guest-pointer formula`);
}

assert(hasPageScript('lib/mem-utils.js'),
  'the page must load mem-utils before runtime consumers');
assert(hasWorkerScript('mem-utils.js'),
  'the guest Worker must load mem-utils before runtime consumers');
assert(workerScripts.indexOf('mem-utils.js') < workerScripts.indexOf('dll-loader.js'),
  'the guest Worker must load mem-utils before dll-loader');

// mem-utils is a classic script in both Window and Worker contexts. A context
// with no `window` models importScripts(): the API must still become global.
const workerGlobal = vm.createContext({
  RegionMap: require('../lib/region-map.generated'),
  Uint8Array, Uint32Array, DataView, ArrayBuffer, SharedArrayBuffer,
  Atomics, WeakMap,
});
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'lib/mem-utils.js'), 'utf8'), workerGlobal);
assert.strictEqual(typeof workerGlobal.memUtils.guestToWasm, 'function',
  'importScripts must expose the same mem-utils API as the browser page');

console.log('JS guest translation consistency tests passed');
