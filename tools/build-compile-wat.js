#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'build', 'wine-assembly.wasm');
const COMPAT_OUT = path.join(ROOT, 'build', 'wine-assembly.compat.wasm');

(async () => {
  const bytes = await compileWat((file) => fs.promises.readFile(path.join(SRC, file), 'utf8'));
  const compatBytes = await compileWat(
    (file) => fs.promises.readFile(path.join(SRC, file), 'utf8'),
    { tailCalls: false }
  );
  await fs.promises.mkdir(path.dirname(OUT), { recursive: true });
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
