#!/usr/bin/env node
// Emit build/combined.wat from the src/main.watx include list — literally the
// same list the real compile resolves, since the shipped wasm IS main.watx's
// (include ...) closure. A shell glob would be a second source of truth, and
// when it disagreed every function index in combined.wat would shift relative
// to the shipped module, so tools that map index->name (func-index.js) would
// start naming the wrong function.
//
// The source parts carry NO `(module ...)` wrapper of their own (Milestone 2.2
// of docs/watx-migration-plan.md): every src/*.wat fragment balances its own
// parentheses so it can be parsed independently, and tools/check-wat-fragments.js
// gates that. lib/compile-wat.js consumes bare top-level module fields directly,
// but the standard-WAT consumers of combined.wat (wat2wasm, check-parens,
// func-index, grep-for-structure) want a complete module, so the wrapper is
// added HERE, around the concatenation.
'use strict';

const fs = require('fs');
const path = require('path');
const { WAT_FILES } = require('../lib/wat-manifest');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'combined.wat');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const out = fs.openSync(OUT, 'w');
try {
  fs.writeSync(out, '(module\n');
  for (const file of WAT_FILES) {
    fs.writeSync(out, fs.readFileSync(path.join(ROOT, 'src', file)));
  }
  fs.writeSync(out, ')\n');
} finally {
  fs.closeSync(out);
}
console.log(`Wrote ${path.relative(ROOT, OUT)} from ${WAT_FILES.length} parts ` +
  `(src/main.watx include order, (module ...) wrapper added here)`);
