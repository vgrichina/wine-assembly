#!/usr/bin/env node

'use strict';

// CloseWindow/OpenIcon are a paired USER transition. The former makes the
// window iconic without destroying it; the latter asks WM_QUERYOPEN before
// restoring and activating it. Both browser and guest-visible state must move
// together.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_make_icon_window") (param $proc i32) (result i32)
    (local $hwnd i32)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $hwnd)
      (select (local.get $proc) (global.get $WNDPROC_BUILTIN)
        (i32.ne (local.get $proc) (i32.const 0))))
    (drop (call $wnd_set_style (local.get $hwnd) (i32.const 0x10CF0000)))
    (local.get $hwnd))

  (func (export "test_close_window") (param $hwnd i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_CloseWindow
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))

  (func (export "test_open_icon") (param $hwnd i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_OpenIcon
      (local.get $hwnd) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))

  (func (export "test_def_query_open") (param $wide i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (if (local.get $wide)
      (then (call $handle_DefWindowProcW
        (i32.const 0) (i32.const 0x0013) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0)))
      (else (call $handle_DefWindowProcA
        (i32.const 0) (i32.const 0x0013) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))))
    (global.set $esp (local.get $saved))
    (global.get $eax))

  (func (export "test_set_active_raw") (param $hwnd i32)
    (global.set $active_hwnd (local.get $hwnd))
    (global.set $focus_hwnd (local.get $hwnd)))
  (func (export "test_set_max_raw") (param $hwnd i32) (param $value i32)
    (call $wnd_max_set (local.get $hwnd) (local.get $value)))
  (func (export "test_min") (param $hwnd i32) (result i32)
    (call $wnd_min_get (local.get $hwnd)))
  (func (export "test_max") (param $hwnd i32) (result i32)
    (call $wnd_max_get (local.get $hwnd)))
  (func (export "test_active") (result i32) (global.get $active_hwnd))
  (func (export "test_last_error") (result i32) (global.get $last_error))
`;

const u32 = value => [value, value >>> 8, value >>> 16, value >>> 24]
  .map(byte => byte & 0xff);

(async () => {
  const hostCalls = [];
  const rendererHwnd = 0x70001;
  const { exports: e, memory } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      sys_command(hwnd, command) {
        hostCalls.push(['sys', hwnd >>> 0, command >>> 0]);
      },
      activate_window(hwnd) {
        hostCalls.push(['activate', hwnd >>> 0]);
        return 1;
      },
      get_window_info: (hwnd, prop) =>
        ((hwnd >>> 0) === rendererHwnd && prop === 4 ? 1 : 0),
      invalidate_frame() {},
    },
  });

  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes synchronous wndproc dispatch');
  e.init_dx_com_thunks();

  assert.strictEqual(e.test_def_query_open(0), 1,
    'DefWindowProcA must permit WM_QUERYOPEN by default');
  assert.strictEqual(e.test_def_query_open(1), 1,
    'DefWindowProcW must permit WM_QUERYOPEN by default');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const allowProc = e.guest_alloc(8) >>> 0;
  new Uint8Array(memory.buffer).set(Uint8Array.from([
    0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax,1
    0xc2, 0x10, 0x00,             // ret 16
  ]), toWasm(allowProc));

  // Use a real x86 wndproc so activation messages exercise the same
  // synchronous callback route as an application window.
  const hwnd = e.test_make_icon_window(allowProc) >>> 0;
  assert.strictEqual(e.test_open_icon(hwnd), 0,
    'OpenIcon does nothing to a window that is not iconic');
  assert.deepStrictEqual(hostCalls, []);

  e.test_set_active_raw(hwnd);
  assert.strictEqual(e.test_close_window(hwnd), 1);
  assert.strictEqual(e.test_min(hwnd), 1,
    'CloseWindow must update the guest IsIconic state');
  assert.strictEqual(e.test_active(), 0,
    'minimizing the active window deactivates it');
  assert.deepStrictEqual(hostCalls, [['sys', hwnd, 0xF020]]);

  assert.strictEqual(e.test_open_icon(hwnd), 1);
  assert.strictEqual(e.test_min(hwnd), 0,
    'OpenIcon clears the guest iconic state');
  assert.strictEqual(e.test_active() >>> 0, hwnd,
    'OpenIcon activates the restored top-level');
  assert.deepStrictEqual(hostCalls.slice(-2), [
    ['sys', hwnd, 0xF120],
    ['activate', hwnd],
  ]);

  e.test_set_max_raw(hwnd, 1);
  assert.strictEqual(e.test_close_window(hwnd), 1);
  assert.strictEqual(e.test_open_icon(hwnd), 1);
  assert.strictEqual(e.test_max(hwnd), 1,
    'restoring an iconified maximized window keeps it maximized');

  const observed = e.guest_alloc(4) >>> 0;
  const vetoProc = e.guest_alloc(32) >>> 0;
  const code = Uint8Array.from([
    0x8b, 0x44, 0x24, 0x08,             // mov eax,[esp+8] (message)
    0xa3, ...u32(observed),              // mov [observed],eax
    0x31, 0xc0,                          // xor eax,eax (veto)
    0xc2, 0x10, 0x00,                    // ret 16
  ]);
  new Uint8Array(memory.buffer).set(code, toWasm(vetoProc));

  const veto = e.test_make_icon_window(vetoProc) >>> 0;
  assert.strictEqual(e.test_close_window(veto), 1);
  const callsBeforeVeto = hostCalls.length;
  assert.strictEqual(e.test_open_icon(veto), 0,
    'a zero WM_QUERYOPEN result vetoes restoration');
  assert.strictEqual(e.test_min(veto), 1,
    'vetoed OpenIcon leaves the window iconic');
  assert.strictEqual(hostCalls.length, callsBeforeVeto,
    'vetoed OpenIcon must not touch renderer state');
  assert.strictEqual(new DataView(memory.buffer).getUint32(toWasm(observed), true), 0x0013,
    'OpenIcon synchronously sent WM_QUERYOPEN');

  assert.strictEqual(e.test_close_window(rendererHwnd), 1,
    'CloseWindow accepts a live renderer-owned window from another process');
  assert.deepStrictEqual(hostCalls.at(-1), ['sys', rendererHwnd, 0xF020],
    'a foreign window is minimized through the shared renderer');

  assert.strictEqual(e.test_close_window(0x7fffffff), 0);
  assert.strictEqual(e.test_last_error(), 1400);
  assert.strictEqual(e.test_open_icon(0x7fffffff), 0);
  assert.strictEqual(e.test_last_error(), 1400);

  console.log('PASS  OpenIcon/CloseWindow synchronize local and renderer-owned Win98 state');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
