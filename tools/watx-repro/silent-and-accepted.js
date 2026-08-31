// REPRODUCERS — four more WATX encoder findings from the wabt differential.
// Each one is a module wabt compiles correctly and WATX does not, and none of
// them produces a diagnostic pointing at the cause.
//
//   1. (start $f) is parsed and then DROPPED. No start section is emitted, so
//      the function never runs. A module that initialises itself in `start`
//      comes up uninitialised and every later symptom is somewhere else.
//   2. \u{…} — a core-WAT string escape — is not decoded in a data segment.
//      WATX drops the backslash and stores the literal characters `u{1F600}`.
//      Wrong bytes in memory, silently.
//   3. Multivalue results are ACCEPTED and miscompiled: `(result i32 i32)` on
//      a function or a block emits a body that pushes one value, which V8 then
//      refuses at Module construction. Accepted-invalid — the compiler should
//      either implement it or refuse it with a located error.
//   4. An imported global is not resolved at all ("Unknown global '$g'"). This
//      one is a clean REJECTION, listed here only because it is the same
//      import-section area and a reader looking for it should find it.
//
// Run: node tools/watx-repro/silent-and-accepted.js
'use strict';
const path = require('path');
const { compileWatx, compileWabt } = require(path.join(__dirname, '..', 'watx-differential.js'));

const CASES = [
  {
    name: '(start $f) never runs',
    src: `(global $ran (mut i32) (i32.const 0))
(func $init (global.set $ran (i32.const 0x1234)))
(start $init)
(func $ran (result i32) (global.get $ran))
(export "ran" (func $ran))`,
    probe: (ex) => ex.ran(),
    expect: 0x1234,
  },
  {
    name: '\\u{…} in a data segment stores the literal characters',
    src: `(memory 1 1)
(export "mem" (memory 0))
(data (i32.const 0) "\\u{1F600}")
(func $n)
(export "n" (func $n))`,
    probe: (ex) => Array.from(new Uint8Array(ex.mem.buffer, 0, 8)).join(','),
    expect: '240,159,152,128,0,0,0,0',
  },
  {
    name: 'multivalue (result i32 i32) is accepted and miscompiled',
    src: `(func $swap (param $a i32) (param $b i32) (result i32 i32) (local.get $b) (local.get $a))
(func $use (result i32) (i32.sub (call $swap (i32.const 9) (i32.const 4))))
(export "use" (func $use))`,
    probe: (ex) => ex.use(),
    expect: -5,
  },
  {
    name: 'an imported global is not resolved (clean rejection)',
    src: `(import "env" "g" (global $g i32))
(func $get (result i32) (global.get $g))
(export "get" (func $get))`,
    imports: { env: { g: 17 } },
    probe: (ex) => ex.get(),
    expect: 17,
  },
];

function value(binary, c) {
  const ex = new WebAssembly.Instance(new WebAssembly.Module(binary), c.imports || {}).exports;
  return c.probe(ex);
}

(async () => {
  let bad = 0;
  for (const c of CASES) {
    let watx;
    try { watx = String(value(compileWatx(c.src, { tailCalls: false }), c)); }
    catch (e) { watx = `<${String(e.message || e).split('\n')[0].slice(0, 70)}>`; }
    let wabt;
    try { wabt = String(value(await compileWabt(c.src), c)); }
    catch (e) { wabt = `<${String(e.message || e).split('\n')[0].slice(0, 70)}>`; }
    const ok = watx === String(c.expect);
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'BUG '} ${c.name}`);
    console.log(`       expected ${c.expect}   wabt ${wabt}   watx ${watx}`);
  }
  console.log(bad ? `\n${bad} case(s) still wrong.` : '\nAll cases fixed — delete this reproducer.');
  process.exit(bad ? 1 : 0);
})();
