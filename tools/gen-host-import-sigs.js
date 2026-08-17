#!/usr/bin/env node
// Generate lib/host-import-sigs.generated.json — the parameter and result types
// of every `(import "host" ...)` the module declares.
//
// Why this has to exist: `WebAssembly.Module.imports()` reports names and kinds
// but NOT signatures, and a worker proxying host calls to the main thread needs
// both. Arity decides how many arguments to marshal, and the result count is the
// difference between a call that can be fired and forgotten and one that must
// block until the answer comes back — which is the single biggest lever on how
// slow a brokered host call is.
//
//   node tools/gen-host-import-sigs.js            # writes the JSON
//   node tools/gen-host-import-sigs.js --check    # verify it is up to date
//
// Run it after adding a host import; tools/build.sh checks it.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', '01-header.wat');
const OUT = path.join(ROOT, 'lib', 'host-import-sigs.generated.json');

function parse(text) {
  const sigs = {};
  // Declarations wrap across lines (gdi_surface_create and friends), so scan
  // the flattened text and take the (func ...) form by counting parens rather
  // than trusting a line to hold a whole declaration.
  const flat = text.replace(/;;[^\n]*/g, ' ').replace(/\s+/g, ' ');
  const head = /\(import "host" "([A-Za-z_0-9]+)" \(func /g;
  let m;
  while ((m = head.exec(flat))) {
    const name = m[1];
    let depth = 1, i = m.index + m[0].length;   // inside the (func
    while (i < flat.length && depth > 0) {
      if (flat[i] === '(') depth++;
      else if (flat[i] === ')') depth--;
      i++;
    }
    const body = flat.slice(m.index + m[0].length, i - 1);
    const params = [];
    let results = [];
    const paramRe = /\(param([^)]*)\)/g;
    let pm;
    while ((pm = paramRe.exec(body))) {
      for (const t of pm[1].trim().split(/\s+/)) if (t && t[0] !== '$') params.push(t);
    }
    const rm = /\(result([^)]*)\)/.exec(body);
    if (rm) results = rm[1].trim().split(/\s+/).filter(Boolean);
    sigs[name] = { params, results };
  }
  return sigs;
}

function main() {
  const text = fs.readFileSync(SRC, 'utf8');
  const sigs = parse(text);
  const names = Object.keys(sigs);
  const declared = (text.match(/\(import\s+"host"\s+"[A-Za-z_0-9]+"\s+\(func/g) || []).length;
  if (names.length !== declared) {
    console.error(`gen-host-import-sigs: parsed ${names.length} of ${declared} declared host imports`);
    process.exit(1);
  }
  const json = JSON.stringify({
    generated_from: 'src/01-header.wat',
    count: names.length,
    sigs,
  }, null, 2) + '\n';

  if (process.argv.includes('--check')) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== json) {
      console.error('lib/host-import-sigs.generated.json is stale — run node tools/gen-host-import-sigs.js');
      process.exit(1);
    }
    console.log(`host import signatures up to date (${names.length} imports)`);
    return;
  }
  fs.writeFileSync(OUT, json);
  const voids = names.filter(n => !sigs[n].results.length).length;
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${names.length} imports `
    + `(${voids} void → can be fired and forgotten, ${names.length - voids} return a value → must block)`);
}

main();
