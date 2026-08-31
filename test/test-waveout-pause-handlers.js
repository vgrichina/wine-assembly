#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const calls = [];
  const { exports: e } = await bootRenderHarness({
    extraWat: String.raw`
      (func (export "test_wave_out_pause") (param $h i32) (result i64)
        (global.set $esp (i32.const 0x00300000))
        (call $handle_waveOutPause (local.get $h)
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
        (i64.or (i64.extend_i32_u (global.get $eax))
          (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
      (func (export "test_wave_out_restart") (param $h i32) (result i64)
        (global.set $esp (i32.const 0x00300000))
        (call $handle_waveOutRestart (local.get $h)
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
        (i64.or (i64.extend_i32_u (global.get $eax))
          (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
    `,
    extraHostOverrides: {
      wave_out_pause: handle => { calls.push(['pause', handle >>> 0]); return 5; },
      wave_out_restart: handle => { calls.push(['restart', handle >>> 0]); return 0; },
    },
  });

  let result = e.test_wave_out_pause(0x0B0001);
  assert.strictEqual(Number(result & 0xFFFFFFFFn), 5,
    'waveOutPause returns the host MMSYSERR code');
  assert.strictEqual(Number(result >> 32n), 0x00300008,
    'waveOutPause pops its handle and return address');

  result = e.test_wave_out_restart(0x0B0002);
  assert.strictEqual(Number(result & 0xFFFFFFFFn), 0,
    'waveOutRestart returns MMSYSERR_NOERROR from the host');
  assert.strictEqual(Number(result >> 32n), 0x00300008,
    'waveOutRestart pops its handle and return address');
  assert.deepStrictEqual(calls, [
    ['pause', 0x0B0001],
    ['restart', 0x0B0002],
  ], 'both WinMM handlers forward the exact HWAVEOUT');

  console.log('PASS  waveOutPause/Restart handlers forward real device state');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
