#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_mixer_get_control_details_a") (param $pmxcd i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_mixerGetControlDetailsA
      (i32.const 0x00090001) (local.get $pmxcd) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_mixer_get_control_details_w") (param $pmxcd i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_mixerGetControlDetailsW
      (i32.const 0x00090001) (local.get $pmxcd) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const calls = [];
  const { exports: e, memory } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      audio_mixer_get_volume: bus => {
        calls.push(['volume', bus]);
        return 0xBEEF1234 | 0;
      },
      audio_mixer_get_mute: bus => {
        calls.push(['mute', bus]);
        return 1;
      },
      audio_mixer_get_peak: bus => {
        calls.push(['peak', bus]);
        return 0x4321;
      },
    },
  });
  const imageBase = e.get_image_base() >>> 0;
  const pmxcdGuest = imageBase + 0x2600;
  const valuesGuest = imageBase + 0x2700;
  const pmxcd = e.guest_to_wasm(pmxcdGuest) >>> 0;
  const values = e.guest_to_wasm(valuesGuest) >>> 0;
  const dv = new DataView(memory.buffer);

  function prepare(controlId, channels) {
    for (let i = 0; i < 24; i += 4) dv.setUint32(pmxcd + i, 0, true);
    dv.setUint32(pmxcd, 24, true);             // cbStruct
    dv.setUint32(pmxcd + 4, controlId, true); // dwControlID
    dv.setUint32(pmxcd + 8, channels, true);  // cChannels
    dv.setUint32(pmxcd + 16, 4, true);        // cbDetails
    dv.setUint32(pmxcd + 20, valuesGuest, true);
    dv.setUint32(values, 0xAAAAAAAA, true);
    dv.setUint32(values + 4, 0xBBBBBBBB, true);
  }

  prepare(0x1001, 2);
  assert.strictEqual(e.test_mixer_get_control_details_a(pmxcdGuest), 0,
    'ANSI VALUE query succeeds');
  assert.strictEqual(e.get_esp() >>> 0, 0x00300010,
    'ANSI entry point pops three stdcall arguments');
  assert.deepStrictEqual(calls.shift(), ['volume', 1],
    'volume control id selects the Wave mixer bus');
  assert.strictEqual(dv.getUint32(values, true), 0x1234,
    'first unsigned detail contains the left channel');
  assert.strictEqual(dv.getUint32(values + 4, true), 0xBEEF,
    'second unsigned detail contains the right channel');

  prepare(0x1001, 2);
  assert.strictEqual(e.test_mixer_get_control_details_w(pmxcdGuest), 0,
    'Unicode VALUE query succeeds');
  assert.strictEqual(e.get_esp() >>> 0, 0x00300010,
    'Unicode entry point pops three stdcall arguments');
  assert.deepStrictEqual(calls.shift(), ['volume', 1],
    'Unicode VALUE query shares the encoding-independent implementation');
  assert.deepStrictEqual(
    [dv.getUint32(values, true), dv.getUint32(values + 4, true)],
    [0x1234, 0xBEEF],
    'ANSI and Unicode entry points emit identical numeric details');

  prepare(0x2002, 1);
  assert.strictEqual(e.test_mixer_get_control_details_w(pmxcdGuest), 0,
    'mute VALUE query succeeds');
  assert.deepStrictEqual(calls.shift(), ['mute', 2],
    'mute control id selects the MIDI mixer bus');
  assert.strictEqual(dv.getUint32(values, true), 1,
    'Boolean detail contains the current mute state');
  assert.strictEqual(dv.getUint32(values + 4, true), 0xBBBBBBBB,
    'a mono query does not overwrite a second detail');

  prepare(0x3000, 2);
  assert.strictEqual(e.test_mixer_get_control_details_a(pmxcdGuest), 0,
    'peak-meter VALUE query succeeds');
  assert.deepStrictEqual(calls.shift(), ['peak', 0],
    'peak control id selects the master mixer bus');
  assert.deepStrictEqual(
    [dv.getUint32(values, true), dv.getUint32(values + 4, true)],
    [0x4321, 0x4321],
    'peak-meter detail is replicated across the reported channels');
  assert.deepStrictEqual(calls, [], 'each query performs exactly one host read');

  console.log('PASS  mixerGetControlDetailsA/W share the numeric VALUE path');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
