#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Canvas } = require('../lib/canvas-compat');

// Count DataView construction across the actual host path. The old fallback
// built one for each of 4,096 slots per frame; the live index shares one view.
const NativeDataView = global.DataView;
let dataViews = 0;
let dxTableTypeReads = 0;
// $DX_OBJECTS, from the map declared in src/00-regions.wat.
const DX_TABLE = require('../lib/region-map.generated.js').BASE.DX_OBJECTS;
const DX_TABLE_BYTES = 4096 * 32;
global.DataView = class CountingDataView extends NativeDataView {
  constructor(...args) {
    super(...args);
    dataViews++;
  }
  getUint32(offset, littleEndian) {
    if (offset >= DX_TABLE && offset < DX_TABLE + DX_TABLE_BYTES &&
        (offset - DX_TABLE) % 32 === 0) dxTableTypeReads++;
    return super.getUint32(offset, littleEndian);
  }
};
const { createHostImports } = require('../lib/host-imports');

const memory = new ArrayBuffer(128 * 1024 * 1024);
const bytes = new Uint8Array(memory);
const dv = new NativeDataView(memory);
const table = DX_TABLE;
const stride = 32;
const hwnd = 0x77;
const canvas = new Canvas(4, 4);

function definePrimary(slot, dib, color) {
  const entry = table + slot * stride;
  dv.setUint32(entry, 2, true);
  dv.setUint16(entry + 12, 4, true);
  dv.setUint16(entry + 14, 4, true);
  dv.setUint16(entry + 16, 32, true);
  dv.setUint16(entry + 18, 16, true);
  dv.setUint32(entry + 20, dib, true);
  dv.setUint32(entry + 28, 1, true);
  bytes.set([color, color + 1, color + 2, 0], dib);
}

definePrimary(4095, 0x20000, 0x10);
const { host, gdi } = createHostImports({
  getMemory: () => memory,
  exports: { get_main_hwnd: () => hwnd, get_dx_primary_pal_wa: () => 0 },
  renderer: {
    windows: { [hwnd]: {} },
    getWindowCanvas: () => ({ ctx: canvas.getContext('2d') }),
    scheduleRepaint() {},
  },
});

const beforeBootstrap = dataViews;
assert.strictEqual(gdi.presentBestDxOffscreen(true), 1,
  'the one-time census must discover a live surface in the last slot');
assert(dataViews - beforeBootstrap < 16,
  `one frame allocated ${dataViews - beforeBootstrap} DataViews instead of sharing one`);

// Free the bootstrapped surface and allocate another high slot through the
// lifecycle records emitted by the common DirectDraw/D3D9 allocator. The
// second present must use those notifications, not repeat the 4,096 walk.
host.dx_trace(22, 4095, 0, 0, 0);
dv.setUint32(table + 4095 * stride, 0, true);
dv.setUint32(table + 4088 * stride, 2, true); // $dx_alloc claims type before publishing
host.dx_trace(21, 4088, 2, 0, 0);
dxTableTypeReads = 0;
assert.strictEqual(gdi.presentBestDxOffscreen(true), 0,
  'an allocation observed before CreateSurface fills its fields is retained but not presented');
assert(dxTableTypeReads < 16,
  `post-bootstrap incomplete frame reread ${dxTableTypeReads} table slots`);
definePrimary(4088, 0x21000, 0x40);
const beforeReuse = dataViews;
dxTableTypeReads = 0;
assert.strictEqual(gdi.presentBestDxOffscreen(true), 1,
  'surface traffic must add a post-bootstrap high slot to the live index');
assert(dataViews - beforeReuse < 16,
  `post-bootstrap frame allocated ${dataViews - beforeReuse} DataViews`);
assert(dxTableTypeReads < 16,
  `post-bootstrap completed frame reread ${dxTableTypeReads} table slots`);

const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'host-imports.js'), 'utf8');
assert.match(source, /for \(const slot of _dxLiveSurfaceSlots\)/,
  'fallback presentation must walk the live set');
assert.strictEqual(
  (source.match(/for \(let slot = 0; slot < DX_SLOT_COUNT; slot\+\+\)/g) || []).length,
  1, 'only the one-time bootstrap may walk the full DX table');
const wat = fs.readFileSync(
  path.join(__dirname, '..', 'src', '09a8-handlers-directx.wat'), 'utf8');
assert.match(wat,
  /\(func \$dx_alloc[\s\S]*?\$lock_release[\s\S]*?\$host_dx_trace\s+\(i32\.const 21\)/,
  'surface allocation must publish only after releasing LOCK_DX');
assert.match(wat,
  /\(func \$dx_free[\s\S]*?\$host_dx_trace\s+\(i32\.const 22\)/,
  'surface free must retire its host-side live slot');

global.DataView = NativeDataView;
console.log('PASS DirectDraw presentation bootstraps once, then walks live high slots');
