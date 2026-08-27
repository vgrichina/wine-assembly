#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_midi_out_long_msg")
      (param $handle i32) (param $hdr i32) (param $cb i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_midiOutLongMsg
      (local.get $handle) (local.get $hdr) (local.get $cb)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const hdr = e.guest_alloc(64) >>> 0;

  let result = e.test_midi_out_long_msg(0xc0001, 0, 64);
  assert.strictEqual(Number(result & 0xffffffffn), 11,
    'NULL MIDIHDR is rejected');

  e.guest_write32(hdr + 16, 0);
  result = e.test_midi_out_long_msg(0xc0001, hdr, 64);
  assert.strictEqual(Number(result & 0xffffffffn), 64,
    'an unprepared MIDIHDR returns MIDIERR_UNPREPARED');

  e.guest_write32(hdr + 16, 2 | 0x10); // PREPARED | INQUEUE
  result = e.test_midi_out_long_msg(0xc0001, hdr, 64);
  assert.strictEqual(Number(result & 0xffffffffn), 0,
    'a prepared long message completes successfully');
  assert.strictEqual(Number(result >> 32n), 0x00300010,
    'three-argument stdcall pops its return address and arguments');
  assert.strictEqual(e.guest_read32(hdr + 16) >>> 0, 3,
    'completion retains PREPARED, clears INQUEUE, and sets DONE');

  console.log('PASS midiOutLongMsg completes prepared SysEx headers coherently');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
