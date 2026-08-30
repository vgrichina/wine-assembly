#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_create_console_buffer") (param $flags i32) (param $data i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_CreateConsoleScreenBuffer
      (i32.const 0xC0000000) (i32.const 3) (i32.const 0)
      (local.get $flags) (local.get $data) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_write_console") (param $handle i32) (param $buf i32)
        (param $count i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_WriteConsoleA
      (local.get $handle) (local.get $buf) (local.get $count)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_set_active_console_buffer") (param $handle i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_SetConsoleActiveScreenBuffer
      (local.get $handle) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_set_console_cursor") (param $handle i32) (param $coord i32)
        (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_SetConsoleCursorPosition
      (local.get $handle) (local.get $coord) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_set_console_size") (param $handle i32) (param $coord i32)
        (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_SetConsoleScreenBufferSize
      (local.get $handle) (local.get $coord) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_get_console_info") (param $handle i32) (param $info i32)
        (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_GetConsoleScreenBufferInfo
      (local.get $handle) (local.get $info) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_close_console_buffer") (param $handle i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_CloseHandle
      (local.get $handle) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_console_char") (param $handle i32) (param $index i32)
        (result i32)
    (local $ch i32)
    (if (i32.eqz (call $console_buffer_enter (local.get $handle)))
      (then (return (i32.const -1))))
    (call $console_cells_ensure)
    (local.set $ch (i32.load16_u (i32.add (global.get $console_text_base)
      (i32.shl (local.get $index) (i32.const 1)))))
    (call $console_buffer_finish (i32.const 0))
    (local.get $ch))
  (func (export "test_active_console_buffer") (result i32)
    (call $console_buffers_init)
    (i32.load (global.get $CONSOLE_BUFFER_ACTIVE)))
  (func (export "test_get_file_type") (param $handle i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_GetFileType
      (local.get $handle) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_set_std_output") (param $handle i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_SetStdHandle
      (i32.const -11) (local.get $handle) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_get_std_output") (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_GetStdHandle
      (i32.const -11) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_set_console_title_a") (param $title i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_SetConsoleTitleA
      (local.get $title) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_set_console_title_w") (param $title i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_SetConsoleTitleW
      (local.get $title) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_get_console_title_a") (param $title i32) (param $size i32)
        (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_GetConsoleTitleA
      (local.get $title) (local.get $size) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_get_console_title_w") (param $title i32) (param $size i32)
        (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_GetConsoleTitleW
      (local.get $title) (local.get $size) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_console_title_first_byte") (result i32)
    (call $console_title_ensure)
    (i32.load8_u (global.get $CONSOLE_TITLE_STORAGE)))
  (func (export "test_read_console_output_a")
        (param $handle i32) (param $buf i32) (param $size i32)
        (param $coord i32) (param $region i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_ReadConsoleOutputA
      (local.get $handle) (local.get $buf) (local.get $size)
      (local.get $coord) (local.get $region) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_read_console_output_w")
        (param $handle i32) (param $buf i32) (param $size i32)
        (param $coord i32) (param $region i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_ReadConsoleOutputW
      (local.get $handle) (local.get $buf) (local.get $size)
      (local.get $coord) (local.get $region) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
`;

(async () => {
  let paints = 0;
  const hostTitles = [];
  const { exports: wat } = await bootRenderHarness({
    fonts: 'none',
    extraWat,
    extraHostOverrides: {
      gdi_text_out: () => { paints++; return 1; },
      gdi_fill_rect: () => { paints++; return 1; },
      gdi_surface_upload: () => { paints++; return 1; },
      set_window_text: (_hwnd, title) => { hostTitles.push(title); },
    },
  });
  const allocText = text => {
    const ptr = wat.guest_alloc(text.length + 1) >>> 0;
    for (let i = 0; i < text.length; i++) wat.guest_write8(ptr + i, text.charCodeAt(i));
    wat.guest_write8(ptr + text.length, 0);
    return ptr;
  };
  const info = () => wat.guest_alloc(22) >>> 0;
  const coord = (x, y) => (x & 0xffff) | ((y & 0xffff) << 16);
  const read16 = ptr => wat.guest_read8(ptr) | (wat.guest_read8(ptr + 1) << 8);

  const titleBuffer = wat.guest_alloc(32) >>> 0;
  assert.strictEqual(wat.test_console_title_first_byte(), 'C'.charCodeAt(0),
    'default console title storage was not initialized');
  assert.strictEqual(wat.test_get_console_title_a(titleBuffer, 32), 7);
  assert.deepStrictEqual(Array.from({ length: 8 }, (_, i) => wat.guest_read8(titleBuffer + i)),
    [...Buffer.from('Console'), 0], 'initial ANSI console title');
  assert.strictEqual(wat.test_set_console_title_a(allocText('Far Manager')), 1);
  assert.strictEqual(wat.test_get_console_title_a(titleBuffer, 5), 4);
  assert.deepStrictEqual(Array.from({ length: 5 }, (_, i) => wat.guest_read8(titleBuffer + i)),
    [...Buffer.from('Far '), 0], 'ANSI title read is bounded and terminated');
  assert.ok(hostTitles.length > 0, 'ANSI title change did not reach browser window');

  const wideTitle = wat.guest_alloc(32) >>> 0;
  for (const [i, ch] of [...'Wide Far'].entries()) wat.guest_write16(wideTitle + i * 2, ch.charCodeAt(0));
  wat.guest_write16(wideTitle + 16, 0);
  assert.strictEqual(wat.test_set_console_title_w(wideTitle), 1);
  const wideOut = wat.guest_alloc(32) >>> 0;
  assert.strictEqual(wat.test_get_console_title_w(wideOut, 16), 8);
  assert.deepStrictEqual(Array.from({ length: 9 }, (_, i) => read16(wideOut + i * 2)),
    [...'Wide Far'].map(ch => ch.charCodeAt(0)).concat(0), 'wide title round-trip');

  const first = wat.test_create_console_buffer(1, 0) >>> 0;
  const second = wat.test_create_console_buffer(1, 0) >>> 0;
  assert.ok(first && first !== 0xffffffff, 'first create failed');
  assert.ok(second && second !== 0xffffffff, 'second create failed');
  assert.notStrictEqual(first, second, 'two calls shared one handle');
  assert.strictEqual(first & 0xffff0000, 0x00310000, 'private handle tag');
  assert.notStrictEqual(first, 0x00030001, 'old fixed handle survived');
  assert.strictEqual(wat.test_get_file_type(first), 2, 'screen buffer is FILE_TYPE_CHAR');

  assert.strictEqual(wat.test_set_console_size(first, coord(40, 20)), 1);
  const resizedInfo = info();
  assert.strictEqual(wat.test_get_console_info(first, resizedInfo), 1);
  assert.strictEqual(wat.guest_read32(resizedInfo) >>> 0, coord(40, 20) >>> 0,
    'private buffer size did not change independently');
  assert.strictEqual(wat.test_set_console_size(first, coord(0xffff, 0xffff)), 0);
  assert.strictEqual(wat.test_get_console_info(first, resizedInfo), 1);
  assert.strictEqual(wat.guest_read32(resizedInfo) >>> 0, coord(40, 20) >>> 0,
    'failed resize discarded the previous dimensions');

  const originalActive = wat.test_active_console_buffer() >>> 0;
  assert.strictEqual(originalActive, 0x00030001, 'original buffer starts active');
  const paintBeforeInactiveWrite = paints;
  assert.strictEqual(wat.test_write_console(first, allocText('ONE'), 3), 1);
  assert.strictEqual(wat.test_console_char(first, 0), 'O'.charCodeAt(0));
  assert.strictEqual(wat.test_console_char(second, 0), 32, 'other buffer was modified');
  assert.strictEqual(wat.test_console_char(0x00030001, 0), 32, 'original buffer was modified');
  assert.strictEqual(wat.test_active_console_buffer() >>> 0, originalActive,
    'inactive write changed the active buffer');
  assert.strictEqual(paints, paintBeforeInactiveWrite, 'inactive write repainted browser console');

  assert.strictEqual(wat.test_set_console_cursor(second, coord(5, 4)), 1);
  const firstInfo = info();
  const secondInfo = info();
  assert.strictEqual(wat.test_get_console_info(first, firstInfo), 1);
  assert.strictEqual(wat.test_get_console_info(second, secondInfo), 1);
  assert.strictEqual(wat.guest_read32(firstInfo + 4) >>> 0, coord(3, 0) >>> 0,
    'first cursor follows its write');
  assert.strictEqual(wat.guest_read32(secondInfo + 4) >>> 0, coord(5, 4) >>> 0,
    'second cursor is independent');

  const paintBeforeActivate = paints;
  assert.strictEqual(wat.test_set_active_console_buffer(first), 1);
  assert.strictEqual(wat.test_active_console_buffer() >>> 0, first);
  assert.ok(paints > paintBeforeActivate, 'activation did not repaint browser console');
  const inherited = wat.test_create_console_buffer(1, 0) >>> 0;
  const inheritedInfo = info();
  assert.strictEqual(wat.test_get_console_info(inherited, inheritedInfo), 1);
  assert.strictEqual(wat.guest_read32(inheritedInfo) >>> 0, coord(40, 20) >>> 0,
    'new buffer did not inherit the active display dimensions');
  assert.strictEqual(wat.test_close_console_buffer(inherited), 1);
  const paintBeforeSecondWrite = paints;
  assert.strictEqual(wat.test_write_console(second, allocText('TWO'), 3), 1);
  assert.strictEqual(wat.test_active_console_buffer() >>> 0, first,
    'writing inactive second buffer switched display');
  assert.strictEqual(paints, paintBeforeSecondWrite, 'inactive second buffer repainted');
  assert.strictEqual(wat.test_console_char(first, 0), 'O'.charCodeAt(0));
  assert.strictEqual(wat.test_console_char(second, 4 * 80 + 5), 'T'.charCodeAt(0));

  const readRegion = wat.guest_alloc(8) >>> 0;
  wat.guest_write16(readRegion, 5);
  wat.guest_write16(readRegion + 2, 4);
  wat.guest_write16(readRegion + 4, 7);
  wat.guest_write16(readRegion + 6, 4);
  const charInfoA = wat.guest_alloc(12) >>> 0;
  assert.strictEqual(wat.test_read_console_output_a(second, charInfoA,
    coord(3, 1), coord(0, 0), readRegion), 1);
  assert.deepStrictEqual([0, 1, 2].map(i => wat.guest_read8(charInfoA + i * 4)),
    [...'TWO'].map(ch => ch.charCodeAt(0)), 'ANSI CHAR_INFO characters');
  const charInfoW = wat.guest_alloc(12) >>> 0;
  assert.strictEqual(wat.test_read_console_output_w(second, charInfoW,
    coord(3, 1), coord(0, 0), readRegion), 1);
  assert.deepStrictEqual([0, 1, 2].map(i => read16(charInfoW + i * 4)),
    [...'TWO'].map(ch => ch.charCodeAt(0)), 'wide CHAR_INFO characters');
  assert.strictEqual(wat.test_read_console_output_a(0xffffffff, charInfoA,
    coord(3, 1), coord(0, 0), readRegion), 0, 'invalid console handle accepted');

  assert.strictEqual(wat.test_set_std_output(second), 1);
  assert.strictEqual(wat.test_get_std_output() >>> 0, second,
    'SetStdHandle redirection was not observable through GetStdHandle');

  assert.strictEqual(wat.test_close_console_buffer(first), 0,
    'active screen buffer should retain its live console reference');
  assert.strictEqual(wat.test_set_active_console_buffer(second), 1);
  assert.strictEqual(wat.test_close_console_buffer(first), 1, 'inactive buffer did not close');
  assert.strictEqual(wat.test_write_console(first, allocText('X'), 1), 0,
    'stale buffer handle still accepted writes');
  assert.strictEqual(wat.test_get_console_info(second, secondInfo), 1,
    'closing first buffer invalidated second');

  assert.strictEqual(wat.test_create_console_buffer(0, 0) >>> 0, 0xffffffff,
    'non-text-mode buffer flags accepted');
  assert.strictEqual(wat.test_create_console_buffer(1, 1) >>> 0, 0xffffffff,
    'reserved screen-buffer data accepted');

  console.log('PASS distinct Win98 console screen buffers preserve state, activation, rendering, and lifetime');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
