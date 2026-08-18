#!/usr/bin/env node
'use strict';
// Report every top-level (func ...) whose paren depth is not 1 — i.e. the
// function before it leaked a paren or swallowed one.
//
// tools/check-parens.js answers "is the whole file balanced", which a pair of
// opposite mistakes hides completely, and it reports the first negative depth
// rather than the edit that caused it. This walks to each function definition
// instead, so the output names the function that went wrong rather than a line
// several hundred further down. lib/compile-wat.js parses by scanning for
// top-level forms, so a function at the wrong depth is invisible to it: every
// definition after the break silently disappears and only turns up later as
// "unknown func" warnings or a WebAssembly.compile stack error.
//
// Usage: node tools/wat-func-depth.js src/09c3-controls.wat [...]

const fs = require('fs');

let bad = 0;
for (const file of process.argv.slice(2)) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let depth = 0;
  let lastForm = '(start of file)';
  // src/*.wat are fragments concatenated into one (module ...), so the
  // top-level depth is 0 in a part and 1 in a whole module. Take it from
  // wherever the first definition sits rather than assuming.
  let base = null;
  lines.forEach((line, i) => {
    const form = /^\s*\((func|global|table|memory|elem|data|type|import|export)\s+(\$?[^\s()]*)/.exec(line);
    if (form && base === null) base = depth;
    if (form && depth !== base) {
      bad++;
      console.log(`${file}:${i + 1}: depth ${depth}, expected ${base} — `
        + `(${form[1]} ${form[2]}); previous top-level form was ${lastForm}`);
    }
    if (form && depth === base) lastForm = `(${form[1]} ${form[2]}) at line ${i + 1}`;

    // Strings first: a literal may contain ";;" or a lone paren, and stripping
    // comments before them turns the rest of that line into nothing. This is
    // what makes tools/check-parens.js report a phantom break in
    // $create_about_dialog on sources that build.
    let s = line.replace(/"(\\.|[^"\\])*"/g, '""');
    s = s.replace(/\(;.*?;\)/g, '').replace(/;;.*$/, '');
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
  });
  if (base !== null && depth !== base) {
    bad++;
    console.log(`${file}: ends at depth ${depth}, expected ${base}`);
  }
}
if (!bad) console.log('all top-level forms start at the file\'s base depth');
process.exit(bad ? 1 : 0);
