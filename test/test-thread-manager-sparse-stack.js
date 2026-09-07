#!/usr/bin/env node
'use strict';

// Safari private browsing cannot use the guest-Worker backend, so CreateThread
// falls back to ThreadManager's cooperative WASM instances. Late allocations
// can live in the sparse high guest arena and must be translated by WAT rather
// than treated as image-relative addresses.

const assert = require('assert');
const { ThreadManager } = require('../lib/thread-manager');
// $GUEST_BASE, from the map declared in src/00-regions.wat.
const RegionMap = require('../lib/region-map.generated.js');

async function main() {
  const memory = new WebAssembly.Memory({ initial: 2048, maximum: 2048, shared: true });
  const sparseBase = 0x40000000;
  const sparseWasmBase = 0x00100000;
  let nextGuest = sparseBase;
  const guestToWasm = addr => sparseWasmBase + ((addr >>> 0) - sparseBase);
  const mainExports = {
    get_sync_table: () => 0,
    get_heap_ptr: () => 0,
    set_heap_ptr: () => {},
    get_image_base: () => 0x00400000,
    get_code_start: () => 0x00400000,
    get_code_end: () => 0x00600000,
    get_thunk_base: () => 0x07500000,
    get_thunk_end: () => 0x07501000,
    get_num_thunks: () => 1,
    get_rsrc_rva: () => 0,
    guest_alloc: size => {
      const result = nextGuest;
      nextGuest = (nextGuest + (size >>> 0)) >>> 0;
      return result;
    },
    guest_to_wasm: guestToWasm,
  };
  assert(RegionMap.g2w(sparseBase, mainExports.get_image_base()) >= memory.buffer.byteLength,
    'fixture must put the obsolete image-relative view outside linear memory');
  const fakeThread = {
    esp: 0,
    eip: 0,
    fsBase: 0,
    tlsSlots: 0,
    exports: {
      init_thread: () => {},
      set_esp(value) { fakeThread.esp = value >>> 0; },
      guest_write32(addr, value) {
        new DataView(memory.buffer).setUint32(guestToWasm(addr), value >>> 0, true);
      },
      set_eip(value) { fakeThread.eip = value >>> 0; },
      set_hwnd_base: () => {},
      set_fs_base(value) { fakeThread.fsBase = value >>> 0; },
      set_tls_slots(value) { fakeThread.tlsSlots = value >>> 0; },
    },
  };
  const tm = new ThreadManager({}, memory, { exports: mainExports }, () => ({ host: {} }), {
    instantiateCooperative: () => fakeThread,
  });
  tm._log = () => {};
  const stackSize = 0x10000;
  new Uint8Array(memory.buffer, sparseWasmBase, stackSize + 0x200).fill(0xaa);
  const handle = tm.createThread(0x00401000, 0x12345678, stackSize, 0);

  await tm.spawnPending();

  assert.strictEqual(fakeThread.esp, sparseBase + stackSize - 8);
  assert.strictEqual(fakeThread.eip, 0x00401000);
  assert.strictEqual(fakeThread.fsBase, sparseBase + stackSize);
  assert.strictEqual(fakeThread.tlsSlots, sparseBase + stackSize + 0x30);
  const dv = new DataView(memory.buffer);
  assert.strictEqual(dv.getUint32(guestToWasm(sparseBase + stackSize - 4), true), 0x12345678);
  assert.strictEqual(dv.getUint32(guestToWasm(sparseBase + stackSize - 8), true), 0);
  assert.strictEqual(new Uint8Array(memory.buffer,
    guestToWasm(fakeThread.tlsSlots), 0x100).some(byte => byte !== 0), false);
  assert.strictEqual(tm.threads.get(handle).state, 'active');

  console.log('PASS cooperative ThreadManager initializes sparse high guest stacks and TLS');
}

main().catch(error => { console.error(error); process.exit(1); });
