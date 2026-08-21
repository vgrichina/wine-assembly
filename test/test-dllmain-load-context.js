#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { callDllMain } = require('../lib/dll-loader');

function captureDllMainArgs(options) {
  const memory = new WebAssembly.Memory({ initial: 128 });
  const dv = new DataView(memory.buffer);
  const imageBase = 0x00400000;
  const savedEsp = 0x00420000;
  const g2w = guest => guest - imageBase + 0x12000;
  let captured;
  const e = {
    memory,
    get_image_base: () => imageBase,
    get_eip: () => 0x00401000,
    get_esp: () => savedEsp,
    get_fs_base: () => 0,
    get_eax: () => 1,
    set_eip: value => { e.eip = value >>> 0; },
    set_esp: value => { e.esp = value >>> 0; },
    run: () => {
      captured = [0, 4, 8, 12].map(offset =>
        dv.getUint32(g2w(e.esp + offset), true) >>> 0);
      e.eip = 0;
    },
  };

  callDllMain(e, 0x0069d000, 0x006c0aa0, null, options);
  return captured;
}

assert.deepStrictEqual(captureDllMainArgs({ lpReserved: 1 }),
  [0, 0x0069d000, 1, 1],
  'static startup DLLs must receive non-NULL lpReserved');
assert.deepStrictEqual(captureDllMainArgs(),
  [0, 0x0069d000, 1, 0],
  'dynamic LoadLibrary DLLs must receive NULL lpReserved');
assert.deepStrictEqual(captureDllMainArgs(1234),
  [0, 0x0069d000, 1, 0],
  'legacy numeric maxBlocks calls must remain dynamic-load compatible');

console.log('PASS  DllMain receives the Windows static/dynamic load context');
