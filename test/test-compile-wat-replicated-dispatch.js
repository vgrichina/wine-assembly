#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { compileWat } = require('../lib/compile-wat');

let sequence = 0;

function moduleWat() {
  return String.raw`(module
    (type $handler_t (func (param i32)))
    (memory 1)
    (export "memory" (memory 0))
    (global $steps (mut i32) (i32.const 0))
    (global $ip (mut i32) (i32.const 0))
    (global $resume_ip (mut i32) (i32.const 0))
    (global $eip (mut i32) (i32.const 0x12345678))
    (global $THREAD_BASE (mut i32) (i32.const 0x40))
    (global $thread_alloc (mut i32) (i32.const 0x80))
    (global $handler_hist_enabled (mut i32) (i32.const 0))
    (global $hits (mut i32) (i32.const 0))
    (global $bad (mut i32) (i32.const 0))
    (table $handlers 1 funcref)
    (elem (i32.const 0) $th_hit)

    (func $clear_cache
      (global.set $bad (i32.const 7)))
    (func $dispatch_bad (param $fn i32)
      (global.set $thread_alloc (global.get $THREAD_BASE))
      (call $clear_cache))
    (func $handler_hist_record (param $fn i32)
      (unreachable))

    (func $next
      (local $fn i32) (local $op i32)
      (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
      (if (i32.le_s (global.get $steps) (i32.const 0))
        (then
          (global.set $resume_ip (global.get $ip))
          (return)))
      (local.set $fn (i32.load (global.get $ip)))
      (local.set $op (i32.load offset=4 (global.get $ip)))
      (global.set $ip (i32.add (global.get $ip) (i32.const 8)))
      (if (i32.ge_u (local.get $fn) (i32.const 444))
        (then
          (return_call $dispatch_bad (local.get $fn))))
      (if (global.get $handler_hist_enabled)
        (then (call $handler_hist_record (local.get $fn))))
      (return_call_indirect (type $handler_t) (local.get $op) (local.get $fn)))

    (func $th_hit (param $op i32)
      (global.set $hits (i32.add (global.get $hits) (i32.const 1)))
      (return_call $next))

    (func (export "set_state") (param $new_ip i32) (param $new_steps i32)
      (global.set $ip (local.get $new_ip))
      (global.set $steps (local.get $new_steps))
      (global.set $resume_ip (i32.const 0))
      (global.set $hits (i32.const 0))
      (global.set $bad (i32.const 0))
      (global.set $thread_alloc (i32.const 0x80)))
    (func (export "entry")
      (return_call $th_hit (i32.const 99)))
    (func (export "get_ip") (result i32) (global.get $ip))
    (func (export "get_resume_ip") (result i32) (global.get $resume_ip))
    (func (export "get_thread_alloc") (result i32) (global.get $thread_alloc))
    (func (export "get_hits") (result i32) (global.get $hits))
    (func (export "get_bad") (result i32) (global.get $bad)))`;
}

async function instantiate(replicatedDispatch) {
  const bytes = await compileWat(() => moduleWat(), {
    files: ['test.wat'],
    cacheKey: `test-compile-wat-replicated-dispatch-${sequence++}`,
    replicatedDispatch,
  });
  const { instance } = await WebAssembly.instantiate(bytes);
  return instance.exports;
}

function storeThreadWord(memory, addr, fn, op) {
  const view = new DataView(memory.buffer);
  view.setUint32(addr, fn >>> 0, true);
  view.setUint32(addr + 4, op >>> 0, true);
}

(async () => {
  for (const [label, replicatedDispatch] of [
    ['shared', false],
    ['replicated', true],
  ]) {
    const e = await instantiate(replicatedDispatch);

    e.set_state(0x100, 2);
    storeThreadWord(e.memory, 0x100, 0, 123);
    e.entry();
    assert.strictEqual(e.get_hits(), 2, `${label}: chained handler did not run`);
    assert.strictEqual(e.get_ip(), 0x108, `${label}: dispatch did not advance ip`);
    assert.strictEqual(e.get_resume_ip(), 0x108, `${label}: resume ip not preserved at step escape`);
    assert.strictEqual(e.get_bad(), 0, `${label}: valid handler took bad-dispatch path`);

    e.set_state(0x180, 2);
    storeThreadWord(e.memory, 0x180, 444, 456);
    e.entry();
    assert.strictEqual(e.get_hits(), 1, `${label}: entry handler should run once before bad dispatch`);
    assert.strictEqual(e.get_ip(), 0x188, `${label}: bad-dispatch fetch should advance ip`);
    assert.strictEqual(e.get_thread_alloc(), 0x40, `${label}: bad dispatch did not reset thread_alloc`);
    assert.strictEqual(e.get_bad(), 7, `${label}: bad dispatch did not clear cache`);
  }

  console.log('PASS compile-wat replicated dispatch preserves shared $next semantics');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
