'use strict';
const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const extraWat = `
  (func (export "test_context_read")
      (param $stack i32) (param $ret i32) (param $value i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $gs32 (local.get $stack) (local.get $ret))
    (global.set $current_thunk_eip (i32.const 0x07501000))
    (global.set $yield_reason (i32.const 0))
    (global.set $yield_flag (i32.const 0))
    (global.set $handler_set_eip (i32.const 0))
    (if (call $clock_spin_step (local.get $value))
      (then (return (call $clock_spin_arm (local.get $value)))))
    (i32.const 0))
  (func (export "test_context_work")
    (global.set $spin_nonpoll_seq (i32.add (global.get $spin_nonpoll_seq) (i32.const 1))))
`;
(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const stacks = [0x110100, 0x110120, 0x110140, 0x110160];
  const ret = 0x401010;
  const k = e.get_spin_park_k();
  e.test_spin_reset();
  for (let round = 0; round < k - 1; round++) {
    for (const stack of stacks) assert.strictEqual(e.test_context_read(stack, ret, 100), 0,
      'interleaved contexts must each prove K reads, not pool their counts');
  }
  assert.strictEqual(e.test_context_read(stacks[0], ret, 100), 1,
    'four alternating depths retain their individual evidence');
  assert.strictEqual(e.get_yield_reason(), 14);
  assert.strictEqual(e.get_esp(), stacks[0], 'park preserves selected context stack');
  assert.strictEqual(e.guest_read32(stacks[0]), ret, 'park preserves return address');
  assert.strictEqual(e.get_eip(), 0x07501000, 'park retries the active thunk');
  for (const stack of stacks) assert.strictEqual(e.test_context_read(stack, ret, 100), 0,
    'at most one park per millisecond across all contexts');

  e.test_spin_reset();
  for (let round = 0; round < k * 2; round++) {
    for (const stack of stacks) assert.strictEqual(e.test_context_read(stack, ret, 100 + round), 0,
      'a moving clock invalidates cached proof');
  }
  e.test_spin_reset();
  for (let round = 0; round < k * 2; round++) {
    e.test_context_work();
    for (const stack of stacks) assert.strictEqual(e.test_context_read(stack, ret, 100), 0,
      'meaningful API work invalidates every cached context');
  }
  e.test_spin_reset();
  for (let round = 0; round < k - 1; round++) {
    for (let i = 0; i < 4; i++) assert.strictEqual(e.test_context_read(stacks[0], ret + i * 4, 100), 0,
      'different return sites retain separate counters at the same depth');
  }
  assert.strictEqual(e.test_context_read(stacks[0], ret, 100), 1);
  e.test_spin_reset();
  for (let round = 0; round < k * 2; round++) {
    for (let i = 0; i < 5; i++) assert.strictEqual(e.test_context_read(stacks[0] + i * 32, ret, 100), 0,
      'bounded history eviction loses proof instead of mixing contexts');
  }
  e.test_spin_reset();
  e.set_spin_park_k(0);
  for (let round = 0; round < k * 2; round++) for (const stack of stacks)
    assert.strictEqual(e.test_context_read(stack, ret, 100), 0, 'K=0 disables every context');
  e.set_spin_park_k(k);
  e.test_spin_reset();
  for (let round = 0; round < k - 1; round++) for (const stack of stacks)
    assert.strictEqual(e.test_context_read(stack, ret, 100), 0);
  const { exports: other } = await bootRenderHarness({ extraWat, memory, fonts: 'none' });
  for (const stack of stacks) assert.strictEqual(other.test_context_read(stack, ret, 100), 0,
    'another instance over shared memory cannot inherit clock proof');
  assert.strictEqual(e.test_context_read(stacks[0], ret, 100), 1,
    'another instance cannot erase the original thread context either');
  console.log('PASS bounded clock contexts, activity/value reset, eviction and stack-safe parking');
})().catch(err => { console.error(err); process.exitCode = 1; });
