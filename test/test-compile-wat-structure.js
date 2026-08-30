#!/usr/bin/env node
'use strict';

// The compiler consumes the emulator as one WAT module split across many
// files. Structural validation therefore has to span file boundaries while
// still rejecting the malformed aggregate before it can be normalized into a
// valid-but-incomplete wasm binary.

const assert = require('assert');
const { compileWat } = require('../lib/compile-wat');

let sequence = 0;
function compile(sources) {
  const files = sources.map((_, index) => `part-${index + 1}.wat`);
  const byName = new Map(files.map((file, index) => [file, sources[index]]));
  return compileWat(file => byName.get(file), {
    files,
    cacheKey: `test-compile-wat-structure-${sequence++}`,
  });
}

async function rejects(source, pattern, description) {
  let error = null;
  try {
    await compile([source]);
  } catch (caught) {
    error = caught;
  }
  assert(error, `${description} compiled successfully`);
  assert.match(error.message, pattern, `${description} reported: ${error.message}`);
}

(async () => {
  const bytes = await compile([
    String.raw`(module
      (; outer comment with ((( and "
         (; nested comment with ))) ;)
      ;)
      (func (export "answer") (result i32)
        (i32.const 7)) ;; a comment containing ) (
    `,
    ')\n',
  ]);
  const instance = await WebAssembly.instantiate(bytes);
  assert.strictEqual(instance.instance.exports.answer(), 7,
    'a module split across balanced source files still compiles');

  await rejects('(module (func $f)\n', /final parenthesis depth 1.*part-1\.wat:1/,
    'an unclosed module');
  await rejects('(module) )\n', /unexpected '\)' at part-1\.wat:1/,
    'an unmatched close parenthesis');
  await rejects('(module (data (i32.const 0) "never closed)\n',
    /unterminated string starting at part-1\.wat:1/,
    'an unterminated string');
  await rejects('(module (; never closed\n)\n',
    /unterminated block comment starting at part-1\.wat:1/,
    'an unterminated block comment');

  console.log('PASS compile-wat rejects malformed aggregate WAT structure');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
