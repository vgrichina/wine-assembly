#!/usr/bin/env node
// Deterministic coverage for the disabled-by-default AoE span-prefix
// stack-packet prototype at 0x0049dd20.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const TRACE = 0x0049dd20;
const EMPTY_ROW = 0x0049dd8b;
const NONEMPTY_ROW = 0x0049ddc7;
const REJECT = 0x0049e0ad;
const RETURN_EIP = 0x12345678;

const u32 = v => v >>> 0;
const hex = v => '0x' + u32(v).toString(16).padStart(8, '0');

function writeBaseScenario(e, opts = {}) {
  const esp = opts.esp || 0x9000;
  const thisPtr = opts.thisPtr || 0x2000;
  const rowTable = opts.rowTable || 0x4000;
  const row = opts.row == null ? 3 : opts.row;
  const x0 = opts.x0 == null ? 20 : opts.x0;
  const x1 = opts.x1 == null ? 40 : opts.x1;
  const rowHead = opts.rowHead || 0;

  e.set_eip(TRACE);
  e.set_esp(esp);
  e.set_ecx(thisPtr);
  e.set_eax(0xaaaaaaaa);
  e.set_ebx(0xbbbbbbbb);
  e.set_edx(0xdddddddd);
  e.set_ebp(0xeeeeeeee);
  e.set_esi(0x51515151);
  e.set_edi(0x71717171);

  e.guest_write32(esp, RETURN_EIP);
  e.guest_write32(esp + 4, x0);
  e.guest_write32(esp + 8, x1);
  e.guest_write32(esp + 12, row);

  e.guest_write32(thisPtr + 0x3c, rowTable);
  e.guest_write32(thisPtr + 0x58, opts.minX == null ? 10 : opts.minX);
  e.guest_write32(thisPtr + 0x5c, opts.maxX == null ? 100 : opts.maxX);
  e.guest_write32(thisPtr + 0x60, opts.minRow == null ? 0 : opts.minRow);
  e.guest_write32(thisPtr + 0x64, opts.maxRow == null ? 10 : opts.maxRow);
  e.guest_write32(rowTable + row * 4, rowHead);

  return {
    esp,
    thisPtr,
    rowTable,
    row,
    rowHead,
    oldEbx: 0xbbbbbbbb,
    oldEbp: 0xeeeeeeee,
    oldEsi: 0x51515151,
    oldEdi: 0x71717171,
  };
}

function assertPrologue(e, s, name) {
  assert.strictEqual(u32(e.get_esp()), s.esp - 16, `${name}: esp`);
  assert.strictEqual(u32(e.guest_read32(s.esp - 4)), s.oldEbx, `${name}: pushed ebx`);
  assert.strictEqual(u32(e.guest_read32(s.esp - 8)), s.oldEbp, `${name}: pushed ebp`);
  assert.strictEqual(u32(e.guest_read32(s.esp - 12)), s.oldEsi, `${name}: pushed esi`);
  assert.strictEqual(u32(e.guest_read32(s.esp - 16)), s.oldEdi, `${name}: pushed edi`);
  assert.strictEqual(u32(e.get_esi()), s.thisPtr, `${name}: esi=this`);
}

function runEmptyRowCase(e) {
  const s = writeBaseScenario(e, {
    rowHead: 0,
    x0: 120,
    x1: 4,
    minX: 10,
    maxX: 100,
  });
  e.reset_stack_packet_counters();
  e.run(1);

  assert.strictEqual(u32(e.get_eip()), EMPTY_ROW, `empty row eip ${hex(e.get_eip())}`);
  assertPrologue(e, s, 'empty row');
  assert.strictEqual(u32(e.guest_read32(e.get_esp() + 0x14)), 10, 'empty row: low clip');
  assert.strictEqual(u32(e.guest_read32(e.get_esp() + 0x18)), 100, 'empty row: high clip');
  assert.strictEqual(u32(e.get_eax()), s.rowTable, 'empty row: eax=row table');
  assert.strictEqual(u32(e.get_ebx()), 0, 'empty row: ebx=row head');
  assert.strictEqual(u32(e.get_ebp()), 100, 'empty row: ebp=clipped x1');
  assert.strictEqual(u32(e.get_ecx()), 10, 'empty row: ecx=min x');
  assert.strictEqual(u32(e.get_edx()), 100, 'empty row: edx=max x');
  assert.strictEqual(u32(e.get_edi()), s.row * 4, 'empty row: edi=row offset');
  assert.strictEqual(u32(e.get_flag_op()), 3, 'empty row: final flags from test');
  assert.strictEqual(u32(e.get_flag_res()), 0, 'empty row: test zero');
  assert.strictEqual(u32(e.get_stack_packet_0049dd20_entries()), 1, 'empty row: trace count');
  assert.strictEqual(u32(e.get_stack_packet_0049dd20_to_dd8b_entries()), 1,
    'empty row: exit count');
}

function runEmptyRowInlineCase(e) {
  const s = writeBaseScenario(e, { rowHead: 0, x0: 20, x1: 40 });
  const tailTable = 0x4800;
  const minTable = 0x5000;
  const maxTable = 0x5800;
  const countTable = 0x6000;
  const node = 0x7000;
  const nextFree = 0x7100;
  const off = s.row * 4;

  e.guest_write32(s.thisPtr + 0x10, node);
  e.guest_write32(s.thisPtr + 0x20, 9);
  e.guest_write32(node, nextFree);
  e.guest_write32(s.thisPtr + 0x40, tailTable);
  e.guest_write32(s.thisPtr + 0x44, minTable);
  e.guest_write32(s.thisPtr + 0x48, maxTable);
  e.guest_write32(s.thisPtr + 0x4c, countTable);
  e.guest_write32(countTable + off, 4);

  e.reset_stack_packet_counters();
  e.run(1);

  assert.strictEqual(u32(e.get_eip()), RETURN_EIP,
    `inline empty row eip ${hex(e.get_eip())}`);
  assert.strictEqual(u32(e.get_esp()), s.esp + 16, 'inline empty row: ret 0xc esp');
  assert.strictEqual(u32(e.get_ebx()), s.oldEbx, 'inline empty row: restored ebx');
  assert.strictEqual(u32(e.get_ebp()), s.oldEbp, 'inline empty row: restored ebp');
  assert.strictEqual(u32(e.get_esi()), s.oldEsi, 'inline empty row: restored esi');
  assert.strictEqual(u32(e.get_edi()), s.oldEdi, 'inline empty row: restored edi');

  assert.strictEqual(u32(e.guest_read32(s.thisPtr + 0x10)), nextFree,
    'inline empty row: free-list head consumed');
  assert.strictEqual(u32(e.guest_read32(s.thisPtr + 0x20)), 8,
    'inline empty row: allocator count decremented');
  assert.strictEqual(u32(e.guest_read32(node)), 0, 'inline empty row: node next');
  assert.strictEqual(u32(e.guest_read32(node + 4)), 0, 'inline empty row: node prev');
  assert.strictEqual(u32(e.guest_read32(node + 8)), 20, 'inline empty row: node x0');
  assert.strictEqual(u32(e.guest_read32(node + 12)), 40, 'inline empty row: node x1');
  assert.strictEqual(u32(e.guest_read32(s.rowTable + off)), node,
    'inline empty row: row head');
  assert.strictEqual(u32(e.guest_read32(tailTable + off)), node,
    'inline empty row: row tail');
  assert.strictEqual(u32(e.guest_read32(minTable + off)), 20,
    'inline empty row: row min');
  assert.strictEqual(u32(e.guest_read32(maxTable + off)), 40,
    'inline empty row: row max');
  assert.strictEqual(u32(e.guest_read32(countTable + off)), 5,
    'inline empty row: count incremented');
  assert.strictEqual(u32(e.get_eax()), minTable, 'inline empty row: eax');
  assert.strictEqual(u32(e.get_ecx()), maxTable, 'inline empty row: ecx');
  assert.strictEqual(u32(e.get_edx()), countTable, 'inline empty row: edx');
  assert.strictEqual(u32(e.get_flag_op()), 4, 'inline empty row: final flags from inc');
  assert.strictEqual(u32(e.get_flag_a()), 4, 'inline empty row: inc flag a');
  assert.strictEqual(u32(e.get_flag_res()), 5, 'inline empty row: inc flag result');
  assert.strictEqual(u32(e.get_stack_packet_0049dd20_empty_inline_entries()), 1,
    'inline empty row: inline count');
}

function runNonemptyRowCase(e) {
  const s = writeBaseScenario(e, { rowHead: 0x6000, x0: 20, x1: 40 });
  e.reset_stack_packet_counters();
  e.run(1);

  assert.strictEqual(u32(e.get_eip()), NONEMPTY_ROW, `nonempty row eip ${hex(e.get_eip())}`);
  assertPrologue(e, s, 'nonempty row');
  assert.strictEqual(u32(e.get_eax()), s.rowTable, 'nonempty row: eax=row table');
  assert.strictEqual(u32(e.get_ebx()), s.rowHead, 'nonempty row: ebx=row head');
  assert.strictEqual(u32(e.get_edi()), s.row * 4, 'nonempty row: edi=row offset');
  assert.strictEqual(u32(e.get_flag_op()), 3, 'nonempty row: final flags from test');
  assert.strictEqual(u32(e.get_flag_res()), s.rowHead, 'nonempty row: test nonzero');
  assert.strictEqual(u32(e.get_stack_packet_0049dd20_to_ddc7_entries()), 1,
    'nonempty row: exit count');
}

function runRejectCase(e) {
  const s = writeBaseScenario(e, { row: 20, minRow: 0, maxRow: 10 });
  e.reset_stack_packet_counters();
  e.run(1);

  assert.strictEqual(u32(e.get_eip()), REJECT, `reject eip ${hex(e.get_eip())}`);
  assertPrologue(e, s, 'reject');
  assert.strictEqual(u32(e.get_edi()), 20, 'reject: edi=row, not row offset');
  assert.strictEqual(u32(e.get_edx()), 0xdddddddd, 'reject: edx unchanged before max-x load');
  assert.strictEqual(u32(e.get_flag_op()), 2, 'reject: final flags from cmp');
  assert.strictEqual(u32(e.get_flag_a()), 20, 'reject: cmp lhs');
  assert.strictEqual(u32(e.get_flag_b()), 10, 'reject: cmp rhs');
  assert.strictEqual(u32(e.get_flag_res()), 10, 'reject: cmp result');
  assert.strictEqual(u32(e.get_stack_packet_0049dd20_to_e0ad_entries()), 1,
    'reject: exit count');
}

(async () => {
  const { exports: e } = await bootRenderHarness();

  assert.strictEqual(u32(e.get_stack_packet_enabled()), 0,
    'stack packet prototype should default off');
  e.set_stack_packet_enabled(1, TRACE);
  assert.strictEqual(u32(e.get_stack_packet_addr()), TRACE,
    'stack packet address should be recorded');

  runEmptyRowCase(e);
  runEmptyRowInlineCase(e);
  runNonemptyRowCase(e);
  runRejectCase(e);

  console.log('PASS  AoE span-prefix trace handler updates state and exits correctly');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
