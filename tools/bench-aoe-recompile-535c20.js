#!/usr/bin/env node
// Microbenchmark for the AoE 0x00535c20 compiled-block proof of concept.
//
// This keeps the inner loop inside WAT: the block's indirect jump table points
// back to the block, and ESI walks a command-byte buffer filled with 0x0b.
// That compares the cached generic threaded block against the compiled handler
// without a JS call around each guest block.

const assert = require('assert');
const { performance } = require('perf_hooks');
const { bootRenderHarness } = require('../test/render-helper');

const BLOCK = 0x00535c20;
const SOURCE = 0x00200000;
const OLD_EDI = 0x00300040;
const ROW_NODE = 0x00440000;
const COMMAND = 0x0b;
const ITERATIONS = parseInt(process.env.ITERATIONS || '2000000', 10);
const WARMUP = parseInt(process.env.WARMUP || '100000', 10);

const BLOCK_BYTES = Uint8Array.from([
  0x89, 0x35, 0x50, 0x50, 0x77, 0x00,       // mov [0x775050], esi
  0x33, 0xc0,                               // xor eax,eax
  0x89, 0x3d, 0x54, 0x50, 0x77, 0x00,       // mov [0x775054], edi
  0x8a, 0x06,                               // mov al,[esi]
  0x2b, 0x3d, 0x20, 0x50, 0x77, 0x00,       // sub edi,[0x775020]
  0x8b, 0xc8,                               // mov ecx,eax
  0x46,                                     // inc esi
  0x83, 0xe0, 0x0f,                         // and eax,0xf
  0x8b, 0x1d, 0x3c, 0x50, 0x77, 0x00,       // mov ebx,[0x77503c]
  0xff, 0x24, 0x85, 0x00, 0x44, 0x53, 0x00, // jmp [0x534400+eax*4]
]);

const u32 = v => v >>> 0;
const hex = v => '0x' + u32(v).toString(16).padStart(8, '0');

(async () => {
  const { exports: e, memory } = await bootRenderHarness();
  const mem = new Uint8Array(memory.buffer);
  const guestBase = e.get_guest_base();
  const imageBase = e.get_image_base ? e.get_image_base() : 0;
  const wa = ga => (u32(ga) - u32(imageBase) + u32(guestBase)) >>> 0;

  mem.set(BLOCK_BYTES, wa(BLOCK));
  mem.fill(COMMAND, wa(SOURCE), wa(SOURCE) + ITERATIONS + WARMUP + 64);

  e.guest_write32(0x00775020, 0);
  e.guest_write32(0x0077503c, ROW_NODE);
  e.guest_write32(0x00534400 + COMMAND * 4, BLOCK);

  function prepare(enabled) {
    e.set_aoe_recompile_enabled(enabled ? 1 : 0);
    e.reset_aoe_recompile_counters();
    e.set_eip(BLOCK);
    e.set_eax(0);
    e.set_ecx(0);
    e.set_edx(0xcccccccc);
    e.set_ebx(0);
    e.set_ebp(0xeeeeeeee);
    e.set_esi(SOURCE);
    e.set_edi(OLD_EDI);
  }

  function run(label, enabled, iterations, report) {
    prepare(enabled);
    const start = performance.now();
    e.run(iterations);
    const ms = performance.now() - start;

    assert.strictEqual(u32(e.get_eip()), BLOCK, `${label}: eip ${hex(e.get_eip())}`);
    assert.strictEqual(u32(e.get_eax()), COMMAND, `${label}: eax`);
    assert.strictEqual(u32(e.get_ecx()), COMMAND, `${label}: ecx`);
    assert.strictEqual(u32(e.get_ebx()), ROW_NODE, `${label}: ebx`);
    assert.strictEqual(u32(e.get_esi()), SOURCE + iterations, `${label}: esi`);
    if (enabled) {
      assert.strictEqual(u32(e.get_aoe_recompile_00535c20_entries()), iterations,
        `${label}: compiled counter`);
    }

    if (report) {
      const blocksPerMs = iterations / ms;
      console.log(`${label}: ${ms.toFixed(2)}ms ${blocksPerMs.toFixed(1)} blocks/ms`);
    }
    return ms;
  }

  if (WARMUP > 0) {
    run('generic warmup', false, WARMUP, false);
    run('compiled warmup', true, WARMUP, false);
  }

  const genericMs = run('generic cached threaded', false, ITERATIONS, true);
  const compiledMs = run('compiled handler', true, ITERATIONS, true);
  const speedup = genericMs / compiledMs;
  console.log(`speedup: ${speedup.toFixed(3)}x (${ITERATIONS} blocks)`);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
