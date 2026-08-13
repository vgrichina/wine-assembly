#!/usr/bin/env node
'use strict';

// RCT's three dominant exact byte-ADD forms must execute identically through
// the cached br_table path. Its current stable runtime loop also relies on the
// ordinary interpreter's 999-handler cutoff, so verify a non-terminal prefix.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const CODE = 0x00530000;
const DATA = 0x00600000;
const STACK = 0x00310000;
const POPPED_EBX = DATA + 0x100;
const SIB_TARGET = POPPED_EBX * 3 + 0x10;
const u32 = value => value >>> 0;

async function makeHarness(enabled) {
  const harness = await bootRenderHarness();
  const e = harness.exports;
  const mem = new Uint8Array(harness.memory.buffer);
  const guestBase = u32(e.get_guest_base());
  const imageBase = u32(e.get_image_base());
  const wa = address => (u32(address) - imageBase + guestBase) >>> 0;
  e.set_hotform_specialization_enabled(1);
  e.set_x86_hot_subset_enabled(enabled ? 1 : 0);
  return { e, mem, wa };
}

function seed(harness, bytes) {
  const { e, mem, wa } = harness;
  mem.fill(0, wa(CODE), wa(CODE) + bytes.length + 16);
  mem.set(bytes, wa(CODE));
  e.guest_write32(DATA, 0x44332211);
  e.guest_write32(DATA + 4, 0x88776655);
  e.guest_write32(DATA + 8, 0xccbbaa99);
  e.guest_write32(DATA + 12, 0x10f0e0d0);
  e.guest_write32(SIB_TARGET, 0x01020304);
  e.guest_write32(STACK, POPPED_EBX);
  e.guest_write32(STACK + 4, 5);
  e.set_eip(CODE);
  e.set_eax(DATA + 1); // AL=1; first exact form writes DATA+1.
  e.set_ecx(DATA + 8); // second exact form writes DATA+12.
  e.set_edx(0x12340710);
  e.set_ebx(0x44444444);
  e.set_esp(STACK);
  e.set_ebp(0x55555555);
  e.set_esi(DATA);
  e.set_edi(DATA + 8);
}

function snapshot(harness) {
  const e = harness.e;
  return {
    eip: u32(e.get_eip()), eax: u32(e.get_eax()), ecx: u32(e.get_ecx()),
    edx: u32(e.get_edx()), ebx: u32(e.get_ebx()), esp: u32(e.get_esp()),
    esi: u32(e.get_esi()), edi: u32(e.get_edi()),
    flagOp: u32(e.get_flag_op()), flagA: u32(e.get_flag_a()),
    flagB: u32(e.get_flag_b()), flagRes: u32(e.get_flag_res()),
    flagShift: u32(e.get_flag_sign_shift()),
    data: [0, 4, 8, 12].map(offset => u32(e.guest_read32(DATA + offset))),
    sibData: u32(e.guest_read32(SIB_TARGET)),
  };
}

function loopBytes(ops) {
  const bytes = [...ops];
  const rel = -(bytes.length + 5);
  bytes.push(0xe9, rel & 0xff, (rel >>> 8) & 0xff,
    (rel >>> 16) & 0xff, (rel >>> 24) & 0xff);
  return bytes;
}

(async () => {
  const baseline = await makeHarness(false);
  const candidate = await makeHarness(true);
  const full = await makeHarness(false);
  full.e.set_x86_full_brtable_enabled(1);

  // add byte [eax],al; add byte [ecx+4],al; add dl,dh; jmp CODE
  const trio = loopBytes([0x00, 0x00, 0x00, 0x41, 0x04, 0x00, 0xf2]);
  seed(baseline, trio);
  seed(candidate, trio);
  seed(full, trio);
  baseline.e.run(1);
  candidate.e.run(1);
  full.e.run(1);
  assert.deepStrictEqual(snapshot(candidate), snapshot(baseline),
    'RCT exact-form packet state');
  assert.deepStrictEqual(snapshot(full), snapshot(baseline),
    'automatically generated full-table exact-form state');
  assert.strictEqual(full.e.get_x86_full_brtable_blocks(), 1,
    'full-table dispatcher must execute the packet');
  assert.strictEqual(candidate.e.get_x86_hot_subset_cached_status(CODE), 1,
    'RCT exact-form packet must classify hot');
  assert.strictEqual(candidate.e.get_x86_hot_subset_hot_blocks(), 1,
    'RCT exact-form packet must use generated dispatch');

  // Exercise every additional generic handler family used by the observed
  // RCT prefix: byte/word memory ALU, CMPSB, POP, register ADD, and SIB+ALU.
  const corpusPacket = loopBytes([
    0x00, 0x00,                         // exact [eax] += al (382)
    0x00, 0x41, 0x04,                   // exact [ecx+4] += al (383)
    0x00, 0xf2,                         // exact dl += dh (384)
    0x00, 0x5e, 0x01,                   // [esi+1] += bl (129)
    0xa6,                               // cmpsb (94)
    0x01, 0x40, 0x08,                   // [eax+8] += eax (127)
    0x5b,                               // pop ebx (334)
    0x5a,                               // pop edx (333)
    0x01, 0xda,                         // add edx,ebx (12)
    0x01, 0x84, 0x5b, 0x10, 0, 0, 0,   // [ebx+ebx*2+0x10] += eax (149,47)
  ]);
  baseline.e.set_x86_hot_subset_enabled(0);
  candidate.e.set_x86_hot_subset_enabled(1);
  full.e.set_x86_full_brtable_enabled(1);
  seed(baseline, corpusPacket);
  seed(candidate, corpusPacket);
  seed(full, corpusPacket);
  baseline.e.run(1);
  candidate.e.run(1);
  full.e.run(1);
  assert.deepStrictEqual(snapshot(candidate), snapshot(baseline),
    'RCT observed handler-family packet state');
  assert.deepStrictEqual(snapshot(full), snapshot(baseline),
    'full-table observed handler-family packet state');
  assert.strictEqual(candidate.e.get_x86_hot_subset_cached_status(CODE), 1,
    'RCT observed handler-family packet must classify hot');

  // The normal threaded interpreter executes only 999 handlers after setting
  // steps=1000. The generated path must stop at the same point instead of
  // running forward to the eventual jump.
  const longPrefix = [];
  for (let i = 0; i < 999; i++) longPrefix.push(0x00, 0xf2);
  const budgeted = loopBytes(longPrefix);
  baseline.e.set_x86_hot_subset_enabled(0);
  candidate.e.set_x86_hot_subset_enabled(1);
  full.e.set_x86_full_brtable_enabled(1);
  seed(baseline, budgeted);
  seed(candidate, budgeted);
  seed(full, budgeted);
  baseline.e.run(1);
  candidate.e.run(1);
  full.e.run(1);
  assert.deepStrictEqual(snapshot(candidate), snapshot(baseline),
    '999-handler cutoff state');
  assert.deepStrictEqual(snapshot(full), snapshot(baseline),
    'full-table 999-handler cutoff state');
  assert.strictEqual(candidate.e.get_x86_hot_subset_cached_status(CODE), 1,
    'supported 999-handler prefix must classify hot');

  console.log('PASS  subset and automatic full br_table match x86 threading');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
