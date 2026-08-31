#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

const memory = new ArrayBuffer(128 * 1024 * 1024);
const frames = [];
const oldPerf = globalThis.WinePerf;
globalThis.WinePerf = { guestFrame: () => frames.push('frame') };

try {
  const { host, gdi } = createHostImports({
    getMemory: () => memory,
    exports: {},
    renderer: null,
  });

  const makeAndFlush = (id, bits) => {
    assert.strictEqual(host.gdi_surface_create(
      id, 4, 4, 32, bits, 16, 1, 0, 0, 0), 1);
    assert.strictEqual(host.gdi_surface_upload(id, 0, 0, 4, 4), 1);
    assert.strictEqual(gdi.flushSurfacePresentation(id), 1);
  };

  makeAndFlush(0x1234, 0x1000);
  assert.strictEqual(frames.length, 1,
    'a GDI-only canonical surface flush is one guest frame');

  makeAndFlush(0x200003, 0x2000);
  assert.strictEqual(frames.length, 1,
    'a DirectDraw render-target/cache flush is not a presentation');

  host.dx_trace(6, 3);
  assert.strictEqual(frames.length, 1,
    'Flip bookkeeping is followed by Present and must not double-count');
  host.dx_trace(5, 3);
  assert.strictEqual(frames.length, 2,
    'the explicit DirectDraw Present is one presentation');

  assert.strictEqual(host.gdi_surface_upload(0x1234, 0, 0, 4, 4), 1);
  assert.strictEqual(gdi.flushSurfacePresentation(0x1234), 1);
  assert.strictEqual(frames.length, 2,
    'surface-cache flushes stay suppressed after DirectDraw presentation starts');

  console.log('PASS perf HUD counts DirectDraw presents, not surface-cache flushes');
} finally {
  globalThis.WinePerf = oldPerf;
}
