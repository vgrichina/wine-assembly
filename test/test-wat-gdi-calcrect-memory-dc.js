#!/usr/bin/env node
'use strict';

// Win98 permits DrawText(DT_CALCRECT) on a compatible memory DC before any
// bitmap is selected. MW3 depends on this ordering to size its caption DIBs.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
// $GUEST_BASE, from the map declared in src/00-regions.wat.
const RegionMap = require('../lib/region-map.generated.js');

(async () => {
  const { exports: wat, memory } = await bootRenderHarness();
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => RegionMap.g2w(guest, imageBase);
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const writeWide = value => {
    const pointer = allocZero((value.length + 1) * 2);
    [...value].forEach((character, index) =>
      wat.guest_write16(pointer + index * 2, character.charCodeAt(0)));
    return pointer;
  };

  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(hdc, 'CreateCompatibleDC must allocate a font-only memory DC');
  const font = wat.test_call_CreateFontW(-20, 500, 0, writeWide('Arial')) >>> 0;
  assert(font, 'CreateFont must allocate the MW3-shaped scalable font');
  wat.test_call_SelectObject(hdc, font);

  const text = allocZero(64);
  bytes.set(Buffer.from('I N S T A N T   A C T I O N\0', 'latin1'), wa(text));
  const rect = allocZero(16); // MW3 starts with an empty RECT.

  const height = wat.test_call_DrawTextA(hdc, text, -1, rect, 0x400);
  const measured = [0, 4, 8, 12].map(offset => wat.guest_read32(rect + offset) | 0);
  assert(height > 0, 'DT_CALCRECT must succeed without a selected bitmap');
  assert.deepStrictEqual(measured.slice(0, 2), [0, 0]);
  assert(measured[2] > 0 && measured[3] === height,
    `font-only CALCRECT must publish non-empty bounds, got ${measured}`);

  const drawRect = allocZero(16);
  wat.guest_write32(drawRect + 8, 320);
  wat.guest_write32(drawRect + 12, 40);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, text, -1, drawRect, 0), 0,
    'ordinary drawing still requires a selected destination bitmap');

  console.log('PASS  font-only compatible DC supports DT_CALCRECT before DIB allocation');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
