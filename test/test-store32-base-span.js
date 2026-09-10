#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');
const RegionMap = require('../lib/region-map.generated');

const ROOT = path.join(__dirname, '..');
const wasmBytes = fs.readFileSync(path.join(ROOT, 'build/wine-assembly.wasm'));
const exeBytes = fs.readFileSync(path.join(__dirname, 'binaries', 'entertainment-pack', 'golf.exe'));

function storeEcxFromEbx(disp) {
  if (disp === 0) return [0x89, 0x19];
  if (disp >= -128 && disp <= 127) return [0x89, 0x59, disp & 255];
  return [0x89, 0x99, disp & 255, (disp >>> 8) & 255,
    (disp >>> 16) & 255, (disp >>> 24) & 255];
}

async function instantiate() {
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { exports: null, getMemory: () => memory.buffer };
  const h = createHostImports(ctx).host;
  Object.assign(h, { memory, exit() {}, log() {}, log_i32() {}, crash_unimplemented() {},
    wait_multiple: () => 0, shell_execute: () => 33 });
  const { instance } = await WebAssembly.instantiate(wasmBytes, { host: h });
  ctx.exports = instance.exports;
  const e = instance.exports;
  const mem = new Uint8Array(memory.buffer);
  mem.set(exeBytes, e.get_staging());
  e.load_pe(exeBytes.length);
  const imageBase = e.get_image_base() >>> 0;
  const g2w = ga => RegionMap.g2w(ga >>> 0, imageBase);
  return { memory, e, mem, dv: new DataView(memory.buffer), imageBase, g2w };
}

function runCode(env, code, codeGa, base, value) {
  const { e, mem, dv, imageBase, g2w } = env;
  mem.set(code, g2w(codeGa));
  const stack = imageBase + 0xD00000;
  dv.setUint32(g2w(stack), 0, true);
  e.set_esp(stack);
  e.set_ecx(base);
  e.set_ebx(value);
  e.set_eip(codeGa);
  e.run(100000);
}

function codeFor(disps) {
  return [...disps.flatMap(storeEcxFromEbx), 0xC3];
}

function h447(env) {
  const hist = new Uint32Array(env.memory.buffer, env.e.get_handler_hist_base(),
    env.e.get_handler_hist_slots());
  return hist[448] >>> 0;
}

(async () => {
  const env = await instantiate();
  const { e, mem, dv, imageBase, g2w } = env;
  const code = imageBase + 0x1800;
  const data = imageBase + 0x8100;
  e.reset_handler_hist();
  e.set_handler_hist_enabled(1);

  // Identical guest bytes first take the scalar decoder path with the A/B
  // switch off, then the memory.fill fast path with it on.
  mem.fill(0xA5, g2w(data), g2w(data) + 32);
  e.set_store_span_fusion(0);
  runCode(env, codeFor([0, 4, 8, 12, 16, 20, 24, 28]), code, data, 0);
  assert.deepStrictEqual([...mem.slice(g2w(data), g2w(data) + 32)], Array(32).fill(0));
  assert.strictEqual(h447(env), 0, 'disabled matcher should retain scalar stores');
  mem.fill(0xA5, g2w(data), g2w(data) + 32);
  e.set_store_span_fusion(1);
  runCode(env, codeFor([0, 4, 8, 12, 16, 20, 24, 28]), code, data, 0);
  assert.deepStrictEqual([...mem.slice(g2w(data), g2w(data) + 32)], Array(32).fill(0));
  assert.strictEqual(h447(env), 1, 'same-page zero span should fuse');

  // A nonzero repeated dword still fuses, but takes the exact gs32 fallback.
  const nonzero = data + 0x100;
  runCode(env, codeFor([0, 4, 8, 12]), code + 0x100, nonzero, 0x78563412);
  for (let i = 0; i < 4; i++) assert.strictEqual(dv.getUint32(g2w(nonzero + i * 4), true), 0x78563412);
  assert.strictEqual(h447(env), 2, 'nonzero span should use fused scalar fallback');

  // A zero span crossing a guest page must fall back rather than assuming one
  // affine mapping, while retaining the same writes on both sides.
  const crossing = (data & ~0xFFF) + 0xFF8;
  mem.fill(0x5A, g2w(crossing), g2w(crossing) + 16);
  runCode(env, codeFor([0, 4, 8, 12]), code + 0x200, crossing, 0);
  assert.deepStrictEqual([...mem.slice(g2w(crossing), g2w(crossing) + 16)], Array(16).fill(0));
  assert.strictEqual(h447(env), 3, 'page-crossing span should stay semantically fused');

  // An unmapped page translates every scalar store to the four-byte null
  // sentinel.  The fast path must reject it: filling the whole nominal span
  // at 0xF0 would corrupt adjacent emulator memory and change fault behavior.
  mem.fill(0xA5, 0xF0, 0x100);
  runCode(env, codeFor([0, 4, 8, 12]), code + 0x280, 0x60001000, 0);
  assert.deepStrictEqual([...mem.slice(0xF0, 0xF4)], Array(4).fill(0));
  assert.deepStrictEqual([...mem.slice(0xF4, 0x100)], Array(12).fill(0xA5));
  assert.strictEqual(h447(env), 4, 'unmapped span should use the scalar fault fallback');

  // A displacement gap is not a span and must remain ordinary stores.
  const gapped = data + 0x200;
  mem.fill(0xCC, g2w(gapped), g2w(gapped) + 20);
  runCode(env, codeFor([0, 4, 12, 16]), code + 0x300, gapped, 0);
  assert.strictEqual(h447(env), 4, 'gapped stores must decline');
  assert.deepStrictEqual([...mem.slice(g2w(gapped), g2w(gapped) + 20)],
    [0, 0, 0, 0, 0, 0, 0, 0, 0xCC, 0xCC, 0xCC, 0xCC, 0, 0, 0, 0, 0, 0, 0, 0]);

  // Decode a target, retire it through one range invalidation from a fused
  // fill, then restore different bytes without another emulator-visible write.
  // Seeing EAX=2 proves the stale EAX=1 decoded block was discarded.
  const target = imageBase + 0xA100;
  runCode(env, [0xB8, 1, 0, 0, 0, 0xC3], target, 0, 0);
  assert.strictEqual(e.get_eax(), 1);
  runCode(env, codeFor([0, 4, 8, 12]), code + 0x400, target, 0);
  mem.set([0xB8, 2, 0, 0, 0, 0xC3], g2w(target));
  runCode(env, [...mem.slice(g2w(target), g2w(target) + 6)], target, 0, 0);
  assert.strictEqual(e.get_eax(), 2, 'range fill must invalidate decoded destination code');

  e.set_handler_hist_enabled(0);
  console.log('store32 base span: PASS', JSON.stringify({ fusedRuns: h447(env) }));
})().catch(error => { console.error(error); process.exit(1); });
