#!/usr/bin/env node
// Map a wasm function index (as printed by V8 profiles / traps) to its $name
// in build/combined.wat. Imported functions occupy the first indices.
// Usage: node tools/wasm-func-name.js <index> [index...] [--wat=build/combined.wat]
const fs = require('fs');

const watArg = (process.argv.find(a => a.startsWith('--wat=')) || '').split('=')[1];
// build/combined.wat is only written by tools/build.sh; test/run.js concatenates
// lib/compile-wat.js's WAT_FILES in memory, so a stale combined.wat silently
// shifts every index. Rebuild the same concatenation here unless told otherwise.
const wat = watArg || 'src/*.wat (WAT_FILES order)';
const indices = process.argv.slice(2).filter(a => !a.startsWith('--')).map(Number);
if (!indices.length) {
  console.error('usage: node tools/wasm-func-name.js <index> [...] [--wat=PATH]');
  process.exit(1);
}

const lines = (() => {
  if (watArg) return fs.readFileSync(watArg, 'utf8').split('\n');
  const src = fs.readFileSync(require('path').join(__dirname, '../lib/compile-wat.js'), 'utf8');
  const block = src.slice(src.indexOf('const WAT_FILES = ['));
  const list = block.slice(0, block.indexOf(']')).match(/'([^']+\.wat)'/g).map(q => q.slice(1, -1));
  return list.flatMap(f => fs.readFileSync(require('path').join(__dirname, '../src', f), 'utf8').split('\n'));
})();
const imports = [];
const defs = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // Import declarations wrap onto a second line when the signature is long,
  // so match the module/name pair first and look ahead for the (func kind.
  let m = line.match(/\(import\s+"[^"]*"\s+"([^"]*)"(.*)$/);
  if (m) {
    const rest = m[2] + (lines[i + 1] || '');
    if (/\(func/.test(rest)) {
      imports.push({ name: 'import:' + m[1], line: i + 1 });
      // A wrapped import puts its (func on the next line; skip it so that
      // continuation is not also counted as a function definition.
      if (!/\(func/.test(m[2])) i++;
      continue;
    }
  }
  m = line.match(/^\s*\(func\s+(\$[^\s()]+|\(export\s+"[^"]*")?/);
  if (m && /^\s*\(func[\s)]/.test(line)) {
    let name = m[1] || '';
    if (!name || name.startsWith('(export')) {
      const ex = line.match(/\(export\s+"([^"]*)"/);
      name = ex ? `"${ex[1]}"` : '(anonymous)';
    }
    defs.push({ name, line: i + 1 });
  }
}

console.log(`${imports.length} imports, ${defs.length} defined functions in ${wat}`);

// Reverse lookup: --find=$name prints the index a profile would show.
for (const arg of process.argv.filter(a => a.startsWith('--find='))) {
  const want = arg.slice('--find='.length);
  let hit = false;
  defs.forEach((d, i) => {
    if (d.name.includes(want)) { console.log(`${d.name} -> wasm-function[${i + imports.length}] (${wat}:${d.line})`); hit = true; }
  });
  if (!hit) console.log(`${want}: not found`);
}
for (const idx of indices) {
  if (idx < imports.length) { console.log(`[${idx}] ${imports[idx].name} (${wat}:${imports[idx].line})`); continue; }
  const d = defs[idx - imports.length];
  console.log(d ? `[${idx}] ${d.name} (${wat}:${d.line})` : `[${idx}] out of range`);
}
