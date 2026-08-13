#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { analyzeThreadedWat } = require('../tools/analyze-threaded-wat');

const ROOT = path.resolve(__dirname, '..');
const report = analyzeThreadedWat();

assert.strictEqual(report.handlerCount, 385, 'handler table inventory');
assert.strictEqual(report.convertibleCount, report.handlerCount,
  'every table handler must remain structurally convertible');
assert.strictEqual(report.blockedCount, 0, 'no unclassified continuation shape');
assert.strictEqual(report.missingCount, 0, 'every table handler has a function');
assert.deepStrictEqual(report.byExit, { continue: 335, terminal: 37, mixed: 13 },
  'continuation inventory must change explicitly when handlers change');

const generated = fs.readFileSync(
  path.join(ROOT, 'src', '05a-full-brtable.generated.wat'), 'utf8');
const cases = generated.match(/^\s*\) ;; \d+: \$th_/gm) || [];
assert.strictEqual(cases.length, report.handlerCount,
  'generated dispatcher must contain one case per handler');
assert(generated.includes('(func $run_x86_full_brtable_packet'),
  'generated dispatcher function');
assert(!generated.includes('(return_call $next)'),
  'generated cases must not retain threaded continuation calls');

console.log('PASS  all 385 threaded handlers are structurally generated as br_table cases');
