#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { APPS } = require('../lib/apps');
const { orderDllInitializers } = require('../lib/dll-loader');

function put32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function peImporting(name) {
  const bytes = new Uint8Array(0x400);
  put32(bytes, 0x3c, 0x80);
  put32(bytes, 0x80, 0x00004550);
  bytes[0x86] = 1; // one section
  bytes[0x94] = 0xe0; // PE32 optional-header size
  put32(bytes, 0x80 + 128, name ? 0x1000 : 0);
  const section = 0x80 + 24 + 0xe0;
  put32(bytes, section + 12, 0x1000);
  put32(bytes, section + 16, 0x200);
  put32(bytes, section + 20, 0x200);
  if (name) {
    put32(bytes, 0x200 + 12, 0x1080);
    for (let i = 0; i < name.length; i++) bytes[0x280 + i] = name.charCodeAt(i);
  }
  return bytes;
}

const fixtureDlls = [
  { name: 'top.dll', bytes: peImporting('middle.dll') },
  { name: 'middle.dll', bytes: peImporting('base.dll') },
  { name: 'base.dll', bytes: peImporting(null) },
];
const fixtureResults = fixtureDlls.map((dll, i) => ({ name: dll.name, loadAddr: i + 1 }));
assert.deepStrictEqual(
  orderDllInitializers(fixtureDlls, fixtureResults).map(result => result.name),
  ['base.dll', 'middle.dll', 'top.dll']);

// When the pinned local payload is available, lock in the graph that exposed
// this bug: Storm initializes before Fog, and both before every D2 consumer.
const root = path.join(__dirname, '..');
const d2Paths = APPS.diablo2_demo.dlls.map(file => path.join(root, file));
if (d2Paths.every(file => fs.existsSync(file))) {
  const dlls = d2Paths.map(file => ({ name: path.basename(file), bytes: fs.readFileSync(file) }));
  const results = dlls.map((dll, i) => ({ name: dll.name, loadAddr: i + 1 }));
  const order = orderDllInitializers(dlls, results).map(result => result.name.toLowerCase());
  const before = (dependency, consumer) => assert(order.indexOf(dependency) < order.indexOf(consumer),
    `${dependency} must initialize before ${consumer}: ${order.join(', ')}`);
  before('storm.dll', 'fog.dll');
  before('storm.dll', 'd2cmp.dll');
  before('fog.dll', 'd2cmp.dll');
  before('d2gfx.dll', 'd2sound.dll');
  before('d2cmp.dll', 'd2win.dll');
}

console.log('test-dll-init-order: PASS');
