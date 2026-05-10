#!/usr/bin/env node
const assert = require('assert');
const { createStorageImports } = require('../lib/storage');
const { g2w, readStrA } = require('../lib/mem-utils');

const IMAGE_BASE = 0x400000;
const memory = new ArrayBuffer(0x20000);
const mem = new Uint8Array(memory);
const dv = new DataView(memory);
const ctx = {
  getMemory: () => memory,
  exports: {
    get_image_base: () => IMAGE_BASE,
  },
};
const storage = createStorageImports(ctx);

function writeGuestString(guestAddr, value) {
  const wa = g2w(guestAddr, IMAGE_BASE);
  for (let i = 0; i < value.length; i++) mem[wa + i] = value.charCodeAt(i);
  mem[wa + value.length] = 0;
}

function writeGuestU32(guestAddr, value) {
  dv.setUint32(g2w(guestAddr, IMAGE_BASE), value >>> 0, true);
}

function readGuestU32(guestAddr) {
  return dv.getUint32(g2w(guestAddr, IMAGE_BASE), true);
}

const subKeyGA = IMAGE_BASE + 0x1000;
const valueNameGA = IMAGE_BASE + 0x1100;
const valueGA = IMAGE_BASE + 0x1200;
const outGA = IMAGE_BASE + 0x1300;
const cbGA = IMAGE_BASE + 0x1400;
const phkGA = IMAGE_BASE + 0x1500;

writeGuestString(subKeyGA, 'Software\\WineAssemblyTest');
writeGuestString(valueNameGA, 'PlayerName');
writeGuestString(valueGA, 'Ada');

assert.strictEqual(storage.reg_create_key(0x80000001, g2w(subKeyGA, IMAGE_BASE), phkGA, 0), 0);
const hKey = readGuestU32(phkGA);
assert(hKey, 'reg_create_key should write a handle');

assert.strictEqual(storage.reg_set_value(hKey, g2w(valueNameGA, IMAGE_BASE), 1, valueGA, 4, 0), 0);
writeGuestU32(cbGA, 32);
assert.strictEqual(storage.reg_query_value(hKey, g2w(valueNameGA, IMAGE_BASE), 0, outGA, cbGA, 0), 0);
assert.strictEqual(readStrA(memory, g2w(outGA, IMAGE_BASE)), 'Ada');
assert.strictEqual(readGuestU32(cbGA), 4);

console.log('PASS  registry REG_SZ stores guest strings through g2w');
