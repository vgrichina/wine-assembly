#!/usr/bin/env node
'use strict';

// Deterministic integration oracle for handler 448.  Both arms execute the
// same finite guest loop under deliberately small, uneven run() budgets.  The
// optimized arm may retire more x86 instructions per scheduler step (like the
// other threaded super-ops), but it must reach byte-for-byte identical memory,
// registers, and lazy-flag state after the same guest work.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const RegionMap = require('../lib/region-map.generated');

const ROOT = path.join(__dirname, '..');
const wasm = fs.readFileSync(path.join(ROOT, 'build', 'wine-assembly.wasm'));
const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries',
  'entertainment-pack', 'golf.exe'));
const DWORDS = 16;
const ITERATIONS = 257;

function le32(v) {
  return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
}

function storeEcxFromEbx(disp) {
  if (disp === 0) return [0x89, 0x19];
  if (disp <= 127) return [0x89, 0x59, disp];
  return [0x89, 0x99, ...le32(disp)];
}

async function runArm(enabled) {
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { exports: null, getMemory: () => memory.buffer };
  const host = createHostImports(ctx).host;
  Object.assign(host, { memory, exit() {}, log() {}, log_i32() {},
    crash_unimplemented() {}, wait_multiple: () => 0, shell_execute: () => 33 });
  const { instance } = await WebAssembly.instantiate(wasm, { host });
  ctx.exports = instance.exports;
  const e = instance.exports;
  const mem = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  mem.set(exe, e.get_staging());
  e.load_pe(exe.length);

  const imageBase = e.get_image_base() >>> 0;
  const g2w = ga => RegionMap.g2w(ga >>> 0, imageBase);
  const code = imageBase + 0x1800;
  const data = imageBase + 0x8800;
  const stack = imageBase + 0xD00000;
  const stores = [];
  for (let i = 0; i < DWORDS; i++) stores.push(...storeEcxFromEbx(i * 4));
  const rel = -(stores.length + 7);
  mem.set([...stores, 0x4A, 0x0F, 0x85, ...le32(rel), 0xC3], g2w(code));
  for (let i = 0; i < DWORDS * 4; i++) mem[g2w(data) + i] = (i * 29 + 7) & 255;
  dv.setUint32(g2w(stack), 0, true);

  e.set_store_span_fusion(enabled ? 1 : 0);
  e.reset_handler_hist();
  e.set_handler_hist_enabled(1);
  e.set_esp(stack);
  e.set_ecx(data);
  e.set_ebx(0);
  e.set_edx(ITERATIONS);
  e.set_eip(code);

  const budgets = [1, 7, 2, 11, 3];
  let calls = 0;
  while ((e.get_eip() >>> 0) !== 0) {
    e.run(budgets[calls % budgets.length]);
    if (++calls > 20000) throw new Error('fixed guest loop did not terminate');
  }
  const hist = new Uint32Array(memory.buffer, e.get_handler_hist_base(),
    e.get_handler_hist_slots());
  const result = {
    memory: [...mem.slice(g2w(data), g2w(data) + DWORDS * 4)],
    registers: [e.get_eip(), e.get_esp(), e.get_eax(), e.get_ecx(), e.get_edx(),
      e.get_ebx(), e.get_ebp(), e.get_esi(), e.get_edi()],
    lazyFlags: [e.get_flag_res(), e.get_flag_op(), e.get_flag_a(),
      e.get_flag_b(), e.get_flag_sign_shift()],
    scalarStores: hist[348] >>> 0,
    fusedSpans: hist[448] >>> 0,
    runCalls: calls,
  };
  e.set_handler_hist_enabled(0);
  return result;
}

(async () => {
  const scalar = await runArm(false);
  const fused = await runArm(true);
  assert.deepStrictEqual(fused.memory, scalar.memory, 'final memory differs');
  assert.deepStrictEqual(fused.registers, scalar.registers, 'final registers differ');
  assert.deepStrictEqual(fused.lazyFlags, scalar.lazyFlags, 'final lazy flags differ');
  assert.deepStrictEqual(fused.memory, Array(DWORDS * 4).fill(0));
  assert.strictEqual(scalar.scalarStores, DWORDS * ITERATIONS);
  assert.strictEqual(scalar.fusedSpans, 0);
  assert.strictEqual(fused.scalarStores, 0);
  assert.strictEqual(fused.fusedSpans, ITERATIONS);
  assert(scalar.runCalls > 0 && fused.runCalls > 0,
    'both arms must make progress through bounded run() slices');
  console.log('store32 span fixed work: PASS', JSON.stringify({
    dwords: DWORDS, iterations: ITERATIONS,
    scalarRunCalls: scalar.runCalls, fusedRunCalls: fused.runCalls,
    scalarStores: scalar.scalarStores, fusedSpans: fused.fusedSpans,
  }));
})().catch(error => { console.error(error); process.exit(1); });
