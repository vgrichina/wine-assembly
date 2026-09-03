#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_clear_showwindow_thunks")
    (global.set $createwnd_move_thunk (i32.const 0))
    (global.set $createwnd_size_thunk (i32.const 0)))
  (func (export "test_get_createwnd_move_thunk") (result i32)
    (global.get $createwnd_move_thunk))
  (func (export "test_get_createwnd_size_thunk") (result i32)
    (global.get $createwnd_size_thunk))
`;

(async () => {
  const { exports: wat, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const fixture = fs.readFileSync(path.join(__dirname, 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, wat.get_staging());
  assert(wat.load_pe(fixture.length), 'fixture PE initializes continuation thunks');

  const move = wat.test_get_createwnd_move_thunk() >>> 0;
  const size = wat.test_get_createwnd_size_thunk() >>> 0;
  assert(move && size && move !== size,
    'main instance has distinct WM_MOVE and WM_SIZE continuation thunks');

  wat.test_clear_showwindow_thunks();
  assert.strictEqual(wat.test_get_createwnd_move_thunk() >>> 0, 0);
  assert.strictEqual(wat.test_get_createwnd_size_thunk() >>> 0, 0);
  wat.sync_thunk_state(wat.get_thunk_end(), wat.get_num_thunks());

  assert.strictEqual(wat.test_get_createwnd_move_thunk() >>> 0, move,
    'worker thunk sync restores CACA0024 as the WM_MOVE continuation');
  assert.strictEqual(wat.test_get_createwnd_size_thunk() >>> 0, size,
    'worker thunk sync restores CACA0031 as the WM_SIZE continuation');
  console.log('PASS worker ShowWindow continuation thunk sync');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
