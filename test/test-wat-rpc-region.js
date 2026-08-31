#!/usr/bin/env node

'use strict';

// lib/guest-rpc.js writes its control blocks at a hard-coded address in the
// shared linear memory. The WAT is the authority for that map, and nothing
// otherwise connects the two numbers — so this asserts they agree.
//
// It is not hypothetical. The original RPC_BASE was 0x1F000000, which was 48MB
// INSIDE the CreateDIBSection pixel arena (0x1C000000 + 64MB). A guest that
// allocated that much DIB would have overwritten a worker's status word, and the
// worker would have sat in Atomics.wait forever with no error anywhere: the page
// would just stop. test-wat-memory-map.js could not catch it either, because the
// RPC region was not declared in the WAT at all.

const assert = require('assert');
const RPC = require('../lib/guest-rpc.js');
const MEM_UTILS = require('../lib/mem-utils.js');

// The mirrors these checks read are symbolic since wave 3 — a literal mirror
// pins its region — so they are resolved through tools/wat-globals.js, which
// understands both spellings, instead of a regex for `i32.const` that would
// find nothing and report an empty map as green.
const WAT_GLOBALS = require('../tools/wat-globals.js').collect();

let passed = 0, failed = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

function watGlobal(name) {
  const g = WAT_GLOBALS.get(name);
  assert(g, `src/ has no (global $${name} i32 ...)`);
  return g.value >>> 0;
}

console.log('guest-rpc region vs the WAT memory map\n');

const rpcBase = watGlobal('THREAD_RPC');
const rpcSize = watGlobal('THREAD_RPC_SIZE');
const dibBase = watGlobal('DIB_BACKING_BASE');
const dibSize = watGlobal('DIB_BACKING_BASE_SIZE');
const dibGuestCap = watGlobal('DIB_GUEST_CAPACITY');
const memoryBytes = 8192 * 65536;   // (memory 8192 8192 shared)

check(RPC.RPC_BASE === rpcBase, 'RPC_BASE matches $THREAD_RPC',
  `js=0x${RPC.RPC_BASE.toString(16)} wat=0x${rpcBase.toString(16)}`);

const hi = rpcBase + RPC.RPC_MAX_SLOTS * RPC.RPC_STRIDE;
check(hi === rpcBase + rpcSize, 'the slot table exactly fills $THREAD_RPC_SIZE',
  `${RPC.RPC_MAX_SLOTS} slots x ${RPC.RPC_STRIDE}B = 0x${(hi - rpcBase).toString(16)}`);
check(hi <= memoryBytes, 'the last slot is inside linear memory',
  `end=0x${hi.toString(16)} memory=0x${memoryBytes.toString(16)}`);

const dibEnd = dibBase + dibSize;
check(rpcBase >= dibEnd, 'no RPC block lands in the DIB pixel arena (the original bug)',
  `dib ends 0x${dibEnd.toString(16)}, rpc starts 0x${rpcBase.toString(16)}`);
check(dibGuestCap === dibSize,
  'DIB guest capacity equals its backing size, so no DIB address maps past its backing',
  `cap=0x${dibGuestCap.toString(16)} backing=0x${dibSize.toString(16)}`);
check(MEM_UTILS.DIB_GUEST_CAPACITY === dibGuestCap,
  'mem-utils DIB guest capacity matches WAT',
  `js=0x${MEM_UTILS.DIB_GUEST_CAPACITY.toString(16)} wat=0x${dibGuestCap.toString(16)}`);
check(MEM_UTILS.DIB_BACKING_BASE === dibBase,
  'mem-utils DIB backing base matches WAT',
  `js=0x${MEM_UTILS.DIB_BACKING_BASE.toString(16)} wat=0x${dibBase.toString(16)}`);

// Blocks must not share a cache line, or two threads' handshakes ping-pong one
// line between cores on every host call.
check(RPC.RPC_STRIDE % 64 === 0, 'each block is a whole number of 64-byte lines',
  `stride=${RPC.RPC_STRIDE}`);
check(RPC.CTRL_INTS * 4 === RPC.RPC_STRIDE, 'the control block fills its stride',
  `${RPC.CTRL_INTS} ints`);

// blockBase must refuse a slot outside the region rather than silently aliasing
// another thread's block or writing past the end of memory.
let threw = false;
try { RPC.blockBase(RPC.RPC_MAX_SLOTS); } catch (_) { threw = true; }
check(threw, 'blockBase rejects an out-of-range slot');
check(RPC.blockBase(1) - RPC.blockBase(0) === RPC.RPC_STRIDE, 'slots are one stride apart');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
