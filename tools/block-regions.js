#!/usr/bin/env node
// What shape is the executed code, and how much of it could a *region* JIT
// swallow whole?  A census over one run's hot-block dump.
//
//   node tools/block-regions.js --dump=FILE --pe=PATH[@0xBASE] [--pe=...]
//                               [--dispatches=N] [--top=N] [--region=0xVA]
//                               [--allow-calls] [--why] [--json]
//
// WHAT IT MEASURES, precisely.
//
// `test/run.js --handler-hist-thread=N --hot-block-dump=FILE` writes one line
// per distinct guest address the profiling window entered a compiled block AT,
// with a hit count.  That counter lives in `$run`'s block-entry loop
// (src/13-exports.wat, `$hot_block_hist_record`), so a hit is not "a basic
// block ran" -- it is one *interpreter block transfer*: an EIP that had to be
// looked up in the page index before anything could execute.  Straight-line
// fall-through inside a decode run costs no hit at all, because
// `$decode_run` fuses a not-taken Jcc into the next op of the same thread
// stream and never returns to `$run` for it.
//
// That is exactly the cost a live region JIT removes.  So this tool takes the
// dump, rebuilds the x86 control-flow graph by recursive descent from every
// dumped address, and asks which of those transfers are INTERNAL to a
// self-contained loop -- the ones a compiled region would turn into a native
// branch -- and which are region entries and exits, which it would still pay.
//
// Each dumped address is classified into one of:
//
//   selfloop  a single node whose own branch targets itself, call-free and
//             with no indirect transfer.  This is Design A territory
//             (docs/loop-idiom-superops-design.md): the shape the shipped
//             COPY_RUN/FILL_RUN/LUT_RUN/SCAN_RUN/RLE_RUN superops fold.
//   region    a member of a strongly-connected component of >= 2 nodes that
//             contains no `call`, no `ret`, and no indirect branch, and that
//             is entered from outside at exactly one node.  This is Design B
//             / toyvm region territory (docs/toyvm-region-live.md): a
//             multi-block loop with internal control flow that a compiled
//             region could hold entirely.
//   loose     in a cycle, but the cycle contains a call, a ret, an indirect
//             branch, or has more than one entry from outside.  A region JIT
//             as toyvm builds it cannot take these without a call-out
//             protocol.
//   acyclic   not in any cycle within the executed set: straight-line code,
//             one-shot paths, and the tops and bottoms of loops whose body
//             lives elsewhere.
//   unmapped  the address is not inside any image passed with --pe.  Runtime-
//             generated code and un-passed DLLs land here; a large share means
//             the census is blind and the numbers below are a subset.
//
// The headline numbers, and what each is worth:
//
//   * transfers by class.  EXACT -- this is the dump, only bucketed.  The
//     `region` and `selfloop` rows are an upper bound on the block transfers
//     a region JIT could delete, because it can only delete the ones that
//     stay inside a compiled region.
//   * internal vs entry transfers per region.  Also exact: a region's entry
//     node keeps its hits (something outside branched in), every OTHER node's
//     hits are transfers that would vanish.  This is the number to multiply
//     by a per-transfer cost.
//   * ops.  ESTIMATED, and deliberately a LOWER bound: hits x the static
//     instruction count of the basic block starting at that address.  Blocks
//     reached only by fused fall-through have no hits, so their instructions
//     are missing.  Pass `--dispatches=N` (the `[handler-hist] ... total=`
//     line from the same window) and the tool prints the residual as
//     "fall-through ops", which is itself the measurement of how much work
//     already reaches the guest without a lookup.
//   * concentration.  How many distinct regions carry 50/80/90% of in-region
//     transfers -- the "is it 10 hot loops or 1000" question, which decides
//     whether a compile-on-demand budget is affordable.
//
// A basic block here ends at the first control transfer: jmp, jcc, call, ret,
// loop/jecxz, int, or an unrecognised byte.  That is the x86 notion, not the
// interpreter's -- the interpreter's block is longer, since it fuses
// fall-throughs -- and the difference is precisely the "fall-through ops"
// residual above.
//
// Recursive descent, not a linear sweep, so data embedded in code is not
// decoded unless something branched to it.  Call targets are NOT followed:
// a call ends a block and its callee is only explored if it appears in the
// dump on its own.  `--why` prints the reason each multi-node cycle was
// declined, which is the work list for a more general region shape.
//
// Importable:
//   const { censusBlocks } = require('./tools/block-regions');
//   censusBlocks({ dump: [{addr, hits}], images: [{path, base}] }) => report

'use strict';

const fs = require('fs');
const path = require('path');
const { readPE } = require(path.join(__dirname, '..', 'lib', 'pe.js'));
const { disasmAt } = require(path.join(__dirname, 'disasm.js'));

const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');

// ---------------------------------------------------------------- images ---

// One image loaded at a runtime base.  `base` defaults to the PE's own
// preferred image base, which is what the loader uses when nothing collides.
function loadImage(spec) {
  const at = spec.lastIndexOf('@');
  let file = spec, base = null;
  if (at > 1) {
    const tail = spec.slice(at + 1);
    if (/^0x[0-9a-f]+$/i.test(tail)) { file = spec.slice(0, at); base = parseInt(tail, 16); }
  }
  const pe = readPE(file);
  if (base === null) base = pe.imageBase;
  let hi = 0;
  for (const s of pe.sections) hi = Math.max(hi, s.va + Math.max(s.vsize || 0, s.rawSize || 0));
  return { name: path.basename(file), pe, base, lo: base, hi: base - pe.imageBase + hi };
}

// runtime VA -> { buf, off } or null when nothing has bytes there.
function resolver(images) {
  return (va) => {
    for (const img of images) {
      if (va < img.lo || va >= img.hi) continue;
      const fileVa = va - img.base + img.pe.imageBase;
      const off = img.pe.va2off(fileVa);        // -1 for BSS: no bytes on disk
      if (off < 0) return null;
      return { buf: img.pe.buf, off, img };
    }
    return null;
  };
}

// ------------------------------------------------------------- decoding ----

const RE_LINE = /^([0-9a-f]{8})\s{2}((?:[0-9a-f]{2} )+)\s*(.*)$/;

// One instruction at a runtime VA -> {va, len, insn, mnem} or null.
function insnAt(resolve, va) {
  const hit = resolve(va);
  if (!hit) return null;
  let lines;
  try { lines = disasmAt(hit.buf, hit.off, va, 1, null, { linear: true }); }
  catch (e) { return null; }
  if (!lines || !lines.length) return null;
  const m = RE_LINE.exec(lines[0]);
  if (!m) return null;
  const len = m[2].trim().split(' ').length;
  const insn = m[3].trim();
  if (!insn || /^\(bad\)|^;/.test(insn)) return null;
  return { va, len, insn, mnem: insn.split(/[\s,]/)[0].toLowerCase() };
}

const RE_JCC = /^(j[a-z]+|loop[a-z]*)$/;
const RE_RET = /^(ret|retf|iret[dq]?)$/;

// Classify a terminator and name its direct successors.
//   kind: 'jcc' | 'jmp' | 'call' | 'ret' | 'int' | 'indirect' | 'bad'
function terminator(ins) {
  const m = ins.mnem;
  const operand = ins.insn.slice(m.length).trim();
  // `jnz short 0x40fa4b` / `jmp 0x40fa4b` are direct; `jmp [0x4b1234+edx*4]`
  // and `call eax` are not.  The `short`/`near` size hint is not an operand.
  const m2 = /^(?:short\s+|near\s+)?(0x[0-9a-f]+)$/i.exec(operand);
  const direct = m2 ? parseInt(m2[1], 16) : null;
  if (RE_RET.test(m)) return { kind: 'ret', targets: [] };
  if (m === 'call') {
    // A call ends the block either way; the callee is a separate root.
    return { kind: 'call', targets: [ins.va + ins.len], indirect: direct === null };
  }
  if (m === 'jmp') {
    if (direct === null) return { kind: 'indirect', targets: [] };
    return { kind: 'jmp', targets: [direct] };
  }
  if (RE_JCC.test(m)) {
    if (direct === null) return { kind: 'indirect', targets: [] };
    return { kind: 'jcc', targets: [ins.va + ins.len, direct] };
  }
  if (/^int/.test(m) || m === 'hlt' || m === 'ud2') return { kind: 'int', targets: [] };
  return null;   // not a terminator
}

const MAX_BLOCK_INSNS = 512;   // the decoder's own cap is 256 guest instructions

// Recursive descent from `roots`, building basic blocks.
// Returns Map va -> { va, insns, len, end, targets, hasCall, indirect, bad }
function buildCfg(resolve, roots, opts = {}) {
  const budget = opts.budget || 4_000_000;
  const blocks = new Map();
  const leaders = new Set(roots);
  const work = roots.slice();
  let decoded = 0;

  while (work.length) {
    const start = work.pop() >>> 0;
    if (blocks.has(start)) continue;
    let va = start, insns = 0, hasCall = false, term = null, bad = false;
    const seen = [];
    while (insns < MAX_BLOCK_INSNS) {
      if (decoded > budget) { bad = true; break; }
      // A leader other than our own start ends the block: something branches
      // here, so it must be its own node for the graph to be right.
      if (va !== start && leaders.has(va)) { term = { kind: 'fall', targets: [va] }; break; }
      const ins = insnAt(resolve, va);
      if (!ins) { bad = true; break; }
      decoded++;
      seen.push(ins);
      insns++;
      const t = terminator(ins);
      va += ins.len;
      if (t) { term = t; if (t.kind === 'call') hasCall = true; break; }
    }
    if (!term && !bad) term = { kind: 'fall', targets: [va] };
    const node = {
      va: start, insns, len: va - start,
      end: term ? term.kind : 'bad',
      targets: (term && term.targets ? term.targets : []).map(v => v >>> 0),
      hasCall, indirect: !!(term && (term.indirect || term.kind === 'indirect')),
      bad,
      lastInsn: seen.length ? seen[seen.length - 1].insn : null,
    };
    blocks.set(start, node);
    for (const t of node.targets) {
      if (!blocks.has(t)) { leaders.add(t); work.push(t); }
    }
  }

  // A target that landed inside an already-decoded block splits it.  One
  // pass is enough in practice because the leader set only grows here.
  let split = true, guard = 0;
  while (split && guard++ < 8) {
    split = false;
    for (const [, n] of Array.from(blocks)) {
      for (const t of n.targets) {
        if (blocks.has(t)) continue;
        // find the block containing t
        for (const [bv, b] of blocks) {
          if (t > bv && t < bv + b.len) {
            work.push(t); leaders.add(t); split = true; break;
          }
        }
      }
    }
    if (split) {
      // re-decode: clearing the split victims is simpler than surgery
      for (const t of work) {
        for (const [bv, b] of Array.from(blocks)) {
          if (t > bv && t < bv + b.len) blocks.delete(bv);
        }
      }
      const again = Array.from(new Set(work.concat(Array.from(blocks.keys()))));
      blocks.clear();
      work.length = 0;
      for (const r of again) work.push(r);
      // rerun the main loop by recursion-free repeat
      while (work.length) {
        const start = work.pop() >>> 0;
        if (blocks.has(start)) continue;
        let va = start, insns = 0, hasCall = false, term = null, bad = false;
        const seen = [];
        while (insns < MAX_BLOCK_INSNS) {
          if (decoded > budget) { bad = true; break; }
          if (va !== start && leaders.has(va)) { term = { kind: 'fall', targets: [va] }; break; }
          const ins = insnAt(resolve, va);
          if (!ins) { bad = true; break; }
          decoded++; seen.push(ins); insns++;
          const t = terminator(ins);
          va += ins.len;
          if (t) { term = t; if (t.kind === 'call') hasCall = true; break; }
        }
        if (!term && !bad) term = { kind: 'fall', targets: [va] };
        blocks.set(start, {
          va: start, insns, len: va - start,
          end: term ? term.kind : 'bad',
          targets: (term && term.targets ? term.targets : []).map(v => v >>> 0),
          hasCall, indirect: !!(term && (term.indirect || term.kind === 'indirect')),
          bad,
          lastInsn: seen.length ? seen[seen.length - 1].insn : null,
        });
        for (const t of blocks.get(start).targets) {
          if (!blocks.has(t)) { leaders.add(t); work.push(t); }
        }
      }
    }
  }
  return blocks;
}

// ------------------------------------------------------------------ SCC ----

// Iterative Tarjan: the graphs here run to 10^5 nodes and recursion blows up.
function sccs(blocks) {
  const index = new Map(), low = new Map(), onStack = new Set();
  const stack = [];
  const out = [];
  let counter = 0;
  for (const root of blocks.keys()) {
    if (index.has(root)) continue;
    const work = [{ v: root, i: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame.v;
      if (frame.i === 0) {
        index.set(v, counter); low.set(v, counter); counter++;
        stack.push(v); onStack.add(v);
      }
      const node = blocks.get(v);
      const succ = node ? node.targets.filter(t => blocks.has(t)) : [];
      if (frame.i < succ.length) {
        const w = succ[frame.i++];
        if (!index.has(w)) work.push({ v: w, i: 0 });
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
        continue;
      }
      work.pop();
      if (work.length) {
        const p = work[work.length - 1].v;
        low.set(p, Math.min(low.get(p), low.get(v)));
      }
      if (low.get(v) === index.get(v)) {
        const comp = [];
        for (;;) {
          const w = stack.pop(); onStack.delete(w); comp.push(w);
          if (w === v) break;
        }
        out.push(comp);
      }
    }
  }
  return out;
}

// -------------------------------------------------------------- census -----

// `allowCalls` sizes the single biggest generality lever: `call` is the top
// decline reason in every app measured, so this re-runs the same census with
// a call treated as an internal edge (the region would have to inline the
// callee or hold a return protocol).  It is an UPPER bound: it says nothing
// about whether the callee is small enough to inline.
function censusBlocks({ dump, images, dispatches = 0, allowCalls = false }) {
  const resolve = resolver(images);
  const hits = new Map();
  for (const row of dump) hits.set(row.addr >>> 0, row.hits);

  const mapped = [], unmapped = [];
  for (const [addr] of hits) (resolve(addr) ? mapped : unmapped).push(addr);

  const blocks = buildCfg(resolve, mapped);
  const comps = sccs(blocks);

  // predecessors, to test single-entry
  const preds = new Map();
  for (const [va, n] of blocks) {
    for (const t of n.targets) {
      if (!blocks.has(t)) continue;
      if (!preds.has(t)) preds.set(t, []);
      preds.get(t).push(va);
    }
  }

  const classOf = new Map();      // va -> class
  const regionOf = new Map();     // va -> region record
  const regions = [];
  const declines = new Map();
  const decline = why => declines.set(why, (declines.get(why) || 0) + 1);

  for (const comp of comps) {
    const set = new Set(comp);
    const selfEdge = comp.length === 1 &&
      blocks.get(comp[0]).targets.includes(comp[0]);
    if (comp.length === 1 && !selfEdge) { classOf.set(comp[0], 'acyclic'); continue; }

    const members = comp.map(v => blocks.get(v));
    const anyCall = members.some(m => m.hasCall);
    const anyRet = members.some(m => m.end === 'ret');
    const anyIndirect = members.some(m => m.indirect);
    const anyBad = members.some(m => m.bad);
    // exits: a member edge that leaves the component, or a terminator with no
    // in-set target at all (ret / indirect / call-out).
    const entryNodes = comp.filter(v =>
      (preds.get(v) || []).some(p => !set.has(p)) || hits.has(v) && (preds.get(v) || []).length === 0);
    const externalEntries = new Set(comp.filter(v =>
      (preds.get(v) || []).some(p => !set.has(p))));

    if (selfEdge) {
      if (anyCall || anyIndirect || anyBad) { decline(anyCall ? 'selfloop:call' : anyIndirect ? 'selfloop:indirect' : 'selfloop:undecodable'); classOf.set(comp[0], 'loose'); continue; }
      classOf.set(comp[0], 'selfloop');
      continue;
    }

    let why = null;
    if (anyCall && !allowCalls) why = 'call';
    else if (anyRet) why = 'ret';
    else if (anyIndirect) why = 'indirect-branch';
    else if (anyBad) why = 'undecodable';
    if (why) {
      decline(why);
      for (const v of comp) classOf.set(v, 'loose');
      continue;
    }
    // Otherwise clean, but entered at more than one node: a compiled region
    // could still take it behind an entry switch, so it is counted apart
    // rather than thrown away.
    const multiEntry = externalEntries.size > 1;
    if (multiEntry) decline('multi-entry (counted as region-multi)');
    const entry = externalEntries.size
      ? Array.from(externalEntries).sort((a, b) => (hits.get(b) || 0) - (hits.get(a) || 0))[0]
      : comp.slice().sort((a, b) => (hits.get(b) || 0) - (hits.get(a) || 0))[0];
    const rec = {
      entry, multiEntry, entries: externalEntries.size,
      nodes: comp.slice().sort((a, b) => a - b),
      insns: members.reduce((s, m) => s + m.insns, 0),
      entryHits: 0, internalHits: 0, ops: 0,
    };
    for (const v of comp) {
      const h = hits.get(v) || 0;
      rec.ops += h * blocks.get(v).insns;
      if (externalEntries.has(v) || (!externalEntries.size && v === entry)) rec.entryHits += h;
      else rec.internalHits += h;
      classOf.set(v, multiEntry ? 'region-multi' : 'region');
      regionOf.set(v, rec);
    }
    // A compiled region has to be indexed against the page that owns its
    // guest bytes -- `$decode_run` already refuses to cross a page for that
    // reason -- so a region spanning two pages needs a different invalidation
    // story before it can be compiled at all.
    let lo = Infinity, hi = 0;
    for (const v of comp) { lo = Math.min(lo, v); hi = Math.max(hi, v + blocks.get(v).len); }
    rec.lo = lo; rec.hi = hi; rec.bytes = hi - lo;
    rec.pages = ((hi - 1) >>> 12) - (lo >>> 12) + 1;
    regions.push(rec);
    void entryNodes;
  }

  // roll up by class, weighted by transfers (exact) and x86 instructions
  const CLASSES = ['selfloop', 'region', 'region-multi', 'loose', 'acyclic', 'unmapped'];
  const byClass = {};
  for (const c of CLASSES) byClass[c] = { transfers: 0, ops: 0, addrs: 0 };
  const byEnd = {};
  let totalTransfers = 0, totalOps = 0;
  for (const [addr, h] of hits) {
    totalTransfers += h;
    const cls = blocks.has(addr) ? (classOf.get(addr) || 'acyclic') : 'unmapped';
    const insns = blocks.has(addr) ? blocks.get(addr).insns : 0;
    byClass[cls].transfers += h;
    byClass[cls].ops += h * insns;
    byClass[cls].addrs++;
    totalOps += h * insns;
    const b = blocks.get(addr);
    const end = !b ? 'unmapped'
      : (b.end === 'call' && b.indirect) ? 'call-ind' : b.end;
    if (!byEnd[end]) byEnd[end] = { transfers: 0, addrs: 0 };
    byEnd[end].transfers += h;
    byEnd[end].addrs++;
  }

  regions.sort((a, b) => (b.internalHits + b.entryHits) - (a.internalHits + a.entryHits));
  const inRegionTransfers = regions.reduce((s, r) => s + r.internalHits + r.entryHits, 0);
  const conc = {};
  for (const q of [0.5, 0.8, 0.9]) {
    let acc = 0, n = 0;
    for (const r of regions) { acc += r.internalHits + r.entryHits; n++; if (acc >= inRegionTransfers * q) break; }
    conc[q] = n;
  }

  // the same question for self-loops, which Design A already addresses
  const selfLoops = mapped.filter(a => classOf.get(a) === 'selfloop')
    .map(a => ({ va: a, hits: hits.get(a), insns: blocks.get(a).insns,
                 lastInsn: blocks.get(a).lastInsn }))
    .sort((a, b) => b.hits - a.hits);

  return {
    totals: {
      distinctAddrs: hits.size, transfers: totalTransfers,
      opsLowerBound: totalOps, dispatches,
      fallThroughOps: dispatches ? dispatches - totalOps : null,
      cfgNodes: blocks.size, unmappedAddrs: unmapped.length,
    },
    byClass, byEnd, regions, selfLoops, concentration: conc, declines,
    blocks, classOf,
  };
}

// ---------------------------------------------------------------- report ---

function main(argv) {
  const arg = (n, d) => {
    const a = argv.find(v => v.startsWith(`--${n}=`));
    return a ? a.slice(n.length + 3) : d;
  };
  const args = n => argv.filter(v => v.startsWith(`--${n}=`)).map(v => v.slice(n.length + 3));
  const dumpPath = arg('dump', null);
  if (!dumpPath) {
    console.error(fs.readFileSync(__filename, 'utf8').split('\n')
      .filter(l => l.startsWith('//')).slice(0, 40).join('\n'));
    process.exit(2);
  }
  const dump = fs.readFileSync(dumpPath, 'utf8').split('\n')
    .map(l => /^(0x[0-9a-f]+)\s+(\d+)/i.exec(l.trim()))
    .filter(Boolean)
    .map(m => ({ addr: parseInt(m[1], 16) >>> 0, hits: parseInt(m[2], 10) }));
  const images = args('pe').map(loadImage);
  const dispatches = parseInt(arg('dispatches', '0'), 10) || 0;
  const top = parseInt(arg('top', '15'), 10);
  const rep = censusBlocks({ dump, images, dispatches,
    allowCalls: argv.includes('--allow-calls') });

  if (argv.includes('--json')) {
    const { blocks, classOf, ...rest } = rep;
    rest.regions = rest.regions.slice(0, 200).map(r => ({ ...r, nodes: r.nodes.length }));
    rest.selfLoops = rest.selfLoops.slice(0, 200);
    rest.declines = Object.fromEntries(rest.declines);
    console.log(JSON.stringify(rest, null, 2));
    return;
  }

  const t = rep.totals;
  console.log(`dump ${path.basename(dumpPath)}: ${t.distinctAddrs} distinct block-entry addresses, ` +
    `${t.transfers.toLocaleString()} block transfers`);
  console.log(`images: ${images.map(i => `${i.name}@${hex(i.base)}`).join(' ') || '(none)'}` +
    `  cfg nodes ${t.cfgNodes}  unmapped addrs ${t.unmappedAddrs}`);
  if (t.dispatches) {
    console.log(`dispatches ${t.dispatches.toLocaleString()}  ` +
      `x86 insns in entry blocks ${t.opsLowerBound.toLocaleString()}  ` +
      `fusion ratio ${(t.dispatches / t.opsLowerBound).toFixed(2)} dispatches per x86 insn`);
    console.log(`mean dispatches per block transfer ${(t.dispatches / t.transfers).toFixed(1)}  ` +
      `mean x86 insns per entry block ${(t.opsLowerBound / t.transfers).toFixed(1)}`);
  }
  console.log('');
  console.log('class        addrs      transfers    share      x86insn   share');
  for (const [cls, v] of Object.entries(rep.byClass)) {
    console.log(`  ${cls.padEnd(12)} ${String(v.addrs).padStart(5)} ` +
      `${v.transfers.toLocaleString().padStart(14)} ` +
      `${(v.transfers * 100 / t.transfers).toFixed(1).padStart(6)}% ` +
      `${v.ops.toLocaleString().padStart(12)} ` +
      `${(t.opsLowerBound ? v.ops * 100 / t.opsLowerBound : 0).toFixed(1).padStart(6)}%`);
  }
  console.log('');
  console.log('entry block terminators, weighted by transfers:');
  for (const [end, v] of Object.entries(rep.byEnd).sort((a, b) => b[1].transfers - a[1].transfers)) {
    console.log(`  ${end.padEnd(10)} ${String(v.addrs).padStart(5)} addrs ` +
      `${v.transfers.toLocaleString().padStart(14)} ` +
      `${(v.transfers * 100 / t.transfers).toFixed(1).padStart(6)}%`);
  }

  const inRegion = rep.regions.reduce((s, r) => s + r.internalHits + r.entryHits, 0);
  const internal = rep.regions.reduce((s, r) => s + r.internalHits, 0);
  console.log('');
  console.log(`regions: ${rep.regions.length}  in-region transfers ${inRegion.toLocaleString()}  ` +
    `of which INTERNAL (deletable) ${internal.toLocaleString()} ` +
    `(${(internal * 100 / t.transfers).toFixed(1)}% of all transfers)`);
  console.log(`  regions carrying 50/80/90% of in-region transfers: ` +
    `${rep.concentration[0.5]} / ${rep.concentration[0.8]} / ${rep.concentration[0.9]}`);
  console.log(`  top regions (entry, nodes, x86 insns, entry hits, internal hits):`);
  for (const r of rep.regions.slice(0, top)) {
    console.log(`    ${hex(r.entry)}  n=${String(r.nodes.length).padStart(3)}  ` +
      `insns=${String(r.insns).padStart(4)}  entries=${r.entries}  ` +
      `bytes=${String(r.bytes).padStart(5)}/${r.pages}pg  ` +
      `entryHits=${r.entryHits.toLocaleString().padStart(12)}  ` +
      `internal=${r.internalHits.toLocaleString().padStart(12)}`);
  }

  const slHits = rep.selfLoops.reduce((s, r) => s + r.hits, 0);
  console.log('');
  console.log(`self-loops: ${rep.selfLoops.length}  transfers ${slHits.toLocaleString()} ` +
    `(${(slHits * 100 / t.transfers).toFixed(1)}%)`);
  for (const r of rep.selfLoops.slice(0, top)) {
    console.log(`    ${hex(r.va)}  insns=${String(r.insns).padStart(3)}  ` +
      `hits=${r.hits.toLocaleString().padStart(12)}  ${r.lastInsn || ''}`);
  }

  const showRegion = arg('region', null);
  if (showRegion) {
    const want = parseInt(showRegion, 16) >>> 0;
    const r = rep.regions.find(x => x.entry === want || x.nodes.includes(want));
    if (!r) console.log(`\nno region contains ${hex(want)}`);
    else {
      console.log(`\nregion ${hex(r.entry)}: ${r.nodes.length} nodes, ${r.insns} x86 insns, ` +
        `${r.entries} external entry node(s)`);
      const dumpHits = new Map(dump.map(d => [d.addr, d.hits]));
      for (const v of r.nodes) {
        const b = rep.blocks.get(v);
        console.log(`    ${hex(v)}  insns=${String(b.insns).padStart(3)}  ` +
          `end=${b.end.padEnd(5)}  hits=${(dumpHits.get(v) || 0).toLocaleString().padStart(10)}  ` +
          `${b.lastInsn || ''}`);
      }
    }
  }

  if (argv.includes('--why')) {
    console.log('');
    console.log('cycles declined as regions, by reason:');
    for (const [w, n] of Array.from(rep.declines).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${w.padEnd(20)} ${n}`);
    }
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { censusBlocks, buildCfg, loadImage, resolver, sccs };
