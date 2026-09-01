#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (global $test_eax (mut i32) (i32.const 0))
  (global $test_esp_delta (mut i32) (i32.const 0))

  (func $record_call (param $saved_esp i32)
    (global.set $test_eax (global.get $eax))
    (global.set $test_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "last_eax") (result i32) (global.get $test_eax))
  (func (export "last_esp_delta") (result i32) (global.get $test_esp_delta))

  (func (export "call_bass_init")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_BASS_Init
      (i32.const -1) (i32.const 44100) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $record_call (local.get $saved_esp)))

  (func (export "call_bass_plugin_load")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_BASS_PluginLoad
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $record_call (local.get $saved_esp)))

  (func (export "call_bass_sample_load")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_BASS_SampleLoad
      (i32.const 1) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $record_call (local.get $saved_esp)))

  (func (export "call_bass_channel_play")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_BASS_ChannelPlay
      (i32.const 0x0BA55001) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $record_call (local.get $saved_esp)))

  (func (export "call_bass_channel_set_position")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_BASS_ChannelSetPosition
      (i32.const 0x0BA55001) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $record_call (local.get $saved_esp)))

  (func (export "call_bass_channel_pause")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_BASS_ChannelPause
      (i32.const 0x0BA55001) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $record_call (local.get $saved_esp)))

  (func (export "call_bass_error_get_code")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_BASS_ErrorGetCode
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $record_call (local.get $saved_esp)))

  (func (export "call_bass_free")
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_BASS_Free
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $record_call (local.get $saved_esp)))
`;

function assertCall(exports, name, eax, espDelta) {
  exports[name]();
  assert.strictEqual(exports.last_eax() >>> 0, eax >>> 0, `${name} return value`);
  assert.strictEqual(exports.last_esp_delta(), espDelta, `${name} stdcall stack cleanup`);
}

(async () => {
  const { exports } = await bootRenderHarness({ extraWat, fonts: 'none' });

  assertCall(exports, 'call_bass_init', 1, 24);
  assertCall(exports, 'call_bass_plugin_load', 0, 12);
  assertCall(exports, 'call_bass_sample_load', 0x0BA55001, 32);
  assertCall(exports, 'call_bass_channel_play', 1, 12);
  assertCall(exports, 'call_bass_channel_set_position', 1, 20);
  assertCall(exports, 'call_bass_channel_pause', 1, 8);
  assertCall(exports, 'call_bass_error_get_code', 0, 4);
  assertCall(exports, 'call_bass_free', 1, 4);

  console.log('PASS  BASS compatibility handlers preserve stdcall cleanup');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
