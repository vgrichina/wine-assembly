'use strict';

const assert = require('assert');
const { readStrW } = require('../lib/mem-utils');

const SharedBuffer = global.SharedArrayBuffer;
if (typeof SharedBuffer === 'undefined') {
  console.log('SKIP  SharedArrayBuffer unavailable');
  process.exit(0);
}

const buffer = new SharedBuffer(16);
const view = new DataView(buffer);
view.setUint16(2, 'D'.charCodeAt(0), true);
view.setUint16(4, 'X'.charCodeAt(0), true);
view.setUint16(6, 0, true);

// Recreate a non-isolated Chrome page: the existing WASM shared buffer remains
// usable, but the constructor is hidden from page JavaScript.
try {
  global.SharedArrayBuffer = undefined;
  assert.strictEqual(readStrW(buffer, 2), 'DX');
} finally {
  global.SharedArrayBuffer = SharedBuffer;
}

assert.strictEqual(readStrW(new Uint8Array(buffer), 2), 'DX',
  'typed-array views still normalize through their backing buffer');
console.log('PASS  readStrW accepts a WASM shared buffer when its constructor is hidden');
