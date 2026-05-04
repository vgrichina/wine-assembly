#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'build', 'wine-assembly.wasm');

(async () => {
  const bytes = await compileWat((file) => fs.promises.readFile(path.join(SRC, file), 'utf8'));
  await fs.promises.mkdir(path.dirname(OUT), { recursive: true });
  await fs.promises.writeFile(OUT, Buffer.from(bytes));
  const st = await fs.promises.stat(OUT);
  console.log(`Build complete: ${path.relative(ROOT, OUT)} (${st.size} bytes)`);
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
