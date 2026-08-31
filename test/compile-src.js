'use strict';

// Compile the FULL src tree for a test, through the canonical compiler.
//
// lib/compile-wat.js's compileWat was retired for full-tree builds (commit
// 24b79256): the src tree now spells region-symbolic operands — bare $REGION
// operands and `(data (region.addr ...))` segments — that the legacy compiler
// lowers to `unreachable` traps with only a warning instead of rejecting. A
// test that still went through it therefore compiled a module that traps at
// run time, or died outright on `unknown op: region.addr`.
//
// tools/watx-closure.js owns the source closure AND the option set, so a test
// that goes through here compiles exactly what tools/build.sh ships
// (tailCalls:true is the same artifact as build/wine-assembly.wasm). Do not
// inline the closure in a test — that is the drift the closure module exists
// to prevent.
//
// `transform(file, source) -> source` is the replacement for the old practice
// of passing compileWat a reader that patched one file on the way past (adding
// a test-only export to 13-exports.wat, say). It is called once per source
// file, with the bare basename ('13-exports.wat'). Note that watx-closure
// registers every file under THREE VFS keys — 'f', 'src/f' and './f' — because
// an (include ...) may spell any of them, so a patch must land on all three or
// the include that actually resolves silently gets the unpatched text; this
// helper does that for you.

const { watxSourceClosure, compileClosure } = require('../tools/watx-closure.js');

function compileSrcWasm(transform, { tailCalls = true } = {}) {
  const closure = watxSourceClosure();
  if (typeof transform === 'function') {
    const bases = [];
    for (const key of closure.vfs.keys()) {
      if (!key.includes('/')) bases.push(key);
    }
    for (const base of bases) {
      const out = transform(base, closure.vfs.get(base));
      if (out === undefined || out === closure.vfs.get(base)) continue;
      for (const key of [base, `src/${base}`, `./${base}`]) {
        if (closure.vfs.has(key)) closure.vfs.set(key, out);
      }
    }
  }
  const r = compileClosure(closure, { tailCalls });
  if (!r || !r.success || !r.wasmBinary) {
    const where = r && r.file ? ` at ${r.file}:${r.line || '?'}:${r.col || '?'}` : '';
    throw new Error(`compile-src: WATX compile failed${where}: ` +
      String((r && (r.error || r.message)) || 'compile() returned no binary'));
  }
  return Buffer.from(r.wasmBinary);
}

module.exports = { compileSrcWasm };
