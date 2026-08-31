#!/usr/bin/env node

'use strict';

// The console keyboard side: the shared input queue that ReadConsoleA,
// ReadConsoleInputA, PeekConsoleInputA and GetNumberOfConsoleInputEvents all
// read. telnet.exe hangs forever without it — its worker thread calls
// ReadConsoleW in a loop and spins on whatever it returns.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_console_reset")
    (i32.store (global.get $CONSOLE_INPUT) (i32.const 0))
    (i32.store (i32.add (global.get $CONSOLE_INPUT) (i32.const 4)) (i32.const 0))
    (i32.store (i32.add (global.get $CONSOLE_INPUT) (i32.const 12)) (i32.const 0))
    (i32.store (i32.add (global.get $CONSOLE_INPUT) (i32.const 24)) (i32.const 0))
    (global.set $yield_flag (i32.const 0))
    (global.set $yield_reason (i32.const 0))
    (global.set $handler_set_eip (i32.const 0)))

  (func (export "test_console_push") (param $ch i32) (param $vk i32)
    (call $console_input_push (local.get $ch) (local.get $vk)))

  (func (export "test_console_ensure_window")
    (call $console_ensure_window))

  (func (export "test_console_count") (result i32)
    (call $console_input_count))

  (func (export "test_console_set_mode") (param $mode i32)
    (call $console_input_set_mode (local.get $mode)))

  (func (export "test_console_mode") (result i32)
    (call $console_input_mode))

  (func (export "test_yield_flag") (result i32)
    (global.get $yield_flag))

  (func (export "test_alloc") (param $n i32) (result i32)
    (call $heap_alloc (local.get $n)))

  (func (export "test_peek8") (param $g i32) (result i32)
    (i32.load8_u (call $g2w (local.get $g))))

  (func (export "test_peek16") (param $g i32) (result i32)
    (i32.load16_u (call $g2w (local.get $g))))

  (func (export "test_peek32") (param $g i32) (result i32)
    (i32.load (call $g2w (local.get $g))))

  (func (export "test_call_ReadConsoleA") (param $buf i32) (param $max i32) (param $pread i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_ReadConsoleA
      (i32.const 1) (local.get $buf) (local.get $max) (local.get $pread)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetNumberOfConsoleInputEvents") (param $out i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetNumberOfConsoleInputEvents
      (i32.const 1) (local.get $out) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_PeekConsoleInputA") (param $buf i32) (param $nrec i32) (param $pread i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_PeekConsoleInputA
      (i32.const 1) (local.get $buf) (local.get $nrec) (local.get $pread)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_ReadConsoleInputA") (param $buf i32) (param $nrec i32) (param $pread i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_ReadConsoleInputA
      (i32.const 1) (local.get $buf) (local.get $nrec) (local.get $pread)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_FlushConsoleInputBuffer") (param $handle i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_FlushConsoleInputBuffer
      (local.get $handle) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DuplicateConsoleHandle")
        (param $handle i32) (param $target i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DuplicateHandle
      (i32.const -1) (local.get $handle) (i32.const -1)
      (local.get $target) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_CloseHandle") (param $handle i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_CloseHandle
      (local.get $handle) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetFileType") (param $handle i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetFileType
      (local.get $handle) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  ;; Tab expansion lives in the character writer, so drive it directly.
  (func (export "test_put_chars") (param $a i32) (param $b i32) (param $c i32)
    (call $console_cells_ensure)
    (global.set $console_cursor_x (i32.const 0))
    (global.set $console_cursor_y (i32.const 0))
    (call $console_put_char (local.get $a))
    (call $console_put_char (local.get $b))
    (call $console_put_char (local.get $c)))

  (func (export "test_cursor_x") (result i32)
    (global.get $console_cursor_x))

  (func (export "test_cell_char") (param $i i32) (result i32)
    (i32.load16_u (i32.add (global.get $CONSOLE_TEXT) (i32.mul (local.get $i) (i32.const 2)))))
`;

function pushString(e, text) {
  for (const ch of text) e.test_console_push(ch.charCodeAt(0), 0);
}

function readAnsi(e, buf, n) {
  let out = '';
  for (let i = 0; i < n; i++) out += String.fromCharCode(e.test_peek8(buf + i));
  return out;
}

(async () => {
  const hostEvents = [];
  let lastHostEvent = null;
  const { exports: e } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      check_input: () => {
        lastHostEvent = hostEvents.shift() || null;
        return lastHostEvent ? lastHostEvent.packed : 0;
      },
      check_input_hwnd: () => lastHostEvent ? lastHostEvent.hwnd : 0,
      check_input_lparam: () => lastHostEvent ? lastHostEvent.lparam : 0,
      check_input_wparam: () => lastHostEvent ? lastHostEvent.wparam : 0,
    },
  });

  const buf = e.test_alloc(256);
  const pread = e.test_alloc(4);
  assert.ok(buf, 'heap allocation succeeded');

  // --- line mode: an incomplete line still blocks -------------------------
  e.test_console_reset();
  e.test_console_set_mode(3);            // PROCESSED_INPUT | LINE_INPUT
  assert.strictEqual(e.test_console_mode(), 3, 'SetConsoleMode is visible to readers');
  pushString(e, 'hi');
  e.test_call_ReadConsoleA(buf, 256, pread);
  assert.strictEqual(e.test_yield_flag(), 1,
    'no Enter yet, so the read parks instead of returning a short line');
  assert.strictEqual(e.test_console_count(), 2, 'a parked read consumes nothing');

  // --- line mode: Enter completes it, and reads back as CRLF --------------
  e.test_console_push(13, 0x0D);
  assert.strictEqual(e.test_call_ReadConsoleA(buf, 256, pread), 1);
  assert.strictEqual(e.test_peek32(pread), 4, 'hi + CR + LF');
  assert.strictEqual(readAnsi(e, buf, 4), 'hi\r\n');
  assert.strictEqual(e.test_console_count(), 0, 'the whole line is drained');

  // --- raw mode: whatever is queued comes back immediately ----------------
  e.test_console_reset();
  e.test_console_set_mode(0);
  pushString(e, 'ab');
  assert.strictEqual(e.test_call_ReadConsoleA(buf, 256, pread), 1,
    'without LINE_INPUT there is nothing to wait for');
  assert.strictEqual(e.test_peek32(pread), 2);
  assert.strictEqual(readAnsi(e, buf, 2), 'ab');

  // --- event count / peek / read ------------------------------------------
  e.test_console_reset();
  e.test_console_set_mode(0);
  e.test_console_push(0x41, 0x41);
  e.test_console_push(0, 0x70);          // F1: a key with no character
  assert.strictEqual(e.test_call_GetNumberOfConsoleInputEvents(pread), 1);
  assert.strictEqual(e.test_peek32(pread), 2);

  assert.strictEqual(e.test_call_PeekConsoleInputA(buf, 2, pread), 1);
  assert.strictEqual(e.test_peek32(pread), 2);
  assert.strictEqual(e.test_peek16(buf), 1, 'KEY_EVENT');
  assert.strictEqual(e.test_peek32(buf + 4), 1, 'bKeyDown');
  assert.strictEqual(e.test_peek16(buf + 10), 0x41, 'wVirtualKeyCode');
  assert.strictEqual(e.test_peek16(buf + 14), 0x41, 'uChar');
  assert.strictEqual(e.test_peek16(buf + 20 + 10), 0x70, 'second record is F1');
  assert.strictEqual(e.test_console_count(), 2, 'Peek is non-destructive');

  assert.strictEqual(e.test_call_ReadConsoleInputA(buf, 1, pread), 1);
  assert.strictEqual(e.test_peek32(pread), 1);
  assert.strictEqual(e.test_console_count(), 1, 'ReadConsoleInput drains what it returned');

  // --- browser keyboard events enter the console without a USER pump ------
  e.test_console_reset();
  e.test_console_ensure_window();
  hostEvents.push(
    { packed: (0x78 << 16) | 0x0100, wparam: 0x78, hwnd: 0,
      lparam: 1 | (0x43 << 16) }, // F9 down
    { packed: (0x78 << 16) | 0x0101, wparam: 0x78, hwnd: 0,
      lparam: (1 | (0x43 << 16) | 0xc0000000) >>> 0 }, // F9 up
  );
  assert.strictEqual(e.test_call_PeekConsoleInputA(buf, 2, pread), 1);
  assert.strictEqual(e.test_call_PeekConsoleInputA(buf, 2, pread), 1);
  assert.strictEqual(e.test_peek32(pread), 2, 'host F9 edges did not become console input');
  assert.strictEqual(e.test_peek16(buf + 10), 0x78, 'host virtual key was not preserved');
  assert.strictEqual(e.test_peek16(buf + 12), 0x43, 'host scan code was not preserved');
  assert.strictEqual(e.test_peek32(buf + 20 + 4), 0, 'F9 key-up reports bKeyDown=FALSE');
  assert.strictEqual(e.test_peek16(buf + 20 + 12), 0x43, 'key-up scan code was lost');
  assert.strictEqual(e.test_call_ReadConsoleInputA(buf, 2, pread), 1);
  assert.strictEqual(e.test_peek16(buf + 10), 0x78, 'queued F9 changed before read');
  assert.strictEqual(e.test_console_count(), 0, 'host key edges were not consumed');

  // Printable WM_CHAR augments its key-down instead of creating a duplicate;
  // modifier state and hardware metadata survive both edges.
  e.test_console_reset();
  hostEvents.push(
    { packed: (0x10 << 16) | 0x0100, wparam: 0x10, hwnd: 0,
      lparam: 1 | (0x2a << 16) },                         // Shift down
    { packed: (0x41 << 16) | 0x0100, wparam: 0x41, hwnd: 0,
      lparam: 1 | (0x1e << 16) },                         // A down
    { packed: (0x61 << 16) | 0x0102, wparam: 0x61, hwnd: 0, lparam: 1 },
    { packed: (0x41 << 16) | 0x0101, wparam: 0x41, hwnd: 0,
      lparam: (1 | (0x1e << 16) | 0xc0000000) >>> 0 },    // A up
    { packed: (0x10 << 16) | 0x0101, wparam: 0x10, hwnd: 0,
      lparam: (1 | (0x2a << 16) | 0xc0000000) >>> 0 },    // Shift up
  );
  for (let i = 0; i < 5; i++) e.test_call_PeekConsoleInputA(buf, 4, pread);
  assert.strictEqual(e.test_peek32(pread), 4,
    'WM_CHAR must merge into four hardware edges, not become a fifth record');
  assert.strictEqual(e.test_peek32(buf + 4), 1, 'Shift down is a key-down');
  assert.strictEqual(e.test_peek16(buf + 12), 0x2a, 'Shift scan code');
  assert.strictEqual(e.test_peek32(buf + 16), 0x10, 'Shift-down control state');
  assert.strictEqual(e.test_peek16(buf + 20 + 10), 0x41, 'A virtual key');
  assert.strictEqual(e.test_peek16(buf + 20 + 12), 0x1e, 'A scan code');
  assert.strictEqual(e.test_peek16(buf + 20 + 14), 0x61,
    'WM_CHAR is attached to the A key-down');
  assert.strictEqual(e.test_peek32(buf + 20 + 16), 0x10,
    'A key-down sees Shift pressed');
  assert.strictEqual(e.test_peek32(buf + 40 + 4), 0, 'A key-up is retained');
  assert.strictEqual(e.test_peek32(buf + 40 + 16), 0x10,
    'A key-up still sees Shift pressed');
  assert.strictEqual(e.test_peek32(buf + 60 + 4), 0, 'Shift key-up is retained');
  assert.strictEqual(e.test_peek32(buf + 60 + 16), 0,
    'Shift key-up clears persistent modifier state');
  e.test_call_ReadConsoleInputA(buf, 4, pread);

  e.test_console_reset();
  hostEvents.push(
    { packed: (0x31 << 16) | 0x0100, wparam: 0x31, hwnd: 0,
      lparam: 1 | (0x02 << 16) },
    { packed: (0x21 << 16) | 0x0102, wparam: 0x21, hwnd: 0, lparam: 1 },
  );
  e.test_call_PeekConsoleInputA(buf, 2, pread);
  e.test_call_PeekConsoleInputA(buf, 2, pread);
  assert.strictEqual(e.test_peek32(pread), 1,
    'shifted punctuation merges into its physical number-row key');
  assert.strictEqual(e.test_peek16(buf + 10), 0x31, 'exclamation mark keeps VK_1');
  assert.strictEqual(e.test_peek16(buf + 14), 0x21, 'exclamation mark character is retained');
  e.test_call_ReadConsoleInputA(buf, 1, pread);

  // Enhanced right-control is event-local; lock state is toggled once, not
  // once per autorepeat record.
  e.test_console_reset();
  hostEvents.push(
    { packed: (0x11 << 16) | 0x0100, wparam: 0x11, hwnd: 0,
      lparam: 1 | (0x1d << 16) | 0x01000000 },
    { packed: (0x11 << 16) | 0x0101, wparam: 0x11, hwnd: 0,
      lparam: (1 | (0x1d << 16) | 0x01000000 | 0xc0000000) >>> 0 },
    { packed: (0x14 << 16) | 0x0100, wparam: 0x14, hwnd: 0,
      lparam: 1 | (0x3a << 16) },
    { packed: (0x14 << 16) | 0x0100, wparam: 0x14, hwnd: 0,
      lparam: 1 | (0x3a << 16) | 0x40000000 },
  );
  for (let i = 0; i < 4; i++) e.test_call_PeekConsoleInputA(buf, 4, pread);
  assert.strictEqual(e.test_peek32(buf + 16), 0x104,
    'enhanced Ctrl-down reports RIGHT_CTRL_PRESSED|ENHANCED_KEY');
  assert.strictEqual(e.test_peek32(buf + 20 + 16), 0x100,
    'Ctrl-up clears right-control but retains event-local ENHANCED_KEY');
  assert.strictEqual(e.test_peek32(buf + 40 + 16), 0x80,
    'fresh CapsLock down turns CAPSLOCK_ON on');
  assert.strictEqual(e.test_peek32(buf + 60 + 16), 0x80,
    'CapsLock autorepeat does not toggle CAPSLOCK_ON back off');
  e.test_call_ReadConsoleInputA(buf, 4, pread);

  // --- ENABLE_MOUSE_INPUT exposes real MOUSE_EVENT_RECORDs ----------------
  e.test_console_reset();
  e.test_console_set_mode(0);
  hostEvents.push({ packed: 0x0200, wparam: 0, hwnd: 0x10001,
    lparam: (24 << 16) | 40 });
  assert.strictEqual(e.test_call_PeekConsoleInputA(buf, 1, pread), 1);
  assert.strictEqual(e.test_peek32(pread), 0,
    'mouse input is discarded while ENABLE_MOUSE_INPUT is clear');

  e.test_console_set_mode(0x10);
  hostEvents.push({ packed: (0x0c << 16) | 0x0200, wparam: 0x0c, hwnd: 0x10001,
    lparam: (24 << 16) | 40 });
  assert.strictEqual(e.test_call_PeekConsoleInputA(buf, 1, pread), 1);
  assert.strictEqual(e.test_peek32(pread), 1);
  assert.strictEqual(e.test_peek16(buf), 2, 'MOUSE_EVENT');
  assert.strictEqual(e.test_peek16(buf + 4), 5, 'pixel x becomes an 8px character cell');
  assert.strictEqual(e.test_peek16(buf + 6), 2, 'pixel y becomes a 12px character cell');
  assert.strictEqual(e.test_peek32(buf + 8), 0, 'move has no pressed buttons');
  assert.strictEqual(e.test_peek32(buf + 12), 0x18,
    'MK_CONTROL/MK_SHIFT become console control-key state');
  assert.strictEqual(e.test_peek32(buf + 16), 1, 'MOUSE_MOVED');
  assert.strictEqual(e.test_call_ReadConsoleInputA(buf, 1, pread), 1);

  hostEvents.push({ packed: (1 << 16) | 0x0201, wparam: 1, hwnd: 0x10001,
    lparam: (36 << 16) | 80 });
  assert.strictEqual(e.test_call_ReadConsoleInputA(buf, 1, pread), 1);
  assert.strictEqual(e.test_peek16(buf), 2);
  assert.strictEqual(e.test_peek16(buf + 4), 10);
  assert.strictEqual(e.test_peek16(buf + 6), 3);
  assert.strictEqual(e.test_peek32(buf + 8), 1,
    'left button maps to FROM_LEFT_1ST_BUTTON_PRESSED');
  assert.strictEqual(e.test_peek32(buf + 16), 0,
    'button transitions have zero event flags');

  hostEvents.push({ packed: (1 << 16) | 0x020A, wparam: (120 << 16) | 1,
    hwnd: 0x10001, lparam: (12 << 16) | 16 });
  assert.strictEqual(e.test_call_ReadConsoleInputA(buf, 1, pread), 1);
  assert.strictEqual(e.test_peek32(buf + 8), (120 << 16) | 1,
    'wheel delta remains in dwButtonState high word');
  assert.strictEqual(e.test_peek32(buf + 16), 4, 'MOUSE_WHEELED');

  hostEvents.push({ packed: 0x0200, wparam: 0, hwnd: 0x10001,
    lparam: (12 << 16) | 8 });
  e.test_console_set_mode(0x10);
  assert.strictEqual(e.test_call_PeekConsoleInputA(buf, 1, pread), 1);
  e.test_console_push(0x5a, 0x5a);
  assert.strictEqual(e.test_call_ReadConsoleA(buf, 1, pread), 1);
  assert.strictEqual(e.test_peek32(pread), 1);
  assert.strictEqual(readAnsi(e, buf, 1), 'Z',
    'high-level ReadConsole filters mouse records and returns keyboard text');

  // --- flushing drains valid input handles but preserves data on failure ---
  e.test_console_push(0x42, 0x42);
  assert.strictEqual(e.test_console_count(), 1);
  assert.strictEqual(e.test_call_FlushConsoleInputBuffer(0xffffffff), 0);
  assert.strictEqual(e.test_console_count(), 1, 'invalid flush consumed queued input');
  assert.strictEqual(e.test_call_FlushConsoleInputBuffer(1), 1);
  assert.strictEqual(e.test_console_count(), 0, 'valid flush did not drain the queue');

  // DuplicateHandle returns independent process handles for the same console
  // input object. Closing one alias must not close another (or stdin itself),
  // and a stale generation must not revive when the slot is reused.
  const duplicateOut = e.test_alloc(4) >>> 0;
  assert.strictEqual(e.test_call_DuplicateConsoleHandle(1, duplicateOut), 1);
  const duplicate = e.test_peek32(duplicateOut) >>> 0;
  assert.notStrictEqual(duplicate, 1, 'DuplicateHandle copied the stdin number');
  assert.strictEqual(duplicate & 0xffff0000, 0x00320000,
    'duplicated stdin does not use the console-alias handle class');
  assert.strictEqual(e.test_call_GetFileType(duplicate), 2,
    'duplicated stdin is not FILE_TYPE_CHAR');

  assert.strictEqual(e.test_call_DuplicateConsoleHandle(duplicate, duplicateOut), 1);
  const secondDuplicate = e.test_peek32(duplicateOut) >>> 0;
  assert.notStrictEqual(secondDuplicate, duplicate,
    'duplicating an alias did not allocate an independent handle');

  e.test_console_push(0x43, 0x43);
  assert.strictEqual(e.test_call_FlushConsoleInputBuffer(duplicate), 1);
  assert.strictEqual(e.test_console_count(), 0,
    'duplicated stdin did not address the shared input queue');
  assert.strictEqual(e.test_call_CloseHandle(duplicate), 1);

  e.test_console_push(0x44, 0x44);
  assert.strictEqual(e.test_call_FlushConsoleInputBuffer(duplicate), 0,
    'closed console alias remained usable');
  assert.strictEqual(e.test_console_count(), 1,
    'stale alias consumed console input');
  assert.strictEqual(e.test_call_FlushConsoleInputBuffer(secondDuplicate), 1,
    'closing one alias invalidated another alias');
  assert.strictEqual(e.test_console_count(), 0);
  assert.strictEqual(e.test_call_CloseHandle(secondDuplicate), 1);
  assert.strictEqual(e.test_call_FlushConsoleInputBuffer(1), 1,
    'closing aliases invalidated the original stdin handle');

  // --- an empty queue parks ReadConsoleInput too ---------------------------
  e.test_console_reset();
  // A park leaves EAX alone — the call has not returned to the guest yet — so
  // the yield flag is the only thing worth asserting on.
  e.test_call_ReadConsoleInputA(buf, 1, pread);
  assert.strictEqual(e.test_yield_flag(), 1);

  // --- tabs advance to the next 8-column stop ------------------------------
  e.test_console_reset();
  e.test_put_chars(0x63, 9, 0x78);        // 'c', TAB, 'x'
  assert.strictEqual(e.test_cursor_x(), 9, 'TAB from column 1 lands on column 8');
  assert.strictEqual(e.test_cell_char(0), 0x63);
  assert.strictEqual(e.test_cell_char(1), 32, 'the tab is padded with spaces');
  assert.strictEqual(e.test_cell_char(8), 0x78);

  console.log('PASS  console input queue: reads, mouse, handle aliases, flush, tab stops');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
