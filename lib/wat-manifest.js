'use strict';

// The source order, read from the ONE place that holds it: src/main.watx.
//
// src/main.watx is the WATX compiler's entry point — a flat list of
// `(include "NN-part.wat")` forms that the include resolver
// (tools/watx-src/compiler-stages.js resolveIncludes) splices into the module
// as top-level fields. That list is therefore COMPILER-ENFORCED for everything
// it names: an include whose file is absent from the vfs is a hard error with a
// file/line/column, not a silently missing part.
//
// Before this module the same order was ALSO typed by hand into a WAT_FILES
// array in lib/compile-wat.js, and a gate existed purely to prove the two
// copies agreed. Deriving it here retires the second copy: every Node consumer
// that used to `require('./compile-wat').WAT_FILES` now gets a list parsed from
// main.watx, so a part can only be added or reordered in one file.
//
// The parse is deliberately trivial and does NOT go through the vendored WATX
// compiler. tools/check-wat-manifest.js is the first gate in tools/build.sh and
// must stay independent of the compiler it runs ahead of; requiring the whole
// compiler here to learn 61 filenames would also cost every small tool that
// only wants the list. So main.watx is held to a grammar of blank lines, `;;`
// comments and `(include "name")` — and anything else is an error rather than
// something quietly skipped, because a form this parser did not understand is
// exactly how a part would go missing again.

const fs = require('fs');
const path = require('path');

const MAIN_WATX = path.join(__dirname, '..', 'src', 'main.watx');

function parseIncludes(text, where = MAIN_WATX) {
  const includes = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith(';;')) continue;
    const m = /^\(include\s+"([^"]+)"\)$/.exec(line);
    if (!m) {
      throw new Error(`${where}:${i + 1}: neither a comment nor an (include "name") ` +
        `form:\n  ${lines[i]}\n  main.watx is the source manifest, not a place for ` +
        `module content.`);
    }
    includes.push(m[1]);
  }
  return includes;
}

function readManifest() {
  let text;
  try {
    text = fs.readFileSync(MAIN_WATX, 'utf-8');
  } catch (e) {
    throw new Error(`lib/wat-manifest.js: cannot read src/main.watx (${e.code || e.message}). ` +
      `It is the root of the (include ...) closure — the build has no source order without it.`);
  }
  const includes = parseIncludes(text);
  if (!includes.length) {
    throw new Error('lib/wat-manifest.js: src/main.watx declared no (include ...) forms.');
  }
  return includes;
}

// Read once per process. The file is ~4 KB and every tool in tools/ wants the
// list, so re-reading it per require would be pure waste; it is also not
// something that changes under a running build.
const WAT_FILES = readManifest();

module.exports = { WAT_FILES, MAIN_WATX, parseIncludes, readManifest };
