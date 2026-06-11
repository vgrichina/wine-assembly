#!/usr/bin/env node
// Deterministic coverage for the disabled-by-default AoE stack-packet
// prototype. The packet covers one hot AoE block at 0x0049d9d1.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const BLOCK = 0x0049d9d1;
const FALL = 0x0049d9f9;
const TARGET = 0x0049da1a;

const u32 = v => v >>> 0;
const hex = v => '0x' + u32(v).toString(16).padStart(8, '0');

function writeScenario(e, compareValue) {
  const esi = 0x2000;
  const ebp = 0x3000;
  const tableA = 0x4000;
  const tableB = 0x5000;
  const oldEcx = 3;
  const edx = 2;
  const baseValue = 0x50;
  const countdown = 10;

  e.set_eip(BLOCK);
  e.set_esi(esi);
  e.set_ebp(ebp);
  e.set_eax(0xaaaaaaaa);
  e.set_ecx(0xbbbbbbbb);
  e.set_edx(0xcccccccc);
  e.set_edi(0xdddddddd);

  e.guest_write32(esi + 0x18, oldEcx);
  e.guest_write32(esi + 0x14, edx);
  e.guest_write32(esi, tableA);
  e.guest_write32(tableA + edx * 4, baseValue);
  e.guest_write32(esi + 0x20, countdown);
  e.guest_write32(esi + 0x04, tableB);
  e.guest_write32(tableB + edx * 4, compareValue);

  return {
    esi,
    ebp,
    tableB,
    oldEcx,
    edx,
    expectedEax: u32(baseValue + (oldEcx << 4)),
    expectedEcx: oldEcx + 1,
    expectedCountdown: countdown - 1,
  };
}

function runCase(e, name, compareValue, expectedEip, expectedFlagRes) {
  const s = writeScenario(e, compareValue);
  e.reset_stack_packet_counters();
  e.run(1);

  assert.strictEqual(u32(e.get_eip()), expectedEip,
    `${name}: wrong next eip, got ${hex(e.get_eip())}`);
  assert.strictEqual(u32(e.get_eax()), s.expectedEax, `${name}: eax`);
  assert.strictEqual(u32(e.get_ecx()), s.expectedEcx, `${name}: ecx`);
  assert.strictEqual(u32(e.get_edx()), s.edx, `${name}: edx`);
  assert.strictEqual(u32(e.get_edi()), s.tableB, `${name}: edi`);
  assert.strictEqual(u32(e.guest_read32(s.esi + 0x20)), s.expectedCountdown,
    `${name}: [esi+20]`);
  assert.strictEqual(u32(e.guest_read32(s.ebp - 4)), s.expectedCountdown,
    `${name}: [ebp-4]`);
  assert.strictEqual(u32(e.guest_read32(s.esi + 0x18)), s.expectedEcx,
    `${name}: [esi+18]`);
  assert.strictEqual(u32(e.get_flag_op()), 2, `${name}: final op is cmp/sub`);
  assert.strictEqual(u32(e.get_flag_a()), s.expectedEcx, `${name}: flag a`);
  assert.strictEqual(u32(e.get_flag_b()), compareValue, `${name}: flag b`);
  assert.strictEqual(u32(e.get_flag_res()), expectedFlagRes,
    `${name}: flag result`);
  assert.strictEqual(u32(e.get_stack_packet_entries()), 1,
    `${name}: packet counter`);
  assert.strictEqual(u32(e.get_stack_packet_0049d9d1_entries()), 1,
    `${name}: block counter`);
}

(async () => {
  const { exports: e } = await bootRenderHarness();

  assert.strictEqual(u32(e.get_stack_packet_enabled()), 0,
    'stack packet prototype should default off');
  e.set_stack_packet_enabled(1, BLOCK);
  assert.strictEqual(u32(e.get_stack_packet_enabled()), 1,
    'stack packet prototype should enable');
  assert.strictEqual(u32(e.get_stack_packet_addr()), BLOCK,
    'stack packet address should be recorded');

  runCase(e, 'equal fallthrough', 4, FALL, 0);
  runCase(e, 'not-equal branch', 7, TARGET, u32(4 - 7));

  console.log('PASS  AoE stack-packet handler updates state and exits correctly');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
