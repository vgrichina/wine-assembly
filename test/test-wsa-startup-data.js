#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWatSnapshot } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');

async function main() {
  const wasm = await compileWatSnapshot(file =>
    fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8'));
  const memory = new WebAssembly.Memory({
    initial: 8192, maximum: 8192, shared: true,
  });
  const ctx = {
    exports: null,
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: {},
  };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  const module = await WebAssembly.compile(wasm);
  for (const entry of WebAssembly.Module.imports(module)) {
    imports[entry.module] = imports[entry.module] || {};
    if (entry.kind === 'function' &&
        typeof imports[entry.module][entry.name] !== 'function') {
      imports[entry.module][entry.name] = () => 0;
    }
  }
  const instance = await WebAssembly.instantiate(module, imports);
  ctx.exports = instance.exports;
  const e = instance.exports;
  const imageBase = e.get_image_base() >>> 0;
  const wsadata = e.guest_alloc(400) >>> 0;
  const wa = wsadata - imageBase + 0x12000;
  const bytes = new Uint8Array(memory.buffer, wa, 400);
  const dv = new DataView(memory.buffer, wa, 400);

  bytes.fill(0xa5);
  assert.strictEqual(e.test_call_WSAStartup(0x0101, wsadata), 0);
  assert.strictEqual(dv.getUint16(0, true), 0x0101,
    'WSAStartup negotiates the requested WinSock 1.1 version');
  assert.strictEqual(dv.getUint16(2, true), 0x0202,
    'WSAStartup advertises the provider high version');
  assert.strictEqual(dv.getUint16(390, true), 64,
    'WSADATA.iMaxSockets reports the real 64-entry virtual socket table');
  assert(dv.getUint16(390, true) > 12,
    'Half-Life Uplink socket-capacity check accepts the provider');
  assert.strictEqual(dv.getUint16(392, true), 0,
    'WSADATA.iMaxUdpDg is zero because the provider exposes no UDP transport');
  assert.strictEqual(dv.getUint32(396, true), 0,
    'WSADATA.lpVendorInfo is NULL');
  assert.strictEqual(bytes[4], 0,
    'WSADATA description storage is initialized');
  assert.strictEqual(bytes[389], 0,
    'WSADATA system-status storage is NUL-terminated');
  assert.strictEqual(bytes[394], 0,
    'WSADATA alignment padding is initialized');

  console.log('PASS WSAStartup fills Win32 WSADATA capacity and provider fields');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
