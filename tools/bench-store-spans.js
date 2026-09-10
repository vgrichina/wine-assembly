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
const { readPE } = require('../lib/pe');
const { findStoreSpans } = require('./find-store-spans');

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
  const peArg = process.argv.find(a => a.startsWith('--pe='));
  const vaArg = process.argv.find(a => a.startsWith('--va='));
  const dwords = Number(countArg ? countArg.slice(9) : 63);
  const iterations = Number(iterArg ? iterArg.slice(13) : 20000);
  const reps = Number(repsArg ? repsArg.slice(7) : 9);
  if ((!peArg && (!Number.isInteger(dwords) || dwords < 4 || dwords > 512)) ||
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
  let stores = [];
  let spanDwords = dwords;
  let spanStartDisp = 0;
  let baseReg = 'ecx';
  let srcReg = 'ebx';
  let site = 'synthetic';
  if (peArg) {
    const pePath = peArg.slice(5);
    const requestedVa = vaArg ? Number(vaArg.slice(5)) : NaN;
    const hits = findStoreSpans(pePath, { min: 4 });
    const hit = Number.isFinite(requestedVa)
      ? hits.find(h => h.va === (requestedVa >>> 0))
      : hits.sort((a, b) => b.count - a.count)[0];
    if (!hit) throw new Error('requested PE has no matching store span/site');
    const pe = readPE(pePath);
    const off = pe.va2off(hit.va);
    stores = [...pe.buf.subarray(off, off + hit.bytes)];
    spanDwords = hit.count;
    spanStartDisp = hit.startDisp;
    baseReg = hit.base;
    srcReg = hit.src;
    site = `${path.basename(pePath)}@0x${hit.va.toString(16)}`;
  } else {
    for (let i = 0; i < dwords; i++) stores.push(...storeEcxFromEbx(i * 4));
  }
  const counterReg = ['edx', 'ebx', 'esi', 'edi', 'ebp', 'eax', 'ecx']
    .find(reg => reg !== baseReg && reg !== srcReg);
  const counterIndex = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi']
    .indexOf(counterReg);
  const branch = stores.length + 1;
  const rel = -(branch + 6);
  const bytes = [...stores, 0x48 + counterIndex, 0x0F, 0x85, ...le32(rel), 0xC3];
  mem.set(bytes, g2w(code));

  function run(enabled, loopCount = iterations, histogram = false) {
    e.set_store_span_fusion(enabled ? 1 : 0);
    e.reset_handler_hist();
    e.set_handler_hist_enabled(histogram ? 1 : 0);
    mem.fill(0xA5, g2w(data), g2w(data) + spanDwords * 4);
    dv.setUint32(g2w(stack), 0, true);
    e.set_esp(stack);
    e[`set_${baseReg}`]((data - spanStartDisp) >>> 0);
    e[`set_${srcReg}`](0);
    e[`set_${counterReg}`](loopCount);
    e.set_eip(code);
    const start = performance.now();
    e.run(0x7FFFFFFF);
    const elapsedMs = performance.now() - start;
    if (e.get_eip() !== 0 || e[`get_${counterReg}`]() !== 0) throw new Error('guest loop did not finish');
    if (mem.subarray(g2w(data), g2w(data) + spanDwords * 4).some(v => v !== 0))
      throw new Error('guest span did not produce the expected zero result');
    return elapsedMs;
  }

  run(false, 1, true);
  const hist = new Uint32Array(memory.buffer, e.get_handler_hist_base(), e.get_handler_hist_slots());
  const scalarActivation = hist[448] >>> 0;
  run(true, 1, true);
  const fusedActivation = hist[448] >>> 0;
  if (scalarActivation !== 0 || fusedActivation !== 1)
    throw new Error(`unexpected handler 448 activation: off=${scalarActivation} on=${fusedActivation}`);
  run(false); run(true);
  const scalar = [], fused = [];
  for (let i = 0; i < reps; i++) {
    const order = i & 1 ? [true, false] : [false, true];
    for (const enabled of order) (enabled ? fused : scalar).push(run(enabled));
  }
  const scalarMedian = median(scalar), fusedMedian = median(fused);
  console.log(JSON.stringify({ site, dwords: spanDwords, spanBytes: spanDwords * 4,
    baseReg, srcReg, startDisp: spanStartDisp, iterations, reps,
    activation: { scalarH447: scalarActivation, fusedH447: fusedActivation },
    scalarMs: scalarMedian, fusedMs: fusedMedian, speedup: scalarMedian / fusedMedian,
    scalarSamples: scalar, fusedSamples: fused }, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
