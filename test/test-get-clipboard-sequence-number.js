#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_clipboard_sequence_number") (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetClipboardSequenceNumber
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_empty_clipboard") (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_EmptyClipboard
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_prepare_clipboard_owner")
    (global.set $clipboard_open (i32.const 1))
    (global.set $clipboard_open_hwnd (i32.const 0x10001))
    (global.set $clipboard_emptied_by_opener (i32.const 0)))

  (func (export "test_set_clipboard_text") (param $memory i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_SetClipboardData
      (i32.const 1) (local.get $memory) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const firstHarness = await bootRenderHarness({ extraWat, fonts: 'none', memory });
  const secondHarness = await bootRenderHarness({ extraWat, fonts: 'none', memory });
  const e = firstHarness.exports;
  const peer = secondHarness.exports;
  const first = e.test_get_clipboard_sequence_number();
  const second = peer.test_get_clipboard_sequence_number();
  const sequence = value => Number(value & 0xffffffffn) >>> 0;

  assert.strictEqual(sequence(first), 1, 'fresh window-station generation is nonzero');
  assert.strictEqual(first, second, 'guest Worker instances observe one shared generation');
  assert.strictEqual(Number(first >> 32n), 0x00300004,
    'zero-argument stdcall pops only the thunk return address');

  assert.strictEqual(e.test_empty_clipboard(), 0,
    'EmptyClipboard still fails outside an open transaction');
  assert.strictEqual(sequence(e.test_get_clipboard_sequence_number()), sequence(first),
    'a failed clipboard mutation does not advance the generation');

  e.test_prepare_clipboard_owner();
  assert.strictEqual(e.test_empty_clipboard(), 1, 'an open owner can empty the clipboard');
  const afterEmpty = e.test_get_clipboard_sequence_number();
  assert.strictEqual(sequence(afterEmpty), sequence(first) + 1,
    'successful EmptyClipboard advances the generation once');
  assert.strictEqual(sequence(peer.test_get_clipboard_sequence_number()), sequence(afterEmpty),
    'the second guest Worker sees the empty operation');

  assert.strictEqual(e.test_set_clipboard_text(0), 0,
    'a failed materialization returns NULL');
  assert.strictEqual(sequence(e.test_get_clipboard_sequence_number()), sequence(afterEmpty),
    'a failed SetClipboardData does not advance the generation');

  const text = e.guest_alloc(2) >>> 0;
  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  bytes[(text - imageBase + guestBase) >>> 0] = 65;
  bytes[((text - imageBase + guestBase) + 1) >>> 0] = 0;
  assert.strictEqual(e.test_set_clipboard_text(text) >>> 0, text,
    'CF_TEXT materializes into clipboard ownership');
  const afterText = e.test_get_clipboard_sequence_number();
  assert.strictEqual(sequence(afterText), sequence(afterEmpty) + 1,
    'successful SetClipboardData advances the generation once');
  assert.strictEqual(sequence(peer.test_get_clipboard_sequence_number()), sequence(afterText),
    'the second guest Worker sees the new clipboard format');

  console.log('PASS clipboard sequence tracks successful mutations across guest Workers');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
