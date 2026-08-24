#!/usr/bin/env node
'use strict';

// List the exports of a built module, so "the host guards on
// `instance.exports.foo` and foo is silently missing" is one command instead of
// an afternoon. lib/compile-wat.js only *warns* about an unresolved name, and
// every debug facility in test/run.js is written as
// `if (instance.exports.set_bp) ...`, so a dropped export disables a flag with
// no error anywhere -- that is exactly how --break/--count came to report
// nothing while --trace-eip-range worked.
//
//   node tools/wasm-exports.js [build/wine-assembly.wasm] [--grep=count]
//   node tools/wasm-exports.js --has=set_bp,set_count,get_count

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = name => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const file = args.find(a => !a.startsWith('--'))
  || path.join(__dirname, '..', 'build', 'wine-assembly.wasm');

const bytes = fs.readFileSync(file);
const mod = new WebAssembly.Module(bytes);
const exps = WebAssembly.Module.exports(mod);

const has = flag('has');
if (has) {
  const names = new Set(exps.map(e => e.name));
  let missing = 0;
  for (const want of has.split(',').map(s => s.trim()).filter(Boolean)) {
    const ok = names.has(want);
    if (!ok) missing++;
    console.log(`${ok ? 'present' : 'MISSING'}  ${want}`);
  }
  process.exit(missing ? 1 : 0);
}

const grep = flag('grep');
const rows = exps
  .filter(e => !grep || e.name.includes(grep))
  .sort((a, b) => a.name.localeCompare(b.name));
for (const e of rows) console.log(`${e.kind.padEnd(8)} ${e.name}`);
console.log(`\n${rows.length} of ${exps.length} exports${grep ? ` matching ${JSON.stringify(grep)}` : ''} in ${path.relative(process.cwd(), file)}`);
