#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MAX_SECONDS = 2147483647;

function validateOverrides(entries, options = {}) {
  const root = options.root || ROOT;
  if (!Array.isArray(entries)) throw new Error('test timeout overrides must be an array');
  const result = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(key => !['test', 'seconds', 'reason'].includes(key))) {
      throw new Error('invalid test timeout override record');
    }
    if (typeof entry.test !== 'string' ||
        !/^test\/(?:test-[A-Za-z0-9._-]+|[A-Za-z0-9._-]+\.test)\.js$/.test(entry.test)) {
      throw new Error(`invalid test timeout path: ${entry.test}`);
    }
    if (result.has(entry.test)) throw new Error(`duplicate test timeout override: ${entry.test}`);
    if (!Number.isInteger(entry.seconds) || entry.seconds <= 0 || entry.seconds > MAX_SECONDS) {
      throw new Error(`invalid timeout seconds for ${entry.test}`);
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error(`timeout override needs a reason: ${entry.test}`);
    }
    const file = path.join(root, entry.test);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`timeout override must name an existing regular test file: ${entry.test}`);
    }
    if (options.tests && !options.tests.has(entry.test)) {
      throw new Error(`timeout override test is not in the manifest: ${entry.test}`);
    }
    result.set(entry.test, { seconds: entry.seconds, reason: entry.reason.trim() });
  }
  return result;
}

function loadTimeoutOverrides(options = {}) {
  return validateOverrides(JSON.parse(fs.readFileSync(
    options.file || path.join(__dirname, 'test-timeouts.json'), 'utf8')), options);
}

function parseGlobalTimeout(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) > MAX_SECONDS) {
    throw new Error('TEST_TIMEOUT/--timeout must be an integer from 0 to 2147483647 seconds');
  }
  return Number(value);
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === '--validate-global') {
      console.log(parseGlobalTimeout(args[1]));
    } else if (!args.length) {
      for (const [test, entry] of loadTimeoutOverrides()) console.log(`${test}\t${entry.seconds}`);
    } else throw new Error('usage: test-timeouts.js [--validate-global SECONDS]');
  } catch (error) {
    console.error(`test-timeouts: ${error.message}`);
    process.exitCode = 2;
  }
}
module.exports = { validateOverrides, loadTimeoutOverrides, parseGlobalTimeout };
