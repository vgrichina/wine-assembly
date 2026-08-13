#!/usr/bin/env node
'use strict';

// The hot br_table executor must run supported AoE blocks exactly and must
// restart an unsupported decoded block through the ordinary x86 interpreter.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const CODE = 0x00520000;
const STACK = 0x00310000;
const RETURN = 0x00521000;

const u32 = value => value >>> 0;

function seed(e) {
  e.set_eip(CODE);
  e.set_esp(STACK);
  e.set_eax(0x11111111);
  e.set_ecx(0x22222222);
  e.set_edx(0x33333333);
  e.set_ebx(0x44444444);
  e.set_ebp(0x55555555);
  e.set_esi(0x66666666);
  e.set_edi(0x77777777);
  e.guest_write32(STACK, RETURN);
}

function snapshot(e) {
  return {
    eip: u32(e.get_eip()),
    esp: u32(e.get_esp()),
    eax: u32(e.get_eax()),
    ecx: u32(e.get_ecx()),
    edx: u32(e.get_edx()),
    ebx: u32(e.get_ebx()),
    ebp: u32(e.get_ebp()),
    esi: u32(e.get_esi()),
    edi: u32(e.get_edi()),
  };
}

(async () => {
  const { exports: e, memory } = await bootRenderHarness();
  const mem = new Uint8Array(memory.buffer);
  const guestBase = u32(e.get_guest_base());
  const imageBase = u32(e.get_image_base());
  const wa = address => (u32(address) - imageBase + guestBase) >>> 0;

  // mov eax,0x12345678; ret. Neither decoded handler belongs to the AoE hot
  // subset, so this block exercises the synchronized fallback path.
  mem.set([0xb8, 0x78, 0x56, 0x34, 0x12, 0xc3], wa(CODE));

  seed(e);
  e.run(1);
  const expected = snapshot(e);

  seed(e);
  e.run_aoe_brtable_subset_generic(1);
  assert.deepStrictEqual(snapshot(e), expected, 'generic subset fallback state');

  seed(e);
  e.run_aoe_brtable_subset_direct(1);
  assert.deepStrictEqual(snapshot(e), expected, 'direct subset fallback state');

  seed(e);
  e.run_aoe_brtable_cached_generic(1);
  assert.deepStrictEqual(snapshot(e), expected, 'untagged cached subset fallback state');

  seed(e);
  e.set_x86_hot_subset_enabled(1);
  e.run(1);
  assert.deepStrictEqual(snapshot(e), expected, 'main-loop subset fallback state');

  assert.strictEqual(expected.eax, 0x12345678);
  assert.strictEqual(expected.eip, RETURN);
  assert.strictEqual(expected.esp, STACK + 4);
  console.log('PASS  AoE br_table hot subset falls back to x86 with exact state');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
