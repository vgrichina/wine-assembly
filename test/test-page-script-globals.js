#!/usr/bin/env node

'use strict';

// Two classic <script> tags share one global lexical scope, so a top-level
// `const api` in one lib/ file and a top-level `const api` in another is a
// SyntaxError -- and not a quiet one: the browser refuses to evaluate the
// second script and the whole page dies before anything renders. Node never
// sees it, because require() gives every file its own module scope.
//
// This actually happened: lib/mobile-keyboard.js shipped a `const api` next to
// the one lib/dll-registry.js has had for months, and every unit test still
// passed. The page-level invariant needs a page-level test.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const sources = [];
const tag = /<script\s+src="([^"?]+)[^"]*"/g;
let m;
while ((m = tag.exec(html))) {
  if (!m[1].startsWith('lib/')) continue;      // vendor bundles are their own scope
  sources.push(m[1]);
}
assert.ok(sources.length > 5, 'index.html should load the lib/ scripts as plain <script> tags');

// Only column-0 declarations are module-global; anything indented is inside a
// function, block, or IIFE and cannot collide.
const DECL = /^(?:const|let|class|function|async function)\s+([A-Za-z_$][\w$]*)/;

const owner = new Map();
const clashes = [];
for (const src of sources) {
  const file = path.join(ROOT, src);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const seen = new Set();
  for (const line of text.split('\n')) {
    const d = DECL.exec(line);
    if (!d) continue;
    const name = d[1];
    if (seen.has(name)) continue;              // function overloads/redeclares within a file
    seen.add(name);
    if (owner.has(name)) clashes.push(`${name}: ${owner.get(name)} and ${src}`);
    else owner.set(name, src);
  }
}

assert.deepStrictEqual(clashes, [],
  'two page scripts declare the same global; the second one will not evaluate at all');

console.log(`PASS  ${sources.length} page scripts declare no colliding globals`);
