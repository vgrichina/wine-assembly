#!/usr/bin/env node

'use strict';

// What each handler actually touches: which guest registers it reads and
// writes, whether it reads or writes memory and at what width, and whether it
// does anything a loop fold may not reason about.
//
//   node tools/toyvm/handler-effects.js --stats
//   node tools/toyvm/handler-effects.js mov_rm16 stosb lodsb32 loop32
//
// WHY THIS EXISTS. A loop fold cannot begin without it. "Is `si` the induction
// variable", "do the read and write streams alias", "is this op loop-invariant"
// are all questions about which registers and memory an op touches, and nothing
// in the toy VM could answer them:
//
//   FLAG_EFFECTS      flags only, which is what dead-flag elimination needed
//   SPEC              register indices, but only for the 58 specialized names
//   reg-index-census  counts accessor sites, does not say read vs write
//   handler-hist      how often an op ran, nothing about what it did
//
// The register INDEX is the hard part, and it is already solved. A handler
// reaches the register file with an index it computed from an arena word --
// `mov_rm16`'s is `(t0 >> 8) & 7` -- and emit.js's resolveIndex() walks that
// expression backwards to the word and the extract program that produced it.
// That resolver was built for register specialization, which measured as a
// null; this is the part of it that pays.
//
// So an effect is either a LITERAL register (`(i32.const 0)` -- the accumulator
// in `stosb`) or an arena-relative one: operand word N, with an extract program
// to run over it. `at(effect, words, p)` turns the second kind into a concrete
// register number for one op in one arena, which is what a compiler pass needs.
//
// Anything it cannot resolve is reported as unresolved rather than guessed at.
// A fold that reads this table must decline on `unresolved`, exactly as
// specializeHandler() declines: getting the register wrong is not a slow fold,
// it is a wrong one.

const {
  HANDLERS, ARITY, prepareTables, indexDefs, resolveIndex, sexpAt, applyExtract,
} = require('./emit');

// The helper names, and what a call to each one means. Bodies are generated
// (`$rset${w}`), so these are matched against the FINISHED body text.
const KIND = [
  [/^rget(8|16|32)$/, 'regRead'],
  [/^rset(8|16|32)$/, 'regWrite'],
  [/^rd(8|16|32)$/, 'memRead'],
  [/^wr(8|16|32)$/, 'memWrite'],
  [/^sget$/, 'segRead'],
  [/^sset$/, 'segWrite'],
  // The effective-address helper, which is 612 of the 1581 handlers and is the
  // single most important thing here rather than a decline: `$ea(i, d)` is a
  // br_table on `i & 15` picking a base+index form, and both arguments come out
  // of the arena. So the COMPILER knows the addressing mode of a specific op,
  // and therefore which registers feed the address -- which is the question
  // "is `si` the induction variable of this stream" is really made of.
  [/^ea(32)?$/, 'address'],
  // The block transfer's own budget-and-self-patch test. Every branch ends in
  // one; it leaves the slice, it does not leave the analysis.
  [/^slice_exit$/, 'transfer'],
  // CX by another name, in `loop` and the string ops' REP counters.
  [/^(cx16|ecx32)$/, 'countRead'],
  [/^push(16|32)$/, 'stackWrite'],
  [/^pop(16|32)$/, 'stackRead'],
  // Everything a fold must not reason about. Ports and faults leave the VM;
  // the x87 stack and the VGA plane latch are state this analysis does not
  // model; cxdec/ecxdec write CX as a side effect of a branch.
  [/^port_(in|out)$/, 'escape'],
  [/^(fault|fault0|gc)$/, 'escape'],
  [/^vga_plane$/, 'escape'],
  [/^(fpush|fpop|fst_set|fst_get|fmr32|fmr64|fcmp|fround|frndint)/, 'fpu'],
  [/^(cx|ecx)dec$/, 'countDown'],
  // Flag record helpers. Named so they are not mistaken for unknown calls --
  // FLAG_EFFECTS already covers what they mean.
  [/^(flags_|rec_|get_|cond)/, 'flags'],
  // Pure arithmetic helpers: the shift/rotate kernels and the offset adder.
  // They compute a value and touch nothing but the flag record, so the store
  // that consumes them is already counted at the handler's own `$rset`.
  [/^(sh_|off_add$|pow2$)/, 'alu'],
];

function kindOf(fn) {
  for (const [re, k] of KIND) if (re.test(fn)) return { kind: k, width: widthOf(fn) };
  return null;
}
function widthOf(fn) {
  const m = /(8|16|32)$/.exec(fn);
  return m ? Number(m[1]) : 0;
}

// The argument list of one `(call $name ...)`, as raw s-expressions.
function callArgs(body, i) {
  // i points at the '(' of the call. Skip past `(call $name`.
  let j = body.indexOf('$', i);
  while (j < body.length && !/\s/.test(body[j])) j++;
  const out = [];
  for (;;) {
    while (j < body.length && /\s/.test(body[j])) j++;
    if (j >= body.length || body[j] === ')') break;
    if (body[j] !== '(') return null;              // a bare identifier: give up
    const s = sexpAt(body, j);
    if (s === null) return null;
    out.push(s);
    j += s.length;
  }
  return out;
}

// One handler -> its effects, or a record saying why it could not be read.
function effectsOf(hx) {
  const body = hx.body;
  const defs = indexDefs(body);
  const e = {
    name: hx.name, index: hx.index, args: hx.args,
    regRead: [], regWrite: [], memRead: [], memWrite: [],
    segRead: [], segWrite: [], stack: [], address: [], escapes: [], fpu: false,
    countDown: false, countRead: false, unresolved: [],
  };
  const re = /\(call \$([a-z0-9_]+)/gi;
  for (let m; (m = re.exec(body)) !== null;) {
    const k = kindOf(m[1]);
    if (!k) { e.unresolved.push(`call $${m[1]}`); continue; }
    if (k.kind === 'flags' || k.kind === 'alu') continue;
    if (k.kind === 'fpu') { e.fpu = true; continue; }
    if (k.kind === 'escape') { e.escapes.push(`$${m[1]}`); continue; }
    if (k.kind === 'countDown') { e.countDown = true; continue; }
    if (k.kind === 'countRead') { e.countRead = true; continue; }
    if (k.kind === 'transfer') continue;
    if (k.kind === 'address') {
      // Both arguments matter: the mode picks the registers, the displacement
      // is the constant part of the address.
      const a = callArgs(body, m.index);
      if (!a || a.length < 2) { e.unresolved.push('$ea args'); continue; }
      const mode = resolveIndex(a[0], m.index, defs);
      const disp = resolveIndex(a[1], m.index, defs);
      if (!mode || !disp) { e.unresolved.push('$ea operands'); continue; }
      e.address.push({ mode, disp, wide: /32$/.test(m[1]) });
      continue;
    }
    if (k.kind === 'memRead' || k.kind === 'memWrite') { e[k.kind].push({ width: k.width }); continue; }
    if (k.kind === 'stackRead' || k.kind === 'stackWrite') { e.stack.push({ width: k.width, kind: k.kind }); continue; }

    // A register or segment access: the first argument is the index, and it is
    // the whole point of this file to say which one.
    const args = callArgs(body, m.index);
    if (!args || !args.length) { e.unresolved.push(`$${m[1]} args`); continue; }
    const lit = /^\(i32\.const\s+(-?\d+)\)$/.exec(args[0].trim());
    let at;
    if (lit) at = { reg: Number(lit[1]) };
    else {
      const r = resolveIndex(args[0], m.index, defs);
      if (!r) { e.unresolved.push(`$${m[1]} index`); continue; }
      at = { operand: r.operand, ops: r.ops };
    }
    at.width = k.width;
    const bucket = { regRead: 'regRead', regWrite: 'regWrite', segRead: 'segRead', segWrite: 'segWrite' }[k.kind];
    e[bucket].push(at);
  }
  // A handler nothing here disqualifies and whose every register index resolved
  // is one a fold may reason about. Everything else declines.
  e.readable = e.unresolved.length === 0 && e.escapes.length === 0 && !e.fpu;
  return e;
}

// Materialize one effect against a real arena op. `p` is the word index of the
// handler word, so its operands start at p+1.
function at(effect, words, p) {
  if (effect.reg !== undefined) return effect.reg;
  return applyExtract(effect, words[p + 1 + effect.operand]);
}

let TABLE = null;
function table() {
  if (TABLE) return TABLE;
  prepareTables();
  TABLE = HANDLERS.map(h => effectsOf(h));
  return TABLE;
}

// --- CLI --------------------------------------------------------------------

function fmt(a) {
  const w = a.width ? `/${a.width}` : '';
  return a.reg !== undefined ? `r${a.reg}${w}`
    : `op${a.operand}${a.ops.map(o => `.${o.op}${o.n}`).join('')}${w}`;
}

function main() {
  const t = table();
  const names = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (process.argv.includes('--stats') || !names.length) {
    const ok = t.filter(e => e.readable);
    console.log(`${t.length} handlers, ${ok.length} readable `
      + `(${(100 * ok.length / t.length).toFixed(1)}%)`);
    const why = new Map();
    for (const e of t) {
      if (e.readable) continue;
      const r = e.fpu ? 'fpu' : e.escapes.length ? `escape ${e.escapes[0]}` : e.unresolved[0];
      why.set(r, (why.get(r) || 0) + 1);
    }
    console.log('declines:');
    for (const [r, n] of [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${String(n).padStart(5)}  ${r}`);
    }
    const nMem = t.filter(e => e.readable && (e.memRead.length || e.memWrite.length)).length;
    console.log(`${nMem} readable handlers touch memory`);
    if (!names.length) return;
  }
  const byName = new Map(t.map(e => [e.name, e]));
  for (const n of names) {
    const e = byName.get(n);
    if (!e) { console.log(`${n}: no such handler`); continue; }
    console.log(`\n${e.name}  #${e.index}  ${e.args} operands  ${e.readable ? '' : 'NOT READABLE'}`);
    const line = (label, v) => { if (v.length) console.log(`  ${label.padEnd(11)}${v.join(', ')}`); };
    line('reads', e.regRead.map(fmt));
    line('writes', e.regWrite.map(fmt));
    line('seg reads', e.segRead.map(fmt));
    line('seg writes', e.segWrite.map(fmt));
    line('address', e.address.map(a => `mode=${fmt({ ...a.mode, width: 0 })} disp=${fmt({ ...a.disp, width: 0 })}${a.wide ? ' a32' : ''}`));
    line('mem reads', e.memRead.map(x => `${x.width}`));
    line('mem writes', e.memWrite.map(x => `${x.width}`));
    line('stack', e.stack.map(x => `${x.kind} ${x.width}`));
    line('escapes', e.escapes);
    line('unresolved', e.unresolved);
    if (e.countDown) console.log('  countDown  yes (the branch decrements CX)');
    if (e.fpu) console.log('  fpu        yes');
  }
}

if (require.main === module) main();
module.exports = { table, effectsOf, at, ARITY };
