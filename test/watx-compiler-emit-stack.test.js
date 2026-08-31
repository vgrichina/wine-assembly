// test/watx-compiler-emit-stack.test.js -- COMP: guard against WATX EMIT stack-overflow regression.
//
// The old emitter assembled complete sections with `allBytes.push(...section)`.
// Android's export/code sections therefore became hundreds of thousands of JS
// call arguments and exhausted V8's default argument stack. This was originally
// misdiagnosed as compileExpr recursion and hidden by tools/build.js respawning
// Node with --stack-size=16000, which browsers cannot do.
//
// This test guards the fix in TWO ways:
//   (1) the build entry points must not rely on a configurable Node stack.
//   (2) a synthetic module with a section larger than the old spread-argument
//       limit must compile directly on the process's default JS stack.
//
// Vendored into Wine-Assembly from ../android-emu (see tools/watx-src/PROVENANCE.md).
// The only adaptation is check (1)'s target: android-emu drives its build from
// tools/build.js, Wine from tools/build.sh plus the migration's
// tools/watx-baseline.sh. The property being asserted is unchanged — no build
// path may respawn Node with a bigger stack, because a browser cannot.
//
// Run: node test/watx-compiler-emit-stack.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

let pass = 0, fail = 0;
const ck = (n, ok, got) => {
  if (ok) { pass++; console.log(`  PASS ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${got !== undefined ? ' (got ' + got + ')' : ''}`); }
};

// ── (1) no build entry point has a Node-only stack-size workaround ───────────────────────────
const BUILD_ENTRY_POINTS = ['build.sh', 'watx-baseline.sh'];
const buildJs = BUILD_ENTRY_POINTS
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'tools', f), 'utf8'))
  .join('\n');
ck('build entry points do not contain __WATX_BIGSTACK', !/__WATX_BIGSTACK/.test(buildJs));
ck('build entry points do not contain --stack-size', !/--stack-size=/.test(buildJs));

// ── (2) Compiler-level stress: large export section on the default stack ─────────────────────
// Reusing one function keeps the AST shallow while making section 7 large. The
// old `push(...encodeSection(...))` path throws RangeError for this input.
const stress = (() => {
  const exports = [];
  for (let i = 0; i < 20000; i++) exports.push(`(export "stress_${i}" (func $answer))`);
  return `(module
    (func $answer (result i32) (effects) (i32.const 42))
    ${exports.join('\n')}
  )`;
})();
let r = null;
try { r = compile(stress, new Map(), { mode: 'production' }); }
catch (e) { ck('compile() large export section did not throw', false, e && e.message); }
if (r) {
  ck('compile() large export section: success', r.success === true, r.success);
  ck('compile() large export section: wasmBinary present', !!(r.wasmBinary && r.wasmBinary.length > 0),
    r.wasmBinary ? r.wasmBinary.length : 'no binary');
  ck('compile() large export section: valid Wasm', WebAssembly.validate(r.wasmBinary));
}

console.log(`\nwatx-compiler-emit-stack: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
