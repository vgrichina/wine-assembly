#!/usr/bin/env node
'use strict';

// Fixed-guest-work production benchmark for the four-op x87 folds. The loop
// and all x87 instructions are real decoded x86; only the fusion gate changes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { createHostImports } = require('../lib/host-imports');
const RegionMap = require('../lib/region-map.generated');

const ROOT = path.join(__dirname, '..');
const ITERATIONS = +(process.env.X87_PIPELINE_ITERS || 200000);
const ROUNDS = +(process.env.X87_PIPELINE_ROUNDS || 9);
const SHAPE = process.env.X87_PIPELINE_SHAPE || 'pipeline';
if (!['pipeline', 'tree', 'island'].includes(SHAPE)) {
  throw new Error('X87_PIPELINE_SHAPE must be pipeline, tree, or island');
}
const FUSED_HANDLER = SHAPE === 'island' ? 450 : (SHAPE === 'tree' ? 449 : 448);
const FUSED_PER_ITERATION = SHAPE === 'island' ? 2 : 1;

function le32(v) {
  return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
}

async function boot() {
  const wasm = fs.readFileSync(path.join(ROOT, 'build', 'wine-assembly.wasm'));
  const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'notepad.exe'));
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
  assert(e.load_pe(exe.length));
  const imageBase = e.get_image_base() >>> 0;
  const g2w = ga => RegionMap.g2w(ga >>> 0, imageBase);
  const code = (imageBase + 0x30000) >>> 0;
  const data = (imageBase + 0x50000) >>> 0;
  const output = (data + 0x100) >>> 0;
  const stack = (imageBase + 0xD00000) >>> 0;
  if (SHAPE === 'island') {
    dv.setInt32(g2w(data), 13, true);
    dv.setInt32(g2w(data + 4), -5, true);
    dv.setFloat32(g2w(data + 8), 0.625, true);
    dv.setFloat32(g2w(data + 12), -1.75, true);
    dv.setFloat32(g2w(data + 16), 2.25, true);
    dv.setFloat32(g2w(data + 20), 17.5, true);
  } else {
    dv.setFloat32(g2w(data), 1.25, true);
    dv.setFloat32(g2w(data + 4), -3.5, true);
    dv.setFloat32(g2w(data + 8), 7.75, true);
  }

  // mov ecx,N; loop: one four-op expression; dec ecx; jnz loop; ret
  const body = SHAPE === 'island' ? [
    0xDB, 0x46, 0x00, 0xDB, 0x46, 0x04, 0xD9, 0xC0,
    0xD8, 0x0D, ...le32(data + 8), 0xD9, 0xCA, 0xDC, 0xC1,
    0xD8, 0x0D, ...le32(data + 12), 0xD9, 0xC9,
    0xD8, 0x0D, ...le32(data + 16),
    0x90,
    0xDC, 0xC1, 0xDE, 0xEA, 0xD8, 0x05, ...le32(data + 20),
    0xD9, 0xC9, 0xD8, 0x05, ...le32(data + 20),
    0x90,
    0xDD, 0x1D, ...le32(output), 0xDD, 0x1D, ...le32(output + 8),
    0x49,
  ] : SHAPE === 'tree' ? [
    0xD9, 0x46, 0x00, // fld [esi]
    0xD9, 0x46, 0x04, // fld [esi+4]
    0xDE, 0xC1,       // faddp st(1),st(0)
    0xD9, 0x5F, 0x00, // fstp [edi]
    0x49,
  ] : [
    0xD9, 0x46, 0x00,
    0xD8, 0x4E, 0x04,
    0xD8, 0x46, 0x08,
    0xD9, 0x5F, 0x00,
    0x49,
  ];
  const loopOffset = 5;
  const codeBytes = [0xB9, ...le32(ITERATIONS), ...body, 0x0F, 0x85];
  const afterDisp = codeBytes.length + 4;
  codeBytes.push(...le32(loopOffset - afterDisp), 0xC3);
  mem.set(codeBytes, g2w(code));

  function run(mode) {
    e.set_x87_pipeline4_fusion(mode >= 1 ? 1 : 0);
    e.set_x87_affine_fusion(mode >= 2 ? 1 : 0);
    e.reset_handler_hist();
    e.set_handler_hist_enabled(1);
    dv.setUint32(g2w(stack), 0, true);
    dv.setUint32(g2w(output), 0, true);
    e.set_esi(data); e.set_edi(output); e.set_esp(stack); e.set_eip(code);
    const start = performance.now();
    let calls = 0;
    while ((e.get_eip() >>> 0) !== 0) {
      e.run(1000000);
      if (++calls > 100) throw new Error('pipeline benchmark did not terminate');
    }
    const elapsed = performance.now() - start;
    const hist = new Uint32Array(memory.buffer, e.get_handler_hist_base(),
      e.get_handler_hist_slots());
    const result = SHAPE === 'island'
      ? [dv.getFloat64(g2w(output), true), dv.getFloat64(g2w(output + 8), true)]
      : dv.getFloat32(g2w(output), true);
    return { elapsed, calls, fused: hist[FUSED_HANDLER] >>> 0,
      affinePrepare: hist[451] >>> 0, affineFinish: hist[452] >>> 0, result };
  }
  return { run };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

(async () => {
  const h = await boot();
  h.run(0); h.run(1);
  if (SHAPE === 'island') h.run(2);
  const samples = { scalar: [], fused: [], semantic: [] };
  let lastScalar, lastFused, lastSemantic;
  for (let i = 0; i < ROUNDS; i++) {
    const modes = SHAPE === 'island'
      ? [[0, 1, 2], [1, 2, 0], [2, 0, 1]][i % 3]
      : (i & 1 ? [1, 0] : [0, 1]);
    for (const mode of modes) {
      const result = h.run(mode);
      const key = mode === 0 ? 'scalar' : (mode === 1 ? 'fused' : 'semantic');
      samples[key].push(result.elapsed);
      if (mode === 0) lastScalar = result;
      else if (mode === 1) lastFused = result;
      else lastSemantic = result;
    }
  }
  assert.deepStrictEqual(lastFused.result, lastScalar.result);
  assert.strictEqual(lastScalar.fused, 0);
  assert.strictEqual(lastFused.fused, ITERATIONS * FUSED_PER_ITERATION);
  const scalarMs = median(samples.scalar);
  const fusedMs = median(samples.fused);
  const output = { shape: SHAPE, handler: FUSED_HANDLER,
    iterations: ITERATIONS, rounds: ROUNDS,
    scalarMs, fusedMs, ratio: fusedMs / scalarMs,
    speedup: scalarMs / fusedMs, scalarCalls: lastScalar.calls,
    fusedCalls: lastFused.calls, result: lastFused.result };
  if (SHAPE === 'island') {
    assert.deepStrictEqual(lastSemantic.result, lastScalar.result);
    assert.strictEqual(lastSemantic.fused, 0);
    assert.strictEqual(lastSemantic.affinePrepare, ITERATIONS);
    assert.strictEqual(lastSemantic.affineFinish, ITERATIONS);
    const semanticMs = median(samples.semantic);
    Object.assign(output, { semanticMs, semanticVsScalar: scalarMs / semanticMs,
      semanticVsIsland: fusedMs / semanticMs, semanticCalls: lastSemantic.calls });
  }
  console.log(JSON.stringify(output, null, 2));
})().catch(error => { console.error(error); process.exit(1); });
