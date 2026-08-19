#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, memory } = await bootRenderHarness();
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  let passed = 0;

  const check = (name, fn) => {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  };
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const read16 = pointer => bytes[wa(pointer)] | (bytes[wa(pointer) + 1] << 8);
  const createPalette = entries => {
    const logical = allocZero(4 + entries.length * 4);
    wat.guest_write16(logical, 0x0300);
    wat.guest_write16(logical + 2, entries.length);
    entries.forEach((entry, index) => wat.guest_write32(logical + 4 + index * 4, entry));
    return wat.test_call_CreatePalette(logical) >>> 0;
  };
  const createSurface = () => {
    const bmi = allocZero(40);
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, 2);
    wat.guest_write32(bmi + 8, -2);
    wat.guest_write16(bmi + 12, 1);
    wat.guest_write16(bmi + 14, 32);
    const bitsOut = allocZero(4);
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert(bitmap && hdc);
    wat.test_call_SelectObject(hdc, bitmap);
    return { bitmap, hdc };
  };

  check('graphics and system-palette modes validate and survive SaveDC', () => {
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert.strictEqual(wat.test_call_GetGraphicsMode(hdc), 1);
    assert.strictEqual(wat.test_call_GetSystemPaletteUse(hdc), 1);
    assert.strictEqual(wat.test_call_SetGraphicsMode(hdc, 2), 1);
    assert.strictEqual(wat.test_call_SetSystemPaletteUse(hdc, 2), 1);
    const level = wat.test_call_SaveDC(hdc);
    assert.strictEqual(level, 1);
    assert.strictEqual(wat.test_call_SetGraphicsMode(hdc, 1), 2);
    assert.strictEqual(wat.test_call_SetSystemPaletteUse(hdc, 3), 2);
    assert.strictEqual(wat.test_call_SetGraphicsMode(hdc, 3), 0);
    assert.strictEqual(wat.test_call_SetSystemPaletteUse(hdc, 4), 0);
    assert.strictEqual(wat.test_call_RestoreDC(hdc, -1), 1);
    assert.strictEqual(wat.test_call_GetGraphicsMode(hdc), 2);
    assert.strictEqual(wat.test_call_GetSystemPaletteUse(hdc), 2);
  });

  check('AnimatePalette changes only PC_RESERVED entries', () => {
    const palette = createPalette([0x01010203, 0x00040506, 0x01070809]);
    const replacement = allocZero(12);
    wat.guest_write32(replacement, 0x00AABBCC);
    wat.guest_write32(replacement + 4, 0x00112233);
    wat.guest_write32(replacement + 8, 0x00445566);
    assert.strictEqual(wat.test_call_AnimatePalette(palette, 0, 3, replacement), 1);
    const output = allocZero(12);
    assert.strictEqual(wat.test_call_GetPaletteEntries(palette, 0, 3, output), 3);
    assert.deepStrictEqual([
      wat.guest_read32(output) >>> 0,
      wat.guest_read32(output + 4) >>> 0,
      wat.guest_read32(output + 8) >>> 0,
    ], [0x01AABBCC, 0x00040506, 0x01445566]);
  });

  check('GdiSetBatchLimit returns previous limit and zero restores default', () => {
    assert.strictEqual(wat.test_call_GdiSetBatchLimit(8), 310);
    assert.strictEqual(wat.test_call_GdiSetBatchLimit(1), 8);
    assert.strictEqual(wat.test_call_GdiSetBatchLimit(0), 1);
    assert.strictEqual(wat.test_call_GdiSetBatchLimit(310), 310);
  });

  check('device gamma ramp defaults to identity and round-trips canonical bytes', () => {
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const identity = allocZero(1536);
    assert.strictEqual(wat.test_call_GetDeviceGammaRamp(hdc, identity), 1);
    for (const index of [0, 1, 127, 255]) {
      const expected = index * 257;
      assert.strictEqual(read16(identity + index * 2), expected);
      assert.strictEqual(read16(identity + 512 + index * 2), expected);
      assert.strictEqual(read16(identity + 1024 + index * 2), expected);
    }
    const ramp = allocZero(1536);
    for (let offset = 0; offset < 1536; offset++) bytes[wa(ramp) + offset] = (offset * 17) & 0xff;
    assert.strictEqual(wat.test_call_SetDeviceGammaRamp(hdc, ramp), 1);
    const output = allocZero(1536);
    assert.strictEqual(wat.test_call_GetDeviceGammaRamp(hdc, output), 1);
    assert.deepStrictEqual(
      Array.from(bytes.subarray(wa(output), wa(output) + 1536)),
      Array.from(bytes.subarray(wa(ramp), wa(ramp) + 1536)));
  });

  check('software pixel format is described, chosen, set once, and swapped', () => {
    const { bitmap, hdc } = createSurface();
    const requested = allocZero(40);
    wat.guest_write16(requested, 40);
    wat.guest_write16(requested + 2, 1);
    wat.guest_write32(requested + 4, 0x25);
    assert.strictEqual(wat.test_call_ChoosePixelFormat(hdc, requested), 1);
    const described = allocZero(40);
    assert.strictEqual(wat.test_call_DescribePixelFormat(hdc, 1, 40, described), 1);
    assert.strictEqual(read16(described), 40);
    assert.strictEqual(read16(described + 2), 1);
    assert.strictEqual(wat.guest_read32(described + 4) >>> 0, 0x25);
    assert.strictEqual(bytes[wa(described) + 9], 32);
    assert.strictEqual(bytes[wa(described) + 23], 24);
    assert.strictEqual(bytes[wa(described) + 24], 8);
    assert.strictEqual(wat.test_call_GetPixelFormat(hdc), 0);
    assert.strictEqual(wat.test_call_SetPixelFormat(hdc, 1, requested), 1);
    assert.strictEqual(wat.test_call_GetPixelFormat(hdc), 1);
    assert.strictEqual(wat.test_call_SetPixelFormat(hdc, 1, requested), 0);
    assert.strictEqual(wat.test_call_SwapBuffers(hdc), 1);
    wat.test_call_DeleteObject(bitmap);
    wat.test_call_DeleteDC(hdc);
  });

  console.log(`\n${passed}/${passed} checks passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
