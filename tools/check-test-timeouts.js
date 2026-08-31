#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'test', 'run-all.sh');

function stripComments(source) {
  let out = '';
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        const next = source[i++];
        out += next;
        if (next === '\\' && i < source.length) out += source[i++];
        else if (next === quote) break;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function findTimeouts(source, capSeconds) {
  const clean = stripComments(source);
  const violations = [];
  const timeoutLiteral = /\b[A-Za-z0-9_]*timeout[A-Za-z0-9_]*\s*(?::|=)\s*(\d(?:_?\d)*)/gi;
  const maxSeconds = /--max-seconds=(\d(?:_?\d)*)/g;
  for (const [kind, regex, scale] of [
    ['timeout', timeoutLiteral, 1000],
    ['--max-seconds', maxSeconds, 1],
  ]) {
    for (let match; (match = regex.exec(clean));) {
      const value = Number(match[1].replaceAll('_', ''));
      if (value > capSeconds * scale) {
        violations.push({ kind, value, line: lineAt(clean, match.index) });
      }
    }
  }
  return violations;
}

function listedTests(runnerSource) {
  return [...new Set([...runnerSource.matchAll(
    /^\s*(test\/test-[A-Za-z0-9._-]+\.js)\s*$/gm)].map(match => match[1]))].sort();
}

function main() {
  const runnerSource = fs.readFileSync(RUNNER, 'utf8');
  const capMatch = runnerSource.match(/^DEFAULT_TEST_TIMEOUT=(\d+)$/m);
  if (!capMatch) throw new Error('test/run-all.sh must declare DEFAULT_TEST_TIMEOUT');
  const capSeconds = Number(capMatch[1]);
  const tests = listedTests(runnerSource);
  const all = [];
  for (const relative of tests) {
    const file = path.join(ROOT, relative);
    if (!fs.existsSync(file)) continue; // stale rows are reported by the manifest gate
    for (const violation of findTimeouts(fs.readFileSync(file, 'utf8'), capSeconds)) {
      all.push(`${relative}:${violation.line}: ${violation.kind} ${violation.value} exceeds ${capSeconds}s runner cap`);
    }
  }
  if (all.length) {
    console.error('check-test-timeouts: per-test budgets exceed test/run-all.sh:');
    for (const line of all) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`check-test-timeouts: OK (${tests.length} listed tests, runner cap ${capSeconds}s)`);
}

if (require.main === module) main();

module.exports = { findTimeouts, listedTests, stripComments };
