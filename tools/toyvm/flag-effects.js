#!/usr/bin/env node
// What the flag analysis in emit.js concluded, per handler.
//
//   node tools/toyvm/flag-effects.js [--name=REGEX] [--nf] [--no-nf] [--summary]
//
// `analyzeFlags()` derives two answers for every generated handler -- does it
// READ the flags it was entered with, and does it OVERWRITE all of them -- and
// `genNoFlagVariants()` keeps a flagless twin of the ones that qualify. Both
// live inside emit.js as arrays. Nothing printed them.
//
// Which matters because the analysis is the load-bearing part of
// docs/toyvm-dead-flags.md: the compiler deletes a flag write on its word, and
// a wrong answer is a program computing with a flag that is not there. The
// existing tools cannot stand in for it -- handler-hist.js counts dispatches
// and knows nothing about flags, `run-dos.js --trace-deadflags` prints only the
// writes that WERE deleted and never the ones that were not or why, and gate.js
// runs one instruction at a time and so is blind to the whole transformation by
// construction. This prints the table itself, which is also the work list for
// widening the variant set.
'use strict';

const { HANDLERS, FLAG_EFFECTS, NOFLAG, prepareTables } = require('./emit');

function main() {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(`--${n}`);
  const opt = (n) => {
    const p = args.find((a) => a.startsWith(`--${n}=`));
    return p ? p.slice(n.length + 3) : null;
  };
  prepareTables();

  const re = opt('name') ? new RegExp(opt('name')) : null;
  const wantNf = flag('nf'), wantNoNf = flag('no-nf');

  let writers = 0, withTwin = 0, readers = 0, edgeOnly = 0;
  const rows = [];
  for (let i = 0; i < HANDLERS.length; i++) {
    const e = FLAG_EFFECTS[i];
    const nf = NOFLAG.get(i);
    if (e.kills) writers++;
    if (nf !== undefined) withTwin++;
    if (e.readsIn) readers++;
    if (e.readsIn && !e.readsInX) edgeOnly++;
    if (re && !re.test(HANDLERS[i].name)) continue;
    if (wantNf && nf === undefined) continue;
    if (wantNoNf && nf !== undefined) continue;
    rows.push({ i, name: HANDLERS[i].name, e, nf });
  }

  if (!flag('summary')) {
    const w = Math.max(4, ...rows.map((r) => r.name.length));
    console.log(`${'handler'.padEnd(w)}  idx   readsIn  acrossEdge  kills  flagless`);
    for (const r of rows) {
      console.log(`${r.name.padEnd(w)}  ${String(r.i).padStart(4)}  `
        + `${r.e.readsIn ? '  yes  ' : '   .   '}  `
        + `${r.e.readsInX ? '    yes   ' : '     .    '}  `
        + `${r.e.kills ? ' yes ' : '  .  '}  `
        + `${r.nf === undefined ? '   .' : String(r.nf).padStart(4)}`);
    }
    console.log('');
  }
  console.log(`${HANDLERS.length} handlers: ${writers} write the flags, `
    + `${withTwin} have a flagless twin, ${readers} read what they were entered `
    + `with (${edgeOnly} of those only through the slice-exit handback)`);
}

if (require.main === module) main();
