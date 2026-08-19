#!/usr/bin/env node
// Gate: lib/compile-wat.js's WAT_FILES is the real build. `src/*.wat` is only
// what build/combined.wat (grep, check-parens, func-index) sees. A new part that
// lands in src/ but not in WAT_FILES compiles into combined.wat and silently
// vanishes from the shipped wasm — that has already happened once. Assert the
// two agree, as sets and as an order.
'use strict';

const fs = require('fs');
const path = require('path');
const { WAT_FILES } = require('../lib/compile-wat');

const SRC = path.join(__dirname, '..', 'src');

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

if (failed) process.exit(1);
console.log(`WAT manifest OK: ${manifest.length} parts, WAT_FILES == src/*.wat`);
