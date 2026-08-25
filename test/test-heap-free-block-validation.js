#!/usr/bin/env node
//
// $heap_alloc must not serve a free block whose own header is impossible.
//
// $heap_free already validates a block's extent before linking it, but the
// header lives in guest memory and stays writable afterwards: a guest that
// overruns the live block in front of a free one rewrites that header after
// the link happened. If the allocator then trusts it, a header reading tens
// of megabytes looks like a fit for any request, gets split, and is handed
// back as a low pointer -- and HEAP_ZERO_MEMORY promptly zeroes that whole
// bogus extent straight through whatever the emulator keeps above the heap.
// The failure surfaces nowhere near the heap (the decoder walks into zeros),
// so it is worth pinning the check itself down here.
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_set_heap_arena") (param $base i32) (param $ptr i32)
    (global.set $image_base (i32.const 0))
    (global.set $heap_base (local.get $base))
    (global.set $heap_ptr (local.get $ptr))
    (global.set $free_list (i32.const 0)))
`;

function putBlock(wat, at, size, next) {
  for (let i = 0; i < 4; i++) {
    wat.guest_write8(at + i, (size >>> (i * 8)) & 0xff);
    wat.guest_write8(at + 4 + i, (next >>> (i * 8)) & 0xff);
  }
}

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });

  const BASE = 0x00100000;
  const TOP = 0x00110000;

  // --- control: a well-formed free block is still recycled ------------------
  wat.test_set_heap_arena(BASE, TOP);
  const good = 0x0010f000;
  putBlock(wat, good, 0x100, 0);
  wat.set_free_list(good);
  const fromList = wat.guest_alloc(0x40) >>> 0;
  assert(fromList > good && fromList < good + 0x100,
    `a valid free block is served from the list (got 0x${fromList.toString(16)})`);
  assert.strictEqual(wat.get_heap_ptr() >>> 0, TOP,
    'and the bump pointer did not move');

  // --- the regression: a header that escapes the arena ----------------------
  wat.test_set_heap_arena(BASE, TOP);
  const bad = 0x00108000;
  putBlock(wat, bad, 0x03d09020, 0);   // 64 MB, ending far past heap_ptr
  wat.set_free_list(bad);
  const alloc = wat.guest_alloc(0x40) >>> 0;
  assert(alloc >= TOP,
    `the impossible block is refused and the request bump-allocates ` +
    `(got 0x${alloc.toString(16)})`);
  assert.strictEqual(wat.get_free_list() >>> 0, 0,
    'the chain is cut there: its next pointer lives in the block we distrust');

  // A request that would have "fit" the bogus 64 MB header is refused too --
  // this is the shape Pawn hits, and serving it is what wipes linear memory.
  wat.test_set_heap_arena(BASE, TOP);
  putBlock(wat, bad, 0x03d09020, 0);
  wat.set_free_list(bad);
  const huge = wat.guest_alloc(0x03d09000) >>> 0;
  assert(huge === 0 || huge >= TOP,
    `a huge request is never carved out of the bogus block ` +
    `(got 0x${huge.toString(16)})`);

  // --- headers that are merely malformed ------------------------------------
  for (const [name, size] of [['undersized', 8], ['misaligned', 0x101]]) {
    wat.test_set_heap_arena(BASE, TOP);
    putBlock(wat, good, size, 0);
    wat.set_free_list(good);
    const got = wat.guest_alloc(4) >>> 0;
    assert(got >= TOP, `a ${name} free-block header is refused too`);
  }

  console.log('PASS  heap_alloc refuses free blocks whose header escapes the arena');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
