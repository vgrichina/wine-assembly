#!/usr/bin/env node
'use strict';

// Decoder regression for canonical `[esp+disp]` load runs. ESP needs a SIB
// byte even when it has no index; the H408 executor already supports base=ESP,
// so this test proves the raw look-ahead recognizes that spelling without
// admitting indexed SIB operands.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ fonts: 'none' });
  const fixture = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE loads');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const imageWa = ga => (ga - imageBase + guestBase) >>> 0;
  const dv = new DataView(memory.buffer);
  const codeBase = (imageBase + 0x1800) >>> 0;
  const stack = (imageBase + 0xd00000) >>> 0;
  let slot = 0;

  function handlerCount(id) {
    return new Uint32Array(memory.buffer)[(e.get_handler_hist_base() >>> 2) + id] >>> 0;
  }

  function run(code, setup) {
    const ga = (codeBase + slot++ * 0x100) >>> 0;
    bytes.set(code, imageWa(ga));
    setup();
    e.reset_handler_hist();
    e.set_handler_hist_enabled(1);
    e.set_eip(ga);
    e.run(1000);
    e.set_handler_hist_enabled(0);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'probe returns to sentinel');
  }

  // disp8, no displacement, and disp32 forms all share one H408 execution.
  run(Uint8Array.from([
    0x8b, 0x44, 0x24, 0x04,                         // mov eax,[esp+4]
    0x8b, 0x0c, 0x24,                               // mov ecx,[esp]
    0x8b, 0x94, 0x24, 0x0c, 0x00, 0x00, 0x00,       // mov edx,[esp+0xc]
    0xc3,
  ]), () => {
    e.set_esp(stack);
    dv.setUint32(imageWa(stack), 0, true);
    dv.setUint32(imageWa(stack + 4), 0x11223344, true);
    dv.setUint32(imageWa(stack + 12), 0x55667788, true);
  });
  assert.strictEqual(e.get_eax() >>> 0, 0x11223344, 'disp8 load');
  assert.strictEqual(e.get_ecx() >>> 0, 0, 'no-displacement load');
  assert.strictEqual(e.get_edx() >>> 0, 0x55667788, 'disp32 load');
  assert.strictEqual(handlerCount(408), 1, 'three ESP loads execute as one H408 run');
  assert.strictEqual(handlerCount(343), 0, 'ordinary ESP load handler is replaced');

  // A write to ESP may be the final element: H408 snapshots the old base and
  // publishes the new stack pointer only after every address has been read.
  const nextStack = (stack + 0x100) >>> 0;
  run(Uint8Array.from([
    0x8b, 0x44, 0x24, 0x04,                         // mov eax,[esp+4]
    0x8b, 0x64, 0x24, 0x08,                         // mov esp,[esp+8]
    0xc3,
  ]), () => {
    e.set_esp(stack);
    dv.setUint32(imageWa(stack), 0, true);
    dv.setUint32(imageWa(stack + 4), 0xaabbccdd, true);
    dv.setUint32(imageWa(stack + 8), nextStack, true);
    dv.setUint32(imageWa(nextStack), 0, true);
  });
  assert.strictEqual(e.get_eax() >>> 0, 0xaabbccdd, 'old ESP supplies every fused address');
  assert.strictEqual(e.get_esp() >>> 0, (nextStack + 4) >>> 0, 'last load may replace ESP before RET');
  assert.strictEqual(handlerCount(408), 1, 'base-clobbering final element remains fused');

  // The same ModRM rm=4 with a real index is not `[esp+disp]` and must decline.
  run(Uint8Array.from([
    0x8b, 0x54, 0x24, 0x04,                         // mov edx,[esp+4]
    0x8b, 0x4c, 0x04, 0x08,                         // mov ecx,[esp+eax+8]
    0xc3,
  ]), () => {
    e.set_eax(0);
    e.set_esp(stack);
    dv.setUint32(imageWa(stack), 0, true);
    dv.setUint32(imageWa(stack + 4), 0x12345678, true);
    dv.setUint32(imageWa(stack + 8), 0x89abcdef, true);
  });
  assert.strictEqual(e.get_edx() >>> 0, 0x12345678, 'near-miss first load');
  assert.strictEqual(e.get_ecx() >>> 0, 0x89abcdef, 'indexed SIB retains ordinary semantics');
  assert.strictEqual(handlerCount(408), 0, 'indexed SIB near miss does not enter H408');
  assert.strictEqual(handlerCount(343), 1, 'first canonical load remains ordinary after decline');

  console.log('PASS H408 canonical ESP load runs: disp forms, final base write, indexed-SIB decline');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
