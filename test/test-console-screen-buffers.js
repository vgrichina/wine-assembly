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
  (func (export "test_set_console_window") (param $handle i32) (param $absolute i32)
        (param $rect i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_SetConsoleWindowInfo
      (local.get $handle) (local.get $absolute) (local.get $rect)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_last_error") (result i32)
    (global.get $last_error))
  (func (export "test_set_last_error") (param $value i32)
    (global.set $last_error (local.get $value)))
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
  (func (export "test_create_file_a") (param $name i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_CreateFileA
      (local.get $name) (i32.const 0xc0000000) (i32.const 3)
      (i32.const 0) (i32.const 3) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
  (func (export "test_create_file_w") (param $name i32) (result i32)
    (local $saved i32)
    (local.set $saved (global.get $esp))
    (call $handle_CreateFileW
      (local.get $name) (i32.const 0xc0000000) (i32.const 3)
      (i32.const 0) (i32.const 3) (i32.const 0))
    (global.set $esp (local.get $saved))
    (global.get $eax))
`;

(async () => {
  let paints = 0;
  const hostTitles = [];
  const { exports: wat, renderer } = await bootRenderHarness({
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
  const allocWide = text => {
    const ptr = wat.guest_alloc((text.length + 1) * 2) >>> 0;
    for (let i = 0; i < text.length; i++) wat.guest_write16(ptr + i * 2, text.charCodeAt(i));
    wat.guest_write16(ptr + text.length * 2, 0);
    return ptr;
  };
  const info = () => wat.guest_alloc(22) >>> 0;
  const coord = (x, y) => (x & 0xffff) | ((y & 0xffff) << 16);
  const read16 = ptr => wat.guest_read8(ptr) | (wat.guest_read8(ptr + 1) << 8);
  const readS16 = ptr => (read16(ptr) << 16) >> 16;
  const writeRect = (ptr, left, top, right, bottom) => {
    wat.guest_write16(ptr, left);
    wat.guest_write16(ptr + 2, top);
    wat.guest_write16(ptr + 4, right);
    wat.guest_write16(ptr + 6, bottom);
  };
  const readRect = ptr => [0, 2, 4, 6].map(offset => readS16(ptr + offset));

  const titleBuffer = wat.guest_alloc(32) >>> 0;
  assert.strictEqual(wat.test_create_file_a(allocText('conin$')), 1,
    'case-insensitive CONIN$ did not open console input');
  assert.strictEqual(wat.test_create_file_a(allocText('CONOUT$')), 2,
    'CONOUT$ did not open active console output');
  const wideConout = wat.guest_alloc(16) >>> 0;
  for (const [i, ch] of [...'ConOut$'].entries()) wat.guest_write16(wideConout + i * 2, ch.charCodeAt(0));
  wat.guest_write16(wideConout + 14, 0);
  assert.strictEqual(wat.test_create_file_w(wideConout), 2,
    'wide mixed-case CONOUT$ did not open console output');
  wat.test_set_last_error(87);
  assert.strictEqual(wat.test_create_file_a(allocText('C:\\missing-save.0')) >>> 0,
    0xffffffff, 'missing ANSI file unexpectedly opened');
  assert.strictEqual(wat.test_last_error(), 2,
    'missing ANSI CreateFile did not publish ERROR_FILE_NOT_FOUND');
  const wideMissing = wat.guest_alloc(40) >>> 0;
  for (const [i, ch] of [...'C:\\missing-wide.0'].entries()) {
    wat.guest_write16(wideMissing + i * 2, ch.charCodeAt(0));
  }
  wat.guest_write16(wideMissing + 'C:\\missing-wide.0'.length * 2, 0);
  wat.test_set_last_error(87);
  assert.strictEqual(wat.test_create_file_w(wideMissing) >>> 0, 0xffffffff,
    'missing Unicode file unexpectedly opened');
  assert.strictEqual(wat.test_last_error(), 2,
    'missing Unicode CreateFile did not publish ERROR_FILE_NOT_FOUND');
  assert.strictEqual(wat.test_console_title_first_byte(), 'C'.charCodeAt(0),
    'default console title storage was not initialized');
  assert.strictEqual(wat.test_get_console_title_a(titleBuffer, 32), 7);
  assert.deepStrictEqual(Array.from({ length: 8 }, (_, i) => wat.guest_read8(titleBuffer + i)),
    [...Buffer.from('Console'), 0], 'initial ANSI console title');
  assert.strictEqual(wat.test_set_console_title_a(0), 0,
    'SetConsoleTitleA accepted a NULL title');
  assert.strictEqual(wat.test_last_error(), 87,
    'NULL SetConsoleTitleA did not set ERROR_INVALID_PARAMETER');
  assert.strictEqual(wat.test_get_console_title_a(titleBuffer, 32), 7,
    'failed SetConsoleTitleA changed the current title');
  assert.strictEqual(wat.test_set_console_title_a(allocText('Far Manager')), 1);
  assert.strictEqual(wat.test_get_console_title_a(titleBuffer, 5), 4);
  assert.deepStrictEqual(Array.from({ length: 5 }, (_, i) => wat.guest_read8(titleBuffer + i)),
    [...Buffer.from('Far '), 0], 'ANSI title read is bounded and terminated');
  wat.guest_write8(titleBuffer, 0x7f);
  assert.strictEqual(wat.test_get_console_title_a(titleBuffer, 1), 0,
    'one-byte ANSI title buffer returned a character');
  assert.strictEqual(wat.guest_read8(titleBuffer), 0,
    'one-byte ANSI title buffer was not terminated');
  assert.ok(hostTitles.length > 0, 'ANSI title change did not reach browser window');
  const consoleWindow = Object.values(renderer.windows).find(win =>
    (win.style >>> 0) === 0x10cf0000);
  assert.ok(consoleWindow, 'console window was not created');
  renderer._computeClientRect(consoleWindow);
  assert.deepStrictEqual([consoleWindow.w, consoleWindow.h], [648, 328],
    'console cell dimensions were passed as outer window dimensions');
  assert.deepStrictEqual([consoleWindow.clientRect.w, consoleWindow.clientRect.h], [640, 300],
    '80x25 console client was clipped by non-client chrome');

  assert.strictEqual(wat.test_set_console_title_w(allocWide('Wide Far')), 1);
  const wideOut = wat.guest_alloc(32) >>> 0;
  assert.strictEqual(wat.test_get_console_title_w(wideOut, 16), 8);
  assert.deepStrictEqual(Array.from({ length: 9 }, (_, i) => read16(wideOut + i * 2)),
    [...'Wide Far'].map(ch => ch.charCodeAt(0)).concat(0), 'wide title round-trip');
  wat.guest_write16(wideOut, 0x7f7f);
  assert.strictEqual(wat.test_get_console_title_w(wideOut, 1), 0,
    'one-character wide title buffer returned a character');
  assert.strictEqual(read16(wideOut), 0,
    'one-character wide title buffer was not terminated');
  assert.strictEqual(wat.test_set_console_title_w(0), 0,
    'SetConsoleTitleW accepted a NULL title');
  assert.strictEqual(wat.test_last_error(), 87,
    'NULL SetConsoleTitleW did not set ERROR_INVALID_PARAMETER');
  assert.strictEqual(wat.test_get_console_title_w(wideOut, 16), 8,
    'failed SetConsoleTitleW changed the current title');

  assert.strictEqual(wat.test_set_console_title_a(allocText('')), 1,
    'SetConsoleTitleA rejected an empty title');
  assert.strictEqual(wat.test_get_console_title_a(titleBuffer, 32), 0,
    'empty ANSI console title was mistaken for uninitialized state');
  assert.strictEqual(wat.guest_read8(titleBuffer), 0,
    'empty ANSI console title was not terminated');
  assert.strictEqual(wat.test_get_console_title_w(wideOut, 16), 0,
    'empty console title was not shared with GetConsoleTitleW');
  assert.strictEqual(read16(wideOut), 0,
    'empty wide console title was not terminated');

  const first = wat.test_create_console_buffer(1, 0) >>> 0;
  const second = wat.test_create_console_buffer(1, 0) >>> 0;
  assert.ok(first && first !== 0xffffffff, 'first create failed');
  assert.ok(second && second !== 0xffffffff, 'second create failed');
  assert.notStrictEqual(first, second, 'two calls shared one handle');
  assert.strictEqual(first & 0xffff0000, 0x00310000, 'private handle tag');
  assert.notStrictEqual(first, 0x00030001, 'old fixed handle survived');
  assert.strictEqual(wat.test_get_file_type(first), 2, 'screen buffer is FILE_TYPE_CHAR');

  const windowRect = wat.guest_alloc(8) >>> 0;
  writeRect(windowRect, 0, 0, 39, 19);
  assert.strictEqual(wat.test_set_console_window(first, 1, windowRect), 1,
    'absolute viewport shrink failed');
  const resizedInfo = info();
  assert.strictEqual(wat.test_get_console_info(first, resizedInfo), 1);
  assert.deepStrictEqual(readRect(resizedInfo + 10), [0, 0, 39, 19],
    'GetConsoleScreenBufferInfo omitted the independent viewport');
  assert.strictEqual(wat.test_set_console_size(first, coord(40, 20)), 1,
    'buffer did not shrink after its viewport');
  assert.strictEqual(wat.test_get_console_info(first, resizedInfo), 1);
  assert.strictEqual(wat.guest_read32(resizedInfo) >>> 0, coord(40, 20) >>> 0,
    'private buffer size did not change independently');

  writeRect(windowRect, 0, 0, 40, 19);
  assert.strictEqual(wat.test_set_console_window(first, 1, windowRect), 0,
    'viewport extending beyond the backing buffer succeeded');
  assert.strictEqual(wat.test_last_error(), 87, 'bad viewport did not set ERROR_INVALID_PARAMETER');
  assert.strictEqual(wat.test_get_console_info(first, resizedInfo), 1);
  assert.deepStrictEqual(readRect(resizedInfo + 10), [0, 0, 39, 19],
    'failed viewport update changed the previous rectangle');
  assert.strictEqual(wat.test_set_console_window(first, 1, 0), 0,
    'NULL viewport pointer succeeded');
  assert.strictEqual(wat.test_last_error(), 87, 'NULL viewport did not set ERROR_INVALID_PARAMETER');
  assert.strictEqual(wat.test_set_console_window(0xffffffff, 1, windowRect), 0,
    'invalid console handle accepted a viewport');
  assert.strictEqual(wat.test_last_error(), 6, 'invalid viewport handle did not set ERROR_INVALID_HANDLE');

  assert.strictEqual(wat.test_set_console_size(first, coord(60, 30)), 1,
    'buffer enlargement failed');
  writeRect(windowRect, 5, 2, 5, 2);
  assert.strictEqual(wat.test_set_console_window(first, 0, windowRect), 1,
    'relative viewport move failed');
  assert.strictEqual(wat.test_get_console_info(first, resizedInfo), 1);
  assert.deepStrictEqual(readRect(resizedInfo + 10), [5, 2, 44, 21],
    'relative viewport did not offset all four current sides');
  assert.strictEqual(wat.test_set_console_size(first, coord(40, 20)), 0,
    'buffer shrank underneath an offset viewport');
  writeRect(windowRect, 0, 0, 39, 19);
  assert.strictEqual(wat.test_set_console_window(first, 1, windowRect), 1);
  assert.strictEqual(wat.test_set_console_size(first, coord(40, 20)), 1);
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
  renderer._computeClientRect(consoleWindow);
  assert.deepStrictEqual([consoleWindow.w, consoleWindow.h], [328, 268],
    'active viewport did not resize the console outer window');
  assert.deepStrictEqual([consoleWindow.clientRect.w, consoleWindow.clientRect.h], [320, 240],
    '40x20 viewport did not become the browser console client');
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

  for (const [label, readOutput] of [
    ['ANSI', wat.test_read_console_output_a],
    ['wide', wat.test_read_console_output_w],
  ]) {
    // Request a 5x4 source block into a 3x2 destination starting at (1,1).
    // Only two cells on the destination's final row correspond to storage.
    // Guard bytes on both sides turn the old unchecked Y walk into a stable
    // executable failure instead of relying on where guest_alloc lands next.
    const guarded = wat.guest_alloc(40) >>> 0;
    for (let i = 0; i < 40; i++) wat.guest_write8(guarded + i, 0xa5);
    const clippedBuffer = guarded + 8;
    writeRect(readRegion, 4, 3, 8, 6);
    assert.strictEqual(readOutput(second, clippedBuffer,
      coord(3, 2), coord(1, 1), readRegion), 1, `${label} clipped read failed`);
    assert.deepStrictEqual(readRect(readRegion), [4, 3, 5, 3],
      `${label} read did not report the actual copied screen rectangle`);
    assert.deepStrictEqual(
      Array.from({ length: 8 }, (_, i) => wat.guest_read8(guarded + i)),
      Array(8).fill(0xa5), `${label} read overwrote its leading guard`);
    assert.deepStrictEqual(
      Array.from({ length: 8 }, (_, i) => wat.guest_read8(guarded + 32 + i)),
      Array(8).fill(0xa5), `${label} read exceeded dwBufferSize.Y`);
    assert.deepStrictEqual(
      Array.from({ length: 16 }, (_, i) => wat.guest_read8(clippedBuffer + i)),
      Array(16).fill(0xa5), `${label} read changed non-corresponding destination cells`);
    assert.notStrictEqual(wat.guest_read32(clippedBuffer + 16) >>> 0, 0xa5a5a5a5,
      `${label} read omitted its first in-bounds cell`);
    assert.notStrictEqual(wat.guest_read32(clippedBuffer + 20) >>> 0, 0xa5a5a5a5,
      `${label} read omitted its second in-bounds cell`);
  }

  const edgeBuffer = wat.guest_alloc(16) >>> 0;
  for (let i = 0; i < 16; i++) wat.guest_write8(edgeBuffer + i, 0xa5);
  writeRect(readRegion, -1, 4, 2, 4);
  assert.strictEqual(wat.test_read_console_output_a(second, edgeBuffer,
    coord(4, 1), coord(0, 0), readRegion), 1, 'source-edge clipped read failed');
  assert.deepStrictEqual(readRect(readRegion), [0, 4, 2, 4],
    'source clipping did not update lpReadRegion');
  assert.strictEqual(wat.guest_read32(edgeBuffer) >>> 0, 0xa5a5a5a5,
    'off-screen source cell should leave its corresponding destination unchanged');

  for (let i = 0; i < 16; i++) wat.guest_write8(edgeBuffer + i, 0xa5);
  writeRect(readRegion, 90, 30, 93, 30);
  assert.strictEqual(wat.test_read_console_output_w(second, edgeBuffer,
    coord(4, 1), coord(0, 0), readRegion), 1, 'fully clipped read failed');
  assert.deepStrictEqual(readRect(readRegion), [0, 0, -1, -1],
    'fully clipped read did not return an empty rectangle');
  assert.deepStrictEqual(
    Array.from({ length: 16 }, (_, i) => wat.guest_read8(edgeBuffer + i)),
    Array(16).fill(0xa5), 'fully clipped read changed destination cells');

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
