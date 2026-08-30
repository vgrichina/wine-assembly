#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { callDllMain } = require('../lib/dll-loader');

function captureDllMainArgs(options, { sparseStack = false } = {}) {
  const memory = new WebAssembly.Memory({ initial: 128 });
  const dv = new DataView(memory.buffer);
  const imageBase = 0x00400000;
  const savedEsp = sparseStack ? 0x07500000 : 0x00420000;
  const contiguousG2w = guest => guest - imageBase + 0x12000;
  const sparseBase = 0x074ff000;
  const sparseWa = 0x00050000;
  const g2w = guest => sparseStack
    ? sparseWa + guest - sparseBase
    : contiguousG2w(guest);
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
  if (sparseStack) e.guest_to_wasm = g2w;

  callDllMain(e, 0x0069d000, 0x006c0aa0, null, options);
  return captured;
}

function captureSleepResume() {
  const memory = new WebAssembly.Memory({ initial: 128 });
  const imageBase = 0x00400000;
  const savedEsp = 0x00420000;
  let eip = 0x00401000;
  let esp = savedEsp;
  let runs = 0;
  let sleepPending = false;
  const e = {
    memory,
    get_image_base: () => imageBase,
    get_eip: () => eip,
    get_esp: () => esp,
    get_fs_base: () => 0,
    get_eax: () => 1,
    get_last_run_halt: () => sleepPending ? 3 : 2,
    get_sleep_yielded: () => {
      const value = sleepPending ? 1 : 0;
      sleepPending = false;
      return value;
    },
    set_eip: value => { eip = value >>> 0; },
    set_esp: value => { esp = value >>> 0; },
    run: () => {
      runs++;
      if (runs === 1) {
        sleepPending = true;
        eip = 0x006c0b10;
      } else {
        eip = 0;
      }
    },
  };

  callDllMain(e, 0x0069d000, 0x006c0aa0);
  return { runs, eip, esp };
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
assert.deepStrictEqual(captureDllMainArgs({ reason: 2 }),
  [0, 0x0069d000, 2, 0],
  'new worker threads must deliver DLL_THREAD_ATTACH before their start routine');
assert.deepStrictEqual(captureDllMainArgs({ reason: 2 }, { sparseStack: true }),
  [0, 0x0069d000, 2, 0],
  'DLL_THREAD_ATTACH must push onto a sparse worker stack through guest_to_wasm');
assert.deepStrictEqual(captureSleepResume(),
  { runs: 2, eip: 0x00401000, esp: 0x00420000 },
  'DllMain must resume after a cooperative Sleep before restoring caller state');

console.log('PASS  DllMain receives the Windows static/dynamic load context');
