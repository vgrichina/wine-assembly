#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_diablo_runtime_init")
    (global.set $image_base (i32.const 0)))
  (func (export "test_diablo_strstr") (param $hay i32) (param $needle i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_strstr (local.get $hay) (local.get $needle)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_diablo_acm_metric") (param $metric i32) (param $out i32) (result i32)
    (call $acm_metrics (i32.const 0) (local.get $metric) (local.get $out)))
  (func (export "test_diablo_atexit_begin") (param $first i32) (param $second i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (global.set $atexit_ret_thunk (i32.const 0x0040DEAD))
    (drop (call $crt_atexit_register (local.get $first)))
    (drop (call $crt_atexit_register (local.get $second)))
    (call $crt_atexit_run_next)
    (global.get $eip))
  (func (export "test_diablo_atexit_next") (result i32)
    (call $crt_atexit_run_next)
    (global.get $eip))
`;

(async () => {
  let exitCode = null;
  const { exports: wat } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: { exit: code => { exitCode = code | 0; } },
  });
  wat.test_diablo_runtime_init();

  const writeAscii = (ptr, value) => {
    for (let i = 0; i < value.length; i++) wat.guest_write8(ptr + i, value.charCodeAt(i));
    wat.guest_write8(ptr + value.length, 0);
  };
  const hay = 0x1000;
  const needle = 0x1100;
  writeAscii(hay, 'storm-diablo-data');
  writeAscii(needle, 'diablo');
  assert.strictEqual(wat.test_diablo_strstr(hay, needle) >>> 0, hay + 6,
    'strstr returns the first matching guest pointer');
  writeAscii(needle, 'missing');
  assert.strictEqual(wat.test_diablo_strstr(hay, needle), 0,
    'strstr returns NULL when the substring is absent');
  writeAscii(needle, '');
  assert.strictEqual(wat.test_diablo_strstr(hay, needle) >>> 0, hay,
    'strstr returns the haystack for an empty needle');

  const metricOut = 0x1200;
  assert.strictEqual(wat.test_diablo_acm_metric(50, metricOut), 0,
    'ACM_METRIC_MAX_SIZE_FORMAT succeeds');
  assert.strictEqual(wat.guest_read32(metricOut), 18,
    'ACM_METRIC_MAX_SIZE_FORMAT includes the WAVEFORMATEX cbSize word');
  assert.strictEqual(wat.test_diablo_acm_metric(20, metricOut), 0,
    'ACM_METRIC_COUNT_LOCAL_DRIVERS succeeds');
  assert.strictEqual(wat.guest_read32(metricOut), 1,
    'the built-in PCM converter is exposed as one local ACM driver');

  assert.strictEqual(wat.test_diablo_atexit_begin(0x00401000, 0x00402000) >>> 0,
    0x00402000, 'normal exit starts with the last registered callback');
  assert.strictEqual(wat.test_crt_atexit_count(), 1,
    'one earlier atexit callback remains after the first dispatch');
  assert.strictEqual(wat.guest_read32((wat.get_esp() >>> 0)), 0x0040DEAD,
    'atexit callbacks return through the dedicated continuation thunk');
  assert.strictEqual(wat.test_diablo_atexit_next() >>> 0, 0x00401000,
    'atexit callbacks drain in LIFO order');
  wat.test_diablo_atexit_next();
  assert.strictEqual(exitCode, 0, 'the normal exit sequence calls the host after callbacks drain');

  console.log('PASS  Diablo CRT and ACM compatibility APIs preserve real contracts');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
