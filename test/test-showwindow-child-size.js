#!/usr/bin/env node
'use strict';

// First showing a hidden child delivers its current client size. Frameworks
// use that notification to lay out controls created after the container.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const packedSize = (283 | (102 << 16)) >>> 0;
const extraWat = String.raw`
  (func (export "test_create_hidden_child") (result i32)
    (local $parent i32) (local $child i32)
    (local.set $parent (global.get $next_hwnd))
    (global.set $next_hwnd
      (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $parent) (global.get $WNDPROC_BUILTIN))
    (drop (call $wnd_set_style (local.get $parent) (i32.const 0x10000000)))
    (global.set $main_hwnd (local.get $parent))

    (local.set $child (global.get $next_hwnd))
    (global.set $next_hwnd
      (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $child) (global.get $WNDPROC_BUILTIN))
    (drop (call $wnd_set_style (local.get $child) (i32.const 0x40000000)))
    (call $wnd_set_parent (local.get $child) (local.get $parent))
    (local.get $child))

  (func (export "test_call_show_window") (param $hwnd i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_ShowWindow
      (local.get $hwnd) (i32.const 5)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp)))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: { show_window: () => packedSize },
  });

  const child = e.test_create_hidden_child() >>> 0;
  e.set_post_queue_count(0);
  e.test_call_show_window(child);

  assert.strictEqual(e.post_queue_depth(), 2,
    'first show queues WM_SHOWWINDOW followed by WM_SIZE');
  assert.deepStrictEqual([0, 1, 2, 3].map(field => e.post_queue_peek(0, field) >>> 0),
    [child, 0x0018, 1, 0], 'WM_SHOWWINDOW describes the visible transition');
  assert.deepStrictEqual([0, 1, 2, 3].map(field => e.post_queue_peek(1, field) >>> 0),
    [child, 0x0005, 0, packedSize], 'WM_SIZE carries the current child client size');

  e.set_post_queue_count(0);
  e.test_call_show_window(child);
  assert.strictEqual(e.post_queue_depth(), 1,
    'showing an already-visible child does not synthesize another WM_SIZE');
  assert.strictEqual(e.post_queue_peek(0, 1) >>> 0, 0x0018);

  console.log('PASS ShowWindow sizes a hidden child when it first becomes visible');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
