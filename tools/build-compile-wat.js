#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(arg => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseReplicatedDispatch() {
  if (hasFlag('replicated-dispatch')) return true;
  const value = getArg('dispatch', 'shared');
  if (value === 'shared' || value === 'none' || value === '0' || value === 'false') return false;
  if (value === 'replicated' || value === 'all' || value === '1' || value === 'true') return true;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

const OUT = path.resolve(ROOT, getArg('out', path.join('build', 'wine-assembly.wasm')));
const COMPAT_OUT = path.resolve(ROOT, getArg('compat-out', path.join('build', 'wine-assembly.compat.wasm')));

(async () => {
  const replicatedDispatch = parseReplicatedDispatch();
  const bytes = await compileWat(
    (file) => fs.promises.readFile(path.join(SRC, file), 'utf8'),
    { replicatedDispatch }
  );
  const compatBytes = await compileWat(
    (file) => fs.promises.readFile(path.join(SRC, file), 'utf8'),
    { tailCalls: false, replicatedDispatch }
  );
  // compileWat emits bytes without validating operand stacks, so a WAT edit
  // that leaves a function's result value unproduced — one paren too few, and
  // an (if) that should yield i32 yields nothing — used to "build" fine and
  // then fail at WebAssembly.instantiate in whatever test ran next, reported as
  // a function *index*. WebAssembly.Module does the real validation and needs
  // no imports, so do it here and name the function.
  for (const [label, buf] of [['wine-assembly.wasm', bytes], ['wine-assembly.compat.wasm', compatBytes]]) {
    try {
      new WebAssembly.Module(buf);
    } catch (err) {
      const m = /function #(\d+)/.exec(err.message || '');
      console.error(`Validation failed for ${label}: ${err.message}`);
      if (m) {
        console.error(`  Name that function with: node tools/wasm-func-name.js ${m[1]}`);
      }
      process.exit(1);
    }
  }

  await fs.promises.mkdir(path.dirname(OUT), { recursive: true });
  await fs.promises.mkdir(path.dirname(COMPAT_OUT), { recursive: true });
  await fs.promises.writeFile(OUT, Buffer.from(bytes));
  await fs.promises.writeFile(COMPAT_OUT, Buffer.from(compatBytes));
  const st = await fs.promises.stat(OUT);
  const compatSt = await fs.promises.stat(COMPAT_OUT);
  console.log(`Build complete: ${path.relative(ROOT, OUT)} (${st.size} bytes)`);
  console.log(`Build complete: ${path.relative(ROOT, COMPAT_OUT)} (${compatSt.size} bytes)`);
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
