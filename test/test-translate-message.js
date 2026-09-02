#!/usr/bin/env node
'use strict';

// USER's TranslateMessage does not mutate MSG. In the browser path the host
// has already translated the DOM event and queued its WM_CHAR partner, so the
// WAT boundary owns the remaining observable contract: all four virtual-key
// message kinds return TRUE and unrelated messages return FALSE.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_translate_message") (param $msg i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_TranslateMessage
      (local.get $msg) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const msg = e.guest_alloc(28) >>> 0;
  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const msgWA = (msg - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);

  const seed = Uint8Array.from([
    0x34, 0x12, 0x01, 0x00, 0, 0, 0, 0,
    0x41, 0, 0, 0, 1, 0, 0, 0,
    0x78, 0x56, 0x34, 0x12, 9, 0, 7, 0,
    4, 0, 0, 0,
  ]);
  bytes.set(seed, msgWA);

  const translate = message => {
    view.setUint32(msgWA + 4, message, true);
    const before = bytes.slice(msgWA, msgWA + 28);
    const result = e.test_translate_message(msg) >>> 0;
    assert.deepStrictEqual(bytes.slice(msgWA, msgWA + 28), before,
      `TranslateMessage must not mutate MSG for 0x${message.toString(16)}`);
    assert.strictEqual(e.get_esp() >>> 0, 0x00300008,
      'TranslateMessage pops its one argument and return address');
    return result;
  };

  for (const message of [0x0100, 0x0101, 0x0104, 0x0105]) {
    assert.strictEqual(translate(message), 1,
      `virtual-key message 0x${message.toString(16)} returns TRUE`);
  }
  for (const message of [0x000f, 0x0102, 0x0106, 0x0200, 0x0400]) {
    assert.strictEqual(translate(message), 0,
      `non-virtual-key message 0x${message.toString(16)} returns FALSE`);
  }

  console.log('PASS TranslateMessage preserves MSG and reports only virtual-key messages');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
