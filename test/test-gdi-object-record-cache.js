#!/usr/bin/env node

'use strict';

// $gdi_object_record lookup caches.
//
// The record lookup keeps two positive hints and two negative ones, because a
// blit resolves the source handle and the destination handle alternately for
// every pixel and a single slot of either kind thrashes between them. The
// negative slots also have to notice when a handle they remembered as absent
// is entered into the table afterwards — worker threads are separate WASM
// instances sharing this memory, so that check goes through the shared
// GDI_OBJECT_GEN counter rather than a per-instance flag.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

// test_gdi_object_record and test_gdi_object_adopt are already exported by the
// module; only the allocator needs a bridge.
const extraWat = `
  (func (export "test_gdi_object_alloc_type") (param $type i32) (result i32)
    (call $gdi_object_alloc (local.get $type)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
`;

let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`  ok  ${label}`); };

(async () => {
  const wat = (await bootRenderHarness({ extraWat })).exports;

  const h1 = wat.test_gdi_object_alloc_type(1) >>> 0;
  const h2 = wat.test_gdi_object_alloc_type(2) >>> 0;
  assert(h1 && h2 && h1 !== h2, 'two distinct object handles');
  const p1 = wat.test_gdi_object_record(h1) >>> 0;
  const p2 = wat.test_gdi_object_record(h2) >>> 0;
  assert(p1 && p2 && p1 !== p2, 'two distinct records');

  check('alternating lookups keep resolving to the same records', () => {
    for (let i = 0; i < 8; i++) {
      assert.strictEqual(wat.test_gdi_object_record(h1) >>> 0, p1);
      assert.strictEqual(wat.test_gdi_object_record(h2) >>> 0, p2);
    }
  });

  const absentA = 0x00200004;
  const absentB = 0x00200008;

  check('alternating absent handles stay absent', () => {
    for (let i = 0; i < 8; i++) {
      assert.strictEqual(wat.test_gdi_object_record(absentA) >>> 0, 0);
      assert.strictEqual(wat.test_gdi_object_record(absentB) >>> 0, 0);
    }
  });

  check('a remembered miss is retired once the handle is adopted', () => {
    assert.strictEqual(wat.test_gdi_object_record(absentA) >>> 0, 0);
    assert.strictEqual(wat.test_gdi_object_adopt(absentA, 3, 0, 0, 0, 0) >>> 0, absentA);
    const found = wat.test_gdi_object_record(absentA) >>> 0;
    assert(found, 'the adopted handle must resolve, not answer from the miss cache');
    assert.strictEqual(wat.test_gdi_object_record(absentB) >>> 0, 0,
      'and the other absent handle must still be absent');
  });

  check('the earlier records survive the invalidation', () => {
    assert.strictEqual(wat.test_gdi_object_record(h1) >>> 0, p1);
    assert.strictEqual(wat.test_gdi_object_record(h2) >>> 0, p2);
  });

  console.log(`\ntest-gdi-object-record-cache: ${passed}/${passed} passed`);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
