#!/usr/bin/env node
// check-region-decls.js — src/00-regions.wat says the same thing the globals do.
//
// The fixed memory map exists twice while Milestone 6 is in flight:
//
//   (global $WND_RECORDS      i32 (i32.const 0x00007000))   <- what code reads
//   (global $WND_RECORDS_SIZE i32 (i32.const 0x00001800))
//   (region.declare-fixed $WND_RECORDS (base 0x00007000) (size 0x00001800))
//
// The compiler validates the DECLARATIONS against each other — overlap,
// alignment, memory bounds — and that is worth nothing if the declarations
// describe a map the code does not use. A declaration set that has drifted from
// the globals is not a safety net, it is a second opinion nobody asked for. So
// this gate is what makes the declarations TRUE, and it runs before compilation
// in tools/build.sh.
//
// Direction of travel: today the globals are authoritative and the declarations
// mirror them. Milestone 6 step 2 inverts that — consumers address regions by
// name, the base globals are generated from the declarations, and this gate's
// job shrinks to nothing because there is only one copy left. Until then it is
// the thing standing between "we declared the map" and "we declared a map".
//
// The declaration set is complete, so the build gate runs --strict: a sized
// global with no mirror declaration is an ERROR. Without --strict it degrades
// to a warning — that mode exists only for mid-edit inspection.
//
// Usage:
//   node tools/check-region-decls.js --strict   # the build gate
//   node tools/check-region-decls.js            # lenient (mid-edit inspection)
//   node tools/check-region-decls.js --list     # print the declared map
//   node tools/check-region-decls.js --file=X   # check a fixture instead of src/00-regions.wat
'use strict';

const fs = require('fs');
const path = require('path');
const { WAT_FILES } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DECLS = '00-regions.wat';
const STRICT = process.argv.includes('--strict');
const LIST = process.argv.includes('--list');

const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

// Whole-token: `0x10zz` and `1_000_000junk` are rejected, not silently
// truncated the way Number.parseInt would. Underscore separators are legal per
// the WATX literal grammar.
function parseInt32(text) {
  const t = String(text).trim().replace(/_/g, '');
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(t)) return null;
  return Number.parseInt(t, /^0x/i.test(t) ? 16 : 10) >>> 0;
}

// The same `(global $NAME i32 (i32.const N))` shape test/test-wat-memory-map.js
// and tools/wat-memory-map.js use, deliberately: a gate that recognized a
// different set of globals than the tools it is reconciling would reconcile
// nothing.
function collectGlobals() {
  const globals = new Map();
  const re = /^\s*\(global\s+(\$[A-Za-z0-9_]+)\s+(?:i32|\(mut\s+i32\))\s+\(i32\.const\s+([^)]+)\)\)\s*(?:;;.*)?$/;
  for (const file of WAT_FILES) {
    if (file === DECLS) continue;
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      const m = line.match(re);
      if (m) globals.set(m[1].slice(1), { value: parseInt32(m[2]), file, line: i + 1 });
    });
  }
  return globals;
}

// Declarations are read with a small dedicated reader rather than the vendored
// WATX parser: this gate runs before the compiler in the build, and a gate that
// needs the thing it gates in order to run is not a gate. The grammar it
// accepts is deliberately narrow — anything it does not recognize is an error,
// never something quietly skipped. (The compiler re-validates the same clause
// set plus overlap/alignment/bounds; this reader only has to refuse to guess.)
const KNOWN_CLAUSES = new Set(['base', 'size', 'end', 'align', 'owner', 'within']);
const NUMERIC_CLAUSES = new Set(['base', 'size', 'end', 'align']);

function collectDeclarations(overrideFile) {
  const fileArg = overrideFile ||
    (process.argv.find(a => a.startsWith('--file=')) || '').slice('--file='.length);
  const file = fileArg ? path.resolve(fileArg) : path.join(SRC, DECLS);
  const text = fs.readFileSync(file, 'utf8');
  const decls = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*\(region\.declare-fixed\s+\$([A-Za-z0-9_]+)\b/.exec(lines[i]);
    if (!head) continue;
    // A declaration may wrap onto following lines; take everything up to the
    // line whose parentheses close it. Line comments are stripped first so a
    // parenthesized aside in a comment is not read as a clause.
    let depth = 0, body = '', j = i;
    do {
      body += lines[j].replace(/;;.*$/, '') + '\n';
      for (const ch of lines[j].replace(/;;.*$/, '')) {
        if (ch === '(') depth++; else if (ch === ')') depth--;
      }
      j++;
    } while (depth > 0 && j < lines.length);
    const d = {
      name: head[1], file: path.relative(ROOT, file), line: i + 1,
      base: null, size: null, within: null, parseErrors: [],
    };
    // Split the declaration body into its depth-1 clause forms. Every clause
    // must be a recognized `(name value)` — an unknown head, a duplicate, a
    // nested value where a flat one belongs, or a malformed number is an error
    // here, never something the mirror check silently reads past.
    const clauseRe = /\(([^()\s]+)((?:[^()"]|"[^"]*")*?)\)/g;
    const afterHead = body.replace(/^\s*\(region\.declare-fixed\s+\$[A-Za-z0-9_]+/, '');
    const seenClauses = new Set();
    const values = new Map();
    let m;
    while ((m = clauseRe.exec(afterHead)) !== null) {
      const key = m[1];
      if (!KNOWN_CLAUSES.has(key)) {
        d.parseErrors.push(`unknown clause (${key} ...)`);
        continue;
      }
      if (seenClauses.has(key)) {
        d.parseErrors.push(`duplicate (${key} ...) clause`);
        continue;
      }
      seenClauses.add(key);
      const value = m[2].trim();
      if (NUMERIC_CLAUSES.has(key)) {
        const n = parseInt32(value);
        if (n === null) d.parseErrors.push(`(${key} ${value}) is not a whole-token integer`);
        else values.set(key, n);
      } else {
        values.set(key, value);
      }
    }
    // Anything at depth 1 that was not consumed as a clause (a bare atom, a
    // nested form the regex skipped) is grammar this reader does not accept.
    const leftover = afterHead.replace(clauseRe, '').replace(/[)\s]/g, '');
    if (leftover) d.parseErrors.push(`unrecognized text in declaration: ${leftover.slice(0, 40)}`);
    if (values.has('size') && values.has('end')) {
      d.parseErrors.push('has both (size N) and (end N); declare one');
    }
    d.base = values.has('base') ? values.get('base') : null;
    d.size = values.has('size') ? values.get('size')
      : values.has('end') && d.base !== null ? (values.get('end') - d.base) >>> 0
      : null;
    const w = values.get('within');
    d.within = w && /^\$[A-Za-z0-9_]+$/.test(w) ? w.slice(1) : null;
    if (w && d.within === null) d.parseErrors.push(`(within ${w}) is not a $NAME`);
    decls.push(d);
    i = j - 1;
  }
  return decls;
}

// Importable: tools/region-census.js reads the same declaration set, so the
// odometer and the gate can never disagree about what a region is.
module.exports = { collectDeclarations, collectGlobals };
if (require.main !== module) return;

const globals = collectGlobals();
const decls = collectDeclarations();

if (LIST) {
  for (const d of [...decls].sort((a, b) => a.base - b.base)) {
    console.log(`${hex(d.base)} +${String(d.size).padStart(9)}  ${d.name}` +
      (d.within ? `  (within $${d.within})` : ''));
  }
  process.exit(0);
}

const errors = [];
const warnings = [];
const seen = new Set();

for (const d of decls) {
  const where = `${d.file}:${d.line}`;
  if (seen.has(d.name)) {
    errors.push(`$${d.name} is declared more than once (${where})`);
    continue;
  }
  seen.add(d.name);
  for (const pe of d.parseErrors) {
    errors.push(`$${d.name} (${where}): ${pe}`);
  }
  if (d.parseErrors.length) continue;
  if (d.base === null || d.size === null) {
    errors.push(`$${d.name} (${where}) has no readable base/extent`);
    continue;
  }
  const base = globals.get(d.name);
  const size = globals.get(`${d.name}_SIZE`);
  if (!base) {
    errors.push(`$${d.name} (${where}) declares a region with no ` +
      `(global $${d.name} i32 ...) behind it — a declaration must describe a ` +
      `region that exists, not invent one`);
    continue;
  }
  if (!size) {
    errors.push(`$${d.name} (${where}) has no (global $${d.name}_SIZE i32 ...); ` +
      `declare the extent where the region's other globals live`);
    continue;
  }
  if (base.value !== d.base) {
    errors.push(`$${d.name} base disagrees: declaration ${hex(d.base)} (${where}) ` +
      `vs global ${hex(base.value)} (${base.file}:${base.line})`);
  }
  if (size.value !== d.size) {
    errors.push(`$${d.name} size disagrees: declaration ${hex(d.size)} (${where}) ` +
      `vs $${d.name}_SIZE ${hex(size.value)} (${size.file}:${size.line})`);
  }
}

for (const [name, g] of globals) {
  if (!name.endsWith('_SIZE')) continue;
  const region = name.slice(0, -'_SIZE'.length);
  if (!globals.has(region) || seen.has(region)) continue;
  const msg = `$${region} is a sized region (${g.file}:${g.line}) with no ` +
    `(region.declare-fixed $${region} ...) in src/${DECLS}`;
  (STRICT ? errors : warnings).push(msg);
}

for (const w of warnings) console.warn(`check-region-decls: WARN ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`check-region-decls: ${e}`);
  console.error(`check-region-decls: ${errors.length} disagreement(s) between ` +
    `src/${DECLS} and the region globals.`);
  process.exit(1);
}
console.log(`region declarations OK: ${decls.length} declared, ` +
  `all agree with their $NAME/$NAME_SIZE globals` +
  (warnings.length ? `, ${warnings.length} sized region(s) not yet declared` : ''));
