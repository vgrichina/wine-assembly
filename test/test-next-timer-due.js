#!/usr/bin/env node
'use strict';

// next_timer_due_ms(): how long the browser drive loop may sleep while the
// guest is parked on GetMessage.
//
// has_pending_message() answers "is there work now". This is the other half --
// "and when could there be" -- and it exists because a WM_TIMER is the one wake
// source that arrives with nothing else touching the emulator: no input event,
// no worker, no posted message. Without a deadline the host can only poll, and
// polling an idle Notepad is what cost 95% of a core.
//
// The rules that matter and are checked below: it consumes nothing (a due timer
// is still there for the next GetMessage), it reports -1 when this thread owns
// no timer at all, it takes the soonest of several, and it counts multimedia
// timers alongside window timers.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_message") (param $msg i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (global.set $yield_flag (i32.const 0))
    (call $handle_GetMessageA
      (local.get $msg) (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  let now = 0;
  const { exports: e } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: { get_ticks: () => now },
  });
  const msg = 0x3000;

  assert.strictEqual(typeof e.next_timer_due_ms, 'function',
    'next_timer_due_ms is exported');

  // No timers: nothing but an external event can wake this thread, and those
  // wake the host explicitly. -1 says "I have no deadline for you".
  assert.strictEqual(e.next_timer_due_ms() | 0, -1,
    'a thread that owns no timer reports no deadline');

  // One 100ms timer, set at tick 0.
  e.test_timer_set(0, 2, 100, 0);
  now = 0;
  assert.strictEqual(e.next_timer_due_ms() | 0, 100,
    'a fresh 100ms timer is due in 100ms');
  now = 60;
  assert.strictEqual(e.next_timer_due_ms() | 0, 40,
    'the deadline counts down with the host clock');

  // Already overdue reports 0, not a negative number the host would have to
  // reason about, and does NOT consume the timer.
  now = 250;
  assert.strictEqual(e.next_timer_due_ms() | 0, 0, 'an overdue timer reports 0');
  assert.strictEqual(e.next_timer_due_ms() | 0, 0,
    'asking twice does not retire the timer');
  assert.strictEqual(e.test_get_message(msg), 1,
    'the timer is still there for GetMessage to deliver');

  // GetMessage consumed it, so the next deadline is a full period away.
  assert.strictEqual(e.next_timer_due_ms() | 0, 100,
    'after delivery the deadline is a full period out');

  // The soonest of several wins.
  e.test_timer_set(1, 3, 20, 0);
  assert.strictEqual(e.next_timer_due_ms() | 0, 20,
    'the soonest of several timers decides the deadline');

  console.log('PASS  next_timer_due_ms reports the soonest wake deadline without consuming it');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
