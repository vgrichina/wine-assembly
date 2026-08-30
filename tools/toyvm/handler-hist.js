'use strict';

// Read the dispatch histogram back out of guest memory, and name every index.
//
//   node tools/toyvm/run-dos.js DEMO.EXE --handler-hist
//   node tools/toyvm/run-dos.js DEMO.EXE --handler-hist=40 --handler-pairs=25
//
// Two tables, written by the instrumented dispatch in emit.js (see histBump):
// one counter per handler, and one per ORDERED PAIR of handlers.
//
// The pair table is the one that answers the design question. A flat census
// says `jz` is hot; it cannot say that `jz` almost always follows `cmp`, which
// is the fact a fused cmp+jcc superinstruction is built on. Every fusion
// candidate is a pair, and so is the reason replicated dispatch wins -- the
// predictor gets a history per predecessor, and that only pays if predecessors
// are actually predictive. This measures whether they are.
//
// Read it as a work list, not as a score. A handler at the top of the flat
// table is where the dispatches go; a PAIR at the top of the pair table with a
// high `after` share is where a superinstruction would remove one.

const { HANDLERS } = require('./emit');
const isa = require('./isa');

// The whole census, decoded. `mem` is the VM's Uint8Array (vm.mem).
function readHist(mem) {
  const u32 = new Uint32Array(mem.buffer, 0, mem.buffer.byteLength >> 2);
  const flatBase = isa.HIST_BASE >> 2;
  const pairBase = isa.HIST_PAIRS >> 2;

  const flat = [];
  let total = 0;
  for (let i = 0; i < HANDLERS.length; i++) {
    const n = u32[flatBase + i];
    if (n) { flat.push({ index: i, name: HANDLERS[i].name, count: n }); total += n; }
  }
  flat.sort((a, b) => b.count - a.count);

  // Only pairs whose predecessor actually ran get walked: the table is a
  // million entries and all but a few thousand are structurally zero, so
  // scanning it whole is a second of nothing.
  const pairs = [];
  for (const p of flat) {
    const row = pairBase + p.index * isa.HIST_SLOTS;
    for (let c = 0; c < HANDLERS.length; c++) {
      const n = u32[row + c];
      if (!n) continue;
      pairs.push({
        prev: p.name,
        cur: HANDLERS[c].name,
        count: n,
        // Of every dispatch of `prev`, the share that went to `cur` next.
        // This is the number a fusion lives or dies on: fusing a pair that is
        // 12% of its predecessor's successors means 88% of the time the fused
        // handler was the wrong guess and the work is done twice.
        after: n / p.count,
      });
    }
  }
  pairs.sort((a, b) => b.count - a.count);

  return { flat, pairs, total, handlers: HANDLERS.length };
}

// One handler's successors, for "what actually follows cmp".
function successorsOf(hist, name) {
  return hist.pairs.filter((p) => p.prev === name).sort((a, b) => b.count - a.count);
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const num = (n) => n.toLocaleString();

function formatHist(hist, { top = 20, pairs = 20 } = {}) {
  if (!hist.total) {
    // Not a throw and not an empty table: a zero census has exactly one cause
    // worth naming, and guessing which of the two it is wastes a run.
    return '  handler histogram: nothing counted -- the VM was built without'
      + ' instrumentation, or the guest never dispatched.';
  }
  const out = [];
  out.push(`  handler histogram: ${num(hist.total)} dispatches over `
    + `${num(hist.flat.length)} of ${hist.handlers} handlers`);

  // How concentrated the profile is decides whether SELECTIVE specialization is
  // even a strategy: if the top 20 are 15% of dispatches, specializing them
  // buys 15% of whatever specialization is worth, and the answer is a different
  // design. Printed before the table because it is the conclusion.
  const cum = (n) => hist.flat.slice(0, n).reduce((s, h) => s + h.count, 0) / hist.total;
  out.push(`    top 10 = ${pct(cum(10))} of dispatches, `
    + `top 20 = ${pct(cum(20))}, top 50 = ${pct(cum(50))}`);

  for (const h of hist.flat.slice(0, top)) {
    out.push(`    ${String(h.count).padStart(12)}  ${pct(h.count / hist.total).padStart(6)}  `
      + `${h.name}`);
  }

  if (pairs > 0 && hist.pairs.length) {
    const pTotal = hist.pairs.reduce((s, p) => s + p.count, 0);
    out.push(`  top handler pairs (fusion candidates), ${num(hist.pairs.length)} distinct:`);
    for (const p of hist.pairs.slice(0, pairs)) {
      out.push(`    ${String(p.count).padStart(12)}  ${pct(p.count / pTotal).padStart(6)}  `
        + `${p.prev} -> ${p.cur}   ${pct(p.after)} of ${p.prev}`);
    }
  }
  return out.join('\n');
}

module.exports = { readHist, formatHist, successorsOf };
