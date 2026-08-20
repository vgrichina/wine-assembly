#!/usr/bin/env node
// A name that does not resolve must fail the build, not warn.
//
// compile-wat used to print "unknown func: $x" and resolve the name to 0.
// Index 0 is the first import ($host_log), so a call to a handler that did not
// exist became a call to that, with the wrong arity, and never popped ESP for
// the guest's stdcall args. It validated anyway: every dispatch arm ends in
// (return), and return is stack-polymorphic, so the leftover operands were
// erased by the unreachable rule. Three handlers were shipping that way, and
// what had actually happened to them was that a bad edit ate the "(func " off
// the front of their definitions -- for weeks, silently.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { compileWat } = require('../lib/compile-wat');

const SRC = path.join(__dirname, '..', 'src');

// Inject the bad call into a real build so this exercises the same path the
// build does, rather than a hand-made module that proves nothing about it.
// compileWat memoizes on options.cacheKey, so every variant needs its own or
// the second call quietly hands back the first one's module.
function build(extra, cacheKey) {
  return compileWat(async (f) => {
    const source = await fs.promises.readFile(path.join(SRC, f), 'utf-8');
    if (!extra || f !== '13-exports.wat') return source;
    return source.replace(/\n\)\s*$/, `\n${extra}\n)\n`);
  }, { cacheKey });
}

(async () => {
  let checks = 0;

  await build('', 'baseline');
  console.log('PASS  the tree as committed still builds');
  checks++;

  const cases = [
    ['func', `(func (export "test_calls_a_ghost") (call $handle_ThisHandlerDoesNotExist
        (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))`],
    ['global', `(func (export "test_reads_a_ghost") (result i32) (global.get $no_such_global))`],
  ];

  for (const [kind, wat] of cases) {
    let err = null;
    try {
      await build(wat, `ghost-${kind}`);
    } catch (e) {
      err = e;
    }
    assert(err, `an unknown ${kind} must fail the build, but it compiled`);
    assert(/unknown/.test(err.message),
      `the error must name the problem, got: ${err.message}`);
    console.log(`PASS  an unknown ${kind} fails the build: ${err.message.trim()}`);
    checks++;
  }

  console.log(`\n${checks}/${checks} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
