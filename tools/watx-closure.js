#!/usr/bin/env node
'use strict';

// The WATX source closure, in one place.
//
// Two callers need to compile the Wine tree with the vendored WATX compiler and
// they must not drift apart: tools/watx-matrix.js (the Milestone 3 differential
// gate, which compares WATX artifacts against legacy ones) and
// tools/build-compile-wat.js (the Milestone 5 canonical build under
// WINE_WAT_COMPILER=watx). If the two ever built a *different* closure, the
// matrix would be certifying bytes the build does not ship — the exact failure
// mode the whole differential gate exists to prevent. So the closure lives here
// and both require it.
//
// The WATX compiler takes one source string plus a VFS the (include ...) forms
// resolve against. src/main.watx is the authoritative entry point since
// Milestone 2.2; the WAT_FILES fallback below is kept for a tree where that file
// is absent, and it has to strip the (module ...) wrapper, which opens in
// 01-header.wat and closes in 13-exports.wat, so no individual file parses on
// its own. Both tokens are blanked in place (not deleted) so every line and
// column in a WATX error still points at the real source position.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function watxSourceClosure() {
  const { WAT_FILES } = require(path.join(ROOT, 'lib', 'compile-wat.js'));
  const mainFile = path.join(SRC, 'main.watx');
  const vfs = new Map();
  if (fs.existsSync(mainFile)) {
    for (const f of fs.readdirSync(SRC)) {
      if (!/\.(wat|watx)$/.test(f)) continue;
      const text = fs.readFileSync(path.join(SRC, f), 'utf8');
      vfs.set(f, text);
      vfs.set(`src/${f}`, text);
      vfs.set(`./${f}`, text);
    }
    return { source: fs.readFileSync(mainFile, 'utf8'), vfs, entry: 'src/main.watx' };
  }

  const files = WAT_FILES.slice();
  const texts = files.map(f => fs.readFileSync(path.join(SRC, f), 'utf8'));

  const openAt = texts[0].indexOf('(module');
  if (openAt < 0) throw new Error(`watx-closure: no "(module" in src/${files[0]}`);
  texts[0] = texts[0].slice(0, openAt) + ' '.repeat('(module'.length) +
    texts[0].slice(openAt + '(module'.length);

  const last = texts.length - 1;
  const closeAt = texts[last].lastIndexOf(')');
  if (closeAt < 0) throw new Error(`watx-closure: no closing ")" in src/${files[last]}`);
  texts[last] = texts[last].slice(0, closeAt) + ' ' + texts[last].slice(closeAt + 1);

  files.forEach((f, i) => vfs.set(f, texts[i]));
  return {
    source: files.map(f => `(include "${f}")`).join('\n') + '\n',
    vfs,
    entry: 'synthesized from lib/compile-wat.js WAT_FILES (src/main.watx absent)',
  };
}

// The compile options are part of the closure contract, not a caller's choice:
// `production` + `standardWat` + no runtime builtins is what Milestone 3
// certified, so the build and the gate must pass exactly these. Only the
// tail-call mode varies, and only because the two shipped artifacts differ in
// precisely that.
// `regionShake` is the one exception to "the caller does not choose": it is a
// deliberate NON-canonical build (docs/watx-region-safety-design.md §8) whose
// whole purpose is to move the memory map and see what breaks, and it reaches
// the region allocator and nothing else. Absent, it is not passed at all.
function compileClosure(closure, { tailCalls, regionShake, nameSection } = {}) {
  const { compile } = require(path.join(__dirname, 'watx.js'));
  const options = {
    mode: 'production',
    standardWat: true,
    runtimeBuiltins: false,
    tailCalls: !!tailCalls,
  };
  if (regionShake) options.regionShake = regionShake;
  // Only ever set when explicitly asked for. A name section changes the emitted
  // bytes, and byte-identity against the canonical artifact is the instrument
  // every compiler change here is proved with.
  if (nameSection) options.nameSection = nameSection;
  return compile(closure.source, closure.vfs, options);
}

module.exports = { watxSourceClosure, compileClosure };
