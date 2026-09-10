#!/usr/bin/env node
'use strict';

// Alternating same-process microbenchmark for the generic straight-line dword
// store-span fold.  It executes identical guest bytes with the decode-time
// matcher off/on, rotating order to cancel JIT warmup and machine drift.

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { createHostImports } = require('../lib/host-imports');
const RegionMap = require('../lib/region-map.generated');

const ROOT = path.join(__dirname, '..');

function storeEcxFromEbx(disp) {
  if (disp === 0) return [0x89, 0x19];
  if (disp <= 127) return [0x89, 0x59, disp];
  return [0x89, 0x99, disp & 255, (disp >>> 8) & 255,
    (disp >>> 16) & 255, (disp >>> 24) & 255];
}
function le32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >>> 1]; }

async function main() {
  const countArg = process.argv.find(a => a.startsWith('--dwords='));
  const iterArg = process.argv.find(a => a.startsWith('--iterations='));
  const repsArg = process.argv.find(a => a.startsWith('--reps='));
  const dwords = Number(countArg ? countArg.slice(9) : 63);
  const iterations = Number(iterArg ? iterArg.slice(13) : 20000);
  const reps = Number(repsArg ? repsArg.slice(7) : 9);
  if (!Number.isInteger(dwords) || dwords < 4 || dwords > 512 ||
      !Number.isInteger(iterations) || iterations < 1 ||
      !Number.isInteger(reps) || reps < 3) throw new Error('invalid benchmark arguments');

  const wasm = fs.readFileSync(path.join(ROOT, 'build', 'wine-assembly.wasm'));
  const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'entertainment-pack', 'golf.exe'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { exports: null, getMemory: () => memory.buffer };
  const h = createHostImports(ctx).host;
  Object.assign(h, { memory, exit() {}, log() {}, log_i32() {}, crash_unimplemented() {},
    wait_multiple: () => 0, shell_execute: () => 33 });
  const { instance } = await WebAssembly.instantiate(wasm, { host: h });
  ctx.exports = instance.exports;
  const e = instance.exports;
  const mem = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  mem.set(exe, e.get_staging());
  e.load_pe(exe.length);
  const imageBase = e.get_image_base() >>> 0;
  const g2w = ga => RegionMap.g2w(ga >>> 0, imageBase);
  const code = imageBase + 0x1800;
  const data = imageBase + 0x9000;
  const stack = imageBase + 0xD00000;
  const stores = [];
  for (let i = 0; i < dwords; i++) stores.push(...storeEcxFromEbx(i * 4));
  const branch = stores.length + 1;
  const rel = -(branch + 6);
  const bytes = [...stores, 0x4A, 0x0F, 0x85, ...le32(rel), 0xC3]; // dec edx; jnz head; ret
  mem.set(bytes, g2w(code));

  function run(enabled) {
    e.set_store_span_fusion(enabled ? 1 : 0);
    mem.fill(0xA5, g2w(data), g2w(data) + dwords * 4);
    dv.setUint32(g2w(stack), 0, true);
    e.set_esp(stack); e.set_ecx(data); e.set_ebx(0); e.set_edx(iterations); e.set_eip(code);
    const start = performance.now();
    e.run(0x7FFFFFFF);
    const elapsedMs = performance.now() - start;
    if (e.get_eip() !== 0 || e.get_edx() !== 0) throw new Error('guest loop did not finish');
    return elapsedMs;
  }

  run(false); run(true);
  const scalar = [], fused = [];
  for (let i = 0; i < reps; i++) {
    const order = i & 1 ? [true, false] : [false, true];
    for (const enabled of order) (enabled ? fused : scalar).push(run(enabled));
  }
  const scalarMedian = median(scalar), fusedMedian = median(fused);
  console.log(JSON.stringify({ dwords, spanBytes: dwords * 4, iterations, reps,
    scalarMs: scalarMedian, fusedMs: fusedMedian, speedup: scalarMedian / fusedMedian,
    scalarSamples: scalar, fusedSamples: fused }, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
