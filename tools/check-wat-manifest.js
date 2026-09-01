#!/usr/bin/env node
// Gate: src/main.watx — the root of the WATX `(include ...)` closure — names
// every src/*.wat, exactly once, in filename order.
//
// WHAT THE COMPILER NOW ENFORCES, AND THIS GATE NO LONGER CLAIMS TO:
//
//   - "listed but absent". An `(include "x.wat")` whose file is not in the vfs
//     is a hard error from resolveIncludes (tools/watx-src/compiler-stages.js)
//     with a file, line and column. It cannot reach a build.
//   - "listed twice". The resolver's `included` set makes a repeat include a
//     no-op rather than a duplicated body.
//   - "the list the build used". There is no second list any more. WAT_FILES in
//     lib/compile-wat.js was a hand-typed mirror of this file; it is now parsed
//     out of it by lib/wat-manifest.js, so the two cannot disagree. The old
//     sequence comparison between them is retired — it compared a list to
//     itself.
//
// WHAT IS STILL ONLY CHECKABLE HERE:
//
//   - "present but unlisted". A file nobody includes is not part of the program
//     and nothing errors: it lands in build/combined.wat (a shell-glob-free
//     concatenation, but still a separate artifact) and is silently absent from
//     the shipped wasm. That has happened before. The compiler cannot see a
//     file no form refers to, so the src/ directory listing is compared here.
//   - "in filename order". Function indices in build/combined.wat only line up
//     with the real module when both are in the same order, so tools that count
//     functions (func-index.js, wasm-func-name.js) do not name the wrong one.
//     Order is a project convention, not a compiler rule.
//   - "the derivation is honest". This file parses main.watx independently —
//     deliberately NOT through the vendored WATX compiler, because this gate
//     runs first in tools/build.sh and must stay independent of the compiler it
//     runs ahead of — and then checks lib/wat-manifest.js's exported list
//     against that parse. Two parsers, one file, same answer.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const MAIN_WATX = path.join(SRC, 'main.watx');

// The trivial grammar main.watx is held to: blank lines, `;;` comments, and
// `(include "name")`. Anything else is an error rather than something silently
// skipped — a form this parser did not understand is exactly how a part would
// go missing.
function readMainWatx() {
  const includes = [];
  const lines = fs.readFileSync(MAIN_WATX, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith(';;')) continue;
    const m = /^\(include\s+"([^"]+)"\)$/.exec(line);
    if (!m) {
      console.error(`ERROR: src/main.watx:${i + 1} is neither a comment nor an ` +
        `(include "name") form:`);
      console.error(`  ${lines[i]}`);
      console.error('  main.watx is the source manifest, not a place for module content.');
      process.exit(1);
    }
    includes.push(m[1]);
  }
  return includes;
}

const onDisk = fs.readdirSync(SRC).filter(f => f.endsWith('.wat')).sort();
const includes = readMainWatx();

const includeSet = new Set(includes);
const diskSet = new Set(onDisk);

let failed = false;

if (includeSet.size !== includes.length) {
  failed = true;
  const seen = new Set();
  console.error('ERROR: src/main.watx includes the same file more than once:');
  for (const f of includes) {
    if (seen.has(f)) console.error(`  ${f}`);
    seen.add(f);
  }
}

const unlisted = onDisk.filter(f => !includeSet.has(f));
if (unlisted.length) {
  failed = true;
  console.error('ERROR: src/*.wat files with no (include ...) in src/main.watx:');
  for (const f of unlisted) console.error(`  ${f}`);
  console.error('  Nothing refers to these, so the compiler cannot complain: they land in');
  console.error('  build/combined.wat and are SILENTLY ABSENT from the shipped wasm.');
  console.error('  Add an (include "...") line to src/main.watx, in filename order.');
}

// An include naming a file that is not there is already a hard, located compile
// error — but this gate runs long before the compiler, so saying it here turns a
// stage-2 stack into one line at the top of the build.
const absent = includes.filter(f => !diskSet.has(f));
if (absent.length) {
  failed = true;
  console.error('ERROR: src/main.watx includes files that do not exist in src/:');
  for (const f of absent) console.error(`  ${f}`);
  console.error('  (The WATX include resolver would also reject these, with a line/column.)');
}

if (!failed) {
  const sorted = includes.slice().sort();
  for (let i = 0; i < includes.length; i++) {
    if (includes[i] !== sorted[i]) {
      failed = true;
      console.error('ERROR: src/main.watx include list is not in sorted (LC_ALL=C) order.');
      console.error(`  index ${i}: main.watx has ${includes[i]}, sorted order wants ${sorted[i]}`);
      console.error('  File numbering controls link order; keep the two the same so a reader');
      console.error('  scanning src/ alphabetically sees the sequence the build uses.');
      break;
    }
  }
}

// The derived export every Node consumer reads must be this same list. If these
// two ever disagree the bug is in lib/wat-manifest.js's parse, not in the tree.
if (!failed) {
  const { WAT_FILES } = require('../lib/wat-manifest.js');
  if (JSON.stringify(WAT_FILES) !== JSON.stringify(includes)) {
    failed = true;
    console.error('ERROR: lib/wat-manifest.js WAT_FILES does not equal this file\'s own ' +
      'parse of src/main.watx.');
    console.error(`  wat-manifest.js: ${WAT_FILES.length} entries`);
    console.error(`  this gate:       ${includes.length} entries`);
    for (let i = 0; i < Math.max(WAT_FILES.length, includes.length); i++) {
      if (WAT_FILES[i] !== includes[i]) {
        console.error(`  first difference at index ${i}: ` +
          `${WAT_FILES[i] || '<end>'} vs ${includes[i] || '<end>'}`);
        break;
      }
    }
  }
}

if (failed) process.exit(1);
console.log(`WAT manifest OK: src/main.watx includes all ${includes.length} src/*.wat ` +
  `in sorted order (missing/duplicate includes are compiler-enforced)`);
