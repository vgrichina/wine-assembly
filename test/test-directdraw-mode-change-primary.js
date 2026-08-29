#!/usr/bin/env node

// An app that changes display mode mid-run can end up owning two surfaces
// that both carry DDSCAPS_PRIMARYSURFACE. Liquid War opens a 16bpp primary,
// calls SetDisplayMode(640,480,8), creates the 8bpp primary it actually draws
// its menu into, and never releases the first one. Whoever stands in for "the
// display" -- the palette-driven re-present in IDirectDrawPalette::SetEntries
// is the one that bit us -- must pick the surface created most recently, not
// the lowest-numbered slot, or an all-zero stale primary gets flushed over
// the frame the live one just presented.

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const DX_OBJECTS = 0x07F60000;
const DX_ENTRY_SIZE = 32;

function makePrimary(dv, slot, bpp, bitsWa) {
  const entry = DX_OBJECTS + slot * DX_ENTRY_SIZE;
  dv.setUint32(entry, 2, true);       // DDSurface
  dv.setUint16(entry + 12, 8, true);  // width
  dv.setUint16(entry + 14, 4, true);  // height
  dv.setUint16(entry + 16, bpp, true);
  dv.setUint16(entry + 18, 32, true); // pitch
  dv.setUint32(entry + 20, bitsWa, true);
  dv.setUint32(entry + 28, 1, true);  // flags = primary
  return entry;
}

(async () => {
  const { exports: wat, memory } = await bootRenderHarness();
  const dv = new DataView(memory.buffer);

  const stale = makePrimary(dv, 1, 16, 0x300000);
  const live = makePrimary(dv, 7, 8, 0x310000);

  // Nothing recorded yet: the scan finds the lowest live primary.
  wat.test_dx_set_primary_wa(0);
  assert.strictEqual(wat.test_dx_primary_entry() >>> 0, stale >>> 0,
    'with no recorded primary the scan must still find one');

  // CreateSurface records the newest primary; it wins over the stale slot.
  wat.test_dx_set_primary_wa(live);
  assert.strictEqual(wat.test_dx_primary_entry() >>> 0, live >>> 0,
    'the primary created most recently owns the display');

  // Release frees the entry (type 0). The stale recorded pointer must not be
  // handed out as a surface -- fall back to the scan instead.
  dv.setUint32(live, 0, true);
  assert.strictEqual(wat.test_dx_primary_entry() >>> 0, stale >>> 0,
    'a freed recorded primary must fall back to the scan');
  assert.strictEqual(wat.test_dx_primary_entry() >>> 0, stale >>> 0,
    'the stale record must have been cleared, not re-tested each call');

  // A recorded entry whose DIB was never allocated is not a display either.
  dv.setUint32(live, 2, true);
  dv.setUint32(live + 20, 0, true);
  wat.test_dx_set_primary_wa(live);
  assert.strictEqual(wat.test_dx_primary_entry() >>> 0, stale >>> 0,
    'a primary with no surface memory must not stand in for the display');

  console.log('PASS test-directdraw-mode-change-primary');
})().catch((err) => { console.error(err); process.exit(1); });
