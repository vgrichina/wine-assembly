#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat } = await bootRenderHarness();
  const hwnd = 0x10001;
  const barCount = 4;
  const childCount = 15;
  const childHeader = 4 + barCount * 16;
  const size = childHeader + 4 + childCount * 28;
  const blob = wat.guest_alloc(size) >>> 0;

  for (let offset = 0; offset < size; offset += 4) wat.guest_write32(blob + offset, 0);
  wat.guest_write32(blob, barCount);
  wat.guest_write32(blob + 4 + 2 * 16 + 8, childHeader);
  wat.guest_write32(blob + childHeader, childCount);
  for (let position = 0; position < childCount; position++) {
    const item = blob + childHeader + 4 + position * 28;
    wat.guest_write32(item + 16, position === 4 ? 4 : 0);
    wat.guest_write32(item + 20, 200 + position);
  }

  wat.test_wnd_table_set(hwnd, 0xffff0002);
  wat.menu_set_source_guest(hwnd, blob, size, 0x410134);
  assert.strictEqual(wat.menu_child_flags(hwnd, 2, 4) & 4, 4,
    'fixture starts with position 4 checked');
  assert.strictEqual(wat.menu_check_position_global(0x30134, 4, 0), 8,
    'unchecking by position returns the old checked state');
  assert.strictEqual(wat.menu_child_flags(hwnd, 2, 4) & 4, 0,
    'old position is unchecked immediately');
  assert.strictEqual(wat.menu_check_position_global(0x30134, 3, 8), 0,
    'checking by position returns the old unchecked state');
  assert.strictEqual(wat.menu_child_flags(hwnd, 2, 4) & 4, 0,
    'old position is unchecked');
  assert.strictEqual(wat.menu_child_flags(hwnd, 2, 3) & 4, 4,
    'new position is checked');

  console.log('PASS CheckMenuItem MF_BYPOSITION updates a resource-menu blob');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
