#!/usr/bin/env node

// Stock pens and brushes must round-trip through SelectObject without being
// confused with the default 1x1 bitmap. Paint saves and restores NULL_PEN and
// NULL_BRUSH around shape previews, so a wrong previous handle detaches its
// memory DC from the document bitmap.

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

const memory = new ArrayBuffer(64 * 1024);
const { host, gdi } = createHostImports({
  getMemory: () => memory,
  exports: {},
});

const dc = host.gdi_create_compat_dc(0);
const bitmap = host.gdi_create_bitmap(32, 24, 32, 0);
const dcState = gdi._dcState[dc];

assert.strictEqual(host.gdi_select_object(dc, bitmap), 0x30007,
  'first bitmap selection should return the default bitmap sentinel');
assert.strictEqual(dcState.selectedBitmap, bitmap);

const previousPen = host.gdi_select_object(dc, 0x30018); // NULL_PEN
assert.strictEqual(previousPen, 0x30017, 'NULL_PEN should replace BLACK_PEN');
assert.strictEqual(dcState.selectedBitmap, bitmap,
  'selecting NULL_PEN must preserve the document bitmap');
assert.strictEqual(host.gdi_select_object(dc, previousPen), 0x30018,
  'restoring BLACK_PEN should return NULL_PEN');
assert.strictEqual(dcState.selectedBitmap, bitmap,
  'restoring a stock pen must preserve the document bitmap');

const previousBrush = host.gdi_select_object(dc, 0x30015); // NULL_BRUSH
assert.strictEqual(previousBrush, 0x30010, 'NULL_BRUSH should replace WHITE_BRUSH');
assert.strictEqual(dcState.selectedBitmap, bitmap,
  'selecting NULL_BRUSH must preserve the document bitmap');
assert.strictEqual(host.gdi_select_object(dc, previousBrush), 0x30015,
  'restoring WHITE_BRUSH should return NULL_BRUSH');
assert.strictEqual(dcState.selectedBitmap, bitmap,
  'restoring a stock brush must preserve the document bitmap');

assert.strictEqual(host.gdi_get_current_object(dc, 1), 0x30017,
  'OBJ_PEN should report BLACK_PEN after restore');
assert.strictEqual(host.gdi_get_current_object(dc, 2), 0x30010,
  'OBJ_BRUSH should report WHITE_BRUSH after restore');
assert.strictEqual(host.gdi_get_current_object(dc, 7), bitmap,
  'OBJ_BITMAP should still report the document bitmap');

assert.strictEqual(host.gdi_select_object(dc, 0x30007), bitmap,
  'restoring the default bitmap should return the document bitmap');
assert.strictEqual(dcState.selectedBitmap, 0x30007,
  'restoring the default bitmap should detach the document bitmap');

console.log('PASS  stock objects round-trip without losing the memory-DC bitmap');
