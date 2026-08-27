#!/usr/bin/env node
'use strict';

// Compiled guest pages grow through 4/8/12/16KB size classes and dropped
// chunks are reused. This is the storage shape selected by Diablo II's page
// occupancy census: 78% of retired pages fit in 4KB and 97% fit in 8KB, while
// fixed 16KB reservations repeatedly exhausted the 4MB thread arena.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_page_storage_reset")
    (global.set $ip (i32.const 0))
    (global.set $sync_msg_depth (i32.const 0))
    (global.set $thread_flush_pending (i32.const 0))
    (global.set $thread_alloc (global.get $THREAD_BASE))
    (call $page_dir_reset))

  ;; Mirror $publish_block's scratch lifecycle around a synthetic threaded
  ;; payload. The bytes themselves need not be valid handler records because
  ;; this test exercises storage and relocation, not execution.
  (func (export "test_page_publish_sized")
        (param $guest i32) (param $len i32) (param $marker i32) (result i32)
    (local $start i32) (local $end i32) (local $off i32)
    (local.set $start (global.get $thread_alloc))
    (local.set $end (i32.add (local.get $start) (local.get $len)))
    (memory.fill (local.get $start) (local.get $marker) (local.get $len))
    (global.set $thread_alloc (local.get $end))
    (local.set $off
      (call $page_publish
        (local.get $guest) (local.get $start) (local.get $end)
        (i32.add (local.get $guest) (i32.const 1))))
    (if (i32.eq (global.get $thread_alloc) (local.get $end))
      (then (global.set $thread_alloc (local.get $start))))
    (local.get $off))

  (func (export "test_page_chunk") (param $page i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $page_dir_slot (local.get $page)))
    (if (i32.ne (i32.load (local.get $slot)) (local.get $page))
      (then (return (i32.const 0))))
    (i32.load offset=8 (local.get $slot)))

  (func (export "test_page_used") (param $page i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $page_dir_slot (local.get $page)))
    (if (i32.ne (i32.load (local.get $slot)) (local.get $page))
      (then (return (i32.const 0))))
    (call $page_desc_used (i32.load offset=12 (local.get $slot))))

  (func (export "test_page_capacity") (param $page i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $page_dir_slot (local.get $page)))
    (if (i32.ne (i32.load (local.get $slot)) (local.get $page))
      (then (return (i32.const 0))))
    (call $page_chunk_bytes
      (call $page_desc_class (i32.load offset=12 (local.get $slot)))))

  (func (export "test_page_chunk_byte") (param $page i32) (param $off i32) (result i32)
    (i32.load8_u (i32.add (call $page_enter_and_chunk (local.get $page)) (local.get $off))))

  (func $page_enter_and_chunk (param $page i32) (result i32)
    (if (i32.eqz (call $page_enter (local.get $page)))
      (then (return (i32.const 0))))
    (global.get $cur_page_chunk))

  (func (export "test_page_thread_used") (result i32)
    (i32.sub (global.get $thread_alloc) (global.get $THREAD_BASE)))
  (func (export "test_page_index_entry") (param $page i32) (param $off i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $page_dir_slot (local.get $page)))
    (if (i32.ne (i32.load (local.get $slot)) (local.get $page))
      (then (return (i32.const -1))))
    (i32.load16_u
      (i32.add (i32.load offset=4 (local.get $slot))
        (i32.shl (local.get $off) (i32.const 1)))))
  (func (export "test_heap_cursor_before_page_index")
    (local $guest i32)
    (local.set $guest
      (call $w2g (i32.sub (global.get $PAGE_INDEX_ARENA) (i32.const 0x1000))))
    (i32.atomic.store (global.get $HEAP_SHARED) (local.get $guest))
    (i32.store offset=4 (global.get $HEAP_SHARED) (local.get $guest))
    (global.set $heap_base (local.get $guest))
    (global.set $heap_ptr (i32.const 0))
    (global.set $heap_end (i32.const 0))
    (global.set $free_list (i32.const 0)))
  (func (export "test_zero_guest_allocation") (param $guest i32) (param $len i32)
    (memory.fill (call $g2w (local.get $guest)) (i32.const 0) (local.get $len)))
  (func (export "test_page_deferred") (result i32) (global.get $page_chunk_deferred))
  (func (export "test_page_reclaim_deferred") (call $page_chunk_reclaim_deferred))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, width: 64, height: 48 });
  const pageA = 0x00400000;
  const pageB = pageA + 0x00400000; // same 1024-entry PAGE_DIR slot

  e.test_page_storage_reset();
  assert.strictEqual(e.test_page_publish_sized(pageA, 3000, 0x11), 0);
  const chunk4 = e.test_page_chunk(pageA) >>> 0;
  assert.ok(chunk4, 'first page should receive a chunk');
  assert.strictEqual(e.test_page_capacity(pageA), 4096,
    'a 3000-byte payload should reserve only 4KB');
  assert.strictEqual(e.test_page_used(pageA), 3000);
  assert.strictEqual(e.test_page_chunk_byte(pageA, 0), 0x11);

  assert.strictEqual(e.test_page_publish_sized(pageA + 4, 2000, 0x22), 3000);
  const chunk8 = e.test_page_chunk(pageA) >>> 0;
  assert.notStrictEqual(chunk8, chunk4, 'crossing 4KB should relocate the page');
  assert.strictEqual(e.test_page_capacity(pageA), 8192,
    'a 5000-byte payload should grow to 8KB');
  assert.strictEqual(e.test_page_used(pageA), 5000);
  assert.strictEqual(e.test_page_chunk_byte(pageA, 0), 0x11,
    'growth should preserve the old payload');
  assert.strictEqual(e.test_page_chunk_byte(pageA, 3000), 0x22,
    'growth should append the new payload');

  // Creating a colliding 8KB page drops A, then immediately consumes A's safe
  // retired chunk instead of advancing the arena.
  const reusesBefore = e.get_page_chunk_reuses();
  assert.strictEqual(e.test_page_publish_sized(pageB, 5000, 0x33), 0);
  assert.strictEqual(e.test_page_chunk(pageB) >>> 0, chunk8,
    'a directory collision should recycle the matching-size chunk');
  assert.ok(e.get_page_chunk_reuses() > reusesBefore,
    'recycled allocation counter should advance');
  assert.strictEqual(e.test_page_chunk_byte(pageB, 0), 0x33);

  // A page beyond the 16KB indexable maximum is retired so its next hot subset
  // can rebuild, but its chunk remains deferred until the already-decoded first
  // block has returned. Model that safe boundary and require later reuse.
  e.test_page_storage_reset();
  assert.strictEqual(e.test_page_publish_sized(pageA, 12000, 0x44), 0);
  assert.strictEqual(e.test_page_publish_sized(pageA + 4, 4000, 0x55), 12000);
  const fullChunk = e.test_page_chunk(pageA) >>> 0;
  assert.strictEqual(e.test_page_capacity(pageA), 16384);
  assert.strictEqual(e.test_page_publish_sized(pageA + 8, 1000, 0x66), -1,
    'a page beyond 16KB should execute the new block from decode scratch');
  assert.strictEqual(e.test_page_chunk(pageA), 0,
    'a full page should leave the directory so its hot subset can rebuild');
  assert.strictEqual(e.test_page_deferred() >>> 0, fullChunk,
    'the full chunk must not be reusable before the decoded block returns');
  e.test_page_reclaim_deferred();
  assert.strictEqual(e.test_page_deferred(), 0);
  assert.strictEqual(e.test_page_publish_sized(pageB, 16000, 0x77), 0);
  assert.strictEqual(e.test_page_chunk(pageB) >>> 0, fullChunk,
    'the full chunk should become reusable at the next safe block boundary');

  // Hundreds of mutually colliding small pages used to strand one 16KB chunk
  // apiece and overflow the arena. With safe 4KB recycling, only the first
  // page advances the bump allocator; every later page reuses that chunk.
  e.test_page_storage_reset();
  const stressBase = 0x01000000;
  const stressReuses = e.get_page_chunk_reuses();
  for (let i = 0; i < 300; i++) {
    const page = stressBase + i * 0x00400000;
    assert.strictEqual(e.test_page_publish_sized(page, 64, i), 0,
      `page ${i} should publish under index pressure`);
    assert.strictEqual(e.test_page_capacity(page), 4096);
  }
  assert.ok(e.test_page_thread_used() < 8192,
    `colliding pages should not fill the arena (${e.test_page_thread_used()} bytes used)`);
  assert.ok(e.get_page_chunk_reuses() - stressReuses >= 299,
    'all colliding pages after the first should reuse one 4KB chunk');

  // Compact chunks also mean the arena no longer overflows often enough to
  // reset the 128-entry index as an accidental replacement policy. Touch more
  // than 128 non-colliding pages and require the clock eviction path to keep
  // publishing rather than falling back to decode-on-every-entry.
  e.test_page_storage_reset();
  const unpublishedBefore = e.get_page_unpublished();
  for (let i = 0; i < 300; i++) {
    const page = 0x10000000 + i * 0x1000;
    const published = e.test_page_publish_sized(page, 64, i);
    assert.strictEqual(published, 0,
      `non-colliding page ${i} should publish under index pressure`);
  }
  assert.strictEqual(e.get_page_unpublished(), unpublishedBefore,
    'index pressure should evict a cold page instead of declining publication');

  // The low guest heap is affine-mapped into WASM memory. Its ceiling must be
  // the first decoded-cache structure, not the later threaded-code arena:
  // otherwise a large app can receive ordinary heap bytes backed by
  // PAGE_INDEX_ARENA and zero a live page entry. AoE2's campaign loader reaches
  // this boundary only in the larger Threads working set.
  e.test_page_storage_reset();
  const protectedPage = 0x00515000;
  assert.strictEqual(e.test_page_publish_sized(protectedPage + 0x40, 64, 0x91), 0);
  assert.strictEqual(e.test_page_publish_sized(protectedPage + 0x5b, 64, 0x92), 64);
  assert.strictEqual(e.test_page_index_entry(protectedPage, 0x5b), 64);
  e.test_heap_cursor_before_page_index();
  const heapBlock = e.guest_alloc(0x2000) >>> 0;
  assert.ok(heapBlock, 'allocation at the low-heap ceiling should spill to sparse memory');
  e.test_zero_guest_allocation(heapBlock, 0x2000);
  assert.strictEqual(e.test_page_index_entry(protectedPage, 0x5b), 64,
    'guest heap writes must not overlap the decoded-page index arena');

  // Exercise relocation through the real decoder, not only through direct
  // page_publish calls. One address-ordered run emits enough threaded code to
  // cross the 4KB class boundary before its first block executes. decode_run
  // must carry its saved first-block pointer to the new chunk.
  e.test_page_storage_reset();
  const code = 0x00030000;
  const stack = 0x00100000;
  const bytes = [];
  const branches = [];
  for (let block = 0; block < 50; block++) {
    for (let n = 0; n < 12; n++) {
      bytes.push(0xb8, n, 0, 0, 0); // mov eax,n
    }
    bytes.push(0x83, 0xf8, 0x0b);   // cmp eax,11
    branches.push(bytes.length);
    bytes.push(0x0f, 0x85, 0, 0, 0, 0); // jne final (not taken)
  }
  const finalOffset = bytes.length;
  bytes.push(0xb8, 0x78, 0x56, 0x34, 0x12, 0xc3); // mov eax,12345678; ret
  for (const operandOffset of branches) {
    const next = operandOffset + 6;
    const rel = finalOffset - next;
    bytes[operandOffset + 2] = rel & 0xff;
    bytes[operandOffset + 3] = (rel >>> 8) & 0xff;
    bytes[operandOffset + 4] = (rel >>> 16) & 0xff;
    bytes[operandOffset + 5] = (rel >>> 24) & 0xff;
  }
  bytes.forEach((byte, i) => e.guest_write8(code + i, byte));
  e.set_esp(stack);
  e.guest_write32(stack, 0);
  const growsBefore = e.get_page_chunk_grows();
  e.set_eip(code);
  e.run(10000);
  assert.strictEqual(e.get_eip() >>> 0, 0,
    'relocated address-ordered run should return to its sentinel');
  assert.strictEqual(e.get_eax() >>> 0, 0x12345678,
    'relocated address-ordered run should execute every fall-through block');
  assert.ok(e.get_page_chunk_grows() > growsBefore,
    'real decode_run should grow and relocate its page chunk');

  console.log('PASS page chunks use measured size classes, relocate safely, and recycle drops');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
