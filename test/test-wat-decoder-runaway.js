#!/usr/bin/env node
'use strict';

// A basic block ends at its first branch, call, return or interrupt, so a real
// one is short. Decoding a region that contains no terminator — a wild jump
// into zeroed memory, where 00 00 decodes as `add [eax], al` forever — used to
// run until it had filled the whole 4MB code arena and then kept going,
// writing past the end and calling the host's log import once per emitted
// operand. What that looked like from outside was not a decoder problem at
// all: the harness sat in a single batch that never returned and eventually
// died with a JavaScript out-of-memory, thousands of batches away from any
// clue about which guest address was at fault.
//
// So the decoder now stops and says where it was, and this pins both halves of
// that: a terminator-free region must fail fast, and an ordinary block must
// still decode untouched.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_decode_block") (param $eip i32) (result i32)
    (call $decode_block (local.get $eip)))
  (func (export "test_poke") (param $addr i32) (param $byte i32)
    (i32.store8 (call $g2w (local.get $addr)) (local.get $byte)))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, width: 64, height: 48 });

  // A lone RET is a complete block: one instruction and a terminator.
  const RET = 0x00030000;
  e.test_poke(RET, 0xc3);
  const tstart = e.test_decode_block(RET) >>> 0;
  assert.ok(tstart, 'a RET should decode into a block');
  console.log('PASS  an ordinary block still decodes');

  // Untouched guest memory is zeroes, which never terminate a block.
  let trapped = null;
  try {
    e.test_decode_block(0x00040000);
  } catch (err) {
    trapped = err;
  }
  assert.ok(trapped, 'decoding a region with no terminator should trap, not spin');
  assert.ok(/unreachable/.test(String(trapped.message)),
    `expected an explicit trap, got: ${trapped && trapped.message}`);
  console.log('PASS  a region with no terminator fails fast instead of filling the arena');

  console.log('\n2/2 decoder runaway checks passed');
})();
