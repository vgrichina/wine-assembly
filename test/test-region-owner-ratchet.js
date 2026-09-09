#!/usr/bin/env node

'use strict';

// `tools/check-region-decls.js --check-owners` gates the stable
// `(owner "file:$symbol")` clause every region declaration carries. For WAT,
// the symbol's complete top-level form must still reference the region: merely
// leaving a same-named function elsewhere in the file cannot hide ownership
// drift. Test-only non-WAT owners require exact anchor and region symbols.
//
// It tests `ownerVerdict` directly rather than shelling out to the CLI, because
// the CLI path is baseline bookkeeping; exercising it proves nothing about
// whether the check itself can see a stale owner.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  collectDeclarations,
  ownerVerdict,
  watTopLevelForms,
} = require('../tools/check-region-decls.js');

let checks = 0;
const check = (cond, what) => { assert.ok(cond, what); checks++; };

const decls = collectDeclarations();
check(decls.length > 100, `the declaration set is real (${decls.length} regions)`);

// 1. Every declaration carries an owner. The compiler makes this mandatory;
//    assert it here too, because a `missing` verdict would otherwise be
//    indistinguishable from a parse failure in this tool.
const ownerless = decls.filter(d => !d.owner);
check(ownerless.length === 0,
  `every region has an (owner "…"): ${ownerless.map(d => d.name).join(', ')}`);

// 2. A global symbol that owns the region mirror is valid.
check(ownerVerdict({
  name: 'STRING_CONSTANTS',
  owner: '"01-header.wat:$STRING_CONSTANTS"',
}).state === 'ok', 'a live region-mirror symbol verdicts ok');

// 3. A function symbol is valid only while that function still uses the exact
//    region (not merely its similarly prefixed _SIZE global).
check(ownerVerdict({
  name: 'CLASS_NAME_STRINGS',
  owner: '"09a-handlers.wat:$control_class_name_ptr"',
}).state === 'ok', 'a live function owner verdicts ok');
const wrongFunction = ownerVerdict({
  name: 'STRING_CONSTANTS',
  owner: '"01-header.wat:$UPDATE_RECT"',
});
check(wrongFunction.state === 'stale',
  `a function that does not use the region is caught (got ${wrongFunction.state})`);
check(/no longer references/.test(wrongFunction.why || ''), 'and the message says why');

// 4. A vanished symbol is stale, even when the file and region both exist.
const vanished = ownerVerdict({
  name: 'STRING_CONSTANTS',
  owner: '"01-header.wat:$no_such_owner_symbol"',
});
check(vanished.state === 'stale', `a vanished symbol is caught (got ${vanished.state})`);

// 5. An owner naming a file that does not exist is stale, not a crash.
check(ownerVerdict({ name: 'X', owner: '"no-such-file.wat:$X"' }).state === 'stale',
  'a vanished owner file is caught');

// 6. The line-number representation is rejected; keeping it as a fallback
//    would quietly reintroduce the churn this migration removes.
const legacyLine = ownerVerdict({
  name: 'STRING_CONSTANTS',
  owner: '"01-header.wat:903"',
});
check(legacyLine.state === 'stale', 'legacy file:line owners are rejected');
check(/unsupported/.test(legacyLine.why || ''), 'the diagnostic names the unsupported form');

// 7. A test-only region may name a repository-relative non-WAT source that
//    mentions its exact symbol. It is verified rather than skipped.
check(ownerVerdict({
  name: 'TEST_SCRATCH',
  owner: '"test/test-wat-window-tables.js:$TEST_SCRATCH"',
}).state === 'ok', 'a test-only JavaScript symbol owner verifies');

// 8. The top-level reader ignores fake forms/symbols in both comment kinds and
//    string bytes; owner validation must inspect WAT code, not documentation.
const parsed = watTopLevelForms([
  ';; (func $line_fake (global.get $FAKE))',
  '(; (func $block_fake (global.get $FAKE)) ;)',
  '(func $real (drop (i32.const 1)) (data.drop $inside))',
  '(data (i32.const 0) "(func $string_fake)")',
].join('\n'));
check(parsed.length === 2, `only two real top-level forms were found (${parsed.length})`);
check(parsed[0].symbol === '$real', 'the real function symbol is parsed');
check(!parsed.some(form => /\$(?:line|block|string)_fake/.test(form.code)),
  'comment and string symbols are absent from owner-checking code');

// 9. No declaration in the live tree is stale, and every owner clause —
//    including the storage-free span omitted from collectDeclarations — uses
//    the stable symbol spelling.
const liveStale = decls.filter(d => ownerVerdict(d).state === 'stale');
check(liveStale.length === 0,
  `no live declaration has a stale owner: ${liveStale.map(d => d.name).join(', ')}`);
const okCount = decls.filter(d => ownerVerdict(d).state === 'ok').length;
check(okCount === decls.length, `the matcher verifies every owner (${okCount})`);
const regionsText = fs.readFileSync(path.join(__dirname, '..', 'src', '00-regions.wat'), 'utf8');
const ownerClauses = [...regionsText.matchAll(/\(owner\s+"([^"]+)"\)/g)].map(match => match[1]);
check(ownerClauses.length > decls.length, 'the raw owner set includes the storage-free span');
check(ownerClauses.every(owner => /:\$[A-Za-z0-9_.\-]+$/.test(owner)),
  'every declaration and span uses file:$symbol ownership');

console.log(`PASS  region symbol owners (${checks} checks, ${okCount} owners verify)`);
