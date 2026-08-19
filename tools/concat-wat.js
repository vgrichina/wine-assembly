#!/usr/bin/env node
// Emit build/combined.wat from WAT_FILES — the same list the real compile uses.
// A shell glob is a second source of truth, and when it disagrees with
// WAT_FILES every function index in combined.wat shifts relative to the shipped
// module, so tools that map index->name (func-index.js) start naming the wrong
// function. tools/check-wat-manifest.js proves the two lists agree; this makes
// them literally the same list.
'use strict';

const fs = require('fs');
const path = require('path');
const { WAT_FILES } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'combined.wat');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const out = fs.openSync(OUT, 'w');
try {
  for (const file of WAT_FILES) {
    fs.writeSync(out, fs.readFileSync(path.join(ROOT, 'src', file)));
  }
} finally {
  fs.closeSync(out);
}
console.log(`Wrote ${path.relative(ROOT, OUT)} from ${WAT_FILES.length} parts (WAT_FILES order)`);
