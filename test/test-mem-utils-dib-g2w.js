#!/usr/bin/env node

'use strict';

// lib/mem-utils.js g2w() must translate the same guest addresses WAT's $g2w
// does. It used to know only the direct image window and the sparse
// VirtualAlloc map, so a CreateDIBSection pointer -- which lives in the
// dedicated high arena -- translated to a wild offset and every JS-side read
// came back zero. That silently broke --trace-api decoding, hexdump, readStrA
// and --watch for anything pointing at DIB bits.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const { g2w, g2wSpan, readStrA } = require('../lib/mem-utils');

const DIB_GUEST_BASE = 0x50000000;
const DIB_GUEST_CAPACITY = 0x04000000;

(async () => {
  const { exports: e, memory } = await bootRenderHarness();
  const dv = new DataView(memory.buffer);
  const imageBase = e.get_image_base() >>> 0;

  const bmi = e.guest_alloc(40) >>> 0;
  const bitsOut = e.guest_alloc(4) >>> 0;
  e.guest_write32(bmi, 40);
  e.guest_write32(bmi + 4, 16);
  e.guest_write32(bmi + 8, -16);   // top-down
  e.guest_write16(bmi + 12, 1);
  e.guest_write16(bmi + 14, 32);

  const bitmap = e.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
  assert(bitmap, 'CreateDIBSection should allocate a WAT bitmap handle');
  const bitsGA = e.guest_read32(bitsOut) >>> 0;
  assert(bitsGA >= DIB_GUEST_BASE && bitsGA < DIB_GUEST_BASE + DIB_GUEST_CAPACITY,
    `DIB bits should live in the DIB arena, got 0x${bitsGA.toString(16)}`);

  // WAT writes the bytes; JS must find them at the address g2w() reports.
  e.guest_write32(bitsGA, 0xDEADBEEF);
  const wa = g2w(bitsGA, imageBase, memory);
  assert.strictEqual(dv.getUint32(wa, true) >>> 0, 0xDEADBEEF,
    'g2w() should resolve a DIB pointer to the byte WAT just wrote');

  // ...and the round trip must hold in the other direction too.
  dv.setUint32(wa + 4, 0x01020304, true);
  assert.strictEqual(e.guest_read32(bitsGA + 4) >>> 0, 0x01020304,
    'a JS write through g2w() should be visible to WAT');

  // readStrA is the common consumer (--trace-api LPCSTR args).
  const bytes = new Uint8Array(memory.buffer);
  for (const [i, c] of [...'DIBTEXT'].entries()) bytes[wa + 8 + i] = c.charCodeAt(0);
  bytes[wa + 15] = 0;
  assert.strictEqual(readStrA(memory.buffer, g2w(bitsGA + 8, imageBase, memory)), 'DIBTEXT',
    'readStrA should read a string stored in DIB memory');

  // A span inside the arena is contiguous up to the end of the arena, never
  // the 4-byte unmapped sentinel run.
  const span = g2wSpan(bitsGA, 0x10000, imageBase, memory);
  assert.strictEqual(span, 0x10000,
    `a DIB run should be fully contiguous, got ${span}`);
  const tailGA = (DIB_GUEST_BASE + DIB_GUEST_CAPACITY - 0x40) >>> 0;
  assert.strictEqual(g2wSpan(tailGA, 0x1000, imageBase, memory), 0x40,
    'a span should stop at the end of the DIB arena');

  // Ordinary image-relative addresses must be untouched by the new branch.
  assert.strictEqual(g2w(imageBase, imageBase, memory), 0x12000,
    'the direct guest window should still translate as before');

  console.log('7/7 checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
