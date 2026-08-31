#!/usr/bin/env node
// Gate: lib/compile-wat.js's WAT_FILES is the real build. `src/*.wat` is only
// what build/combined.wat (grep, check-parens, func-index) sees. A new part that
// lands in src/ but not in WAT_FILES compiles into combined.wat and silently
// vanishes from the shipped wasm — that has already happened once. Assert the
// two agree, as sets and as an order.
//
// Since Milestone 2.1 of docs/watx-migration-plan.md there is a THIRD list:
// src/main.watx, the WATX include manifest, and it is the AUTHORITATIVE one.
// WAT_FILES is not generated from it (the legacy compiler must stay a plain JS
// module with no parse step at require time), so it is verified against it here
// instead — as a sequence, not a set. Exactly one of the two is edited by hand
// on purpose; the other is mirrored, and this gate refuses the mismatch.
'use strict';

const fs = require('fs');
const path = require('path');
const { WAT_FILES } = require('../lib/compile-wat');

const SRC = path.join(__dirname, '..', 'src');
const MAIN_WATX = path.join(SRC, 'main.watx');

// Read the ordered include list out of src/main.watx. Deliberately NOT via the
// vendored WATX compiler: this gate runs first in tools/build.sh and must stay
// independent of the compiler it will one day gate. The file is held to a
// trivial grammar — blank lines, `;;` comments, and `(include "name")` — and
// anything else is an error rather than something silently skipped.
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
const manifest = WAT_FILES.slice();

const manifestSet = new Set(manifest);
const diskSet = new Set(onDisk);

const missingFromManifest = onDisk.filter(f => !manifestSet.has(f));
const missingFromDisk = manifest.filter(f => !diskSet.has(f));

let failed = false;

if (missingFromManifest.length) {
  failed = true;
  console.error('ERROR: src/*.wat files absent from WAT_FILES in lib/compile-wat.js:');
  for (const f of missingFromManifest) console.error(`  ${f}`);
  console.error('  These compile into build/combined.wat but NOT into the shipped wasm.');
}

if (missingFromDisk.length) {
  failed = true;
  console.error('ERROR: WAT_FILES entries with no file in src/:');
  for (const f of missingFromDisk) console.error(`  ${f}`);
}

// Function indices in build/combined.wat only line up with the real module when
// both are in the same order, so tools that count functions (func-index.js)
// don't lie. combined.wat is now emitted in WAT_FILES order by
// tools/concat-wat.js; this check keeps that order equal to the LC_ALL=C sort
// so a reader scanning src/ alphabetically sees the same sequence.
if (!failed) {
  const sortedManifest = manifest.slice().sort();
  for (let i = 0; i < manifest.length; i++) {
    if (manifest[i] !== sortedManifest[i]) {
      failed = true;
      console.error('ERROR: WAT_FILES is not in sorted (LC_ALL=C) order.');
      console.error(`  index ${i}: manifest has ${manifest[i]}, sorted order wants ${sortedManifest[i]}`);
      break;
    }
  }
}

// src/main.watx is the authoritative order; WAT_FILES mirrors it. Compare as a
// sequence — two lists that agree as sets but not in order produce a different
// function numbering, which is the exact thing func-index.js/wasm-native.js
// depend on.
if (!failed) {
  const includes = readMainWatx();
  if (includes.length !== manifest.length) {
    failed = true;
    console.error(`ERROR: src/main.watx lists ${includes.length} includes but ` +
      `WAT_FILES has ${manifest.length} entries.`);
  }
  for (let i = 0; i < Math.max(includes.length, manifest.length); i++) {
    if (includes[i] !== manifest[i]) {
      failed = true;
      console.error('ERROR: src/main.watx and WAT_FILES disagree on source order.');
      console.error(`  index ${i}: main.watx has ${includes[i] || '<end>'}, ` +
        `WAT_FILES has ${manifest[i] || '<end>'}`);
      console.error('  src/main.watx is AUTHORITATIVE — mirror it into ' +
        'lib/compile-wat.js WAT_FILES.');
      break;
    }
  }
}

if (failed) process.exit(1);
console.log(`WAT manifest OK: ${manifest.length} parts, ` +
  `src/main.watx == WAT_FILES == src/*.wat`);
