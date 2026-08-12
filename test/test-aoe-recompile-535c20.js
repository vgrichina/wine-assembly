#!/usr/bin/env node
// Deterministic coverage for the disabled-by-default AoE compiled-block POC.
// The block covers the software blitter command dispatch at 0x00535c20.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const BLOCK = 0x00535c20;
const SOURCE = 0x00200000;
const OLD_ESI = SOURCE;
const OLD_EDI = 0x00300040;
const CLIP_BASE = 0x00300010;
const ROW_NODE = 0x00440000;
const TARGET = 0x00535e00;

const u32 = v => v >>> 0;
const hex = v => '0x' + u32(v).toString(16).padStart(8, '0');

(async () => {
  const { exports: e } = await bootRenderHarness();

  assert.strictEqual(u32(e.get_aoe_recompile_enabled()), 0,
    'AoE recompile POC defaults off');
  e.set_aoe_recompile_enabled(1);
  assert.strictEqual(u32(e.get_aoe_recompile_enabled()), 1,
    'AoE recompile POC enables');

  e.set_eip(BLOCK);
  e.set_eax(0xaaaaaaaa);
  e.set_ecx(0xbbbbbbbb);
  e.set_edx(0xcccccccc);
  e.set_ebx(0xdddddddd);
  e.set_ebp(0xeeeeeeee);
  e.set_esi(OLD_ESI);
  e.set_edi(OLD_EDI);

  e.guest_write32(SOURCE, 0x000000ab);
  e.guest_write32(0x00775020, CLIP_BASE);
  e.guest_write32(0x0077503c, ROW_NODE);
  e.guest_write32(0x00534400 + 0x0b * 4, TARGET);

  e.reset_aoe_recompile_counters();
  e.run(1);

  assert.strictEqual(u32(e.get_eip()), TARGET,
    `wrong jump target, got ${hex(e.get_eip())}`);
  assert.strictEqual(u32(e.get_eax()), 0x0b, 'eax = command low nibble');
  assert.strictEqual(u32(e.get_ecx()), 0xab, 'ecx = full command byte');
  assert.strictEqual(u32(e.get_ebx()), ROW_NODE, 'ebx = current span node');
  assert.strictEqual(u32(e.get_esi()), OLD_ESI + 1, 'esi increments past command byte');
  assert.strictEqual(u32(e.get_edi()), OLD_EDI - CLIP_BASE, 'edi subtracts clip base');
  assert.strictEqual(u32(e.get_edx()), 0xcccccccc, 'edx unchanged');
  assert.strictEqual(u32(e.get_ebp()), 0xeeeeeeee, 'ebp unchanged');

  assert.strictEqual(u32(e.guest_read32(0x00775050)), OLD_ESI,
    '[0x775050] saves incoming esi');
  assert.strictEqual(u32(e.guest_read32(0x00775054)), OLD_EDI,
    '[0x775054] saves incoming edi');

  assert.strictEqual(u32(e.get_flag_op()), 3, 'final flags are logic flags from AND');
  assert.strictEqual(u32(e.get_flag_res()), 0x0b, 'flag result = eax after AND');
  assert.strictEqual(u32(e.get_flag_sign_shift()), 31, '32-bit flag width');
  assert.strictEqual(u32(e.get_aoe_recompile_entries()), 1, 'compiled entry counter');
  assert.strictEqual(u32(e.get_aoe_recompile_00535c20_entries()), 1,
    'compiled block counter');

  console.log('PASS  AoE 0x00535c20 compiled block updates state and jumps correctly');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
