#!/usr/bin/env node
// How much of a run reaches the register file through a RUNTIME index.
//
//   node tools/toyvm/reg-index-census.js DEMO.EXE [DEMO2.EXE ...] [--budget=8e6]
//   node tools/toyvm/reg-index-census.js --static
//
// Every guest register lives in a wasm global, and a handler gets at one by
// calling $rget16/$rset16/$rget8/... with an index. When that index is an
// `(i32.const N)` the engine can inline the helper and fold the br_table to a
// single `global.get`. When it comes out of the arena -- `(local.get $t0)`,
// loaded from the operand stream -- it cannot: every access is a call and a
// br_table on a value the compiler is not allowed to know, even though the
// COMPILER knew the register number at emit time and wrote it into the arena
// itself. Specializing those handlers per register is the register-window idea
// in docs/toyvm-superinstructions.md's "what is next" list.
//
// This is the measurement that says whether that is worth building. Two
// existing tools each hold half the answer and neither joins them:
// flag-effects.js prints a per-handler property but only about flags, and
// handler-hist.js counts dispatches per handler but never looks at a body. The
// join is the question, so it lives here.
//
// The classification is textual, over the handler body emit.js already built,
// and it is deliberately pessimistic: anything that is not a literal
// `(i32.const N)` argument counts as dynamic, including the `(i32.and $t0 7)`
// shape the one-byte opcodes use. A handler that does both -- `mul` reads AX by
// constant and its operand by index -- is counted dynamic, because the dynamic
// access is the one that costs.
'use strict';

const { HANDLERS, prepareTables } = require('./emit');

const ACCESSORS = ['rget32', 'rset32', 'rget16', 'rset16', 'rget8', 'rset8'];

// The balanced s-expression starting at `i` (which must be at its `(`).
function sexp(s, i) {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '(') d++;
    else if (s[j] === ')') { d--; if (d === 0) return s.slice(i, j + 1); }
  }
  return s.slice(i);
}

// { const: n, dyn: n, locals: [..] } -- register accesses in this body, by
// index shape. `locals` is the set of distinct DYNAMIC index expressions: one
// entry means every register this handler touches comes from a single operand
// word, which is the case a per-register twin covers with 8 variants.
function classify(body) {
  const out = { const: 0, dyn: 0, locals: [], packed: false };
  const seen = new Set();
  for (const a of ACCESSORS) {
    const needle = `(call $${a} `;
    let at = 0;
    for (;;) {
      const i = body.indexOf(needle, at);
      if (i < 0) break;
      at = i + needle.length;
      let j = at;
      while (j < body.length && body[j] !== '(') j++;
      const arg = sexp(body, j);
      if (/^\(i32\.const\s+\d+\)$/.test(arg.trim())) out.const++;
      else {
        out.dyn++;
        // `(local.get $t0)` and `(i32.and (local.get $t0) (i32.const 7))` are
        // the same operand word reached two ways, so key on the local, not on
        // the expression text. Anything not built from exactly one local is
        // its own bucket and disqualifies the handler.
        const ls = [...new Set((arg.match(/\$t\d+/g) || []))];
        seen.add(ls.length === 1 ? ls[0] : arg.trim().replace(/\s+/g, ' '));
        // A BARE `(local.get $tK)` index means the operand word IS the register
        // number, so eight twins cover it. Anything else -- `(i32.and $t0 7)`
        // next to `(i32.shr_u $t0 4)` -- is two register fields PACKED into one
        // word, and covering that takes 64.
        if (!/^\(local\.get \$t\d+\)$/.test(arg.trim())) out.packed = true;
      }
    }
  }
  out.locals = [...seen];
  return out;
}

function table() {
  prepareTables();
  return HANDLERS.map(h => ({ name: h.name, ...classify(h.body || '') }));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = n => args.includes(`--${n}`);
  const opt = (n, d) => {
    const p = args.find(a => a.startsWith(`--${n}=`));
    return p ? p.slice(n.length + 3) : d;
  };
  const cls = table();

  if (flag('static') || args.every(a => a.startsWith('--'))) {
    let dyn = 0, cst = 0, none = 0;
    const byLocals = new Map();
    for (const c of cls) {
      if (c.dyn) {
        dyn++;
        const k = `${c.locals.length}${c.packed ? ' packed' : ' bare'}`;
        byLocals.set(k, (byLocals.get(k) || 0) + 1);
      }
      else if (c.const) cst++;
      else none++;
    }
    console.log(`${cls.length} handlers: ${dyn} dynamic-index, ${cst} const-index only, ${none} no register access`);
    for (const k of [...byLocals.keys()].sort()) {
      console.log(`  ${String(byLocals.get(k)).padStart(4)} handlers index through ${k} operand(s)`);
    }
    if (flag('list')) {
      for (const c of cls) if (c.dyn) console.log(`  ${c.name}  dyn=${c.dyn} const=${c.const}`);
    }
    return;
  }

  // `--only=REGEX` scores a CANDIDATE SET rather than the whole table: only
// handlers whose name matches count towards the specializable column, so a
// proposed family list can be priced before any of it is generated.
  const only = opt('only', null) ? new RegExp(opt('only')) : null;
  const { runDos } = require('./run-dos');
  const budget = Number(opt('budget', '8e6'));
  const top = Number(opt('top', '10'));
  // Handler -> summed share of dispatches across the programs given, so a twin
  // budget can be spent on the handlers that carry the corpus rather than on
  // whichever one leads a single program.
  const rank = new Map();
  console.log(`program        dispatches   dyn-1-operand   dyn-many   const-only   no-reg`);
  for (const exe of args.filter(a => !a.startsWith('--'))) {
    const r = await runDos({ exe, budget, hist: 1, histPairs: 0, stuckLimit: 0 });
    let total = 0, one = 0, many = 0, cst = 0, none = 0;
    const rows = [];
    for (const { index: i, count: n } of r.hist.flat) {
      total += n;
      const c = cls[i] || { dyn: 0, const: 0, locals: [] };
      if (c.dyn) {
        const eligible = c.locals.length === 1 && !c.packed
          && (!only || only.test(HANDLERS[i].name));
        if (eligible) one += n; else many += n;
        rows.push([n, c, i]);
      } else if (c.const) cst += n;
      else none += n;
    }
    const pct = v => `${(100 * v / (total || 1)).toFixed(1)}%`;
    const base = require('path').basename(exe);
    console.log(`${base.padEnd(14)} ${String(total).padStart(10)}  `
      + `${pct(one).padStart(13)} ${pct(many).padStart(10)} `
      + `${pct(cst).padStart(12)} ${pct(none).padStart(8)}`);
    for (const [n, c, i] of rows) {
      if (c.locals.length !== 1 || c.packed) continue;
      rank.set(i, (rank.get(i) || 0) + n / (total || 1));
    }
    rows.sort((a, b) => b[0] - a[0]);
    for (const [n, c, i] of rows.slice(0, top)) {
      console.log(`    ${(HANDLERS[i] ? HANDLERS[i].name : `#${i}`).padEnd(28)} `
        + `${String(n).padStart(10)}  ${pct(n).padStart(6)}  ${c.dyn} dyn via `
        + `${c.locals.length} operand${c.locals.length === 1 ? '' : 's'} / ${c.const} const`);
    }
  }

  // The ranked twin budget. Mean share is what to spend a fixed number of
  // twins on: a handler that is 40% of one program and absent from the other
  // nine is worth less than one that is 6% of all ten.
  const nProg = args.filter(a => !a.startsWith('--')).length;
  const ranked = [...rank.entries()].map(([i, s]) => [i, s / nProg])
    .sort((a, b) => b[1] - a[1]);
  // 464 is what is actually available: HIST_SLOTS is 2048 and the pair
  // histogram is HIST_SLOTS^2 words of the VM's OWN linear memory, so the
  // handler table cannot pass 2048 without quadrupling a 16MB table that every
  // run allocates. 1581 handlers today leaves 467.
  const twinBudget = Number(opt('twins', '464'));
  const nHandlers = Math.floor(twinBudget / 8);
  console.log(`\nranked by mean share over ${nProg} programs; `
    + `a budget of ${twinBudget} twins buys ${nHandlers} handlers:`);
  let cum = 0;
  for (const [n, [i, s]] of ranked.entries()) {
    cum += s;
    const mark = n === nHandlers - 1 ? '  <-- budget' : '';
    if (n < nHandlers + 4 || n % 25 === 0) {
      console.log(`  ${String(n + 1).padStart(3)}  ${HANDLERS[i].name.padEnd(24)}`
        + ` ${(100 * s).toFixed(2)}%   cumulative ${(100 * cum).toFixed(1)}%${mark}`);
    }
  }
  console.log(`  ${ranked.length} bare-eligible handlers were dispatched at all; `
    + `all of them together are ${(100 * cum).toFixed(1)}%`);
  if (flag('names')) {
    console.log(`\n${ranked.slice(0, nHandlers).map(([i]) => HANDLERS[i].name).join('\n')}`);
  }
}

module.exports = { classify, table };

if (require.main === module) main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });
