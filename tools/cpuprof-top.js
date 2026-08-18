#!/usr/bin/env node
// Rank functions by self time in a V8 .cpuprofile (node --cpu-prof output).
// Usage: node tools/cpuprof-top.js <file.cpuprofile> [top=30] [--callers=NAME]
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/cpuprof-top.js <file.cpuprofile> [top] [--callers=NAME]');
  process.exit(1);
}
const top = parseInt(process.argv.find(a => /^\d+$/.test(a)) || '30', 10);
const callersOf = (process.argv.find(a => a.startsWith('--callers=')) || '').split('=')[1];

const prof = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map();
for (const n of prof.nodes) byId.set(n.id, n);
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children || []) parent.set(c, n.id);

// timeDeltas[i] is the time spent before samples[i] was taken.
const self = new Map();
let total = 0;
for (let i = 0; i < prof.samples.length; i++) {
  const dt = (prof.timeDeltas[i] || 0) / 1000; // ms
  total += dt;
  const id = prof.samples[i];
  self.set(id, (self.get(id) || 0) + dt);
}

const label = n => {
  const f = n.callFrame;
  const name = f.functionName || '(anonymous)';
  const url = (f.url || '').replace(/^file:\/\//, '').split('/').slice(-1)[0];
  return url ? `${name} @ ${url}:${f.lineNumber + 1}` : name;
};

const agg = new Map();
for (const [id, ms] of self) {
  const n = byId.get(id);
  if (!n) continue;
  const k = label(n);
  agg.set(k, (agg.get(k) || 0) + ms);
}

// Wasm vs JS split: in this project the wasm half is the emulator itself and
// the JS half is host/harness work, so the ratio says which one to profile next.
let wasmMs = 0;
for (const [k, ms] of agg) if (k.startsWith('wasm-function[')) wasmMs += ms;
console.log(`total sampled: ${total.toFixed(1)} ms, ${prof.samples.length} samples`);
console.log(`wasm: ${wasmMs.toFixed(1)} ms (${(100 * wasmMs / total).toFixed(1)}%), other: ${(total - wasmMs).toFixed(1)} ms`);
console.log('--- self time ---');
for (const [k, ms] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`${ms.toFixed(1).padStart(9)} ms  ${(100 * ms / total).toFixed(1).padStart(5)}%  ${k}`);
}

if (callersOf) {
  const chains = new Map();
  for (const [id, ms] of self) {
    const n = byId.get(id);
    if (!n || !label(n).includes(callersOf)) continue;
    const stack = [];
    let cur = parent.get(id);
    while (cur !== undefined && stack.length < 8) {
      stack.push(label(byId.get(cur)));
      cur = parent.get(cur);
    }
    const k = stack.join(' <- ');
    chains.set(k, (chains.get(k) || 0) + ms);
  }
  console.log(`--- callers of ${callersOf} ---`);
  for (const [k, ms] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`${ms.toFixed(1).padStart(9)} ms  ${k}`);
  }
}
