#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_spi_nonclient")
      (param $ui_param i32) (param $buffer i32) (param $wide i32) (result i32)
    (call $spi_core (i32.const 0x29) (local.get $ui_param)
      (local.get $buffer) (i32.const 0) (local.get $wide)))
`;

(async () => {
  const { exports: wat, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const allocFilled = (size, value = 0x2f) => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(value, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const read32 = pointer => view.getUint32(wa(pointer), true) >>> 0;
  const write32 = (pointer, value) => view.setUint32(wa(pointer), value >>> 0, true);

  const ansiSize = 340;
  const ansi = allocFilled(ansiSize + 8);
  write32(ansi, ansiSize);
  assert.strictEqual(wat.test_spi_nonclient(0, ansi, 0), 1,
    'Win9x uiParam=0 must use NONCLIENTMETRICSA.cbSize');
  assert.strictEqual(read32(ansi), ansiSize, 'ANSI cbSize is preserved');
  for (const offset of [24, 92, 160, 220, 280]) {
    assert.strictEqual(read32(ansi + offset + 4), 0,
      `LOGFONTA lfWidth at ${offset} must be initialized`);
    assert.strictEqual(bytes[wa(ansi + offset + 20)], 0,
      `LOGFONTA lfItalic at ${offset} must be initialized`);
    assert.strictEqual(bytes[wa(ansi + offset + 28 + 'MS Sans Serif'.length)], 0,
      `LOGFONTA face at ${offset} must be terminated`);
  }
  assert.deepStrictEqual(Array.from(bytes.slice(wa(ansi + ansiSize), wa(ansi + ansiSize + 8))),
    Array(8).fill(0x2f), 'ANSI fill must not overwrite the caller tail');

  const wideSize = 500;
  const wide = allocFilled(wideSize + 8);
  write32(wide, wideSize);
  assert.strictEqual(wat.test_spi_nonclient(0, wide, 1), 1,
    'Win9x uiParam=0 must use NONCLIENTMETRICSW.cbSize');
  assert.strictEqual(read32(wide), wideSize, 'wide cbSize is preserved');
  for (const offset of [24, 124, 224, 316, 408]) {
    assert.strictEqual(read32(wide + offset + 4), 0,
      `LOGFONTW lfWidth at ${offset} must be initialized`);
    assert.strictEqual(bytes[wa(wide + offset + 20)], 0,
      `LOGFONTW lfItalic at ${offset} must be initialized`);
    const terminator = wide + offset + 28 + 'MS Sans Serif'.length * 2;
    assert.strictEqual(bytes[wa(terminator)] | bytes[wa(terminator + 1)], 0,
      `LOGFONTW face at ${offset} must be terminated`);
  }
  assert.deepStrictEqual(Array.from(bytes.slice(wa(wide + wideSize), wa(wide + wideSize + 8))),
    Array(8).fill(0x2f), 'wide fill must not overwrite the caller tail');

  const short = allocFilled(ansiSize);
  write32(short, ansiSize - 1);
  assert.strictEqual(wat.test_spi_nonclient(0, short, 0), 0,
    'an undersized declared layout must fail atomically');
  assert.strictEqual(read32(short), ansiSize - 1,
    'failed sizing must leave the caller buffer untouched');

  const explicit = allocFilled(ansiSize);
  write32(explicit, 0);
  assert.strictEqual(wat.test_spi_nonclient(ansiSize, explicit, 0), 1,
    'explicit uiParam sizing remains supported');
  assert.strictEqual(read32(explicit), ansiSize,
    'explicit uiParam becomes the returned cbSize');

  console.log('PASS SystemParametersInfo nonclient metrics honors Win9x cbSize');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
