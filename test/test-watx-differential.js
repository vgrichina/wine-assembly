// test/test-watx-differential.js — the WATX encoder against an INDEPENDENT one.
//
// Everything that makes this a real oracle rather than another hand-written
// suite lives in tools/watx-differential.js; read the header there. The short
// version: a corpus of standard-WAT modules is compiled by WATX and by wabt's
// wat2wasm with the same feature set, both binaries are instantiated, and what
// they compute is compared over a grid of inputs plus the memory they leave
// behind. wabt does not know what WATX believes, which is the whole point —
// the legacy compiler was exactly this oracle until it was retired at 24b79256
// and nothing replaced it.
//
// Every module runs in BOTH tailCalls modes. Modules marked expectDivergence
// are known compiler bugs kept as live witnesses: they must KEEP diverging, and
// the suite fails if one starts agreeing (that means the bug is fixed and the
// marker should come off, which is news worth failing over).
//
// Run: node test/test-watx-differential.js
'use strict';
const path = require('path');
const { runDifferential, CORPUS, DIALECT_GAPS } = require(path.join(__dirname, '..', 'tools', 'watx-differential.js'));

runDifferential({
  onResult: (r) => {
    if (r.knownBug) { console.log(`  KNOWN ${r.name} — ${r.expected}`); return; }
    if (r.ok) { console.log(`  PASS  ${r.name}${r.byteIdentical ? '  [byte-identical to wabt]' : ''}`); return; }
    console.log(`  FAIL  ${r.name}`);
    for (const n of r.notes) console.log(`        ${n}`);
    for (const d of r.divergences) console.log(`        ${JSON.stringify(d)}`);
  },
}).then((rep) => {
  const fails = rep.total - rep.passed;
  console.log(`\n${rep.passed}/${rep.total} corpus modules behave as expected against wabt`);
  console.log(`  ${rep.knownBugs} known divergence(s), each with a reproducer under tools/watx-repro/`);
  console.log(`  ${rep.byteIdentical}/${rep.total} byte-identical (reported, never required: WATX legitimately`);
  console.log('    emits empty sections wabt omits and lowers return_call when tail calls are off)');
  console.log(`  ${DIALECT_GAPS.length} standard-WAT spellings WATX refuses outright (see DIALECT_GAPS)`);
  if (fails) {
    console.log(`\n${fails} module(s) FAILED. A failure here is either an encoder bug or a`);
    console.log('known one that has been fixed without its marker being removed — the');
    console.log('printed note says which.');
  }
  process.exit(fails ? 1 : 0);
}).catch((e) => {
  console.error('differential harness itself failed:', e);
  process.exit(2);
});

// Referenced so a corpus that somehow empties itself fails loudly rather than
// passing 0/0.
if (CORPUS.length < 30) {
  console.error(`corpus has shrunk to ${CORPUS.length} modules; it is meant to be 40+`);
  process.exit(2);
}
