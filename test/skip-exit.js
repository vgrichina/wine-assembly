#!/usr/bin/env node

'use strict';

// Loaded by test/run-all.sh before each test. Existing fixture tests already
// announce an intentional non-run with a leading "SKIP" line, but historically
// returned success. Preserve their messages while turning that protocol into
// an unambiguous process status the parent runner can count separately.
const skipStatus = Number.parseInt(process.env.WA_TEST_SKIP_EXIT || '77', 10);
if (!Number.isInteger(skipStatus) || skipStatus < 1 || skipStatus > 255) {
  throw new Error(`invalid WA_TEST_SKIP_EXIT=${process.env.WA_TEST_SKIP_EXIT}`);
}

let skipped = false;
const skipLine = /^\s*SKIP(?:\s|:|$)/;
for (const method of ['log', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    if (typeof args[0] === 'string' && skipLine.test(args[0])) skipped = true;
    return original(...args);
  };
}

const originalExit = process.exit.bind(process);
process.exit = (code = process.exitCode || 0) => {
  const status = Number(code) || 0;
  originalExit(skipped && status === 0 ? skipStatus : status);
};

process.on('beforeExit', code => {
  if (skipped && code === 0) process.exitCode = skipStatus;
});
