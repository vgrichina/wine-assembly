#!/usr/bin/env node

'use strict';

// Map a WebAssembly function index back to the WAT function that produced it.
//
// An instantiation failure reports an index and nothing else:
//
//   CompileError: Compiling function #3849 failed: expected 1 elements on the
//   stack for fallthru, found 2
//
// In a 3,900-function module concatenated from two dozen files that names no
// file, no function, and no line. Indices count imported functions first, then
// definitions in source order, so this walks build/combined.wat the same way
// the compiler does and prints the function - which is usually enough to see
// the mistake, and always enough to know whose file it is in.
//
//   node tools/func-index.js 3849
//   node tools/func-index.js 3849 --body     # print the whole function
//   node tools/func-index.js --name=$tt_fnt_build   # the other direction

const fs = require('fs');
const path = require('path');

const COMBINED = path.join(__dirname, '..', 'build', 'combined.wat');

function scan(source) {
  const imports = [];
  const defined = [];
  const lines = source.split('\n');

  // Depth tracking keeps a `(func ...)` inside a comment or a nested form from
  // being counted. Only top-level definitions get an index.
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const code = raw.replace(/;;.*$/, '');

    if (depth <= 1) {
      const importFunc = code.match(/\(import\s+"[^"]*"\s+"([^"]*)"\s+\(func\s+(\$[^\s)]+)/);
      if (importFunc) {
        imports.push({ name: importFunc[2], line: i + 1, host: importFunc[1] });
      } else {
        const define = code.match(/^\s*\(func\s+(\$[^\s)]+|\(export\s+"[^"]*")/);
        if (define) {
          const exported = code.match(/\(export\s+"([^"]*)"/);
          defined.push({
            name: define[1].startsWith('$') ? define[1] : `(export "${exported[1]}")`,
            line: i + 1,
            depth,
          });
        }
      }
    }

    for (const ch of code) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
  }
  return { imports, defined, lines };
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('usage: node tools/func-index.js <index> [--body] | --name=$fn');
    process.exit(2);
  }
  if (!fs.existsSync(COMBINED)) {
    console.error(`${COMBINED} not found - run bash tools/build.sh first`);
    process.exit(2);
  }

  const source = fs.readFileSync(COMBINED, 'utf8');
  const { imports, defined, lines } = scan(source);
  const wantBody = args.includes('--body');
  const byName = args.find(a => a.startsWith('--name='));

  if (byName) {
    const name = byName.slice('--name='.length);
    const at = defined.findIndex(f => f.name === name);
    if (at < 0) {
      console.error(`no function named ${name} in combined.wat`);
      process.exit(1);
    }
    console.log(`${name} is function #${at + imports.length} ` +
      `(definition ${at}, ${imports.length} imports precede it), ` +
      `combined.wat:${defined[at].line}`);
    return;
  }

  const index = Number(args[0]);
  if (!Number.isInteger(index) || index < 0) {
    console.error(`not a function index: ${args[0]}`);
    process.exit(2);
  }

  console.log(`${imports.length} imported functions, ${defined.length} defined ` +
    `(indices ${imports.length}..${imports.length + defined.length - 1})`);

  if (index < imports.length) {
    const found = imports[index];
    console.log(`#${index} is the import ${found.name} ("${found.host}"), ` +
      `combined.wat:${found.line}`);
    return;
  }

  const at = index - imports.length;
  if (at >= defined.length) {
    console.error(`#${index} is past the last function`);
    process.exit(1);
  }

  const found = defined[at];
  const next = defined[at + 1];
  console.log(`#${index} is ${found.name} at combined.wat:${found.line}` +
    (next ? ` (next function starts at line ${next.line})` : ''));

  if (wantBody) {
    const end = next ? next.line - 1 : lines.length;
    for (let i = found.line - 1; i < end; i += 1) {
      console.log(`${i + 1}\t${lines[i]}`);
    }
  }
}

main();
