#!/usr/bin/env node
const assert = require('assert');
const { createStorageImports, setIniValue, setRegValue } = require('../lib/storage');
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
const enumNameGA = IMAGE_BASE + 0x1900;
const enumNameLenGA = IMAGE_BASE + 0x1A00;
const enumTypeGA = IMAGE_BASE + 0x1B00;
const enumDataGA = IMAGE_BASE + 0x1C00;
const enumDataLenGA = IMAGE_BASE + 0x1D00;
const infoSubCountGA = IMAGE_BASE + 0x1E00;
const infoMaxSubKeyGA = IMAGE_BASE + 0x1E10;
const infoValueCountGA = IMAGE_BASE + 0x1E20;
const infoMaxValueNameGA = IMAGE_BASE + 0x1E30;
const infoMaxValueDataGA = IMAGE_BASE + 0x1E40;

writeGuestString(subKeyGA, 'Software\\WineAssemblyTest');
writeGuestString(valueNameGA, 'PlayerName');
writeGuestString(valueGA, 'Ada');

assert.strictEqual(storage.reg_create_key(0x80000001, g2w(subKeyGA, IMAGE_BASE), phkGA, 0), 0);
const hKey = readGuestU32(phkGA);
assert(hKey, 'reg_create_key should write a handle');

assert.strictEqual(storage.reg_set_value(hKey, g2w(valueNameGA, IMAGE_BASE), 1, valueGA, 4, 0), 0);
writeGuestU32(cbGA, 0);
assert.strictEqual(storage.reg_query_value(hKey, g2w(valueNameGA, IMAGE_BASE), 0, 0, cbGA, 0), 0);
assert.strictEqual(readGuestU32(cbGA), 4);

const rootHKey = storage.reg_open_key(0x80000001, 0, 0);
assert(rootHKey, 'predefined registry roots should open without a materialized root record');
writeGuestU32(enumNameLenGA, 64);
writeGuestU32(enumDataLenGA, 64);
assert.strictEqual(storage.reg_enum_value(
  hKey, 0, enumNameGA, enumNameLenGA, enumTypeGA, enumDataGA, enumDataLenGA, 0
), 0);
assert.strictEqual(readStrA(memory, g2w(enumNameGA, IMAGE_BASE)), 'PlayerName');
assert.strictEqual(readGuestU32(enumNameLenGA), 'PlayerName'.length);
assert.strictEqual(readGuestU32(enumTypeGA), 1);
assert.strictEqual(readStrA(memory, g2w(enumDataGA, IMAGE_BASE)), 'Ada');
assert.strictEqual(readGuestU32(enumDataLenGA), 4);
assert.strictEqual(storage.reg_query_info(
  hKey,
  infoSubCountGA,
  infoMaxSubKeyGA,
  infoValueCountGA,
  infoMaxValueNameGA,
  infoMaxValueDataGA,
  0
), 0);
assert.strictEqual(readGuestU32(infoSubCountGA), 0);
assert.strictEqual(readGuestU32(infoMaxSubKeyGA), 0);
assert.strictEqual(readGuestU32(infoValueCountGA), 1);
assert.strictEqual(readGuestU32(infoMaxValueNameGA), 'PlayerName'.length);
assert.strictEqual(readGuestU32(infoMaxValueDataGA), 4);

writeGuestU32(enumNameLenGA, 64);
assert.strictEqual(storage.reg_enum_key(0x80000002, 0, enumNameGA, 64, 0), 0);
assert.strictEqual(readStrA(memory, g2w(enumNameGA, IMAGE_BASE)).toLowerCase(), 'software');
writeGuestU32(cbGA, 32);
assert.strictEqual(storage.reg_query_value(hKey, g2w(valueNameGA, IMAGE_BASE), 0, outGA, cbGA, 0), 0);
assert.strictEqual(readStrA(memory, g2w(outGA, IMAGE_BASE)), 'Ada');
assert.strictEqual(readGuestU32(cbGA), 4);

setRegValue('HKCU\\ParentMaterialize\\Child\\Leaf', 'Enabled', 4, 7);
writeGuestString(subKeyGA, 'ParentMaterialize');
assert(storage.reg_open_key(0x80000001, g2w(subKeyGA, IMAGE_BASE), 0), 'setRegValue should create top-level parent registry keys');
writeGuestString(subKeyGA, 'ParentMaterialize\\Child\\Leaf');
const leafHKey = storage.reg_open_key(0x80000001, g2w(subKeyGA, IMAGE_BASE), 0);
assert(leafHKey, 'setRegValue should create parent registry keys so RegOpenKey can reach the leaf');
writeGuestString(valueNameGA, 'Enabled');
writeGuestU32(cbGA, 4);
assert.strictEqual(storage.reg_query_value(leafHKey, g2w(valueNameGA, IMAGE_BASE), 0, valueGA, cbGA, 0), 0);
assert.strictEqual(readGuestU32(valueGA), 7);

const iniSectionGA = IMAGE_BASE + 0x1600;
const iniKeyGA = IMAGE_BASE + 0x1700;
const iniFileGA = IMAGE_BASE + 0x1800;
writeGuestString(iniSectionGA, 'intl');
writeGuestString(iniKeyGA, 'iCDateCount');
writeGuestString(iniFileGA, 'win.ini');
setIniValue('win.ini', 'intl', 'iCDateCount', -1);
assert.strictEqual(
  storage.ini_get_int(
    g2w(iniSectionGA, IMAGE_BASE),
    g2w(iniKeyGA, IMAGE_BASE),
    0,
    g2w(iniFileGA, IMAGE_BASE),
    0
  ),
  -1,
  'setIniValue should seed app startup INI values'
);

console.log('PASS  registry REG_SZ stores guest strings through g2w');
console.log('PASS  setRegValue materializes parent registry keys');
console.log('PASS  registry roots, subkeys, and values enumerate with Win32 buffer semantics');
console.log('PASS  RegQueryInfoKey-style registry metadata reports counts and max lengths');
console.log('PASS  app startup INI values are visible to profile APIs');
