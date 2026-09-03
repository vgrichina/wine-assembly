#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_free_console") (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_FreeConsole
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_alloc_console") (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_AllocConsole
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_get_std_handle") (param $which i32) (result i32)
    (call $console_std_handle_get (local.get $which)))
  (func (export "test_set_std_handle") (param $which i32) (param $handle i32) (result i32)
    (call $console_std_handle_set (local.get $which) (local.get $handle)))
  (func (export "test_console_attached") (result i32)
    (call $console_is_attached))
  (func (export "test_ensure_console_window") (result i32)
    (call $console_ensure_window)
    (call $console_shared_hwnd))
  (func (export "test_wnd_exists") (param $hwnd i32) (result i32)
    (i32.ne (call $wnd_table_get (local.get $hwnd)) (i32.const 0)))
  (func (export "test_last_error") (result i32)
    (global.get $last_error))
  (func (export "test_set_pe_subsystem") (param $subsystem i32)
    (global.set $image_base (i32.const 0x00400000))
    (call $gs16 (i32.const 0x00400000) (i32.const 0x5A4D))
    (call $gs32 (i32.const 0x0040003C) (i32.const 0x80))
    (call $gs32 (i32.const 0x00400080) (i32.const 0x00004550))
    (call $gs16 (i32.const 0x004000DC) (local.get $subsystem))
    (i32.atomic.store (region.addr $CONSOLE_INPUT 0xC10) (i32.const 0)))
  (func (export "test_clear_pe_subsystem")
    (global.set $image_base (i32.const 0))
    (i32.atomic.store (region.addr $CONSOLE_INPUT 0xC10) (i32.const 0)))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  wat.test_set_pe_subsystem(2);
  assert.strictEqual(wat.test_console_attached(), 0,
    'IMAGE_SUBSYSTEM_WINDOWS_GUI started with a console');
  assert.strictEqual(wat.test_get_std_handle(0xfffffff5), 0,
    'GUI image received an implicit CONOUT$ handle');
  wat.test_set_pe_subsystem(3);
  assert.strictEqual(wat.test_console_attached(), 1,
    'IMAGE_SUBSYSTEM_WINDOWS_CUI did not start attached');
  wat.test_clear_pe_subsystem();
  assert.strictEqual(wat.test_console_attached(), 1,
    'non-PE harness should retain the console-process default');
  assert.strictEqual(wat.test_get_std_handle(0xfffffff6), 1);
  assert.strictEqual(wat.test_get_std_handle(0xfffffff5), 2);
  assert.strictEqual(wat.test_get_std_handle(0xfffffff4), 3);
  const hwnd = wat.test_ensure_console_window() >>> 0;
  assert.notStrictEqual(hwnd, 0, 'attached console did not create its host window');
  assert.strictEqual(wat.test_wnd_exists(hwnd), 1);

  assert.strictEqual(wat.test_alloc_console(), 0,
    'AllocConsole accepted a process that already owns a console');
  assert.strictEqual(wat.test_last_error(), 5,
    'duplicate AllocConsole did not set ERROR_ACCESS_DENIED');

  assert.strictEqual(wat.test_free_console(), 1, 'FreeConsole succeeds');
  assert.strictEqual(wat.get_esp(), 0x00300004,
    'zero-argument stdcall pops its return address');
  assert.strictEqual(wat.test_console_attached(), 0);
  assert.strictEqual(wat.test_wnd_exists(hwnd), 0,
    'FreeConsole left the console HWND registered');
  assert.strictEqual(wat.test_ensure_console_window(), 0,
    'detached console recreated a window on demand');
  assert.strictEqual(wat.test_get_std_handle(0xfffffff6), 0);
  assert.strictEqual(wat.test_get_std_handle(0xfffffff5), 0);
  assert.strictEqual(wat.test_get_std_handle(0xfffffff4), 0);

  assert.strictEqual(wat.test_set_std_handle(0xfffffff5, 0x12345678), 1);
  assert.strictEqual(wat.test_get_std_handle(0xfffffff5) >>> 0, 0x12345678,
    'detached process lost an explicitly redirected standard handle');
  assert.strictEqual(wat.test_free_console(), 1,
    'FreeConsole must also succeed when already detached');

  assert.strictEqual(wat.test_alloc_console(), 1,
    'AllocConsole did not attach a fresh console');
  assert.strictEqual(wat.test_console_attached(), 1);
  assert.strictEqual(wat.test_get_std_handle(0xfffffff6), 1);
  assert.strictEqual(wat.test_get_std_handle(0xfffffff5), 2,
    'AllocConsole did not replace redirected standard handles with CONOUT$');
  assert.strictEqual(wat.test_get_std_handle(0xfffffff4), 3);
  const replacement = wat.test_ensure_console_window() >>> 0;
  assert.notStrictEqual(replacement, 0);
  assert.notStrictEqual(replacement, hwnd,
    'AllocConsole reused the detached console HWND identity');
  assert.strictEqual(wat.test_alloc_console(), 0,
    'second AllocConsole unexpectedly succeeded');

  console.log('PASS Win32 console attachment, detachment, standard handles, and window lifetime');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
